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

function requiredChecks(rules: unknown, protection: unknown): RequiredCheck[] {
  if (!Array.isArray(rules)) throw new Error("effective rules is not an array");
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
  return required;
}

/** Fail closed on malformed rules; optional check runs do not affect the result. */
export function requiredChecksPassed(
  rules: unknown,
  protection: unknown,
  checkRuns: unknown,
  statuses: unknown,
): boolean {
  if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) {
    throw new Error("head checks or statuses is not an array");
  }
  return requiredChecks(rules, protection).every(({ context, appId }) => {
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

const ELIGIBLE_ACTION_EVENTS = new Set([
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_target",
  "deployment",
  "deployment_status",
]);

/** Read one commit's checks and discard Actions jobs GitHub will not evaluate. */
async function readCommitChecks(
  repo: string,
  sha: string,
  names: ReadonlySet<string>,
  gh: (args: string[]) => Promise<string>,
): Promise<
  { checkRuns: ObjectValue[]; statuses: ObjectValue[]; hasAny: boolean }
> {
  const pages = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(pages)) throw new Error("check run pages are malformed");
  const rawRuns = pages.flatMap((page: unknown) => {
    const value = object(page, "check run page");
    if (!Array.isArray(value.check_runs)) {
      throw new Error("check run page has no check_runs");
    }
    return value.check_runs.map((run: unknown) => object(run, "check run"));
  });
  const statusPages = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/commits/${sha}/status?per_page=100`,
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
    return value.statuses.map((status: unknown) =>
      object(status, "commit status")
    );
  });
  const suiteEvents = new Map<number, boolean>();
  const checkRuns: ObjectValue[] = [];
  for (const run of rawRuns) {
    if (typeof run.name !== "string" || !names.has(run.name)) continue;
    const app = object(run.app, "required check app");
    if (typeof app.id !== "number" || typeof app.slug !== "string") {
      throw new Error(`required check ${run.name} has no app identity`);
    }
    if (app.slug !== "github-actions") {
      checkRuns.push(run);
      continue;
    }
    const suite = object(run.check_suite, "Actions check suite");
    if (!Number.isSafeInteger(suite.id) || (suite.id as number) <= 0) {
      throw new Error(`required Actions check ${run.name} has no suite id`);
    }
    const suiteId = suite.id as number;
    let eligible = suiteEvents.get(suiteId);
    if (eligible === undefined) {
      const response = object(
        JSON.parse(
          await gh([
            "api",
            `repos/${repo}/actions/runs?check_suite_id=${suiteId}&per_page=100`,
          ]),
        ),
        "Actions workflow runs",
      );
      if (
        response.total_count !== 1 || !Array.isArray(response.workflow_runs) ||
        response.workflow_runs.length !== 1
      ) {
        throw new Error(
          `cannot identify Actions workflow for suite ${suiteId}`,
        );
      }
      const workflow = object(
        response.workflow_runs[0],
        "Actions workflow run",
      );
      if (
        workflow.check_suite_id !== suiteId ||
        typeof workflow.event !== "string"
      ) {
        throw new Error(
          `Actions workflow for suite ${suiteId} has invalid event metadata`,
        );
      }
      eligible = ELIGIBLE_ACTION_EVENTS.has(workflow.event);
      suiteEvents.set(suiteId, eligible);
    }
    if (eligible) checkRuns.push(run);
  }
  return { checkRuns, statuses, hasAny: rawRuns.length + statuses.length > 0 };
}

/** Read both effective rules and classic branch protection for a particular head. */
export async function readRequiredChecksPassed(
  repo: string,
  base: string,
  head: string,
  gh: (args: string[]) => Promise<string>,
  mergeHead?: string,
): Promise<boolean> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/i.test(head) ||
    !base ||
    (mergeHead !== undefined && !/^[a-f0-9]{40}$/i.test(mergeHead))
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
  const flatRules = rules.flat();
  const names = new Set(
    requiredChecks(flatRules, protection).map((c) => c.context),
  );
  if (mergeHead !== undefined && mergeHead !== head) {
    const merge = await readCommitChecks(repo, mergeHead, names, gh);
    if (merge.hasAny) {
      return requiredChecksPassed(
        flatRules,
        protection,
        merge.checkRuns,
        merge.statuses,
      );
    }
  }
  const source = await readCommitChecks(repo, head, names, gh);
  return requiredChecksPassed(
    flatRules,
    protection,
    source.checkRuns,
    source.statuses,
  );
}

/** Confirm GitHub's test merge belongs to the same PR head and current base. */
async function readTestMerge(
  repo: string,
  prNumber: number,
  base: string,
  head: string,
  gh: (args: string[]) => Promise<string>,
): Promise<{ mergeSha: string; baseSha: string }> {
  const pr = object(
    JSON.parse(await gh(["api", `repos/${repo}/pulls/${prNumber}`])),
    "PR merge state",
  );
  const prHead = object(pr.head, "PR head");
  const prBase = object(pr.base, "PR base");
  if (
    pr.state !== "open" || pr.mergeable !== true || prHead.sha !== head ||
    prBase.ref !== base ||
    typeof prBase.sha !== "string" || !/^[a-f0-9]{40}$/i.test(prBase.sha) ||
    typeof pr.merge_commit_sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha)
  ) {
    throw new Error(
      "PR test merge is unavailable or no longer matches its head and base",
    );
  }
  const merge = object(
    JSON.parse(
      await gh(["api", `repos/${repo}/git/commits/${pr.merge_commit_sha}`]),
    ),
    "PR test merge commit",
  );
  if (
    !Array.isArray(merge.parents) || merge.parents.length !== 2 ||
    object(merge.parents[0], "first merge parent").sha !== prBase.sha ||
    object(merge.parents[1], "second merge parent").sha !== head
  ) {
    throw new Error("PR test merge parents do not match its head and base");
  }
  return { mergeSha: pr.merge_commit_sha, baseSha: prBase.sha };
}

/** Re-read the PR and its current-head contract before asking for a refresh. */
export async function requestReadyBranchUpdate(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  expectedBase?: string,
): Promise<Result<void>> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    return {
      ok: false,
      error: new Error("Invalid repository or PR number for branch update"),
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
    const merge = await readTestMerge(
      repo,
      prNumber,
      current.baseRefName,
      current.headRefOid,
      gh,
    );
    if (
      !await readRequiredChecksPassed(
        repo,
        current.baseRefName,
        current.headRefOid,
        gh,
        merge.mergeSha,
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
    const freshMerge = await readTestMerge(
      repo,
      prNumber,
      current.baseRefName,
      current.headRefOid,
      gh,
    );
    if (
      freshMerge.mergeSha !== merge.mergeSha ||
      freshMerge.baseSha !== merge.baseSha
    ) {
      return {
        ok: false,
        error: new Error(
          "PR test merge changed while required checks were read",
        ),
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
