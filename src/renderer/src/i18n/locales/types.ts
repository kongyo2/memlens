/**
 * 多言語辞書の型。両 locale はこれと同じ shape である必要がある。
 *
 * 数値や bytes 埋め込みは callsite 側で template string を組む方針なので、
 * すべての leaf 値は plain string。
 */
export type Dict = {
  readonly app: {
    readonly projects: string;
    readonly refresh: string;
    readonly openSettings: string;
    readonly selectProject: string;
    /** platform 別の「ファイルマネージャで表示」ラベル。 */
    readonly revealWin: string;
    readonly revealMac: string;
    readonly revealLinux: string;
    readonly closeError: string;
    readonly disabledNote: string;
    readonly seeReason: string;
    readonly switchLanguage: string;
  };
  readonly projectList: {
    readonly empty: string;
    readonly filesSuffix: string;
    readonly indexBadge: string;
    readonly currentBadge: string;
  };
  readonly memoryList: {
    readonly searchPlaceholder: string;
    readonly searchAriaLabel: string;
    readonly newButton: string;
    readonly newTooltip: string;
    readonly indexNotCreated: string;
    readonly indexLineUnit: string;
    readonly indexExceededShort: string;
    readonly emptyList: string;
    readonly noMatches: string;
    readonly filterAll: string;
    /** 検索 query 入力時に表示する body 全文一致セクションのタイトル。 */
    readonly bodyHitsLabel: string;
    readonly bodySearching: string;
    /** 全プロジェクト横断検索の結果セクションタイトル。 */
    readonly globalHitsLabel: string;
    /** 検索スコープ切替チップ (「全プロジェクト」)。 */
    readonly scopeAll: string;
    /** sort segmented control のラベル。 */
    readonly sortAria: string;
    readonly sortRecency: string;
    readonly sortName: string;
    readonly sortSize: string;
  };
  readonly detail: {
    readonly selectPrompt: string;
    /** placeholder に添えるキーボードショートカットの説明 (動詞部分)。 */
    readonly shortcutSearch: string;
    readonly shortcutNew: string;
    readonly shortcutReload: string;
    readonly edit: string;
    readonly save: string;
    readonly cancel: string;
    readonly externalEditor: string;
    readonly externalEditorTitle: string;
    readonly askDelete: string;
    readonly confirmDelete: string;
    readonly rename: string;
    readonly renameTitle: string;
    readonly renameFilenameLabel: string;
    readonly renameHint: string;
    readonly renameSubmit: string;
    readonly renameSubmitting: string;
    readonly copyPath: string;
    readonly copied: string;
    /** 編集モードの Write / Preview タブ。 */
    readonly write: string;
    readonly preview: string;
    /**
     * 公式 memoryFreshnessText (src/memdir/memoryAge.ts:33) が 2 日以上前の
     * memory に付ける staleness 注記の UI 表現。
     */
    readonly staleChip: string;
    readonly staleTitle: string;
    readonly indexLoadNote: string;
    readonly indexLineUnit: string;
    /** MEMORY.md ロードバジェット計のタイトル。 */
    readonly budgetTitle: string;
  };
  readonly create: {
    readonly title: string;
    readonly memoryDirLabel: string;
    readonly name: string;
    readonly description: string;
    readonly type: string;
    readonly filename: string;
    readonly body: string;
    readonly namePlaceholder: string;
    readonly descPlaceholder: string;
    readonly bodyPlaceholder: string;
    /**
     * feedback / project type で公式が推奨する本文構造
     * (src/memdir/memoryTypes.ts の body_structure) のヒント。
     */
    readonly bodyStructureHint: string;
    readonly filenameHintPrefix: string;
    readonly nameAria: string;
    readonly descAria: string;
    readonly typeAria: string;
    readonly filenameAria: string;
    readonly bodyAria: string;
    readonly errorNameRequired: string;
    readonly errorDescRequired: string;
    readonly submit: string;
    readonly submitting: string;
    /**
     * 各 memory type が「何を入れるべきか」の 1 行ガイド。 公式
     * src/memdir/memoryTypes.ts の type 説明を要約したもの。 type select の
     * 下に小さく表示して、 最初に何を書けばよいかの当たりを付けやすくする。
     */
    readonly typeHints: {
      readonly user: string;
      readonly feedback: string;
      readonly project: string;
      readonly reference: string;
    };
  };
  readonly settings: {
    readonly title: string;
    readonly enabledLabel: string;
    readonly baseDirLabel: string;
    readonly autoMemDirLabel: string;
    readonly homedirLabel: string;
    readonly on: string;
    readonly off: string;
    readonly remoteOverride: string;
    readonly defaultBaseDir: string;
    readonly sourceLabel: string;
    readonly autoMemUnset: string;
    readonly loading: string;
    readonly editHint: string;
    readonly close: string;
    readonly reasons: {
      readonly envDisable: string;
      readonly envSimple: string;
      readonly envRemote: string;
      readonly settings: string;
      readonly default: string;
    };
    readonly sources: {
      readonly cowork: string;
      readonly policy: string;
      readonly flag: string;
      readonly user: string;
    };
  };
  readonly age: {
    readonly today: string;
    readonly yesterday: string;
    /** "{n} days ago" / "{n} 日前" 形式の prefix を入れた完全な suffix。 */
    readonly daysAgoSuffix: string;
  };
};
