import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
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

describe('a live Gemini chat URL is the conversation the popup reports', () => {
  const background = readFileSync(repoFile('extension/background.js'), 'utf8').replace(/\r\n/g, '\n');

  function slice(name: string): string {
    const match = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm').exec(background);
    if (!match) throw new Error(`${name} was not found in extension/background.js`);
    return match[0];
  }

  // The parser under test is the shipped background.js source loaded into a fresh context, so the
  // route shapes are proven against the real regexes rather than a copy of them.
  const urlParsing = runInNewContext(
    [
      slice('cleanConversationId'),
      slice('conversationFromUrl'),
      slice('isGeminiUrl'),
      '({ cleanConversationId, conversationFromUrl, isGeminiUrl })'
    ].join('\n'),
    { URL }
  ) as {
    cleanConversationId: (value: unknown) => string | null;
    conversationFromUrl: (value: unknown) => string | null;
    isGeminiUrl: (value: unknown) => boolean;
  };

  it('parses the /app/<id> route a live Gemini tab actually has', () => {
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/app/c85317e1183c88b')).toBe('c85317e1183c88b');
  });

  it('normalizes the c_ prefix Gemini writes onto the same conversation', () => {
    expect(urlParsing.cleanConversationId('c_c85317e1183c88b')).toBe('c85317e1183c88b');
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/app/c_c85317e1183c88b')).toBe('c85317e1183c88b');
  });

  it('still reads the legacy /c/ and per-gem routes', () => {
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/c/c85317e1183c88b')).toBe('c85317e1183c88b');
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/g/gem-1234/c/c85317e1183c88b')).toBe('c85317e1183c88b');
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/gem/skywalker/c85317e1183c88b')).toBe('c85317e1183c88b');
  });

  it('refuses a share link, a foreign host and anything that is not a URL', () => {
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/share/c/c85317e1183c88b')).toBeNull();
    expect(urlParsing.conversationFromUrl('https://example.com/app/c85317e1183c88b')).toBeNull();
    expect(urlParsing.conversationFromUrl('https://gemini.google.com/')).toBeNull();
    expect(urlParsing.conversationFromUrl('not a url')).toBeNull();
    expect(urlParsing.isGeminiUrl('https://gemini.google.com/app/new')).toBe(true);
    expect(urlParsing.isGeminiUrl('https://example.com/app/c85317e1183c88b')).toBe(false);
  });
});

interface StatusProjection {
  tab: number | null;
  isChat: boolean;
  url: string | null;
  conversationId: string | null;
  bound: boolean;
  documentId: string | null;
  epoch: number | null;
  terminal: boolean;
  recorder: boolean;
  relay: boolean;
  ncodeRecorder: Record<string, unknown> | null;
  page: Record<string, unknown> | null;
  chatTabs: number;
  pendingAll: number;
  delivery: unknown;
}

describe('the popup status projection reports a live Gemini recorder and relay', () => {
  const background = readFileSync(repoFile('extension/background.js'), 'utf8').replace(/\r\n/g, '\n');

  function sliceFunction(name: string): string {
    const match = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm').exec(background);
    if (!match) throw new Error(`${name} was not found in extension/background.js`);
    return match[0];
  }

  function sliceMethod(): string {
    const match = /^  async tabStatus\(\) \{[\s\S]*?\n  \},/m.exec(background);
    if (!match) throw new Error('tabStatus was not found in extension/background.js');
    return match[0];
  }

  // The popup reads its conversation through the real tabStatus() handler, so the projection is
  // executed from the shipped background.js source inside a fresh context with only its chrome
  // surface stubbed: one active Gemini chat tab, one bound document and no live recorder failures.
  function harness(options: { probeThrows?: boolean; companion?: Record<string, unknown> | null } = {}): {
    status: () => Promise<StatusProjection>;
    probes: Array<Record<string, unknown>>;
  } {
    const probes: Array<Record<string, unknown>> = [];
    const tab = { id: 42, url: 'https://gemini.google.com/app/c85317e1183c88b' };
    const companion =
      options.companion === undefined
        ? {
            recorderInstalled: true,
            relayOpen: true,
            requestId: 'req-c85317e1183c88b',
            chatId: 'c85317e1183c88b'
          }
        : options.companion;
    const tabStatus = runInNewContext(
      [
        sliceFunction('cleanConversationId'),
        sliceFunction('conversationFromUrl'),
        sliceFunction('isGeminiUrl'),
        `const HANDLERS = {\n${sliceMethod()}\n};`,
        'HANDLERS.tabStatus;'
      ].join('\n'),
      {
        URL,
        load: async () => undefined,
        chrome: {
          tabs: {
            query: async () => [tab]
          }
        },
        GEMINI_TAB_URLS: ['https://gemini.google.com/*'],
        tabConversations: {},
        tabDocuments: { '42': 'doc-1' },
        tabEpochs: { '42': 3 },
        terminalDocuments: {},
        tabReply: async (
          _tab: unknown,
          message: Record<string, unknown>,
          extra?: Record<string, unknown>
        ) => {
          probes.push({ ...message, ...(extra ?? {}) });
          if (options.probeThrows) throw new Error('the Gemini page did not answer');
          return { ok: true, conversationId: 'c85317e1183c88b' };
        },
        ncodeCompanion: () => companion,
        journal: [],
        closeOutbox: [],
        commandAckOutbox: [],
        delivery: null
      }
    ) as () => Promise<StatusProjection>;
    return { status: tabStatus, probes };
  }

  it('reports the recorder, the relay and the chat id a live Gemini tab has', async () => {
    const { status, probes } = harness();
    const projection = await status();
    expect(probes).toEqual([{ type: 'clf-page-status', documentId: 'doc-1' }]);
    expect(projection.tab).toBe(42);
    expect(projection.isChat).toBe(true);
    expect(projection.recorder).toBe(true);
    expect(projection.relay).toBe(true);
    expect(projection.conversationId).toBe('c85317e1183c88b');
    expect(projection.page).toEqual({ ok: true, conversationId: 'c85317e1183c88b' });
    expect(projection.bound).toBe(false);
    expect(projection.documentId).toBe('doc-1');
    expect(projection.epoch).toBe(3);
    expect(projection.chatTabs).toBe(1);
    expect(projection.ncodeRecorder).toEqual({
      recorderInstalled: true,
      requestId: 'req-c85317e1183c88b',
      chatId: 'c85317e1183c88b'
    });
  });

  it('keeps the URL conversation when the page recorder is gone', async () => {
    const { status } = harness({ probeThrows: true, companion: null });
    const projection = await status();
    expect(projection.page).toBeNull();
    expect(projection.recorder).toBe(false);
    expect(projection.relay).toBe(false);
    expect(projection.ncodeRecorder).toBeNull();
    expect(projection.conversationId).toBe('c85317e1183c88b');
  });
});
