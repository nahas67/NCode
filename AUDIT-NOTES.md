# NCode diagnostic audit — working findings

Repo: `ncode` (product name NCode, v2.1.36). Branch has ~23 modified + 14 untracked
files from an unfinished ChatGPT→Gemini rename. Never reset/checkout/clean this tree.

## Phase 1 — Electron: already healthy, no fix needed
`node -e "console.log(require('electron'))"` → `…\node_modules\electron\dist\electron.exe`, exit 0.
electron 44.3.0, path.txt = `electron.exe`, dist/electron.exe = 246,070,272 bytes. The reported
`Cannot find module 'electron/package.json'` was stale/transient.

## Bugs found

### BUG 1 (CRITICAL) — port 45880 double-bind  [FIXED: two ports, after user decision]
Uncommitted refactor rewrote `src/shared/browser-bridge.ts` to `[BRIDGE_PORT]` and
`extension/background.js:32` `PORTS` to `[45880]`. `git diff` shows originals were
`[8765..8769]` + fallbacks `[18765..18769, 38765..38769]`.

`startNCodeBridge()` calls `server.listen()` synchronously (`ncode-bridge.ts:306`);
`startBridge()` defers through the `enqueueBridgeLifecycle` microtask (`bridge.ts:5291`) before
`listen` (`bridge.ts:5359`). NCode always won; legacy bridge hit EADDRINUSE, and with
`candidates.length === 1` threw at `bridge.ts:5374`, which `startBridgeOnce`
(`bridge.ts:5438-5460`) swallowed → `null` + `bridgeError`, no user-visible failure.

Downstream damage: `start-input.ts:46` (every desktop send), `ipc.ts:1902` (`wakeDecision`),
`ipc.ts:1991` (`configureChatModelDiscovery.wake`), `ipc.ts:744` — all do
`if (!await startBridge()) throw new Error('The browser bridge could not start')`.

`test/bridge-ports.test.ts` had been rewritten to ASSERT the collision and had DELETED the guard
comparing `extension/background.js`'s `const PORTS` literal to `BROWSER_BRIDGE_AUTO_PORTS`.
That deleted guard is why this shipped undetected.

**Decision (revised after user input): two ports, not one.** The first attempt retired the legacy
listener outright. That turned out to cost 677 tests: `test/bridge.test.ts` is 16k lines / 681
tests that exercise a REAL loopback listener over HTTP+WebSocket (its own `beforeAll` asserts
`'no loopback port in 8765-8769 was free'`), and `bridge-port-lifecycle.test.ts` lost 8. The user
chose to give the legacy bridge its original ports back rather than delete a tested subsystem.
So the fix is to give each listener its own port range:
- `src/shared/browser-bridge.ts` restored to HEAD — `BROWSER_BRIDGE_PORTS = [8765..8769]`,
  `BROWSER_BRIDGE_FALLBACK_PORTS = [18765..18769, 38765..38769]`, `BROWSER_BRIDGE_AUTO_PORTS` is
  their union, and a doc comment now states the lists must never contain `BRIDGE_PORT`.
- `src/main/bridge.ts` restored to HEAD's real `startBridge(): Promise<number|null>` (the
  `legacyListenerRetired() { return true }` guard and the `Promise.resolve(BRIDGE_PORT)` stub are
  gone), keeping every non-listener export (bridgeStatus, onBridgeChange, shutdownBridge,
  sessionControlsFor, sessionActivityExpiresAt, goalWorkerChat, unattributedRepairEta,
  imageExportCapable, browserWakeConnected) that control-api.ts, control-reads.ts, pet-overlay.ts,
  kernel.ts, tools-core.ts, read-model.ts and browser-startup.ts import.
- `src/main/config.ts` — `browserBridgePortSchema` had been narrowed to
  `z.literal(BROWSER_BRIDGE_PORTS[0])`, making the setting `'auto' | 45880` and killing the
  renderer's 8765-8769 port dropdown plus a real type error at `ipc.ts:411`. Rewrote as an
  explicit union `'auto' | 8765 | 8766 | 8767 | 8768 | 8769`.
- `src/main/index.ts` restored to `if (browserExtensionRequired(getConfig())) { void startBridge()
  … } else void syncCosBrowser();`

**Regression guard:** `test/bridge-ports.test.ts` now has `gives the Gemini extension exactly the
NCode port and never the legacy one`, asserting `background.js` `PORTS === [BRIDGE_PORT]`, the
manifest grants `http://127.0.0.1:45880/*`, and `BROWSER_BRIDGE_AUTO_PORTS` does NOT contain
`BRIDGE_PORT`. That last assertion is what would have caught this bug before it shipped.

**Verified:** `npx vitest run test/bridge.test.ts test/bridge-ports.test.ts
test/bridge-port-lifecycle.test.ts test/config.test.ts test/ipc.test.ts` → 905 passed, and a live
launch shows BOTH `127.0.0.1:45880` and `127.0.0.1:8765` listening under the same Electron main
pid with no EADDRINUSE.

**Known limitation, reported not fixed:** the shipped Gemini extension only ever dials 45880, so
the restored 8765-8769 listener is reachable by direct HTTP but has no extension wired to it.

