/**
 * The Quorum orchestrator (Issue #4111, parent #4102, milestone #4060).
 *
 * Two providers draft a plan for the same issue **concurrently**, a third
 * judges the two anonymised drafts, and this module reports what happened —
 * winner, runner-up, the judge's reasoning, per-agent timings, and a named
 * degradation whenever the run was not a clean three-agent quorum.
 *
 * There is no GitHub I/O here, deliberately. Splitting the orchestration from
 * the GitHub-facing processor mirrors `planning_run_stats.ts` beside
 * `planning_processor.ts`: the judging logic and its failure modes are where
 * the interesting tests live, and they should not need a GitHub fake to
 * exercise. The caller supplies the invoker, so the whole module is driven by
 * fakes in tests and by `runClaudeWithRetry` in production.
 *
 * ```mermaid
 * flowchart LR
 *     I["Issue context"] --> D["Draft prompt"]
 *     D --> A["Planner @ position A"]
 *     D --> B["Planner @ position B"]
 *     A --> J["Judge prompt<br/>(both plans fenced)"]
 *     B --> J
 *     J --> V["Verdict"]
 *     V --> R["QuorumRunResult"]
 * ```
 *
 * Four decisions carry the weight:
 *
 * - **Concurrency.** The drafts are raced together, so Quorum costs one draft
 *   plus one judgement rather than two drafts plus one.
 * - **Position assignment.** A/B comes from the issue number, never from the
 *   order the providers were supplied in. Position bias is a real judging
 *   failure mode, and a fixed pairing would bake it into every verdict.
 * - **No silent winner.** A drafter failure, a judge failure, and an
 *   unreadable verdict each produce a distinct outcome with a stated reason;
 *   none of them falls back to Plan A (Issue #3234).
 * - **Bounded agents.** Every invocation is abandoned after its timeout plus
 *   the kill-after grace, the way `grillMeTimeout` / `grillMeKillAfter` bound
 *   a grill-me round, so one hung CLI cannot stall the worker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { RunStats } from "./run_stats.ts";
import {
  type AgentProviderDescriptor,
  type AgentProviderSelection,
  type AgentProviderSelector,
  selectAgentProvider,
} from "./agent_provider.ts";
import { loadPrompt, validatePromptTemplate } from "./prompt_manager.ts";
import {
  buildBoundaryIntegrityInstruction,
  createPromptDelimiters,
  sanitiseDelimitedComments,
  sanitiseDelimiterPatterns,
} from "./prompt_delimiter.ts";
import { redactSecrets } from "./secret_redaction.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which side of the quorum an agent is on. */
export type QuorumRole = "planner" | "judge";

/** The anonymised position a plan occupies in front of the judge. */
export type QuorumPosition = "A" | "B";

/** The phase name each Quorum invocation runs under. */
export const QUORUM_DRAFT_PHASE = "quorum";

/** The phase name the judging invocation runs under. */
export const QUORUM_JUDGE_PHASE = "quorum_judge";

/** The issue the quorum is planning, as text the prompts fence. */
export interface QuorumIssueContext {
  /** `owner/repo`. */
  repo: string;
  /** The issue being planned. */
  issueNumber: number;
  /** Issue title (untrusted). */
  issueTitle: string;
  /** Issue body (untrusted). */
  issueBody: string;
  /** Comma-separated labels (untrusted). */
  issueLabels: string;
  /** Formatted comment history (untrusted). */
  issueComments?: string;
  /**
   * Boundary id whose per-comment trust headers inside `issueComments` are
   * genuine (Issue #3637). Adopted as this run's nonce when well formed.
   */
  commentBoundaryId?: string;
  /** Rendered verbosity block for the prompt body. */
  verbosityInstructions?: string;
  /** Prompt directory override (tests). */
  promptsDir?: string;
}

/** The three providers one quorum run uses. */
export interface QuorumProviderTrio {
  /** The two drafting providers, in no significant order. */
  planners: readonly [AgentProviderSelector, AgentProviderSelector];
  /** The adjudicating provider. */
  judge: AgentProviderSelector;
}

