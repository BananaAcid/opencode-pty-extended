# AGENTS.md — opencode-pty-extended

Working notes for agents editing this plugin. This file is the **plan + decisions**
record; the complete **progress log** lives in [`CHANGES.md`](CHANGES.md).
Keep both up to date as implementation proceeds.

---

## What this is

`opencode-pty-extended` is a **wrapper plugin** for OpenCode v2 that makes the
published `opencode-pty` package (v0.4.0) usable and extends it. It does **not**
edit `node_modules/opencode-pty`; everything is done by wrapping the package's
modules at runtime from this directory.

- Loaded as an OpenCode v2 **server plugin** via `gist:e0374ff83a2d774d4cf8d76d54ea10da`
  (declared in `~/.config/opencode/opencode.jsonc`).
- OpenCode clones the gist into an npm git-cache dir; the current directory **is**
  that checkout. Edits here are the loaded copy, but are overwritten when OpenCode
  reinstalls the gist. The **gist is the source of truth** — changes here must be
  synced back to the gist by the user.
- `tui.tsx` is the separate **CLI plugin** half (OpenTUI sidebar), loaded from the
  same package.

### Files

Workdir:
C:\Users\nabil\.cache\opencode\npm\git-e0374ff83a2d774d4cf8d76d54ea10da-03db31d52c8e\<date-time>\node_modules\opencode-pty-extended

| File | Role |
|---|---|
| `index.js` | Server half: tool/command registration, web-UI patches, RPC bridge, exit notifier, grouping. |
| `shared.js` | Shared utils: config loading/merging, `PtyRpc` definition, output rendering, `resolveTuiSidebar`, `resolveOutput`. |
| `tui.tsx` | CLI half: sidebar slot, `/pty-output` `/pty-kill` `/pty-refresh`, pickers. |
| `opencode-pty-extended.jsonc` | Shipped reference config (documents every option). |
| `Readme.md` | User-facing description. |
| `package.json` | `opencode-pty-extended` v1.16.92; deps `opencode-pty@0.4.0`, `@opentui/solid`. |
| `CHANGES.md` | The complete progress log (all `[implemented]`/`[bugfix]`/`[decision]`/`[verified]` history), moved out of this file. Append new entries there. |

---

## Verified OpenCode v2 facts (drive the design)

- **Tool execute context** (`Tool.Context`) = `{ sessionID, agent, messageID, callID, progress }`
  (promise tools also get `signal`). **There is no `directory`/`worktree` on it.**
  `sessionID` is the session *running* the tool; `task.ts` creates a subagent as a
  **child session** (`parentID: ctx.sessionID`), so **inside a subagent
  `context.sessionID` is the subagent session**.
- **Session hierarchy**: `ctx.data.session.root(id)` / `family(id)` / `list()`
  (`list()` entries carry `parentID`). `ctx.location.directory` = the plugin
  instance's project directory. V2 `Session.Info` has `location: Location.Ref`
  (no `directory`).
- **`ctx.session.prompt({ sessionID, text })`** sends a prompt to a specific
  session; `ctx.session.synthetic({ sessionID, text, resume })` injects a
  synthetic message. The exit notifier uses `prompt`.
- **Upstream `opencode-pty` v0.4.0 internals**:
  - `tools/spawn.js`: sets `parentSessionId: ctx.sessionID`, `parentAgent: ctx.agent`,
    passes `workdir: args.workdir` straight through (undefined if omitted), and
    **never resolves relative paths**.
  - `session-lifecycle.js` `createSessionObject`: `workdir = opts.workdir ?? process.cwd()`.
  - `manager.js`: `spawn(opts)` → lifecycle; on exit calls the active notifier when
    `session.notifyOnExit`.
  - `notification-manager.js`: `buildExitNotification` emits `<pty_exited>` with
    ID / Description / Exit Code / TimeoutSeconds / Timed Out / Output Lines /
    Last Line (no session ids).
  - `v2/index.js` `setup`: `createV2Adapter()` (no options) → `installHostAdapter`
    sets neither notifier nor permissions, so **`checkCommandPermission` /
    `checkWorkdirPermission` are no-ops** (safe to always set a workdir).
  - `toInfo()` drops `parentSessionId`/`parentAgent`; the raw session keeps them
    (reached via `manager.lifecycleManager.getSession(id)`).
