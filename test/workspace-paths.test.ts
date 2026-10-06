import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import {
  workspaceDate,
  datedWorkspace,
} from "../src/server/workspace-paths.ts";
import { git } from "../src/server/git.ts";

test("new workspaces group by local date with short names; persisted legacy paths remain reusable", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const project = f.store.state.project!;
  assert.equal(project.workspaceLayout, "dated");
  assert.equal(
    project.workspaceRoot,
    datedWorkspace(f.data, project, project.createdAt),
  );
  assert.equal(workspaceDate(new Date(2026, 9, 6, 23, 59)), "2026-10-06");
  assert.ok(
    project.integrationPath.includes(
      `${join("workspaces", workspaceDate(project.createdAt))}/repo-`,
    ),
  );
  const head = await git(f.repo, "rev-parse", "HEAD"),
    index = await git(f.repo, "diff", "--cached"),
    branch = await git(f.repo, "branch", "--show-current");
  const agent = f.agent();
  const path = await f.service.work.planningWorkspace(project, agent);
  assert.match(path, /agent-[a-f0-9]{12}-[a-f0-9]{8}$/);
  assert.equal(await f.service.work.planningWorkspace(project, agent), path);
  const legacy = {
    ...project,
    workspaceLayout: undefined,
    workspaceRoot: undefined,
  };
  const oldPath = await f.service.work.planningWorkspace(legacy, agent);
  assert.equal(
    oldPath,
    join(
      f.data,
      "workspaces",
      project.id,
      `agent-${agent}-${project.integratedHead.slice(0, 12)}`,
    ),
  );
  assert.equal(await f.service.work.planningWorkspace(legacy, agent), oldPath);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), head);
  assert.equal(await git(f.repo, "diff", "--cached"), index);
  assert.equal(await git(f.repo, "branch", "--show-current"), branch);
});
