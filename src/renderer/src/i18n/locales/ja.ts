import type { Dict } from "./types.ts";

/**
 * 日本語辞書。
 *
 * 数値や bytes 等の埋め込みは呼び出し側で template string を組む方針 (関数値は使わない)。
 * 単位 (行 / bytes など) は別キーで提供する。
 */
export const ja: Dict = {
  app: {
    projects: "プロジェクト",
    refresh: "再読込",
    openSettings: "auto memory 設定を表示",
    selectProject: "プロジェクトを選択",
    openInExplorer: "Explorer で開く",
    closeError: "エラーを閉じる",
    disabledNote: "auto memory が OFF です。",
    seeReason: "理由を見る",
    switchLanguage: "Language",
  },
  projectList: {
    empty:
      "~/.claude/projects/ 配下に memory ディレクトリを持つプロジェクトが見つかりません。",
    filesSuffix: "ファイル",
    indexBadge: "MEMORY.md",
    currentBadge: "cwd",
  },
  memoryList: {
    searchPlaceholder: "検索 (ファイル名 / name / description / 本文)",
    searchAriaLabel: "memory 検索",
    newButton: "+ 新規",
    newTooltip: "新規 memory を作成",
    indexNotCreated: "未作成",
    indexLineUnit: "行",
    byteUnit: "bytes",
    indexExceededShort: "上限超過",
    emptyList: "memory ファイルなし",
    noMatches: "該当する memory が見つかりません",
    filterAll: "all",
    bodyHitsLabel: "本文一致",
    bodySearching: "検索中…",
  },
  detail: {
    selectPrompt: "左でプロジェクトを、中央で memory を選択してください。",
    edit: "編集",
    save: "保存",
    cancel: "キャンセル",
    externalEditor: "外部エディタ",
    externalEditorTitle: "既定のエディタで開く",
    askDelete: "削除",
    confirmDelete: "本当に削除",
    indexLoadNote: "上限超過 (Claude Code は先頭 200 行 / 25 KB のみロード)",
    indexLineUnit: "行",
  },
  create: {
    title: "新規 memory を作成",
    memoryDirLabel: "memoryDir:",
    name: "name",
    description: "description",
    type: "type",
    filename: "filename",
    body: "body",
    namePlaceholder: "例: user-deep-go-experience",
    descPlaceholder: "一行で memory の内容を説明",
    bodyPlaceholder: "memory 本文 (markdown)",
    filenameHintPrefix: "実際の保存名:",
    nameAria: "memory name",
    descAria: "memory description",
    typeAria: "memory type",
    filenameAria: "memory filename",
    bodyAria: "memory body",
    errorNameRequired: "name は必須です",
    errorDescRequired: "description は必須です",
    submit: "作成",
    submitting: "作成中…",
    typeHints: {
      user: "ユーザ自身の属性 — 役割、専門、進め方。 応答を相手に合わせるために使う。",
      feedback:
        "訂正 (やめて / 違う) や肯定 (それで OK) から学んだルール。 **理由 (Why)** を必ず添える。",
      project:
        "コードや git log から導けない案件文脈 — 期限、決定、インシデント。 鮮度が落ちやすい。",
      reference:
        "外部システムへのポインタ (Linear プロジェクト、 Slack channel、 dashboard)。",
    },
  },
  settings: {
    title: "auto memory 設定",
    enabledLabel: "有効 / 無効",
    baseDirLabel: "baseDir",
    autoMemDirLabel: "autoMemoryDirectory",
    homedirLabel: "homedir",
    on: "ON",
    off: "OFF",
    remoteOverride: "CLAUDE_CODE_REMOTE_MEMORY_DIR で上書き",
    defaultBaseDir: "デフォルト (~/.claude)",
    sourceLabel: "source:",
    autoMemUnset: "未設定 (projects/<sanitized>/memory を使用)",
    loading: "読み込み中…",
    editHint:
      "設定を変更するには ~/.claude/settings.json を直接編集してください。",
    close: "閉じる",
    reasons: {
      envDisable: "env CLAUDE_CODE_DISABLE_AUTO_MEMORY が値を持つため",
      envSimple: "env CLAUDE_CODE_SIMPLE (--bare) が ON のため",
      envRemote:
        "env CLAUDE_CODE_REMOTE が ON で REMOTE_MEMORY_DIR 未設定のため",
      settings: "settings.json の autoMemoryEnabled を採用",
      default: "デフォルト (env も settings も未指定)",
    },
    sources: {
      cowork: "env CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
      policy: "managed-settings.json (組織ポリシー)",
      flag: "--settings ファイル (CLAUDE_SETTINGS_PATH)",
      user: "~/.claude/settings.json",
    },
  },
  age: {
    today: "今日",
    yesterday: "昨日",
    daysAgoSuffix: "日前",
  },
};
