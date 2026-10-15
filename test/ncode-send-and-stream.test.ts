import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { makeTempDir, removeTempDir } from './helpers.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';

// The workspace comes from config for MCP workspaces; the stream path only needs the session store,
// and the recording flag must stay on or the recorder drops the turn.
const mocks = vi.hoisted(() => ({ record: true }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ roots: [], sessions: { record: mocks.record }, ui: { backgroundChats: false } })
}));

import {
  startNCodeBridge,
  stopNCodeBridge,
  stripNCodeTags,
  getNCodeConnectionState
} from '../src/main/ncode-bridge.js';
import {
  findSessionByConversation,
  flushSessions,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { activeSessionId, onSessionChange } from '../src/main/session/recorder.js';
import { BRIDGE_HOST, EXTENSION_CLIENT_ID, WS_PATH } from '../src/shared/ncode-config.js';

const TEST_PORT = 45884;
const CONVERSATION_ID = 'c85317e1183c88b';
const TOOL_CONVERSATION_ID = 'aa11bb22cc33dd44';
const PREFIXED_CONVERSATION_ID = 'ff00ee11dd22cc33';
const WAIT = { timeout: 8000, interval: 50 } as const;
const repoFile = (relative: string): string => path.join(__dirname, '..', relative);

type AssistantEvent = {
  kind: 'assistant_message';
  messageId?: string;
  final: boolean;
  state?: string;
  message: { text: string; chars: number; truncated: boolean };
};

// The reply of a Gemini tab belongs to the session the desktop chat window is showing, which is
// the recorder's active session once the first NCode turn has been written.
async function activeAssistantEvents(): Promise<AssistantEvent[]> {
  const sessionId = activeSessionId();
  expect(sessionId, 'the NCode turn owns a session').not.toBeNull();
  const events = await readEvents(sessionId!);
  return events.filter(event => event.kind === 'assistant_message') as unknown as AssistantEvent[];
}

function connectExtensionClient(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${BRIDGE_HOST}:${TEST_PORT}${WS_PATH}?client=${EXTENSION_CLIENT_ID}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const send = (ws: WebSocket, message: Record<string, unknown>): void => {
  ws.send(JSON.stringify(message));
};

describe('NCode replies reach the Electron chat window', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir('clf-ncode-stream-');
    initDurableStore(dir);
    initSessionStore(dir);
    await startNCodeBridge(TEST_PORT, BRIDGE_HOST);
  });

  afterAll(async () => {
    await stopNCodeBridge();
    await flushSessions();
    await flushDurable();
    resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(dir);
  });

  it('reports the Gemini extension as connected, which is what releases a composer send', async () => {
    const ws = await connectExtensionClient();
    await vi.waitFor(() => expect(getNCodeConnectionState().extension).toBe(true), WAIT);
    ws.close();
  });

  it('streams a Gemini reply into the session transcript and closes the turn', async () => {
    const ws = await connectExtensionClient();
    const changes: unknown[] = [];
    const unsubscribe = onSessionChange(change => { changes.push(change); });

    // The extension streams partial text while Gemini generates.
    send(ws, { type: 'NCODE_STREAM', text: 'Hello!', conversationId: CONVERSATION_ID });
    await vi.waitFor(async () => {
      const streaming = await activeAssistantEvents();
      expect(streaming).toHaveLength(1);
      expect(streaming[0]).toMatchObject({
        messageId: `ncode:${CONVERSATION_ID}`,
        final: false,
        state: 'streaming'
      });
      expect(streaming[0]!.message.text).toBe('Hello!');
    }, WAIT);

    // A plain conversational reply completes the turn without any protocol tag.
    send(ws, {
      type: 'NCODE_TURN_COMPLETE',
      text: 'Hello! How can I help you?',
      conversationId: CONVERSATION_ID,
      hasToolCall: false,
      hasFinish: false
    });
    await vi.waitFor(async () => {
      const events = await activeAssistantEvents();
      const finals = events.filter(event => event.final);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({
        messageId: `ncode:${CONVERSATION_ID}`,
        state: 'final'
      });
      expect(finals[0]!.message.text).toBe('Hello! How can I help you?');
    }, WAIT);

    // The recorded session is the one this conversation owns.
    const owned = await findSessionByConversation(CONVERSATION_ID);
    expect(owned?.id).toBe(activeSessionId());

    // The renderer only repaints the transcript when the store broadcasts the change.
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), WAIT);
    unsubscribe();
    ws.close();
  });

  it('keeps a tool-call turn open so the composer stays on Stop until the tool finishes', async () => {
    const ws = await connectExtensionClient();
    send(ws, {
      type: 'NCODE_TURN_COMPLETE',
      text: 'Let me check.\n<ncode_tool name="shell">\n{"cmd":"ls"}\n</ncode_tool>',
      conversationId: TOOL_CONVERSATION_ID,
      hasToolCall: true
    });
    await vi.waitFor(async () => {
      const events = await activeAssistantEvents();
      const toolTurn = events.filter(event => event.messageId === `ncode:${TOOL_CONVERSATION_ID}`);
      expect(toolTurn.filter(event => event.final)).toHaveLength(0);
      expect(toolTurn[toolTurn.length - 1]).toMatchObject({ state: 'streaming', final: false });
      expect(toolTurn[toolTurn.length - 1]!.message.text).toBe('Let me check.');
    }, WAIT);
    ws.close();
  });

  it('normalizes the c_ prefix Gemini writes onto the same conversation', async () => {
    const ws = await connectExtensionClient();
    send(ws, {
      type: 'NCODE_TURN_COMPLETE',
      text: 'Done.',
      conversationId: `c_${PREFIXED_CONVERSATION_ID}`,
      hasToolCall: false
    });
    await vi.waitFor(async () => {
      const events = await activeAssistantEvents();
      const prefixed = events.filter(event => event.messageId === `ncode:${PREFIXED_CONVERSATION_ID}`);
      expect(prefixed).toHaveLength(1);
      expect(prefixed[0]).toMatchObject({ final: true, state: 'final' });
      expect(prefixed[0]!.message.text).toBe('Done.');
    }, WAIT);
    ws.close();
  });

  it('strips the NCode protocol wrappers from the prose the chat window shows', () => {
    expect(stripNCodeTags('Hello! How can I help you?')).toBe('Hello! How can I help you?');
    expect(stripNCodeTags('Working on it.\n<ncode_plan>[{"step":"Read the file"}]</ncode_plan>')).toBe('Working on it.');
    expect(stripNCodeTags('<ncode_tool name="shell">\n{"cmd":"ls"}\n</ncode_tool>')).toBe('');
    expect(stripNCodeTags('Answer\n<ncode_finish>{"summary":"done"}</ncode_finish>\nBye')).toBe('Answer\n\nBye');
  });

  it('keeps the tunnel ID out of the NCode send path', () => {
    // No code path that dispatches a composer send may consult the Cloudflare tunnel ID.
    const sendPath = [
      repoFile('src/main/ncode-bridge.ts'),
      repoFile('src/main/session/start-input.ts')
    ].map(file => readFileSync(file, 'utf8'));
    for (const source of sendPath) {
      expect(source).not.toContain('Enter a tunnel ID');
      expect(source).not.toContain('tunnelId');
    }
  });
});
