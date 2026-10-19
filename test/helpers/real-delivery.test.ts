// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { collectFinalDelivery, collectTeamRunResult } from "./real-delivery.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

function api(status = "completed", text = "[report](/artifact-versions/older/content)", content = "report", httpStatus = 200) {
  const paths: string[] = [];
  const cancellations: string[] = [];
  const data: Record<string, unknown> = {
    "/api/sessions/s/runs": [{ id: "r", assistantMessageId: "m", status }],
    "/api/sessions/s": { messages: [{ id: "m", role: "assistant", content: text }] },
    "/api/sessions/s/artifacts": [{ id: "a", logicalName: "nested/report.md" }],
    "/api/sessions/s/artifacts/a/versions": [{ id: "newer", version: 2 }, { id: "older", version: 1 }],
  };
  const page = { request: { post: async (url: string) => {
    cancellations.push(new URL(url).pathname);
    return { status: () => 202 };
  }, get: async (url: string) => {
    const path = new URL(url).pathname; paths.push(path);
    return { ok: () => path.endsWith("/content") ? httpStatus === 200 : true, status: () => httpStatus,
      json: async () => data[path], body: async () => Buffer.from(content) };
  } } };
  return { page: page as never, paths, cancellations };
}

test("delivery reads the immutable version explicitly referenced in the final response", async () => {
  const fake = api();
  const result = await collectFinalDelivery(fake.page, "s", "r");
  assert.equal(result.status, "passed");
  assert.equal(result.artifacts[0]?.version, "older");
  assert.ok(!fake.paths.some(p => p.includes("newer/content")));
});
test("empty or unreadable referenced output is a failed delivery", async () => {
  for (const [content, status] of [["   ", 200], ["report", 404]] as const) {
    const fake = api("completed", "nested/report.md", content, status);
    const result = await collectFinalDelivery(fake.page, "s", "r");
    assert.equal(result.status, "failed");
    assert.equal(result.errors.length, 1);
  }
});
test("a failed agent with a real final artifact is recorded as partial, never passed", async () => {
  const fake = api("failed");
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "partial");
});

test("an unfinished run is not a failed delivery, with or without a cited artifact", async () => {
  for (const status of ["queued", "running", "blocked"]) {
    for (const answer of ["", "nested/report.md"]) {
      const result = await collectFinalDelivery(api(status, answer).page, "s", "r");
      assert.equal(result.status, "running");
      assert.equal(result.run_status, status);
    }
  }
});

test("terminal runs with no cited artifact remain failed deliveries", async () => {
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
    assert.equal((await collectFinalDelivery(api(status, "").page, "s", "r")).status, "failed");
  }
});

test("team budget expiry records cancellation and timeout separately from delivery", async () => {
  for (const status of ["running", "cancelled", "completed"]) {
    const fake = api(status, status === "completed" ? "nested/report.md" : "");
    const result = await collectTeamRunResult(fake.page, "s", "r", true);
    assert.equal(result.integration, "timed_out");
    assert.equal(result.budget_exceeded, true);
    assert.equal(result.cancel_requested, true);
    assert.equal(result.cancel_http_status, 202);
    assert.equal(result.cancel_error, null);
    assert.equal(result.delivery.run_status, status);
    assert.equal(result.delivery.status, status === "running" ? "running" : status === "completed" ? "passed" : "failed");
    assert.deepEqual(fake.cancellations, ["/api/sessions/s/runs/r/cancel"]);
  }
});

test("team cancellation HTTP and transport failures retain timeout attribution", async () => {
  for (const status of [503, null]) {
    const fake = api("running", "");
    (fake.page as any).request.post = async () => {
      if (status === null) throw new Error("cancel connection closed");
      return { status: () => status };
    };
    const result = await collectTeamRunResult(fake.page, "s", "r", true);
    assert.equal(result.integration, "timed_out");
    assert.equal(result.delivery.status, "running");
    assert.equal(result.cancel_requested, true);
    assert.equal(result.cancel_http_status, status);
    assert.equal(result.cancel_error, status === null ? "cancel connection closed" : null);
  }
});

test("a team that finishes within budget retains its delivery verdict without cancellation", async () => {
  for (const [status, answer, verdict] of [
    ["completed", "nested/report.md", "passed"], ["completed", "", "failed"],
    ["failed", "nested/report.md", "partial"], ["failed", "", "failed"],
  ]) {
    const fake = api(status, answer);
    const result = await collectTeamRunResult(fake.page, "s", "r", false);
    assert.equal(result.integration, verdict);
    assert.equal(result.budget_exceeded, false);
    assert.equal(result.cancel_requested, false);
    assert.equal(result.cancel_http_status, null);
    assert.deepEqual(fake.cancellations, []);
  }
});
