import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * The shipping app must never bind the legacy ChatGPT companion listener on 8765-8769, because
 * a separate NCode install owns those ports on this machine and nothing NCode ships
 * can reach that listener anyway. These tests pin the two halves of that decision: the predicate
 * itself, and the fact that no runtime call site can start the listener while it is off.
 */
describe('legacy browser bridge listener gating', () => {
  it('reads the override, then falls back to not being Electron', async () => {
    const { legacyBridgeListenerEnabled } = await import('../src/main/bridge.js');

    const saved = process.env.NCODE_LEGACY_BRIDGE_LISTENER;
    const savedElectron = process.versions.electron;
    try {
      // Outside Electron (which is what the test runner is) the listener stays available, so the
      // 681 bridge tests keep driving a real loopback server.
      delete process.env.NCODE_LEGACY_BRIDGE_LISTENER;
      Object.defineProperty(process.versions, 'electron', { value: undefined, configurable: true });
      expect(legacyBridgeListenerEnabled()).toBe(true);

      Object.defineProperty(process.versions, 'electron', { value: '44.3.0', configurable: true });
      expect(legacyBridgeListenerEnabled()).toBe(false);
    } finally {
      Object.defineProperty(process.versions, 'electron', { value: savedElectron, configurable: true });
      if (saved === undefined) delete process.env.NCODE_LEGACY_BRIDGE_LISTENER;
      else process.env.NCODE_LEGACY_BRIDGE_LISTENER = saved;
    }
  });

  it('lets the env var win in both directions', async () => {
    const { legacyBridgeListenerEnabled } = await import('../src/main/bridge.js');

    const saved = process.env.NCODE_LEGACY_BRIDGE_LISTENER;
    const savedElectron = process.versions.electron;
    try {
      process.env.NCODE_LEGACY_BRIDGE_LISTENER = '1';
      Object.defineProperty(process.versions, 'electron', { value: '44.3.0', configurable: true });
      expect(legacyBridgeListenerEnabled()).toBe(true);

      process.env.NCODE_LEGACY_BRIDGE_LISTENER = '0';
      Object.defineProperty(process.versions, 'electron', { value: undefined, configurable: true });
      expect(legacyBridgeListenerEnabled()).toBe(false);
    } finally {
      Object.defineProperty(process.versions, 'electron', { value: savedElectron, configurable: true });
      if (saved === undefined) delete process.env.NCODE_LEGACY_BRIDGE_LISTENER;
      else process.env.NCODE_LEGACY_BRIDGE_LISTENER = saved;
    }
  });

  it('leaves startBridge() itself unguarded so the bridge tests still bind a real port', () => {
    // The gate belongs at the call sites. Baking it into startBridge() silently disabled the
    // listener under the test runner too, which skipped all 681 tests in bridge.test.ts.
    const body = read('../src/main/bridge.ts');
    const startBridge = body.slice(body.indexOf('export function startBridge('));
    expect(startBridge.slice(0, 400)).not.toContain('legacyBridgeListenerEnabled');
  });

  it('guards every runtime startBridge() call site', () => {
    // A call site that starts the listener without asking is exactly how 8765 came back.
    for (const file of ['../src/main/index.ts', '../src/main/ipc.ts', '../src/main/session/start-input.ts']) {
      const lines = read(file).split('\n');
      lines.forEach((line, index) => {
        if (!/\bstartBridge\(/.test(line) || /legacyBridgeListenerEnabled|import |from '/.test(line)) return;
        const guarded = lines[index - 1] ?? '';
        const isGuarded =
          guarded.includes('legacyBridgeListenerEnabled') || guarded.includes('!browserExtensionRequired(next)');
        expect(isGuarded, `${file}:${index + 1} ${line.trim()}`).toBe(true);
      });
    }
  });
});