/** One agent invocation the orchestrator asks the caller to run. */
export interface QuorumInvocation {
  /** The fully rendered prompt. */
  prompt: string;
  /** {@link QUORUM_DRAFT_PHASE} or {@link QUORUM_JUDGE_PHASE}. */
  phase: string;
  /** Which side of the quorum this invocation is on. */
  role: QuorumRole;
  /** Anonymised position, on a drafting invocation only. */
  position?: QuorumPosition;
  /** The descriptor resolved for this invocation only (Issue #4109). */
  agentProvider: AgentProviderDescriptor;
  /** Convenience copy of `agentProvider.id`. */
  providerId: string;
  /** Wall-clock budget for the agent, in seconds. */
  timeoutSeconds: number;
  /** Grace after the timeout before the child is killed, in seconds. */
  killAfterSeconds: number;
  /**
   * Aborted when the orchestrator's own watchdog fires.
   *
   * A production invoker passes this to the child process so a hung CLI is
   * killed rather than left running behind an abandoned promise.
   */
  signal: AbortSignal;
}

/**
 * What the model layer observed about one invocation (Issue #4434).
 *
 * A plan-off is several Fable-preferring invocations behind an injected
 * runner, so the served-model facts the six single-call phases record through
 * `phase_run_stats.ts` are only visible here if the invoker hands them back.
 * Without them a Fable→Opus reroute ran silently: no `degraded-model` label,
 * no stats comment.
 */
export interface QuorumModelFields {
  /** Requested/served models, effort and token usage, when reported. */
  runStats?: RunStats;
  /** Cheaper model the invocation fell back to after rate limits (#1113). */
  fallbackModel?: string;
  /** Set when the pre-flight Fable reroute served this call on Opus (#3231). */
  preflightDegraded?: boolean;
  /** Human-readable reason accompanying {@link preflightDegraded}. */
  preflightDegradedReason?: string;
}

/** What one agent invocation produced. */
export interface QuorumInvocationOutput extends QuorumModelFields {
  /** The agent's text output. */
  output: string;
  /** Process exit code, when the invoker has one. */
  exitCode?: number;
  /** Whether the invoker's own timeout fired. */
  timedOut?: boolean;
}

/** One invocation's model observation, attributed to the agent that ran it. */
export interface QuorumModelObservation extends QuorumModelFields {
  /** The phase the invocation ran under (`quorum` / `quorum_judge`). */
  phase: string;
  /** Which side of the quorum the invocation was on. */
  role: QuorumRole;
  /** Anonymised position, on a drafting invocation only. */
  position?: QuorumPosition;
  /** The provider that ran it. */
  providerId: string;
}

/** Runs one agent invocation. Supplied by the caller; faked in tests. */
export type QuorumInvoker = (
  invocation: QuorumInvocation,
) => Promise<Result<QuorumInvocationOutput>>;

/** Options for {@link runQuorum}. */
export interface RunQuorumOptions {
  /** The issue the quorum is planning. */
  issue: QuorumIssueContext;
  /** The two planners and the judge. */
  providers: QuorumProviderTrio;
  /** How an invocation is actually run. */
  invoke: QuorumInvoker;
  /** Per-agent wall-clock budget in seconds (`grillMeTimeout`'s role). */
  timeoutSeconds: number;
  /** Grace after the timeout in seconds (`grillMeKillAfter`'s role). */
  killAfterSeconds?: number;
  /**
   * How the three providers are resolved (Issue #4109).
   *
   * Omitted in production, so selection reads the process environment and the
   * image's installed-provider stamp still gates every agent. A caller that
   * must not inherit the ambient environment — a test driving descriptors no
   * image installs — supplies its own lookup here instead.
   */
  providerSelection?: AgentProviderSelection;
}

/** One drafted plan, with the position the judge saw it in. */
export interface QuorumPlan {
  /** Anonymised position in front of the judge. */
  position: QuorumPosition;
  /** The provider that drafted it. */
  providerId: string;
  /** The plan text, with secrets redacted. */
  text: string;
}

/** How one agent invocation ended. */
export type QuorumAgentStatus = "ok" | "failed" | "timed-out";

/** What one agent cost and how it ended. */
export interface QuorumAgentTiming {
  /** Which side of the quorum the agent was on. */
  role: QuorumRole;
  /** Anonymised position, on a drafting invocation only. */
  position?: QuorumPosition;
  /** The provider that ran. */
  providerId: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** How it ended. */
  status: QuorumAgentStatus;
  /** Failure message, with secrets redacted, when it did not end `ok`. */
  detail?: string;
}

