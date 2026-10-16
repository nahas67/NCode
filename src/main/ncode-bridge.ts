/**
 * NCode Loopback WebSocket Bridge.
 *
 * Listens strictly on 127.0.0.1:45880/ncode-bridge.
 *
 * A handshake is admitted when it presents the client identifier 'ncode-gemini-extension'
 * as `?client=`, or when its `Origin` parses to an allowed origin (any `chrome-extension://`
 * scheme origin, or exactly https://gemini.google.com). Anything else is closed with 403
 * before the upgrade.
 *
 * Directly routes local tool execution (shell, read_file, write_file, git_diff) over loopback.
 *
 * What admission does NOT do: it does not establish an authenticated principal beyond "a page
 * from an allowed origin, on this machine". A browser cannot set headers on a WebSocket
 * upgrade, so `x-ncode-client` is reachable only from a non-browser client (tests, scripts)
 * and `?client=` is a self-declared string any local process can write. For the same reason
 * MCP_CALL is honoured on a freshly accepted socket with no prior PAIR frame: the bundled
 * extension never sends one (it opens the socket, waits for HELLO, then calls tools), so
 * requiring it would break the only real client. The loopback bind plus the origin allowlist
 * is the entire boundary.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  APP_ID,
  BRIDGE_HOST,
  BRIDGE_PORT,
  EXTENSION_CLIENT_ID,
  GEMINI_ORIGIN,
  PROTOCOL_VERSION,
  WS_PATH
} from '../shared/ncode-config.js';
import { executeNCodeTool } from './ncode-tools.js';
import { syncGeminiModels } from './chat-models.js';
import { buildNCodeBootstrapPrompt } from './prompts/ncode-bootstrap.js';
import { buildNCodeTurnPrompt } from './prompts/ncode-turn-wrapper.js';
import { attachBrowserWake } from './browser-wake.js';
import { bridgeRequestListener } from './bridge.js';
import { setSecret } from './secrets.js';
import { getConfig } from './config.js';
import { isReasoningEffort, type ReasoningEffort } from '../shared/session.js';
import { activeSessionId, notifyChanged, sessionForConversation, sessionIdForConversation } from './session/recorder.js';
import { appendEvent, upsertMessageEvent } from './session/store.js';
import type { NCodeCheckpoint, NCodePlanStep, NCodeToolResult } from '../shared/ncode-protocol.js';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from './version.js';

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

let latestPlan: NCodePlanStep[] = [];
let latestCheckpoint: NCodeCheckpoint | null = null;
let latestFinish: string | null = null;
let activeModel: string | null = null;

/**
 * Tool calls handled since boot. Only used to label the turn prompt; the extension keeps its own
 * `turnCount` and owns when to compact, so this deliberately does not drive that decision.
 */
let toolCallCount = 0;

/**
 * Credential the extension stores after POST /pair.
 *
 * The popup reports `paired` from the presence of this token, and the extension refuses to talk
 * to the bridge without one, so an app that never answers /pair looks unreachable forever. It
 * is deliberately not an authorisation decision: the WebSocket admission check is the origin
 * allowlist on the upgrade, and this token only exists so the popup and the extension agree that
 * pairing succeeded. It is regenerated on every launch, because nothing on the other side of the
 * loopback should outlive the process that minted it.
 */
let pairingToken: string | null = null;

/**
 * Companion sockets that have reported an active Gemini tab.
 *
 * `clients` holds one socket per content-script relay port, so counting sockets would count the
 * bridge's own transport rather than what the user can see. Only a content script sends
 * `MODELS_SYNC` (it is what scrapes the page's `<bard-mode-switcher>`), so a socket in this set is
 * a live tab that reported for itself, and a socket that never reported stays out. Cleared with
 * `clients`, so a closed tab stops counting without a separate sweep.
 */
const geminiTabSockets = new Set<WebSocket>();

/** The service worker reached this process over HTTP (`/hello`, `/status`) without a socket. */
let extensionReached = false;
/** An authenticated `/wake` socket is open; set from `attachBrowserWake`'s own `changed` signal. */
let wakeOpen = false;
/** A page has reported its model switcher at least once this launch. */
let modelsSynced = false;

