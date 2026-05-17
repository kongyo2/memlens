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
    readonly openInExplorer: string;
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
    readonly byteUnit: string;
    readonly indexExceededShort: string;
    readonly emptyList: string;
    readonly noMatches: string;
    readonly filterAll: string;
  };
  readonly detail: {
    readonly selectPrompt: string;
    readonly edit: string;
    readonly save: string;
    readonly cancel: string;
    readonly externalEditor: string;
    readonly externalEditorTitle: string;
    readonly askDelete: string;
    readonly confirmDelete: string;
    readonly indexLoadNote: string;
    readonly indexLineUnit: string;
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
