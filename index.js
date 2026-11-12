// ~/.config/opencode/plugins/opencode-pty-extended/index.js
//
// Local wrapper that makes the installed `opencode-pty` package usable on
// OpenCode v2. It is a discovery-directory plugin (auto-loaded from
// ~/.config/opencode/plugins/) because `opencode plugin add opencode-pty/v2`
// fails with NpmInstallFailedError - see shekohex/opencode-pty#67.
//
// Why a wrapper is needed:
//   The package's PUBLISHED v2 entrypoint (dist/src/v2/index.js) has two bugs:
//     1. it NEVER calls `ctx.tool.transform`, so the agent never sees
//        `pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill`
//        (the five definitions exist in dist/src/v2/tools.js -> ptyTools); and
//     2. its `registerV2Commands` only calls `draft.update(...)`, but the v2
//        CommandEditor exposes `add` only, so `/pty-*` commands never register.
//
// This wrapper:
//   1. runs the package's own v2 setup (optional autostart/web server),
//   2. installs a v2 exit-notifier so `notifyOnExit` works — each spawned PTY
//      records the session that initiated it (`parentSessionId`) and the root
//      conversation (`rootSessionId`), and `<pty_exited>` / `<pty_spawned>` both
//      carry those ids; who receives the exit prompt is chosen by `notify.target`
//      and the `pty_spawn` `notifyTarget` argument ("spawner" | "root" | "both"),
//   3. registers the package's PTY tools on the v2 ToolEditor, adapting the V1
//      `tool({ description, args, execute })` shape into v2 `Tool.Info`
//      (`{ name, description, input, execute }`), plus an extra `pty_url` tool
//      (not shipped by the package) that returns the PTY Sessions Web Interface
//      URL, starting the web server on demand — optionally selecting a session
//      via `?session=<id>`; and
//   4. (moved) the `/pty-open-background-spy` and `/pty-show-server-url`
//      commands no longer register here: they lived in the core prompt-command
//      layer (ctx.command.transform -> registerPtyCommands), which newer
//      opencode builds fill the input for instead of executing on selection,
//      and their keymap-layer twins made them show up twice in the slash
//      menu. They now live ONLY in the TUI keymap layer (tui.tsx), which
//      executes directly on selection.
//   5. resolves `pty_spawn`'s `workdir` against the session's project directory
//      (relative paths) and defaults it to that directory when omitted — the
//      package passes it through untouched (PR #72 behaviour).
//
// Options and tool-argument defaults are read from an `opencode-pty-extended.jsonc`
// (or `.json`) file — see "User configuration" below.
//
// The wrapper also lets you restyle the PTY Web UI's font: `terminalFont` applies to
// the whole output area — the `.output-container` panel and the `.xterm`
// terminal it wraps are the same content — which is otherwise hard-coded to
// `monospace`/`'SF Mono', …` inside the package's bundled JS and index.html.
// See "Web UI font override" below and the `terminalFont` block in
// `opencode-pty-extended.jsonc`.
//
// Four more Web UI fixes live here, all implemented the same way (no
// node_modules edits, everything in this file + the config):
//   - viewer resize -> PTY resize: the terminal normally stays at the spawn
//     size (120x40) no matter how big the browser window is. The served bundle
//     is rewritten so the terminal follows the viewer (FitAddon + magic
//     `\x1ePTYRSZ:<cols>,<rows>` envelope POSTed to the existing input route,
//     which the patched `manager.write` turns into `process.resize`).
//   - CSI 18t replies: apps like blessed ask the host terminal for its size
//     with `ESC [ 18t` and wait on stdin; under ConPTY nothing answers, so they
//     hang. The patched `manager.spawn` scans each session's output and answers
//     with `ESC [ 8 ; <rows> ; <cols> t` on the child's stdin.
//   - terminal kill keys: the shipped web JS routes `^C` ("\x03") to the same
//     handler as its "Kill Session" button, so pressing Ctrl+C in the terminal
//     killed the session instead of interrupting the foreground process. The
//     served bundle is rewritten so that, by default, `^C` is sent to the PTY
//     as input (a real interrupt; `webUi.ctrlCKillSession: false`) while `^D`
//     becomes a kill-session shortcut (`webUi.ctrlDKillSession: true`). The
//     Kill Session button keeps its own wiring.
//   - debug line: the web UI's "Debug: N chars, active: …" line is relabeled
//     to "<id>: N chars, …" with the id in bold (the "Debug:"/"active:"
//     labels are dropped; always applied) and extended with the live terminal
//     size (`size: <cols>x<rows>`; `webUi.debugSize`). The size is read from
//     the xterm instance the bundle already exposes on `window.xtermTerminal`.
// All are gated by the `webUi` block in `opencode-pty-extended.jsonc`. The exit-notifier
// for `notifyOnExit` also uses the proper v2 `ctx.session.prompt({ sessionID,
// text })` shape (the previous V1-shaped call silently failed, so `<pty_exited>`
// never arrived).
//
// The package is loaded with dynamic imports rather than static ones so the
// dependency base can be probed at runtime (static `import ... from` only
// accepts a string literal, so a computed `${BASE}/...` there is a syntax
// error). `BASE` below is either `<plugin>/node_modules` (the wrapper ships its
// own) or `<plugin>/..` (the wrapper is installed inside a node_modules folder
// alongside the packages it needs).

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import {
  loadUserConfig,
  deepMerge,
  normalizeGroupBy,
  resolveTuiSidebar,
  resolveOutput,
  sanitizeOutputText,
  configGetPayload,
  configSetLocal,
  PtyRpc,
} from "./shared.js";

// Per-spawn context carried across the async tool execution: upstream
// `spawn.js` builds its manager options explicitly and never forwards unknown
// args, so the wrapper's extra per-spawn choices (the exit-notify target) ride
// an AsyncLocalStorage scope that the wrapped `manager.spawn` reads. See
// installManagerSessionLineage.
const spawnScope = new AsyncLocalStorage();

let depsPromise;

// ---------------------------------------------------------------------------
// User configuration
// ---------------------------------------------------------------------------
// Options and tool-argument defaults are loaded from every `opencode-pty-extended.jsonc`
// (or `.json`) found, deep-merged lowest precedence first:
//
//   1. <this plugin dir>/opencode-pty-extended.json[c]       (shipped reference config)
//   2. <global config dir>/opencode-pty-extended.json[c]     ($XDG_CONFIG_HOME/~/.config + /opencode)
//   3. <ancestor>/opencode-pty-extended.json[c]              (project, nearest wins)
//   4. <ancestor>/.opencode/opencode-pty-extended.json[c]    (project, nearest wins)
//   5. plugins[].options for this plugin (ctx.options)
//
// `plugins[].options` is merged BEFORE the plugin's own config files (it beats
// only the shipped reference config): the effective chain is
// built-ins < shipped < plugins[].options < global < project, so the dialog's
// save into one of our files always wins over the opencode.json entry.
//
// Layers 3-4 walk up from the session directory (`ctx.location.directory`), so
// the nearest ancestor wins, and every `.opencode/` config outranks every
// sibling one — the same order opencode uses for its own config. Within a
// directory `.json` is applied before `.jsonc`.
//
// A file may contain:
//
//   {
//     "port": 0, "hostname": "::1", "autostart": false,
//     "argDefaults": { "pty_spawn": { "notifyOnExit": true,
//                                     "notifyTarget": "spawner" },
//                      "pty_read": { "limit": 500 }, ... },
//     "notify":      { "target": "spawner" },
//     "terminalFont":     { "enabled": true, "family": "...", "size": 14 },
//     "webUi":       { "viewerResize": { "enabled": true, "debounceMs": 120 },
//                      "csiReply": true, "ctrlCKillSession": false,
//                      "ctrlDKillSession": true, "debugSize": true,
//                      "killConfirmSession": true, "closeConfirmSession": true,
//                      "downloadLog": true, "stretchSessions": true,
//                      "groupBy": "agent" },
//     "tuiSidebar":  { "enabled": true, "pollMs": 1500, "maxLines": 400,
//                      "filterBySession": true, "groupBy": "agent" },
//     "output":      { "stripAnsiSequences": false,
//                      "dialog": { "stripAnsiSequences": false },
//                      "tool":   { "stripAnsiSequences": false } }
//   }
//
// `output.tool` differs from the two display scopes: false leaves the `pty_read`
// result raw, true strips its ANSI/control sequences (keeps \n and \t).
//
// `notify.target` (default "spawner") picks who receives an exiting PTY's
// `<pty_exited>` prompt: the session that called `pty_spawn` ("spawner"), the
// root conversation ("root"), or both. A `pty_spawn` `notifyTarget` argument
// (and `argDefaults.pty_spawn.notifyTarget`) override it per spawn. Both
// `<pty_spawned>` and `<pty_exited>` carry the initiator + root session ids.
//
// `tuiSidebar.filterBySession` (default true) scopes the TUI sidebar and the
// `/pty-output` and `/pty-kill` pickers to the PTYs spawned by the opencode
// session currently in view (plus its subagent descendants); false lists every
// PTY. The `pty_list` tool follows the same idea: by default it lists the calling
// session's PTYs and appends a compact summary of the others (`sessionID` /
// `all: true` override the scope).
//
// `webUi.groupBy` (default "agent") groups the web UI sidebar's PTY list by the
// opencode conversation each PTY belongs to, headed by that conversation's
// title, id and count; "agent" additionally sub-groups each conversation's PTYs
// by the sub-session (subagent) that spawned them. `false` keeps the flat list
// and `"session"` groups without the sub-agent level. Subagent PTYs roll up to
// the root conversation; PTYs with no opencode parent (created from the web UI
// itself) are shown ungrouped at the top. `tuiSidebar.groupBy` mirrors it for
// the TUI sidebar.
//
// `webUi.stretchSessions` (default true) stretches each sidebar session card to
// the list's full width; false keeps upstream's shrink-to-fit `<button>` sizing.
// The header "Kill Session" button always gets the download split button's
// geometry (padding/typography) while keeping its own red background/typography.
//
// Anything omitted (or a missing file) falls back to the built-ins below.
//
// The TUI half (tui.tsx) never receives `plugins[].options` from opencode — the
// CLI only gets TUI plugin options from cli.json — so the server half serves
// this fully merged, already-resolved result (the `tuiSidebar` and `output`
// blocks) to the TUI half over RPC (`PtyRpc.settings`). That keeps
// `plugins[].options` one coherent layer for both halves (below the plugin's
// own files), with no cli.json entry required.

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

// Where the wrapper's dependencies live. The wrapper either ships its own
// `node_modules` (`./node_modules`) or is itself installed inside a
// `node_modules` folder alongside the packages it needs (`..`). Probe the
// primary package and use whichever base actually contains it; dynamic
// `import()` resolves the relative specifier against this module.
const BASE_CANDIDATES = ["./node_modules", ".."];
const BASE =
  BASE_CANDIDATES.find((base) => existsSync(join(PLUGIN_DIR, base, "opencode-pty"))) ??
  BASE_CANDIDATES[0];

// Fallbacks used when the config file is absent or omits a key.
const BUILTIN_OPTIONS = {
  port: 0,
  hostname: "::1",
  autostart: false,
};

// Default for the Web UI font override. Off by default so the package's own
// styling is used unless the config opts in. When enabled without an explicit
// `family`, this stack is used for the whole output area (the `.output-container`
// panel and the `.xterm` terminal it wraps): FiraCode Nerd Font Mono first,
// then the package's own fallbacks.
const BUILTIN_TERMINAL_FONT = {
  enabled: false,
  family: "'FiraCode Nerd Font Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace",
};

// Defaults for the Web UI viewer-resize + CSI-18t replies. On by default; the
// config `webUi` block can turn either off.
const BUILTIN_WEBUI = {
  viewerResize: { enabled: true, debounceMs: 120 },
  csiReply: true,
  // Terminal kill keys; see applyKillKeysToJs. By default Ctrl+C is forwarded
  // to the PTY as input (an interrupt) and Ctrl+D kills the session.
  ctrlCKillSession: false,
  ctrlDKillSession: true,
  // The web UI's "Debug:" line is relabeled (ALWAYS, no key): "<id>: N chars,
  // …" with the id in bold — the "Debug:"/"active:" labels are dropped; see
  // applyDebugRelabelToJs.
  // Append the live terminal size to that line; see applyDebugSizeToJs.
  debugSize: true,
  // Confirmation dialogs. `killConfirmSession` gates the header "Kill Session"
  // button (and the Ctrl+D shortcut, which shares its handler; see
  // applyKillConfirmToJs). `closeConfirmSession` gates the per-session × close
  // button (see applySessionCloseToJs). false = act without asking.
  killConfirmSession: true,
  closeConfirmSession: true,
  downloadLog: true,
  // Stretch each sidebar session card to the list's full width (the upstream
  // `<button>` entries are inline-block and shrink to fit their content).
  // false restores the shrink-to-fit look. See applyWebUiShapeToHtml.
  stretchSessions: true,
  // Group the web UI sidebar's PTY sessions. `false` is the shipped flat list;
  // "session" groups by the owning opencode conversation (root session),
  // headed by that conversation's title (+ id + count); "agent" additionally
  // sub-groups each conversation's PTYs by the sub-session (subagent) that
  // spawned them. PTYs with no opencode parent (created from the web UI itself,
  // `parentSessionId: "web-api"`) are shown ungrouped at the top. See
  // applyGroupBySessionToJs and installManagerGroupBySession.
  groupBy: "agent",
  // Terminal size control bar below the terminal window (auto/fixed toggle +
  // cols/rows textboxes; see applySizeModeBarToHtml). false removes the bar —
  // the backend fixed-size machinery (pty_spawn cols/rows, pty_size_set/get)
  // keeps working without it.
  sizeControl: true,
  // The header `+` button (right-aligned next to "PTY Sessions") that opens the
  // spawn popup: pick GLOBAL or one of the opencode conversations, enter a
  // command, spawn a new PTY — the target conversation's chat gets a
  // `<pty_spawned>` announcement (notify.announceWebSpawn). See
  // applyPlusSpawnToHtml and createWebApiHandlers.
  spawnButton: true,
  // The `+` spawn popup's session dropdown by default lists only LIVE opencode
  // sessions: everything the event tracker observed alive (which may have 0
  // PTYs) plus every conversation currently owning a RUNNING PTY. `true`
  // restores the all-history list. See createWebApiHandlers and liveSessionIdSet.
  newPtyShowAllSessions: false,
  // "Actively doing something" window (ms): a session NOT open in any UI still
  // counts as live while the session_v2 store's `time_updated` is inside this
  // span (live-verified: it bumps continuously while an agent streams).
  // UI-open sessions (TUI tabs, web-UI opens) are stamped presence-based and
  // need no window.
  newPtyActiveWindowMs: 3 * 60_000,
  // Web-UI auto-reconnect for a dropped page socket: the injected watchdog
  // starts ONLY when the page's WebSocket actually closed (never while
  // connected) and probes /ws every `reconnectIntervalMs`; as soon as the
  // server answers it reloads the page, which re-mounts the app (fresh
  // session list, subscription and xterm buffer). Reloads are rate-limited
  // (at most one per 15 s) so a flapping server cannot loop-reload. 0 or
  // false disables the feature entirely (nothing is injected). See
  // applyWsReconnectToJs / applyWsReconnectToHtml.
  reconnectIntervalMs: 2000,
};

// Optional-argument defaults for the pty tools. These are applied by the wrapper
// at runtime — registerPtyTools merges them into `args` before calling the V1
// tool, so an omitted argument takes the configured default — and are also
// declared in the generated JSON Schema so the agent sees the same values.
//
// The base below mirrors the shipped `opencode-pty-extended.jsonc` `argDefaults`, so a
// missing config behaves identically to the default config:
//   pty_spawn.notifyOnExit -> true
//   pty_read.offset        -> 0
//   pty_read.limit         -> DEFAULT_READ_LIMIT (see ZERO_MEANS_UNSET)
//   pty_read.ignoreCase    -> false
//   pty_kill.cleanup       -> false
//
// Keys where 0 is not a meaningful value for an omitted argument: a 0 in the
// config is treated as "unset" and falls back to the built-in default. For
// pty_read, `limit: 0` would otherwise make the agent read zero lines.
const ZERO_MEANS_UNSET = new Set(["limit"]);

