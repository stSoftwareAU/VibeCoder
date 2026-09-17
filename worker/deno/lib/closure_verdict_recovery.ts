/**
 * Ask for the closure verdict as data, and render the blocks (Issue #2242).
 *
 * The in-run recovery (#2189) hands the agent the gate's own remediation
 * comment — the exact template included — and asks it to write the block. On
 * VibeCoder#2104 that invocation ran for eighteen minutes and produced 103
 * lines of prose with no `## Acceptance Criteria` block, no `## Standards
 * Review` block and no `reviewer:` line anywhere, and the run died on the
 * second block. Two hour-long runs on one issue, on a rule documented in the
 * prompt and restated in the comment.
 *
 * So the shape stops being the model's job. When the recovery's own summary
 * still fails either gate, this module asks one constrained question — the
 * verdict as JSON, one entry per stated criterion plus the standards half —
 * and `closure_verdict.ts` renders the blocks the validators accept. A verdict
 * that does not cover every criterion is asked for once more, with the
 * shortfall named; a second short verdict is rendered as it stands, and the
 * gate blocks on it exactly as before. Nothing is invented at any step.
 *
 * ```mermaid
 * flowchart TD
 *     B["Gate blocked<br/>(no PR)"] --> R["#2189 recovery invocation"]
 *     R --> V{"Summary passes<br/>both gates?"}
 *     V -- yes --> Q["Quality gate → completion re-run"]
 *     V -- no --> A1["Ask: verdict as JSON"]
 *     A1 --> C{"Covers every<br/>criterion?"}
 *     C -- no --> A2["Ask once more<br/>(shortfalls named)"]
 *     A2 --> W
 *     C -- yes --> W["Worker renders the blocks<br/>into the summary"]
 *     W --> Q
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { extractAcceptanceCriteria } from "./acceptance_criteria_gate.ts";
import { validateAcceptanceClosure } from "./acceptance_criteria_gate.ts";
import { validateIndependentReview } from "./independent_review_gate.ts";
import { loadPrSummary } from "./pr_summary_loader.ts";
import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";
import {
  applyClosureBlocks,
  assessVerdictCoverage,
  CLOSURE_VERDICT_CLOSE,
  CLOSURE_VERDICT_OPEN,
  type ClosureVerdict,
  parseClosureVerdict,
  renderClosureBlocks,
} from "./closure_verdict.ts";
import {
  type IssueContext,
  type PhaseState,
  recordClaudeRunStats,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";

/** The canonical home of a PR summary, used when no file exists yet. */
function canonicalSummaryPath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
}

/** What the render attempt did, for the caller's log. */
export type ClosureRenderKind =
  /** The issue states no criteria — neither gate applies. */
  | "not-applicable"
  /** The summary already satisfies both gates; nothing was asked or written. */
  | "already-valid"
  /** The worker rendered the blocks into the summary. */
  | "rendered"
  /** No usable verdict was returned, so the summary is untouched. */
  | "unavailable";

/** Outcome of {@link renderClosureBlocksFromVerdict}. */
export interface ClosureRenderOutcome {
  kind: ClosureRenderKind;
  /** One line saying what happened — logged verbatim. */
  detail: string;
  /** Constrained verdict questions asked (0, 1 or 2). */
  asks: number;
  /** True when the rendered summary satisfies both gates. */
  valid: boolean;
}

/**
 * Build the constrained verdict question.
 *
 * One question, one answer shape, no file edits: the model supplies the
 * content and the worker owns the document. The criteria are quoted from an
 * attacker-supplied issue body, so they ride inside a CSPRNG-nonced untrusted
 * fence rather than as bare prompt text.
 *
 * @param opts.criteria - The criteria the issue body states, in body order.
 * @param opts.problems - What the gate said was wrong with the summary.
 * @param opts.shortfalls - Present on the re-ask: what the first verdict
 *   left outstanding.
 * @param opts.boundaryId - Pinned nonce for tests; production mints one.
 */
