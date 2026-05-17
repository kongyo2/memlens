import * as React from "react";

import type { MemorySettings } from "@shared/api/contract.ts";

type Props = {
  readonly settings: MemorySettings | null;
  readonly onClose: () => void;
};

const ENABLED_REASON: Record<MemorySettings["enabledSource"], string> = {
  "env-disable": "env CLAUDE_CODE_DISABLE_AUTO_MEMORY が値を持つため",
  "env-simple": "env CLAUDE_CODE_SIMPLE (--bare) が ON のため",
  "env-remote":
    "env CLAUDE_CODE_REMOTE が ON で REMOTE_MEMORY_DIR 未設定のため",
  settings: "settings.json の autoMemoryEnabled を採用",
  default: "デフォルト (env も settings も未指定)",
};

export function SettingsPanel(props: Props): React.ReactElement {
  const { settings, onClose } = props;
  return (
    <dialog
      className="modal-backdrop"
      open
      aria-labelledby="settings-modal-title"
    >
      <div className="modal settings-modal">
        <h3 id="settings-modal-title">auto memory 設定</h3>
        {settings ? (
          <dl className="settings-dl">
            <dt>有効 / 無効</dt>
            <dd>
              <span className={settings.enabled ? "ok" : "warn"}>
                {settings.enabled ? "ON" : "OFF"}
              </span>
              <small>{ENABLED_REASON[settings.enabledSource]}</small>
            </dd>
            <dt>baseDir</dt>
            <dd>
              <code>{settings.baseDir}</code>
              <small>
                {settings.remoteMemoryDir
                  ? "CLAUDE_CODE_REMOTE_MEMORY_DIR で上書き"
                  : "デフォルト (~/.claude)"}
              </small>
            </dd>
            <dt>autoMemoryDirectory</dt>
            <dd>
              {settings.autoMemoryDirectory ? (
                <>
                  <code>{settings.autoMemoryDirectory}</code>
                  <small>
                    source: {settings.autoMemoryDirectorySource ?? "?"} settings
                  </small>
                </>
              ) : (
                <small>未設定 (projects/&lt;sanitized&gt;/memory を使用)</small>
              )}
            </dd>
            <dt>homedir</dt>
            <dd>
              <code>{settings.homedir}</code>
            </dd>
          </dl>
        ) : (
          <p>読み込み中…</p>
        )}
        <p className="modal-hint">
          設定の変更は <code>~/.claude/settings.json</code>{" "}
          を直接編集してください。
        </p>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}