function mintPairingToken(): string {
  // 32 hex chars from the platform CSPRNG. This is a loopback bookkeeping token, not a secret
  // that guards anything, but randomBytes keeps it from being guess-shaped if it ever is copied
  // somewhere that logs it.
  return randomBytes(16).toString('hex');
}

/**
 * The three components NCode actually is, each from the fact that owns it.
 *
 * This is the one connection record the host publishes. The renderer's popover paints these three
 * rows and nothing else: the old "MCP link" row described a ChatGPT connector this product has no
 * listener for, and the old "Extension" row read a legacy bridge flag that is never set inside
 * Electron, so neither could ever go green.
 */
export type NCodeConnectionState = {
  /** This process is listening on 127.0.0.1:45880. Nothing else about NCode works without it. */
  bridge: boolean;
  /** `extension/background.js` reached this process: /hello, /status, /pair, /wake or the upgrade. */
  extension: boolean;
  /** A live companion socket reported an active gemini.google.com tab. */
  geminiTab: boolean;
  /** POST /pair minted the credential the popup and the extension hold this launch. */
  paired: boolean;
  /** A Gemini page has reported its model switcher this launch. */
  modelsSynced: boolean;
  /** The model the page reports as its own current selection. */
  activeModel: string | null;
  /** How many live companion sockets are reporting a Gemini tab. */
  geminiTabs: number;
  /**
   * `extension` under the name the wire and the renderer's send gate already use.
   *
   * Kept as a field rather than left to each reader to infer: `chat.ts` gates the NCode send path
   * on it and the preload contract is pinned to it. It is the extension fact — reaching this
   * process at all — and deliberately not "some socket is open", which is what it used to mean
   * and which went false while the extension was perfectly reachable over its wake socket.
   */
  connected: boolean;
};

function connectionState(): NCodeConnectionState {
  const extension = extensionReached || wakeOpen || pairingToken !== null || isExtensionConnected();
  return {
    bridge: server?.listening === true,
    extension,
    geminiTab: geminiTabSockets.size > 0,
    paired: pairingToken !== null,
    modelsSynced,
    activeModel,
    geminiTabs: geminiTabSockets.size,
    connected: extension
  };
}

let lastPublished: string | null = null;

/**
 * Publishes the snapshot, but only when it actually changed.
 *
 * `/status` is polled on a timer by the popup and the legacy bridge routes, so publishing on every
 * hit would push an identical payload at the window for the rest of the session. Comparing against
 * the last published value keeps "emit on every relevant trigger" without making the trigger
 * frequency the renderer's problem.
 */
function publishConnection(): void {
  const state = connectionState();
  const encoded = JSON.stringify(state);
  if (encoded === lastPublished) return;
  lastPublished = encoded;
  for (const listener of listeners.connection) listener(state);
}

const listeners = {
  plan: new Set<(plan: NCodePlanStep[]) => void>(),
  checkpoint: new Set<(checkpoint: NCodeCheckpoint) => void>(),
  finish: new Set<(summary: string) => void>(),
  connection: new Set<(state: NCodeConnectionState) => void>()
};

export function onNCodePlan(fn: (plan: NCodePlanStep[]) => void): () => void {
  listeners.plan.add(fn);
  return () => listeners.plan.delete(fn);
}

export function onNCodeCheckpoint(fn: (cp: NCodeCheckpoint) => void): () => void {
  listeners.checkpoint.add(fn);
  return () => listeners.checkpoint.delete(fn);
}

export function onNCodeFinish(fn: (summary: string) => void): () => void {
  listeners.finish.add(fn);
  return () => listeners.finish.delete(fn);
}

export function onNCodeConnection(fn: (state: NCodeConnectionState) => void): () => void {
  listeners.connection.add(fn);
  return () => listeners.connection.delete(fn);
}

export function isExtensionConnected(): boolean {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function getNCodeConnectionState(): NCodeConnectionState {
  return connectionState();
}

export function getLatestPlan(): NCodePlanStep[] {
  return [...latestPlan];
}

export function getLatestCheckpoint(): NCodeCheckpoint | null {
  return latestCheckpoint;
}

export function getLatestFinish(): string | null {
  return latestFinish;
}

export function getActiveGeminiModel(): string | null {
  return activeModel;
}

export function sendToExtension(message: unknown): boolean {
  const payload = JSON.stringify(message);
  let sent = false;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent = true;
    }
  }
  return sent;
}

