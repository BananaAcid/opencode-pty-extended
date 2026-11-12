/** @jsxImportSource @opentui/solid */
// ~/.config/opencode/plugins/opencode-pty-extended/tui.tsx
//
// TUI (CLI) half of the opencode-pty-extended wrapper.
//
// opencode loads the two halves of this plugin directory:
//   server -> index.js   (owns the PTY manager)
//   tui    -> tui.tsx    (this file)
//
// The PTY sessions live in the server process, so this sidebar reaches them
// through the RPC methods registered by the server half. It renders a compact
// session list into "sidebar.content" and exposes palette/slash commands to
// view output and kill sessions.
//
// Settings (the `tuiSidebar` and `output` blocks) come from the server half
// over RPC, so they honour `plugins[].options` in opencode.json(c) just like
// the server-side features do — the CLI never receives those options directly.
// Config files are the fallback when the server half is unreachable. The
// sidebar is on by default, so `"tuiSidebar": { "enabled": false }` turns it
// back off.

import { Plugin } from "@opencode/plugin/tui"
import {
  For,
  Show,
  createSignal,
  createMemo,
  onCleanup,
} from "solid-js"
import { appendFileSync } from "node:fs"
import { InputRenderable, InputRenderableEvents } from "@opentui/core"
import { loadUserConfig, deepMerge, resolveTuiSidebar, resolveOutput, sanitizeOutputText, PtyRpc, configGetPayload, configSetLocal } from "./shared.js"

// TEMPORARY /pty-config diagnostics: decisions about dead keys and mouse
// events inside the compiled TUI cannot be made from source alone, so every
// interesting event appends one line to this file. Remove once ConfigDialog is
// verified end-to-end.
const DBG_LOG =
  `${process.env.TEMP || process.env.TMP || "/tmp"}/opencode-pty-config-debug.log`
function dbg(msg: string) {
  try {
    appendFileSync(DBG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* diagnostics must never break the dialog */
  }
}


type PtySession = {
  id: string
  title?: string
  description?: string
  command?: string
  args?: string[]
  workdir?: string
  status?: string
  exitCode?: number | null
  exitSignal?: string | null
  pid?: number
  createdAt?: string
  lineCount?: number
  // The opencode session that spawned this PTY (exposed by the server half's
  // RPC `list`); used to scope the sidebar/pickers to the current session.
  parentSessionId?: string | null
  // Lineage exposed by the server half (`installManagerGroupBySession`): the
  // session that called `pty_spawn` (the subagent, if any), its agent, the root
  // conversation it rolls up to, and whether it differs from the initiator.
  initiatorSessionId?: string | null
  initiatorAgent?: string | null
  rootSessionId?: string | null
  isSubagent?: boolean
  // Grouping keys (present when `groupBy` is not false): `groupSessionId` is the
  // root conversation; `subagentSessionId` is the sub-session in "agent" mode.
  groupSessionId?: string | null
  groupSessionTitle?: string | null
  subagentSessionId?: string | null
  subagentSessionTitle?: string | null
}

const DOT: Record<string, string> = {
  running: "●",
  killing: "◐",
  killed: "○",
  exited: "○",
}

// Mirrors the web UI's `.status-*` badge colors (dist/web/index.html).
const STATUS_COLOR: Record<string, string> = {
  running: "#238636",
  killing: "#d29922",
  killed: "#8957e5",
  exited: "#da3633",
}

function shortId(id: string) {
  return String(id ?? "").replace(/^pty_/, "").slice(0, 6)
}

function pidText(session: PtySession) {
  return session.pid ? String(session.pid) : shortId(session.id)
}

// The session's display name - the same one the web UI's session card (and so
// the session list in the `/pty-kill` and `/pty-output` pickers) uses:
// description first, then title, then the command line.
function sessionName(session: PtySession) {
  return session.description || session.title || session.command || session.id
}

function label(session: PtySession, pidWidth = 0) {
  // Prefix the name with the process id (falling back to the short id for
  // sessions that never got a pid), left-padded to `pidWidth` so every title in
  // the sidebar starts in the same column. Truncation is left to the renderer
  // (the <text truncate> prop), so it ellipsizes at the real sidebar width.
  return `${pidText(session).padEnd(pidWidth)}  ${sessionName(session)}`
}

// The built-in `dialog.confirm` message box WRAPS long words — there is no
// truncate prop on it (medium dialog = 60 cols, inset 3 -> ~54 message cells,
// proven: 54-cell lines fit while 55 wrapped). Confirm-dialog lines and names
// are therefore pre-truncated here to `CONFIRM_LINE_MAX` cells with a
// right-side ellipsis — the same "…" the PTY sidebar rows show at their edge.
const CONFIRM_LINE_MAX = 54

// Hard-truncate a sentence to `max` cells, replacing its tail with a
// right-side ellipsis ("mid-sentence truncation", as the sidebar renders).
function truncateSentence(s: string, max: number) {
  const text = String(s ?? "")
  return text.length > max
    ? `${text.slice(0, Math.max(1, max - 1))}…`
    : text
}

function tail(text: unknown, maxLines: number) {
  const lines = String(text ?? "").split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n")
}

// Widest row of the viewer body, in terminal cells. OpenTUI's text renderable
// never reports an intrinsic width to layout, so a <scrollbox> child sized
// "auto" simply fills the viewport - the scrollbox then cannot detect a
// horizontal overflow and its horizontal scrollbar never appears. Measuring the
// longest row lets OutputViewer pin an explicit width on the text instead.
//
// `Bun.stringWidth` is exact for the wide (CJK/emoji) and zero-width
// (combining) code points a PTY can emit, and OpenTUI's text buffer renders a
// literal tab as two cells, so tabs are expanded before measuring.
const TAB_CELLS = 2

// East-Asian Wide / Fullwidth and emoji ranges - only used by the fallback when
// Bun's width helper is unavailable.
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function cellWidth(line: string): number {
  const expanded = line.indexOf("\t") >= 0 ? line.replace(/\t/g, " ".repeat(TAB_CELLS)) : line
  const bun = (globalThis as { Bun?: { stringWidth?: (value: string) => number } }).Bun
  if (bun && typeof bun.stringWidth === "function") {
    return bun.stringWidth(expanded)
  }
  let width = 0
  for (const ch of expanded) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue
    if (cp >= 0x0300 && cp <= 0x036f) continue
    width += isWideCodePoint(cp) ? 2 : 1
  }
  return width
}

function maxLineWidth(text: string): number {
  let width = 0
  for (const line of text.split("\n")) {
    const lineWidth = cellWidth(line)
    if (lineWidth > width) width = lineWidth
  }
  return width
}

