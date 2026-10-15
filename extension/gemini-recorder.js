/**
 * Gemini Web recorder — MAIN world, `document_start`.
 *
 * It has to run here, and this early, for one reason: the request id and the conversation id only
 * exist inside Gemini's own RPC envelope, and the only way to see that envelope is to wrap
 * `window.fetch` / `XMLHttpRequest` *before* Gemini's own bundle runs. An isolated-world content
 * script at `document_idle` — where `ncode-content.js` lives — is already far too late, and a
 * MAIN-world script injected later would miss the calls it exists to observe.
 *
 * It deliberately does not live in `fiber.js`. That file is ~169 KB of ChatGPT-specific React,
 * stream-envelope and turn evidence written against `chatgpt.com`'s DOM; loading it on
 * gemini.google.com would ship half a megabyte of code whose every selector is wrong for Gemini,
 * and grow the shipped extension on every Gemini page load for nothing. This file is Gemini-only,
 * small, and leaves `fiber.js` byte-for-byte as it is.
 *
 * It observes, and nothing else. Every native call is delegated unchanged, the page reads its own
 * untouched response stream, and any failure here is swallowed rather than thrown into the page.
 */

(() => {
  'use strict';

  // The manifest already declares this file for `https://gemini.google.com/*` only, but a second
  // injection is possible (extension reload, an unpacked edit) and a second fetch hook would
  // double every finding and wrap an already-wrapped function.
  if (globalThis.__ncodeGeminiRecorderLoaded) return;
  globalThis.__ncodeGeminiRecorderLoaded = true;

  try {
    const SOURCE = 'ncode-gemini-recorder';
    // The one name this file listens for. It is the isolated script announcing itself, because the
    // install notice below is sent at document_start and `ncode-content.js` only runs later.
    const HELLO_SOURCE = 'ncode-content-hello';
    const ENDPOINT = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

    // This file runs on every Gemini page load for as long as the tab is open, so every retained
    // value is bounded by name and nothing here may grow with the length of the conversation.
    const MAX_ID_CHARS = 200;              // request id, cid, rid, rcid
    const MAX_CHUNKS = 200;                // retained raw response frames, oldest dropped first
    const MAX_CHUNK_CHARS = 2000;          // per retained frame
    const MAX_TOTAL_TEXT_CHARS = 20000;    // retained response text across every frame
    const MAX_REQUEST_BODY_SCAN = 65536;   // bounded peek at a request body for conversation ids
    const MAX_STREAM_READS = 1000;         // reader-loop guard for a stream that never ends
    const CID_SCAN_FRAMES = 4;             // how many frames are scanned for a response-side cid

    // Gemini carries the conversation ids as quoted pairs in its RPC body and sometimes in the
    // query. The exact envelope moves between releases, so these are read defensively rather than
    // parsed: a shape that changes costs one missing id, never a wrong one.
    const META_PATTERNS = ['cid', 'rid', 'rcid', '_reqid'].map((key) => [
      key,
      new RegExp(`"${key}"\\s*,\\s*"([^"\\\\]{1,${MAX_ID_CHARS}})"`)
    ]);
    const META_BY_KEY = new Map(META_PATTERNS);

    function boundId(value) {
      if (typeof value !== 'string' || value.length === 0) return null;
      return value.length > MAX_ID_CHARS ? value.slice(0, MAX_ID_CHARS) : value;
    }

    // Readable by the page's own MAIN world. The isolated world cannot see these globals at all,
    // which is exactly why every finding is also sent through `postMessage` below.
    const state = {
      requestId: null,
      chatId: null,
      rid: null,
      rcid: null,
      chunks: [],
      requests: 0,
      chunkCount: 0,
      textChars: 0
    };
    globalThis.__ncodeRecorder = state;
    globalThis.__ncodeRecorderInstalled = true;

    function emit(type, payload) {
      try {
        const message = { source: SOURCE, type };
        if (payload) {
          for (const key of Object.keys(payload)) message[key] = payload[key];
        }
        window.postMessage(message, '*');
      } catch {
        // A page that has taken `postMessage` away cannot be told anything. The hooks still work.
      }
    }

    function metaFromUrl(url) {
      const found = {};
      try {
        const parsed = new URL(String(url || ''), location.href);
        for (const key of ['_reqid', 'cid', 'rid', 'rcid']) {
          const value = parsed.searchParams.get(key);
          if (value) found[key] = boundId(value);
        }
      } catch {
        // A relative or malformed URL simply leaves whatever the body scan can still find.
      }
      return found;
    }

    function metaFromBody(body) {
      const found = {};
      if (typeof body !== 'string' || body.length === 0) return found;
      const slice = body.length > MAX_REQUEST_BODY_SCAN ? body.slice(0, MAX_REQUEST_BODY_SCAN) : body;
      for (const [key, pattern] of META_PATTERNS) {
        const match = pattern.exec(slice);
        if (match && match[1]) found[key] = boundId(match[1]);
      }
      return found;
    }

    function absorb(meta) {
      const cid = meta.cid || meta.chatId;
      if (cid) state.chatId = cid;
      if (meta.rid) state.rid = meta.rid;
      if (meta.rcid) state.rcid = meta.rcid;
    }

    function publishRequest(url, body) {
      const fromUrl = metaFromUrl(url);
      const fromBody = metaFromBody(body);
      const requestId = fromUrl._reqid || fromBody._reqid || null;
      if (requestId) state.requestId = requestId;
      absorb(fromUrl);
      absorb(fromBody);
      state.requests += 1;
      // A new request starts a new retained chunk set: chunks from the previous turn must never
      // be read as if they belonged to this one.
      state.chunks.length = 0;
      state.textChars = 0;
      emit('request', {
        requestId: state.requestId,
        chatId: state.chatId,
        cid: state.chatId,
        rid: state.rid,
        rcid: state.rcid
      });
      return requestId;
    }

    let cidScanFrames = CID_SCAN_FRAMES;

    /**
     * Keeps a bounded copy of one raw response frame and hands it to the isolated world.
     *
     * The stream is a sequence of length-prefixed frames, so this deliberately does not decode it:
     * the recorder is here to prove which request a turn belongs to, and a bounded raw slice does
     * that without a protobuf schema that Gemini is free to change.
     */
    function retain(requestId, text) {
      if (typeof text !== 'string' || text.length === 0) return;
      const bounded = text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
      state.chunkCount += 1;
      state.chunks.push({ requestId, text: bounded, chars: bounded.length });
      state.textChars += bounded.length;
      while (state.chunks.length > MAX_CHUNKS || state.textChars > MAX_TOTAL_TEXT_CHARS) {
        const dropped = state.chunks.shift();
        if (!dropped) break;
        state.textChars -= dropped.chars;
      }
      // The first response frame is the one reliable place for the conversation id when the
      // request body was not readable, and it is bounded to a few frames rather than every one.
      if (cidScanFrames > 0) {
        cidScanFrames -= 1;
        const match = META_BY_KEY.get('cid').exec(bounded);
        if (match && match[1] && !state.chatId) state.chatId = boundId(match[1]);
      }
      emit('chunk', { requestId, text: bounded });
    }

    /**
     * Reads a *clone* of the response, never the one the page gets.
     *
     * `Response.clone()` tees the stream, so the page reads its own branch byte-for-byte exactly
     * as it would have; this branch is read and then cancelled. The reader loop is bounded in
     * both reads and retained bytes so a stream that never ends cannot hold memory.
     */
    function observeFetchResponse(response, requestId) {
      try {
        if (!response || !response.body || typeof response.clone !== 'function') return;
        const reader = response.clone().body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let pending = '';
        void (async () => {
          try {
            for (let read = 0; read < MAX_STREAM_READS; read += 1) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;
              pending += decoder.decode(value, { stream: true });
              // One read is not one frame, so cut on a line boundary where there is one and keep
              // the tail as the next piece. A stream with no newline at all is flushed whole rather
              // than allowed to grow the tail without limit.
              const cut = pending.lastIndexOf('\n');
              if (cut !== -1) {
                retain(requestId, pending.slice(0, cut));
                pending = pending.slice(cut + 1);
              } else if (pending.length > MAX_CHUNK_CHARS * 2) {
                retain(requestId, pending);
                pending = '';
              }
            }
            if (pending) retain(requestId, pending);
          } catch {
            // An aborted, reset or already-consumed stream is the network's problem, not the page's.
          }
          try { await reader.cancel(); } catch { /* already closed */ }
        })();
      } catch {
        // The page still receives its own untouched response whether or not this succeeds.
      }
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function ncodeRecorderFetch(input, init) {
        let url = null;
        let body = null;
        try {
          url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : null;
          body = init && typeof init.body === 'string' ? init.body : null;
        } catch {
          url = null;
        }
        if (url && url.indexOf(ENDPOINT) !== -1) {
          const requestId = publishRequest(url, body);
          const pending = nativeFetch.call(this, input, init);
          // `then` here only observes the resolved value; the same promise object the page would
          // have handled is the one it still gets, with its body and error path untouched.
          return pending.then((response) => {
            observeFetchResponse(response, requestId);
            return response;
          });
        }
        return nativeFetch.call(this, input, init);
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function' && typeof XHR.prototype.send === 'function') {
      const nativeOpen = XHR.prototype.open;
      const nativeSend = XHR.prototype.send;
      XHR.prototype.open = function ncodeRecorderOpen(method, url, ...rest) {
        try { this.__ncodeRecorderUrl = typeof url === 'string' ? url : String(url || ''); } catch { /* ignore */ }
        return nativeOpen.apply(this, [method, url, ...rest]);
      };
      XHR.prototype.send = function ncodeRecorderSend(body) {
        try {
          const url = typeof this.__ncodeRecorderUrl === 'string' ? this.__ncodeRecorderUrl : '';
          if (url.indexOf(ENDPOINT) !== -1) {
            const requestId = publishRequest(url, typeof body === 'string' ? body : null);
            // `responseText` is the response the page already owns; reading it here changes
            // nothing, and it throws by spec for a non-text responseType, which is caught.
            this.addEventListener('load', () => {
              try {
                const text = this.responseText;
                if (typeof text === 'string' && text.length > 0) retain(requestId, text);
              } catch {
                // A binary or document response carries no frame to retain.
              }
            });
          }
        } catch {
          // Never let the hook break the request: the native `send` below runs regardless.
        }
        return nativeSend.call(this, body);
      };
    }

    function announce() {
      emit('ready', { requestId: state.requestId, chatId: state.chatId });
    }

    // One listener, one answer, no polling: the install notice below is sent at document_start and
    // an isolated script injected at document_idle cannot have heard it.
    window.addEventListener('message', (event) => {
      try {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.source !== HELLO_SOURCE) return;
        announce();
      } catch {
        // A message this recorder cannot read is a message that was never for it.
      }
    });

    announce();
  } catch {
    // Nothing in here may reach the host page. A recorder that throws during install would take
    // Gemini's own bundle down with it, which is strictly worse than not recording.
  }
})();