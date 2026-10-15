/**
 * NCode Local Tool Execution: Executes shell, read_file, write_file, apply_patch, git_diff locally.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NCodeToolResult } from '../shared/ncode-protocol.js';
import { isContained } from './sandbox.js';

let activeWorkspaceDir = process.cwd();

export function setNCodeWorkspace(dir: string): void {
  activeWorkspaceDir = path.resolve(dir);
}

export function getNCodeWorkspace(): string {
  return activeWorkspaceDir;
}

/** A tool result is sent back as one WebSocket frame, so a capture has to end somewhere. */
const MAX_OUTPUT_CHARS = 1_000_000;

/**
 * The largest file `apply_patch` will read and rewrite.
 *
 * Same ceiling `read_file` already enforces, kept under its own name because this one is a
 * *mutation* bound: a surgical edit is meant for a source file the model is working in, and a
 * multi-megabyte artifact (a lockfile, a bundle, a dump) is a file `write_file` and a shell
 * redirect are for. Checked from the stat before the read, so an oversized file is never pulled
 * into memory to be refused afterwards.
 */
const MAX_PATCH_FILE_BYTES = 1_000_000;

/**
 * How many times an exact `search` string occurs in a file, counted non-overlapping.
 *
 * Non-overlapping is the only count a model can reason about: "aaa" contains "aa" once in the
 * sense `split` reports it, not twice. `search` is never empty here, so the loop terminates.
 */
function countOccurrences(content: string, search: string): number {
  let count = 0;
  let at = content.indexOf(search);
  while (at !== -1) {
    count += 1;
    at = content.indexOf(search, at + search.length);
  }
  return count;
}

/**
 * Accumulates child output up to a ceiling instead of letting a runaway command
 * (`type` a huge file, `git diff` a monorepo) grow the main process until it dies.
 */
function createCapture(): { push: (chunk: unknown) => void; text: () => string } {
  let value = '';
  let truncated = false;
  return {
    push(chunk: unknown): void {
      if (truncated) return;
      const next = value + String(chunk);
      if (next.length > MAX_OUTPUT_CHARS) {
        value = next.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      } else {
        value = next;
      }
    },
    text(): string {
      return truncated ? `${value}\n... output truncated at ${MAX_OUTPUT_CHARS} characters.` : value;
    }
  };
}

/**
 * Resolves a model-supplied path against the shared folder and refuses anything outside it.
 *
 * Gemini is told its workspace is that one folder, so an absolute path pointing elsewhere,
 * or a `..` chain that climbs out of it, is not a request worth honouring however
 * well-formed it looks. Containment is lexical — the same boundary `isContained` draws for
 * every other tool in this app — so a symlink inside the folder that points out is still
 * followed, exactly as it is everywhere else.
 */
function resolveInsideWorkspace(workspace: string, candidate: string, label: string): string {
  const target = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspace, candidate);
  if (!isContained(workspace, target)) {
    throw new Error(`${label} must stay inside the shared folder ${workspace}. "${candidate}" resolves outside it.`);
  }
  return target;
}

