import * as React from "react";

import type { MemoryProject } from "@shared/api/contract.ts";

import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly projects: readonly MemoryProject[];
  readonly selected: MemoryProject | null;
  readonly currentProject: MemoryProject | null;
  readonly onSelect: (project: MemoryProject) => void;
};

export function ProjectList(props: Props): React.ReactElement {
  const { projects, selected, currentProject, onSelect } = props;
  const { t } = useTranslation();
  if (projects.length === 0) {
    return <p className="empty">{t.projectList.empty}</p>;
  }
  return (
    <ul className="project-list">
      {projects.map((p) => (
        <ProjectListItem
          key={p.name}
          project={p}
          active={p.name === selected?.name}
          isCurrent={p.name === currentProject?.name}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

type ItemProps = {
  readonly project: MemoryProject;
  readonly active: boolean;
  readonly isCurrent: boolean;
  readonly onSelect: (project: MemoryProject) => void;
};

const ProjectListItem = React.memo(function ProjectListItem(
  props: ItemProps,
): React.ReactElement {
  const { project, active, isCurrent, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(project);
  }, [onSelect, project]);
  const className = active ? "active" : isCurrent ? "current" : "";
  const label = project.decodedProjectPath ?? project.name;
  const fileCountLabel = `${String(project.fileCount)} ${t.projectList.filesSuffix}`;
  const indexSuffix = project.hasIndex ? ` · ${t.projectList.indexBadge}` : "";
  // sanitized 名と memoryDir を併記して、 hover で確実に「実体ディレクトリ」を
  // 見せる。 sanitize は破壊的なので decodedProjectPath は best-effort であり、
  // 信頼できる手掛かりは memoryDir そのもの。
  const tooltip = `${project.name}\n${project.memoryDir}`;
  return (
    <li>
      <button
        type="button"
        className={className}
        onClick={handleClick}
        title={tooltip}
      >
        <span className="project-name">
          <span className="project-label">{label}</span>
          {isCurrent ? (
            <span className="badge">{t.projectList.currentBadge}</span>
          ) : null}
        </span>
        <span className="project-encoded">
          {fileCountLabel}
          {indexSuffix}
        </span>
      </button>
    </li>
  );
});
