/**
 * Classify a no-PR run outcome as fixable by code or not (Issue #4328, part
 * of #4291).
 *
 * #4291 splits no-PR outcomes into two buckets that drive behaviour:
 *
 * - **code-fixable** — the worker could be changed to stop it happening
 *   (OOM / SIGKILL with memory evidence, disk exhaustion, crashes, missing
 *   tools). These get an auto-filed issue (Issue #4329).
 * - **not fixable by code** — an account or environment limit (usage / rate
 *   limit, out of credit) or the agent simply not delivering. These are
 *   stated plainly in the release comment and nothing else happens.
 *
 * `unknown` is the SAFE default: it is NOT code-fixable for auto-filing — a
 * wrong guess costs a spam issue — and the auto-filer files only on
 * `code_fixable`.
 *
 * Modelled on `ci_failure_classifier.ts` (classify, then file, with a stable
 * class slug for dedup). The primary input is the `FailureCategory` from
 * `failure_diagnosis.ts` — `detectFailureCategory()` is the single diagnosis
 * path (#4298's corrected messages flow through it) and this refines it
 * rather than re-deriving it. The raw message is a secondary input only, for
 * signals the category cannot express (OOM evidence, disk exhaustion,
 * out-of-credit).
 *
 * Pure: no `Deno.*`, no network, no clock. Deterministic on its inputs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertNever } from "./assert_never.ts";
import type { FailureCategory } from "./failure_diagnosis.ts";

/** Whether a code change could stop the failure recurring. */
export type RunFailureFixability =
  | "code_fixable"
  | "not_code_fixable"
  | "unknown";

/** Result of classifying a no-PR run outcome. */
export interface RunFailureClassification {
  fixability: RunFailureFixability;
  /**
   * Stable kebab-case slug used as the dedup key by the auto-filing sibling
   * (Issue #4329) — one open issue per class. Changing a slug orphans its
   * open issue, so treat these as an API.
   */
  failureClass: string;
  /** Short human sentence naming the evidence that decided it. */
  rationale: string;
}

/** Every slug the classifier can emit, for tests and the auto-filer. */
export const RUN_FAILURE_CLASSES = [
  "usage-limit",
  "interrupted",
  "scheduled-release",
  "out-of-credit",
  "stale-lineage",
  "oom",
  "killed-unknown",
  "disk-full",
  "worker-crash",
  "missing-tools",
  "timeout",
  "no-output",
  "agent-outcome",
  "unknown",
] as const;

/** Out-of-credit / billing signals — account state, not a worker fault. */
const OUT_OF_CREDIT_RE =
  /out of credit|credit balance|insufficient (?:balance|credit|funds|quota)|payment required|billing (?:hard )?limit|quota exceeded/i;

/**
 * Memory-pressure evidence beside a kill (Issue #4202).
 *
 * Message-shaped signals are protected from accidental matches inside
 * branch/path/URL slugs. The category is still required to be `killed`.
 */
