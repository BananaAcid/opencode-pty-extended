// ~/.config/opencode/plugins/opencode-pty-extended/shared.js
//
// Shared by the two halves of the wrapper:
//   - index.js  (server entry: owns the PTY manager)
//   - tui.tsx   (TUI entry: renders the sidebar, calls the manager over RPC)
//
// Two sections:
//   1. Config helpers - plain JS using only `node:` built-ins, so they stay
//      usable from a bare Node/Bun context (e.g. scripts/tests).
//   2. The RPC contract `PtyRpc` - the single source of truth for the
//      methods/events exchanged between the two halves. This section depends
//      on the opencode-only `@opencode/plugin/rpc` runtime module.

import { Rpc } from "@opencode/plugin/rpc";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

// The global opencode config root, computed the way opencode does
// (`$XDG_CONFIG_HOME` or `~/.config`, plus the app name). The wrapper's own
// `opencode-pty-extended.json[c]` sits next to the global `opencode.json[c]` when
// installed under `~/.config/opencode/plugins/`, but deriving it here also
// finds it for a gist/npm install (where the plugin dir is a cache path).
export const GLOBAL_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
);

// Config file names searched inside each directory, lowest -> highest (a
// `.jsonc` overrides a sibling `.json`, matching opencode's
// `["opencode.json", "opencode.jsonc"]` order).
export const CONFIG_FILE_NAMES = ["opencode-pty-extended.json", "opencode-pty-extended.jsonc"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalizes the `groupBy` option shared by `webUi.groupBy` and
// `tuiSidebar.groupBy`:
//
//   false       -> no grouping (flat list)
//   "session"   -> group by the owning opencode conversation (root session)
//   "agent"     -> group by conversation, then sub-group by each sub-session
//
// Booleans are accepted for back-compat with the old `groupBySession` option
// (`true` -> "session", `false` -> false). Anything else falls back to
// `fallback`.
export function normalizeGroupBy(value, fallback) {
  if (value === false) return false;
  if (value === true) return "session";
  if (value === "session" || value === "agent") return value;
  return fallback;
}

// Deep-merges plain objects; arrays and scalars replace (so `false` can turn a
// block off wholesale). `undefined` in `override` leaves `base` untouched.
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (!isPlainObject(override)) return override;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

// The TUI sidebar is on by default (it only renders when there is a PTY
// session to show). `pollMs` is how often the sidebar refreshes its list when
// the RPC "changed" event is not available; `maxLines` caps the output dialog.
//
// `filterBySession` (default true) shows only the PTYs belonging to the
// opencode session currently in view (plus any subagent descendants). Set it to
// false to list every PTY the shared manager tracks, from every opencode
// session. Without a current opencode session id nothing is filtered.
//
// `groupBy` (default "agent") adds group headers to the sidebar:
//   false     -> flat list
//   "session" -> one header per owning opencode conversation (root session)
//   "agent"   -> a conversation header, then a sub-header per sub-session
// A boolean is still accepted for back-compat with `groupBySession`.
export const BUILTIN_TUI_SIDEBAR = {
  enabled: true,
  pollMs: 1500,
  maxLines: 400,
  filterBySession: true,
  groupBy: "agent",
  initiallyHidden: true,
  killConfirmSession: true,
};

// Parses JSON with comments and trailing commas (JSONC). Uses Bun's parser when
// available and otherwise a small string-aware fallback.
export function parseJsonc(text) {
  const jsonc = globalThis.Bun?.JSONC;
  if (jsonc && typeof jsonc.parse === "function") return jsonc.parse(text);

  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function normalizeDir(dir) {
  try {
    return resolve(String(dir));
  } catch {
    return String(dir);
  }
}

// Comparison key for directory identity (Windows paths are case-insensitive).
function dirKey(dir) {
  const abs = normalizeDir(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

// Ancestors of `start`, farthest first (`/a`, `/a/b`, `/a/b/c`).
function ancestorDirs(start) {
  const dirs = [];
  let dir = normalizeDir(start);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

// Loads and deep-merges every applicable config file, lowest precedence first:
//
//   1. shipped reference config   <plugin dir>/opencode-pty-extended.json[c]
//   2. global config              <GLOBAL_CONFIG_DIR>/opencode-pty-extended.json[c]
//   3. project (sibling)          <ancestor>/opencode-pty-extended.json[c]
//   4. project (`.opencode/`)     <ancestor>/.opencode/opencode-pty-extended.json[c]
//
// Layers 3-4 walk up from `directory` (farthest -> nearest, so the nearest
// ancestor wins) and mirror opencode, where every `.opencode/` config outranks
// every sibling one. Within a directory `.json` is applied before `.jsonc`.
// `plugins[].options` (the caller's `ctx.options`) sits BELOW every plugin
// config file: the caller merges it first, then deep-merges this result on
// top - e.g. `deepMerge(ctx.options, loadUserConfig().config)`. Returns
// `{ files, config }`.
export function loadUserConfig(directory) {
  let config = {};
  const files = [];

  const applyDir = (dir) => {
    for (const name of CONFIG_FILE_NAMES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const parsed = parseJsonc(readFileSync(file, "utf8"));
        if (!isPlainObject(parsed)) continue;
        config = deepMerge(config, parsed);
        files.push(file);
      } catch (error) {
        console.warn(`[opencode-pty-extended] ignoring invalid config ${file}:`, error);
      }
    }
  };

  // 1. Shipped reference config, next to this module.
  applyDir(PLUGIN_DIR);

  // 2. Global config root (`$XDG_CONFIG_HOME`/`~/.config` + `opencode`).
  applyDir(GLOBAL_CONFIG_DIR);

  // 3-4. Project config. The plugin dir and global root are skipped so they are
  // not applied twice when the session is opened inside one of them.
  const skip = new Set([dirKey(PLUGIN_DIR), dirKey(GLOBAL_CONFIG_DIR)]);
  const dirs = ancestorDirs(directory ?? process.cwd()).filter((dir) => !skip.has(dirKey(dir)));
  for (const dir of dirs) applyDir(dir);
  for (const dir of dirs) applyDir(join(dir, ".opencode"));

  return { files, config };
}

// ---------------------------------------------------------------------------
// Editable config schema (the /pty-config dialog's surface)
// ---------------------------------------------------------------------------
// One entry per editable setting, keyed by dotted config path. The /pty-config
// dialog (tui.tsx) builds its rows from this list; the server half resolves
// provenance per path. Restart tiers for the dialog's hint column:
//   `restart: "full"` - the key is read at plugin load by the upstream package
//     and only a full OpenCode `/restart` applies it (currently autostart and
//     the tuiSidebar.initiallyHidden one-way latch; tuiSidebar.enabled left
//     this tier - it is a live show/hide gate now, never a load gate).
//   `restart: true`   - the PTY-stack soft restart (`pty_restart`, which
//     recreates the web-UI server) applies it; hot for everything the server
//     re-reads, but the server itself must be rebuilt first.
//     (boolean stays the back-compat shape; booleans mean the web tier.)
// Every other key is hot-applied by the server half's config reload.

// The built-in terminalFont stack (index.js owns the BUILTIN_TERMINAL_FONT object; only
// the default string is needed here, so unconfigured values can be shown).
const BUILTIN_TERMINAL_FONT_FAMILY =
  "'FiraCode Nerd Font Mono', 'SF Mono', 'Fira', 'Fira Code', 'Consolas', monospace";

export const CONFIG_SCHEMA = [
  // Root / general
  { path: "autostart", type: "bool", default: false, restart: "full", desc: "Start the web-UI server with each session (not requiring /pty-show-server-url to start the server)" },
  { path: "hostname", type: "string", default: "::1", restart: true, desc: "Web UI listen address (IPv4 `0.0.0.0`, IPv6 `::`; IPv4 `127.0.0.1`, IPv6 `::1`; etc.)" },
  { path: "port", type: "number", default: 58858, restart: true, desc: "Web UI port (0 = pick a random free one)" },
  // terminalFont
  { path: "terminalFont.enabled", type: "bool", default: false, restart: true, desc: "Enable to override the web-UI terminal font" },
  { path: "terminalFont.family", type: "string", default: BUILTIN_TERMINAL_FONT_FAMILY, restart: true, desc: "Font stack for the web UI, ideally a `Nerd Font` variant" },
  { path: "terminalFont.size", type: "number", default: 0, restart: true, desc: "Terminal font size, px (0 = unset)" },
  { path: "terminalFont.lineHeight", type: "number", default: 0, restart: true, desc: "Terminal line height (0 = unset, example: 1.2 (20% spacing between lines))" },
  // webUi
  { path: "webUi.viewerResize.enabled", type: "bool", default: true, restart: true, desc: "Web viewer resize watcher" },
  { path: "webUi.groupBy", type: "enum", enum: [false, "session", "agent"], default: "agent", restart: true, desc: "Web-UI sidebar pty session grouping" },
  { path: "webUi.ctrlCKillSession", type: "bool", default: false, restart: true, desc: "Ctrl+C kills the web session (false = passthrough)" },
  { path: "webUi.ctrlDKillSession", type: "bool", default: true, restart: true, desc: "Ctrl+D kills the web session (default in for most terminals)" },
  { path: "webUi.killConfirmSession", type: "bool", default: true, restart: true, desc: "Confirm the web-UI Kill Session button" },
  { path: "webUi.closeConfirmSession", type: "bool", default: true, restart: true, desc: "Confirm the per-session close button" },
  { path: "webUi.newPtyShowAllSessions", type: "bool", default: false, restart: true, desc: "Header `+` button dropdown lists ALL sessions (false = only live ones)" },
  { path: "webUi.newPtyActiveWindowMs", type: "number", default: 180000, restart: true, desc: "\"Actively doing something\" window (ms); live even when open in no UI" },
  { path: "webUi.stretchSessions", type: "bool", default: true, restart: true, desc: "Session cards fill the sidebar width for a uniform look" },
  { path: "webUi.downloadLog", type: "bool", default: true, restart: true, desc: "Show the output Download/RAW buttons" },
  { path: "webUi.sizeControl", type: "bool", default: true, restart: true, desc: "Terminal size options (auto/fixed) below the terminal" },
  { path: "webUi.spawnButton", type: "bool", default: true, restart: true, desc: "Header `+` button for spawning new PTYs from the web UI" },
  { path: "webUi.reconnectIntervalMs", type: "number", default: 2000, restart: true, desc: "Web-UI reconnect (auto-reload poll after socket drop (ms); 0/false = off)" },
  { path: "webUi.viewerResize.debounceMs", type: "number", default: 120, restart: true, desc: "Viewer resize debounce, ms" },
  { path: "webUi.csiReply", type: "bool", default: true, restart: true, desc: "Reply to CSI-18t from the web viewer" },
  { path: "webUi.debugSize", type: "bool", default: false, restart: true, desc: "Append live terminal size to the Debug line" },
  // notify
  { path: "notify.target", type: "enum", enum: ["spawner", "root", "both"], default: "spawner", desc: "Who receives pty_exited by default" },
  { path: "notify.announceWebSpawn", type: "bool", default: true, desc: "Announce web-UI spawns in the target chat session (global = all sessions)" },
  // argDefaults
  { path: "argDefaults.pty_spawn.notifyOnExit", type: "bool", default: true, desc: "Default setting of notifyOnExit for the pty_spawn tool" },
  { path: "argDefaults.pty_spawn.notifyTarget", type: "enum", enum: ["spawner", "root", "both"], default: "spawner", desc: "Default setting of notifyTarget for pty_spawn tool" },
  { path: "argDefaults.pty_read.offset", type: "number", default: 0, desc: "Default infile read offset for the pty_read tool (should always be 0)" },
  { path: "argDefaults.pty_read.limit", type: "number", default: 0, desc: "Default pty_read line limit (0 = built-in limit of 500)" },
  { path: "argDefaults.pty_read.ignoreCase", type: "bool", default: false, desc: "Default ignoreCase setting for regex patterns for pty_read" },
  { path: "argDefaults.pty_kill.cleanup", type: "bool", default: false, desc: "Default cleanup setting for the pty_kill tool (true: prefer removing exitted/killed pty sessions)" },
  // tuiSidebar
  { path: "tuiSidebar.enabled", type: "bool", default: true, desc: "Show/hide the PTY sidebar section" },
  { path: "tuiSidebar.initiallyHidden", type: "bool", default: true, restart: "full", desc: "Hide the PTY section until the first PTY" },
  { path: "tuiSidebar.filterBySession", type: "bool", default: true, desc: "Show only the current session's PTYs in the sidebar" },
  { path: "tuiSidebar.groupBy", type: "enum", enum: [false, "session", "agent"], default: "agent", desc: "Sidebar grouping style" },
  { path: "tuiSidebar.killConfirmSession", type: "bool", default: true, desc: "Confirm TUI kills (for sidebar right-click and /pty-kill)" },
  { path: "tuiSidebar.pollMs", type: "number", default: 1000, desc: "Sidebar refresh interval, ms" },
  { path: "tuiSidebar.maxLines", type: "number", default: 400, desc: "Output dialog tail length in lines" },
  // output
  { path: "output.stripAnsiSequences", type: "bool", default: true, desc: "<pty_exited>: strip vs visualize ANSI (usually `false` to get the plain text of the last line)" },
  { path: "output.dialog.stripAnsiSequences", type: "bool", default: true, desc: "/pty-output dialog: strip vs visualize (using `false` depends on if you need to see the ANSI)" },
  { path: "output.tool.stripAnsiSequences", type: "bool", default: false, desc: "pty_read tool output: proccess raw or sanitize ANSI (usually `false` for processing)" },
];

// Reads a dotted config path out of a plain object (`"webUi.groupBy"` ->
// obj.webUi?.groupBy). Returns undefined when any link is missing.
export function getConfigValue(obj, path) {
  let cursor = obj;
  for (const segment of String(path ?? "").split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// Writes a dotted config path into a plain object (creating intermediate
// blocks). Mutates and returns `obj`; `value === undefined` deletes the key.
export function setConfigValue(obj, path, value) {
  const segments = String(path ?? "").split(".");
  if (!segments[0]) return obj;
  let cursor = obj;
  for (let index = 0; index < segments.length - 1; index++) {
    if (typeof cursor[segments[index]] !== "object" || cursor[segments[index]] === null) {
      cursor[segments[index]] = {};
    }
    cursor = cursor[segments[index]];
  }
  const leaf = segments[segments.length - 1];
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
  return obj;
}

// The same walk `loadUserConfig` performs (identical precedence and file
// order), but keeping the layers individually so the /pty-config dialog can
// show where each value comes from. Returns `{ layers, merged }`:
//
//   layers  precedence-ordered (lowest first):
//             [{ scope: "shipped" | "global" | "project", file, config }]
//   merged  deepMerge of all layers (equals loadUserConfig().config)
export function configLayers(directory) {
  const layers = [];
  let merged = {};

  const applyDir = (dir, scope) => {
    for (const name of CONFIG_FILE_NAMES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const parsed = parseJsonc(readFileSync(file, "utf8"));
        if (!isPlainObject(parsed)) continue;
        layers.push({ scope, file, config: parsed });
        merged = deepMerge(merged, parsed);
      } catch {
        /* loadUserConfig silently skips files it cannot parse; same here */
      }
    }
  };

  applyDir(PLUGIN_DIR, "shipped");
  applyDir(GLOBAL_CONFIG_DIR, "global");
  const skip = new Set([dirKey(PLUGIN_DIR), dirKey(GLOBAL_CONFIG_DIR)]);
  const dirs = ancestorDirs(directory ?? process.cwd()).filter((dir) => !skip.has(dirKey(dir)));
  for (const dir of dirs) applyDir(dir, "project");
  for (const dir of dirs) applyDir(join(dir, ".opencode"), "project");

  return { layers, merged };
}

// Provenance of every schema path, resolved against the live layers plus the
// `plugins[].options` merge:
//
//   { [path]: { value, source, file?, restart? } }
//
//   source: "opencode" | "project" | "global" | "shipped" | "default"
//
// Precedence (low -> high): shipped defaults, then opencode's
// `plugins[].options` (the "opencode" layer), then the plugin's own config
// files global -> project. `file` is the file a value comes from (project /
// global / shipped layers), `restart` mirrors the schema entry.
export function resolveConfigProvenance(schemaEntries, layers, override) {
  const out = {};
  const ranked = [...layers].reverse();
  for (const entry of schemaEntries) {
    const result = { source: "default", value: entry.default };
    // opencode's own `plugins[].options` merge runs FIRST: it beats the
    // shipped reference config but LOSES to every plugin config file layer
    // (the plugin merges its own global / project files after it - see the
    // deepMerge argument order in index.js Plugin.setup / reloadLiveConfig).
    const overrideValue = getConfigValue(override, entry.path);
    if (overrideValue !== undefined) {
      result.source = "opencode";
      result.value = overrideValue;
    }
    for (const layer of ranked) {
      const value = getConfigValue(layer.config, entry.path);
      if (value !== undefined) {
        result.source = layer.scope;
        result.file = layer.file;
        result.value = value;
        break;
      }
    }
    // Preserve the tier (`true` = web tier, `"full"` = OpenCode /restart
    // tier): the dialog's hint column and restart flows branch on the exact
    // string, flattening it to a boolean would mislabel full-tier keys as
    // `(needs web restart)`.
    if (entry.restart) result.restart = entry.restart;
    out[entry.path] = result;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config save targets (global vs project)
// ---------------------------------------------------------------------------
// Where the /pty-config dialog's Save can write. Both resolvers prefer an
// existing file (a sibling `.json` outranks `.jsonc`, mirroring
// CONFIG_FILE_NAMES precedence) and otherwise report that creation is needed.

// The global config file: `~/.config/opencode/opencode-pty-extended.json[c]`.
export function globalConfigFile() {
  for (const name of CONFIG_FILE_NAMES) {
    const file = join(GLOBAL_CONFIG_DIR, name);
    if (existsSync(file)) return { file, create: false };
  }
  return { file: join(GLOBAL_CONFIG_DIR, "opencode-pty-extended.jsonc"), create: true };
}

// The project config file:
//
//   where "opencode" -> <dir>/.opencode/opencode-pty-extended.json[c]
//                       (existing file preferred; `allowCreate` lets the
//                       resolver offer the file before the folder exists)
//   where "sibling"  -> <dir>/opencode-pty-extended.json[c]
//                       (only next to an existing opencode.json[c])
//
// Returns `{ file, create }` or null when the location does not apply.
export function projectConfigFile(directory, where, allowCreate = false) {
  const dir = String(directory ?? process.cwd());
  if (where === "opencode") {
    const opencodeDir = join(dir, ".opencode");
    if (!existsSync(opencodeDir) && !allowCreate) return null;
    for (const name of CONFIG_FILE_NAMES) {
      const file = join(opencodeDir, name);
      if (existsSync(file)) return { file, create: false };
    }
    return {
      file: join(opencodeDir, "opencode-pty-extended.jsonc"),
      create: !existsSync(opencodeDir),
    };
  }
  if (where === "sibling") {
    const hasOpencodeJson =
      existsSync(join(dir, "opencode.json")) || existsSync(join(dir, "opencode.jsonc"));
    // Without opencode.json[c] the sibling location only applies when the
    // caller explicitly picked it (an explicit pick may create the file).
    // Note `create` reports true even when opencode.json[c] exists but this
    // plugin's config does not - "will create" applies to the config file.
    if (!hasOpencodeJson && !allowCreate) return null;
    for (const name of CONFIG_FILE_NAMES) {
      const file = join(dir, name);
      if (existsSync(file)) return { file, create: false };
    }
    return { file: join(dir, "opencode-pty-extended.jsonc"), create: true };
  }
  return null;
}

// Resolves the project destination for a save: `"opencode"` / `"sibling"` pin
// the location (and allow creating it); `undefined` auto-picks the first that
// already applies (`.opencode/` folder, then sibling of an existing
// opencode.json[c]). Returns null when nothing applies.
export function resolveProjectTarget(directory, where, allowCreate = false) {
  if (where) return projectConfigFile(directory, where, true);
  return projectConfigFile(directory, "opencode", allowCreate) ??
    projectConfigFile(directory, "sibling", allowCreate);
}

// ---------------------------------------------------------------------------
// Comment-preserving JSONC writes
// ---------------------------------------------------------------------------
// The /pty-config dialog edits real config files, and rewriting them through
// parseJsonc would drop every comment. Writes therefore patch the *raw text*:
//
//   1. replace the value span of an existing key in place,
//   2. insert missing keys (with their intermediate blocks) into the deepest
//      existing parent object,
//   3. delete a key span (revert/clear),
//
// and only fall back to a full regeneration (comments lost) when the raw text
// cannot be patched safely. `writeConfigValues` reports `mode: "rewrite"` so
// the caller can warn.

// Index of the next character that is neither whitespace nor a comment.
function skipSilence(text, index, length) {
  for (;;) {
    if (index >= length) return length;
    const ch = text[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index++;
      continue;
    }
    if (ch === "/" && index + 1 < length) {
      const next = text[index + 1];
      if (next === "/") {
        const end = text.indexOf("\n", index + 2);
        index = end < 0 ? length : end + 1;
        continue;
      }
      if (next === "*") {
        const end = text.indexOf("*/", index + 2);
        index = end < 0 ? length : end + 2;
        continue;
      }
    }
    return index;
  }
}

// Index of the nearest character at or before `from` that is neither
// whitespace nor a comment (only understood directly before a closing brace:
// `*/` ends a block comment there; line comments end with the brace's line).
function skipSilenceBackward(text, from) {
  let i = from;
  for (;;) {
    if (i < 0) return -1;
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i--;
      continue;
    }
    if (ch === "/" && text[i - 1] === "*") {
      const start = text.lastIndexOf("/*", i - 2);
      if (start < 0) return i;
      i = start - 1;
      continue;
    }
    return i;
  }
}

// Scans the double-quoted string starting at `i` (the open quote). Returns
// `{ value, start, end }` (end = closing quote index) or null when the string
// never closes.
function scanJsoncString(text, i, length) {
  const start = i;
  i++;
  let value = "";
  while (i < length) {
    const ch = text[i];
    if (ch === "\\") {
      const esc = text[i + 1];
      if (esc === "u") {
        const hex = parseInt(text.slice(i + 2, i + 6), 16);
        value += Number.isNaN(hex) ? "" : String.fromCharCode(hex);
        i += 6;
        continue;
      }
      value += esc ?? "";
      i += 2;
      continue;
    }
    if (ch === '"') return { value, start, end: i };
    value += ch;
    i++;
  }
  return null;
}

// Index of the LAST character (inclusive) of the raw JSON value starting at
// `i`. Handles strings, `{}`/`[]` blocks (string- and comment-aware), and
// bare primitives (true/false/null/numbers). Returns -1 when malformed.
function scanJsonValueEnd(text, i, length) {
  if (i >= length) return -1;
  const ch = text[i];
  if (ch === '"') {
    const str = scanJsoncString(text, i, length);
    return str ? str.end : -1;
  }
  if (ch === "{" || ch === "[") {
    let depth = 0;
    let j = i;
    while (j < length) {
      const c = text[j];
      if (c === '"') {
        const str = scanJsoncString(text, j, length);
        if (!str) return -1;
        j = str.end + 1;
        continue;
      }
      if (c === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        const after = skipSilence(text, j, length);
        if (after === j) return -1;
        j = after;
        continue;
      }
      if (c === "{" || c === "[") {
        depth++;
        j++;
        continue;
      }
      if (c === "}" || c === "]") {
        depth--;
        j++;
        if (depth === 0) return j - 1;
        if (depth < 0) return -1;
        continue;
      }
      j++;
    }
    return -1;
  }
  // Primitive: a bare number / true / false / null token.
  let j = i;
  while (j < length && !/[\s,}\]]/.test(text[j])) j++;
  return j - 1;
}

// Locates `segments` (e.g. ["webUi", "groupBy"]) in the raw JSONC text:
//
//   { keyStart, keyEnd, valueStart, valueEnd, parentStart, parentEnd }
//
// (all indices into `text`; valueEnd and parentEnd are inclusive). Returns
// null when the path does not exist in the raw text.
export function locateJsoncPath(text, segments) {
  const length = text.length;
  let i = skipSilence(text, 0, length);
  if (i >= length || text[i] !== "{") return null;
  i++;

  // Stack of open containers. The root frame carries `root: true` and is
  // excluded from the key lineage (it has no key of its own); every other
  // frame carries the key under which its container was opened.
  const stack = [{ root: true, key: undefined, start: i - 1, end: -1, isArr: false }];
  let currentKey = null; // the key just parsed at the current level

  while (i < length) {
    i = skipSilence(text, i, length);
    if (i >= length) break;
    const ch = text[i];

    if (ch === "{") {
      stack.push({ key: currentKey?.value ?? undefined, start: i, end: -1, isArr: false });
      currentKey = null;
      i++;
      continue;
    }
    if (ch === "[") {
      stack.push({ key: currentKey?.value ?? undefined, start: i, end: -1, isArr: true });
      currentKey = null;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const frame = stack.pop();
      if (frame) frame.end = i;
      currentKey = null;
      i++;
      continue;
    }
    if (ch === '"') {
      const scanned = scanJsoncString(text, i, length);
      if (!scanned) return null;
      const colonAt = skipSilence(text, scanned.end + 1, length);
      if (colonAt >= length || text[colonAt] !== ":") {
        // A plain string value (inside an array etc.).
        currentKey = null;
        i = scanned.end + 1;
        continue;
      }
      // A member key of the innermost open container.
      const lineage = stack.filter((frame) => !frame.root).map((frame) => frame.key);
      const depth = lineage.length;
      if (
        depth === segments.length - 1 &&
        lineage.every((key, index) => key === segments[index]) &&
        scanned.value === segments[depth]
      ) {
        // Target found: report its span and its containing object.
        const valueStart = skipSilence(text, colonAt + 1, length);
        const valueEnd = scanJsonValueEnd(text, valueStart, length);
        const parent = stack[stack.length - 1];
        return {
          keyStart: scanned.start,
          keyEnd: scanned.end,
          valueStart,
          valueEnd,
          parentStart: parent?.start ?? -1,
          parentEnd: parentEndOf(parent, text, length),
        };
      }
      // Not the target. A container value continues the path through its own
      // keys, so keep the parsed key for the frame the `{`/`[` above will
      // push; plain values just skip past.
      const valueStart = skipSilence(text, colonAt + 1, length);
      const valueEnd = scanJsonValueEnd(text, valueStart, length);
      if (valueEnd < 0) return null;
      const isContainer = text[valueStart] === "{" || text[valueStart] === "[";
      if (isContainer) {
        // Leave `i` at the open brace so the frame binds to this key.
        currentKey = { value: scanned.value };
        i = valueStart;
        continue;
      }
      currentKey = null;
      i = valueEnd + 1;
      continue;
    }
    if (ch === ",") {
      currentKey = null;
      i++;
      continue;
    }
    // A bare primitive value (number / true / false / null).
    const primitiveEnd = scanJsonValueEnd(text, i, length);
    if (primitiveEnd < 0) return null;
    currentKey = null;
    i = primitiveEnd + 1;
  }
  return null;
}

// The containing object's closing brace index, falling back to a raw scan
// when the member loop above never observed the close.
function parentEndOf(frame, text, length) {
  if (!frame) return -1;
  if (frame.end >= 0) return frame.end;
  return scanJsonValueEnd(text, frame.start, length);
}

// Builds the JSONC text for `segments` -> `value` at the given indentation.
// Multi-segment chains nest inline objects:
//
//   "a": {
//     "b": 1
//   }
function buildJsoncEntry(segments, value, indent) {
  const key = JSON.stringify(segments[0]);
  if (segments.length === 1) return `${key}: ${JSON.stringify(value)}`;
  const inner = buildJsoncEntry(segments.slice(1), value, `${indent}  `);
  return `${key}: {\n${indent}${inner}\n${indent.slice(0, -2)}}`;
}

// Builds the JSONC text to insert for `segments` -> `value` into the parent
// object whose opening/closing braces sit at `parentStart`/`parentEnd`,
// mirroring the file's own indentation and comma style:
//
//   { "existing": 1,        |   (empty object)
//     "new": 2          }   |   { "new": 2 }
//
// Returns `{ at, text }` - splice into the raw text at `at`.
export function insertJsoncKey(raw, parentStart, parentEnd, segments, value) {
  const length = raw.length;
  // Indentation of the closing-brace line (= the parent's indent) and one
  // level deeper for the new member(s).
  const braceLineStart = raw.lastIndexOf("\n", parentEnd - 1) + 1;
  const parentIndent = (/^\s*/.exec(raw.slice(braceLineStart, parentEnd))?.[0] ?? "");
  const childIndent = `${parentIndent}  `;
  const body = buildJsoncEntry(segments, value, childIndent);

  // Last meaningful char before the closing brace.
  const probe = skipSilenceBackward(raw, parentEnd - 1);
  if (probe <= parentStart) {
    // Empty/members-less object: only whitespace (and comments) until `}`.
    return {
      at: parentStart + 1,
      text: `\n${childIndent}${body}\n${parentIndent}`,
    };
  }
  if (raw[probe] === ",") {
    // A trailing comma is already there; insert after it.
    return { at: probe + 1, text: `\n${childIndent}${body}` };
  }
  // New member needs its own comma; insert right after the previous member.
  return { at: probe + 1, text: `,\n${childIndent}${body}` };
}

// Deletes the whole `key: value` member the `locateJsoncPath` result points
// at, cleaning the orphaned comma (leading or trailing) and swallowing the
// line when the key was its only content.
export function deleteJsoncSpan(raw, found) {
  let start = found.keyStart;
  let end = found.valueEnd;
  if (start < 0 || end < start) return raw;
  let after = skipSilence(raw, end + 1, raw.length);
  if (raw[after] === ",") {
    // Drop the trailing comma with the member.
    end = after;
  } else {
    const before = skipSilenceBackward(raw, start - 1);
    if (before >= 0 && raw[before] === ",") {
      // No trailing comma; drop the leading one instead.
      start = before;
    }
  }
  // If the member occupied a full line (only whitespace before it on that
  // line), remove the trailing blanks plus the line's own newline so no
  // empty line is left behind.
  const lineStart = raw.lastIndexOf("\n", start) + 1;
  if (/^[\t ]*$/.test(raw.slice(lineStart, start))) {
    let e = end;
    while (e + 1 < raw.length && raw[e + 1] !== "\n" && /[\t ]/.test(raw[e + 1])) e++;
    if (e + 1 < raw.length && raw[e + 1] === "\n") end = e + 1;
    start = lineStart;
  }
  return raw.slice(0, start) + raw.slice(end + 1);
}

// Applies `{ path, value }` writes to one config file, patching the raw JSONC
// text so untouched comments survive. `value: null` deletes (reverts) a key.
// Returns `{ mode, warnings }`:
//
//   mode: "patch" | "create" | "rewrite" | "noop"
//
// "create" = the file did not exist and was written fresh; "rewrite" = the
// raw text could not be patched safely and the file was regenerated from its
// parsed form (all comments lost - the caller warns); "noop" = nothing
// changed (e.g. deleting absent keys). Throws when even the rewrite fallback
// fails; the file is left untouched in that case.
export function writeConfigValues(file, changes, { create = true } = {}) {
  const exists = existsSync(file);
  if (!exists && !create) throw new Error(`config file not found: ${file}`);

  let raw = exists ? readFileSync(file, "utf8") : "{\n}\n";
  let mode = exists ? "patch" : "create";
  let appliedCount = 0;
  const warnings = [];

  for (const change of changes) {
    if (!change || typeof change.path !== "string" || !change.path) continue;
    const segments = change.path.split(".");
    if (change.value === null || change.value === undefined) {
      const found = locateJsoncPath(raw, segments);
      if (!found) continue; // deleting an absent key: nothing to do
      raw = deleteJsoncSpan(raw, found);
      appliedCount++;
      continue;
    }
    const safeValue = JSON.parse(JSON.stringify(change.value));
    const found = locateJsoncPath(raw, segments);
    if (found) {
      raw =
        raw.slice(0, found.valueStart) +
        JSON.stringify(safeValue) +
        raw.slice(found.valueEnd + 1);
      appliedCount++;
      continue;
    }
    // The key is missing: insert into the deepest ancestor object that does
    // exist; for a root-level key (or when no non-root ancestor exists) that
    // is the file's root object itself.
    let ancestor = null;
    let level = segments.length - 1;
    for (; level >= 1; level--) {
      const probe = locateJsoncPath(raw, segments.slice(0, level));
      if (probe && raw[probe.valueStart] === "{") {
        // Insert into that key's VALUE object (the parentStart/parentEnd of a
        // locate result point at the container holding the key, not at it).
        ancestor = { parentStart: probe.valueStart, parentEnd: probe.valueEnd };
        break;
      }
    }
    if (!ancestor) {
      const root = rootObjectSpan(raw);
      if (!root) {
        // Unpatchable (e.g. unreadable layout): regenerate the whole file.
        mode = "rewrite";
        warnings.push(`${change.path}: raw patch failed, file regenerated`);
        break;
      }
      ancestor = { parentStart: root.start, parentEnd: root.end };
      level = 0;
    }
    const insertion = insertJsoncKey(raw, ancestor.parentStart, ancestor.parentEnd, segments.slice(level), safeValue);
    raw = raw.slice(0, insertion.at) + insertion.text + raw.slice(insertion.at);
    appliedCount++;
    continue;
  }

  if (mode === "rewrite") {
    // Regenerate from the parsed form. Re-read from disk because `raw` may
    // already be mid-edit (only the never-officially-committed state is lost,
    // which is exactly what the parse-then-set path reconstructs).
    const source = exists ? readFileSync(file, "utf8") : "{\n}\n";
    let object = {};
    try {
      const parsed = parseJsonc(source);
      if (isPlainObject(parsed)) object = parsed;
    } catch {
      /* start from an empty object */
    }
    for (const change of changes) {
      if (typeof change?.path !== "string" || !change.path) continue;
      setConfigValue(object, change.path, change.value === null ? undefined : change.value);
    }
    raw = `${JSON.stringify(object, null, 2)}\n`;
    appliedCount = changes.length;
  }

  // Post-check: the resulting text must parse and carry exactly what was
  // written (deletions must be gone, writes must hold the new value).
  const verify = parseJsonc(raw);
  if (!isPlainObject(verify)) throw new Error("patched config did not parse as an object");
  for (const change of changes) {
    if (typeof change?.path !== "string" || !change.path) continue;
    const current = getConfigValue(verify, change.path);
    const desired = change.value === null || change.value === undefined ? undefined : change.value;
    if (desired === undefined) {
      if (current !== undefined) {
        throw new Error(`verify failed: ${change.path} still set after delete`);
      }
    } else if (JSON.stringify(current) !== JSON.stringify(desired)) {
      throw new Error(`verify failed: ${change.path} has an unexpected value`);
    }
  }
  if (appliedCount === 0) {
    return { mode: "noop", warnings };
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw);
  return { mode, warnings };
}

// Span of the file's root object: `{ start, end }` (end inclusive), or null
// when the text does not open with an object.
function rootObjectSpan(raw) {
  const start = skipSilence(raw, 0, raw.length);
  if (start >= raw.length || raw[start] !== "{") return null;
  const end = scanJsonValueEnd(raw, start, raw.length);
  if (end < 0) return null;
  return { start, end };
}

// Resolves the effective `tuiSidebar` settings from a parsed config object.
export function resolveTuiSidebar(config) {
  const raw = config?.tuiSidebar;
  const block = typeof raw === "object" && raw !== null ? raw : {};
  return {
    ...BUILTIN_TUI_SIDEBAR,
    ...block,
    enabled: block.enabled ?? BUILTIN_TUI_SIDEBAR.enabled,
    pollMs: block.pollMs ?? BUILTIN_TUI_SIDEBAR.pollMs,
    maxLines: block.maxLines ?? BUILTIN_TUI_SIDEBAR.maxLines,
    filterBySession: block.filterBySession ?? BUILTIN_TUI_SIDEBAR.filterBySession,
    // `groupBy` (false | "session" | "agent"); honors a legacy boolean
    // `groupBySession` when `groupBy` itself is not set.
    groupBy: normalizeGroupBy(
      block.groupBy ?? block.groupBySession,
      BUILTIN_TUI_SIDEBAR.groupBy,
    ),
  };
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------
// Raw PTY output carries ANSI escape sequences and control characters. Rendered
// verbatim the TUI interprets them (colors, cursor moves, ...) and the console
// can look broken. The wrapper instead *visualizes* them by default, so they
// stay readable but inert; `stripAnsiSequences` drops them entirely.
//
//   "output": {
//     "stripAnsiSequences": false,               // <pty_exited> notification
//     "dialog": { "stripAnsiSequences": false }, // /pty-output dialog
//     "tool":   { "stripAnsiSequences": false }  // pty_read tool output
//   }
//
// The scopes are independent (no fallback between them). Unlike the two display
// scopes, `tool` does NOT visualize when false: the `pty_read` output stays raw
// (the real content, for the agent) and is only sanitized when set to true.
export const BUILTIN_OUTPUT = {
  stripAnsiSequences: false,
  dialog: { stripAnsiSequences: false },
  tool: { stripAnsiSequences: false },
};

// Resolves the effective `output` settings from a parsed config object.
export function resolveOutput(config) {
  const block = config?.output;
  const raw = typeof block === "object" && block !== null ? block : {};
  const dialog = typeof raw.dialog === "object" && raw.dialog !== null ? raw.dialog : {};
  const tool = typeof raw.tool === "object" && raw.tool !== null ? raw.tool : {};
  return {
    stripAnsiSequences: raw.stripAnsiSequences ?? BUILTIN_OUTPUT.stripAnsiSequences,
    dialog: {
      stripAnsiSequences: dialog.stripAnsiSequences ?? BUILTIN_OUTPUT.dialog.stripAnsiSequences,
    },
    tool: {
      stripAnsiSequences: tool.stripAnsiSequences ?? BUILTIN_OUTPUT.tool.stripAnsiSequences,
    },
  };
}

// Caret-notation visualization of control characters, so escape sequences show
// up as readable text (`ESC [ K` -> `^[[K`) instead of being interpreted:
//   - `\n` and `\t` are kept as-is (real newline / tab)
//   - `\r` becomes the two characters `\r` (a literal CR would move the cursor
//     to column 0 and overwrite the line)
//   - ESC (0x1b) -> `^[`; the other C0 controls -> `^X`; DEL (0x7f) -> `^?`
export function escapeControlChars(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t") {
      out += ch;
    } else if (ch === "\r") {
      out += "\\r";
    } else if (code < 0x20) {
      out += `^${String.fromCharCode(code + 64)}`;
    } else if (code === 0x7f) {
      out += "^?";
    } else {
      out += ch;
    }
  }
  return out;
}

// Fallback ANSI matcher for runtimes without `Bun.stripANSI` (CSI/OSC plus the
// simple two-character escapes).
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// Renders raw PTY output as display text:
//   stripAnsiSequences=false -> visualize (caret notation, readable + inert)
//   stripAnsiSequences=true  -> drop ANSI sequences (and any remaining control
//                               characters except real newlines/tabs)
export function sanitizeOutputText(text, { stripAnsiSequences = false } = {}) {
  const input = String(text ?? "");
  if (!stripAnsiSequences) return escapeControlChars(input);

  const stripped =
    typeof Bun !== "undefined" && typeof Bun.stripANSI === "function"
      ? Bun.stripANSI(input)
      : input.replace(ANSI_SEQUENCE, "");
  return stripped.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// ---------------------------------------------------------------------------
// RPC contract
// ---------------------------------------------------------------------------
// Definitions shared by the server half (index.js registers the handlers via
// `ctx.rpc.register(PtyRpc, { ... })`) and the TUI half (tui.tsx calls them via
// `context.client.rpc(PtyRpc)`). Keeping one definition for both sides means the
// method/event schemas can never drift.

// The renderer only needs the values to survive transport, so outputs use a
// trivial Standard Schema `validate` (the runtime's `tP`/"~standard" branch).
// JSON-Schema `output` validation misbehaves on opencode 2.0.26.
const passthrough = () => ({
  "~standard": {
    version: 1,
    vendor: "opencode-pty-extended",
    validate: (value) => ({ value }),
  },
});

const PTY_RPC_METHODS = {
    // All sessions the manager currently tracks (running + exited).
    list: {
      input: {
        type: "object",
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Raw output buffer for one session (the caller visualizes or strips it
    // according to the `output.dialog` config before displaying). Also carries
    // the session's live terminal size (`cols`/`rows`) so the `/pty-output`
    // viewer can size its dialog from the PTY.
    read: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Send input to a session. The magic resize envelope is understood here
    // too, because it is handled in `manager.write`.
    write: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          data: { type: "string" },
        },
        required: ["id", "data"],
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Kill a session (optionally dropping it from the list entirely).
    kill: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          cleanup: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Start (if needed) the PTY web UI server and open it in the default
    // browser. An optional `id` selects that session in the web UI
    // (`/index.html?session=<id>`). Returns the URL in `message`.
    // `open: false` ensures/starts the server but does NOT launch a browser —
    // the URL-only variant the TUI's `/pty-show-server-url` command uses.
    openWeb: {
      input: {
        type: "object",
        properties: { id: { type: "string" }, open: { type: "boolean" } },
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Restart the PTY stack (index.js ptyRestartStack): live-config reload +
    // EAGER web-UI server recycle. `scope` omitted -> "soft" (running PTYs
    // survive); "kill" additionally kills every RUNNING PTY first. Returns a
    // summary report (recycled / killed / url / urlChanged / error).
    restart: {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["soft", "kill"] },
        },
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // The server half's fully merged, already-resolved TUI settings (config
    // files + `plugins[].options`). The TUI/CLI half uses these instead of its
    // own load, because opencode does not forward `plugins[].options` from
    // opencode.json(c) to the CLI plugin context - the TUI half would otherwise
    // only ever see the config files. Returns `{ tuiSidebar, output }`.
    settings: {
      input: {
        type: "object",
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // The runtime-only "show all PTYs" override for the TUI sidebar (state
    // lives in the server half, see index.js showAllOverride). Input:
    //   {}                    -> read only (returns the current state)
    //   { value: true|false } -> set the override (true = show every session's
    //                            PTYs, false = current session only)
    //   { value: null }       -> clear the override (follow config again)
    //   { toggle: true }      -> flip the effective state
    // Returns `{ value, effective, source }` (`value` = the raw override,
    // `effective` = what the sidebar now shows, `source` = "override" or
    // "config"). The handler emits the `settings` event when the state
    // changed, so every connected TUI half re-pulls and re-renders.
    showAll: {
      input: {
        type: "object",
        properties: {
          value: {},
          toggle: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Stamp presence: the TUI half reports its currently open/in-view session
    // ids on a heartbeat (and on tab switches). Server stamps each id with the
    // "tui" source until the heartbeats stop (TUI closed -> goes stale).
    present: {
      input: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["ids"],
        additionalProperties: false,
      },
      output: passthrough(),
    },
    // Apply draft changes to the RUNNING plugin (memory only, nothing is
    // written to any config file). `changes` are `{ path, value }` (value null
    // = clear the key at runtime, i.e. fall back to the value of the layer
    // below). The overrides live until the plugin restarts (/restart, or the
    // host reloading the plugin); a subsequent save always wins because the
    // file walk re-runs under the recorded overrides.
    configApply: {
      input: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                value: {},
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        required: ["changes"],
        additionalProperties: false,
      },
      output: passthrough(),
    },
}

// A SINGLE shared id, deliberately. Probes proved (2026-11-01) that the
// OpenCode rpc route resolves a registered contract against the SERVER ROOT
// scope (the server's cwd), not the requester's directory: posting
// `opencode-pty-extended_C_Users_nabil_f5720d96` from `C:\Users\nabil`
// reached the handler, while posting the gist/System32 instances'
// per-location ids from their own directories returned `rpc.unavailable`.
// OpenCode loads one plugin instance per LOCATION and every instance
// registered a per-location id - but only the server-root instance's
// registration is ever visible to the route, so per-location ids can never
// resolve for the other locations (and cannot work across a remote server
// at all, where the directories live on different machines).
//
// The root instance therefore serves every location, as it always did. The
// old "served by whichever instance registered first" bug that per-location
// ids tried to fix is solved differently: the only instance-specific part of
// the RPC, the /pty-config payload, became a LOCAL, directory-aware
// computation (see configGetPayload) instead of an RPC fetch. Session state
// (list/read/write/kill) lives in ONE shared manager on the server, so which
// instance serves it does not matter.
export const PtyRpc = Rpc.define({
  id: "opencode-pty-extended",
  methods: PTY_RPC_METHODS,
  events: {
    // Emitted whenever the session list changes, so the sidebar can refresh
    // without polling.
    changed: {
      schema: { type: "object", additionalProperties: false },
    },
    // Emitted after every live config reload on the server half (the dialog's
    // apply, a save, `pty_refresh`, `pty_restart`), so the TUI sidebar
    // re-pulls its settings (`tuiSidebar.*` / `output.*`) and re-renders the
    // affected view immediately instead of waiting for /pty-refresh or a poll.
    settings: {
      schema: { type: "object", additionalProperties: false },
    },
  },
});

// ---------------------------------------------------------------------------
// /pty-config payload — directory-aware, runs in BOTH halves
// ---------------------------------------------------------------------------
// The dialog needs the schema rows, per-path provenance (config-file layers +
// the `plugins[].options` override) and the save targets. Rendering and file
// writes are purely local (`node:fs` is available in both halves), and the rpc
// route's server-root scope means an RPC fetch could only ever return the
// SERVER ROOT location's layers - the wrong directory for every other
// location. So index.js's createConfigController wraps these helpers with its
// live-object extras (runtimeOverrides + hot reload), while the TUI half calls
// them directly with its own `context.location.directory`.

// Probes whether a save could actually create/overwrite the given target.
// Returns `{ writable: true }` or `{ writable: false, deny: <reason> }`.
// Access checks are not trusted on Windows (an ACL-locked folder still passes
// `accessSync(dir, W_OK)`), so the probe is a real create/delete of a uniquely
// named temp file inside the folder the save would need to touch - the same
// permission minus the bytes. When the destination's own folder does not
// exist, the nearest EXISTING ancestor is probed (that is what the save's
// recursive mkdir would have to write into). The temp artifact is always
// cleaned up; unexpected probe errors never claim unwritable (the actual
// save still surfaces them).
export function probeConfigTargetWritable(target) {
  if (!target?.file) return { writable: true };
  let info = null;
  try {
    if (existsSync(target.file)) info = statSync(target.file);
  } catch {
    /* unreadable stat - let the real write surface whatever that is */
  }
  if (info) {
    if (info.isDirectory()) return { writable: false, deny: "path is a folder" };
    // Windows maps the read-only attribute to cleared write bits: an existing
    // `+r` file fails the save with EPERM even when the folder is writable.
    if ((info.mode & 0o222) === 0) return { writable: false, deny: "file is read-only" };
  }
  // Walk up to the nearest existing directory (the save may mkdir the chain).
  let probeDir = dirname(target.file);
  for (;;) {
    try {
      const s = statSync(probeDir);
      if (s.isDirectory()) break;
      return { writable: false, deny: "parent path is a file" };
    } catch {
      const parent = dirname(probeDir);
      if (parent === probeDir) break; // drove to the root; probe it as-is
      probeDir = parent;
    }
  }
  const probeFile = join(
    probeDir,
    `.opencode-pty-extended-write-probe-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    const fd = openSync(probeFile, "a");
    try {
      closeSync(fd);
    } finally {
      try {
        unlinkSync(probeFile);
      } catch {
        /* best effort cleanup */
      }
    }
  } catch (error) {
    const code = error?.code ?? "";
    if (code === "EACCES" || code === "EPERM") {
      return { writable: false, deny: "no write permission" };
    }
    /* other failures: inconclusive, treat as writable and let the save report */
  }
  return { writable: true };
}

// Builds the full dialog payload for one project directory. `override` is the
// host's `plugins[].options` (best-effort: the CLI half never receives them);
// `runtimeOverrides` are Apply-only in-memory values known to the server half.
export function configGetPayload(projectDir, { override, runtimeOverrides } = {}) {
  const dir = projectDir ?? process.cwd();
  const { layers } = configLayers(dir);
  const provenance = resolveConfigProvenance(CONFIG_SCHEMA, layers, override);
  const overrides = runtimeOverrides ?? {};
  // The value shown per row is the provenance-resolved one: our project >
  // our global > opencode's `plugins[].options` > shipped > default (matches
  // what setup actually applies). A runtime-only Apply overrides the display
  // value and marks the row `applied`.
  const settings = CONFIG_SCHEMA.map((entry) => {
    const info = provenance[entry.path] ?? {};
    const applied = Object.prototype.hasOwnProperty.call(overrides, entry.path);
    return {
      path: entry.path,
      type: entry.type,
      enum: entry.enum ?? undefined,
      value: applied ? (overrides[entry.path] === undefined ? entry.default : overrides[entry.path]) : info.value,
      effective: (info.source ?? "default") === "default",
      source: applied ? "applied" : info.source,
      file: applied ? undefined : (info.file ?? undefined),
      restart: info.restart ?? false,
      desc: entry.desc,
    };
  });
  // Pre-flight every save target: `writable: false` rows are rendered offer
  // their `deny` reason in the save dialog (suffix) and refuse picks. Only
  // attached when NOT writable so the payload shape stays stable.
  const probed = (target) => {
    if (!target) return target;
    const can = probeConfigTargetWritable(target);
    return can.writable ? target : { ...target, writable: false, deny: can.deny };
  };
  const payload = {
    settings,
    targets: {
      global: probed(globalConfigFile()),
      project: {
        directory: dir,
        auto: probed(resolveProjectTarget(dir, undefined, false)),
        // Offered even when the `.opencode/` folder does not exist yet:
        // `create: true` means choosing it creates folder + file. The
        // sibling is offered when opencode.json[c] exists (existing file
        // preferred) or, when neither location applies, still offered as a
        // "will create" pick - the dialog surfaces `create` either way.
        opencode: probed(projectConfigFile(dir, "opencode", true)),
        sibling: probed(projectConfigFile(dir, "sibling", true)),
      },
    },
  };
  return JSON.parse(JSON.stringify(payload));
}

// Persists draft changes from the dialog into the chosen config file, patching
// the raw JSONC text (comments survive). `changes` are `{ path, value }`
// (value null = clear the key); `target` picks the file:
//
//   { scope: "global" }                           -> ~/.config/opencode/...
//   { scope: "project", where: "opencode"|"sibling" }
//                                                 -> project config
//
// An explicit `where` may create its folder/file; without one the first
// existing project location is auto-picked and reported back. No reload here:
// the TUI half has no live object, and the server half layers its own reload
// on top in createConfigController.
export function configSetLocal(projectDir, input) {
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  if (changes.length === 0) return { ok: false, error: "no-changes" };
  const target = input?.target ?? {};
  let destination;
  if (target.scope === "project") {
    destination = resolveProjectTarget(projectDir ?? process.cwd(), target.where, Boolean(target.where));
    if (!destination) return { ok: false, error: "no-project-target" };
  } else {
    destination = globalConfigFile();
  }
  try {
    const result = writeConfigValues(destination.file, changes, { create: true });
    return JSON.parse(
      JSON.stringify({
        ok: true,
        file: destination.file,
        mode: result.mode,
        warnings: result.warnings ?? [],
        scope: target.scope === "project" ? "project" : "global",
      }),
    );
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), file: destination.file };
  }
}
