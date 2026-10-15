/**
 * NCode extension constants (mirrors src/shared/ncode-config.ts).
 */

// `var`, not `const`: the manifest injects this file and `background.js` can inject it again into
// the same ISOLATED world, and re-declaring a top-level `const` there is a SyntaxError that takes
// the whole content_scripts array down with it.
var NCodeConfig = {
  NCODE_DIR_NAME: 'ncode',
  APP_NAME: 'ncode',
  PRODUCT_NAME: 'NCode',
  APP_ID: 'ncode-gemini-host',
  EXTENSION_CLIENT_ID: 'ncode-gemini-extension',
  BRIDGE_HOST: '127.0.0.1',
  BRIDGE_PORT: 45880,
  WS_PATH: '/ncode-bridge',
  PROTOCOL_VERSION: 1,
  BRIDGE_ORIGIN: 'http://127.0.0.1:45880',
  BRIDGE_URL: 'ws://127.0.0.1:45880/ncode-bridge',
  BRIDGE_HOST_PERMISSION: 'http://127.0.0.1:45880/*',
  GEMINI_ORIGIN: 'https://gemini.google.com',
  GEMINI_MATCH: 'https://gemini.google.com/*',
  COMPACT_AFTER_TURNS: 18
};

if (typeof globalThis !== 'undefined') {
  globalThis.NCodeConfig = NCodeConfig;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NCodeConfig;
  module.exports.default = NCodeConfig;
  module.exports.NCodeConfig = NCodeConfig;
  Object.assign(module.exports, NCodeConfig);
}
