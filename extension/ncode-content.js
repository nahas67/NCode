/**
 * NCode — Gemini Companion Content Script.
 * Runs on https://gemini.google.com/*
 *
 * Responsibilities:
 *  1. Connects to the local NCode bridge on 127.0.0.1:45880/ncode-bridge.
 *  2. Discovers Gemini subscription tiers from <bard-mode-switcher> and syncs to desktop app.
 *  3. Monitors Gemini generation states and parses <ncode_*> protocol tags.
 *  4. Routes <ncode_tool> calls over loopback WebSocket to execute tools locally via MCP.
 *  5. Submits <ncode_result> back into Gemini with anti-drift directives.
 *  6. Manages Compact & Resume after turn threshold by obtaining <ncode_checkpoint>,
 *     opening a fresh chat (a[href="/app"]), and re-injecting bootstrap prompt.
 */

(() => {
  'use strict';

  // Only run on Gemini Web
  if (!window.location.hostname.includes('gemini.google.com')) {
    return;
  }

  // The manifest injects this file and `background.js` re-injects it during tab repair, both into
  // the same isolated world. Without this guard a repair registers a second
  // `setInterval(monitorGeneration, 200)` and a second relay port, so every turn is scanned
  // twice and the same tool call can be dispatched twice. A repeat injection must be a no-op
  // that leaves the already-live instance — and the `__NCODE_COMPANION__` handle it published —
  // exactly as they are.
  if (globalThis.__ncodeContentLoaded) {
    return;
  }
  // Out-of-order injection is normal, not fatal. `background.js` and the manifest do not inject
  // the same files in the same order, so this script can run before its dependencies exist.
  // Claiming initialization here — before the dependency check — used to set
  // `__ncodeContentLoaded` anyway, which turned every later injection into a no-op for the life
  // of the document and left a live Gemini tab reporting no recorder at all. Claim the
  // initialization only while a pass is in flight, and release it the moment a pass gives up.
  if (globalThis.__ncodeContentBooting) {
    return;
  }
  globalThis.__ncodeContentBooting = true;

  const Config = globalThis.NCodeConfig || {
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_PORT: 45880,
    WS_PATH: '/ncode-bridge',
    EXTENSION_CLIENT_ID: 'ncode-gemini-extension',
    COMPACT_AFTER_TURNS: 18
  };

  /**
   * A `GeminiDOM` for a pass that ran before the real one existed.
   *
   * `background.js` repairs a Gemini tab by re-injecting this file through
   * `chrome.scripting.executeScript`, and that repair can win the race against the manifest's own
   * `document_idle` injection — after an extension reload, or when the worker wakes onto an
   * already-open tab. Aborting left a live, signed-in Gemini tab reporting no recorder for the rest
   * of the document. So a missing dependency is no longer fatal: this factory supplies the same
   * surface, and the real object replaces it later (see `boot()`).
   *
   * It is written to be honest rather than quiet. Every query is guarded, so a page that has not
   * hydrated answers `null`/`false`/`''` instead of throwing, and the four write-path members
   * (`injectText`, `submit`, `switchModel`, `newChat`) return `false` when they could not find the
   * element — a caller can tell "did not work" from "threw", which is the whole difference between
   * a degraded companion and a silent one.
   */
  function createFallbackGeminiDOM() {
    const SELECTORS = {
      editor: 'rich-textarea div[contenteditable="true"], rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], div[role="textbox"]',
      send: 'button[aria-label*="Send message" i], button[aria-label*="Send" i], button.send-button',
      stop: 'button[aria-label*="Stop response" i], button[aria-label*="Stop streaming" i], button[aria-label*="Stop generating" i], button[aria-label*="Stop" i]',
      newChat: 'a[href="/app"], a[data-test-id="new-chat-button"], button[aria-label*="New chat" i], a[aria-label*="New chat" i]',
      picker: 'bard-mode-switcher, [data-test-id="bard-mode-menu-button"], [data-test-id*="mode"]',
      modelOption: '[role="menuitemradio"], [role="option"], menu-item, [data-test-id*="model"]',
      response: 'model-response, .model-response, message-content, .message-content, [data-message-author-role="model"]'
    };

    /** One guarded `querySelector`. `document` may be absent entirely in a bare world. */
    function one(selector) {
      try {
        if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') return null;
        return document.querySelector(selector) || null;
      } catch {
        return null;
      }
    }

    /** One guarded `querySelectorAll`, always an array so a caller never indexes `null`. */
    function all(selector) {
      try {
        if (typeof document === 'undefined' || !document || typeof document.querySelectorAll !== 'function') return [];
        return Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    function textOf(node) {
      if (!node) return '';
      try {
        return (node.innerText || node.textContent || '').trim();
      } catch {
        return '';
      }
    }

    /** The current pathname, or `''` where there is no readable location. */
    function pathnameNow() {
      try {
        let loc = typeof globalThis !== 'undefined' && globalThis.location ? globalThis.location : null;
        // A host that hands this file a `window` which is not `globalThis` still has the location.
        if (!loc && typeof globalThis !== 'undefined' && globalThis.window) loc = globalThis.window.location;
        if (loc && typeof loc.pathname === 'string' && loc.pathname) return loc.pathname;
        if (loc && typeof loc.href === 'string' && loc.href) {
          try {
            return new URL(loc.href).pathname;
          } catch {
            const slash = loc.href.indexOf('/', loc.href.indexOf('://') + 3);
            if (slash > -1) return loc.href.slice(slash).split('?')[0].split('#')[0];
          }
        }
      } catch {
        // A world with no location is a world that has no conversation either.
      }
      return '';
    }

    function conversationIdFromPath(path) {
      try {
        const match = /^\/(?:app|gem\/[^/]+|(?:g\/[^/]+\/)?c)\/((?:c_)?[0-9a-f-]{8,64})(?:\/|$)/i.exec(String(path || ''));
        if (!match) return '';
        // `c_c85317e1183c88b` and `c85317e1183c88b` are one conversation.
        return match[1].replace(/^c_/i, '');
      } catch {
        return '';
      }
    }

    function setEditorText(node, value) {
      if (!node) return false;
      try {
        if (typeof node.focus === 'function') node.focus();
        if (typeof document !== 'undefined' && document && typeof document.execCommand === 'function') {
          document.execCommand('selectAll', false, undefined);
          document.execCommand('insertText', false, value);
        } else {
          node.textContent = value;
        }
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch {
        try {
          node.textContent = value;
          return true;
        } catch {
          return false;
        }
      }
    }

    return {
      getEditor() {
        return one(SELECTORS.editor);
      },
      getSendButton() {
        return one(SELECTORS.send);
      },
      getStopButton() {
        return one(SELECTORS.stop);
      },
      getNewChatButton() {
        return one(SELECTORS.newChat);
      },
      isGenerating() {
        const stop = one(SELECTORS.stop);
        if (stop) return true;
        const responses = all(SELECTORS.response);
        const latest = responses[responses.length - 1];
        try {
          return !!(latest && latest.getAttribute && latest.getAttribute('data-generating') === 'true');
        } catch {
          return false;
        }
      },
      injectText(text) {
        if (typeof text !== 'string' || !text) return false;
        return setEditorText(one(SELECTORS.editor), text);
      },
      submit() {
        const send = one(SELECTORS.send);
        if (send) {
          try {
            send.click();
            return true;
          } catch {
            return false;
          }
        }
        const editor = one(SELECTORS.editor);
        if (!editor) return false;
        try {
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return true;
        } catch {
          return false;
        }
      },
      async switchModel(modelId) {
        const target = String(modelId || '');
        if (!target) return false;
        const picker = one(SELECTORS.picker);
        if (!picker) return false;
        try {
          picker.click();
          const options = all(SELECTORS.modelOption);
          for (const option of options) {
            const label = textOf(option);
            const value = option.getAttribute && (option.getAttribute('data-model-id') || option.getAttribute('value'));
            if (value === target || label === target || label.toLowerCase().includes(target.toLowerCase())) {
              option.click();
              return true;
            }
          }
        } catch {
          return false;
        }
        return false;
      },
      newChat() {
        const btn = one(SELECTORS.newChat);
        if (btn) {
          try {
            btn.click();
            return true;
          } catch {
            return false;
          }
        }
        try {
          if (typeof globalThis !== 'undefined' && globalThis.location) {
            globalThis.location.href = 'https://gemini.google.com/app';
            return true;
          }
        } catch {
          return false;
        }
        return false;
      },
      getLatestAssistantText() {
        const responses = all(SELECTORS.response);
        return textOf(responses[responses.length - 1]);
      },
      getConversationIdFromUrl() {
        return conversationIdFromPath(pathnameNow()) || null;
      },
      async discoverModels() {
        // Honest about what it could read. A picker that has not mounted yields an empty list
        // rather than a guess, so the desktop app shows "nothing observed" instead of a fiction.
        try {
          const picker = one(SELECTORS.picker);
          const options = picker ? all(SELECTORS.modelOption) : [];
          const models = options.map((option) => ({
            id: (option.getAttribute && option.getAttribute('data-model-id')) || textOf(option),
            name: textOf(option)
          })).filter((model) => Boolean(model.id));
          return { activeModel: null, models };
        } catch {
          return { activeModel: null, models: [] };
        }
      }
    };
  }

  /**
   * An `NCodeProtocol` for a pass that ran before the real one existed.
   *
   * The names below are copied from `ncode-protocol.js`'s export block (which names
   * `formatNCodeResult`, not a `formatNCodeToolResult`) and the shapes are the same tags it emits,
   * so a turn parsed by this fallback is structurally identical to one parsed by the real module.
   *
   * What degrades is confidence, not honesty: `parseNCodeTurn` returns `{ rawText, cleanedText }`
   * and simply omits `plan` / `toolCall` / `toolResult` / `checkpoint` / `finish` when it finds
   * nothing, so a consumer sees "no tags this turn" instead of an invented empty plan. Malformed
   * JSON inside a tag is caught per tag — one bad `<ncode_plan>` never discards a valid
   * `<ncode_finish>` beside it, and never throws.
   */
  function createFallbackProtocol() {
    function stripGeminiArtifacts(text) {
      try {
        if (!text || typeof text !== 'string') return '';
        let cleaned = text.replace(/\r\n?/g, '\n');
        cleaned = cleaned.replace(/^(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '');
        cleaned = cleaned.replace(/\n(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '\n');
        cleaned = cleaned.replace(/```(?:xml|html|json|markdown|ncode)?\s*\n?([\s\S]*?)```/g, '$1');
        return cleaned.trim();
      } catch {
        return '';
      }
    }

    function parseJsonTag(body) {
      try {
        return { ok: true, value: JSON.parse(String(body || '').trim()) };
      } catch {
        return { ok: false, value: null };
      }
    }

    function parseNCodeTurn(rawText) {
      const cleanedText = stripGeminiArtifacts(rawText);
      const result = { rawText, cleanedText };
      try {
        const planMatch = /<ncode_plan>([\s\S]*?)<\/ncode_plan>/i.exec(cleanedText);
        if (planMatch) {
          const parsed = parseJsonTag(planMatch[1]);
          if (parsed.ok && Array.isArray(parsed.value)) {
            result.plan = parsed.value.map((item, idx) => ({
              id: String((item && item.id) ?? idx + 1),
              title: String((item && (item.title ?? item.step)) || ''),
              status: item && (item.status === 'completed' || item.status === 'in_progress') ? item.status : 'pending',
              ...(item && item.details ? { details: String(item.details) } : {})
            }));
          }
        }

        const toolMatch = /<ncode_tool(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/ncode_tool>/i.exec(cleanedText);
        if (toolMatch) {
          const tool = (toolMatch[1] || '').trim();
          const body = (toolMatch[2] || '').trim();
          const parsed = parseJsonTag(body);
          const args = !body ? {} : (parsed.ok && typeof parsed.value === 'object' ? parsed.value : { raw: body });
          result.toolCall = {
            id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            tool: tool || (typeof args.tool === 'string' ? args.tool : 'shell'),
            args
          };
        }

        const resultMatch = /<ncode_result(?:\s+id=["']([^"']+)["'])?(?:\s+tool=["']([^"']+)["'])?(?:\s+status=["']([^"']+)["'])?>([\s\S]*?)<\/ncode_result>/i.exec(cleanedText);
        if (resultMatch) {
          result.toolResult = {
            id: resultMatch[1] || 'unknown',
            tool: resultMatch[2] || 'unknown',
            status: resultMatch[3] === 'error' ? 'error' : 'success',
            stdout: (resultMatch[4] || '').trim(),
            stderr: ''
          };
        }

        const checkpointMatch = /<ncode_checkpoint>([\s\S]*?)<\/ncode_checkpoint>/i.exec(cleanedText);
        if (checkpointMatch && checkpointMatch[1]) {
          const body = checkpointMatch[1].trim();
          const parsed = parseJsonTag(body);
          if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
            result.checkpoint = {
              summary: String(parsed.value.summary ?? ''),
              completedTasks: Array.isArray(parsed.value.completedTasks) ? parsed.value.completedTasks.map(String) : [],
              nextSteps: Array.isArray(parsed.value.nextSteps) ? parsed.value.nextSteps.map(String) : [],
              criticalFiles: Array.isArray(parsed.value.criticalFiles) ? parsed.value.criticalFiles.map(String) : [],
              ...parsed.value
            };
          } else {
            result.checkpoint = { summary: body, completedTasks: [], nextSteps: [] };
          }
        }

        const finishMatch = /<ncode_finish>([\s\S]*?)<\/ncode_finish>/i.exec(cleanedText);
        if (finishMatch) {
          result.finish = { summary: (finishMatch[1] || '').trim() };
        }
      } catch {
        // A turn this script cannot fully read is still a turn: keep the text, claim no tags.
      }
      return result;
    }

    /** Every formatter renders the same tag the real module does, from any input at all. */
    function stringify(value) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        // Circular or otherwise unserializable input renders as text rather than throwing.
        return String(value);
      }
    }

    return {
      stripGeminiArtifacts,
      parseNCodeTurn,
      formatNCodePlan(plan) {
        return `<ncode_plan>\n${stringify(plan)}\n</ncode_plan>`;
      },
      formatNCodeToolCall(tool, args) {
        return `<ncode_tool name="${String(tool ?? '')}">\n${stringify(args)}\n</ncode_tool>`;
      },
      formatNCodeResult(result) {
        const source = result && typeof result === 'object' ? result : {};
        let content = '';
        try {
          content = [source.stdout, source.stderr].filter(Boolean).join('\n').trim();
        } catch {
          content = '';
        }
        return `<ncode_result id="${String(source.id ?? '')}" tool="${String(source.tool ?? '')}" status="${String(source.status ?? '')}">\n${content}\n</ncode_result>`;
      },
      formatNCodeCheckpoint(checkpoint) {
        return `<ncode_checkpoint>\n${stringify(checkpoint)}\n</ncode_checkpoint>`;
      },
      formatNCodeFinish(summary) {
        const text = typeof summary === 'string' ? summary.trim() : String(summary ?? '').trim();
        return `<ncode_finish>\n${text}\n</ncode_finish>`;
      }
    };
  }

  /**
   * One initialization pass.
   *
   * This is a function so a pass that ran before its dependencies existed could simply run again.
   * That reason is gone: a missing `GeminiDOM`/`NCodeProtocol` is no longer fatal, because the
   * fallbacks below are a complete, honest surface and the real objects can replace them in place.
   * The function is kept for the one thing it still owns — the single claim on initialization — so
   * a repeat injection still finds exactly one live instance.
   */
  function boot() {
  // `let`, not `const`: when a real dependency arrives after this pass booted on a fallback, the
  // upgrade below rebinds these two names to it. It never tears the instance down, never registers
  // a second interval, and never opens a second relay port — the running companion just starts
  // reading the better object. Rebinding is only ever done once both real globals are confirmed
  // present, so a half-loaded world can never swap one in and leave the other a fallback.
  const realDOM = globalThis.GeminiDOM;
  const realProtocol = globalThis.NCodeProtocol;
  let DOM = realDOM || createFallbackGeminiDOM();
  let Protocol = realProtocol || createFallbackProtocol();

  // The reconnect and keepalive cadence: one base delay, jittered so a row of tabs does not tick
  // in lockstep, backing off to a cap while the app is unreachable.
  const RECONNECT_MS = 2500;
  const RECONNECT_JITTER_MS = 750;
  const RECONNECT_MAX_MS = 5000;
  // Two picker reads closer together than this tell the desktop nothing new and make Gemini's
  // menu flicker, so every trigger waits this long behind the last read.
  const MODEL_SYNC_MIN_GAP_MS = 4000;
  // Every control Gemini has used for the model/mode picker. Kept as one selector so observing
  // the click and reading the menu agree on what "the picker" is.
  const MODEL_PICKER_SELECTOR = 'bard-mode-switcher, [data-test-id="bard-mode-menu-button"], [data-test-id*="mode"]';

  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MS;
  let wasGenerating = false;
  let turnCount = 0;
  let pendingCompactResume = false;
  let activeGoal = '';
  let savedCheckpoint = null;
  let lastProcessedAssistantText = '';
  // The last partial this tab streamed to the host. Comparing against it keeps the 200 ms tick
  // from republishing an unchanged partial; cleared on the falling generation edge so the next
  // turn streams from its first delta again.
  let lastStreamedAssistantText = '';
  // The port behind the relay shim, kept so the recorder evidence below can travel over the one
  // channel this companion already owns instead of opening a second one.
  let relayPort = null;

  /**
   * What the MAIN-world recorder has reported about this document.
   *
   * `gemini-recorder.js` runs in the MAIN world at `document_start` and wraps `fetch`/
   * `XMLHttpRequest` before Gemini's own bundle does, which is the only place the request id and
   * the conversation id exist. It reaches this script as `postMessage` data, which is page data:
   * anything on the page can post the same shape. It is therefore read as an observation and
   * never as an instruction — it names things, it does not grant them, and every consumer
   * re-checks the relay and the app before acting on it.
   */
  const recorder = {
    // Any finding at all, which is also how a reloaded page learns the recorder is present.
    installed: false,
    // A Gemini RPC envelope was actually seen, which is what carries a request id.
    reported: false,
    requestId: null,
    chatId: null,
    rid: null,
    rcid: null,
    requests: 0,
    chunks: 0
  };

  /**
   * Opens the bridge connection through the service worker.
   *
   * The Gemini page CSP refuses content-script WebSockets: its `connect-src` lists only Google
   * origins, with no `ws:` scheme and no loopback host, so a direct
   * `new WebSocket('ws://127.0.0.1:45880/ncode-bridge')` on this page is refused before it leaves
   * the browser. The MV3 service worker is exempt from the page CSP, so it owns the socket and
   * frames are relayed over a runtime Port. The object below deliberately exposes only the
   * WebSocket surface this file uses, with the same numeric readyState values, so nothing
   * downstream has to know it is not a real socket.
   */
  function openRelaySocket() {
    const port = chrome.runtime.connect({ name: 'ncode-bridge' });
    relayPort = port;
    // "Is there a recorder in this tab" is asked of the service worker by the popup, and this
    // relay is the one channel the companion already owns. One control frame through it makes
    // that answer available; the worker consumes it and never forwards it, so the app's own
    // protocol over this socket stays untouched.
    try {
      port.postMessage({ __ncodeRelay: 'register' });
    } catch {
      // A relay that cannot even be announced about fails the same way the socket does.
    }
    const relay = {
      // CONNECTING until the worker reports the host socket open. Reporting OPEN early would let
      // sendBridgeMessage drop the frames sent immediately after connect, because the worker has
      // nowhere to put them yet.
      readyState: 0,
      send(data) {
        if (relay.readyState !== 1) return;
        port.postMessage(data);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null
    };
    port.onMessage.addListener((data) => {
      if (data && data.__ncodeRelay === 'ready') {
        relay.readyState = 1;
        if (relay.onopen) relay.onopen({});
        return;
      }
      if (relay.onmessage) relay.onmessage({ data });
    });
    port.onDisconnect.addListener(() => {
      if (relayPort === port) relayPort = null;
      relay.readyState = 3;
      if (relay.onclose) relay.onclose({ code: 1006, reason: 'ncode relay disconnected' });
    });
    return relay;
  }

  function sendBridgeMessage(msg) {
    // Numeric literals, not `WebSocket.OPEN`: this shim is not a WebSocket, and comparing
    // against the real global would throw on any page that also happens to define one with a
    // different shape. `openRelaySocket()` publishes the same 0/1/3 the browser uses.
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** True while this companion holds a live relay, whatever else it is doing. */
  function bridgeOpen() {
    return Boolean(socket && socket.readyState === 1);
  }

  /**
   * Carries the recorder's evidence to the service worker over the relay this companion already
   * owns.
   *
   * This is the same local control frame the worker already consumes to answer "is there a
   * recorder in this tab", carrying a little more. It is consumed there and never forwarded, so
   * the app's own protocol on this socket stays byte-for-byte what it was. No second transport
   * and no WebSocket: this page's CSP refuses one anyway, which is why the relay exists.
   */
  function announceRecorder() {
    if (!relayPort) return;
    try {
      relayPort.postMessage({
        __ncodeRelay: 'register',
        recorderInstalled: recorder.installed,
        recorderReported: recorder.reported,
        requestId: recorder.requestId,
        chatId: recorder.chatId,
        rid: recorder.rid,
        rcid: recorder.rcid
      });
    } catch {
      // The relay re-announces itself the next time it opens.
    }
  }

  /**
   * The recorder channel, and nothing else on it.
   *
   * Every other message on this window channel — the page's own, another extension's, a stale
   * sender — is ignored. A finding only updates what this script already observes and is then
   * re-checked by whatever reads it.
   */
  function observeRecorderMessage(event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.source !== 'ncode-gemini-recorder') return;
      recorder.installed = true;

      if (data.type === 'ready') {
        announceRecorder();
        return;
      }
      if (data.type === 'chunk') {
        recorder.chunks += 1;
        return;
      }
      if (data.type !== 'request') return;

      recorder.reported = true;
      recorder.requests += 1;
      // Bounded again on this side: the MAIN world already bounded these and this side never
      // trusts it.
      if (typeof data.requestId === 'string' && data.requestId) recorder.requestId = data.requestId.slice(0, 200);
      const chatId = typeof data.chatId === 'string' && data.chatId
        ? data.chatId
        : typeof data.cid === 'string' ? data.cid : '';
      if (chatId) recorder.chatId = chatId.slice(0, 200);
      if (typeof data.rid === 'string' && data.rid) recorder.rid = data.rid.slice(0, 200);
      if (typeof data.rcid === 'string' && data.rcid) recorder.rcid = data.rcid.slice(0, 200);
      announceRecorder();
    } catch {
      // A malformed report is this page's problem to have posted, not this script's to throw on.
    }
  }

  let readingModels = false;
  let modelsSyncFlight = null;
  let modelsSyncDue = 0;
  let lastModelsSyncAt = 0;

  /**
   * One model read at a time, with a minimum gap behind the last one.
   *
   * Initialization, `HELLO`, `DISCOVER_MODELS` and the person opening Gemini's own picker all
   * ask here, so there is a single owner of "when did we last read the picker". The first read
   * is immediate; a burst of clicks then collapses into one read that happens after the last
   * ask, instead of opening, reading and closing the menu once per click.
   */
  function requestModelsSync() {
    modelsSyncDue = Math.max(modelsSyncDue, lastModelsSyncAt + MODEL_SYNC_MIN_GAP_MS);
    if (modelsSyncFlight) return modelsSyncFlight;
    modelsSyncFlight = (async () => {
      try {
        for (;;) {
          const wait = modelsSyncDue - Date.now();
          if (wait > 0) {
            await new Promise((resolve) => { setTimeout(resolve, wait); });
            continue;
          }
          await syncModels();
          lastModelsSyncAt = Date.now();
          // An ask that landed while the picker was open waits for the next gap rather than being
          // lost, so a model change made mid-read is still published.
          if (Date.now() < modelsSyncDue) continue;
          return;
        }
      } finally {
        modelsSyncFlight = null;
      }
    })();
    return modelsSyncFlight;
  }

  async function syncModels() {
    readingModels = true;
    try {
      const discovery = await DOM.discoverModels();
      sendBridgeMessage({
        type: 'MODELS_SYNC',
        activeModel: discovery.activeModel,
        models: discovery.models
      });
      console.log('[NCode] Synced Gemini models:', discovery);
    } catch (err) {
      console.warn('[NCode] Model discovery failed:', err);
    } finally {
      readingModels = false;
    }
  }

  /**
   * Re-reads the picker when the person opens Gemini's own model/mode control.
   *
   * The desktop shows what the page shows, so a mid-session model change has to reach it
   * without waiting for the next `HELLO`. The listener sits on the document in the capture
   * phase so it still sees a click Gemini stops propagating, and it is one listener for the
   * whole page rather than a poll. Reads this companion performs are ignored, or opening the
   * menu to read it would ask for another read forever.
   */
  function observeModelPicker() {
    document.addEventListener('click', (event) => {
      if (readingModels) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (!target.closest(MODEL_PICKER_SELECTOR)) return;
      requestModelsSync();
    }, true);
  }

  function handleBridgeMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    console.log('[NCode] Received message from desktop bridge:', msg.type);

    switch (msg.type) {
      case 'HELLO':
        console.log('[NCode] Connected to NCode host:', msg.app, msg.version);
        requestModelsSync();
        break;

      case 'MCP_RESULT': {
        // The host composes the result tag and the anti-drift directive so there is one source of
        // truth for them. An older host sends only the raw fields, so keep composing it here as a
        // fallback rather than injecting an empty composer.
        let nextPrompt = '';
        if (typeof msg.prompt === 'string' && msg.prompt) {
          nextPrompt = msg.prompt.endsWith('\n') ? msg.prompt : `${msg.prompt}\n`;
        } else {
          const resultFormatted = Protocol.formatNCodeResult({
            id: msg.id,
            tool: msg.tool,
            status: msg.status,
            stdout: msg.stdout || '',
            stderr: msg.stderr || ''
          });

          nextPrompt = `${resultFormatted}\n\n`;
          nextPrompt += `[SYSTEM DIRECTIVE - ANTI-DRIFT]\n`;
          nextPrompt += `Stay strictly focused on fulfilling the user's objective without deviations.\n`;
          nextPrompt += `Review your plan with <ncode_plan>, continue with the next <ncode_tool>, or finish with <ncode_finish> when done.\n`;
        }

        if (turnCount >= Config.COMPACT_AFTER_TURNS) {
          nextPrompt += `\n[COMPACT & RESUME DIRECTIVE]\n`;
          nextPrompt += `Turn threshold reached (${turnCount} turns). Please serialize your current state now by emitting <ncode_checkpoint>:\n`;
          nextPrompt += `<ncode_checkpoint>{"summary": "...", "completedTasks": [...], "nextSteps": [...], "criticalFiles": [...]}</ncode_checkpoint>\n`;
          pendingCompactResume = true;
        }

        DOM.injectText(nextPrompt);
        setTimeout(() => DOM.submit(), 150);
        break;
      }

      case 'START_GOAL': {
        activeGoal = msg.goal || '';
        turnCount = 0;
        pendingCompactResume = false;
        savedCheckpoint = null;
        DOM.injectText(msg.prompt || activeGoal);
        setTimeout(() => DOM.submit(), 150);
        break;
      }

      case 'BOOTSTRAP': {
        DOM.injectText(msg.prompt);
        setTimeout(() => DOM.submit(), 150);
        break;
      }

      case 'USER_MESSAGE': {
        // A follow-up turn in an already-running goal session: same composer hand-off, and the
        // goal already lives in activeGoal, so turn bookkeeping intentionally stays untouched.
        if (msg.text) {
          DOM.injectText(msg.text);
          setTimeout(() => DOM.submit(), 150);
        }
        break;
      }

      case 'SET_MODEL': {
        if (msg.modelId) {
          void DOM.switchModel(msg.modelId);
        }
        break;
      }

      case 'DISCOVER_MODELS': {
        requestModelsSync();
        break;
      }

      case 'REQUEST_CHECKPOINT': {
        pendingCompactResume = true;
        const reqPrompt = `[COMPACT & RESUME DIRECTIVE]\nPlease emit your state checkpoint now using <ncode_checkpoint>:\n<ncode_checkpoint>{"summary": "...", "completedTasks": [...], "nextSteps": [...], "criticalFiles": [...]}</ncode_checkpoint>`;
        DOM.injectText(reqPrompt);
        setTimeout(() => DOM.submit(), 150);
        break;
      }

      default:
        break;
    }
  }

  function connectToBridge() {
    if (bridgeOpen() || (socket && socket.readyState === 0)) {
      return;
    }

    try {
      socket = openRelaySocket();

      socket.onopen = () => {
        console.log('[NCode] Bridge relay open.');
        reconnectDelay = RECONNECT_MS;
      };

      socket.onmessage = (event) => {
        handleBridgeMessage(event.data);
      };

      socket.onclose = () => {
        socket = null;
      };

      socket.onerror = () => {
        socket = null;
      };
    } catch {
      socket = null;
    }
  }

  /**
   * The one reconnect-and-keepalive cadence, as a single chain of `setTimeout`s.
   *
   * It used to fire only after a close, so a relay that was silently dropped was never noticed:
   * the companion still read as connected while nothing carried frames either way. The app
   * answers `PING` with `PONG`, so every tick now reconnects a dead relay and pings a live one.
   * One timer, jittered, with a backoff cap for an app that is not running — no second owner.
   */
  function scheduleReconnect() {
    if (!reconnectTimer) {
      const delay = Math.min(RECONNECT_MAX_MS, reconnectDelay + Math.floor(Math.random() * RECONNECT_JITTER_MS));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        // A tick that got its PING out earns the base delay back. One that did not reconnects and
        // grows toward the cap, so a down app is retried at the cap rather than as fast as it can.
        if (sendBridgeMessage({ type: 'PING', at: Date.now() })) {
          reconnectDelay = RECONNECT_MS;
        } else {
          reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay + RECONNECT_JITTER_MS);
          connectToBridge();
        }
        scheduleReconnect();
      }, delay);
    }
  }

  /**
   * The prose a person reads: the `<ncode_*>` directive blocks are agent protocol, not chat text,
   * so the bubble shows the reply with them removed. The host repeats the same strip on `text`
   * for turns that never carried a `displayText`; one frame carrying both keeps the raw text
   * available for parsing while the user only ever sees clean prose.
   */
  function stripNCodeTags(text) {
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
   * Evaluates the latest generation output when a turn finishes.
   */
  async function onTurnCompleted() {
    const rawText = DOM.getLatestAssistantText();
    if (!rawText || rawText === lastProcessedAssistantText) {
      return;
    }
    lastProcessedAssistantText = rawText;

    const parsed = Protocol.parseNCodeTurn(rawText);
    turnCount++;
    console.log(`[NCode] Turn ${turnCount} completed. Parsed tags:`, {
      plan: Boolean(parsed.plan),
      toolCall: Boolean(parsed.toolCall),
      checkpoint: Boolean(parsed.checkpoint),
      finish: Boolean(parsed.finish)
    });

    // 0. The chat window always gets the reply, tag or no tag. A plain conversational answer used
    //    to vanish here because only tag branches sent anything to the bridge. `displayText` is
    //    the prose a person reads: the raw <ncode_*> directives are activity, not text, and the
    //    host renders them as structured items instead of leaking the wrappers into the bubble.
    sendBridgeMessage({
      type: 'NCODE_TURN_COMPLETE',
      text: rawText,
      displayText: stripNCodeTags(rawText),
      conversationId: currentConversationId(),
      hasToolCall: Boolean(parsed.toolCall),
      hasFinish: Boolean(parsed.finish)
    });

    // 1. Plan update
    if (parsed.plan) {
      sendBridgeMessage({ type: 'NCODE_PLAN', plan: parsed.plan });
    }

    // 2. Checkpoint received (Compact & Resume)
    if (parsed.checkpoint) {
      savedCheckpoint = parsed.checkpoint;
      sendBridgeMessage({ type: 'NCODE_CHECKPOINT', checkpoint: parsed.checkpoint });

      if (pendingCompactResume) {
        pendingCompactResume = false;
        turnCount = 0;
        console.log('[NCode] Compact & Resume checkpoint captured. Starting fresh chat session.');

        // Navigate / click New chat
        DOM.newChat();

        // Wait for fresh session to open, then re-bootstrap. "New chat" discards the whole
        // turn history, so the desktop has to rebuild the bootstrap prompt (tool docs, 5-rule
        // protocol, resumed checkpoint, objective) and send it back as START_GOAL.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        let waited = 0;
        const checkEditor = setInterval(() => {
          waited += 200;
          const editor = DOM.getEditor();
          if ((editor && !DOM.getLatestAssistantText()) || waited > 10000) {
            clearInterval(checkEditor);
            sendBridgeMessage({
              type: 'NCODE_RESUME',
              goal: activeGoal,
              checkpoint: savedCheckpoint
            });
          }
        }, 200);
        return;
      }
    }

    // 3. Task Finish
    if (parsed.finish) {
      sendBridgeMessage({ type: 'NCODE_FINISH', summary: parsed.finish.summary, conversationId: currentConversationId() });
      console.log('[NCode] Task marked complete by model:', parsed.finish.summary);
      return;
    }

    // 4. Tool Call Execution
    if (parsed.toolCall) {
      console.log('[NCode] Dispatching tool call to desktop bridge:', parsed.toolCall);
      sendBridgeMessage({
        type: 'MCP_CALL',
        id: parsed.toolCall.id,
        tool: parsed.toolCall.tool,
        args: parsed.toolCall.args,
        conversationId: currentConversationId()
      });
      return;
    }

    // 5. Context degradation threshold check
    if (turnCount >= Config.COMPACT_AFTER_TURNS && !pendingCompactResume) {
      console.log(`[NCode] Turn count reached ${turnCount}; initiating Compact & Resume.`);
      pendingCompactResume = true;
      const reqPrompt = `[COMPACT & RESUME DIRECTIVE]\nContext limit reached at turn ${turnCount}. Please emit an <ncode_checkpoint> tag now:\n<ncode_checkpoint>{"summary": "...", "completedTasks": [...], "nextSteps": [...], "criticalFiles": [...]}</ncode_checkpoint>`;
      DOM.injectText(reqPrompt);
      setTimeout(() => DOM.submit(), 150);
    }
  }

  /**
   * Monitor DOM mutations and generation state changes.
   */
  function monitorGeneration() {
    // The same tick that watches for a finished turn also re-reads which conversation this document
    // is showing. One interval, one owner: a Gemini SPA navigation is noticed here rather than by a
    // second timer or a URL listener that would outlive the boot that created it.
    try {
      announceDocumentAndConversation();
    } catch {
      // A status announcement that fails must never stop generation monitoring.
    }

    const isNowGenerating = DOM.isGenerating();

    // Stream the turn as it grows. Every tick reads only what this submit produced
    // (`getLatestTurnText` answers '' until the reply exists), so earlier answers never leak back
    // into the chat window, and only deltas are sent: an unchanged partial is not republished.
    const turnText = typeof DOM.getLatestTurnText === 'function' ? DOM.getLatestTurnText() : '';
    if (turnText && turnText !== lastStreamedAssistantText) {
      lastStreamedAssistantText = turnText;
      sendBridgeMessage({
        type: 'NCODE_STREAM',
        text: turnText,
        conversationId: currentConversationId()
      });
    }

    if (isNowGenerating && !wasGenerating) {
      wasGenerating = true;
      console.log('[NCode] Gemini generation started...');
    } else if (!isNowGenerating && wasGenerating) {
      wasGenerating = false;
      lastStreamedAssistantText = '';
      console.log('[NCode] Gemini generation completed.');
      void onTurnCompleted();
    }
  }

  // Poll generation state regularly
  setInterval(monitorGeneration, 200);

  // Initialize
  connectToBridge();
  // The one cadence that both reconnects a dead relay and keeps a live one honest.
  scheduleReconnect();
  // Read the picker here rather than waiting for a `HELLO`: a companion that never receives one
  // — the app not running yet, or a relay that only opens later — used to leave the desktop on
  // its own hardcoded model list for the whole session.
  requestModelsSync();
  observeModelPicker();

  /**
   * The popup diagnostics probe this worker already sends to every Gemini tab, answered with the
   * only things this script can genuinely prove.
   *
   * `background.js::tabStatus()` reads whatever answers `clf-page-status` as its `page` field and
   * hands that to the popup, so the recorder evidence reaches the popup through the route that
   * already exists rather than a second one invented beside it.
   *
   * `ok: true` is the part that changed, and it is the honest answer for a different reason than
   * it used to be. It previously meant "this document can also be trusted with turn state and
   * Gemini's transport errors", which this script never observed, so it was left out. It now means
   * only what a worker can actually read off a reply that arrives: a Gemini observer is installed
   * in this document, it is answering, and it is bound to the conversation it reports. That is the
   * fact `register_document` below establishes, and it is what the popup needs to show a healthy
   * page instead of `reload`.
   *
   * What this document still does NOT observe is stated by the fields themselves rather than by
   * their absence, so a reader cannot mistake silence for proof:
   *   - `recorderInstalled: true` is this observer's presence, nothing more. Whether the MAIN-world
   *     `gemini-recorder.js` ever saw a Gemini RPC envelope is `recorderReported`, with `requests`
   *     and `chunks` as the counts behind it.
   *   - `streaming`/`generating` is Gemini's own Stop control being mounted, not a turn boundary.
   *   - `assistantError` is always `false`: this script does not read Gemini's transport errors, and
   *     the legacy `content.js` observer remains the one that reports a real one.
   */
  function answerPageStatus(message, sendResponse) {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type !== 'clf-page-status' && message.type !== 'clf-recorder-ping') return undefined;
    try {
      if (message.type === 'clf-recorder-ping') {
        sendResponse({ ok: true, recorderVersion: 22, busy: DOM.isGenerating() });
        return false;
      }
      let generating = false;
      try {
        generating = Boolean(DOM.isGenerating());
      } catch {
        // An unreadable Stop control is "not busy", never a thrown reply.
      }
      sendResponse({
        ok: true,
        // Marks the reply as this recorder's, so a reader can tell it from the ChatGPT observer's.
        ncodeRecorder: true,
        recorderInstalled: true,
        recorderReported: recorder.reported,
        requestId: recorder.requestId,
        conversationId: recorder.chatId || (DOM.getConversationIdFromUrl && DOM.getConversationIdFromUrl()),
        rid: recorder.rid,
        rcid: recorder.rcid,
        requests: recorder.requests,
        chunks: recorder.chunks,
        streaming: generating,
        generating,
        assistantError: false
      });
    } catch {
      // No page object at all beats a page object that would read as a second observer.
    }
    return false;
  }

  /**
   * One guarded `chrome.runtime.sendMessage`.
   *
   * Read through `globalThis` and every hop guarded: the re-injection harness loads this file into a
   * bare sandbox with no chrome at all, and a revoked or missing runtime must not turn a status
   * announcement into a thrown boot.
   */
  function sendRuntimeMessage(payload) {
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      if (!runtime || typeof runtime.sendMessage !== 'function') return;
      const pending = runtime.sendMessage(payload);
      // `sendMessage` returns a promise in MV3. A worker that cannot be reached rejects it, and an
      // unhandled rejection is a console error this document would be blamed for.
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    } catch {
      // Same reason, on the synchronous path.
    }
  }

  /** The conversation this document is bound to, or `null` on an id-less New Chat page. */
  function currentConversationId() {
    if (recorder.chatId) return recorder.chatId;
    try {
      return (DOM.getConversationIdFromUrl && DOM.getConversationIdFromUrl()) || null;
    } catch {
      return null;
    }
  }

  let announcedDocument = false;
  let announcedConversationId = null;

  /**
   * Registers this document with the worker and binds the conversation it is showing.
   *
   * `register_document` is what clears `terminalDocuments[key]`. A tab flagged terminal from an
   * earlier failure used to keep the popup showing `reload` forever, because nothing re-announced
   * the document once it was live again — so it goes out on every boot and again whenever the
   * bound conversation changes.
   *
   * Gemini is a single-page app: the document survives a whole conversation and its URL changes
   * underneath it. A one-shot send therefore binds the first chat and every later one stays
   * invisible to the worker. `monitorGeneration()` — the interval this companion already owns —
   * is the single place that re-reads the conversation, so the SPA change is noticed on the same
   * cadence as a generation change, with no second timer and no `popstate`/`hashchange` listener to
   * outlive the document.
   */
  function announceDocumentAndConversation() {
    const conversationId = currentConversationId();
    if (announcedDocument && conversationId === announcedConversationId) return;
    announcedDocument = true;
    announcedConversationId = conversationId;
    sendRuntimeMessage({ type: 'register_document', navigationEpoch: 0 });
    if (conversationId) sendRuntimeMessage({ type: 'bind', conversationId, navigationEpoch: 0 });
  }

  // Read through the global rather than the bare `chrome` so a context without the messaging API
  // (the re-injection harness loads this file into a bare sandbox) loads it exactly as before
  // instead of throwing while the script is still being installed.
  const runtimeOnMessage = globalThis.chrome && globalThis.chrome.runtime
    ? globalThis.chrome.runtime.onMessage
    : null;
  if (runtimeOnMessage && typeof runtimeOnMessage.addListener === 'function') {
    runtimeOnMessage.addListener(answerPageStatus);
  }

  window.addEventListener('message', observeRecorderMessage);
  // `gemini-recorder.js` announces itself at document_start, which this isolated script runs
  // after, so ask it once for the state it already has instead of waiting for the next Gemini RPC.
  try {
    window.postMessage({ source: 'ncode-content-hello' }, '*');
  } catch {
    // A page that refuses the message still sends every finding this script listens for.
  }

  /**
   * Swaps a fallback for the real object once both real dependencies exist.
   *
   * Deliberately non-destructive: the live instance keeps its interval, its relay port, its
   * companion handle and its `__ncodeContentLoaded` claim, and only the two names every read goes
   * through are rebound. Tearing the instance down to "re-boot properly" is what the old design
   * needed and what this one must never do — a second boot would register a second poller and open
   * a second relay port over a perfectly working companion.
   *
   * @returns true once both real globals have been adopted, so the caller can stop re-checking.
   */
  function upgradeFallbacksIfDependenciesArrived() {
    const nextDOM = globalThis.GeminiDOM;
    const nextProtocol = globalThis.NCodeProtocol;
    // Both, or neither: adopting one while the other is still a fallback would leave the companion
    // half-real for the rest of the document.
    if (!nextDOM || !nextProtocol) return false;
    DOM = nextDOM;
    Protocol = nextProtocol;
    return true;
  }

  // Export for testing
  globalThis.__NCODE_COMPANION__ = {
    connectToBridge,
    syncModels,
    requestModelsSync,
    onTurnCompleted,
    getTurnCount: () => turnCount,
    setTurnCount: (n) => { turnCount = n; }
  };

  // The companion is live: only now is initialization claimed, so a later injection is a
  // no-op that leaves this instance and this handle exactly as they are.
  globalThis.__ncodeContentLoaded = true;
  // Announced here, not on the first tick: the worker should already know this document exists by
  // the time boot returns, and `monitorGeneration` owns every later change from here.
  announceDocumentAndConversation();
  return {
    // Which half, if either, this pass had to invent. The caller uses it to decide whether an
    // upgrade re-check is worth its one bounded timer at all.
    degraded: { dom: !realDOM, protocol: !realProtocol },
    upgrade: upgradeFallbacksIfDependenciesArrived
  };
  }

  // The bounded cadence for waiting on a real dependency. Kept from the pass that used to re-boot
  // the whole companion: a boot can no longer fail, so the retry is now only an upgrade re-check,
  // and it runs only when this pass actually booted on a fallback.
  const DEPENDENCY_RETRY_INTERVAL_MS = 100;
  const DEPENDENCY_MAX_ATTEMPTS = 50;

  const started = boot();
  globalThis.__ncodeContentBooting = false;

  if (started.degraded.dom || started.degraded.protocol) {
    // A fallback boot is a working companion, so this never blocks and never repeats a side effect:
    // it swaps the two names when — and only when — both real objects are present, then retires.
    // Bounded, so a genuinely dependency-less page costs five seconds and leaves no live timer.
    let upgradeAttempts = 0;
    const upgradeRetry = setInterval(() => {
      upgradeAttempts += 1;
      if (started.upgrade() || upgradeAttempts >= DEPENDENCY_MAX_ATTEMPTS) {
        clearInterval(upgradeRetry);
      }
    }, DEPENDENCY_RETRY_INTERVAL_MS);
  }
})();