/** How the run ended. */
export type QuorumOutcome =
  /** Two plans, one judged winner — the clean three-agent quorum. */
  | "judged"
  /** One drafter failed; the survivor stands unjudged. */
  | "unjudged-single"
  /** Both plans stand, unjudged, because the judgement failed. */
  | "unjudged-both"
  /** Both drafters failed; there is nothing to publish. */
  | "failed";

/** Why a run was not a clean three-agent quorum. */
export type QuorumDegradationKind =
  | "drafter-failed"
  | "both-drafters-failed"
  | "judge-failed"
  | "judge-verdict-unreadable";

/** The named reason a run degraded. */
export interface QuorumDegradation {
  /** Which degradation occurred. */
  kind: QuorumDegradationKind;
  /** Operator-facing detail, with secrets redacted. */
  detail: string;
}

/** Per-criterion scores the judge awarded one plan. */
export interface QuorumCriterionScores {
  correctness: number | null;
  completeness: number | null;
  feasibility: number | null;
  risk: number | null;
  standards: number | null;
}

/** Scores for both positions, when the judge supplied them. */
export interface QuorumScores {
  A?: QuorumCriterionScores;
  B?: QuorumCriterionScores;
}

/** The judge's verdict, once validated. */
export interface QuorumVerdict {
  /** The winning position. */
  winner: QuorumPosition;
  /** The judge's stated reasoning. */
  reasoning: string;
  /** Per-criterion scores, when present and readable. */
  scores?: QuorumScores;
}

/** Everything one quorum run produced. */
export interface QuorumRunResult {
  /** How the run ended. */
  outcome: QuorumOutcome;
  /**
   * The judged winner — present **only** when `outcome` is `"judged"`.
   *
   * A degraded run never names a winner: the surviving plan of a half-failed
   * quorum is in {@link plans}, marked unjudged by the outcome, so no caller
   * can mistake "the one that ran" for "the one that won".
   */
  winner?: QuorumPlan;
  /** The plan that lost, on a judged run. */
  runnerUp?: QuorumPlan;
  /** Every plan drafted, in A-then-B order. */
  plans: QuorumPlan[];
  /** The judge's reasoning, on a judged run. */
  reasoning?: string;
  /** The judge's scores, when it supplied readable ones. */
  scores?: QuorumScores;
  /** One entry per agent that ran. */
  timings: QuorumAgentTiming[];
  /**
   * One entry per invocation the runner reported a model observation for
   * (Issue #4434), so the processor can apply the `degraded-model` label and
   * post the run's stats comment the way the single-call phases do.
   */
  modelObservations: QuorumModelObservation[];
  /** Present whenever `outcome` is not `"judged"`. */
  degradation?: QuorumDegradation;
}

// ---------------------------------------------------------------------------
// A/B position assignment
// ---------------------------------------------------------------------------

/**
 * Assign the anonymised A/B positions for one issue.
 *
 * The assignment is a function of the issue number and the provider ids as a
 * **set** — never of the order they were supplied in. Sorting the ids first is
 * what makes it order-independent: the same issue pairs the same way however
 * the trio was assembled, while consecutive issues alternate, so no provider
 * is permanently Plan A across the fleet.
 *
 * @param issueNumber - The issue being planned.
 * @param providerIds - The two drafting provider ids, in any order.
 * @returns The provider id at each position.
 * @throws When the issue number is not a finite integer — an unusable seed
 *   would silently collapse to a fixed pairing (Issue #3234).
 */
