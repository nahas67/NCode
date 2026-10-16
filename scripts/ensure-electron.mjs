/**
 * Guarantee the Electron binary exists before electron-vite starts.
 *
 * electron-vite resolves Electron through node_modules/electron/path.txt, and that file only
 * exists once Electron's own postinstall download has run. A node_modules carried over from a
 * cache, a download that failed halfway, or a fresh clone installed with
 * `--ignore-scripts` leaves path.txt (and the binary under dist/) missing, and `npm run dev`
 * then dies with "Error: Electron uninstall at getElectronPath (...)". Repair it here instead of
 * leaving the developer to discover the cause: if either half is missing, run Electron's own
 * installer synchronously and re-check.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');
const pathFile = path.join(electronDir, 'path.txt');
const say = (message) => process.stdout.write(`${message}\n`);

/** What is still missing, or null when the binary electron-vite resolves is on disk. */
function missingElectron() {
  if (!existsSync(installer)) return 'node_modules/electron/install.js is absent (run npm install)';
  if (!existsSync(pathFile)) return 'node_modules/electron/path.txt is absent';
  const recorded = readFileSync(pathFile, 'utf8').trim();
  if (!recorded) return 'node_modules/electron/path.txt is empty';
  if (!existsSync(path.join(electronDir, 'dist', recorded))) return `node_modules/electron/dist/${recorded}`;
  return null;
}

const before = missingElectron();
if (before) {
  say(`[ensure-electron] ${before}; running Electron's installer`);
  execFileSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' });
}

const after = missingElectron();
if (after) {
  say(`[ensure-electron] the Electron binary is still missing (${after}); run "npm install" and retry`);
  process.exitCode = 1;
} else {
  say(before ? '[ensure-electron] Electron binary installed' : '[ensure-electron] Electron binary present');
}
