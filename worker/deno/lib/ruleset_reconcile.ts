/**
 * Reconcile a committed ruleset payload against the one GitHub applies
 * (Issue #1049).
 *
 * `infra/rulesets/*.json` call themselves the source of truth for the rulesets
 * this repository expects. A committed file on its own is only a wish: the tag
 * ruleset of Issue #869 was applied by hand without its `update` rule, so a
 * release tag could still be fast-forwarded onto a later commit while the file
 * said otherwise, and nothing in the repository would have noticed.
 *
 * This module is the half that notices, shared by the branch check of Issue
 * #858 and the tag check of Issue #1049 — same payload shape, one fetch, one
 * comparison. Failure modes are separated, never conflated:
 *
 *   - **drift** — the ruleset was read and differs. Reported field by field.
 *   - **absent** — no ruleset of that name and target exists. Fails loud: an
 *     absent ruleset is indistinguishable from an unprotected ref.
 *   - **skipped** — no credential, no `administration:read`, or GitHub
 *     unreachable. Says `SKIPPED` in as many words; never reported as
 *     agreement.
 *
 * Anything else propagates. A `gh` failure this module does not recognise is
 * not quietly turned into a pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import {
  defaultGhExec,
  type GhExec,
  isValidRepoSlug,
} from "./repo_rulesets.ts";
import type { RulesetPayload, RulesetRule } from "./ruleset_payload.ts";

/** One field where the applied ruleset differs from the committed payload. */
export interface RulesetDrift {
  /** The payload field that differs, e.g. `required_status_checks`. */
  field: string;
  /** One line naming what differs, applied versus committed. */
  detail: string;
}

/** Outcome of one comparison. */
export type RulesetStatus = "ok" | "drift" | "absent" | "skipped";

/** What a reconciliation found. */
export interface RulesetReconcileResult {
  status: RulesetStatus;
  /** Every field that differs. Empty unless the status is `drift`. */
  findings: RulesetDrift[];
  /** Operator-facing summary — the diff, or why nothing was compared. */
  message: string;
}

/** Options for {@link reconcileRuleset}. */
export interface RulesetReconcileOptions {
  /** `owner/repo` whose ruleset is read. */
  repo: string;
  /** The committed payload the applied ruleset must match. */
  committed: RulesetPayload;
  /** Repo-relative path of that payload, named in every message. */
  path: string;
  /** Injectable `gh` executor; defaults to the shared chokepoint. */
  ghExec?: GhExec;
  /** Target-specific comparisons appended to the generic diff. */
  extraDiff?: (live: unknown, committed: RulesetPayload) => RulesetDrift[];
}

/** A ruleset as `GET /repos/{repo}/rulesets` lists it. */
interface RulesetSummary {
  id?: number;
  name?: string;
  target?: string;
}

/** Categories that mean "could not look", not "looked and found nothing". */
const SKIP_CATEGORIES = new Set([
  GitHubErrorCategory.Authentication,
  GitHubErrorCategory.Permission,
  GitHubErrorCategory.Network,
  GitHubErrorCategory.RateLimit,
  GitHubErrorCategory.TransientServer,
]);

/** The rules a live payload carries, tolerating a missing or odd field. */
export function liveRulesetRules(live: unknown): RulesetRule[] {
  const rules = (live as { rules?: unknown } | null)?.rules;
  return Array.isArray(rules) ? rules as RulesetRule[] : [];
}

/** Coerce the live payload into the parsed shape, tolerating missing fields. */
function liveView(live: unknown): {
  name: string;
  target: string;
  enforcement: string;
  bypassActors: unknown[];
  include: string[];
  exclude: string[];
  rules: RulesetRule[];
} {
  const obj = (typeof live === "object" && live !== null)
    ? live as Record<string, unknown>
    : {};
  const conditions = obj.conditions as
    | { ref_name?: { include?: unknown; exclude?: unknown } }
    | undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    target: typeof obj.target === "string" ? obj.target : "",
    enforcement: typeof obj.enforcement === "string" ? obj.enforcement : "",
    bypassActors: Array.isArray(obj.bypass_actors) ? obj.bypass_actors : [],
    include: strings(conditions?.ref_name?.include),
    exclude: strings(conditions?.ref_name?.exclude),
    rules: liveRulesetRules(live),
  };
}

/**
 * Compare two lists as sets, returning what the first is missing and has
 * extra.
 */
export function setDiff(
  applied: string[],
  wanted: string[],
): { missing: string[]; extra: string[] } {
  const appliedSet = new Set(applied);
  const wantedSet = new Set(wanted);
  return {
    missing: wanted.filter((v) => !appliedSet.has(v)),
    extra: applied.filter((v) => !wantedSet.has(v)),
  };
}

/**
 * Compare the ruleset GitHub applies against the committed payload.
 *
 * Every field that could weaken enforcement is compared, not just the rule
 * types: a ruleset with a bypass actor is technically still "active" and
 * protects nothing, and one whose enforcement dropped to `evaluate` reports
 * without blocking. An empty array means the two agree.
 */
