// Which model wrote each /review-fleet-prs review, and what it cost.
//
// Every review the skill posts ends with a run footer: a visible line naming
// the provider, the model(s) and the effort of the round that wrote it and its
// estimated USD, plus a hidden `vibe-review-run` marker a report can sum:
//
//   _Review run: provider claude · model claude-opus-5-5 · effort xhigh ·
//   estimated cost $0.4100 (estimate only; this PR's 1/3 share of the round)._
//   <!-- vibe-review-run round="20261016-101500" attempt="1" provider="claude"
//   models="claude-opus-5-5" effort="xhigh" usd="0.4100" share="1/3" -->
//
// How the cost is attributed. One round is one `claude -p` session: its main
// session reads the skill and starts one reviewer sub-agent per ready PR, in
// the background and in parallel, then posts each reply with post.ts. The
// CLI's per-message stream usage under-reports output tokens (each message's
// usage is a snapshot taken at its first block), so no exact per-PR figure
// exists. The CLI's own result `modelUsage` is exact for the whole session,
// sub-agents included, so each attempt is priced from its last result line
// and split equally across the PRs the round was given (the gate's `ready`
// list): every review an attempt posts carries 1/N of that attempt's
// estimate. A round is a fresh session, never resumed, so `modelUsage` is the
// attempt's own and needs no baseline (model_usage_scope.ts).
//
// The cost is only known once the attempt ends, after its reviews are posted,
// so post.ts posts the footer with "cost unknown" and the runner amends each
// review's body when the round is over (`amendRound`). An attempt that never
// ended (the runner's alarm killed it), a stream with no result line, or a
// model with no pricing row stays "cost unknown" — never $0. Prices are the
// worker's own (`estimateRunCost`, token_usage.ts): a non-Claude provider's
// figure is its API-equivalent list price, labelled so.
//
// Usage (the runner, on the host, after a round):
//   deno run --allow-run=gh --allow-read --allow-write review_cost.ts \
//     --round-dir=<dir>
// Output: one line of JSON, { round, attempts, amended, errors }.

import {
  attributeUsageByModel,
  estimateRunCost,
  formatUsd,
  type ModelUsageEntry,
} from "../../../../worker/deno/lib/cost_estimate.ts";
import { extractRunStats } from "../../../../worker/deno/lib/run_stats.ts";
import { CLAUDE_PROVIDER_ID } from "../../../../worker/deno/lib/agent_provider.ts";
import {
  REVIEW_RUN_FILE,
  type ReviewRunAttempt,
  type ReviewRunRecord,
} from "../../../../worker/deno/lib/review_run_record.ts";
import type { RunGh } from "./needs_human.ts";

/** The visible footer line starts with this. */
export const RUN_FOOTER_PREFIX = "_Review run: ";
/** The hidden marker's name. */
export const RUN_MARKER = "vibe-review-run";
/** The reviews a round posted, one JSON line each, in its directory. */
export const POSTED_FILE = "posted.jsonl";

/** What a review's run footer says about the model run that wrote it. */
export type RunInfo =
  | {
    kind: "round";
    round: string;
    attempt: number;
    provider: string;
    models: string[];
    effort: string | null;
    /** This PR's share of the attempt's estimate, or null when unknown. */
    usd: number | null;
    /** True when the price is an API-equivalent list price. */
    apiEquivalent: boolean;
    /** The number of PRs the attempt's estimate was split across. */
    share?: number;
  }
  // Posted from an interactive /review-fleet-prs session: the script cannot
  // see the session's model or its usage.
  | { kind: "interactive" }
  // Posted with no model run at all (a dependency-audit send-back).
  | { kind: "no-model" };

/** A review a round posted, as recorded in {@link POSTED_FILE}. */
export interface PostedReview {
  repo: string;
  number: number;
  attempt: number;
}

// Marker values are model ids, provider ids and numbers; anything else is
// dropped so a value can never close the comment or the attribute.
const safe = (value: string) => value.replace(/[^A-Za-z0-9._:/,+-]/g, "");

