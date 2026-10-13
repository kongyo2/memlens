import type { MemorySettings, ValueOrigin } from "@shared/api/contract.ts";
import * as React from "react";

import { useTranslation } from "../i18n/index.ts";
import type { Dict } from "../i18n/index.ts";

type Props = {
  readonly settings: MemorySettings | null;
  readonly onClose: () => void;
};

function reasonFor(source: MemorySettings["enabledSource"], t: Dict): string {
  switch (source) {
    case "env-safe-mode":
      return t.settings.reasons.envSafeMode;
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

function autoMemSourceLabel(
  source: NonNullable<MemorySettings["autoMemoryDirectorySource"]>,
  t: Dict,
): string {
  switch (source) {
    case "cowork":
      return t.settings.sources.cowork;
    case "policy":
      return t.settings.sources.policy;
    case "flag":
      return t.settings.sources.flag;
    case "user":
      return t.settings.sources.user;
  }
}

/** 環境変数がどこで設定されたか (起動環境 / settings の env ブロック)。 */
function envOriginLabel(origin: ValueOrigin, t: Dict): string {
  return t.settings.origins[origin];
}

/** settings キーがどの層から来たか。 */
function settingsLayerLabel(origin: ValueOrigin, t: Dict): string {
  return origin === "shell" ? t.settings.origins.shell : t.settings.sources[origin];
}

export function SettingsPanel(props: Props): React.ReactElement {
  const { settings, onClose } = props;
  const { t } = useTranslation();
  const enabledOrigin =
    settings?.enabledOrigin == null
      ? null
      : settings.enabledSource === "settings"
        ? settingsLayerLabel(settings.enabledOrigin, t)
        : envOriginLabel(settings.enabledOrigin, t);
  return (
    <dialog className="modal-backdrop" open aria-labelledby="settings-modal-title">
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
              {enabledOrigin ? (
                <small>
                  {t.settings.originLabel} {enabledOrigin}
                </small>
              ) : null}
            </dd>
            <dt>{t.settings.configDirLabel}</dt>
            <dd>
              <code>{settings.configDir}</code>
            </dd>
            <dt>{t.settings.baseDirLabel}</dt>
            <dd>
              <code>{settings.baseDir}</code>
              <small>
                {settings.remoteMemoryDir ? t.settings.remoteOverride : t.settings.defaultBaseDir}
              </small>
            </dd>
            <dt>{t.settings.autoMemDirLabel}</dt>
            <dd>
              {settings.autoMemoryDirectory ? (
                <>
                  <code>{settings.autoMemoryDirectory}</code>
                  <small>
                    {t.settings.sourceLabel}{" "}
                    {settings.autoMemoryDirectorySource
                      ? autoMemSourceLabel(settings.autoMemoryDirectorySource, t)
                      : "?"}
                  </small>
                  {settings.autoMemoryDirectoryOrigin ? (
                    <small>
                      {t.settings.originLabel}{" "}
                      {envOriginLabel(settings.autoMemoryDirectoryOrigin, t)}
                    </small>
                  ) : null}
                </>
              ) : (
                <small>{t.settings.autoMemUnset}</small>
              )}
            </dd>
            {settings.projectDirName ? (
              <>
                <dt>{t.settings.projectDirNameLabel}</dt>
                <dd>
                  <code>{settings.projectDirName}</code>
                  <small>{t.settings.projectDirNameNote}</small>
                </dd>
              </>
            ) : null}
            <dt>{t.settings.policyLabel}</dt>
            <dd>
              {settings.policySource ? (
                <code>{t.settings.policySources[settings.policySource]}</code>
              ) : (
                <small>{t.settings.policyNone}</small>
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
