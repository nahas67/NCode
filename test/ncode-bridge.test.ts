import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { WebSocket } from 'ws';

// MCP_CALL resolves its workspace from the shared folder rather than process.cwd(), so the
// bridge needs a config before it will touch the disk.
const mocks = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ roots: mocks.root ? [{ path: mocks.root }] : [] })
}));

import {
  startNCodeBridge,
  stopNCodeBridge,
  onNCodePlan,
  onNCodeFinish,
  isAllowedOrigin,
  normalizeSyncedModels,
  isExtensionConnected,
  startGoalInGemini,
  requestGeminiCheckpoint,
  switchGeminiModel
} from '../src/main/ncode-bridge.js';
import {
  APP_ID,
  BRIDGE_HOST,
  EXTENSION_CLIENT_ID,
  GEMINI_ORIGIN,
  WS_PATH
} from '../src/shared/ncode-config.js';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

describe('ncode websocket bridge', () => {
  const TEST_PORT = 45885;

  beforeAll(async () => {
    mocks.root = process.cwd();
    await startNCodeBridge(TEST_PORT, BRIDGE_HOST);
  });

  afterAll(async () => {
    await stopNCodeBridge();
  });

  function createClient(queryOrHeader: { query?: string; header?: boolean; origin?: string } = {}) {
    let url = `ws://${BRIDGE_HOST}:${TEST_PORT}${WS_PATH}`;
    if (queryOrHeader.query) url += `?client=${queryOrHeader.query}`;
    const options: Record<string, unknown> = {};
    if (queryOrHeader.header) options.headers = { 'x-ncode-client': EXTENSION_CLIENT_ID };
    if (queryOrHeader.origin) options.origin = queryOrHeader.origin;
    const ws = new WebSocket(url, options);

    const queue: any[] = [];
    const waiters: Array<(msg: any) => void> = [];

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else queue.push(parsed);
      } catch {
        // ignore
      }
    });

    const nextMessage = (timeoutMs = 5000): Promise<any> => {
      return new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(resolver);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
        }, timeoutMs);
        const resolver = (msg: any) => {
          clearTimeout(timer);
          resolve(msg);
        };
        waiters.push(resolver);
      });
    };

    const waitOpen = (): Promise<boolean> => {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) { resolve(true); return; }
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
      });
    };

    const close = async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        ws.close();
      });
    };

    return { ws, nextMessage, waitOpen, close };
  }

  it('rejects handshake without valid client identifier', async () => {
    const ws = new WebSocket(`ws://${BRIDGE_HOST}:${TEST_PORT}${WS_PATH}`);
    let receivedStatusCode = 0;

    const promise = new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        receivedStatusCode = res.statusCode ?? 0;
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', () => {
        resolve(receivedStatusCode || 403);
      });
    });

    const code = await promise;
    expect(code).toBe(403);
    ws.terminate();
  });

  it('accepts handshake when presenting ncode-gemini-extension via query parameter', async () => {
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    const opened = await client.waitOpen();
    expect(opened).toBe(true);

    const hello = await client.nextMessage();
    expect(hello.type).toBe('HELLO');
    expect(hello.app).toBe('ncode-gemini-host');

    await client.close();
  });

  it('accepts handshake when presenting ncode-gemini-extension via header', async () => {
    const client = createClient({ header: true });
    const opened = await client.waitOpen();
    expect(opened).toBe(true);

    const hello = await client.nextMessage();
    expect(hello.type).toBe('HELLO');

    await client.close();
  });

  it('accepts handshake from the Gemini page origin alone', async () => {
    const client = createClient({ origin: GEMINI_ORIGIN });
    const opened = await client.waitOpen();
    expect(opened).toBe(true);

    const hello = await client.nextMessage();
    expect(hello.type).toBe('HELLO');

    await client.close();
  });

  it('rejects handshake whose origin only contains gemini.google.com', async () => {
    expect(await rejectedStatusCodeFor({ origin: 'https://gemini.google.com.evil.example' })).toBe(403);
  });

  it('rejects handshake from an unrelated page origin', async () => {
    expect(await rejectedStatusCodeFor({ origin: 'https://evil.example/?gemini.google.com' })).toBe(403);
  });

  /**
   * The bridge answers a refused upgrade with a raw 403 line rather than a WebSocket close
   * frame, so `ws` surfaces it as `unexpected-response`; the error fallback covers a server
   * that simply drops the socket.
   */
  function rejectedStatusCodeFor(queryOrHeader: { query?: string; header?: boolean; origin?: string }): Promise<number> {
    const { ws } = createClient(queryOrHeader);
    return new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(403));
    });
  }

  it('executes tool via MCP_CALL and returns MCP_RESULT', async () => {
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    await client.waitOpen();

    // Consume HELLO
    const hello = await client.nextMessage();
    expect(hello.type).toBe('HELLO');

    client.ws.send(JSON.stringify({
      type: 'MCP_CALL',
      id: 'test-1',
      tool: 'shell',
      args: { command: 'node -e "console.log(\'bridge-ok\')"' }
    }));

    const result = await client.nextMessage();
    expect(result.type).toBe('MCP_RESULT');
    expect(result.id).toBe('test-1');
    expect(result.status).toBe('success');
    expect(result.stdout).toContain('bridge-ok');
    // The host builds the whole turn prompt so the extension has one producer, not two.
    expect(typeof result.prompt).toBe('string');
    expect(result.prompt).toContain('<ncode_result id="test-1" tool="shell" status="success">');
    expect(result.prompt).toContain('[SYSTEM DIRECTIVE - ANTI-DRIFT]');
    expect(result.prompt.indexOf('</ncode_result>')).toBeLessThan(
      result.prompt.indexOf('[SYSTEM DIRECTIVE - ANTI-DRIFT]')
    );
    // Main must not also emit a compact directive: the extension owns that decision.
    expect(result.prompt).not.toContain('[COMPACT & RESUME DIRECTIVE]');

    await client.close();
  });

  it('refuses to run a tool when no folder is shared', async () => {
    mocks.root = '';
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    await client.waitOpen();
    await client.nextMessage(); // HELLO

    client.ws.send(JSON.stringify({
      type: 'MCP_CALL',
      id: 'no-root',
      tool: 'shell',
      args: { command: 'echo should-not-run' }
    }));

    const result = await client.nextMessage();
    expect(result.type).toBe('MCP_RESULT');
    expect(result.id).toBe('no-root');
    expect(result.status).toBe('error');
    expect(result.stderr).toMatch(/folder/i);
    // A refusal still has to carry the turn prompt, or the model gets a bare error with no
    // instruction to stop and report instead of retrying the same call.
    expect(result.prompt).toContain('<ncode_result id="no-root" tool="shell" status="error">');
    expect(result.prompt).toContain('[SYSTEM DIRECTIVE - ANTI-DRIFT]');

    mocks.root = process.cwd();
    await client.close();
  });

  it('handles MODELS_SYNC and NCODE_PLAN and NCODE_FINISH messages', async () => {
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    await client.waitOpen();
    await client.nextMessage(); // HELLO

    let planReceived: any = null;
    const unsubPlan = onNCodePlan((plan) => { planReceived = plan; });

    let finishReceived: any = null;
    const unsubFinish = onNCodeFinish((summary) => { finishReceived = summary; });

    client.ws.send(JSON.stringify({
      type: 'MODELS_SYNC',
      activeModel: 'gemini-1.5-pro',
      models: [
        { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
        { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' }
      ]
    }));

    client.ws.send(JSON.stringify({
      type: 'NCODE_PLAN',
      plan: [{ id: '1', title: 'Task 1', status: 'completed' }]
    }));

    client.ws.send(JSON.stringify({
      type: 'NCODE_FINISH',
      summary: 'All tasks completed successfully'
    }));

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(planReceived).toEqual([{ id: '1', title: 'Task 1', status: 'completed' }]);
    expect(finishReceived).toBe('All tasks completed successfully');

    unsubPlan();
    unsubFinish();
    await client.close();
  });

  it('delivers a goal to exactly one session when two are connected', async () => {
    // Every Gemini tab runs its own content script and opens its own socket. Broadcasting a
    // goal would make each tab inject and submit the same prompt, starting one agent run per
    // tab against the same shared folder.
    const first = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await first.waitOpen()).toBe(true);
    expect((await first.nextMessage()).type).toBe('HELLO');

    const second = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await second.waitOpen()).toBe(true);
    expect((await second.nextMessage()).type).toBe('HELLO');

    const secondSawGoal = second.nextMessage(400).then(
      () => 'received',
      () => 'silent'
    );

    expect(startGoalInGemini('ship the fix', 'do the thing')).toBe(true);
    expect((await first.nextMessage()).type).toBe('START_GOAL');
    expect(await secondSawGoal).toBe('silent');

    await first.close();
    await second.close();
  });

  it('falls back to the next session when the longest-connected one goes away', async () => {
    const first = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await first.waitOpen()).toBe(true);
    expect((await first.nextMessage()).type).toBe('HELLO');

    const second = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await second.waitOpen()).toBe(true);
    expect((await second.nextMessage()).type).toBe('HELLO');

    await first.close();
    // The close event is what promotes the next socket, so let it land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(requestGeminiCheckpoint()).toBe(true);
    expect((await second.nextMessage()).type).toBe('REQUEST_CHECKPOINT');

    await second.close();
  });

  it('still broadcasts a model switch to every session', async () => {
    const first = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await first.waitOpen()).toBe(true);
    expect((await first.nextMessage()).type).toBe('HELLO');

    const second = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await second.waitOpen()).toBe(true);
    expect((await second.nextMessage()).type).toBe('HELLO');

    expect(switchGeminiModel('gemini-thinking')).toBe(true);
    expect((await first.nextMessage()).type).toBe('SET_MODEL');
    expect((await second.nextMessage()).type).toBe('SET_MODEL');

    await first.close();
    await second.close();
  });

  it('reports no delivery when nothing is connected', () => {
    expect(isExtensionConnected()).toBe(false);
    expect(startGoalInGemini('g', 'p')).toBe(false);
    expect(requestGeminiCheckpoint()).toBe(false);
  });

  /**
   * Compact & Resume. Clicking "New chat" in Gemini discards the turn history, so the bootstrap
   * prompt -- tool docs, 5-rule protocol and the user's objective -- has to be rebuilt and sent
   * back. The extension used to run `shell: echo Resumed from checkpoint:` instead, which left
   * the fresh chat with no objective at all and lost the goal for good.
   */
  it('rebuilds the bootstrap prompt when the extension asks to resume', async () => {
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await client.waitOpen()).toBe(true);
    expect((await client.nextMessage()).type).toBe('HELLO');

    client.ws.send(JSON.stringify({
      type: 'NCODE_RESUME',
      goal: 'port the parser to the new schema',
      checkpoint: {
        summary: 'Rewrote the tokenizer',
        completedTasks: ['inventory the old grammar'],
        nextSteps: ['swap the lexer over'],
        criticalFiles: ['src/parser.ts']
      }
    }));

    const reply = await client.nextMessage();
    expect(reply.type).toBe('START_GOAL');
    expect(reply.goal).toBe('port the parser to the new schema');
    // The rebuilt prompt must be the real bootstrap, not a bare restatement of the goal.
    expect(reply.prompt).toContain('port the parser to the new schema');
    expect(reply.prompt).toContain('RESUMED STATE CHECKPOINT');
    expect(reply.prompt).toContain('Rewrote the tokenizer');
    expect(reply.prompt).toContain('swap the lexer over');
    expect(reply.prompt).toContain('src/parser.ts');
    expect(reply.prompt).toContain('<ncode_tool name="shell">');

    await client.close();
  });

  it('falls back to the last known checkpoint when the resume omits one', async () => {
    const client = createClient({ query: EXTENSION_CLIENT_ID });
    expect(await client.waitOpen()).toBe(true);
    expect((await client.nextMessage()).type).toBe('HELLO');

    client.ws.send(JSON.stringify({
      type: 'NCODE_CHECKPOINT',
      checkpoint: { summary: 'earlier checkpoint', completedTasks: [], nextSteps: ['continue'] }
    }));
    client.ws.send(JSON.stringify({ type: 'NCODE_RESUME', goal: 'finish the migration' }));

    const reply = await client.nextMessage();
    expect(reply.type).toBe('START_GOAL');
    expect(reply.prompt).toContain('earlier checkpoint');
    expect(reply.prompt).toContain('finish the migration');

    await client.close();
  });
});

