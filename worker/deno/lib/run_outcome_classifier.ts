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
 * `failure_diagnosis.ts`, declared by new worker results or detected by legacy
 * raw-output adapters. This refines that category rather than re-deriving it. The raw message is a secondary input only, for
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
import {
  type FailureCategory,
  isOutOfCreditMessage,
  isWorkerGateCategory,
} from "./failure_diagnosis.ts";
import { isSecondaryRateLimitMessage } from "./secondary_rate_limit.ts";

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
  "github-abuse-limit",
  "interrupted",
  "scheduled-release",
  "out-of-credit",
  "stale-lineage",
  "oom",
  "killed-unknown",
  "disk-full",
  "worker-crash",
  "missing-tools",
  "tool-runtime",
  "timeout",
  "no-output",
  "agent-outcome",
  "workflow-gate",
  "repo-config",
  "prompt-too-long",
  "clone-corrupt",
  // Filed by `security_fix_gate_retry.ts`, never emitted by the classifier
  // (Issue #4298): repeated gate blocks on one approved issue are a gate bug.
  "security-fix-gate-blocked",
  "unknown",
] as const;

/**
 * Memory-pressure evidence beside a kill (Issue #4202).
 *
 * Read from the worker's own words only (Issue #3694): gated on the `killed`
 * category and scanned over `splitAgentNarration(...).worker`. The agent's
 * quoted output carries tool results such as `Error: Exit code 137` from a
 * command the agent ran, which is not evidence that the agent itself was
 * OOM-killed. The worker-authored kill-diagnostics block (kernel OOM lines)
 * and the kill headline stay in scope. The CLI's own V8 heap abort is caught
 * earlier by the runner's `detectOutOfMemory` (claude_runner.ts) and reaches
 * the classifier as `buildOutOfMemoryMessage`'s worker-worded headline.
 */
