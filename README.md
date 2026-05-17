# memlens

[日本語版 README はこちら](./README.ja.md)

memlens is a desktop viewer and manager for [Claude Code](https://www.anthropic.com/claude-code) auto-memory files. It surfaces the per-project `MEMORY.md` index and the markdown files under `~/.claude/projects/<sanitized>/memory/` in a three-pane GUI, so you can review, edit, and prune what Claude Code has written about your work without touching the filesystem by hand.

Built with Electron + React + TypeScript. Primary target is Windows 11; macOS / Linux work in development but only the Windows installer ships from the release workflow.

## Features

- **Project browser** — lists every project under `~/.claude/projects/` that has a `memory/` directory, sorted by last write, with a `cwd` badge on the project that matches the current working directory.
- **Memory list** — shows every `.md` file in a project's memory dir, parses YAML frontmatter for `name` / `description` / `type`, and supports type-filter chips (`user`, `feedback`, `project`, `reference`).
- **Full-text search** — debounced body search across all memories in the selected project, with line-number hits and excerpts.
- **Index viewer/editor** — opens `MEMORY.md` with a clear indication when it exceeds Claude Code's 200-line / 25 KB load limit.
- **Create / edit / delete** — guided new-memory dialog with per-type hints, in-place editing with save/cancel, and safe deletion (the `MEMORY.md` entrypoint cannot be deleted).
- **Live reload** — `fs.watch` on the selected project's memory dir picks up writes from Claude Code itself, so the UI stays in sync.
- **Settings inspector** — shows the resolved auto-memory configuration (enabled flag, base dir, `autoMemoryDirectory`) and explains which layer provided each value (env var, managed policy, `--settings` flag, or `~/.claude/settings.json`).
- **Custom directories** — supports `CLAUDE_CODE_REMOTE_MEMORY_DIR`, `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, and `settings.json`'s `autoMemoryDirectory`. Custom dirs outside `projects/` appear as a `(custom)` virtual project.
- **Bilingual UI** — Japanese / English toggle in the header.
- **Keyboard shortcuts** — `Ctrl/Cmd + R` reload, `Ctrl/Cmd + N` new memory, `Ctrl/Cmd + F` focus search, `Esc` to close dialogs.

## Requirements

- Node.js **>= 20.10.0** (for development)
- Windows 11 (recommended; release binary). Other platforms work in `dev` mode.
- An existing Claude Code installation (auto-memory enabled). memlens only reads / writes files in directories Claude Code already manages.

## Install (Windows)

1. Grab the latest `memlens-Setup-<version>.exe` from the [Releases](https://github.com/kongyo2/memlens/releases) page.
2. Run the installer. It's a per-user NSIS installer; admin rights are not required.
3. Launch **memlens** from the Start menu.

## Build from source

```sh
git clone https://github.com/kongyo2/memlens.git
cd memlens
npm install

# launch the app in dev mode (hot reload)
npm run dev

# build the renderer/main/preload bundles
npm run build

# package a Windows installer into ./release/
npm run build:win
```

## Configuration

memlens does not have its own config file — it reads the same env vars and `settings.json` that Claude Code does, so whatever your CLI sees is what the app sees.

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

## Scripts

- `npm run dev` — start Electron + Vite dev server
- `npm run build` — build all three Vite bundles
- `npm run build:win` — build + produce a Windows installer (NSIS)
- `npm run typecheck` — TypeScript project references check
- `npm run lint` / `npm run lint:strict` — oxlint
- `npm run format` / `npm run format:check` — Prettier
- `npm test` — Vitest

## Project structure

```
src/
  main/        Electron main process (IPC handlers, fs services, fs.watch)
  preload/     contextBridge for renderer ↔ main
  renderer/    React UI (three-pane app, i18n, components)
  shared/      schemas (zod), IPC channels, contract types
```

## License

MIT — see [LICENSE](./LICENSE).

memlens is an independent third-party tool. It is not affiliated with or endorsed by Anthropic.