/**
 * Sends a command that must reach exactly one Gemini session.
 *
 * Every open Gemini tab runs its own copy of the content script, and each one opens its own
 * socket, so `clients` holds one entry per tab. Broadcasting a goal or a checkpoint probe to
 * all of them makes every tab inject the prompt and submit it, which starts one agent run per
 * tab against the same shared folder — the same tool then executes once per tab, concurrently,
 * in one workspace. `clients` is insertion-ordered, so the first live socket is the session
 * that has been connected longest; that is the one an app-initiated command belongs to.
 */
function sendToPrimaryClient(message: unknown): boolean {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      return true;
    }
  }
  return false;
}

export function switchGeminiModel(modelId: string): boolean {
  // Deliberately broadcast: one composer selector drives the model every tab is using.
  return sendToExtension({
    type: 'SET_MODEL',
    modelId
  });
}

export function startGoalInGemini(goal: string, prompt: string): boolean {
  return sendToPrimaryClient({
    type: 'START_GOAL',
    goal,
    prompt
  });
}

/** A follow-up turn inside an already-started goal session rides the plain composer text. */
export function sendUserMessageToGemini(text: string): boolean {
  return sendToPrimaryClient({
    type: 'USER_MESSAGE',
    text
  });
}

/**
 * The extension protocol wraps its own directives in `<ncode_*>` blocks. A plain conversational
 * reply never carries them, so the assistant bubble must show the clean prose: agent directives
 * are activity, not text the user asked to read.
 */