### BUG 2 (CRITICAL) — ESM in MV3 content script killed the whole extension  [FIXED: me]
`extension/gemini-dom.js:6` was `export const GeminiDOM = {`, and gemini-dom.js is entry #3 of
`content_scripts[0].js` (`["ncode-config.js","ncode-protocol.js","gemini-dom.js","ncode-content.js"]`).
MV3 content scripts are classic scripts, so `export` is a SyntaxError that takes down the ENTIRE
array — ncode-config.js, ncode-protocol.js and ncode-content.js all failed too.
Compounding: the file only `export`ed GeminiDOM and never set `globalThis.GeminiDOM`, which is
exactly what `ncode-content.js:31` (`const DOM = globalThis.GeminiDOM;`) reads.

Fixed: dropped the `export`, added a `globalThis.GeminiDOM = GeminiDOM` publication, kept the
guarded `module.exports` block for tests.
Verified: `node --check` exit=0 on all 4 content scripts; grep for top-level `import`/`export`
across the 4 files returns zero hits; `npx vitest run test/gemini-dom.test.ts` → 6 passed.

### BUG 3 (MAJOR) — MCP_CALL runs in process.cwd(), not the user's project root  [FIXED: me]
`src/main/ncode-tools.ts:10` `let activeWorkspaceDir = process.cwd();` and
`setNCodeWorkspace()` has ZERO production callers (only `test/ncode-tools.test.ts`).
The `ncode-bridge.ts` `MCP_CALL` handler called `executeNCodeTool({ id, tool, args })` with no
`workspaceDir`, so it fell back to `activeWorkspaceDir`. Meanwhile `start-input.ts:8` tells
Gemini the workspace is `getConfig().roots?.[0]?.path`.
Result: `shell` / `read_file` / `write_file` / `git_diff` operated on an unpredictable directory
while the prompt named a different one.
Fix: the `MCP_CALL` case now resolves `getConfig().roots?.[0]?.path` itself and passes it as
`workspaceDir`. When no root is configured it refuses with `status:'error'` and a message
pointing at Setup, rather than guessing a directory — which is also the one gate the renderer
already enforces (`renderer/main.ts:856-868` blocks chat until `roots.length > 0`), so main and
UI now agree.
Test: `refuses to run a tool when no folder is shared`. Before the `vi.mock('../src/main/config.js')`
was added, the pre-existing `executes tool via MCP_CALL` test failed with
`expected 'error' to be 'success'` — i.e. the old suite was asserting the buggy behaviour.

### BUG 4 (MAJOR) — MODELS_SYNC dropped the reasoning-effort ladder  [FIXED: lane alp-4]
`ncode-bridge.ts` (old `:188-192`) forwarded only `id`, `label`, `aliases`, so
`syncGeminiModels` (`chat-models.ts:187`) always applied its `['none']` fallback. Also
misused `m.description` as the alias list.
Fix: pure `normalizeSyncedModels()` + `sanitizeEfforts()` + `deriveEfforts()`. Because the
extension sends no ladder, it is derived: `/\b(thinking|pro)\b/` over id+label →
`['none','low','medium','high']`, else `['none']`. A payload that does carry `efforts` is
whitelisted against the real union via `isReasoningEffort` from `src/shared/session.ts:906`.

NOTE: the real `ReasoningEffort` union is `'pro'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'`
— 9 values, not the 5 originally assumed.

### BUG 5 (MINOR) — Origin allowlist was a substring match  [FIXED: lane alp-4]
Old `ncode-bridge.ts:263` `origin.includes('gemini.google.com')` accepted
`https://gemini.google.com.evil.example` and `https://evil.example/?gemini.google.com`.
Now `isAllowedOrigin()` parses with `URL`, accepts `chrome-extension:` with a non-empty host, else
requires `parsed.origin === GEMINI_ORIGIN`.

### BUG 6 (MINOR) — CORS reflected any Origin  [FIXED: lane alp-4]
Old `:118-119` `res.setHeader('Access-Control-Allow-Origin', origin || '*')`.
Now echoes the origin only when allowlisted, adds `Vary: Origin`, never wildcards.

### BUG 7 (MINOR) — header-comment + PAIR honesty  [FIXED: lane alp-4]
The file header claimed "Rejects any handshake not presenting client identifier". Actually
`wss.on('connection')` admits the socket immediately and `MCP_CALL` is honoured with no prior
`PAIR`; `PAIR` validates nothing about `msg.client`. Comments corrected. PAIR deliberately NOT
enforced: `rg -n "PAIR" extension/` → 0 hits, the bundled extension never sends one, so
requiring it would break the only real client. `x-ncode-client` header is unreachable from a
browser WebSocket (browsers cannot set upgrade headers) — documented as tests/scripts only.

### BUG 8 (MAJOR) — 7 of 8 `ncode:*` IPC channels had no renderer subscriber  [FIXED: lane alp-5]
All 8 are handled in `ipc.ts:1667-1713` and exposed on `window.api`, but the renderer consumed
exactly ONE (`ncode:switchModel`). Dead: `ncode:status`, `ncode:startGoal`,
`ncode:requestCheckpoint`, `ncode:plan`, `ncode:checkpoint`, `ncode:finish`, `ncode:connection`.
Consequence: the companion's connection state and active Gemini model were never displayed, and
plan/checkpoint/finish were computed in main and thrown away.
NO channel-name mismatches or typos were found anywhere in the 138+7+3 handler ledger.

