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


import type { PermissionDecision, PermissionGrant, PermissionRequest } from "@sciencediscovery/schema";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionCards, PermissionGrantManager } from "../src/Permissions.js";
import { permissionMatchingKey } from "../src/PermissionDecisionActions.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { activityCardId } from "../src/session/run-activity.js";

const noopToggle = () => undefined;

const SANDBOX_NETWORK_HINT = "Applies only to the listed hosts on this Runner for the current agent run. Other hosts still ask; global sandbox network settings are unchanged.";

function networkRequest(): PermissionRequest {
  return { action: "sandbox_network", createdAt: "2026-10-18T00:00:00.000Z", id: "request-network",
    projectId: "project-1", resource: `sandbox-network:${"a".repeat(64)}`, sessionId: "session-1", state: "pending",
    summary: "Sandbox network on local for this Agent run: eutils.ncbi.nlm.nih.gov:443. Purpose: Retrieve requested PubMed records." };
}

test("allow-matching UI groups the same permission resources as the backend", () => {
  const request = {
    action: "artifact_download" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-download",
    resource: "pubmed:download:first.pdf",
    sessionId: "session-1",
    state: "pending" as const,
    summary: "Download first.pdf",
  };
  assert.equal(permissionMatchingKey(request), "artifact_download:pubmed:download");
  assert.equal(
    permissionMatchingKey({ ...request, id: "request-2", resource: "pubmed:download:second.pdf" }),
    permissionMatchingKey(request),
  );
  assert.notEqual(
    permissionMatchingKey({ ...request, id: "request-3", resource: "biorxiv:download:paper.pdf" }),
    permissionMatchingKey(request),
  );
});

test("pending permission details fold without hiding the decision buttons", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /Permission required/);
  assert.match(html, /Run local code/);
  assert.match(html, /Run Python code in the Session workspace/);
  assert.match(html, /aria-expanded="false"/);
  // Resource details fold, while pending decisions remain directly actionable.
  assert.doesNotMatch(html, /workspace-code/);
  assert.match(html, /Allow once/);
});

test("expanded permission card exposes the independent decisions", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: { [activityCardId("permission", request.id)]: true },
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /workspace-code/);
  assert.match(html, /class="plan-actions permission-decision-actions"/);
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, /class="secondary-button"[^>]*>Allow once</);
  assert.match(html, /class="secondary-button"[^>]*>Allow same type</);
  assert.match(html, /class="danger-button"[^>]*>Deny</);
});

test("permission cards hide decided requests", () => {
  const request: PermissionRequest = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:05.000Z",
    decision: "allowed",
    id: "request-1",
    projectId: "project-1",
    resource: "arxiv",
    sessionId: "session-1",
    state: "allowed",
    summary: "Query the arxiv connector",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.equal(html, "");
});

test("pending download approvals keep all actions while cancelled ones have no approval entry", () => {
  const request: PermissionRequest = {
    action: "artifact_download", createdAt: "2026-09-11T00:00:00.000Z",
    id: "download-approval", projectId: "project-1", sessionId: "session-1",
    resource: "arxiv:download:paper.pdf", summary: "Download paper.pdf", state: "pending",
  };
  const render = (state: PermissionRequest["state"]) => renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle,
    requests: [{ ...request, state }],
  }));
  const pending = render("pending");
  assert.match(pending, />Allow once<\/button>/);
  assert.match(pending, />Allow same type<\/button>/);
  assert.match(pending, />Deny<\/button>/);
  assert.equal(render("cancelled"), "");
});

test("standing grants are listable and revocable", () => {
  const grant: PermissionGrant = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "grant-1",
    projectId: "project-1",
    resource: "pubmed",
    scope: "project",
    state: "active",
  };
  const html = renderToStaticMarkup(createElement(PermissionGrantManager, {
    grants: [grant],
    onRevoke: () => undefined,
  }));
  assert.match(html, /Standing permission grants/);
  assert.match(html, /pubmed · this Session/);
  assert.match(html, /Revoke/);
});