export function assignQuorumPositions(
  issueNumber: number,
  providerIds: readonly [string, string],
): { A: string; B: string } {
  if (!Number.isFinite(issueNumber) || !Number.isInteger(issueNumber)) {
    throw new Error(
      `Quorum A/B assignment needs an integer issue number, got ` +
        `${JSON.stringify(issueNumber)}. Without it the pairing is not ` +
        `reproducible.`,
    );
  }
  const sorted = [...providerIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const [first, second] = sorted as [string, string];
  // Odd issues swap, even issues do not: reproducible per issue, and both
  // providers take position A across a run of issues.
  return Math.abs(issueNumber) % 2 === 1
    ? { A: second, B: first }
    : { A: first, B: second };
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

/** The marker the judging prompt wraps its verdict in. */
const VERDICT_OPEN = "<quorum_verdict>";
const VERDICT_CLOSE = "</quorum_verdict>";

/** The five criteria the judging prompt scores. */
const CRITERIA = [
  "correctness",
  "completeness",
  "feasibility",
  "risk",
  "standards",
] as const;

/**
 * Read one plan's scores leniently.
 *
 * Scores are informational — the winner and its reasoning are what the run
 * turns on — so a missing or unreadable criterion becomes `null` rather than
 * failing the whole verdict.
 *
 * @param raw - The `scores.A` / `scores.B` value from the verdict JSON.
 * @returns The five criteria, or undefined when the entry is not an object.
 */
function parseScores(raw: unknown): QuorumCriterionScores | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const scores = {} as QuorumCriterionScores;
  for (const criterion of CRITERIA) {
    const value = record[criterion];
    scores[criterion] = typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
  }
  return scores;
}

/**
 * Parse and validate the judge's verdict block.
 *
 * The judging prompt requires exactly one block, last in the reply, so the
 * **last** block is the judge's own — an earlier one quoted out of a candidate
 * plan cannot displace it.
 *
 * Fail loud (Issue #3234): a missing block, unparseable JSON, a winner naming
 * neither plan, or empty reasoning is a failed judgement. None of them
 * defaults to Plan A, because a default here would publish a decision nobody
 * made.
 *
 * @param output - The judge's raw text output.
 * @returns The validated verdict, or the reason it could not be read.
 */
export function parseQuorumVerdict(output: string): Result<QuorumVerdict> {
  const open = output.lastIndexOf(VERDICT_OPEN);
  if (open < 0) {
    return {
      ok: false,
      error: new Error(
        `The judge's reply carries no ${VERDICT_OPEN} block, so no verdict ` +
          `was returned.`,
      ),
    };
  }
  const close = output.indexOf(VERDICT_CLOSE, open);
  if (close < 0) {
    return {
      ok: false,
      error: new Error(
        `The judge's ${VERDICT_OPEN} block is never closed with ` +
          `${VERDICT_CLOSE}.`,
      ),
    };
  }

  // Strip a code fence the judge may have wrapped the JSON in.
  const body = output
    .slice(open + VERDICT_OPEN.length, close)
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `The judge's verdict block is not valid JSON: ` +
          `${(error as Error).message}`,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(`The judge's verdict block is not a JSON object.`),
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawWinner = record.winner;
  const winner = typeof rawWinner === "string"
    ? rawWinner.trim().toUpperCase()
    : "";
  if (winner !== "A" && winner !== "B") {
    return {
      ok: false,
      error: new Error(
        `The judge's verdict names neither plan: winner was ` +
          `${JSON.stringify(rawWinner)}, and only "A" or "B" identifies a ` +
          `plan.`,
      ),
    };
  }

  const rawReasoning = record.reasoning;
  const reasoning = typeof rawReasoning === "string" ? rawReasoning.trim() : "";
  if (reasoning === "") {
    return {
      ok: false,
      error: new Error(
        `The judge's verdict carries no reasoning, so the decision cannot be ` +
          `reviewed.`,
      ),
    };
  }

  const rawScores = record.scores as Record<string, unknown> | undefined;
  const scoreA = parseScores(rawScores?.A);
  const scoreB = parseScores(rawScores?.B);
  const scores = scoreA || scoreB ? { A: scoreA, B: scoreB } : undefined;

  return { ok: true, value: { winner, reasoning, scores } };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/** The values one Quorum prompt substitutes. */
type Substitutions = Record<string, string>;

/**
 * Substitute placeholders with function-form replacements.
 *
 * Function form matters: the string form of `replaceAll` expands `$&`,
 * `` $` ``, `$'` and `$$`, which would let untrusted content splice the
 * already-rendered prefix — ending in a genuine, nonced boundary marker — into
 * the untrusted region without guessing the nonce (Issue #3654).
 */
function render(template: string, values: Substitutions): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, () => value);
  }
  return rendered;
}

/** Wrap sanitised untrusted text in its markers. */
function fence(start: string, text: string, end: string): string {
  return `${start}\n${text}\n${end}`;
}

