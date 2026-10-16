/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { startBridge, legacyBridgeListenerEnabled } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { getConfig } from '../config.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, noteNCodeDelivery, type InputArgs, type InputEntry } from './input.js';
import { isExtensionConnected, getNCodeConnectionState, onNCodeConnection, startGoalInGemini, sendUserMessageToGemini, getLatestPlan, getLatestFinish } from '../ncode-bridge.js';
import { buildNCodeBootstrapPrompt } from '../prompts/ncode-bootstrap.js';

function wakeBrowser(entry: InputEntry, retry = false): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  return wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true);
}
/**
 * Connection setup, not the browser, stopped this send (#882 VM test, 2026-10-04: a fresh install
 * said "Browser startup failed: Add a folder before connecting"). Its own prefix says what to do;
 * retry accepts both, so the message still goes out once Setup is done.
 */
const SETUP_PREFIX = 'Message queued. Finish Setup to send: ';
const BROWSER_PREFIX = 'Message queued. Browser startup failed: ';
class SetupNotReady extends Error {}
const startupError = (error: unknown): string =>
  (error instanceof SetupNotReady ? SETUP_PREFIX : BROWSER_PREFIX) + (error as Error).message;

async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await the existing status authority before browser work; local admission is already durable.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new SetupNotReady(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  signal?.throwIfAborted();
  // The legacy ChatGPT listener is off at runtime (see legacyBridgeListenerEnabled); NCode's own
  // readiness signal is the Gemini companion socket, so its absence must not fail a send.
  if (legacyBridgeListenerEnabled() && !await startBridge()) throw new Error('The browser bridge could not start.');
  signal?.throwIfAborted();
}
/**
 * NCode's transport is the local bridge to the Gemini companion tab, not a browser this app
 * opens itself. When the companion is connected, a send is delivered the moment it is accepted:
 * the user's turn is committed as sent, so the outbox hold, its retry affordance and the
 * composer's pending Stop square all end immediately. No connector startup is consulted on this
 * path, which is why a missing or malformed tunnel can never hold a message again.
 */
const EXTENSION_WAIT_MS = 2000;
// A send that found no companion has to launch a browser and load a Gemini page, which is a
// different order of work than the two-second companion hiccup above.
const GEMINI_TAB_WAIT_MS = 12000;
// A note about the Gemini tab, not a connector diagnosis: while the bridge listens, the OpenAI
// connector and the Cloudflare tunnel ID it demands are not part of this send at all.
const GEMINI_TAB_WAIT_NOTE = 'Waiting for the Gemini tab. Open gemini.google.com and send again.';
async function waitForExtension(signal?: AbortSignal, timeoutMs = EXTENSION_WAIT_MS): Promise<boolean> {
  if (isExtensionConnected()) return true;
  return await new Promise<boolean>((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); resolve(isExtensionConnected()); }, timeoutMs);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); resolve(false); };
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = onNCodeConnection((state) => {
      if (!state.extension) return;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); unsubscribe(); resolve(true);
    });
  });
}
async function deliverOverNCode(entry: InputEntry): Promise<InputEntry | null> {
  // The first turn of a goal carries the bootstrap prompt. Anything after a plan or a reported
  // finish is an ordinary follow-up inside the same Gemini chat, which only needs the text.
  const followUp = getLatestPlan().length > 0 || getLatestFinish() !== null;
  const dispatched = followUp
    ? sendUserMessageToGemini(entry.text)
    : startGoalInGemini(entry.text, buildNCodeBootstrapPrompt({
      goal: entry.text,
      workspacePath: getConfig().roots?.[0]?.path
    }));
  if (!dispatched) return null;
  return await noteNCodeDelivery(entry.id);
}
async function deliver(entry: InputEntry, retry = false): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
let stopped = false;
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}
async function startAcceptedInput(entry: InputEntry, controller: AbortController): Promise<void> {
  try {
    controller.signal.throwIfAborted();
    const connection = getNCodeConnectionState();
    if (connection.bridge) {
      // The NCode bridge is listening, so this send never consults the ChatGPT connector: no
      // connect(), no startTunnel, and therefore no tunnel-ID requirement can hold it.
      let connected = connection.extension;
      if (!connected) {
        // No companion yet. Ask the extension to bring up a Gemini tab — it opens
        // https://gemini.google.com/app when this browser holds none — then wait for the relay.
        wakeBrowserWork('wake');
        connected = await waitForExtension(controller.signal, GEMINI_TAB_WAIT_MS);
      }
      controller.signal.throwIfAborted();
      if (connected) {
        const delivered = await deliverOverNCode(entry);
        if (delivered) return;
      }
      await noteInputStartupError(entry.id, GEMINI_TAB_WAIT_NOTE);
      return;
    }
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const current = (await listInputs()).find(row => row.id === entry.id);
    controller.signal.throwIfAborted();
    if (current?.state === 'queued') await deliver(current);
  } catch (error) {
    if (!controller.signal.aborted) await noteInputStartupError(entry.id, startupError(error));
  } finally {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
  }
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (input.mode === 'finish' || starting.has(input.id)) return enqueueInput(input);
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    const entry = await enqueueInput(input);
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    if (entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool') {
      starting.delete(input.id); return entry;
    }
    // Return after durable admission, not after connection startup or native delivery.
    void startAcceptedInput(entry, controller).catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === controller) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!(entry.error?.startsWith(BROWSER_PREFIX) || entry.error?.startsWith(SETUP_PREFIX) || entry.error?.startsWith('Local chat setup failed:'));
  if (!eligible((await listInputs()).find(entry => entry.id === id)) || stopped || starting.has(id)) return null;
  const controller = new AbortController(); starting.set(id, controller);
  try {
    const repaired = await noteInputStartupError(id, null);
    if (repaired?.error?.startsWith('Local chat setup failed:')) return repaired;
    await ready(controller.signal);
    const entry = (await listInputs()).find(row => row.id === id);
    controller.signal.throwIfAborted();
    return entry?.state === 'queued' ? await deliver(entry, true) : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    return await noteInputStartupError(id, startupError(error));
  } finally { if (starting.get(id) === controller) starting.delete(id); }
}
export function resetInputStartupForTests(): void { stopInputStartup(); stopped = false; resetBrowserStartupForTests(); }