function buildArgDefaults(DEFAULT_READ_LIMIT, overrides, notifyTarget) {
  const base = {
    pty_spawn: {
      notifyOnExit: true,
      notifyTarget: normalizeNotifyTarget(notifyTarget),
    },
    pty_read: { offset: 0, limit: DEFAULT_READ_LIMIT, ignoreCase: false },
    pty_kill: { cleanup: false },
  };

  if (!overrides || typeof overrides !== "object") return base;

  // Merge per tool, so the config file can override individual keys and add
  // defaults for tools that have none here. `undefined`/`null` — and 0 for keys
  // in ZERO_MEANS_UNSET — are treated as "unset" and keep the built-in default.
  const merged = {};
  const names = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  for (const name of names) {
    const toolDefaults = { ...(base[name] ?? {}) };
    for (const [key, value] of Object.entries(overrides[name] ?? {})) {
      if (value === undefined || value === null) continue;
      if (value === 0 && ZERO_MEANS_UNSET.has(key)) continue;
      toolDefaults[key] = value;
    }
    merged[name] = toolDefaults;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// /pty-config support: live config object + hot reload
// ---------------------------------------------------------------------------
// The config controller (registerPtyRpc's `configGet` / `configSet` handlers)
// operates on a `live` object created by Plugin.setup holding *references* to
// the mutable resolved-config pieces. When a save lands, `live.reload()` re-runs
// the config walk and refreshes every one of those objects IN PLACE
// (`syncObject`, below), so every closure that captured them keeps seeing the
// new values without a plugin restart.

function isPlainObj(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// In-place deep refresh of `target` from `source`: nested plain-object pairs
// recurse (preserving identity for captured references), everything else is
// assigned, and keys that vanish from `source` are deleted from `target`.
function syncObject(target, source) {
  if (!isPlainObj(target) || !isPlainObj(source)) {
    throw new Error("syncObject needs two plain objects");
  }
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObj(value) && isPlainObj(target[key])) {
      syncObject(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// Overlay the `/pty-config` Apply overrides (runtime-only, no file write)
// onto a freshly derived config object. `null` deletes the key so the derive
// falls back to the layer below; any other value replaces it (missing
// ancestor objects are created). Returns the number of keys applied.
function applyRuntimeObject(config, overrides) {
  let count = 0;
  for (const [path, value] of Object.entries(overrides ?? {})) {
    const parts = String(path).split(".");
    let obj = config;
    let missing = false;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObj(obj?.[parts[i]])) {
        if (value === null) {
          missing = true;
          break;
        }
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]];
    }
    if (missing) continue;
    const leaf = parts[parts.length - 1];
    if (value === null) delete obj[leaf];
    else obj[leaf] = value;
    count++;
  }
  return count;
}

// The web-UI option block, refreshed from a (re-loaded) config object. Same
// shape and precedence rules Plugin.setup applies, extracted so the hot
// reload recomputes it instead of drifting from the setup path.
function computeWebUiOptions(config) {
  const rawWebUi = config?.webUi ?? {};
  return {
    csiReply: rawWebUi.csiReply ?? BUILTIN_WEBUI.csiReply,
    ctrlCKillSession: rawWebUi.ctrlCKillSession ?? BUILTIN_WEBUI.ctrlCKillSession,
    ctrlDKillSession: rawWebUi.ctrlDKillSession ?? BUILTIN_WEBUI.ctrlDKillSession,
    debugSize: rawWebUi.debugSize ?? BUILTIN_WEBUI.debugSize,
    killConfirmSession: rawWebUi.killConfirmSession ?? BUILTIN_WEBUI.killConfirmSession,
    closeConfirmSession: rawWebUi.closeConfirmSession ?? BUILTIN_WEBUI.closeConfirmSession,
    downloadLog: rawWebUi.downloadLog ?? BUILTIN_WEBUI.downloadLog,
    stretchSessions: rawWebUi.stretchSessions ?? BUILTIN_WEBUI.stretchSessions,
    sizeControl: rawWebUi.sizeControl ?? BUILTIN_WEBUI.sizeControl,
    spawnButton: rawWebUi.spawnButton ?? BUILTIN_WEBUI.spawnButton,
    // `+` popup dropdown: false (default) = only live opencode sessions,
    // true = the full session history. See createWebApiHandlers.
    newPtyShowAllSessions: rawWebUi.newPtyShowAllSessions ?? BUILTIN_WEBUI.newPtyShowAllSessions,
    newPtyActiveWindowMs: (() => {
      const n = Number(rawWebUi.newPtyActiveWindowMs);
      return Math.max(0, Number.isFinite(n) ? n : BUILTIN_WEBUI.newPtyActiveWindowMs);
    })(),
    // Reconnect poll interval, ms. `false`/`0` disables the watchdog (and the
    // injection); anything else numeric clamps to >= 0, non-numbers fall back
    // to the builtin default. See BUILTIN_WEBUI.reconnectIntervalMs.
    reconnectIntervalMs: (() => {
      const raw = rawWebUi.reconnectIntervalMs ?? BUILTIN_WEBUI.reconnectIntervalMs;
      if (raw === false || raw === 0) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : BUILTIN_WEBUI.reconnectIntervalMs;
    })(),
    // `groupBy` (false | "session" | "agent"); honors a legacy boolean
    // `groupBySession` when `groupBy` itself is not set.
    groupBy: normalizeGroupBy(rawWebUi.groupBy ?? rawWebUi.groupBySession, BUILTIN_WEBUI.groupBy),
    viewerResize: {
      ...BUILTIN_WEBUI.viewerResize,
      ...(typeof rawWebUi.viewerResize === "object" && rawWebUi.viewerResize !== null
        ? rawWebUi.viewerResize
        : rawWebUi.viewerResize === false
          ? { enabled: false }
          : {}),
    },
  };
}

// `ensurePtyWebServer` / `openPtyWebUi` accept either a plain signature
// string (captured at setup) or the live `{ value }` holder the config
// controller refreshes on save - resolved at call time either way, so a web
// server only survives a config save while its bundle signature still
// matches.
function signatureValueOf(serverSignature) {
  if (isPlainObj(serverSignature) && typeof serverSignature.value === "string") {
    return serverSignature.value;
  }
  return typeof serverSignature === "string" ? serverSignature : "";
}

// The /pty-config RPC handlers, built on the `live` object (see Plugin.setup):
//   get  -> rows (schema + provenance + effective value) + save targets
//   set  -> patch one config file, then hot-reload the live pieces
function createConfigController(live) {
  return {
    // The shared helpers in shared.js compute everything from files for one
    // project directory. The live object adds the two server-only layers on
    // top: the `plugins[].options` override from THIS instance's config walk,
    // and any Apply-only runtime overrides.
    get: async () =>
      configGetPayload(live.projectDir ?? process.cwd(), {
        override: live.override,
        runtimeOverrides: live.runtimeOverrides,
      }),
    set: async (input) => {
      const result = configSetLocal(live.projectDir, input);
      // The file is written; refresh the live config so most keys hot-apply.
      if (result?.ok && typeof live.reload === "function") {
        try {
          live.reload();
        } catch (error) {
          console.warn("[opencode-pty-extended] config reload after save failed:", error);
        }
      }
      return result;
    },
    // Apply the draft changes to the RUNNING plugin only (mutates the runtime
    // pieces via `live.reload`, which re-derives from the files first and then
    // overlays `live.runtimeOverrides` — never writes a config file).
    apply: async (input) => {
      const changes = Array.isArray(input?.changes) ? input.changes : [];
      if (changes.length === 0) return { ok: false, error: "no-changes" };
      for (const change of changes) {
        live.runtimeOverrides[change.path] = change?.value === undefined ? null : change.value;
      }
      try {
        if (typeof live.reload === "function") live.reload();
      } catch (error) {
        console.warn("[opencode-pty-extended] runtime config apply failed:", error);
        return { ok: false, error: String(error?.message ?? error) };
      }
      return JSON.parse(
        JSON.stringify({ ok: true, applied: changes.map((change) => change.path) }),
      );
    },
  };
}


// ---------------------------------------------------------------------------
// Web UI font override
// ---------------------------------------------------------------------------
// The PTY Web UI is served from the package's `dist/web/` assets. The terminal
// font is hard-coded in the bundled JS, e.g.:
//
//   new Terminal({ ..., fontFamily: "monospace", fontSize: 14, scrollback: 5e3 })
//
// The plain output panel (`.output-container`, the element that wraps the
// terminal) has its own hard-coded rule in `dist/web/index.html`:
//
//   .output-container { …; font-family: 'SF Mono', 'Fira Code', 'Consolas',
//     monospace; font-size: 13px; line-height: 1.5; … }
//
// `terminalFont` styles that panel too (see applyOutputContainerFontToHtml): the
// container and the terminal it wraps are the same content, so both use
// `terminalFont.family` and, when set, `terminalFont.size`/`terminalFont.lineHeight`. The
// rewrite touches only the `.output-container` rule — the sidebar and output
// header are separate rules and keep the package's styling.
//
// `Bun.serve` snapshots its routes when the server is constructed, so the only
// way to change the font from outside the package is to transform the in-memory
// static responses before `new PTYServer(...)` runs. `installCreateServerPatch`
// wraps `PTYServer.createServer` to do exactly that (it also injects the
// viewer-resize watcher — see below).
//
// The rewriting is intentionally tolerant: if the expected strings are not
// found (e.g. after a package upgrade) the asset is left untouched and a
// warning is logged, rather than failing.

const MONOSPACE_FONT_RE = /fontFamily:\s*["']monospace["']/g;

// JSON.stringify yields a valid JS string literal (for `fontFamily:<literal>` in
// the bundle). CSS/HTML take the raw stack instead, stripped of characters that
// could break out of the declaration.
function fontStackLiteral(family) {
  return JSON.stringify(family);
}

function cssFontStack(family) {
  return String(family).replace(/[;{}<>]/g, "");
}

// Rewrites the bundled JS: the app's own terminal constructor first (so
// `size`/`lineHeight` land on the terminal we care about), then any remaining
// occurrences (xterm's internal option defaults) for the family only.
function applyTerminalFontToJs(text, terminalFont) {
  const family = fontStackLiteral(terminalFont.family);
  const hasSize = typeof terminalFont.size === "number" && terminalFont.size > 0;
  const hasLineHeight =
    typeof terminalFont.lineHeight === "number" && terminalFont.lineHeight > 0;
  let changed = false;

  text = text.replace(
    /fontFamily:\s*["']monospace["']\s*,\s*fontSize:\s*(\d+)\s*,\s*(scrollback:\s*\d+)/g,
    (_match, size, scrollback) => {
      changed = true;
      const parts = [
        `fontFamily:${family}`,
        `fontSize:${hasSize ? terminalFont.size : size}`,
      ];
      if (hasLineHeight) parts.push(`lineHeight:${terminalFont.lineHeight}`);
      parts.push(scrollback);
      return parts.join(",");
    },
  );

  text = text.replace(MONOSPACE_FONT_RE, () => {
    changed = true;
    return `fontFamily:${family}`;
  });

  return { text, changed };
}

function applyTerminalFontToCss(text, terminalFont) {
  const family = cssFontStack(terminalFont.family);
  let changed = false;
  text = text.replace(/font-family:\s*monospace/g, () => {
    changed = true;
    return `font-family:${family}`;
  });
  return { text, changed };
}

function applyTerminalFontToHtml(text, terminalFont) {
  if (
    !terminalFont.family ||
    !text.includes("</head>") ||
    text.includes("data-pty-font-override")
  ) {
    return { text, changed: false };
  }
  const family = cssFontStack(terminalFont.family);
  const container = [];
  if (typeof terminalFont.size === "number" && terminalFont.size > 0) {
    container.push(`font-size:${terminalFont.size}px !important`);
  }
  if (typeof terminalFont.lineHeight === "number" && terminalFont.lineHeight > 0) {
    container.push(`line-height:${terminalFont.lineHeight} !important`);
  }
  const style =
    `<style data-pty-font-override>` +
    `.xterm,.xterm *,.xterm-accessibility-tree,.output-container` +
    `{font-family:${family} !important}` +
    (container.length ? `.output-container{${container.join(";")}}` : "") +
    `</style></head>`;
  return { text: text.replace("</head>", style), changed: true };
}

// Rewrites the font declarations inside the package's own
// `.output-container { … }` rule in `dist/web/index.html`:
//
//   .output-container { …; font-family: 'SF Mono', …; font-size: 13px;
//                       line-height: 1.5; … }
//
// `terminalFont` styles the output area as a whole: the container and the terminal
// it wraps (`.xterm`) are the same content, so they share `family` (and
// `size`/`lineHeight` when configured). Only that rule is touched — sibling
// rules (`.output-header`, `.sidebar`, …) keep the package's styling.
// Idempotent (a second pass finds the rewritten values and reports no change)
// and tolerant: a missing rule leaves the text untouched and the caller warns.
function applyOutputContainerFontToHtml(text, terminalFont) {
  const rule = /\.output-container\s*\{[^}]*\}/;
  const match = rule.exec(text);
  if (!match) return { text, changed: false };

  const decls = [["font-family", `font-family:${cssFontStack(terminalFont.family)}`]];
  if (typeof terminalFont.size === "number" && terminalFont.size > 0) {
    decls.push(["font-size", `font-size:${terminalFont.size}px`]);
  }
  if (typeof terminalFont.lineHeight === "number" && terminalFont.lineHeight > 0) {
    decls.push(["line-height", `line-height:${terminalFont.lineHeight}`]);
  }

  let rewritten = match[0];
  for (const [prop, decl] of decls) {
    const re = new RegExp(`${prop}\\s*:[^;]*`);
    if (re.test(rewritten)) rewritten = rewritten.replace(re, decl);
  }
  if (rewritten === match[0]) return { text, changed: false };
  return { text: text.replace(rule, () => rewritten), changed: true };
}

// Applies the font to the buffered static `Response` objects in place.
function applyTerminalFont(staticRoutes, terminalFont) {
  if (!terminalFont || terminalFont.enabled === false || !terminalFont.family) {
    return Promise.resolve();
  }

  return Promise.all(
    Object.entries(staticRoutes).map(async ([key, response]) => {
      if (typeof Response !== "function" || !(response instanceof Response)) return;

      const dot = key.lastIndexOf(".");
      const ext = dot === -1 ? "" : key.slice(dot).toLowerCase();

      let transform;
      if (ext === ".js") transform = applyTerminalFontToJs;
      else if (ext === ".css") transform = applyTerminalFontToCss;
      else if (ext === ".html")
        // The html gets both the `!important` override near `</head>` and the
        // in-place rewrite of the package's own `.output-container` rule.
        transform = (text, font) => {
          const first = applyTerminalFontToHtml(text, font);
          const second = applyOutputContainerFontToHtml(first.text, font);
          return {
            text: second.text,
            changed: first.changed || second.changed,
          };
        };
      else return;

      const { text, changed } = transform(await response.text(), terminalFont);
      if (!changed) {
        console.warn(
          `[opencode-pty-extended] terminalFont: no matching declaration found in ${key}`,
        );
        return;
      }

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      // The asset was rewritten in memory but its hashed URL and `immutable`
      // cache header are unchanged, so returning browsers would keep the old
      // bytes. Force a refetch for transformed assets only.
      headers.set("Cache-Control", "no-store");
      staticRoutes[key] = new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
}

// Magic envelope the injected watcher POSTs to `/api/sessions/:id/input`. The
// wrapped `manager.write` intercepts it and turns it into a real PTY resize.
const RESIZE_PREFIX = "\x1ePTYRSZ:";

// Magic envelope the size-mode control (web UI) and `pty_size_set` use, posted
// to the same input route. `"\x1ePTYSZM:fixed,<cols>,<rows>"` resizes the PTY
// now AND pins the session to that size (the viewer stops auto-fitting);
// `"\x1ePTYSZM:auto"` releases the pin (the viewer's auto-size resumes; until
// the next fit the PTY keeps its current size). The wrapped `manager.write`
// below intercepts both.
const SIZE_MODE_PREFIX = "\x1ePTYSZM:";

// Upstream `session-lifecycle.js` hardcodes these via its own constants module
// (not exported), so the wrapper mirrors them for sane fallbacks.
const DEFAULT_SPAWN_COLS = 120;
const DEFAULT_SPAWN_ROWS = 40;

const isCellCount = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 1000;

// The current size state of a session, read off the raw session object:
// `mode` — "auto" (viewer may refit; upstream default size at spawn) or "fixed"
// (pinned to an explicit size); `cols`/`rows` — the pinned values when a mode
// envelope/tool stamped them, else the live ConPTY size.
function sessionSizeState(session) {
  const process = session?.process;
  const mode = session?.__ptySizeMode === "fixed" ? "fixed" : "auto";
  const cols = Number.isInteger(session?.__ptyCols)
    ? session.__ptyCols
    : Number.isInteger(process?.cols)
      ? process.cols
      : null;
  const rows = Number.isInteger(session?.__ptyRows)
    ? session.__ptyRows
    : Number.isInteger(process?.rows)
      ? process.rows
      : null;
  return { mode, cols, rows };
}

// Resizes the PTY now and pins the session to that size (stamps mode + dims so
// the CSI reply and `/api/sessions` see them immediately).
function applyFixedSize(session, cols, rows) {
  if (!session?.process) return false;
  if (!isCellCount(cols) || !isCellCount(rows)) return false;
  try {
    session.process.resize(cols, rows);
  } catch (error) {
    console.warn(
      `[opencode-pty-extended] fixed size resize failed for ${session.id}:`,
      error,
    );
    return false;
  }
  session.__ptyCols = cols;
  session.__ptyRows = rows;
  session.__ptySizeMode = "fixed";
  return true;
}

// Releases the fixed-size pin: the viewer's auto-size resumes (until the next
// fit the PTY keeps its current size, which the "falls back to the default
// size" semantics refer to). The dimension stamps are dropped so everything
// reads the live ConPTY size again.
function setSizeModeAuto(session) {
  if (!session) return false;
  session.__ptySizeMode = "auto";
  delete session.__ptyCols;
  delete session.__ptyRows;
  return true;
}

// Parses a `pty_spawn` / `pty_size_set` cols/rows request. Each axis is
// optional; a missing axis is filled from explicitly passed fallback values
// (the spawn defaults or the session's current size). Returns
// `{ ok, cols, rows }` or `{ ok: false }` when BOTH axes are missing or any
// given value is not a valid cell count.
function parseSizeRequest(cols, rows, fallbackCols, fallbackRows) {
  const hasCols = cols !== undefined && cols !== null && cols !== "";
  const hasRows = rows !== undefined && rows !== null && rows !== "";
  if (!hasCols && !hasRows) return { ok: false };
  const resolved = {
    cols: hasCols ? Math.floor(Number(cols)) : fallbackCols,
    rows: hasRows ? Math.floor(Number(rows)) : fallbackRows,
  };
  if (!isCellCount(resolved.cols) || !isCellCount(resolved.rows)) {
    return { ok: false };
  }
  return { ok: true, ...resolved };
}

// Injects the viewer-resize watcher into the web UI bundle. The watcher is
// created inside `initializeTerminal` (where `this.fitAddon` and the terminal
// `t` are in scope). On any resize of the `.xterm` container it re-fits the
// terminal and POSTs the new size as the magic envelope; the active session id
// is read from the container's `data-active-session` attribute, so no
// bundle-internal state is needed. Tolerant: leaves the bundle untouched (and
// the caller logs a warning) if the anchor is missing or already injected.
function applyResizeToJs(text, viewerResize) {
  if (text.includes("__ptyWatchResize")) return { text, changed: false };
  const anchor =
    /this\.terminalRef\.current&&\(t\.open\(this\.terminalRef\.current\),this\.fitAddon\.fit\(\)\),this\.xtermInstance=t/;
  if (!anchor.test(text)) return { text, changed: false };

  const debounceMs =
    viewerResize && Number(viewerResize.debounceMs) > 0
      ? viewerResize.debounceMs
      : 120;

  const injection =
    `this.terminalRef.current&&(t.open(this.terminalRef.current),this.fitAddon.fit(),` +
    `(this.__ptyWatchResize||(this.__ptyWatchResize=()=>{` +
    // Hardened v62 watcher (wedge fix): the observer watches the terminal's
    // PARENT (the app's layout panel) instead of the terminal element itself —
    // the element's own size is mutated by fit() (scrollbar churn), so
    // observing el re-triggered its own resizing in a ping-pong loop. send()
    // additionally skips no-op posts: the PTYRSZ envelope only leaves the page
    // when the size actually changed since the last post (output-driven
    // scrollbar flapping no longer spams the PTY with resizes).
    `const el=this.terminalRef.current;if(!el)return;let timer=0,T=null;` +
    `const act=el.parentElement||el;` +
    `const activeId=()=>{let n=el,id="";` +
    `while(n){id=(n.getAttribute&&n.getAttribute("data-active-session"))||"";if(id)break;n=n.parentElement}return id};` +
    `const send=()=>{timer=0;const id=activeId();if(!id)return;` +
    `var AUTO=window.__ptySizeMode||(window.__ptySizeMode={});` +
    `var NOW=window.__ptySizeNow||(window.__ptySizeNow={});` +
    `NOW[id]={cols:t.cols,rows:t.rows};` +
    `if(AUTO[id]==="fixed")return;` +
    `try{this.fitAddon.fit()}catch(e){}` +
    `NOW[id]={cols:t.cols,rows:t.rows};` +
    `var SENT=window.__ptySizeSent||(window.__ptySizeSent={});` +
    `var prev=SENT[id];` +
    `if(!prev||prev.cols!==t.cols||prev.rows!==t.rows){` +
    `SENT[id]={cols:t.cols,rows:t.rows};` +
    `try{fetch("/api/sessions/"+id+"/input",{method:"POST",` +
    `headers:{"Content-Type":"application/json"},` +
    `body:JSON.stringify({data:"\\u001ePTYRSZ:"+t.cols+","+t.rows})})}catch(e){}}};` +
    `window.__ptySendResize=send;` +
    `const onR=()=>{clearTimeout(timer);timer=setTimeout(send,${debounceMs})};` +
    `if("ResizeObserver"in window){T=new ResizeObserver(onR);T.observe(act)}` +
    `else window.addEventListener("resize",onR);` +
    `this.__ptyDisposeResize=()=>{clearTimeout(timer);` +
    `if(window.__ptySendResize===send)window.__ptySendResize=null;` +
    `if(T){try{T.disconnect()}catch(e){}T=null}else window.removeEventListener("resize",onR)};` +
    `setTimeout(send,250)}))()),this.xtermInstance=t`;

  return { text: text.replace(anchor, injection), changed: true };
}

// Query parameter the web UI patch reads to pick a session (see below).
const SESSION_QUERY_KEY = "session";

// Injects "?session=<id>" support into the web UI bundle. The app has no
// URL-based selection: on every `session_list` WebSocket message it
// auto-selects the first running session, unless localStorage["skip-autoselect"]
// is "true". The patch rewrites that selection expression so the `session`
// query parameter wins (even when skip-autoselect is set), while leaving the
// original running/first fallback intact for URLs without the parameter.
// Tolerant: leaves the bundle untouched (and the caller logs a warning) when
// the anchor is missing or the patch was already applied.
function applySelectSessionToJs(text) {
  // After the first pass the anchor is gone, so this is naturally idempotent.
  const anchor =
    'B.length>0&&!e&&!O&&(U=B.find(G=>G.status==="running")||null||B[0]||null,';
  if (!text.includes(anchor)) return { text, changed: false };

  const injection =
    `B.length>0&&!e&&(U=(()=>{let W=null;try{W=` +
    `new URLSearchParams(location.search).get(${JSON.stringify(SESSION_QUERY_KEY)})` +
    `}catch(Z){}if(W){const Z=B.find(G=>G.id===W);if(Z)return Z}` +
    `return O?null:(B.find(G=>G.status==="running")||null||B[0]||null)})(),`;

  return { text: text.replace(anchor, injection), changed: true };
}

// The shipped web JS wires the terminal's `onData` handler to treat Ctrl+C
// ("\x03") like the "Kill Session" button (`onInterrupt`), so pressing Ctrl+C
// killed the session instead of interrupting its foreground process. This
// regenerates that handler from the effective options:
//
//   ctrlCKillSession (default false) -> false: `^C` is forwarded to the PTY as
//                                       input (a real interrupt);
//                                       true:  `^C` kills the session.
//   ctrlDKillSession (default true)  -> true:  `^D` kills the session.
//
// Regenerating the whole `setupInputHandling` body makes it idempotent (a
// second pass with the same options is a no-op) and lets the options be changed
// without a stale handler lingering. Tolerant: leaves the bundle untouched (and
// the caller logs a warning) if the anchor is missing.
function applyKillKeysToJs(text, { ctrlCKillSession, ctrlDKillSession } = {}) {
  const anchor =
    /setupInputHandling\((\w+)\)\{const\{onSendInput:(\w+),onInterrupt:(\w+),disabled:(\w+)\}=this\.props;if\(\4\)return;[\s\S]*?\}(?=render\(\))/;
  const match = text.match(anchor);
  if (!match) return { text, changed: false };

  const [, term, send, interrupt, disabled] = match;
  const key = "c";
  const conds = [];
  if (ctrlCKillSession === true) conds.push(`${key}==="\\u0003"`);
  if (ctrlDKillSession !== false) conds.push(`${key}==="\\u0004"`);

  const handler =
    conds.length > 0
      ? `${key}=>{(${conds.join("||")})?${interrupt}?.():${send}?.(${key})}`
      : `${key}=>{${send}?.(${key})}`;

  const replacement =
    `setupInputHandling(${term}){const{onSendInput:${send},onInterrupt:${interrupt},disabled:${disabled}}=this.props;if(${disabled})return;${term}.onData(${handler})}`;

  if (text.includes(replacement)) return { text, changed: false };
  return { text: text.replace(match[0], replacement), changed: true };
}

// Relabels the web UI's "Debug:" line (user-locked format, 2026-11-03): the
// pane line built by the React bundle as
//
//   children:["Debug: ",<l>.length," chars, active: ",<s>?.id||"none",
//            ", WS raw_data:"," ",<p>,", session_updates: ",<y>]
//
// becomes "<id>: N chars, WS raw_data: …, session_updates: …" with the id
// BOLD — the "Debug:" and "active:" labels are dropped. Because the children
// are a literal array, the rewrite is a static head replacement; the bold id
// is emitted through the bundle's own jsx runtime (`_e.jsx`, referenced in
// the same React component), so React renders and re-renders `<strong>` on
// every output chunk with zero DOM observer hacks. Only a truthy id is
// bolded — with the pane empty the original `||"none"` falls back to PLAIN
// `none:` (user decision) to keep the format uniform.
//
// Idempotent: the anchor contains `"Debug: "` which the rewrite erases.
// Tolerant: leaves the bundle untouched (and the caller logs a warning) if
// the anchor is missing. MUST run before applyDebugSizeToJs in the patch
// chain (that patch anchors on the unchanged `", session_updates: ",<y>]`
// tail, untouched here).
function applyDebugRelabelToJs(text) {
  const anchor =
    /"Debug: ",(\w+)\.length," chars, active: ",(\w+)\?\.\w+\|\|"none",", WS raw_data:"," "/;
  const match = text.match(anchor);
  if (!match) return { text, changed: false };
  const [, len, sel] = match;
  const injection =
    `${sel}?_e.jsx("strong",{children:${sel}.id}):"none",": ",` +
    `${len}.length," chars",", WS raw_data:"," "`;
  return { text: text.replace(match[0], injection), changed: true };
}

// Extends the web UI's debug line (already relabeled by
// applyDebugRelabelToJs: "<id>: N chars, …") with the live terminal size, e.g.
// "... , session_updates: 3, size: 120x40". The value is read at render time
// from the xterm instance the bundle already exposes on `window.xtermTerminal`
// (set in `initializeTerminal`), so it tracks the current viewer size. The line
// re-renders whenever terminal output or session updates arrive.
//
// Idempotent: after the rewrite the anchor no longer matches. Tolerant: leaves
// the bundle untouched (and the caller logs a warning) if the anchor is missing.
function applyDebugSizeToJs(text) {
  const anchor = /, session_updates: ",(\w+)\]/;
  const match = text.match(anchor);
  if (!match) return { text, changed: false };
  const [, updates] = match;
  const injection =
    `, session_updates: ",${updates},", size: ",` +
    `(window.xtermTerminal?window.xtermTerminal.cols+"x"+window.xtermTerminal.rows:"?x?")]`;
  return { text: text.replace(match[0], injection), changed: true };
}

// Gates the web UI's "Kill Session" confirmation dialog. The shipped handler
// (`onInterrupt`, shared by the header button and the Ctrl+D shortcut) prompts
// before killing:
//
//   if(e&&confirm(`Are you sure you want to kill session "${e.description??e.title}"?`))
//     try{await ln.session.kill({id:e.id})}catch{}
//
// When `killConfirmSession` is false the guard is dropped so the kill happens
// without asking. A no-op while enabled (the pristine text is already correct),
// so it is naturally idempotent. Tolerant: leaves the bundle untouched (and the
// caller logs a warning) if the anchor is missing.
function applyKillConfirmToJs(text, { enabled } = {}) {
  if (enabled !== false) return { text, changed: false };
  const anchor =
    'if(e&&confirm(`Are you sure you want to kill session "${e.description??e.title}"?`))' +
    "try{await ln.session.kill({id:e.id})}catch{}";
  if (!text.includes(anchor)) return { text, changed: false };
  return {
    text: text.replace(anchor, "if(e)try{await ln.session.kill({id:e.id})}catch{}"),
    changed: true,
  };
}

// Adds a per-session close (×) button to each sidebar session box in the web
// UI. Clicking it grays the card IMMEDIATELY (direct `.session-closing` DOM
// write from the click handler — the React tree only repaints on the next
// poll), then confirms, then sends `DELETE /api/sessions/:id/cleanup` for
// that session — the same one-call kill+cleanup the server already exposes
// (`cleanupSession` -> `manager.kill(id, true)`), so the session's process is
// terminated *and* its record dropped (unlike the header "Kill Session" button,
// which only kills and leaves the box behind as "killed").
//
// Two rewrites (see applySessionCloseToHtml for the CSS half):
//
//   1. Filters dismissed ids out of the rendered list, so a session closed
//      while running doesn't flash back as "killed" when its `session_update`
//      (fired by the process's onExit) arrives before the next 10s poll.
//   2. Prepends a `<span class="session-close">` to each box's children.
//
// The × is a `<span>` (not a nested `<button>` — invalid HTML inside the box's
// own `<button>`) and stops propagation so clicking it doesn't select the
// session. When `closeConfirmSession` is false (`{ confirm: false }`) the
// "Kill and remove session?" confirmation is dropped. Idempotent: after the
// rewrite the anchors no longer match. Tolerant: leaves the bundle untouched
// (and the caller warns) if the anchor is missing.
function applySessionCloseToJs(text, { confirm } = {}) {
  // 1. Render only sessions not yet dismissed (window.__ptyClosed).
  const mapAnchor = '):e.map(l=>_e.jsxs("button",{type:"button",className:';
  const mapInjection =
    '):e.filter(l=>!(window.__ptyClosed||new Set()).has(l.id))' +
    '.map(l=>_e.jsxs("button",{type:"button",className:';
  // 2. Prepend the close button to each box's children.
  const childAnchor =
    'onClick:()=>s(l),children:[_e.jsx("div",{className:"session-title"';
  // The handler grays the card IMMEDIATELY (direct DOM, before the confirm
  // dialog and the cleanup fetch): the React tree only repaints on the next
  // poll/session_update, so without this the card sits there "running" for
  // a noticeable moment. Un-grayed on cancel / fetch failure; on success the
  // card is filtered out of the next render anyway.
  const closeSpan =
    '_e.jsx("span",{className:"session-close",title:"Kill and remove",onClick:(ev)=>{' +
    'ev.stopPropagation();ev.preventDefault();' +
    'var B=ev.target&&ev.target.closest?ev.target.closest(".session-item"):null;' +
    'if(B)B.classList.add("session-closing");' +
    (confirm === false
      ? ""
      : `if(!confirm('Kill and remove session "'+(l.description??l.title)+'"?')){if(B)B.classList.remove("session-closing");return;}`) +
    'var K=window.__ptyClosed||(window.__ptyClosed=new Set());K.add(l.id);' +
    `fetch('/api/sessions/'+encodeURIComponent(l.id)+'/cleanup',{method:'DELETE'})` +
    '.then(function(r){if(!r.ok){K.delete(l.id);if(B)B.classList.remove("session-closing")}})' +
    '.catch(function(){K.delete(l.id);if(B)B.classList.remove("session-closing")})' +
    '},children:"\\u00d7"}),';

  if (!text.includes(mapAnchor) || !text.includes(childAnchor)) {
    return { text, changed: false };
  }
  const out = text
    .replace(mapAnchor, mapInjection)
    .replace(
      childAnchor,
      `onClick:()=>s(l),children:[${closeSpan}_e.jsx("div",{className:"session-title"`,
    );
  return { text: out, changed: true };
}

// Injects the download log split button (Download|RAW) into the web UI header,
// left of the "Kill Session" button. Downloads use the existing buffer endpoints:
// - plain (ANSI stripped) as .log
// - raw (with ANSI) as .raw.log
function applyDownloadLogToJs(text) {
  const anchor =
    '_e.jsx("button",{type:"button",className:"kill-btn",onClick:U,children:"Kill Session"})';
  if (!text.includes(anchor)) return { text, changed: false };
  return { text, changed: false };
}

// Groups the web UI sidebar's PTY sessions by their owning opencode conversation
// (see installManagerGroupBySession for the backend data). The shipped sidebar
// renders a flat list:
//
//   className:"session-list",children:e.length===0?…:e.map(l=>_e.jsxs("button",…))
//
// This rewrites the `.map` into a call to `window.__ptyGroup(<array>,_e,l=>…)`
// (defined by applyGroupBySessionToHtml). The helper keeps the same item
// renderer but prepends a header before each run of sessions that share a
// `groupSessionId`, and emits the parentless sessions first, ungrouped. `_e` (the
// jsx-runtime object) is passed in because the injected helper lives in a
// separate `<script>` that cannot see the bundle's local binding.
//
// Each group/subgroup header also carries a group close ("×") button when the
// grouped conversations have PTYs: it grays the group's cards IMMEDIATELY (the
// same direct `.session-closing` DOM write as the per-card ×), asks once for the
// whole list (up to 5 `title (id)` lines + "... and M more"; skipped when
// `confirm === false`, reusing the session-close `closeConfirmSession` gate via
// the `{ confirm }` argument), then sends `DELETE /api/sessions/:id/cleanup` for
// every PTY of that conversation and marks them dismissed in
// `window.__ptyClosed` (same filter the per-card × uses). The items are baked
// into the closure at render time, so the header × kills exactly the PTYs shown
// under it; if any cleanup fails, the collected cards are un-grayed again (the
// DOM walk order may not match the items order, so this stays conservative).
//
// The array expression is captured generically (`e` or the session-close patch's
// `e.filter(…).map(…)`), so this works whether or not applySessionCloseToJs ran
// first. Idempotent (the `__ptyGroup` marker) and tolerant: leaves the bundle
// untouched (and the caller logs a warning) if the anchor is missing.
function applyGroupBySessionToJs(text) {
  if (text.includes("__ptyGroup")) return { text, changed: false };
  const anchor =
    /([A-Za-z_$][\w$]*(?:\.filter\([\s\S]*?\))?)\.map\(l=>_e\.jsxs\("button",\{type:"button",className:`session-item /;
  const match = text.match(anchor);
  if (!match) return { text, changed: false };

  const head = 'window.__ptyGroup(';
  const tail = ',_e,l=>_e.jsxs("button",{type:"button",className:`session-item ';
  return { text: text.replace(anchor, head + match[1] + tail), changed: true };
}

// context and styles the `.session-close` × at its top-right. Injected into
// `dist/web/index.html` near `</head>`, independently of the terminalFont override.
// Idempotent (a second pass sees the marker) and tolerant (missing `</head>`
// leaves the text untouched).
function applySessionCloseToHtml(text) {
  if (!text.includes("</head>") || text.includes("data-pty-session-close")) {
    return { text, changed: false };
  }
  const style =
    `<style data-pty-session-close>` +
    `.session-item{position:relative}` +
    // Circle 1px closer to the edge (top:1/right:1); glyph centered
    // (paddingless 16px box, 11px font); unhovered fill matches the cards.
    `.session-close{position:absolute;top:1px;right:1px;width:16px;height:16px;` +
    `display:flex;align-items:center;justify-content:center;` +
    `font-size:11px;line-height:1;color:#c9d1d9;background:#21262d;` +
    `border:1px solid #30363d;border-radius:50%;cursor:pointer;` +
    `user-select:none;box-sizing:border-box}` +
    `.session-close:hover{color:#fff;background:#da3633;border-color:#da3633}` +
    // Immediate "closing" state written by the × handler (see
    // applySessionCloseToJs): gray + inert until the card is removed.
    `.session-item.session-closing{filter:grayscale(1);opacity:.55;pointer-events:none}` +
    `</style></head>`;
  return { text: text.replace("</head>", style), changed: true };
}

// Web-UI shape overrides, ALWAYS applied (independent of downloadLog/groupBy):
//   1. The header "Kill Session" button gets the download split button's
//      geometry (`.dl-part`: padding 6px 10px, font-size 13px, weight 500,
//      line-height 1) but keeps its own look - background #da3633, white text,
//      hover #f85149, radius 6px. Being injected later in <head>, equal
//      specificity wins over upstream's `.kill-btn` (8px 16px / 14px / 600).
//   2. `webUi.stretchSessions` (default true): upstream renders each sidebar
//      entry as `<button class="session-item">`; buttons are UA inline-block
//      (shrink-to-fit), so cards stop short of the sidebar's right edge.
//      `display:block;width:100%` fills the list width — width:100% is what
//      actually stretches a button; display:block alone does not (Chrome keeps
//      a button's atomic inline-level sizing). false restores it.
//   3. Terminal background placement: the app paints the xterm scrollable
//      element gray via an INLINE `background-color: rgb(30, 30, 30)` style
//      (set from JSX, wins over any plain CSS), so the gray covers the whole
//      terminal band even where no text is drawn. The gray belongs on the
//      terminal's screen surface instead: `.xterm-scrollable-element` becomes
//      transparent (`!important` beats the inline style) and `.xterm-screen`
//      carries `rgb(30, 30, 30)`, matching the color the app assigns. The
//      same selector also pins `position: absolute` (the app sets it inline;
//      kept stable in CSS) and reserves `padding-right: 21px` for the
//      scrollbar strip so surface content does not run under it.
//      The xterm viewport (`.xterm .xterm-viewport`) is made transparent and
//      its `overflow-y: scroll` unset (dead weight that forces the native
//      gray scrollbar gutter; the custom ScrollableElement owns scrolling).
//      Side effect of the transparency: the custom (VS Code-style)
//      scrollbar's track has no background of its own, so rule 3a gives it
//      the same `rgb(30, 30, 30)` as the screen surface (user-locked) and
//      stops the upstream idle fade (`opacity: 1 !important` +
//      `pointer-events: auto !important`) so the scrollbar is always visible
//      and grabbable.
// Idempotent + tolerant like the siblings above.
function applyWebUiShapeToHtml(text, { stretch = true } = {}) {
  if (!text.includes("</head>") || text.includes("data-pty-webui-shape")) {
    return { text, changed: false };
  }
  const rules = [`.kill-btn{padding:6px 10px;font-size:13px;font-weight:500;line-height:1}`];
  if (stretch) rules.push(`.session-item{display:block;width:100%}`);
  rules.push(
    // background: the app paints this element gray via an INLINE style
    // (`background-color: rgb(30,30,30)` set from JSX) - transparent
    // `!important` is what beats it; the gray belongs on `.xterm-screen`.
    // position: the app ALSO sets `position: absolute` inline on this element;
    // pinning it in CSS keeps that stable. padding-right reserves the
    // scrollbar strip (user-locked 21px) so terminal content does not run
    // under the scrollbar.
    `.xterm .xterm-scrollable-element{background-color:transparent !important;position:absolute !important;padding-right:21px}`,
    `.xterm .xterm-screen{background-color:rgb(30,30,30)}`,
    // Upstream xterm CSS paints the scrollback viewport #000; transparent so
    // the app's own background shows through around the gray screen surface.
    // The same upstream rule carries `overflow-y: scroll`, which forces the
    // always-on NATIVE scrollbar gutter even though this xterm build's scroll
    // handling lives in `.xterm-scrollable-element` (the viewport never
    // overflows: scrollHeight == clientHeight, measured live) - dead weight
    // that shows as a gray classic scrollbar in Chrome builds with
    // non-overlay scrollbars. `unset` neutralizes it (overflow-y does not
    // inherit -> initial `visible`; the viewport still clips nothing
    // horizontally since overflow-x stays visible too).
    `.xterm .xterm-viewport{background-color:transparent;overflow-y:unset}`,
    // 3a: the scrollbar strip mirrors the screen background (user-locked
    // rgb(30,30,30), the same color `.xterm-screen` carries; the slider keeps
    // its theme color). Matches upstream's own state rules on the same
    // element (`.visible{background:#0000}`), so the injected block must win
    // on document order AND specificity - both are equal, hence
    // `!important`.
    //
    // opacity/pointer-events: upstream fades the scrollbar out after idle
    // (`.invisible{opacity:0;pointer-events:none}` + `.invisible.fade`
    // transition) - user-locked: it should never fade. `!important` also
    // beats those state rules on the same element; pointer-events:auto keeps
    // the thumb grabbable/clickable even in the upstream "invisible" state
    // (upstream gives the .scrollbar block its own inline
    // position/width/height/right:0/top:0 - untouched).
    `.xterm .xterm-scrollable-element>.scrollbar{background-color:rgb(30,30,30) !important;opacity:1 !important;pointer-events:auto !important}`,
  );
  const style =
    `<style data-pty-webui-shape>` + rules.join("") + `</style></head>`;
  return { text: text.replace("</head>", style), changed: true };
}

// Web-UI WebSocket auto-reconnect, frontend half.
//
// Upstream never re-connects: the page's single `/ws` WebSocket only flips a
// `connected` state in `onclose` (`m.onclose=()=>{h(!1)}`), so a dropped
// socket (server recycle, restart, down-time, sleep) leaves the page dead
// until an explicit reload. Two pieces fix that:
//
//   1. THIS function (runs on the bundle JS): directly after the app
//      constructs its WebSocket (`const m=new WebSocket(...);return
//      m.onopen=...`) it registers that socket with
//      `window.__ptyWsWatch(m)` (defined by applyWsReconnectToHtml's script).
//   2. The injected script: while the socket is OPEN it stays passive (never
//      touches the app's own onopen/onclose — only addEventListener, which
//      coexists with the property handlers). The MOMENT the current socket
//      fires `close` it starts a probe loop: every `interval` ms it opens a
//      bare probe WebSocket to `/ws`; on the first successful probe open it
//      reloads the page, which re-mounts the whole app (session list,
//      subscription, xterm + buffer replay). Never starts while connected;
//      reloads are rate-limited to one per 15 s so a flapping server cannot
//      loop-reload. `interval <= 0` never injects anything.
//
// The anchor is upstream's own code with this exact surrounding (single
// `new WebSocket` in the whole bundle):
//   `const m=new WebSocket(<...>);return m.onopen=`
// Idempotent + tolerant like the sibling patchers.
function applyWsReconnectToJs(text) {
  const anchor = "return m.onopen=";
  if (typeof text !== "string" || !text.includes(anchor) ||
      text.includes("window.__ptyWsWatch&&window.__ptyWsWatch(m);")) {
    return { text, changed: false };
  }
  return {
    text: text.replace(
      anchor,
      "window.__ptyWsWatch&&window.__ptyWsWatch(m);" + anchor,
    ),
    changed: true,
  };
}

// Web-UI WebSocket auto-reconnect, HTML half: injects the (idempotent)
// `window.__ptyWsWatch` watchdog script described above. `interval` is the
// effective `webUi.reconnectIntervalMs` (ms between probes); the caller only
// invokes this with `interval > 0`, and the script guards it again. Injected
// into `dist/web/index.html` near `</head>`; a missing `</head>` leaves the
// text untouched.
function applyWsReconnectToHtml(text, { interval = 2000 } = {}) {
  if (typeof text !== "string" || !text.includes("</head>") || text.includes("data-pty-ws-watch")) {
    return { text, changed: false };
  }
  // Integer, and sane floor: a probe per tick (plus every WS state machine
  // bubble) should stay below a few Hz even at absurd config values.
  const iv = Math.max(250, Math.round(Number(interval) || 2000));
  const script =
    `<script data-pty-ws-watch>(function(){` +
    `if(window.__ptyWsWatch)return;` +
    `var IV=${iv},URL=(location.protocol=="https:"?"wss://":"ws://")+location.host+"/ws";` +
    `var cur=null,timer=null,lastReload=0;` +
    `function stop(){if(timer){clearInterval(timer);timer=null}}` +
    `function start(){if(!IV||timer)return;timer=setInterval(check,IV)}` +
    `function check(){` +
    `if(cur&&cur.readyState!==3){stop();return}` +
    `var s=null;try{s=new WebSocket(URL)}catch(e){stop();return}` +
    `var done=false;` +
    `s.addEventListener("open",function(){if(done)return;done=true;try{s.close()}catch(e){}` +
    `if(cur&&cur.readyState!==3)return;` +
    `var n=Date.now();if(n-lastReload>15000){lastReload=n;stop();location.reload()}});` +
    `s.addEventListener("close",function(){if(done)return;done=true;try{s.close()}catch(e){}});` +
    `}` +
    `window.__ptyWsWatch=function(m){` +
    `if(!m||typeof m.addEventListener!=="function")return;` +
    `cur=m;stop();` +
    `m.addEventListener("open",function(){if(cur===m){cur=m;stop()}});` +
    `m.addEventListener("close",function(){if(cur!==m)return;cur=m;start()});` +
    `};` +
    `})();</script></head>`;
  return { text: text.replace("</head>", script), changed: true };
}

// Frontend of webUi.downloadLog: injects the (Download|RAW|mode) split button
// into the web UI header, left of "Kill Session", plus a dropdown (the attached
// `▾` segment) toggling the download source per PTY session:
//   "screen" (default) — serialize the page's live xterm buffer (scrollback +
//              viewport, wraps joined): Download = plain text, RAW = text with
//              ANSI colors reconstructed from cell attributes (SGR runs).
//   "buffer" — the upstream byte-stream ring buffer endpoints:
//              Download = /buffer/plain (Bun.stripANSI), RAW = /buffer/raw.
// The mode is stored in `window.__ptyDlMode[sessionId]` (plain JS var per PTY,
// intentionally reset on page reload) and shown on the `▾` segment itself.
// Filenames carry the mode: <title>-<ts>.screen[.raw].log / .buffer[.raw].log.
//
// The xterm Terminal instance is reached by walking the React fiber tree from
// the `.xterm` DOM node up to a hook ref holding an object with `.buffer` and
// `.rows`; if that fails, screen Download falls back to `.xterm-screen`
// innerText and RAW reports the failure. No new server routes.
//
// NB: the injected script runs in <head>, where document.body is still null —
// DOM work must happen inside boot() (at/after DOMContentLoaded). Injected
// source avoids ALL backslash escapes (use String.fromCharCode/new RegExp) so
// template-literal escaping can never corrupt it.
function applyDownloadLogToHtml(text) {
  if (!text.includes("</head>") || text.includes("data-pty-download-log")) {
    return { text, changed: false };
  }
  const style =
    `<style data-pty-download-log>` +
    `.dl-split{display:inline-flex;border:1px solid #30363d;border-radius:6px;overflow:hidden;background:#0d1117}` +
    `.dl-part{padding:6px 10px;background:transparent;color:#c9d1d9;border:0;cursor:pointer;font-size:13px;font-weight:500;line-height:1;white-space:nowrap}` +
    `.dl-part+.dl-part{border-left:1px solid #30363d}` +
    `.dl-part:hover{background:#30363d}` +
    `.dl-part:active{background:#21262d}` +
    `.dl-plain{color:#c9d1d9}` +
    `.dl-raw{color:#8b949e}` +
    `.dl-mode{color:#8b949e;font-size:11px;padding:6px 8px}` +
    `.dl-menu{position:fixed;z-index:1000;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:4px;display:flex;flex-direction:column;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.4)}` +
    `.dl-menu-item{text-align:left;background:transparent;border:0;color:#c9d1d9;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap}` +
    `.dl-menu-item:hover{background:#30363d}` +
    `.output-header .output-title{margin-right:auto}` +
    `.output-header .dl-split{margin-right:16px}` +
    `</style>`;
  const script =
    `<script data-pty-download-log>` +
    `(function(){` +
    `var MODES={};` +
    `var NL=String.fromCharCode(10),CR=String.fromCharCode(13),ESC=String.fromCharCode(27);` +
    `function sid(){var c=document.querySelector(".container");return c?c.getAttribute("data-active-session"):null}` +
    `function mode(){var id=sid();return(id&&MODES[id])||"screen"}` +
    `function setMode(k){var id=sid();if(id)MODES[id]=k}` +
    `function looksLikeTerm(o){return !!o&&typeof o.write==="function"&&!!o.buffer&&typeof o.rows==="number"}` +
    `function findHost(){` +
    `var el=document.querySelector(".xterm");` +
    `for(var d=0;el&&d<6;el=el.parentElement,d++){` +
    `var keys=Object.keys(el);` +
    `for(var i=0;i<keys.length;i++){` +
    `if(keys[i].indexOf("__reactFiber$")!==0)continue;` +
    `var f=el[keys[i]];` +
    `for(var up=0;f&&up<300;f=f.return,up++){` +
    `var sn=f.stateNode;` +
    `if(sn&&typeof sn==="object"){` +
    `if(looksLikeTerm(sn.xtermInstance))return sn;` +
    `if(looksLikeTerm(sn))return sn}` +
    `for(var h=f.memoizedState;h;h=h.next){` +
    `var c=h.memoizedState;` +
    `if(c&&c.current&&looksLikeTerm(c.current))return c.current;` +
    `if(looksLikeTerm(c))return c}}}}` +
    `return null}` +
    `function termOf(x){return(x&&x.xtermInstance)||x}` +
    `function serOf(x){return(x&&x.serializeAddon)||null}` +
    `function stripAnsi(str){` +
    `var out="",i=0,n=str.length;` +
    `while(i<n){` +
    `var cd=str.charCodeAt(i);` +
    `if(cd===27){` +
    `i++;` +
    `var c2=str.charCodeAt(i);` +
    `if(c2===91){i++;while(i<n){var cc=str.charCodeAt(i);i++;if(cc>=64&&cc<=126)break}}` +
    `else{i++}` +
    `continue}` +
    `out+=str.charAt(i);i++}` +
    `return out}` +
    `function sgr(c){` +
    `var p=[];` +
    `if(c.isBold())p.push(1);` +
    `if(c.isDim())p.push(2);` +
    `if(c.isItalic())p.push(3);` +
    `if(c.isUnderline())p.push(4);` +
    `if(c.isInverse())p.push(7);` +
    `if(c.isFgRGB()){var f=c.getFgColor();p.push(38,2,(f>>>16)&255,(f>>>8)&255,f&255)}` +
    `else if(c.isFgPalette()){var i=c.getFgColor();if(i<8)p.push(30+i);else if(i<16)p.push(90+i-8);else p.push(38,5,i)}` +
    `if(c.isBgRGB()){var g=c.getBgColor();p.push(48,2,(g>>>16)&255,(g>>>8)&255,g&255)}` +
    `else if(c.isBgPalette()){var j=c.getBgColor();if(j<8)p.push(40+j);else if(j<16)p.push(100+j-8);else p.push(48,5,j)}` +
    `return p.length?ESC+"["+p.join(";")+"m":""}` +
    `function snapText(){` +
    `var host=findHost();if(!host)return null;` +
    `var t=termOf(host),ser=serOf(host);` +
    `if(ser&&typeof ser.serialize==="function"){` +
    `try{var s=ser.serialize({scrollback:t.buffer.active.length});return stripAnsi(s).split(CR+NL).join(NL).split(CR).join(NL)}catch(e){}}` +
    `var b=t.buffer.active;` +
    `var end=Math.min(b.lines.length,b.ydisp+t.rows);` +
    `var lines=[];` +
    `for(var y=0;y<end;y++){` +
    `var l=b.lines.get(y);if(!l)break;` +
    `var str=l.translateToString(true);` +
    `if(l.isWrapped&&lines.length)lines[lines.length-1]+=str;` +
    `else lines.push(str)}` +
    `return lines.join(NL)}` +
    `function snapAnsi(){` +
    `var host=findHost();if(!host)return null;` +
    `var t=termOf(host),ser=serOf(host);` +
    `if(ser&&typeof ser.serialize==="function"){try{return ser.serialize({scrollback:t.buffer.active.length})}catch(e){}}` +
    `var b=t.buffer.active;` +
    `var end=Math.min(b.lines.length,b.ydisp+t.rows);` +
    `var lines=[];` +
    `for(var y=0;y<end;y++){` +
    `var l=b.lines.get(y);if(!l)break;` +
    `var out="",cur="",len=l.translateToString(true).length;` +
    `for(var x=0;x<len;x++){` +
    `var c=l.getCell(x);if(!c||c.getWidth()===0)continue;` +
    `var ch=c.getChars()||" ";` +
    `var s=sgr(c);` +
    `if(s!==cur){out+=s;cur=s}` +
    `out+=ch}` +
    `if(cur)out+=ESC+"[0m";` +
    `if(l.isWrapped&&lines.length)lines[lines.length-1]+=out;` +
    `else lines.push(out)}` +
    `return lines.join(NL)}` +
    `function save(name,txt){` +
    `var b=new Blob([txt],{type:"text/plain;charset=utf-8"});` +
    `var a=document.createElement("a");` +
    `a.href=URL.createObjectURL(b);a.download=name;` +
    `document.body.appendChild(a);a.click();` +
    `setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},0)}` +
    `async function dl(cls){` +
    `try{` +
    `var id=sid();if(!id)return;` +
    `var m=mode(),raw=cls==="dl-raw";` +
    `var titleEl=document.querySelector(".output-title");` +
    `var base=((titleEl&&titleEl.innerText||id)+"").replace(new RegExp("[^A-Za-z0-9._-]+","g"),"_");` +
    `var ts=new Date().toISOString().replace(new RegExp("[:.]","g"),"-");` +
    `if(m==="screen"){` +
    `var txt=raw?snapAnsi():snapText();` +
    `if(txt==null){alert("Screen snapshot unavailable (terminal instance not found)");return}` +
    `save(base+"-"+ts+".screen"+(raw?".raw.log":".log"),txt);` +
    `return}` +
    `var r=await fetch("/api/sessions/"+encodeURIComponent(id)+"/buffer/"+(raw?"raw":"plain"));` +
    `if(!r.ok)throw new Error("HTTP "+r.status);` +
    `var j=await r.json();` +
    `save(base+"-"+ts+".buffer"+(raw?".raw.log":".log"),raw?(j.raw||""):(j.plain||""))` +
    `}catch(e){alert("Download failed: "+e.message)}}` +
    `function closeMenu(){` +
    `var m=document.querySelector(".dl-menu");if(m)m.remove();` +
    `document.removeEventListener("mousedown",outside,true);` +
    `document.removeEventListener("keydown",escKey,true)}` +
    `function outside(ev){var m=document.querySelector(".dl-menu");if(!m)return;if(m.contains(ev.target))return;var t=ev.target;if(t&&t.closest&&t.closest(".dl-mode"))return;closeMenu()}` +
    `function escKey(ev){if(ev.key==="Escape")closeMenu()}` +
    `function toggleMenu(btn){` +
    `if(document.querySelector(".dl-menu")){closeMenu();return}` +
    `var m=document.createElement("div");m.className="dl-menu";m.setAttribute("role","menu");` +
    `["screen","buffer"].forEach(function(k){` +
    `var it=document.createElement("button");` +
    `it.type="button";it.className="dl-menu-item";it.setAttribute("role","menuitemradio");` +
    `var on=mode()===k;it.setAttribute("aria-checked",on?"true":"false");` +
    `it.innerText=(on?"✓ ":"")+(k==="screen"?"Screen — what the terminal shows":"Buffer — raw byte stream");` +
    `it.onclick=function(){setMode(k);closeMenu()};` +
    `m.appendChild(it)});` +
    `document.body.appendChild(m);` +
    `var r=btn.getBoundingClientRect();` +
    // Pop down CENTERED on the trigger button (was left-aligned). Measured after
    // append so offsetWidth is live; clamp keeps the menu inside the viewport.
    `var mx=r.left+r.width/2-m.offsetWidth/2;` +
    `mx=Math.max(8,Math.min(mx,window.innerWidth-m.offsetWidth-8));` +
    `m.style.top=(r.bottom+4)+"px";m.style.left=mx+"px";` +
    `setTimeout(function(){` +
    `document.addEventListener("mousedown",outside,true);` +
    `document.addEventListener("keydown",escKey,true)},0)}` +
    `function sync(){` +
    `var id=sid();if(!id)return;` +
    `var m=MODES[id]||"screen";` +
    `var lbl=(m==="screen"?"Screen":"Buffer")+" ▾";` +
    `var mb=document.querySelector(".dl-mode");` +
    `if(mb&&mb.dataset.dlLabel!==lbl){` +
    `mb.dataset.dlLabel=lbl;` +
    `mb.innerText=lbl;` +
    `mb.title="Download source: "+(m==="screen"?"Screen (what the terminal shows)":"Buffer (raw byte stream)")+" — click to switch"}` +
    `var p=document.querySelector(".dl-plain");` +
    `if(p)p.title=m==="screen"?"Download: current screen (plain text)":"Download: full buffer (ANSI stripped)";` +
    `var w=document.querySelector(".dl-raw");` +
    `if(w)w.title=m==="screen"?"Download: current screen (with ANSI colors)":"Download: full buffer (raw, with ANSI)"}` +
    `function insert(){` +
    `var header=document.querySelector(".output-header");` +
    `var killBtn=document.querySelector(".kill-btn");` +
    `if(!header||!killBtn||header.querySelector(".dl-split"))return;` +
    `var split=document.createElement("div");` +
    `split.className="dl-split";split.setAttribute("role","group");split.setAttribute("aria-label","Download terminal log");` +
    `function mkBtn(cls,label){` +
    `var btn=document.createElement("button");` +
    `btn.type="button";btn.className="dl-part "+cls;` +
    `btn.innerText=label;` +
    `btn.onclick=function(){dl(cls)};` +
    `return btn}` +
    `split.appendChild(mkBtn("dl-plain","Download"));` +
    `split.appendChild(mkBtn("dl-raw","RAW"));` +
    `var modeBtn=document.createElement("button");` +
    `modeBtn.type="button";modeBtn.className="dl-part dl-mode";` +
    `modeBtn.onclick=function(ev){ev.stopPropagation();toggleMenu(modeBtn)};` +
    `split.appendChild(modeBtn);` +
    `header.insertBefore(split,killBtn);` +
    `sync()}` +
    `function boot(){` +
    `if(!document.body)return;` +
    `insert();` +
    `var obs=new MutationObserver(function(){insert();sync()});` +
    `obs.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["data-active-session"]});` +
    `}` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);` +
    `else boot();` +
    `})()` +
    `</script>`;
  return { text: text.replace("</head>", style + script + "</head>"), changed: true };
}

// Terminal size control (web UI): a bar below the terminal window with an
// "auto size | fixed size" segmented toggle and two textboxes (columns x rows).
//
//   * auto: the injected watcher keeps auto-fitting; the textboxes follow the
//     live size while the browser window resizes (read-only).
//   * fixed: pins the PTY to an explicit size. Toggling to fixed posts the
//     size-mode envelope with the CURRENT size (so server and page agree);
//     editing the textboxes then reveals Apply/Cancel — Apply posts the new
//     `PTYSZM:fixed,<cols>,<rows>` envelope (the backend resizes the ConPTY),
//     Cancel restores the pre-edit values.
//
// State lives on `window.__ptySizeMode` (sid -> "auto"|"fixed"; the resize
// watcher gates its fit on it), `window.__ptySizeNow` (sid -> live cols/rows,
// maintained by the watcher) and the control's own SRV/BASE maps synced from
// `GET /api/sessions` rows (which carry `sizeMode`/`cols`/`rows`). Agent-side
// changes (pty_spawn cols/rows, pty_size_set) are adopted by the 3s fetch loop.
//
// The bar doubles as the pane's statusbar: on every `paint()` the upstream
// `.debug-info` line ("<id>: N chars, WS raw_data: …, size: WxH" — relabeled
// by applyDebugRelabelToJs) is ADOPTED as the
// bar's last child (right-aligned via CSS), so it reads after the size edit
// controls. The physical reparent keeps React's node reference intact (its
// in-place text updates keep landing); moving it back never undoes adoption —
// the observer/paint re-adopts immediately (bar re-insert or pane re-render).
// Without the bar (`webUi.sizeControl: false`) the line stays untouched.
//
// The envelope separator is `String.fromCharCode(30)` — per the injected-source
// rule, no backslash escape sequences appear in the emitted script. Idempotent
// via the `data-pty-size-control` marker; tolerant of a missing `</head>`.
function applySizeModeBarToHtml(text) {
  if (!text.includes("</head>") || text.includes("data-pty-size-control")) {
    return { text, changed: false };
  }
  const style =
    `<style data-pty-size-control>` +
    // Sized above the pane; .debug-info is then adopted INTO the bar on paint().
    `.szctl{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:2px 12px 6px;` +
    `background:#161b22;border:1px solid #30363d;border-radius:8px;font-size:12px;color:#c9d1d9}` +
    `.szctl-label{color:#8b949e;user-select:none}` +
    `.szctl-seg{display:inline-flex;border:1px solid #30363d;border-radius:6px;overflow:hidden}` +
    `.szctl-seg-btn{padding:3px 10px;font-size:12px;line-height:1;background:#21262d;color:#8b949e;` +
    `border:none;cursor:pointer}` +
    `.szctl-seg-btn.szctl-on{background:#1f6feb;color:#fff}` +
    `.szctl-in{width:6ch;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;` +
    `padding:2px 6px;font-size:12px;line-height:1;text-align:right}` +
    `.szctl-in.szctl-bad{border-color:#da3633;color:#f85149}` +
    `.szctl-x{color:#8b949e;user-select:none}` +
    `input[type=number].szctl-in::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}` +
    `input[type=number].szctl-in{-moz-appearance:textfield;appearance:textfield}` +
    `.szctl-btn{padding:3px 10px;font-size:12px;line-height:1;border-radius:6px;border:1px solid #30363d;` +
    `background:#21262d;color:#c9d1d9;cursor:pointer}` +
    `.szctl-apply{background:#1f6feb;border-color:#1f6feb;color:#fff}` +
    // Adopted .debug-info: muted, right-aligned after the Apply/Cancel
    // controls. Selectable (no user-select:none — a user copy of the id or
    // size must work; DEBUG-SELECT FIX, user report).
    `.szctl .debug-info{margin-left:auto;color:#8b949e;font-size:12px;line-height:1.2;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}` +
    `.szctl[hidden]{display:none}` +
    `</style>`;
  const script =
    `<script data-pty-size-control>` +
    `(function(){` +
    `var SEP=String.fromCharCode(30);` +
    `var SRV={},SRVKNOWN={},BASE={};` +
    `function am(){return window.__ptySizeMode||(window.__ptySizeMode={})}` +
    `function nm(){return window.__ptySizeNow||(window.__ptySizeNow={})}` +
    `function sid(){var n=document.querySelector(".container[data-active-session]");` +
    `return n?n.dataset.activeSession:null}` +
    `function mode(id){var m=am()[id];return m==="fixed"?"fixed":"auto"}` +
    `function post(txt){var id=sid();if(!id)return;` +
    `try{fetch("/api/sessions/"+encodeURIComponent(id)+"/input",{method:"POST",` +
    `headers:{"Content-Type":"application/json"},` +
    `body:JSON.stringify({data:SEP+"PTYSZM:"+txt})})}catch(e){}}` +
    `function term(){return window.xtermTerminal||null}` +
    `function label(){var t=term();return t?{cols:t.cols,rows:t.rows}:{cols:null,rows:null}}` +
    `function goAuto(id){am()[id]="auto";delete BASE[id];post("auto");` +
    `if(window.__ptySendResize)try{window.__ptySendResize()}catch(e){}` +
    `paint()}` +
    `function goFixed(id,c,r){am()[id]="fixed";BASE[id]={cols:c,rows:r};` +
    `post("fixed,"+c+","+r);paint()}` +
    `function valid(n){return n>=1&&n<=1000}` +
    `function displayFixed(id){var t=term(),b=BASE[id];if(!t||!b)return;` +
    `if(valid(b.cols)&&valid(b.rows)&&(t.cols!==b.cols||t.rows!==b.rows))` +
    `try{t.resize(b.cols,b.rows)}catch(e){}}` +
    `function refreshServer(){` +
    `try{fetch("/api/sessions").then(function(r){return r.ok?r.json():null}).then(function(j){` +
    `if(!j)return;var rows=Array.isArray(j)?j:(j&&j.sessions)||[],i;` +
    `if(!Array.isArray(rows))return;` +
    `for(i=0;i<rows.length;i++){var s=rows[i];if(!s||!s.id)continue;` +
    `var mode=s.sizeMode==="fixed"?"fixed":"auto";` +
    `var c=typeof s.cols==="number"?s.cols:null;` +
    `var r=typeof s.rows==="number"?s.rows:null;` +
    `SRV[s.id]={mode:mode,cols:c,rows:r};` +
    `var k=SRVKNOWN[s.id];` +
    `if(!k||k.mode!==mode||k.cols!==c||k.rows!==r){` +
    `SRVKNOWN[s.id]={mode:mode,cols:c,rows:r};` +
    `am()[s.id]=mode;` +
    `if(mode==="fixed"&&valid(c)&&valid(r)){BASE[s.id]={cols:c,rows:r};` +
    `if(s.id===sid()){displayFixed(s.id);paint()}}}}}).catch(function(){})}catch(e){}}` +
    // Statusbar adoption: make the upstream .debug-info the bar's LAST child
    // (right-aligned by CSS). React keeps the same DOM node, so its per-poll
    // text updates continue to land after the move.
    `function hasEdits(id){var b=BASE[id];if(!b)return false;` +
    `var bar=document.querySelector(".szctl");` +
    `var c=parseInt(bar.querySelector(".szctl-cols").value,10);` +
    `var r=parseInt(bar.querySelector(".szctl-rows").value,10);` +
    `var cb=(c>=1&&c<=1000&&c!==b.cols),rb=(r>=1&&r<=1000&&r!==b.rows);` +
    `return cb||rb}` +
    `function adoptDebug(){` +
    `var barD=document.querySelector(".szctl");if(!barD)return;` +
    `var d=document.querySelector(".debug-info");if(!d)return;` +
    `if(d.parentElement!==barD)barD.appendChild(d)}` +
    `function paint(){` +
    `var bar=document.querySelector(".szctl");if(!bar)return;` +
    `var id=sid();` +
    `if(!id||!document.querySelector(".output-container")){bar.hidden=true;return}` +
    `bar.hidden=false;` +
    `adoptDebug();` +
    `if(bar.dataset.szId!==id){bar.dataset.szId=id}` +
    `var m=mode(id),auto=(m==="auto");` +
    `bar.querySelectorAll(".szctl-seg-btn").forEach(function(btn){` +
    `btn.classList.toggle("szctl-on",(btn.dataset.mode===m))});` +
    // FOLLOW-UP (found while verifying the tab fix): the auto branch never
    // touched Apply/Cancel visibility, so switching fixed->auto with pending
    // edits left the buttons visible forever (they do nothing in auto mode).
    // Auto has nothing to apply or cancel: always hide them here.
    `bar.querySelector(".szctl-apply").hidden=auto;` +
    `bar.querySelector(".szctl-cancel").hidden=auto;` +
    `var colsEl=bar.querySelector(".szctl-cols"),rowsEl=bar.querySelector(".szctl-rows");` +
    `colsEl.readOnly=auto;rowsEl.readOnly=auto;` +
    `if(auto){` +
    `var live=nm()[id]||label();` +
    `if(live.cols!=null&&colsEl.value!==String(live.cols))colsEl.value=live.cols;` +
    `if(live.rows!=null&&rowsEl.value!==String(live.rows))rowsEl.value=live.rows;` +
    `colsEl.classList.remove("szctl-bad");rowsEl.classList.remove("szctl-bad")}` +
    `else{` +
    `displayFixed(id);` +
    // TAB-TO-APPLY FIX (user report: tabbing from an editbox to Apply flashed
    // focus and hid the buttons): the old guard treated ONLY the two inputs
    // as focused, so the instant Tab moved focus to the Apply button, the next
    // 500 ms paint() saw "not focused", clobbered both edited values back to
    // BASE, made hasEdits() false and hid Apply/Cancel out from under the
    // focus. Guard the WHOLE bar instead: while focus is anywhere inside it
    // (inputs OR buttons), paint() must never overwrite the draft values —
    // hasEdits() stays true and the buttons stay visible. Outside focus (the
    // cancel button's own paint() call has document.activeElement === body)
    // the behave is the old one: values resnap, buttons hide.
    `var ae=document.activeElement;` +
    `var focused=!!(ae&&bar.contains(ae));` +
    `if(!focused){` +
    `var b=BASE[id];` +
    `if(b&&colsEl.value!==String(b.cols))colsEl.value=b.cols;` +
    `if(b&&rowsEl.value!==String(b.rows))rowsEl.value=b.rows}` +
    `var has=hasEdits(id);` +
    `bar.querySelector(".szctl-apply").hidden=!has;` +
    `bar.querySelector(".szctl-cancel").hidden=!has}}` +
    `function onEdit(){` +
    `var bar=document.querySelector(".szctl"),id=sid();` +
    `if(!bar||!id||mode(id)!=="fixed")return;` +
    `var cE=bar.querySelector(".szctl-cols"),rE=bar.querySelector(".szctl-rows");` +
    `var c=parseInt(cE.value,10),r=parseInt(rE.value,10);` +
    `cE.classList.toggle("szctl-bad",cE.value!==""&&!valid(c));` +
    `rE.classList.toggle("szctl-bad",rE.value!==""&&!valid(r));` +
    `var has=hasEdits(id);` +
    `bar.querySelector(".szctl-apply").hidden=!has;` +
    `bar.querySelector(".szctl-cancel").hidden=!has}` +
    `function onApply(){` +
    `var id=sid();if(!id||mode(id)!=="fixed")return;` +
    `var c=parseInt(document.querySelector(".szctl-cols").value,10);` +
    `var r=parseInt(document.querySelector(".szctl-rows").value,10);` +
    `if(!valid(c)||!valid(r))return;` +
    `goFixed(id,c,r)}` +
    `function insert(){` +
    `if(document.querySelector(".szctl"))return;` +
    `var cont=document.querySelector(".output-container");` +
    `if(!cont||!cont.parentElement)return;` +
    `var bar=document.createElement("div");bar.className="szctl";bar.hidden=true;` +
    `bar.setAttribute("role","group");bar.setAttribute("aria-label","Terminal size");` +
    `var lab=document.createElement("span");lab.className="szctl-label";lab.innerText="Size";` +
    `bar.appendChild(lab);` +
    `var seg=document.createElement("span");seg.className="szctl-seg";` +
    `[["auto","auto size"],["fixed","fixed size"]].forEach(function(p){` +
    `var btn=document.createElement("button");btn.type="button";` +
    `btn.className="szctl-seg-btn";btn.dataset.mode=p[0];btn.innerText=p[1];` +
    `btn.title=p[0]==="auto"` +
    `?"Viewer auto-fits the PTY to the window"` +
    `:"Pins the PTY to an explicit size";` +
    `btn.onclick=function(){var id=sid();if(!id)return;` +
    `var m=mode(id);if(p[0]===m)return;` +
    `if(p[0]==="auto")goAuto(id);` +
    `else{var n=nm()[id]||label()||{};var s=SRV[id]||{};` +
    `var c=valid(n.cols)?n.cols:(valid(s.cols)?s.cols:120);` +
    `var r=valid(n.rows)?n.rows:(valid(s.rows)?s.rows:40);` +
    `goFixed(id,c,r)}};` +
    `seg.appendChild(btn)});` +
    `bar.appendChild(seg);` +
    `var ci=document.createElement("input");ci.type="number";ci.min=1;ci.max=1000;` +
    `ci.className="szctl-in szctl-cols";ci.title="Columns (character cells per line)";` +
    `ci.autocomplete="off";` +
    `ci.addEventListener("input",onEdit);` +
    `bar.appendChild(ci);` +
    `var x=document.createElement("span");x.className="szctl-x";x.innerText="\u00d7";` +
    `bar.appendChild(x);` +
    `var ri=document.createElement("input");ri.type="number";ri.min=1;ri.max=1000;` +
    `ri.className="szctl-in szctl-rows";ri.title="Rows (text lines)";` +
    `ri.autocomplete="off";` +
    `ri.addEventListener("input",onEdit);` +
    `bar.appendChild(ri);` +
    `var ap=document.createElement("button");ap.type="button";` +
    `ap.className="szctl-btn szctl-apply";ap.innerText="Apply";ap.hidden=true;` +
    `ap.onclick=onApply;` +
    `bar.appendChild(ap);` +
    `var ca=document.createElement("button");ca.type="button";` +
    `ca.className="szctl-btn szctl-cancel";ca.innerText="Cancel";ca.hidden=true;` +
    `ca.onclick=function(){paint()};` +
    `bar.appendChild(ca);` +
    `cont.parentElement.insertBefore(bar,cont.nextSibling)}` +
    `function boot(){` +
    `if(!document.body)return;insert();refreshServer();paint();` +
    `var obs=new MutationObserver(function(){insert();paint()});` +
    // Hardened v62 (wedge fix): watch childList ONLY. The previous config also
    // watched `class`/`data-active-session` attribute changes, and attribute
    // mutations fed the observer from our own paint()/insert() writes — an
    // observer↔DOM ping-pong. The 500 ms interval already repaints the bar, so
    // losing attribute reactivity costs nothing.
    `obs.observe(document.body,{childList:true,subtree:true});` +
    `setInterval(function(){refreshServer();paint()},500)}` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);` +
    `else boot();` +
    `})()` +
    `</script>`;
  return { text: text.replace("</head>", style + script + "</head>"), changed: true };
}

// Frontend of webUi.spawnButton: a small, right-aligned `+` button inside the
// `.sidebar-header` (flex layout applied via CSS) of the web UI. Clicking it
// opens a popup to spawn a NEW PTY session:
//   * Session dropdown: GLOBAL pinned first, then the opencode conversations
//     (root sessions only) as `title` + small dim `ses_<id>`, fetched from
//     GET /api/opencode-sessions (rows carry a best-effort `directory`). The
//     dropdown starts CLOSED; it re-renders on a 1.5 s interval while the
//     popup is open, so sessions started elsewhere appear live. A dim ▾ arrow
//   * Command entry (free text; split shell-word style SERVER side, see
//     splitShellWords) + optional workdir; Create POSTs the popup's body to
//     POST /api/pty-extended/sessions, which spawns and announces (see
//     createWebApiHandlers).
// Auto-behavior on open: with zero opencode sessions the command field is
// focused (GLOBAL is the only choice); with exactly one session it is
// pre-selected and the command field focused; with 2+ sessions nothing is
// focused. The workdir placeholder follows the selection (GLOBAL = user home,
// session = the conversation's project directory) and is submitted when the
// field is left empty.
// The popup closes via the × button, Escape, or an outside mousedown; command
// and workdir values survive close/reopen. The listener style follows the
// hardened size-bar pattern: childList/subtree MutationObserver ONLY (the
// 500-poll habits of attribute watchers caused the v60 wedge).
//
// Post-spawn/select: the script polls for the sidebar card whose React fiber
// key equals the new id and clicks it (≤ 12 tries × 300 ms), falling back to a
// `?session=<id>` navigation which the select-session bundle patch honors at
// boot; a found card is followed by focusing the xterm shell. Clicking any
// `.session-item` card also focuses the xterm shell (kill buttons excluded).
//
// NB: the injected script runs in <head>, where document.body is still null —
// DOM work must happen inside boot() (at/after DOMContentLoaded). Injected
// source avoids ALL backslash escapes (use String.fromCharCode) so
// template-literal escaping can never corrupt it.
function applyPlusSpawnToHtml(text, { defaultCommand, homeDir, defaultNotifyOnExit } = {}) {
  if (!text.includes("</head>") || text.includes("data-pty-spawn-button")) {
    return { text, changed: false };
  }
  const defCommand =
    typeof defaultCommand === "string" && defaultCommand
      ? defaultCommand
      : defaultSpawnCommand();
  const homeStr = typeof homeDir === "string" ? homeDir : "";
  // Bake the user home for the injected script WITHOUT emitting a single
  // backslash character: a Windows path becomes an array of segments joined
  // with String.fromCharCode(92) at runtime (posix paths join on "/").
  const homeParts = homeStr
    ? "[" +
      homeStr
        .split(/[\\/]/)
        .map((s) => JSON.stringify(s))
        .join(",") +
      "]"
    : "[]";
  const homeSep = homeStr.includes("\\") ? "String.fromCharCode(92)" : '"/"';
  const style =
    `<style data-pty-spawn-button>` +
    `.sidebar-header{display:flex;align-items:center;justify-content:space-between}` +
    `.spw-open{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;width:26px;height:26px;flex:0 0 auto;font-size:15px;line-height:1;font-weight:600;cursor:pointer;margin-left:8px}` +
    `.spw-open:hover{background:#30363d;border-color:#58a6ff}` +
    `.spw-pop{position:fixed;z-index:1000;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px;width:330px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:6px}` +
    `.spw-pop[hidden]{display:none}` +
    `.spw-head{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;color:#58a6ff}` +
    `.spw-close{background:transparent;border:0;color:#8b949e;cursor:pointer;font-size:14px;padding:0 2px;line-height:1}` +
    `.spw-close:hover{color:#fff}` +
    `.spw-label{font-size:11px;color:#8b949e}` +
    `.spw-select{position:relative}` +
    `.spw-sel{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;cursor:pointer;text-align:left}` +
    `.spw-sel:hover{border-color:#58a6ff}` +
    `.spw-sel-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
    `.spw-sel-none{color:#58a6ff;font-weight:600}` +
    `.spw-sel-hint{color:#8b949e;font-size:11px}` +
    `.spw-sel-id{color:#8b949e;font-size:11px;flex:0 0 auto}` +
    `.spw-sel-arrow{color:#8b949e;font-size:22px;flex:0 0 auto;line-height:1}` +
    `.spw-list{position:absolute;top:calc(100% + 3px);left:0;right:0;max-height:200px;overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:6px;z-index:1001;box-shadow:0 8px 24px rgba(0,0,0,.5)}` +
    `.spw-list[hidden]{display:none}` +
    `.spw-item{display:flex;align-items:baseline;gap:8px;padding:6px 8px;cursor:pointer;font-size:12px;color:#c9d1d9}` +
    `.spw-item:hover{background:#30363d}` +
    `.spw-item.spw-on{background:#21262d}` +
    `.spw-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
    `.spw-in{background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 8px;font-size:12px;width:100%}` +
    `.spw-in:focus{outline:none;border-color:#58a6ff}` +
    `.spw-foot{display:flex;align-items:center;gap:8px}` +
    `.spw-nx{display:flex;align-items:center;gap:5px;color:#8b949e;font-size:11px;cursor:pointer;flex:0 0 auto}` +
    `.spw-nx:hover{color:#c9d1d9}` +
    `.spw-nx input{accent-color:#58a6ff;margin:0}` +
    `.spw-err{color:#f85149;font-size:11px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` +
    `.spw-create{background:#238636;color:#fff;border:0;border-radius:6px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer}` +
    `.spw-create:hover{background:#2ea043}` +
    `.spw-create[disabled]{opacity:.6;cursor:default}` +
    `</style>`;
  const script =
    `<script data-pty-spawn-button>` +
    `(function(){` +
    `var pop=null,sel=null,selBtn=null,selList=null,cmd=null,wd=null,nx=null,err=null,createB=null,openB=null,current="",cache=[],timer=null,autoDone=false;` +
    `var CANCEL=String.fromCharCode(215);` +
    `var DEF=${JSON.stringify(defCommand)};` +
    // Initial notify-on-exit toggle state: the effective pty_spawn tool default
    // (argDefaults.pty_spawn.notifyOnExit, built in Plugin.setup and threaded
    // through applyStaticTransforms).
    `var DEFNX=${JSON.stringify(defaultNotifyOnExit !== false)};` +
    `var HOME=${homeParts}.join(${homeSep});` +
    // Presence (web-UI source): sessions opened via the + picker are stamped
    // into `window.__ptyPresenceIds` and a 45 s heartbeat POSTs them to
    // /api/opencode-presence while the page stays open (page closed -> stamps
    // staled -> the session leaves the live-only dropdown).
    `function ptyStampPresence(){` +
    `try{var w=window;if(!w.__ptyPresenceIds)w.__ptyPresenceIds=new Set();` +
    `if(current)w.__ptyPresenceIds.add(current)}catch(e){}}` +
    `function ptyPresenceHeartbeat(){` +
    `try{var w=window;var s=w.__ptyPresenceIds;` +
    `if(!s||!s.size)return;var ids=[];s.forEach(function(v){ids.push(v)});` +
    `fetch("/api/opencode-presence",{method:"POST",headers:{"content-type":"application/json"},` +
    `body:JSON.stringify({ids:ids})}).catch(function(){})}catch(e){}}` +
    `try{window.setInterval(ptyPresenceHeartbeat,45000)}catch(e){}` +
    `function boot(){` +
    `if(!document.body)return;` +
    `insert();` +
    `document.addEventListener("click",cardFocus,true);` +
    `var obs=new MutationObserver(function(){insert()});` +
    `obs.observe(document.body,{childList:true,subtree:true})}` +
    `function focusTTY(tries){` +
    `if(tries<=0)return;` +
    `var ta=document.querySelector(".terminal .xterm-helper-textarea, .terminal textarea, .xterm-helper-textarea");` +
    `if(ta){ta.focus();return}` +
    `window.setTimeout(function(){focusTTY(tries-1)},200)}` +
    `function cardFocus(ev){` +
    `if(!ev||!ev.target||!ev.target.closest)return;` +
    `var card=ev.target.closest(".session-item");` +
    `if(!card)return;` +
    `if(ev.target.closest(".kill-btn")||ev.target.closest(".session-close"))return;` +
    `focusTTY(8)}` +
    `function insert(){` +
    `var h=document.querySelector(".sidebar-header");if(!h)return;` +
    `if(h.querySelector(".spw-open"))return;` +
    `var b=document.createElement("button");` +
    `b.type="button";b.className="spw-open";` +
    `b.setAttribute("aria-label","Spawn a new PTY session");` +
    `b.textContent=String.fromCharCode(43);` +
    `b.onclick=function(ev){ev.stopPropagation();toggle()};` +
    `h.appendChild(b);openB=b}` +
    `function build(){` +
    `if(pop)return;` +
    `pop=document.createElement("div");pop.className="spw-pop";pop.hidden=true;` +
    `var head=document.createElement("div");head.className="spw-head";` +
    `var t=document.createElement("span");t.textContent="New PTY session";head.appendChild(t);` +
    `var x=document.createElement("button");x.type="button";x.className="spw-close";` +
    `x.setAttribute("aria-label","Close");` +
    `x.textContent=CANCEL;x.onclick=function(ev){ev.stopPropagation();close()};head.appendChild(x);` +
    `pop.appendChild(head);` +
    `var ls=document.createElement("div");ls.className="spw-label";ls.textContent="Session";pop.appendChild(ls);` +
    `sel=document.createElement("div");sel.className="spw-select";` +
    `selBtn=document.createElement("button");selBtn.type="button";selBtn.className="spw-sel";` +
    `selBtn.onclick=function(ev){ev.stopPropagation();toggleList()};sel.appendChild(selBtn);` +
    `selList=document.createElement("div");selList.className="spw-list";selList.hidden=true;` +
    `sel.appendChild(selList);pop.appendChild(sel);` +
    `var lc=document.createElement("div");lc.className="spw-label";lc.textContent="Command";pop.appendChild(lc);` +
    `cmd=document.createElement("input");cmd.className="spw-in";cmd.placeholder=DEF;` +
    `cmd.autocomplete="off";` +
    `cmd.onkeydown=function(ev){if(ev.key==="Enter"){ev.preventDefault();submit()}};` +
    `pop.appendChild(cmd);` +
    `var lw=document.createElement("div");lw.className="spw-label";lw.textContent="Workdir";pop.appendChild(lw);` +
    `wd=document.createElement("input");wd.className="spw-in";wd.placeholder="";` +
    `wd.autocomplete="off";wd.onkeydown=cmd.onkeydown;` +
    `pop.appendChild(wd);` +
    `var foot=document.createElement("div");foot.className="spw-foot";` +
    // Bottom-left: notify-on-exit toggle (initial state from config, co-clicks
    // stay silent). The error span keeps flex:1 so Create stays bottom-right.
    `nx=document.createElement("input");nx.type="checkbox";nx.checked=DEFNX;` +
    `var nxl=document.createElement("label");nxl.className="spw-nx";` +
    `nxl.title="Post a <pty_exited> notice to the conversation when this PTY exits";` +
    `nxl.appendChild(nx);` +
    `var nxt=document.createElement("span");nxt.textContent="Notify on exit";nxl.appendChild(nxt);` +
    `foot.appendChild(nxl);` +
    `err=document.createElement("span");err.className="spw-err";foot.appendChild(err);` +
    `createB=document.createElement("button");createB.type="button";createB.className="spw-create";` +
    `createB.textContent="Create";createB.onclick=function(ev){ev.stopPropagation();submit()};foot.appendChild(createB);` +
    `pop.appendChild(foot);` +
    `document.body.appendChild(pop);` +
    `document.addEventListener("mousedown",outside,true);` +
    `document.addEventListener("keydown",keys,true)}` +
    `function toggle(){if(pop&&!pop.hidden){close()}else{open()}}` +
    `function toggleList(){if(!selList)return;if(selList.hidden){renderList();selList.hidden=false}else{selList.hidden=true}}` +
    `function curWdDefault(){` +
    `if(current){` +
    `for(var i=0;i<cache.length;i++){var r=cache[i];` +
    `if(r&&r.id===current&&typeof r.directory==="string"&&r.directory)return r.directory}` +
    `return ""}` +
    `return HOME}` +
    `function paintWd(){` +
    `if(!wd)return;` +
    `var d=curWdDefault();` +
    `wd.placeholder=d?d:""}` +
    `function pick(row){` +
    `current=row&&row.id?row.id:"";` +
    `ptyStampPresence();` +
    `paintSel();paintWd();` +
    `if(selList)selList.hidden=true}` +
    `function labelOf(id){` +
    `for(var i=0;i<cache.length;i++){if(cache[i]&&cache[i].id===id)return String((cache[i]&&cache[i].title)||"")||id}` +
    `return id}` +
    `function paintSel(){` +
    `if(!selBtn)return;` +
    `while(selBtn.firstChild)selBtn.removeChild(selBtn.firstChild);` +
    `if(!current){` +
    `var g=document.createElement("span");g.textContent="GLOBAL";g.className="spw-sel-title spw-sel-none";` +
    `var h=document.createElement("span");h.textContent="(all sessions)";h.className="spw-sel-hint";` +
    `selBtn.appendChild(g);selBtn.appendChild(h)}else{` +
    `var tt=document.createElement("span");tt.textContent=labelOf(current);tt.className="spw-sel-title";` +
    `var id=document.createElement("span");id.textContent=current;id.className="spw-sel-id";` +
    `selBtn.appendChild(tt);selBtn.appendChild(id)}` +
    `var ar=document.createElement("span");ar.textContent=String.fromCharCode(9662);ar.className="spw-sel-arrow";` +
    `selBtn.appendChild(ar)}` +
    `function refresh(){` +
    `return fetch("/api/opencode-sessions").then(function(r){if(!r.ok)throw 0;return r.json()})` +
    `.then(function(j){cache=Array.isArray(j)?j:[];renderList()})` +
    `.catch(function(){cache=[];renderList()})}` +
    `function renderList(){` +
    `while(selList.firstChild)selList.removeChild(selList.firstChild);` +
    `var g=document.createElement("div");g.className="spw-item"+(current?"":" spw-on");` +
    `var gt=document.createElement("span");gt.textContent="GLOBAL (all sessions)";gt.className="spw-sel-title";` +
    `g.appendChild(gt);` +
    `g.onclick=function(ev){ev.stopPropagation();pick(null)};` +
    `selList.appendChild(g);` +
    `for(var i=0;i<cache.length;i++){` +
    `(function(row){` +
    `if(!row||typeof row.id!=="string"||!row.id)return;` +
    `var it=document.createElement("div");it.className="spw-item"+(current===row.id?" spw-on":"");` +
    `var tt=document.createElement("span");tt.textContent=row.title||row.id;tt.className="spw-sel-title spw-grow";` +
    `var id=document.createElement("span");id.textContent=row.id;id.className="spw-sel-id";` +
    `it.appendChild(tt);it.appendChild(id);` +
    `it.onclick=function(ev){ev.stopPropagation();pick(row)};` +
    `selList.appendChild(it);})(cache[i])}` +
    // renderList NEVER touches selList.hidden: the dropdown only opens via
    // toggleList (a user click), never automatically from open()/refresh().
    `}` +
    `function applyAuto(){` +
    `if(autoDone)return;autoDone=true;` +
    `if(pop&&pop.hidden)return;` +
    `if(current)return;` +
    `var valid=[];` +
    `for(var i=0;i<cache.length;i++){var r=cache[i];` +
    `if(r&&typeof r.id==="string"&&r.id)valid.push(r)}` +
    `if(valid.length===1){current=valid[0].id;paintSel();paintWd()}` +
    `if((valid.length===0||valid.length===1)&&cmd){try{cmd.focus()}catch(e0){}}}` +
    `function open(){` +
    `build();` +
    `if(openB){` +
    `var r=openB.getBoundingClientRect();var w=346;` +
    `pop.style.left=Math.max(8,Math.min(r.left,(window.innerWidth||1200)-w-8))+"px";` +
    `pop.style.top=(r.bottom+6)+"px"}` +
    `err.textContent="";` +
    `paintSel();paintWd();` +
    `autoDone=false;` +
    `refresh().then(function(){applyAuto()});` +
    `if(timer)window.clearInterval(timer);` +
    `timer=window.setInterval(function(){refresh()},1500);` +
    `pop.hidden=false}` +
    `function close(){` +
    `if(timer){window.clearInterval(timer);timer=null}` +
    `if(selList)selList.hidden=true;` +
    `if(pop)pop.hidden=true}` +
    `function outside(ev){` +
    `if(!pop||pop.hidden)return;` +
    `if(pop.contains(ev.target))return;` +
    `if(ev.target&&ev.target.closest&&ev.target.closest(".spw-open"))return;` +
    `close()}` +
    `function keys(ev){` +
    `if(!pop||pop.hidden)return;` +
    `if(ev.key==="Escape"){ev.stopPropagation();close()}}` +
    `function fiberKeyOf(el){` +
    `var ks=Object.keys(el||{});` +
    `for(var i=0;i<ks.length;i++){` +
    `if(ks[i].indexOf("__reactFiber")===0){` +
    `var f=el[ks[i]];` +
    `if(f)return String(f.key||"")}}` +
    `return ""}` +
    `function selectCard(id){` +
    `var cards=document.querySelectorAll(".session-item");` +
    `for(var i=0;i<cards.length;i++){` +
    `var c=cards[i];` +
    `var n=c;` +
    `while(n&&n!==document.body){` +
    `if(fiberKeyOf(n)===id){c.click();return true}` +
    `n=n.parentElement}}` +
    `return false}` +
    `function trySelect(id,tries){` +
    `if(tries<=0){` +
    `window.location.replace(window.location.pathname+"?session="+id);` +
    `return}` +
    `window.setTimeout(function(){` +
    `if(selectCard(id)){focusTTY(8);return}` +
    `trySelect(id,tries-1)},300)}` +
    `function submit(){` +
    `if(!createB)return;` +
    `var command=cmd.value.trim()||DEF;` +
    `if(!command){err.textContent="Command is required";return}` +
    `var body={};body.command=command;` +
    `if(current)body.parentSessionId=current;` +
    `body.notifyOnExit=!!(nx&&nx.checked);` +
    `var w=wd.value.trim()||curWdDefault();if(w)body.workdir=w;` +
    `createB.disabled=true;err.textContent="";` +
    `fetch("/api/pty-extended/sessions",{` +
    `method:"POST",` +
    `headers:{"Content-Type":"application/json"},` +
    `body:JSON.stringify(body)})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j,status:r.status}})})` +
    `.then(function(res){createB.disabled=false;` +
    `if(!res.ok){err.textContent=String((res.j&&res.j.error)||("HTTP "+res.status));return}` +
    `close();` +
    `if(res.j&&res.j.id)trySelect(String(res.j.id),12)})` +
    `.catch(function(){createB.disabled=false;err.textContent="Spawn failed"})}` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);` +
    `else boot();` +
    `})()` +
    `</script>`;
  return { text: text.replace("</head>", style + script + "</head>"), changed: true };
}
// the patched sidebar, see applyGroupBySessionToJs) and the group-header CSS,
// injected into `dist/web/index.html` near `</head>`. `mode` is `"session"` or
// `"agent"` and is baked in (the injected script cannot see the plugin config).
//
// `__ptyGroup(list, h, item)` receives the sessions array, the bundle's jsx
// runtime (`h`) and the per-session item renderer, and returns a flat React
// element array: parentless sessions first (ungrouped), then, for each opencode
// conversation in first-appearance order, a header (title · id · count)
// followed by its sessions. The header's title falls back to "Session" when the
// opencode title could not be resolved.
//
// In `"agent"` mode each conversation's PTYs are additionally sub-grouped by the
// sub-session (`subagentSessionId`) that spawned them: PTYs spawned directly by
// the conversation appear first (no sub-header), then one sub-header per
// subagent followed by its PTYs. A PTY with no `subagentSessionId` (direct child
// or an unresolved lineage) stays under the conversation header.
//
// Idempotent (a second pass sees the marker) and tolerant (missing `</head>`
// leaves the text untouched).
function applyGroupBySessionToHtml(text, mode, { confirm } = {}) {
  if (!text.includes("</head>") || text.includes("data-pty-group-by-session")) {
    return { text, changed: false };
  }
  const agent = mode === "agent";
  const script =
    `<script data-pty-group-by-session>` +
    `window.__ptyGroup=function(list,h,item){` +
    `var MODE=${JSON.stringify(agent ? "agent" : "session")};` +
    `var CONFIRM=${JSON.stringify(confirm !== false)};` +
    `var NL=String.fromCharCode(10);` +
    `var ungrouped=[],groups=[],byKey=Object.create(null);` +
    `for(var i=0;i<list.length;i++){` +
    `var s=list[i],k=s&&s.groupSessionId;` +
    `if(!k){ungrouped.push(s);continue}` +
    `var g=byKey[k];if(!g){g=byKey[k]={id:k,title:(s.groupSessionTitle||""),items:[]};groups.push(g)}` +
    `g.items.push(s)}` +
    `function groupClose(ev,items,title){` +
    `if(ev&&ev.stopPropagation)ev.stopPropagation();` +
    `var ids=[],a;` +
    `for(a=0;a<items.length;a++){var v0=items[a];if(v0&&v0.id)ids.push(v0.id)}` +
    `if(!ids.length)return;` +
    `var cards=[],root=ev&&ev.target&&ev.target.closest?` +
    `ev.target.closest(".session-group")||ev.target.closest(".session-subgroup"):null;` +
    `if(root){` +
    `var n=root.nextElementSibling;` +
    `while(n&&!n.classList.contains("session-group")){` +
    `if(n.classList.contains("session-item"))cards.push(n);` +
    `else if(n.classList.contains("session-subgroup-wrap")){` +
    `for(var s2=0;s2<n.children.length;s2++){var w2=n.children[s2];` +
    `if(w2.classList&&w2.classList.contains("session-subgroup-children")){` +
    `for(var c2=0;c2<w2.children.length;c2++)cards.push(w2.children[c2])}}}` +
    `else if(n.classList.contains("session-subgroup-children")){` +
    `for(var c=0;c<n.children.length;c++)cards.push(n.children[c])}` +
    `n=n.nextElementSibling;` +
    `}}` +
    `for(var r=0;r<cards.length;r++)cards[r].classList.add("session-closing");` +
    `var msg="Kill and remove "+ids.length+" PTY session(s)"+(title?" of "+title:"")+"?";` +
    `var lines=[msg];` +
    `for(var d=0;d<ids.length&&d<5;d++){var t2=items[d];` +
    `var ty=(t2&&(t2.title||""))||"?(no title)";` +
    `var pp=(t2&&typeof t2.pid==="number"&&t2.pid>0)?"PID "+t2.pid:"id "+ids[d];` +
    `lines.push("- "+ty+" ("+pp+")");}` +
    `if(ids.length>5)lines.push("... and "+(ids.length-5)+" more");` +
    `if(CONFIRM&&!window.confirm(lines.join(NL))){` +
    `for(var u=0;u<cards.length;u++)cards[u].classList.remove("session-closing");` +
    `return}` +
    `var K=window.__ptyClosed||(window.__ptyClosed=new Set());` +
    `var bad=0,done=0;` +
    `var ungrayAll=function(){for(var w=0;w<cards.length;w++){var el=cards[w];` +
    `if(el.isConnected)el.classList.remove("session-closing")}};` +
    `var step=function(pid,ok){done++;` +
    `if(ok)K.add(pid);else{K.delete(pid);bad++}` +
    `if(done===ids.length&&bad)ungrayAll()};` +
    `for(var f=0;f<ids.length;f++){(function(pid){` +
    `fetch("/api/sessions/"+encodeURIComponent(pid)+"/cleanup",{method:"DELETE"})` +
    `.then(function(r){step(pid,!!r.ok)})` +
    `.catch(function(){step(pid,false)})})(ids[f])}` +
    `}` +
    `function head(cls,id,title,count,key,items){` +
    `var kids=[` +
    `h.jsx("div",{className:cls+"-title",children:title||"Session"}),` +
    `h.jsxs("div",{className:cls+"-meta",children:[` +
    `h.jsx("span",{className:cls+"-id",children:id}),` +
    `h.jsx("span",{className:cls+"-count",children:count+" PTY"+(count===1?"":"s")})` +
    `]})];` +
    `if(items&&items.length)kids.push(h.jsx("span",` +
    `{className:"session-close session-close-group",` +
    `title:"Kill and remove "+items.length+" PTY session(s)",` +
    `onClick:function(ev){groupClose(ev,items,title||id)},children:"\\u00d7"}` +
    `,"close"+key));` +
    `return h.jsxs("div",{className:cls,children:kids},key)}` +
    `var out=[];` +
    `for(var j=0;j<ungrouped.length;j++)out.push(item(ungrouped[j]));` +
    `for(var m=0;m<groups.length;m++){var grp=groups[m];` +
    `out.push(head("session-group",grp.id,grp.title,grp.items.length,"grp_"+grp.id,grp.items));` +
    `if(MODE!=="agent"){for(var n=0;n<grp.items.length;n++)out.push(item(grp.items[n]));continue}` +
    `var direct=[],subs=[],subByKey=Object.create(null);` +
    `for(var q=0;q<grp.items.length;q++){var it=grp.items[q],sid=it&&it.subagentSessionId;` +
    `if(!sid){direct.push(it);continue}` +
    `var sb=subByKey[sid];if(!sb){sb=subByKey[sid]={id:sid,title:(it.subagentSessionTitle||""),items:[]};subs.push(sb)}` +
    `sb.items.push(it)}` +
    `for(var d=0;d<direct.length;d++)out.push(item(direct[d]));` +
    `for(var p=0;p<subs.length;p++){var sub=subs[p];` +
    `out.push(h.jsx("div",{className:"session-subgroup-wrap",children:[` +
    `head("session-subgroup",sub.id,sub.title,sub.items.length,"sub_"+sub.id,sub.items),` +
    `h.jsx("div",{className:"session-subgroup-children",children:sub.items.map(function(s){return item(s);})})` +
    `]},"wrap_"+sub.id))}` +
    `}` +
    `return out};` +
    `</script>`;
  const style =
    `<style data-pty-group-by-session>` +
    `.session-group{padding:10px 0 4px;margin-top:4px;border-top:1px solid #21262d;` +
    `font-size:11px;letter-spacing:.04em;color:#8b949e}` +
    `.session-group-title{font-weight:600;color:#c9d1d9;overflow:hidden;` +
    `text-overflow:ellipsis;white-space:nowrap}` +
    `.session-group-meta{display:flex;align-items:baseline;` +
    `justify-content:space-between;gap:8px;margin-top:2px}` +
    `.session-group-id{font-family:monospace;font-size:10px;color:#6e7681;` +
    `overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
    `.session-group-count{color:#6e7681;white-space:nowrap}` +
    `.session-subgroup-wrap{margin-left:4px;padding-left:8px}` +
    `.session-subgroup{padding:6px 0 2px;margin-top:2px;` +
    `font-size:10px;letter-spacing:.04em;color:#6e7681}` +
    `.session-subgroup-title{font-weight:500;color:#8b949e;overflow:hidden;` +
    `text-overflow:ellipsis;white-space:nowrap}` +
    `.session-subgroup-meta{display:flex;align-items:baseline;` +
    `justify-content:space-between;gap:8px;margin-top:1px}` +
    `.session-subgroup-id{font-family:monospace;font-size:9px;color:#6e7681;` +
    `overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
    `.session-subgroup-count{color:#6e7681;white-space:nowrap}` +
    `.session-subgroup-children{padding-left:0}` +
    // Group × positioning: vertically centered on the header's title line
    // (title starts at the 10px/6px top padding through an 11px/10px font
    // -> glyph+circle center at ~17px/~12px -> top 8px/4px for a 16px circle).
    // `padding:0` cancels the base card-x glyph shift. The ring is visible
    // before hover (subtle dark fill + border) like the card x's circle.
    `.session-group{position:relative}` +
    `.session-subgroup{position:relative}` +
    `.session-group-title,.session-subgroup-title{padding-right:20px}` +
    `.session-group .session-close,.session-subgroup .session-close{` +
    `position:absolute;top:8px;right:0;width:16px;height:16px;font-size:14px;` +
    `color:#8b949e;background:#161b22;border-color:#30363d;opacity:.8}` +
    `.session-subgroup .session-close{top:4px}` +
    // The very first group header: no separator line, no extra spacing above
    // (per user spec; the negative margin compensates for the ×-bearing
    // padding band).
    `.session-group:first-of-type{border-top:unset;margin-top:-10px}` +
    `.session-group .session-close:hover,.session-subgroup .session-close:hover{` +
    `color:#fff;background:#da3633;border-color:#da3633;opacity:1}` +
    `</style>`;
  return { text: text.replace("</head>", style + script + "</head>"), changed: true };
}

// cached class can tell an up-to-date wrapper from a stale one.
const PATCH_VERSION = 92;

// Replaces `PTYServer.createServer` so the static routes are transformed before
// the Bun server is constructed. The package module (and therefore the class)
// can be cached across plugin hot reloads, so this always reinstalls the wrapper
// (with the current transform implementation) rather than keeping a stale one.
function installCreateServerPatch({ PTYServer, buildStaticRoutes }, transforms) {
  if (!PTYServer || typeof buildStaticRoutes !== "function") {
    const wants =
      transforms?.terminalFont?.enabled !== false ||
      transforms?.webUi?.viewerResize?.enabled !== false ||
      transforms?.webUi != null;
    if (wants) {
      console.warn("[opencode-pty-extended] server internals unavailable; static-route transforms ignored");
    }
    return;
  }

  // Live build/transform functions + options, reachable from the (possibly
  // cached) patched function.
  const state = (PTYServer.__opencodePtyLocalState ??= { seen: 0 });
  state.seen = (state.seen ?? 0) + 1;
  state.buildStaticRoutes = buildStaticRoutes;
  state.apply = applyStaticTransforms;
  state.transforms = transforms;
  state.version = PATCH_VERSION;

  const patched = async function createServer(options) {
    const staticRoutes = await state.buildStaticRoutes();
    await state.apply(staticRoutes, state.transforms);
    const server = new PTYServer(staticRoutes, options);
    // Stamped so a live server left over from an earlier wrapper (or config)
    // can be detected and recycled; see the `setup` and `openWeb` checks.
    server.__opencodePtyLocalPatched = true;
    server.__opencodePtyLocalSignature = state.transforms?.signature ?? "";
    return server;
  };
  patched.__opencodePtyLocalPatched = true;
  patched.__opencodePtyLocalVersion = PATCH_VERSION;
  PTYServer.createServer = patched;
}

// ---------------------------------------------------------------------------
// Web-UI `+` spawn button: wrapper-owned JSON routes (server side)
// ---------------------------------------------------------------------------
// The web-UI header's `+` button (applyPlusSpawnToHtml) needs two things the
// upstream server does not provide:
//
//   1. GET /api/opencode-sessions — the opencode conversations for the spawn
//      popup's session dropdown (root sessions only; subagents excluded).
//   2. POST /api/pty-extended/sessions — spawn a PTY, optionally bound to one
//      of those conversations (`parentSessionId`), and ANNOUNCE the new PTY in
//      the target conversation's chat via `ctx.session.prompt` (a global spawn
//      announces to every open root conversation when
//      `notify.announceWebSpawn` is not false).
//
// Both are injected as plain function handlers into `staticRoutes` inside the
// patched `createServer` (Bun routes accept a function to serve every method
// of the path; `applyStaticTransforms` skips non-Response entries safely). The
// upstream `POST /api/sessions` route is left untouched — hardcoding there
// would have to override Bun.serve's spread order, which is unreliable; the
// wrapper-owned paths carry the spawn semantics instead (the UI never posts to
// the upstream route).
//
// The popup sends the command as free text (`command`), split shell-word style
// HERE so quoting stays simple. A session-bound spawn goes through the same
// `manager.spawn` choke point as the `pty_spawn` tool, so lineage grouping /
// notifyTarget stamping apply unchanged (`installManagerSessionLineage`); a
// global spawn passes `parentSessionId: GROUP_WEB_API_PARENT` ("web-api") and
// stays ungrouped, like upstream's own web-API spawns.
function splitShellWords(input) {
  const tokens = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) return null; // unterminated quote: refuse rather than mis-split
  if (cur) tokens.push(cur);
  return tokens;
}

function jsonResp(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Root (non-subagent) opencode conversations, for the dropdown and the global
// announcement list. `ctx.data.session.list()` entries carry `parentID` —
// subagent sessions are child sessions. Best-effort: an unavailable store
// yields an empty list (the dropdown degrades to GLOBAL only).
function listRootSessions(ctx) {
  let rows;
  try {
    const result = ctx?.data?.session?.list?.();
    if (Array.isArray(result)) rows = result;
    else if (Array.isArray(result?.data)) rows = result.data;
  } catch {
    rows = undefined;
  }
  if (!Array.isArray(rows)) return [];
  const roots = [];
  for (const entry of rows) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    if (typeof entry.parentID === "string" && entry.parentID) continue;
    roots.push(entry);
  }
  return roots;
}

// ASYNC session listing for the plugin-setup context: `ctx.data.session.list()`
// works in TOOL contexts but can be missing/empty in the setup ctx (live-verified
// v70: GET /api/opencode-sessions returned [] while grouping still worked).
// This chain probes, in order: `ctx.session.list()` (if the ctx exposes it),
// the SDK client (`ctx.client.session.list()` -> { data: [...] } or [...]),
// and finally the sync `listRootSessions` walk (works when a data store IS
// present, e.g. tool contexts). Normalizes entries to
// `{ id, title, parent, raw }` and filters to ROOT sessions.
async function opencodeSessionRows(ctx) {
  const normalize = (e) => {
    const id = typeof e?.id === "string" ? e.id : "";
    if (!id) return null;
    const parent =
      typeof e?.parentID === "string" ? e.parentID :
      typeof e?.parentId === "string" ? e.parentId : "";
    const title = typeof e?.title === "string" ? e.title : "";
    return { id, title, parent, raw: e };
  };
  let raw = null;
  try {
    const listFn = ctx?.session?.list;
    if (typeof listFn === "function") raw = await listFn.call(ctx.session);
  } catch {
    raw = null;
  }
  if (!raw) {
    try {
      const listFn = ctx?.client?.session?.list;
      if (typeof listFn === "function") {
        const result = await listFn.call(ctx.client.session);
        raw = result?.data ?? result;
      }
    } catch {
      raw = null;
    }
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
  const tuples = Array.isArray(arr)
    ? arr.map(normalize).filter(Boolean)
    : listRootSessions(ctx)
        .map(normalize)
        .filter(Boolean);
  return tuples.filter((t) => !t.parent);
}

// The `<pty_spawned>`-shaped block written into the target chat, mirroring the
// pty_spawn tool result. Provenance follows the same lineage scheme as the
// tool-spawned block: `Initiator Session` names the origin ("PTY web UI"),
// `Root Session` the owning root conversation id — or `global` when the spawn
// was not parked on any session.
function buildWebSpawnAnnouncement(info, rootId, notifyOnExit) {
  return [
    "<pty_spawned>",
    `ID: ${info?.id ?? ""}`,
    `Title: ${info?.title ?? ""}`,
    `Command: ${info?.command ?? ""}${Array.isArray(info?.args) && info.args.length ? " " + info.args.join(" ") : ""}`,
    `Workdir: ${info?.workdir ?? ""}`,
    `PID: ${info?.pid ?? ""}`,
    `Status: ${info?.status ?? "running"}`,
    `notifyOnExit: ${notifyOnExit === true}`,
    `Initiator Session: PTY web UI`,
    `Root Session: ${rootId || "global"}`,
    "</pty_spawned>",
  ].join("\n");
}

// Fire-and-forget: prompt the target conversation(s) with the announcement.
// One failing target never blocks the others (same pattern as the exit
// notifier's per-target try/catch).
function announceWebSpawn(ctx, notify, info, parentSessionId, notifyOnExit) {
  if (notify?.announceWebSpawn === false) return;
  const prompt = ctx?.session?.prompt;
  if (typeof prompt !== "function") return;
  const isGlobal = !parentSessionId;
  let rootId = "";
  if (!isGlobal) {
    try {
      rootId = String(rootSessionId(ctx, parentSessionId) ?? "");
    } catch {
      rootId = String(parentSessionId);
    }
  }
  const text = buildWebSpawnAnnouncement(info, rootId, notifyOnExit);
  void (async () => {
    const targets = isGlobal
      ? (await opencodeSessionRowsSafe(ctx)).map((s) => s.id)
      : [parentSessionId];
    for (const target of targets) {
      if (typeof target !== "string" || !target) continue;
      try {
        const result = prompt({ sessionID: target, text });
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        /* never let a prompt failure break the spawn response */
      }
    }
  })();
}

// Never-throwing wrapper for the fire-and-forget announcer above.
async function opencodeSessionRowsSafe(ctx) {
  try {
    return await opencodeSessionRows(ctx);
  } catch {
    return [];
  }
}

// OS-aware default for the `+` popup's command field (the placeholder AND the
// value submitted when the field is left empty). Windows default `pwsh`; on
// posix the user's login shell (`SHELL`), falling back to `bash`.
function defaultSpawnCommand() {
  if (process.platform === "win32") return "pwsh -NoLogo";
  const shell =
    typeof process.env.SHELL === "string" && process.env.SHELL.trim()
      ? process.env.SHELL.trim()
      : "";
  return shell || "bash";
}

// Creates the two route handlers; returns null when the manager (or another
// precondition) is missing, in which case the routes are simply not injected.
//
// The `+` popup's PRESENCE store (rework after v75's 60-min window was dropped):
// `Map<sessionId, Map<source, ts>>` of presence stamps. Sources:
//   "tui"     - the TUI half heartbeats its open/in-view session ids
//               (`present` RPC); stamps stop when the TUI closes.
//   "web"     - the PTY web UI stamps sessions opened from the "+"/page and
//               heartbeats while the page is open.
//   "tracker" - the (proven-dead) event tracker; kept as a minor fallback.
// A session is live when ANY of its stamps is younger than its source's
// staleness limit, or it is "active" per the DB (time_updated inside the
// short `webUi.newPtyActiveWindowMs` window), or it owns a RUNNING PTY.
// Lives on `globalThis` so hot reloads and web handlers share one store.
const LIVE_SESSIONS_MAP_KEY = "__opencodePtyLiveSessionStamps";
function liveSessionsGlobal() {
  const g = globalThis;
  let store = g[LIVE_SESSIONS_MAP_KEY];
  if (!(store instanceof Map)) {
    store = new Map();
    g[LIVE_SESSIONS_MAP_KEY] = store;
  }
  return store;
}

const PRESENCE_SRC_TUI = "tui";
const PRESENCE_SRC_WEB = "web";
const PRESENCE_SRC_TRACKER = "tracker";
// Heartbeat defaults live on the senders (TUI 60 s / web 45 s); a source goes
// stale after this multiple of silence (closed tab/page/TUI => not selectable).
// Generous for "web": background browser tabs throttle setInterval.
const PRESENCE_STALE_MS = {
  [PRESENCE_SRC_TUI]: 3 * 60_000,
  [PRESENCE_SRC_WEB]: 3 * 60_000,
  [PRESENCE_SRC_TRACKER]: 2 * 60_000,
};

// Record a presence stamp for one session id + source (the `present` RPC, the
// /api/opencode-presence route, the tracker, and the TUI/web heartbeats).
function presenceStamp(id, source, when = Date.now()) {
  if (typeof id !== "string" || !id || id === GROUP_WEB_API_PARENT) return;
  const store = liveSessionsGlobal();
  let srcs = store.get(id);
  if (!(srcs instanceof Map)) {
    srcs = new Map();
    store.set(id, srcs);
  }
  srcs.set(source, when);
}

// Tracker-facing alias (kept for the session.deleted prune path).
function markSessionLive(id, when = Date.now()) {
  presenceStamp(id, PRESENCE_SRC_TRACKER, when);
}

// Drop a session from the presence store (session.deleted events).
function markSessionDeleted(id) {
  if (typeof id === "string" && id) {
    liveSessionsGlobal().delete(id);
  }
}

// Build only valid, non-web-api ids of one session into a set.
function markSessionLiveInto(target, candidates) {
  for (const id of candidates ?? []) {
    if (typeof id === "string" && id && id !== GROUP_WEB_API_PARENT) {
      target.add(id);
    }
  }
}

// --- presence DB (L3: "actively doing something") ---------------------------
// The opencode sqlite store (`~/.local/share/opencode/opencode.db`, XDG_DATA_HOME
// aware). Liveness query: `session_v2.time_updated` — live-verified to bump
// continuously while an agent streams (1-9 s cadence). event/message/part rows
// cannot be used (event.created is hardcoded 0; v2 sessions write NO
// message/part rows while streaming). Read-only WAL access; option casing
// differs per module (wrong spelling would open read-write).
// Retrieability: on open failure wait 100 ms and retry, 25 times (~2.5 s
// worst case); then the ROUTE falls back to the FULL history (user decision:
// a closed tab means "don't interact anymore" anyway - an honest full list
// beats a heuristically-filtered one). After the ladder hard-fails, calls
// within a 5 min cooldown degrade FAST (no repeated 2.5 s stalls).
const PRESENCE_DB_RETRY_MS = 100;
const PRESENCE_DB_RETRIES = 25;
const PRESENCE_DB_COOLDOWN_MS = 5 * 60_000;
let presenceDbPromise = null;
let presenceDbFailedUntil = 0;
let presenceDbState = { status: "idle", attempts: 0 };

function presenceSleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function presenceDatabase() {
  try {
    if (presenceDbPromise) return presenceDbPromise;
    if (Date.now() < presenceDbFailedUntil) {
      // Cooldown after a hard ladder failure: degrade fast until retry time.
      return Promise.resolve(null);
    }
    const dataHome =
      (typeof process.env.XDG_DATA_HOME === "string" && process.env.XDG_DATA_HOME) ||
      join(homedir(), ".local", "share");
    const dbPath = join(dataHome, "opencode", "opencode.db");
    presenceDbPromise = (async () => {
      const bun = await import("bun:sqlite").catch(() => null);
      const mod = bun ?? (await import("node:sqlite").catch(() => null));
      const Ctor = mod?.Database ?? mod?.DatabaseSync;
      if (typeof Ctor !== "function") {
        presenceDbState = { status: "no-module", attempts: 0 };
        presenceDbFailedUntil = Date.now() + PRESENCE_DB_COOLDOWN_MS;
        return null;
      }
      // Option name differs: bun spells it `readonly`, node `readOnly`
      // (wrong casing would open the shared DB read-write).
      const opts = bun ? { readonly: true } : { readOnly: true };
      for (let attempt = 1; attempt <= PRESENCE_DB_RETRIES; attempt += 1) {
        try {
          const db = new Ctor(dbPath, opts);
          presenceDbState = { status: "open", attempts: attempt };
          return db;
        } catch (error) {
          presenceDbState = {
            status: "retrying",
            attempts: attempt,
            lastError: String(error).slice(0, 120),
          };
          if (attempt < PRESENCE_DB_RETRIES) await presenceSleep(PRESENCE_DB_RETRY_MS);
        }
      }
      presenceDbState = { status: "failed", attempts: PRESENCE_DB_RETRIES, degradedAt: Date.now(), lastError: String(presenceDbState.lastError ?? "").slice(0, 120) };
      presenceDbFailedUntil = Date.now() + PRESENCE_DB_COOLDOWN_MS;
      return null;
    })();
    presenceDbPromise.catch(() => null); // ladder never rejects; belt-and-braces
    return presenceDbPromise;
  } catch {
    return Promise.resolve(null);
  }
}

// Per-query fast retry (transient SQLITE_BUSY): 3 attempts x 50 ms.
async function presenceQuery(db, sql, param) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return db.prepare(sql).all(param);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await presenceSleep(50);
    }
  }
  throw lastError ?? new Error("presenceQuery failed");
}

// Liveness for the `webUi.newPtyShowAllSessions === false` dropdown filter.
// Composition (user-locked semantics):
//   1. presence stamps (TUI open tab / web-UI open / tracker) that are NOT yet
//      stale for their source;
//   2. DB activity: `session_v2.time_updated` inside the ACTIVE window (the
//      "doing something without a UI open" fallback);
//   3. RUNNING-PTY owners (re-stamped every read, survive anything).
// Returns `{ ids: Set<string>, degraded: boolean }`; `degraded` is true when
// the DB was unreachable AND no other source contributed - the route turns
// that into the full-history fallback (never an empty/only-GLOBAL list).
async function liveSessionIdSet(manager, activeWindowMs, db) {
  const out = new Set();
  const now = Date.now();
  // 1. Stamped sources, per-source staleness, expired entries pruned at read.
  for (const [id, srcs] of liveSessionsGlobal()) {
    let alive = false;
    for (const [src, ts] of srcs) {
      const staleMs = PRESENCE_STALE_MS[src] ?? 3 * 60_000;
      if (typeof ts === "number" && now - ts <= staleMs) {
        alive = true;
      } else {
        srcs.delete(src);
      }
    }
    if (srcs.size === 0) {
      liveSessionsGlobal().delete(id);
    } else if (alive) {
      out.add(id);
    }
  }
  let degraded = false;
  // 2. DB activity inside the (short) active window.
  try {
    const span = Math.max(0, Number(activeWindowMs) || 0);
    if (!db) {
      // No DB (not open / failed): degrade only when nothing else knows better.
      degraded = true;
    } else if (span > 0 && typeof db.prepare === "function") {
      const rows = await presenceQuery(
        db,
        "SELECT id, time_updated FROM session_v2 WHERE time_updated > ?",
        now - span,
      );
      for (const row of rows ?? []) {
        if (row && typeof row.id === "string" && row.id) {
          markSessionLiveInto(out, [row.id]);
        }
      }
    }
  } catch {
    degraded = true;
  }
  // 3. RUNNING-PTY owners.
  try {
    const list = manager?.lifecycleManager?.listSessions?.() ?? [];
    for (const session of list) {
      if (String(session?.status ?? "") !== "running") continue;
      markSessionLiveInto(out, [
        session.id,
        session.parentSessionId,
        session.rootSessionId,
      ]);
    }
  } catch {
    /* no lifecycle store; stamps only */
  }
  return { ids: out, degraded: degraded && out.size === 0 };
}

// Liveness tracker (collapsed in v78; minor best-effort fallback only). The
// v73-v74 probe rounds proved both candidate channels are plugin-gated for
// registered-plugin shapes - `subscribe` variants AND name-based `hook` calls
// all subscribed without error yet never delivered a single event
// (`?debug=ctx` round: eventCount stayed 0 while the host streamed). The
// decisive liveness sources are the presence store (TUI/web stamps) plus the
// session_v2 DB recency feed; the tracker stays ONLY as an extra stamp source
// in case a future host opens its event stream: a single-arg `subscribe`.
// Report fields kept (`subscribed`/`errors`/`subscribeReturns`/`eventCount`)
// so diagnostics stay shaped like before.
function installLiveSessionTracker(ctx) {
  const info = (globalThis.__opencodePtyLiveTrackerInfo = {
    subscribed: [],
    subscribeReturns: {},
    errors: [],
    eventCount: 0,
  });
  const note = (event) => {
    try {
      info.eventCount += 1;
      const p = event?.properties ?? event;
      const id =
        p?.sessionID ??
        p?.info?.id ??
        (typeof p === "string" ? p.match(/ses_\w+/)?.[0] : undefined);
      const type = String(event?.type ?? event ?? "");
      if (type === "session.deleted") {
        markSessionDeleted(typeof id === "string" ? id : p?.info?.id);
      } else {
        markSessionLive(id);
      }
    } catch {
      /* a tracker error must never break the host */
    }
  };
  const ev = ctx?.event;
  if (ev && typeof ev === "object" && typeof ev.subscribe === "function") {
    try {
      const returned = ev.subscribe((event) => note(event));
      info.subscribed.push("subscribe(fn)");
      if (returned !== undefined && returned !== null) {
        info.subscribeReturns["subscribe(fn)"] = String(returned).slice(0, 300);
      }
    } catch (error) {
      info.errors.push(`subscribe(fn): ${String(error).slice(0, 120)}`);
    }
  }
  return info;
}

function createWebApiHandlers(deps, ctx, notify) {  const manager = deps?.manager;
  if (!manager || typeof manager.spawn !== "function") return null;

  async function opencodeSessions(req) {
    // Session-bound spawn defaults: the popup uses `directory` as the workdir
    // placeholder (submitted when the field is left empty). The exact home of
    // a session's directory is best-effort: probe session info, then fall back
    // to the plugin instance's project directory.
    const base = typeof ctx?.location?.directory === "string" ? ctx.location.directory : "";
    let tuples = await opencodeSessionRowsSafe(ctx);
    // `webUi.newPtyShowAllSessions !== true` (the default): only LIVE sessions
    // reach the dropdown (presence stamps + DB activity + RUNNING-PTY owners).
    if (deps?.webUi?.newPtyShowAllSessions !== true) {
      const live = await liveSessionIdSet(
        manager,
        deps?.webUi?.newPtyActiveWindowMs,
        await presenceDatabase(),
      );
      if (live.degraded) {
        // DB unreachable AND nothing else knows liveness: full history is the
        // honest fallback (never an empty/only-GLOBAL list).
      } else {
        tuples = tuples.filter((t) => live.ids.has(t.id));
      }
    }
    const rows = [];
    for (const t of tuples) {
      let directory = "";
      try {
        const info = await ctx?.session?.get?.({ sessionID: t.id });
        directory =
          (typeof info?.location?.directory === "string" && info.location.directory) ||
          (typeof info?.directory === "string" && info.directory) ||
          "";
      } catch {
        directory = "";
      }
      if (!directory) directory = base;
      rows.push({ id: t.id, title: t.title, directory });
    }
    return jsonResp(rows);
  }

  async function sessions(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResp({ error: "Invalid JSON in request body" }, 400);
    }
    const rawCommand = typeof body?.command === "string" ? body.command.trim() : "";
    // An empty command uses the OS-aware default (the popup's placeholder).
    const effectiveCommand = rawCommand || defaultSpawnCommand();
    const tokens = splitShellWords(effectiveCommand);
    if (!tokens || tokens.length === 0) {
      return jsonResp({ error: "Command is required" }, 400);
    }
    const command = tokens[0];
    const args = Array.isArray(body?.args)
      ? body.args.filter((a) => typeof a === "string")
      : tokens.slice(1);
    const rawParent =
      typeof body?.parentSessionId === "string" ? body.parentSessionId.trim() : "";
    let parent = "";
    if (rawParent && rawParent !== GROUP_WEB_API_PARENT) {
      let target = null;
      try {
        target = await ctx?.session?.get?.({ sessionID: rawParent });
      } catch {
        target = null;
      }
      if (!target || typeof target.id !== "string" || !target.id) {
        return jsonResp({ error: `Unknown opencode session: ${rawParent}` }, 400);
      }
      parent = target.id;
    }
    const workdir =
      typeof body?.workdir === "string" && body.workdir.trim()
        ? body.workdir.trim()
        : undefined;
    const description =
      typeof body?.description === "string" && body.description.trim()
        ? body.description.trim()
        : undefined;
    const timeoutSeconds =
      typeof body?.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)
        ? body.timeoutSeconds
        : undefined;
    // Notify-on-exit checkbox (new-PTY dialog). Explicit body value only — the
    // dialog always sends it, so an omitted key keeps the upstream default
    // (`opts.notifyOnExit ?? false`). Delivering the exit notification is the
    // exit notifier's job (installExitNotifier -> notifyTargets).
    const notifyOnExit = body?.notifyOnExit === true;
    let info;
    try {
      info = manager.spawn({
        command,
        args,
        description,
        workdir,
        timeoutSeconds,
        notifyOnExit,
        parentSessionId: parent || GROUP_WEB_API_PARENT,
      });
    } catch (error) {
      return jsonResp(
        { error: `Spawn failed: ${error?.message ?? String(error)}` },
        500,
      );
    }
    announceWebSpawn(ctx, notify, info, parent, notifyOnExit);
    return jsonResp(
      {
        id: info?.id ?? "",
        title: info?.title ?? "",
        command: info?.command ?? command,
        args: info?.args ?? args,
        pid: info?.pid ?? null,
        status: info?.status ?? "running",
        workdir: info?.workdir ?? workdir ?? "",
        parentSessionId: parent || GROUP_WEB_API_PARENT,
      },
      201,
    );
  }

  // Stamp web-UI presence (POST /api/opencode-presence). The injected popup
  // script heartbeats `/api/opencode-presence` with the ids of the sessions
  // opened in the web UI; while the page is open the stamps refresh, page
  // closed -> stamps go stale (presence, not activity). Best-effort: malformed
  // bodies just stamp nothing.
  async function presence(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResp({ ok: false, error: "Invalid JSON in request body" }, 400);
    }
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    let stamped = 0;
    for (const id of ids) {
      if (typeof id === "string" && id && id !== GROUP_WEB_API_PARENT) {
        presenceStamp(id, PRESENCE_SRC_WEB);
        stamped += 1;
      }
    }
    return jsonResp({ ok: true, stamped });
  }

  return { opencodeSessions, presence, sessions };
}

// Applies the font, viewer-resize, session-select, terminal-kill-key,
// debug-size and session-close transforms to the buffered static `Response`
// objects in place (called by the patched `createServer`).
async function applyStaticTransforms(staticRoutes, { terminalFont, webUi, webApi, argDefaults } = {}) {
  await applyTerminalFont(staticRoutes, terminalFont);

  const viewerResize = webUi?.viewerResize;
  const resizeEnabled = Boolean(viewerResize) && viewerResize.enabled !== false;
  const debugSizeEnabled = webUi?.debugSize !== false;
  // Always applied: this rewrite is what makes `^C` a passthrough (and `^D` an
  // optional kill) instead of the package's default `^C`-kills-session.
  const killKeys = {
    ctrlCKillSession: webUi?.ctrlCKillSession === true,
    ctrlDKillSession: webUi?.ctrlDKillSession !== false,
  };
  // Confirmation gating; false = act without asking (see applyKillConfirmToJs
  // and the `{ confirm }` argument of applySessionCloseToJs).
  const killConfirm = webUi?.killConfirmSession !== false;
  const closeConfirm = webUi?.closeConfirmSession !== false;
  // Group the web UI sidebar by opencode conversation; `"agent"` mode also
  // sub-groups each conversation by the sub-session that spawned the PTY.
  const groupBy = normalizeGroupBy(webUi?.groupBy, "agent");
  const grouped = groupBy !== false;
  const downloadLogEnabled = webUi?.downloadLog !== false;
  const sizeControlEnabled = webUi?.sizeControl !== false;
  const spawnButtonEnabled = webUi?.spawnButton !== false;
  // The `+` dialog's initial notify-on-exit toggle state follows the same
  // effective default the `pty_spawn` tool uses.
  const spawnNotifyOnExit = argDefaults?.pty_spawn?.notifyOnExit !== false;
  // WebSocket auto-reconnect watchdog; 0/false injects nothing.
  const reconnectIntervalMs = Number(webUi?.reconnectIntervalMs) > 0
    ? Math.round(Number(webUi.reconnectIntervalMs))
    : 0;

  await Promise.all(
    Object.entries(staticRoutes).map(async ([key, response]) => {
      if (typeof Response !== "function" || !(response instanceof Response)) return;
      if (!key.toLowerCase().endsWith(".js")) return;

      let text = await response.text();
      let changed = false;

      if (resizeEnabled) {
        const result = applyResizeToJs(text, viewerResize);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] viewerResize: terminal init pattern not found in ${key}`);
        }
      }

      // Always applied: `?session=<id>` preselects that session (used by the
      // sidebar, /pty-open-background-spy and the pty_url tool).
      {
        const result = applySelectSessionToJs(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] sessionSelect: auto-select pattern not found in ${key}`);
        }
      }

      {
        const result = applyKillKeysToJs(text, killKeys);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] ctrlCKillSession/ctrlDKillSession: input handler pattern not found in ${key}`);
        }
      }

      if (!killConfirm) {
        const result = applyKillConfirmToJs(text, { enabled: false });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] killConfirmSession: kill handler pattern not found in ${key}`);
        }
      }

      // Always applied: the debug-line relabel — "<id>: N chars, WS raw_data:
      // …, session_updates: …" with the id bold (see applyDebugRelabelToJs).
      {
        const result = applyDebugRelabelToJs(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] debugRelabel: debug-info pattern not found in ${key}`);
        }
      }

      if (debugSizeEnabled) {
        const result = applyDebugSizeToJs(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] debugSize: debug-info pattern not found in ${key}`);
        }
      }

      // Always applied: the per-session close (×) button.
      {
        const result = applySessionCloseToJs(text, { confirm: closeConfirm });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] sessionClose: session-item pattern not found in ${key}`);
        }
      }

      // Always applied (when enabled): the WebSocket auto-reconnect hook.
      // The watchdog itself lives in the html route (applyWsReconnectToHtml).
      if (reconnectIntervalMs > 0) {
        const result = applyWsReconnectToJs(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] reconnect: WebSocket pattern not found in ${key}`);
        }
      }

      // Group the sidebar by opencode conversation. Runs after session-close so
      // its `.filter(...)` sits inside the wrapped array.
      if (grouped) {
        const result = applyGroupBySessionToJs(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] groupBy: session-list pattern not found in ${key}`);
        }
      }

      if (!changed) return;

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("Cache-Control", "no-store");
      staticRoutes[key] = new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );

  // The session-close (×) button's CSS and the group-by-session helper/CSS live
  // in the html route (always applied / gated by the option respectively).
  await Promise.all(
    Object.entries(staticRoutes).map(async ([key, response]) => {
      if (typeof Response !== "function" || !(response instanceof Response)) return;
      const dot = key.lastIndexOf(".");
      if (dot === -1 || key.slice(dot).toLowerCase() !== ".html") return;

      let text = await response.text();
      let changed = false;
      {
        const result = applySessionCloseToHtml(text);
        text = result.text;
        changed = changed || result.changed;
      }
      {
        // Kill-button geometry + stretchSessions; always applied.
        const result = applyWebUiShapeToHtml(text, {
          stretch: webUi?.stretchSessions !== false,
        });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] webui shape: </head> not found in ${key} (or already patched)`);
        }
      }
      if (reconnectIntervalMs > 0) {
        // The WebSocket auto-reconnect watchdog (pairs with
        // applyWsReconnectToJs's hook above; `interval` baked in at
        // transform time — a config change bumps the server signature and
        // recycles + re-transforms the routes).
        const result = applyWsReconnectToHtml(text, { interval: reconnectIntervalMs });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] reconnect: </head> not found in ${key} (or already patched)`);
        }
      }
      if (grouped) {
        const result = applyGroupBySessionToHtml(text, groupBy, {
          confirm: closeConfirm,
        });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] groupBy: </head> not found in ${key}`);
        }
      }
      if (sizeControlEnabled) {
        const result = applySizeModeBarToHtml(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] sizeControl: </head> not found in ${key} (or already patched)`);
        }
      }
      if (downloadLogEnabled) {
        const result = applyDownloadLogToHtml(text);
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] downloadLog: </head> not found in ${key}`);
        }
      }
      if (spawnButtonEnabled) {
        const result = applyPlusSpawnToHtml(text, {
          defaultCommand: defaultSpawnCommand(),
          homeDir: homedir(),
          defaultNotifyOnExit: spawnNotifyOnExit,
        });
        text = result.text;
        changed = changed || result.changed;
        if (!result.changed) {
          console.warn(`[opencode-pty-extended] spawnButton: </head> not found in ${key} (or already patched)`);
        }
      }
      if (!changed) return;

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("Cache-Control", "no-store");
      staticRoutes[key] = new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );

  // The wrapper-owned JSON routes for the `+` spawn button: function entries
  // serve every method of the path; nothing below touches upstream's routes.
  // (The transform loops above skip function entries via the
  // `response instanceof Response` guard.)
  if (webApi && typeof webApi === "object") {
    if (typeof webApi.opencodeSessions === "function") {
      staticRoutes["/api/opencode-sessions"] = webApi.opencodeSessions;
      staticRoutes["/api/opencode-presence"] = webApi.presence;
    }
    if (typeof webApi.sessions === "function") {
      staticRoutes["/api/pty-extended/sessions"] = webApi.sessions;
    }
  }
}