export function stripNCodeTags(text: string): string {
  return String(text || '')
    .replace(/<ncode_plan[\s\S]*?<\/ncode_plan>/gi, '')
    .replace(/<ncode_tool[^>]*>[\s\S]*?<\/ncode_tool>/gi, '')
    .replace(/<ncode_result[^>]*\/>/gi, '')
    .replace(/<ncode_result[\s\S]*?<\/ncode_result>/gi, '')
    .replace(/<ncode_checkpoint[\s\S]*?<\/ncode_checkpoint>/gi, '')
    .replace(/<ncode_finish[\s\S]*?<\/ncode_finish>/gi, '')
    .replace(/<\/?ncode_[a-z]+[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Write (or close) the streaming assistant turn of the NCode conversation into the session
 * transcript. `messageId` is minted per conversation so stream deltas upsert in place instead of
 * appending a bubble per 200 ms poll, and the final upsert closes the same bubble.
 */
async function recordNCodeTurn(conversationId: string | null, text: string, final: boolean): Promise<void> {
  // Gemini writes `c_<id>` into the composer URL and the recorder ids; one conversation, one key.
  const conversation = conversationId?.replace(/^c_/, '') ?? null;
  const clean = stripNCodeTags(text);
  if (!clean) return;
  const sessionId = await resolveNCodeSession(conversation);
  if (!sessionId) return;
  try {
    await upsertMessageEvent(sessionId, {
      time: Date.now(),
      source: 'app',
      kind: 'assistant_message',
      ...(conversation ? { providerMessageId: conversation } : {}),
      messageId: `ncode:${conversation ?? 'unbound'}`,
      message: { text: clean, chars: clean.length, truncated: false },
      final,
      ...(final ? { state: 'final' as const } : { state: 'streaming' as const })
    });
    notifyChanged(sessionId);
  } catch (error) {
    logWarn(`[NCode] transcript turn update failed: ${(error as Error).message}`);
  }
}

/**
 * Which session an NCode conversation writes to.
 *
 * The conversation id is the exact owner of a turn; the active session is only the fallback for
 * an unbound turn, otherwise the first NCode chat would capture every later conversation.
 */
async function resolveNCodeSession(conversationId: string | null): Promise<string | null> {
  return (conversationId ? sessionIdForConversation(conversationId) : null)
    ?? activeSessionId()
    ?? (conversationId ? await sessionForConversation(conversationId) : null);
}

/**
 * A tool the desktop ran on Gemini's behalf, recorded in the same transcript as the turn it
 * belongs to, so the chat window shows the live call and its output rather than only the reply.
 *
 * The extension reports the conversation beside the call, which is turn-grade evidence: the page
 * said which chat asked. There is no inbound x-request-id on this path, so `requestId` stays null
 * and the placement method says so instead of borrowing a stronger grade.
 */
async function recordNCodeToolCall(call: {
  conversationId: string | null;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'ok' | 'error';
  stdout: string;
  stderr: string;
  durationMs: number;
}): Promise<void> {
  const sessionId = await resolveNCodeSession(call.conversationId);
  if (!sessionId) return;
  const conversation = call.conversationId?.replace(/^c_/, '') ?? null;
  const argsText = JSON.stringify(call.args);
  const output = [call.stdout, call.stderr].filter(part => part.trim()).join('\n');
  const ok = call.status === 'ok';
  try {
    await appendEvent(sessionId, {
      time: Date.now(),
      source: 'app',
      kind: 'tool_call',
      call: {
        callId: call.callId,
        tool: call.tool,
        attribution: 'turn',
        requestId: null,
        conversationId: conversation,
        attributionMethod: 'unattributed',
        args: { text: argsText, chars: argsText.length, truncated: false },
        result: { text: output, chars: output.length, truncated: false },
        outcome: ok ? 'ok' : 'tool_execution_error',
        durationMs: call.durationMs,
        summary: {
          title: call.tool,
          ...(ok ? {} : { detail: call.stderr.trim().slice(0, 200) }),
          tone: ok ? 'good' : 'bad',
          kind: 'other'
        }
      }
    });
    notifyChanged(sessionId);
  } catch (error) {
    logWarn(`[NCode] transcript tool record failed: ${(error as Error).message}`);
  }
}

/**
 * Close the turn in the transcript when a reply finishes without a pending tool call.
 *
 * The composer's Stop control is derived state over the outbox row and the live turn, so ending the
 * turn here — with the assistant message already committed final — is what returns the button to
 * Send and the session to idle.
 */
async function closeNCodeTurn(conversationId: string | null): Promise<void> {
  const sessionId = await resolveNCodeSession(conversationId);
  if (!sessionId) return;
  const conversation = conversationId?.replace(/^c_/, '') ?? null;
  try {
    await appendEvent(sessionId, {
      time: Date.now(),
      source: 'app',
      kind: 'turn_end',
      turnId: `ncode:${conversation ?? 'unbound'}`,
      outcome: 'completed',
      detail: 'the Gemini reply completed without a pending tool call'
    });
    notifyChanged(sessionId);
  } catch (error) {
    logWarn(`[NCode] transcript turn end failed: ${(error as Error).message}`);
  }
}

export function requestGeminiCheckpoint(): boolean {
  return sendToPrimaryClient({
    type: 'REQUEST_CHECKPOINT'
  });
}

/**
 * The one origin allowlist for this listener. Both the WebSocket upgrade and the plain-HTTP
 * CORS answer use it, so a page cannot be admitted on one route and refused on the other.
 *
 * A WebSocket upgrade's `Origin` is the page the content script runs in, which is
 * https://gemini.google.com for this product. `chrome-extension://` covers the extension's
 * own pages and native hosts. Everything else — including any origin that merely *contains*
 * gemini.google.com in its host, path or query — is refused.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string') return false;
  const candidate = origin.trim();
  if (!candidate) return false;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }

  // Any installed extension is accepted; `origin` is 'null' for these schemes, so compare
  // the parsed host rather than the stringified origin.
  if (parsed.protocol === 'chrome-extension:') return parsed.hostname.length > 0;

  return parsed.origin === GEMINI_ORIGIN;
}

/** One model after normalization, ready for `syncGeminiModels`. */
export interface NormalizedSyncedModel {
  id: string;
  label: string;
  efforts: ReasoningEffort[];
  aliases?: string[];
}

/**
 * The reasoning ladder for a model whose payload carried no usable one.
 *
 * Gemini exposes a thinking control on its thinking/Pro tiers and nothing on the rest, so
 * the id and label are the only signal the host has. This is a deliberate heuristic, not a
 * claim about account entitlement — the renderer's picker still shows only what the
 * observed catalog holds. Without it every synced model collapses to a bare ['none'] and
 * the user's effort control disappears entirely.
 */
function deriveEfforts(id: string, label: string): ReasoningEffort[] {
  const identity = `${id} ${label}`.toLowerCase();
  return /\b(thinking|pro)\b/.test(identity) ? ['none', 'low', 'medium', 'high'] : ['none'];
}

/** Whitelist, drop non-strings and unknowns, de-duplicate, keep first-seen order. */
function sanitizeEfforts(raw: unknown): ReasoningEffort[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ReasoningEffort>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (!isReasoningEffort(entry)) continue;
    seen.add(entry);
  }
  return [...seen];
}

/**
 * Normalize an extension `MODELS_SYNC.models` array.
 *
 * The bundled extension does not send `efforts` at all (its payload is id/label/description),
 * so the ladder is derived from the model identity rather than forwarded blindly. A payload
 * that does carry one gets it sanitized against the shared `ReasoningEffort` vocabulary
 * instead. `description` is prose, never an alias, so it is not read here.
 */
export function normalizeSyncedModels(raw: unknown): NormalizedSyncedModel[] {
  if (!Array.isArray(raw)) return [];

  const models: NormalizedSyncedModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;

    const rawId = typeof model.id === 'string' ? model.id.trim() : '';
    const rawLabel = typeof model.label === 'string' ? model.label.trim() : '';
    const id = rawId || rawLabel || 'gemini';
    const label = rawLabel || rawId || 'Gemini';

    const efforts = sanitizeEfforts(model.efforts);
    const aliases = Array.isArray(model.aliases)
      ? [...new Set(model.aliases.filter((a): a is string => typeof a === 'string').map(a => a.trim()).filter(Boolean))]
      : [];

    models.push({
      id,
      label,
      efforts: efforts.length ? efforts : deriveEfforts(id, label),
      ...(aliases.length ? { aliases } : {})
    });
  }
  return models;
}

/**
 * Read a small JSON request body, or resolve null when there is none.
 *
 * Bounded on purpose: this listener answers local probes, and an unbounded read would let a
 * caller hold the socket open. A body that is not JSON, is empty, or exceeds the cap resolves to
 * null rather than rejecting, because every current caller treats the body as advisory.
 */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // This listener holds real shell and file authority, so the CORS answer names only
  // allowed origins. A disallowed Origin still receives its JSON; it just cannot be read
  // from a page that was not admitted. Never a wildcard — the endpoints stay reachable by
  // non-browser local clients, which send no Origin at all.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ncode-client');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);

  // The extension decides reachability from this body alone, and it uses three fields this
  // bridge previously did not send at all. `bridge` is compared for EQUALITY against the
  // extension's own BRIDGE_PROTOCOL, so a missing value makes the port read as incompatible and
  // the popup shows a version-mismatch state that no amount of retrying clears. `paired` is what
  // the popup renders, and `compatible` is only false when this process would actually refuse the
  // extension - which, because the upgrade already passed, it never does.
  const status = {
    app: APP_ID,
    version: APP_VERSION,
    bridge: BRIDGE_PROTOCOL,
    protocol: PROTOCOL_VERSION,
    connected: isExtensionConnected(),
    paired: pairingToken !== null,
    compatible: true,
    model: activeModel
  };

  if (url.pathname === '/hello' || url.pathname === '/status') {
    // The service worker probes these before it has any reason to open a socket, so reaching
    // either one is itself the fact that the extension is installed and talking to this process.
    extensionReached = true;
    publishConnection();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // POST /pair mints the credential the popup reports `paired` from. The extension sends
  // { reuse: true } for a normal pair and { reconnect: true } after a deliberate Disconnect, so
  // reuse keeps the existing token and reconnect forces a fresh one. The body is read and
  // discarded: it carries no authority, and a malformed body still gets a token rather than an
  // error the popup cannot render.
  if (url.pathname === '/pair') {
    let reconnect = false;
    await readJsonBody(req).then((body) => {
      reconnect = body?.reconnect === true;
    }).catch(() => undefined);
    if (reconnect || !pairingToken) {
      pairingToken = mintPairingToken();
      // Persist it so the delegated bridge routes below, which authenticate against the
      // `bridgeToken` secret, accept the same credential the popup and the wake socket already
      // hold. Without this the extension would pair, report ready, and then get a 401 on every
      // call it makes after that. A secure-storage failure must not break pairing itself: the
      // popup still needs the token, and the delegated routes simply stay unauthorized.
      await setSecret('bridgeToken', pairingToken).catch(() => {
        logWarn('ncode-bridge: could not persist the pairing token; delegated bridge routes will reject it.');
      });
    }
    publishConnection();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: pairingToken, app: APP_ID, bridge: BRIDGE_PROTOCOL }));
    return;
  }

  // Everything else belongs to the legacy bridge protocol, which `background.js` and `popup.js`
  // still call on this port. Delegating keeps the full protocol reachable from the single
  // BRIDGE_PORT listener without this module ever binding a second port. The routes above are
  // checked first on purpose: `bridge.ts` has its own `/hello` and `/pair`, and its `/hello` lacks
  // the `port` and `appProtocol` fields the popup reads, so letting it win would break the
  // reachability contract this module owns.
  bridgeRequestListener()(req, res);
}