### BUG 9 (MINOR) — stale GPT-6-only model heuristic in renderer  [FIXED: lane alp-5]
`src/renderer/chat-models.ts:190` preferred a label matching `/^gpt[ -]?6$/i` with `'high'`
effort. Can never match a Gemini catalog; silently fell through to `models[0]`.

### BUG 10 (MINOR) — dead ChatGPT share link  [FIXED: lane alp-5]
`src/renderer/chat.ts:937` `writeClipboard('https://chatgpt.com/c/' + id)` hands the user a dead
link on a real conversation. Reachable on the normal Gemini path.

### BUG 11 (MAJOR) — app-initiated commands were broadcast to every open Gemini tab  [FIXED: me]
`sendToExtension()` (`ncode-bridge.ts:101-111`) loops over `clients` and sends to **all** of them.
`clients` is one entry per socket, and every Gemini tab runs its own copy of the content script,
so N open tabs = N sockets.
`startGoalInGemini()` and `requestGeminiCheckpoint()` both went through that broadcast, and
`extension/ncode-content.js:116-124` / `:144-149` act on them immediately —
`DOM.injectText(...)` then `DOM.submit()`. So one "start goal" in the app injected and submitted
the identical prompt in every open tab: N agent runs, N concurrent executions of the same tool in
the one shared folder, and N results racing back.
Fix: added `sendToPrimaryClient()`, which walks the insertion-ordered `Set` and stops at the
first live socket. `startGoalInGemini` and `requestGeminiCheckpoint` now use it.
`switchGeminiModel` deliberately stays broadcast — one composer selector should drive the model
every tab is using, and that is the user's actual intent.
`MCP_RESULT` was already correct: the `MCP_CALL` case replies to the `client` that sent the frame,
never to the set. That path was left alone.
Tests (4, all socket-level against the real bridge on port 45885): goal reaches only the first
session; the next session is promoted once the first disconnects; `SET_MODEL` still reaches both;
and the send helpers report `false` when nothing is connected.

### BUG 12 (CRITICAL) — `read_file`/`write_file` escaped the shared folder  [FIXED: me]
`ncode-tools.ts` did `path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath)`,
so an absolute path was used verbatim and `..` chains climbed straight out. `read_file` with
`C:\Users\<me>\.ssh\id_rsa` succeeded and `write_file` with `../../..` wrote anywhere on disk.
That defeats the entire point of the Setup "share one folder" boundary, which
`renderer/main.ts` enforces by blocking chat until `roots.length > 0`.
Fix: reused the codebase's own containment primitive — `isContained()` from
`src/main/sandbox.ts`, the same boundary `workspace.ts` and `mcp/kernel.ts` already rely on
(`sandbox.ts`'s other helper, `resolvePath`, takes a *virtual* path plus `roots[]` and does not
fit a single real directory). New `resolveInsideWorkspace()` throws through the file's existing
outer `try/catch`, so every tool keeps one error path. Containment is lexical, so a symlink
inside the folder pointing out is still followed; that is the existing limit of `isContained`
and is documented rather than papered over.

### BUG 13 (MAJOR) — `args.cwd` escaped the shared folder  [FIXED: me]
Same hole in both `shell` and `git_diff`: `path.resolve(workspace, String(args.cwd))` with no
containment check, so `cwd: "C:\\"` ran the command at the drive root. Fixed with the same
`resolveInsideWorkspace()`.

### BUG 14 (MAJOR) — `child.kill()` left the process tree running on Windows  [FIXED: me]
`shell` spawns `powershell.exe -Command <cmd>`. `child.kill()` terminates only the shell, so a
timed-out `npm install` or `curl` kept running and kept writing into the folder long after the
tool reported a timeout. Fix: `killProcessTree()` spawns `taskkill /pid <pid> /T /F` on win32
(with an `error` handler that falls back to `child.kill()` — without it an ENOENT would surface
as an unhandled `'error'` event and take down the main process), and plain `child.kill()`
elsewhere.

### BUG 15 (MINOR) — unbounded output capture  [FIXED: me]
`stdout += chunk.toString()` with no ceiling, in both `shell` and `git_diff`. The result is sent
as a single WebSocket frame, so a runaway command or a monorepo `git diff` could exhaust main's
memory. Fix: `MAX_OUTPUT_CHARS = 1_000_000` and a `createCapture()` accumulator that stops at the
ceiling and appends a truncation note, so the model is told it was cut rather than silently
handed a short file. `read_file` stats before reading and refuses an oversized file outright —
capping after `fs.readFile` would be useless, because the memory is already gone by then.

Tests (6, new `describe('workspace containment')` in `test/ncode-tools.test.ts`): absolute path
inside the folder still works (guards against over-fixing), absolute path outside is refused,
traversal write is refused, shell `cwd` outside is refused, `git_diff` `cwd` outside is refused,
and a refused write leaves nothing behind on disk. `11 passed`.

