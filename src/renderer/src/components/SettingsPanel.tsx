import * as React from "react";

import type { MemorySettings } from "@shared/api/contract.ts";

import { useTranslation } from "../i18n/index.ts";
import type { Dict } from "../i18n/index.ts";

type Props = {
  readonly settings: MemorySettings | null;
  readonly onClose: () => void;
};

function reasonFor(source: MemorySettings["enabledSource"], t: Dict): string {
  switch (source) {
    case "env-disable":
      return t.settings.reasons.envDisable;
    case "env-simple":
      return t.settings.reasons.envSimple;
    case "env-remote":
      return t.settings.reasons.envRemote;
    case "settings":
      return t.settings.reasons.settings;
    case "default":
      return t.settings.reasons.default;
  }
}

export function SettingsPanel(props: Props): React.ReactElement {
  const { settings, onClose } = props;
  const { t } = useTranslation();
  return (
    <dialog
      className="modal-backdrop"
      open
      aria-labelledby="settings-modal-title"
    >
      <div className="modal settings-modal">
        <h3 id="settings-modal-title">{t.settings.title}</h3>
        {settings ? (
          <dl className="settings-dl">
            <dt>{t.settings.enabledLabel}</dt>
            <dd>
              <span className={settings.enabled ? "ok" : "warn"}>
                {settings.enabled ? t.settings.on : t.settings.off}
              </span>
              <small>{reasonFor(settings.enabledSource, t)}</small>
            </dd>
            <dt>{t.settings.baseDirLabel}</dt>
            <dd>
              <code>{settings.baseDir}</code>
              <small>
                {settings.remoteMemoryDir
                  ? t.settings.remoteOverride
                  : t.settings.defaultBaseDir}
              </small>
            </dd>
            <dt>{t.settings.autoMemDirLabel}</dt>
            <dd>
              {settings.autoMemoryDirectory ? (
                <>
                  <code>{settings.autoMemoryDirectory}</code>
                  <small>
                    {t.settings.sourceLabel}{" "}
                    {settings.autoMemoryDirectorySource ?? "?"}{" "}
                    {t.settings.settingsWord}
                  </small>
                </>
              ) : (
                <small>{t.settings.autoMemUnset}</small>
              )}
            </dd>
            <dt>{t.settings.homedirLabel}</dt>
            <dd>
              <code>{settings.homedir}</code>
            </dd>
          </dl>
        ) : (
          <p>{t.settings.loading}</p>
        )}
        <p className="modal-hint">{t.settings.editHint}</p>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t.settings.close}
          </button>
        </div>
      </div>
    </dialog>
  );
}
