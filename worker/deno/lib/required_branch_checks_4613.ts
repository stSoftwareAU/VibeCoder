/** Evaluate the effective branch-check contract against the current head. */

import type { Result } from "../types.ts";
import { requestBranchUpdate } from "./merge_block_escalation.ts";
import { redactSecrets } from "./secret_redaction.ts";

type ObjectValue = Record<string, unknown>;
interface RequiredCheck {
  context: string;
  appId?: number;
}

function object(value: unknown, where: string): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value as ObjectValue;
}

function requiredList(value: unknown, where: string): RequiredCheck[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
  return value.map((item) => {
    const entry = object(item, where);
    if (typeof entry.context !== "string" || !entry.context.trim()) {
      throw new Error(`${where} has no context`);
    }
    const appId = entry.integration_id ?? entry.app_id;
    if (
      appId !== undefined && appId !== null &&
      (!Number.isInteger(appId) || (appId as number) < -1)
    ) {
      throw new Error(`${where} has an invalid app id`);
    }
    return {
      context: entry.context,
      ...(typeof appId === "number" && appId >= 0 ? { appId } : {}),
    };
  });
}

/** Fail closed on malformed rules; optional check runs do not affect the result. */
export function requiredChecksPassed(
  rules: unknown,
  protection: unknown,
  checkRuns: unknown,
  statuses: unknown,
): boolean {
  if (!Array.isArray(rules)) throw new Error("effective rules is not an array");
  if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) {
    throw new Error("head checks or statuses is not an array");
  }
  const required: RequiredCheck[] = [];
  for (const raw of rules) {
    const rule = object(raw, "effective rule");
    if (typeof rule.type !== "string") {
      throw new Error("effective rule has no type");
    }
    if (rule.type !== "required_status_checks") continue;
    const parameters = object(
      rule.parameters,
      "required status checks parameters",
    );
    required.push(
      ...requiredList(
        parameters.required_status_checks,
        "required status checks",
      ),
    );
  }
  if (protection !== null) {
    const classic = object(protection, "branch protection");
    if (!Array.isArray(classic.contexts)) {
      throw new Error("branch protection contexts is not an array");
    }
    for (const context of classic.contexts) {
      if (typeof context !== "string" || !context.trim()) {
        throw new Error("invalid protected context");
      }
      required.push({ context });
    }
    if (classic.checks !== undefined) {
      required.push(...requiredList(classic.checks, "protected checks"));
    }
  }
  return required.every(({ context, appId }) => {
    const matchingRuns = checkRuns.map((r) => object(r, "check run")).filter((
      r,
    ) =>
      r.name === context &&
      (appId === undefined || object(r.app, "check run app").id === appId)
    );
    const matchingStatuses = statuses.map((s) => object(s, "commit status"))
      .filter((s) => s.context === context);
    if (matchingStatuses.some((s) => s.state !== "success")) return false;
    // REST commit statuses do not identify the GitHub App integration. A
    // status with this name must pass even when a same-named check run exists,
    // but its creator cannot safely be matched to the pinned app here.
    if (appId !== undefined && matchingStatuses.length > 0) {
      throw new Error(
        `cannot verify publisher of app-pinned status ${context}`,
      );
    }
    return matchingRuns.length + matchingStatuses.length > 0 &&
      matchingRuns.every((r) =>
        r.status === "completed" &&
        (r.conclusion === "success" || r.conclusion === "neutral" ||
          r.conclusion === "skipped")
      );
  });
}

/** Read both effective rules and classic branch protection for a particular head. */
export async function readRequiredChecksPassed(
  repo: string,
  base: string,
  head: string,
  gh: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/i.test(head) || !base
  ) {
    throw new Error("Invalid repository, base or head for required-check read");
  }
  const branch = encodeURIComponent(base);
  const rules = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/rules/branches/${branch}?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(rules) || !rules.every(Array.isArray)) {
    throw new Error("effective rules pages are malformed");
  }
  // The branch response exposes the classic protection summary to readers.
  // The dedicated protection endpoint returns an ambiguous 404 without admin
  // access, even when this branch has no classic protection.
  const branchInfo = object(
    JSON.parse(
      await gh([
        "api",
        `repos/${repo}/branches/${branch}`,
      ]),
    ),
    "branch",
  );
  const protectionSummary = object(
    branchInfo.protection,
    "branch protection summary",
  );
  if (typeof protectionSummary.enabled !== "boolean") {
    throw new Error("branch protection summary has no enabled flag");
  }
  const protection = object(
    protectionSummary.required_status_checks,
    "classic required checks",
  );
  const runs = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(runs)) throw new Error("check run pages are malformed");
  const checkRuns = runs.flatMap((page: unknown) => {
    const value = object(page, "check run page");
    if (!Array.isArray(value.check_runs)) {
      throw new Error("check run page has no check_runs");
    }
    return value.check_runs;
  });
  const statusPages = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/commits/${head}/status?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(statusPages)) {
    throw new Error("commit status pages are malformed");
  }
  const statuses = statusPages.flatMap((page: unknown) => {
    const value = object(page, "combined commit status");
    if (!Array.isArray(value.statuses)) {
      throw new Error("combined status has no statuses");
    }
    return value.statuses;
  });
  return requiredChecksPassed(rules.flat(), protection, checkRuns, statuses);
}

/** Re-read the PR and its current-head contract before asking for a refresh. */
export async function requestReadyBranchUpdate(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  expectedBase?: string,
): Promise<Result<void>> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return {
      ok: false,
      error: new Error("Invalid PR number for branch update"),
    };
  }
  try {
    const readLivePr = async () =>
      object(
        JSON.parse(
          await gh([
            "pr",
            "view",
            String(prNumber),
            "--repo",
            repo,
            "--json",
            "state,baseRefName,headRefOid,autoMergeRequest,reviewDecision,mergeable,mergeStateStatus",
          ]),
        ),
        "live PR",
      );
    const ready = (pr: ObjectValue) =>
      pr.state === "OPEN" && !!pr.autoMergeRequest &&
      pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "BEHIND" &&
      (pr.reviewDecision === "APPROVED" || pr.reviewDecision === "" ||
        pr.reviewDecision === null) &&
      typeof pr.baseRefName === "string" &&
      (expectedBase === undefined || pr.baseRefName === expectedBase) &&
      typeof pr.headRefOid === "string";
    const current = await readLivePr();
    if (
      !ready(current) || typeof current.baseRefName !== "string" ||
      typeof current.headRefOid !== "string"
    ) {
      return {
        ok: false,
        error: new Error("PR no longer ready for a branch update"),
      };
    }
    if (
      !await readRequiredChecksPassed(
        repo,
        current.baseRefName,
        current.headRefOid,
        gh,
      )
    ) {
      return {
        ok: false,
        error: new Error("required current-head checks have not passed"),
      };
    }
    const fresh = await readLivePr();
    if (
      !ready(fresh) || fresh.baseRefName !== current.baseRefName ||
      fresh.headRefOid !== current.headRefOid
    ) {
      return {
        ok: false,
        error: new Error("PR changed while its required checks were read"),
      };
    }
    return await requestBranchUpdate(repo, prNumber, gh, current.headRefOid);
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `required-check read failed: ${
          redactSecrets(error instanceof Error ? error.message : String(error))
        }`,
      ),
    };
  }
}