// ---------------------------------------------------------------------------
// Web UI viewer resize + CSI 18t replies (backend)
// ---------------------------------------------------------------------------
// See the header comment for the "why". The frontend half is the injected
// resize watcher (`applyResizeToJs` above); the backend half is these manager
// patches:
//
//   1. `manager.write` recognises the magic `\x1ePTYRSZ:<cols>,<rows>` envelope
//      the watcher POSTs and calls `session.process.resize(cols, rows)` on the
//      bun-pty (which resizes the ConPTY) instead of writing to the child.
//   2. `manager.spawn` decorates each session's output buffer so that any data
//      containing the CSI 18t size query is answered on the child's stdin with
//      `ESC [ 8 ; <rows> ; <cols> t` (blessed's `getWindowSize`).
//
// Both patches are applied to the shared `manager` singleton, so every spawn
// path (agent tool, HTTP API, WebSocket) is covered. They are idempotent.
function installManagerResizeAndCsi(manager, webUi) {
  if (!manager) return;

  const resizeEnabled = webUi?.viewerResize?.enabled !== false;
  const csiEnabled = webUi?.csiReply !== false;

  if (resizeEnabled && typeof manager.write === "function" && !manager.write.__opencodePtyLocalWrapped) {
    const originalWrite = manager.write.bind(manager);
    manager.write = (id, data) => {
      if (typeof data === "string" && data.startsWith(RESIZE_PREFIX)) {
        const [cols, rows] = data
          .slice(RESIZE_PREFIX.length)
          .split(",")
          .map(Number);
        const session = manager.lifecycleManager?.getSession(id);
        if (
          session?.process &&
          Number.isInteger(cols) && cols > 0 &&
          Number.isInteger(rows) && rows > 0
        ) {
          // A fixed-size session ignores viewer auto-fit requests entirely —
          // only the size-mode envelope / pty_size_set / TUI control may move a
          // pinned PTY.
          if (session.__ptySizeMode === "fixed") {
            return true;
          }
          try {
            session.process.resize(cols, rows);
            session.__ptyCols = cols; // remembered so the CSI reply uses the
            session.__ptyRows = rows; // viewer size even before ConPTY reports it
          } catch (error) {
            console.warn(`[opencode-pty-extended] resize failed for ${id}:`, error);
          }
        }
        return true; // swallow the magic envelope
      }
      if (typeof data === "string" && data.startsWith(SIZE_MODE_PREFIX)) {
        // Size-mode envelopes from the web UI control (and `pty_size_set` uses
        // the same helpers directly). Unknown payloads are swallowed too — a
        // malformed mode string must never reach the PTY as typed input.
        try {
          const session = manager.lifecycleManager?.getSession(id);
          const rest = data.slice(SIZE_MODE_PREFIX.length);
          if (rest === "auto") {
            setSizeModeAuto(session);
          } else if (rest.startsWith("fixed,")) {
            const [cols, rows] = rest.slice("fixed,".length).split(",").map(Number);
            if (session?.process) applyFixedSize(session, cols, rows);
          }
        } catch (error) {
          console.warn(`[opencode-pty-extended] size mode envelope failed for ${id}:`, error);
        }
        return true;
      }
      return originalWrite(id, data);
    };
    manager.write.__opencodePtyLocalWrapped = true;
  }

  if (csiEnabled && typeof manager.spawn === "function" && !manager.spawn.__opencodePtyLocalWrapped) {
    const originalSpawn = manager.spawn.bind(manager);
    manager.spawn = (opts) => {
      const info = originalSpawn(opts);
      const session = manager.lifecycleManager?.getSession(info?.id);
      if (
        session &&
        typeof session.buffer?.append === "function" &&
        !session.buffer.__opencodePtyLocalWrapped
      ) {
        const append = session.buffer.append.bind(session.buffer);
        session.buffer.__opencodePtyLocalWrapped = true;
        session.buffer.append = (data) => {
          append(data);
          if (typeof data === "string" && /\x1b\[18t/.test(data)) {
            const process = session.process;
            if (process) {
              try {
                const cols = session.__ptyCols ?? process.cols;
                const rows = session.__ptyRows ?? process.rows;
                process.write(`\x1b[8;${rows};${cols}t`);
              } catch {
                // never let a reply failure break output handling
              }
            }
          }
        };
      }
      return info;
    };
    manager.spawn.__opencodePtyLocalWrapped = true;
  }
}

// ---------------------------------------------------------------------------
// Session lineage + sidebar grouping fields (backend half)
// ---------------------------------------------------------------------------
// Neither the web UI nor the TUI sidebar has access to opencode's session store,
// so this backend half enriches the shared `manager.list()` rows — the single
// source for `GET /api/sessions`, the `session_list` WebSocket push, the TUI's
// RPC `list` and `pty_list` — with:
//
//   parentSessionId     the raw PTY session's immediate parent (or null);
//   initiatorSessionId  the session that called `pty_spawn` (the subagent);
//   initiatorAgent      that session's agent name (or null);
//   rootSessionId       the *root* opencode conversation the PTY rolls up to
//                       (null for web-UI-created sessions / orphans);
//   isSubagent          true when the initiator is not the root conversation;
//   groupSessionId      the root conversation (or null) — the grouping key;
//   groupSessionTitle   that root conversation's title (or null if unresolved);
//   subagentSessionId   the immediate parent when it differs from the root — the
//   subagentSessionTitle "agent" mode's sub-group key + title (else null).
//
// All of them are always emitted: `webUi.groupBy` and `tuiSidebar.groupBy` are
// independent options, so which fields are *used* (and how) is decided by each
// frontend against its own mode — this half just supplies the data. The title
// refresher (below) only runs while at least one of them wants headers.
//
// Rooting walks `parentID` up the `ctx.data.session` tree (best effort; with no
// store the immediate parent is its own root). Titles come from
// `ctx.session.get({ sessionID })` and are resolved lazily in the background,
// because `manager.list()` is synchronous. Only parents not already cached are
// looked up; unresolved titles are retried on a slow timer (titles are set
// asynchronously by opencode). The cache and timer live on `globalThis` so a hot
// reload reuses them instead of stacking.

// A web-UI-created session's parent (see the package's `createSession`); it is
// not an opencode conversation, so those PTYs stay ungrouped.
const GROUP_WEB_API_PARENT = "web-api";

// Where an exit notification is delivered. "spawner" = the session that called
// `pty_spawn` (the subagent, if any); "root" = the top-level conversation;
// "both" = each distinct target. Anything else falls back to "spawner".
const NOTIFY_TARGETS = new Set(["spawner", "root", "both"]);
function normalizeNotifyTarget(value) {
  return NOTIFY_TARGETS.has(value) ? value : "spawner";
}

function groupCacheGlobal() {
  const g = globalThis;
  if (!(g.__opencodePtyLocalGroupCache instanceof Map)) {
    g.__opencodePtyLocalGroupCache = new Map();
  }
  return g.__opencodePtyLocalGroupCache;
}

// The root opencode conversation `sessionID` rolls up to (walks `parentID`).
// Falls back to `sessionID` when the session store is unavailable.
function rootSessionId(ctx, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return sessionID;
  // Prefer the documented v2 helper when the store exposes it: it walks the
  // real parent chain and understands the store's own shapes (a subagent is a
  // child session, so a top-level session is its own root).
  try {
    const root = ctx?.data?.session?.root?.(sessionID);
    const id = typeof root === "string" ? root : root?.id;
    if (typeof id === "string" && id) return id;
  } catch {
    /* fall through to the parentID walk */
  }
  try {
    const list = ctx?.data?.session?.list?.();
    if (Array.isArray(list) && list.length > 0) {
      const parentOf = new Map();
      for (const entry of list) {
        const id = entry?.id;
        const parent = entry?.parentID ?? entry?.parentId;
        if (typeof id === "string" && id && typeof parent === "string" && parent) {
          parentOf.set(id, parent);
        }
      }
      let current = sessionID;
      for (let i = 0; i < 100 && parentOf.has(current); i += 1) {
        current = parentOf.get(current);
      }
      return current;
    }
  } catch {
    /* no session store; treat the parent as its own root */
  }
  return sessionID;
}

// Async root resolver: walks the session store's real parent chain via
// `ctx.session.get({ sessionID })` (which returns a `Session` with `parentID`).
// The synchronous `ctx.data.session.root()`/`list()` walk can miss subagent
// sessions (the store may not expose them synchronously), so this is the
// authoritative path used by the background refresher and the spawn stamper.
// Returns `sessionID` when the chain bottoms out (a top-level session is its
// own root) or the store is unavailable.
async function asyncRootSessionId(ctx, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return sessionID;
  const get = ctx?.session?.get;
  if (typeof get !== "function") return rootSessionId(ctx, sessionID);
  let current = sessionID;
  for (let i = 0; i < 100; i += 1) {
    let info;
    try {
      info = await get.call(ctx.session, { sessionID: current });
    } catch {
      break;
    }
    const parent = info?.parentID ?? info?.parentId;
    if (typeof parent !== "string" || !parent || parent === current) break;
    current = parent;
  }
  return current;
}

function installManagerGroupBySession(manager, ctx, webUi, tuiSidebar) {
  // Always stop any previous refresher first (so disabling grouping, or a hot
  // reload, never leaves a stale timer resolving titles).
  const g = globalThis;
  if (g.__opencodePtyLocalGroupTimer) {
    clearInterval(g.__opencodePtyLocalGroupTimer);
    g.__opencodePtyLocalGroupTimer = null;
  }
  if (!manager || typeof manager.list !== "function") return;

  const cache = groupCacheGlobal();

  // Decorates the shared list with the lineage + grouping fields. Always
  // installed (the exit notifier, `pty_list` and the TUI sidebar need them even
  // when no headers are drawn). Idempotent; reads the cache through the global so
  // a hot reload swaps in the fresh cache without re-wrapping the manager.
  if (!manager.list.__opencodePtyLocalGrouped) {
    const originalList = manager.list.bind(manager);
    const decorated = () => {
      const store = groupCacheGlobal();
      // Roots for sessions that predate the spawn stamping (or a hot reload) are
      // walked once per list() call and memoized for the pass.
      const rootOf = new Map();
      const rootFor = (parent) => {
        if (rootOf.has(parent)) return rootOf.get(parent);
        const value = rootSessionId(ctx, parent);
        rootOf.set(parent, value);
        return value;
      };
      return originalList().map((info) => {
        const raw = manager.lifecycleManager?.getSession(info.id);
        const parent = raw?.parentSessionId ?? null;
        const agent = raw?.parentAgent ?? null;
        if (!parent || parent === GROUP_WEB_API_PARENT) {
          const size = sessionSizeState(raw);
          return {
            ...info,
            parentSessionId: parent,
            initiatorSessionId: null,
            initiatorAgent: null,
            rootSessionId: null,
            isSubagent: false,
            groupSessionId: null,
            groupSessionTitle: null,
            subagentSessionId: null,
            subagentSessionTitle: null,
            sizeMode: size.mode,
            cols: size.cols,
            rows: size.rows,
          };
        }
        const entry = store.get(parent);
        // Prefer the root stamped at spawn (authoritative), then the resolved
        // cache entry, then a synchronous walk of the session store.
        const root = raw?.rootSessionId ?? entry?.rootId ?? rootFor(parent);
        const isSubagent = root !== parent;
        const size = sessionSizeState(raw);
        return {
          ...info,
          parentSessionId: parent,
          initiatorSessionId: parent,
          initiatorAgent: agent,
          rootSessionId: root,
          isSubagent,
          groupSessionId: root,
          groupSessionTitle: entry?.title ?? null,
          subagentSessionId: isSubagent ? parent : null,
          subagentSessionTitle: isSubagent ? entry?.parentTitle ?? null : null,
          sizeMode: size.mode,
          cols: size.cols,
          rows: size.rows,
        };
      });
    };
    decorated.__opencodePtyLocalGrouped = true;
    manager.list = decorated;
  }

  // Only need a background refresher when at least one of the two independent
  // grouping options (`webUi.groupBy` / `tuiSidebar.groupBy`) wants headers.
  const wantsHeaders =
    normalizeGroupBy(webUi?.groupBy ?? webUi?.groupBySession, "agent") !== false ||
    normalizeGroupBy(tuiSidebar?.groupBy, "agent") !== false;
  if (!wantsHeaders) return;

  // Resolve titles for parents we haven't resolved yet. Unresolved entries are
  // retried on a slow cadence (a title set later still lands); resolved ones are
  // cached indefinitely. Both the root conversation's title and (in "agent"
  // mode) the immediate sub-session's title are resolved. The timer lives on
  // `globalThis` so hot reloads replace rather than stack.
  const RETRY_MS = 15000;
  const refresh = async () => {
    let parents;
    try {
      parents = new Set(
        (manager.lifecycleManager?.listSessions?.() ?? [])
          .map((session) => session?.parentSessionId)
          .filter(
            (parent) =>
              typeof parent === "string" &&
              parent &&
              parent !== GROUP_WEB_API_PARENT,
          ),
      );
    } catch {
      return;
    }
    for (const parent of parents) {
      const entry = cache.get(parent);
      const rootId = entry?.rootId ?? (await asyncRootSessionId(ctx, parent));
      const wantParentTitle = rootId !== parent;
      const resolved = Boolean(entry?.title) && (!wantParentTitle || Boolean(entry?.parentTitle));
      if (entry && resolved) continue;
      if (entry && Date.now() - (entry.ts ?? 0) < RETRY_MS) continue;
      let title = entry?.title ?? null;
      let parentTitle = entry?.parentTitle ?? null;
      try {
        if (!title) {
          const info = await ctx?.session?.get?.({ sessionID: rootId });
          if (typeof info?.title === "string" && info.title) title = info.title;
        }
        if (wantParentTitle && !parentTitle) {
          const info = await ctx?.session?.get?.({ sessionID: parent });
          if (typeof info?.title === "string" && info.title) parentTitle = info.title;
        }
      } catch {
        /* leave unresolved; retried on the next tick */
      }
      cache.set(parent, { rootId, title, parentTitle, ts: Date.now() });
    }
  };
  refresh();
  const timer = setInterval(refresh, 2000);
  if (typeof timer?.unref === "function") timer.unref();
  g.__opencodePtyLocalGroupTimer = timer;
}

// Stamps each freshly spawned PTY with the lineage the notifier and listings
// need. `manager.spawn` is the single choke point for every spawn path (agent
// tool, HTTP API, WebSocket), so wrapping it once here covers all of them.
//
// Two facts are recorded on the raw session:
//   * `rootSessionId` — the root opencode conversation (from the immediate
//     parent). The raw session keeps `parentSessionId`/`parentAgent` already.
//   * `notifyTarget` — where to deliver `<pty_exited>` ("spawner" | "root" |
//     "both"). Upstream builds its manager options explicitly and never
//     forwards unknown args, so the per-spawn choice rides an AsyncLocalStorage
//     scope set by `registerPtyTools` around the tool call; a plain spawn with
//     no scope falls back to the configured default.
//
// Idempotent (the marker) and tolerant (a stamp failure never breaks spawning).
// ---------------------------------------------------------------------------
// Spawn-time PTY size (`pty_spawn` cols/rows)
// ---------------------------------------------------------------------------
// Upstream `session-lifecycle.spawnProcess` hardcodes `DEFAULT_TERMINAL_
// COLS/ROWS` (120x40) — there is no size option and `createSessionObject`
// drops unknown opts fields. The tool execute therefore transports the
// requested size through the same AsyncLocalStorage scope the notify target
// uses (`spawnScope.run({ notifyTarget, spawnSize }, ...)`), and this wrap-once
// installer reaches into `manager.lifecycleManager` to consume it: the
// original spawnProcess creates the PTY at the upstream default, then the
// wrapper immediately resizes it and stamps `__ptyCols/__ptyRows/__ptySizeMode
// = "fixed"` — so even the CSI 18t reply and the first `/api/sessions` push
// already report the fixed size. Runs inside the spawn call chain, so the ALS
// store is live here.
function installManagerSpawnSize(manager) {
  const lifecycle = manager?.lifecycleManager;
  if (!lifecycle || typeof lifecycle.spawnProcess !== "function") return;
  if (lifecycle.spawnProcess.__opencodePtyLocalSpawnSize) return;
  const originalSpawnProcess = lifecycle.spawnProcess.bind(lifecycle);
  const wrapped = (session) => {
    originalSpawnProcess(session);
    try {
      const size = spawnScope.getStore()?.spawnSize;
      if (!size || !session?.process) return;
      if (!applyFixedSize(session, size.cols, size.rows)) {
        console.warn(
          `[opencode-pty-extended] spawn size ignored for ${session.id}: ` +
            "cols/rows must be integers between 1 and 1000",
        );
      }
    } catch (error) {
      console.warn("[opencode-pty-extended] spawn size stamping failed:", error);
    }
  };
  wrapped.__opencodePtyLocalSpawnSize = true;
  lifecycle.spawnProcess = wrapped;
}

function installManagerSessionLineage(manager, ctx, notify) {
  if (!manager || typeof manager.spawn !== "function") return;
  if (manager.spawn.__opencodePtyLocalLineage) return;
  const originalSpawn = manager.spawn.bind(manager);
  const wrapped = (opts) => {
    const session = originalSpawn(opts);
    try {
      const parent = session?.parentSessionId;
      if (typeof parent === "string" && parent && parent !== GROUP_WEB_API_PARENT) {
        if (typeof session.rootSessionId !== "string" || !session.rootSessionId) {
          // Resolve the root asynchronously via the session store (the sync
          // walk can miss subagent sessions). Stamp it when it lands; the
          // decorated list prefers this stamped value on subsequent passes.
          asyncRootSessionId(ctx, parent)
            .then((root) => {
              if (typeof root === "string" && root) session.rootSessionId = root;
            })
            .catch(() => {});
        }
        const scope = spawnScope.getStore();
        session.notifyTarget = normalizeNotifyTarget(scope?.notifyTarget ?? notify?.target);
      }
    } catch (error) {
      console.warn("[opencode-pty-extended] failed to stamp PTY lineage:", error);
    }
    return session;
  };
  wrapped.__opencodePtyLocalLineage = true;
  manager.spawn = wrapped;
}



// ---------------------------------------------------------------------------
// TUI sidebar RPC bridge
// ---------------------------------------------------------------------------
// The sidebar (tui.tsx) renders in the CLI process while the PTY sessions live
// in this (server) process, so the CLI cannot read `manager` directly. The
// sidebar instead calls these RPC methods through the shared OpenCode client.
// Gated by the `tuiSidebar` block in opencode-pty-extended.jsonc (on by default).
// Ensures a live PTY web server that serves the *current* transformed bundle,
// and returns it. The package keeps its server in module state that can be lost
// across a hot reload (or a package-dir move), leaving an orphan bound to the
// configured port; so the wrapper tracks its own handle on `globalThis` and,
// if the configured port is still held, falls back to an ephemeral port.
async function ensurePtyWebServer(deps, options, serverSignature) {
  const g = globalThis;
  const signature = signatureValueOf(serverSignature);
  const existing = g.__opencodePtyLocalWebServer;
  if (existing && g.__opencodePtyLocalWebSignature === signature) {
    return existing;
  }

  // Drop the handle we tracked previously (signature changed or missing).
  if (existing) {
    try {
      existing[Symbol.dispose]?.();
    } catch {
      /* ignore */
    }
    g.__opencodePtyLocalWebServer = null;
    g.__opencodePtyLocalWebSignature = null;
  }

  // Create our own server so the wrapper fully owns the lifecycle: the package
  // keeps its server in module state that a hot reload can lose, orphaning the
  // configured port. If the port is held, fall back to an ephemeral one.
  let server;
  try {
    server = await deps.PTYServer.createServer(options ?? {});
  } catch (error) {
    console.warn(
      "[opencode-pty-extended] PTY web server could not bind the configured port; using an ephemeral port:",
      error,
    );
    server = await deps.PTYServer.createServer({ ...(options ?? {}), port: 0 });
  }

  g.__opencodePtyLocalWebServer = server;
  g.__opencodePtyLocalWebSignature = signature;
  return server;
}

// Opens a URL in the OS default browser WITHOUT the console-window flash the
// `open` package produces on Windows: open v11 spawns powershell.exe without
// `windowsHide` and the runtime defaults that flag to false, so the launcher's
// console window becomes briefly visible on every open. Strategy per platform:
//   win32  -> PLAIN URL (no `?query`, no `#fragment`): spawn `explorer.exe
//             <url>` (a GUI shell process, so no console can ever be created)
//             which hands the URL to the default browser — VERIFIED working
//             for plain URLs. URL WITH a query or fragment: explorer does NOT
//             recognize the argument as a URL and silently falls back to
//             opening its default folder (Documents; user-verified 2026-11-12
//             with `?test=2` AND `#test=2`) — the spawn still "succeeds",
//             which is exactly the silent left-click bug. So those URLs go
//             straight to the hidden PowerShell `Start '<url>'` (ShellExecute
//             — any URL shape, `windowsHide: true`, no flash); only if THAT
//             fails defer to the package's original opener (worst case: the
//             old flash still opens).
//   other  -> the package's opener untouched (macOS `open`, Linux `xdg-open`
//             have no console windows in the first place).
// `spawn` resolves on the 'spawn' event (process actually launched) so a
// missing/broken launcher is caught BEFORE we declare success; the electron
// bug in open/#367 does not apply (opencode's server is long-lived and we
// never rely on stdio keeping the parent alive).
async function openUrlQuiet(openUrl, url) {
  if (typeof openUrl !== "function") return undefined;
  if (process.platform !== "win32") return openUrl(url);
  const launch = (command, args, extras = {}) =>
    Promise.race([
      new Promise((win2, lose) => {
        const child = spawn(command, args, { windowsHide: true, stdio: "ignore", ...extras });
        child.once("error", lose);
        child.once("spawn", () => {
          child.off("error", lose);
          win2(child);
        });
      }),
      new Promise(
        (_, lose) =>
          setTimeout(() => lose(new Error(`${command} launcher timed out`)), 5000), // eslint-disable-line no-promise-executor-return
      ),
    ]);
  // Hidden PowerShell `Start '<url>'` (mirror of open v11's encoded-command
  // launch, UTF-16LE Base64, with the `windowsHide` flag upstream omits).
  // ShellExecute underneath, so EVERY URL shape works — including the
  // `?session=<id>` query URLs that explorer.exe silently mishandles.
  const startHidden = async () => {
    const command = `$ProgressPreference = 'SilentlyContinue'; Start '${String(url).replace(/'/g, "''")}'`;
    const encoded = Buffer.from(command, "ucs2").toString("base64");
    const child = await launch(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    );
    // Keep parity with open: wait for the launcher to close (a few hundred
    // ms) so a fast /restart can't kill it mid-handoff via the job object.
    await new Promise((win2) => {
      child.once("close", win2);
      setTimeout(win2, 3000); // eslint-disable-line no-promise-executor-return
    });
    return child;
  };
  // explorer.exe fast path ONLY for plain URLs (no `?query`, no `#fragment`):
  // with either it does not recognize the argument as a URL and just opens
  // its default folder (user-verified 2026-11-12 with ?test=2 AND #test=2).
  if (!/[?#]/.test(String(url))) {
    try {
      await launch("explorer.exe", [String(url)]);
      return undefined;
    } catch {
      /* fall through to the hidden PowerShell opener */
    }
  }
  try {
    await startHidden();
    return undefined;
  } catch (powershellError) {
    console.warn(
      "[opencode-pty-extended] hidden URL open failed; falling back to the open package (may flash a console):",
      powershellError,
    );
    return openUrl(url);
  }
}

// Ensures the web UI server and opens it in the default browser. With `id`,
// appends `?session=<id>` so the (patched) bundle selects that session.
async function openPtyWebUi(deps, options, serverSignature, id) {
  const server = await ensurePtyWebServer(deps, options, serverSignature);
  const base = String(server?.server?.url?.origin ?? "").replace(/\/$/, "");
  const url = id
    ? `${base}/index.html?session=${encodeURIComponent(id)}`
    : `${base}/index.html`;
  try {
    await openUrlQuiet(deps.openUrl, url);
  } catch (error) {
    console.warn("[opencode-pty-extended] failed to open PTY web UI:", error);
  }
  return { url, server };
}

// Best-effort web-UI server origin (null when unavailable).
function ptyWebOriginOf(server) {
  try {
    return String(server?.server?.url?.origin ?? "").replace(/\/$/, "") || null;
  } catch {
    return null;
  }
}

// Restarts the PTY stack. This is the SINGLE implementation behind the
// `pty_restart` tool, the `/pty-restart` command and the TUI dialog's
// restart offer (`PtyRpc.restart`).
//
// Scopes:
//   "soft" (default) — reload the live config (the same in-place walk the
//     /pty-config save/apply already triggers) and RECYCLE the PTY web-UI
//     server eagerly (stop the package's active server + our wrapper handle,
//     then start fresh), so the served bundle matches the current options at
//     ONCE instead of lazily on the next open. Running PTYs survive: the
//     processes are manager state in the opencode server process, NOT
//     children of the web listener.
//   "kill" — additionally kill every RUNNING PTY first (each emits its
//     `<pty_exited>` notification; the flood is accepted).
//
// Returns a summary with the fresh origin and whether the URL changed (an
// ephemeral `port: 0` server re-picking its port is the visible case).
async function ptyRestartStack(deps, live, options, serverSignature, scope) {
  const g = globalThis;
  const { manager } = deps;
  const effect = scope === "kill" ? "kill" : "soft";
  const result = {
    scope: effect,
    runningPtys: 0,
    killed: 0,
    url: null,
    urlChanged: false,
    recycled: false,
    error: null,
  };
  // Running-PTY stats (and kills for the kill scope) BEFORE any teardown, so
  // the killed rows are the ones counted. Plain kills: their <pty_exited>
  // notifications ride the exit notifier as usual (flood accepted).
  let rows = [];
  try {
    rows = manager?.list?.() ?? [];
  } catch {
    /* manager unavailable; recycle only */
  }
  const running = rows.filter((r) => String(r?.status ?? "") === "running");
  result.runningPtys = running.length;
  if (effect === "kill") {
    for (const row of running) {
      try {
        if (manager.kill(row.id, false)) result.killed += 1;
      } catch {
        /* one dead PTY must not stop the restart */
      }
    }
  }
  const before =
    ptyWebOriginOf(g.__opencodePtyLocalWebServer) ??
    ptyWebOriginOf(deps.commands?.getActiveServer?.());
  // Tear down both server homes (the wrapper-owned handle and the package's
  // module-state server), re-run the live config walk, then start fresh so
  // the URL (and its possible change) is known immediately.
  try {
    deps.commands?.stopActiveServer?.();
  } catch {
    /* ignore */
  }
  try {
    g.__opencodePtyLocalWebServer?.[Symbol.dispose]?.();
  } catch {
    /* ignore */
  }
  g.__opencodePtyLocalWebServer = null;
  g.__opencodePtyLocalWebSignature = null;
  try {
    live.reload?.();
  } catch (error) {
    result.error = `reload: ${String(error?.message ?? error).slice(0, 120)}`;
  }
  try {
    const server = await ensurePtyWebServer(deps, options, serverSignature);
    result.url = ptyWebOriginOf(server);
    result.recycled = true;
    result.urlChanged = Boolean(before && result.url && before !== result.url);
  } catch (error) {
    // Append (not overwrite): the reload error above must survive, so one
    // failed restart reports BOTH phases.
    const phase = `web server: ${String(error?.message ?? error).slice(0, 120)}`;
    result.error = result.error ? `${result.error} · ${phase}` : phase;
  }
  return result;
}

// The one-line summary both the tool result and the command message render.
// The URL is printed ONLY when it changed (see the pty_url tool otherwise).
function formatPtyRestartResult(result) {
  const bits = [];
  bits.push(result?.recycled ? "web server recycled" : "web server recycle FAILED");
  if (result?.scope === "kill") {
    bits.push(`killed ${result.killed}/${result.runningPtys} running PTY(s)`);
  } else if (result?.runningPtys > 0) {
    bits.push(`${result.runningPtys} running PTY(s) kept`);
  } else {
    bits.push("no running PTYs");
  }
  if (result?.urlChanged && result?.url) {
    bits.push(`web-UI URL (changed): ${result.url}`);
  }
  if (result?.error) bits.push(`error: ${result.error}`);
  return `PTY stack restarted: ${bits.join(" · ")}`;
}

// --- Runtime-only "show all PTYs" override (TUI sidebar visibility) --------
// State machine (user-locked 2026-11-12):
//   * The state lives in the SERVER half, on globalThis like the other shared
//     manager state (one opencode process hosts one plugin instance per
//     location; the sessions/PTYs it serves are global anyway). Both surfaces
//     reach it through the RPC bridge: the `pty_show_all_pty` tool directly
//     (it runs here) and the TUI `/pty-show-all-pty` slash command via the
//     `showAll` RPC method — one shared state, never two divergent ones.
//   * `null` = follow `tuiSidebar.filterBySession` (config);
//     `true`/`false` = explicit runtime override (wins over config).
//   * Runtime-only: NEVER written to any config file; it dies with the
//     process (a /restart resets it to "follow config").
//   * Reset: a config change of `tuiSidebar.filterBySession` (dialog Apply or
//     Save — both funnel through reloadLiveConfig) clears the override, so
//     the deliberately-set config value is the truth again.
function showAllOverride() {
  return typeof globalThis.__opencodePtyShowAllOverride === "boolean"
    ? globalThis.__opencodePtyShowAllOverride
    : null;
}
function setShowAllOverride(value) {
  globalThis.__opencodePtyShowAllOverride =
    value === true || value === false ? value : null;
}
// The visibility the sidebar should apply right now: the override when set,
// else the config value (`tuiSidebar.filterBySession`, default true = scoped).
// `tui` is the live merged settings holder (registerPtyRpc's `tui` param /
// registerPtyTools' `tuiSettings`), which reloadLiveConfig keeps fresh.
function showAllEffective(tui) {
  const override = showAllOverride();
  if (override !== null) return override;
  return (tui?.tuiSidebar?.filterBySession ?? true) !== false;
}
// Push the "settings" event so every connected TUI half re-pulls its merged
// settings (which now include the override — see registerPtyRpc's `settings`)
// and re-renders immediately. Best-effort: without the bridge (or before
// installSidebarChangeNotifier ran) the next poll picks the change up.
function emitSettingsChanged() {
  try {
    globalThis.__opencodePtyLocalEmitSettings?.();
  } catch {
    /* the event bridge is optional */
  }
}

async function registerPtyRpc(deps, ctx, options, serverSignature, tui, configHandlers, live) {
  const register = ctx?.rpc?.register;
  if (typeof register !== "function") {
    console.warn("[opencode-pty-extended] ctx.rpc unavailable; TUI sidebar disabled");
    return;
  }

  const { manager } = deps;
  try {
    // The returned registration exposes `events.emit`, which
    // installSidebarChangeNotifier uses to push live updates to the sidebar.
    // A SINGLE shared id (see shared.js PtyRpc): the rpc route resolves
    // registrations against the server-root scope, so only this id can ever
    // resolve — and it deliberately does for every location, because the
    // state it serves (sessions) and the runtime it applies over are shared
    // server state anyway.
    const registration = await register.call(ctx.rpc, PtyRpc, {
      // The fully merged, already-resolved TUI settings (config files +
      // `plugins[].options`). The TUI half cannot see `plugins[].options` on
      // its own, so it fetches them here instead. JSON round-trip so any
      // `undefined` values are dropped (the RPC body schema rejects them).
      // `showAllOverride` rides along (null = follow config): the TUI mirrors
      // it into its local signal, so the pull JSON-compare sees an override
      // change as "changed" and re-renders the scoped view.
      settings: async () =>
        JSON.parse(
          JSON.stringify({
            tuiSidebar: tui?.tuiSidebar,
            output: tui?.output,
            showAllOverride: showAllOverride(),
          }),
        ),
      // Apply-only runtime overlay for the dialog's Apply button: pushes the
      // draft values into THIS instance's running config in memory (nothing
      // is written to any file). Reads/writes of config FILES no longer ride
      // the RPC — the dialog computes those locally, because this route can
      // only ever resolve in the server-root scope (and would hand every
      // other location the root location's config layers).
      configApply: async (input) => {
        if (configHandlers?.apply) return await configHandlers.apply(input);
        return { ok: false, error: "unavailable" };
      },
      // The TUI half's presence heartbeat: stamp its open/in-view session ids
      // with the "tui" source. Stamps go stale ~3 min after the TUI stops
      // heartbeating (closed tab/process => the session leaves the dropdown).
      // The runtime-only "show all PTYs" override (see showAllOverride above):
      // read / set / clear / toggle. Setting emits the `settings` event so all
      // connected TUI halves re-pull (the changed value rides the `settings`
      // payload) and re-render — the same hot-apply path a config apply uses.
      showAll: async (input) => {
        let changed = false;
        if (input?.toggle === true) {
          const next = !showAllEffective(tui);
          changed = showAllOverride() !== next;
          setShowAllOverride(next);
        } else if (input?.value === true || input?.value === false) {
          changed = showAllOverride() !== input.value;
          setShowAllOverride(input.value);
        } else if (input?.value === null) {
          // Explicit clear: follow the config value again (the TUI slash
          // command never sends this, but the reset hook and future callers
          // can).
          changed = showAllOverride() !== null;
          setShowAllOverride(null);
        }
        const value = showAllOverride();
        const effective = showAllEffective(tui);
        if (changed) emitSettingsChanged();
        return { value, effective, source: value === null ? "config" : "override" };
      },
      present: async (input) => {
        const ids = Array.isArray(input?.ids) ? input.ids : [];
        let stamped = 0;
        for (const id of ids) {
          if (typeof id === "string" && id && id !== GROUP_WEB_API_PARENT) {
            presenceStamp(id, PRESENCE_SRC_TUI);
            stamped += 1;
          }
        }
        return { ok: true, stamped };
      },
      list: async () => {
        // `toInfo()` drops the parent, so decorate each row with the lineage the
        // TUI sidebar groups/filters on. `manager.list()` is already decorated
        // (see installManagerGroupBySession) but this keeps the fields present
        // even if that decoration were skipped (e.g. a file-config-only host).
        const rows = manager.list().map((row) => {
          const raw = manager.lifecycleManager?.getSession(row.id);
          const parent = row.parentSessionId ?? raw?.parentSessionId ?? null;
          const root =
            row.rootSessionId ?? (parent ? rootSessionId(ctx, parent) : null);
          return {
            ...row,
            parentSessionId: parent,
            initiatorSessionId: row.initiatorSessionId ?? parent,
            initiatorAgent: row.initiatorAgent ?? raw?.parentAgent ?? null,
            rootSessionId: root,
            isSubagent: row.isSubagent ?? Boolean(parent && root && root !== parent),
          };
        });
        // Round-trip through JSON so `undefined` fields (e.g. exitCode on a
        // running session) are dropped — the RPC body schema rejects them.
        return { sessions: JSON.parse(JSON.stringify(rows)) };
      },
      read: async (input) => {
        // The session's live terminal size, so the `/pty-output` viewer can
        // size its dialog from it (`cols`/`rows`). Prefer the viewer-set size
        // remembered on the session, then fall back to what ConPTY reports.
        // `manager.get()` only returns `toInfo()` (which drops these), so reach
        // the raw session through the lifecycle manager - the same accessor the
        // viewer-resize / CSI-18t hooks use.
        const session = manager.lifecycleManager?.getSession(input?.id);
        const cols = session?.__ptyCols ?? session?.process?.cols;
        const rows = session?.__ptyRows ?? session?.process?.rows;
        const buffer = manager.getRawBuffer(input?.id);
        if (!buffer) return { text: "", total: 0, cols, rows };
        // Raw output: the TUI visualizes or strips it (per `output.dialog`)
        // before display, so escape codes stay inspectable but inert.
        const text = buffer.raw;
        return { text, total: text.length, cols, rows };
      },
      write: async (input) => ({ ok: Boolean(manager.write(input?.id, input?.data ?? "")) }),
      kill: async (input) => ({ ok: Boolean(manager.kill(input?.id, input?.cleanup ?? false)) }),
      // Surface the PTY web UI. Creates the (shared) PTYServer lazily and opens
      // it in the default browser; with `id`, opens `/index.html?session=<id>`
      // so the web UI selects that session (the served bundle is patched to
      // honour the `session` query parameter - see applySelectSessionToJs).
      openWeb: async (input) => {
        const id = typeof input?.id === "string" && input.id ? input.id : null;
        // `open: false` = URL-only: ensure/start the server, never launch a
        // browser (the TUI `/pty-show-server-url` command's show-not-open).
        if (input?.open === false) {
          const server = await ensurePtyWebServer(deps, options, serverSignature);
          const url = String(server?.server?.url?.origin ?? "").replace(/\/$/, "");
          return { ok: true, url, opened: false, message: `PTY Sessions Web Interface URL: ${url}` };
        }
        const { url } = await openPtyWebUi(deps, options, serverSignature, id);
        return { ok: true, url, message: `PTY Sessions Web Interface opened at: ${url}` };
      },
      // Restart the PTY stack (see ptyRestartStack): live-config reload +
      // EAGER web-UI server recycle. `scope: "kill"` additionally kills every
      // RUNNING PTY first. The dialog's post-save restart offer, the
      // /pty-restart command and the pty_restart tool all land here.
      restart: async (input) => {
        const result = await ptyRestartStack(
          deps,
          live,
          options,
          serverSignature,
          input?.scope === "kill" ? "kill" : "soft",
        );
        // JSON round-trip so the plain object carries no undefined values.
        return JSON.parse(JSON.stringify(result));
      },
    });
    return registration;
  } catch (error) {
    console.warn("[opencode-pty-extended] failed to register PTY RPC:", error);
    return null;
  }
}

// Pushes a `changed` event to the TUI sidebar whenever the session list
// changes (spawn, exit, kill, clear), so the sidebar refreshes immediately
// instead of waiting for its poll. The registration is replaced on hot reload,
// so the current emitter is kept on globalThis and the manager hooks always
// call the latest one. Emits are coalesced because a burst (e.g. clearing many
// sessions at once) would otherwise fire one event per session.
function installSidebarChangeNotifier(deps, registration) {
  const g = globalThis;

  const emitChanged = () => {
    try {
      registration?.events?.emit?.("changed", {});
    } catch (error) {
      console.warn("[opencode-pty-extended] failed to emit sidebar change:", error);
    }
  };
  g.__opencodePtyLocalEmitChanged = emitChanged;

  // The registration is replaced whenever the plugin (re)loads, so follow the
  // same globalThis indirection for the `settings` event: after every live
  // config reload (dialog apply / save / pty_refresh / pty_restart) each
  // connected TUI half re-pulls its settings and re-renders (see tui.tsx).
  g.__opencodePtyLocalRegistration = registration;
  g.__opencodePtyLocalEmitSettings = () => {
    try {
      g.__opencodePtyLocalRegistration?.events?.emit?.("settings", {});
    } catch (error) {
      console.warn("[opencode-pty-extended] failed to emit settings change:", error);
    }
  };

  const schedule = () => {
    if (g.__opencodePtyLocalEmitTimer) return;
    g.__opencodePtyLocalEmitTimer = setTimeout(() => {
      g.__opencodePtyLocalEmitTimer = null;
      g.__opencodePtyLocalEmitChanged?.();
    }, 50);
  };

  const { manager, registerSessionUpdateCallback } = deps;

  // Spawns and exits already notify the session-update callbacks; hook them
  // once (the global indirection above keeps the emitter current on reload).
  if (
    g.__opencodePtyLocalSessionUpdateHooked !== true &&
    typeof registerSessionUpdateCallback === "function"
  ) {
    registerSessionUpdateCallback(() => schedule());
    g.__opencodePtyLocalSessionUpdateHooked = true;
  }

  // Kills do not notify the callbacks, so wrap the lifecycle kill (idempotent).
  const lifecycle = manager?.lifecycleManager;
  if (
    lifecycle &&
    typeof lifecycle.kill === "function" &&
    !lifecycle.kill.__opencodePtyLocalWrapped
  ) {
    const originalKill = lifecycle.kill.bind(lifecycle);
    lifecycle.kill = (id, cleanup = false) => {
      const result = originalKill(id, cleanup);
      schedule();
      return result;
    };
    lifecycle.kill.__opencodePtyLocalWrapped = true;
  }
}


// Loads the installed package once, resolving relative to this plugin (so its
// own dependencies like `bun-pty`, `open` and `zod` are found). BASE is the
// node_modules folder that actually holds the package (see BASE_CANDIDATES).
function loadPackage() {
  if (!depsPromise) {
    depsPromise = (async () => {
      const pty = `${BASE}/opencode-pty/dist/src`;
      const [
        { Plugin: PTYPlugin },
        { ptyTools },
        { tool },
        { manager, registerSessionUpdateCallback },
        { NotificationManager },
        { formatSessionInfo },
        { DEFAULT_READ_LIMIT },
        commands,
        { PTYServer },
        { buildStaticRoutes },
        { default: openUrl },
      ] = await Promise.all([
        import(`${pty}/v2/index.js`),
        import(`${pty}/v2/tools.js`),
        import(`${BASE}/@opencode-ai/plugin/dist/index.js`),
        import(`${pty}/plugin/pty/manager.js`),
        import(`${pty}/plugin/pty/notification-manager.js`),
        import(`${pty}/plugin/pty/formatters.js`),
        import(`${pty}/shared/constants.js`),
        import(`${pty}/v2/commands.js`),
        import(`${pty}/web/server/server.js`),
        import(`${pty}/web/server/handlers/static.js`),
        import(`${BASE}/open/index.js`),
      ]);
      return {
        PTYPlugin,
        ptyTools,
        tool,
        manager,
        registerSessionUpdateCallback,
        NotificationManager,
        formatSessionInfo,
        DEFAULT_READ_LIMIT,
        commands,
        PTYServer,
        buildStaticRoutes,
        openUrl,
      };
    })();
  }
  return depsPromise;
}

// Converts the V1 `args` (Zod raw shape) into a JSON Schema accepted by the v2
// `Tool.Info.input` (which allows a plain JsonSchema value).
function buildInputSchema(tool, definition, name, argDefaults) {
  let schema;
  try {
    schema = tool.schema.toJSONSchema(tool.schema.object(definition.args));
  } catch (error) {
    console.warn(`[opencode-pty-extended] could not build input schema for ${name}; using permissive schema`, error);
    schema = { type: "object", additionalProperties: true };
  }

  const defaults = argDefaults?.[name];
  if (defaults && schema && typeof schema === "object" && schema.properties) {
    for (const [key, value] of Object.entries(defaults)) {
      if (schema.properties[key]) {
        schema.properties[key] = { ...schema.properties[key], default: value };
      }
    }
  }

  return schema;
}

// Declares the extra `pty_list` arguments. The package's own `pty_list` takes no
// arguments, so this widens the generated schema with the session-scoping
// options the wrapper adds at runtime.
function withPtyListArgs(schema) {
  const base = schema && typeof schema === "object" ? schema : {};
  const properties = { ...(base.properties ?? {}) };
  properties.sessionID = {
    type: "string",
    description:
      "opencode conversation session id to scope the listing to (not a PTY " +
      'session id, which always looks like "pty_..."). Use "*" to list every ' +
      "session. Omit it to list the current conversation's PTYs and a compact " +
      "summary of the others.",
  };
  properties.all = {
    type: "boolean",
    description: "Set true to list every PTY session, ignoring the session scope.",
  };
  return { ...base, type: base.type ?? "object", properties };
}

// Declares the extra `pty_spawn` argument the wrapper adds: `notifyTarget`. The
// package's own schema is widened with it (and the wrapper strips it before
// calling upstream, which would ignore it anyway and never forward it to the
// manager). Its description deliberately prefers the default ("spawner") so a
// subagent that spawns a PTY gets the exit notification back.
function withPtySpawnArgs(schema, defaultValue) {
  const base = schema && typeof schema === "object" ? schema : {};
  const properties = { ...(base.properties ?? {}) };
  properties.notifyTarget = {
    type: "string",
    enum: ["spawner", "root", "both"],
    ...(typeof defaultValue === "string" ? { default: defaultValue } : {}),
    description:
      "Only when notifyOnExit is true: where to deliver this PTY's " +
      "<pty_exited> notification. \"spawner\" (default) sends it to the session " +
      "that called pty_spawn — prefer this, so a subagent that started the " +
      "process is told when it finishes; \"root\" sends it to the top-level " +
      "conversation; \"both\" sends it to each distinct target. Omit to use the " +
      "configured notify.target.",
  };
  // Fixed spawn size. Both axes must be passed together (a missing axis is
  // filled from the default); when set, the PTY spawns at exactly this size
  // and its web-UI size control starts in "fixed" mode.
  properties.cols = {
    type: "integer",
    minimum: 1,
    maximum: 1000,
    description:
      "Terminal width in character cells (columns). Pass together with `rows` " +
      "to spawn the PTY at a fixed size (e.g. cols=80, rows=24 for a classic " +
      "console layout) — the web UI then shows that session's size control in " +
      '"fixed" mode. Omit both to spawn at the default 120x40 with "auto" size.',
  };
  properties.rows = {
    type: "integer",
    minimum: 1,
    maximum: 1000,
    description:
      "Terminal height in text lines (rows). Pass together with `cols` " +
      "to spawn the PTY at a fixed size (e.g. cols=80, rows=24) — the web UI " +
      "then shows that session's size control in \"fixed\" mode. Omit both to " +
      "spawn at the default 120x40 with \"auto\" size.",
  };
  return { ...base, type: base.type ?? "object", properties };
}

// The opencode sessions whose PTYs belong to `sessionID`: the session itself and
// (best effort) its subagent descendants. The server-side plugin context has no
// guaranteed session store, so this tries the CLI `context.data.session` helpers
// and otherwise falls back to the exact session id.
function ptyListScopeIds(ctx, sessionID) {
  const ids = new Set([sessionID]);
  try {
    const family = ctx?.data?.session?.family?.(sessionID);
    if (Array.isArray(family)) {
      for (const entry of family) {
        const id = typeof entry === "string" ? entry : entry?.id;
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  } catch {
    /* no session store; exact match only */
  }
  try {
    const list = ctx?.data?.session?.list?.();
    if (Array.isArray(list) && list.length > 0) {
      // Index children by parent so the current session's whole subtree can be
      // walked (subagent sessions spawn their own PTYs too).
      const children = new Map();
      for (const entry of list) {
        const parent = entry?.parentID ?? entry?.parentId;
        const id = entry?.id;
        if (typeof parent === "string" && parent && typeof id === "string" && id) {
          const bucket = children.get(parent);
          if (bucket) bucket.push(id);
          else children.set(parent, [id]);
        }
      }
      const queue = [sessionID];
      while (queue.length > 0) {
        const current = queue.pop();
        for (const child of children.get(current) ?? []) {
          if (!ids.has(child)) {
            ids.add(child);
            queue.push(child);
          }
        }
      }
    }
  } catch {
    /* no session store; keep the family/exact-match result */
  }
  return ids;
}

// A one-line summary used by the "other sessions" section of `pty_list`, so the
// agent can still discover (and then `pty_read` / `pty_kill`) PTYs that belong
// to a different opencode conversation. Takes the same `row` object the full
// block uses so the fields can mirror it: field order = PID -> Size ->
// Initiator -> Root (root only when it differs from the initiator). PID is
// informational — stale or recycled once the process exited — but is ALWAYS
// shown when the platform reported one, exited sessions included
// (user-locked 2026-11-12, option A).
function formatCompactSession(row) {
  const info = row?.info ?? row;
  const title = info?.title || info?.command || info?.id;
  const status = info?.status ?? "unknown";
  const exit =
    info?.exitCode !== undefined && info?.exitCode !== null ? ` (exit ${info.exitCode})` : "";
  const pid = Number.isInteger(info?.pid) ? ` · PID ${info.pid}` : "";
  const size =
    Number.isInteger(info?.cols) && Number.isInteger(info?.rows)
      ? ` · ${info.cols}x${info.rows} ${info.sizeMode ?? "auto"}`
      : "";
  const initiator = row?.initiator
    ? ` · Initiator: ${row.initiator}${row.agent ? ` (${row.agent})` : ""}`
    : "";
  const root = row?.root && row.root !== row.initiator ? ` → root: ${row.root}` : "";
  return `[${info?.id}] ${title} — ${status}${exit}${pid}${size}${initiator}${root}`;
}

// Builds the `pty_list` output. The wrapper adds session scoping on top of the
// package's flat list:
//   * no `sessionID`  -> the calling opencode session's PTYs in full, plus a
//                        compact summary of every other session (so the agent is
//                        never blind to a PTY it may still need);
//   * `sessionID: id` -> only that opencode session's PTYs, in full;
//   * `sessionID: "*"` / `all: true` -> every PTY, in full.
// A `sessionID` that looks like a PTY id (`pty_...`) is treated as a lookup of
// that single PTY.
function formatPtyList(manager, formatSessionInfo, args, ctx) {
  const rows = manager.list().map((info) => {
    const raw = manager.lifecycleManager?.getSession(info.id);
    const initiator = info.initiatorSessionId ?? raw?.parentSessionId ?? null;
    const agent = info.initiatorAgent ?? raw?.parentAgent ?? null;
    const root = info.rootSessionId ?? (initiator ? rootSessionId(ctx, initiator) : null);
    return {
      info,
      parent: initiator,
      initiator,
      root,
      agent,
      // Size fields from the decorated list (see installManagerGroupBySession)
      // with the raw session as fallback.
      sizeMode: info.sizeMode ?? sessionSizeState(raw).mode,
      cols: info.cols ?? sessionSizeState(raw).cols,
      rows: info.rows ?? sessionSizeState(raw).rows,
    };
  });

  // The package's own per-session block, plus the wrapper's lineage lines so the
  // agent can tell which conversation (and subagent) a PTY belongs to.
  const sessionBlock = (row) => {
    const block = formatSessionInfo(row.info);
    const lines = [...(Array.isArray(block) ? block : [block])];
    if (Number.isInteger(row.cols) && Number.isInteger(row.rows)) {
      // Inserted before the wrapper's lineage lines, right after the struct
      // (ID/Command/Status/PID/Lines/Workdir/Created) — always XxY mode.
      lines.splice(
        Math.max(1, lines.length - 1),
        0,
        `  Size: ${row.cols}x${row.rows} (${row.sizeMode ?? "auto"})`,
      );
    }
    if (!row.initiator) return lines;
    lines.push(`Initiator: ${row.initiator}${row.agent ? ` (${row.agent})` : ""}`);
    if (row.root && row.root !== row.initiator) lines.push(`Root: ${row.root}`);
    return lines;
  };

  if (rows.length === 0) {
    return "<pty_list>\nNo active PTY sessions.\n</pty_list>";
  }

  const raw = typeof args?.sessionID === "string" ? args.sessionID.trim() : "";

  // Allow a bare PTY id as a convenience, even though the argument is documented
  // as an opencode session id.
  if (raw.startsWith("pty_")) {
    const row = rows.find((entry) => entry.info.id === raw);
    if (!row) return `<pty_list>\nNo PTY session '${raw}'.\n</pty_list>`;
    return ["<pty_list>", ...sessionBlock(row), "</pty_list>"].join("\n");
  }

  const wantAll = args?.all === true || raw === "*";
  const explicit = raw && raw !== "*" ? raw : null;
  const caller = typeof ctx?.sessionID === "string" && ctx.sessionID ? ctx.sessionID : null;
  const lines = ["<pty_list>"];

  // Every PTY, in full. Also the fallback when no scope is known at all.
  if (wantAll || (!explicit && !caller)) {
    for (const row of rows) lines.push(...sessionBlock(row));
    lines.push(`Total: ${rows.length} session(s)`);
    lines.push("</pty_list>");
    return lines.join("\n");
  }

  const target = explicit ?? caller;
  const scope = ptyListScopeIds(ctx, target);
  const mine = rows.filter((row) => row.parent && scope.has(row.parent));

  if (mine.length === 0) {
    lines.push("No PTY sessions for this conversation.");
  } else {
    for (const row of mine) lines.push(...sessionBlock(row));
    lines.push(`Total: ${mine.length} session(s)`);
  }

  // Only the default (no explicit id) appends the "other sessions" summary.
  if (!explicit) {
    const others = rows.filter((row) => !mine.includes(row));
    if (others.length > 0) {
      lines.push("");
      lines.push("");
      lines.push(`Other sessions (${others.length}):`);
      for (const row of others) lines.push(formatCompactSession(row));
    }
  }

  lines.push("</pty_list>");
  return lines.join("\n");
}

// `pty_write` carries the upstream description verbatim, but it only documents
// keys and text — the same stdin bytes also deliver SGR mouse events (clicks,
// wheel, motion) to any application that enabled mouse reporting, and an agent
// can drive mouse-driven TUIs without a real mouse by writing those sequences.
// This is a full replacement (not an append): the upstream "Use this tool to"
// list gains the mouse bullet, and a reference block documents the SGR format.
// Every sequence is shown as LITERAL TEXT (`\x1b` in this source renders
// `\x1b` in the description - note the double backslash in the template
// literal below) because upstream `write.js` parses `\xNN`/`\n\r\t` escape
// sequences out of `data` before writing, so agents can copy them verbatim.
const PTY_WRITE_DESCRIPTION = `Sends input data to an active PTY session.

Use this tool to:
- Type commands or text into an interactive terminal
- Send special key sequences (Ctrl+C, Enter, arrow keys, etc.)
- Respond to prompts in interactive programs
- Send mouse events (clicks, wheel, motion) to applications
  that have enabled SGR mouse reporting

Usage:
- \`id\`: The PTY session ID (from pty_spawn or pty_list)
- \`data\`: The input to send (text, commands, or escape sequences)

Common escape sequences:
- Enter/newline: "\\n" or "\\r"
- Ctrl+C (interrupt): "\\x03"
- Ctrl+D (EOF): "\\x04"
- Ctrl+Z (suspend): "\\x1a"
- Tab: "\\t"
- Arrow Up: "\\x1b[A"
- Arrow Down: "\\x1b[B"
- Arrow Right: "\\x1b[C"
- Arrow Left: "\\x1b[D"

Mouse events (SGR encoding, mode 1006): the application only
treats these as mouse input when it has enabled mouse reporting;
otherwise the bytes arrive as plain garbage input.
- Format: "\\x1b[<b;x;yM" = button press, "\\x1b[<b;x;ym" = button
  release, where b = button code, x = column (1-based),
  y = row (1-based). Example: "\\x1b[<0;24;12M" = LEFT button
  pressed at column 24, row 12.
- Buttons: 0 left, 1 middle, 2 right
  (+4 shift, +8 meta, +32 ctrl on the code)
- Wheel: 64 up, 65 down, 66 left, 67 right
- Motion while a button is held: button code +32
- Motion without a button (hover, mode 1003 only): 35
- Most UIs act on press AND release: a right-click is typically
  "\\x1b[<2;24;12M" followed by "\\x1b[<2;24;12m". Both go in ONE
  data string: "\\x1b[<2;24;12M\\x1b[<2;24;12m".

Returns success or error message.

Examples:
- Send a command: data="ls -la\\n"
- Interrupt a process: data="\\x03"
- Answer a prompt: data="yes\\n"
- Left-click at column 24, row 12: data="\\x1b[<0;24;12M"
- Scroll up at the same cell: data="\\x1b[<64;24;12M"`;

// Registers the five pty tools via the v2 tool transform.
function registerPtyTools({ tool, ptyTools, manager, formatSessionInfo }, ctx, argDefaults, output, tuiSettings) {
  if (!ctx?.tool || typeof ctx.tool.transform !== "function") {
    console.warn("[opencode-pty-extended] ctx.tool.transform unavailable; pty tools not registered");
    return Promise.resolve();
  }

  // `argDefaults` is passed in prebuilt (Plugin.setup builds it with
  // buildArgDefaults) so the /pty-config hot reload can refresh the same
  // object in place — the per-execute merge below and these schema defaults
  // then follow live config changes without re-registering the tools.
  // `output.tool.stripAnsiSequences` only ever strips (when true). When false
  // the tool output stays raw, so the agent still gets the real content.
  // Read per execute so a config save applies without a restart.
  const stripToolAnsi = () => output?.tool?.stripAnsiSequences === true;

  return ctx.tool.transform((draft) => {
    if (typeof draft.add !== "function") return;

    for (const [name, definition] of Object.entries(ptyTools)) {
      // `pty_list` is the only tool the wrapper re-implements: the package's own
      // version lists every PTY in the shared manager, while the wrapper scopes
      // it to the calling opencode session (see formatPtyList) and widens its
      // schema with the `sessionID` / `all` arguments.
      const isList = name === "pty_list" && manager && typeof formatSessionInfo === "function";
      // `pty_spawn` is widened with `notifyTarget` and gets its `workdir`
      // resolved against the project directory (upstream passes `workdir`
      // through untouched and never resolves relative paths).
      const isSpawn = name === "pty_spawn";
      draft.add({
        name,
        description: isList
          ? `${definition.description}\n\nOptionally pass "sessionID" to list only the PTY sessions spawned by that opencode session (or "*" for every session). Omitted, it lists the current conversation's PTYs plus a compact summary of the others.`
          : name === "pty_write" && PTY_WRITE_DESCRIPTION
            ? PTY_WRITE_DESCRIPTION
            : name === "pty_spawn"
              ? `${definition.description}\n\nTerminal Size:\n- Omit \`cols\`/\`rows\` to spawn at the default 120x40 ("auto" size; the web UI auto-fits it to the viewer)\n- Pass \`cols\` AND \`rows\` (integers 1..1000) to spawn at a fixed size (e.g. cols=80, rows=24) — the PTY stays at that size and the web UI shows that session's size control in "fixed" mode\n- \`pty_size_get\` reads a session's size and sizeMode; \`pty_size_set\` changes it later`
              : definition.description,
        input: isList
          ? withPtyListArgs(buildInputSchema(tool, definition, name, argDefaults))
          : isSpawn
            ? withPtySpawnArgs(
                buildInputSchema(tool, definition, name, argDefaults),
                argDefaults?.pty_spawn?.notifyTarget,
              )
            : buildInputSchema(tool, definition, name, argDefaults),
        execute: async (args, context) => {
          // Apply the configured defaults for omitted arguments (explicit args
          // win). This is what makes `argDefaults` a real runtime default, not
          // just a schema hint.
          const merged = { ...(argDefaults?.[name] ?? {}), ...(args ?? {}) };
          if (isList) return { content: formatPtyList(manager, formatSessionInfo, merged, context) };

          if (isSpawn) {
            // Resolve `workdir` against the project directory: upstream passes
            // it through untouched and defaults a missing one to `process.cwd()`
            // (see PR #72). Prefer a `directory` on the tool context (a fixed
            // upstream would provide it), else the plugin instance's project.
            const directory =
              (typeof context?.directory === "string" && context.directory) ||
              (typeof ctx?.location?.directory === "string" && ctx.location.directory) ||
              process.cwd();
            merged.workdir = resolve(
              directory,
              typeof merged.workdir === "string" ? merged.workdir : "",
            );
            // The per-spawn notify target and the requested fixed size ride an
            // AsyncLocalStorage scope the wrapped manager.spawn /
            // lifecycle.spawnProcess read (upstream never forwards unknown
            // args), then are stripped so they cannot reach upstream.
            const target = normalizeNotifyTarget(merged.notifyTarget);
            delete merged.notifyTarget;
            const sizeReq = parseSizeRequest(
              merged.cols,
              merged.rows,
              DEFAULT_SPAWN_COLS,
              DEFAULT_SPAWN_ROWS,
            );
            const spawnSize = sizeReq.ok ? { cols: sizeReq.cols, rows: sizeReq.rows } : null;
            delete merged.cols;
            delete merged.rows;
            // Invalid dimensions degrade to the default size (never an error):
            // the schema documents 1..1000, so a stale/odd caller still spawns.
            const result = await spawnScope.run(
              { notifyTarget: target, spawnSize },
              () => definition.execute(merged, { ...context, directory }),
            );
            const text = typeof result === "string" ? result : result?.output;
            // Surface the actual size in the <pty_spawned> block so the agent
            // immediately knows the dimensions it is talking to.
            const matchedId = /\bpty_[0-9a-f]+\b/.exec(text ?? "");
            const spawnedRaw = matchedId ? manager?.lifecycleManager?.getSession(matchedId[0]) : null;
            const spawnedSize = spawnedRaw ? sessionSizeState(spawnedRaw) : null;
            const enriched = enrichSpawnedOutput(text, ctx, context, spawnedSize);
            if (typeof result === "string") return { content: enriched ?? result };
            if (result && typeof result === "object" && typeof result.output === "string") {
              return {
                ...result,
                output: enriched ?? result.output,
                content: enriched ?? result.output,
                ...(result.metadata ? { metadata: result.metadata } : {}),
              };
            }
            return result;
          }

          const result = await definition.execute(merged, context);
          // Only `pty_read` returns a raw buffer; strip it when configured.
          const render = (text) =>
            name === "pty_read" && stripToolAnsi() ? sanitizeOutputText(text, { stripAnsiSequences: true }) : text;
          if (typeof result === "string") return { content: render(result) };
          // V1 returns { title, output, metadata }; v2 renders `content`.
          if (result && typeof result === "object" && typeof result.output === "string") {
            return {
              content: render(result.output),
              ...(result.metadata ? { metadata: result.metadata } : {}),
            };
          }
          return result;
        },
      });
    }

    // Wrapper-only tool: pty_show_all_pty. Runtime-only visibility override
    // for the TUI sidebar (state + reset semantics: see showAllOverride
    // above). `read` is the default (per user-locked design: the tool reports
    // unless explicitly told to change), while the TUI /pty-show-all-pty
    // slash command toggles. Setting the state emits the `settings` event so
    // every connected TUI half re-pulls and re-renders immediately.
    draft.add({
      name: "pty_show_all_pty",
      description:
        "Reads or changes which opencode sessions' PTYs the TUI sidebar shows " +
        '(runtime override; never written to config). "read" (default) reports ' +
        "the current visibility and which layer decides it (runtime override vs " +
        "tuiSidebar.filterBySession config). \"on\" shows EVERY session's PTYs " +
        '(grouped per owning session, other sessions dimmed); "off" shows only ' +
        "the viewed session's PTYs (+ its subagents). A config change of " +
        "tuiSidebar.filterBySession resets the override.",
      input: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["read", "on", "off"],
            description:
              '"read" (default): report the current state. ' +
              '"on" / "off": set the runtime override.',
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const state =
          args?.state === "on" || args?.state === "off" || args?.state === "read"
            ? args.state
            : "read";
        if (state === "on" || state === "off") {
          const next = state === "on";
          if (showAllOverride() !== next) {
            setShowAllOverride(next);
            emitSettingsChanged();
          }
        }
        const override = showAllOverride();
        const effective = showAllEffective(tuiSettings);
        return {
          content:
            "<pty_show_all_pty>\n" +
            `effective: ${effective ? "on (showing every session's PTYs)" : "off (current session only)"}\n` +
            `override: ${override === null ? "none" : String(override)}\n` +
            `source: ${override === null ? "config (tuiSidebar.filterBySession)" : "runtime override (config unchanged)"}\n` +
            "</pty_show_all_pty>",
        };
      },
    });

    // Wrapper-only tools: pty_size_set / pty_size_get. The fixed/auto size mode
    // lives on the raw session (stamped by the size-mode envelope / spawn) and
    // is exposed through the decorated `manager.list()` rows; these tools are
    // the structured agent surface for it.
    if (manager) {
      draft.add({
        name: "pty_size_set",
        description:
          "Sets a PTY session's size mode: \"auto\" (the web UI viewer " +
          "auto-fits the PTY to the browser window; until the next fit the PTY " +
          "keeps its current size) or \"fixed\" (pins the PTY to an explicit " +
          "cols x rows cell size immediately). Requires a running process. " +
          "Read the current state with pty_size_get.",
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "PTY session id (pty_...) to resize.",
            },
            mode: {
              type: "string",
              enum: ["auto", "fixed"],
              description:
                '"auto": release a fixed-size pin and follow the viewer again. ' +
                '"fixed": resize to cols/rows now (either axis may be omitted ' +
                "to keep the session's current value).",
            },
            cols: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              description: "New terminal width in character cells (fixed mode only).",
            },
            rows: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              description: "New terminal height in text lines (fixed mode only).",
            },
          },
          required: ["id", "mode"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const id = typeof args?.id === "string" ? args.id.trim() : "";
          const mode = args?.mode === "auto" || args?.mode === "fixed" ? args.mode : null;
          const session = id ? manager.lifecycleManager?.getSession(id) : null;
          if (!session?.process) {
            return { content: `<pty_size_set>\nError: no running PTY session '${id || "?"}'.\n</pty_size_set>` };
          }
          if (!mode) {
            return {
              content:
                "<pty_size_set>\nError: mode must be \"auto\" or \"fixed\".\n</pty_size_set>",
            };
          }
          if (mode === "auto") {
            setSizeModeAuto(session);
            const cur = sessionSizeState(session);
            return {
              content:
                `<pty_size_set>\nOK: ${id} -> auto ` +
                `(current size ${cur.cols ?? "?"}x${cur.rows ?? "?"}; the web UI ` +
                "viewer resizes it on the next window fit)\n</pty_size_set>",
            };
          }
          const cur = sessionSizeState(session);
          const req = parseSizeRequest(
            args?.cols,
            args?.rows,
            Number.isInteger(cur.cols) ? cur.cols : DEFAULT_SPAWN_COLS,
            Number.isInteger(cur.rows) ? cur.rows : DEFAULT_SPAWN_ROWS,
          );
          if (!req.ok) {
            return {
              content:
                "<pty_size_set>\nError: fixed mode needs integer cols/rows " +
                "between 1 and 1000 (an omitted axis keeps the session's " +
                "current value).\n</pty_size_set>",
            };
          }
          const applied = applyFixedSize(session, req.cols, req.rows);
          if (!applied) {
            return {
              content:
                `<pty_size_set>\nError: resizing ${id} to ${req.cols}x${req.rows} failed.\n</pty_size_set>`,
            };
          }
          return {
            content: `<pty_size_set>\nOK: ${id} -> fixed ${req.cols}x${req.rows}\n</pty_size_set>`,
          };
        },
      });

      draft.add({
        name: "pty_size_get",
        description:
          "Reads a PTY session's current size and size mode. With `id`, returns " +
          "that session's exact cols, rows and sizeMode (\"auto\" = the web UI " +
          'viewer auto-fits / follows the browser window; "fixed" = pinned to ' +
          "an explicit size, e.g. by pty_spawn cols/rows or pty_size_set). " +
          "Without `id`, returns every PTY session, one line each.",
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "PTY session id (pty_...). Omit to list all sessions.",
            },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const id = typeof args?.id === "string" ? args.id.trim() : "";
          const line = (entry) => {
            const raw = manager.lifecycleManager?.getSession(entry?.id);
            const st = sessionSizeState(raw);
            return (
              `${entry?.id} — ${entry?.title ?? "?"} — ` +
              `${st.cols ?? "?"}x${st.rows ?? "?"} — ${st.mode}`
            );
          };
          if (id) {
            const raw = manager.lifecycleManager?.getSession(id);
            if (!raw?.process) {
              return { content: `<pty_size>\nNo running PTY session '${id}'.\n</pty_size>` };
            }
            return { content: `<pty_size>\n${line({ id, title: raw.title })}\n</pty_size>` };
          }
          const list = manager.list();
          if (list.length === 0) {
            return { content: "<pty_size>\nNo active PTY sessions.\n</pty_size>" };
          }
          return {
            content: ["<pty_size>", ...list.map(line), "</pty_size>"].join("\n"),
          };
        },
      });
    }
  });
}