/** The issue-text substitutions both Quorum prompts share. */
function issueSubstitutions(
  issue: QuorumIssueContext,
  delimiters: ReturnType<typeof createPromptDelimiters>,
  untrustedBlocks: readonly string[],
): Substitutions {
  return {
    VERBOSITY_INSTRUCTIONS: issue.verbosityInstructions ?? "",
    REPO: issue.repo,
    ISSUE_NUMBER: String(issue.issueNumber),
    ISSUE_TITLE: fence(
      delimiters.titleStart,
      sanitiseDelimiterPatterns(issue.issueTitle),
      delimiters.titleEnd,
    ),
    ISSUE_LABELS: sanitiseDelimiterPatterns(issue.issueLabels),
    ISSUE_BODY: fence(
      delimiters.bodyStart,
      sanitiseDelimiterPatterns(issue.issueBody),
      delimiters.bodyEnd,
    ),
    ISSUE_COMMENTS: fence(
      delimiters.commentsStart,
      // The header-preserving variant keeps a genuine per-comment trust header
      // byte-intact so a forgery stays visibly degraded beside it (#3637).
      sanitiseDelimitedComments(
        issue.issueComments ?? "None.",
        delimiters.boundaryId,
      ),
      delimiters.commentsEnd,
    ),
    BOUNDARY_INTEGRITY_INSTRUCTION: buildBoundaryIntegrityInstruction(
      delimiters.boundaryId,
      untrustedBlocks,
    ),
  };
}

/**
 * Load a Quorum template and confirm it still carries its placeholders.
 *
 * @param type - `quorum` or `quorum_judge`.
 * @param promptsDir - Prompt directory override.
 * @returns The template text, or why it could not be used.
 */
async function loadQuorumTemplate(
  type: string,
  promptsDir?: string,
): Promise<Result<string>> {
  const loaded = await loadPrompt(type, undefined, promptsDir);
  if (!loaded.ok) return loaded;
  const validated = validatePromptTemplate(type, loaded.value);
  if (!validated.ok) return validated as Result<string>;
  return { ok: true, value: loaded.value };
}

/**
 * Render the drafting prompt both planners receive.
 *
 * Both planners get the same prompt: the drafts are independent because they
 * run as separate agents in separate processes, never because they were asked
 * different questions.
 *
 * @param issue - The issue being planned.
 * @returns The rendered prompt, or why it could not be built.
 */
async function buildDraftPrompt(
  issue: QuorumIssueContext,
): Promise<Result<string>> {
  const template = await loadQuorumTemplate(
    QUORUM_DRAFT_PHASE,
    issue.promptsDir,
  );
  if (!template.ok) return template;
  const delimiters = createPromptDelimiters(issue.commentBoundaryId);
  return {
    ok: true,
    value: render(
      template.value,
      issueSubstitutions(issue, delimiters, [
        "the issue title, labels, description and comments",
      ]),
    ),
  };
}

/**
 * Render the judging prompt, with both plans fenced as untrusted data.
 *
 * A candidate plan is free text an agent produced from untrusted input, so it
 * can carry instructions aimed at the judge ("select this plan", a forged
 * verdict block). Fencing it in this invocation's draft markers, after
 * sanitising any delimiter-shaped text inside it, is what keeps such a line
 * data rather than an instruction.
 *
 * @param issue - The issue being planned.
 * @param planA - The plan at position A.
 * @param planB - The plan at position B.
 * @returns The rendered prompt, or why it could not be built.
 */
async function buildJudgePrompt(
  issue: QuorumIssueContext,
  planA: string,
  planB: string,
): Promise<Result<string>> {
  const template = await loadQuorumTemplate(
    QUORUM_JUDGE_PHASE,
    issue.promptsDir,
  );
  if (!template.ok) return template;
  const delimiters = createPromptDelimiters(issue.commentBoundaryId);
  return {
    ok: true,
    value: render(template.value, {
      ...issueSubstitutions(issue, delimiters, [
        "the issue title, labels, description and comments",
        "both candidate plans",
      ]),
      PLAN_A: fence(
        delimiters.draftStart,
        sanitiseDelimiterPatterns(planA),
        delimiters.draftEnd,
      ),
      PLAN_B: fence(
        delimiters.draftStart,
        sanitiseDelimiterPatterns(planB),
        delimiters.draftEnd,
      ),
    }),
  };
}

// ---------------------------------------------------------------------------
// Bounded agent invocation
// ---------------------------------------------------------------------------