### BUG 16 (MAJOR) — Compact & Resume threw the goal away  [FIXED: me]
After `COMPACT_AFTER_TURNS` (18) turns the extension asks the model for a checkpoint, clicks
"New chat" to escape the degraded context, and then — instead of re-bootstrapping — ran
`MCP_CALL { tool: 'shell', command: 'echo Resumed from checkpoint: …' }`. "New chat" discards the
turn history, so the fresh conversation got no bootstrap prompt, no tool documentation, no
5-rule protocol and **no objective**. The goal was lost permanently, and the echo's output came
back as an `<ncode_result>` as if it were a real answer.
Fix: the extension now sends `NCODE_RESUME { goal, checkpoint }` and the desktop rebuilds the
prompt with `buildNCodeBootstrapPrompt()` and replies `START_GOAL` to the requesting socket.
The prompt template deliberately stays in one place — duplicating it in the content script is
exactly how the `efforts` ladder would have drifted across the process boundary.
If the resume omits a checkpoint, the desktop falls back to the last one it received, and a
resume with no goal is logged as a warning rather than silently producing an empty objective.
Tests (2): the rebuilt prompt contains the goal, the resumed-checkpoint section, the completed
tasks, the next steps, the critical files and the tool documentation; and the fallback path.

### BUG 17 (MAJOR) — 12 of 13 extension locales were renamed out from under the code  [FIXED: me]
English's catalog had been rebranded to Gemini; the other 12 had not. All **13** files (de, en, es,
fr, ja, ko, pt_BR, pt_PT, ru, tr, vi, zh_CN, zh_TW) hold 390 keys but the key NAMES were disjoint:
English renamed 9 keys `chatgpt`→`gemini`
(`content_chatgpt_message_box_not_ready`, `content_chatgpt_tool`,
`content_compact_chatgpt_writing`, `content_goal_backend_chatgpt_helper`,
`content_goal_sending_to_chatgpt`, `content_turn_chatgpt_interrupted`, `popup_chatgpt_tab`,
`popup_overwrite_chatgpt`, `popup_section_augment_chatgpt`) while the other 12 kept the old names.
`chrome.i18n.getMessage()` therefore returned the raw key string for every non-English user.
English held 0 occurrences of `ChatGPT`/`NCode`; de held 41 `ChatGPT` + 11
`NCode`.
Fixed with a raw-text script (no JSON round-trip, so encoding and key order survive) that renames
a key only when the match is `"<name>": {`, then replaces the brand tokens in message text. A
Python diff against HEAD confirmed a clean 1:1 with 390 keys on both sides.
**Correction (see BUG 18):** only 3 of those 9 renames should have been applied. The final state is
3 `popup_*` keys renamed and the 6 `content_*` keys left at HEAD's `chatgpt*` names, because the
only live consumer of the `content_*` keys is dead code.

### BUG 18 (REVERTED — the target file is dead shipped code, not a bug)  [FIXED, then REVERTED]
Initially diagnosed as: "all 10 `t()` calls in `extension/content.js` request the old `chatgpt*`
names, so each misses the catalog and falls through to its hardcoded fallback." Renamed the 6
referenced keys and the 5 fallback strings.

**That fix was wrong and has been reverted.** `extension/content.js` is not shipped:
- `extension/manifest.json` `content_scripts[0].js` is
  `["ncode-config.js","ncode-protocol.js","gemini-dom.js","ncode-content.js"]` — `content.js`
  is absent.
- `extension/background.js` `restoreGeminiTab()` injects `i18n.js` (:5337) then `gemini-dom.js`
  (:5339), plus `usage.js` + `fiber.js` in the MAIN world (:5322). It never injects `content.js`.
- Nothing in `popup.js`, `popup.html`, `ncode-content.js` or `gemini-dom.js` references it.

How it was caught: `npx vitest run test/content-script.test.ts -t "says what it is doing above the
composer"` **passed** against HEAD's `content.js` and **failed** against my edited copy, while
`test/content-script.test.ts` and `test/input-delivery-integration.test.ts` are both unmodified
at HEAD and `git diff --stat -- extension/content.js` showed exactly 10 insertions / 10 deletions
— only my edits.
Action: reverted `extension/content.js` to HEAD (`git show HEAD:extension/content.js >`).
`content-script.test.ts` went from 3 failed to 0. Lesson recorded: the rebrand left a large dead
ChatGPT surface in the extension directory, and "this file looks stale" is not the same as
"this file is loaded".

### BUG 19 (MAJOR) — extension name and action title lost their i18n placeholders  [FIXED: me]
`extension/manifest.json` had `"name": "NCode — Gemini Companion"` and a literal
`action.default_title`, where HEAD used `__MSG_extension_name__` /
`__MSG_extension_action_title__`. A literal name is not localized at all — Chrome ignores all 13
catalogs for it. Restored both placeholders.
Naming note for the user: English's `extension_name`/`extension_action_title` said
"NCode — Gemini Companion", but `test/renderer-i18n.test.ts:373` encodes a house rule
("calls the browser extension an extension, not a companion") and the other 11 locales already
said "NCode" / "NCode Browser Extension". English now matches them. This is a user-visible
product name — revert the two catalog strings if you prefer the longer form.

### BUG 20 (MINOR) — four user-visible strings still said ChatGPT  [FIXED: me]
`src/shared/goal-errors.ts` lines 3/9/19/20 said ChatGPT in text the user reads inside the app,
while the extension catalogs for the same `content_goal_error_*` keys said Gemini —
`test/goal-errors.test.ts` asserts the two agree, so this was a guaranteed failure. Rebranded the
four strings to Gemini and re-keyed the matching translations in all 12 `src/renderer/locales/*.json`
(renderer locales are keyed by the ENGLISH SOURCE STRING, so changing the source would otherwise
have silently untranslated them).

