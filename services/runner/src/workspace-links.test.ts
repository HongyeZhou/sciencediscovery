// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { executePython, executeShell } from "./executor.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";

async function fixture(context: TestContext) {
  await mkdir(".tmp", { recursive: true });
  const dataDir = await mkdtemp(resolve(".tmp/workspace-links-"));
  const workspaceRoot = resolve(dataDir, "projects/p/sessions/s/workspace");
  await mkdir(workspaceRoot, { recursive: true });
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, bwrapPath: process.env.SCIENCE_AGENT_BWRAP_PATH || "bwrap", execTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_000_000 };
  const request = { agentId: "main", executionId: "links", workspaceRoot, code: "echo ran > executed",
    permissionEpoch: { id: "epoch", sessionId: "s", createdAt: new Date().toISOString(),
      environmentRevisionId: "system", mounts: [{ source: "workspace" as const, mode: "read-write" as const }],
      networkPolicy: "none" as const, secretRefs: [], reason: "test" } };
  return { dataDir, workspaceRoot, config, request };
}

test("Shell and Python reject host-only and dangling data links before user code", async (context) => {
  const { dataDir, workspaceRoot, config, request } = await fixture(context);
  const outside = resolve(dataDir, "host-data");
  await writeFile(outside, "real data");
  const link = resolve(workspaceRoot, "naturebench_data");
  for (const target of [outside, "../../../../host-data", "missing-data"]) {
    await symlink(target, link);
    for (const execute of [executeShell, executePython]) {
      await assert.rejects(execute(config, { ...request, code: execute === executeShell ? request.code
        : "from pathlib import Path\nPath('executed').touch()" }), /Workspace symlink .*naturebench_data.*not readable in the sandbox.*Copy or upload/);
      await assert.rejects(readFile(resolve(workspaceRoot, "executed")), { code: "ENOENT" });
    }
    await rm(link);
  }
});

test("sandbox-visible absolute, relative, chained and runtime links remain usable", async (context) => {
  const { workspaceRoot, config, request } = await fixture(context);
  await mkdir(resolve(workspaceRoot, "data"));
  await writeFile(resolve(workspaceRoot, "data/values"), "real data");
  await symlink("data", resolve(workspaceRoot, "relative"));
  await symlink("/workspace/relative/values", resolve(workspaceRoot, "absolute"));
  await symlink("absolute", resolve(workspaceRoot, "chain"));
  await symlink("/usr/bin/bash", resolve(workspaceRoot, "bash"));
  const result = await executeShell(config, { ...request, code: "cat chain; ./bash -c 'printf runtime'" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "real dataruntime");
});

test("link names are data and a cyclic link fails without hanging", async (context) => {
  const { workspaceRoot, config, request } = await fixture(context);
  const name = "data '$(touch injected)\nlink";
  await symlink("missing", resolve(workspaceRoot, name));
  await assert.rejects(executeShell(config, request), /Workspace symlink .*not readable in the sandbox/);
  await assert.rejects(readFile(resolve(workspaceRoot, "injected")), { code: "ENOENT" });
  await rm(resolve(workspaceRoot, name));
  await symlink("cycle", resolve(workspaceRoot, "cycle"));
  await assert.rejects(executeShell(config, request), /Workspace symlink .*cycle.*not readable/);
});

test("read-only parent links use the actual nested subagent mount layout", async (context) => {
  const { dataDir, workspaceRoot, config, request } = await fixture(context);
  const child = resolve(workspaceRoot, "subagents/child");
  await mkdir(child, { recursive: true });
  await writeFile(resolve(workspaceRoot, "data"), "parent data");
  await symlink("../../data", resolve(child, "input"));
  const scoped = { ...request, agentId: "child", workspaceRoot: child, readOnlyWorkspaceRoot: workspaceRoot,
    code: "cat input" };
  assert.equal((await executeShell(config, scoped)).stdout, "parent data");
  await symlink(resolve(dataDir, "host-only"), resolve(workspaceRoot, "invalid"));
  await assert.rejects(executeShell(config, scoped), /Workspace symlink .*invalid.*not readable/);
});

test("reused shell sessions recheck links and recover without losing their state", async (context) => {
  const { workspaceRoot, config, request } = await fixture(context);
  const manager = new ShellSessionManager({ ...config, idleTimeoutMs: 0 }, new SessionEnvProfileStore());
  context.after(() => manager.close());
  const persistent = { ...request, kernelMode: "persistent" as const };
  await manager.execute({ ...persistent, code: "export SAVED=kept" });
  await symlink("missing", resolve(workspaceRoot, "input"));
  await assert.rejects(manager.execute(persistent), /Workspace symlink .*input.*not readable/);
  await rm(resolve(workspaceRoot, "input"));
  await writeFile(resolve(workspaceRoot, "input"), "real");
  const result = await manager.execute({ ...persistent, code: "printf '%s ' \"$SAVED\"; cat input" });
  assert.equal(result.stdout, "kept real");
});
