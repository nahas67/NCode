/**
 * Ports the legacy ChatGPT companion extension discovers without additional host permissions.
 *
 * These belong to `src/main/bridge.ts`, which binds one of them at startup. They are NOT the
 * Gemini companion's port: `ncode-bridge.ts` owns 127.0.0.1:45880, derived from
 * `shared/ncode-config.ts` and declared as the extension's single host permission.
 *
 * The two used to be the same socket. A refactor re-pointed these constants at `BRIDGE_PORT`,
 * so `bridge.ts` and `startNCodeBridge()` both raced for 45880: the NCode bridge binds
 * synchronously, the legacy listener reaches `listen()` through a `.then()` microtask, lost
 * EADDRINUSE, and every desktop send died with "The browser bridge could not start". Two
 * components, two ports, no contention.
 */
export const BROWSER_BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769] as const;
/**
 * Where Auto looks when 8765-8769 are all taken (#1314). Windows can reserve whole blocks of
 * ports for Hyper-V, WSL2 or Docker, and one such block covered the primary range, so the bridge
 * could not listen anywhere. Two ranges far apart make it unlikely that every block is reserved.
 * Auto only: the fixed choices in Settings stay the primary range.
 */
export const BROWSER_BRIDGE_FALLBACK_PORTS = [18765, 18766, 18767, 18768, 18769, 38765, 38766, 38767, 38768, 38769] as const;
/** Auto's order, and exactly the list the extension scans (extension/background.js `PORTS`). */
export const BROWSER_BRIDGE_AUTO_PORTS = [...BROWSER_BRIDGE_PORTS, ...BROWSER_BRIDGE_FALLBACK_PORTS] as const;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];