// Registers the extra `pty_url` tool (not part of the package's ptyTools). It is
// the tool counterpart of the `/pty-show-server-url` command, so the agent can
// obtain the URL itself — starting the PTY web server on demand — instead of
// asking the user to run a command. It also documents and supports direct
// session selection. URL formats:
//
//   http://[::1]:58858                              (no id; server origin)
//   http://[::1]:58858/index.html?session=pty_8b... (with id; session selected)
//
// The `/index.html?session=<id>` form only selects the session because the
// served bundle is patched by applySelectSessionToJs (always applied).
function registerPtyUrlTool(deps, ctx, options, serverSignature) {
  if (!ctx?.tool || typeof ctx.tool.transform !== "function") {
    console.warn("[opencode-pty-extended] ctx.tool.transform unavailable; pty_url tool not registered");
    return Promise.resolve();
  }

  return ctx.tool.transform((draft) => {
    if (typeof draft.add !== "function") return;

    draft.add({
      name: "pty_url",
      description:
        "Get the URL of the PTY Sessions Web Interface, starting the web server " +
        "if it is not already running. Without `id` this returns the server origin " +
        "(e.g. http://[::1]:58858). Pass the `id` of a PTY session to get a URL that " +
        "selects it directly: http://[::1]:58858/index.html?session=pty_8b344e50.",
      input: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "PTY session id (pty_...). When set, the returned URL selects that " +
              "session with ?session=<id> for direct session selection.",
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = typeof args?.id === "string" && args.id ? args.id : null;
        try {
          const server = await ensurePtyWebServer(deps, options, serverSignature);
          const base = String(server?.server?.url?.origin ?? "").replace(/\/$/, "");
          const url = id
            ? `${base}/index.html?session=${encodeURIComponent(id)}`
            : base;
          return { content: url, metadata: { url, sessionID: id } };
        } catch (error) {
          return {
            content: `Failed to get PTY Sessions Web Interface URL: ${
              error?.message ?? error
            }`,
          };
        }
      },
    });
  });
}

