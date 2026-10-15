<p align="center">
  <a href="https://github.com/nahas67/NCode/releases/latest/download/NCode-x64-Setup.exe"><img src="docs/images/download-windows.svg" width="208" height="56" alt="Download for Windows x64" /></a>&nbsp;
  <a href="https://github.com/nahas67/NCode/releases/latest/download/NCode-arm64-macOS.dmg"><img src="docs/images/download-macos.svg" width="208" height="56" alt="Download for macOS Apple silicon" /></a>&nbsp;
  <a href="https://github.com/nahas67/NCode/releases/latest/download/NCode-x64-Linux.deb"><img src="docs/images/download-linux.svg" width="208" height="56" alt="Download for Linux x64" /></a>
</p>

<p align="center"><a href="https://github.com/nahas67/NCode/releases/latest">All downloads</a></p>

<p align="center"><sub>Independent beta. Use at your own risk and within your provider's rules. <a href="#responsible-use-and-provider-rules">Read the usage notice</a> before connecting.</sub></p>

<br />

<p align="center"><a href="#get-started">Get started</a> &nbsp;·&nbsp; <a href="CHANGELOG.md">What's new</a></p>

<br />

<h2 align="center">Code. Delegate. Keep going.</h2>

NCode is a desktop workspace around **Gemini Web**. You write the task in the desktop app; Gemini generates it in your own signed-in browser tab. The app sends instructions, records what happens, runs local tools for you, and keeps long work organized.

Everything stays on this machine. There is no cloud relay, no tunnel and no remote connector: the app, the extension and the browser tab talk over a loopback bridge on `127.0.0.1:45880`.

**Work on the real project.** Let Gemini read and edit files, run tests, keep terminals open and use your desktop. Follow the actual tool results as they arrive.

**Give it a team.** Split independent jobs across workers, then bring their results back. Workers keep their context, so the next task can pick up where they left off.

**Stay in control of long tasks.** Send a correction while work runs. Goal follows unfinished work; Loop keeps working within your brief. Compact & Resume carries the session and worker history into a fresh chat.

<p align="center"><strong>Uses your Gemini Web conversation in your own browser.</strong><br /><sub>Your account's model availability, usage and context limits still apply. <a href="https://one.google.com/about/google-ai-plans/">Google AI plans →</a></sub></p>

---

## How it fits together

```
  NCode desktop app                     Your browser
  ┌──────────────────────┐              ┌───────────────────────────────┐
  │  Composer & timeline │              │  gemini.google.com tab        │
  │  Local tool runner   │◄─ loopback ─►│  ┌─────────────────────────┐  │
  │  Sessions & history  │  127.0.0.1   │  │ ncode-content.js        │  │
  └──────────────────────┘   :45880     │  │ gemini-dom.js           │  │
                              ▲         │  │ gemini-recorder.js      │  │
                              │         │  └─────────────────────────┘  │
                       ┌──────┴───────┐ │              ▲                │
                       │ background.js│─┘──────────────┘                │
                       │ (MV3 worker) │   chrome.runtime port relay     │
                       └──────────────┘                                 │
                       Holds the only socket. The page's CSP cannot    │
                       block a service worker, so it carries frames     │
                       for the content script.                         │
                       └───────────────────────────────┘
```

Three parts, each doing one job:

- **The bridge** (`ncode-bridge`) listens on `127.0.0.1:45880` and runs your local tools. It is the only thing that touches your filesystem.
- **The extension** holds the single WebSocket and relays it. The Gemini page's Content-Security-Policy refuses a content-script socket to a loopback port, so the MV3 service worker — which is exempt — owns it instead.
- **The content script** reads the Gemini DOM: the composer, the stop button, and the model picker. It sends instructions, submits them, and reports what came back.

## What you can do

**Pick the model your account actually offers.** NCode scrapes the live model picker from your Gemini tab — the same list you see in the browser — rather than shipping a hardcoded catalog. The picker updates as soon as the tab connects.

**Run local tools through Gemini.** `shell`, `read_file`, `write_file`, `apply_patch` and `git_diff` all run inside the folder you approved, and their output lands in the timeline next to the conversation. `apply_patch` is for surgical edits: give it a `search` and a `replace` instead of re-sending a whole file.