### Reported, deliberately NOT changed
- **`src/renderer/locales/*.json` still carry 260+ `ChatGPT` occurrences each** in translated copy
  for the legacy ChatGPT-era surfaces. No test covers them and they are real translations, not
  mechanical renames. This is the remaining tail of the rebrand, not a regression.
- **`goal-errors.ts` still says "helper", "tunnel" and "continuation provider"** — accurate
  wording for the Goal/Loop subsystem that still works against the legacy bridge.

## Confirmed NOT bugs (do not "fix")
- **Extension config has not drifted from `src/shared/ncode-config.ts`.** All 15 constants in
  `extension/ncode-config.js` match the shared module, and `test/ncode-config.test.ts` (3 tests)
  asserts that parity, so drift would already be a red build.
- **The extension's protocol port matches the shared one.** `extension/ncode-protocol.js` is a
  faithful JS port of `src/shared/ncode-protocol.ts` — same 5 regexes, same 4 formatters, same
  tag names. The only textual difference is `if (planMatch)` vs `if (planMatch && planMatch[1])`,
  and the empty-body case throws into the same `catch`, so behaviour is identical.
- **All 11 extension JS files parse.** 5 classic scripts pass `node --check`; the 6 ESM ones
  (`background.js`, `browser-control.js`, `browser-control-page.js`, `active-tabs.js`, `i18n.js`,
  `usage.js`) pass as modules. `EXT_CHECK_FAILURES=0`.
- **Every manifest-referenced file exists** (`background.js`, the 4 content scripts,
  `overlay.css`, `popup.html`, `popup.js`, 4 icons, `_locales/en/messages.json`).
- **All 11 bridge message types line up across the boundary.** Extension sends `MODELS_SYNC`,
  `NCODE_PLAN`, `NCODE_CHECKPOINT`, `NCODE_FINISH`, `MCP_CALL`; main handles exactly those.
  Main sends `HELLO`, `MCP_RESULT`, `START_GOAL`, `SET_MODEL`, `REQUEST_CHECKPOINT`; the
  extension handles exactly those. `BOOTSTRAP` and `DISCOVER_MODELS` are receive-only cases with
  no sender — defensive, unreachable, harmless.
- **No blocking legacy wizard.** The only live admission gate is `missingStep()`
  (`renderer/main.ts:856-868`), firing solely when `config.roots.length === 0`. Its `_values`
  arg (tunnelId/hasApiKey) is underscore-prefixed and unused — the tunnel gate is already gone.
  `tunnel`/`key` wizard steps are `hidden` unless `config.tunnel.kind === 'openai'`
  (`main.ts:1644-1645`); fresh-install default is `'manual'` (`main/config.ts:566`).
  `Create MCP App`: 0 hits.
- **Extension WebSocket auth already works.** `extension/ncode-content.js:49` builds
  `ws://127.0.0.1:45880/ncode-bridge?client=ncode-gemini-extension` and `:163` calls
  `new WebSocket(url)` — the `searchParams` branch, no headers needed.
- **`ncode-bridge.ts` boot wiring is correct**: imported `index.ts:38`, called unconditionally at
  `index.ts:631`, stopped in the 40s shutdown drain at `index.ts:700`, idempotent at `:244-245`.
- **MODELS_SYNC → model dropdown chain is wired end-to-end**:
  `ncode-bridge.ts:184-193` → `chat-models.ts:183` → `ipc.ts:1990` push → renderer `:510-518`.
- **All manifest-referenced extension files exist.** `background.js`'s top-level imports are legal
  because the manifest declares `"type": "module"`.

## Dead code (reported, not deleted — outside the work order)
- `src/main/prompts/ncode-turn-wrapper.ts` `buildNCodeTurnPrompt` — zero production callers
  (only `test/ncode-prompts.test.ts`).
- `src/shared/ncode-protocol.ts` runtime fns `parseNCodeTurn`, `stripGeminiArtifacts`,
  `formatNCode*` — zero main-side production callers. The extension's own copy does the parsing
  (`extension/ncode-content.js:210`). Design is coherent (extension parses, main executes).
- **`extension/content.js` (751 KB) — never loaded.** Absent from the manifest's
  `content_scripts`, never injected by `background.js`, referenced by nothing. This is the single
  largest piece of dead ChatGPT code in the repo. See BUG 18.
- **`extension/chatgpt-dom.js` (194 KB) — never loaded.** Same reasoning: no manifest entry, no
  injection site, no reference from the shipped content scripts.
- `extension/fiber.js` (169 KB) and `extension/usage.js` — these ARE injected, by
  `background.js:5322` into the MAIN world, but nothing in the Gemini path consumes them. Alive
  but orphaned; do not delete without checking the MAIN-world contract.

## Residual risk (accepted, needs a follow-up lane)
`?client=ncode-gemini-extension` is a self-declared string any local process can write, and any
page on `https://gemini.google.com` (incl. an XSS there) gets tool authority. A real fix needs a
per-install shared secret, which requires editing `src/shared/ncode-config.ts` + the extension.