/** What one bounded invocation produced. */
interface AgentOutcome {
  status: QuorumAgentStatus;
  /** Output text, redacted, when the status is `ok`. */
  text?: string;
  /** Failure detail, redacted, when it is not. */
  detail?: string;
  durationMs: number;
  /**
   * What the runner observed about the model that served this invocation
   * (Issue #4434). Present whenever the invoker returned — a run that was
   * rerouted and then failed is still a degraded run.
   */
  model?: QuorumModelFields;
}

/** Everything needed to run one agent, minus the parts the caller adds. */
interface AgentSpec {
  prompt: string;
  phase: string;
  role: QuorumRole;
  position?: QuorumPosition;
  provider: AgentProviderDescriptor;
}

/**
 * Copy the model-observation fields off one invocation's output (#4434).
 *
 * Absent fields are omitted rather than carried as `undefined`, so an invoker
 * that reports nothing produces an empty observation the degradation
 * assessment reads as "not observed" instead of a false healthy signal.
 */
function modelFieldsOf(output: QuorumInvocationOutput): QuorumModelFields {
  return {
    ...(output.runStats ? { runStats: output.runStats } : {}),
    ...(output.fallbackModel ? { fallbackModel: output.fallbackModel } : {}),
    ...(output.preflightDegraded
      ? {
        preflightDegraded: true,
        ...(output.preflightDegradedReason
          ? { preflightDegradedReason: output.preflightDegradedReason }
          : {}),
      }
      : {}),
  };
}

/** Attribute one invocation's model observation to the agent that ran it. */
function observationOf(
  spec: AgentSpec,
  outcome: AgentOutcome,
): QuorumModelObservation | undefined {
  if (!outcome.model) return undefined;
  return {
    phase: spec.phase,
    role: spec.role,
    ...(spec.position ? { position: spec.position } : {}),
    providerId: spec.provider.id,
    ...outcome.model,
  };
}

/** Human-readable name for the agent in a failure message. */
function agentName(spec: AgentSpec): string {
  return spec.role === "judge"
    ? `The judge (${spec.provider.id})`
    : `Plan ${spec.position} (${spec.provider.id})`;
}

/** What "no output" means for this agent. */
function emptyOutputDetail(spec: AgentSpec): string {
  return spec.role === "judge"
    ? `${agentName(spec)} returned no verdict text.`
    : `${agentName(spec)} returned no plan text.`;
}

/**
 * Run one agent, bounded by the timeout plus its kill-after grace.
 *
 * The bound is the orchestrator's own, not the invoker's: an invoker whose
 * timeout never fires — a wedged CLI, a fake that never resolves — must not be
 * able to stall the worker. When the watchdog fires the invocation's
 * `AbortSignal` is raised so a production invoker can kill the child, and the
 * agent is recorded as timed out.
 *
 * @param spec - The agent to run.
 * @param invoke - The caller's invoker.
 * @param timeoutSeconds - Wall-clock budget.
 * @param killAfterSeconds - Grace after the budget.
 * @returns How the invocation ended; never throws.
 */
async function runAgent(
  spec: AgentSpec,
  invoke: QuorumInvoker,
  timeoutSeconds: number,
  killAfterSeconds: number,
): Promise<AgentOutcome> {
  const controller = new AbortController();
  const started = performance.now();
  const since = () => performance.now() - started;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<AgentOutcome>((resolve) => {
    watchdog = setTimeout(() => {
      controller.abort();
      resolve({
        status: "timed-out",
        detail: `${agentName(spec)} timed out after ${timeoutSeconds}s ` +
          `plus a ${killAfterSeconds}s kill-after grace.`,
        durationMs: since(),
      });
    }, (timeoutSeconds + killAfterSeconds) * 1000);
  });

  const call = (async (): Promise<AgentOutcome> => {
    try {
      const result = await invoke({
        prompt: spec.prompt,
        phase: spec.phase,
        role: spec.role,
        position: spec.position,
        agentProvider: spec.provider,
        providerId: spec.provider.id,
        timeoutSeconds,
        killAfterSeconds,
        signal: controller.signal,
      });
      if (!result.ok) {
        return {
          status: "failed",
          detail: `${agentName(spec)} failed: ${
            redactSecrets(result.error.message)
          }`,
          durationMs: since(),
        };
      }
      const { output, exitCode, timedOut } = result.value;
      // Kept on every outcome below, not just the successful one: a
      // rerouted invocation that then failed is still a degraded run.
      const model = modelFieldsOf(result.value);
      if (timedOut) {
        return {
          status: "timed-out",
          detail: `${agentName(spec)} timed out after ${timeoutSeconds}s.`,
          durationMs: since(),
          model,
        };
      }
      if (exitCode !== undefined && exitCode !== 0) {
        return {
          status: "failed",
          detail: `${agentName(spec)} failed: exit code ${exitCode}.`,
          durationMs: since(),
          model,
        };
      }
      // Redact at capture, so no downstream consumer — a comment body, a log
      // line, this module's own result — can leak a secret the agent echoed.
      const text = redactSecrets(output ?? "").trim();
      if (text === "") {
        return {
          status: "failed",
          detail: emptyOutputDetail(spec),
          durationMs: since(),
          model,
        };
      }
      return { status: "ok", text, durationMs: since(), model };
    } catch (error) {
      // An invoker that throws is a failure like any other — never a silent
      // pass (Issue #3234).
      return {
        status: "failed",
        detail: `${agentName(spec)} failed: ${
          redactSecrets((error as Error).message ?? String(error))
        }`,
        durationMs: since(),
      };
    }
  })();

  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(watchdog);
  }
}