// (Removed 2026-11-12: registerPtyCommands.) The `/pty-open-background-spy`
// and `/pty-show-server-url` slash commands used to be registered here, in the
// core prompt-command layer. Newer opencode builds treat that layer's commands
// as argumentative: selecting one filled the input and waited for Enter, and —
// once the TUI keymap layer gained direct-executing twins of the same names —
// both showed up TWICE in the slash menu. The keymap layer (tui.tsx) is the
// only registration now; non-TUI clients reach the same actions through the
// `pty_url` tool or the web UI itself.

// Registers the `pty_restart` tool: one line entry point over
// ptyRestartStack (soft by default; scope="kill" is the explicit opt-in).
// The fresh web-UI URL is included in the result text WHEN it changed, so
// the running LLM session learns the new origin without a follow-up pty_url.
function registerPtyRestartTool(deps, ctx, live, options, serverSignature) {
  if (!ctx?.tool || typeof ctx.tool.transform !== "function") {
    console.warn("[opencode-pty-extended] ctx.tool.transform unavailable; pty_restart tool not registered");
    return Promise.resolve();
  }
  return ctx.tool.transform((draft) => {
    if (typeof draft.add !== "function") return;
    draft.add({
      name: "pty_restart",
      description:
        "Restart the PTY stack: reload the plugin's live config (config files + runtime overrides) and " +
        "recycle the PTY web-UI server, so the served web UI (font, port, host, every webUi.* option) is " +
        "rebuilt from the current options immediately instead of lazily. PTY sessions survive by default; " +
        "pass scope=\"kill\" (only when explicitly asked) to kill every running PTY first — each emits " +
        "its <pty_exited> notification. If the web-UI URL changed (e.g. an ephemeral port was re-picked), " +
        "the fresh URL is included in the result.",
      input: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["soft", "kill"],
            description:
              "\"soft\" (default; preferred) recycles only the web-UI server and keeps running PTYs; " +
              "\"kill\" additionally kills every RUNNING PTY first (destructive). Omit for soft.",
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const scope = args?.scope === "kill" ? "kill" : "soft";
        try {
          const result = await ptyRestartStack(deps, live, options, serverSignature, scope);
          return { content: formatPtyRestartResult(result), metadata: result };
        } catch (error) {
          return {
            content: `pty_restart failed: ${error?.message ?? error}`,
          };
        }
      },
    });
  });
}

