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

import type { ExecutionRun } from "@sciencediscovery/schema";

/** A run whose outcome the Runner actually settled. */
export type SettledExecutionStatus = "cancelled" | "failed" | "succeeded";

/** True when the run records an outcome that was actually observed. */
export function isSettledExecutionStatus(status: ExecutionRun["status"]): status is SettledExecutionStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** The minimum a run needs to be ranked and de-duplicated. */
type RankedRun = Pick<ExecutionRun, "id" | "status" | "finishedAt">;

/** True when `right` finished after `left` (or is the only known finish). */
const isEarlierThan = (left: RankedRun, right: RankedRun): boolean =>
  left.finishedAt.localeCompare(right.finishedAt) < 0;

/**
 * The settled run of one Execution ID, or undefined when the outcome was
 * never observed.
 *
 * Execution runs are append-only. An execution whose status observation was
 * lost keeps its `unconfirmed` row forever, and a later reconciliation appends
 * the real outcome under the same ID — so the latest settled row is the
 * outcome readers must use.
 */
export function settledExecutionRun<T extends RankedRun>(
  runs: readonly T[],
  executionId: string,
): T | undefined {
  return runs
    .filter((run) => run.id === executionId && isSettledExecutionStatus(run.status))
    .toSorted((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0];
}

/**
 * One row per Execution ID, carrying the outcome readers must use.
 *
 * A settled row supersedes an unconfirmed observation of the same execution.
 * When nothing was ever settled the unconfirmed row is kept: it reports
 * neither a success nor a failure.
 */
export function effectiveExecutionRuns<T extends RankedRun>(runs: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const run of runs) {
    const current = byId.get(run.id);
    if (!current) {
      byId.set(run.id, run);
      continue;
    }
    const settled = isSettledExecutionStatus(run.status);
    const currentSettled = isSettledExecutionStatus(current.status);
    if (settled !== currentSettled) {
      if (settled) byId.set(run.id, run);
      continue;
    }
    if (isEarlierThan(current, run)) byId.set(run.id, run);
  }
  return [...byId.values()];
}

/**
 * The settled run of every execution that has one. Executions whose outcome
 * was never observed are left out entirely: they are neither successes nor
 * failures and must not be reported as either.
 */
export function settledExecutionRuns<T extends RankedRun>(runs: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const run of runs) {
    if (!isSettledExecutionStatus(run.status)) continue;
    const current = latest.get(run.id);
    if (!current || isEarlierThan(current, run)) latest.set(run.id, run);
  }
  return [...latest.values()];
}