async function handleClientMessage(client: WebSocket, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logWarn('ncode-bridge: malformed JSON message from client');
    return;
  }

  const type = String(msg.type ?? '');

  switch (type) {
    case 'MCP_CALL': {
      const callId = String(msg.id ?? `call-${Date.now()}`);
      const tool = String(msg.tool ?? '');
      const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>;
      const startedAt = Date.now();
      const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : null;
      toolCallCount += 1;

      // ncode-tools falls back to process.cwd() when given no workspace, which for a packaged
      // app is the install directory rather than the folder the person shared. The bootstrap
      // prompt already names roots[0] as the workspace, so the tools have to agree with it or
      // the model is told about one tree and edits another.
      const workspace = getConfig().roots?.[0]?.path?.trim();
      if (!workspace) {
        const refused: NCodeToolResult = {
          id: callId,
          tool,
          status: 'error',
          stdout: '',
          stderr: 'No shared folder is configured, so there is nowhere safe to run this. Pick a folder in Setup and retry.'
        };
        logWarn(`ncode-bridge: refused ${tool} [${callId}] — no configured workspace root`);
        void recordNCodeToolCall({
          conversationId,
          callId,
          tool,
          args,
          status: 'error',
          stdout: '',
          stderr: refused.stderr,
          durationMs: Date.now() - startedAt
        });
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'MCP_RESULT',
            ...refused,
            // The host builds the whole turn prompt, so the extension has one source of truth for
            // the result tag and the anti-drift directive. It still appends its own compact
            // directive on top, because it owns the turn threshold.
            prompt: buildNCodeTurnPrompt({ result: refused, turnNumber: toolCallCount })
          }));
        }
        break;
      }

      logInfo(`ncode-bridge: executing tool ${tool} [${callId}] in ${workspace}`);
      const result = await executeNCodeTool({
        id: callId,
        tool,
        args,
        workspaceDir: workspace
      });

      // The chat window shows the call and its output beside the turn that asked for it.
      void recordNCodeToolCall({
        conversationId,
        callId,
        tool,
        args,
        status: result.status === 'success' ? 'ok' : 'error',
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt
      });

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'MCP_RESULT',
          id: result.id,
          tool: result.tool,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          prompt: buildNCodeTurnPrompt({ result, turnNumber: toolCallCount })
        }));
      }
      break;
    }

    case 'MODELS_SYNC': {
      activeModel = typeof msg.activeModel === 'string' ? msg.activeModel : null;
      const models = normalizeSyncedModels(msg.models);
      logInfo(`ncode-bridge: synced ${models.length} models, active=${activeModel}`);
      syncGeminiModels(models, activeModel);
      // Only a content script sends this frame, so it is the one place the host is told a live
      // tab exists. A tab that cannot read its own switcher never reports and stays uncounted,
      // which is honest: there is no evidence it can serve a turn.
      geminiTabSockets.add(client);
      modelsSynced = true;
      publishConnection();
      break;
    }

    case 'NCODE_STREAM': {
      // A plain Gemini reply (or the partial while it is still streaming) is the assistant turn
      // the chat window must show; tag-only traffic keeps flowing to the plan listeners.
      if (typeof msg.text === 'string' && msg.text) {
        void recordNCodeTurn(typeof msg.conversationId === 'string' ? msg.conversationId : null, msg.text, false);
      }
      break;
    }

    case 'NCODE_TURN_COMPLETE': {
      // `displayText` is the reply with the agent directives stripped; the raw `text` stays the
      // fallback for a companion that predates the field.
      const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : null;
      const displayText = typeof msg.displayText === 'string' && msg.displayText.trim()
        ? msg.displayText
        : String(msg.text || '');
      const pendingToolCall = msg.hasToolCall === true;
      void recordNCodeTurn(conversationId, displayText, !pendingToolCall);
      // No tool call pending means the turn is over: close it so the composer leaves its busy state.
      if (!pendingToolCall) void closeNCodeTurn(conversationId);
      break;
    }

    case 'NCODE_PLAN': {
      if (Array.isArray(msg.plan)) {
        latestPlan = msg.plan as NCodePlanStep[];
        for (const listener of listeners.plan) listener(latestPlan);
      }
      break;
    }

    case 'NCODE_CHECKPOINT': {
      if (msg.checkpoint && typeof msg.checkpoint === 'object') {
        latestCheckpoint = msg.checkpoint as NCodeCheckpoint;
        for (const listener of listeners.checkpoint) listener(latestCheckpoint);
      }
      break;
    }

    // Compact & Resume. The extension clicks "New chat" to escape a degraded context, which
    // throws away the whole turn history -- including the bootstrap prompt, the tool
    // documentation and the user's objective. So the desktop rebuilds the bootstrap from the
    // checkpoint and the goal and hands it straight back. The extension cannot do this itself:
    // the prompt template lives here, and duplicating it in the content script would let the
    // two copies drift.
    case 'NCODE_RESUME': {
      const checkpoint = (msg.checkpoint && typeof msg.checkpoint === 'object'
        ? msg.checkpoint
        : latestCheckpoint) as NCodeCheckpoint | null;
      const goal = String(msg.goal ?? '');
      if (checkpoint) latestCheckpoint = checkpoint;
      if (!goal) logWarn('ncode-bridge: resume requested without a goal; the rebuilt prompt has no objective');
      logInfo(`ncode-bridge: rebuilding bootstrap prompt to resume after compact${checkpoint ? ` (${checkpoint.summary})` : ''}`);

      const prompt = buildNCodeBootstrapPrompt({
        goal,
        checkpoint,
        workspacePath: getConfig().roots?.[0]?.path
      });
      if (client.readyState !== WebSocket.OPEN) {
        logWarn('ncode-bridge: cannot resume, the companion socket closed first');
        break;
      }
      client.send(JSON.stringify({ type: 'START_GOAL', goal, prompt }));
      break;
    }

    case 'NCODE_FINISH': {
      latestFinish = String(msg.summary ?? '');
      logInfo(`ncode-bridge: received task finish: ${latestFinish}`);
      for (const listener of listeners.finish) listener(latestFinish);
      // A finish is the model's own end-of-task, which closes the turn whether or not the
      // completion frame carried the conversation id.
      void closeNCodeTurn(typeof msg.conversationId === 'string' ? msg.conversationId : null);
      break;
    }

    case 'PAIR': {
      // Not an authentication step: `msg.client` is never validated and an admitted socket
      // is already trusted without this frame. Kept for protocol compatibility; it only
      // re-sends the greeting. See the file comment for why admission is the whole boundary.
      logInfo('ncode-bridge: companion extension sent PAIR');
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'HELLO',
          app: APP_ID,
          version: APP_VERSION,
          protocol: PROTOCOL_VERSION
        }));
      }
      break;
    }

    case 'PING': {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'PONG', at: Date.now() }));
      }
      break;
    }

    default:
      logInfo(`ncode-bridge: unhandled message type ${type}`);
  }
}