// Registers the `pty_refresh` tool: reload the live config (config files +
// runtime overrides) and push the `settings` event, so every connected TUI
// sidebar re-pulls its merged settings and re-renders immediately. This is the
// tool-side equivalent of the TUI's `/pty-refresh` command for config keys —
// it does NOT touch the web-UI server (that's `pty_restart`, which also
// recomputes the bundle signature and recycles a serving server).
function registerPtyRefreshTool(deps, ctx, live) {
  if (!ctx?.tool || typeof ctx.tool.transform !== "function") {
    console.warn("[opencode-pty-extended] ctx.tool.transform unavailable; pty_refresh tool not registered");
    return Promise.resolve();
  }
  return ctx.tool.transform((draft) => {
    if (typeof draft.add !== "function") return;
    draft.add({
      name: "pty_refresh",
      description:
        "Refresh the PTY plugin's live config in memory: re-read the config files, re-apply the runtime " +
        "overrides and push the result to every connected TUI sidebar (tuiSidebar.* / output.* keys take " +
        "effect immediately). Does NOT recycle the PTY web-UI server — call pty_restart when web-server or " +
        "restart-flagged config keys must take effect.",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        try {
          if (typeof live.reload === "function") {
            live.reload();
            return {
              content: "PTY live config reloaded (files re-read, runtime overrides re-applied); settings pushed to the sidebar.",
              metadata: { ok: true },
            };
          }
          return { content: "pty_refresh unavailable: no live config on this instance", metadata: { ok: false } };
        } catch (error) {
          return { content: `pty_refresh failed: ${error?.message ?? error}`, metadata: { ok: false, error: String(error) } };
        }
      },
    });
  });
}

