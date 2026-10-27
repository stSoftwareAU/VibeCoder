/**
 * GitHub merge queue availability and settings (Issue #4424).
 *
 * A merge queue can only be added to a ruleset where GitHub allows one. The
 * answer is read from repository and organisation metadata where that is
 * conclusive; where it is not, the worker creates a **disabled** probe ruleset
 * carrying a `merge_queue` rule and reads GitHub's answer to that, then deletes
 * the probe. Anything that cannot be established is `unknown` and is never
 * treated as available.
 *
 * This module only detects and describes. Wiring the rule into the
 * default-branch ruleset is the configurator's job
 * (`default_branch_ruleset.ts`).
 *
 * The `gh` executor is injected for testability, as in `repo_rulesets.ts`.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import {
  createRulesetReturningId,
  defaultGhExec,
  deleteRuleset,
  type GhExec,
  isValidRepoSlug,
  type MergeQueueParameters,
  type RulesetBody,
  RulesetIdUnreadableError,
  type RulesetResult,
} from "./repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

/** The `type` of the ruleset rule that enables a merge queue. */
export const MERGE_QUEUE_RULE_TYPE = "merge_queue";

/** Repo topic that opts a repository out of the merge queue. */
export const MERGE_QUEUE_OPT_OUT_TOPIC = "no-merge-queue";

/** Name of the disabled ruleset the probe creates and then deletes. */
export const MERGE_QUEUE_PROBE_NAME = "Vibe Coder merge queue probe";

/** Longest reason string returned, so a GitHub message cannot flood a log. */
const REASON_MAX_CHARS = 300;

type MergeMethod = MergeQueueParameters["merge_method"];