/**
 * The ladder regression. `syncGeminiModels` falls back to a bare `['none']` for any model
 * without `efforts`, so a host that drops the field silently collapses the user's effort
 * control to a single choice. These are pure-function tests — no socket, no port.
 */
describe('normalizeSyncedModels', () => {
  it('preserves a valid ladder in the order the extension sent it', () => {
    const models = normalizeSyncedModels([
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['high', 'low', 'medium'] }
    ]);
    expect(models).toEqual([
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['high', 'low', 'medium'] }
    ]);
  });

  it('drops non-string and unknown effort values', () => {
    const models = normalizeSyncedModels([
      { id: 'm', label: 'M', efforts: ['high', 'turbo', 7, null, {}, 'medium'] }
    ]);
    expect(models.map(m => m.efforts)).toEqual([['high', 'medium']]);
  });

  it('removes duplicate efforts and keeps first-seen order', () => {
    const models = normalizeSyncedModels([
      { id: 'm', label: 'M', efforts: ['low', 'high', 'low', 'medium', 'high'] }
    ]);
    expect(models.map(m => m.efforts)).toEqual([['low', 'high', 'medium']]);
  });

  it('falls back to the derived ladder when no valid effort survives', () => {
    const models = normalizeSyncedModels([
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: [] },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: 'high' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['nonsense'] }
    ]);
    expect(models.map(m => m.efforts)).toEqual([
      ['none', 'low', 'medium', 'high'],
      ['none', 'low', 'medium', 'high'],
      ['none', 'low', 'medium', 'high']
    ]);
  });

  it('derives a thinking/pro ladder from the model identity when the extension sends none', () => {
    // The bundled extension's payload is id/label/description only — it has no efforts field.
    const models = normalizeSyncedModels([
      { id: 'gemini-3-pro-high', label: 'Gemini 3 Pro', description: 'Best for complex tasks' },
      { id: 'thinking-mode', label: 'Thinking' },
      { id: 'gemini-flash', label: 'Gemini Flash' },
      { id: 'gemini-auto', label: 'Gemini Web' }
    ]);
    expect(models.map(m => m.efforts)).toEqual([
      ['none', 'low', 'medium', 'high'],
      ['none', 'low', 'medium', 'high'],
      ['none'],
      ['none']
    ]);
  });

  it('yields an empty array for a non-array models payload', () => {
    expect(normalizeSyncedModels(undefined)).toEqual([]);
    expect(normalizeSyncedModels(null)).toEqual([]);
    expect(normalizeSyncedModels('gemini')).toEqual([]);
    expect(normalizeSyncedModels({ models: [] })).toEqual([]);
  });

  it('never treats description as an alias', () => {
    const models = normalizeSyncedModels([
      { id: 'gemini-flash', label: 'Gemini Flash', description: 'Fastest responses for everyday chats' }
    ]);
    expect(models[0]).not.toHaveProperty('aliases');
    expect(JSON.stringify(models)).not.toContain('Fastest responses');
  });

  it('passes aliases through only when they are strings', () => {
    const models = normalizeSyncedModels([
      { id: 'a', label: 'A', aliases: ['a1', 5, 'a1', '  ', 'a2'] },
      { id: 'b', label: 'B', aliases: 'a1' }
    ]);
    expect(models.map(m => m.aliases)).toEqual([['a1', 'a2'], undefined]);
  });

  it('skips entries that are not objects and never throws', () => {
    const models = normalizeSyncedModels([null, 'gemini', 7, { label: 'Only label' }]);
    expect(models).toEqual([
      { id: 'Only label', label: 'Only label', efforts: ['none'] }
    ]);
  });
});

