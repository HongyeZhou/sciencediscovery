// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, fileDigest, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import { hostPlatform, hostArch } from '../test/support/tagged/environment.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { PROVIDER_FAULT, detectProviderFault, detectProviderFaultFromErrors, retryableProviderFaults } from '../test/support/tagged/provider-fault.mjs';
import TaggedReporter from '../test/support/tagged/playwright-reporter.mjs';
import { reconcile } from './real-report.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = { os: hostPlatform(process.platform), arch: hostArch(process.arch) };

// The texts the Nightly of 2026-10-06 recorded, unchanged.
const GATEWAY_500 = "[181001] model call failed, reason: openAI API async stream error: InternalServerError: Error code: 500 - {'error': {'message': 'Database error...', 'type': 'new_api_error'}}";
const GATEWAY_503 = "[181001] model call failed, reason: openAI API async stream error: ServiceUnavailableError: Error code: 503 - {'error': {'message': 'No available channel for model deepseek-v4-flash...', 'type': 'model_not_found'}}";
const UNAUTHORIZED = "[181001] model call failed, reason: openAI API async stream error: AuthenticationError: Error code: 401 - {'error': {'message': 'scripted http401'}}";
const RATE_LIMITED = "[181001] model call failed, reason: openAI API async stream error: RateLimitError: Error code: 429 - {'error': {'message': 'scripted http429'}}";
const DELIVERY_MISS = 'Main run must complete with readable, nonempty declared final artifacts; delivery_status=failed; run_status=failed; delivered_artifacts=0; run_error=none';

const directory = t => {
  const path = mkdtempSync(join(tmpdir(), 'provider-fault-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

/** One browser identity, as the tagged plan records it. */
const identity = (id, tags) => ({
  id, source: 'test/journey-basic-real-api.spec.ts',
  sourceHash: fileDigest(readFileSync(join(root, 'test/journey-basic-real-api.spec.ts'))),
  runner: 'playwright', requirements: [], tags,
});
const realTags = ['category:e2e', `os:${target.os}`, `arch:${target.arch}`, 'model:real', 'tier:l4'];
const mockedTags = ['category:e2e', `os:${target.os}`, `arch:${target.arch}`, 'model:mock', 'tier:l2'];
const realCaseTags = realTags.map(tag => `@${tag}`);
const mockedCaseTags = mockedTags.map(tag => `@${tag}`);

/** A Playwright test case, as the reporter sees it. */
const browserCase = (title, tags) => ({
  location: { file: join(root, 'test/journey-basic-real-api.spec.ts') },
  titlePath: () => ['real', title],
  annotations: [],
  tags,
});

/** The identity the reporter derives from one browser case. */
const browserId = title => `playwright:test/journey-basic-real-api.spec.ts::real/${encodeURIComponent(title)}`;

/** Run the tagged reporter over one browser result and return what it wrote. */
function report(t, { title, tags, status, errors, duration }) {
  const plan = createPlan([identity(browserId(title), tags.map(tag => tag.slice(1)))], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const home = directory(t);
  const planPath = join(home, 'plan.json');
  const reportPath = join(home, 'report.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const previous = { plan: process.env.SCIENCE_TAG_PLAN, report: process.env.SCIENCE_TAG_PW_REPORT };
  process.env.SCIENCE_TAG_PLAN = planPath;
  process.env.SCIENCE_TAG_PW_REPORT = reportPath;
  try {
    const reporter = new TaggedReporter();
    const testCase = browserCase(title, tags);
    reporter.onBegin({ workers: 1, fullyParallel: false }, { allTests: () => [testCase] });
    reporter.onTestEnd(testCase, { status, errors: errors.map(message => ({ message })), duration });
    reporter.onEnd();
  } finally {
    if (previous.plan === undefined) delete process.env.SCIENCE_TAG_PLAN; else process.env.SCIENCE_TAG_PLAN = previous.plan;
    if (previous.report === undefined) delete process.env.SCIENCE_TAG_PW_REPORT; else process.env.SCIENCE_TAG_PW_REPORT = previous.report;
  }
  return { plan, written: JSON.parse(readFileSync(reportPath, 'utf8')) };
}

test('a gateway 500 with the gateway own codes is a provider fault, not a product failure', () => {
  const fault = detectProviderFault(GATEWAY_500);
  assert.equal(fault.code, 'provider-server-error');
  assert.equal(fault.status, 500);
  // The gateway's routing failures name themselves even without a status.
  assert.equal(detectProviderFault(GATEWAY_503).status, 503);
  assert.equal(detectProviderFault(GATEWAY_503).code, 'provider-server-error');
  assert.equal(detectProviderFault('No available channel for model deepseek-v4-flash').code, 'provider-unavailable');
});

test('an unauthorized, rate-limited or semantic failure is never a transient gateway fault', () => {
  assert.equal(detectProviderFault(UNAUTHORIZED), null);
  assert.equal(detectProviderFault(RATE_LIMITED), null);
  assert.equal(detectProviderFault(DELIVERY_MISS), null);
  assert.equal(detectProviderFault('The final handoff must identify a report, not only intermediate notes'), null);
  // The product's own answer is not the gateway's, even with a status in it.
  assert.equal(detectProviderFault('/api/sessions/abc -> 500: {"error":"Internal Server Error"}'), null);
  assert.equal(detectProviderFault('Agent run stalled: no assistant progress for 600000 ms'), null);
  assert.equal(detectProviderFault('Test timeout of 240000ms exceeded.'), null);
});

test('one unrelated line cannot turn a product failure into an outage', () => {
  assert.equal(detectProviderFaultFromErrors([GATEWAY_500, 'Expected: "passed", Received: "failed"']), null);
  assert.equal(detectProviderFaultFromErrors([GATEWAY_500]).code, 'provider-server-error');
  assert.equal(detectProviderFaultFromErrors([]), null);
});

test('the reporter records a live-model gateway fault apart from a product failure', t => {
  const { plan, written } = report(t, {
    title: 'DRB-75', tags: realCaseTags, status: 'failed', errors: [GATEWAY_500], duration: 9_300,
  });
  assert.equal(written.results[0].outcome, PROVIDER_FAULT);
  // The provider's own words stay in the failure: nothing is rewritten.
  assert.deepEqual(written.results[0].errors, [GATEWAY_500]);
  assert.deepEqual(written.results[0].providerFault, { code: 'provider-server-error', status: 500 });
  // The case ran; it is not a case that was never executed.
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.executed, 1);
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.passed, 0);
  assert.equal(verdict.providerFaults, 1);
});

test('a product failure stays a hard failure with no provider class', t => {
  const { plan, written } = report(t, {
    title: 'DRB-59', tags: realCaseTags, status: 'failed', errors: [DELIVERY_MISS], duration: 600_000,
  });
  assert.equal(written.results[0].outcome, 'FAIL');
  assert.equal(written.results[0].providerFault, undefined);
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.failed, 1);
  assert.ok(verdict.problems.includes(`FAIL: ${plan.entries[0].key}`));
  assert.ok(!verdict.problems.some(problem => problem.startsWith('PROVIDER_FAULT:')));
});

test('a mocked case is never soft-classified, however its failure reads', t => {
  const { plan, written } = report(t, {
    title: 'workspace plan gateway', tags: mockedCaseTags, status: 'failed',
    errors: ["Run failed while waiting for Workspace Plans: Needs attention: {'type': 'new_api_error', 'code': 503}"], duration: 1_000,
  });
  assert.equal(written.results[0].outcome, 'FAIL');
  assert.equal(verifyResults(plan, written.results).status, 'FAIL');
});

test('the visible-gateway-error journey stays a mocked case', () => {
  const source = readFileSync(join(root, 'test/issue-67-34-inline-cards.spec.ts'), 'utf8');
  const journey = source.slice(source.indexOf('visible gateway errors fail promptly'));
  assert.match(journey, /@mocked/);
  assert.match(journey, /@model:mock/);
});

test('a provider fault is reported under its own code and does not fail the gate', () => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const entry = plan.entries[0];
  const verdict = verifyResults(plan, [{
    key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend,
    providerFault: { code: 'provider-server-error', status: 503 },
  }]);
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.providerFaults, 1);
  assert.ok(verdict.problems.includes(`PROVIDER_FAULT: ${entry.key}`));
  assert.ok(!verdict.problems.includes(`FAIL: ${entry.key}`));
});