/** Fold one outcome into the timings list. */
function timingOf(spec: AgentSpec, outcome: AgentOutcome): QuorumAgentTiming {
  return {
    role: spec.role,
    position: spec.position,
    providerId: spec.provider.id,
    durationMs: outcome.durationMs,
    status: outcome.status,
    detail: outcome.detail,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one quorum: two plans drafted concurrently, one judged winner.
 *
 * The result always states what happened. `ok: false` is reserved for a run
 * that could not start — an unusable timeout, an unresolvable provider, a
 * prompt template that will not load — because those are the caller's faults
 * to fix. Everything the agents themselves do, including both of them
 * failing, comes back as an `ok` result with a named outcome and, when the run
 * was not a clean three-agent quorum, a named degradation.
 *
 * @param options - Issue context, provider trio, invoker and bounds.
 * @returns The run result, or why the run could not start.
 */
export async function runQuorum(
  options: RunQuorumOptions,
): Promise<Result<QuorumRunResult>> {
  const { issue, providers, invoke } = options;
  const timeoutSeconds = options.timeoutSeconds;
  const killAfterSeconds = options.killAfterSeconds ?? 0;

  // Bounds first: no agent may start without one (Issue #3234).
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return {
      ok: false,
      error: new Error(
        `Quorum needs a positive timeoutSeconds, got ` +
          `${JSON.stringify(options.timeoutSeconds)}. An unbounded agent can ` +
          `stall the worker indefinitely.`,
      ),
    };
  }
  if (!Number.isFinite(killAfterSeconds) || killAfterSeconds < 0) {
    return {
      ok: false,
      error: new Error(
        `Quorum needs a non-negative killAfterSeconds, got ` +
          `${JSON.stringify(options.killAfterSeconds)}.`,
      ),
    };
  }

  // Resolve all three providers per invocation (Issue #4109): the descriptors
  // are locals for the whole run, so the three agents can run concurrently in
  // one process without racing on module-level state.
  let planners: [AgentProviderDescriptor, AgentProviderDescriptor];
  let judge: AgentProviderDescriptor;
  let positions: { A: string; B: string };
  try {
    const selection = options.providerSelection;
    planners = [
      selectAgentProvider(providers.planners[0], selection),
      selectAgentProvider(providers.planners[1], selection),
    ];
    judge = selectAgentProvider(providers.judge, selection);
    positions = assignQuorumPositions(issue.issueNumber, [
      planners[0].id,
      planners[1].id,
    ]);
  } catch (error) {
    return { ok: false, error: error as Error };
  }

  // Position A goes to whichever planner the issue number picked. With two
  // instances of the same provider the ids cannot distinguish them, so the
  // supplied order breaks that (unobservable) tie.
  const [atA, atB] = planners[0].id === positions.A
    ? [planners[0], planners[1]]
    : [planners[1], planners[0]];

  const draftPrompt = await buildDraftPrompt(issue);
  if (!draftPrompt.ok) return draftPrompt;

  const draftSpecs: AgentSpec[] = [
    {
      prompt: draftPrompt.value,
      phase: QUORUM_DRAFT_PHASE,
      role: "planner",
      position: "A",
      provider: atA,
    },
    {
      prompt: draftPrompt.value,
      phase: QUORUM_DRAFT_PHASE,
      role: "planner",
      position: "B",
      provider: atB,
    },
  ];

  // Both drafts in flight together: Quorum costs one draft plus one
  // judgement, not two drafts plus one.
  const draftOutcomes = await Promise.all(
    draftSpecs.map((spec) =>
      runAgent(spec, invoke, timeoutSeconds, killAfterSeconds)
    ),
  );
  const timings = draftSpecs.map((spec, index) =>
    timingOf(spec, draftOutcomes[index]!)
  );
  // Model observations ride every return path below (Issue #4434): a plan-off
  // that degraded before it could be judged is exactly the run whose reroute
  // has to be reported.
  const modelObservations = draftSpecs
    .map((spec, index) => observationOf(spec, draftOutcomes[index]!))
    .filter((obs): obs is QuorumModelObservation => obs !== undefined);

  const drafted = draftSpecs
    .map((spec, index) => ({ spec, outcome: draftOutcomes[index]! }))
    .filter((entry) => entry.outcome.status === "ok");
  const failed = draftSpecs
    .map((spec, index) => ({ spec, outcome: draftOutcomes[index]! }))
    .filter((entry) => entry.outcome.status !== "ok");

  const plans: QuorumPlan[] = drafted.map(({ spec, outcome }) => ({
    position: spec.position!,
    providerId: spec.provider.id,
    text: outcome.text!,
  }));

  // Both drafters failed: there is nothing to publish and nothing to judge.
  if (plans.length === 0) {
    return {
      ok: true,
      value: {
        outcome: "failed",
        plans,
        timings,
        modelObservations,
        degradation: {
          kind: "both-drafters-failed",
          detail: failed.map((entry) => entry.outcome.detail).join(" "),
        },
      },
    };
  }

  // One drafter failed: the survivor stands, explicitly unjudged. Judging one
  // plan against nothing would be a verdict in name only.
  if (plans.length === 1) {
    return {
      ok: true,
      value: {
        outcome: "unjudged-single",
        plans,
        timings,
        modelObservations,
        degradation: {
          kind: "drafter-failed",
          detail: failed[0]!.outcome.detail!,
        },
      },
    };
  }

  const planA = plans.find((plan) => plan.position === "A")!;
  const planB = plans.find((plan) => plan.position === "B")!;

  const judgePrompt = await buildJudgePrompt(issue, planA.text, planB.text);
  if (!judgePrompt.ok) return judgePrompt;

  const judgeSpec: AgentSpec = {
    prompt: judgePrompt.value,
    phase: QUORUM_JUDGE_PHASE,
    role: "judge",
    provider: judge,
  };
  const judgeOutcome = await runAgent(
    judgeSpec,
    invoke,
    timeoutSeconds,
    killAfterSeconds,
  );
  timings.push(timingOf(judgeSpec, judgeOutcome));
  const judgeObservation = observationOf(judgeSpec, judgeOutcome);
  if (judgeObservation) modelObservations.push(judgeObservation);

  // The judge failed: both plans stand unjudged rather than one being picked
  // arbitrarily.
  if (judgeOutcome.status !== "ok") {
    return {
      ok: true,
      value: {
        outcome: "unjudged-both",
        plans,
        timings,
        modelObservations,
        degradation: {
          kind: "judge-failed",
          detail: judgeOutcome.detail!,
        },
      },
    };
  }

  const verdict = parseQuorumVerdict(judgeOutcome.text!);
  if (!verdict.ok) {
    return {
      ok: true,
      value: {
        outcome: "unjudged-both",
        plans,
        timings,
        modelObservations,
        degradation: {
          kind: "judge-verdict-unreadable",
          detail: `${agentName(judgeSpec)} returned an unreadable verdict: ${
            redactSecrets(verdict.error.message)
          }`,
        },
      },
    };
  }

  const winner = verdict.value.winner === "A" ? planA : planB;
  const runnerUp = verdict.value.winner === "A" ? planB : planA;
  return {
    ok: true,
    value: {
      outcome: "judged",
      winner,
      runnerUp,
      plans,
      reasoning: verdict.value.reasoning,
      scores: verdict.value.scores,
      timings,
      modelObservations,
    },
  };
}
