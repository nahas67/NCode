/**
 * The Gemini extension's state in the renderer.
 *
 * `src/main/ncode-bridge.ts` owns every fact here: it holds the socket, the model catalog the
 * page reports, and the last plan/checkpoint/finish. This only projects that state into the
 * surfaces the shell already has — the Setup wizard's connect step, the sidebar connection
 * popover and the composer dock — so "is the extension actually paired?" and "which loopback
 * port does it need?" are answerable without reading the log.
 *
 * The popover's whole header and all three rows are painted from one record here, not from two
 * places: this module is the only writer of `#connectionPopover`, its title and its three rows.
 *
 * Nothing here decides. The send path never waits on it: a send that reaches main is exactly
 * the send that used to happen, paired or not.
 */

import type { NCodeCheckpoint, NCodePlanStep } from '../shared/ncode-protocol.js';
import { BRIDGE_HOST, BRIDGE_PORT } from '../shared/ncode-config.js';
import { t, ui } from './i18n.js';

/** The connection record exactly as `src/main/ncode-bridge.ts` publishes it. */
type NCodeConnectionState = {
  bridge: boolean;
  extension: boolean;
  geminiTab: boolean;
  paired: boolean;
  modelsSynced: boolean;
  activeModel: string | null;
  geminiTabs: number;
  /** `extension` under the name the wire and the send gate already use. */
  connected: boolean;
};

/** `ncode:status` answers with these names; a newer push for any of them supersedes the read. */
type NCodeStatus = NCodeConnectionState & {
  plan: NCodePlanStep[];
  checkpoint: NCodeCheckpoint | null;
  finish: string | null;
  /** False when the legacy browser bridge is switched off at runtime. */
  legacyBridge?: boolean;
};

/** null until the first status read or push answers: unknown is not "not connected". */
let connection: NCodeConnectionState | null = null;
let plan: NCodePlanStep[] = [];
let checkpoint: NCodeCheckpoint | null = null;
let finish: string | null = null;
let legacyBridge = true;

/**
 * Whether the legacy browser bridge is running. With it off there is no legacy session or tunnel
 * to connect, so its verdict is not this app's connection state and must not be shown as one.
 */
export function ncodeLegacyBridgeActive(): boolean { return legacyBridge; }

/**
 * Whether the extension itself is reachable. An unread state is not connected.
 *
 * This is the extension row's own fact — it reached this process — read from `extension` rather
 * than from the `connected` alias the wire also carries, so the two names can never disagree. It
 * stays true after a Gemini tab closes, which is what pairing actually proved.
 */
export function ncodeConnected(): boolean { return connection?.extension === true; }

/** A pushed value is trusted only as far as the wire type allows. */
function readPlan(value: unknown): NCodePlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter((step): step is NCodePlanStep =>
    !!step && typeof step === 'object' && typeof (step as NCodePlanStep).title === 'string');
}

function readCheckpoint(value: unknown): NCodeCheckpoint | null {
  return value && typeof value === 'object' && typeof (value as NCodeCheckpoint).summary === 'string'
    ? value as NCodeCheckpoint
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBool(value: unknown): boolean { return value === true; }

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Accepts a connection record only when every field it claims arrived with its own type.
 *
 * A partial push would silently drop a row back to "not connected", so an incomplete record is
 * ignored whole and the previous one keeps painting until a complete one replaces it.
 */
function readConnection(value: unknown): NCodeConnectionState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.bridge !== 'boolean' || typeof raw.extension !== 'boolean' || typeof raw.geminiTab !== 'boolean') return null;
  return {
    bridge: raw.bridge,
    extension: raw.extension,
    geminiTab: raw.geminiTab,
    paired: readBool(raw.paired),
    modelsSynced: readBool(raw.modelsSynced),
    activeModel: readText(raw.activeModel),
    geminiTabs: readCount(raw.geminiTabs),
    connected: raw.extension
  };
}

/** Loopback endpoint the extension has to be allowed; the port is never spelled out here. */
function endpoint(): string {
  return `${BRIDGE_HOST}:${BRIDGE_PORT}`;
}

function companionText(): string {
  return ncodeConnected()
    ? t('Gemini extension paired on {0}', [endpoint()])
    : connection
      ? t("Gemini extension not paired. Allow {0} in the extension's host permissions.", [endpoint()])
      : t('Gemini extension · {0}', [endpoint()]);
}