## Phase 4 — build and live smoke test (after all fixes)
- `npm run build` → exit 0. main 236 modules, preload 5, renderer 404.
- `npx electron-vite preview` launched via `Start-Process`; stdout/stderr captured to
  `%TEMP%\ncode-smoke2.log{,.err}`. (A `Start-Sleep` poll loop is rejected by the
  `cannylite DENY (sleep-wait)` guard — poll across separate tool calls instead.)
- Log contains `[NCode Bridge] Listening on ws://127.0.0.1:45880/ncode-bridge`.
  No EADDRINUSE, no "already in use", no uncaught exceptions, no native module errors. The only
  stderr output was Vite `vite:reporter` chunk-size warnings.
- `Get-NetTCPConnection` showed **both** listeners under the same Electron main pid 11492:
  `45880 LISTEN` (ncode-bridge) and `8765 LISTEN` (legacy bridge; 8766-8769 free because
  `startBridge()` takes the first free auto port). This is the decisive proof the double-bind is
  gone. Probes confirmed they are distinct services: 45880 answers HTTP 404
  `{"error":"not_found"}`, 8765 answers HTTP 401 (legacy token auth).
- Shutdown via `taskkill /PID <pid> /T /F` cleared both ports and left 0 electron processes.

## Final test-suite numbers
Full `npx vitest run`, taken before the BUG 18 revert:
```
Test Files  18 failed | 327 passed | 5 skipped (350)
     Tests  365 failed | 8424 passed | 50 skipped (8839)
  Duration  615.08s
```
Baseline at the start of the audit was **20 failed files / 371 failed tests / 8418 passed / 584s**,
so the audit took the suite from 371 to 365 failures even before the last fix.
`bridge.test.ts` went from **669 failed to 1 failed out of 681** — that single number is the
measurement of BUG 1 being genuinely fixed rather than papered over.
After the BUG 18 revert, `npx vitest run test/extension-i18n.test.ts test/extension-popup.test.ts
test/renderer-i18n.test.ts test/content-script.test.ts` → **977 passed / 0 failed (exit 0)**, which
removes 4 of those 365 (3 in `content-script.test.ts`, 1 in `extension-i18n.test.ts`).
**Projected final: 17 failed files / 361 failed tests.** A full re-run after the revert was NOT
run, so treat 361 as a projection; the 977/977 targeted run above is the direct evidence.

Every remaining failure is in one of these 18 legacy ChatGPT suites, all of which mock the old
background script: `extension.test.ts` (215/333), `desktop-input-maintenance.test.ts` (97/179),
`background-window.test.ts` (9/42), `plugin-refresh-workflow.test.ts` (7/48),
`extension-auto-reload.test.ts` (6/14), `project-successor.test.ts` (6/25), `packaging.test.ts`
(3/29), `skills-integration.test.ts` (3/8), `plugin-refresh-browser-creation.test.ts` (2/3),
`content-script.test.ts` (3/904, now fixed), `input-delivery-integration.test.ts` (7/286),
`app-proxy.test.ts` (1/6), `secrets.test.ts` (1/19), `tunnel-lifecycle.test.ts` (1/21),
`update.test.ts` (1/33), `feature-parity.test.ts` (1/5), `exec-hints.test.ts` (1/125),
`bridge.test.ts` (1/681).

## Why ~360 tests still fail (pre-existing, not caused by this audit)
The whole ChatGPT→Gemini rebrand is **uncommitted** — HEAD is still `e63508eb`. `git diff` on
`extension/background.js` shows 372 changed lines of *behavioural* rewiring, not cosmetics:
`PORTS` `[8765..38769]` → `[45880]`, `isChatGptUrl`→`isGeminiUrl`,
`CHATGPT_TAB_URLS`→`GEMINI_TAB_URLS`, `body.app === 'ncode'` → `'ncode-gemini-host'`,
the `/project-create` field `chatgptId`→`geminiId`, the connector regex
`^NCode Core...$`→`^NCode Core...$`, and `BACKGROUND_GROUP_TITLE` → `'NCode'`.
The legacy suites (`extension.test.ts`, `desktop-input-maintenance.test.ts`,
`project-successor.test.ts`, `plugin-refresh-*.test.ts`, `input-delivery-integration`,
`skills-integration`, `tunnel-lifecycle`, `app-proxy`, `update`, `secrets`, `packaging`,
`feature-parity`) mock that old background and assert old brand strings and URLs. **Those test
files are themselves unmodified** — only the source they exercise moved. Retargeting them is a
separate project; this audit reports it rather than rewriting ~350 assertions.

---

## Follow-up round: the extension could not reach the app at all

The 4-fix cleanup goal left the extension paired and reporting ready, but the moment anyone
actually ran it a live error appeared and the popup stayed grey. Three defects, all from the same
root cause: the NCode bridge protocol was served on 8765 and NCode deliberately stopped
listening there, so every route the extension calls had nowhere to land.