/**
 * The browser-wake socket the extension service worker opens. It is a separate upgrade path from
 * WS_PATH and is handled by `browser-wake.ts`, mounted on this same server so NCode keeps exactly
 * one listening port.
 */
const WAKE_PATH = '/wake';

export async function startNCodeBridge(port = BRIDGE_PORT, host = BRIDGE_HOST): Promise<http.Server> {
  if (server) return server;

  server = http.createServer(handleHttpRequest);
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Strictly check path
    if (url.pathname !== WS_PATH) {
      // `/wake` belongs to the browser-wake handler mounted on this same server. Node runs every
      // upgrade listener, so returning without touching the socket is what lets that handler claim
      // it; ending it here would 404 a perfectly valid wake upgrade.
      if (url.pathname === WAKE_PATH) return;
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    // Handshake isolation. `?client=` is what the bundled extension actually sends, because a
    // browser cannot set headers on a WebSocket upgrade. `Origin` is the page the content
    // script runs in and cannot be forged, so it is parsed and compared exactly.
    // `x-ncode-client` is reachable only from a non-browser client (tests, local scripts);
    // no browser can attach it to a WebSocket handshake.
    const clientHeader = req.headers['x-ncode-client'];
    const clientQuery = url.searchParams.get('client');
    const origin = req.headers.origin;

    if (clientHeader !== EXTENSION_CLIENT_ID && clientQuery !== EXTENSION_CLIENT_ID && !isAllowedOrigin(origin)) {
      logWarn(`ncode-bridge: rejected handshake missing or invalid client identifier (${clientHeader || clientQuery || origin})`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    wss?.handleUpgrade(req, socket, head, (client) => {
      wss?.emit('connection', client, req);
    });
  });

  wss.on('connection', (client: WebSocket) => {
    clients.add(client);
    logInfo('ncode-bridge: companion extension connected on loopback');
    publishConnection();

    // Initial greeting
    client.send(JSON.stringify({
      type: 'HELLO',
      app: APP_ID,
      version: APP_VERSION,
      protocol: PROTOCOL_VERSION
    }));

    client.on('message', (data: Buffer | string) => {
      void handleClientMessage(client, data.toString());
    });

    client.on('close', () => {
      clients.delete(client);
      geminiTabSockets.delete(client);
      logInfo('ncode-bridge: companion extension disconnected');
      publishConnection();
    });

    client.on('error', (err) => {
      logWarn(`ncode-bridge client socket error: ${err.message}`);
      clients.delete(client);
      geminiTabSockets.delete(client);
      publishConnection();
    });
  });

  return new Promise((resolve, reject) => {
    // The extension service worker opens `/wake?host=browser|cos` on this same port. Mounting the
    // existing wake handler here is what keeps NCode to a single listener. It authenticates with the
    // token minted by `/pair`, which is the same credential the popup already holds. Its `changed`
    // fires on authenticate, on disconnect and on revoke, and the returned handle is the only owner
    // of whether a wake socket is open right now.
    const wake = attachBrowserWake(
      server!,
      (request) => {
        const origin = request.headers.origin;
        return typeof origin !== 'string' || isAllowedOrigin(origin);
      },
      async (token) => pairingToken !== null && token === pairingToken,
      () => {
        wakeOpen = wake.connected();
        publishConnection();
      },
      // Hand WS_PATH back untouched; this handler must not destroy the companion socket.
      (pathname) => pathname === WS_PATH
    );

    server!.listen(port, host, () => {
      logInfo(`NCode bridge listening on ${host}:${port}${WS_PATH}`);
      console.log(`[NCode Bridge] Listening on ws://${host}:${port}${WS_PATH}`);
      // The listener is the one component that comes up without the browser being involved.
      publishConnection();
      resolve(server!);
    });

    server!.on('error', (err) => {
      logWarn(`NCode bridge server error: ${err.message}`);
      publishConnection();
      reject(err);
    });
  });
}

export async function stopNCodeBridge(): Promise<void> {
  if (wss) {
    for (const client of clients) client.terminate();
    clients.clear();
    geminiTabSockets.clear();
    wss.close();
    wss = null;
  }
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  // Everything this launch learned is about this launch: the pairing token is regenerated on every
  // start by design, and a surviving flag would report a browser that is not there any more.
  extensionReached = false;
  wakeOpen = false;
  modelsSynced = false;
  publishConnection();
}