export function diffRulesetPayloads(
  live: unknown,
  committed: RulesetPayload,
): RulesetDrift[] {
  const applied = liveView(live);
  const drift: RulesetDrift[] = [];
  const note = (field: string, detail: string) => drift.push({ field, detail });

  for (
    const [field, appliedValue, wantedValue] of [
      ["name", applied.name, committed.name],
      ["target", applied.target, committed.target],
      ["enforcement", applied.enforcement, committed.enforcement],
    ] as Array<[string, string, string]>
  ) {
    if (appliedValue !== wantedValue) {
      note(field, `applied "${appliedValue}", committed "${wantedValue}"`);
    }
  }

  if (applied.bypassActors.length !== committed.bypass_actors.length) {
    note(
      "bypass_actors",
      `applied ${applied.bypassActors.length} bypass actor(s), committed ` +
        `${committed.bypass_actors.length} — a bypass actor makes an active ` +
        "ruleset protect nothing",
    );
  }

  for (
    const [field, appliedList, wantedList] of [
      [
        "conditions.ref_name.include",
        applied.include,
        committed.conditions.ref_name.include,
      ],
      [
        "conditions.ref_name.exclude",
        applied.exclude,
        committed.conditions.ref_name.exclude,
      ],
    ] as Array<[string, string[], string[]]>
  ) {
    const { missing, extra } = setDiff(appliedList, wantedList);
    for (const value of missing) note(field, `"${value}" is not applied`);
    for (const value of extra) {
      note(field, `"${value}" is applied but not committed`);
    }
  }

  const ruleDiff = setDiff(
    applied.rules.map((rule) => rule.type),
    committed.rules.map((rule) => rule.type),
  );
  for (const type of ruleDiff.missing) {
    note("rules", `rule "${type}" is committed but not applied`);
  }
  for (const type of ruleDiff.extra) {
    note("rules", `rule "${type}" is applied but not committed`);
  }

  return drift;
}

/** The `gh api` call that applies the committed payload over an existing one. */
export function applyRulesetCommand(
  repo: string,
  rulesetId: number | string,
  path: string,
): string {
  return `gh api --method PUT repos/${repo}/rulesets/${rulesetId} ` +
    `--input ${path}`;
}

/** Parse `gh` output, failing loud when it is not the JSON we asked for. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`could not read ${what} — ${(error as Error).message}`);
  }
}

/**
 * Compare the applied ruleset against a committed payload.
 *
 * Nothing is written. The ruleset is matched by the committed payload's `name`
 * on its own target — never by id, so recreating it by hand does not silently
 * stop the check working.
 */
export async function reconcileRuleset(
  options: RulesetReconcileOptions,
): Promise<RulesetReconcileResult> {
  const { repo, committed, path, ghExec = defaultGhExec, extraDiff } = options;
  if (!isValidRepoSlug(repo)) {
    throw new Error(`invalid repo slug: ${repo}`);
  }

  let listText: string;
  try {
    listText = await ghExec(["api", `repos/${repo}/rulesets`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SKIP_CATEGORIES.has(classifyGitHubError(message).category)) {
      return {
        status: "skipped",
        findings: [],
        message: `SKIPPED: the ${repo} rulesets could not be read — ` +
          `${message}. Nothing was compared; this is not a pass.`,
      };
    }
    throw error;
  }

  const summaries = parseJson(listText, `the ${repo} ruleset list`);
  const match = (Array.isArray(summaries) ? summaries as RulesetSummary[] : [])
    .find((entry) =>
      entry?.name === committed.name &&
      (entry.target === undefined || entry.target === committed.target)
    );
  if (!match?.id) {
    return {
      status: "absent",
      findings: [],
      message:
        `No ${committed.target} ruleset named "${committed.name}" exists on ` +
        `${repo}. ${path} describes a ruleset that is not applied, so the ` +
        "refs it names are unprotected. Create it with: " +
        `gh api --method POST repos/${repo}/rulesets --input ${path}`,
    };
  }

  const detailText = await ghExec([
    "api",
    `repos/${repo}/rulesets/${match.id}`,
  ]);
  const live = parseJson(detailText, `ruleset ${match.id} on ${repo}`);
  const findings = [
    ...diffRulesetPayloads(live, committed),
    ...(extraDiff ? extraDiff(live, committed) : []),
  ];
  if (findings.length === 0) {
    return {
      status: "ok",
      findings,
      message:
        `Ruleset "${committed.name}" (${match.id}) on ${repo} matches ${path}.`,
    };
  }
  const lines = findings.map((f) => `  - ${f.field}: ${f.detail}`).join("\n");
  return {
    status: "drift",
    findings,
    message: `Ruleset "${committed.name}" (${match.id}) on ${repo} differs ` +
      `from ${path}:\n${lines}\n\nApply the committed payload with:\n  ` +
      applyRulesetCommand(repo, match.id, path),
  };
}
