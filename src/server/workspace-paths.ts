import { basename, join } from "node:path";
import type { Project } from "../shared/types.ts";

/** Local calendar dates match Finder; saved paths remain authoritative on restart. */
export function workspaceDate(value: string | Date) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function datedWorkspace(
  dataDir: string,
  project: Pick<Project, "id" | "root">,
  at: string | Date,
) {
  const name =
    basename(project.root)
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "project";
  return join(
    dataDir,
    "workspaces",
    workspaceDate(at),
    `${name}-${project.id.replaceAll("-", "").slice(0, 12)}`,
  );
}
export function workspaceRoot(dataDir: string, project: Project) {
  return project.workspaceRoot ?? join(dataDir, "workspaces", project.id);
}
export function workspaceId(id: string) {
  return id.replaceAll("-", "").slice(0, 12);
}
