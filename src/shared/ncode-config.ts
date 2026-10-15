/**
 * Every durable identity and transport constant NCode owns lives here, in one file.
 *
 * This file exists because the old app carried the same facts in four places: a port list
 * in `browser-bridge.ts`, a second copy of that list hardcoded in the extension's service
 * worker, the product name in `electron-builder.yml`, and the OS keychain service implied
 * by whatever `package.json` happened to say. Four copies is three chances to ship two apps
 * that think they own the same port. So: one owner, and everything else imports or is
 * asserted against it.
 *
 * Isolation rules this file encodes:
 *   - The bridge binds loopback only. It is never reachable from another machine, so NCode
 *     and any other local app cannot answer each other's sockets.
 *   - The port is a single fixed number, never a range and never "Auto". NCode
 *     owns 8765-8769 with fallbacks at 18765-18769 and 38765-38769; 45880 is outside every
 *     one of those blocks, so a machine with both installed never has to negotiate.
 *   - The WebSocket path and the client id together are the handshake. A socket that is not
 *     on our path is not ours, and a client that does not present our id is not our client.
 *   - `ncode` is the directory name for app data, logs and the mirrored extension. Nothing
 *     outside this file may spell that path.
 *
 * The Chrome extension cannot import this file (it ships as plain unbundled JavaScript), so
 * `extension/ncode-config.js` mirrors these same values and `test/ncode-config.test.ts`
 * asserts the two files agree. That test is the reason a drift is a failing build instead of
 * a companion that silently talks to nothing.
 */

/** Directory name for every piece of runtime state: `%APPDATA%\ncode`, `~/.config/ncode`. */
export const NCODE_DIR_NAME = 'ncode';

/**
 * `app.getName()` for this application. Electron derives the OS keychain service name
 * (`ncode Safe Storage` on macOS) from it, and `userData` when nothing overrides the path.
 * `src/main/index.ts` sets both explicitly so a packaged run and a `npm run dev` run agree.
 */
export const APP_NAME = NCODE_DIR_NAME;

/** `electron-builder.yml` productName. Installed programs, Start Menu entries, window title. */
export const PRODUCT_NAME = 'NCode';

/** Identity this host answers with on the bridge, so an extension can tell NCode from anything else. */
export const APP_ID = 'ncode-gemini-host';

/** The only client identifier this host accepts on the bridge. */
export const EXTENSION_CLIENT_ID = 'ncode-gemini-extension';

/** Loopback only. A wildcard bind would expose every tool call this app can make to the LAN. */
export const BRIDGE_HOST = '127.0.0.1';

/** Fixed, single, outside NCode' primary and fallback blocks. See the file comment. */
export const BRIDGE_PORT = 45880;

/** Path the WebSocket upgrade must target. Anything else on this port is not NCode's. */
export const WS_PATH = '/ncode-bridge';

/** Bumped when a bridge message changes shape. Both ends refuse a version they do not know. */
export const PROTOCOL_VERSION = 1;

/** Loopback origin. Also the exact host permission the extension needs, and nothing else. */
export const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

/** The URL the extension opens. Derived, never spelled out a second time. */
export const BRIDGE_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}${WS_PATH}`;

/** Host permission strings for `extension/manifest.json`, derived so they cannot drift. */
export const BRIDGE_HOST_PERMISSION = `${BRIDGE_ORIGIN}/*`;

/** The only page this extension ever runs on. */
export const GEMINI_ORIGIN = 'https://gemini.google.com';

/** The only page match this extension ever declares. */
export const GEMINI_MATCH = `${GEMINI_ORIGIN}/*`;

/**
 * Turns a fresh Gemini chat before we compact it ourselves.
 *
 * Gemini has no context window we can read, and its own "New chat" silently drops the
 * transcript. Eighteen tool round trips is where the model starts re-asking for things it
 * was already told, so that is where we take the state into our own hands.
 */
export const COMPACT_AFTER_TURNS = 18;