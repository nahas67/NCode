/**
 * Re-injection safety and the CLF_DOM contract.
 *
 * The manifest injects the Gemini content scripts, and `background.js` re-injects the same files
 * into the same isolated world during tab repair. Two failures came out of that: re-declaring a
 * top-level `const` is a SyntaxError that takes the whole content_scripts array down with it, and
 * a repair injected the legacy ChatGPT recorder whose `CLF_DOM` came from a file that path never
 * loads. These tests pin both closed.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const ext = (name: string): string => path.join(repo, 'extension', name);
const read = (name: string): string => fs.readFileSync(ext(name), 'utf8');

/** The files the manifest lists, in the order Chrome evaluates them. */
const CONTENT_SCRIPTS = ['ncode-config.js', 'ncode-protocol.js', 'gemini-dom.js', 'ncode-content.js'];

/** The two members that are selector strings rather than callables. */
const SELECTOR_KEYS = ['TURN_SELECTOR', 'AUTHORED_SELECTOR'];

interface Sandbox {
  context: vm.Context;
  timers: () => number;
  connects: () => number;
  /** Every `console.warn` the scripts emitted, in order. */
  warnings: () => string[];
  /**
   * Runs every still-pending interval callback once, exactly as a real timer would.
   *
   * The companion's dependency retry is a real `setInterval`, and a dependency-less boot pass is
   * supposed to leave the tab recoverable only because that timer will fire again. Counting the
   * registration is not enough to prove the retry works, so the harness runs it on demand.
   */
  tickIntervals: () => number;
}

function makeSandbox(): Sandbox {
  let intervalCount = 0;
  let connectCount = 0;
  const intervalCallbacks = new Map<number, () => void>();
  const warningMessages: string[] = [];

  // Enough of a page for the scripts to load. Nothing here is exercised by load-time code, but
  // ncode-content.js reads window.location.hostname before it will do anything at all.
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ style: {}, setAttribute: () => undefined, appendChild: () => undefined }),
    head: { appendChild: () => undefined },
    body: { appendChild: () => undefined },
    documentElement: { setAttribute: () => undefined },
    location: { href: 'https://gemini.google.com/app', pathname: '/app', search: '', origin: 'https://gemini.google.com' },
    execCommand: () => true,
    readyState: 'complete'
  };
  const windowStub = {
    location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' },
    document: documentStub,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    GeminiDOM: undefined
  };
  const chromeStub = {
    runtime: {
      // The relay socket. Counting connects is how we prove a second injection did not open a
      // second port, which would double every message the content script sends.
      connect: () => {
        connectCount += 1;
        return {
          name: 'ncode-bridge',
          postMessage: () => undefined,
          disconnect: () => undefined,
          onMessage: { addListener: () => undefined },
          onDisconnect: { addListener: () => undefined }
        };
      },
      getManifest: () => ({ version: '2.1.36' }),
      lastError: null
    },
    storage: { session: { get: () => Promise.resolve({}) } }
  };

  const context = vm.createContext({
    document: documentStub,
    window: windowStub,
    chrome: chromeStub,
    console: {
      log: () => undefined,
      warn: (message: string) => { warningMessages.push(String(message)); },
      error: () => undefined,
      info: () => undefined
    },
    setInterval: (callback: () => void) => {
      intervalCount += 1;
      intervalCallbacks.set(intervalCount, callback);
      return intervalCount;
    },
    clearInterval: (id: number) => { intervalCallbacks.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    queueMicrotask: () => undefined,
    URL,
    AbortSignal,
    fetch: () => Promise.reject(new Error('no network in this sandbox')),
    JSON,
    Math,
    Date,
    RegExp,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise
  });
  context.globalThis = context;
  return {
    context,
    timers: () => intervalCount,
    connects: () => connectCount,
    warnings: () => [...warningMessages],
    tickIntervals: () => {
      const pending = [...intervalCallbacks.values()];
      for (const callback of pending) callback();
      return pending.length;
    }
  };
}