/** The footer: the visible line, then the hidden marker. */
export function runFooter(info: RunInfo): string {
  if (info.kind === "interactive") {
    return [
      `${RUN_FOOTER_PREFIX}interactive session · model unknown · cost unknown._`,
      `<!-- ${RUN_MARKER} provider="unknown" models="" effort="" usd="unknown" -->`,
    ].join("\n");
  }
  if (info.kind === "no-model") {
    return [
      `${RUN_FOOTER_PREFIX}no model run · estimated cost ${formatUsd(0)}._`,
      `<!-- ${RUN_MARKER} provider="none" models="" effort="" usd="${
        (0).toFixed(4)
      }" -->`,
    ].join("\n");
  }
  const models = info.models.length > 0 ? info.models.join(", ") : "unknown";
  const effort = info.effort ?? "unknown";
  const share = info.share !== undefined && info.share > 1
    ? `this PR's 1/${info.share} share of the round`
    : "the whole round";
  const cost = info.usd === null
    ? "cost unknown"
    : `estimated cost ${formatUsd(info.usd)} (${
      info.apiEquivalent ? "API-equivalent estimate" : "estimate only"
    }; ${share})`;
  const attrs = [
    `round="${safe(info.round)}"`,
    `attempt="${info.attempt}"`,
    `provider="${safe(info.provider)}"`,
    `models="${safe(info.models.join(","))}"`,
    `effort="${safe(info.effort ?? "")}"`,
    `usd="${info.usd === null ? "unknown" : info.usd.toFixed(4)}"`,
    ...(info.share !== undefined ? [`share="1/${info.share}"`] : []),
  ];
  return [
    `${RUN_FOOTER_PREFIX}provider ${info.provider} · model ${models} · effort ${effort} · ${cost}._`,
    `<!-- ${RUN_MARKER} ${attrs.join(" ")} -->`,
  ].join("\n");
}

/** `body` with its run footer (if any) replaced by the one for `info`. */
export function withRunFooter(body: string, info: RunInfo): string {
  const kept = body.split("\n").filter((line) =>
    !line.startsWith(RUN_FOOTER_PREFIX) &&
    !line.startsWith(`<!-- ${RUN_MARKER} `)
  ).join("\n").trimEnd();
  return `${kept}\n\n${runFooter(info)}`;
}

/** Read a round's attempt log, or undefined when there is none. */
export async function readReviewRun(
  roundDir: string,
): Promise<ReviewRunRecord | undefined> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(`${roundDir}/${REVIEW_RUN_FILE}`),
    );
    return typeof parsed?.round === "string" && Array.isArray(parsed.attempts)
      ? parsed as ReviewRunRecord
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What post.ts says about the run posting a review: the attempt still
 * running in `roundDir`, an interactive session when there is no round, or
 * no model run at all.
 */
export async function postRunInfo(
  roundDir: string | undefined,
  options: { noModel?: boolean } = {},
): Promise<RunInfo> {
  if (options.noModel) return { kind: "no-model" };
  const record = roundDir === undefined
    ? undefined
    : await readReviewRun(roundDir);
  const current = record?.attempts.at(-1);
  if (record === undefined || current === undefined) {
    return { kind: "interactive" };
  }
  return {
    kind: "round",
    round: record.round,
    attempt: current.attempt,
    provider: current.provider,
    models: current.model ? [current.model] : [],
    effort: current.effort,
    usd: null,
    apiEquivalent: current.provider !== CLAUDE_PROVIDER_ID,
  };
}

/** Record a review a round posted, so the runner can price it afterwards. */
export async function recordPosted(
  roundDir: string,
  posted: PostedReview,
): Promise<void> {
  await Deno.writeTextFile(
    `${roundDir}/${POSTED_FILE}`,
    JSON.stringify(posted) + "\n",
    { append: true },
  );
}

/** One attempt's models and estimated USD, from its stream-json. */
export interface AttemptCost {
  models: string[];
  /** The whole attempt's estimate, or null when it cannot be priced. */
  usd: number | null;
  apiEquivalent: boolean;
}

const isClaudeModel = (model: string) => /^claude-/i.test(model);

/**
 * Price one attempt from its stream-json, with the worker's own pricing.
 *
 * The last result line's `modelUsage` is the session's running total, so it
 * covers the whole attempt, sub-agents included; `attributeUsageByModel`
 * adds any shortfall against the result's `usage` on the first served model.
 * On a non-Claude provider, a `claude-*` id is the requested alias (the
 * reviewer agent's pinned model) answered by that provider's own endpoint:
 * it is named and priced as the attempt's model, never at Claude's rate.
 */
export function attemptCost(
  stream: string,
  attempt: ReviewRunAttempt,
): AttemptCost {
  const stats = extractRunStats(stream);
  const thirdParty = attempt.provider !== CLAUDE_PROVIDER_ID;
  const requested = attempt.model ?? stats.servedModels[0] ?? "";
  const rename = (model: string) =>
    thirdParty && isClaudeModel(model) && attempt.model ? attempt.model : model;
  const distinct = (ids: string[]) => [...new Set(ids.map(rename))];
  if (!stats.tokenUsage) {
    const served = distinct(stats.servedModels);
    return {
      models: served.length > 0 ? served : requested ? [requested] : [],
      usd: null,
      apiEquivalent: thirdParty,
    };
  }
  const entries: ModelUsageEntry[] = attributeUsageByModel(
    stats.tokenUsage,
    stats.modelUsage,
    stats.servedModels[0] ?? requested,
  ).map((e) => ({ model: rename(e.model), usage: e.usage }));
  const estimate = estimateRunCost(entries);
  const priced = estimate.perModel.filter((m) =>
    m.usage.inputTokens + m.usage.outputTokens + m.usage.cacheCreationTokens +
        m.usage.cacheReadTokens > 0
  );
  return {
    models: distinct(priced.map((m) => m.model)),
    usd: estimate.hasUnknownPricing || priced.length === 0
      ? null
      : estimate.totalCost,
    apiEquivalent: priced.some((m) => m.apiEquivalent),
  };
}