// Scrollable viewer for `/pty-output`. A plain `dialog.alert` clips long output
// with no way to scroll, so this renders a custom dialog whose body is an
// OpenTUI <scrollbox>. The dialog frame itself has a *fixed* width (60/88/116
// depending on `size`) and a content-driven height, so the viewer must give the
// scrollbox an explicit `height` - a percentage/flexGrow resolves against the
// content and never bounds the viewport (no scrollbar). Lines use
// wrapMode="none" so horizontal panning preserves the exact buffer layout, and
// the footer's `close` button (a clickable box, like the built-in alert) closes
// the dialog; the Escape binding lives in a keymap layer created inside the
// component so OpenCode tears it down when the dialog closes.
function OutputViewer(props: {
  context: any
  id: string
  pid?: number | null
  text: string
  size: "medium" | "large" | "xlarge"
  height: number
}) {
  const context = props.context
  const dialog = context.ui.dialog
  // Set the frame size *here*, during the dialog element's own setup. The
  // host's `replace()` - which is what the plugin `show()` calls internally -
  // resets both `size` and `centered`, so a `set()` issued before `show()` is
  // silently discarded. Upstream's own shell-output dialog does the same
  // (setSize/setCentered at the top of its component, i.e. after that reset).
  dialog.set?.({ size: props.size, centered: true })
  const buttonBg = context.theme?.background?.action?.primary?.focused ?? "#1f6feb"
  const buttonFg = context.theme?.text?.action?.primary?.focused ?? "#ffffff"
  // Secondary text (`text.muted`) for the session id after the title's PID.
  const mutedFg = context.theme?.text?.muted ?? "#8b949e"
  const lineWidth = maxLineWidth(props.text)

  const dispose = context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "opencode-pty.output.close",
        title: "PTY: close output",
        bind: "escape",
        run: () => context.ui.dialog.clear(),
      },
    ],
  }))
  onCleanup(() => {
    if (typeof dispose === "function") dispose()
  })

  return (
    <box flexDirection="column" width="100%" gap={1} paddingLeft={2} paddingRight={2}>
      <text>
        <b>{`PTY ${props.pid ?? shortId(props.id)}`}</b>
        <span fg={mutedFg}> {props.id}</span>
      </text>
      {/*
        Horizontal scrolling needs two things that `@opentui/solid` cannot
        express as props:

        1. The scrollbox's content box must be allowed to grow past the
           viewport. `ScrollBoxRenderable` only does that when constructed with
           `scrollX: true`, but `scrollX` is constructor-only and has no setter -
           the reconciler builds the renderable with just `{ id }` and then
           assigns every other prop, so passing `scrollX` here is a no-op and
           the content box keeps the default `maxWidth: "100%"` clamp.
        2. The <text> needs an explicit width. OpenTUI's text renderable reports
           no intrinsic width to layout, so left to `auto` it fills the
           viewport and the scrollbox sees no overflow.

        So measure the longest row and (a) pin the text to it, and (b) drop the
        clamp by raising the content box's `maxWidth` from the scrollbox ref
        (children/ref run before the first layout, so no re-render is needed).
      */}
      <scrollbox
        ref={(el: any) => {
          if (lineWidth > 0) el.content.maxWidth = lineWidth
        }}
        width="100%"
        height={props.height}
        scrollY
        verticalScrollbarOptions={{ showArrows: true }}
        horizontalScrollbarOptions={{ showArrows: true }}
      >
        <text width={lineWidth > 0 ? lineWidth : undefined} wrapMode="none">
          {props.text}
        </text>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={buttonBg}
          onMouseUp={() => context.ui.dialog.clear()}
        >
          <text fg={buttonFg}>close</text>
        </box>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// /pty-config — the settings dialog
// ---------------------------------------------------------------------------
// The dialog data is computed LOCALLY (shared.js `configGetPayload` on this
// CLI's `context.location.directory`): layers, provenance and save targets are
// file operations the TUI half can do itself. Fetching it over RPC made the
// dialog show ANOTHER location's project layers — the rpc route only resolves
// registrations made under the server-root scope (see shared.js PtyRpc for the
// probe evidence), so the root instance answers for everyone. Edits live in a
// client-side draft; `configSetLocal` writes them into the chosen config file
// patching the raw JSONC text (comments survive). Only the Apply button still
// rides the RPC (`configApply`): it overlays runtime-only values on the
// server-installed instance. Restart tiers: `autostart` needs OpenCode's full
// `/restart` (read at plugin load by the upstream package); `port` / `hostname`
// / terminalFont / webUi need a PTY-stack (webserver) restart; everything else
// hot-applies — plus a best-effort `configApply` overlay after the file write
// (same mechanism a server-side save used to run).

type ConfigSetting = {
  path: string
  type: "bool" | "number" | "string" | "enum"
  enum?: unknown[]
  value?: unknown
  effective?: boolean
  source?: string
  file?: string
  restart?: boolean | "full"
  desc?: string
}

type ConfigPayload = {
  settings?: ConfigSetting[]
  targets?: {
    global?: { file: string; create: boolean } | null
    project?: {
      directory?: string
      auto?: { file: string; create: boolean } | null
      opencode?: { file: string; create: boolean } | null
      sibling?: { file: string; create: boolean } | null
    } | null
  } | null
}

// Provenance badge: keyword only. `opencode` = opencode's own
// `plugins[].options` merge (the lowest file layer, below every plugin config
// file); `applied` = an Apply-only runtime change (in memory, unsaved).
const BADGE_TEXT: Record<string, string> = {
  default: "[default]",
  shipped: "[default]",
  global: "[global]",
  project: "[project]",
  opencode: "[opencode]",
  applied: "[applied]",
}
const BADGE_COLOR: Record<string, string> = {
  default: "#8b949e",
  shipped: "#8b949e",
  global: "#d2a8ff",
  project: "#79c0ff",
  opencode: "#e3b341",
  applied: "#56d364",
}

// Apply-only runtime overlay values, mirrored on the TUI side. The server's
// own overlay (`live.runtimeOverrides`) is unreachable from the local dialog
// (the config read/write path is file-based, no RPC), so the dialog records
// here what it successfully applied: those rows show the applied value in the
// value column (green) with the green `[applied]` badge — until a file save
// (mirror entry removed) or ↺/right-click restore (overlay dropped) or an
// OpenCode `/restart` (process dies, overlay gone) settles them. Process-wide,
// so reopening the dialog in the same TUI still shows them.
let cfgRuntimeApplied = new Map<string, unknown>()

// Deep-equality across primitives/null/undefined for draft-vs-file and
// draft-vs-runtime comparisons (booleans/numbers/strings - the schema's types).
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// Restart hint cell: rendered as its own fixed-width column (the rightmost
// one) on rows whose schema entry sets `restart`; blank otherwise, so the
// badge and ` ↺` columns stay aligned. Width-coupled to the `valW` budget.
// Two tiers (user-locked): "full" (read at plugin load — only OpenCode's
// /restart applies it) vs web (a PTY-stack soft restart rebuilding the
// web-UI server applies it). Every cell is width-padded to RESTART_W so the
// tier texts can differ without moving the columns.
const RESTART_W = 19 // width of the widest tier text, "(needs web restart)"
function restartCellText(setting: ConfigSetting): string {
  const text = !setting.restart
    ? ""
    : setting.restart === "full"
      ? "(needs /restart)"
      : "(needs web restart)"
  return ` ${text.padEnd(RESTART_W)}`
}

// Sections the dialog groups settings into, by the path's first segment. Root
// keys (port/hostname/autostart) roll up as `general` to keep the dialog's
// shapes consistent.
function sectionOf(path: string): string {
  const first = String(path ?? "").split(".")[0]
  if (first === "port" || first === "hostname" || first === "autostart") return "general"
  return first || "general"
}

// The dialog row label: the path without its section prefix.
function rowLabel(setting: ConfigSetting, section: string): string {
  const prefix = section === "general" ? `${setting.path}` : setting.path.slice(section.length + 1)
  return prefix || setting.path
}

type ConfigListItem =
  | { kind: "header"; foldKey: string; label: string; open: boolean; level: number }
  | {
      kind: "row"
      setting: ConfigSetting
      index: number
      foldKey: string
      leaf: string
      level: number
      // Absolute line of this row within the FULL rendered item list
      // (headers count). The body scrollbox must include this line for the
      // marker row to be on screen; arrow-key marker following clamps
      // `s.viewTop` around it.
      line: number
      // Stamps, all captured at rebuild time so the render callback stays a
      // pure function of the item (no signal reads that could go stale).
      isCursor: boolean
      changed: boolean
      value: string
      isEditing: boolean
      editValue: string
    }

function ConfigDialog() {
  // All mount-time data comes from the module-level dialog state; the
  // remounted snapshot is rendered with no props at all.
  const s = cfgState!
  if (!s) {
    return <box><text>PTY config closed</text></box>
  }
  const context = s.context
  const dialog: any = context.ui.dialog
  const mutedFg = context.theme?.text?.muted ?? "#8b949e"
  const buttonBg = context.theme?.background?.action?.primary?.focused ?? "#1f6feb"
  const buttonFg = context.theme?.text?.action?.primary?.focused ?? "#ffffff"
  // Secondary footer buttons (apply/save): builtin dialogs render secondary
  // actions with NO default background (hover-fill only under new-designs),
  // but the user wants a visible muted fill here. `#21262d` matches the
  // dialog's card/circle palette.
  const secondaryBg = "#21262d"
  // The backdrop guard swallows outside mousedown/mouseup on EVERY mount (the
  // guard's own lifecycle ends with the mount, so no disable-flip is needed).
  // Swallow helper for the backdrop guard events (mousedown+mouseup released
  // outside the content box would otherwise clear the dialog stack).
  const stopEvent = (e: any) => {
    dbg(`guard swallow type=${e?.type ?? "?"} btn=${e?.button ?? "?"}`)
    // Empty-space click: not the search — mouse rule applies here too.
    blurSearch()
    if (typeof e?.stopPropagation === "function") e.stopPropagation()
  }
  // Close: delegated to the module-level owner of the dialog state (it owns
  // the key hook, the pending-refresh timer and the host dialog stack).
  const close = closeConfigDialog
  const guardProps = () => ({ onMouseDown: stopEvent, onMouseUp: stopEvent })

  // TERMINAL RESIZE -> remount. Every geometry constant here (column widths,
  // windowing height) is computed once per mount, and the host never re-renders
  // the dialog when the terminal changes size — a resized terminal used to keep
  // serving stale widths. Poll the renderer dims each ~250 ms and rebuild
  // (queueRefresh -> host `replace` remount, cheap at ~34 rows) when they move.
  // One interval per dialog open: re-created per remount (the old one is
  // cleared first), and `closeConfigDialog` clears it on close.
  if (s.geoTimer) clearInterval(s.geoTimer)
  s.geoW = Number(context.renderer?.width) || 0
  s.geoH = Number(context.renderer?.height) || 0
  s.geoTimer = setInterval(() => {
    const w = Number(s.context.renderer?.width) || 0
    const h = Number(s.context.renderer?.height) || 0
    if (w === s.geoW && h === s.geoH) return
    dbg(`terminal resize ${s.geoW}x${s.geoH} -> ${w}x${h}`)
    const wasH = s.geoH
    s.geoW = w
    s.geoH = h
    // WIDTH-ONLY resize adapts IN PLACE (no remount -> no top-flash): the
    // value cell width (`cfgval.` = valW + 1) is all that moves when the
    // height is unchanged, and every
    // row repaints exactly like the in-place value patch does (proven path).
    // A height change moves `visibleRows`/the scrollbox itself — that remount
    // is rare and keeps the (now exact) restore.
    if (wasH === h) {
      if (applyResizeInPlace(w)) {
        dbg("resize adapted in place")
        return
      }
      dbg("resize in-place failed — remount")
    }
    queueRefresh()
  }, 250)

  const settings = () => s.data.settings ?? []
  const targets = () => s.data.targets ?? null

  // REPLACE-REBUILD ARCHITECTURE. Inside the host's DialogProvider subtree the
  // component reactivity is unreliable in the live binary (context/owner
  // failures proven by the "No renderer found" overlay crash + the dead
  // `<For>` update channel), while one-shot mounts always painted. So the
  // dialog state lives at MODULE level (survives remounts) and every mutation
  // calls `queueRefresh()`, which re-mounts the WHOLE dialog via the host's
  // `dialog.show` (`replace` semantics. This component is a STATELESS
  // SNAPSHOT: all fields read once at mount; the item list is built once; no
  // live signals are wired to the tree.
  // Field aliases: keep the existing signal-shaped read/write call sites
  // (query(), draftMap(), folds(), cursor(), editing(), busy()) intact.
  const query = () => s.query
  const draftMap = () => s.drafts
  const folds = () => s.folds
  const cursor = () => s.cursor
  const editing = () => s.editing
  const busy = () => s.busy
  const setQueryRaw = (v: string) => {
    if (s) s.query = v
  }
  const setCursorRaw = (n: number) => {
    if (s) s.cursor = n
  }
  const setEditing = (p: string | null) => {
    if (s) s.editing = p
  }
  const setBusy = (b: boolean) => {
    if (s) s.busy = b
  }
  const setQuery = (v: string) => {
    setQueryRaw(v)
    rebuild()
  }
  const setCursor = (at: number) => {
    setCursorRaw(at)
    rebuild()
  }
  const setDraftMap = (fn: (prev: Map<string, unknown>) => Map<string, unknown>) => {
    if (s) s.drafts = fn(s.drafts)
  }
  const setFoldsRaw = (fn: (prev: Set<string>) => Set<string>) => {
    if (s) s.folds = fn(s.folds)
  }
  // Terminal height — buildList's box-height mirror reads it, and buildList()
  // runs at the mount-time snapshot below, so it must be declared BEFORE
  // that call.
  const termH = Number(context.renderer?.height) || 30
  // Snapshot items: built exactly once per mount (see the stateless-snapshot
  // note above); `s.items` is what the module key handler — running OUTSIDE
  // this component between/after remounts — iterates.
  const items: ConfigListItem[] = buildList()
  s.items = items
  const itemsSig = () => items
  // REBOUND PER MOUNT. The module-level key channel (`installConfigKeyChannel`)
  // dispatches through `s.actions`, so each remount points the actions at this
  // mount's local mutation functions (hoisted function declarations plus the
  // `setCursor` const defined above).
  s.actions.setCursor = setCursor
  s.actions.activate = activate
  s.actions.stepEnum = stepEnum
  s.actions.setValue = setValue
  s.actions.cancelEdit = cancelEdit
  s.actions.commitEdit = commitEdit
  s.actions.saveFlow = saveFlow
  // ctrl+x routes through resetRow (draft-undo -> clear) instead of direct
  // setValue(null); it needs to be reachable from the module-level key handler.
  s.actions.resetRow = resetRow
  // Arrow/tab marker moves patch rows in place (no rebuild): the module-level
  // `moveMarker` calls this so the detail line keeps following the selection.
  s.actions.patchDetail = () => {
    patchDetailLineInPlace(s.cursor)
  }
  function rebuild() {
    queueRefresh()
    try {
      const root: any = context.renderer?.root
      dbg(`requestRender root=${root ? root.id ?? "present" : "---"}`)
      root?.requestRender?.()
    } catch (cause: any) {
      dbg(`requestRender failed: ${cause?.message ?? cause}`)
    }
  }

  function orderedSections(): { name: string; settings: ConfigSetting[] }[] {
    const out: { name: string; settings: ConfigSetting[] }[] = []
    const byName = new Map<string, ConfigSetting[]>()
    for (const setting of settings()) {
      const name = sectionOf(setting.path)
      let bucket = byName.get(name)
      if (!bucket) {
        bucket = []
        byName.set(name, bucket)
        out.push({ name, settings: bucket })
      }
      bucket.push(setting)
    }
    return out
  }

  // Deepest tree level (used to keep the value/badge columns aligned across
  // depths): every row's label field is padded up to one common column.
  const maxDepth = Math.max(
    0,
    ...settings().map((s) => Math.max(0, rowLabel(s, sectionOf(s.path)).split(".").length - 1)),
  )

  // The complete item list: section headers + a TREE of their (possibly
  // filtered) settings. Remaining dotted labels nest (`webUi.viewerResize.*`
  // renders as a `▼ viewerResize` sub-header, +4 indent per level). Fold keys
  // are full paths (`webUi`, `webUi.viewerResize`). While searching, folds
  // don't hide results and empty groups disappear. The window/sticky-header
  // slice is applied here too, so one call produces exactly the render set.
  function buildList(): ConfigListItem[] {
    const q = query().trim().toLowerCase()
    const searching = q.length > 0
    const fm = folds()
    const out: ConfigListItem[] = []
    let index = 0
    // Plain rows first (first-appearance order), then every subsection —
    // a section reads as keys, then its nested groups, like the sidebar.
    const emit = (
      groups: { setting: ConfigSetting; parts: string[] }[],
      keyBase: string,
      level: number,
    ) => {
      const buckets = new Map<string, { setting: ConfigSetting; parts: string[] }[]>()
      for (const g of groups) {
        const head = g.parts[0]
        let bucket = buckets.get(head)
        if (!bucket) {
          bucket = []
          buckets.set(head, bucket)
        }
        bucket.push(g)
      }
      for (const [head, bucket] of buckets) {
        if (!bucket.every((b) => b.parts.length === 1)) continue
        for (const g of bucket) {
          out.push({ kind: "row", setting: g.setting, index: index++, foldKey: keyBase, leaf: head, level, isCursor: false, changed: false, value: "", isEditing: false, editValue: "", line: 0 })
        }
      }
      for (const [head, bucket] of buckets) {
        if (bucket.every((b) => b.parts.length === 1)) continue
        const foldKey = `${keyBase}.${head}`
        const open = searching || !fm.has(foldKey)
        out.push({ kind: "header", foldKey, label: head, open, level })
        if (!open) continue
        emit(
          bucket.map((b) => ({ setting: b.setting, parts: b.parts.slice(1) })),
          foldKey,
          level + 1,
        )
      }
    }
    for (const section of orderedSections()) {
      const rows = searching
        ? section.settings.filter(
            (s) => s.path.toLowerCase().includes(q) || String(s.desc ?? "").toLowerCase().includes(q),
          )
        : section.settings
      if (rows.length === 0) continue
      const open = searching || !fm.has(section.name)
      out.push({
        kind: "header",
        foldKey: section.name,
        label: section.name,
        open,
        // -1: section headers render at column 0 (`(level + 1) * 4`), while
        // sub-headers (level 0+) sit one step in alongside their sibling rows.
        level: -1,
      })
      if (!open) continue
      emit(
        rows.map((s) => ({ setting: s, parts: rowLabel(s, section.name).split(".") })),
        section.name,
        0,
      )
    }
    // Stamp rows: clamped cursor, draft markers, current values, the editor
    // row (editVal is also part of the draft pass — stamped only when the row
    // opens its editor).
    const dm = draftMap()
    const editingPath = editing()
    const markLines = (list: ConfigListItem[]) => {
      // Absolute line of every row within the FULL rendered list — headers
      // count. This is the number the body scrollbox must include so the
      // marker row is on screen (`s.viewTop <= row.line <= s.viewTop + s.boxH
      // - 2`, with the adjoining line in reserve on arrow-key scrolls).
      let ln = 0
      for (const item of list) {
        if (item.kind === "row") {
          item.line = ln
        }
        ln++
      }
    }
    let rowIndex = 0
    const ci = Math.min(cursor(), Math.max(0, out.filter((i) => i.kind === "row").length - 1))
    for (const item of out) {
      if (item.kind !== "row") continue
      item.isCursor = rowIndex === ci
      item.changed = dm.has(item.setting.path)
      item.value = valueText(item.setting)
      item.isEditing = item.setting.path === editingPath
      item.editValue = item.isEditing ? s.editVal : ""
      rowIndex++
    }
    // No windowing: the FULL item list always renders (headers cost one line,
    // exactly what the user sees), so the mouse wheel keeps its free
    // scrolling range untouched. Arrow-key marker following is the ONLY thing
    // that adjusts the scroll position: the module key channel clamps
    // `s.viewTop` around the marker's stamped absolute `.line`, and the body
    // scrollbox ref restores it after each remount. (The previous sliding
    // window was the root bug here: it re-stamped `.line` window-relative on
    // the same row objects and shadowed `s.items` with a subset, so the
    // offset math mixed absolute and window-relative coordinates and the
    // view jumped — end, then top — losing the marker.)
    s.totalRows = out.filter((i) => i.kind === "row").length
    markLines(out)
    return out
  }

  const visibleRows = Math.max(6, Math.min(settings().length, Math.floor(termH * 0.55)))
  // Body scrollbox height (and the marker band for arrow-key following).
  s.boxH = visibleRows + 2

  // The snapshot is built above (mount-time `buildList()`); no initial
  // re-render needed in the replace-rebuild architecture.

  const changedCount = () => draftMap().size
  // Rows currently displayed through the applied runtime overlay (green value
  // + `[applied]` badge; mirror-driven, so it survives reopen in this TUI).
  const appliedCount = () =>
    settings().filter((row: any) => appliedActive(row)).length

  // Drop one applied runtime overlay value: remove the TUI mirror entry and
  // best-effort remove the SERVER's overlay too (`configApply` stores
  // `null` for an undefined value, and `applyRuntimeObject` deletes the key on
  // a null overlay — the derive falls back to the config files). Without the
  // RPC bridge nothing can be sent; the mirror deletion alone keeps the
  // display honest and an OpenCode /restart erases the overlay either way.
  // A failed RPC re-stamps the mirror so the display never lies about runtime.
  function unapplyRuntime(setting: ConfigSetting) {
    const path = setting.path
    if (!cfgRuntimeApplied.has(path)) return
    const previous = cfgRuntimeApplied.get(path)
    cfgRuntimeApplied.delete(path)
    dbg(`unapply runtime ${path} (overlay value ${JSON.stringify(previous ?? null)})`)
    if (typeof s.apply !== "function") return
    void s
      .apply([{ path, value: undefined }])
      .then((res: any) => {
        if (!res?.ok) throw new Error(res?.error ?? "unknown error")
        dbg(`unapply runtime OK ${path}`)
      })
      .catch((cause: any) => {
        dbg(`unapply rpc FAILED ${path}: ${cause?.message ?? cause} — overlay re-stamped`)
        cfgRuntimeApplied.set(path, previous)
      })
  }

  // Draft bookkeeping WITHOUT any repaint: callers decide whether to rebuild
  // (remount) or patch the row in place. Same equality rule as before —
  // writing the layer value removes the draft; and when that value also
  // cancels an applied runtime overlay, the overlay is dropped too (the row
  // went back to its file/default setting: there is no applied difference
  // left to remember).
  function applyDraftRaw(setting: ConfigSetting, value: unknown) {
    const current = draftMap().has(setting.path)
      ? draftMap().get(setting.path)
      : setting.value
    const removes = jsonEq(value ?? null, current ?? null)
    setDraftMap((prev) => {
      const next = new Map(prev)
      if (removes) next.delete(setting.path)
      else next.set(setting.path, value)
      return next
    })
    dbg(
      `draft ${setting.path} <- ${JSON.stringify(value ?? null)} (draft count ${draftMap().size})`,
    )
    if (removes) unapplyRuntime(setting)
  }

  function setValue(setting: ConfigSetting, value: unknown) {
    if (s.editing === setting.path) s.editing = null // value flip closes an open editor on this row
    applyDraftRaw(setting, value)
    // IN-PLACE value flip: bool/enum toggles and clears repaint just this row
    // (marker ✱/›, value cell, ↺ tint) plus the footer counts. The former
    // remount rebuilt the whole dialog and flashed top-then-restored for
    // ~50 ms on EVERY toggle (visible in the debug log).
    if (patchRowValueInPlace(setting)) {
      patchFooterCountsInPlace()
      dbg(`setValue in place ${setting.path} <- ${JSON.stringify(value ?? null)}`)
      return
    }
    dbg(`setValue remount fallback ${setting.path} <- ${JSON.stringify(value ?? null)}`)
    rebuild()
  }

  function toggleFold(key: string) {
    let size = 0
    let folded = ""
    setFoldsRaw((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      size = next.size
      folded = [...next].join(",")
      return next
    })
    dbg(`toggleFold ${key} -> set(${size}) [${folded}]`)
    // IN-PLACE fold (see patchRowValueInPlace): detach/re-attach the section's
    // live row boxes instead of remounting — the remount painted the list top
    // for ~40-90 ms on every fold click. Degrades to the (exact-restore)
    // remount path when a required live box cannot be reached.
    if (s.editing) tryCommitEditBeforeNavigate() // outside click while editing
    if (!toggleFoldInPlace(key)) {
      dbg(`fold remount fallback ${key}`)
      rebuild()
    }
  }

  // In-place fold/unfold. The live tree holds one direct child per rendered
  // item: rows (`cfgrow.<path>`, boxes) and headers (`cfgsec.<foldKey>` /
  // `cfgsec.<subkey>`, texts). Folding = detach the subtree's items; unfolding
  // = re-attach the previously detached boxes (kept in `s.detachedRows` with
  // their mouse handlers intact). Falls back (false) when a needed box is not
  // available — e.g. after a remount that rendered with folds already closed.
  function toggleFoldInPlace(key: string): boolean {
    const box: any = s.bodyBoxRef
    if (!box || box.isDestroyed) return false
    if (typeof box.findDescendantById !== "function") return false
    const idOf = (it: ConfigListItem): string =>
      it.kind === "row" ? `cfgrow.${it.setting.path}` : `cfgsec.${it.foldKey}`
    try {
      // Fresh snapshot with the NEW fold state (buildList reads the live
      // signals; it also stamps cursor/values/lines for the new list).
      const after: ConfigListItem[] = buildList()
      const afterKeys = new Map<string, ConfigListItem>()
      for (const it of after) afterKeys.set(idOf(it), it)
      const beforeRows: Extract<ConfigListItem, { kind: "row" }>[] = (s.items ?? []).filter(
        (i: ConfigListItem): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
      )
      const rowsAfter: Extract<ConfigListItem, { kind: "row" }>[] = after.filter(
        (i): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
      )
      // Remember where the marked row is (by PATH — indices shift with the
      // detach/attach below).
      const curIdx = Math.max(0, Math.min(cursor(), Math.max(0, beforeRows.length - 1)))
      const curPath = beforeRows[curIdx]?.setting?.path ?? null
      const liveOf = (id: string): any => {
        const found: any = box.findDescendantById(id)
        return found && !found.isDestroyed ? found : null
      }
      // 1) DETACH every live child that left the rendered list (rows AND
      //    sub-headers under the now-closed section). A cursor-marked row among
      //    them gets its marker cleared first so a re-attach shows `✱`/` `
      //    state, not a stale `›`.
      const removable: string[] = []
      for (const child of (box.getChildren?.() ?? []) as any[]) {
        const id: string = typeof child?.id === "string" ? child.id : ""
        if (
          (id.startsWith("cfgrow.") || id.startsWith("cfgsec.")) &&
          !afterKeys.has(id) &&
          !s.detachedRows.has(id)
        ) {
          removable.push(id)
        }
      }
      if (removable.length > 0) {
        const keepMarker = (item: Extract<ConfigListItem, { kind: "row" }> | null) => {
          if (!item) return
          const bi = beforeRows.findIndex((r) => r.setting.path === item.setting.path)
          if (bi >= 0) patchMarkerRow(s, beforeRows, bi, false)
        }
        const curKey = curPath ? `cfgrow.${curPath}` : null
        if (curKey && removable.includes(curKey)) {
          keepMarker(beforeRows[curIdx] ?? null)
        }
        for (const id of removable) {
          const child = liveOf(id)
          if (!child) continue // already detached (stale id) — ignore
          try {
            box.remove(child)
            s.detachedRows.set(id, child)
          } catch (cause: any) {
            dbg(`fold detach FAILED ${id}: ${cause?.message ?? cause}`)
            return false
          }
        }
      }
      // 2) RE-ATTACH rendered items that are missing from the live tree, in
      //    list order. Anchor = the next item in the new list that IS live;
      //    with none following, append at the content end.
      for (let i = 0; i < after.length; i++) {
        const it = after[i]
        const id = idOf(it)
        if (liveOf(id)) continue
        const detached = s.detachedRows.get(id)
        if (!detached || detached.isDestroyed) {
          dbg(`fold reattach FAILED ${id}: no kept box (degraded)`)
          return false
        }
        let inserted = false
        for (let j = i + 1; j < after.length; j++) {
          const anchor = liveOf(idOf(after[j]))
          if (anchor) {
            box.insertBefore(detached, anchor)
            inserted = true
            break
          }
        }
        if (!inserted) box.add(detached)
        s.detachedRows.delete(id)
        detached.requestRender?.()
      }
      // 3) Publish the new item list WITHOUT a remount. `items`/`itemsSig` keep
      //    the mount-time array identity (the module key channel points at it),
      //    so mutate it in place.
      items.length = 0
      items.push(...after)
      // 4) Cursor: prefer the marked row by path; when it folded away, shift by
      //    the number of removed rows above it and clamp. Patch markers in
      //    place for old + new rows (the detached old row is already shown
      //    unmarked from step 1).
      const rows = rowsAfter
      let newIdx = curPath ? rows.findIndex((r) => r.setting.path === curPath) : -1
      if (newIdx < 0) {
        const curRowKey = curPath ? `cfgrow.${curPath}` : null
        let removedAbove = 0
        for (let bi = 0; bi <= curIdx && bi < beforeRows.length; bi++) {
          const key = `cfgrow.${beforeRows[bi].setting.path}`
          if (curRowKey !== key && !afterKeys.has(key)) removedAbove++
        }
        newIdx = curIdx - removedAbove
      }
      const clamped = Math.max(0, Math.min(newIdx, Math.max(0, rows.length - 1)))
      let ri = 0
      for (const it of after) {
        if (it.kind === "row") {
          it.isCursor = ri === clamped
          ri++
        }
      }
      if (clamped !== cursor()) {
        dbg(`fold cursor clamp ${cursor()} -> ${clamped}`)
        setCursorRaw(clamped) // signal write only — NO rebuild here
      }
      patchMarkerRow(s, rows, clamped, true)
      // 5) Flip the folded section's arrow glyph in place.
      patchHeaderArrowInPlace(key, after)
      box.requestRender?.()
      dbg(`fold adapted in place ${key} (removed ${removable.length})`)
      return true
    } catch (cause: any) {
      dbg(`fold in place FAILED ${key}: ${cause?.message ?? cause}`)
      return false
    }
  }

  // Redraw one section/sub-section header's arrow badge from the fresh item
  // stamps (`▼`/<label>` vs `▶`).
  function patchHeaderArrowInPlace(key: string, after: ConfigListItem[]): void {
    const box: any = s.bodyBoxRef
    if (!box || typeof box.findDescendantById !== "function") return
    const item = after.find(
      (it): it is Extract<ConfigListItem, { kind: "header" }> =>
        it.kind === "header" && it.foldKey === key,
    )
    const hdr: any = box.findDescendantById(`cfgsec.${key}`)
    if (!item || !hdr || typeof hdr.getTextChildren !== "function") return
    try {
      const spans = hdr.getTextChildren() as any[]
      if (spans.length < 1) return
      const pad = " ".repeat((item.level + 1) * 4)
      if (spans[0]) spans[0].children = [`${pad}${item.open ? "▼" : "▶"} ${item.label}`]
      spans[0]?.requestRender?.()
      hdr.requestRender?.()
    } catch (cause: any) {
      dbg(`header arrow patch FAILED ${key}: ${cause?.message ?? cause}`)
    }
  }

  // Input renderable references live on the dialog state (`s.searchInputRef`,
  // `s.editInputRef`) because the module-level key handler needs them across
  // remounts. Focus moves between search and the inline row editor as editing
  // starts and ends. Every remount replaces those renderables, so focus calls
  // RETRY on a short poll until the (new) renderable is live — a single 1-tick
  // defer loses the race with the remount scheduled at timeout 0.
  const searchInputRef = () => s.searchInputRef
  const editInputRef = () => s.editInputRef
  function focusSearch() {
    const attempt = (tries: number) => {
      const r = s.searchInputRef
      if (r && !r.isDestroyed) {
        r.focus?.()
        return
      }
      if (tries <= 0) return
      setTimeout(() => attempt(tries - 1), 10)
    }
    attempt(20)
  }
  // Live "does the search own the keyboard right now" read, used to snapshot
  // focus state when an inline editor opens.
  function searchFocusedNow(): boolean {
    const r = s.searchInputRef
    try {
      return Boolean(r && !r.isDestroyed && r.focused)
    } catch {
      return false
    }
  }
  // MOUSE RULE (user request): clicking anything inside the dialog that is
  // not the search field itself unfocuses the search — the mouse must never
  // leave the keyboard parked in the search box. Called from EVERY non-search
  // mouse path (rows, reset glyph, fold headers, footer buttons, backdrop
  // guard, bubble router). Kept silent when the search is not focused.
  function blurSearch() {
    const r = s.searchInputRef
    try {
      if (r && !r.isDestroyed && r.focused) {
        r.blur?.()
        dbg("search unfocused by mouse click")
      }
    } catch {
      /* ignore */
    }
  }
  // Click-outside-while-editing: commit then navigate (user: "like enter").
  function tryCommitEditBeforeNavigate() {
    if (!s.editing) return false
    commitEdit() // ends the edit; if commit blocked (bad number), edit stays open
    return true // called; the caller decides whether to continue its action
  }
  function focusEditor() {
    const attempt = (tries: number) => {
      const r = s.editInputRef
      if (r && !r.isDestroyed) {
        const search = s.searchInputRef
        search && !search.isDestroyed ? search.blur?.() : null
        r.focus?.()
        return
      }
      if (tries <= 0) return
      setTimeout(() => attempt(tries - 1), 10)
    }
    attempt(20)
  }

  // Activate the cursor row: booleans toggle, enums step, numbers/strings open
  // their inline editor.
  function activate(setting: ConfigSetting, viaMouse = false) {
    const draft = draftMap()
    const current = draft.has(setting.path) ? draft.get(setting.path) : setting.value
    if (setting.type === "bool") {
      setValue(setting, current !== true)
      return
    }
    if (setting.type === "enum") {
      const options = setting.enum ?? []
      if (options.length === 0) return
      let at = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(current))
      at = at < 0 ? 0 : (at + 1) % options.length
      setValue(setting, options[at])
      return
    }
    // Editor buffer lives on the module state (`s.editVal`) — no signal write,
    // and while typing no rebuild happens anyway (a rebuild would re-create
    // the editor <input> and reset caret + focus on every keystroke).
    // IN-PLACE EDITOR OPEN: switching from another open editor commits that
    // one first (in place, no scroll), then the editor is created directly on
    // the live row — the view must not move AT ALL when editing starts.
    if (s.editing && s.editing !== setting.path) {
      dbg(`activate: auto-commit open editor of ${s.editing}`)
      commitEdit(viaMouse)
      if (s.editing) return // e.g. invalid number blocked the commit — stay there
    }
    if (s.editing === setting.path && s.editInputRef && !s.editInputRef.isDestroyed) {
      dbg(`activate: editor already open for ${setting.path}`)
      focusEditor()
      return
    }
    // FOCUS RULE (user request): committing/canceling an inline editor only
    // refocuses the search when the search was focused immediately before the
    // edit started (e.g. the user arrived by typing into search -> enter).
    // Snapshot BEFORE focusEditor blurs the search.
    s.searchWasFocusedBeforeEdit = searchFocusedNow()
    dbg(`edit focus snapshot ${setting.path}: searchWasFocused=${s.searchWasFocusedBeforeEdit}`)
    s.editVal = current === null || current === undefined ? "" : String(current)
    if (openEditorInputInPlace(setting)) {
      setEditing(setting.path)
      focusEditor()
      return
    }
    dbg(`editor open in-place failed for ${setting.path} — remount fallback`)
    setEditing(setting.path)
    rebuild()
    focusEditor()
  }

  // Reset the row: undo a pending draft first, else clear the override from
  // the target layer (writes = delete on save, i.e. fall back to the value
  // below — which, since our files merge last, may be opencode's
  // `plugins[].options` entry or the shipped default).
  function resetRow(setting: ConfigSetting) {
    const dm = draftMap()
    if (dm.has(setting.path)) {
      // ↺ = undo the change ALL the way: when this draft was the applied
      // runtime value, the server overlay is dropped too (unapplyRuntime) —
      // bringing the row back to its file/default value.
      unapplyRuntime(setting)
      setDraftMap((fn) => {
        const next = new Map(fn)
        next.delete(setting.path)
        return next
      })
      dbg(`reset undo draft ${setting.path} (draft count ${draftMap().size})`)
      if (s.editing === setting.path) s.editing = null
      if (patchRowValueInPlace(setting)) {
        patchFooterCountsInPlace()
        return
      }
      rebuild()
      return
    }
    if (cfgRuntimeApplied.has(setting.path)) {
      // Applied-but-no-draft (e.g. after reopening the dialog in this TUI
      // process): ↺ undoes the runtime overlay back to the file value.
      unapplyRuntime(setting)
      if (patchRowValueInPlace(setting)) {
        patchFooterCountsInPlace()
        return
      }
      rebuild()
      return
    }
    if (setting.source === "default") {
      context.ui.toast.show({ message: `${setting.path} is already at its default` })
      return
    }
    setValue(setting, null)
  }

  function stepEnum(setting: ConfigSetting, dir: number) {
    if (setting.type !== "enum") return
    const options = setting.enum ?? []
    if (options.length === 0) return
    const current = draftMap().has(setting.path)
      ? draftMap().get(setting.path)
      : setting.value
    let at = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(current))
    at = at < 0 ? (dir > 0 ? 0 : options.length - 1) : (at + dir + options.length) % options.length
    setValue(setting, options[at])
  }

  function cancelEdit() {
    const path = editing()
    const setting = path ? settings().find((c) => c.path === path) : null
    s.editing = null
    // Refocus rule: only when the search owned the keyboard right before this
    // editor opened (snapshot in activate).
    if (s.searchWasFocusedBeforeEdit) {
      dbg(`cancelEdit refocus search (${path})`)
      focusSearch()
    }
    if (setting && patchRowValueInPlace(setting)) {
      dbg(`cancelEdit in place ${path}`)
      patchFooterCountsInPlace()
    } else {
      dbg(`cancelEdit remount fallback${path ? ` ${path}` : ""}`)
      rebuild()
    }
    focusSearch()
  }

  function commitEdit(viaMouse = false) {
    const path = editing()
    if (!path) return
    const setting = settings().find((c) => c.path === path)
    if (!setting) {
      setEditing(null)
      rebuild()
      if (s.searchWasFocusedBeforeEdit) focusSearch()
      return
    }
    // Read the live editor buffer: the imperative input's own text when
    // available (the INPUT listener mirrors it into s.editVal), else s.editVal.
    const inp: any = s.editInputRef && !s.editInputRef.isDestroyed ? s.editInputRef : null
    let raw = s.editVal
    if (inp) {
      try {
        if (typeof inp.plainText === "string") raw = inp.plainText
      } catch {
        /* keep s.editVal */
      }
    }
    const trimmed = raw.trim()
    // Number validation happens BEFORE any state change, so a bad value keeps
    // the editor open without moving the view.
    if (trimmed !== "" && setting.type === "number") {
      const num = Number(trimmed)
      if (!Number.isFinite(num)) {
        context.ui.toast.show({ message: `Not a number: ${trimmed}`, variant: "error" })
        return
      }
    }
    const nextVal: unknown = trimmed === "" ? null : setting.type === "number" ? Number(trimmed) : raw
    s.editing = null
    applyDraftRaw(setting, nextVal)
    // NO SCROLLING when editing a value: paint the closed row in place and
    // patch the footer counts; rebuild only if the patch cannot reach the row
    // (degraded / JSX-editor fallback form).
    if (patchRowValueInPlace(setting)) {
      dbg(`commitEdit in place ${path} <- ${JSON.stringify(nextVal ?? null)}`)
      patchFooterCountsInPlace()
    } else {
      dbg(`commitEdit remount fallback ${path} <- ${JSON.stringify(nextVal ?? null)}`)
      rebuild()
    }
    // Refocus rule: only when the search owned the keyboard right before this
    // editor opened (snapshot in activate) AND the edit was ended by the
    // KEYBOARD (enter/esc). A mouse-driven end (click on another row) must
    // never refocus — the keyboard stays out of the mouse's way.
    if (!viaMouse && s.searchWasFocusedBeforeEdit) {
      dbg(`commitEdit refocus search (${path})`)
      focusSearch()
    }
  }

  // The save dialog: pick where the draft lands (global vs the two project
  // locations), then write it locally (`configSetLocal`, comments preserved).
  // `where` is only sent for explicitly picked project locations because an
  // explicit pick may create folder + file.
  //
  // ERROR SEMANTICS (user rule): the picker NEVER closes because of an error.
  // Unwritable targets are pre-flighted (`writable/deny` on each target, see
  // shared.js `probeConfigTargetWritable`) and marked in the row; both an
  // unwritable pick AND a failed write keep the SAME picker up (it re-opens
  // with identical options — the built-in select self-closes on any resolve,
  // REPLACE semantics) with the drafts untouched. Only a successful save
  // releases the loop. ESC / outside-close is the only way out without
  // saving, returning to the config dialog below.
  // Touch detection for the post-save/apply restart flow: schema-driven — a
  // row whose CONFIG_SCHEMA entry sets `restart` wants its value to take
  // effect NOW (web-UI port/font keys, autostart). Tiered (user-locked):
  // webserver-tier keys Restart the PTY stack automatically (apply: always
  // soft; save: only when ALL touched restart keys are webserver-tier);
  // full-tier keys (autostart) never restart automatically — save keeps the
  // picker as today, apply just notes it in the toast.
  function restartTouchedOf(changes: { path: string }[]) {
    return changes.filter((c) => restartTierOf(c.path) !== null)
  }
  function restartTierOf(path: string): "full" | "web" | null {
    const row: any = settings().find((x: any) => x.path === path)
    if (!row?.restart) return null
    return row.restart === "full" ? "full" : "web"
  }
  function fullTouchedOf(changes: { path: string }[]) {
    return changes.filter((c) => restartTierOf(c.path) === "full")
  }
  function webTouchedOf(changes: { path: string }[]) {
    return changes.filter((c) => restartTierOf(c.path) === "web")
  }

  // The restart run (used by both the save-flow offer and the apply flow):
  // call the RPC `PtyRpc.restart`, summarize the result in a toast, and
  // queueRefresh at the end (restores the config dialog when it is still
  // logically open; a no-op after a save). `kill` additionally kills every
  // running PTY.
  async function runPtyRestart(scope: "soft" | "kill", restartTouched: { path: string }[]) {
    if (typeof s.restart !== "function") return
    try {
      const result: any = await s.restart(String(scope))
      const bits: string[] = []
      bits.push(result?.recycled ? "web server recycled" : "recycle FAILED")
      if (scope === "kill") bits.push(`killed ${result?.killed ?? 0}/${result?.runningPtys ?? 0}`)
      else if (result?.runningPtys > 0) bits.push(`${result.runningPtys} PTY(s) kept`)
      if (result?.urlChanged && result?.url) bits.push(`new web-UI URL: ${result.url}`)
      if (result?.error) bits.push(`error: ${result.error}`)
      const full = fullTouchedOf(restartTouched)
      if (full.length > 0) {
        // autostart (schema `restart: "full"`) is read by the upstream package
        // at plugin load only — a PTY-stack restart can never apply it.
        bits.push(`${full.map((c) => c.path).join(", ")} still needs OpenCode's full /restart`)
      }
      context.ui.toast.show({
        message: `PTY stack restarted: ${bits.join(" · ")}`,
        variant: result?.recycled ? "success" : "error",
      })
    } catch (cause: any) {
      context.ui.toast.show({
        message: `PTY restart failed: ${cause?.message ?? cause}`,
        variant: "error",
      })
    } finally {
      // Restore the config dialog when it is still open (apply flow); after a
      // save it is closed and the null guard skips the remount.
      queueRefresh()
    }
  }

  // The post-save restart offer: soft (recycle the web-UI server, PTYs
  // survive) or kill (+ kill every running PTY, their <pty_exited> flood is
  // accepted). The apply flow does NOT use this picker — it soft-restarts
  // automatically (see applyFlow); a save whose touched restart keys are ALL
  // webserver-tier soft-restarts without asking (user-locked: "if only
  // webserver restart, just do it"), a save that also touched a full-tier key
  // keeps the picker as today. The host `dialog.select` REPLACES whatever is
  // on the dialog stack — after it closes, `queueRefresh()` restores the
  // config dialog when it is still logically open; after a save it is already
  // closed and the no-op guard simply skips the restore.
  async function offerRestart(restartTouched: { path: string }[]) {
    if (restartTouched.length === 0 || typeof s.restart !== "function") return
    const wasSaving = s.saving
    s.saving = true
    try {
      if (fullTouchedOf(restartTouched).length === 0) {
        // All webserver-tier: just do it (soft scope; PTYs survive).
        await runPtyRestart("soft", restartTouched)
        return
      }
      const picking = dialog.select({
        title: `Restart PTY stack? (${restartTouched.length} key(s) apply on restart)`,
        options: [
          {
            title: "Soft restart",
            description: "recycle the web-UI server; PTYs survive (full-tier keys still need /restart)",
            value: "soft",
          },
          {
            title: "Kill + restart",
            description: "recycle + kill every running PTY",
            value: "kill",
          },
        ],
      })
      const picked = await picking
      if (!picked || picked === "__cancel") return
      await runPtyRestart(String(picked) === "kill" ? "kill" : "soft", restartTouched)
    } finally {
      s.saving = wasSaving
      // Restore the config dialog when it is still open (apply flow); after a
      // save it is closed and the null guard skips the remount.
      queueRefresh()
    }
  }

  async function saveFlow() {
    if (busy()) return
    const changes = [...draftMap()].map(([path, value]) => ({ path, value }))
    if (changes.length === 0) {
      context.ui.toast.show({ message: "Nothing changed" })
      return
    }
    const t = targets()
    const options: { title: string; value: string; description?: string }[] = []
    // Row layout: first column = the target KIND (Global / Project / Project
    // root), the gray secondary column (`description`) = the concrete PATH
    // (with ` (will create)` appended when the save would create it, and
    // ` (no write permission)`-style denial appended when the pre-flight
    // probe says the save cannot write there).
    const denialOf = (target: any): string | null =>
      target?.writable === false ? `(${target.deny ?? "no write permission"})` : null
    const pushOption = (title: string, value: string, target: any) => {
      const deny = denialOf(target)
      options.push({
        title,
        value,
        // "(will create)" only when the target is writable: a denied target
        // cannot create anything, so the optimistic note would mislead.
        description: target
          ? `${target.file}${deny ? "" : target.create ? "  (will create)" : ""}${deny ? "  " + deny : ""}`
          : undefined,
      })
    }
    pushOption("Global", "global", t?.global ?? null)
    const proj = t?.project
    if (proj?.opencode) pushOption("Project", "opencode", proj.opencode)
    if (proj?.sibling) pushOption("Project root", "sibling", proj.sibling)
    for (;;) {
      // No "Cancel" entry: ESC (or closing the picker) resolves with no pick
      // and returns to the config dialog below — a cancel row would make the
      // list the only way out.
      s.saving = true
      // Widen the picker: built-in dialogs open at the default "medium" size
      // (60 cols) — the same quirk `dialog.show` has. `select` shows the
      // dialog synchronously and only the PROMISE waits for the user, so
      // `set` must run after the call but before the await (same pattern the
      // /pty-output picker uses). xlarge = 116 cols; centered. Needed again
      // on EVERY loop turn: the select re-opened at medium.
      const picking = dialog.select({
        title: `Save ${changes.length} change${changes.length === 1 ? "" : "s"} — pick target`,
        options,
      })
      context.ui.dialog.set?.({ size: "xlarge", centered: true })
      const picked = await picking
      s.saving = false
      if (!picked || picked === "__cancel") {
        // The host dialog API uses REPLACE semantics: `dialog.select` swapped
        // the config dialog out of the dialog slot, so once the picker closes
        // there is nothing left on screen. Re-show the config dialog with the
        // exact scroll + search-focus restore.
        queueRefresh()
        return
      }
      // Re-check pickability at pick time too (the pre-flight ran at open;
      // filesystem state may have changed since): an unwritable pick never
      // reaches the save and never closes anything.
      const chosen =
        picked === "global"
          ? (t?.global as any)
          : picked === "opencode"
            ? ((t?.project?.opencode as any) ?? null)
            : ((t?.project?.sibling as any) ?? null)
      if (chosen?.writable === false) {
        context.ui.toast.show({
          message: `Not writable: ${chosen.file ?? "target"} (${chosen.deny ?? "no write permission"})`,
          variant: "error",
        })
        continue
      }
      const target =
        picked === "global"
          ? { scope: "global" }
          : { scope: "project", where: picked === "opencode" ? "opencode" : "sibling" }
      setBusy(true)
      try {
        s.saving = true
        const result: any = await s.save(changes, target)
        if (!result?.ok) {
          s.saving = false
          context.ui.toast.show({
            message: `Save failed: ${result?.error ?? "unknown error"}`,
            variant: "error",
          })
          // Keep the picker up: the user picks another target or ESCs out.
          setBusy(false)
          continue
        }
        // Success: release the picker loop and finish as before.
        // Schema-flagged restart keys ask for a PTY stack restart so they take
        // effect NOW: all-webserver tier just soft-restarts (offerRestart
        // skips the picker, user-locked); a full-tier key (autostart) among
        // them keeps the picker (soft / kill / not now) as today.
        const restartTouched = restartTouchedOf(changes)
        context.ui.toast.show({
          message:
            `Saved ${changes.length} → ${result.file}` +
            (result.mode === "rewrite" ? " (rewritten: comments lost)" : "") +
            (result.warnings?.length ? ` (${result.warnings.length} warnings)` : "") +
            (restartTouched.length
              ? fullTouchedOf(restartTouched).length === 0
                ? typeof s.restart === "function"
                  ? " — restarting PTY stack (soft)"
                  : " — key(s) apply after a PTY (web) restart"
                : fullTouchedOf(restartTouched).length === restartTouched.length
                  ? ` — ${fullTouchedOf(restartTouched).map((c) => c.path).join(", ")} needs OpenCode's /restart`
                  : " — restart offered (full-tier keys need /restart)"
              : ""),
          variant: "success",
        })
        setDraftMap(() => new Map())
        // Saved → the values now live in a config file: drop the TUI runtime
        // mirror so reopened dialogs show the file provenance, not [applied].
        // (The server overlay was re-applied with the same values at the call
        // site, which mirrors the file — provenance display is honest again.)
        for (const change of changes) cfgRuntimeApplied.delete(change.path)
        s.saving = false
        setBusy(false)
        // The changed paths ride along: the sidebar hook uses
        // `tuiSidebar.enabled` among them to open its section latch (UX).
        try {
          await s.onSaved(changes)
        } catch {
          /* the dialog already closed; a save is durable either way */
        }
        close()
        await offerRestart(restartTouched)
        return
      } catch (cause: any) {
        s.saving = false
        setBusy(false)
        context.ui.toast.show({
          message: `Save failed: ${cause?.message ?? cause}`,
          variant: "error",
        })
        continue
      }
    }
  }

  // Apply draft changes to the RUNNING plugin only — the server overlays them
  // in memory (`live.runtimeOverrides`, re-applied on every hot reload) and
  // never touches a config file. The drafts STAY pending: the rows keep their
  // ✱ marker and the `save N` count, so a later ctrl+s persists the same
  // values (v1.16.0.82-and-earlier cleared them here, which made the values
  // revert to the stale open-time payload AND become unsaveable without
  // re-entering them). The TUI mirror `cfgRuntimeApplied` records the applied
  // values so the rows show green `[applied]` display until saved/undone.
  async function applyFlow() {
    if (busy()) return
    const changes = [...draftMap()].map(([path, value]) => ({ path, value }))
    if (changes.length === 0) {
      context.ui.toast.show({ message: "Nothing changed" })
      return
    }
    setBusy(true)
    s.saving = true
    try {
      const result: any = await s.apply(changes)
      if (!result?.ok) {
        context.ui.toast.show({
          message: `Apply failed: ${result?.error ?? "unknown error"}`,
          variant: "error",
        })
        return
      }
      // Restart tiers (user-locked): webserver-tier keys (port/hostname/
      // terminalFont/webUi) take their PTY stack soft restart RIGHT AWAY — the
      // configApply reload already overlays the running plugin, and
      // `pty_restart soft` also recycles a serving web server eagerly so the
      // applied web-UI keys render with the very next page open. Full-tier
      // keys (autostart) never restart automatically — a PTY-stack restart
      // does nothing for them; the toast notes the /restart requirement
      // instead. `kill` stays a save-flow picker choice.
      const restartTouched = restartTouchedOf(changes)
      const webTouched = webTouchedOf(changes)
      const fullTouched = fullTouchedOf(changes)
      // Stamp the runtime overlay mirror: the rows now display the applied
      // value with the green `[applied]` badge (value text comes from the
      // still-pending draft, which by definition equals what was applied).
      for (const change of changes) cfgRuntimeApplied.set(change.path, change.value)
      // Pull the refreshed settings into the TUI sidebar right away (same
      // call a save makes on success and /pty-refresh makes) — without this,
      // an applied `tuiSidebar.*` / `output.*` key only reached the SERVER
      // half and waited for the user to run /pty-refresh manually. Best-effort
      // on purpose (it holds the RPC settings fetch; the apply verdict above
      // already stands either way). The changed paths ride along so
      // `tuiSidebar.enabled` among them opens the section latch (UX).
      if (typeof s.onSaved === "function") {
        try {
          await s.onSaved(changes)
        } catch (cause: any) {
          dbg(`apply pullSettings FAILED (non-fatal): ${cause?.message ?? cause}`)
        }
      }
      context.ui.toast.show({
        message:
          `Applied ${changes.length} → runtime (not saved)` +
          (webTouched.length
            ? typeof s.restart === "function"
              ? ` — restarting PTY stack (soft)`
              : ` — ${webTouched.length} key(s) apply after a PTY (web) restart`
            : "") +
          (fullTouched.length
            ? ` — ${fullTouched.map((c) => c.path).join(", ")} needs OpenCode's /restart`
            : ""),
        variant: "success",
      })
      s.saving = false
      // Apply is a multi-row change; repaint changed rows in place (marker ✱
      // + value + `[applied]` badge) rather than remounting. Only remount when
      // the in-place pass can't reach a row — the auto restart below re-queues
      // its own refresh anyway.
      const changedPaths = changes.map((c) => c.path)
      let inPlaceOk = true
      for (const path of changedPaths) {
        const setting = settings().find((s) => s.path === path)
        if (!setting) continue
        if (!patchRowValueInPlace(setting)) inPlaceOk = false
      }
      patchFooterCountsInPlace()
      if (!inPlaceOk) {
        dbg(`apply remount fallback (inPlace=${inPlaceOk})`)
        rebuild()
      } else {
        dbg(`apply in place (changed=${changedPaths.length})`)
      }
      // Restart the stack NOW (inside the try, so busy/saving release only
      // after the whole flow ends) — but only for the WEB tier: the soft
      // restart is what makes port/hostname/terminalFont/webUi take effect now,
      // while a full-tier key (autostart) is untouched by it (noted in the
      // toast above; runPtyRestart repeats it in the result toast). The
      // picker-less soft scope keeps the dialog open; runPtyRestart
      // queueRefreshes the current dialog state.
      if (webTouched.length > 0) await runPtyRestart("soft", restartTouched)
    } catch (cause: any) {
      s.saving = false
      context.ui.toast.show({
        message: `Apply failed: ${cause?.message ?? cause}`,
        variant: "error",
      })
    } finally {
      s.saving = false
      setBusy(false)
    }
  }

  // ── IN-PLACE EDITOR LIFECYCLE ────────────────────────────────────────────
  // The view must not scroll AT ALL when a value is being edited: no remount
  // when the editor opens (activate), commits or cancels, and no scroll
  // anywhere in between. Everything below repaints the LIVE renderables
  // directly (same approach as the arrow-key marker patch) — a rebuild
  // replaces the whole dialog and the fresh scrollbox paints from scrollTop 0
  // until its restore settles: exactly the "jumps to top, then shows
  // correctly scrolled" glitch this works around.

  const findRowBoxLive = (path: string): any => {
    const box: any = s.bodyBoxRef
    if (!box || box.isDestroyed || typeof box.findDescendantById !== "function") return null
    try {
      return box.findDescendantById(`cfgrow.${path}`) ?? null
    } catch {
      return null
    }
  }

  // The normal row is TWO texts now (user-locked click UX split): `cfg.<path>`
  // with TWO spans (prefix, label) and `cfgval.<path>` with ONE span (the
  // value); the JSX editor fallback row has NO `cfgval` id — that difference
  // is the shape test deciding whether in-place painting can reach a row.
  function patchRowValueInPlace(setting: ConfigSetting): boolean {
    const rows = (s.items ?? []).filter(
      (i: ConfigListItem): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
    )
    const rowItem = rows.find((r) => r.setting.path === setting.path) ?? null
    if (!rowItem) return false
    const rowBox = findRowBoxLive(setting.path)
    if (!rowBox) return false
    let kids: any[] = []
    try {
      kids = rowBox.getChildren() ?? []
    } catch {
      return false
    }
    const text1 = kids.find((c: any) => c?.id === `cfg.${setting.path}`)
    const valText = kids.find((c: any) => c?.id === `cfgval.${setting.path}`)
    const resText = kids.find((c: any) => c?.id === `cfgreset.${setting.path}`)
    const badgeText = kids.find((c: any) => c?.id === `cfgbadge.${setting.path}`)
    if (!text1 || !valText || typeof text1.getTextChildren !== "function") return false
    let spans: any[] = []
    try {
      spans = (text1.getTextChildren() ?? []) as any[]
    } catch {
      return false
    }
    if (spans.length < 2) return false // JSX editor fallback row — only a remount repaints it
    let valSpans: any[] = []
    try {
      valSpans = (valText.getTextChildren() ?? []) as any[]
    } catch {
      return false
    }
    if (valSpans.length < 1) return false
    // Still-open imperative editor on this row: remove + destroy it first
    // (the JSX-managed fallback input is NOT touched — the host owns it).
    const inp: any = s.editInputRef && !s.editInputRef.isDestroyed ? s.editInputRef : null
    if (inp && (kids.includes(inp) || inp.parent === rowBox)) {
      try {
        inp.blur?.()
      } catch {
        /* ignore */
      }
      try {
        inp.off?.(InputRenderableEvents.INPUT)
      } catch {
        /* ignore */
      }
      try {
        rowBox.remove(inp)
      } catch (cause: any) {
        dbg(`editor remove FAILED: ${cause?.message ?? cause}`)
      }
      try {
        inp.destroy?.()
      } catch {
        /* ignore */
      }
      s.editInputRef = null
    }
    // Stamp the closed row exactly like buildList would: value, marker char,
    // prefix/label colors, ↺ tint.
    const changed = draftMap().has(setting.path)
    const indent = Math.max(0, rowItem.level * 4)
    const rowIdx = rows.findIndex((r) => r.setting.path === setting.path)
    const isCursor = rowIdx >= 0 ? rowIdx === s.cursor : Boolean(rowItem.isCursor)
    const displayVal = valueText(setting)
    const valueFg =
      displayVal === "(cleared)"
        ? "#f85149"
        : appliedActive(setting)
          ? "#56d364"
          : changed
            ? "#ffd24a"
            : "#c9d1d9"
    const marker = isCursor ? "›" : changed ? "✱" : " "
    try {
      const prefixSpan = spans[0]
      const valueSpan = valSpans[0]
      // COLUMN FIX restore: openEditorInputInPlace narrowed the value text to
      // the 1 leading-blank cell while editing — restore the full fixed width
      // (content ` ${fitValue}` = valW + 1) here so the ↺/badge/hint columns
      // sit back at their regular positions.
      valText.width = valW + 1
      prefixSpan.children = [`${" ".repeat(indent)}${marker}  `]
      prefixSpan.fg = isCursor ? "#e6edf3" : "#4d5566"
      valueSpan.children = [` ${fitValue(displayVal, valW, setting.path === "terminalFont.family")}`]
      valueSpan.fg = valueFg
      if (resText) {
        resText.fg = changed ? "#ffd24a" : mutedFg
        resText.requestRender?.()
      }
      text1.requestRender?.()
      valText.requestRender?.()
      if (badgeText) {
        try {
          const bspans = (badgeText.getTextChildren?.() ?? []) as any[]
          if (bspans.length > 0) {
            const { badge: badgeRaw, badgeFg: badgeFg2 } = badgeOf(setting)
            bspans[0].children = [` ${badgeRaw.padEnd(10)}`]
            bspans[0].fg = badgeFg2
            badgeText.requestRender?.()
          }
        } catch (cause: any) {
          dbg(`badge repaint FAILED ${setting.path}: ${cause?.message ?? cause}`)
        }
      }
    } catch (cause: any) {
      dbg(`row repaint FAILED ${setting.path}: ${cause?.message ?? cause}`)
      return false
    }
    return true
  }

  // Footer counts (apply/save buttons + title count) repaint in place so a
  // commit never triggers the remount-restore dance either.
  function patchFooterCountsInPlace() {
    const n = draftMap().size
    // Rows currently displayed through the applied runtime overlay ([applied]
    // badge, open-time drafts can shadow the mirror but `appliedActive`
    // resolves the effective display).
    const m = settings().filter((row: any) => appliedActive(row)).length
    const root: any = context.renderer?.root
    if (!root || typeof root.findDescendantById !== "function") {
      dbg("footer patch skipped (no root)")
      return
    }
    const edits: [string, string][] = [
      ["cfg.apply", n > 0 ? `apply ${n}` : "apply"],
      ["cfg.save", n > 0 ? `save ${n}` : "save"],
      [
        "cfg.count",
        `${settings().length} settings` +
          (n > 0 ? ` · ${n} changed` : "") +
          (m > 0 ? ` · ${m} applied` : ""),
      ],
    ]
    for (const [id, next] of edits) {
      try {
        const bx: any = root.findDescendantById(id)
        const tx: any = bx && typeof bx.getChildren === "function" ? bx.getChildren()[0] : null
        if (!tx) continue
        tx.content = next
        tx.requestRender?.()
      } catch (cause: any) {
        dbg(`footer patch FAILED ${id}: ${cause?.message ?? cause}`)
      }
    }
  }

  // Detail line (the row of text under the body scrollbox): always shows the
  // DESC of the currently selected row, dimmed. Rebuilt from JSX on every
  // remount (the const snapshot always renders the live cursor row), so the
  // in-place repatch below is ONLY needed after marker moves that skip the
  // rebuild. Purely cosmetic: a failed patch degrades to "previous text
  // stays" (never a remount, never an error for the user).
  function detailTextOf(at: number): string {
    const rows = (s.items ?? []).filter(
      (i: ConfigListItem): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
    )
    const cur = rows[Math.max(0, Math.min(at, rows.length - 1))]
    return String(cur?.setting?.desc ?? "").trim()
  }

  function patchDetailLineInPlace(at: number): boolean {
    const root: any = context.renderer?.root
    if (!root || typeof root.findDescendantById !== "function") return false
    try {
      const tx: any = root.findDescendantById("cfg.detail")
      if (!tx || tx.isDestroyed) return false
      const next = fitValue(detailTextOf(at), msgW, true)
      if (String(tx.content ?? "") === next) return true
      tx.content = next
      tx.requestRender?.()
      return true
    } catch (cause: any) {
      dbg(`detail patch failed: ${cause?.message ?? cause}`)
      return false
    }
  }

  // Cursor move from a click WITHOUT a rebuild: the clicked row is
  // visible by definition, so no scroll — just the two-row marker patch.
  // Returns false when the patch cannot reach a row (caller falls back to
  // the remounting setCursor).
  function selectCursorInPlace(at: number): boolean {
    if (s.cursor === at) return true
    const box: any = s.bodyBoxRef
    if (!box || box.isDestroyed) return false
    const rows = (s.items ?? []).filter(
      (i: ConfigListItem): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
    )
    if (at < 0 || at >= rows.length) return false
    try {
      s.viewTop = Math.max(0, Math.trunc(Number(box.scrollTop) || 0))
    } catch {
      /* keep previous */
    }
    const prev = s.cursor
    s.cursor = at
    const okOld = patchMarkerRow(s, rows, prev, false)
    const okNew = patchMarkerRow(s, rows, at, true)
    if (!okOld || !okNew) {
      s.cursor = prev
      dbg(`cursor select in-place incomplete (at ${at}) — remount fallback`)
      return false
    }
    dbg(`cursor select in place ${prev} -> ${at}`)
    patchDetailLineInPlace(at)
    return true
  }

  // Create the row editor directly on the live row: blank the value cells,
  // mount a width-matched InputRenderable into the row box, wire its INPUT
  // event to `s.editVal`, focus it. No rebuild — the view stays put.
  function openEditorInputInPlace(setting: ConfigSetting): boolean {
    const rowBox = findRowBoxLive(setting.path)
    if (!rowBox) return false
    let kids: any[] = []
    try {
      kids = rowBox.getChildren() ?? []
    } catch {
      return false
    }
    const text1 = kids.find((c: any) => c?.id === `cfg.${setting.path}`)
    const valText = kids.find((c: any) => c?.id === `cfgval.${setting.path}`)
    if (!text1 || !valText || typeof text1.getTextChildren !== "function") return false
    let spans: any[] = []
    try {
      spans = (text1.getTextChildren() ?? []) as any[]
    } catch {
      return false
    }
    if (spans.length < 2) return false
    let valSpans: any[] = []
    try {
      valSpans = (valText.getTextChildren() ?? []) as any[]
    } catch {
      return false
    }
    if (valSpans.length < 1) return false
    let ctxObj: any = null
    try {
      ctxObj = rowBox.ctx ?? null
    } catch {
      ctxObj = null
    }
    if (!ctxObj) {
      dbg("editor ctx unavailable")
      return false
    }
    try {
      valSpans[0].children = [""]
      // COLUMN FIX (user report: editor opened too far right): the input must
      // sit exactly where the value column is. The LIVE row now is TWO texts
      // (`cfg.` prefix+label ending at 4*maxDepth+keyW+6, `cfgval.` the value
      // cell whose span's leading blank is the 1 cell at +6), so blanking
      // cfgval's span AND narrowing it to that ONE blank cell puts the input's
      // insertion point (rowBox.add index 2, i.e. right after cfgval) at
      // 4*maxDepth+keyW+7 — the exact pre-split geometry. The commit/cancel
      // repaint (patchRowValueInPlace) restores the value text's full width
      // and content.
      valText.width = 1
      valText.requestRender?.()
    } catch (cause: any) {
      dbg(`editor blank FAILED ${setting.path}: ${cause?.message ?? cause}`)
      return false
    }
    let input: any = null
    try {
      input = new InputRenderable(ctxObj, {
        width: valW,
        value: s.editVal,
        backgroundColor: formfieldBg,
        textColor: "#e6edf3",
        focusedBackgroundColor: formfieldBg,
        focusedTextColor: formfieldFg,
      })
      rowBox.add(input, 2)
    } catch (cause: any) {
      dbg(`editor create FAILED ${setting.path}: ${cause?.message ?? cause}`)
      try {
        valSpans[0].children = [` ${fitValue(valueText(setting), valW, setting.path === "terminalFont.family")}`]
        valText.width = valW + 1
        valText.requestRender?.()
      } catch {
        /* best effort */
      }
      return false
    }
    s.editInputRef = input
    try {
      input.on(InputRenderableEvents.INPUT, (value: string) => {
        if (cfgState) cfgState.editVal = value ?? ""
        dbg(`edit input -> ${JSON.stringify(value)}`)
      })
    } catch (cause: any) {
      dbg(`editor INPUT wiring FAILED: ${cause?.message ?? cause} (commit reads plainText)`)
    }
    dbg(`editor opened in place ${setting.path} (value "${s.editVal}")`)
    return true
  }

  // Width-only resize: recompute the value-column budget from the new terminal
  // width and repaint every live row (value text re-fit + fixed text width) —
  // the exact changes a remount would produce, without the scrollbox rebuild.
  // One unreachable row degrades the whole pass (mirrors buildList's
  // mount-time math).
  function applyResizeInPlace(w: number): boolean {
    const box: any = s.bodyBoxRef
    if (!box || box.isDestroyed) return false
    // An open imperative editor has its row's text1 narrowed to the label
    // width — this pass would clobber that. Degrade to the remount path,
    // which repaints the edit row from JSX with fresh widths.
    if (s.editing) return false
    const msgW2 = Math.max(36, Math.min(110, w - 6))
    const valW2 = Math.max(4, msgW2 - (4 * maxDepth + keyW + 38))
    // The `cfg.` key column's width (4*maxDepth + keyW + 6) is resize-invariant
    // (derived from keyW/maxDepth only); the `cfgval.` value cell is
    // valW + 1 (its span's content is ` ${fitValue(...)}` — one leading blank
    // + the value).
    const valColW2 = valW2 + 1
    const rows = (s.items ?? []).filter(
      (i: ConfigListItem): i is Extract<ConfigListItem, { kind: "row" }> => i.kind === "row",
    )
    for (const rowItem of rows) {
      const path = rowItem.setting.path
      const rowBox = findRowBoxLive(path)
      if (!rowBox) return false
      let kids: any[] = []
      try {
        kids = rowBox.getChildren() ?? []
      } catch {
        return false
      }
      const text1 = kids.find((c: any) => c?.id === `cfg.${path}`)
      const valText = kids.find((c: any) => c?.id === `cfgval.${path}`)
      if (!text1 || !valText || typeof text1.getTextChildren !== "function") return false
      let spans: any[] = []
      try {
        spans = (text1.getTextChildren() ?? []) as any[]
      } catch {
        return false
      }
      if (spans.length < 2) return false // open editor fallback row — remount repaints it
      let valSpans: any[] = []
      try {
        valSpans = (valText.getTextChildren() ?? []) as any[]
      } catch {
        return false
      }
      if (valSpans.length < 1) return false
      try {
        valText.width = valColW2
        valSpans[0].children = [` ${fitValue(valueText(rowItem.setting), valW2, path === "terminalFont.family")}`]
        text1.requestRender?.()
        valText.requestRender?.()
      } catch (cause: any) {
        dbg(`resize patch FAILED ${path}: ${cause?.message ?? cause}`)
        return false
      }
    }
    return true
  }

  // Keyboard routing now lives at MODULE level (see `openConfigDialog`): the
  // key hook is registered ONCE per dialog open, outside the remounted
  // component, and dispatches through `s.actions` so it always reaches the
  // current mount's mutation functions.
  // The value cell text for one row (when not in its inline editor): the
  // applied runtime value wins when there is no newer draft, then the draft,
  // then the payload (file/merged) value; `(cleared)` marks a pending delete.
  function valueText(setting: ConfigSetting) {
    const draft = draftMap()
    if (draft.has(setting.path)) {
      const value = draft.get(setting.path)
      return value === null ? "(cleared)" : value === false ? "false" : String(value)
    }
    if (cfgRuntimeApplied.has(setting.path)) {
      const value = cfgRuntimeApplied.get(setting.path)
      if (value === null) return setting.value == null ? "(unset)" : "(cleared)"
      return value === false ? "false" : String(value)
    }
    const value = setting.value
    if (value === null || value === undefined) return "(unset)"
    return value === false ? "false" : String(value)
  }

  // TRUE when the row is currently DISPLAYED through the applied runtime
  // overlay and it actually differs from the file/merged value the row's
  // payload carries. The runtime value beats the file value, and a draft that
  // drifted away from what was last applied is NOT applied (it is a pending
  // draft again - yellow ✱, provenance badge).
  function appliedActive(setting: ConfigSetting): boolean {
    const path = setting.path
    if (!cfgRuntimeApplied.has(path)) return false
    if (draftMap().has(path) && !jsonEq(draftMap().get(path), cfgRuntimeApplied.get(path))) {
      return false
    }
    const active = draftMap().has(path) ? draftMap().get(path) : cfgRuntimeApplied.get(path)
    return !jsonEq(active, setting.value)
  }

  // Badge text + color for one row: green `[applied]` when the runtime overlay
  // rules the row and differs from the file value; the provenance badge
  // otherwise. `badgeOf` returns the UNpadded text (renderers padEnd(10)).
  function badgeOf(setting: ConfigSetting): { badge: string; badgeFg: string } {
    if (appliedActive(setting)) {
      return { badge: BADGE_TEXT["applied"], badgeFg: BADGE_COLOR["applied"] }
    }
    const key = setting.source ?? "default"
    return { badge: BADGE_TEXT[key] ?? "[default]", badgeFg: BADGE_COLOR[key] ?? mutedFg }
  }

  // Column layout: every row is ONE `text` element (OpenTUI hit-testing fires
  // mouse handlers on the deepest `text` under the cursor — handlers on the
  // enclosing `box` never fire), so the cells must be fixed-width string
  // segments. That also fixes the overflowing `family` value: it is truncated
  // to the value column instead of pushing the badge sideways.
  //
  // Restart hint: a dedicated fixed-width column (blank for rows that don't
  // need it) so the badges and ` ↺` stay aligned across rows.
  const keyW = Math.min(
    30,
    Math.max(16, ...settings().map((s) => (rowLabel(s, sectionOf(s.path)).split(".").pop() ?? "").length)),
  )
  // Message-row width, responsive: xlarge dialog = 116 wide with inset 3 each
  // side -> 110 cells on a full-size terminal, but the host shrinks the dialog
  // on a narrower terminal, so the budget derives from the live renderer width
  // (`min(110, width - 6)`).
  const msgW = Math.max(36, Math.min(110, (Number(context.renderer?.width) || 116) - 6))
  // Fixed row budget (all cells except the value one), in final order:
  //   indent+marker (4*maxDepth + 3) + " <label>" (aligned worst total
  //   4*maxDepth + keyW + 2) + value leading (1) + ` ↺` (2) + badge (11)
  //   + restart column (1 + 19 = 20, RESTART_W: the widest tier text,
  //   "(needs web restart)") + 1 trailing cell the scrollbox scrollbar
  //   must not overlap. The value column takes
  //   the WHOLE remainder (the row is laid out with exact fixed widths, see
  //   the row JSX), so the right-side cells never move; only the value
  //   shrinks. Clamp 4, not 12: on small terminals a fat minimum pushed the
  //   restart-hint column past the dialog edge, where it got cut off.
  const valW = Math.max(4, msgW - (4 * maxDepth + keyW + 42))
  // Truncate with an ellipsis when too long; otherwise pad so columns align.
  const fit = (s: string, w: number) =>
    s.length > w ? s.slice(0, Math.max(1, w - 1)) + "…" : s.padEnd(w)
  // Value cell: HARD cut at the column edge — no "…" marker anywhere (the
  // native `truncate` path ellipsized whole values on narrow dialogs, which
  // read as "value hidden though there was space"). The ONE exception is
  // `terminalFont.family`: its value is a long stack, so it keeps a right-side
  // ellipsis to signal that the stack continues. Otherwise pad so the value
  // column and everything right of it stay aligned.
  const fitValue = (
    s: string,
    w: number,
    ellipsis = false,
  ) =>
    s.length > w
      ? ellipsis
        ? `${s.slice(0, Math.max(0, w - 1))}…`
        : s.slice(0, w)
      : s.padEnd(w)

  // One blank line the host's `paddingBottom` convention expects below the
  // footer, plus the cells the dialog content box occupies on the terminal —
  // geometry for the full-screen backdrop guard (`dialogWidth("xlarge")` = 116,
  // flex-centered by the host overlay). Computing it lets the guard span the
  // whole terminal from inside the content box without an extra render pass.
  const termW = () => Math.max(40, Number(context.renderer?.width) || 0)
  const dlgH = () => Math.max(12, Number(context.renderer?.height) || 30)
  const guardLeft = () => -Math.floor((termW() - 116) / 2)
  // visibleRows + 9: title row, search row, scrollbox (visibleRows + 2),
  // footer row, the host's paddingBottom blank line and the inter-row gaps;
  // the cfg.detail line (after the scrollbox) adds one row + one gap.
  const guardTop = () => -Math.floor((dlgH() - (visibleRows + 11)) / 2)

  // Search-field tokens, copied from the built-in `dialog.select` search: the
  // mint form-field cursor on its focused background, muted placeholder.
  const formfieldFg = context.theme?.text?.formfield?.focused ?? "#7ee787"
  const formfieldBg = context.theme?.background?.formfield?.focused ?? "#0d1117"

  // Click router — belt and braces. Per-row/per-header handlers are the
  // primary path; this root-level handler catches everything that BUBBLES
  // out of the dialog body with a `cfg…` renderable id on the hit target and
  // dispatches it. (Rows intentionally `stopPropagation()` when they act,
  // so this never double-fires. The log records which targets the native
  // hit-test actually resolves — that is how the previous dead-click rounds
  // get diagnosed.)
  const onMouseBelow = (e: any) => {
    dbg(
      `root mouse type=${e?.type} btn=${e?.button} x=${e?.x} y=${e?.y} ` +
        `target=${String(e?.target?.id ?? "(none)")} stopped=${e?.propagationStopped}`,
    )
    // Any wheel tick aborts a pending settle-verified restore chain: the
    // wheel owns the scroll position and must never be fought. (No other
    // wheel behavior here — mouse scrolling stays untouched.)
    if (e?.type === "scroll" && cfgState) cfgState.wheelAt = Date.now()
    if (e?.type !== "up" || e?.defaultPrevented || e?.propagationStopped) return
    if (e?.button !== 0 && e?.button !== 2) return
    let node: any = e?.target
    while (node) {
      const id: string = typeof node?.id === "string" ? node.id : ""
      if (id.startsWith("cfgsec.")) {
        dbg(`root dispatch: fold ${id.slice(7)}`)
        blurSearch()
        if (s.editing) tryCommitEditBeforeNavigate()
        if (e?.button === 0) toggleFoldInPlace(id.slice(7)) || rebuild()
        return
      }
      if (id.startsWith("cfgval.")) {
        const path = id.slice(7)
        for (const item of itemsSig()) {
          if (item.kind === "row" && item.setting.path === path) {
            dbg(`root dispatch: value ${path} btn=${e?.button}`)
            blurSearch()
            if (s.editing) tryCommitEditBeforeNavigate()
            // Same in-place-first cursor move as the value-cell handler (no
            // remount flash when selecting before acting).
            if (!selectCursorInPlace(item.index)) setCursor(item.index)
            // VALUE column semantics: left click activates/edits.
            if (e?.button === 0) activate(item.setting, true)
            else if (e?.button === 2) resetRow(item.setting)
            return
          }
        }
        return
      }
      if (id.startsWith("cfg.") || id.startsWith("cfgbadge.")) {
        const path = id.startsWith("cfg.") ? id.slice(4) : id.slice(9)
        for (const item of itemsSig()) {
          if (item.kind === "row" && item.setting.path === path) {
            dbg(`root dispatch: key ${path} btn=${e?.button}`)
            blurSearch()
            if (s.editing) tryCommitEditBeforeNavigate()
            // Same in-place-first cursor move (no remount flash when
            // selecting before acting).
            if (!selectCursorInPlace(item.index)) setCursor(item.index)
            // KEY/badge columns are SELECT-ONLY on a left click (user-locked
            // UX: only the value column changes the value); right click keeps
            // the ↺ reset strategy.
            if (e?.button === 2) resetRow(item.setting)
            return
          }
        }
        return
      }
      node = node?.parent
    }
  }

  // STATELESS SNAPSHOT RETURN. The JSX is plain: all values come from the
  // item stamps captured at mount. No owner management, no disposers — the
  // host tears the remounted dialog down itself.

  return (
    <box
      flexDirection="column"
      width="100%"
      gap={1}
      paddingLeft={3}
      paddingRight={3}
      paddingBottom={1}
      ref={(el: any) => {
        if (el) el.onMouse = (e: any) => onMouseBelow(e)
      }}
    >
      {/* Backdrop guard: the built-in `Dialog` wrapper clears the whole dialog
          stack when the mouse is released on the dark backdrop (outside the
          content box). This transparent full-terminal box — positioned to
          cover the backdrop from inside the content box, and painted before
          the content so it never wins a hit-test over real rows — swallows
          outside mousedown/mouseup on every mount so clicking outside no
          longer closes the dialog (the content box above already
          stopPropagation()s everything bubbling out of its subtree; the
          guard's own lifecycle ends with the mount, so no disable-flip is
          needed). */}
      <box position="absolute" left={guardLeft()} top={guardTop()} width={termW()} height={dlgH()} {...guardProps()} />
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text attributes={1} fg="#e6edf3">
            PTY config
          </text>
          <text id="cfg.count" fg={mutedFg}>
            {`${settings().length} settings${changedCount() > 0 ? ` · ${changedCount()} changed` : ""}${appliedCount() > 0 ? ` · ${appliedCount()} applied` : ""}`}
          </text>
        </box>
        <text
          id="cfg.esc"
          fg={mutedFg}
          flexShrink={0}
          onMouseUp={(e: any) => {
            dbg("esc label click")
            e?.stopPropagation?.()
            blurSearch()
            if (s.editing) tryCommitEditBeforeNavigate()
            close()
          }}
        >
          esc
        </text>
      </box>
      {/* dialog.select-style search: the ONLY element is the input — its
          placeholder "Search" does the label's job (gone as soon as typing
          starts). Click-to-edit: a wrapper box takes the mouse too, because
          hit-testing may resolve the wrapper instead of the focusable input —
          both paths focus the field (and the input's own native mouse-down
          autofocus, if it fires first, is the same thing). */}
      <box
        width="100%"
        onMouseUp={(e: any) => {
          dbg("search wrapper click -> focus")
          e?.stopPropagation?.()
          focusSearch()
        }}
      >
        <input
          id="cfg.search"
          width="100%"
          placeholder="Search"
          placeholderColor={mutedFg}
          // Initial buffer: on a remount the input must show the query typed
          // so far (the module key channel writes `s.query` without the input,
          // and each remount creates a fresh buffer).
          value={query()}
          cursorColor={formfieldFg}
          focusedBackgroundColor={formfieldBg}
          focusedTextColor={formfieldFg}
          ref={(r: any) => {
            s.searchInputRef = r
            // FOCUS CONTINUITY: focus only when the search owned the
            // keyboard before the remount (captured by queueRefresh; init
            // `true` covers the first mount — dialog-open behavior). This
            // is what stops enter/click/value-edit remounts from silently
            // re-focusing the search ("selects the search" bug); typing,
            // space and backspace focus it via the key channel instead.
            if (!s.editing && s.searchWasFocused) {
              setTimeout(() => {
                if (!s.searchInputRef || s.searchInputRef.isDestroyed || s.editing) return
                s.searchInputRef.focus?.()
              }, 1)
            }
          }}
          onInput={(value: string) => {
            dbg(`search input -> ${JSON.stringify(value)}`)
            setQuery(value ?? "")
          }}
        />
      </box>
      <scrollbox
        width="100%"
        height={visibleRows + 2}
        scrollY
        ref={(r: any) => {
          // Restore the tracked scroll position on every remount (a fresh
          // scrollbox starts at 0). Deferred + retried like the search-focus
          // so the children are laid out by then; a no-op when viewTop is 0
          // (fresh open or cursor already at the top).
          s.bodyBoxRef = r
          s.detachedRows.clear()
          const restore = (tries: number) => {
            const box = s.bodyBoxRef
            if (box && !box.isDestroyed) {
              // Clamp against the CONTENT item count (deterministic at this
              // point) — a fresh scrollbox may not have its layout/scroll
              // metrics settled yet, so never rely on scrollHeight here.
              const maxTop = Math.max(0, (s.items ?? []).length - Math.max(6, s.boxH || 6))
              const want = Math.min(Math.max(0, s.viewTop ?? 0), maxTop)
              if (want <= 0) return
              // SETTLE-VERIFIED restore. Writing scrollTop right after the
              // ref fires is often clamped away by the layout pass that
              // follows a fresh mount (the write "sticks" only occasionally —
              // the live-debug log showed it reading back 0 on the next key
              // press), so the fresh mount flashes the list top. NUMERIC
              // FIRST: `want` is the exact pre-rebuild offset (queueRefresh
              // captures the live box scrollTop), so a sticking write
              // restores the view one-to-one — no edge snapping, no lead
              // loss. OpenTUI's own `scrollChildIntoView` is the LAST resort
              // (after 15 failed numeric polls) because it snaps the marker
              // minimally to an edge. The settle loop (read back / re-assert
              // until the box holds, ±1 tolerance, wheel-abort, supersede,
              // remount handoff) guards both.
              // Prefer the module cursor index — the isCursor stamps go
              // stale after in-place marker moves (see handleDialogKey).
              const allRows = (s.items ?? []).filter(
                (it: ConfigListItem): it is Extract<ConfigListItem, { kind: "row" }> =>
                  it.kind === "row",
              )
              const cursorRow = allRows[s.cursor] ?? allRows.find((r) => r.isCursor) ?? null
              let numericTries = 0
              const scrollToWant = () => {
                if (numericTries < 15) {
                  numericTries++
                  box.scrollTop = want
                  return
                }
                if (cursorRow && typeof box.scrollChildIntoView === "function") {
                  try {
                    dbg(`scrollIntoView cfgrow.${cursorRow.setting.path}`)
                    box.scrollChildIntoView(`cfgrow.${cursorRow.setting.path}`)
                    return
                  } catch (cause: any) {
                    dbg(`scrollIntoView failed: ${cause?.message ?? cause} — numeric fallback`)
                  }
                }
                box.scrollTop = want
              }
              const hold = 2
              // Epoch of THIS restore chain: any wheel tick after it aborts.
              const epoch = Date.now()
              const wheelWon = () => s.wheelAt > epoch
              const tick = (left: number, ok: number) => {
                if (wheelWon()) {
                  dbg(`restore aborted: wheel moved the view`)
                  return
                }
                // Superseded: a newer arrow-key move changed the target
                // after this chain started. Without a remount, the owner
                // check (`s.bodyBoxRef !== box`) never fires, so an old
                // chain would keep fighting the new scroll position here.
                if ((s.viewTop ?? 0) !== want) return
                const cur2 = s.bodyBoxRef && !s.bodyBoxRef.isDestroyed
                  ? Math.trunc(Number(s.bodyBoxRef.scrollTop) || 0)
                  : NaN
                if (Number.isNaN(cur2)) return // current box got destroyed meanwhile
                if (s.bodyBoxRef !== box) return // remounted: a newer chain owns the box now
                if (Math.abs(cur2 - want) > 1) {
                  scrollToWant()
                  dbg(`restore reassert want=${want} cur=${cur2} left=${left}`)
                  setTimeout(() => tick(Math.max(0, left - 1), 0), 8)
                  return
                }
                if (ok + 1 >= hold) {
                  dbg(`restore settled viewTop=${cur2} ${Date.now() - epoch}ms after mount ref`)
                  return
                }
                setTimeout(() => tick(Math.max(0, left - 1), ok + 1), 8)
              }
              scrollToWant()
              dbg(`restore viewTop=${want} @ref`)
              setTimeout(() => tick(40, 0), 0)
              return
            }
            if (tries <= 0) return
            setTimeout(() => restore(tries - 1), 10)
          }
          restore(20)
        }}
      >
        <For each={itemsSig()}>
          {(item) => {
            // Snapshot stamp — no live reactivity: every mutation remounts the
            // whole dialog, so this runs once per refresh.
            dbg(
              `render item ${item.kind === "header" ? `sec:${item.foldKey}` : `row:${item.setting.path}`}`,
            )
            if (item.kind === "header") {
              // Sub-headers sit one step deeper than their sibling keys and
              // share the column of their own children; sections render at
              // column 0 (level -1). No counts — the user asked them off.
              const pad = " ".repeat((item.level + 1) * 4)
              return (
                <text
                  id={`cfgsec.${item.foldKey}`}
                  truncate
                  onMouseUp={(e: any) => {
                    dbg(`header click ${item.foldKey} btn=${e?.button}`)
                    blurSearch()
                    if (e?.button === 0) {
                      e?.stopPropagation?.()
                      toggleFold(item.foldKey)
                    }
                  }}
                >
                  <b style={{ fg: "#e6edf3" }}>{`${pad}${item.open ? "▼" : "▶"} ${item.label}`}</b>
                </text>
              )
            }
            // Rows render PURELY from the item stamps captured by rebuild() —
            // no signal reads here (they went stale in the live TUI).
            const setting = item.setting
            const { badge: badgeRaw, badgeFg: badgeFg } = badgeOf(setting)
            const badge = badgeRaw.padEnd(10)
            const isEditing = item.isEditing
            const isCursor = item.isCursor
            const changed = item.changed
            // Indentation: rows start at the content edge and every tree level
            // adds 4. The label field is padded so the VALUE column stays at
            // one constant column for every depth (indent + marker + label +
            // pad = maxDepth*4 + 4 + keyW).
            const indent = Math.max(0, item.level * 4)
            const marker = `${isCursor ? "›" : changed ? "✱" : " "}  `
            const prefix = `${" ".repeat(indent)}${marker}`
            const label = fit(item.leaf, keyW).padEnd(keyW + (maxDepth - item.level) * 4)
            // While this row is being text-edited: a real single-line <input>
            // (height 1, keeps the caret visible; long values scroll inside the
            // input as the caret moves, like a web input) next to the fixed key
            // and badge columns. Its buffer is plain `editVal` — no reactive
            // writes while typing (a rebuild would re-create the input and
            // reset the caret).
            if (isEditing) {
              return (
                <box flexDirection="row" id={`cfgrow.${setting.path}`} width="100%" paddingRight={1}>
                  <text wrapMode="none" truncate flexShrink={0}>
                    <span style={{ fg: "#e6edf3" }}>{`${prefix} ${label}  `}</span>
                  </text>
                  <input
                    id={`cfgedit.${setting.path}`}
                    width={valW}
                    ref={(r: any) => {
                      s.editInputRef = r
                    }}
                    value={item.editValue}
                    onInput={(value: string) => {
                      if (s) s.editVal = value ?? ""
                    }}
                  />
                  {/* Blank 2 cells where the ↺ column sits, so the badge and
                      restart-hint columns align with the other rows. */}
                  <text wrapMode="none" flexShrink={0}>{`  `}</text>
                  <text wrapMode="none" flexShrink={0}>
                    <span style={{ fg: badgeFg }}>{` ${badge}`}</span>
                    <span style={{ fg: mutedFg }}>{restartCellText(setting)}</span>
                  </text>
                </box>
              )
            }
            const rawValue = item.value
            const valueFg =
              rawValue === "(cleared)"
                ? "#f85149"
                : appliedActive(setting)
                  ? "#56d364"
                  : changed
                    ? "#ffd24a"
                    : "#c9d1d9"
            // Row cells in order: [indent+marker+label] [value] [ ↺] [badge +
            // restart hint]. Click UX (user-locked): the KEY cell (prefix +
            // label, id `cfg.<path>`) SELECTS ONLY — a left click moves the
            // cursor row and never touches the value; the VALUE cell (id
            // `cfgval.<path>`) carries the full row semantics (left click
            // activates/opens the editor, right click resets). The ↺ reset
            // control stays its own <text> hit target (clicking it must reset,
            // not activate — an in-row marker fell through to activate/toggle
            // in early rounds); the badge and restart hint form a second
            // <text> limited to select + reset (a click there is not a value
            // click). Hit-testing fires on the deepest text — boxes never
            // fire. ↺ = undo the change all the way (draft AND an applied
            // runtime overlay); the hint is read-only (`(needs /restart)` vs
            // `(needs web restart)`, per tier). EXACT cell math instead of
            // flex: native `truncate` inserts its own "…" one layer below us
            // (it wiped out visible value cells when the dialog shrank), so
            // the value <text> gets a fixed width and `fitValue` cuts it
            // ourselves. All rows share ONE value-cell width — the 4·level
            // indent and the 4·(maxDepth-level) label pad cancel out, so the
            // label region (incl. the label span's 1 leading + 2 trailing
            // spaces) ends at the constant offset 4·maxDepth + keyW + 6, the
            // value span's leading blank sits at +6 and its first VISIBLE
            // character at +7 (this is also exactly where the old single-text
            // editor landed). So: `keyColW = 4*maxDepth + keyW + 6`,
            // `valColW = valW + 1` (content ` ${fitValue}` fits it exactly)
            // — the ⇥ ↺ / badge / restart-hint cells sit flush at the dialog
            // edge exactly as with the pre-split single text.
            const keyColW = 4 * maxDepth + keyW + 6
            const valColW = valW + 1
            const selectRowAt = (e: any) => {
              // Shared by BOTH cells: a click is never a search click —
              // unfocus it, then move the cursor in place (no remount => no
              // scroll flash); the remounting setCursor is only the degraded
              // fallback.
              blurSearch()
              if (!selectCursorInPlace(item.index)) setCursor(item.index)
            }
            const keyMouseUp = (e: any) => {
              dbg(`key click ${setting.path} btn=${e?.button}`)
              selectRowAt(e)
              if (e?.button === 0) {
                if (s.editing) tryCommitEditBeforeNavigate()
                e?.stopPropagation?.()
                // SELECT ONLY: the key column never changes the value.
              } else if (e?.button === 2) {
                // Same value-reset strategy as the ↺ reset button (draft undo
                // -> applied-overlay undo -> default toast -> clear), never a
                // direct clear.
                e?.stopPropagation?.()
                resetRow(setting)
              }
            }
            const rowMouseUp = (e: any) => {
              dbg(`value click ${setting.path} btn=${e?.button}`)
              selectRowAt(e)
              if (e?.button === 0) {
                if (s.editing) tryCommitEditBeforeNavigate()
                e?.stopPropagation?.()
                activate(setting, true)
              } else if (e?.button === 2) {
                e?.stopPropagation?.()
                resetRow(setting)
              }
            }
            return (
              <box
                flexDirection="row"
                alignItems="center"
                width="100%"
                paddingRight={1}
                // Stable child id: this is what `scrollChildIntoView` targets
                // in the restore chain (layout-aware alternative to raw
                // scrollTop writes, which the early-mount clamp kept erasing).
                id={`cfgrow.${setting.path}`}
              >
                <text
                  id={`cfg.${setting.path}`}
                  wrapMode="none"
                  width={keyColW}
                  onMouseUp={keyMouseUp}
                >
                  <span style={{ fg: isCursor ? "#e6edf3" : "#4d5566" }}>{prefix}</span>
                  <span style={{ fg: isCursor ? "#e6edf3" : "#c9d1d9" }}>{` ${label}  `}</span>
                </text>
                <text
                  id={`cfgval.${setting.path}`}
                  wrapMode="none"
                  width={valColW}
                  onMouseUp={rowMouseUp}
                >
                  <span style={{ fg: valueFg }}>{` ${fitValue(rawValue, valW, setting.path === "terminalFont.family")}`}</span>
                </text>
                <text
                  id={`cfgreset.${setting.path}`}
                  wrapMode="none"
                  flexShrink={0}
                  fg={draftMap().has(setting.path) ? "#ffd24a" : mutedFg}
                  onMouseUp={(e: any) => {
                    dbg(`reset click ${setting.path} btn=${e?.button}`)
                    e?.stopPropagation?.()
                    blurSearch()
                    // Same in-place-first cursor move as the row handler — the
                    // bare setCursor remounted the dialog and flashed top-then-
                    // restored (the reset's repaint problem came from THIS line).
                    if (!selectCursorInPlace(item.index)) setCursor(item.index)
                    // Both buttons use the same value-reset strategy (the
                    // user-locked semantics: right-click == reset button).
                    resetRow(setting)
                  }}
                >
                  {` ↺`}
                </text>
                <text
                  id={`cfgbadge.${setting.path}`}
                  wrapMode="none"
                  flexShrink={0}
                  onMouseUp={(e: any) => {
                    dbg(`badge click ${setting.path} btn=${e?.button}`)
                    e?.stopPropagation?.()
                    // Badge column is not the value column: select only on a
                    // left click; a right click reset stays available (the
                    // whole row semantics split: value = edit, rest = select).
                    selectRowAt(e)
                    if (e?.button === 2) resetRow(setting)
                  }}
                >
                  <span style={{ fg: badgeFg }}>{` ${badge}`}</span>
                  <span style={{ fg: mutedFg }}>{restartCellText(setting)}</span>
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
      {/* Detail line: the DESC of the currently selected row (dimmed, hard-
          truncated to the dialog width). Rebuilt from the snapshot on every
          remount; module-level marker moves repatch it in place via
          s.actions.patchDetail. Layout: an extra flow row + gap -> the
          backdrop guard's centering math counts both (visibleRows + 11). */}
      <text id="cfg.detail" fg={mutedFg} wrapMode="none" width="100%" flexShrink={0}>
        {fitValue(detailTextOf(s.cursor), msgW, true)}
      </text>
      <box flexDirection="row" width="100%" justifyContent="space-between" flexShrink={0}>
        <text fg={mutedFg}>
          {"↑↓ move · tab next · enter/‹› edit · ctrl+x clear · ctrl+s save"}
        </text>
        <box flexDirection="row" gap={1} flexShrink={0}>
          {/* Apply only mutates the runtime (memory); save writes a config
              file. Both stay uncolored (muted text, no background) per the
              layout ask. Apply keeps the drafts pending (✱ + `save N`) so the
              same values can be persisted later, and stamps the rows as
              applied: green value + green `[applied]` badge. Webserver-tier
              keys (⟳ + "(needs web restart)") take their PTY stack soft
              restart right away; full-tier keys (`(needs /restart)`) never
              restart anything. */}
          <box
            id="cfg.apply"
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={secondaryBg}
            onMouseUp={(e: any) => {
              dbg(`apply button click (changed=${changedCount()})`)
              e?.stopPropagation?.()
              blurSearch()
              if (s.editing) tryCommitEditBeforeNavigate()
              void applyFlow()
            }}
          >
            <text fg={mutedFg}>{changedCount() > 0 ? `apply ${changedCount()}` : "apply"}</text>
          </box>
          {/* Always visible: with no draft it toasts "Nothing changed", so the
              button never dead-ends. Sits left of `close`, per the layout ask. */}
          <box
            id="cfg.save"
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={secondaryBg}
            onMouseUp={(e: any) => {
              dbg(`save button click (changed=${changedCount()})`)
              e?.stopPropagation?.()
              blurSearch()
              if (s.editing) tryCommitEditBeforeNavigate()
              void saveFlow()
            }}
          >
            <text fg={mutedFg}>{changedCount() > 0 ? `save ${changedCount()}` : "save"}</text>
          </box>
          <box
            id="cfg.close"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={buttonBg}
            onMouseUp={(e: any) => {
              dbg("close button click")
              e?.stopPropagation?.()
              blurSearch()
              close()
            }}
          >
            <text fg={buttonFg}>close</text>
          </box>
        </box>
      </box>
    </box>
  )
}

// The module-level owner of the replace-rebuild dialog state and refresh
// channel (created on open, nulled on close).
type ConfigDialogState = {
  context: any
  data: ConfigPayload
  save: (changes: { path: string; value: unknown }[], target: { scope: string; where?: string }) => Promise<any>
  apply: (changes: { path: string; value: unknown }[]) => Promise<any>
  // Post-success hook for BOTH flows (save + apply). Receives the changed
  // paths when given: the sidebar side uses them for the enabled-latch UX
  // (tuiSidebar.enabled among them -> `ptySectionShown` opens, see the
  // openConfigDialog call site). Optional argument so the old
  // `s.onSaved()` shape keeps working.
  onSaved: (changes?: { path: string; value: unknown }[]) => Promise<void> | void
  // Restart the PTY stack via the RPC (`PtyRpc.restart`). Optional: without an
  // RPC bridge the dialog simply never offers a restart after a save/apply.
  restart?: (scope: string) => Promise<any>
  query: string
  drafts: Map<string, unknown>
  folds: Set<string>
  cursor: number
  editing: string | null
  editVal: string
  busy: boolean
  items: ConfigListItem[]
  // Absolute row count (not the windowed count) for up/down clamping.
  totalRows: number
  actions: {
    setCursor: (at: number) => void
    activate: (setting: ConfigSetting) => void
    stepEnum: (setting: ConfigSetting, dir: number) => void
    setValue: (setting: ConfigSetting, value: unknown) => void
    cancelEdit: () => void
    commitEdit: () => void
    saveFlow: () => void
    resetRow?: (setting: ConfigSetting) => void
    // Repatch the detail line (detailTextOf(s.cursor)) in place after module-
    // level marker moves that did not rebuild the dialog.
    patchDetail?: () => void
  }
  searchInputRef: any
  editInputRef: any
  offKeys: (() => void) | null
  // Terminal-resize watcher (see ConfigDialog's mount): one interval per open,
  // cleared/re-created on every remount.
  geoTimer: ReturnType<typeof setInterval> | null
  geoW: number
  geoH: number
  // Body scrollbox position and geometry for ARROW-KEY marker following
  // (`s.viewTop <= marker line <= s.viewTop + s.boxH - 2`). Only marker
  // movement adjusts `viewTop`; mouse wheel scrolling stays untouched and
  // remounts restore `viewTop` through `bodyBoxRef`.
  viewTop: number
  boxH: number
  bodyBoxRef: any
  // Timestamp of the last wheel tick (0 = none): a pending restore chain
  // aborts when the wheel has moved the view, since the wheel owns the
  // scroll position and must never be fought.
  wheelAt: number
  // Whether the search input owned the keyboard before the last remount
  // (captured by queueRefresh). The input ref restores focus from it —
  // focus CONTINUITY instead of unconditional autofocus, so non-typing
  // interactions never silently steal the keyboard into the search field.
  // Init `true`: the first mount focuses the search (dialog-open behavior).
  searchWasFocused: boolean
  // Whether the search input owned the keyboard immediately before the current
  // INLINE EDITOR opened (snapshot in activate). Commit/cancel refocuses the
  // search from this — only when the user arrived from the search field, so
  // ending an edit never steals the keyboard into the search on its own.
  searchWasFocusedBeforeEdit: boolean
  // True while a host sub-dialog (save-flow picker) is stacked on top of the
  // config dialog: the module key channel lets arrows/enter/escape through to
  // the host dialog instead of dispatching into the config handler.
  saving: boolean
  // Live row/sub-header boxes detached by an in-place fold, keyed by their
  // element id (`cfgrow.<path>` / `cfgsec.<foldKey>`). An unfold re-attaches
  // the kept renderable — no remount either way. Cleared whenever the dialog
  // remounts (the fresh <For> tree holds fresh boxes; the old ones are gone).
  detachedRows: Map<string, any>
}

let cfgState: ConfigDialogState | null = null
let cfgRefreshPending = false
// Remount the dialog through the plugin dialog API (`show` = host-side
// `replace`, i.e. swap the top of the dialog stack). Coalesced: several
// mutations within one tick repaint once. Runs OUTSIDE any dialog component.
function queueRefresh() {
  if (cfgRefreshPending || !cfgState) return
  cfgRefreshPending = true
  setTimeout(() => {
    cfgRefreshPending = false
    const s = cfgState
    if (!s) return
    // Capture the LIVE dialog state before the replace tears it down:
    // - the exact scroll offset (the restore lands precisely where the view
    //   was — no childScroll edge snapping, no lead loss), and
    // - whether the search input owns the keyboard (focus continuity — the
    //   fresh input restores it; non-typing interactions never steal it).
    const box = s.bodyBoxRef
    if (box && !box.isDestroyed) {
      s.viewTop = Math.max(0, Math.trunc(Number(box.scrollTop) || 0))
    }
    const search = s.searchInputRef
    s.searchWasFocused = Boolean(search && !search.isDestroyed && search.focused) && !s.editing
    dbg(`queueRefresh -> remount (viewTop ${s.viewTop}, searchWasFocused ${s.searchWasFocused})`)
    s.context.ui.dialog.show(() => <ConfigDialog />)
    // `show` -> host `replace` resets size to "medium" + uncentered; re-apply.
    s.context.ui.dialog.set?.({ size: "xlarge", centered: true })
  }, 0)
}

// Close from anywhere (key channel, buttons, post-save): clear the state and
// pop the dialog. The key hook is released here.
function closeConfigDialog() {
  const s = cfgState
  if (!s) return
  cfgState = null
  cfgRefreshPending = false
  if (s.geoTimer) {
    clearInterval(s.geoTimer)
    s.geoTimer = null
  }
  dbg("config dialog close")
  try {
    s.offKeys?.()
  } catch {
    /* already released */
  }
  try {
    s.context.ui.dialog.clear?.()
  } catch {
    /* stack already dismissed */
  }
}

// Register the key hook ONCE per dialog open. See the channel-selection notes
// in earlier progress-log rounds: `keymap.intercept` (dev branch) or a
// prepended `renderer.keyInput` listener is the proven tier. The handler reads
// module state and dispatches through the current mount's action functions.
// IN-PLACE marker patch for arrow-key moves (no remount). Flips the marker
// cell (`›` / `✱`/space prefix) and the two affected span colors on the OLD
// and NEW cursor rows directly on the live renderables. Rationale: the
// remount fired on every arrow press rebuilt the whole dialog, and the fresh
// scrollbox paints its first frames at scrollTop 0 — the layout pass that
// would let a restore stick only completes after those frames were drawn
// (that IS the "flashes as if scrolled to top" glitch). Patching inside the
// already-scrolled live box cannot flash because no such frame is ever
// created. Returns false when the row could not be patched, so the caller
// can fall back to the remount path.
function patchMarkerRow(
  s: ConfigDialogState,
  rows: Extract<ConfigListItem, { kind: "row" }>[],
  idx: number,
  isCursor: boolean,
): boolean {
  const box: any = s.bodyBoxRef
  if (!box || box.isDestroyed) return false
  const rowItem = rows[idx]
  if (!rowItem) return true // nothing at that index (edge) — treat as ok
  const path = rowItem.setting.path
  const rowBox: any = typeof box.findDescendantById === "function"
    ? box.findDescendantById(`cfgrow.${path}`)
    : null
  if (!rowBox) {
    dbg(`patch marker: row box not found cfgrow.${path}`)
    return false
  }
  const kids = (typeof rowBox.getChildren === "function" ? rowBox.getChildren() : []) as any[]
  const text1 = kids.find((c) => c?.id === `cfg.${path}`)
  if (!text1 || typeof text1.getTextChildren !== "function") {
    dbg(`patch marker: text1 not found ${path}`)
    return false
  }
  const spans = text1.getTextChildren() as any[]
  if (!spans || spans.length < 2) {
    dbg(`patch marker: spans missing ${path}`)
    return false
  }
  try {
    const prefixSpan = spans[0]
    const labelSpan = spans[1]
    const indent = Math.max(0, rowItem.level * 4)
    // The live draft map is authoritative for the ✱ (the old glyph scan read
    // the CURRENT marker cell, which said `›` whenever the cursor sat on a
    // changed row — so stepping off that row erased its ✱ until a rebuild).
    const hadStar = Boolean(s.drafts?.has?.(rowItem.setting.path))
    const marker = isCursor ? "›" : hadStar ? "✱" : " "
    prefixSpan.children = [`${" ".repeat(indent)}${marker}  `]
    // Same colors the JSX stamps (prefix/label switch bright when cursor).
    prefixSpan.fg = isCursor ? "#e6edf3" : "#4d5566"
    labelSpan.fg = isCursor ? "#e6edf3" : "#c9d1d9"
    text1.requestRender?.()
    dbg(`patch marker ${path} cursor=${isCursor} marker=${marker === " " ? "(space)" : marker}`)
    return true
  } catch (cause: any) {
    dbg(`patch marker FAILED ${path}: ${cause?.message ?? cause}`)
    return false
  }
}

function installConfigKeyChannel(context: any, s: ConfigDialogState) {
  const handleDialogKey = (ctx: any) => {
    const key = ctx?.event ?? ctx
    const mods = [key?.ctrl ? "ctrl" : "", key?.meta ? "alt" : "", key?.shift ? "shift" : ""]
      .filter(Boolean)
      .join("+")
    dbg(`key name=${key?.name} mods=${mods || "-"} seq=${JSON.stringify(key?.sequence)} consumed-before=${key?.defaultPrevented}`)
    if (!cfgState) return
    // When a sub-dialog is open (save-flow picker, or any host dialog stacked
    // on top), the host owns the keyboard COMPLETELY: every key — navigation,
    // enter, escape, typing — goes to the sub-dialog, nothing is consumed and
    // nothing is dispatched into the config handler. The sub-dialog
    // (dialog.select) handles navigation (up/down), selection (enter) and its
    // own esc→return-to-config. cfgState.saving is cleared on every save-flow
    // path, which hands the keys back to this channel.
    if (cfgState.saving) {
      dbg(`key redirected to sub-dialog (saving): ${key?.name}`)
      return
    }
    if (key?.defaultPrevented || key?.propagationStopped) return
    const eating = () => {
      if (typeof ctx?.consume === "function") {
        ctx.consume()
        return
      }
      key?.preventDefault?.()
      key?.stopPropagation?.()
    }
    const isEnter = key?.name === "return" || key?.name === "enter"
    const ctrl = Boolean(key?.ctrl)
    const items = s.items ?? []
    const rows = items.filter((i: ConfigListItem) => i.kind === "row") as Extract<ConfigListItem, { kind: "row" }>[]
    // The marker row: prefer the module cursor index — the isCursor STAMPS
    // on the item objects go stale as soon as arrow/tab moves patch the two
    // rows in place without a rebuild (stamps only refresh on the next
    // rebuild). Reading the stale stamp made enter/left-right act on the
    // row that was marked at the LAST rebuild — "sometimes the wrong line".
    const currentRow: Extract<ConfigListItem, { kind: "row" }> | null =
      rows[s.cursor] ?? rows.find((r) => r.isCursor) ?? rows[0] ?? null
    const a = s.actions

    // While a row is in its inline editor, the editor renderable owns normal
    // keys; only escape (cancel), enter (commit) and ctrl+s (save) are ours.
    if (s.editing) {
      if (key?.name === "escape") {
        eating()
        a.cancelEdit()
      } else if (isEnter && !ctrl) {
        eating()
        a.commitEdit()
      } else if (ctrl && key?.name === "s") {
        eating()
        a.saveFlow()
      }
      return
    }

    if (isEnter) {
      // Like dialog.select: enter picks whatever the list cursor points at.
      eating()
      dbg(`enter -> activate ${currentRow ? currentRow.setting.path : "(no row)"}`)
      if (currentRow) a.activate(currentRow.setting)
      return
    }
    if (key?.name === "escape") {
      eating()
      dbg("escape -> close")
      closeConfigDialog()
      return
    }
    // Shared marker-move path for up/down AND tab/shift+tab: the adjoined-
    // line band rule on the live box (scroll only when the marker AND its
    // adjoining line are not already visible), then the in-place two-row
    // patch (NO remount -> no flash), remount only as degraded fallback.
    const moveMarker = (at: number, why: string) => {
      const lvBox = s.bodyBoxRef && !s.bodyBoxRef.isDestroyed ? s.bodyBoxRef : null
      const lvTop = lvBox
        ? Math.max(0, Math.trunc(Number(lvBox.scrollTop) || 0))
        : Math.max(0, s.viewTop ?? 0)
      const bH = Math.max(6, s.boxH || Math.floor((Number(s.context?.renderer?.height) || 30) * 0.55) + 2)
      const mxTop = Math.max(0, items.length - bH)
      let next = lvTop
      if (at >= 0 && at < rows.length) {
        const markerLine = Math.max(0, rows[at]?.line ?? 0)
        if (markerLine > lvTop + bH - 2) next = markerLine - (bH - 2)
        else if (markerLine - 1 < lvTop) next = Math.max(0, markerLine - 1)
        next = Math.max(0, Math.min(next, mxTop))
      }
      s.viewTop = next
      if (lvBox && next !== lvTop) {
        // The box is fully laid out here, so this write sticks — the early-
        // mount clamping that kept erasing remount restores does not apply.
        try {
          lvBox.scrollTop = next
        } catch (cause: any) {
          dbg(`marker scroll FAILED: ${cause?.message ?? cause}`)
        }
        dbg(`marker follow (${why}) -> viewTop ${next} (liveTop ${lvTop}, boxH ${bH}, maxTop ${mxTop})`)
      }
      // IN-PLACE PATCH — the flash fix. A marker move only flips two rows
      // inside the already-scrolled live box; remounting rebuilt the whole
      // dialog from scrollTop 0 and painted that until the restore landed.
      // Update `s.cursor` (future rebuilds re-stamp from it) and patch the
      // two rows directly.
      const prevAt = s.cursor
      s.cursor = at
      if (!lvBox) {
        a.setCursor(at)
        return
      }
      const okOld = prevAt !== at ? patchMarkerRow(s, rows, prevAt, false) : true
      const okNew = patchMarkerRow(s, rows, at, true)
      if (!okOld || !okNew) {
        dbg(`marker patch incomplete (prev ok=${okOld}, new ok=${okNew}) — remount fallback`)
        a.setCursor(at)
      } else {
        // Detail line follows the marker (module channel -> current mount).
        typeof a.patchDetail === "function" && a.patchDetail()
      }
    }

    if (key?.name === "up" || key?.name === "down") {
      eating()
      // Down from the search input leaves search and selects the list.
      s.searchInputRef && !s.searchInputRef.isDestroyed ? s.searchInputRef.blur?.() : null
      const cl = Math.max(0, (s.totalRows ?? rows.length) - 1)
      const at = key?.name === "up" ? Math.max(0, s.cursor - 1) : Math.min(cl, s.cursor + 1)
      dbg(`cursor ${key?.name} -> ${at}`)
      moveMarker(at, key?.name)
      return
    }
    // TAB / SHIFT+TAB: jump the marker to the first config row of the next
    // (previous) SECTION. Sections are the level -1 headers; an item's line
    // == its index in `items` (markLines/emit order). No wrap at the ends.
    if (key?.name === "tab") {
      eating()
      const back = Boolean(key?.shift)
      const rootHeaders = items
        .map((it: ConfigListItem, idx: number) => ({ it, idx }))
        .filter((e) => e.it.kind === "header" && (e.it as Extract<ConfigListItem, { kind: "header" }>).level === -1)
      const markerLine = Math.max(0, rows[s.cursor]?.line ?? 0)
      let curIdx = -1
      for (const e of rootHeaders) {
        if (e.idx < markerLine) curIdx = rootHeaders.indexOf(e)
        else break
      }
      const targetIdx = curIdx + (back ? -1 : 1)
      if (curIdx < 0 || targetIdx < 0 || targetIdx >= rootHeaders.length) {
        dbg(`tab: at section boundary (curIdx ${curIdx}, target ${targetIdx}) — no move`)
        return
      }
      const tHeader = rootHeaders[targetIdx].it as Extract<ConfigListItem, { kind: "header" }>
      const tHeaderIdx = rootHeaders[targetIdx].idx
      let tRow: Extract<ConfigListItem, { kind: "row" }> | null = null
      for (let i = tHeaderIdx; i < items.length; i++) {
        const it = items[i]
        if (it.kind === "row") {
          tRow = it as Extract<ConfigListItem, { kind: "row" }>
          break
        }
      }
      if (!tRow) {
        dbg(`tab: no row after section ${tHeader.foldKey}`)
        return
      }
      const at = rows.findIndex((r) => r === tRow)
      if (at < 0) return
      dbg(`${back ? "shift+tab" : "tab"} -> section ${tHeader.label} row ${at}`)
      moveMarker(at, back ? "shift-tab" : "tab")
      return
    }
    // TYPING / SPACE / BACKSPACE outside a row editor: FOCUS THE SEARCH and
    // deliver the SAME keystroke into it (the filter). While the search is
    // already focused the input handles keys natively (no double delivery),
    // and while a row editor is open this branch never runs (the editing
    // path above returns first). Modifier combos never reach here.
    if (!s.editing) {
      const printable =
        key?.name === "space"
          ? " "
          : key?.name && key.name.length === 1 && !key?.ctrl && !key?.alt && !key?.meta
            ? key.name
            : null
      const isBack = key?.name === "backspace" && !key?.ctrl && !key?.alt && !key?.meta
      if (printable !== null || isBack) {
        const r = s.searchInputRef
        if (r?.focused) return // native input path owns it
        if (r && !r.isDestroyed) {
          eating()
          r.focus?.()
          try {
            if (isBack) {
              r.deleteCharBackward()
              dbg(`auto-search focus + backspace`)
            } else {
              r.insertText(printable)
              dbg(`auto-search focus + ${JSON.stringify(printable)}`)
            }
          } catch (cause: any) {
            dbg(`auto-search FAILED: ${cause?.message ?? cause}`)
          }
          return
        }
      }
    }
    if (key?.name === "left" || key?.name === "right") {
      eating()
      if (currentRow) a.stepEnum(currentRow.setting, key?.name === "right" ? 1 : -1)
      return
    }
    if (ctrl && key?.name === "x") {
      eating()
      if (currentRow) {
        dbg(`ctrl+x reset ${currentRow.setting.path}`)
        // Two-step: draft-undo (delete draft -> row shows saved value) then,
        // with no draft left, clear. Delegate fully to resetRow (same as ↺).
        // The action entry (set on s.actions when ConfigDialog mounts) points
        // to the component closure's resetRow — always the current instance.
        const act = (a as any).resetRow ?? (a as any).setValue
        if (act === (a as any).resetRow) {
          a.resetRow(currentRow.setting)
        } else {
          a.setValue(currentRow.setting, null)
        }
      }
      return
    }
    if (ctrl && key?.name === "s") {
      eating()
      a.saveFlow()
      return
    }
    // Any printable key types into search (even unfocused, like dialog.select
    // widgets): focus the field and let the input renderable insert the char.
    const seq = key?.sequence
    if (typeof seq === "string" && seq.length === 1 && !ctrl && !key?.meta && !key?.super && !key?.hyper) {
      if (s.searchInputRef && !s.searchInputRef.isDestroyed && !s.searchInputRef.focused) {
        dbg(`char ${JSON.stringify(seq)} -> focus search + insert`)
        const next = s.query + (key?.name === "space" ? " " : seq)
        s.query = next
        s.searchInputRef.value = next
        s.searchInputRef.focus?.()
        queueRefresh()
      }
      return
    }
    dbg(`key ${key?.name} ignored (no binding)`)
  }
  const keymapSvc: any = context.keymap
  if (typeof keymapSvc?.intercept === "function") {
    s.offKeys = keymapSvc.intercept("key", (ctx: any) => handleDialogKey(ctx))
    dbg("key channel: keymap.intercept")
    return
  }
  const keyInput: any = context.renderer?.keyInput
  if (keyInput && typeof keyInput.on === "function") {
    const listener = (key: any) => handleDialogKey(key)
    if (typeof keyInput.prependListener === "function") {
      keyInput.prependListener("keypress", listener)
      dbg("key channel: renderer.keyInput prependListener")
    } else {
      keyInput.on("keypress", listener)
      dbg("key channel: renderer.keyInput on")
    }
    s.offKeys = () => {
      try {
        if (typeof keyInput.off === "function") keyInput.off("keypress", listener)
        else if (typeof keyInput.removeListener === "function") keyInput.removeListener("keypress", listener)
      } catch {
        /* emitter already dismantled at teardown */
      }
    }
    return
  }
  dbg("key channel: none available (keys via focused input only)")
}

// Open the replace-rebuild settings dialog. Replaces the former overlay
// mount (which crashed with "No renderer found" — see the progress log).
function openConfigDialog(
  context: any,
  data: ConfigPayload,
  save: (changes: { path: string; value: unknown }[], target: { scope: string; where?: string }) => Promise<any>,
  apply: (changes: { path: string; value: unknown }[]) => Promise<any>,
  onSaved: (changes?: { path: string; value: unknown }[]) => Promise<void> | void,
  restart?: (scope: string) => Promise<any>,
): void {
  closeConfigDialog()
  cfgState = {
    context,
    data,
    save,
    apply,
    onSaved,
    restart,
    query: "",
    drafts: new Map(),
    folds: new Set(),
    cursor: 0,
    editing: null,
    editVal: "",
    busy: false,
    items: [],
    totalRows: 0,
    actions: {
      setCursor: (at: number) => {
        if (cfgState) cfgState.cursor = Math.max(0, at)
        queueRefresh()
      },
      // The remaining action functions are re-bound per mount (below, in the
      // component) so they always operate on the current snapshot build.
      activate: () => {},
      stepEnum: () => {},
      setValue: () => {},
      cancelEdit: () => {},
      commitEdit: () => {},
      saveFlow: () => {},
    },
    searchInputRef: null as any,
    editInputRef: null as any,
    offKeys: null,
    geoTimer: null,
    geoW: 0,
    geoH: 0,
    viewTop: 0,
    boxH: 0,
    bodyBoxRef: null as any,
    wheelAt: 0,
    searchWasFocused: true,
    searchWasFocusedBeforeEdit: false,
    saving: false,
    detachedRows: new Map(),
  }
  installConfigKeyChannel(context, cfgState)
  try {
    context.ui.dialog.show(() => <ConfigDialog />)
    // `show` -> host `replace` resets size to "medium" (60 cols) AND
    // centering to false, so both must be applied AFTER the show.
    context.ui.dialog.set?.({ size: "xlarge", centered: true })
    dbg("config dialog opened (replace-rebuild)")
  } catch (cause: any) {
    dbg(`config dialog open FAILED: ${cause?.message ?? cause}`)
    try {
      context.ui.toast.show({
        message: `PTY config failed to open: ${cause?.message ?? cause}`,
        variant: "error",
      })
    } catch {
      /* toast unavailable */
    }
  }
}


export default Plugin.define({
  id: "opencode-pty-extended.tui",
  async setup(context: any) {
    // Local file config is the fallback. The CLI never receives
    // `plugins[].options` from opencode.json(c), so the server half is the
    // source of truth: it exposes the fully merged, already-resolved settings
    // over RPC. Fetch those and let them win; degrade to the local file view
    // if the server half is unreachable or slow.
    const { config: fileConfig } = loadUserConfig(context?.location?.directory)
    let config = deepMerge(fileConfig, context?.options ?? {})

    // `context.client` is connected to whichever server the CLI uses (local or
    // remote); the RPC subclient talks to the wrapper's server half. The
    // contract id is the SHARED base id (see shared.js PtyRpc): the rpc route
    // resolves registrations against the server-root scope, so per-location
    // ids could never resolve for non-root locations. Everything served here
    // is either shared server state (sessions) or optional (settings/config
    // apply); the config dialog itself reads/writes files locally below, so
    // "which instance answers" no longer matters for correctness.
    let pty: any = null
    try {
      pty = context.client.rpc(PtyRpc)
    } catch {
      /* the RPC subclient is unavailable; the sidebar simply stays empty */
    }

    if (pty) {
      // The server half registers the RPC bridge during its own setup, which
      // may still be in flight when this half loads. Retry briefly within a
      // bounded window so that race does not silently fall back to the file
      // config; on a remote or slow server we simply keep the local config.
      const deadline = Date.now() + 1500
      for (;;) {
        try {
          const remote: any = await pty.settings({})
          if (remote?.tuiSidebar || remote?.output) {
            config = deepMerge(config, { tuiSidebar: remote.tuiSidebar, output: remote.output })
          }
          break
        } catch {
          if (Date.now() >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }

  // --- TUI presence heartbeat (L1: open tabs) --------------------------------
  // Stamps EVERY open session tab through the `present` RPC so the web UI's
  // live-only dropdown keeps including them while THIS TUI stays alive —
  // fully idle background tabs included (user-locked semantics: "open tab =
  // live even when idle"). The tab list comes from `context.ui.tabs.list()`
  // (rows carry `sessionID/title/active/...`; verified live in v76), so open
  // and close are handled naturally: a closed tab simply stops being stamped
  // and its stamp decays on the server (~3 min staleness) — no zombie
  // tracking. Fall back to the in-view session when the tabs API is
  // unavailable. The 60 s heartbeat sits well inside the server's 3 min
  // staleness; unref'd so the timer never holds the TUI process open.
  let tuiInView: string | undefined
  function tuiSessionTabIds(): string[] {
    const ids: string[] = []
    try {
      const anyCtx = context as any
      const rows = anyCtx?.ui?.tabs?.list?.()
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const id = row?.sessionID ?? row?.sessionId ?? row?.id
          if (typeof id === "string" && id) ids.push(id)
        }
      }
    } catch {
      /* tabs API unavailable; fall back to the in-view session */
    }
    if (ids.length === 0 && tuiInView) ids.push(tuiInView)
    return ids
  }
  async function ptyPresenceBeat(ids: string[]) {
    try {
      if (!pty || typeof pty.present !== "function" || ids.length === 0) return
      await pty.present({ ids })
    } catch {
      /* presence is best-effort; never break the plugin */
    }
  }
  const tuiPresenceTimer = setInterval(() => {
    try {
      void ptyPresenceBeat(tuiSessionTabIds())
    } catch {
      /* presence is best-effort */
    }
  }, 60_000)
  try {
    ;(tuiPresenceTimer as any).unref?.()
  } catch {
    /* timer discipline is best-effort */
  }

    // Rebuilt by pullSettings() whenever the server half reports updated
    // settings (/pty-refresh, after a /pty-config save) — `let` so the sidebar
    // closures pick up the refreshed values on the next render.
    let settings = resolveTuiSidebar(config)
    let output = resolveOutput(config)

    // Runtime-only "show all PTYs" override (mirrors the server half's state —
    // the single source of truth lives THERE, shared with the pty_show_all_pty
    // tool; see index.js showAllOverride). `null` = follow
    // `tuiSidebar.filterBySession`; `true`/`false` = explicit override (show
    // every session's PTYs / current session only). A signal so the slot's
    // reactive render scope re-renders on change (same pattern as
    // sectionShown); the mirror is refreshed by pullSettings, which the
    // server's `settings` event (emitted on every override set) drives.
    const [showAllOverride, setShowAllOverride] = createSignal<boolean | null>(null)
    // The visibility to apply right now: override when set, else the config
    // value (`filterBySession`, default true = current session only).
    const showAllEffective = () => {
      const override = showAllOverride()
      if (override !== null) return override
      return settings.filterBySession !== false
    }
    // True while the sidebar shows EVERY session's PTYs (i.e. filtering is
    // off). Drives the per-root-session attribution headers.
    const showAllActive = () => !showAllEffective()

    // Re-pull the fully merged settings (tuiSidebar + output + the show-all
    // override mirror) from the server half. Called by the RPC `settings`
    // event, /pty-refresh and the config dialog's onSaved hook (save + apply).
    // Returns TRUE when anything actually changed (JSON-compare), so the
    // caller knows whether a re-render is worth forcing — a pull that returns
    // identical values is a no-op everywhere.
    async function pullSettings(): Promise<boolean> {
      if (!pty) return false
      try {
        const remote: any = await pty.settings({})
        if (!(remote?.tuiSidebar || remote?.output)) return false
        const before = JSON.stringify({
          tuiSidebar: settings,
          output,
          override: showAllOverride(),
        })
        config = deepMerge(config, { tuiSidebar: remote.tuiSidebar, output: remote.output })
        settings = resolveTuiSidebar(config)
        output = resolveOutput(config)
        setShowAllOverride(
          remote.showAllOverride === true || remote.showAllOverride === false
            ? remote.showAllOverride
            : null,
        )
        return (
          JSON.stringify({
            tuiSidebar: settings,
            output,
            override: showAllOverride(),
          }) !== before
        )
      } catch {
        /* keep the current settings */
        return false
      }
    }

    // Live re-apply of a pulled settings change to the sidebar view (the RPC
    // `settings` event, /pty-refresh and the config dialog's onSaved hook all
    // funnel into this): a settings-only change must still re-render — the
    // refresh() signature includes the settings fingerprint (see below), the
    // session scope recomputes (filterBySession applies immediately), and the
    // refresh is kicked off NOW instead of at the next poll beat.
    async function applyRefreshedSettings() {
      const changed = await pullSettings()
      if (!changed) return
      dbg(`apply refreshed settings (TUI)`)
      lastSignature = null
      updateScope(viewSessionID)
      void refresh()
    }
    // INITIAL MERGE — the old `if (!settings.enabled) return` mount gate is
    // GONE (enabled is now a live show/hide check inside renderPanel, see
    // below; user-locked semantics: the option is about the section being
    // visible, NEVER about loading — everything below still runs while the
    // section is hidden). This await replaces the gate's data job: `config`
    // above resolves from FILES + context.options only — opencode does not
    // forward plugins[].options to the CLI half — so the OLD gate literally
    // could not see a `tuiSidebar.enabled: false` set in opencode.jsonc (or a
    // runtime Apply overlay), which is the bug. Pull the server's merged
    // settings ONCE before the first render and keep them fresh via the
    // `settings` push from here on; without the RPC bridge the local file
    // value stays effective.
    if (pty) {
      try {
        await pullSettings()
      } catch {
        /* local file values stay effective */
      }
    }

    const [sessions, setSessions] = createSignal<PtySession[]>([])
    const [error, setError] = createSignal<string | null>(null)
    // Whether the session list under the `PTY` section header is folded up
    // (todos-list style: `▼ PTY` / `▶ PTY (N sessions)`). A signal so the
    // slot's reactive scope re-renders immediately on toggle, not at the next
    // poll.
    const [collapsed, setCollapsed] = createSignal(false)
    // `tuiSidebar.initiallyHidden` (default true): keep the whole PTY section
    // out of the sidebar until a PTY actually exists. The first session makes
    // it appear — and from then on it never hides again, even when the list
    // becomes empty later (flip to false here; only ever evaluated while the
    // flag is still false, so the display state is a one-way latch).
    // SIGNAL (not a plain let!): the sidebar slot's render scope only re-runs
    // when a reactive dependency it READ changes — a plain variable write is
    // invisible to it (live-proven: the dialog hook flipped the plain latch
    // and the section stayed hidden until a host-forced re-render minutes
    // later). Reading `sectionShown()` inside renderPanel registers the
    // dependency; `openLatch()` both flips and repaints through reactivity.
    const [sectionShown, openLatch] = createSignal(!settings.initiallyHidden)
    // `tuiSidebar.killConfirmSession` (default true): when false, no dialog is
    // shown before a right-click / `/pty-kill` kill+clear — the action just
    // happens (one-way kill, exactly as configured). Read LIVE at every kill
    // site (not snapshotted at setup): a value applied via /pty-config +
    // /pty-refresh (pullSettings → this reassignment) applies without any
    // restart, like filterBySession/groupBy already did.
    const killConfirm = () => settings.killConfirmSession !== false

    // --- Session scoping --------------------------------------------------
    // With the effective filter ON (override, else `tuiSidebar.filterBySession`,
    // default true) the sidebar and the two pickers show only the PTYs spawned
    // by the opencode session currently in view, plus its subagent
    // descendants. The current session id arrives with the sidebar slot's
    // render props; without one nothing is filtered. The runtime
    // /pty-show-all-pty override (showAllEffective above) wins over the
    // config: with it OFF (show all), every session's PTYs are listed and the
    // root headers + dimming mark which session owns what.
    let viewSessionID: string | undefined
    let scopeIds: Set<string> | null = null
    // The viewed session + its descendants, computed on EVERY scope update
    // regardless of the filter state: `scopeIds` (the filter) is null while
    // show-all is active, but `ownerIds` is what the row dimming reads to mark
    // which visible PTYs belong to the current session.
    let ownerIds: Set<string> | null = null

    // The opencode sessions whose PTYs belong to `root`: the session itself plus
    // its descendants. `context.data.session.list()` (walked by parentID) is the
    // precise source; `context.data.session.family()` (root + subtree) is the
    // fallback. When neither is available the scope narrows to `{ root }`.
    function collectScopeIds(root: string): Set<string> {
      const ids = new Set<string>([root])
      try {
        const list = context?.data?.session?.list?.()
        if (Array.isArray(list) && list.length > 0) {
          const children = new Map<string, string[]>()
          for (const entry of list as any[]) {
            const parent = entry?.parentID ?? entry?.parentId
            const id = entry?.id
            if (typeof parent === "string" && parent && typeof id === "string" && id) {
              const bucket = children.get(parent)
              if (bucket) bucket.push(id)
              else children.set(parent, [id])
            }
          }
          const queue = [root]
          while (queue.length > 0) {
            const current = queue.pop() as string
            for (const child of children.get(current) ?? []) {
              if (!ids.has(child)) {
                ids.add(child)
                queue.push(child)
              }
            }
          }
          return ids
        }
      } catch {
        /* fall through to family() */
      }
      try {
        const family = context?.data?.session?.family?.(root)
        if (Array.isArray(family)) {
          for (const entry of family as any[]) {
            const id = typeof entry === "string" ? entry : entry?.id
            if (typeof id === "string" && id) ids.add(id)
          }
        }
      } catch {
        /* session store unavailable; keep the exact-session scope */
      }
      return ids
    }

    // Recomputes the scope for the session now in view. Cheap enough to run on
    // every sidebar render (which the host re-invokes on a tab switch).
    function updateScope(sessionID: unknown) {
      viewSessionID = typeof sessionID === "string" && sessionID ? sessionID : undefined
      // Immediate presence stamp on every tab switch / re-render: ALL open
      // tabs are stamped (not just the one now in view — idle background tabs
      // stay selectable too), and the stamps decay once the TUI stops
      // heartbeating. Also reacts to tab open/close instantly, since the host
      // re-invokes the slot on those.
      tuiInView = viewSessionID
      {
        const ids = tuiSessionTabIds()
        if (ids.length > 0) void ptyPresenceBeat(ids)
        else if (viewSessionID) void ptyPresenceBeat([viewSessionID])
      }
      ownerIds = null
      if (viewSessionID) {
        ownerIds = collectScopeIds(viewSessionID)
      }
      // The filter follows the effective visibility: show-all active
      // (`showAllEffective()` false) -> null (every session listed, rows
      // attributed/dimmed instead). Reading the override signal here keeps
      // the slot's reactive render scope dependent on it, so a toggle
      // re-renders immediately.
      scopeIds = null
      if (showAllEffective() && viewSessionID) {
        scopeIds = ownerIds
      }
    }

    // The sessions shown in the sidebar and offered by the pickers. `scopeIds`
    // is null when filtering is off or no session id is known, in which case
    // every session is shown.
    //
    // CURRENT SESSION FIRST (user-locked 2026-11-12): the viewed opencode
    // session's PTYs always sort to the TOP — in every mode. Ownership mirrors
    // rowDim/groupIsMine: a PTY is ours when its initiator (`parentSessionId`)
    // is the viewed session itself or inside its subtree (`ownerIds`). In
    // grouped views this also puts our root group first, because groups are
    // built in first-seen order. The partition is stable (server arrival order
    // kept within each half) and applied at RENDER time, so a tab switch
    // re-orders instantly — no refresh round-trip.
    const isMineRow = (session: PtySession): boolean => {
      if (!viewSessionID || !session.parentSessionId) return false
      return (
        session.parentSessionId === viewSessionID ||
        (ownerIds?.has(session.parentSessionId) ?? false)
      )
    }
    function sortMineFirst(list: PtySession[]): PtySession[] {
      if (!viewSessionID) return list
      const mine: PtySession[] = []
      const others: PtySession[] = []
      for (const session of list) {
        ;(isMineRow(session) ? mine : others).push(session)
      }
      return [...mine, ...others]
    }
    const visibleSessions = () => {
      const all = sessions()
      const scope = scopeIds
      if (!scope) return sortMineFirst(all)
      return sortMineFirst(
        all.filter((session) =>
          session.parentSessionId ? scope.has(session.parentSessionId) : false,
        ),
      )
    }

    // A flat list of the rows the sidebar draws, from the visible sessions and
    // the `groupBy` mode: plain sessions, plus (when grouping is on) a
    // "subgroup" header (title + `ses_<id>`) and its PTYs per sub-session in
    // "agent" mode. The main/root conversation draws no header — its PTYs render
    // directly at the top level. Mirrors the web UI's `__ptyGroup`.
    //
    // While show-all is active (`showAllActive()`) the compact scoped view is
    // replaced by ATTRIBUTION: a `■ <session title>` + dimmed `ses_<id>` header
    // per root session (only when more than one root group is visible, or the
    // single one is not ours), every row nested one indent deeper, and each
    // session row that does NOT belong to the viewed session dimmed
    // (dim-the-others marking, user-locked 2026-11-12). Legacy PTYs without a
    // root session (`groupSessionId` missing) render flat and unattributed.
    type PanelRow =
      | { kind: "session"; session: PtySession; indent?: number; dim?: boolean }
      | {
          kind: "subgroup"
          id: string
          title: string
          items: PtySession[]
          indent?: number
          dim?: boolean
        }
      | { kind: "rootgroup"; id: string; title: string; items: PtySession[]; dim: boolean }

    // A row's ownership: foreign (= dim) when its PTY was initiated OUTSIDE
    // the viewed session's subtree — its `parentSessionId` (initiator: root
    // session or subagent) not in `ownerIds`. Without a viewed session
    // nothing is foreign (no dimming possible); without an initiator id the
    // row stays neutral (undimmed; it is also filtered out while scoped).
    const rowDim = (session: PtySession): boolean => {
      if (!viewSessionID || !session.parentSessionId) return false
      return !(ownerIds?.has(session.parentSessionId) ?? true)
    }

    function groupRows(list: PtySession[], mode: false | "session" | "agent"): PanelRow[] {
      const attribution = showAllActive()
      const dimRow = (session: PtySession) => (attribution ? rowDim(session) : false)
      if (mode === false) {
        return list.map((session) => ({ kind: "session", session, dim: dimRow(session) }))
      }
      const rows: PanelRow[] = []
      const ungrouped: PtySession[] = []
      const groups: { id: string; title: string; items: PtySession[] }[] = []
      const byKey = new Map<string, { id: string; title: string; items: PtySession[] }>()
      for (const session of list) {
        const key = session.groupSessionId
        if (!key) {
          ungrouped.push(session)
          continue
        }
        let group = byKey.get(key)
        if (!group) {
          group = { id: key, title: session.groupSessionTitle || "", items: [] }
          byKey.set(key, group)
          groups.push(group)
        }
        group.items.push(session)
      }
      // A root group is "ours" when its root session id is the viewed session
      // itself (or — theoretically — inside its subtree). Without a viewed
      // session no group is ours, so headers stay neutral (undimmed).
      const groupIsMine = (id: string) =>
        Boolean(viewSessionID) && (id === viewSessionID || (ownerIds?.has(id) ?? false))
      // Attribution headers: with show-all active and MORE than one root
      // group — or a single root group that is not ours (the viewed session
      // has no PTYs but another session's do) — every root group gets its
      // header. A lone OUR group (show-all on, only our PTYs exist) stays
      // compact; the filter-on scoped view never draws headers.
      const withHeaders =
        attribution &&
        groups.length > 0 &&
        (groups.length > 1 || !groupIsMine(groups[0].id))
      // Everything under a header sits one indent level (2 cells) deeper.
      const rootIndent = withHeaders ? 2 : 0
      for (const session of ungrouped) {
        rows.push({ kind: "session", session, dim: dimRow(session) })
      }
      for (const group of groups) {
        if (withHeaders) {
          rows.push({
            kind: "rootgroup",
            id: group.id,
            title: group.title,
            items: group.items,
            dim: Boolean(viewSessionID) && !groupIsMine(group.id),
          })
        }
        if (mode !== "agent") {
          for (const session of group.items) {
            rows.push({
              kind: "session",
              session,
              indent: rootIndent,
              dim: dimRow(session),
            })
          }
          continue
        }
        const direct: PtySession[] = []
        const subs: { id: string; title: string; items: PtySession[] }[] = []
        const subByKey = new Map<string, { id: string; title: string; items: PtySession[] }>()
        for (const session of group.items) {
          const sid = session.subagentSessionId
          if (!sid) {
            direct.push(session)
            continue
          }
          let sub = subByKey.get(sid)
          if (!sub) {
            sub = { id: sid, title: session.subagentSessionTitle || "", items: [] }
            subByKey.set(sid, sub)
            subs.push(sub)
          }
          sub.items.push(session)
        }
        for (const session of direct) {
          rows.push({
            kind: "session",
            session,
            indent: rootIndent,
            dim: dimRow(session),
          })
        }
        for (const sub of subs) {
          // The block header dims when its PTYs are foreign (dim of the first
          // item — the whole sub-block belongs to one sub-session).
          const subDim = sub.items.length > 0 ? dimRow(sub.items[0]) : false
          rows.push({
            kind: "subgroup",
            id: sub.id,
            title: sub.title,
            items: sub.items,
            indent: rootIndent + 2,
            dim: subDim,
          })
          for (const session of sub.items) {
            rows.push({
              kind: "session",
              session,
              indent: rootIndent + 2,
              dim: dimRow(session),
            })
          }
        }
      }
      return rows
    }

    // Only notify the signal when something that affects the RENDER actually
    // changes: the session list OR the display-affecting settings. A poll that
    // returns an identical list does not re-render (and flicker) the sidebar —
    // but a settings-only change (applied groupBy etc.) must not be swallowed
    // by that guard, so the settings fingerprint rides in the signature.
    let lastSignature: string | null = null
    async function refresh() {
      if (!pty) return
      try {
        const result = await pty.list({})
        const list: PtySession[] = Array.isArray(result?.sessions) ? result.sessions : []
        // The show-all override rides in the fingerprint too: a toggle with an
        // otherwise identical list must still reach setSessions (the poll
        // path has no pullSettings/lastSignature reset around it).
        const signature = JSON.stringify([list, settings, output, showAllOverride()])
        if (signature !== lastSignature) {
          lastSignature = signature
          setSessions(list)
        }
        setError(null)
      } catch (cause: any) {
        setError(cause?.message ?? String(cause))
      }
    }

    // Refresh the moment the server half emits its RPC `changed` event
    // (spawn/exit/kill) instead of waiting for the next poll. Polling stays as
    // a fallback for when the event bridge is unavailable.
    let unsubscribe: (() => void) | null = null
    let unsubscribeSettings: (() => void) | null = null
    try {
      const events: any = pty?.events
      if (events && typeof events.on === "function") {
        unsubscribe = events.on("changed", () => void refresh())
        // Live re-pull whenever the server half reloads its config (the
        // dialog's apply, a save, the pty_refresh/pty_restart tools): the
        // merged settings are fetched, applied to the view and the sidebar
        // re-renders right away — no manual /pty-refresh needed.
        unsubscribeSettings = events.on("settings", () => void applyRefreshedSettings())
      }
    } catch {
      /* event bridge unavailable; the poll below still refreshes */
    }

    void refresh()
    // Self-rescheduling poll: the delay is re-read from `settings.pollMs` on
    // EVERY beat, so an applied/refreshed pollMs applies on the next cycle —
    // a fixed `setInterval(…, settings.pollMs)` would snapshot the period at
    // setup and never follow a config change.
    let timer: ReturnType<typeof setTimeout> | undefined
    function schedulePoll() {
      timer = setTimeout(() => {
        void refresh()
        schedulePoll()
      }, Math.max(250, Number(settings.pollMs) || 1500))
    }
    schedulePoll()

    // Widest PID (or fallback short id) among the visible sessions, so the
    // titles all start in the same column.
    const pidWidth = () => visibleSessions().reduce((max, s) => Math.max(max, pidText(s).length), 0)

    // Clicking a session (or the `no sessions` placeholder) opens the PTY
    // Sessions Web Interface in the default browser (the server half creates it
    // lazily). Passing an id opens it with that session already selected.
    async function openWeb(id?: string) {
      if (!pty) return
      try {
        const result = await pty.openWeb(id ? { id } : {})
        context.ui.toast.show({
          message: String(result?.message || "PTY Sessions Web Interface opened"),
          variant: "success",
        })
      } catch (cause: any) {
        context.ui.toast.show({
          message: `PTY web UI failed: ${cause?.message ?? cause}`,
          variant: "error",
        })
      }
    }

    // --- Right-click removal (kill + clear) -------------------------------
    // "Clear" is upstream's `manager.kill(id, cleanup: true)`: it kills the
    // process if one is still running, wipes the ring buffer, and drops the
    // entry from the list — everything a right-click "remove" reads as (it
    // also works on already-exited sessions), so no new RPC method is needed.
    async function killClear(target: PtySession[]) {
      if (!pty || target.length === 0) return
      try {
        for (const entry of target) await pty.kill({ id: entry.id, cleanup: true })
        await refresh()
        context.ui.toast.show({
          message: `Cleared ${target.length} session${target.length === 1 ? "" : "s"}`,
          variant: "success",
        })
      } catch (cause: any) {
        context.ui.toast.show({
          message: `PTY clear failed: ${cause?.message ?? cause}`,
          variant: "error",
        })
      }
    }

    // True while a process still exists (`killing` = right at the dying edge,
    // where the RPC kill is still the action the user expects) — these get the
    // confirmation dialog before their PTYs are killed + cleared.
    function isAlive(session: PtySession) {
      return session.status === "running" || session.status === "killing"
    }

    // Right-click on one PTY row: running/killing → confirmation dialog in the
    // exact `/pty-kill` style, then kill + clear; already dead → clear directly.
    async function removeSession(session: PtySession) {
      if (isAlive(session) && killConfirm()) {
        const confirmed = await context.ui.dialog.confirm({
          title: "Kill PTY session?",
          message: `${truncateSentence(sessionName(session), CONFIRM_LINE_MAX)}\n\nPID ${session.pid != null ? session.pid : "unavailable"}\nID ${session.id}`,
        })
        if (!confirmed) return
      }
      await killClear([session])
    }

    // One dialog line per session, in exactly the sidebar's row format: status
    // dot + space, then `pidText` (pid, or the short `pty_…` id fallback)
    // left-padded to a dialog-local column, two spaces, then the name — the
    // same pieces the sidebar itself uses (`DOT` + `label(session, pidWidth)`).
    function groupConfirmLine(entry: PtySession, pidWidth: number) {
      const prefix = `${DOT[entry.status ?? ""] ?? "·"} ${pidText(entry).padEnd(pidWidth)}  `
      // The name gets whatever `CONFIRM_LINE_MAX` leaves after the
      // dot/pid prefix, so no row ever wraps in the confirm dialog — a
      // too-long title ends in "…" mid-sentence instead.
      const nameMax = Math.max(8, CONFIRM_LINE_MAX - prefix.length)
      return prefix + truncateSentence(sessionName(entry), nameMax)
    }

    // Right-click on a group header (`▼ PTY` or a `↳ subagent` block): when ANY
    // of the group's PTYs is alive, confirm once for the whole group, then
    // purge every PTY of the group (dead ones included); when all are dead,
    // clear without asking. A `subagentTitle` (a `↳ subgroup` row) gets the
    // sidebar's block header — `↳ <title>` — above the session list; the top
    // `▼ PTY` header passes none and the list stands alone.
    async function removeGroup(items: PtySession[], subagentTitle?: string) {
      if (items.length === 0) return
      if (killConfirm() && items.some(isAlive)) {
        // Widest pid among the group's items, so every name starts in the same
        // column (the sidebar does the same with its global `pidWidth`).
        const pidWidth = items.reduce((max, entry) => Math.max(max, pidText(entry).length), 0)
        const lines = items.map((entry) => groupConfirmLine(entry, pidWidth))
        const shown = lines.slice(0, 8)
        if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`)
        const confirmed = await context.ui.dialog.confirm({
          title: `Kill ${items.length} PTY session${items.length === 1 ? "" : "s"}?`,
          message:
            (subagentTitle !== undefined
              ? `↳ ${truncateSentence(subagentTitle || "subagent", CONFIRM_LINE_MAX - 2)}\n\n`
              : "") +
            shown.join("\n"),
        })
        if (!confirmed) return
      }
      await killClear(items)
    }

    // NOTE: this is a plain render helper, not a component. The slot renderer
    // invokes it directly so the reads below happen in that reactive scope and
    // are tracked; rendering it as a component would run the body untracked.
    const renderPanel = () => {
      // REACTIVE LIVENESS: read the session signal BEFORE every early return —
      // the slot render only re-runs when a dependency read in THIS scope
      // changes; a hidden path returning early without any signal read makes
      // the whole section permanently stale (invisible to latch flips,
      // settings updates and poll setSessions writes alike).
      const visible = visibleSessions()
      // `tuiSidebar.enabled` — PURE SHOW/HIDE GATE, consulted LIVE on every
      // render (hot-appliable: apply/save push -> pullSettings -> refresh
      // fingerprint change -> this re-render; no restart in either direction).
      // Hidden renders exactly what the initiallyHidden latch does below:
      // nothing. Everything (RPC, polls, commands) keeps loading regardless.
      if (settings.enabled === false) return <box flexDirection="column" width="100%" />
      // `tuiSidebar.initiallyHidden` latch (SIGNAL, see above): while it is
      // closed and no PTY exists yet, render an empty section; the first
      // visible session opens it and the section stays visible from then on.
      if (!sectionShown()) {
        if (visible.length === 0) return <box flexDirection="column" width="100%" />
        openLatch(true)
      }
      const hidden = sessions().length - visible.length
      const mode = settings.groupBy ?? "agent"
      const rows = groupRows(visible, mode)
      const isCollapsed = collapsed()
      return (
        <box flexDirection="column" width="100%">
          {/* Todos-list style header: a filled triangle + the bold title. Left
              click folds/unfolds the session list; right click opens the group
              kill dialog for every PTY currently visible in this sidebar. The
              dimmed count appears only while folded. */}
          <text
            truncate
            onMouseUp={(e: any) => {
              if (e?.button === 2) void removeGroup(visible)
              else setCollapsed(!isCollapsed)
            }}
          >
            <b>{`${isCollapsed ? "▶" : "▼"} PTY`}</b>
            <Show when={isCollapsed}>
              <span style={{ fg: "#808080" }}>
                {` (${visible.length} session${visible.length === 1 ? "" : "s"})`}
              </span>
            </Show>
          </text>
          <Show when={!pty}>
            <text fg="#ff6b6b" truncate>
              ⚠ RPC unavailable
            </text>
          </Show>
          <Show when={error()}>
            <text fg="#ff6b6b" truncate>
              ⚠ {error()}
            </text>
          </Show>
          {/* With no PTYs the only clickable line is this one — clicking it
              opens the PTY Sessions Web Interface. Hidden while folded. */}
          <Show when={!isCollapsed && pty && !error() && visible.length === 0}>
            <text fg="#808080" onMouseUp={(e: any) => { if (e?.button === 0) void openWeb() }}>
              no sessions
            </text>
          </Show>
          <Show when={!isCollapsed}>
            <For each={rows}>
              {(row) => {
                if (row.kind === "rootgroup") {
                  // Root-session attribution header (show-all only):
                  // `■ <session title>` + the dimmed `ses_<id>` beneath. The
                  // SQUARE marks these as attribution labels — unlike the main
                  // collapsible `▼ PTY` header they are NOT fold toggles
                  // (user-locked 2026-11-12: no arrow). Foreign groups render
                  // dimmed (dim-the-others marking); ours keep full
                  // brightness. Right-click purges the whole root group.
                  return (
                    <box
                      flexDirection="column"
                      paddingTop={1}
                      onMouseUp={(e: any) => {
                        if (e?.button === 2) void removeGroup(row.items)
                      }}
                    >
                      <text fg={row.dim ? "#6e7681" : "#c9d1d9"} truncate>
                        <b>{`■ ${row.title || "session"}`}</b>
                      </text>
                      <box paddingLeft={2}>
                        <text fg="#6e7681" truncate>
                          {row.id}
                        </text>
                      </box>
                    </box>
                  )
                }
                if (row.kind === "subgroup") {
                  // Sub-agent block: `↳ <title>` with its `ses_<id>` one indent
                  // deeper, then its PTYs (no blank line between). `paddingTop`
                  // gives the blank that separates the block from the main list
                  // (or the previous sub-agent). Right-click purges the whole
                  // block (see removeGroup — confirm first when any PTY runs).
                  // Under a root header the block sits one indent deeper
                  // (`row.indent`); a foreign block dims with its PTYs.
                  return (
                    <box
                      flexDirection="column"
                      paddingTop={1}
                      paddingLeft={row.indent ?? 2}
                      onMouseUp={(e: any) => {
                        if (e?.button === 2) void removeGroup(row.items, row.title)
                      }}
                    >
                      <text fg={row.dim ? "#6e7681" : "#c9d1d9"} truncate>
                        {`↳ ${row.title || "subagent"}`}
                      </text>
                      <box paddingLeft={2}>
                        <text fg="#6e7681" truncate>
                          {row.id}
                        </text>
                      </box>
                    </box>
                  )
                }
                const session = row.session
                const indent = " ".repeat(row.indent ?? 0)
                return (
                  <text
                    truncate
                    wrapMode="none"
                    onMouseUp={(e: any) => {
                      // Left click opens the web UI; right click kills + clears
                      // the session (removeSession: confirm when it still runs).
                      if (e?.button === 2) void removeSession(session)
                      else if (e?.button === 0) void openWeb(session.id)
                    }}
                  >
                    <span style={{ fg: STATUS_COLOR[session.status ?? ""] ?? "#8b949e" }}>
                      {`${indent}${DOT[session.status ?? ""] ?? "·"} `}
                    </span>
                    {row.dim ? (
                      // Dim-the-others marking: a foreign session's name text
                      // is muted; the status dot keeps its status color so the
                      // live/dead state stays readable at a glance.
                      <span style={{ fg: "#6e7681" }}>{label(session, pidWidth())}</span>
                    ) : (
                      <span>{label(session, pidWidth())}</span>
                    )}
                  </text>
                )
              }}
            </For>
            <Show when={hidden > 0}>
              <text fg="#808080" truncate>
                {`+${hidden} other session(s)`}
              </text>
            </Show>
          </Show>
        </box>
      )
    }

    // Call the helper directly (not `<Panel />`). OpenTUI's Solid JSX compiler
    // skips files under node_modules, so a read deferred into a component body
    // is evaluated once — a snapshot — and the sidebar would only refresh when
    // the host re-invoked this render (i.e. on a tab switch). Reading
    // sessions()/error() here makes the slot re-render whenever they change.
    // The slot hands us the session in view, which drives the scope.
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props: any) => {
        // v2 passes `sessionID`; tolerate the legacy `session_id` spelling too.
        updateScope(props?.sessionID ?? props?.session_id)
        return renderPanel()
      },
    })

    async function pick(dialogTitle = "PTY sessions"): Promise<string | undefined> {
      const list = visibleSessions()
      if (!list.length) {
        context.ui.toast.show({ message: "No PTY sessions" })
        return undefined
      }
      // Picker rows: `<dot> <pid>  <name>` with a status-colored dot, like the
      // sidebar and the group-kill dialog: alive (running/killing) = filled
      // `●`, dead (exited/killed) = empty `○`, unknown = muted `·`.
      // The dot is passed as the host's `gutter` MARKER FIELD, not as a
      // `titleView` element: `dialog.select` calls `gutter` at row-render time
      // inside its own Solid scope, so the <span> is created where a renderer
      // context exists. A JSX element built up here — inside a command
      // handler with no reactive owner/RendererContext — throws during element
      // construction, the promise rejects silently and the dialog never opens
      // (the exact wall the config-overlay attempts hit). The plain `title`
      // string drives the dialog's fuzzy search; `description` is the COMMAND
      // only (the dot already says the status). Lines truncate with a
      // right-side ellipsis at a responsive cap, so the dialog auto-sizes wide.
      const pickerCap = Math.min(104, (Number(context.renderer?.width) || 120) - 12)
      // Widen the picker: built-in dialogs open at their default "medium"
      // size (60 cols) — same quirk `dialog.show` has, which the config
      // dialog fixes by re-applying the size right after opening. `select`
      // shows the dialog synchronously and only the PROMISE waits for the
      // user, so `set` must run after the call but before the await. xlarge
      // = 116 cols (the picker's rows are cut at `pickerCap` = terminal
      // width - 12, which always fits inside 116's message width).
      try {
        const picking = context.ui.dialog.select({
        title: dialogTitle,
        options: (() => {
          const pidWidth = list.reduce((max, entry) => Math.max(max, pidText(entry).length), 0)
          return list.map((session) => {
            const status = session.status ?? ""
            const alive = status === "running" || status === "killing"
            const dot = status === "" ? "·" : alive ? "●" : "○"
            const color = STATUS_COLOR[status] ?? "#8b949e"
            // Attribution (show-all active only): a foreign session's row
            // names its owning opencode session, so the pickers teach the
            // same "which is whose" the sidebar does (dim-the-others marking
            // is not available in a plain title string — the tag carries it).
            let ownerTag = ""
            if (
              showAllActive() &&
              viewSessionID &&
              session.parentSessionId &&
              !(ownerIds?.has(session.parentSessionId) ?? true)
            ) {
              const root = session.groupSessionTitle || session.rootSessionId
              if (root) ownerTag = `  [${root}]`
            }
            // `searchText` is the third fuzzysort key in the host's select
            // (`title` -> `category` -> `searchText`), so typing part of the
            // command line matches the row too — not just its name.
            const searchText =
              `${session.command ?? ""} ${(session.args ?? []).join(" ")}`.trim()
            // Row content runs 2 cells left of the dialog's "Search" column,
            // so indent EVERYTHING by 2: the margin dot glyph (see below) and
            // the title text land dotted under the "S", with a blank cell
            // between the dot and the pid column.
            const rowWidth = Math.max(8, pickerCap - 2)
            return {
              // The host renders this at row time, inside its scope. It drops
              // the element into a bare <box>, so it must be a <text>
              // renderable — a <span> is only valid inside a <text> and would
              // crash with "Orphan text error".
              //
              // `margin` (NOT `gutter`): a gutter RESERVES its marker cells
              // and shifts the whole title column left — every row ended up
              // 2 cells left of the dialog's header/footer alignment. A
              // `margin` floats absolutely in front of the row while the
              // title keeps the standard column. The absolute position is
              // the host's fixed marker slot, 2 cells left of the search
              // input's "S" — pad the glyph itself so the dot optically
              // lines up with it.
              margin: () => <text fg={color}>{`  ${dot}`}</text>,
              title: "  " +
                truncateSentence(
                  `${pidText(session).padEnd(pidWidth)}  ${sessionName(session)}${ownerTag}`,
                  rowWidth,
                ),
              value: session.id,
              searchText,
              description: truncateSentence(searchText, pickerCap),
            }
          })
        })(),
      })
      context.ui.dialog.set?.({ size: "xlarge", centered: true })
      return await picking
      } catch (cause: any) {
        // Surface the failure — a silent rejection looks like "nothing happens".
        dbg(`pick failed: ${cause?.stack ?? cause}`)
        context.ui.toast.show({
          message: `PTY picker error: ${cause?.message ?? cause}`,
          variant: "error",
        })
        return undefined
      }
    }

    // Posts a user-visible message into the session's chat WITHOUT triggering
    // the agent loop — the live v2 contract is
    // POST /api/session/{sessionID}/prompt with `{ text, resume: false }`
    // (verified live with a throwaway session: the message lands in the
    // session inbox, delivery "steer", no agent run scheduled). This is the
    // same channel the removed core-layer prompt commands used via
    // `ctx.session.prompt`; the keymap commands use it so
    // /pty-show-server-url shows the URL in the chat again instead of only
    // in a toast. The generated client's argument shape drifted across
    // opencode builds, so try the known shapes in order — hey-api's
    // generated methods default to ThrowOnError=false and REPORT errors on
    // the returned result instead of throwing, so each attempt is judged by
    // `result.error`; a thrown error (strict variant / missing path param)
    // just moves to the next shape.
    async function postSessionChat(
      sessionID: string | undefined,
      text: string,
    ): Promise<boolean> {
      if (!sessionID || !text) return false
      const prompt = (context as any).client?.session?.prompt
      if (typeof prompt !== "function") return false
      const attempts: any[] = [
        // Current v2 contract, classic hey-api convention (path + body).
        { path: { sessionID }, body: { text, resume: false } },
        // Same contract with a flattened argument shape.
        { sessionID, text, resume: false },
        // Older generated contract: /session/{sessionID}/message with parts.
        { path: { sessionID }, body: { parts: [{ type: "text", text }] } },
        // Oldest generated contract: /session/{id}/message.
        { path: { id: sessionID }, body: { parts: [{ type: "text", text }] } },
      ]
      for (const attempt of attempts) {
        try {
          const result = await prompt(attempt)
          if (result && typeof result === "object" && result.error) continue
          return true
        } catch {
          // Next shape.
        }
      }
      return false
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-pty.sidebar.output",
          title: "Open a selection for which pty to show the output",
          group: "PTY",
          palette: true,
          slash: { name: "pty-output" },
          run: async () => {
            const id = await pick("Select PTY session to view")
            if (!id) return
            // `read` returns only the buffer + terminal size, so take the
            // process id from the session list for the dialog title.
            const session = sessions().find((entry) => entry.id === id)
            try {
              const result = await pty.read({ id })
              // Show the tail, then render ANSI/control characters as inert
              // text (or strip them, per `output.dialog.stripAnsiSequences`).
              const body =
                sanitizeOutputText(tail(result?.text, settings.maxLines), output.dialog) ||
                "(no output)"
              // Centered custom dialog with a scrollbox body (a plain alert has
              // no scrollbar). Fall back to the alert if this runtime does not
              // expose custom dialogs.
              const dialog: any = context.ui.dialog
              if (typeof dialog?.show === "function") {
                // The frame only accepts three width presets (medium 60 /
                // large 88 / xlarge 116), so pick the smallest that fits the
                // PTY width capped at 80% of the terminal - never below medium,
                // which is the alert's width.
                const termW = Number(context.renderer?.width) || 80
                const termH = Number(context.renderer?.height) || 24
                const targetW = Math.min(result?.cols ?? Infinity, Math.floor(termW * 0.8))
                const size = targetW <= 60 ? "medium" : targetW <= 88 ? "large" : "xlarge"
                // The frame has no height of its own, so the scrollbox height is
                // ours: the PTY's rows, capped at 80% of the terminal so the
                // centered dialog always fits. CHROME is everything the frame
                // adds around the scrollbox (frame top pad + title + the two
                // gaps + the close button row + its bottom pad), and the height is
                // floored so the dialog never shrinks below an alert-sized box.
                const CHROME = 6
                const cap = Math.max(3, Math.floor(termH * 0.8) - CHROME)
                const height = Math.min(Math.max(result?.rows ?? cap, 3), cap)
                dialog.show(() => (
                  <OutputViewer
                    context={context}
                    id={id}
                    pid={session?.pid}
                    text={body}
                    size={size}
                    height={height}
                  />
                ))
              } else {
                await dialog.alert({ title: `PTY ${session?.pid ?? shortId(id)}`, message: body })
              }
            } catch (cause: any) {
              context.ui.toast.show({
                message: `PTY read failed: ${cause?.message ?? cause}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-pty.sidebar.kill",
          title: "Open a selection for which pty to kill",
          group: "PTY",
          palette: true,
          slash: { name: "pty-kill" },
          run: async () => {
            const id = await pick("Select PTY session to kill")
            if (!id) return
            // `pick` only surfaces the session id, so look the session up to
            // name it exactly as its list entry / the web UI does
            // (`sessionName`), plus its process id and id.
            const session = sessions().find((entry) => entry.id === id)
            const name = session ? sessionName(session) : id
            // `killConfirmSession` may skip the dialog entirely (one-way kill).
            const confirmed = killConfirm()
              ? await context.ui.dialog.confirm({
                  title: "Kill PTY session?",
                  message: `${truncateSentence(name, CONFIRM_LINE_MAX)}\n\nPID ${session?.pid != null ? session.pid : "unavailable"}\nID ${id}`,
                })
              : true
            if (!confirmed) return
            try {
              await pty.kill({ id, cleanup: true })
              await refresh()
              context.ui.toast.show({ message: `Killed ${shortId(id)}`, variant: "success" })
            } catch (cause: any) {
              context.ui.toast.show({
                message: `PTY kill failed: ${cause?.message ?? cause}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-pty.sidebar.refresh",
          title: "Refresh PTY in the TUI sidebar",
          group: "PTY",
          palette: true,
          slash: { name: "pty-refresh" },
          // Refresh both halves: the PTY list and the plugin settings (the
          // server half may have hot-reloaded config, e.g. after a
          // /pty-config save or a manual config-file edit) — including the
          // immediate re-render both paths need now (applyRefreshedSettings).
          run: async () => {
            await applyRefreshedSettings()
          },
        },
        {
          id: "opencode-pty.sidebar.showall",
          title: "Toggle showing other sessions' PTYs (/pty-show-all-pty [on|off])",
          group: "PTY",
          palette: true,
          slash: { name: "pty-show-all-pty", arguments: true },
          // Runtime-only visibility override (user-locked design): NO ARG =
          // TOGGLE (direct); `on`/`off` set it explicitly; `read` reports the
          // current state + which layer decides it. `slash.arguments: true`
          // (official TUI plugin API) passes the typed text after the command
          // to run(), so the keyword CAN be added after selecting the command;
          // parsing stays best-effort for older builds. The state lives in the
          // server half (shared with the pty_show_all_pty tool, reached
          // through the `showAll` RPC) and is NEVER written to config — the
          // toast says so.
          run: async (args: any) => {
            let word: string | null = null
            try {
              const raw =
                typeof args === "string"
                  ? args
                  : Array.isArray(args) && args.length > 0
                    ? String(args[0])
                    : args && typeof args === "object"
                      ? String(args.args ?? args.input ?? args.text ?? "")
                      : ""
              const first = String(raw ?? "").trim().split(/\s+/).filter(Boolean)[0]
              if (first) word = first.toLowerCase()
            } catch {
              /* keep null -> toggle */
            }
            if (!pty) {
              context.ui.toast.show({ message: "PTY RPC unavailable", variant: "error" })
              return
            }
            try {
              let result: any
              if (word === "on" || word === "off") {
                result = await pty.showAll({ value: word === "on" })
              } else if (word === "read") {
                result = await pty.showAll({})
              } else {
                // BARE invocation = direct toggle (user-locked, reverted from
                // a picker after `slash.arguments: true` proved the typed-arg
                // path works: menu selection now fills the input so the
                // keyword CAN be added — the picker was only the defensive
                // fallback for the case where args never reached run()).
                result = await pty.showAll({ toggle: true })
              }
              // Reflect locally right away (the server half emitted its
              // `settings` event on a change, but this TUI need not wait for
              // that roundtrip — and the pull also re-syncs the override
              // mirror this render scope reads).
              await applyRefreshedSettings()
              const state = result?.effective
                ? "on (showing every session's PTYs)"
                : "off (current session only)"
              const source =
                result?.source === "override"
                  ? "runtime override, config unchanged"
                  : "following tuiSidebar.filterBySession"
              context.ui.toast.show({
                message: `Show all PTYs: ${state} — ${source}`,
                variant: "success",
              })
            } catch (cause: any) {
              context.ui.toast.show({
                message: `pty-show-all-pty failed: ${cause?.message ?? cause}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-pty.sidebar.openweb",
          title: "Open the PTY Sessions Web Interface in your browser",
          group: "PTY",
          palette: true,
          slash: { name: "pty-open-background-spy" },
          // Direct-executing TUI counterpart of the core command layer's
          // prompt command: the newer host fills the prompt-command input and
          // waits for Enter, but a keymap-layer slash command runs on
          // selection. Opens the browser silently (no prompt into the
          // conversation) + toasts the URL — the same path a sidebar row's
          // left click uses.
          run: async () => {
            await openWeb()
          },
        },
        {
          id: "opencode-pty.sidebar.serverurl",
          title: "Show the PTY Sessions Web Interface URL",
          group: "PTY",
          palette: true,
          slash: { name: "pty-show-server-url" },
          // URL-only: ensures/starts the web server (so the URL is real) but
          // never launches a browser (RPC `openWeb` with `open: false`). The
          // URL is ALSO posted into the session's chat via postSessionChat —
          // the behavior of the removed core-layer command (`resume: false`,
          // user-visible without continuing the agent loop); a toast alone
          // proved too easy to miss (user report 2026-11-12). Without a
          // session in view (home screen) it degrades to the toast only.
          run: async () => {
            if (!pty) {
              context.ui.toast.show({ message: "PTY RPC unavailable", variant: "error" })
              return
            }
            try {
              const result: any = await pty.openWeb({ open: false })
              const url = String(result?.url || result?.message || "PTY web UI URL unavailable")
              const posted = await postSessionChat(
                viewSessionID,
                `PTY Sessions Web Interface URL: ${url}`,
              )
              context.ui.toast.show({
                message: posted
                  ? url
                  : `${url}${viewSessionID ? "" : " (no session in view for the chat copy)"}`,
                variant: "success",
              })
            } catch (cause: any) {
              context.ui.toast.show({
                message: `pty-show-server-url failed: ${cause?.message ?? cause}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "opencode-pty.sidebar.config",
          title: "Open configuration dialog",
          group: "PTY",
          palette: true,
          slash: { name: "pty-config" },
          run: async () => {
            // LOCALLY computed payload for THIS CLI's location — no RPC. The
            // rpc route resolves registrations against the server-root scope
            // (see shared.js PtyRpc), so an RPC configGet could only ever
            // return the root location's layers. `context.options` is the
            // host's `plugins[].options` (mostly empty for a CLI plugin).
            const dir = context?.location?.directory
            let data: ConfigPayload
            try {
              data = configGetPayload(dir, { override: context?.options ?? {} }) as ConfigPayload
            } catch (cause: any) {
              context.ui.toast.show({
                message: `PTY config failed: ${cause?.message ?? cause}`,
                variant: "error",
              })
              return
            }
            if (!data?.settings?.length) {
              context.ui.toast.show({
                message: "PTY config unavailable (config schema empty)",
              })
              return
            }
            // REPLACE-REBUILD dialog: the module-level owner remounts the whole
            // dialog on every mutation (host `dialog.replace` semantics) — see
            // the architecture comment on ConfigDialog.
            openConfigDialog(
              context,
              data,
              // Save: local file write, comments preserved. Then best-effort
              // parity with the pre-local UX: overlay the just-saved values on
              // the running instance (`configApply` = `live.runtimeOverrides`
              // + reload, exactly what a server-side save used to do). The
              // overlay mirrors the file and dies with the process, so it can
              // never diverge from what was written. It lands on the
              // server-root instance — the one whose merged settings the
              // sidebar's `settings` fetch receives — so live keys
              // (tuiSidebar/output) take effect in the sidebar view without
              // /restart; tool-side values for non-root locations stay
              // restart-gated.
              async (changes, target) => {
                const result: any = configSetLocal(dir, { changes, target })
                if (result?.ok && pty) {
                  try {
                    await pty.configApply({ changes })
                  } catch {
                    /* the file save already succeeded; the overlay is optional */
                  }
                }
                return result
              },
              // Apply-only: runtime overlay for the server-installed instance.
              // Optional — the dialog still opens/saves without an RPC bridge
              // (the payload above is computed locally, pty may be null).
              (changes) =>
                pty
                  ? pty.configApply({ changes })
                  : Promise.resolve({ ok: false, error: "RPC not connected" }),
              // Post-save/apply hook. User-locked latch UX: when
              // `tuiSidebar.enabled` was explicitly touched through the dialog,
              // open the `ptySectionShown` latch immediately — the section then
              // becomes visible right away (even with ZERO sessions), which is
              // the "I turned it on -> show it" expectation. Hiding still
              // belongs to the live `settings.enabled === false` gate in
              // renderPanel (an applied false hides instantly regardless of
              // the latch), and the default clutter behavior (initiallyHidden
              // hides until the first PTY for everyone who never touches the
              // dialog) is unchanged. Persisted-show nuance: the latch is a
              // TUI-lifetime var — a save of enabled=true comes back on the
              // next /restart only when initiallyHidden=false too (its
              // documented full-tier behavior).
              async (changes) => {
                if (changes?.some((c) => c.path === "tuiSidebar.enabled")) {
                  openLatch(true)
                  dbg("enabled touched via dialog -> ptySectionShown latch OPEN")
                  // FORCED REPAINT (bypasses refresh's fingerprint guard): the
                  // signal flip alone repaints only when the render scope
                  // re-runs, and refresh() refuses setSessions on an unchanged
                  // fingerprint — with zero sessions one never changes, so
                  // without this the flip is invisible until a host-forced
                  // re-render (live-proven). A fresh array reference notifies
                  // the sessions signal; every render path reads it now.
                  lastSignature = null
                  setSessions([...sessions()])
                }
                await applyRefreshedSettings()
              },
              // Post-save/apply restart offer (only when schema `restart`
              // keys were touched): PtyRpc.restart → ptyRestartStack on the
              // server half. Without the RPC bridge the offer never appears.
              (scope) =>
                pty
                  ? pty.restart({ scope: scope === "kill" ? "kill" : "soft" })
                  : Promise.resolve({ ok: false, error: "RPC not connected" }),
            )
          },
        },
      ],
    }))

    return () => {
      clearTimeout(timer)
      if (typeof unsubscribe === "function") unsubscribe()
      if (typeof unsubscribeSettings === "function") unsubscribeSettings()
      if (typeof disposeSlot === "function") disposeSlot()
    }
  },
})
