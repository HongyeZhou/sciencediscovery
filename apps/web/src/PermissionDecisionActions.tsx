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

import type { PermissionDecision, PermissionRequest } from "@sciencediscovery/schema";
import { useLocale } from "./i18n/index.js";

/** UI-only grouping used to suppress duplicate clicks while allow-matching is in flight. */
export function permissionMatchingKey(request: PermissionRequest): string {
  const parts = request.resource.split(":");
  const resource = request.action === "connector" || request.action === "artifact_download"
    ? parts.slice(0, 2).join(":")
    : request.action === "remote_job"
      ? parts.slice(0, 3).join(":")
      : request.resource;
  return `${request.action}:${resource}`;
}

/**
 * A sandbox-network grant covers only the listed hosts, on the requesting
 * Runner, until the owning agent run ends. "Allow same type" reads as blanket
 * network access, so that one action names the hosts it actually grants.
 */
export function PermissionDecisionActions({
  action,
  busy,
  onDecision,
}: {
  action?: PermissionRequest["action"];
  busy: boolean;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const { t } = useLocale();
  const sandboxNetwork = action === "sandbox_network";
  return <div className="plan-actions permission-decision-actions">
    <button className="secondary-button" disabled={busy} onClick={() => onDecision("allow_once")} type="button">{t("permissions.allowOnce")}</button>
    <button className="secondary-button" disabled={busy} onClick={() => onDecision("allow_matching")} title={sandboxNetwork ? t("permissions.allowSandboxNetworkHostsHint") : undefined} type="button">{sandboxNetwork ? t("permissions.allowSandboxNetworkHosts") : t("permissions.allowMatching")}</button>
    <button className="danger-button" disabled={busy} onClick={() => onDecision("deny")} type="button">{t("permissions.deny")}</button>
  </div>;
}