// Registers the `/pty-restart` command: the same ptyRestartStack, posted to
// the chat (resume:false — informational, like /pty-open). An optional
// literal `kill` argument selects the destructive scope. The fresh URL is
// shown in the message when it changed so both user and LLM know it.
function registerPtyRestartCommand(deps, ctx, live, options, serverSignature) {
  if (!ctx?.command || typeof ctx.command.transform !== "function") {
    console.warn("[opencode-pty-extended] ctx.command.transform unavailable; /pty-restart not registered");
    return Promise.resolve();
  }
  return ctx.command.transform((draft) => {
    if (typeof draft.add !== "function") return;
    draft.add({
      name: "pty-restart",
      description:
        "Restart the PTY stack: reload live config and recycle the PTY web-UI server (running PTYs survive). " +
        "Optional argument: the literal word `kill` to first kill every running PTY.",
      execute: async (invocation) => {
        let text;
        try {
          const raw = invocation?.prompt?.text ?? invocation?.arguments ?? invocation?.args ?? "";
          const argText = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "");
          const scope = /\bkill\b/i.test(argText) ? "kill" : "soft";
          const result = await ptyRestartStack(deps, live, options, serverSignature, scope);
          text = formatPtyRestartResult(result);
        } catch (error) {
          text = `pty-restart failed: ${error?.message ?? error}`;
        }
        try {
          const prompt = ctx?.session?.prompt;
          if (typeof prompt === "function" && invocation?.sessionID) {
            // resume:false — informational only; the session does not continue.
            await prompt({
              sessionID: invocation.sessionID,
              text,
              resume: false,
            });
          } else {
            console.log(`[opencode-pty-extended] pty-restart: ${text}`);
          }
        } catch {
          console.log(`[opencode-pty-extended] pty-restart: ${text}`);
        }
      },
    });
  });
}

