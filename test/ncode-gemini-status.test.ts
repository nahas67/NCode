import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startNCodeBridge, stopNCodeBridge } from '../src/main/ncode-bridge.js';
import {
  BRIDGE_HOST,
  EXTENSION_CLIENT_ID,
  WS_PATH
} from '../src/shared/ncode-config.js';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';
import { APP_ID } from '../src/shared/ncode-config.js';

// `WebSocket` is imported as a named import because that is the form the rest of this suite
// already uses successfully; a default import arrives here as a namespace object, so
// destructuring it yielded `undefined` and `new WebSocket(...)` threw.

const TEST_PORT = 45889;
const repoFile = (relative: string): string =>
  path.join(__dirname, '..', relative.replace(/\//g, path.sep));

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-store' });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function openCompanion(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('a Gemini tab reaches the app and the app reports it connected', () => {
  beforeAll(async () => {
    await startNCodeBridge(TEST_PORT, BRIDGE_HOST);
  });

  afterAll(async () => {
    await stopNCodeBridge();
  });

  it('reports the app as connected to no companion until a Gemini tab opens its socket', async () => {
    const status = await readJson(`http://${BRIDGE_HOST}:${TEST_PORT}/status`);
    expect(status.app).toBe(APP_ID);
    expect(status.bridge).toBe(BRIDGE_PROTOCOL);
    expect(status.compatible).toBe(true);
    expect(status.connected).toBe(false);
  });

  it('flips connected to true while a Gemini tab holds the companion socket', async () => {
    const socket = await openCompanion(
      `ws://${BRIDGE_HOST}:${TEST_PORT}${WS_PATH}?client=${EXTENSION_CLIENT_ID}`
    );
    try {
      const status = await readJson(`http://${BRIDGE_HOST}:${TEST_PORT}/status`);
      expect(status.connected).toBe(true);
    } finally {
      socket.close();
    }
  });

  it('flips back to false once that tab goes away', async () => {
    const socket = await openCompanion(
      `ws://${BRIDGE_HOST}:${TEST_PORT}${WS_PATH}?client=${EXTENSION_CLIENT_ID}`
    );
    socket.close();
    // The server drops the client on its own close frame; poll for the readback rather than
    // sleeping, so the assertion cannot pass or fail on timing alone.
    const deadline = Date.now() + 5_000;
    let connected: unknown = true;
    while (Date.now() < deadline) {
      connected = (await readJson(`http://${BRIDGE_HOST}:${TEST_PORT}/status`)).connected;
      if (connected === false) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(connected).toBe(false);
  });
});

describe('the extension actually targets the Gemini tab it now repairs', () => {
  const background = readFileSync(repoFile('extension/background.js'), 'utf8');

  it('matches the Gemini host with no duplicate entries left by the rebrand', () => {
    const declared = /const GEMINI_TAB_URLS\s*=\s*(\[[^\]]*\]);/.exec(background);
    expect(declared, 'GEMINI_TAB_URLS is not declared in background.js').not.toBeNull();
    // The source literal is JavaScript, so its strings are single-quoted and `JSON.parse` would
    // reject it. Pull the quoted entries out instead of pretending the source is JSON.
    const literal = (declared as RegExpExecArray)[1] ?? '';
    const urls = [...literal.matchAll(/['"]([^'"]+)['"]/g)]
      .map((entry) => entry[1] ?? '')
      .filter((entry) => entry.length > 0);
    expect(urls).toEqual(['https://gemini.google.com/*']);
  });

  it('repairs a Gemini tab with the Gemini recorder, never the ChatGPT one', () => {
    const restore = /async function restoreGeminiTab\([\s\S]*?\n}\n/.exec(background);
    expect(restore, 'restoreGeminiTab was not found in background.js').not.toBeNull();
    const body = (restore as RegExpExecArray)[0];
    expect(body).toContain("files: ['ncode-content.js']");
    // A bare content.js injection is the defect that made every repaired Gemini tab throw
    // ReferenceError: CLF_DOM is not defined.
    expect(body).not.toMatch(/files:\s*\['content\.js'\]/);
    // The rest of the Gemini stack must still be injected by this path.
    expect(body).toContain("files: ['i18n.js']");
    expect(body).toContain("files: ['overlay.css']");
    // This path used to load `gemini-dom.js` alone, so a repair that ran before the manifest's own
    // `document_idle` injection evaluated `ncode-content.js` with no `GeminiDOM` and no
    // `NCodeProtocol`. It must now load the whole support set, in the manifest's order, and before
    // the recorder that consumes it.
    const support = body.match(/files:\s*\[[^\]]*\]/g) ?? [];
    const supportInjection = support.find((entry) => entry.includes('gemini-dom.js')) ?? '';
    expect(supportInjection).toContain("'ncode-config.js'");
    expect(supportInjection).toContain("'ncode-protocol.js'");
    expect(supportInjection).toContain("'gemini-dom.js'");
    expect(
      body.indexOf(supportInjection),
      'the support files must be injected before the recorder'
    ).toBeLessThan(body.indexOf("files: ['ncode-content.js']"));
  });

  it('leaves no path in the extension injecting the legacy ChatGPT recorder', () => {
    expect(background).not.toMatch(/files:\s*\['content\.js'\]/);
  });

  it('injects only files that exist', () => {
    const injected = [...background.matchAll(/files:\s*\[([^\]]*)\]/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
      .filter((name) => name.length > 0);
    expect(injected.length).toBeGreaterThan(0);
    for (const name of new Set(injected)) {
      expect(() => readFileSync(repoFile(`extension/${name}`), 'utf8'), name).not.toThrow();
    }
  });

  it('exposes the companion state the renderer needs to paint itself green', () => {
    const preload = readFileSync(repoFile('src/preload/index.ts'), 'utf8');
    expect(preload).toContain("call<{ connected: boolean;");
    expect(preload).toContain("ipcRenderer.on('ncode:connection'");
  });
});