- **PR #72** (`shekohex/opencode-pty`) is the reference for the workdir fix:
  `resolve(ctx.directory ?? '', args.workdir ?? '')`, with `directory` injected
  from the plugin's `ctx.location.directory`.

### Key `index.js` symbols (line numbers drift — search by name)

- `BUILTIN_OPTIONS` (~162), `BUILTIN_WEBFONT` (~173), `BUILTIN_WEBUI` (~180)
- `ZERO_MEANS_UNSET` / `buildArgDefaults` (~220)
- `applyGroupBySessionToJs` (~664), `applyGroupBySessionToHtml` (~710)
- `PATCH_VERSION` (~752)
- `installCreateServerPatch` (~758)
- `installManagerResizeAndCsi` (~959)
- `GROUP_WEB_API_PARENT` (~1051), `groupCacheGlobal` (~1053), `rootSessionId` (~1063)
- `installManagerGroupBySession` (~1087)
- `ensurePtyWebServer` (~1188), `registerPtyRpc` (~1241) (RPC `list` ~1258, `settings` ~1257)
- `installSidebarChangeNotifier` (~1310), `loadPackage` (~1370)
- `buildInputSchema` (~1413), `withPtyListArgs` (~1437), `ptyListScopeIds` (~1459)
- `formatCompactSession` (~1507), `formatPtyList` (~1524)
- `registerPtyTools` (~1583), `registerPtyUrlTool` (~1647), `registerPtyCommands` (~1699)
- `installExitNotifier` (~1783), `Plugin.setup` (~1814), exports (~1902)

### Key `shared.js` symbols

- `deepMerge` (~43), `BUILTIN_TUI_SIDEBAR` (~61), `loadUserConfig` (~120),
  `resolveTuiSidebar` (~156), `resolveOutput` (~193).

### Key `tui.tsx` symbols

- RPC settings fetch + `resolveTuiSidebar` (~265–285)
- `collectScopeIds` (~306), `updateScope` (~352), `visibleSessions` (~363)
- `renderPanel` (~433), sidebar slot (~481).

---

## Decisions (locked)

1. **PTY lineage**: a spawned PTY stores **both** the immediate initiator
   (subagent, already `parentSessionId`) **and** the root session
   (`rootSessionId`). Both are exposed in listings.
2. **Grouping**: replace `webUi.groupBySession` (boolean) with
   `webUi.groupBy`: `false | "session" | "agent"`. Add `tuiSidebar.groupBy`
   (same enum). `"agent"` = group by root session, then sub-group by sub-session.
3. **Grouping default**: `.groupBy` defaults to **`"agent"`** for *both*
   `webUi.groupBy` and `tuiSidebar.groupBy` (changes current out-of-the-box
   behavior).
4. **Exit notification target**: add a `pty_spawn` tool argument `notifyTarget`
   (`"spawner" | "root" | "both"`, default `"spawner"`) plus config
   `notify.target`. The tool-arg description must **prefer `"spawner"`** (so a
   subagent that triggered the spawn gets the info). Config default is overridable
   via `argDefaults.pty_spawn.notifyTarget`; an explicit tool arg always wins.
5. **Notification content**: both `<pty_spawned>` and `<pty_exited>` include the
   initiator session id and the root session id (and initiator agent).