describe('isAllowedOrigin', () => {
  it('accepts any chrome-extension scheme origin', () => {
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(true);
    expect(isAllowedOrigin('chrome-extension://knjkdhokjajhkbdmpagjoklljffdno')).toBe(true);
  });

  it('accepts exactly the Gemini page origin', () => {
    expect(isAllowedOrigin(GEMINI_ORIGIN)).toBe(true);
    expect(isAllowedOrigin('https://gemini.google.com/')).toBe(true);
    expect(isAllowedOrigin('https://gemini.google.com/app')).toBe(true);
  });

  it('rejects a host that merely starts with gemini.google.com', () => {
    expect(isAllowedOrigin('https://gemini.google.com.evil.example')).toBe(false);
    expect(isAllowedOrigin('https://gemini.google.com.evil.example/app')).toBe(false);
  });

  it('rejects an origin that merely contains gemini.google.com', () => {
    expect(isAllowedOrigin('https://evil.example/?gemini.google.com')).toBe(false);
    expect(isAllowedOrigin('https://evil.example/#gemini.google.com')).toBe(false);
  });

  it('rejects unrelated and look-alike origins', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
    expect(isAllowedOrigin('http://gemini.google.com')).toBe(false);
    expect(isAllowedOrigin('https://google.com/?x=https://gemini.google.com')).toBe(false);
    expect(isAllowedOrigin('moz-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(false);
    expect(isAllowedOrigin('file:///etc/passwd')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
  });

  it('rejects absent, empty and malformed origins without throwing', () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
    expect(isAllowedOrigin('   ')).toBe(false);
    expect(isAllowedOrigin('gemini.google.com')).toBe(false);
    expect(isAllowedOrigin('://gemini.google.com')).toBe(false);
    expect(isAllowedOrigin('https://')).toBe(false);
    expect(isAllowedOrigin('chrome-extension://')).toBe(false);
  });
});

describe('ncode bridge lifecycle', () => {
  const LIFECYCLE_PORT = 45886;

  it('returns the same server on a repeated start and stops safely', async () => {
    const first = await startNCodeBridge(LIFECYCLE_PORT, BRIDGE_HOST);
    const second = await startNCodeBridge(LIFECYCLE_PORT, BRIDGE_HOST);
    expect(second).toBe(first);

    await stopNCodeBridge();
    // Stopping twice must not throw: the first describe already tore its own bridge down.
    await expect(stopNCodeBridge()).resolves.toBeUndefined();

    // And a fresh start after a stop still gets a new, listening server.
    const restarted = await startNCodeBridge(LIFECYCLE_PORT, BRIDGE_HOST);
    expect(restarted).not.toBe(first);
    await stopNCodeBridge();
  });
});

describe('ncode bridge http surface', () => {
  const TEST_PORT = 45887;

  beforeAll(async () => {
    await startNCodeBridge(TEST_PORT, BRIDGE_HOST);
  });

  afterAll(async () => {
    await stopNCodeBridge();
  });

  const base = () => `http://${BRIDGE_HOST}:${TEST_PORT}`;
  const readJson = async (res: globalThis.Response) => res.json() as Promise<Record<string, unknown>>;

  it('reports the bridge protocol the extension compares for equality', async () => {
    const body = await readJson(await fetch(`${base()}/hello`));
    expect(body.app).toBe(APP_ID);
    // background.js marks a port incompatible when `bridge` is absent or unequal.
    expect(body.bridge).toBe(BRIDGE_PROTOCOL);
    expect(body.compatible).not.toBe(false);
    expect(typeof body.version).toBe('string');
  });

  it('starts unpaired and reports it as a real boolean', async () => {
    const body = await readJson(await fetch(`${base()}/status`));
    expect(body.paired).toBe(false);
  });

  it('mints a pairing token as a string, which is all the extension accepts', async () => {
    const res = await fetch(`${base()}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reuse: true })
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(typeof body.token).toBe('string');
    expect((body.token as string).length).toBeGreaterThan(0);
  });

  it('reports paired once a token has been minted', async () => {
    await fetch(`${base()}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reuse: true })
    });
    expect((await readJson(await fetch(`${base()}/hello`))).paired).toBe(true);
    expect((await readJson(await fetch(`${base()}/status`))).paired).toBe(true);
  });

  it('keeps the same token for a reuse pairing', async () => {
    const first = await readJson(await fetch(`${base()}/pair`, { method: 'POST', body: '{}' }));
    const second = await readJson(await fetch(`${base()}/pair`, {
      method: 'POST',
      body: JSON.stringify({ reuse: true })
    }));
    expect(second.token).toBe(first.token);
  });

  it('rotates the token when the extension reconnects', async () => {
    const before = await readJson(await fetch(`${base()}/pair`, { method: 'POST', body: '{}' }));
    const after = await readJson(await fetch(`${base()}/pair`, {
      method: 'POST',
      body: JSON.stringify({ reconnect: true })
    }));
    expect(after.token).not.toBe(before.token);
  });

  it('still pairs when the body is missing or malformed', async () => {
    const body = await readJson(await fetch(`${base()}/pair`, {
      method: 'POST',
      body: 'not json at all'
    }));
    expect(typeof body.token).toBe('string');
  });
});

