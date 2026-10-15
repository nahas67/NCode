import { describe, expect, it, afterAll } from 'vitest';
import { executeNCodeTool, setNCodeWorkspace } from '../src/main/ncode-tools.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ncode local tool execution', () => {
  const tempDir = path.join(os.tmpdir(), `ncode-tools-test-${Date.now()}`);

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('executes write_file and read_file', async () => {
    setNCodeWorkspace(tempDir);
    const writeRes = await executeNCodeTool({
      tool: 'write_file',
      args: { path: 'sub/test.txt', content: 'Hello NCode' },
      workspaceDir: tempDir
    });
    expect(writeRes.status).toBe('success');
    expect(writeRes.stdout).toContain('Successfully wrote');

    const readRes = await executeNCodeTool({
      tool: 'read_file',
      args: { path: 'sub/test.txt' },
      workspaceDir: tempDir
    });
    expect(readRes.status).toBe('success');
    expect(readRes.stdout).toBe('Hello NCode');
  });

  it('executes shell command', async () => {
    const res = await executeNCodeTool({
      tool: 'shell',
      args: { command: 'node -e "console.log(\'from node\')"' },
      workspaceDir: tempDir
    });
    expect(res.status).toBe('success');
    expect(res.stdout).toContain('from node');
  });

  it('handles shell command failures cleanly', async () => {
    const res = await executeNCodeTool({
      tool: 'shell',
      args: { command: 'node -e "process.exit(1)"' },
      workspaceDir: tempDir
    });
    expect(res.status).toBe('error');
  });

  it('executes git_diff without error in repository', async () => {
    const res = await executeNCodeTool({
      tool: 'git_diff',
      args: {},
      workspaceDir: process.cwd()
    });
    expect(res.status).toBe('success');
  });

  it('rejects unknown tool gracefully', async () => {
    const res = await executeNCodeTool({
      tool: 'nonexistent_tool',
      args: {}
    });
    expect(res.status).toBe('error');
    expect(res.stderr).toContain('Unknown tool: nonexistent_tool');
  });

  // The model is told its workspace is the one shared folder, so every path it supplies
  // has to stay inside it. These pin the boundary down from both directions: absolute paths
  // are not banned outright, only ones that land somewhere else.
  describe('workspace containment', () => {
    const outsideDir = path.dirname(tempDir);

    it('reads a file addressed by absolute path inside the folder', async () => {
      const res = await executeNCodeTool({
        tool: 'read_file',
        args: { path: path.join(tempDir, 'sub', 'test.txt') },
        workspaceDir: tempDir
      });
      expect(res.status).toBe('success');
      expect(res.stdout).toBe('Hello NCode');
    });

    it('refuses to read an absolute path outside the folder', async () => {
      const res = await executeNCodeTool({
        tool: 'read_file',
        args: { path: path.join(outsideDir, 'ncode-escape.txt') },
        workspaceDir: tempDir
      });
      expect(res.status).toBe('error');
      expect(res.stderr).toContain('shared folder');
    });

    it('refuses to write through a traversal out of the folder', async () => {
      const res = await executeNCodeTool({
        tool: 'write_file',
        args: { path: path.join('..', 'ncode-escape.txt'), content: 'nope' },
        workspaceDir: tempDir
      });
      expect(res.status).toBe('error');
      expect(res.stderr).toContain('shared folder');
    });

    it('refuses a shell cwd outside the folder', async () => {
      const res = await executeNCodeTool({
        tool: 'shell',
        args: { command: 'echo hi', cwd: outsideDir },
        workspaceDir: tempDir
      });
      expect(res.status).toBe('error');
      expect(res.stderr).toContain('shared folder');
    });

    it('refuses a git_diff cwd outside the folder', async () => {
      const res = await executeNCodeTool({
        tool: 'git_diff',
        args: { cwd: outsideDir },
        workspaceDir: tempDir
      });
      expect(res.status).toBe('error');
      expect(res.stderr).toContain('shared folder');
    });

    it('leaves nothing behind when a write is refused', async () => {
      await fs.mkdir(outsideDir, { recursive: true });
      const escapeTarget = path.join(outsideDir, 'ncode-escape.txt');
      await executeNCodeTool({
        tool: 'write_file',
        args: { path: escapeTarget, content: 'nope' },
        workspaceDir: tempDir
      });
      await expect(fs.access(escapeTarget)).rejects.toThrow();
    });
  });
});