**Send work in three modes.** An ordinary message, a **Goal** that follows work to its finish line, or a **Loop** that keeps improving within your brief. You can correct it mid-run.

**Split work across workers.** A worker is its own Gemini conversation with its own task, reporting back to the one that started it. Several can run at once.

**Keep going when a chat gets long.** Compact & Resume moves the same session — history, project, queue, workers — into a fresh chat without losing any of it.

---

## Responsible use and provider rules

NCode is an independent, open-source workspace for coding and other authorized tasks with your own files and tools. It is intended to support productive work within the rules of the services you use. **It is not intended to bypass usage limits, account restrictions or safety controls.**

Use NCode in accordance with Google's applicable [Terms of Service](https://policies.google.com/terms), [Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy) and [AI Principles](https://ai.google/responsibility/principles/), plus your workspace's rules and any connected service's terms.

- **Respect limits and access decisions.** Workers, Goal/Loop, Compact & Resume and finish checkpoints organize work; they do not grant extra quota or model access and must not be used to evade rate limits, usage caps or account restrictions. Do not switch accounts or chats to evade a restriction.
- **Respect safety decisions.** Do not use local tools, browser control, plugins or another worker to carry out an action that the provider blocked for safety. A local permission or an enabled tool is not permission to override a provider refusal.
- **Understand the integration.** NCode connects local tools over a loopback bridge and drives your own signed-in Gemini Web tab. The companion extension observes and automates the Gemini browser UI and records conversation content locally. This browser integration is not a public Gemini automation API, and MCP-style tool availability does not establish permission for every form of browser automation or recording; Google's terms also restrict automated or programmatic extraction of data or output.
- **Use at your own risk.** Review the rules for your account and intended workflow before connecting, supervise automation, and review tool actions and outputs. NCode cannot guarantee policy compliance, continued service access or protection from account warnings, restrictions or suspension. If a workflow is restricted or receives a policy warning, stop that workflow and seek clarification through the provider's support or appeal process.

This notice states the project's intended use; it does not certify compliance or change provider rules. NCode is not affiliated with, endorsed by or approved by Google. The software is provided as-is under the [MIT license](LICENSE); applicable statutory rights remain unaffected. See [Security](SECURITY.md) for local permissions and risks.

---

## Get started

1. **Install NCode** and open **Settings → Setup**.
2. **Connect your browser:** load the extension in Chrome, Edge or Brave. Setup shows your browser's own extensions page in your language: turn on **Developer mode**, click **Load unpacked**, and choose the folder that **Open extension folder** shows. Pairing is automatic.
3. **Share a folder and choose access:** the folder Gemini may work in, and what it may do there.
4. **Open Gemini** in your browser and sign in. The popup turns green once the tab, the extension and the bridge are all connected.
5. **Choose a model, write your task and send.**

<details>
<summary>Requirements &amp; installation notes</summary>

Windows 10/11, **macOS 13 Ventura or newer**, or a current desktop Linux. Chrome 125+, current Edge or Brave, plus a Gemini account. The model list comes from your own tab, so it reflects exactly what your account can use.

- **The bridge is local.** It binds `127.0.0.1:45880` and nothing else. There is no server, no account and no cloud component to configure.
- **Unsigned beta:** Windows is not publisher-signed; macOS is unsigned and unnotarized. Verify the package against the release checksums. Because of that, macOS asks once after each update for your login password so the new version can open its saved keys (`ncode Safe Storage`); choose **Always Allow**. Until you answer, chats and the browser connection wait, and the app says so.
- **Linux:** a Secret Service keyring is required. Prefer the DEB; when unprivileged user namespaces are disabled, the AppImage launcher can fall back to `--no-sandbox`.
</details>

---

## Development

```sh
npm install
npm run dev          # run from source
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run build        # electron-vite build
npm run verify       # privacy, notices, typecheck, tests
```

The extension ships unbundled — `extension/` is loaded directly by the browser, so edit and reload.

- `src/main/` — bridge, sessions, tools, agents, compaction
- `src/renderer/` — the desktop workspace
- `src/shared/` — the protocol contracts between them
- `extension/` — the companion extension
- `AGENTS.md` — the full product and ownership map

## License

[MIT](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt); native component sources are catalogued under [docs/licenses/](docs/licenses/).