/**
 * Ends a shell and everything it started.
 *
 * `child.kill()` terminates only the shell itself; on Windows the program it launched
 * keeps running, and keeps writing to the folder, long after the tool reported a timeout.
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill();
}

export interface ExecuteToolOptions {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
  workspaceDir?: string;
  timeoutMs?: number;
}

export async function executeNCodeTool(options: ExecuteToolOptions): Promise<NCodeToolResult> {
  const id = options.id || `call-${Date.now()}`;
  const tool = options.tool.trim().toLowerCase();
  const args = options.args || {};
  const workspace = path.resolve(options.workspaceDir || activeWorkspaceDir);
  const timeoutMs = options.timeoutMs ?? 120_000;

  try {
    switch (tool) {
      case 'shell': {
        const command = String(args.command ?? args.cmd ?? args.raw ?? '');
        if (!command.trim()) {
          return { id, tool, status: 'error', stdout: '', stderr: 'No shell command provided.' };
        }

        const cwd = args.cwd ? resolveInsideWorkspace(workspace, String(args.cwd), 'The cwd for shell') : workspace;

        return await new Promise<NCodeToolResult>((resolve) => {
          const isWin = process.platform === 'win32';
          const shellCmd = isWin ? 'powershell.exe' : '/bin/sh';
          const shellArgs = isWin
            ? ['-NoProfile', '-NonInteractive', '-Command', command]
            : ['-c', command];

          const stdout = createCapture();
          const stderr = createCapture();
          let timedOut = false;

          const child = spawn(shellCmd, shellArgs, {
            cwd,
            windowsHide: true,
            env: { ...process.env, CI: '1' }
          });

          const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, timeoutMs);

          child.stdout.on('data', (chunk) => {
            stdout.push(chunk);
          });

          child.stderr.on('data', (chunk) => {
            stderr.push(chunk);
          });

          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({
              id,
              tool,
              status: 'error',
              stdout: stdout.text().trim(),
              stderr: `Execution error: ${err.message}`
            });
          });

          child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
              resolve({
                id,
                tool,
                status: 'error',
                stdout: stdout.text().trim(),
                stderr: `Execution timed out after ${timeoutMs}ms`
              });
            } else if (code !== 0) {
              resolve({
                id,
                tool,
                status: 'error',
                stdout: stdout.text().trim(),
                stderr: stderr.text().trim() || `Process exited with code ${code}`
              });
            } else {
              resolve({
                id,
                tool,
                status: 'success',
                stdout: stdout.text().trim(),
                stderr: stderr.text().trim()
              });
            }
          });
        });
      }

      case 'read_file': {
        const filePath = String(args.path ?? args.file ?? '');
        if (!filePath.trim()) {
          return { id, tool, status: 'error', stdout: '', stderr: 'No path specified for read_file.' };
        }
        const targetPath = resolveInsideWorkspace(workspace, filePath, 'The path for read_file');
        // Checked before the read, because an oversized file would otherwise be pulled
        // wholly into memory before anything had a chance to notice.
        const { size } = await fs.stat(targetPath);
        if (size > MAX_OUTPUT_CHARS) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: `${filePath} is ${size} bytes, over the ${MAX_OUTPUT_CHARS}-byte limit for read_file.`
          };
        }
        const content = await fs.readFile(targetPath, 'utf8');
        return {
          id,
          tool,
          status: 'success',
          stdout: content,
          stderr: ''
        };
      }

      case 'write_file': {
        const filePath = String(args.path ?? args.file ?? '');
        if (!filePath.trim()) {
          return { id, tool, status: 'error', stdout: '', stderr: 'No path specified for write_file.' };
        }
        const content = String(args.content ?? args.text ?? '');
        const targetPath = resolveInsideWorkspace(workspace, filePath, 'The path for write_file');
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, 'utf8');
        return {
          id,
          tool,
          status: 'success',
          stdout: `Successfully wrote ${content.length} characters to ${filePath}`,
          stderr: ''
        };
      }

      case 'apply_patch': {
        const filePath = String(args.path ?? args.file ?? '');
        if (!filePath.trim()) {
          return { id, tool, status: 'error', stdout: '', stderr: 'No path specified for apply_patch.' };
        }
        if (typeof args.search !== 'string' || !args.search) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: 'apply_patch needs a non-empty "search" string to find.'
          };
        }
        if (typeof args.replace !== 'string') {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: 'apply_patch needs a "replace" string; use "" to delete the matched text.'
          };
        }
        const search = args.search;
        const replace = args.replace;
        const targetPath = resolveInsideWorkspace(workspace, filePath, 'The path for apply_patch');
        // Checked before the read for the same reason read_file checks it: an oversized file must
        // never be pulled into memory first and refused afterwards.
        const { size } = await fs.stat(targetPath);
        if (size > MAX_PATCH_FILE_BYTES) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: `${filePath} is ${size} bytes, over the ${MAX_PATCH_FILE_BYTES}-byte limit for apply_patch.`
          };
        }
        const raw = await fs.readFile(targetPath);
        // UTF-16 is refused rather than guessed at. Decoding it as UTF-8 and writing the result
        // back would corrupt the file on the one tool whose entire promise is that exactly the
        // named substring changed.
        if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: `${filePath} is UTF-16 encoded. apply_patch only edits UTF-8 files.`
          };
        }
        // A BOM is taken off before the match and put back verbatim, so a BOM file stays a BOM
        // file and the search text is compared against the content the model actually sees.
        const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
        const content = raw.toString('utf8', hasBom ? 3 : 0);
        const occurrences = countOccurrences(content, search);
        if (occurrences === 0) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: `apply_patch found no occurrence of the search text in ${filePath}. Read the file and copy the exact text, including its line endings.`
          };
        }
        if (occurrences > 1) {
          return {
            id,
            tool,
            status: 'error',
            stdout: '',
            stderr: `apply_patch found ${occurrences} occurrences of the search text in ${filePath}. Include more surrounding lines so exactly one matches.`
          };
        }
        // Nothing is ever split on newlines, so CRLF and LF both pass through untouched: a file
        // keeps the line endings it had, and a `search` written with the wrong ending simply fails
        // to match instead of quietly rewriting the whole file with the other one.
        const at = content.indexOf(search);
        const patched = content.slice(0, at) + replace + content.slice(at + search.length);
        // A replacement that changes nothing must not touch the file: no rewrite, no mtime bump,
        // and nothing a concurrent writer could lose content to.
        if (patched !== content) {
          const body = Buffer.from(patched, 'utf8');
          await fs.writeFile(targetPath, hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
        }
        return {
          id,
          tool,
          status: 'success',
          stdout: `Patched ${filePath}: replaced 1 occurrence (${search.length} characters) with ${replace.length} characters.`,
          stderr: ''
        };
      }

      case 'git_diff': {
        const staged = Boolean(args.staged);
        const cwd = args.cwd ? resolveInsideWorkspace(workspace, String(args.cwd), 'The cwd for git_diff') : workspace;
        return await new Promise<NCodeToolResult>((resolve) => {
          const gitArgs = staged ? ['diff', '--staged'] : ['diff'];
          const child = spawn('git', gitArgs, { cwd, windowsHide: true });
          const stdout = createCapture();
          const stderr = createCapture();
          child.stdout.on('data', chunk => { stdout.push(chunk); });
          child.stderr.on('data', chunk => { stderr.push(chunk); });
          child.on('close', (code) => {
            if (code !== 0) {
              resolve({
                id,
                tool,
                status: 'error',
                stdout: '',
                stderr: stderr.text().trim() || `git diff exited with code ${code}`
              });
            } else {
              resolve({
                id,
                tool,
                status: 'success',
                stdout: stdout.text().trim() || '(no git changes)',
                stderr: ''
              });
            }
          });
          child.on('error', (err) => {
            resolve({
              id,
              tool,
              status: 'error',
              stdout: '',
              stderr: `git error: ${err.message}`
            });
          });
        });
      }

      default:
        return {
          id,
          tool,
          status: 'error',
          stdout: '',
          stderr: `Unknown tool: ${tool}. Supported tools are: shell, read_file, write_file, apply_patch, git_diff.`
        };
    }
  } catch (err: unknown) {
    const error = err as Error;
    return {
      id,
      tool,
      status: 'error',
      stdout: '',
      stderr: error.message || String(err)
    };
  }
}