6. **Workdir**: resolve relative `workdir` against the session project and default
   a missing `workdir` to the project dir (mirror PR #72), using
   `context.directory` if it is a string, else `ctx.location.directory`.
7. **Back-compat**: a boolean `groupBySession: true|false` in existing config maps
   to `"session"`/`false`; it overrides the new default.
8. **Show-all runtime override** (2026-11-12): the TUI sidebar's "show every
   session's PTYs" visibility is a RUNTIME-ONLY override shared by the
   `/pty-show-all-pty` slash command (no arg = toggle) and the
   `pty_show_all_pty` tool (`read|on|off`, default read). One shared state in
   the server half (globalThis), reached through the `showAll` RPC; never
   written to config; reset to null when `tuiSidebar.filterBySession` changes
   via config apply/save (funnel: `reloadLiveConfig`). While show-all is
   active the sidebar attributes PTYs per root session (`■ <title>` (square,
   NOT the collapsible `▼` — these headers are attribution labels, not fold
   toggles; user-locked 2026-11-12) + dimmed `ses_<id>` headers when >1 root
   group or a lone foreign one) and marks
   foreign rows by DIMMING their names (user-locked: dim-the-others, no
   marker glyph); pickers follow the toggle and tag foreign rows
   `[<owning session>]`. TUI-only change → no PATCH_VERSION bump.

9. **Current session first in the TUI** (2026-11-12): the viewed opencode
   session's PTYs always sort to the TOP of the sidebar, in every mode.
   Ownership test = the same as rowDim/groupIsMine (initiator
   `parentSessionId` = viewed session or inside its subtree via `ownerIds`).
   Stable partition at RENDER time (`sortMineFirst` inside
   `visibleSessions()`), so tab switches re-order instantly without a
   refresh; grouped views inherit it (groups build in first-seen order, so
   our root group/`■` header comes first). Pickers follow automatically.

---

## Plan (by todo)

### Todo 1 — store + expose initiator and root session ids

- `rootSessionId(ctx, id)`: prefer `ctx.data.session.root(id)`; fall back to the
  existing `list()` `parentID` walk; finally `id`.
- New `installManagerSessionLineage(manager, ctx, webUi)` (called from
  `Plugin.setup`, after `installManagerGroupBySession`): wrap `manager.spawn`
  **once**; after `origSpawn(opts)`, read `manager.lifecycleManager.getSession(id)`
  and stamp `rootSessionId = rootSessionId(ctx, raw.parentSessionId)` and
  `notifyTarget` (per-spawn), skipping `GROUP_WEB_API_PARENT`.
- Decorated `manager.list()` and RPC `list` rows gain:
  `initiatorSessionId` (= `parentSessionId`), `initiatorAgent` (= `parentAgent`),
  `rootSessionId`, `isSubagent` (`root !== initiator`), and — only when
  `groupBy === "agent"` — `subagentSessionId` / `subagentSessionTitle`.
  `groupSessionId` / `groupSessionTitle` stay the root.
- Extend the title cache (`groupCacheGlobal`) to also resolve the **subagent**
  (immediate parent) title.
- `formatPtyList`: add an `Initiator`/`Root` line per session.
- Web UI: `__ptyGroup` becomes 2-level — nest subagent subgroups under the root
  when rows carry `subagentSessionId`; unchanged when they don't.

### Todo 2 — ids in notifications

- `<pty_spawned>` (built by the wrapper around upstream's result): add
  `Initiator Session`, `Root Session`, `Initiator Agent`.
- `<pty_exited>`: subclass `NotificationManager`, override
  `buildExitNotification` to insert the same three lines before `</pty_exited>`,
  then sanitize as today.

### Todo 3 — notify target option

- Add `notifyTarget` to the `pty_spawn` schema (new `withPtySpawnArgs(schema)`).
- In `registerPtyTools`, strip `notifyTarget` from `merged` before calling
  upstream and stash it on the raw session (via the spawn wrapper; see below).
- `installExitNotifier` selects target(s): `"spawner"` → `parentSessionId`;
  `"root"` → `rootSessionId ?? parent`; `"both"` → unique of both. Skip
  `"web-api"`.
- Effective default: `argDefaults.pty_spawn.notifyTarget ?? notify.target ?? "spawner"`.

### Todo 4 — workdir resolution

- `import { resolve } from "node:path"`.
- In `registerPtyTools`, for `pty_spawn`:
  `base = (typeof context.directory === "string" ? context.directory : ctx.location?.directory)`;
  `merged.workdir = resolve(base || process.cwd(), merged.workdir ?? "")`.
- Also inject `directory` into the context passed to `definition.execute`
  (forward-compat with a fixed upstream).

### Config / API surface changes

| Key | Values | Default |
|---|---|---|
| `webUi.groupBy` (replaces `groupBySession`) | `false` \| `"session"` \| `"agent"` | **`"agent"`** |
| `tuiSidebar.groupBy` (new) | `false` \| `"session"` \| `"agent"` | **`"agent"`** |
| `notify.target` (new) | `"spawner"` \| `"root"` \| `"both"` | `"spawner"` |
| `pty_spawn` arg `notifyTarget` (new) | same enum, used only when `notifyOnExit` | `notify.target` |

### Housekeeping

- Bump `PATCH_VERSION` (**92** now) so the live web server recycles and serves the
  new injected JS/HTML. **Every time `PATCH_VERSION` changes, update the last
  part of `package.json` `"version"` to match it** — since 2026-11-13 the
  version format is `1.16.<PATCH_VERSION>` (e.g. `PATCH_VERSION` 92 ⇔
  `"version": "1.16.92"`). Keep them in lockstep. (Format history: the old
  four-segment style `1.16.0.92` was dropped because npm only accepts valid
  three-part semver — the `0.` segment made every publish-unready version an
  invalid one.)
- Update the named-export list at the bottom of `index.js` (verify-script surface).
- Update `opencode-pty-extended.jsonc` docs and `Readme.md`.

### Backups

- **7-Zip is installed** at `C:\Program Files\7-Zip\7z.exe` (not on `PATH` — call
  it with the full path or add it when needed).
- When asked to create a backup: 7z the **current workdir's** `opencode-pty-extended`
  folder (`C:\Users\nabil\.cache\opencode\npm\git-e0374ff83a2d774d4cf8d76d54ea10da-<hash>\node_modules\opencode-pty-extended`)
  to
  `D:\GitHub\opencode-pty-extended (gist)\opencode-pty-extended <current package version>.<timestamp>.7z`,
  where `<timestamp>` is `YYYY-MM-DD HHmm` (e.g. `opencode-pty-extended 1.16.92.2026-11-13 0002.7z`).
  Verify the archive was written (file exists + size > 0) before reporting done.

---

## Per-spawn stamping mechanism (notifyTarget + rootSessionId)

`manager.spawn` is the single choke point, but upstream builds `opts` explicitly
and does **not** forward unknown args (so `notifyTarget` cannot ride along in
`opts`). Plan:

- Use `AsyncLocalStorage` (from `node:async_hooks`) around
  `definition.execute(merged, context)` for `pty_spawn`, carrying
  `{ notifyTarget }`.
- The wrapped `manager.spawn` reads the store and stamps the created raw session
  (`rootSessionId`, `notifyTarget`).
- Fallback if `AsyncLocalStorage` is unavailable: parse `ID: pty_…` from the
  `<pty_spawned>` result and stamp afterwards.

---

## Risks / assumptions

- `ctx.data.session.root/family/list` are **best-effort** on the server plugin
  context (the code already assumes this). Every path degrades: `root()` →
  `list()` walk → identity.
- `AsyncLocalStorage` must exist in the runtime (Bun supports `node:async_hooks`).
  Fallback described above.
- The parse fallback couples to upstream's `<pty_spawned>` format.
- No broadcast path exists for exit notifications (only
  `installExitNotifier` → `ctx.session.prompt`); if "any session gets it"
  persists after the target option, investigate `ctx.session.prompt` routing.

## Verification

- `node --check index.js shared.js` (syntax) and a TypeScript/JSX sanity pass for
  `tui.tsx` if a toolchain is available.
- **Web-UI changes are ALWAYS checked live in the MCP browser** (the
  `chrome-devtools` MCP tools) against the running PTY web server, never by
  code review or harnesses alone — reload the served page (PATCH_VERSION bump
  forces a recycle so a fresh bundle is served), then verify the feature AND a
  clean console (no new errors/warnings from the injected scripts).
- Manual: spawn a PTY from a subagent and from root; check `<pty_spawned>` /
  `<pty_exited>` ids, the notify recipient for each `notifyTarget`, web-UI
  grouping in `"agent"`/`"session"`/`false`, TUI grouping, and workdir defaults
  (spawn with no `workdir` and with a relative one).
- A `verify-pty-fixes.mjs` harness exists in the author's dev copy (not in this
  checkout) that imports the wrapper's exported helpers.

---

## ConfigDialog redraw bug — root cause, fix patterns, and rules (reference)

> This section solidifies HOW the "strange repaint at top, then correct
> position" redraw bug was fixed, so future work and similar components start
> here instead of re-deriving it. Version context: 1.16.0.48 / work in
> `tui.tsx` (PATCH_VERSION bumps only affect the web bundle, not this TUI code).

### The bug chain (why it happened)

1. `/pty-config` uses a **replace-rebuild** architecture (`s.context.ui.dialog.show(() =>
   <ConfigDialog/>)` per content change) — required because solid's reactive
   update channel is dead inside the host `DialogProvider` subtree (proven: item
   callbacks ran once, signals updated, framebuffer never painted).
2. Every remount creates a **fresh scrollbox at scrollTop 0**. Writing
   `scrollTop` at ref time gets **clamped away by the initial layout pass**
   (content height not yet measured), so the first frames paint the top.
3. The settle-verified numeric restore (capture live `scrollTop` in
   `queueRefresh` before teardown → re-assert loop at the ref, ±1 tolerance,
   wheel-abort, supersede guard) lands correctly — but 40–90 ms later. That
   delay IS the visible flash ("jumps to top and then shows correctly again").

### Fix patterns (locked — always prefer these over a remount)

Every content-preserving mutate must patch **live renderables in place** and
only remount when in-place paint cannot reach the row (returns false → caller
rebuilds = today's restored behavior, never a half-paint "improved" state):

- **`patchMarkerRow(s, rows, idx, isCursor)`** (module level): flips the prefix
  char (`›`/`✱`/space) + prefix/label colors of one row via
  `findDescendantById("cfgrow.<path>")` → text `cfg.<path>` →
  `getTextChildren()` spans. The ✱ is derived from the **live draft map**
  (`s.drafts.has(path)`) — NEVER from a glyph scan of the current marker cell
  (the cursor masks ✱ with `›`, so stepping off a changed row erased its ✱).
- **`patchRowValueInPlace(setting)`** (component closure): repaints a row's
  static state after value changes — value text via `valueText()` + colors
  (`(cleared)` red / draft `#ffd24a` / normal), marker char, ↺ tint — and
  removes/destroys an imperative editor if still mounted. Since the click-UX
  split (2026-11-03) a normal row is **TWO texts**: `cfg.<path>` with **2
  spans** (prefix, label; key-column width `4*maxDepth + keyW + 6`) and
  `cfgval.<path>` with **1 span** (the value; width `valW + 1`); the JSX
  editor fallback row has NO `cfgval` id (⇒ caller must remount).
- **`patchFooterCountsInPlace()`**: writes `.content` on `cfg.apply`,
  `cfg.save`, `cfg.count` (title count) found via
  `context.renderer.root.findDescendantById(...)`. Footer/title texts must
  carry these ids so imperative updates can reach them.
- **`selectCursorInPlace(at)`**: click-driven cursor moves (the clicked row is
  visible; no scroll needed) — patch two rows, no `setCursor` rebuild.
- **`applyResizeInPlace(w)`**: width-only terminal resizes re-fit every row's
  value span + `cfgval.width = valColW2 (= valW2 + 1)` in place (Renderable
  exposes a public
  `set width`; the `cfg.` key column's width is resize-invariant). Height-only
  changes move `visibleRows`/the scrollbox box →
  remount (rare), with the exact restore.
- **`toggleFoldInPlace(key)`**: fold/unfold detaches/re-attaches the live
  children of the scrollbox (`box.remove(child)` / `box.insertBefore(detached,
  anchor)` / `box.add(detached)` — ScrollBox delegates all three to its
  content box). Folded boxes are kept in `s.detachedRows` (id → renderable;
  cleared on every remount since the fresh `<For>` tree holds new boxes) so an
  unfold reuses the SAME instance — ids, mouse handlers, zip intact — instead
  of recreating rows imperatively. Cursor sticks by PATH (indices shift with
  the attach), markers re-patched via `patchMarkerRow`, header arrow flipped
  via `patchHeaderArrowInPlace` (spans children swap). Fallback = remount when
  a needed box isn't kept (e.g. a remount rendered with folds closed). Note
  the AFTER-list must be published without a remount by splicing the MOUNT-TIME
  `items` array in place — `itemsSig` closes over that array identity, and the
  module key channel points at it.
- **Imperative editor (`openEditorInputInPlace`)**: an `InputRenderable` from
  `@opentui/core` (import both it and `InputRenderableEvents`) constructed with
  `rowBox.ctx`, blanking the `cfgval.` span and narrowing it to width 1, then
  `rowBox.add(input, 2)` (same call shape solid's
  own `_insertNode` uses: add(node, anchorIndex)); the input lands at
  4*maxDepth+keyW+7 — the exact geometry the pre-split single-text narrowing
  produced. `INPUT` event → `s.editVal`,
  commit reads `input.plainText` as belt-and-braces. On commit/cancel the row
  is repainted via `patchRowValueInPlace` — **no rebuild anywhere in the
  editor lifecycle** (editing a value must not move the view AT ALL).

Active by construction: element ids (`cfgrow./cfg./cfgval./cfgreset./cfg.apply/cfg.save/cfg.count/cfg.search/cfg.esc/cfg.detail`)
are the addressing scheme for every in-place patch; each mutated element gets
`requestRender()` after its mutation.

### Key handling (module channel)

- Keys are captured ONCE per dialog open at module level
  (`installConfigKeyChannel`): `keymap.intercept("key", ...)` when available,
  else a **prepended** listener on `renderer.keyInput` (`get keyInput()` /
  `prependListener("keypress")`), dispatching through `s.actions`
  (`setCursor/activate/stepEnum/setValue/cancelEdit/commitEdit/saveFlow`),
  which are re-bound to the current mount's closures after every remount
  (`s.actions.<name> = <fn>` runs at each mount snapshot, before first render).
- Key model (user-confirmed): ↑/↓ marker move (in-place patch, no remount);
  tab/shift+tab jump to next/previous section's first row (no wrap); ←/→ step
  enum values; **enter acts on the marked row only** (bool toggle / enum step /
  open editor — never focuses or triggers search; enter must change the row
  pointed at by `s.cursor`, prime example of why stale stamps matter below);
  typing/space/backspace outside an editbox auto-focus the search AND deliver
  that same keystroke into it (`insertText`/`deleteCharBackward` → native INPUT
  → `onInput` → `setQuery` → rebuild filter); inside a row editor all normal
  keys go natively to the editor, only escape/enter/ctrl+s are intercepted;
  escape closes; ctrl+s opens the save flow; the mouse wheel is untouched
  (`type:"scroll"` events only stamp `s.wheelAt`, which aborts pending restore
  chains — the wheel owns scroll position).
- **Stale-stamp rule**: arrow/tab moves patch rows in place WITHOUT a rebuild,
  so `isCursor`/`changed` stamps on `s.items` go stale. Any code resolving
  "the marked row" MUST read `rows[s.cursor]` first and fall back to the
  stamp only when the index is invalid (`currentRow` in the key channel, the
  restore chain's cursor-row lookup). Violating this produced "enter started
  editing the wrong line".
- `eating()` consumes keys channel-agnostically (`ctx.consume()` if present,
  else flag the KeyEvent via `preventDefault()`+`stopPropagation()`).

### Mouse/click handling

- OpenTUI hit-testing fires on the **deepest `<text>`** under the cursor;
  handlers on enclosing `<box>` rows never fire. A config row is TWO
  fixed-column `<text>` cells since the click-UX split (2026-11-03): the key
  cell `cfg.<path>` (prefix+label; width `4*maxDepth + keyW + 6`) and the
  value cell `cfgval.<path>` (one span; width `valW + 1`) — plus the ↺ glyph
  (`cfgreset.<path>`) and the badge cell (`cfgbadge.<path>`), each with its
  own `onMouseUp`.
- Click semantics (user-locked 2026-11-03): every click moves the cursor in
  place first (`selectCursorInPlace`), falling back to a remounting `setCursor`
  only if the patch fails. **Left** click on the VALUE cell (`cfgval.`)
  = `activate()` (edit/toggle the value); left click on the KEY cell, the ↺
  glyph or the badge = SELECT ONLY (never touches the value). **Right** click
  anywhere on the row = `resetRow(setting)` (same tiered value-reset strategy
  as the ↺ reset button: draft undo → applied-overlay undo → default toast →
  clear — never a direct `setValue(null)`).
- A root-level bubble router (`onMouseBelow` on the content box) catches ids
  it dispatches to: `cfgsec.<foldKey>` (button 0 = fold toggle), `cfgval.<path>`
  (value semantics: left = activate, right = reset), `cfg.<path>` /
  `cfgbadge.<path>` (key semantics: left = select only, right = reset).
  Rows/actions call
  `e.stopPropagation()` when they act, so the router never double-fires.
- Wheel events also bubble through this router (`type == "scroll"`) — never
  handle them as clicks; they exist to stamp `wheelAt`.
- **Mouse-focus rule (user-clarified)**: clicking anything inside the dialog
  that is not the search field itself UNFOCUSES the search (`blurSearch()`,
  called from every non-search mouse path: rows, reset glyph, fold headers,
  footer buttons, `esc`/`close`, backdrop guard, bubble router dispatches).
  Clicking the search wrapper still focuses it. Consequence: an editor opened
  after any mouse click always snapshots `searchWasFocusedBeforeEdit=false`,
  so ending it (even by keyboard enter) never refocuses search; and the
  keyboard-end refocus (search focused right before the edit) applies only to
  edits opened while the search genuinely owned the keyboard.
- A transparent full-terminal backdrop-guard box (first child, absolutely
  positioned, `onMouseDown/onMouseUp → stopPropagation()`) prevents the host
  Dialog's backdrop from closing the dialog on outside clicks.

### Degradation + verification discipline (prevent regressions)

- Every in-place patch returns a boolean; callers fall back to the remount
  path on failure and `dbg()` which path ran (log lines: `patch marker ...`,
  `... in place`, `... remount fallback`, `patch marker incomplete`).
- Never leave a half-painted tree: either the patch fully succeeds or the
  caller rebuilds.
- Runtime probes (now dbg in tui.tsx, `%TEMP%\opencode-pty-config-debug.log`)
  are diagnostic-only and MUST be stripped (and `PATCH_VERSION`/package last
  segment bumped together) once live verification passes.

## Debug probes — mechanism and lessons (reference)

> Solidified from the todo-3 (System32/home misreport → RPC routing) and
> ConfigDialog-verification rounds so future agents wire probes the same way
> instead of re-deriving what works. All TEMP PROBEs from those rounds are
> stripped as of 1.16.0.49; the `dbg()` helper and its permanent diagnostics
> stay.

### Why plugin diagnostics don't go to the opencode server log

Plugin `console.log`/`console.warn` output does NOT appear in
`C:\Users\nabil\.local\share\opencode\log\opencode.log` (verified by
calibration: grep for our `[opencode-pty-extended]` prefix stayed empty while
the plugin was running). Worse, it looks like "the code never ran". Therefore
every probe writes to FILES.

### The two evidence channels

1. **Shared debug log**: `%TEMP%\opencode-pty-config-debug.log`
   (= `C:\Users\nabil\AppData\Local\Temp\opencode-pty-config-debug.log`).
   - Server half (index.js): `appendFileSync` from `node:fs`, one line per
     event: `` `${new Date().toISOString()} <message>` ``.
   - TUI half (tui.tsx): the same path via the module-level `dbg(msg)` helper
     (line ~38) — same format, so both halves interleave into one timeline.
   - **Shared across ALL opencode processes** (three instances alive at once:
     System32 / home / gist). That is a feature: one read shows every
     instance's side. Consequence: always filter by timestamp AND remember a
     line may come from another location's instance.
   - The log survives `/restart`s — batch events by timestamp. The LATEST
     `setup:`-style batch reflects the currently loaded code only after the
     restart that loaded it.
2. **Server log** `...\log\opencode.log`:
   - No plugin console output, but HTTP evidence: lines like
     `http.url=/api/rpc/<rpc id>/<method> http.status=<code>` per call.
   - `spawning process` lines echo the exact pwsh commands an agent runs —
     handy for correlating agent activity timestamps within the log.

### Probe patterns (what worked)

- **Server-side file probe (index.js)**: an `appendFileSync` line wrapped in
  `try { … } catch { /* probe must never break … */ }` so a probe can NEVER
  break setup or an RPC handler. Always tag the comment with the question it
  answers and the strip condition: `// TEMP PROBE (<question>): … strip once
  <condition>`. Examples used: `setup:` (per-instance
  `location.directory`/`server.cwd`/`projectDir` — THE attribution line for
  multi-instance questions), `rpc-register OK / FAILED id=` (registration
  failures would otherwise vanish — `ctx.rpc.register` rejections surfaced
  only here, never in opencode.log and never crashed setup).
- **TUI-side `dbg()` probes (tui.tsx)**: one line per decision —
  `local configGet: project.directory=…`, `save options: global=… opencode=…
  sibling=…`, `editor layout NOW/T+60`, key-channel election
  (`key channel: …`), in-place repaint outcomes (`patch marker …`,
  `… remount fallback`, `… in place`). Some `dbg` lines are PERMANENT
  diagnostics for the in-place machinery — strip ONLY lines marked
  `TEMP PROBE` / `DIAGNOSTIC ONLY`; keep the rest.
- **CLI network probe** (`opencode api post "/api/rpc/<id>/<method>" --data
  "{}"` from a shell): reproduces a TUI RPC call without the TUI. The error
  BODY is the answer — `rpc.invalid_input` means the handler was REACHED
  (only the payload was wrong: 200-route, 400 status); `rpc.unavailable`
  means the contract did not route at all. Run it from different `workdir`s
  to expose directory-scoped routing (this is exactly how the
  server-root-scoped rpc route visibility was proven — see the
  `CHANGES.md` progress-log `decision` entries of 1.16.0.48/49).
- **Read order when diagnosing**: (1) latest `setup:` batch in the debug log
  (which code + which instances are live); (2) probe lines around the failure
  timestamp; (3) http lines for the same window in opencode.log.

### Discipline

- Probes are always `try/catch`-wrapped; a diagnostic must never become a
  failure mode.
- After live verification passes: strip ALL `TEMP PROBE` blocks (grep the
  marker string), remove now-tag-along imports (e.g. `appendFileSync` when
  only probes used it), bump `PATCH_VERSION` and the `package.json` version's
  last segment in lockstep, and record the strip in the progress log (now in
  `CHANGES.md`).
- Probe edits to the git-cache checkout are picked up by the next `/restart`
  (no reinstall) — the checkout IS the loaded copy.

## Progress log

The complete progress log **moved to [`CHANGES.md`](CHANGES.md)** in this
directory — every historical entry (`[implemented]`, `[bugfix]`, `[decision]`,
`[verified]`, bugfix chases, housekeeping, backups, pending live tests and
gist re-sync lists) was moved there byte-for-byte on 2026-11-02.

- **Where to add**: append new entries at the BOTTOM of `CHANGES.md`, keeping
  the established `**[tag]**` style.
- **What to add**: an entry for every round of work — what changed and why,
  decisions (with the reasoning that locked them), verification results
  (`node --check` / offline harness / live MCP-browser checks),
  `PATCH_VERSION` + `package.json` lockstep bumps, TEMP-PROBE strips, 7z
  backups, and the gist re-sync file list. Pending live tests stay listed
  until they actually pass.
- **Why to read it**: the log explains why the code is the way it is — root
  causes, live-verified platform lessons (OpenCode internals, Windows
  quirks), user-confirmed behaviors, and abandoned approaches that must not
  be restarted. Before changing `index.js` / `shared.js` / `tui.tsx` or
  debugging, read `CHANGES.md` first — most "mysteries" were already solved
  and recorded there.