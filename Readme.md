# opencode-pty/v2 - Extended

This wrapper exists to fix the original plugin's shortcomings, while extending it. Original: [opencode-pty](https://github.com/shekohex/opencode-pty/) by [shekohex](https://github.com/shekohex).
<br>You can build and debug full TUI applications (like plugins in OpenCode), including terminal resizing and mouse support.

<img width="292" height="361" alt="690280742-0b74940f-ba6d-45e8-a2d9-8ba1c1f53a87" src="https://github.com/user-attachments/assets/79481c73-8a32-413d-af9f-e74a93474c25" />
<img width="300" height="685" alt="693039222-7b0f8373-25f9-4cfa-9540-ff89a578e378" src="https://github.com/user-attachments/assets/a33b7400-efaa-498a-b0ad-987c696e2fce" />
<img width="325" height="119" alt="693019411-12ff7bbf-f157-4de2-9a51-b6c681c7510f" src="https://github.com/user-attachments/assets/1d93171d-9f63-4f92-9920-d69cc78258a6" />
<img width="433" height="175" alt="690247052-6de000e5-74b9-4bd0-983f-0e83b51f2cc5" src="https://github.com/user-attachments/assets/be88bc04-98fa-46a2-accd-206a9fcea6cd" />
<img width="817" height="201" alt="691146021-5959093f-0b14-4349-920d-9e7bd45da4a7" src="https://github.com/user-attachments/assets/51f13657-8b45-4c2c-b88d-b62e8b05db25" />
<img width="816" height="800" alt="692920668-d7bc4efb-6c83-4656-9646-6323b5c6c61d" src="https://github.com/user-attachments/assets/26b8713f-afcc-4cce-9115-ddf015815975" />
<img width="585" height="289" alt="692713074-985c5fe5-e738-4889-9cd8-7085e4c53cfb" src="https://github.com/user-attachments/assets/25a12dfe-15bf-4c73-a116-15508928ead7" />

## Install

### Use the cli
```bash
opencode plugin add opencode-pty-extended 
```

#### Config
Simple usable config, add to `opencode.jsonc`
```jsonc
"plugins": [
    {
        "package": "opencode-pty-extended",
        "options": {
            // fixed port - not random anymore
            "port": 58858,
            
            "terminalFont": {
                // enable Nerd Font glyph support in terminal
                "family": "'FiraCode Nerd Font Mono', 'SF Mono', 'Fira', 'Fira Code', 'Consolas', monospace",
                // smaller terminal font size
                "size": 12
            },
            "webUi": {
                // no confirmation alerts
                "killConfirmSession": false,
                "closeConfirmSession": false,
            },
            "output": {
                // strip ansi sequences from pty exit messages (otherwise the will be shown readable)
                "stripAnsiSequences": true,
                // ... and from /pty-output dialog
                "dialog": { "stripAnsiSequences": true },
                // but keep for true TTY inspection
                "tool": { "stripAnsiSequences": false }
            }
        }
    }
]
```

