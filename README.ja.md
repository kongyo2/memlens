# memlens

[English README is here](./README.md)

memlens は [Claude Code](https://www.anthropic.com/claude-code) の auto memory ファイルを閲覧・編集するためのデスクトップアプリです。`~/.claude/projects/<sanitized>/memory/` 配下に Claude Code が書き出した `MEMORY.md` (index) と各 markdown ファイルを 3 ペインの GUI で表示し、ファイルシステムを直接触らずに内容の確認・編集・整理を行えます。

Electron + React + TypeScript 製。主なターゲットは Windows 11 です (macOS / Linux でも `dev` モードでは動作しますが、リリース成果物として配布されるのは Windows インストーラのみ)。

## 主な機能

- **プロジェクト一覧** — `~/.claude/projects/` 配下の `memory/` ディレクトリを持つプロジェクトを最終更新順で一覧表示。現在の作業ディレクトリと一致するプロジェクトには `cwd` バッジが付きます。
- **memory 一覧** — プロジェクト内のすべての `.md` を表示し、YAML frontmatter の `name` / `description` / `type` を解析。`user` / `feedback` / `project` / `reference` のタイプ別フィルタが利用できます。
- **全文検索** — 選択中プロジェクトの全 memory に対する全文検索 (debounce 付き)。マッチした行番号と前後の抜粋を表示します。
- **MEMORY.md ビューア/エディタ** — `MEMORY.md` を表示し、Claude Code がロードする上限 (200 行 / 25 KB) を超えている場合は明示的に警告します。上限の測定は Claude Code 本体 (v2.1.211+) と同じく「実際にロードされる内容」に対して行います (YAML frontmatter とブロックレベルの HTML コメントは除外)。
- **作成 / 編集 / 削除** — タイプごとの説明付きの新規作成ダイアログ、保存/キャンセル付きのインライン編集、安全な削除 (entrypoint である `MEMORY.md` は削除不可)。
- **自動更新** — 選択中プロジェクトの memory dir を `fs.watch` で監視し、Claude Code 本体が memory を書き込むと自動で UI を更新します。
- **設定インスペクタ** — auto memory の有効/無効、base dir、`autoMemoryDirectory` の解決結果を表示し、その値が「環境変数」「managed policy」「--settings」「~/.claude/settings.json」のどこから来たかを明示します。
- **カスタムディレクトリ対応** — `CLAUDE_CODE_REMOTE_MEMORY_DIR` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` / `settings.json` の `autoMemoryDirectory` をサポート。`projects/` 外を指す場合は `(custom)` という仮想プロジェクトとして表示します。
- **日本語 / 英語 UI** — ヘッダーから即時切り替え可能。
- **キーボードショートカット** — `Ctrl/Cmd + R` で再読み込み、`Ctrl/Cmd + N` で新規作成、`Ctrl/Cmd + F` で検索フォーカス、`Esc` でダイアログを閉じる。

## 動作環境

- Node.js **>= 20.10.0** (開発時)
- Windows 11 推奨 (リリースバイナリの対象)。他 OS でも `dev` モードでは動作します。
- Claude Code がインストール済みで auto memory が有効であること。memlens は Claude Code が管理するディレクトリ配下のファイルのみを読み書きします。

## インストール (Windows)

1. [Releases](https://github.com/kongyo2/memlens/releases) ページから最新の `memlens-Setup-<version>.exe` をダウンロードします。
2. インストーラを実行します。ユーザ単位の NSIS インストーラなので、管理者権限は不要です。
3. スタートメニューから **memlens** を起動します。

## ソースからビルド

```sh
git clone https://github.com/kongyo2/memlens.git
cd memlens
npm install

# 開発モードで起動 (ホットリロード)
npm run dev

# renderer / main / preload をビルド
npm run build

# Windows インストーラを ./release/ に出力
npm run build:win
```

## 設定

memlens 専用の設定ファイルはありません。Claude Code 本体と同じ環境変数および `settings.json` を参照するため、CLI 側で見えているものがそのままアプリにも反映されます。

環境変数 (プロセス起動時に読み込み):

| 変数                                 | 効果                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`                  | 設定ディレクトリのデフォルト `~/.claude` を上書きします。 |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR`      | memory base dir を上書き (remote / cowork 用)。           |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`    | truthy なら auto memory を OFF / falsy なら強制 ON。      |
| `CLAUDE_CODE_SIMPLE`                 | truthy なら OFF (CLI の `--bare` 相当)。                  |
| `CLAUDE_CODE_REMOTE`                 | truthy かつ `REMOTE_MEMORY_DIR` 未設定なら OFF。          |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | `autoMemoryDirectory` の最優先 override。                 |
| `CLAUDE_SETTINGS_PATH`               | `--settings` 相当のオーバーレイ JSON のパス。             |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH`  | managed-settings ディレクトリ (policy 層) を上書き。      |

設定ファイルの優先順位 (リフレッシュごとに再読み込み):

1. `managed-settings.json` + `managed-settings.d/*.json` (管理者ポリシー)
2. `CLAUDE_SETTINGS_PATH` (flag 層)
3. `~/.claude/settings.json` (user)

memlens が参照するキー: `autoMemoryEnabled` (boolean)、`autoMemoryDirectory` (string、`~/` の展開に対応)。

## npm スクリプト

- `npm run dev` — Electron + Vite の開発サーバを起動
- `npm run build` — 3 つの Vite バンドルをビルド
- `npm run build:win` — ビルド + Windows インストーラ (NSIS) を作成
- `npm run typecheck` — TypeScript project references のチェック
- `npm run lint` / `npm run lint:strict` — oxlint
- `npm run format` / `npm run format:check` — Prettier
- `npm test` — Vitest

## ディレクトリ構成

```
src/
  main/        Electron main プロセス (IPC handler、fs サービス、fs.watch)
  preload/     renderer ↔ main の contextBridge
  renderer/    React UI (3 ペイン、i18n、各種コンポーネント)
  shared/      schemas (zod)、IPC チャネル、契約型
```

## ライセンス

MIT — [LICENSE](./LICENSE) を参照してください。

memlens は独立したサードパーティツールです。Anthropic とは無関係であり、Anthropic による公式の支援を受けたものではありません。