// Inserts the lineage lines (initiator + root session id, and the initiator
// agent) into the `<pty_spawned>` block the package returns. The initiator is
// the session running the tool (`context.sessionID`); the root is resolved from
// the session store. Tolerant: returns the text untouched if the block or the
// ids are unavailable.
function enrichSpawnedOutput(text, ctx, context, size) {
  if (typeof text !== "string" || !text.includes("</pty_spawned>")) return text;
  const initiator =
    typeof context?.sessionID === "string" && context.sessionID ? context.sessionID : null;
  if (!initiator) return text;
  const root = rootSessionId(ctx, initiator);
  const agent = typeof context?.agent === "string" && context.agent ? context.agent : "none";
  const sizeLine = Number.isInteger(size?.cols) && Number.isInteger(size?.rows)
    ? [`Size: ${size.cols}x${size.rows} (${size.mode ?? "auto"})`]
    : [];
  const lines = [
    ...sizeLine,
    `Initiator Session: ${initiator}`,
    `Root Session: ${root}`,
    `Initiator Agent: ${agent}`,
  ].join("\n");
  return text.replace("</pty_spawned>", `${lines}\n</pty_spawned>`);
}

// Inserts the same lineage lines into the `<pty_exited>` block built by the
// package's NotificationManager, ahead of `</pty_exited>`.
function enrichExitedOutput(text, session) {
  if (typeof text !== "string" || !text.includes("</pty_exited>")) return text;
  const initiator =
    typeof session?.parentSessionId === "string" && session.parentSessionId
      ? session.parentSessionId
      : "none";
  const root =
    typeof session?.rootSessionId === "string" && session.rootSessionId
      ? session.rootSessionId
      : initiator;
  const agent =
    typeof session?.parentAgent === "string" && session.parentAgent ? session.parentAgent : "none";
  const lines = [
    `Initiator Session: ${initiator}`,
    `Root Session: ${root}`,
    `Initiator Agent: ${agent}`,
  ].join("\n");
  return text.replace("</pty_exited>", `${lines}\n</pty_exited>`);
}

// The opencode sessions that should receive an exited PTY's notification, per
// the PTY's `notifyTarget` (stamped at spawn) or the configured default.
// "spawner" -> the session that called pty_spawn; "root" -> the root
// conversation; "both" -> each distinct target. Web-UI-created PTYs (no
// opencode parent) notify nobody.
function notifyTargets(session, notify) {
  const parent = session?.parentSessionId;
  if (typeof parent !== "string" || !parent || parent === GROUP_WEB_API_PARENT) return [];
  const root =
    typeof session.rootSessionId === "string" && session.rootSessionId
      ? session.rootSessionId
      : parent;
  const target = normalizeNotifyTarget(session.notifyTarget ?? notify?.target);
  const set = new Set();
  if (target === "spawner" || target === "both") set.add(parent);
  if (target === "root" || target === "both") set.add(root);
  return [...set];
}

// Delivers `<pty_exited>` notifications through the v2 session client so the
// session's current model is preserved. The v2 `SessionPromptInput` is
// `{ sessionID, text, ... }` — the earlier V1-shaped call
// (`{ sessionID, id, text, resume }`) validated against the v2 client and
// silently failed, which is why `notifyOnExit` never seemed to inform opencode.
// The recipient(s) come from the PTY's `notifyTarget` (see notifyTargets).
function installExitNotifier({ manager, NotificationManager }, ctx, output, notify) {
  const prompt = ctx?.session?.prompt;
  if (typeof prompt !== "function") {
    console.warn("[opencode-pty-extended] ctx.session.prompt unavailable; pty exit notifications disabled");
    return;
  }

  const notificationBuilder = new NotificationManager();
  manager.setNotifier({
    async sendExitNotification(session, exitCode) {
      const targets = notifyTargets(session, notify);
      if (targets.length === 0) return;
      // The buffer's last line can carry raw ANSI escape sequences; render them
      // as inert text (`output.stripAnsiSequences` controls whether to visualize
      // or drop them) so they cannot break the TUI.
      const text = sanitizeOutputText(
        enrichExitedOutput(
          notificationBuilder.buildExitNotification(session, exitCode),
          session,
        ),
        output,
      );
      for (const sessionID of targets) {
        try {
          await prompt({ sessionID, text });
        } catch (error) {
          console.error(
            `[opencode-pty-extended] failed to deliver exit notification for ${session.id} to ${sessionID}:`,
            error,
          );
        }
      }
    },
  });
}

const Plugin = {
  id: "opencode-pty-extended",
  async setup(ctx) {
    const deps = await loadPackage();
    // Load user config (opencode-pty-extended.jsonc/.json) and resolve effective values.
    // Precedence: built-ins < shipped < OpenCode `plugins[].options` < config files
    // (our own global -> project files merge LAST and win).
    const projectDir = ctx?.location?.directory;
    const { files: configFiles, config: fileConfig } = loadUserConfig(projectDir);
    // The plugin options live at the config root (no "options" subkey):
    // port / hostname / autostart. Only defined keys override the built-ins.
    const config = deepMerge(ctx?.options ?? {}, fileConfig);
    const options = { ...BUILTIN_OPTIONS };
    for (const key of Object.keys(BUILTIN_OPTIONS)) {
      if (config[key] !== undefined) options[key] = config[key];
    }
    Object.assign(options, ctx?.options ?? {});
    const terminalFont = { ...BUILTIN_TERMINAL_FONT, ...(config.terminalFont ?? {}) };
    const webUi = computeWebUiOptions(config);
    // Liveness tracking for the `+` popup's session dropdown filter
    // (webUi.newPtyShowAllSessions). Installed early so it observes as many
    // `session.*` events as possible. TEMP mechanism probe; refine next round.
    try {
      installLiveSessionTracker(ctx);
    } catch (error) {
      console.warn("[opencode-pty-extended] live-session tracker failed:", error);
    }
    // Exit-notification default target (`notify.target`); a `pty_spawn`
    // `notifyTarget` arg (or `argDefaults.pty_spawn.notifyTarget`) wins per spawn.
    // `announceWebSpawn` gates the chat announcement of web-UI `+` spawns
    // (global spawns announce to every open root session).
    const notify = {
      target: normalizeNotifyTarget(config.notify?.target),
      announceWebSpawn: config.notify?.announceWebSpawn !== false,
    };
    const output = resolveOutput(config);
    // Tool-argument defaults: built HERE (not inside registerPtyTools) so the
    // /pty-config hot reload can refresh the same object in place.
    const argDefaults = buildArgDefaults(deps.DEFAULT_READ_LIMIT, config.argDefaults, notify.target);
    const tuiSettings = { tuiSidebar: resolveTuiSidebar(config), output };
    // The `+` spawn button's wrapper-owned routes (see createWebApiHandlers).
    // `notify` is a live object (hot reload syncs it in place), so the
    // announcement gate follows config saves without recreating the handlers.
    // `webUi` is the same live object — the dropdown filter follows config saves.
    const webApiHandlers = createWebApiHandlers({ manager: deps.manager, webUi }, ctx, notify);    if (configFiles.length > 0) {
      console.log(`[opencode-pty-extended] config files (low -> high): ${configFiles.join(", ")}`);
    }
    // Signature of the effective web-UI transforms *and* the transform
    // implementation version. A live PTY server built with a different
    // signature (e.g. before a hot reload or a config change) is recycled so it
    // serves the current bundle. Kept in the `serverSignatureLive` holder: the
    // web-server helpers resolve `.value` per call, so a config save that
    // re-stamps it recycles the server on the next open.
    const serverSignatureLive = {
      value: JSON.stringify({ patch: PATCH_VERSION, terminalFont, webUi, notifyOnExit: argDefaults?.pty_spawn?.notifyOnExit !== false }),
    };
    // Live references consumed by the /pty-config controller (configGet walks
    // `config`/`override`; configSet writes files and calls `reload()`).
    // `runtimeOverrides` holds the Apply-only values (memory, never written to
    // a file), overlaid on every reload so a later save can't discard them.
    const live = {
      projectDir,
      config,
      override: ctx?.options ?? {},
      options,
      terminalFont,
      webUi,
      notify,
      output,
      argDefaults,
      runtimeOverrides: {},
      serverSignatureLive,
      reload: null,
    };
    // Hot reload: re-run the config walk and refresh every resolved piece IN
    // PLACE (`syncObject` keeps object identities so all installed closures -
    // notify targets, argDefaults merges, web transforms, RPC `settings` -
    // keep seeing the new values without a plugin restart).
    const reloadLiveConfig = () => {
      const { config: freshFiles } = loadUserConfig(projectDir);
      const freshConfig = deepMerge(ctx?.options ?? {}, freshFiles);
      // Apply-only overrides ride ON TOP of the fresh file walk, so a later
      // save (or a file edit) can never silently discard them.
      applyRuntimeObject(freshConfig, live.runtimeOverrides);
      live.config = freshConfig;
      const freshOptions = { ...BUILTIN_OPTIONS };
      for (const key of Object.keys(BUILTIN_OPTIONS)) {
        if (freshConfig[key] !== undefined) freshOptions[key] = freshConfig[key];
      }
      Object.assign(options, ctx?.options ?? {});
      syncObject(options, freshOptions);
      syncObject(terminalFont, { ...BUILTIN_TERMINAL_FONT, ...(freshConfig.terminalFont ?? {}) });
      syncObject(webUi, computeWebUiOptions(freshConfig));
      syncObject(notify, {
        target: normalizeNotifyTarget(freshConfig.notify?.target),
        announceWebSpawn: freshConfig.notify?.announceWebSpawn !== false,
      });
      // User-locked reset: when `tuiSidebar.filterBySession` CHANGES through a
      // config apply/save (this reload is the funnel for the dialog's Apply
      // and Save, /pty-refresh and /pty-restart), the runtime show-all
      // override is cleared so the deliberately-set config value is the truth
      // again. A save that does not touch that key leaves the override alone.
      // The previous value is captured BEFORE the syncObject below overwrites
      // the live object in place.
      const prevFilter = tuiSettings.tuiSidebar.filterBySession;
      const freshFilter = resolveTuiSidebar(freshConfig).filterBySession;
      syncObject(tuiSettings.tuiSidebar, resolveTuiSidebar(freshConfig));
      syncObject(tuiSettings.output, resolveOutput(freshConfig));
      if (showAllOverride() !== null && freshFilter !== prevFilter) {
        setShowAllOverride(null);
      }
      syncObject(argDefaults, buildArgDefaults(deps.DEFAULT_READ_LIMIT, freshConfig.argDefaults, notify.target));
      serverSignatureLive.value = JSON.stringify({ patch: PATCH_VERSION, terminalFont, webUi, notifyOnExit: argDefaults?.pty_spawn?.notifyOnExit !== false });
      installCreateServerPatch(deps, { terminalFont, webUi, webApi: webApiHandlers, argDefaults, signature: serverSignatureLive.value });
      try {
        const active = deps.commands?.getActiveServer?.();
        if (active && active.__opencodePtyLocalSignature !== serverSignatureLive.value) {
          deps.commands?.stopActiveServer?.();
        }
      } catch (error) {
        console.warn("[opencode-pty-extended] web server recycle after config save failed:", error);
      }
      // Notify every connected TUI half: the merged settings
      // (`tuiSidebar.*` / `output.*`) may have changed — the sidebar re-pulls
      // and re-renders immediately (the RPC `settings` event, declared in
      // shared.js PtyRpc). Best-effort: without the bridge (or while the
      // change notifier was never installed, e.g. the RPC went down) the next
      // /pty-refresh or a poll picks the values up instead.
      try {
        globalThis.__opencodePtyLocalEmitSettings?.();
      } catch (error) {
        console.warn("[opencode-pty-extended] settings event after config save failed:", error);
      }
    };
    live.reload = reloadLiveConfig;
    // 0. Install the static-route transforms (font override + viewer-resize
    //    watcher + session-select) and the backend resize/CSI-18t manager
    //    patches, before anything can create a server or spawn a session (the
    //    package's setup below may autostart a server).
    installCreateServerPatch(deps, { terminalFont, webUi, webApi: webApiHandlers, argDefaults, signature: serverSignatureLive.value });
    installManagerResizeAndCsi(deps.manager, webUi);
    installManagerGroupBySession(deps.manager, ctx, webUi);
    // Fixed spawn size (`pty_spawn` cols/rows): wraps lifecycle.spawnProcess so
    // the requested size is applied the moment the PTY exists.
    installManagerSpawnSize(deps.manager);
    // Stamp root session + per-spawn notify target on every spawned PTY. Runs
    // after installManagerResizeAndCsi so it wraps that spawn patch (both are
    // idempotent and guarded by their own markers).
    installManagerSessionLineage(deps.manager, ctx, notify);
    // The package keeps its server in module state, which a hot reload can
    // lose. Recycle its server if it predates the current transforms so a
    // future `getOrCreateServer` cannot serve the old bundle.
    try {
      const active = deps.commands?.getActiveServer?.();
      if (active && active.__opencodePtyLocalSignature !== serverSignatureLive.value) {
        deps.commands?.stopActiveServer?.();
      }
    } catch (error) {
      console.warn("[opencode-pty-extended] could not recycle stale PTY web server:", error);
    }
    // 1. Keep the package's own wiring (optional autostart/web server).
    if (deps.PTYPlugin && typeof deps.PTYPlugin.setup === "function") {
      await deps.PTYPlugin.setup({ ...ctx, options });
    }
    // 2. Exit notifications + 3. tools + 4. commands the published entrypoint forgets.
    installExitNotifier(deps, ctx, output, notify);
    // `tuiSettings` powers pty_show_all_pty's effective-state read (the live
    // merged tuiSidebar, kept fresh by reloadLiveConfig).
    await registerPtyTools(deps, ctx, argDefaults, output, tuiSettings);
    await registerPtyUrlTool(deps, ctx, options, serverSignatureLive);
    // (/pty-open-background-spy + /pty-show-server-url moved to the TUI
    // keymap layer — tui.tsx; the core prompt-command layer registration was
    // removed: it duplicated the menu entries and filled the input.)
    // `pty_restart` / `/pty-restart`: live config reload + eager web-UI server
    // recycle (soft keeps PTYs; scope "kill" is the explicit opt-in).
    await registerPtyRestartTool(deps, ctx, live, options, serverSignatureLive);
    await registerPtyRestartCommand(deps, ctx, live, options, serverSignatureLive);
    // `pty_refresh`: live config reload + settings push (no web recycle).
    await registerPtyRefreshTool(deps, ctx, live);
    // 5. RPC bridge for the TUI sidebar (tui.tsx). The sidebar runs in the CLI
    //    process and reaches the PTY manager through these methods. Registered
    //    even when the sidebar is disabled so the TUI half can fetch the merged
    //    settings (including a `tuiSidebar.enabled: false` coming from
    //    `plugins[].options`, which never reaches the TUI half directly) and
    //    decide for itself; the change notifier only matters while enabled.
    //    The LAST argument (createConfigController) wires only the dialog's
    //    Apply button (runtime-only overrides). The dialog's read/write of
    //    config files is LOCAL in the TUI half now — see shared.js
    //    configGetPayload for why the RPC route can't serve per-location
    //    config data (server-root-scoped route resolution).
    const rpc = await registerPtyRpc(
      deps,
      ctx,
      options,
      serverSignatureLive,
      tuiSettings,
      createConfigController(live),
      // `live` powers the RPC `restart` (live reload + recycle).
      live,
    );
    // The change + settings notifiers install unconditionally (idempotent
    // globalThis indirections): session-list `changed` events matter only
    // while the sidebar is visible, but the `settings` event is what lets
    // every connected TUI half re-pull its merged settings the moment any
    // reload happens (apply / save / pty_refresh / pty_restart) — exactly
    // how `tuiSidebar.enabled` (a live show/hide gate since the mount-gate
    // removal) and all other TUI keys hot-apply now.
    installSidebarChangeNotifier(deps, rpc);
  },
};

export default Plugin;
export { Plugin };
// Named exports used by the standalone verification script (verify-pty-fixes.mjs)
// so the exact same functions can be exercised outside of opencode.
export { applyResizeToJs, applySelectSessionToJs, applyKillKeysToJs, applyDebugRelabelToJs, applyDebugSizeToJs, applyKillConfirmToJs, applySessionCloseToJs, applyGroupBySessionToJs, applyGroupBySessionToHtml, applySizeModeBarToHtml, applyPlusSpawnToHtml, applySessionCloseToHtml, applyWebUiShapeToHtml, applyDownloadLogToHtml, applyWsReconnectToJs, applyWsReconnectToHtml, installCreateServerPatch, installManagerResizeAndCsi, installManagerGroupBySession, installManagerSpawnSize, installManagerSessionLineage, installExitNotifier, buildArgDefaults, withPtyListArgs, withPtySpawnArgs, formatPtyList, enrichSpawnedOutput, enrichExitedOutput, notifyTargets, normalizeNotifyTarget, rootSessionId, spawnScope, BUILTIN_WEBUI, isPlainObj, syncObject, applyRuntimeObject, computeWebUiOptions, signatureValueOf, createConfigController, openUrlQuiet, sessionSizeState, applyFixedSize, setSizeModeAuto, parseSizeRequest, splitShellWords, listRootSessions, opencodeSessionRows, opencodeSessionRowsSafe, buildWebSpawnAnnouncement, announceWebSpawn, createWebApiHandlers, liveSessionIdSet, markSessionLive, markSessionDeleted, liveSessionsGlobal, presenceStamp, PRESENCE_SRC_TUI, PRESENCE_SRC_WEB, presenceDatabase, installLiveSessionTracker, ptyWebOriginOf, ptyRestartStack, formatPtyRestartResult, jsonResp };