### BUG 21 (CRITICAL) - `/wake` returned 404
`extension/background.js:2792` opened `ws://127.0.0.1:45880/wake?host=browser` and got
`Unexpected response code: 404`. `ncode-bridge.ts` only accepted upgrades whose pathname equalled
`WS_PATH`; every other path was ended with a 404 by its own upgrade handler.
It only became visible after `/pair` was added - `connectWakeSocket()` bails at `if (!token)`, so
before there was a token it never opened a socket at all. Adding `/pair` activated dead legacy code.
Fix: mounted the existing `attachBrowserWake()` (from `src/main/browser-wake.ts`) onto the 45880
server. That module attaches via `server.on('upgrade')`, and Node runs every listener with no way to
stop propagation, so its path guard had to learn to defer rather than destroy - a new optional
`ownsOthers(pathname)` parameter, default `() => false`, keeps the standalone legacy server
byte-for-byte unchanged. `/wake` is exempt from `ncode-bridge` own upgrade guard for the mirror
reason. Auth reuses the `pairingToken` `/pair` already mints, so the popup and the service worker
share one credential and no new secret exists. `allowed` accepts an absent Origin or one passing
`isAllowedOrigin`, and deliberately does NOT require `?client=ncode-gemini-extension` - that was the
specific rejection the extension hit.
5 tests on port 45888 covering: token-as-first-frame gets the `wake` greeting and stays OPEN;
`pong` keeps it open; `?host=cos` authenticates; a non-token first frame never authorizes; and the
companion socket on the same port still upgrades (the regression guard against the wake handler
destroying a socket it does not own).

### BUG 22 (MAJOR) - every other HTTP route 404ed
`ncode-bridge.ts` served only `/hello`, `/status` and `/pair`. `background.js` and `popup.js` call
`/closed`, `/compact`, `/conversation-deleted`, `/core-plugin`, `/correlations`, `/diagnostics`,
`/events`, `/image-export`, `/models`, `/plugin-refresh`, `/project-create`, `/settings`, `/usage`,
`/commands`, `/browser`, `/extension`, `/repairs`, `/input`, `/cos-browser`, `/activity` and
`/goal`.
Fix: exported `bridgeRequestListener()` from `src/main/bridge.ts` - the request handler with no
readiness guard - and `createBridgeListener()` now delegates to it, so there is one copy of the
logic and the standalone listener keeps its `bridge_recovering` 503 guard. `ncode-bridge.ts`
delegates every unhandled path to it.
The blocker was auth: `bridge.ts` `authorised()` compares against `getSecret('bridgeToken')`, not
against module state tied to a running listener. So `/pair` now also persists with
`setSecret('bridgeToken', token)`, making the pairing token the single credential for the popup, the
wake socket and every delegated route. A secure-storage failure is logged and swallowed rather than
breaking pairing. Route precedence is deliberate - ncode-bridge checks `/hello`, `/status`, `/pair`
first, because `bridge.ts` has its own `/hello` lacking the `port` and `appProtocol` fields the popup
reads, so letting it win would break the reachability contract.

### BUG 23 (CRITICAL) - the content script could never open its socket (CSP)
Verified empirically rather than assumed. `curl -I https://gemini.google.com/` returns a
`connect-src` of `self` plus hundreds of Google origins, with no `ws:` scheme, no wildcard for it
and no 127.0.0.1. Chrome subjects content-script-initiated WebSockets to the page `connect-src`; the
MV3 service worker is exempt. So `ncode-content.js` `new WebSocket(...)` was refused by the page,
and there was no working path to regress.
Fix: `ncode-content.js` now opens a `chrome.runtime.connect({ name: ncode-bridge })` port through
`openRelaySocket()`, which exposes exactly the surface the file uses - `readyState`, `send`,
`onopen`, `onmessage(event)`, `onclose`, `onerror` - with the numeric readyState values the
comparisons against `WebSocket.OPEN` / `CONNECTING` depend on. `background.js` owns the one real
`new WebSocket(...)` in the CSP-exempt service worker and forwards both directions. Everything
downstream in ncode-content.js is unchanged.
---

## Follow-up round 2: the Gemini content scripts could not load at all

Reported live on `https://gemini.google.com/app`:

```
Uncaught SyntaxError: Identifier 'GeminiDOM' has already been declared   (gemini-dom.js:6)
Uncaught ReferenceError: CLF_DOM is not defined
```

Both are the same defect seen from two sides: `restoreGeminiTab()` in `background.js` re-injects
the Gemini content scripts into a world the manifest has already populated, and the repair path it
takes injects the legacy ChatGPT recorder, which needs a file that path never loads.

### BUG 24 (CRITICAL) - re-injection re-declared a top-level `const`

**Root cause.** The manifest lists `ncode-config.js`, `ncode-protocol.js`, `gemini-dom.js` and
`ncode-content.js` in `content_scripts`, and `restoreGeminiTab` separately `executeScript`s
`i18n.js`, `gemini-dom.js` and (previously) `content.js` into the same isolated world. In a classic
script world a top-level `const` is a lexical declaration: evaluating the file a second time in the
same realm throws `Identifier X has already been declared`. That is a parse-time failure, so it
takes down the whole `content_scripts` array, not just its own file - which is why `ncode-content.js`
never ran either.

Three files carried such a declaration: `ncode-config.js:5`, `ncode-protocol.js:130`,
`gemini-dom.js:6`. `ncode-content.js` was already fully IIFE-wrapped with no top-level
declarations, so it was only ever one bad evaluation away from running.

