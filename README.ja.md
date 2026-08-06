# memlens

[English README is here](./README.md)

**memlens は [Claude Code](https://www.anthropic.com/claude-code) の auto memory を覗くデスクトップレンズ** — Claude があなた自身・プロジェクト・仕事の進め方について自分用に書き残すメモを見るための道具です。 `~/.claude/projects/<sanitized>/memory/` 配下の markdown 群を 3 ペインの計器盤に載せ、 レビュー・検索・整理・削除をファイルシステムを直接掘らずに行えます。

**Windows / macOS / Linux** 対応。 Electron + React + TypeScript 製。

![feedback memory を読んでいる memlens](./docs/screenshots/reading.png)

## なぜ作ったか

Claude Code は自動でメモリを蓄積します: プロジェクトごとの `MEMORY.md` インデックスと、 型付きの memory ファイル群。 その内容は以後のすべてのセッションに影響しますが、 実体は隠しディレクトリの中にあり、 書いているのは機械です。 memlens は「何が新鮮で、 何が古く、 何が効いていて、 何を消すべきか」を*見える*ようにします。

## 機能

### 閲覧

- **プロジェクトレール** — `~/.claude/projects/` 配下で memory ディレクトリを持つ全プロジェクトを更新順に一覧。 作業ディレクトリに一致するものには `cwd` バッジ。 カスタムディレクトリ (`autoMemoryDirectory`、 cowork override) は `(custom)` 仮想プロジェクトとして表示。
- **鮮度トレース** — 各 memory 行の左端に、 経過時間で減光するトレース。 減光が始まる境界は Claude Code 本体の staleness ルール (2 日以上前の memory はプロンプト内で _point-in-time observation_ と注記される, `src/memdir/memoryAge.ts`) と一致させており、 開いたときも同じ `point-in-time` チップが付きます。
- **タイプ分類** — 公式のメモリタイプ体系そのままの `user` / `feedback` / `project` / `reference` チップ (件数付き) と、 更新順 / 名前順 / サイズ順ソート。
- **ライブリロード** — 選択中 memory ディレクトリを `fs.watch` し、 Claude Code の書き込みへ即追従。

### 検索

- **プロジェクト内検索** — ヘッダの即時フィルタ + debounce 付き本文全文検索 (行番号・抜粋付き)。
- **全プロジェクト横断検索** — `全プロジェクト` スコープに切り替えると、 1 クエリでマシン上の全 memory ディレクトリを横断。 ヒットにはプロジェクト名が付き、 クリックで直接開けます。

![全プロジェクト横断検索](./docs/screenshots/global-search.png)

### 整理

- **ロードバジェット計** — Claude Code が `MEMORY.md` からロードするのは先頭 **200 行 / 25 KB** だけ (`src/memdir/memdir.ts`)。 memlens はその予算に対する現在値を 2 本のゲージで表示します。 Claude Code v2.1.211+ と同じく、 実際にロードされる内容 (frontmatter / ブロック HTML コメント除去後) に対して測定。
- **新規作成** — タイプ別ヒント付きのガイド付きダイアログ。 `feedback` / `project` には公式推奨の本文構造 (\*ルール → **Why:** → **How to apply:\***) を提示。
- **編集** — Write / Preview 切替付きのその場編集。 変更があるときだけ保存が有効 (`Ctrl/Cmd+S`)、 `Esc` でキャンセル。
- **リネーム / 削除** — 安全側に倒した設計: トップレベル `MEMORY.md` はリネームも削除も不可、 既存ファイルへの上書きは拒否、 ファイル名は全 OS で最も厳しい (Windows の) 規則で検証するため、 同期された memory ディレクトリの可搬性が保たれます。
- **パスコピー / 表示** — 絶対パスのコピー、 Explorer / Finder / ファイルマネージャで表示。

![ロードバジェット計付きの MEMORY.md](./docs/screenshots/load-budget.png)

### 設定の透明性

- **設定インスペクタ** — auto memory の解決済み設定と*その根拠* (env 変数 / 組織ポリシー / `--settings` / `~/.claude/settings.json` のどの層が決めたか) を表示。
- **バイリンガル UI** — 日本語 / English をワンクリックで切替。

## インストール

[Releases](https://github.com/kongyo2/memlens/releases) から OS に合ったビルドを取得してください:

| OS      | 成果物                           | 補足                                                                                                 |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Windows | `memlens-Setup-<version>.exe`    | per-user NSIS インストーラ。 管理者権限不要。 未署名のため SmartScreen 警告時は「詳細情報 → 実行」。 |
| macOS   | `memlens-<version>-<arch>.dmg`   | 未署名: 初回は右クリック → 開く、 または `xattr -cr /Applications/memlens.app`。                     |
| Linux   | `memlens-<version>-x64.AppImage` | `chmod +x` して実行。 Debian/Ubuntu 向けに `.deb` も配布。                                           |

memlens の動作には auto memory が有効な Claude Code 環境が必要です — Claude Code が管理するディレクトリ以外には読み書きしません。

## キーボードショートカット

| ショートカット | 動作                                |
| -------------- | ----------------------------------- |
| `Ctrl/Cmd + F` | 検索へフォーカス                    |
| `Ctrl/Cmd + N` | 新規 memory                         |
| `Ctrl/Cmd + R` | 再読込                              |
| `Ctrl/Cmd + S` | 保存 (編集中)                       |
| `Esc`          | 編集キャンセル / ダイアログを閉じる |

## auto memory の仕組み (かんたんな入門)

- 各プロジェクトのメモリは `~/.claude/projects/<project>/memory/` にあります。 `<project>` は canonical な git root (worktree は 1 つに集約) から導出され、 ファイルシステム安全な形に sanitize されます (200 文字超はハッシュ接尾辞付き)。
- `MEMORY.md` がインデックスで、 毎セッション読み込まれます (200 行 / 25 KB で打ち切り)。
- 個々の memory は `name` / `description` / `type` frontmatter を持つ markdown。 4 タイプはリポジトリから*導出できない*文脈を保持します: あなた自身 (`user`)、 もらった指針 (`feedback`)、 進行中の作業 (`project`)、 外部システムへのポインタ (`reference`)。
- メモリは古びます: 2 日以上前のものは point-in-time observation として注記されます。

memlens はこれらすべて (パス sanitize、 インデックス上限、 タイプ解釈、 staleness) を公式実装と揃えているため、 見えているものは Claude Code が見ているものと同じです。 詳細は公式の [memory ドキュメント](https://code.claude.com/docs/en/memory) を参照してください。

## 設定

memlens 自身の設定ファイルはありません — Claude Code と同じ env 変数と `settings.json` を読むため、 CLI に見えているものがそのままアプリにも見えます。

環境変数 (プロセス起動時に読み取り):

| 変数                                 | 効果                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`                  | config home (`~/.claude`) を上書き。                     |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR`      | memory base dir を上書き (remote / cowork 用)。          |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`    | truthy → auto-memory OFF; falsy → 強制 ON。              |
| `CLAUDE_CODE_SIMPLE`                 | truthy → auto-memory OFF (CLI `--bare` 相当)。           |
| `CLAUDE_CODE_REMOTE`                 | truthy かつ `REMOTE_MEMORY_DIR` 無し → auto-memory OFF。 |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | `autoMemoryDirectory` の最優先 override。                |
| `CLAUDE_SETTINGS_PATH`               | `--settings` 相当の overlay JSON へのパス。              |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH`  | managed-settings ディレクトリ (`policy` 層) を上書き。   |

settings ファイルの優先順 (リフレッシュごとに再読込):

1. `managed-settings.json` + `managed-settings.d/*.json` (組織ポリシー)
2. `CLAUDE_SETTINGS_PATH` (`flag` 層)
3. `~/.claude/settings.json` (user)

memlens が読むキー: `autoMemoryEnabled` (boolean)、 `autoMemoryDirectory` (string、 `~/` 展開対応)。

## 開発

要件: Node.js **>= 20.10** (22 LTS 推奨 — Electron 42 のツーリングが要求)。

```sh
git clone https://github.com/kongyo2/memlens.git
cd memlens
npm ci

npm run dev          # Electron + Vite dev サーバ (ホットリロード)
npm test             # Vitest (一発実行は -- --run)
npm run typecheck    # TypeScript project references
npm run lint:strict  # oxlint (warning もエラー扱い)
npm run format       # Prettier

npm run build        # renderer/main/preload をビルド
npm run build:win    # Windows インストーラを ./release/ に生成
npm run build:mac    # macOS dmg/zip (arm64 + x64)
npm run build:linux  # AppImage + deb
```

### プロジェクト構成

```
src/
  main/        Electron main プロセス
    services/  設定解決、 memory fs 操作、 検索、 watcher、
               git-root 正規化、 パス sanitize
    ipc/       ipcMain ハンドラ (境界で入力検証)
  preload/     contextBridge — renderer ↔ main の唯一の橋
  renderer/    React UI (3 ペイン、 i18n en/ja、 components)
  shared/      zod スキーマ、 IPC チャネル名、 API contract 型
```

セキュリティ方針: renderer は型付き preload API 経由でしかファイルシステムに触れず、 すべてのパスは main プロセス側で許可された memory root 配下か検証されます。 本番ビルドには厳格な CSP を注入し、 外部リンクは http/https/mailto のみシステムブラウザで開きます。

### リリース手順

`Actions → Release → Run workflow` でバージョン (例: `v0.3.0`) を入力。 ワークフローは **Windows / macOS / Linux** の 3 OS で lint・型チェック・テストを実行してから全プラットフォームをパッケージし、 全成果物付きの GitHub Release を発行します。 CI も毎 PR で同じ 3 OS テストマトリクスを回します。

## ライセンス

MIT — [LICENSE](./LICENSE) を参照。

memlens は独立したサードパーティツールであり、 Anthropic とは無関係で、 承認も受けていません。 "Claude" および "Claude Code" は Anthropic, PBC の商標です。