/** The reviews a round posted, in order. */
async function readPosted(roundDir: string): Promise<PostedReview[]> {
  const text = await Deno.readTextFile(`${roundDir}/${POSTED_FILE}`)
    .catch(() => "");
  const posted: PostedReview[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const p = JSON.parse(line);
      if (
        typeof p.repo === "string" && Number.isInteger(p.number) &&
        Number.isInteger(p.attempt)
      ) posted.push(p);
    } catch {
      // A torn line names no review.
    }
  }
  return posted;
}

/** How many PRs the round was given: the gate's `ready` list. */
async function readyCount(roundDir: string): Promise<number | undefined> {
  try {
    const gate = JSON.parse(await Deno.readTextFile(`${roundDir}/gate.json`));
    return Array.isArray(gate?.ready) && gate.ready.length > 0
      ? gate.ready.length
      : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link amendRound} did. */
export interface AmendSummary {
  round: string | null;
  attempts: {
    attempt: number;
    provider: string;
    models: string[];
    usd: number | null;
  }[];
  amended: number;
  errors: string[];
}

/**
 * Once a round is over, add each posted review's share of its attempt's
 * cost to the review's body on GitHub. Reviews of an attempt that never
 * ended, or whose cost is unknown, are left saying "cost unknown". A failure
 * to read or update one review is reported and never stops the others.
 */
export async function amendRound(
  roundDir: string,
  gh: RunGh,
): Promise<AmendSummary> {
  const summary: AmendSummary = {
    round: null,
    attempts: [],
    amended: 0,
    errors: [],
  };
  const record = await readReviewRun(roundDir);
  if (!record) return summary;
  summary.round = record.round;
  const posted = await readPosted(roundDir);
  const costs = new Map<number, AttemptCost>();
  for (const attempt of record.attempts) {
    if (attempt.code === undefined) continue; // never ended
    const stream = await Deno.readTextFile(`${roundDir}/${attempt.stream}`)
      .catch(() => "");
    const cost = attemptCost(stream, attempt);
    costs.set(attempt.attempt, cost);
    summary.attempts.push({
      attempt: attempt.attempt,
      provider: attempt.provider,
      models: cost.models,
      usd: cost.usd,
    });
  }
  const ready = await readyCount(roundDir);
  for (const p of posted) {
    const cost = costs.get(p.attempt);
    const attempt = record.attempts.find((a) => a.attempt === p.attempt);
    if (!cost || !attempt || cost.usd === null) continue;
    const share = ready ??
      new Set(
        posted.filter((q) => q.attempt === p.attempt).map((q) =>
          `${q.repo}#${q.number}`
        ),
      ).size;
    const info: RunInfo = {
      kind: "round",
      round: record.round,
      attempt: p.attempt,
      provider: attempt.provider,
      models: cost.models,
      effort: attempt.effort,
      usd: cost.usd / share,
      apiEquivalent: cost.apiEquivalent,
      share,
    };
    const tag = `round="${safe(record.round)}" attempt="${p.attempt}" `;
    try {
      // One object per line, so every page parses on its own.
      const reviews: { id: number; body?: string }[] = (await gh([
        "api",
        `repos/${p.repo}/pulls/${p.number}/reviews?per_page=100`,
        "--paginate",
        "--jq",
        ".[] | {id, body}",
      ])).split("\n").filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
      const mine = reviews.filter((r) =>
        (r.body ?? "").includes(`<!-- ${RUN_MARKER} ${tag}`) &&
        (r.body ?? "").includes('usd="unknown"')
      );
      for (const r of mine) {
        // The body goes in a file, not on the command line: a long review
        // could pass the length one argument may have.
        const input = await Deno.makeTempFile({ suffix: ".json" });
        try {
          await Deno.writeTextFile(
            input,
            JSON.stringify({ body: withRunFooter(r.body ?? "", info) }),
          );
          await gh([
            "api",
            "-X",
            "PUT",
            `repos/${p.repo}/pulls/${p.number}/reviews/${r.id}`,
            "--input",
            input,
          ]);
        } finally {
          await Deno.remove(input).catch(() => {});
        }
        summary.amended++;
      }
    } catch (e) {
      summary.errors.push(`${p.repo}#${p.number}: ${(e as Error).message}`);
    }
  }
  return summary;
}

async function run(args: string[]): Promise<string> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

if (import.meta.main) {
  const roundDir = Deno.args.find((a) => a.startsWith("--round-dir="))
    ?.slice("--round-dir=".length);
  if (!roundDir) throw new Error("--round-dir=<dir> is required");
  console.log(JSON.stringify(await amendRound(roundDir, run)));
}