export function buildClosureVerdictPrompt(opts: {
  repo: string;
  issueNumber: number;
  criteria: readonly string[];
  problems: readonly string[];
  shortfalls?: readonly string[];
  boundaryId?: string;
}): string {
  if (opts.criteria.length === 0) {
    throw new Error(
      "buildClosureVerdictPrompt requires the issue's acceptance criteria",
    );
  }
  const numbered = opts.criteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join("\n");
  const example = JSON.stringify(
    {
      criteria: [
        {
          criterion: "criterion 1, as stated",
          status: "met",
          evidence: "worker/deno/tests/foo_test.ts::does the thing",
        },
        {
          criterion: "criterion 2, as stated",
          status: "partial",
          evidence: "worker/deno/lib/foo.ts",
          reason: "the second half is not wired up",
        },
        {
          criterion: "criterion 3, as stated",
          status: "missing",
          reason: "not attempted in this diff",
        },
      ],
      standards: [
        {
          status: "violation",
          finding: "American spelling in a new identifier",
          evidence: "worker/deno/lib/foo.ts:42",
          reason: "renamed in this diff",
        },
        {
          status: "clean",
          finding: "Australian English, TDD, fail-loud error handling",
        },
      ],
    },
    null,
    2,
  );

  const reAsk = opts.shortfalls && opts.shortfalls.length > 0
    ? [
      "",
      "Your previous verdict was short. Fix exactly this and answer again:",
      "",
      ...opts.shortfalls.map((s) => `- ${s}`),
    ]
    : [];

  return [
    `The PR summary for ${opts.repo}#${opts.issueNumber} does not close out ` +
    `this issue's acceptance criteria, so the PR cannot be raised:`,
    "",
    ...opts.problems.map((p) => `- ${p}`),
    "",
    "**This turn writes no files and changes no code.** The worker renders " +
    "the `## Acceptance Criteria` and `## Standards Review` blocks itself, " +
    "from the verdict you return here — so answer with the verdict and " +
    "nothing else.",
    "",
    ...fenceUntrustedIssueText(
      numbered,
      `The ${opts.criteria.length} criteria this issue states, in order:`,
      opts.boundaryId,
    ),
    "",
    "Judge the change on the branch — `git diff` against the base branch, and " +
    "the tests it adds — against each criterion above, and judge the same " +
    "diff against `CODING-STANDARDS.md`. Then reply with exactly one block:",
    "",
    CLOSURE_VERDICT_OPEN,
    "```json",
    example,
    "```",
    CLOSURE_VERDICT_CLOSE,
    "",
    "Rules the worker checks before it renders:",
    "",
    `- One \`criteria\` entry per stated criterion — all ${opts.criteria.length} ` +
    "of them, in order. A criterion the diff does not satisfy is `missing`, " +
    "never omitted.",
    "- `status` is exactly one of `met`, `partial`, `missing`, `unrequested`. " +
    "Add an `unrequested` entry for any change in the diff not traceable to " +
    "the issue.",
    "- `met` and `partial` name their `evidence` — the file, test or test " +
    "identifier that shows it.",
    "- `partial`, `missing` and `unrequested` carry a one-line `reason`.",
    "- `standards` carries one entry per departure from `CODING-STANDARDS.md` " +
    "(`violation`, with `evidence` as `file:line` and a `reason` saying " +
    "whether it was fixed), plus a `clean` entry naming the areas you checked " +
    "and found compliant.",
    "- Never inflate a status, and never invent evidence. `partial` with the " +
    "gap named is a better answer than an unsupported `met`.",
    ...reAsk,
  ].join("\n");
}

/** Ask the model one constrained verdict question. */
async function askForVerdict(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  prompt: string,
): Promise<ClosureVerdict | null> {
  const { repo, issueNumber, config } = ctx;
  const logger = deps.logger;
  const result = await deps.claude.runClaudeWithRetry(
    {
      prompt,
      phase: "issue",
      repo,
      issueNumber,
      timeoutSeconds: config.claudeTimeout,
      killAfterSeconds: config.claudeKillAfter,
      model: config.claudeModel || undefined,
      cwd: state.repoPath,
      logger,
    },
    { maxRetries: config.maxRateLimitRetries },
  );
  if (!result.ok) {
    logger.warn(
      `Closure-verdict question could not be launched: ${result.error.message}`,
      { repo, issueNumber },
    );
    return null;
  }
  recordClaudeRunStats(state, result.value);

  const parsed = parseClosureVerdict(result.value.output ?? "");
  if (!parsed.ok) {
    // A verdict that cannot be read is not an empty verdict — say which, so a
    // model that stopped answering in the agreed shape is visible in the log.
    logger.warn(
      `Closure verdict not returned in the agreed shape: ${parsed.error.message}`,
      { repo, issueNumber },
    );
    return null;
  }
  if (parsed.value.dropped.length > 0) {
    logger.warn("Closure verdict carried entries that could not be read", {
      repo,
      issueNumber,
      dropped: parsed.value.dropped,
    });
  }
  return parsed.value;
}

/** Write the summary back where it was read from, creating the canonical path. */
async function writeSummary(
  repoPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = `${repoPath}/${relativePath}`;
  const directory = fullPath.slice(0, fullPath.lastIndexOf("/"));
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(fullPath, content);
}

/**
 * Render the review blocks into the run's PR summary from a model verdict.
 *
 * Called by the #2189 recovery after its agent invocation, before the quality
 * gate. Does nothing when the issue states no criteria, or when the summary
 * the agent wrote already satisfies both gates — the model writing the block
 * itself is still the happy path, and this is the floor beneath it.
 *
 * @returns What happened, for the caller's log. Never throws on a missing or
 *   unreadable verdict: the summary is left exactly as the agent wrote it and
 *   the gate blocks on it, which is the existing behaviour.
 */