const OOM_EVIDENCE_RE =
  /(?<![-_/])(?:out[- ]of[- ]memory|\boom[- ]?kill|killed process|\bexit(?: code)? 137\b|\(exit 137|heap out of memory|allocation failed|cannot allocate memory)(?![-_/])/i;

/** The probe reading the killed branch writes into the diagnostics (Issue #4374). */
const HIGH_PRESSURE_AT_KILL_RE = /memory pressure at kill: high/i;

/**
 * Disk exhaustion — the worker can prune, warn or size the volume.
 *
 * ENOSPC is an error token and is conventionally uppercase. Requiring that
 * exact case plus non-slug boundaries prevents lowercase `enospc` embedded
 * in a branch/path/URL from looking like an operating-system error. Human
 * phrases remain case-insensitive.
 */
const ENOSPC_RE = /(?<![-_/])\bENOSPC\b(?![-_/])/;
const DISK_FULL_RE = /\b(?:no space left on device|disk full|disk is full)\b/i;

/** A squash-lineage refusal is deliberate completion safety, not a defect. */
const STALE_LINEAGE_RE = /Refusing to push[\s\S]*squashed this branch's work/i;

/** An unhandled exception / stack trace from the worker itself. */
const STACK_TRACE_RE =
  /\bat (?:Object|Module|async|file:\/\/)|\n\s+at \S+ \(|unhandled (?:exception|rejection)|typeerror:|referenceerror:/i;

/**
 * The structural half of {@link STACK_TRACE_RE}: a real stack frame.
 *
 * Kept separate because it is the half that survives inside quoted agent
 * output (Issue #249). A frame naming a function and a `file://` URL is a
 * crash dump — the Claude CLI itself falling over is a genuine worker-side
 * failure even though the dump reaches us through the agent's stdout. The
 * prose half (`unhandled exception`, `TypeError:`) is not: an agent whose
 * whole job is discussing code says those words constantly.
 */
const STACK_FRAME_RE = /\bat (?:Object|Module|async|file:\/\/)|\n\s+at \S+ \(/;

/**
 * The agent-authored `<details>` block in a detailed failure message —
 * `failure_message.ts` wraps `lastOutputSnippet` in exactly this shape.
 *
 * Non-greedy and anchored on the summary line so it cannot swallow the
 * sibling "Processes at the kill" block, which *is* worker-authored
 * evidence.
 */
const AGENT_OUTPUT_BLOCK_RE =
  /<details>\s*\n<summary>Last output from Claude[^<]*<\/summary>[\s\S]*?<\/details>/gi;

/**
 * Split a failure message into the worker's own words and the agent's.
 *
 * `formatDetailedFailureMessage` embeds the tail of Claude's stdout in the
 * message it hands the classifier. That text is the agent narrating about
 * the *user's* codebase, and treating it as evidence about the worker is
 * how Issue #249 happened: a clean deadline stop (exit 143, WIP preserved,
 * category `timeout`) was filed as a `worker-crash` because Claude had
 * written "a second failure surfaces as an unhandled rejection" about the
 * concurrency driver it was fixing in GRQ.
 *
 * @param message - The full failure message.
 * @returns `worker` with the agent block removed, and `agent` holding just
 *   the removed block(s).
 */
export function splitAgentNarration(
  message: string,
): { worker: string; agent: string } {
  const agentParts: string[] = [];
  const worker = message.replace(AGENT_OUTPUT_BLOCK_RE, (match) => {
    agentParts.push(match);
    return "\n";
  });
  return { worker, agent: agentParts.join("\n") };
}

/**
 * Classify a no-PR run failure.
 *
 * ORDER MATTERS and is fixed here, most specific first:
 *
 * 1. Account limits and expected releases.
 * 2. Squash-lineage safety refusals.
 * 3. Disk exhaustion by error-shaped message evidence.
 * 4. `killed` with/without OOM evidence.
 * 5. Worker crashes and missing tools.
 * 6. Timeout / zero output / agent outcomes.
 * 7. Anything else → unknown.
 */
export function classifyRunFailure(
  category: FailureCategory,
  failureMessage: string,
): RunFailureClassification {
  const message = failureMessage ?? "";

  // 1. Account limits: usage / rate limit and out-of-credit are never a
  // worker fault. Checked before anything else so unrelated error text cannot
  // outrank them.
  if (category === "rate_limit") {
    return {
      fixability: "not_code_fixable",
      failureClass: "usage-limit",
      rationale:
        "The run hit a usage or rate limit (account/quota state, not a worker defect).",
    };
  }
  if (category === "interrupted") {
    return {
      fixability: "not_code_fixable",
      failureClass: "interrupted",
      rationale:
        "The run was cut off before finishing (still working, not concluding) — transient, retried rather than filed.",
    };
  }
  if (category === "scheduled_release") {
    return {
      fixability: "not_code_fixable",
      failureClass: "scheduled-release",
      rationale:
        "The run was released on schedule (cycle ended or run hard cap reached) with its work preserved — not a worker defect.",
    };
  }
  if (OUT_OF_CREDIT_RE.test(message)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "out-of-credit",
      rationale: "The message reports an out-of-credit / billing condition.",
    };
  }

  // 2. A completion-phase squash-lineage refusal means the work is already
  // represented in the base and replay was deliberately refused. It must win
  // over incidental tokens in branch names, including `enospc`.
  if (STALE_LINEAGE_RE.test(message)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "stale-lineage",
      rationale:
        "The push was deliberately refused because a squash merge already represented the branch work in the base.",
    };
  }

  // 3. Disk exhaustion by message — outranks killed/crash because a full
  // disk is what killed or crashed the run.
  if (ENOSPC_RE.test(message) || DISK_FULL_RE.test(message)) {
    return {
      fixability: "code_fixable",
      failureClass: "disk-full",
      rationale:
        "The message reports disk exhaustion (ENOSPC / no space left on device).",
    };
  }

  switch (category) {
    case "killed":
      if (HIGH_PRESSURE_AT_KILL_RE.test(message)) {
        return {
          fixability: "code_fixable",
          failureClass: "oom",
          rationale:
            "The run was killed (SIGKILL) while the memory-pressure probe read high at the kill.",
        };
      }
      if (OOM_EVIDENCE_RE.test(message)) {
        return {
          fixability: "code_fixable",
          failureClass: "oom",
          rationale:
            "The run was killed (SIGKILL) with out-of-memory evidence in the message.",
        };
      }
      return {
        fixability: "unknown",
        failureClass: "killed-unknown",
        rationale:
          "The run was killed (SIGKILL) with no memory evidence — cause unproven.",
      };
    case "internal_error":
      return {
        fixability: "code_fixable",
        failureClass: "worker-crash",
        rationale:
          "The failure is an internal tooling / CLI error or unhandled exception in the worker.",
      };
    case "missing_tools":
      return {
        fixability: "code_fixable",
        failureClass: "missing-tools",
        rationale: "A required tool is missing from the worker environment.",
      };
    case "timeout":
      return crashOr({
        fixability: "unknown",
        failureClass: "timeout",
        rationale:
          "The run timed out; the cause is not proven to be the worker.",
      }, message);
    case "zero_output":
      return crashOr({
        fixability: "unknown",
        failureClass: "no-output",
        rationale:
          "The run produced no output; the cause is not proven to be the worker.",
      }, message);
    case "quality_check":
    case "no_changes":
    case "evidence_missing":
      return {
        fixability: "not_code_fixable",
        failureClass: "agent-outcome",
        rationale:
          "The agent did not deliver (quality gate, no changes, missing evidence) — not a worker defect.",
      };
    case "token_scope":
      return {
        fixability: "not_code_fixable",
        failureClass: "token-scope",
        rationale:
          "The worker's token lacks the workflow scope the change needs — a host credential gap, not a worker defect.",
      };
    case "push_failure":
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "Git push failed; the cause is not proven to be the worker.",
      }, message);
    case "unknown":
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "No signal in the category or message decides fixability.",
      }, message);
    default:
      return assertNever(category);
  }
}

/**
 * Refine an otherwise-unknown result: an unhandled exception / stack trace
 * in the message is a worker crash (code-fixable) whatever the category.
 */
function crashOr(
  fallback: RunFailureClassification,
  message: string,
): RunFailureClassification {
  // Issue #249: crash evidence is read from the worker's own words. The
  // quoted agent output is excluded from the prose patterns, because an
  // agent discussing exceptions in the code it is writing is not a worker
  // crash — that false positive filed this very issue against a run that
  // had stopped cleanly at its deadline with WIP preserved.
  const { worker, agent } = splitAgentNarration(message);
  if (STACK_TRACE_RE.test(worker) || STACK_FRAME_RE.test(agent)) {
    return {
      fixability: "code_fixable",
      failureClass: "worker-crash",
      rationale:
        "The message carries an unhandled exception / stack trace from the worker.",
    };
  }
  return fallback;
}