const evaluate = (sandbox: Sandbox, file: string): void => {
  vm.runInContext(read(file), sandbox.context, { filename: file });
};

describe('extension content scripts survive re-injection', () => {
  it('runs every content script twice in one context without a SyntaxError', () => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    // The reported crash was `Identifier 'GeminiDOM' has already been declared`, thrown by the
    // second pass. A top-level `const` or `let` anywhere in these files fails right here.
    for (const file of CONTENT_SCRIPTS) {
      expect(() => evaluate(sandbox, file), `${file} must be re-injection safe`).not.toThrow();
    }
  });

  it('registers a single poller and a single relay port across two injections', () => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    const afterFirst = { timers: sandbox.timers(), connects: sandbox.connects() };
    expect(afterFirst.timers, 'the turn poller must start').toBeGreaterThan(0);
    expect(afterFirst.connects, 'the relay socket must open').toBe(1);

    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    expect(sandbox.timers(), 'a repair must not start a second poller').toBe(afterFirst.timers);
    expect(sandbox.connects(), 'a repair must not open a second relay port').toBe(1);
  });

  it('keeps the already-live companion handle rather than replacing it', () => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    const live = (sandbox.context as Record<string, unknown>).__NCODE_COMPANION__;
    expect(live, 'the first injection must publish a companion handle').toBeTruthy();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    // A caller that already captured the handle keeps working across a repair. Replacing it would
    // strand any listener the host registered on the previous instance.
    expect((sandbox.context as Record<string, unknown>).__NCODE_COMPANION__).toBe(live);
  });

  it('marks the content script loaded so a repeat injection is a no-op', () => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    expect((sandbox.context as Record<string, unknown>).__ncodeContentLoaded).toBe(true);
  });

  it('does not set the guard on a page that is not Gemini', () => {
    const sandbox = makeSandbox();
    (sandbox.context as Record<string, unknown>).window = {
      location: { hostname: 'example.test', href: 'https://example.test/', origin: 'https://example.test' }
    };
    evaluate(sandbox, 'ncode-content.js');
    expect((sandbox.context as Record<string, unknown>).__ncodeContentLoaded).toBeUndefined();
  });
});

/**
 * The recorder must survive being injected before its dependencies exist.
 *
 * `background.js` repairs a Gemini tab by re-injecting the recorder through
 * `chrome.scripting.executeScript`, and that repair can run before the manifest's own
 * `document_idle` injection — after an extension reload, or when the worker wakes onto a tab that
 * is already open. The repair used to load `ncode-content.js` alone, so the recorder evaluated with
 * no `GeminiDOM` and no `NCodeProtocol`. It then claimed initialization on the way out, which made
 * every later injection a no-op for the rest of the document: a live, signed-in Gemini tab reported
 * "No recorder in this tab. Reload the page." and reloading did not help.
 *
 * Two properties are pinned here. The repair path must load the support files it depends on, in the
 * manifest's order; and the recorder must not let a dependency-less pass consume its own one chance
 * to start.
 */