const OOM_EVIDENCE_RE =
  /(?<![\w/-])out[- ]of[- ]memory(?![\w/-])|(?<![\w/-])oom[- ]?kill|killed process|\bexit(?: code)? 137\b|\(exit 137|heap out of memory|allocation failed|cannot allocate memory/i;

/** The probe reading the killed branch writes into the diagnostics (Issue #4374). */
const HIGH_PRESSURE_AT_KILL_RE = /memory pressure at kill: high/i;

/**
 * Disk exhaustion — the worker can prune, warn or size the volume. The
 * intentional host-disk park note shares the class for diagnosis, but its
 * protective release is not code-fixable (handled above).
 *
 * Deliberately still scanned over the *whole* message, agent output
 * included, unlike the crash patterns (Issue #249). The asymmetry is not an
 * oversight: ENOSPC reaching us through the agent's stdout means the run
 * genuinely hit a full disk, which is real environmental evidence the
 * worker can act on. A mention of an exception is different in kind — the
 * agent is describing the user's code, not reporting its own environment.
 *
 * Error-shaped text only (Issue #1658): `ENOSPC` is the errno as an
 * operating system spells it — uppercase, a whole word, and never glued to
 * a slug, path or URL with `-`, `_` or `/`. The lowercase, unanchored form
 * matched `enospc` inside the branch name
 * `milestone/4690-bug-sampler-enospc-on-228-gb-hosts-60-gb-disk` in a push
 * refusal that had nothing to do with disk, and auto-filed a `disk-full`
 * worker defect for it. The three prose phrases stay case-insensitive, as
 * whole phrases.
 */
const ENOSPC_RE = /(?<![\w/-])ENOSPC(?![\w/-])/;
const DISK_FULL_PHRASE_RE =
  /\bno space left on device\b|\bdisk full\b|\bdisk is full\b|Read-only file system|\bos error 30\b|Parked as infrastructure \(Issue #4360\)/i;

/** Whether `message` has disk-exhaustion evidence or the host-disk park note. */
function isDiskFull(message: string): boolean {
  return ENOSPC_RE.test(message) || DISK_FULL_PHRASE_RE.test(message);
}

/**
 * The completion phase's squash-lineage refusal (Issue #534): a merged PR
 * already squashed this branch's work into the base, and replaying the
 * branch onto the moved base was refused. The base moved on — a property
 * of the repository's history, never a worker defect, and (Issue #1658)
 * not a full disk either, whatever the branch happens to be called.
 */
const STALE_LINEAGE_RE =
  /Refusing to push[\s\S]{0,600}?squashed this branch's work/;

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

/** Out-of-credit / billing — account state, not a worker defect. */
const OUT_OF_CREDIT: RunFailureClassification = {
  fixability: "not_code_fixable",
  failureClass: "out-of-credit",
  rationale: "The message reports an out-of-credit / billing condition.",
};

/** The agent did not deliver — a property of the attempt, not a worker defect. */
const AGENT_OUTCOME: RunFailureClassification = {
  fixability: "not_code_fixable",
  failureClass: "agent-outcome",
  rationale:
    "The agent did not deliver (quality gate, PR-summary gates, security-fix evidence, no changes, missing evidence) — not a worker defect.",
};

/**
 * The agent's tool runtime failed (Issue #4324).
 *
 * A code-mode host that is unavailable, or a session whose every tool call
 * failed to spawn, is the worker's infrastructure. It is code-fixable, so the
 * run-failure filer raises one deduped issue, and it is not the source
 * issue's fault.
 */
const TOOL_RUNTIME: RunFailureClassification = {
  fixability: "code_fixable",
  failureClass: "tool-runtime",
  rationale:
    "The agent's tool runtime failed (tools or the code-mode host were unavailable, or every tool call failed to spawn) — infrastructure, not an agent outcome.",
};

/**
 * A refused repository-admin setting (Issue #4442).
 *
 * The category stays `internal_error`, but the refusal is a repository or
 * credential condition, so it is never auto-filed as a `worker-crash`.
 */
export const REPO_ADMIN_REFUSED: RunFailureClassification = {
  fixability: "not_code_fixable",
  failureClass: "repo-config",
  rationale:
    "The repository or the worker's token refused the repository-admin setting the finding asks for (permission, plan or protection) — a configuration fault, not a worker defect.",
};

/** Codex item types that are tool calls (the same set the progress tracker counts). */
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "command",
  "function_call",
  "mcp_tool_call",
  "mcp_tool",
  "tool",
  "tool_use",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** One transcript entry, unwrapping a Codex `item` or `payload` envelope. */
function unwrapTranscriptItem(entry: unknown): Record<string, unknown> | null {
  const record = asRecord(entry);
  if (!record) return null;
  return asRecord(record.item) ?? asRecord(record.payload) ?? record;
}

function itemType(item: Record<string, unknown>): string {
  const raw = item.item_type ?? item.type;
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

/** Text a transcript item carries, folded for a case-insensitive check. */
function itemText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["message", "text", "content", "error"]) {
    const value = item[key];
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    const nested = asRecord(value);
    if (nested && typeof nested.message === "string") {
      parts.push(nested.message);
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * A provider error item saying tools, or the code-mode host, are unavailable.
 */
function isProviderToolRuntimeError(item: Record<string, unknown>): boolean {
  if (itemType(item) !== "error") return false;
  const text = itemText(item);
  return text.includes("code mode is unavailable") ||
    text.includes("host executable was not found") ||
    (text.includes("tool") && text.includes("unavailable"));
}

function isToolItem(item: Record<string, unknown>): boolean {
  return TOOL_ITEM_TYPES.has(itemType(item));
}

/** A tool call that never started because the runtime could not spawn it. */
function toolFailedToSpawn(item: Record<string, unknown>): boolean {
  const status = typeof item.status === "string"
    ? item.status.toLowerCase()
    : "";
  if (status === "failed_to_spawn" || status === "spawn_failed") return true;
  const text = itemText(item);
  return text.includes("failed to spawn") ||
    text.includes("failure to spawn") ||
    text.includes("could not spawn");
}

/**
 * Whether a Codex transcript shows the tool runtime itself failing
 * (Issue #4324).
 *
 * Two shapes count. A provider error item — `Code Mode is unavailable`, a
 * missing code-mode host, or tools reported unavailable — when no tool call
 * *after that error* succeeded. Or at least one tool call, every one of
 * which failed to spawn. A later session counts on its own (Issue #4362):
 * the implementing agent may have used tools, and the pre-PR verifier's
 * session can still open with the code-mode host missing. A tool that
 * succeeds after the error means the runtime recovered.
 */
/**
 * Parse a Codex session JSONL into items.
 *
 * A line that is not a JSON object is skipped. A torn final line is not a
 * transcript item, and it does not discard the items already read.
 */
export function parseCodexTranscript(text: string): unknown[] {
  const items: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return items;
}

function transcriptShowsToolRuntimeFailure(
  transcript: readonly unknown[] | undefined,
): boolean {
  if (!transcript || transcript.length === 0) return false;
  const items: Record<string, unknown>[] = [];
  for (const entry of transcript) {
    const item = unwrapTranscriptItem(entry);
    if (item) items.push(item);
  }
  // A provider error counts when nothing after it actually ran. Tools that
  // succeeded *before* the error are an earlier session (Issue #4362).
  let sawRuntimeError = false;
  let toolSucceededAfterError = false;
  for (const item of items) {
    if (isProviderToolRuntimeError(item)) sawRuntimeError = true;
    if (
      sawRuntimeError && isToolItem(item) && !toolFailedToSpawn(item)
    ) {
      toolSucceededAfterError = true;
    }
  }
  if (sawRuntimeError && !toolSucceededAfterError) return true;

  const tools = items.filter(isToolItem);
  // A tool that actually ran, with no provider error after it, means the
  // runtime was up. Quoted errors in a later agent message do not undo that.
  if (tools.some((tool) => !toolFailedToSpawn(tool))) return false;
  return tools.length > 0 && tools.every(toolFailedToSpawn);
}

/**
 * Classify a no-PR run failure.
 *
 * ORDER MATTERS and is fixed here, most specific first — exactly as
 * `detectFailureCategory` documents its own ordering:
 *
 * 0. A transcript that shows the tool runtime failing (Issue #4362) —
 *    infrastructure, even when the recorded category is a worker gate such
 *    as `criteria_unmet`. The signal is the session items, not quoted prose.
 * 0b. Every registered worker gate category (`WORKER_GATE_MARKERS`: summary,
 *    security-fix and pre-push gates; Issues #3431, #3454, #3716) — answered
 *    before the message rules, because the gate refusal quotes the agent's
 *    summary, tests or tool output and a quoted "ENOSPC", usage limit or stack
 *    trace must not turn it into another class.
 * 1. Account limits (`rate_limit` category, out-of-credit message) — the
 *    highest-cost false positive is auto-filing on a fleet-wide usage cap,
 *    so these win over everything, including a stack trace in the same
 *    message.
 * 2. A squash-lineage push refusal (Issue #534) — the base moved on; never
 *    a worker defect, and checked before the disk and crash rules so a
 *    branch name or a hint line in the refusal cannot be mistaken for
 *    either (Issue #1658).
 * 3. Disk exhaustion by message — a full disk kills or crashes whatever ran
 *    on top of it, so it outranks `killed` / `internal_error`.
 * 4. `killed` — with OOM evidence → `oom` (code-fixable); without → the
 *    cause is unproven, so `killed-unknown` (unknown). An OOM message that
 *    also mentions a timeout classifies as `oom` because the category was
 *    already `killed`, not `timeout`.
 * 5. Worker crashes: `internal_error`, or an unhandled exception / stack
 *    trace in the message with any other non-agent category.
 * 6. `missing_tools` — the image/PATH is the worker's to fix.
 * 7. `timeout` / `zero_output` — cause unproven → unknown.
 * 8. `quality_check` / `no_changes` /
 *    `evidence_missing` — the AGENT not
 *    delivering, not a worker defect: `not_code_fixable`, never auto-filed.
 *    Exception (Issue #4324): a transcript that shows the tool runtime
 *    failing is infrastructure (`tool-runtime`, code-fixable). An ordinary
 *    no-change run, whose tools worked, stays an agent outcome.
 * 9. `workflow_gate` — a pre-PR gate the worker applied refused the change
 *    (Issue #2044): not a worker defect either, and it keeps its own class so
 *    an archive can tell a gate block from an unexplained failure.
 * 10. Anything else → unknown.
 */
export function classifyRunFailure(
  category: FailureCategory,
  failureMessage: string,
  declaredCategory: boolean,
  transcript?: readonly unknown[],
): RunFailureClassification {
  // A declared source cause cannot be replaced by quoted git, test or agent
  // prose. Kills, account limits and internal-tool errors retain their source-specific
  // diagnostic refinements. Timeout disk evidence has its narrow exception below;
  // other declared categories do not read a message.
  const message = declaredCategory
    ? category === "killed" || category === "rate_limit" ||
        category === "internal_error"
      ? splitAgentNarration(failureMessage ?? "").worker
      : ""
    : failureMessage ?? "";

  // A broken tool runtime is infrastructure whatever category the run was
  // recorded under (Issue #4362). The signal is the session items, not the
  // gate's quoted reason, so a criteria-unmet record whose verifier or agent
  // had no working tools is not an agent outcome.
  if (transcriptShowsToolRuntimeFailure(transcript)) return TOOL_RUNTIME;

  // A worker gate refusal (summary, security-fix or pre-push gate) quotes text
  //    the worker did not write, so any message-pattern rule below (secondary
  //    limit, out-of-credit, stale lineage, disk-full) can trip on that
  //    quotation. The category is a gate category only for a worker-authored
  //    marker prefix (or, for `summary_incomplete`, an existing-PR finalise),
  //    so it answers first (Issues #3431, #3454; PR #3716).
  if (isWorkerGateCategory(category)) return AGENT_OUTCOME;

  // 1. Account limits: usage / rate limit and out-of-credit are never a
  //    worker fault. Checked before anything else so a stack trace or a
  //    "timed out" clause in the same message cannot outrank them.
  //
  //    GitHub's *secondary* (content-creation) limit is separated out first
  //    (Issue #1951): it is a self-clearing throttle on one host's burst of
  //    writes, not an account or subscription cap, and counting the two
  //    together made an exhausted model subscription indistinguishable in
  //    the record from a throttle that cleared itself in minutes.
  //
  //    Read from the worker's own words only (Issue #249): the agent's
  //    quoted stdout reaches this message too, and an agent *writing about*
  //    this very throttle must not make its run a GitHub throttle.
  if (isSecondaryRateLimitMessage(splitAgentNarration(message).worker)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "github-abuse-limit",
      rationale:
        "GitHub's secondary (content-creation) rate limit refused a write — " +
        "a self-clearing throttle, not an account usage limit.",
    };
  }
  if (category === "rate_limit") {
    // An out-of-credit refusal is categorised rate_limit (Issue #2590) but
    // keeps its own, more precise failure class.
    if (isOutOfCreditMessage(message)) return OUT_OF_CREDIT;
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
  // A scheduled release is the fleet working as designed (Issue #424): the
  // cycle ended or the supervisor's hard cap was reached, the WIP is on the
  // branch and the next claim resumes it. Never a worker defect, so never
  // auto-filed — and checked before the message-pattern rules, whose
  // "timed out" and stack-trace signals appear in the agent output such a
  // release quotes.
  if (category === "scheduled_release") {
    return {
      fixability: "not_code_fixable",
      failureClass: "scheduled-release",
      rationale:
        "The run was released on schedule (cycle ended, finish deadline reached, or run hard cap reached) with its work preserved — not a worker defect.",
    };
  }
  if (isOutOfCreditMessage(message)) return OUT_OF_CREDIT;

  // 2. A squash-lineage refusal is the base having moved on (Issue #534),
  //    stated in the worker's own words — and its text quotes a branch name
  //    and git's conflict hints, which is exactly what fooled the disk and
  //    crash rules before (Issue #1658). Named first so neither can.
  if (STALE_LINEAGE_RE.test(message)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "stale-lineage",
      rationale:
        "The completion phase refused to push a branch whose work a merged PR already squashed into the base (Issue #534) — the base moved on, not a worker defect.",
    };
  }

  // The worker deliberately releases an in-flight build when its own disk
  // monitor crosses the floor (Issue #4360). Keep the stable disk-full class
  // for diagnosis, but do not file it as a worker defect: the release is the
  // disk guard working as designed. Read the marker only from worker prose;
  // the same phrase in an agent's quoted output is not a parking decision.
  if (
    category === "internal_error" &&
    /Parked as infrastructure \(Issue #4360\)/.test(
      splitAgentNarration(failureMessage ?? "").worker,
    )
  ) {
    return {
      fixability: "not_code_fixable",
      failureClass: "disk-full",
      rationale:
        "The worker intentionally parked work after its host-disk floor was crossed; the protective release is not a worker defect.",
    };
  }

  // 3. Disk exhaustion by message — outranks killed/crash because a full
  //    disk is what killed or crashed the run.
  // Existing timeout diagnostics intentionally retain error-shaped disk evidence
  // from CLI output. That narrow refinement does not grant quoted account,
  // crash or lineage prose authority over a declared execution timeout.
  if (
    isDiskFull(
      declaredCategory && category === "timeout" ? failureMessage : message,
    )
  ) {
    return {
      fixability: "code_fixable",
      failureClass: "disk-full",
      rationale:
        "The message reports disk exhaustion (ENOSPC, no space left on device, or a read-only filesystem after the disk filled).",
    };
  }

  switch (category) {
    case "killed":
      // 4. SIGKILL: memory evidence makes it an OOM the worker can size or
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
      if (OOM_EVIDENCE_RE.test(splitAgentNarration(message).worker)) {
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
      // 5. A worker-side error or crash.
      return {
        fixability: "code_fixable",
        failureClass: "worker-crash",
        rationale:
          "The failure is an internal tooling / CLI error or unhandled exception in the worker.",
      };
    case "missing_tools":
      // 6. The image or PATH is the worker's to fix.
      return {
        fixability: "code_fixable",
        failureClass: "missing-tools",
        rationale: "A required tool is missing from the worker environment.",
      };
    case "timeout":
      // 7. Cause unproven: an agent that ran long is not, by itself, a
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
      // 8. The agent did not deliver — a property of the attempt, not a
      //    worker defect. Stated plainly, never auto-filed: filing an issue
      //    every time the model fails a quality gate would be pure noise.
      //    A broken tool runtime is not that attempt (Issue #4324): the
      //    transcript says the tools never came up, so the worker files it
      //    and the issue is not blamed.
      if (transcriptShowsToolRuntimeFailure(transcript)) return TOOL_RUNTIME;
      return AGENT_OUTCOME;
    case "workflow_gate":
      // Issue #2044: the changed-workflow gate refused the run over a finding
      // in a workflow file the change introduced. A property of the change,
      // never a worker defect — so it is stated plainly and never auto-filed,
      // and it keeps its own class so an archive can tell a gate block from
      // an unexplained failure.
      return {
        fixability: "not_code_fixable",
        failureClass: "workflow-gate",
        rationale:
          "A pre-PR gate refused the run over a GitHub Actions finding in a workflow file the change introduced — not a worker defect.",
      };
    case "token_scope":
      // Issue #1475: the host's credential lacks the `workflow` scope. An
      // operator grants it; no code changes. Never auto-filed as a worker
      // defect — the run itself already says exactly what to do.
      return {
        fixability: "not_code_fixable",
        failureClass: "token-scope",
        rationale:
          "The worker's token lacks the workflow scope the change needs — a host credential gap, not a worker defect.",
      };
    case "repo_config":
      // Issue #2220: the repository refused the milestone branch (a ruleset,
      // a protection, or a missing permission). An operator clears it in the
      // repository's settings; no worker code change would help, so it is
      // never auto-filed as a worker defect.
      return {
        fixability: "not_code_fixable",
        failureClass: "repo-config",
        rationale:
          "The repository refused the milestone branch (ruleset, protection or permission) — a repository configuration fault, not a worker defect.",
      };
    case "prompt_too_long":
      // Issue #2682: the agent CLI refused the run because the transcript
      // outgrew the context window. The worker already spent its one
      // fresh-session retry, so this is stated plainly and never auto-filed.
      return {
        fixability: "not_code_fixable",
        failureClass: "prompt-too-long",
        rationale:
          "The agent CLI refused the run as Prompt is too long, even on a fresh session — the issue's context outgrew the model, not a worker defect.",
      };
    case "clone_corrupt":
      // Issue #2884: the host's shared clone is damaged (broken refs or a
      // corrupt object store). An operator repairs the host's clone; no
      // worker code change would help, so it is never auto-filed.
      return {
        fixability: "not_code_fixable",
        failureClass: "clone-corrupt",
        rationale:
          "Branch creation failed because the host's shared clone is damaged — a host infrastructure fault, not a worker defect.",
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
      // 9. The safe default — with one refinement: an unhandled exception /
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
