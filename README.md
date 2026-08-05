# memlens

[日本語版 README はこちら](./README.ja.md)

**memlens is a desktop lens over [Claude Code](https://www.anthropic.com/claude-code)'s auto memory** — the notes Claude writes to itself about you, your projects, and how you like to work. It turns the markdown files under `~/.claude/projects/<sanitized>/memory/` into a fast three-pane instrument for reviewing, searching, curating, and pruning what your AI remembers.

Runs on **Windows, macOS, and Linux**. Built with Electron + React + TypeScript.

![memlens reading a feedback memory](./docs/screenshots/reading.png)

## Why

Claude Code accumulates memory automatically: a `MEMORY.md` index plus typed memory files per project. That memory shapes every future session, but it lives in hidden directories and is written by a machine. memlens exists so you can _see_ it — what's fresh, what's stale, what's load-bearing, and what deserves to be deleted — without spelunking through `~/.claude` by hand.

## Features

### Browse & read

- **Project rail** — every project under `~/.claude/projects/` with a memory directory, newest first, with a `cwd` badge on the one matching your working directory. Custom directories (`autoMemoryDirectory`, cowork overrides) appear as `(custom)` virtual projects.
- **Freshness traces** — each memory row carries a trace that dims with age. The fresh/faded boundary matches Claude Code's own staleness rule: memories older than a day are flagged in prompts as _point-in-time observations_ (`src/memdir/memoryAge.ts`), and memlens marks them with the same `point-in-time` chip when you open them.
- **Type taxonomy** — `user` / `feedback` / `project` / `reference` chips with live counts, matching the official memory type system, plus recency / name / size sorting.
- **Live reload** — `fs.watch` on the selected memory directory keeps the UI in sync while Claude Code writes.

### Search

- **In-project search** — instant header filtering plus debounced full-text body search with line numbers and excerpts.
- **All-projects search** — flip the `all projects` scope and one query sweeps every memory directory on the machine; hits are labeled by project and open with a click.

![Global search across all projects](./docs/screenshots/global-search.png)

### Curate

- **Load-budget meter** — Claude Code loads only the first **200 lines / 25 KB** of `MEMORY.md` (`src/memdir/memdir.ts`). memlens measures your index against that budget with two gauges — like Claude Code v2.1.211+, measured on the content that actually loads (frontmatter and block-level HTML comments stripped first).
- **Create** — guided dialog with per-type hints and the officially recommended body structure for `feedback` / `project` memories (\*rule → **Why:** → **How to apply:\***).
- **Edit** — in-place editor with a Write / Preview toggle, dirty-state save (`Ctrl/Cmd+S`), and Escape to cancel.
- **Rename / delete** — safe by construction: the top-level `MEMORY.md` entrypoint can be neither renamed nor deleted, collisions are refused, and filenames are validated against the strictest (Windows) rules on every OS so synced memory dirs stay portable.
- **Copy path / reveal** — copy the absolute path, or jump to Explorer / Finder / your file manager.

![MEMORY.md with the load-budget meter](./docs/screenshots/load-budget.png)

### Understand your setup

- **Settings inspector** — shows the resolved auto-memory configuration and _why_: which layer decided each value (env var, managed policy, `--settings` flag, or `~/.claude/settings.json`).
- **Bilingual UI** — English / 日本語, one click.

## Install

Grab the latest build for your OS from [Releases](https://github.com/kongyo2/memlens/releases):

| OS      | Artifact                         | Notes                                                                                                        |
| ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Windows | `memlens-Setup-<version>.exe`    | Per-user NSIS installer, no admin rights needed. SmartScreen may warn (unsigned) — "More info → Run anyway". |
| macOS   | `memlens-<version>-<arch>.dmg`   | Unsigned: right-click → Open on first launch, or `xattr -cr /Applications/memlens.app`.                      |
| Linux   | `memlens-<version>-x64.AppImage` | `chmod +x` then run. A `.deb` is also published for Debian/Ubuntu.                                           |

memlens needs an existing Claude Code installation with auto memory enabled — it only reads and writes files in directories Claude Code already manages.

## Keyboard shortcuts

| Shortcut       | Action                     |
| -------------- | -------------------------- |
| `Ctrl/Cmd + F` | Focus search               |
| `Ctrl/Cmd + N` | New memory                 |
| `Ctrl/Cmd + R` | Reload                     |
| `Ctrl/Cmd + S` | Save (while editing)       |
| `Esc`          | Cancel edit / close dialog |

## How auto memory works (primer)

- Each project's memory lives at `~/.claude/projects/<project>/memory/`, where `<project>` is derived from the canonical git root (worktrees share one directory) and sanitized for the filesystem; paths longer than 200 chars get a hash suffix.
- `MEMORY.md` is the index — loaded into every session, truncated at 200 lines / 25 KB.
- Individual memories are markdown files with `name` / `description` / `type` frontmatter. The four types capture context _not derivable_ from the repo: who you are (`user`), guidance you've given (`feedback`), ongoing work (`project`), and pointers to external systems (`reference`).
- Memories age: Claude Code annotates anything older than a day as a point-in-time observation.

memlens mirrors the official implementation for all of this (path sanitization, index limits, type parsing, staleness), so what you see is what Claude Code sees. See the official [memory documentation](https://code.claude.com/docs/en/memory) for the full story.

## Configuration

memlens has no config file of its own — it reads the same env vars and `settings.json` that Claude Code does, so whatever your CLI sees is what the app sees.

Environment variables (read at process start):

| Variable                             | Effect                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`                  | Overrides `~/.claude` as the config home.                     |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR`      | Overrides the memory base dir (used by remote/cowork setups). |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`    | Truthy → auto-memory OFF; falsy → forced ON.                  |
| `CLAUDE_CODE_SIMPLE`                 | Truthy → auto-memory OFF (matches CLI `--bare`).              |
| `CLAUDE_CODE_REMOTE`                 | Truthy + no `REMOTE_MEMORY_DIR` → auto-memory OFF.            |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | Highest-precedence override for `autoMemoryDirectory`.        |
| `CLAUDE_SETTINGS_PATH`               | Path to a `--settings`-style overlay JSON.                    |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH`  | Overrides the managed-settings directory (`policy` layer).    |

Settings file precedence (re-read on every refresh):

1. `managed-settings.json` + `managed-settings.d/*.json` (admin policy)
2. `CLAUDE_SETTINGS_PATH` (the `flag` layer)
3. `~/.claude/settings.json` (user)

Keys honored by memlens: `autoMemoryEnabled` (boolean), `autoMemoryDirectory` (string, `~/` expansion supported).

## Development

Requirements: Node.js **>= 20.10** (22 LTS recommended — Electron 42's tooling prefers it).

```sh
git clone https://github.com/kongyo2/memlens.git
cd memlens
npm ci

npm run dev          # Electron + Vite dev server (hot reload)
npm test             # Vitest (add -- --run for one-shot)
npm run typecheck    # TypeScript project references
npm run lint:strict  # oxlint, warnings as errors
npm run format       # Prettier

npm run build        # build renderer/main/preload bundles
npm run build:win    # package a Windows installer into ./release/
npm run build:mac    # package macOS dmg/zip (arm64 + x64)
npm run build:linux  # package AppImage + deb
```

### Project structure

```
src/
  main/        Electron main process
    services/  settings resolution, memory fs ops, search, watcher,
               git-root canonicalization, path sanitization
    ipc/       ipcMain handlers (validated at the boundary)
  preload/     contextBridge — the only bridge renderer ↔ main
  renderer/    React UI (three-pane app, i18n en/ja, components)
  shared/      zod schemas, IPC channel names, API contract types
```

Security posture: sandboxed renderer talks to the filesystem only through the typed preload API; every path is validated against the allowed memory roots in the main process; production builds get a strict CSP; external links open in the system browser only for http/https/mailto.

### Releasing

`Actions → Release → Run workflow` with a version like `v0.3.0`. The workflow lints, type-checks, and tests on **Windows, macOS, and Linux**, packages all three platforms, and publishes a GitHub Release with every artifact. CI runs the same three-OS test matrix on every PR.

## License

MIT — see [LICENSE](./LICENSE).

memlens is an independent third-party tool. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.