test('a mixed job keeps its passes as passes and still fails on a product failure', () => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const [first, second] = plan.entries;
  const passed = entry => ({ key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend });
  const faulted = entry => ({ key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend });
  const failed = entry => ({ key: entry.key, outcome: 'FAIL', actualTarget: entry.target, actualBackend: entry.backend });

  const mixed = verifyResults(plan, [passed(first), faulted(second)]);
  assert.equal(mixed.status, 'PROVIDER_FAULT');
  assert.equal(mixed.exitCode, 0);
  assert.equal(mixed.passed, 1);
  assert.equal(mixed.failed, 0);
  assert.equal(mixed.providerFaults, 1);

  const withProductFailure = verifyResults(plan, [passed(first), failed(second)]);
  assert.equal(withProductFailure.status, 'FAIL');
  assert.equal(withProductFailure.exitCode, 1);
  assert.equal(withProductFailure.passed, 1);
  assert.equal(withProductFailure.failed, 1);
});

test('the daily reconcile reports a provider fault without failing the suite', t => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  const [first, second] = plan.entries;
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(entry => shard.keys.includes(entry.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    const results = worker.entries.map(entry => entry.key === first.key
      ? { key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend }
      : { key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend });
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, results)));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.passed, 1);
  assert.equal(verdict.providerFaults, 1);
  assert.ok(verdict.problems.some(problem => problem.startsWith('PROVIDER_FAULT:')));
  assert.ok(!verdict.problems.some(problem => problem.includes('SHARD_FAILED')));
});

test('the daily reconcile still fails the suite on a product failure', t => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  const [entry] = plan.entries;
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(item => shard.keys.includes(item.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, [{
      key: entry.key, outcome: 'FAIL', actualTarget: entry.target, actualBackend: entry.backend,
    }])));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.exitCode, 1);
});

test('only an early gateway fault is worth repeating', () => {
  const early = { outcome: PROVIDER_FAULT, durationMs: 9_300 };
  const late = { outcome: PROVIDER_FAULT, durationMs: 2_400_000 };
  const product = { outcome: 'FAIL', durationMs: 9_300 };
  assert.deepEqual(retryableProviderFaults([early]), [early]);
  assert.deepEqual(retryableProviderFaults([late]), []);
  assert.deepEqual(retryableProviderFaults([product]), []);
  assert.deepEqual(retryableProviderFaults([early, late, product]), [early]);
});