describe('the recorder survives out-of-order dependency injection', () => {
  /** The support files the recorder reads at load time, in the manifest's order. */
  const SUPPORT_FILES = ['ncode-config.js', 'ncode-protocol.js', 'gemini-dom.js'];

  it('boots on fallbacks when its dependencies are missing, and logs no warning', () => {
    const sandbox = makeSandbox();
    // The field failure, exactly: the recorder arrives with neither dependency. Aborting here is
    // what turned a recoverable ordering problem into a permanently dead page, so the pass now
    // boots on the self-contained fallback surface instead.
    evaluate(sandbox, 'ncode-content.js');

    const globals = sandbox.context as Record<string, unknown>;
    // Claiming initialization now means "the companion is live", and a fallback companion is
    // live: it answers probes, opens the relay and serves the picker.
    expect(globals.__ncodeContentLoaded, 'a fallback boot is a real boot').toBe(true);
    expect(globals.__NCODE_COMPANION__, 'the companion handle must be published').toBeTruthy();
    expect(sandbox.connects(), 'a fallback boot must still open exactly one relay port').toBe(1);
    // The whole point of the fallbacks: a missing dependency is no longer something to warn about.
    expect(sandbox.warnings(), 'a fallback boot must not log a missing-dependency warning').toEqual([]);
  });

  it('never opens a second relay port when the real dependencies arrive later', () => {
    const sandbox = makeSandbox();
    evaluate(sandbox, 'ncode-content.js');
    for (const file of SUPPORT_FILES) evaluate(sandbox, file);

    const globals = sandbox.context as Record<string, unknown>;
    expect(globals.__ncodeContentLoaded, 'the real pass must claim initialization').toBe(true);
    expect(globals.__NCODE_COMPANION__, 'the companion handle must be published').toBeTruthy();
    // The regression this guards: the relay is owned by the first successful pass and the real
    // globals rebind its DOM/Protocol in place. Two ports would double every tool call.
    expect(sandbox.connects(), 'exactly one relay port across both passes').toBe(1);
  });

  it('does not re-run the recovery pass once it has succeeded', () => {
    const sandbox = makeSandbox();
    evaluate(sandbox, 'ncode-content.js');
    for (const file of SUPPORT_FILES) evaluate(sandbox, file);
    sandbox.tickIntervals();

    const afterRecovery = { timers: sandbox.timers(), connects: sandbox.connects() };
    // A late manifest injection, or a second repair, must find a live companion and leave it alone.
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    expect(sandbox.timers(), 'a repair must not start a second poller').toBe(afterRecovery.timers);
    expect(sandbox.connects(), 'a repair must not open a second relay port').toBe(afterRecovery.connects);
  });

  it('starts the companion on the manifest order too, with no warning and one port', () => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);

    const globals = sandbox.context as Record<string, unknown>;
    expect(globals.__ncodeContentLoaded, 'the manifest order must still boot in a single pass').toBe(true);
    expect(globals.__NCODE_COMPANION__, 'the manifest order must publish the companion handle').toBeTruthy();
    expect(sandbox.connects(), 'the manifest order must open exactly one relay port').toBe(1);
    expect(sandbox.warnings(), 'an in-order boot must not warn').toEqual([]);
  });

  it('has background.js load the support files before the recorder', () => {
    // The root cause, pinned against the repair path itself so it cannot silently regress.
    const source = read('background.js');
    const signature = 'async function restoreGeminiTab(';
    const start = source.indexOf(signature);
    expect(start, 'could not locate restoreGeminiTab in background.js').toBeGreaterThan(-1);

    // Walk the function's own braces rather than guessing its length: every `files: [...]` this
    // test cares about is inside it, and a later function's injections must not satisfy the
    // ordering assertion by accident.
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) { bodyEnd = index; break; }
      }
    }
    const body = source.slice(bodyStart, bodyEnd);

    const order = [...body.matchAll(/files:\s*\[([^\]]*)\]/g)].map((match) => match[1]);
    const flattened = order.join(',');
    for (const file of SUPPORT_FILES) {
      expect(flattened, `${file} must be loaded by the repair path`).toContain(`'${file}'`);
    }
    const protocolAt = flattened.indexOf("'ncode-protocol.js'");
    const recorderAt = flattened.indexOf("'ncode-content.js'");
    expect(protocolAt, 'ncode-protocol.js must be injected before ncode-content.js').toBeGreaterThan(-1);
    expect(recorderAt, 'ncode-content.js must be injected by the repair path').toBeGreaterThan(-1);
    expect(protocolAt, 'the recorder needs its protocol before it evaluates').toBeLessThan(recorderAt);
  });
});

