/** Evaluate the effective branch-check contract against the current head. */

import type { Result } from "../types.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { requestBranchUpdate } from "./merge_block_escalation.ts";
import { retryWithBackoff } from "./retry.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  acquireBaseRefreshOwner,
  type BaseRefreshStatus,
  makeGitHubBaseRefreshOwnershipPort,
  reconcileBaseRefreshOwner,
  releaseBaseRefreshOwner,
} from "./base_refresh_ownership_4613.ts";

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

function classicChecksFromBranch(branch: ObjectValue): ObjectValue | null {
  if (!("protection" in branch)) {
    throw new Error("branch response has no branch protection summary");
  }
  if (branch.protection === null) return null;
  const summary = object(branch.protection, "branch protection summary");
  if (!("required_status_checks" in summary)) {
    throw new Error("branch protection summary has no required checks field");
  }
  if (summary.required_status_checks === null) {
    return null;
  }
  return object(summary.required_status_checks, "classic required checks");
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
  const protection = classicChecksFromBranch(branchInfo);
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

/** True only when a present required context has a terminal failing result. */
export async function readRequiredChecksFailed(
  repo: string,
  base: string,
  head: string,
  gh: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const branch = encodeURIComponent(base);
  const pages = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/rules/branches/${branch}?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("effective rules pages are malformed");
  }
  const branchInfo = object(
    JSON.parse(
      await gh([
        "api",
        `repos/${repo}/branches/${branch}`,
      ]),
    ),
    "branch",
  );
  const protection = classicChecksFromBranch(branchInfo);
  const required = requiredChecks(pages.flat(), protection);
  const checkNames = new Set(required.map(({ context }) => context));
  const checks = await readCommitChecks(repo, head, checkNames, gh);
  return required.some(({ context, appId }) => {
    const runs = checks.checkRuns.filter((run) =>
      run.name === context &&
      (appId === undefined ||
        object(run.app, "required check app").id === appId)
    );
    const statuses = checks.statuses.filter((status) =>
      status.context === context
    );
    return statuses.some((status) =>
      status.state === "failure" || status.state === "error"
    ) ||
      runs.some((run) =>
        run.status === "completed" &&
        run.conclusion !== "success" && run.conclusion !== "neutral" &&
        run.conclusion !== "skipped"
      );
  });
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

/** Re-read the PR and current-head contract before asking for a refresh. */
export async function requestReadyBranchUpdate(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  expectedBase?: string,
  expectedHead?: string,
  ownershipSleepFn?: (ms: number) => Promise<void>,
  ownershipAuthorOptions?: AlertDedupAuthorOptions,
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
            "state,isDraft,baseRefName,headRefOid,autoMergeRequest,reviewDecision,mergeable,mergeStateStatus",
          ]),
        ),
        "live PR",
      );
    const hasCurrentTarget = (pr: ObjectValue) =>
      pr.state === "OPEN" && typeof pr.baseRefName === "string" &&
      (expectedBase === undefined || pr.baseRefName === expectedBase) &&
      typeof pr.headRefOid === "string" &&
      (expectedHead === undefined || pr.headRefOid === expectedHead);
    const otherwiseReady = (pr: ObjectValue) =>
      pr.state === "OPEN" && pr.isDraft === false && !!pr.autoMergeRequest &&
      pr.mergeStateStatus === "BEHIND" &&
      (pr.reviewDecision === "APPROVED" || pr.reviewDecision === "" ||
        pr.reviewDecision === null) &&
      typeof pr.baseRefName === "string" &&
      typeof pr.headRefOid === "string";
    const ready = (pr: ObjectValue) =>
      otherwiseReady(pr) && pr.mergeable === "MERGEABLE";
    const initial = await readLivePr();
    if (!hasCurrentTarget(initial)) {
      return {
        ok: false,
        error: new Error("PR base or head changed before branch update"),
      };
    }
    const baseRefName = initial.baseRefName as string;
    const headRefOid = initial.headRefOid as string;
    const policy = await readStrictBasePolicy(
      repo,
      baseRefName,
      gh,
    );
    if (policy.mergeQueue) {
      return {
        ok: false,
        error: new Error("merge-queue base is exempt from behind-only refresh"),
      };
    }
    if (!policy.strict) {
      if (initial.mergeable === "UNKNOWN" || initial.mergeable === null) {
        return {
          ok: false,
          error: new Error("PR no longer ready for a branch update"),
        };
      }
      return await requestBranchUpdate(
        repo,
        prNumber,
        gh,
        headRefOid,
      );
    }
    let current = initial;
    if (
      otherwiseReady(initial) &&
      (initial.mergeable === "UNKNOWN" || initial.mergeable === null)
    ) {
      let firstRead = true;
      current = await retryWithBackoff(async () => {
        const live = firstRead ? initial : await readLivePr();
        firstRead = false;
        if (
          !hasCurrentTarget(live) || live.baseRefName !== baseRefName ||
          live.headRefOid !== headRefOid
        ) return live;
        if (
          otherwiseReady(live) &&
          (live.mergeable === "UNKNOWN" || live.mergeable === null)
        ) {
          throw new Error("PR mergeability is still UNKNOWN");
        }
        return live;
      }, {
        maxAttempts: 4,
        ...(ownershipSleepFn ? { sleepFn: ownershipSleepFn } : {}),
        shouldRetry: (error) =>
          error.message === "PR mergeability is still UNKNOWN",
      });
    }
    if (
      !hasCurrentTarget(current) || current.baseRefName !== baseRefName ||
      current.headRefOid !== headRefOid
    ) {
      return {
        ok: false,
        error: new Error("PR base or head changed before branch update"),
      };
    }
    if (!ready(current)) {
      return {
        ok: false,
        error: new Error("PR no longer ready for a branch update"),
      };
    }
    const workerId = `refresh-${crypto.randomUUID()}`;
    const stableAnchorPr = async (ownerRepo: string, _ownerBase: string) => {
      const payload = await gh([
        "api",
        `repos/${ownerRepo}/pulls?state=all&sort=created&direction=asc&per_page=1`,
        "--jq",
        "map(.number) | .[]",
      ]);
      const value = payload.trim();
      if (!/^\d+$/.test(value)) {
        throw new Error("stable PR anchor lookup did not return one PR");
      }
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error("stable PR anchor has no valid number");
      }
      return number;
    };
    const port = makeGitHubBaseRefreshOwnershipPort({
      workerId,
      ghCommandFn: gh,
      anchorPrForBase: stableAnchorPr,
      ...(ownershipSleepFn ? { sleepFn: ownershipSleepFn } : {}),
      ...(ownershipAuthorOptions
        ? { authorOptions: ownershipAuthorOptions }
        : {}),
      log: (message) => console.warn(message),
    });
    await reconcileBaseRefreshOwner(
      port,
      repo,
      baseRefName,
      async (owner): Promise<BaseRefreshStatus> => {
        try {
          const live = object(
            JSON.parse(
              await gh([
                "pr",
                "view",
                String(owner.prNumber),
                "--repo",
                repo,
                "--json",
                "state,headRefOid",
              ]),
            ),
            "refresh owner PR",
          );
          if (live.state === "MERGED") return "merged";
          if (live.state === "CLOSED") return "closed";
          if (live.state !== "OPEN" || typeof live.headRefOid !== "string") {
            return "failed";
          }
          return await readRequiredChecksFailed(
              repo,
              owner.base,
              live.headRefOid,
              gh,
            )
            ? "failed"
            : "active";
        } catch (error) {
          console.warn(
            `Refresh owner state is unreadable for ${repo}#${owner.prNumber}; retaining ownership for retry: ${
              redactSecrets(
                error instanceof Error ? error.message : String(error),
              )
            }`,
          );
          return "active";
        }
      },
    );
    const readCurrentTestMerge = () =>
      retryWithBackoff(
        () => readTestMerge(repo, prNumber, baseRefName, headRefOid, gh),
        {
          maxAttempts: 4,
          ...(ownershipSleepFn ? { sleepFn: ownershipSleepFn } : {}),
          shouldRetry: (error) =>
            error.message ===
              "PR test merge parents do not match its head and base",
        },
      );
    const merge = await readCurrentTestMerge();
    if (
      !await readRequiredChecksPassed(
        repo,
        baseRefName,
        headRefOid,
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
      !ready(fresh) || fresh.baseRefName !== baseRefName ||
      fresh.headRefOid !== headRefOid
    ) {
      return {
        ok: false,
        error: new Error("PR changed while its required checks were read"),
      };
    }
    const freshMerge = await readCurrentTestMerge();
    const freshChecksPassed = await readRequiredChecksPassed(
      repo,
      baseRefName,
      headRefOid,
      gh,
      freshMerge.mergeSha,
    );
    if (
      freshMerge.mergeSha !== merge.mergeSha ||
      freshMerge.baseSha !== merge.baseSha || !freshChecksPassed
    ) {
      return {
        ok: false,
        error: new Error(
          "PR test merge changed while required checks were read",
        ),
      };
    }
    const ownership = await acquireBaseRefreshOwner(port, {
      repo,
      base: baseRefName,
      prNumber,
      headSha: headRefOid,
      workerId,
      ttlSeconds: 6 * 60 * 60,
    });
    if (!ownership.acquired) {
      return {
        ok: false,
        error: new Error(
          `base refresh owned by ${repo}#${ownership.ownerPrNumber} (${ownership.ownerWorkerId})`,
        ),
      };
    }
    try {
      const immediatelyFresh = await readLivePr();
      if (
        !ready(immediatelyFresh) ||
        immediatelyFresh.baseRefName !== baseRefName ||
        immediatelyFresh.headRefOid !== headRefOid
      ) {
        throw new Error("PR base or head changed before branch update");
      }
      const immediateMerge = await readCurrentTestMerge();
      const immediateChecksPassed = await readRequiredChecksPassed(
        repo,
        baseRefName,
        headRefOid,
        gh,
        immediateMerge.mergeSha,
      );
      if (
        immediateMerge.mergeSha !== merge.mergeSha ||
        immediateMerge.baseSha !== merge.baseSha ||
        !immediateChecksPassed
      ) {
        throw new Error(
          "PR test merge or required checks changed before branch update",
        );
      }
    } catch (error) {
      await releaseBaseRefreshOwner(
        port,
        repo,
        baseRefName,
        ownership.ownerId,
      );
      throw error;
    }
    const update = await requestBranchUpdate(
      repo,
      prNumber,
      gh,
      headRefOid,
    );
    if (!update.ok) {
      await releaseBaseRefreshOwner(
        port,
        repo,
        baseRefName,
        ownership.ownerId,
      );
    }
    return update;
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

async function readStrictBasePolicy(
  repo: string,
  base: string,
  gh: (args: string[]) => Promise<string>,
): Promise<{ strict: boolean; mergeQueue: boolean }> {
  const encoded = encodeURIComponent(base);
  const pages = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/rules/branches/${encoded}?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("base rules pages are malformed");
  }
  const rules = pages.flat();
  const mergeQueue = rules.some((raw) =>
    object(raw, "branch rule").type === "merge_queue"
  );
  let strict = false;
  for (const strictRule of rules) {
    if (object(strictRule, "branch rule").type !== "required_status_checks") {
      continue;
    }
    const parameters = object(
      object(strictRule, "required checks rule").parameters,
      "required checks parameters",
    );
    if (typeof parameters.strict_required_status_checks_policy !== "boolean") {
      throw new Error("strict required-status-check policy is unreadable");
    }
    strict ||= parameters.strict_required_status_checks_policy;
  }
  const branch = object(
    JSON.parse(
      await gh([
        "api",
        `repos/${repo}/branches/${encoded}`,
      ]),
    ),
    "base branch",
  );
  let protection = classicChecksFromBranch(branch);
  if (protection !== null && typeof protection.strict !== "boolean") {
    if (
      protection.enforcement_level === "off" &&
      Array.isArray(protection.contexts) && protection.contexts.length === 0 &&
      Array.isArray(protection.checks) && protection.checks.length === 0
    ) {
      protection = null;
    } else {
      try {
        protection = object(
          JSON.parse(
            await gh([
              "api",
              `repos/${repo}/branches/${encoded}/protection/required_status_checks`,
            ]),
          ),
          "classic required-check protection",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /404/.test(message) &&
          /branch not protected|required status checks not enabled/i.test(
            message,
          )
        ) {
          protection = null;
        } else throw error;
      }
    }
  }
  if (protection !== null) {
    if (typeof protection.strict !== "boolean") {
      throw new Error("classic strict up-to-date policy is unreadable");
    }
    strict ||= protection.strict;
  }
  return { strict, mergeQueue };
}