/** Bounded, so one long model summary cannot turn a status row into a wall of text. */
function clip(text: string, limit = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * The newest thing the companion reported, as one dock line. The order is the protocol's:
 * a finish retires the checkpoint and the plan, and a checkpoint is newer than a plan.
 */
function activityText(): string | null {
  if (finish) return t('NCode finished: {0}', [clip(finish)]);
  if (checkpoint) return t('NCode checkpoint: {0} ({1} done, {2} next)',
    [clip(checkpoint.summary), checkpoint.completedTasks?.length ?? 0, checkpoint.nextSteps?.length ?? 0]);
  if (plan.length) return t('NCode plan · {0} of {1} steps done · {2}',
    [plan.filter(step => step.status === 'completed').length, plan.length,
      clip(plan.find(step => step.status === 'in_progress')?.title || plan[0]!.title)]);
  return null;
}

/**
 * The popover header. Two real states: everything is up, or the bridge is up and something the
 * user must do in the browser is not.
 *
 * This used to print the MCP connection state's own word for the panel, which meant a retired
 * ChatGPT tunnel verdict ("Tunnel unavailable") could be the headline of a product that has no
 * tunnel. The header is about NCode's three components and reads only from them.
 */
function headerText(): string {
  if (!connection?.bridge) return t('Not connected');
  return connection.extension && connection.geminiTab
    ? t('Connected · Port 45880')
    : t('Bridge listening · Port 45880');
}

/**
 * The head dot's tone, using the classes the popover stylesheet already defines.
 * `is-busy` blinks, which is exactly what "waiting for the extension or a Gemini tab" is.
 */
function headerTone(): string {
  if (!connection) return '';
  if (!connection.bridge) return 'is-error';
  return connection.extension && connection.geminiTab ? 'is-connected' : 'is-busy';
}

const POPOVER_ROWS: ReadonlyArray<{ id: string; up: (state: NCodeConnectionState) => boolean }> = [
  { id: 'connectionPopoverLocalBridge', up: state => state.bridge },
  { id: 'connectionPopoverExtension', up: state => state.extension },
  { id: 'connectionPopoverGeminiTab', up: state => state.geminiTab }
];

/** The popover's whole card plus its header, from the one connection record. */
function paintConnection(): void {
  const popover = document.getElementById('connectionPopover');
  if (!popover) return;
  const tone = headerTone();
  const className = `connection-popover scroll${tone ? ` ${tone}` : ''}`;
  if (popover.className !== className) popover.className = className;
  ui(document.getElementById('connectionPopoverTitle')!, 'textContent', headerText);
  for (const row of POPOVER_ROWS) {
    const label = document.getElementById(row.id);
    const element = label?.parentElement ?? null;
    if (!label || !element) continue;
    const up = connection ? row.up(connection) : false;
    ui(label, 'textContent', () => up ? t('Connected') : t('Not connected'));
    ui(element, 'title', () => up ? t('Connected') : t('Not connected'));
    // An unanswered record is not a failure: leave the dot neutral rather than paint it red.
    if (!connection) element.removeAttribute('data-tone');
    else element.dataset.tone = up ? 'ok' : 'bad';
  }
}

/** Setup's connect step answers "paired? on which port?" beside the composer dock. */
function paintCompanion(): void {
  const wizard = document.getElementById('wizCompanion');
  if (wizard) ui(wizard, 'textContent', companionText);
}

/** The composer dock's own notice line, beside the plan, queue and recovery rows. */
function paintActivity(): void {
  const node = document.getElementById('ncodeStatus');
  if (!node) return;
  ui(node, 'textContent', () => activityText() ?? '');
  node.hidden = activityText() === null;
}

function paint(): void {
  paintConnection();
  paintCompanion();
  paintActivity();
}

function applyStatus(value: Partial<NCodeStatus>): void {
  if (typeof value.bridge === 'boolean') {
    connection = readConnection(value) ?? connection;
  }
  if (typeof value.legacyBridge === 'boolean') legacyBridge = value.legacyBridge;
  if (value.plan !== undefined) plan = readPlan(value.plan);
  if (value.checkpoint !== undefined) checkpoint = readCheckpoint(value.checkpoint);
  if (value.finish !== undefined) finish = readText(value.finish);
  paint();
}

/**
 * Reads the current state once and keeps it live: the startup read is what paints before any
 * socket event arrives, and every push after it repaints from the same state.
 *
 * Returns its unsubscribe closures, so a host tearing this window down drops the listeners
 * it owns instead of leaving them bound to a dead document.
 */
export function initNCode(): () => void {
  const disposers: Array<() => void> = [];
  const subscribe = (add: undefined | (() => void)): void => { if (add) disposers.push(add); };
  // Paint the unknown state first, so the loopback port the extension needs is on screen even
  // if the status read below never answers.
  paint();
  void window.api.ncodeGetStatus?.()
    .then(reply => { if (reply?.ok) applyStatus(reply.data as Partial<NCodeStatus>); })
    .catch(() => undefined);
  subscribe(window.api.onNCodeConnection?.(value => applyStatus(value as Partial<NCodeStatus>)));
  subscribe(window.api.onNCodePlan?.(value => applyStatus({ plan: readPlan(value) })));
  subscribe(window.api.onNCodeCheckpoint?.(value => applyStatus({ checkpoint: value })));
  subscribe(window.api.onNCodeFinish?.(value => applyStatus({ finish: value })));
  return () => { for (const dispose of disposers.splice(0)) dispose(); };
}

/**
 * Hands a Goal/Loop submission to Gemini. Fire and forget on purpose: the answer is only
 * whether a socket took it, and nothing in the send path may wait on that.
 */
export function startNCodeGoal(goal: string, prompt: string): void {
  void window.api.ncodeStartGoal?.(goal, prompt).catch(() => undefined);
}

/**
 * Asks Gemini for a `<ncode_checkpoint>`. Exposed rather than wired to a control: the composer
 * has no affordance that means "capture state now", and reusing a delivery-choice control
 * would give it a second meaning.
 */
export function requestNCodeCheckpoint(): void {
  void window.api.ncodeRequestCheckpoint?.().catch(() => undefined);
}