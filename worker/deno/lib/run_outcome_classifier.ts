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
 * Message matching is case-insensitive throughout (the #4315 lesson: a
 * case-sensitive check let "Rate limit …" fall through to unknown).
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
  "out-of-credit",
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
 * Whole-message, for the same reason as {@link DISK_FULL_RE} — and gated on
 * the `killed` category besides, so agent prose alone cannot reach it.
 */
const OOM_EVIDENCE_RE =
  /out[- ]of[- ]memory|\boom[- ]?kill|killed process|\bexit(?: code)? 137\b|\(exit 137|heap out of memory|allocation failed|cannot allocate memory/i;

/** The probe reading the killed branch writes into the diagnostics (Issue #4374). */
const HIGH_PRESSURE_AT_KILL_RE = /memory pressure at kill: high/i;

/**
 * Disk exhaustion — the worker can prune, warn or size the volume.
 *
 * Deliberately still scanned over the *whole* message, agent output
 * included, unlike the crash patterns (Issue #249). The asymmetry is not an
 * oversight: ENOSPC reaching us through the agent's stdout means the run
 * genuinely hit a full disk, which is real environmental evidence the
 * worker can act on. A mention of an exception is different in kind — the
 * agent is describing the user's code, not reporting its own environment.
 */
const DISK_FULL_RE = /enospc|no space left on device|disk full|disk is full/i;

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
 * ORDER MATTERS and is fixed here, most specific first — exactly as
 * `detectFailureCategory` documents its own ordering:
 *
 * 1. Account limits (`rate_limit` category, out-of-credit message) — the
 *    highest-cost false positive is auto-filing on a fleet-wide usage cap,
 *    so these win over everything, including a stack trace in the same
 *    message.
 * 2. Disk exhaustion by message — a full disk kills or crashes whatever ran
 *    on top of it, so it outranks `killed` / `internal_error`.
 * 3. `killed` — with OOM evidence → `oom` (code-fixable); without → the
 *    cause is unproven, so `killed-unknown` (unknown). An OOM message that
 *    also mentions a timeout classifies as `oom` because the category was
 *    already `killed`, not `timeout`.
 * 4. Worker crashes: `internal_error`, or an unhandled exception / stack
 *    trace in the message with any other non-agent category.
 * 5. `missing_tools` — the image/PATH is the worker's to fix.
 * 6. `timeout` / `zero_output` — cause unproven → unknown.
 * 7. `quality_check` / `no_changes` / `evidence_missing` — the AGENT not
 *    delivering, not a worker defect: `not_code_fixable`, never auto-filed.
 * 8. Anything else → unknown.
 */
export function classifyRunFailure(
  category: FailureCategory,
  failureMessage: string,
): RunFailureClassification {
  const message = failureMessage ?? "";

  // 1. Account limits: usage / rate limit and out-of-credit are never a
  //    worker fault. Checked before anything else so a stack trace or a
  //    "timed out" clause in the same message cannot outrank them.
  if (category === "rate_limit") {
    return {
      fixability: "not_code_fixable",
      failureClass: "usage-limit",
      rationale:
        "The run hit a usage or rate limit (account/quota state, not a worker defect).",
    };
  }
  // A run cut off before finishing is transient infrastructure, never a worker
  // defect and never auto-filed — the loop simply retries it (Issue #108).
  if (category === "interrupted") {
    return {
      fixability: "not_code_fixable",
      failureClass: "interrupted",
      rationale:
        "The run was cut off before finishing (still working, not concluding) — transient, retried rather than filed.",
    };
  }
  if (OUT_OF_CREDIT_RE.test(message)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "out-of-credit",
      rationale: "The message reports an out-of-credit / billing condition.",
    };
  }

  // 2. Disk exhaustion by message — outranks killed/crash because a full
  //    disk is what killed or crashed the run.
  if (DISK_FULL_RE.test(message)) {
    return {
      fixability: "code_fixable",
      failureClass: "disk-full",
      rationale:
        "The message reports disk exhaustion (ENOSPC / no space left on device).",
    };
  }

  switch (category) {
    case "killed":
      // 3. SIGKILL: memory evidence makes it an OOM the worker can size or
      //    throttle for; without evidence the cause is unproven. The probe
      //    reading taken at the kill (Issue #4374) is the strongest evidence
      //    and is named as such — exit 137 alone is an inference.
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
      // 4. A worker-side error or crash.
      return {
        fixability: "code_fixable",
        failureClass: "worker-crash",
        rationale:
          "The failure is an internal tooling / CLI error or unhandled exception in the worker.",
      };
    case "missing_tools":
      // 5. The image or PATH is the worker's to fix.
      return {
        fixability: "code_fixable",
        failureClass: "missing-tools",
        rationale: "A required tool is missing from the worker environment.",
      };
    case "timeout":
      // 6. Cause unproven: an agent that ran long is not, by itself, a
      //    worker defect.
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
      // 7. The agent did not deliver — a property of the attempt, not a
      //    worker defect. Stated plainly, never auto-filed: filing an issue
      //    every time the model fails a quality gate would be pure noise.
      return {
        fixability: "not_code_fixable",
        failureClass: "agent-outcome",
        rationale:
          "The agent did not deliver (quality gate, no changes, missing evidence) — not a worker defect.",
      };
    case "push_failure":
      // A rejected push is usually permissions/protection or a race — not
      // proven either way.
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "Git push failed; the cause is not proven to be the worker.",
      }, message);
    case "unknown":
      // 8. The safe default — with one refinement: an unhandled exception /
      //    stack trace in the message is a worker crash whatever the
      //    category detector made of it.
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "No signal in the category or message decides fixability.",
      }, message);
    default:
      // Exhaustiveness guard: a new FailureCategory must choose a bucket.
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
