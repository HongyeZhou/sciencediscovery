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

/**
 * E2E-META: Import real task data, observe an actionable rejection for a host
 * symlink, then materialize it and finish the computation through Runner HTTP.
 * Run: node test/api/workspace-data-visibility-journey.mjs
 * Requires Linux, bubblewrap, Node and a build of the committed checkout.
 * Uses the production Runner CLI, private loopback port/token and isolated data.
 * No model or external service, credentials, paid calls or user data.
 * Reports all outcomes under .tmp/workspace-data-visibility-<id>/report.md.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RunnerClient } from "../../packages/executor/dist/runner-client.js";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = resolve(".tmp", `workspace-data-visibility-${randomUUID()}`);
const data = resolve(root, "data");
const workspace = resolve(data, "projects/project/sessions/session/workspace");
const source = resolve(root, "host-data");
const token = randomUUID();
const steps = [];
let child, origin, client;
let log = "";
let verdict = "FAIL";
const redact = (value) => String(value).replaceAll(token, "[redacted]");
async function step(name, expected, action) {
  try {
    const actual = await action();
    steps.push({ name, expected, actual: actual ?? "PASS", verdict: "PASS" });
  } catch (error) {
    steps.push({ name, expected, actual: redact(error.stack ?? error), verdict: "FAIL" });
    throw error;
  }
}
function request(code) {
  return { executionId: randomUUID(), agentId: "main", code, workspaceRoot: workspace,
    permissionEpoch: { id: "visibility-epoch", sessionId: "session", createdAt: new Date().toISOString(),
      environmentRevisionId: "audit-only", mounts: [{ source: "workspace", mode: "read-write" }],
      networkPolicy: "none", secretRefs: [], reason: "journey" } };
}
try {
  await step("1. Start an isolated Runner and stage task data", "Production CLI is healthy; host data exists", async () => {
    if (process.platform !== "linux") throw new Error("BLOCKED: requires Linux bubblewrap");
    await mkdir(workspace, { recursive: true });
    await mkdir(source);
    await writeFile(resolve(source, "values.txt"), "2\n3\n");
    child = spawn(process.execPath, ["services/runner/dist/server.js"], { stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, SCIENCE_AGENT_DATA_DIR: data, SCIENCE_AGENT_RUNNER_PORT: "0",
        SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_TOKEN: token,
        SCIENCE_AGENT_NPU_BROKER: "0", SCIENTIFIC_ENVS: "0" } });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      log += redact(chunk.toString());
      origin ??= chunk.toString().match(/runner listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    const deadline = Date.now() + 30_000;
    while (!origin) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`BLOCKED: Runner startup: ${log}`);
      await new Promise((done) => setTimeout(done, 25));
    }
    client = new RunnerClient(origin, token);
    assert.equal((await client.health()).status, "ok");
    return "Runner health OK; isolated data and port";
  });
  await step("2. Submit computation with an absolute host data symlink", "Reject before code runs, naming the link and how to import data", async () => {
    await symlink(source, resolve(workspace, "naturebench_data"));
    const code = "if [ -r naturebench_data/values.txt ]; then cat naturebench_data/values.txt; else echo SYNTHETIC_FALLBACK; fi; touch executed";
    let outcome;
    try { outcome = await client.executeShell(request(code)); } catch (error) { outcome = error.message; }
    assert.equal(typeof outcome, "string", `Expected preflight rejection, got ${JSON.stringify(outcome)}`);
    assert.match(outcome, /naturebench_data/);
    assert.match(outcome, /symlink.*sandbox|sandbox.*symlink/i);
    assert.match(outcome, /copy|upload|workspace_transfer/i);
    await assert.rejects(readFile(resolve(workspace, "executed")), { code: "ENOENT" });
    return outcome;
  });
  await step("3. Submit Python and background work with the same invalid input", "Both reject; background failure is queryable without running code", async () => {
    await assert.rejects(client.execute(request("from pathlib import Path\nPath('python-executed').touch()")), /Workspace symlink .*naturebench_data.*not readable/);
    const input = request("touch background-executed");
    const accepted = await client.startShellExecution(input);
    const owner = { sessionId: "session", agentId: "main" };
    let execution;
    const deadline = Date.now() + 15_000;
    do {
      execution = await client.getShellExecution(accepted.id, owner);
      if (!["queued", "running"].includes(execution.state)) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for background rejection");
      await new Promise((done) => setTimeout(done, 25));
    } while (true);
    assert.equal(execution.state, "failed");
    assert.match(execution.error, /Workspace symlink .*naturebench_data.*not readable/);
    for (const name of ["python-executed", "background-executed"]) {
      await assert.rejects(readFile(resolve(workspace, name)), { code: "ENOENT" });
    }
    return `Python rejected; background state: ${execution.state}; ${execution.error}`;
  });
  await step("4. Materialize data and run the real computation", "Same workspace recovers and produces result 5", async () => {
    await rm(resolve(workspace, "naturebench_data"));
    await cp(source, resolve(workspace, "nb_data"), { recursive: true });
    await symlink("nb_data", resolve(workspace, "naturebench_data"));
    const result = await client.executeShell(request("awk '{sum += $1} END {print sum}' naturebench_data/values.txt > result.txt; cat result.txt"));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "5");
    assert.equal((await readFile(resolve(workspace, "result.txt"), "utf8")).trim(), "5");
    return "Relative symlink readable; real output persisted: 5";
  });
  await step("5. Reuse the workspace from Python", "Python reads the same data and records the real result", async () => {
    const result = await client.execute(request("from pathlib import Path\np = Path('naturebench_data/values.txt')\nvalue = sum(map(int, p.read_text().split()))\nPath('python-result.txt').write_text(str(value))\nprint(value)"));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "5");
    assert.equal(await readFile(resolve(workspace, "python-result.txt"), "utf8"), "5");
    return "Python real-data output: 5";
  });
  verdict = "PASS";
} catch (error) {
  if (String(error).includes("BLOCKED:")) verdict = "BLOCKED";
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  }
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "report.md"), `# Workspace data visibility: ${verdict}\n\nSHA: ${sha}\nStartup: node services/runner/dist/server.js\nDriver: node test/api/workspace-data-visibility-journey.mjs\nInterface: Runner HTTP; no external services\nPlanned: 5; executed: ${steps.length}; passed: ${steps.filter(s => s.verdict === "PASS").length}; failed: ${steps.filter(s => s.verdict === "FAIL").length}; skipped: ${5 - steps.length}\n\n${steps.map(s => `## ${s.name}: ${s.verdict}\n\nExpected: ${s.expected}\n\nActual: ${s.actual}\n`).join("\n")}\n## Runner log\n\n\`\`\`\n${log}\n\`\`\`\n`);
  await rm(data, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
  console.log(`${verdict}: ${resolve(root, "report.md")}`);
}