export async function renderClosureBlocksFromVerdict(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<ClosureRenderOutcome> {
  const { repo, issueNumber } = ctx;
  const logger = deps.logger;
  const criteria = extractAcceptanceCriteria(ctx.issueBody);
  if (criteria.length === 0) {
    return {
      kind: "not-applicable",
      detail: "the issue states no acceptance criteria",
      asks: 0,
      valid: true,
    };
  }

  const loaded = await loadPrSummary(state.repoPath, issueNumber);
  if (!loaded.ok) {
    logger.warn(
      `Could not read the PR summary to render the closure block: ${loaded.error.message}`,
      { repo, issueNumber },
    );
    return {
      kind: "unavailable",
      detail: `the PR summary could not be read: ${loaded.error.message}`,
      asks: 0,
      valid: false,
    };
  }
  const existing = loaded.value.content;
  const relativePath = loaded.value.source === "not_found"
    ? canonicalSummaryPath(issueNumber)
    : loaded.value.source;

  const gateProblems = [
    ...validateAcceptanceClosure({
      issueBody: ctx.issueBody,
      prSummaryContent: existing,
    }).problems,
    ...validateIndependentReview({
      issueBody: ctx.issueBody,
      prSummaryContent: existing,
    }).problems,
  ];
  if (gateProblems.length === 0) {
    return {
      kind: "already-valid",
      detail: "the recovery's own summary satisfies both gates",
      asks: 0,
      valid: true,
    };
  }

  logger.warn(
    "Rendering the review blocks from a structured verdict — the recovery's " +
      "summary still fails the gates (Issue #2242)",
    { repo, issueNumber, problems: gateProblems },
  );

  let asks = 0;
  let verdict = await askForVerdict(
    ctx,
    state,
    deps,
    buildClosureVerdictPrompt({
      repo,
      issueNumber,
      criteria,
      problems: gateProblems,
    }),
  );
  asks++;

  // A verdict short of a criterion is asked for once more, with the shortfall
  // named. Exactly once: a second short verdict is rendered as it stands and
  // the gate blocks on it, which is the honest report of a shortfall.
  const coverage = verdict
    ? assessVerdictCoverage(verdict, criteria)
    : { complete: false, shortfalls: ["no verdict was returned at all"] };
  if (!coverage.complete) {
    logger.warn("Closure verdict incomplete — asking once more", {
      repo,
      issueNumber,
      shortfalls: coverage.shortfalls,
    });
    const second = await askForVerdict(
      ctx,
      state,
      deps,
      buildClosureVerdictPrompt({
        repo,
        issueNumber,
        criteria,
        problems: gateProblems,
        shortfalls: coverage.shortfalls,
      }),
    );
    asks++;
    // Keep the better of the two: a second answer that is worse than the first
    // must not cost the run the verdict it already had.
    if (
      second &&
      (!verdict ||
        assessVerdictCoverage(second, criteria).shortfalls.length <=
          coverage.shortfalls.length)
    ) {
      verdict = second;
    }
  }

  if (!verdict) {
    logger.warn(
      "No usable closure verdict was returned — the summary is left as the " +
        "recovery wrote it and the gate block stands",
      { repo, issueNumber, asks },
    );
    return {
      kind: "unavailable",
      detail: "no usable verdict was returned in two questions",
      asks,
      valid: false,
    };
  }

  const blocks = renderClosureBlocks(verdict);
  const base = existing.trim() === ""
    ? `## Summary\n\nCloses #${issueNumber}.\n`
    : existing;
  const updated = applyClosureBlocks(base, blocks);
  await writeSummary(state.repoPath, relativePath, updated);

  const valid = validateAcceptanceClosure({
    issueBody: ctx.issueBody,
    prSummaryContent: updated,
  }).valid &&
    validateIndependentReview({
      issueBody: ctx.issueBody,
      prSummaryContent: updated,
    }).valid;

  const detail = valid
    ? `rendered ${verdict.criteria.length} criteria and ` +
      `${verdict.standards.length} standards findings into ${relativePath}`
    : `rendered ${verdict.criteria.length} criteria into ${relativePath}, ` +
      `which still does not satisfy both gates`;
  if (valid) {
    logger.info(`Closure block rendered from the model's verdict: ${detail}`, {
      repo,
      issueNumber,
      asks,
    });
  } else {
    // Loud: the run is about to fail the gate again, and the reason is that
    // the verdict itself was short — not that the render misfired.
    logger.warn(`Closure block rendered but still short: ${detail}`, {
      repo,
      issueNumber,
      asks,
    });
  }

  return { kind: "rendered", detail, asks, valid };
}
