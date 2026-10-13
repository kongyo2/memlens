import type { MemoryProject } from "@shared/api/contract.ts";
import * as React from "react";

import { formatFileCount, useTranslation } from "../i18n/index.ts";

type Props = {
  readonly projects: readonly MemoryProject[];
  readonly selected: MemoryProject | null;
  readonly currentProject: MemoryProject | null;
  readonly onSelect: (project: MemoryProject) => void;
};

/**
 * 左 rail。 auto memory のプロジェクト (custom dir を含む) と、 user スコープの
 * サブエージェント memory (~/.claude/agent-memory/<agent>/) を分けて並べる。
 */
export function ProjectList(props: Props): React.ReactElement {
  const { projects, selected, currentProject, onSelect } = props;
  const { t } = useTranslation();
  const { main, agents } = React.useMemo(
    () => ({
      main: projects.filter((p) => p.kind !== "agent"),
      agents: projects.filter((p) => p.kind === "agent"),
    }),
    [projects],
  );
  return (
    <div className="project-groups">
      {main.length === 0 ? (
        <p className="empty">{t.projectList.empty}</p>
      ) : (
        <ul className="project-list">
          {main.map((p) => (
            <ProjectListItem
              key={p.name}
              project={p}
              active={p.name === selected?.name}
              isCurrent={p.name === currentProject?.name}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {agents.length > 0 ? (
        <>
          <span className="eyebrow group-head">{t.app.agentMemory}</span>
          <ul className="project-list">
            {agents.map((p) => (
              <ProjectListItem
                key={p.name}
                project={p}
                active={p.name === selected?.name}
                isCurrent={false}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

type ItemProps = {
  readonly project: MemoryProject;
  readonly active: boolean;
  readonly isCurrent: boolean;
  readonly onSelect: (project: MemoryProject) => void;
};

const ProjectListItem = React.memo(function ProjectListItem(props: ItemProps): React.ReactElement {
  const { project, active, isCurrent, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(project);
  }, [onSelect, project]);
  const className = active ? "active" : isCurrent ? "current" : "";
  const label = project.decodedProjectPath ?? project.displayName;
  const fileCountLabel = formatFileCount(t, project.fileCount);
  const indexSuffix = project.hasIndex ? ` · ${t.projectList.indexBadge}` : "";
  // sanitized 名と memoryDir を併記して、 hover で確実に「実体ディレクトリ」を
  // 見せる。 パスの出どころ (transcript で確認済みか、 名前からの推測か) も添える。
  const provenance =
    project.kind === "agent"
      ? t.projectList.agentTooltip
      : project.projectPathSource === "transcript"
        ? t.projectList.pathFromTranscript
        : project.projectPathSource === "guess"
          ? t.projectList.pathGuessed
          : null;
  const tooltip = [project.name, project.memoryDir, provenance]
    .filter((line): line is string => line !== null)
    .join("\n");
  const labelClass =
    project.projectPathSource === "guess" ? "project-label guessed" : "project-label";
  return (
    <li>
      <button type="button" className={className} onClick={handleClick} title={tooltip}>
        <span className="project-name">
          <span className={labelClass}>{label}</span>
          {isCurrent ? <span className="badge">{t.projectList.currentBadge}</span> : null}
        </span>
        <span className="project-encoded">
          {fileCountLabel}
          {indexSuffix}
        </span>
      </button>
    </li>
  );
});
