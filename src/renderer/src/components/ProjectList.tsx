import * as React from "react";

import type { MemoryProject } from "@shared/api/contract.ts";

type Props = {
  readonly projects: readonly MemoryProject[];
  readonly selected: MemoryProject | null;
  readonly currentProject: MemoryProject | null;
  readonly onSelect: (project: MemoryProject) => void;
};

export function ProjectList(props: Props): React.ReactElement {
  const { projects, selected, currentProject, onSelect } = props;
  if (projects.length === 0) {
    return (
      <p className="empty">
        ~/.claude/projects/ 配下に memory
        ディレクトリを持つプロジェクトが見つかりません。
      </p>
    );
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
  const handleClick = React.useCallback(() => {
    onSelect(project);
  }, [onSelect, project]);
  const className = active ? "active" : isCurrent ? "current" : "";
  const label = project.decodedProjectPath ?? project.name;
  return (
    <li>
      <button
        type="button"
        className={className}
        onClick={handleClick}
        title={project.name}
      >
        <span className="project-name">
          {label}
          {isCurrent ? <span className="badge">cwd</span> : null}
        </span>
        <span className="project-encoded">
          {String(project.fileCount)} files
          {project.hasIndex ? " · MEMORY.md" : ""}
        </span>
      </button>
    </li>
  );
});
