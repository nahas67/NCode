import { describe, expect, it } from 'vitest';
import * as sharedConfig from '../src/shared/ncode-config.js';
// @ts-ignore
import * as extensionConfig from '../extension/ncode-config.js';
import { readFileSync } from 'node:fs';

describe('ncode config isolation and consistency', () => {
  it('mirrors all shared configuration constants into extension config', () => {
    expect(extensionConfig.APP_ID).toBe(sharedConfig.APP_ID);
    expect(extensionConfig.EXTENSION_CLIENT_ID).toBe(sharedConfig.EXTENSION_CLIENT_ID);
    expect(extensionConfig.BRIDGE_HOST).toBe(sharedConfig.BRIDGE_HOST);
    expect(extensionConfig.BRIDGE_PORT).toBe(sharedConfig.BRIDGE_PORT);
    expect(extensionConfig.WS_PATH).toBe(sharedConfig.WS_PATH);
    expect(extensionConfig.BRIDGE_ORIGIN).toBe(sharedConfig.BRIDGE_ORIGIN);
    expect(extensionConfig.BRIDGE_URL).toBe(sharedConfig.BRIDGE_URL);
    expect(extensionConfig.GEMINI_ORIGIN).toBe(sharedConfig.GEMINI_ORIGIN);
    expect(extensionConfig.GEMINI_MATCH).toBe(sharedConfig.GEMINI_MATCH);
    expect(extensionConfig.COMPACT_AFTER_TURNS).toBe(sharedConfig.COMPACT_AFTER_TURNS);
  });

  it('declares the strict host permissions in extension/manifest.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.host_permissions).toContain(sharedConfig.GEMINI_MATCH);
    expect(manifest.host_permissions).toContain(sharedConfig.BRIDGE_HOST_PERMISSION);
    expect(manifest.permissions).toEqual(['tabs', 'storage', 'scripting']);
  });

  it('uses isolated port 45880 outside legacy ranges', () => {
    expect(sharedConfig.BRIDGE_PORT).toBe(45880);
    expect(sharedConfig.BRIDGE_HOST).toBe('127.0.0.1');
    expect(sharedConfig.WS_PATH).toBe('/ncode-bridge');
  });
});