describe('ncode bridge wake socket', () => {
  const TEST_PORT = 45888;

  beforeAll(async () => {
    await startNCodeBridge(TEST_PORT, BRIDGE_HOST);
  });

  afterAll(async () => {
    await stopNCodeBridge();
  });

  const base = () => `http://${BRIDGE_HOST}:${TEST_PORT}`;
  const readJson = async (res: globalThis.Response) => res.json() as Promise<Record<string, unknown>>;
  const mintToken = async () => {
    const body = await readJson(await fetch(`${base()}/pair`, {
      method: 'POST',
      body: JSON.stringify({ reuse: true })
    }));
    return String(body.token);
  };
  /** Mirrors background.js connectWakeSocket(): plain-text frames, token first. */
  const connectWake = (host = 'browser') => new WebSocket(`ws://${BRIDGE_HOST}:${TEST_PORT}/wake?host=${host}`);

  it('accepts the token as the first frame and pushes the wake greeting', async () => {
    const token = await mintToken();
    const socket = connectWake();
    const frames: string[] = [];
    socket.on('message', (data: Buffer) => frames.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(token));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('wake socket closed before the greeting')));
      const poll = setInterval(() => {
        if (frames.includes('wake')) { clearInterval(poll); resolve(); }
      }, 20);
    });

    expect(frames).toContain('wake');
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('keeps answering heartbeat pings instead of dropping the socket', async () => {
    const token = await mintToken();
    const socket = connectWake();
    const frames: string[] = [];
    socket.on('message', (data: Buffer) => {
      const frame = data.toString();
      frames.push(frame);
      if (frame === 'ping') socket.send('pong');
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(token));
      socket.once('error', reject);
      const poll = setInterval(() => {
        if (frames.includes('wake')) { clearInterval(poll); resolve(); }
      }, 20);
    });

    // browser-wake only accepts `pong` after auth; anything else terminates the socket.
    socket.send('pong');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('serves the cos host variant the service worker also opens', async () => {
    const token = await mintToken();
    const socket = connectWake('cos');
    const frames: string[] = [];
    socket.on('message', (data: Buffer) => frames.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(token));
      socket.once('error', reject);
      const poll = setInterval(() => {
        if (frames.includes('wake')) { clearInterval(poll); resolve(); }
      }, 20);
    });

    expect(frames).toContain('wake');
    socket.close();
  });

  it('never authorises a first frame that is not the pairing token', async () => {
    await mintToken();
    const socket = connectWake();
    let authenticated = false;
    socket.on('message', (data: Buffer) => {
      if (data.toString() === 'wake') authenticated = true;
    });

    await new Promise<void>((resolve) => {
      socket.once('open', () => {
        socket.send('not-the-token');
        setTimeout(resolve, 150);
      });
      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    });

    expect(authenticated).toBe(false);
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });

  it('still upgrades the companion socket on the same port', async () => {
    const companion = new WebSocket(`ws://${BRIDGE_HOST}:${TEST_PORT}/ncode-bridge?client=ncode-gemini-extension`);
    const frames: string[] = [];
    companion.on('message', (data: Buffer) => frames.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      companion.once('open', resolve);
      companion.once('error', reject);
      companion.once('close', () => reject(new Error('companion socket closed')));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The wake handler must not destroy a socket it does not own.
    expect(companion.readyState).toBe(WebSocket.OPEN);
    expect(frames.length).toBeGreaterThan(0);
    companion.close();
  });
});