test("direct consent is visibly unsandboxed and retains exact command whitespace", () => {
  const request: PermissionRequest = { id: "direct", action: "direct_code", createdAt: "2026-01-01T00:00:00Z",
    resource: "direct:bound-scope", sessionId: "session", state: "pending",
    summary: "DIRECT HOST EXECUTION: machine, account user, cwd workspace. No isolation.\nprintf 'a  b'\n" };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => {}, onToggleCard: noopToggle, requests: [request],
  }));
  assert.match(html, /Execute directly on the host \(no sandbox\)/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /a  b/);
  assert.match(html, /Allow once/);
  assert.match(html, /Deny/);
  assert.notEqual(permissionMatchingKey(request), permissionMatchingKey({ ...request, resource: "direct:other-run" }));
});

test("network consent names hosts and purpose in the conversation without expanding details", () => {
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onToggleCard: noopToggle, onDecision: async () => {},
    requests: [{ action: "sandbox_network", createdAt: "2026-10-18T00:00:00Z", id: "network",
      sessionId: "s", resource: "sandbox-network:scoped-digest", state: "pending",
      summary: "Sandbox network on local for this Agent run: eutils.ncbi.nlm.nih.gov:443. Purpose: Retrieve requested PubMed records." }],
  }));
  assert.match(html, /Sandbox network access/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /sandbox-network:scoped-digest/);
  assert.match(html, /for this Agent run/);
  assert.match(html, /eutils.ncbi.nlm.nih.gov:443/);
  assert.match(html, /Retrieve requested PubMed records/);
  assert.match(html, /Allow once/); assert.match(html, /Deny/);
});

test("a sandbox network grant is offered by host scope, not as the shared allow-same-type action", () => {
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [networkRequest()],
  }));
  assert.match(html, new RegExp(`<button class="secondary-button"[^>]*title="${SANDBOX_NETWORK_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Allow these hosts for this run</button>`));
  assert.doesNotMatch(html, /Allow same type/);
  assert.match(html, />Allow once<\/button>/);
  assert.match(html, />Deny<\/button>/);
});

test("the renamed sandbox network button still decides allow_matching", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const request = networkRequest();
  const decisions: PermissionDecision[] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(PermissionCards, {
      expandedCards: {}, onToggleCard: noopToggle, requests: [request],
      onDecision: async (_decided, decision) => { decisions.push(decision); },
    })); });
    await act(async () => renderer.root.findByProps({ title: SANDBOX_NETWORK_HINT }).props.onClick());
    assert.deepEqual(decisions, ["allow_matching"]);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test("shell execution cards keep Allow once / Allow same type / Deny with no scope hint", () => {
  const request: PermissionRequest = {
    action: "code", createdAt: "2026-10-18T00:00:00.000Z", id: "request-shell",
    projectId: "project-1", resource: "workspace-code", sessionId: "session-1", state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
  }));
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, />Allow once<\/button>/);
  assert.match(html, />Allow same type<\/button>/);
  assert.match(html, />Deny<\/button>/);
  assert.doesNotMatch(html, /title=/);
});

test("the sandbox network grant button is localized", () => {
  const render = (locale: "en" | "zh-CN") => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [networkRequest()],
    })));
  assert.match(render("zh-CN"), />本次运行允许这些主机<\/button>/);
  assert.doesNotMatch(render("zh-CN"), /允许同类操作/);
  assert.match(render("en"), />Allow these hosts for this run<\/button>/);
});

test("sandbox network grants end with the agent run while other grants keep the Session scope", () => {
  const grant = (overrides: Partial<PermissionGrant>): PermissionGrant => ({
    action: "code", createdAt: "2026-10-18T00:00:00.000Z", id: "grant-1", projectId: "project-1",
    resource: "workspace-code", scope: "project", state: "active", ...overrides,
  });
  const html = renderToStaticMarkup(createElement(PermissionGrantManager, {
    grants: [
      grant({ action: "sandbox_network", id: "grant-network", resource: `sandbox-network:${"a".repeat(64)}`, scope: "session" }),
      grant({ id: "grant-shell" }),
    ],
    onRevoke: () => undefined,
  }));
  const networkLine = html.match(/<small>[^<]*sandbox-network[^<]*<\/small>/)?.[0] ?? "";
  assert.match(networkLine, /· this agent run<\/small>$/);
  assert.match(html, /workspace-code · this Session/);
});