**Font**: you should use a **Nerd Font** variant, like `FiraMono Nerd Font` ([Nerd Font list/downloads](https://www.nerdfonts.com/font-downloads)) to ensure, you have all glyphs the terminal might need. 

For all options [see below](opencode-pty-extended.jsonc).

#### Config sources

Options are **deep-merged** from every config source found, lowest priority
first (a later layer only overrides the keys it sets: nested objects merge,
arrays/scalars replace):

1. this shipped `opencode-pty-extended.jsonc` (reference defaults)
2. `<opencode config dir>/opencode-pty-extended.json[c]` — e.g. `~/.config/opencode/`
3. project files, walking up from the session directory: each ancestor's
   `opencode-pty-extended.json[c]`, then each ancestor's `.opencode/opencode-pty-extended.json[c]`
   (the nearest ancestor wins, and every `.opencode/` file outranks every
   non-`.opencode/` one — the same order opencode uses)
4. the plugin entry's `options` in `opencode.jsonc` (see above, highest)

Within a directory `.json` is read before `.jsonc` (`.jsonc` wins); missing
files are skipped. So a `opencode-pty-extended.jsonc` can live in `~/.config/opencode/`,
in a project root, or in a project's `./.opencode/` — or you can put the same
keys in the plugin `options`.

The TUI sidebar and the `/pty-output` dialog honour the **same** merged result
as the server-side features: the server half resolves the layers above and
hands the `tuiSidebar` / `output` blocks to the TUI half over RPC. So
`plugins[].options` also drives `/pty-output` — you do *not* need to repeat
those keys in `cli.json`.


## Note

... opencode should automatically update its loaded plugins .. but you might to type `/restart` within opencode or from commandline `opencode service restart`


### Tell opencode to install
```
read and install the plugin workaround from https://github.com/BananaAcid/opencode-pty-extended README.md
```


## Additional features of this wrapper:

**The original `opencode-pty/v2` v0.4.0 had some bugs and limitations:**
   - it can not be loaded by opencode v2
   - the commands and tools do not get exposed / unusable
   - the tui sidebar does not work
   - stale issue tracker


**commands & tools at a glance:**

| command / tool | purpose | used by |
|---|---|---|
| `/pty-config` | settings dialog (browse, apply, save) | user |
| `/pty-kill` | pick a PTY, confirm, kill + clean up | user |
| `/pty-output` | view a PTY's buffered output | user |
| `/pty-refresh` | re-pull the session list + plugin settings (no restart) | user |
| `/pty-show-all-pty` | toggle/show-all/current-only visibility of the sidebar's PTY list (`[on\|off]`, no arg = toggle; runtime-only) | user |
| `/pty-restart` | reload config + eagerly recycle the web-UI server (soft; `kill` kills running PTYs) | user |
| `/pty-open-background-spy`, `/pty-show-server-url` | show/open the web-UI URL silently | user |
| `pty_spawn` | start a PTY (relative `workdir` resolved, `cols`/`rows`, `notifyOnExit`, `notifyTarget`) | agent |
| `pty_write` | send text/keys to a PTY (incl. SGR mouse sequences) | agent |
| `pty_read` | read the output buffer (+ terminal size) | agent |
| `pty_list` | list sessions, scoped by conversation by default | agent |
| `pty_kill` | kill / clean up a session | agent |
| `pty_refresh` | reload the live config in memory + push settings (no web-UI recycle) | agent |
| `pty_restart` | reload config + recycle the web-UI server (soft / `kill`) | agent |
| `pty_url` | web-UI URL, optionally deep-linked to one session | agent |
| `pty_size_get` / `pty_size_set` | terminal size pin (auto / fixed) | agent |
| `pty_show_all_pty` | report (`read`, default) or override (`on` / `off`) whether all sessions' PTYs are shown in the TUI sidebar — runtime-only, a `tuiSidebar.filterBySession` config change resets it | agent |

... changing the config requires opencode "/restart" to reload the config

**New features:**
1. extra config file for any kind of settings, [see below](opencode-pty-extended.jsonc)
2. config includes terminalFont family,size,lineheight to configure the TTY font
3. fixed notifyOnExit to work with this v2 wrapper; the `argDefaults` in the config are applied at runtime (and reflected in the tool schema)
    - the exit notification (`<pty_exited>`) and the spawn result (`<pty_spawned>`) both carry the initiator and root opencode session ids (and the initiator agent)
    - a web-UI `+`-spawned PTY's `<pty_spawned>` block uses the same lineage scheme: `Initiator Session: PTY web UI`, `Root Session: <root session id>` (`global` when spawned without a session), plus `notifyOnExit`
    - the web UI's "New PTY session" dialog has a bottom-left "Notify on exit" toggle (initial state = `argDefaults.pty_spawn.notifyOnExit`); when on, the parked conversation receives the `<pty_exited>` notice like a tool-spawned PTY
    - `pty_spawn` takes a `notifyTarget` argument (`"spawner"` default | `"root"` | `"both"`) choosing who is told when the process exits; the config default is `notify.target`
    - `pty_write`'s tool description documents SGR mouse events (`\x1b[<b;x;yM` press / `m` release — buttons 0/1/2, wheel 64–67, motion +32 / hover 35): an agent can drive mouse-driven TUIs (`\x1b[<0;24;12M` = left click at column 24, row 12) without a real mouse; the sequences only act as mouse input when the running app enabled mouse reporting
4. added resize notification to underlying tty (checking width and height will be correctly reported by its actual size in browser)
    - debug line relabeled to `<session id>: N chars, …` with the id in bold ("Debug:"/"active:" dropped) and the current tty size appended at the window bottom
5. no console-window flash when the PTY web UI opens the browser on Windows
6. The TUI sidebar's `PTY` area can be clicked in different places for different functionality:
    - clicking the `▼ PTY` header folds the session list away.
    - clicking the dimmed `no sessions` line opens the webui (the header itself no longer does)
    - clicking one of the items still opens the webui and selects that session in the menu
    - right-clicking an item removes it: running/killing → confirmation dialog, then the session is killed and cleared; killed/exited → cleared directly, no dialog
    - right-clicking a `↳ subagent` group header removes the whole group: if any of its PTYs still runs, one confirmation lists them all and then every PTY of the group is killed + cleared; if they are all dead, they are cleared without asking
7. CTRL+C will not be cought by the ui anymore (can be enabled in the config), CTRL+D is the default as its commonly used by TTYs for that purpose (can be disabled in the config)
8. additional commands:
    - `/pty-kill` (open popup to select a session to kill and cleanup)
    - `/pty-output` (open popup to select a session to show output)
    - `/pty-refresh` (refresh the session list *and* re-pull the plugin settings — picks up hot-reloaded config without a restart)
    - `/pty-open-background-spy` and `/pty-show-server-url` are output-only now: both open/show the PTY web UI silently (no notification/prompt to opencode)
    - `/pty-config` (settings dialog: provenance badges, live search, foldable sections, draft/undo, `save` to the global or project config file, `apply` to preview values on the running plugin only; keys and all details are documented in the shipped `opencode-pty-extended.jsonc`)
9. new `pty_restart` tool + `/pty-restart` command (reload the live config and eagerly recycle the PTY web-UI server, running PTYs survive; `scope="kill"` first kills every running PTY), a `pty_refresh` tool (reload the live config in memory and push it to the TUI sidebars — no web-UI recycle), and a `pty_url` tool (returns the PTY web UI URL — starting the server on demand; pass a session id to get `.../index.html?session=<id>` for direct session selection). Perfect for use with a browser MCP (like `chrome-devtools-mcp`).
    - settings hot-apply: `tuiSidebar.*` / `output.*` take effect immediately on every live reload (dialog apply/save, `/pty-refresh`, `pty_refresh`, `pty_restart`) — `tuiSidebar.enabled` included (a pure show/hide gate for the section, consulted live; hiding never unloads anything); webserver-tier keys (`port`, `hostname`, `terminalFont.*`, `webUi.*`) additionally need the PTY-stack soft restart, and `autostart`, `tuiSidebar.initiallyHidden` need a full opencode `/restart`
10. per-session close (×) button kills *and* removes that session
    - the confirmation dialogs can be disabled independently via the config
11. safly rendered ansi sequences, but can be stripped as well:
    - `/pty-output` uses `output.dialog.stripAnsiSequences`
    - `<pty_exited>` uses `output.stripAnsiSequences`
    - the `pty_read` tool result is left raw by default and only stripped when `output.tool.stripAnsiSequences` is true
12. sessions are remembered by the opencode session that spawned them:
    - the TUI sidebar and the `/pty-output` / `/pty-kill` pickers show only the
      current conversation's PTYs (plus its subagent descendants) when
      `tuiSidebar.filterBySession` is true (the default); set it to false to see
      every PTY
    - `/pty-show-all-pty` (no arg = toggle; `on`/`off`) and the
      `pty_show_all_pty` tool change that visibility at RUNTIME — one shared
      override state, never written to config, reset to "follow config" when
      `tuiSidebar.filterBySession` changes via the dialog (apply/save)
    - while show-all is active, the sidebar attributes every PTY to its owning
      opencode session (`■ <session title>` + dimmed `ses_<id>` header per root
      group, rows nested one indent deeper) and marks the current session's
      rows by contrast: foreign rows render dimmed (the pickers tag foreign
      rows with `[<owning session>]` instead)
    - the `pty_list` tool lists the calling conversation's PTYs by default and
      appends a compact summary of the others; pass `sessionID` to scope it
      (or `"*"` / `all: true` to list everything). Each entry also shows its
      `Initiator` (the session/subagent that spawned it) and `Root` conversation
    - both the web UI (browser) sidebar and the TUI sidebar group their PTY
      sessions by owning opencode conversation, and (in `"agent"` mode) sub-group
      them by the subagent that spawned them. `webUi.groupBy` /
      `tuiSidebar.groupBy` take `false | "session" | "agent"` (default
      `"agent"`)
13. Sub agents have the correct working dir
14. Nesting for sessions in webui and TUI
15. Added Download / Download-RAW buttons (the *Buffer* source) plus an attached
    mode dropdown that can instead snapshot the *Screen* (what the live terminal
    currently shows, scrollback included) as plain text or with ANSI colours
16. Web-UI touch-ups: the header kill button matches the download buttons' geometry, session cards fill the sidebar width (`webUi.stretchSessions`), and the per-card / per-group × close buttons (instant gray + one confirm; `webUi.closeConfirmSession` gated)
17. Fixed PTY size support: `pty_spawn` takes `cols`/`rows`, `pty_size_get`/`pty_size_set` manage the pin later, and the web UI statusbar (`webUi.sizeControl`) carries an auto/fixed toggle, size textboxes with Apply/Cancel, and the session debug line as its right-aligned tail

18. Web-UI `+` spawn button (`webUi.spawnButton`): a right-aligned `+` next to "PTY Sessions" opens a popup (GLOBAL first, then opencode conversations with their `ses_<id>`; command entry + optional workdir); the created PTY is announced in the target conversation's chat (`notify.announceWebSpawn`, global = all open sessions)

19. Web-UI auto-reconnect (`webUi.reconnectIntervalMs`, default 2000 ms): when the page's WebSocket drops (server recycle/restart/down-time), the injected watchdog — which only starts probing **after** disconnect, never while connected — polls `/ws` at the configured interval and reloads the page as soon as the server answers again, so the fresh page rebuilds session list, subscription and terminal by itself. Reloads are limited to one per 15 s; `0`/`false` disables it (upstream behavior: the page stays dead until a manual reload).

**for current version number** see [below](#file-package-json)

## License
MIT.