**Fix.**
- All three `const` became `var`, each with a comment naming the failure so the next reader does
  not reintroduce it. `var` re-declaration is legal in a classic script world, and both the
  `globalThis` publish and the guarded `module.exports` tail are unchanged, so the CommonJS test
  path and `test/ncode-config.test.ts` (which pins the 15 shared constants against
  `src/shared/ncode-config.ts`) are untouched.
- `ncode-content.js` gained a `__ncodeContentLoaded` guard, placed after the Gemini hostname check
  so a non-Gemini page never sets it. Without it a repair registered a second
  `setInterval(monitorGeneration, 200)` and a second relay port, so every turn was scanned twice
  and one tool call could be dispatched twice. The guard returns early without clearing
  `__NCODE_COMPANION__`, so a handle the host already captured stays valid across a repair.
- The duplicated `globalThis.GeminiDOM = GeminiDOM` assignment in `gemini-dom.js` (it was written
  twice) is now written once.

**Regression test.** `test/extension-reinjection.test.ts` evaluates all four content scripts twice
in one `vm` context. It was verified to actually catch the defect: reverting `var` back to `const`
makes it fail 4 of 12 with the exact reported `SyntaxError: Identifier 'GeminiDOM' has already
been declared`, and restoring the fix returns it to 12/12.

### BUG 25 (CRITICAL) - a Gemini tab was given the ChatGPT recorder

**Root cause.** Despite its name, `restoreGeminiTab` recovered a Gemini tab by injecting the legacy
ChatGPT `content.js` - 751 KB of code that references `CLF_DOM` some 60 times. `CLF_DOM` is defined
in `extension/chatgpt-dom.js`, which nothing in that path has ever loaded, so every repair
produced `ReferenceError: CLF_DOM is not defined`. The ping the recovery path uses to decide
whether a tab is already healthy (`clf-recorder-ping`) is answered only by `content.js`, so on a
Gemini tab it always fell through to full recovery, which is what guaranteed both errors on every
single call.

**Fix.** `restoreGeminiTab` now injects `ncode-content.js` - the recorder that is actually written
for the Gemini page - in place of `content.js`. Injection order is otherwise unchanged
(`i18n.js` -> `gemini-dom.js` -> `usage.js` + `fiber.js` in the MAIN world -> `ncode-content.js` ->
`overlay.css`).

Confirmed no test pinned the old list: the only assertions on `files: ['content.js']` are in
`test/extension.test.ts` and `test/content-script.test.ts`, and the two blocks that read as if they
did (`re-injects the recorder into already-open ChatGPT tabs after an extension reload` at
:3297-3322 and `repairs the matching recorder and helper together for the requesting document
only` at :3404-3425) exercise a different function that does inject `chatgpt-dom.js` and targets
`https://chatgpt.com/*`.

### The `CLF_DOM` bridge (defence in depth)

`content.js` is not the only file that names `CLF_DOM` - 14 test files do as well, and other code
paths may still reach it. `gemini-dom.js` therefore now also publishes `globalThis.CLF_DOM`, built
to the shape of the legacy object: a local `safe(fn, fallback)` wrapper on every getter so nothing
can throw, and a full member set implemented against real Gemini selectors (the rich-textarea
composer, the Send and Stop buttons, `message-content` turns, `<bard-mode-switcher>` for the model
picker, and the `/app/<id>` conversation URL). ChatGPT-only concepts degrade to inert values rather
than being dropped, so the contract stays complete: connectors return `[]`, plugin management
returns `false`/best-effort, and `fiberRef` returns `window.Fiber` or `null`.

`test/extension-reinjection.test.ts` asserts the bridge is a superset of what the legacy
`chatgpt-dom.js` exports, that every member the shipped code actually calls exists and is callable
(the two selector strings excepted), and that no getter throws against an empty document.

### `background.js` injection audit

Every `executeScript` and `insertCSS` in `background.js` was checked. All eight sites inject files
that exist, and the two inline `func:` bodies were read in full: `() => location.href` at :4868,
which is entirely generic, and the `askGeminiSignedIn` fetch of relative `/api/auth/session` at
:5562, which is same-origin on the Gemini page and free of ChatGPT globals. The remaining inline
`func` at :5431 only sets a MAIN-world flag.

### Two smaller findings from the same audit

**`GEMINI_TAB_URLS` had a duplicate entry** (`extension/background.js:4992`). It read
`['https://gemini.google.com/*', 'https://gemini.google.com/*']`. The mechanical ChatGPT to Gemini
rename collapsed two genuinely different hosts, `https://chatgpt.com/*` and `https://chat.openai.com/*`,
onto the same string, so the array was left with two identical entries. Harmless, because
`chrome.tabs.query` tolerates a repeated match pattern, but it is dead weight and more evidence that
the rename was textual rather than reviewed. Deduped to `['https://gemini.google.com/*']` after
confirming no test asserts the array or its contents: the only other occurrences of that pattern are
`ncode-config.js:22` (`GEMINI_MATCH`), a comment at `ncode-content.js:3`, and the two legitimate
`manifest.json` entries.

**A comment named a file the code no longer loads** (`extension/background.js:5371-5373`). It referred
to "the nonce/version gate in content.js", but that path injects `ncode-content.js` after the BUG 25
fix, so the comment pointed at a file the branch never loads. Reworded to "the version gate in the
Gemini recorder". Worth calling out because a stale reference of exactly this shape is what made
BUG 25 hard to see in the first place.