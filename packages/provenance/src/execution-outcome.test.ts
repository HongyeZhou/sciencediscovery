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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  effectiveExecutionRuns,
  settledExecutionRun,
  settledExecutionRuns,
} from "./execution-outcome.js";

const run = (id: string, status: "cancelled" | "failed" | "succeeded" | "unconfirmed", finishedAt: string) =>
  ({ id, status, finishedAt });

test("settledExecutionRun prefers the latest settled outcome over an unconfirmed observation", () => {
  const runs = [
    run("exec-1", "unconfirmed", "2026-01-01T00:00:00.000Z"),
    run("exec-1", "succeeded", "2026-01-01T00:01:00.000Z"),
    run("exec-2", "unconfirmed", "2026-01-01T00:02:00.000Z"),
  ];
  assert.equal(settledExecutionRun(runs, "exec-1")?.status, "succeeded");
  assert.equal(settledExecutionRun(runs, "exec-2"), undefined);
});

test("effectiveExecutionRuns keep unconfirmed only when no settled row exists", () => {
  const runs = [
    run("exec-1", "unconfirmed", "2026-01-01T00:00:00.000Z"),
    run("exec-1", "failed", "2026-01-01T00:01:00.000Z"),
    run("exec-2", "unconfirmed", "2026-01-01T00:02:00.000Z"),
    run("exec-3", "succeeded", "2026-01-01T00:03:00.000Z"),
  ];
  const effective = effectiveExecutionRuns(runs).toSorted((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(effective.map((item) => [item.id, item.status]), [
    ["exec-1", "failed"],
    ["exec-2", "unconfirmed"],
    ["exec-3", "succeeded"],
  ]);
});

test("settledExecutionRuns omit unconfirmed observations entirely", () => {
  const runs = [
    run("exec-1", "unconfirmed", "2026-01-01T00:00:00.000Z"),
    run("exec-1", "succeeded", "2026-01-01T00:01:00.000Z"),
    run("exec-2", "unconfirmed", "2026-01-01T00:02:00.000Z"),
    run("exec-3", "failed", "2026-01-01T00:03:00.000Z"),
  ];
  const settled = settledExecutionRuns(runs).toSorted((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(settled.map((item) => [item.id, item.status]), [
    ["exec-1", "succeeded"],
    ["exec-3", "failed"],
  ]);
});