describe('CLF_DOM contract', () => {
  const loadBridge = (): Record<string, unknown> => {
    const sandbox = makeSandbox();
    for (const file of CONTENT_SCRIPTS) evaluate(sandbox, file);
    return sandbox.context as Record<string, unknown>;
  };

  /** Every distinct member the shipped code actually calls, with optional calls tolerated. */
  const calledMembers = (): string[] => {
    const pattern = /CLF_DOM\s*(?:\?\.)?\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const found = new Set<string>();
    for (const file of ['content.js', 'background.js', 'chatgpt-dom.js']) {
      const source = read(file);
      for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1]);
    }
    return [...found].sort();
  };

  it('publishes both GeminiDOM and CLF_DOM on globalThis', () => {
    const globals = loadBridge();
    expect(globals.GeminiDOM, 'the Gemini recorder surface must be published').toBeTruthy();
    expect(globals.CLF_DOM, 'the legacy bridge surface must be published').toBeTruthy();
  });

  it('keeps GeminiDOM usable after CLF_DOM is defined', () => {
    const globals = loadBridge();
    const dom = globals.GeminiDOM as Record<string, unknown>;
    for (const member of [
      'getEditor', 'getSendButton', 'getStopButton', 'getNewChatButton', 'isGenerating',
      'injectText', 'submit', 'discoverModels', 'switchModel', 'newChat', 'getLatestAssistantText'
    ]) {
      expect(typeof dom[member], `GeminiDOM.${member} must be callable`).toBe('function');
    }
  });

  it('exposes every member the shipped code calls', () => {
    const members = calledMembers();
    expect(members.length, 'the call-site extraction found nothing to check').toBeGreaterThan(50);
    const clf = loadBridge().CLF_DOM as Record<string, unknown>;
    const missing = members.filter((member) => !(member in clf));
    expect(missing, 'every called CLF_DOM member must exist on the Gemini bridge').toEqual([]);
  });

  it('makes every non-selector member callable so no call site can throw not-a-function', () => {
    const clf = loadBridge().CLF_DOM as Record<string, unknown>;
    const members = calledMembers().filter((member) => !SELECTOR_KEYS.includes(member));
    const notCallable = members.filter((member) => typeof clf[member] !== 'function');
    expect(notCallable, 'a getter that is not a function throws CLF_DOM.xyz is not a function').toEqual([]);
  });

  it('exposes the selector members as strings', () => {
    const clf = loadBridge().CLF_DOM as Record<string, unknown>;
    for (const key of SELECTOR_KEYS) {
      expect(typeof clf[key], `${key} is a selector, not a method`).toBe('string');
    }
  });

  it('covers every member the legacy chatgpt-dom.js exported', () => {
    // The legacy file is still the contract's source of truth. Dropping a key from the Gemini
    // bridge silently breaks whichever caller happens to use it first at runtime.
    const legacy = read('chatgpt-dom.js');
    const start = legacy.lastIndexOf('return {');
    expect(start, 'could not locate the legacy CLF_DOM export block').toBeGreaterThan(-1);
    const block = legacy.slice(start, legacy.indexOf('\n};', start));
    const keys = new Set<string>();
    for (const match of block.matchAll(/^\s{4}([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|,)/gm)) if (match[1]) keys.add(match[1]);
    expect(keys.size, 'the legacy export block yielded no keys').toBeGreaterThan(50);

    const clf = loadBridge().CLF_DOM as Record<string, unknown>;
    const missing = [...keys].filter((key) => !(key in clf)).sort();
    expect(missing, 'the Gemini bridge must be a superset of the legacy surface').toEqual([]);
  });

  it('returns a fallback instead of throwing when the Gemini DOM is absent', () => {
    const clf = loadBridge().CLF_DOM as Record<string, () => unknown>;
    // The whole point of STEP 2 is that a getter never throws. Every one of these runs against an
    // empty document in the sandbox, which is the worst case a real page can present.
    for (const member of calledMembers().filter((m) => !SELECTOR_KEYS.includes(m) && typeof clf[m] === 'function')) {
      const getter = clf[member] as () => unknown;
      expect(() => getter(), `CLF_DOM.${member} threw on an empty document`).not.toThrow();
    }
  });
});