/** Outcome of {@link detectMergeQueueAvailability}. */
export type MergeQueueAvailability =
  | {
    status: "available";
    via: "metadata" | "probe";
    mergeMethod: MergeQueueParameters["merge_method"];
    reason: string;
  }
  // Definitive: GitHub does not allow a merge queue here.
  | { status: "unavailable"; via: "metadata" | "probe"; reason: string }
  // Could not be established; never treated as available.
  | { status: "unknown"; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The merge queue parameters the worker uses: squash-style grouping of up to
 * five entries, one-minute minimum wait, and a sixty-minute check timeout.
 */
export function buildMergeQueueParameters(
  mergeMethod: MergeQueueParameters["merge_method"],
): MergeQueueParameters {
  return {
    check_response_timeout_minutes: 60,
    grouping_strategy: "ALLGREEN",
    max_entries_to_build: 5,
    max_entries_to_merge: 5,
    merge_method: mergeMethod,
    min_entries_to_merge: 1,
    min_entries_to_merge_wait_minutes: 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped(text: string): string {
  return text.length > REASON_MAX_CHARS
    ? text.slice(0, REASON_MAX_CHARS)
    : text;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

/** The first non-empty line of a message, capped. */
function firstLine(text: string): string {
  return capped(nonEmptyLines(text)[0] ?? "(no message)");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse a JSON response; anything unparseable is `undefined`. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface RepoMetadata {
  ownerType: string;
  isPrivate: boolean;
  mergeMethod: MergeMethod;
}

/**
 * The merge method to probe and to report: squash when squash is allowed,
 * otherwise a merge commit when that is allowed, otherwise rebase. An absent
 * flag counts as allowed.
 */
function pickMergeMethod(repo: Record<string, unknown>): MergeMethod {
  if (repo.allow_squash_merge !== false) return "SQUASH";
  if (repo.allow_merge_commit !== false) return "MERGE";
  return "REBASE";
}

/**
 * Parse `GET repos/{repo}`. Any missing or wrongly typed field the decision
 * reads makes the whole response unusable, so the caller probes instead.
 */
function parseRepoMetadata(raw: string): RepoMetadata | undefined {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return undefined;
  const owner = parsed.owner;
  if (!isRecord(owner)) return undefined;
  const ownerType = owner.type;
  const isPrivate = parsed.private;
  if (typeof ownerType !== "string" || typeof isPrivate !== "boolean") {
    return undefined;
  }
  for (
    const key of [
      "allow_squash_merge",
      "allow_merge_commit",
      "allow_rebase_merge",
    ]
  ) {
    const flag = parsed[key];
    if (flag !== undefined && typeof flag !== "boolean") return undefined;
  }
  return { ownerType, isPrivate, mergeMethod: pickMergeMethod(parsed) };
}

async function readRepoMetadata(
  repo: string,
  ghFn: GhExec,
): Promise<RepoMetadata | undefined> {
  try {
    return parseRepoMetadata(await ghFn(["api", `repos/${repo}`]));
  } catch {
    return undefined;
  }
}

/**
 * The organisation's plan name, or `undefined` when it cannot be read (an
 * error, no `plan` object, or no usable `name`).
 */
async function readOrgPlanName(
  owner: string,
  ghFn: GhExec,
): Promise<string | undefined> {
  try {
    const parsed = parseJson(await ghFn(["api", `orgs/${owner}`]));
    if (!isRecord(parsed)) return undefined;
    const plan = parsed.plan;
    if (!isRecord(plan)) return undefined;
    const name = plan.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** The disabled probe ruleset: a `merge_queue` rule on the default branch. */
function probeRulesetBody(mergeMethod: MergeMethod): RulesetBody {
  return {
    name: MERGE_QUEUE_PROBE_NAME,
    target: "branch",
    enforcement: "disabled",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{
      type: MERGE_QUEUE_RULE_TYPE,
      parameters: buildMergeQueueParameters(mergeMethod),
    }],
  };
}

/** Classify a failed probe create: a 422 names GitHub's refusal; else unknown. */
function probeCreateFailure(error: Error): MergeQueueAvailability {
  const message = error.message;
  if (!/422|invalid rule/i.test(message)) {
    return { status: "unknown", reason: `probe failed: ${firstLine(message)}` };
  }
  const lines = nonEmptyLines(message);
  const cause = lines.find((line) => /invalid rule/i.test(line)) ??
    lines[0] ?? "(no message)";
  return {
    status: "unavailable",
    via: "probe",
    reason: `GitHub rejected a merge_queue rule on this repository: ${
      capped(cause)
    }`,
  };
}

/**
 * Delete the probe ruleset. Never throws: a failure is returned for the caller
 * to report, so the probe is always removed or its leftover is named.
 */
async function removeProbe(
  repo: string,
  probeId: number,
  ghFn: GhExec,
): Promise<RulesetResult<void>> {
  try {
    return await deleteRuleset(repo, probeId, ghFn);
  } catch (error) {
    return { ok: false, error: new Error(errorMessage(error)) };
  }
}

/**
 * Create the disabled probe, then delete it. The delete is attempted straight
 * after a successful create, with nothing in between that could skip it.
 */
async function probeMergeQueue(
  repo: string,
  mergeMethod: MergeMethod,
  ghFn: GhExec,
): Promise<MergeQueueAvailability> {
  const created = await createRulesetReturningId(
    repo,
    probeRulesetBody(mergeMethod),
    ghFn,
  );
  if (!created.ok) {
    if (created.error instanceof RulesetIdUnreadableError) {
      return {
        status: "unknown",
        reason:
          `a ruleset named "${MERGE_QUEUE_PROBE_NAME}" may have been created (${
            firstLine(created.error.message)
          }) and must be deleted by hand if present`,
      };
    }
    return probeCreateFailure(created.error);
  }

  const probeId = created.value;
  const removal = await removeProbe(repo, probeId, ghFn);
  if (!removal.ok) {
    return {
      status: "unknown",
      reason:
        `probe ruleset ${probeId} ("${MERGE_QUEUE_PROBE_NAME}") was created but could not be deleted (${
          firstLine(removal.error.message)
        }); it is disabled and must be deleted by hand`,
    };
  }
  return {
    status: "available",
    via: "probe",
    mergeMethod,
    reason:
      "GitHub accepted a merge_queue rule on a disabled probe ruleset, which has been deleted",
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function detect(
  repo: string,
  ghFn: GhExec,
): Promise<MergeQueueAvailability> {
  if (!isValidRepoSlug(repo)) {
    return {
      status: "unknown",
      reason: "invalid repository slug; merge queue availability not checked",
    };
  }

  const metadata = await readRepoMetadata(repo, ghFn);
  if (metadata === undefined) {
    // The metadata was unreadable or malformed, so the merge method is not
    // known. Probe with squash, the fleet's usual method.
    return await probeMergeQueue(repo, "SQUASH", ghFn);
  }

  if (metadata.ownerType !== "Organization") {
    return {
      status: "unavailable",
      via: "metadata",
      reason:
        "owned by a user account; GitHub allows merge queues on organisation-owned repositories only",
    };
  }

  if (!metadata.isPrivate) {
    return {
      status: "available",
      via: "metadata",
      mergeMethod: metadata.mergeMethod,
      reason: "public repository of an organisation",
    };
  }

  const owner = repo.slice(0, repo.indexOf("/"));
  const plan = await readOrgPlanName(owner, ghFn);
  if (plan === "enterprise") {
    return {
      status: "available",
      via: "metadata",
      mergeMethod: metadata.mergeMethod,
      reason: "private repository of an enterprise organisation",
    };
  }
  if (plan !== undefined) {
    return {
      status: "unavailable",
      via: "metadata",
      reason: `private repository on the "${
        capped(plan)
      }" plan; merge queue on a private repository needs GitHub Enterprise Cloud`,
    };
  }

  // The plan could not be read, so GitHub itself has to answer.
  return await probeMergeQueue(repo, metadata.mergeMethod, ghFn);
}

/**
 * Whether GitHub allows a merge queue on `repo`, with the merge method to use.
 *
 * Reads repository and organisation metadata first. Where that is not
 * conclusive, creates a disabled probe ruleset and deletes it again. Never
 * throws: anything that goes wrong is `unknown`, with a reason.
 */
export async function detectMergeQueueAvailability(
  repo: string,
  ghFn: GhExec = defaultGhExec,
): Promise<MergeQueueAvailability> {
  try {
    return await detect(repo, ghFn);
  } catch (error) {
    return {
      status: "unknown",
      reason: `merge queue availability could not be established: ${
        firstLine(errorMessage(error))
      }`,
    };
  }
}

/**
 * Whether the repository opts out of the merge queue, by carrying
 * {@link MERGE_QUEUE_OPT_OUT_TOPIC} among its topics. An unreadable topic list
 * is reported as an error, not as "not opted out".
 */
export async function readMergeQueueOptOut(
  repo: string,
  ghFn: GhExec = defaultGhExec,
): Promise<{ ok: true; optedOut: boolean } | { ok: false; error: string }> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: "invalid repository slug" };
  }
  let raw: string;
  try {
    raw = await ghFn(["api", `repos/${repo}/topics`]);
  } catch (error) {
    return { ok: false, error: firstLine(errorMessage(error)) };
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    return { ok: false, error: "topics response was not a JSON object" };
  }
  const names = parsed.names;
  if (!Array.isArray(names)) {
    return { ok: false, error: "topics response had no names list" };
  }
  return {
    ok: true,
    optedOut: names.includes(MERGE_QUEUE_OPT_OUT_TOPIC),
  };
}
