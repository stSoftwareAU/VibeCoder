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
 */ import { assertNever } from "./assert_never.ts";
import { isHostDiskProtectiveStopText } from "./host_disk_protective_stop.ts";
import { isOutOfCreditMessage, isWorkerGateCategory } from "./failure_diagnosis.ts";
import { isSecondaryRateLimitMessage } from "./secondary_rate_limit.ts";
/** Every slug the classifier can emit, for tests and the auto-filer. */ export const RUN_FAILURE_CLASSES = [
  "usage-limit",
  "github-abuse-limit",
  "interrupted",
  "scheduled-release",
  "out-of-credit",
  "provider-unavailable",
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
  "unknown"
];
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
 */ const OOM_EVIDENCE_RE = /(?<![\w/-])out[- ]of[- ]memory(?![\w/-])|(?<![\w/-])oom[- ]?kill|killed process|\bexit(?: code)? 137\b|\(exit 137|heap out of memory|allocation failed|cannot allocate memory/i;
/** The probe reading the killed branch writes into the diagnostics (Issue #4374). */ const HIGH_PRESSURE_AT_KILL_RE = /memory pressure at kill: high/i;
/**
 * Disk exhaustion — the worker can prune, warn or size the volume. The
 * park note remains disk evidence for other categories, where it stays
 * code-fixable. The floor-only wording is handled by the `internal_error`
 * protective-stop branch above, so quoted agent narration cannot trigger it.
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
 */ const ENOSPC_RE = /(?<![\w/-])ENOSPC(?![\w/-])/;
const DISK_FULL_PHRASE_RE = /\bno space left on device\b|\bdisk full\b|\bdisk is full\b|Read-only file system|\bos error 30\b|Parked as infrastructure \(Issue #4360\)/i;
/** Whether `message` has disk-exhaustion evidence or the host-disk park note. */ function isDiskFull(message) {
  return ENOSPC_RE.test(message) || DISK_FULL_PHRASE_RE.test(message);
}
/**
 * The completion phase's squash-lineage refusal (Issue #534): a merged PR
 * already squashed this branch's work into the base, and replaying the
 * branch onto the moved base was refused. The base moved on — a property
 * of the repository's history, never a worker defect, and (Issue #1658)
 * not a full disk either, whatever the branch happens to be called.
 */ const STALE_LINEAGE_RE = /Refusing to push[\s\S]{0,600}?squashed this branch's work/;
/** An unhandled exception / stack trace from the worker itself. */ const STACK_TRACE_RE = /\bat (?:Object|Module|async|file:\/\/)|\n\s+at \S+ \(|unhandled (?:exception|rejection)|typeerror:|referenceerror:/i;
/**
 * The structural half of {@link STACK_TRACE_RE}: a real stack frame.
 *
 * Kept separate because it is the half that survives inside quoted agent
 * output (Issue #249). A frame naming a function and a `file://` URL is a
 * crash dump — the Claude CLI itself falling over is a genuine worker-side
 * failure even though the dump reaches us through the agent's stdout. The
 * prose half (`unhandled exception`, `TypeError:`) is not: an agent whose
 * whole job is discussing code says those words constantly.
 */ const STACK_FRAME_RE = /\bat (?:Object|Module|async|file:\/\/)|\n\s+at \S+ \(/;
/**
 * The agent-authored `<details>` block in a detailed failure message —
 * `failure_message.ts` wraps `lastOutputSnippet` in exactly this shape.
 *
 * Non-greedy and anchored on the summary line so it cannot swallow the
 * sibling "Processes at the kill" block, which *is* worker-authored
 * evidence.
 */ const AGENT_OUTPUT_BLOCK_RE = /<details>\s*\n<summary>Last output from Claude[^<]*<\/summary>[\s\S]*?<\/details>/gi;
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
 */ export function splitAgentNarration(message) {
  const agentParts = [];
  const worker = message.replace(AGENT_OUTPUT_BLOCK_RE, (match)=>{
    agentParts.push(match);
    return "\n";
  });
  return {
    worker,
    agent: agentParts.join("\n")
  };
}
/** Out-of-credit / billing — account state, not a worker defect. */ const OUT_OF_CREDIT = {
  fixability: "not_code_fixable",
  failureClass: "out-of-credit",
  rationale: "The message reports an out-of-credit / billing condition."
};
/**
 * An external-orchestration provider unavailable on this host (Issue #4508).
 *
 * `preflightRole` in `orchestration/preflight.ts` refuses the run when the
 * provider's subscription is exhausted or its login rejected. That is account
 * state on the host, not a worker defect, so it is never auto-filed.
 */ const PROVIDER_UNAVAILABLE = {
  fixability: "not_code_fixable",
  failureClass: "provider-unavailable",
  rationale: "The external-orchestration provider's subscription login or quota was unavailable on this host (authentication rejected or quota exhausted) — account state, not a worker defect."
};
/**
 * The external-orchestration provider is unavailable (Issue #4508).
 *
 * Read from the worker's own words only: the agent's quoted output must not
 * trigger it. Gated on `internal_error`, the category the preflight refusal
 * is recorded under. It deliberately does NOT cover the other preflight
 * refusals (`CLI is not runnable`, `requires a fixed-price subscription`,
 * `child has metered credentials`), which stay `worker-crash`.
 */ const PROVIDER_UNAVAILABLE_RE = /\bexternal orchestration: [\w-]+ unavailable \(/;
/** The agent did not deliver — a property of the attempt, not a worker defect. */ const AGENT_OUTCOME = {
  fixability: "not_code_fixable",
  failureClass: "agent-outcome",
  rationale: "The agent did not deliver (quality gate, PR-summary gates, security-fix evidence, no changes, missing evidence) — not a worker defect."
};
/**
 * The agent's tool runtime failed (Issue #4324).
 *
 * A code-mode host that is unavailable, or a session whose every tool call
 * failed to spawn, is the worker's infrastructure. It is code-fixable, so the
 * run-failure filer raises one deduped issue, and it is not the source
 * issue's fault.
 */ const TOOL_RUNTIME = {
  fixability: "code_fixable",
  failureClass: "tool-runtime",
  rationale: "The agent's tool runtime failed (tools or the code-mode host were unavailable, or every tool call failed to spawn) — infrastructure, not an agent outcome."
};
/**
 * A refused repository-admin setting (Issue #4442).
 *
 * The refusal carries category `unknown` (Issue #4461), so it takes the
 * failed-once ladder with its escalating cooldown rather than the flat
 * transient retry an `internal_error` earns. The `repo-config` class is what
 * keeps the run-failure filer from auto-filing it as a `worker-crash`: it is a
 * repository or credential condition, not a worker defect.
 */ export const REPO_ADMIN_REFUSED = {
  fixability: "not_code_fixable",
  failureClass: "repo-config",
  rationale: "The repository or the worker's token refused the repository-admin setting the finding asks for (permission, plan or protection) — a configuration fault, not a worker defect."
};
/** Codex item types that are tool calls (the same set the progress tracker counts). */ const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "command",
  "function_call",
  "mcp_tool_call",
  "mcp_tool",
  "tool",
  "tool_use"
]);
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}
/** One transcript entry, unwrapping a Codex `item` or `payload` envelope. */ function unwrapTranscriptItem(entry) {
  const record = asRecord(entry);
  if (!record) return null;
  return asRecord(record.item) ?? asRecord(record.payload) ?? record;
}
function itemType(item) {
  const raw = item.item_type ?? item.type;
  return typeof raw === "string" ? raw.toLowerCase() : "";
}
/** Text a transcript item carries, folded for a case-insensitive check. */ function itemText(item) {
  const parts = [];
  for (const key of [
    "message",
    "text",
    "content",
    "error"
  ]){
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
 */ function isProviderToolRuntimeError(item) {
  if (itemType(item) !== "error") return false;
  const text = itemText(item);
  return text.includes("code mode is unavailable") || text.includes("host executable was not found") || text.includes("tool") && text.includes("unavailable");
}
function isToolItem(item) {
  return TOOL_ITEM_TYPES.has(itemType(item));
}
/** A tool call that never started because the runtime could not spawn it. */ function toolFailedToSpawn(item) {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  if (status === "failed_to_spawn" || status === "spawn_failed") return true;
  const text = itemText(item);
  return text.includes("failed to spawn") || text.includes("failure to spawn") || text.includes("could not spawn");
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
 */ /**
 * Parse a Codex session JSONL into items.
 *
 * A line that is not a JSON object is skipped. A torn final line is not a
 * transcript item, and it does not discard the items already read.
 */ export function parseCodexTranscript(text) {
  const items = [];
  for (const line of text.split("\n")){
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch  {
      continue;
    }
  }
  return items;
}
function transcriptShowsToolRuntimeFailure(transcript) {
  if (!transcript || transcript.length === 0) return false;
  const items = [];
  for (const entry of transcript){
    const item = unwrapTranscriptItem(entry);
    if (item) items.push(item);
  }
  // A provider error counts when nothing after it actually ran. Tools that
  // succeeded *before* the error are an earlier session (Issue #4362).
  let sawRuntimeError = false;
  let toolSucceededAfterError = false;
  for (const item of items){
    if (isProviderToolRuntimeError(item)) sawRuntimeError = true;
    if (sawRuntimeError && isToolItem(item) && !toolFailedToSpawn(item)) {
      toolSucceededAfterError = true;
    }
  }
  if (sawRuntimeError && !toolSucceededAfterError) return true;
  const tools = items.filter(isToolItem);
  // A tool that actually ran, with no provider error after it, means the
  // runtime was up. Quoted errors in a later agent message do not undo that.
  if (tools.some((tool)=>!toolFailedToSpawn(tool))) return false;
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
 * 1b. An unavailable external-orchestration provider (`internal_error`,
 *    worker's own words: `external orchestration: <provider> unavailable (`)
 *    — account state on the host, not a worker crash (Issue #4508).
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
 */ export function classifyRunFailure(category, failureMessage, declaredCategory, transcript) {
  // A declared source cause cannot be replaced by quoted git, test or agent
  // prose. Kills, account limits and internal-tool errors retain their source-specific
  // diagnostic refinements. Timeout disk evidence has its narrow exception below;
  // other declared categories do not read a message.
  const message = declaredCategory ? category === "killed" || category === "rate_limit" || category === "internal_error" ? splitAgentNarration(failureMessage ?? "").worker : "" : failureMessage ?? "";
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
      rationale: "GitHub's secondary (content-creation) rate limit refused a write — " + "a self-clearing throttle, not an account usage limit."
    };
  }
  if (category === "rate_limit") {
    // An out-of-credit refusal is categorised rate_limit (Issue #2590) but
    // keeps its own, more precise failure class.
    if (isOutOfCreditMessage(message)) return OUT_OF_CREDIT;
    return {
      fixability: "not_code_fixable",
      failureClass: "usage-limit",
      rationale: "The run hit a usage or rate limit (account/quota state, not a worker defect)."
    };
  }
  // A run cut off before finishing is transient infrastructure, never a worker
  // defect and never auto-filed — the loop simply retries it (Issue #108).
  if (category === "interrupted") {
    return {
      fixability: "not_code_fixable",
      failureClass: "interrupted",
      rationale: "The run was cut off before finishing (still working, not concluding) — transient, retried rather than filed."
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
      rationale: "The run was released on schedule (cycle ended, finish deadline reached, or run hard cap reached) with its work preserved — not a worker defect."
    };
  }
  if (isOutOfCreditMessage(message)) return OUT_OF_CREDIT;
  // An unavailable external-orchestration provider is account state (Issue #4508).
  if (category === "internal_error" && PROVIDER_UNAVAILABLE_RE.test(splitAgentNarration(failureMessage ?? "").worker)) return PROVIDER_UNAVAILABLE;
  // 2. A squash-lineage refusal is the base having moved on (Issue #534),
  //    stated in the worker's own words — and its text quotes a branch name
  //    and git's conflict hints, which is exactly what fooled the disk and
  //    crash rules before (Issue #1658). Named first so neither can.
  if (STALE_LINEAGE_RE.test(message)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "stale-lineage",
      rationale: "The completion phase refused to push a branch whose work a merged PR already squashed into the base (Issue #534) — the base moved on, not a worker defect."
    };
  }
  // The worker deliberately releases an in-flight build when its own disk
  // monitor crosses the floor (Issue #4360). Keep the stable disk-full class
  // for diagnosis, but do not file it as a worker defect: the release is the
  // disk guard working as designed. Read protective-stop wording only from
  // worker prose; the same sentence in quoted agent output is not a parking
  // decision. The shared matcher also recognises the floor-only wording
  // emitted when a caller quotes the host check without its park note.
  if (category === "internal_error" && isHostDiskProtectiveStopText(splitAgentNarration(failureMessage ?? "").worker)) {
    return {
      fixability: "not_code_fixable",
      failureClass: "disk-full",
      rationale: "The worker intentionally parked work after its host-disk floor was crossed; the protective release is not a worker defect."
    };
  }
  // 3. Disk exhaustion by message — outranks killed/crash because a full
  //    disk is what killed or crashed the run.
  // Existing timeout diagnostics intentionally retain error-shaped disk evidence
  // from CLI output. That narrow refinement does not grant quoted account,
  // crash or lineage prose authority over a declared execution timeout.
  if (isDiskFull(declaredCategory && category === "timeout" ? failureMessage : message)) {
    return {
      fixability: "code_fixable",
      failureClass: "disk-full",
      rationale: "The message reports disk exhaustion (ENOSPC, no space left on device, or a read-only filesystem after the disk filled)."
    };
  }
  switch(category){
    case "killed":
      // 4. SIGKILL: memory evidence makes it an OOM the worker can size or
      //    throttle for; without evidence the cause is unproven. The probe
      //    reading taken at the kill (Issue #4374) is the strongest evidence
      //    and is named as such — exit 137 alone is an inference.
      if (HIGH_PRESSURE_AT_KILL_RE.test(message)) {
        return {
          fixability: "code_fixable",
          failureClass: "oom",
          rationale: "The run was killed (SIGKILL) while the memory-pressure probe read high at the kill."
        };
      }
      if (OOM_EVIDENCE_RE.test(splitAgentNarration(message).worker)) {
        return {
          fixability: "code_fixable",
          failureClass: "oom",
          rationale: "The run was killed (SIGKILL) with out-of-memory evidence in the message."
        };
      }
      return {
        fixability: "unknown",
        failureClass: "killed-unknown",
        rationale: "The run was killed (SIGKILL) with no memory evidence — cause unproven."
      };
    case "internal_error":
      // 5. A worker-side error or crash.
      return {
        fixability: "code_fixable",
        failureClass: "worker-crash",
        rationale: "The failure is an internal tooling / CLI error or unhandled exception in the worker."
      };
    case "missing_tools":
      // 6. The image or PATH is the worker's to fix.
      return {
        fixability: "code_fixable",
        failureClass: "missing-tools",
        rationale: "A required tool is missing from the worker environment."
      };
    case "timeout":
      // 7. Cause unproven: an agent that ran long is not, by itself, a
      //    worker defect.
      return crashOr({
        fixability: "unknown",
        failureClass: "timeout",
        rationale: "The run timed out; the cause is not proven to be the worker."
      }, message);
    case "zero_output":
      return crashOr({
        fixability: "unknown",
        failureClass: "no-output",
        rationale: "The run produced no output; the cause is not proven to be the worker."
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
        rationale: "A pre-PR gate refused the run over a GitHub Actions finding in a workflow file the change introduced — not a worker defect."
      };
    case "token_scope":
      // Issue #1475: the host's credential lacks the `workflow` scope. An
      // operator grants it; no code changes. Never auto-filed as a worker
      // defect — the run itself already says exactly what to do.
      return {
        fixability: "not_code_fixable",
        failureClass: "token-scope",
        rationale: "The worker's token lacks the workflow scope the change needs — a host credential gap, not a worker defect."
      };
    case "repo_config":
      // Issue #2220: the repository refused the milestone branch (a ruleset,
      // a protection, or a missing permission). An operator clears it in the
      // repository's settings; no worker code change would help, so it is
      // never auto-filed as a worker defect.
      return {
        fixability: "not_code_fixable",
        failureClass: "repo-config",
        rationale: "The repository refused the milestone branch (ruleset, protection or permission) — a repository configuration fault, not a worker defect."
      };
    case "prompt_too_long":
      // Issue #2682: the agent CLI refused the run because the transcript
      // outgrew the context window. The worker already spent its one
      // fresh-session retry, so this is stated plainly and never auto-filed.
      return {
        fixability: "not_code_fixable",
        failureClass: "prompt-too-long",
        rationale: "The agent CLI refused the run as Prompt is too long, even on a fresh session — the issue's context outgrew the model, not a worker defect."
      };
    case "clone_corrupt":
      // Issue #2884: the host's shared clone is damaged (broken refs or a
      // corrupt object store). An operator repairs the host's clone; no
      // worker code change would help, so it is never auto-filed.
      return {
        fixability: "not_code_fixable",
        failureClass: "clone-corrupt",
        rationale: "Branch creation failed because the host's shared clone is damaged — a host infrastructure fault, not a worker defect."
      };
    case "push_failure":
      // A rejected push is usually permissions/protection or a race — not
      // proven either way.
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "Git push failed; the cause is not proven to be the worker."
      }, message);
    case "unknown":
      // 9. The safe default — with one refinement: an unhandled exception /
      //    stack trace in the message is a worker crash whatever the
      //    category detector made of it.
      return crashOr({
        fixability: "unknown",
        failureClass: "unknown",
        rationale: "No signal in the category or message decides fixability."
      }, message);
    default:
      // Exhaustiveness guard: a new FailureCategory must choose a bucket.
      return assertNever(category);
  }
}
/**
 * Refine an otherwise-unknown result: an unhandled exception / stack trace
 * in the message is a worker crash (code-fixable) whatever the category.
 */ function crashOr(fallback, message) {
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
      rationale: "The message carries an unhandled exception / stack trace from the worker."
    };
  }
  return fallback;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydW5fb3V0Y29tZV9jbGFzc2lmaWVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2xhc3NpZnkgYSBuby1QUiBydW4gb3V0Y29tZSBhcyBmaXhhYmxlIGJ5IGNvZGUgb3Igbm90IChJc3N1ZSAjNDMyOCwgcGFydFxuICogb2YgIzQyOTEpLlxuICpcbiAqICM0MjkxIHNwbGl0cyBuby1QUiBvdXRjb21lcyBpbnRvIHR3byBidWNrZXRzIHRoYXQgZHJpdmUgYmVoYXZpb3VyOlxuICpcbiAqIC0gKipjb2RlLWZpeGFibGUqKiDigJQgdGhlIHdvcmtlciBjb3VsZCBiZSBjaGFuZ2VkIHRvIHN0b3AgaXQgaGFwcGVuaW5nXG4gKiAgIChPT00gLyBTSUdLSUxMIHdpdGggbWVtb3J5IGV2aWRlbmNlLCBkaXNrIGV4aGF1c3Rpb24sIGNyYXNoZXMsIG1pc3NpbmdcbiAqICAgdG9vbHMpLiBUaGVzZSBnZXQgYW4gYXV0by1maWxlZCBpc3N1ZSAoSXNzdWUgIzQzMjkpLlxuICogLSAqKm5vdCBmaXhhYmxlIGJ5IGNvZGUqKiDigJQgYW4gYWNjb3VudCBvciBlbnZpcm9ubWVudCBsaW1pdCAodXNhZ2UgLyByYXRlXG4gKiAgIGxpbWl0LCBvdXQgb2YgY3JlZGl0KSBvciB0aGUgYWdlbnQgc2ltcGx5IG5vdCBkZWxpdmVyaW5nLiBUaGVzZSBhcmVcbiAqICAgc3RhdGVkIHBsYWlubHkgaW4gdGhlIHJlbGVhc2UgY29tbWVudCBhbmQgbm90aGluZyBlbHNlIGhhcHBlbnMuXG4gKlxuICogYHVua25vd25gIGlzIHRoZSBTQUZFIGRlZmF1bHQ6IGl0IGlzIE5PVCBjb2RlLWZpeGFibGUgZm9yIGF1dG8tZmlsaW5nIOKAlCBhXG4gKiB3cm9uZyBndWVzcyBjb3N0cyBhIHNwYW0gaXNzdWUg4oCUIGFuZCB0aGUgYXV0by1maWxlciBmaWxlcyBvbmx5IG9uXG4gKiBgY29kZV9maXhhYmxlYC5cbiAqXG4gKiBNb2RlbGxlZCBvbiBgY2lfZmFpbHVyZV9jbGFzc2lmaWVyLnRzYCAoY2xhc3NpZnksIHRoZW4gZmlsZSwgd2l0aCBhIHN0YWJsZVxuICogY2xhc3Mgc2x1ZyBmb3IgZGVkdXApLiBUaGUgcHJpbWFyeSBpbnB1dCBpcyB0aGUgYEZhaWx1cmVDYXRlZ29yeWAgZnJvbVxuICogYGZhaWx1cmVfZGlhZ25vc2lzLnRzYCwgZGVjbGFyZWQgYnkgbmV3IHdvcmtlciByZXN1bHRzIG9yIGRldGVjdGVkIGJ5IGxlZ2FjeVxuICogcmF3LW91dHB1dCBhZGFwdGVycy4gVGhpcyByZWZpbmVzIHRoYXQgY2F0ZWdvcnkgcmF0aGVyIHRoYW4gcmUtZGVyaXZpbmcgaXQuIFRoZSByYXcgbWVzc2FnZSBpcyBhIHNlY29uZGFyeSBpbnB1dCBvbmx5LCBmb3JcbiAqIHNpZ25hbHMgdGhlIGNhdGVnb3J5IGNhbm5vdCBleHByZXNzIChPT00gZXZpZGVuY2UsIGRpc2sgZXhoYXVzdGlvbixcbiAqIG91dC1vZi1jcmVkaXQpLlxuICpcbiAqIFB1cmU6IG5vIGBEZW5vLipgLCBubyBuZXR3b3JrLCBubyBjbG9jay4gRGV0ZXJtaW5pc3RpYyBvbiBpdHMgaW5wdXRzLlxuICogTWVzc2FnZSBtYXRjaGluZyBpcyBjYXNlLWluc2Vuc2l0aXZlIHRocm91Z2hvdXQgKHRoZSAjNDMxNSBsZXNzb246IGFcbiAqIGNhc2Utc2Vuc2l0aXZlIGNoZWNrIGxldCBcIlJhdGUgbGltaXQg4oCmXCIgZmFsbCB0aHJvdWdoIHRvIHVua25vd24pLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGFzc2VydE5ldmVyIH0gZnJvbSBcIi4vYXNzZXJ0X25ldmVyLnRzXCI7XG5pbXBvcnQgeyBpc0hvc3REaXNrUHJvdGVjdGl2ZVN0b3BUZXh0IH0gZnJvbSBcIi4vaG9zdF9kaXNrX3Byb3RlY3RpdmVfc3RvcC50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBGYWlsdXJlQ2F0ZWdvcnksXG4gIGlzT3V0T2ZDcmVkaXRNZXNzYWdlLFxuICBpc1dvcmtlckdhdGVDYXRlZ29yeSxcbn0gZnJvbSBcIi4vZmFpbHVyZV9kaWFnbm9zaXMudHNcIjtcbmltcG9ydCB7IGlzU2Vjb25kYXJ5UmF0ZUxpbWl0TWVzc2FnZSB9IGZyb20gXCIuL3NlY29uZGFyeV9yYXRlX2xpbWl0LnRzXCI7XG5cbi8qKiBXaGV0aGVyIGEgY29kZSBjaGFuZ2UgY291bGQgc3RvcCB0aGUgZmFpbHVyZSByZWN1cnJpbmcuICovXG5leHBvcnQgdHlwZSBSdW5GYWlsdXJlRml4YWJpbGl0eSA9XG4gIHwgXCJjb2RlX2ZpeGFibGVcIlxuICB8IFwibm90X2NvZGVfZml4YWJsZVwiXG4gIHwgXCJ1bmtub3duXCI7XG5cbi8qKiBSZXN1bHQgb2YgY2xhc3NpZnlpbmcgYSBuby1QUiBydW4gb3V0Y29tZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuRmFpbHVyZUNsYXNzaWZpY2F0aW9uIHtcbiAgZml4YWJpbGl0eTogUnVuRmFpbHVyZUZpeGFiaWxpdHk7XG4gIC8qKlxuICAgKiBTdGFibGUga2ViYWItY2FzZSBzbHVnIHVzZWQgYXMgdGhlIGRlZHVwIGtleSBieSB0aGUgYXV0by1maWxpbmcgc2libGluZ1xuICAgKiAoSXNzdWUgIzQzMjkpIOKAlCBvbmUgb3BlbiBpc3N1ZSBwZXIgY2xhc3MuIENoYW5naW5nIGEgc2x1ZyBvcnBoYW5zIGl0c1xuICAgKiBvcGVuIGlzc3VlLCBzbyB0cmVhdCB0aGVzZSBhcyBhbiBBUEkuXG4gICAqL1xuICBmYWlsdXJlQ2xhc3M6IHN0cmluZztcbiAgLyoqIFNob3J0IGh1bWFuIHNlbnRlbmNlIG5hbWluZyB0aGUgZXZpZGVuY2UgdGhhdCBkZWNpZGVkIGl0LiAqL1xuICByYXRpb25hbGU6IHN0cmluZztcbn1cblxuLyoqIEV2ZXJ5IHNsdWcgdGhlIGNsYXNzaWZpZXIgY2FuIGVtaXQsIGZvciB0ZXN0cyBhbmQgdGhlIGF1dG8tZmlsZXIuICovXG5leHBvcnQgY29uc3QgUlVOX0ZBSUxVUkVfQ0xBU1NFUyA9IFtcbiAgXCJ1c2FnZS1saW1pdFwiLFxuICBcImdpdGh1Yi1hYnVzZS1saW1pdFwiLFxuICBcImludGVycnVwdGVkXCIsXG4gIFwic2NoZWR1bGVkLXJlbGVhc2VcIixcbiAgXCJvdXQtb2YtY3JlZGl0XCIsXG4gIFwicHJvdmlkZXItdW5hdmFpbGFibGVcIixcbiAgXCJzdGFsZS1saW5lYWdlXCIsXG4gIFwib29tXCIsXG4gIFwia2lsbGVkLXVua25vd25cIixcbiAgXCJkaXNrLWZ1bGxcIixcbiAgXCJ3b3JrZXItY3Jhc2hcIixcbiAgXCJtaXNzaW5nLXRvb2xzXCIsXG4gIFwidG9vbC1ydW50aW1lXCIsXG4gIFwidGltZW91dFwiLFxuICBcIm5vLW91dHB1dFwiLFxuICBcImFnZW50LW91dGNvbWVcIixcbiAgXCJ3b3JrZmxvdy1nYXRlXCIsXG4gIFwicmVwby1jb25maWdcIixcbiAgXCJwcm9tcHQtdG9vLWxvbmdcIixcbiAgXCJjbG9uZS1jb3JydXB0XCIsXG4gIC8vIEZpbGVkIGJ5IGBzZWN1cml0eV9maXhfZ2F0ZV9yZXRyeS50c2AsIG5ldmVyIGVtaXR0ZWQgYnkgdGhlIGNsYXNzaWZpZXJcbiAgLy8gKElzc3VlICM0Mjk4KTogcmVwZWF0ZWQgZ2F0ZSBibG9ja3Mgb24gb25lIGFwcHJvdmVkIGlzc3VlIGFyZSBhIGdhdGUgYnVnLlxuICBcInNlY3VyaXR5LWZpeC1nYXRlLWJsb2NrZWRcIixcbiAgXCJ1bmtub3duXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIE1lbW9yeS1wcmVzc3VyZSBldmlkZW5jZSBiZXNpZGUgYSBraWxsIChJc3N1ZSAjNDIwMikuXG4gKlxuICogUmVhZCBmcm9tIHRoZSB3b3JrZXIncyBvd24gd29yZHMgb25seSAoSXNzdWUgIzM2OTQpOiBnYXRlZCBvbiB0aGUgYGtpbGxlZGBcbiAqIGNhdGVnb3J5IGFuZCBzY2FubmVkIG92ZXIgYHNwbGl0QWdlbnROYXJyYXRpb24oLi4uKS53b3JrZXJgLiBUaGUgYWdlbnQnc1xuICogcXVvdGVkIG91dHB1dCBjYXJyaWVzIHRvb2wgcmVzdWx0cyBzdWNoIGFzIGBFcnJvcjogRXhpdCBjb2RlIDEzN2AgZnJvbSBhXG4gKiBjb21tYW5kIHRoZSBhZ2VudCByYW4sIHdoaWNoIGlzIG5vdCBldmlkZW5jZSB0aGF0IHRoZSBhZ2VudCBpdHNlbGYgd2FzXG4gKiBPT00ta2lsbGVkLiBUaGUgd29ya2VyLWF1dGhvcmVkIGtpbGwtZGlhZ25vc3RpY3MgYmxvY2sgKGtlcm5lbCBPT00gbGluZXMpXG4gKiBhbmQgdGhlIGtpbGwgaGVhZGxpbmUgc3RheSBpbiBzY29wZS4gVGhlIENMSSdzIG93biBWOCBoZWFwIGFib3J0IGlzIGNhdWdodFxuICogZWFybGllciBieSB0aGUgcnVubmVyJ3MgYGRldGVjdE91dE9mTWVtb3J5YCAoY2xhdWRlX3J1bm5lci50cykgYW5kIHJlYWNoZXNcbiAqIHRoZSBjbGFzc2lmaWVyIGFzIGBidWlsZE91dE9mTWVtb3J5TWVzc2FnZWAncyB3b3JrZXItd29yZGVkIGhlYWRsaW5lLlxuICovXG5jb25zdCBPT01fRVZJREVOQ0VfUkUgPVxuICAvKD88IVtcXHcvLV0pb3V0Wy0gXW9mWy0gXW1lbW9yeSg/IVtcXHcvLV0pfCg/PCFbXFx3Ly1dKW9vbVstIF0/a2lsbHxraWxsZWQgcHJvY2Vzc3xcXGJleGl0KD86IGNvZGUpPyAxMzdcXGJ8XFwoZXhpdCAxMzd8aGVhcCBvdXQgb2YgbWVtb3J5fGFsbG9jYXRpb24gZmFpbGVkfGNhbm5vdCBhbGxvY2F0ZSBtZW1vcnkvaTtcblxuLyoqIFRoZSBwcm9iZSByZWFkaW5nIHRoZSBraWxsZWQgYnJhbmNoIHdyaXRlcyBpbnRvIHRoZSBkaWFnbm9zdGljcyAoSXNzdWUgIzQzNzQpLiAqL1xuY29uc3QgSElHSF9QUkVTU1VSRV9BVF9LSUxMX1JFID0gL21lbW9yeSBwcmVzc3VyZSBhdCBraWxsOiBoaWdoL2k7XG5cbi8qKlxuICogRGlzayBleGhhdXN0aW9uIOKAlCB0aGUgd29ya2VyIGNhbiBwcnVuZSwgd2FybiBvciBzaXplIHRoZSB2b2x1bWUuIFRoZVxuICogcGFyayBub3RlIHJlbWFpbnMgZGlzayBldmlkZW5jZSBmb3Igb3RoZXIgY2F0ZWdvcmllcywgd2hlcmUgaXQgc3RheXNcbiAqIGNvZGUtZml4YWJsZS4gVGhlIGZsb29yLW9ubHkgd29yZGluZyBpcyBoYW5kbGVkIGJ5IHRoZSBgaW50ZXJuYWxfZXJyb3JgXG4gKiBwcm90ZWN0aXZlLXN0b3AgYnJhbmNoIGFib3ZlLCBzbyBxdW90ZWQgYWdlbnQgbmFycmF0aW9uIGNhbm5vdCB0cmlnZ2VyIGl0LlxuICpcbiAqIERlbGliZXJhdGVseSBzdGlsbCBzY2FubmVkIG92ZXIgdGhlICp3aG9sZSogbWVzc2FnZSwgYWdlbnQgb3V0cHV0XG4gKiBpbmNsdWRlZCwgdW5saWtlIHRoZSBjcmFzaCBwYXR0ZXJucyAoSXNzdWUgIzI0OSkuIFRoZSBhc3ltbWV0cnkgaXMgbm90IGFuXG4gKiBvdmVyc2lnaHQ6IEVOT1NQQyByZWFjaGluZyB1cyB0aHJvdWdoIHRoZSBhZ2VudCdzIHN0ZG91dCBtZWFucyB0aGUgcnVuXG4gKiBnZW51aW5lbHkgaGl0IGEgZnVsbCBkaXNrLCB3aGljaCBpcyByZWFsIGVudmlyb25tZW50YWwgZXZpZGVuY2UgdGhlXG4gKiB3b3JrZXIgY2FuIGFjdCBvbi4gQSBtZW50aW9uIG9mIGFuIGV4Y2VwdGlvbiBpcyBkaWZmZXJlbnQgaW4ga2luZCDigJQgdGhlXG4gKiBhZ2VudCBpcyBkZXNjcmliaW5nIHRoZSB1c2VyJ3MgY29kZSwgbm90IHJlcG9ydGluZyBpdHMgb3duIGVudmlyb25tZW50LlxuICpcbiAqIEVycm9yLXNoYXBlZCB0ZXh0IG9ubHkgKElzc3VlICMxNjU4KTogYEVOT1NQQ2AgaXMgdGhlIGVycm5vIGFzIGFuXG4gKiBvcGVyYXRpbmcgc3lzdGVtIHNwZWxscyBpdCDigJQgdXBwZXJjYXNlLCBhIHdob2xlIHdvcmQsIGFuZCBuZXZlciBnbHVlZCB0b1xuICogYSBzbHVnLCBwYXRoIG9yIFVSTCB3aXRoIGAtYCwgYF9gIG9yIGAvYC4gVGhlIGxvd2VyY2FzZSwgdW5hbmNob3JlZCBmb3JtXG4gKiBtYXRjaGVkIGBlbm9zcGNgIGluc2lkZSB0aGUgYnJhbmNoIG5hbWVcbiAqIGBtaWxlc3RvbmUvNDY5MC1idWctc2FtcGxlci1lbm9zcGMtb24tMjI4LWdiLWhvc3RzLTYwLWdiLWRpc2tgIGluIGEgcHVzaFxuICogcmVmdXNhbCB0aGF0IGhhZCBub3RoaW5nIHRvIGRvIHdpdGggZGlzaywgYW5kIGF1dG8tZmlsZWQgYSBgZGlzay1mdWxsYFxuICogd29ya2VyIGRlZmVjdCBmb3IgaXQuIFRoZSB0aHJlZSBwcm9zZSBwaHJhc2VzIHN0YXkgY2FzZS1pbnNlbnNpdGl2ZSwgYXNcbiAqIHdob2xlIHBocmFzZXMuXG4gKi9cbmNvbnN0IEVOT1NQQ19SRSA9IC8oPzwhW1xcdy8tXSlFTk9TUEMoPyFbXFx3Ly1dKS87XG5jb25zdCBESVNLX0ZVTExfUEhSQVNFX1JFID1cbiAgL1xcYm5vIHNwYWNlIGxlZnQgb24gZGV2aWNlXFxifFxcYmRpc2sgZnVsbFxcYnxcXGJkaXNrIGlzIGZ1bGxcXGJ8UmVhZC1vbmx5IGZpbGUgc3lzdGVtfFxcYm9zIGVycm9yIDMwXFxifFBhcmtlZCBhcyBpbmZyYXN0cnVjdHVyZSBcXChJc3N1ZSAjNDM2MFxcKS9pO1xuXG4vKiogV2hldGhlciBgbWVzc2FnZWAgaGFzIGRpc2stZXhoYXVzdGlvbiBldmlkZW5jZSBvciB0aGUgaG9zdC1kaXNrIHBhcmsgbm90ZS4gKi9cbmZ1bmN0aW9uIGlzRGlza0Z1bGwobWVzc2FnZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBFTk9TUENfUkUudGVzdChtZXNzYWdlKSB8fCBESVNLX0ZVTExfUEhSQVNFX1JFLnRlc3QobWVzc2FnZSk7XG59XG5cbi8qKlxuICogVGhlIGNvbXBsZXRpb24gcGhhc2UncyBzcXVhc2gtbGluZWFnZSByZWZ1c2FsIChJc3N1ZSAjNTM0KTogYSBtZXJnZWQgUFJcbiAqIGFscmVhZHkgc3F1YXNoZWQgdGhpcyBicmFuY2gncyB3b3JrIGludG8gdGhlIGJhc2UsIGFuZCByZXBsYXlpbmcgdGhlXG4gKiBicmFuY2ggb250byB0aGUgbW92ZWQgYmFzZSB3YXMgcmVmdXNlZC4gVGhlIGJhc2UgbW92ZWQgb24g4oCUIGEgcHJvcGVydHlcbiAqIG9mIHRoZSByZXBvc2l0b3J5J3MgaGlzdG9yeSwgbmV2ZXIgYSB3b3JrZXIgZGVmZWN0LCBhbmQgKElzc3VlICMxNjU4KVxuICogbm90IGEgZnVsbCBkaXNrIGVpdGhlciwgd2hhdGV2ZXIgdGhlIGJyYW5jaCBoYXBwZW5zIHRvIGJlIGNhbGxlZC5cbiAqL1xuY29uc3QgU1RBTEVfTElORUFHRV9SRSA9XG4gIC9SZWZ1c2luZyB0byBwdXNoW1xcc1xcU117MCw2MDB9P3NxdWFzaGVkIHRoaXMgYnJhbmNoJ3Mgd29yay87XG5cbi8qKiBBbiB1bmhhbmRsZWQgZXhjZXB0aW9uIC8gc3RhY2sgdHJhY2UgZnJvbSB0aGUgd29ya2VyIGl0c2VsZi4gKi9cbmNvbnN0IFNUQUNLX1RSQUNFX1JFID1cbiAgL1xcYmF0ICg/Ok9iamVjdHxNb2R1bGV8YXN5bmN8ZmlsZTpcXC9cXC8pfFxcblxccythdCBcXFMrIFxcKHx1bmhhbmRsZWQgKD86ZXhjZXB0aW9ufHJlamVjdGlvbil8dHlwZWVycm9yOnxyZWZlcmVuY2VlcnJvcjovaTtcblxuLyoqXG4gKiBUaGUgc3RydWN0dXJhbCBoYWxmIG9mIHtAbGluayBTVEFDS19UUkFDRV9SRX06IGEgcmVhbCBzdGFjayBmcmFtZS5cbiAqXG4gKiBLZXB0IHNlcGFyYXRlIGJlY2F1c2UgaXQgaXMgdGhlIGhhbGYgdGhhdCBzdXJ2aXZlcyBpbnNpZGUgcXVvdGVkIGFnZW50XG4gKiBvdXRwdXQgKElzc3VlICMyNDkpLiBBIGZyYW1lIG5hbWluZyBhIGZ1bmN0aW9uIGFuZCBhIGBmaWxlOi8vYCBVUkwgaXMgYVxuICogY3Jhc2ggZHVtcCDigJQgdGhlIENsYXVkZSBDTEkgaXRzZWxmIGZhbGxpbmcgb3ZlciBpcyBhIGdlbnVpbmUgd29ya2VyLXNpZGVcbiAqIGZhaWx1cmUgZXZlbiB0aG91Z2ggdGhlIGR1bXAgcmVhY2hlcyB1cyB0aHJvdWdoIHRoZSBhZ2VudCdzIHN0ZG91dC4gVGhlXG4gKiBwcm9zZSBoYWxmIChgdW5oYW5kbGVkIGV4Y2VwdGlvbmAsIGBUeXBlRXJyb3I6YCkgaXMgbm90OiBhbiBhZ2VudCB3aG9zZVxuICogd2hvbGUgam9iIGlzIGRpc2N1c3NpbmcgY29kZSBzYXlzIHRob3NlIHdvcmRzIGNvbnN0YW50bHkuXG4gKi9cbmNvbnN0IFNUQUNLX0ZSQU1FX1JFID0gL1xcYmF0ICg/Ok9iamVjdHxNb2R1bGV8YXN5bmN8ZmlsZTpcXC9cXC8pfFxcblxccythdCBcXFMrIFxcKC87XG5cbi8qKlxuICogVGhlIGFnZW50LWF1dGhvcmVkIGA8ZGV0YWlscz5gIGJsb2NrIGluIGEgZGV0YWlsZWQgZmFpbHVyZSBtZXNzYWdlIOKAlFxuICogYGZhaWx1cmVfbWVzc2FnZS50c2Agd3JhcHMgYGxhc3RPdXRwdXRTbmlwcGV0YCBpbiBleGFjdGx5IHRoaXMgc2hhcGUuXG4gKlxuICogTm9uLWdyZWVkeSBhbmQgYW5jaG9yZWQgb24gdGhlIHN1bW1hcnkgbGluZSBzbyBpdCBjYW5ub3Qgc3dhbGxvdyB0aGVcbiAqIHNpYmxpbmcgXCJQcm9jZXNzZXMgYXQgdGhlIGtpbGxcIiBibG9jaywgd2hpY2ggKmlzKiB3b3JrZXItYXV0aG9yZWRcbiAqIGV2aWRlbmNlLlxuICovXG5jb25zdCBBR0VOVF9PVVRQVVRfQkxPQ0tfUkUgPVxuICAvPGRldGFpbHM+XFxzKlxcbjxzdW1tYXJ5Pkxhc3Qgb3V0cHV0IGZyb20gQ2xhdWRlW148XSo8XFwvc3VtbWFyeT5bXFxzXFxTXSo/PFxcL2RldGFpbHM+L2dpO1xuXG4vKipcbiAqIFNwbGl0IGEgZmFpbHVyZSBtZXNzYWdlIGludG8gdGhlIHdvcmtlcidzIG93biB3b3JkcyBhbmQgdGhlIGFnZW50J3MuXG4gKlxuICogYGZvcm1hdERldGFpbGVkRmFpbHVyZU1lc3NhZ2VgIGVtYmVkcyB0aGUgdGFpbCBvZiBDbGF1ZGUncyBzdGRvdXQgaW4gdGhlXG4gKiBtZXNzYWdlIGl0IGhhbmRzIHRoZSBjbGFzc2lmaWVyLiBUaGF0IHRleHQgaXMgdGhlIGFnZW50IG5hcnJhdGluZyBhYm91dFxuICogdGhlICp1c2VyJ3MqIGNvZGViYXNlLCBhbmQgdHJlYXRpbmcgaXQgYXMgZXZpZGVuY2UgYWJvdXQgdGhlIHdvcmtlciBpc1xuICogaG93IElzc3VlICMyNDkgaGFwcGVuZWQ6IGEgY2xlYW4gZGVhZGxpbmUgc3RvcCAoZXhpdCAxNDMsIFdJUCBwcmVzZXJ2ZWQsXG4gKiBjYXRlZ29yeSBgdGltZW91dGApIHdhcyBmaWxlZCBhcyBhIGB3b3JrZXItY3Jhc2hgIGJlY2F1c2UgQ2xhdWRlIGhhZFxuICogd3JpdHRlbiBcImEgc2Vjb25kIGZhaWx1cmUgc3VyZmFjZXMgYXMgYW4gdW5oYW5kbGVkIHJlamVjdGlvblwiIGFib3V0IHRoZVxuICogY29uY3VycmVuY3kgZHJpdmVyIGl0IHdhcyBmaXhpbmcgaW4gR1JRLlxuICpcbiAqIEBwYXJhbSBtZXNzYWdlIC0gVGhlIGZ1bGwgZmFpbHVyZSBtZXNzYWdlLlxuICogQHJldHVybnMgYHdvcmtlcmAgd2l0aCB0aGUgYWdlbnQgYmxvY2sgcmVtb3ZlZCwgYW5kIGBhZ2VudGAgaG9sZGluZyBqdXN0XG4gKiAgIHRoZSByZW1vdmVkIGJsb2NrKHMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRBZ2VudE5hcnJhdGlvbihcbiAgbWVzc2FnZTogc3RyaW5nLFxuKTogeyB3b3JrZXI6IHN0cmluZzsgYWdlbnQ6IHN0cmluZyB9IHtcbiAgY29uc3QgYWdlbnRQYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd29ya2VyID0gbWVzc2FnZS5yZXBsYWNlKEFHRU5UX09VVFBVVF9CTE9DS19SRSwgKG1hdGNoKSA9PiB7XG4gICAgYWdlbnRQYXJ0cy5wdXNoKG1hdGNoKTtcbiAgICByZXR1cm4gXCJcXG5cIjtcbiAgfSk7XG4gIHJldHVybiB7IHdvcmtlciwgYWdlbnQ6IGFnZW50UGFydHMuam9pbihcIlxcblwiKSB9O1xufVxuXG4vKiogT3V0LW9mLWNyZWRpdCAvIGJpbGxpbmcg4oCUIGFjY291bnQgc3RhdGUsIG5vdCBhIHdvcmtlciBkZWZlY3QuICovXG5jb25zdCBPVVRfT0ZfQ1JFRElUOiBSdW5GYWlsdXJlQ2xhc3NpZmljYXRpb24gPSB7XG4gIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICBmYWlsdXJlQ2xhc3M6IFwib3V0LW9mLWNyZWRpdFwiLFxuICByYXRpb25hbGU6IFwiVGhlIG1lc3NhZ2UgcmVwb3J0cyBhbiBvdXQtb2YtY3JlZGl0IC8gYmlsbGluZyBjb25kaXRpb24uXCIsXG59O1xuXG4vKipcbiAqIEFuIGV4dGVybmFsLW9yY2hlc3RyYXRpb24gcHJvdmlkZXIgdW5hdmFpbGFibGUgb24gdGhpcyBob3N0IChJc3N1ZSAjNDUwOCkuXG4gKlxuICogYHByZWZsaWdodFJvbGVgIGluIGBvcmNoZXN0cmF0aW9uL3ByZWZsaWdodC50c2AgcmVmdXNlcyB0aGUgcnVuIHdoZW4gdGhlXG4gKiBwcm92aWRlcidzIHN1YnNjcmlwdGlvbiBpcyBleGhhdXN0ZWQgb3IgaXRzIGxvZ2luIHJlamVjdGVkLiBUaGF0IGlzIGFjY291bnRcbiAqIHN0YXRlIG9uIHRoZSBob3N0LCBub3QgYSB3b3JrZXIgZGVmZWN0LCBzbyBpdCBpcyBuZXZlciBhdXRvLWZpbGVkLlxuICovXG5jb25zdCBQUk9WSURFUl9VTkFWQUlMQUJMRTogUnVuRmFpbHVyZUNsYXNzaWZpY2F0aW9uID0ge1xuICBmaXhhYmlsaXR5OiBcIm5vdF9jb2RlX2ZpeGFibGVcIixcbiAgZmFpbHVyZUNsYXNzOiBcInByb3ZpZGVyLXVuYXZhaWxhYmxlXCIsXG4gIHJhdGlvbmFsZTpcbiAgICBcIlRoZSBleHRlcm5hbC1vcmNoZXN0cmF0aW9uIHByb3ZpZGVyJ3Mgc3Vic2NyaXB0aW9uIGxvZ2luIG9yIHF1b3RhIHdhcyB1bmF2YWlsYWJsZSBvbiB0aGlzIGhvc3QgKGF1dGhlbnRpY2F0aW9uIHJlamVjdGVkIG9yIHF1b3RhIGV4aGF1c3RlZCkg4oCUIGFjY291bnQgc3RhdGUsIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG59O1xuXG4vKipcbiAqIFRoZSBleHRlcm5hbC1vcmNoZXN0cmF0aW9uIHByb3ZpZGVyIGlzIHVuYXZhaWxhYmxlIChJc3N1ZSAjNDUwOCkuXG4gKlxuICogUmVhZCBmcm9tIHRoZSB3b3JrZXIncyBvd24gd29yZHMgb25seTogdGhlIGFnZW50J3MgcXVvdGVkIG91dHB1dCBtdXN0IG5vdFxuICogdHJpZ2dlciBpdC4gR2F0ZWQgb24gYGludGVybmFsX2Vycm9yYCwgdGhlIGNhdGVnb3J5IHRoZSBwcmVmbGlnaHQgcmVmdXNhbFxuICogaXMgcmVjb3JkZWQgdW5kZXIuIEl0IGRlbGliZXJhdGVseSBkb2VzIE5PVCBjb3ZlciB0aGUgb3RoZXIgcHJlZmxpZ2h0XG4gKiByZWZ1c2FscyAoYENMSSBpcyBub3QgcnVubmFibGVgLCBgcmVxdWlyZXMgYSBmaXhlZC1wcmljZSBzdWJzY3JpcHRpb25gLFxuICogYGNoaWxkIGhhcyBtZXRlcmVkIGNyZWRlbnRpYWxzYCksIHdoaWNoIHN0YXkgYHdvcmtlci1jcmFzaGAuXG4gKi9cbmNvbnN0IFBST1ZJREVSX1VOQVZBSUxBQkxFX1JFID1cbiAgL1xcYmV4dGVybmFsIG9yY2hlc3RyYXRpb246IFtcXHctXSsgdW5hdmFpbGFibGUgXFwoLztcblxuLyoqIFRoZSBhZ2VudCBkaWQgbm90IGRlbGl2ZXIg4oCUIGEgcHJvcGVydHkgb2YgdGhlIGF0dGVtcHQsIG5vdCBhIHdvcmtlciBkZWZlY3QuICovXG5jb25zdCBBR0VOVF9PVVRDT01FOiBSdW5GYWlsdXJlQ2xhc3NpZmljYXRpb24gPSB7XG4gIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICBmYWlsdXJlQ2xhc3M6IFwiYWdlbnQtb3V0Y29tZVwiLFxuICByYXRpb25hbGU6XG4gICAgXCJUaGUgYWdlbnQgZGlkIG5vdCBkZWxpdmVyIChxdWFsaXR5IGdhdGUsIFBSLXN1bW1hcnkgZ2F0ZXMsIHNlY3VyaXR5LWZpeCBldmlkZW5jZSwgbm8gY2hhbmdlcywgbWlzc2luZyBldmlkZW5jZSkg4oCUIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG59O1xuXG4vKipcbiAqIFRoZSBhZ2VudCdzIHRvb2wgcnVudGltZSBmYWlsZWQgKElzc3VlICM0MzI0KS5cbiAqXG4gKiBBIGNvZGUtbW9kZSBob3N0IHRoYXQgaXMgdW5hdmFpbGFibGUsIG9yIGEgc2Vzc2lvbiB3aG9zZSBldmVyeSB0b29sIGNhbGxcbiAqIGZhaWxlZCB0byBzcGF3biwgaXMgdGhlIHdvcmtlcidzIGluZnJhc3RydWN0dXJlLiBJdCBpcyBjb2RlLWZpeGFibGUsIHNvIHRoZVxuICogcnVuLWZhaWx1cmUgZmlsZXIgcmFpc2VzIG9uZSBkZWR1cGVkIGlzc3VlLCBhbmQgaXQgaXMgbm90IHRoZSBzb3VyY2VcbiAqIGlzc3VlJ3MgZmF1bHQuXG4gKi9cbmNvbnN0IFRPT0xfUlVOVElNRTogUnVuRmFpbHVyZUNsYXNzaWZpY2F0aW9uID0ge1xuICBmaXhhYmlsaXR5OiBcImNvZGVfZml4YWJsZVwiLFxuICBmYWlsdXJlQ2xhc3M6IFwidG9vbC1ydW50aW1lXCIsXG4gIHJhdGlvbmFsZTpcbiAgICBcIlRoZSBhZ2VudCdzIHRvb2wgcnVudGltZSBmYWlsZWQgKHRvb2xzIG9yIHRoZSBjb2RlLW1vZGUgaG9zdCB3ZXJlIHVuYXZhaWxhYmxlLCBvciBldmVyeSB0b29sIGNhbGwgZmFpbGVkIHRvIHNwYXduKSDigJQgaW5mcmFzdHJ1Y3R1cmUsIG5vdCBhbiBhZ2VudCBvdXRjb21lLlwiLFxufTtcblxuLyoqXG4gKiBBIHJlZnVzZWQgcmVwb3NpdG9yeS1hZG1pbiBzZXR0aW5nIChJc3N1ZSAjNDQ0MikuXG4gKlxuICogVGhlIHJlZnVzYWwgY2FycmllcyBjYXRlZ29yeSBgdW5rbm93bmAgKElzc3VlICM0NDYxKSwgc28gaXQgdGFrZXMgdGhlXG4gKiBmYWlsZWQtb25jZSBsYWRkZXIgd2l0aCBpdHMgZXNjYWxhdGluZyBjb29sZG93biByYXRoZXIgdGhhbiB0aGUgZmxhdFxuICogdHJhbnNpZW50IHJldHJ5IGFuIGBpbnRlcm5hbF9lcnJvcmAgZWFybnMuIFRoZSBgcmVwby1jb25maWdgIGNsYXNzIGlzIHdoYXRcbiAqIGtlZXBzIHRoZSBydW4tZmFpbHVyZSBmaWxlciBmcm9tIGF1dG8tZmlsaW5nIGl0IGFzIGEgYHdvcmtlci1jcmFzaGA6IGl0IGlzIGFcbiAqIHJlcG9zaXRvcnkgb3IgY3JlZGVudGlhbCBjb25kaXRpb24sIG5vdCBhIHdvcmtlciBkZWZlY3QuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVBPX0FETUlOX1JFRlVTRUQ6IFJ1bkZhaWx1cmVDbGFzc2lmaWNhdGlvbiA9IHtcbiAgZml4YWJpbGl0eTogXCJub3RfY29kZV9maXhhYmxlXCIsXG4gIGZhaWx1cmVDbGFzczogXCJyZXBvLWNvbmZpZ1wiLFxuICByYXRpb25hbGU6XG4gICAgXCJUaGUgcmVwb3NpdG9yeSBvciB0aGUgd29ya2VyJ3MgdG9rZW4gcmVmdXNlZCB0aGUgcmVwb3NpdG9yeS1hZG1pbiBzZXR0aW5nIHRoZSBmaW5kaW5nIGFza3MgZm9yIChwZXJtaXNzaW9uLCBwbGFuIG9yIHByb3RlY3Rpb24pIOKAlCBhIGNvbmZpZ3VyYXRpb24gZmF1bHQsIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG59O1xuXG4vKiogQ29kZXggaXRlbSB0eXBlcyB0aGF0IGFyZSB0b29sIGNhbGxzICh0aGUgc2FtZSBzZXQgdGhlIHByb2dyZXNzIHRyYWNrZXIgY291bnRzKS4gKi9cbmNvbnN0IFRPT0xfSVRFTV9UWVBFUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcImNvbW1hbmRfZXhlY3V0aW9uXCIsXG4gIFwiY29tbWFuZFwiLFxuICBcImZ1bmN0aW9uX2NhbGxcIixcbiAgXCJtY3BfdG9vbF9jYWxsXCIsXG4gIFwibWNwX3Rvb2xcIixcbiAgXCJ0b29sXCIsXG4gIFwidG9vbF91c2VcIixcbl0pO1xuXG5mdW5jdGlvbiBhc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgdmFsdWUgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbi8qKiBPbmUgdHJhbnNjcmlwdCBlbnRyeSwgdW53cmFwcGluZyBhIENvZGV4IGBpdGVtYCBvciBgcGF5bG9hZGAgZW52ZWxvcGUuICovXG5mdW5jdGlvbiB1bndyYXBUcmFuc2NyaXB0SXRlbShlbnRyeTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGNvbnN0IHJlY29yZCA9IGFzUmVjb3JkKGVudHJ5KTtcbiAgaWYgKCFyZWNvcmQpIHJldHVybiBudWxsO1xuICByZXR1cm4gYXNSZWNvcmQocmVjb3JkLml0ZW0pID8/IGFzUmVjb3JkKHJlY29yZC5wYXlsb2FkKSA/PyByZWNvcmQ7XG59XG5cbmZ1bmN0aW9uIGl0ZW1UeXBlKGl0ZW06IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gaXRlbS5pdGVtX3R5cGUgPz8gaXRlbS50eXBlO1xuICByZXR1cm4gdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdy50b0xvd2VyQ2FzZSgpIDogXCJcIjtcbn1cblxuLyoqIFRleHQgYSB0cmFuc2NyaXB0IGl0ZW0gY2FycmllcywgZm9sZGVkIGZvciBhIGNhc2UtaW5zZW5zaXRpdmUgY2hlY2suICovXG5mdW5jdGlvbiBpdGVtVGV4dChpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJtZXNzYWdlXCIsIFwidGV4dFwiLCBcImNvbnRlbnRcIiwgXCJlcnJvclwiXSkge1xuICAgIGNvbnN0IHZhbHVlID0gaXRlbVtrZXldO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHBhcnRzLnB1c2godmFsdWUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IG5lc3RlZCA9IGFzUmVjb3JkKHZhbHVlKTtcbiAgICBpZiAobmVzdGVkICYmIHR5cGVvZiBuZXN0ZWQubWVzc2FnZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgcGFydHMucHVzaChuZXN0ZWQubWVzc2FnZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXCIpLnRvTG93ZXJDYXNlKCk7XG59XG5cbi8qKlxuICogQSBwcm92aWRlciBlcnJvciBpdGVtIHNheWluZyB0b29scywgb3IgdGhlIGNvZGUtbW9kZSBob3N0LCBhcmUgdW5hdmFpbGFibGUuXG4gKi9cbmZ1bmN0aW9uIGlzUHJvdmlkZXJUb29sUnVudGltZUVycm9yKGl0ZW06IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogYm9vbGVhbiB7XG4gIGlmIChpdGVtVHlwZShpdGVtKSAhPT0gXCJlcnJvclwiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHRleHQgPSBpdGVtVGV4dChpdGVtKTtcbiAgcmV0dXJuIHRleHQuaW5jbHVkZXMoXCJjb2RlIG1vZGUgaXMgdW5hdmFpbGFibGVcIikgfHxcbiAgICB0ZXh0LmluY2x1ZGVzKFwiaG9zdCBleGVjdXRhYmxlIHdhcyBub3QgZm91bmRcIikgfHxcbiAgICAodGV4dC5pbmNsdWRlcyhcInRvb2xcIikgJiYgdGV4dC5pbmNsdWRlcyhcInVuYXZhaWxhYmxlXCIpKTtcbn1cblxuZnVuY3Rpb24gaXNUb29sSXRlbShpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICByZXR1cm4gVE9PTF9JVEVNX1RZUEVTLmhhcyhpdGVtVHlwZShpdGVtKSk7XG59XG5cbi8qKiBBIHRvb2wgY2FsbCB0aGF0IG5ldmVyIHN0YXJ0ZWQgYmVjYXVzZSB0aGUgcnVudGltZSBjb3VsZCBub3Qgc3Bhd24gaXQuICovXG5mdW5jdGlvbiB0b29sRmFpbGVkVG9TcGF3bihpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICBjb25zdCBzdGF0dXMgPSB0eXBlb2YgaXRlbS5zdGF0dXMgPT09IFwic3RyaW5nXCJcbiAgICA/IGl0ZW0uc3RhdHVzLnRvTG93ZXJDYXNlKClcbiAgICA6IFwiXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkX3RvX3NwYXduXCIgfHwgc3RhdHVzID09PSBcInNwYXduX2ZhaWxlZFwiKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgdGV4dCA9IGl0ZW1UZXh0KGl0ZW0pO1xuICByZXR1cm4gdGV4dC5pbmNsdWRlcyhcImZhaWxlZCB0byBzcGF3blwiKSB8fFxuICAgIHRleHQuaW5jbHVkZXMoXCJmYWlsdXJlIHRvIHNwYXduXCIpIHx8XG4gICAgdGV4dC5pbmNsdWRlcyhcImNvdWxkIG5vdCBzcGF3blwiKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgQ29kZXggdHJhbnNjcmlwdCBzaG93cyB0aGUgdG9vbCBydW50aW1lIGl0c2VsZiBmYWlsaW5nXG4gKiAoSXNzdWUgIzQzMjQpLlxuICpcbiAqIFR3byBzaGFwZXMgY291bnQuIEEgcHJvdmlkZXIgZXJyb3IgaXRlbSDigJQgYENvZGUgTW9kZSBpcyB1bmF2YWlsYWJsZWAsIGFcbiAqIG1pc3NpbmcgY29kZS1tb2RlIGhvc3QsIG9yIHRvb2xzIHJlcG9ydGVkIHVuYXZhaWxhYmxlIOKAlCB3aGVuIG5vIHRvb2wgY2FsbFxuICogKmFmdGVyIHRoYXQgZXJyb3IqIHN1Y2NlZWRlZC4gT3IgYXQgbGVhc3Qgb25lIHRvb2wgY2FsbCwgZXZlcnkgb25lIG9mXG4gKiB3aGljaCBmYWlsZWQgdG8gc3Bhd24uIEEgbGF0ZXIgc2Vzc2lvbiBjb3VudHMgb24gaXRzIG93biAoSXNzdWUgIzQzNjIpOlxuICogdGhlIGltcGxlbWVudGluZyBhZ2VudCBtYXkgaGF2ZSB1c2VkIHRvb2xzLCBhbmQgdGhlIHByZS1QUiB2ZXJpZmllcidzXG4gKiBzZXNzaW9uIGNhbiBzdGlsbCBvcGVuIHdpdGggdGhlIGNvZGUtbW9kZSBob3N0IG1pc3NpbmcuIEEgdG9vbCB0aGF0XG4gKiBzdWNjZWVkcyBhZnRlciB0aGUgZXJyb3IgbWVhbnMgdGhlIHJ1bnRpbWUgcmVjb3ZlcmVkLlxuICovXG4vKipcbiAqIFBhcnNlIGEgQ29kZXggc2Vzc2lvbiBKU09OTCBpbnRvIGl0ZW1zLlxuICpcbiAqIEEgbGluZSB0aGF0IGlzIG5vdCBhIEpTT04gb2JqZWN0IGlzIHNraXBwZWQuIEEgdG9ybiBmaW5hbCBsaW5lIGlzIG5vdCBhXG4gKiB0cmFuc2NyaXB0IGl0ZW0sIGFuZCBpdCBkb2VzIG5vdCBkaXNjYXJkIHRoZSBpdGVtcyBhbHJlYWR5IHJlYWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvZGV4VHJhbnNjcmlwdCh0ZXh0OiBzdHJpbmcpOiB1bmtub3duW10ge1xuICBjb25zdCBpdGVtczogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiB0ZXh0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKFwie1wiKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGl0ZW1zLnB1c2goSlNPTi5wYXJzZSh0cmltbWVkKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGl0ZW1zO1xufVxuXG5mdW5jdGlvbiB0cmFuc2NyaXB0U2hvd3NUb29sUnVudGltZUZhaWx1cmUoXG4gIHRyYW5zY3JpcHQ6IHJlYWRvbmx5IHVua25vd25bXSB8IHVuZGVmaW5lZCxcbik6IGJvb2xlYW4ge1xuICBpZiAoIXRyYW5zY3JpcHQgfHwgdHJhbnNjcmlwdC5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcbiAgY29uc3QgaXRlbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiB0cmFuc2NyaXB0KSB7XG4gICAgY29uc3QgaXRlbSA9IHVud3JhcFRyYW5zY3JpcHRJdGVtKGVudHJ5KTtcbiAgICBpZiAoaXRlbSkgaXRlbXMucHVzaChpdGVtKTtcbiAgfVxuICAvLyBBIHByb3ZpZGVyIGVycm9yIGNvdW50cyB3aGVuIG5vdGhpbmcgYWZ0ZXIgaXQgYWN0dWFsbHkgcmFuLiBUb29scyB0aGF0XG4gIC8vIHN1Y2NlZWRlZCAqYmVmb3JlKiB0aGUgZXJyb3IgYXJlIGFuIGVhcmxpZXIgc2Vzc2lvbiAoSXNzdWUgIzQzNjIpLlxuICBsZXQgc2F3UnVudGltZUVycm9yID0gZmFsc2U7XG4gIGxldCB0b29sU3VjY2VlZGVkQWZ0ZXJFcnJvciA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBpZiAoaXNQcm92aWRlclRvb2xSdW50aW1lRXJyb3IoaXRlbSkpIHNhd1J1bnRpbWVFcnJvciA9IHRydWU7XG4gICAgaWYgKFxuICAgICAgc2F3UnVudGltZUVycm9yICYmIGlzVG9vbEl0ZW0oaXRlbSkgJiYgIXRvb2xGYWlsZWRUb1NwYXduKGl0ZW0pXG4gICAgKSB7XG4gICAgICB0b29sU3VjY2VlZGVkQWZ0ZXJFcnJvciA9IHRydWU7XG4gICAgfVxuICB9XG4gIGlmIChzYXdSdW50aW1lRXJyb3IgJiYgIXRvb2xTdWNjZWVkZWRBZnRlckVycm9yKSByZXR1cm4gdHJ1ZTtcblxuICBjb25zdCB0b29scyA9IGl0ZW1zLmZpbHRlcihpc1Rvb2xJdGVtKTtcbiAgLy8gQSB0b29sIHRoYXQgYWN0dWFsbHkgcmFuLCB3aXRoIG5vIHByb3ZpZGVyIGVycm9yIGFmdGVyIGl0LCBtZWFucyB0aGVcbiAgLy8gcnVudGltZSB3YXMgdXAuIFF1b3RlZCBlcnJvcnMgaW4gYSBsYXRlciBhZ2VudCBtZXNzYWdlIGRvIG5vdCB1bmRvIHRoYXQuXG4gIGlmICh0b29scy5zb21lKCh0b29sKSA9PiAhdG9vbEZhaWxlZFRvU3Bhd24odG9vbCkpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0b29scy5sZW5ndGggPiAwICYmIHRvb2xzLmV2ZXJ5KHRvb2xGYWlsZWRUb1NwYXduKTtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBhIG5vLVBSIHJ1biBmYWlsdXJlLlxuICpcbiAqIE9SREVSIE1BVFRFUlMgYW5kIGlzIGZpeGVkIGhlcmUsIG1vc3Qgc3BlY2lmaWMgZmlyc3Qg4oCUIGV4YWN0bHkgYXNcbiAqIGBkZXRlY3RGYWlsdXJlQ2F0ZWdvcnlgIGRvY3VtZW50cyBpdHMgb3duIG9yZGVyaW5nOlxuICpcbiAqIDAuIEEgdHJhbnNjcmlwdCB0aGF0IHNob3dzIHRoZSB0b29sIHJ1bnRpbWUgZmFpbGluZyAoSXNzdWUgIzQzNjIpIOKAlFxuICogICAgaW5mcmFzdHJ1Y3R1cmUsIGV2ZW4gd2hlbiB0aGUgcmVjb3JkZWQgY2F0ZWdvcnkgaXMgYSB3b3JrZXIgZ2F0ZSBzdWNoXG4gKiAgICBhcyBgY3JpdGVyaWFfdW5tZXRgLiBUaGUgc2lnbmFsIGlzIHRoZSBzZXNzaW9uIGl0ZW1zLCBub3QgcXVvdGVkIHByb3NlLlxuICogMGIuIEV2ZXJ5IHJlZ2lzdGVyZWQgd29ya2VyIGdhdGUgY2F0ZWdvcnkgKGBXT1JLRVJfR0FURV9NQVJLRVJTYDogc3VtbWFyeSxcbiAqICAgIHNlY3VyaXR5LWZpeCBhbmQgcHJlLXB1c2ggZ2F0ZXM7IElzc3VlcyAjMzQzMSwgIzM0NTQsICMzNzE2KSDigJQgYW5zd2VyZWRcbiAqICAgIGJlZm9yZSB0aGUgbWVzc2FnZSBydWxlcywgYmVjYXVzZSB0aGUgZ2F0ZSByZWZ1c2FsIHF1b3RlcyB0aGUgYWdlbnQnc1xuICogICAgc3VtbWFyeSwgdGVzdHMgb3IgdG9vbCBvdXRwdXQgYW5kIGEgcXVvdGVkIFwiRU5PU1BDXCIsIHVzYWdlIGxpbWl0IG9yIHN0YWNrXG4gKiAgICB0cmFjZSBtdXN0IG5vdCB0dXJuIGl0IGludG8gYW5vdGhlciBjbGFzcy5cbiAqIDEuIEFjY291bnQgbGltaXRzIChgcmF0ZV9saW1pdGAgY2F0ZWdvcnksIG91dC1vZi1jcmVkaXQgbWVzc2FnZSkg4oCUIHRoZVxuICogICAgaGlnaGVzdC1jb3N0IGZhbHNlIHBvc2l0aXZlIGlzIGF1dG8tZmlsaW5nIG9uIGEgZmxlZXQtd2lkZSB1c2FnZSBjYXAsXG4gKiAgICBzbyB0aGVzZSB3aW4gb3ZlciBldmVyeXRoaW5nLCBpbmNsdWRpbmcgYSBzdGFjayB0cmFjZSBpbiB0aGUgc2FtZVxuICogICAgbWVzc2FnZS5cbiAqIDFiLiBBbiB1bmF2YWlsYWJsZSBleHRlcm5hbC1vcmNoZXN0cmF0aW9uIHByb3ZpZGVyIChgaW50ZXJuYWxfZXJyb3JgLFxuICogICAgd29ya2VyJ3Mgb3duIHdvcmRzOiBgZXh0ZXJuYWwgb3JjaGVzdHJhdGlvbjogPHByb3ZpZGVyPiB1bmF2YWlsYWJsZSAoYClcbiAqICAgIOKAlCBhY2NvdW50IHN0YXRlIG9uIHRoZSBob3N0LCBub3QgYSB3b3JrZXIgY3Jhc2ggKElzc3VlICM0NTA4KS5cbiAqIDIuIEEgc3F1YXNoLWxpbmVhZ2UgcHVzaCByZWZ1c2FsIChJc3N1ZSAjNTM0KSDigJQgdGhlIGJhc2UgbW92ZWQgb247IG5ldmVyXG4gKiAgICBhIHdvcmtlciBkZWZlY3QsIGFuZCBjaGVja2VkIGJlZm9yZSB0aGUgZGlzayBhbmQgY3Jhc2ggcnVsZXMgc28gYVxuICogICAgYnJhbmNoIG5hbWUgb3IgYSBoaW50IGxpbmUgaW4gdGhlIHJlZnVzYWwgY2Fubm90IGJlIG1pc3Rha2VuIGZvclxuICogICAgZWl0aGVyIChJc3N1ZSAjMTY1OCkuXG4gKiAzLiBEaXNrIGV4aGF1c3Rpb24gYnkgbWVzc2FnZSDigJQgYSBmdWxsIGRpc2sga2lsbHMgb3IgY3Jhc2hlcyB3aGF0ZXZlciByYW5cbiAqICAgIG9uIHRvcCBvZiBpdCwgc28gaXQgb3V0cmFua3MgYGtpbGxlZGAgLyBgaW50ZXJuYWxfZXJyb3JgLlxuICogNC4gYGtpbGxlZGAg4oCUIHdpdGggT09NIGV2aWRlbmNlIOKGkiBgb29tYCAoY29kZS1maXhhYmxlKTsgd2l0aG91dCDihpIgdGhlXG4gKiAgICBjYXVzZSBpcyB1bnByb3Zlbiwgc28gYGtpbGxlZC11bmtub3duYCAodW5rbm93bikuIEFuIE9PTSBtZXNzYWdlIHRoYXRcbiAqICAgIGFsc28gbWVudGlvbnMgYSB0aW1lb3V0IGNsYXNzaWZpZXMgYXMgYG9vbWAgYmVjYXVzZSB0aGUgY2F0ZWdvcnkgd2FzXG4gKiAgICBhbHJlYWR5IGBraWxsZWRgLCBub3QgYHRpbWVvdXRgLlxuICogNS4gV29ya2VyIGNyYXNoZXM6IGBpbnRlcm5hbF9lcnJvcmAsIG9yIGFuIHVuaGFuZGxlZCBleGNlcHRpb24gLyBzdGFja1xuICogICAgdHJhY2UgaW4gdGhlIG1lc3NhZ2Ugd2l0aCBhbnkgb3RoZXIgbm9uLWFnZW50IGNhdGVnb3J5LlxuICogNi4gYG1pc3NpbmdfdG9vbHNgIOKAlCB0aGUgaW1hZ2UvUEFUSCBpcyB0aGUgd29ya2VyJ3MgdG8gZml4LlxuICogNy4gYHRpbWVvdXRgIC8gYHplcm9fb3V0cHV0YCDigJQgY2F1c2UgdW5wcm92ZW4g4oaSIHVua25vd24uXG4gKiA4LiBgcXVhbGl0eV9jaGVja2AgLyBgbm9fY2hhbmdlc2AgL1xuICogICAgYGV2aWRlbmNlX21pc3NpbmdgIOKAlCB0aGUgQUdFTlQgbm90XG4gKiAgICBkZWxpdmVyaW5nLCBub3QgYSB3b3JrZXIgZGVmZWN0OiBgbm90X2NvZGVfZml4YWJsZWAsIG5ldmVyIGF1dG8tZmlsZWQuXG4gKiAgICBFeGNlcHRpb24gKElzc3VlICM0MzI0KTogYSB0cmFuc2NyaXB0IHRoYXQgc2hvd3MgdGhlIHRvb2wgcnVudGltZVxuICogICAgZmFpbGluZyBpcyBpbmZyYXN0cnVjdHVyZSAoYHRvb2wtcnVudGltZWAsIGNvZGUtZml4YWJsZSkuIEFuIG9yZGluYXJ5XG4gKiAgICBuby1jaGFuZ2UgcnVuLCB3aG9zZSB0b29scyB3b3JrZWQsIHN0YXlzIGFuIGFnZW50IG91dGNvbWUuXG4gKiA5LiBgd29ya2Zsb3dfZ2F0ZWAg4oCUIGEgcHJlLVBSIGdhdGUgdGhlIHdvcmtlciBhcHBsaWVkIHJlZnVzZWQgdGhlIGNoYW5nZVxuICogICAgKElzc3VlICMyMDQ0KTogbm90IGEgd29ya2VyIGRlZmVjdCBlaXRoZXIsIGFuZCBpdCBrZWVwcyBpdHMgb3duIGNsYXNzIHNvXG4gKiAgICBhbiBhcmNoaXZlIGNhbiB0ZWxsIGEgZ2F0ZSBibG9jayBmcm9tIGFuIHVuZXhwbGFpbmVkIGZhaWx1cmUuXG4gKiAxMC4gQW55dGhpbmcgZWxzZSDihpIgdW5rbm93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5UnVuRmFpbHVyZShcbiAgY2F0ZWdvcnk6IEZhaWx1cmVDYXRlZ29yeSxcbiAgZmFpbHVyZU1lc3NhZ2U6IHN0cmluZyxcbiAgZGVjbGFyZWRDYXRlZ29yeTogYm9vbGVhbixcbiAgdHJhbnNjcmlwdD86IHJlYWRvbmx5IHVua25vd25bXSxcbik6IFJ1bkZhaWx1cmVDbGFzc2lmaWNhdGlvbiB7XG4gIC8vIEEgZGVjbGFyZWQgc291cmNlIGNhdXNlIGNhbm5vdCBiZSByZXBsYWNlZCBieSBxdW90ZWQgZ2l0LCB0ZXN0IG9yIGFnZW50XG4gIC8vIHByb3NlLiBLaWxscywgYWNjb3VudCBsaW1pdHMgYW5kIGludGVybmFsLXRvb2wgZXJyb3JzIHJldGFpbiB0aGVpciBzb3VyY2Utc3BlY2lmaWNcbiAgLy8gZGlhZ25vc3RpYyByZWZpbmVtZW50cy4gVGltZW91dCBkaXNrIGV2aWRlbmNlIGhhcyBpdHMgbmFycm93IGV4Y2VwdGlvbiBiZWxvdztcbiAgLy8gb3RoZXIgZGVjbGFyZWQgY2F0ZWdvcmllcyBkbyBub3QgcmVhZCBhIG1lc3NhZ2UuXG4gIGNvbnN0IG1lc3NhZ2UgPSBkZWNsYXJlZENhdGVnb3J5XG4gICAgPyBjYXRlZ29yeSA9PT0gXCJraWxsZWRcIiB8fCBjYXRlZ29yeSA9PT0gXCJyYXRlX2xpbWl0XCIgfHxcbiAgICAgICAgY2F0ZWdvcnkgPT09IFwiaW50ZXJuYWxfZXJyb3JcIlxuICAgICAgPyBzcGxpdEFnZW50TmFycmF0aW9uKGZhaWx1cmVNZXNzYWdlID8/IFwiXCIpLndvcmtlclxuICAgICAgOiBcIlwiXG4gICAgOiBmYWlsdXJlTWVzc2FnZSA/PyBcIlwiO1xuXG4gIC8vIEEgYnJva2VuIHRvb2wgcnVudGltZSBpcyBpbmZyYXN0cnVjdHVyZSB3aGF0ZXZlciBjYXRlZ29yeSB0aGUgcnVuIHdhc1xuICAvLyByZWNvcmRlZCB1bmRlciAoSXNzdWUgIzQzNjIpLiBUaGUgc2lnbmFsIGlzIHRoZSBzZXNzaW9uIGl0ZW1zLCBub3QgdGhlXG4gIC8vIGdhdGUncyBxdW90ZWQgcmVhc29uLCBzbyBhIGNyaXRlcmlhLXVubWV0IHJlY29yZCB3aG9zZSB2ZXJpZmllciBvciBhZ2VudFxuICAvLyBoYWQgbm8gd29ya2luZyB0b29scyBpcyBub3QgYW4gYWdlbnQgb3V0Y29tZS5cbiAgaWYgKHRyYW5zY3JpcHRTaG93c1Rvb2xSdW50aW1lRmFpbHVyZSh0cmFuc2NyaXB0KSkgcmV0dXJuIFRPT0xfUlVOVElNRTtcblxuICAvLyBBIHdvcmtlciBnYXRlIHJlZnVzYWwgKHN1bW1hcnksIHNlY3VyaXR5LWZpeCBvciBwcmUtcHVzaCBnYXRlKSBxdW90ZXMgdGV4dFxuICAvLyAgICB0aGUgd29ya2VyIGRpZCBub3Qgd3JpdGUsIHNvIGFueSBtZXNzYWdlLXBhdHRlcm4gcnVsZSBiZWxvdyAoc2Vjb25kYXJ5XG4gIC8vICAgIGxpbWl0LCBvdXQtb2YtY3JlZGl0LCBzdGFsZSBsaW5lYWdlLCBkaXNrLWZ1bGwpIGNhbiB0cmlwIG9uIHRoYXRcbiAgLy8gICAgcXVvdGF0aW9uLiBUaGUgY2F0ZWdvcnkgaXMgYSBnYXRlIGNhdGVnb3J5IG9ubHkgZm9yIGEgd29ya2VyLWF1dGhvcmVkXG4gIC8vICAgIG1hcmtlciBwcmVmaXggKG9yLCBmb3IgYHN1bW1hcnlfaW5jb21wbGV0ZWAsIGFuIGV4aXN0aW5nLVBSIGZpbmFsaXNlKSxcbiAgLy8gICAgc28gaXQgYW5zd2VycyBmaXJzdCAoSXNzdWVzICMzNDMxLCAjMzQ1NDsgUFIgIzM3MTYpLlxuICBpZiAoaXNXb3JrZXJHYXRlQ2F0ZWdvcnkoY2F0ZWdvcnkpKSByZXR1cm4gQUdFTlRfT1VUQ09NRTtcblxuICAvLyAxLiBBY2NvdW50IGxpbWl0czogdXNhZ2UgLyByYXRlIGxpbWl0IGFuZCBvdXQtb2YtY3JlZGl0IGFyZSBuZXZlciBhXG4gIC8vICAgIHdvcmtlciBmYXVsdC4gQ2hlY2tlZCBiZWZvcmUgYW55dGhpbmcgZWxzZSBzbyBhIHN0YWNrIHRyYWNlIG9yIGFcbiAgLy8gICAgXCJ0aW1lZCBvdXRcIiBjbGF1c2UgaW4gdGhlIHNhbWUgbWVzc2FnZSBjYW5ub3Qgb3V0cmFuayB0aGVtLlxuICAvL1xuICAvLyAgICBHaXRIdWIncyAqc2Vjb25kYXJ5KiAoY29udGVudC1jcmVhdGlvbikgbGltaXQgaXMgc2VwYXJhdGVkIG91dCBmaXJzdFxuICAvLyAgICAoSXNzdWUgIzE5NTEpOiBpdCBpcyBhIHNlbGYtY2xlYXJpbmcgdGhyb3R0bGUgb24gb25lIGhvc3QncyBidXJzdCBvZlxuICAvLyAgICB3cml0ZXMsIG5vdCBhbiBhY2NvdW50IG9yIHN1YnNjcmlwdGlvbiBjYXAsIGFuZCBjb3VudGluZyB0aGUgdHdvXG4gIC8vICAgIHRvZ2V0aGVyIG1hZGUgYW4gZXhoYXVzdGVkIG1vZGVsIHN1YnNjcmlwdGlvbiBpbmRpc3Rpbmd1aXNoYWJsZSBpblxuICAvLyAgICB0aGUgcmVjb3JkIGZyb20gYSB0aHJvdHRsZSB0aGF0IGNsZWFyZWQgaXRzZWxmIGluIG1pbnV0ZXMuXG4gIC8vXG4gIC8vICAgIFJlYWQgZnJvbSB0aGUgd29ya2VyJ3Mgb3duIHdvcmRzIG9ubHkgKElzc3VlICMyNDkpOiB0aGUgYWdlbnQnc1xuICAvLyAgICBxdW90ZWQgc3Rkb3V0IHJlYWNoZXMgdGhpcyBtZXNzYWdlIHRvbywgYW5kIGFuIGFnZW50ICp3cml0aW5nIGFib3V0KlxuICAvLyAgICB0aGlzIHZlcnkgdGhyb3R0bGUgbXVzdCBub3QgbWFrZSBpdHMgcnVuIGEgR2l0SHViIHRocm90dGxlLlxuICBpZiAoaXNTZWNvbmRhcnlSYXRlTGltaXRNZXNzYWdlKHNwbGl0QWdlbnROYXJyYXRpb24obWVzc2FnZSkud29ya2VyKSkge1xuICAgIHJldHVybiB7XG4gICAgICBmaXhhYmlsaXR5OiBcIm5vdF9jb2RlX2ZpeGFibGVcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJnaXRodWItYWJ1c2UtbGltaXRcIixcbiAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgXCJHaXRIdWIncyBzZWNvbmRhcnkgKGNvbnRlbnQtY3JlYXRpb24pIHJhdGUgbGltaXQgcmVmdXNlZCBhIHdyaXRlIOKAlCBcIiArXG4gICAgICAgIFwiYSBzZWxmLWNsZWFyaW5nIHRocm90dGxlLCBub3QgYW4gYWNjb3VudCB1c2FnZSBsaW1pdC5cIixcbiAgICB9O1xuICB9XG4gIGlmIChjYXRlZ29yeSA9PT0gXCJyYXRlX2xpbWl0XCIpIHtcbiAgICAvLyBBbiBvdXQtb2YtY3JlZGl0IHJlZnVzYWwgaXMgY2F0ZWdvcmlzZWQgcmF0ZV9saW1pdCAoSXNzdWUgIzI1OTApIGJ1dFxuICAgIC8vIGtlZXBzIGl0cyBvd24sIG1vcmUgcHJlY2lzZSBmYWlsdXJlIGNsYXNzLlxuICAgIGlmIChpc091dE9mQ3JlZGl0TWVzc2FnZShtZXNzYWdlKSkgcmV0dXJuIE9VVF9PRl9DUkVESVQ7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcInVzYWdlLWxpbWl0XCIsXG4gICAgICByYXRpb25hbGU6XG4gICAgICAgIFwiVGhlIHJ1biBoaXQgYSB1c2FnZSBvciByYXRlIGxpbWl0IChhY2NvdW50L3F1b3RhIHN0YXRlLCBub3QgYSB3b3JrZXIgZGVmZWN0KS5cIixcbiAgICB9O1xuICB9XG4gIC8vIEEgcnVuIGN1dCBvZmYgYmVmb3JlIGZpbmlzaGluZyBpcyB0cmFuc2llbnQgaW5mcmFzdHJ1Y3R1cmUsIG5ldmVyIGEgd29ya2VyXG4gIC8vIGRlZmVjdCBhbmQgbmV2ZXIgYXV0by1maWxlZCDigJQgdGhlIGxvb3Agc2ltcGx5IHJldHJpZXMgaXQgKElzc3VlICMxMDgpLlxuICBpZiAoY2F0ZWdvcnkgPT09IFwiaW50ZXJydXB0ZWRcIikge1xuICAgIHJldHVybiB7XG4gICAgICBmaXhhYmlsaXR5OiBcIm5vdF9jb2RlX2ZpeGFibGVcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJpbnRlcnJ1cHRlZFwiLFxuICAgICAgcmF0aW9uYWxlOlxuICAgICAgICBcIlRoZSBydW4gd2FzIGN1dCBvZmYgYmVmb3JlIGZpbmlzaGluZyAoc3RpbGwgd29ya2luZywgbm90IGNvbmNsdWRpbmcpIOKAlCB0cmFuc2llbnQsIHJldHJpZWQgcmF0aGVyIHRoYW4gZmlsZWQuXCIsXG4gICAgfTtcbiAgfVxuICAvLyBBIHNjaGVkdWxlZCByZWxlYXNlIGlzIHRoZSBmbGVldCB3b3JraW5nIGFzIGRlc2lnbmVkIChJc3N1ZSAjNDI0KTogdGhlXG4gIC8vIGN5Y2xlIGVuZGVkIG9yIHRoZSBzdXBlcnZpc29yJ3MgaGFyZCBjYXAgd2FzIHJlYWNoZWQsIHRoZSBXSVAgaXMgb24gdGhlXG4gIC8vIGJyYW5jaCBhbmQgdGhlIG5leHQgY2xhaW0gcmVzdW1lcyBpdC4gTmV2ZXIgYSB3b3JrZXIgZGVmZWN0LCBzbyBuZXZlclxuICAvLyBhdXRvLWZpbGVkIOKAlCBhbmQgY2hlY2tlZCBiZWZvcmUgdGhlIG1lc3NhZ2UtcGF0dGVybiBydWxlcywgd2hvc2VcbiAgLy8gXCJ0aW1lZCBvdXRcIiBhbmQgc3RhY2stdHJhY2Ugc2lnbmFscyBhcHBlYXIgaW4gdGhlIGFnZW50IG91dHB1dCBzdWNoIGFcbiAgLy8gcmVsZWFzZSBxdW90ZXMuXG4gIGlmIChjYXRlZ29yeSA9PT0gXCJzY2hlZHVsZWRfcmVsZWFzZVwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcInNjaGVkdWxlZC1yZWxlYXNlXCIsXG4gICAgICByYXRpb25hbGU6XG4gICAgICAgIFwiVGhlIHJ1biB3YXMgcmVsZWFzZWQgb24gc2NoZWR1bGUgKGN5Y2xlIGVuZGVkLCBmaW5pc2ggZGVhZGxpbmUgcmVhY2hlZCwgb3IgcnVuIGhhcmQgY2FwIHJlYWNoZWQpIHdpdGggaXRzIHdvcmsgcHJlc2VydmVkIOKAlCBub3QgYSB3b3JrZXIgZGVmZWN0LlwiLFxuICAgIH07XG4gIH1cbiAgaWYgKGlzT3V0T2ZDcmVkaXRNZXNzYWdlKG1lc3NhZ2UpKSByZXR1cm4gT1VUX09GX0NSRURJVDtcbiAgLy8gQW4gdW5hdmFpbGFibGUgZXh0ZXJuYWwtb3JjaGVzdHJhdGlvbiBwcm92aWRlciBpcyBhY2NvdW50IHN0YXRlIChJc3N1ZSAjNDUwOCkuXG4gIGlmIChcbiAgICBjYXRlZ29yeSA9PT0gXCJpbnRlcm5hbF9lcnJvclwiICYmXG4gICAgUFJPVklERVJfVU5BVkFJTEFCTEVfUkUudGVzdChcbiAgICAgIHNwbGl0QWdlbnROYXJyYXRpb24oZmFpbHVyZU1lc3NhZ2UgPz8gXCJcIikud29ya2VyLFxuICAgIClcbiAgKSByZXR1cm4gUFJPVklERVJfVU5BVkFJTEFCTEU7XG5cbiAgLy8gMi4gQSBzcXVhc2gtbGluZWFnZSByZWZ1c2FsIGlzIHRoZSBiYXNlIGhhdmluZyBtb3ZlZCBvbiAoSXNzdWUgIzUzNCksXG4gIC8vICAgIHN0YXRlZCBpbiB0aGUgd29ya2VyJ3Mgb3duIHdvcmRzIOKAlCBhbmQgaXRzIHRleHQgcXVvdGVzIGEgYnJhbmNoIG5hbWVcbiAgLy8gICAgYW5kIGdpdCdzIGNvbmZsaWN0IGhpbnRzLCB3aGljaCBpcyBleGFjdGx5IHdoYXQgZm9vbGVkIHRoZSBkaXNrIGFuZFxuICAvLyAgICBjcmFzaCBydWxlcyBiZWZvcmUgKElzc3VlICMxNjU4KS4gTmFtZWQgZmlyc3Qgc28gbmVpdGhlciBjYW4uXG4gIGlmIChTVEFMRV9MSU5FQUdFX1JFLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgZml4YWJpbGl0eTogXCJub3RfY29kZV9maXhhYmxlXCIsXG4gICAgICBmYWlsdXJlQ2xhc3M6IFwic3RhbGUtbGluZWFnZVwiLFxuICAgICAgcmF0aW9uYWxlOlxuICAgICAgICBcIlRoZSBjb21wbGV0aW9uIHBoYXNlIHJlZnVzZWQgdG8gcHVzaCBhIGJyYW5jaCB3aG9zZSB3b3JrIGEgbWVyZ2VkIFBSIGFscmVhZHkgc3F1YXNoZWQgaW50byB0aGUgYmFzZSAoSXNzdWUgIzUzNCkg4oCUIHRoZSBiYXNlIG1vdmVkIG9uLCBub3QgYSB3b3JrZXIgZGVmZWN0LlwiLFxuICAgIH07XG4gIH1cblxuICAvLyBUaGUgd29ya2VyIGRlbGliZXJhdGVseSByZWxlYXNlcyBhbiBpbi1mbGlnaHQgYnVpbGQgd2hlbiBpdHMgb3duIGRpc2tcbiAgLy8gbW9uaXRvciBjcm9zc2VzIHRoZSBmbG9vciAoSXNzdWUgIzQzNjApLiBLZWVwIHRoZSBzdGFibGUgZGlzay1mdWxsIGNsYXNzXG4gIC8vIGZvciBkaWFnbm9zaXMsIGJ1dCBkbyBub3QgZmlsZSBpdCBhcyBhIHdvcmtlciBkZWZlY3Q6IHRoZSByZWxlYXNlIGlzIHRoZVxuICAvLyBkaXNrIGd1YXJkIHdvcmtpbmcgYXMgZGVzaWduZWQuIFJlYWQgcHJvdGVjdGl2ZS1zdG9wIHdvcmRpbmcgb25seSBmcm9tXG4gIC8vIHdvcmtlciBwcm9zZTsgdGhlIHNhbWUgc2VudGVuY2UgaW4gcXVvdGVkIGFnZW50IG91dHB1dCBpcyBub3QgYSBwYXJraW5nXG4gIC8vIGRlY2lzaW9uLiBUaGUgc2hhcmVkIG1hdGNoZXIgYWxzbyByZWNvZ25pc2VzIHRoZSBmbG9vci1vbmx5IHdvcmRpbmdcbiAgLy8gZW1pdHRlZCB3aGVuIGEgY2FsbGVyIHF1b3RlcyB0aGUgaG9zdCBjaGVjayB3aXRob3V0IGl0cyBwYXJrIG5vdGUuXG4gIGlmIChcbiAgICBjYXRlZ29yeSA9PT0gXCJpbnRlcm5hbF9lcnJvclwiICYmXG4gICAgaXNIb3N0RGlza1Byb3RlY3RpdmVTdG9wVGV4dChcbiAgICAgIHNwbGl0QWdlbnROYXJyYXRpb24oZmFpbHVyZU1lc3NhZ2UgPz8gXCJcIikud29ya2VyLFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcImRpc2stZnVsbFwiLFxuICAgICAgcmF0aW9uYWxlOlxuICAgICAgICBcIlRoZSB3b3JrZXIgaW50ZW50aW9uYWxseSBwYXJrZWQgd29yayBhZnRlciBpdHMgaG9zdC1kaXNrIGZsb29yIHdhcyBjcm9zc2VkOyB0aGUgcHJvdGVjdGl2ZSByZWxlYXNlIGlzIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIDMuIERpc2sgZXhoYXVzdGlvbiBieSBtZXNzYWdlIOKAlCBvdXRyYW5rcyBraWxsZWQvY3Jhc2ggYmVjYXVzZSBhIGZ1bGxcbiAgLy8gICAgZGlzayBpcyB3aGF0IGtpbGxlZCBvciBjcmFzaGVkIHRoZSBydW4uXG4gIC8vIEV4aXN0aW5nIHRpbWVvdXQgZGlhZ25vc3RpY3MgaW50ZW50aW9uYWxseSByZXRhaW4gZXJyb3Itc2hhcGVkIGRpc2sgZXZpZGVuY2VcbiAgLy8gZnJvbSBDTEkgb3V0cHV0LiBUaGF0IG5hcnJvdyByZWZpbmVtZW50IGRvZXMgbm90IGdyYW50IHF1b3RlZCBhY2NvdW50LFxuICAvLyBjcmFzaCBvciBsaW5lYWdlIHByb3NlIGF1dGhvcml0eSBvdmVyIGEgZGVjbGFyZWQgZXhlY3V0aW9uIHRpbWVvdXQuXG4gIGlmIChcbiAgICBpc0Rpc2tGdWxsKFxuICAgICAgZGVjbGFyZWRDYXRlZ29yeSAmJiBjYXRlZ29yeSA9PT0gXCJ0aW1lb3V0XCIgPyBmYWlsdXJlTWVzc2FnZSA6IG1lc3NhZ2UsXG4gICAgKVxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgZml4YWJpbGl0eTogXCJjb2RlX2ZpeGFibGVcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJkaXNrLWZ1bGxcIixcbiAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgXCJUaGUgbWVzc2FnZSByZXBvcnRzIGRpc2sgZXhoYXVzdGlvbiAoRU5PU1BDLCBubyBzcGFjZSBsZWZ0IG9uIGRldmljZSwgb3IgYSByZWFkLW9ubHkgZmlsZXN5c3RlbSBhZnRlciB0aGUgZGlzayBmaWxsZWQpLlwiLFxuICAgIH07XG4gIH1cblxuICBzd2l0Y2ggKGNhdGVnb3J5KSB7XG4gICAgY2FzZSBcImtpbGxlZFwiOlxuICAgICAgLy8gNC4gU0lHS0lMTDogbWVtb3J5IGV2aWRlbmNlIG1ha2VzIGl0IGFuIE9PTSB0aGUgd29ya2VyIGNhbiBzaXplIG9yXG4gICAgICAvLyAgICB0aHJvdHRsZSBmb3I7IHdpdGhvdXQgZXZpZGVuY2UgdGhlIGNhdXNlIGlzIHVucHJvdmVuLiBUaGUgcHJvYmVcbiAgICAgIC8vICAgIHJlYWRpbmcgdGFrZW4gYXQgdGhlIGtpbGwgKElzc3VlICM0Mzc0KSBpcyB0aGUgc3Ryb25nZXN0IGV2aWRlbmNlXG4gICAgICAvLyAgICBhbmQgaXMgbmFtZWQgYXMgc3VjaCDigJQgZXhpdCAxMzcgYWxvbmUgaXMgYW4gaW5mZXJlbmNlLlxuICAgICAgaWYgKEhJR0hfUFJFU1NVUkVfQVRfS0lMTF9SRS50ZXN0KG1lc3NhZ2UpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZml4YWJpbGl0eTogXCJjb2RlX2ZpeGFibGVcIixcbiAgICAgICAgICBmYWlsdXJlQ2xhc3M6IFwib29tXCIsXG4gICAgICAgICAgcmF0aW9uYWxlOlxuICAgICAgICAgICAgXCJUaGUgcnVuIHdhcyBraWxsZWQgKFNJR0tJTEwpIHdoaWxlIHRoZSBtZW1vcnktcHJlc3N1cmUgcHJvYmUgcmVhZCBoaWdoIGF0IHRoZSBraWxsLlwiLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKE9PTV9FVklERU5DRV9SRS50ZXN0KHNwbGl0QWdlbnROYXJyYXRpb24obWVzc2FnZSkud29ya2VyKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGZpeGFiaWxpdHk6IFwiY29kZV9maXhhYmxlXCIsXG4gICAgICAgICAgZmFpbHVyZUNsYXNzOiBcIm9vbVwiLFxuICAgICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICAgIFwiVGhlIHJ1biB3YXMga2lsbGVkIChTSUdLSUxMKSB3aXRoIG91dC1vZi1tZW1vcnkgZXZpZGVuY2UgaW4gdGhlIG1lc3NhZ2UuXCIsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBmaXhhYmlsaXR5OiBcInVua25vd25cIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcImtpbGxlZC11bmtub3duXCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIlRoZSBydW4gd2FzIGtpbGxlZCAoU0lHS0lMTCkgd2l0aCBubyBtZW1vcnkgZXZpZGVuY2Ug4oCUIGNhdXNlIHVucHJvdmVuLlwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwiaW50ZXJuYWxfZXJyb3JcIjpcbiAgICAgIC8vIDUuIEEgd29ya2VyLXNpZGUgZXJyb3Igb3IgY3Jhc2guXG4gICAgICByZXR1cm4ge1xuICAgICAgICBmaXhhYmlsaXR5OiBcImNvZGVfZml4YWJsZVwiLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IFwid29ya2VyLWNyYXNoXCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIlRoZSBmYWlsdXJlIGlzIGFuIGludGVybmFsIHRvb2xpbmcgLyBDTEkgZXJyb3Igb3IgdW5oYW5kbGVkIGV4Y2VwdGlvbiBpbiB0aGUgd29ya2VyLlwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwibWlzc2luZ190b29sc1wiOlxuICAgICAgLy8gNi4gVGhlIGltYWdlIG9yIFBBVEggaXMgdGhlIHdvcmtlcidzIHRvIGZpeC5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGZpeGFiaWxpdHk6IFwiY29kZV9maXhhYmxlXCIsXG4gICAgICAgIGZhaWx1cmVDbGFzczogXCJtaXNzaW5nLXRvb2xzXCIsXG4gICAgICAgIHJhdGlvbmFsZTogXCJBIHJlcXVpcmVkIHRvb2wgaXMgbWlzc2luZyBmcm9tIHRoZSB3b3JrZXIgZW52aXJvbm1lbnQuXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJ0aW1lb3V0XCI6XG4gICAgICAvLyA3LiBDYXVzZSB1bnByb3ZlbjogYW4gYWdlbnQgdGhhdCByYW4gbG9uZyBpcyBub3QsIGJ5IGl0c2VsZiwgYVxuICAgICAgLy8gICAgd29ya2VyIGRlZmVjdC5cbiAgICAgIHJldHVybiBjcmFzaE9yKHtcbiAgICAgICAgZml4YWJpbGl0eTogXCJ1bmtub3duXCIsXG4gICAgICAgIGZhaWx1cmVDbGFzczogXCJ0aW1lb3V0XCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIlRoZSBydW4gdGltZWQgb3V0OyB0aGUgY2F1c2UgaXMgbm90IHByb3ZlbiB0byBiZSB0aGUgd29ya2VyLlwiLFxuICAgICAgfSwgbWVzc2FnZSk7XG4gICAgY2FzZSBcInplcm9fb3V0cHV0XCI6XG4gICAgICByZXR1cm4gY3Jhc2hPcih7XG4gICAgICAgIGZpeGFiaWxpdHk6IFwidW5rbm93blwiLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibm8tb3V0cHV0XCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIlRoZSBydW4gcHJvZHVjZWQgbm8gb3V0cHV0OyB0aGUgY2F1c2UgaXMgbm90IHByb3ZlbiB0byBiZSB0aGUgd29ya2VyLlwiLFxuICAgICAgfSwgbWVzc2FnZSk7XG4gICAgY2FzZSBcInF1YWxpdHlfY2hlY2tcIjpcbiAgICBjYXNlIFwibm9fY2hhbmdlc1wiOlxuICAgIGNhc2UgXCJldmlkZW5jZV9taXNzaW5nXCI6XG4gICAgICAvLyA4LiBUaGUgYWdlbnQgZGlkIG5vdCBkZWxpdmVyIOKAlCBhIHByb3BlcnR5IG9mIHRoZSBhdHRlbXB0LCBub3QgYVxuICAgICAgLy8gICAgd29ya2VyIGRlZmVjdC4gU3RhdGVkIHBsYWlubHksIG5ldmVyIGF1dG8tZmlsZWQ6IGZpbGluZyBhbiBpc3N1ZVxuICAgICAgLy8gICAgZXZlcnkgdGltZSB0aGUgbW9kZWwgZmFpbHMgYSBxdWFsaXR5IGdhdGUgd291bGQgYmUgcHVyZSBub2lzZS5cbiAgICAgIC8vICAgIEEgYnJva2VuIHRvb2wgcnVudGltZSBpcyBub3QgdGhhdCBhdHRlbXB0IChJc3N1ZSAjNDMyNCk6IHRoZVxuICAgICAgLy8gICAgdHJhbnNjcmlwdCBzYXlzIHRoZSB0b29scyBuZXZlciBjYW1lIHVwLCBzbyB0aGUgd29ya2VyIGZpbGVzIGl0XG4gICAgICAvLyAgICBhbmQgdGhlIGlzc3VlIGlzIG5vdCBibGFtZWQuXG4gICAgICBpZiAodHJhbnNjcmlwdFNob3dzVG9vbFJ1bnRpbWVGYWlsdXJlKHRyYW5zY3JpcHQpKSByZXR1cm4gVE9PTF9SVU5USU1FO1xuICAgICAgcmV0dXJuIEFHRU5UX09VVENPTUU7XG4gICAgY2FzZSBcIndvcmtmbG93X2dhdGVcIjpcbiAgICAgIC8vIElzc3VlICMyMDQ0OiB0aGUgY2hhbmdlZC13b3JrZmxvdyBnYXRlIHJlZnVzZWQgdGhlIHJ1biBvdmVyIGEgZmluZGluZ1xuICAgICAgLy8gaW4gYSB3b3JrZmxvdyBmaWxlIHRoZSBjaGFuZ2UgaW50cm9kdWNlZC4gQSBwcm9wZXJ0eSBvZiB0aGUgY2hhbmdlLFxuICAgICAgLy8gbmV2ZXIgYSB3b3JrZXIgZGVmZWN0IOKAlCBzbyBpdCBpcyBzdGF0ZWQgcGxhaW5seSBhbmQgbmV2ZXIgYXV0by1maWxlZCxcbiAgICAgIC8vIGFuZCBpdCBrZWVwcyBpdHMgb3duIGNsYXNzIHNvIGFuIGFyY2hpdmUgY2FuIHRlbGwgYSBnYXRlIGJsb2NrIGZyb21cbiAgICAgIC8vIGFuIHVuZXhwbGFpbmVkIGZhaWx1cmUuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBmaXhhYmlsaXR5OiBcIm5vdF9jb2RlX2ZpeGFibGVcIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcIndvcmtmbG93LWdhdGVcIixcbiAgICAgICAgcmF0aW9uYWxlOlxuICAgICAgICAgIFwiQSBwcmUtUFIgZ2F0ZSByZWZ1c2VkIHRoZSBydW4gb3ZlciBhIEdpdEh1YiBBY3Rpb25zIGZpbmRpbmcgaW4gYSB3b3JrZmxvdyBmaWxlIHRoZSBjaGFuZ2UgaW50cm9kdWNlZCDigJQgbm90IGEgd29ya2VyIGRlZmVjdC5cIixcbiAgICAgIH07XG4gICAgY2FzZSBcInRva2VuX3Njb3BlXCI6XG4gICAgICAvLyBJc3N1ZSAjMTQ3NTogdGhlIGhvc3QncyBjcmVkZW50aWFsIGxhY2tzIHRoZSBgd29ya2Zsb3dgIHNjb3BlLiBBblxuICAgICAgLy8gb3BlcmF0b3IgZ3JhbnRzIGl0OyBubyBjb2RlIGNoYW5nZXMuIE5ldmVyIGF1dG8tZmlsZWQgYXMgYSB3b3JrZXJcbiAgICAgIC8vIGRlZmVjdCDigJQgdGhlIHJ1biBpdHNlbGYgYWxyZWFkeSBzYXlzIGV4YWN0bHkgd2hhdCB0byBkby5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGZpeGFiaWxpdHk6IFwibm90X2NvZGVfZml4YWJsZVwiLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IFwidG9rZW4tc2NvcGVcIixcbiAgICAgICAgcmF0aW9uYWxlOlxuICAgICAgICAgIFwiVGhlIHdvcmtlcidzIHRva2VuIGxhY2tzIHRoZSB3b3JrZmxvdyBzY29wZSB0aGUgY2hhbmdlIG5lZWRzIOKAlCBhIGhvc3QgY3JlZGVudGlhbCBnYXAsIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJyZXBvX2NvbmZpZ1wiOlxuICAgICAgLy8gSXNzdWUgIzIyMjA6IHRoZSByZXBvc2l0b3J5IHJlZnVzZWQgdGhlIG1pbGVzdG9uZSBicmFuY2ggKGEgcnVsZXNldCxcbiAgICAgIC8vIGEgcHJvdGVjdGlvbiwgb3IgYSBtaXNzaW5nIHBlcm1pc3Npb24pLiBBbiBvcGVyYXRvciBjbGVhcnMgaXQgaW4gdGhlXG4gICAgICAvLyByZXBvc2l0b3J5J3Mgc2V0dGluZ3M7IG5vIHdvcmtlciBjb2RlIGNoYW5nZSB3b3VsZCBoZWxwLCBzbyBpdCBpc1xuICAgICAgLy8gbmV2ZXIgYXV0by1maWxlZCBhcyBhIHdvcmtlciBkZWZlY3QuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBmaXhhYmlsaXR5OiBcIm5vdF9jb2RlX2ZpeGFibGVcIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcInJlcG8tY29uZmlnXCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIlRoZSByZXBvc2l0b3J5IHJlZnVzZWQgdGhlIG1pbGVzdG9uZSBicmFuY2ggKHJ1bGVzZXQsIHByb3RlY3Rpb24gb3IgcGVybWlzc2lvbikg4oCUIGEgcmVwb3NpdG9yeSBjb25maWd1cmF0aW9uIGZhdWx0LCBub3QgYSB3b3JrZXIgZGVmZWN0LlwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwicHJvbXB0X3Rvb19sb25nXCI6XG4gICAgICAvLyBJc3N1ZSAjMjY4MjogdGhlIGFnZW50IENMSSByZWZ1c2VkIHRoZSBydW4gYmVjYXVzZSB0aGUgdHJhbnNjcmlwdFxuICAgICAgLy8gb3V0Z3JldyB0aGUgY29udGV4dCB3aW5kb3cuIFRoZSB3b3JrZXIgYWxyZWFkeSBzcGVudCBpdHMgb25lXG4gICAgICAvLyBmcmVzaC1zZXNzaW9uIHJldHJ5LCBzbyB0aGlzIGlzIHN0YXRlZCBwbGFpbmx5IGFuZCBuZXZlciBhdXRvLWZpbGVkLlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZml4YWJpbGl0eTogXCJub3RfY29kZV9maXhhYmxlXCIsXG4gICAgICAgIGZhaWx1cmVDbGFzczogXCJwcm9tcHQtdG9vLWxvbmdcIixcbiAgICAgICAgcmF0aW9uYWxlOlxuICAgICAgICAgIFwiVGhlIGFnZW50IENMSSByZWZ1c2VkIHRoZSBydW4gYXMgUHJvbXB0IGlzIHRvbyBsb25nLCBldmVuIG9uIGEgZnJlc2ggc2Vzc2lvbiDigJQgdGhlIGlzc3VlJ3MgY29udGV4dCBvdXRncmV3IHRoZSBtb2RlbCwgbm90IGEgd29ya2VyIGRlZmVjdC5cIixcbiAgICAgIH07XG4gICAgY2FzZSBcImNsb25lX2NvcnJ1cHRcIjpcbiAgICAgIC8vIElzc3VlICMyODg0OiB0aGUgaG9zdCdzIHNoYXJlZCBjbG9uZSBpcyBkYW1hZ2VkIChicm9rZW4gcmVmcyBvciBhXG4gICAgICAvLyBjb3JydXB0IG9iamVjdCBzdG9yZSkuIEFuIG9wZXJhdG9yIHJlcGFpcnMgdGhlIGhvc3QncyBjbG9uZTsgbm9cbiAgICAgIC8vIHdvcmtlciBjb2RlIGNoYW5nZSB3b3VsZCBoZWxwLCBzbyBpdCBpcyBuZXZlciBhdXRvLWZpbGVkLlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZml4YWJpbGl0eTogXCJub3RfY29kZV9maXhhYmxlXCIsXG4gICAgICAgIGZhaWx1cmVDbGFzczogXCJjbG9uZS1jb3JydXB0XCIsXG4gICAgICAgIHJhdGlvbmFsZTpcbiAgICAgICAgICBcIkJyYW5jaCBjcmVhdGlvbiBmYWlsZWQgYmVjYXVzZSB0aGUgaG9zdCdzIHNoYXJlZCBjbG9uZSBpcyBkYW1hZ2VkIOKAlCBhIGhvc3QgaW5mcmFzdHJ1Y3R1cmUgZmF1bHQsIG5vdCBhIHdvcmtlciBkZWZlY3QuXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJwdXNoX2ZhaWx1cmVcIjpcbiAgICAgIC8vIEEgcmVqZWN0ZWQgcHVzaCBpcyB1c3VhbGx5IHBlcm1pc3Npb25zL3Byb3RlY3Rpb24gb3IgYSByYWNlIOKAlCBub3RcbiAgICAgIC8vIHByb3ZlbiBlaXRoZXIgd2F5LlxuICAgICAgcmV0dXJuIGNyYXNoT3Ioe1xuICAgICAgICBmaXhhYmlsaXR5OiBcInVua25vd25cIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcInVua25vd25cIixcbiAgICAgICAgcmF0aW9uYWxlOiBcIkdpdCBwdXNoIGZhaWxlZDsgdGhlIGNhdXNlIGlzIG5vdCBwcm92ZW4gdG8gYmUgdGhlIHdvcmtlci5cIixcbiAgICAgIH0sIG1lc3NhZ2UpO1xuICAgIGNhc2UgXCJ1bmtub3duXCI6XG4gICAgICAvLyA5LiBUaGUgc2FmZSBkZWZhdWx0IOKAlCB3aXRoIG9uZSByZWZpbmVtZW50OiBhbiB1bmhhbmRsZWQgZXhjZXB0aW9uIC9cbiAgICAgIC8vICAgIHN0YWNrIHRyYWNlIGluIHRoZSBtZXNzYWdlIGlzIGEgd29ya2VyIGNyYXNoIHdoYXRldmVyIHRoZVxuICAgICAgLy8gICAgY2F0ZWdvcnkgZGV0ZWN0b3IgbWFkZSBvZiBpdC5cbiAgICAgIHJldHVybiBjcmFzaE9yKHtcbiAgICAgICAgZml4YWJpbGl0eTogXCJ1bmtub3duXCIsXG4gICAgICAgIGZhaWx1cmVDbGFzczogXCJ1bmtub3duXCIsXG4gICAgICAgIHJhdGlvbmFsZTogXCJObyBzaWduYWwgaW4gdGhlIGNhdGVnb3J5IG9yIG1lc3NhZ2UgZGVjaWRlcyBmaXhhYmlsaXR5LlwiLFxuICAgICAgfSwgbWVzc2FnZSk7XG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIEV4aGF1c3RpdmVuZXNzIGd1YXJkOiBhIG5ldyBGYWlsdXJlQ2F0ZWdvcnkgbXVzdCBjaG9vc2UgYSBidWNrZXQuXG4gICAgICByZXR1cm4gYXNzZXJ0TmV2ZXIoY2F0ZWdvcnkpO1xuICB9XG59XG5cbi8qKlxuICogUmVmaW5lIGFuIG90aGVyd2lzZS11bmtub3duIHJlc3VsdDogYW4gdW5oYW5kbGVkIGV4Y2VwdGlvbiAvIHN0YWNrIHRyYWNlXG4gKiBpbiB0aGUgbWVzc2FnZSBpcyBhIHdvcmtlciBjcmFzaCAoY29kZS1maXhhYmxlKSB3aGF0ZXZlciB0aGUgY2F0ZWdvcnkuXG4gKi9cbmZ1bmN0aW9uIGNyYXNoT3IoXG4gIGZhbGxiYWNrOiBSdW5GYWlsdXJlQ2xhc3NpZmljYXRpb24sXG4gIG1lc3NhZ2U6IHN0cmluZyxcbik6IFJ1bkZhaWx1cmVDbGFzc2lmaWNhdGlvbiB7XG4gIC8vIElzc3VlICMyNDk6IGNyYXNoIGV2aWRlbmNlIGlzIHJlYWQgZnJvbSB0aGUgd29ya2VyJ3Mgb3duIHdvcmRzLiBUaGVcbiAgLy8gcXVvdGVkIGFnZW50IG91dHB1dCBpcyBleGNsdWRlZCBmcm9tIHRoZSBwcm9zZSBwYXR0ZXJucywgYmVjYXVzZSBhblxuICAvLyBhZ2VudCBkaXNjdXNzaW5nIGV4Y2VwdGlvbnMgaW4gdGhlIGNvZGUgaXQgaXMgd3JpdGluZyBpcyBub3QgYSB3b3JrZXJcbiAgLy8gY3Jhc2gg4oCUIHRoYXQgZmFsc2UgcG9zaXRpdmUgZmlsZWQgdGhpcyB2ZXJ5IGlzc3VlIGFnYWluc3QgYSBydW4gdGhhdFxuICAvLyBoYWQgc3RvcHBlZCBjbGVhbmx5IGF0IGl0cyBkZWFkbGluZSB3aXRoIFdJUCBwcmVzZXJ2ZWQuXG4gIGNvbnN0IHsgd29ya2VyLCBhZ2VudCB9ID0gc3BsaXRBZ2VudE5hcnJhdGlvbihtZXNzYWdlKTtcbiAgaWYgKFNUQUNLX1RSQUNFX1JFLnRlc3Qod29ya2VyKSB8fCBTVEFDS19GUkFNRV9SRS50ZXN0KGFnZW50KSkge1xuICAgIHJldHVybiB7XG4gICAgICBmaXhhYmlsaXR5OiBcImNvZGVfZml4YWJsZVwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcIndvcmtlci1jcmFzaFwiLFxuICAgICAgcmF0aW9uYWxlOlxuICAgICAgICBcIlRoZSBtZXNzYWdlIGNhcnJpZXMgYW4gdW5oYW5kbGVkIGV4Y2VwdGlvbiAvIHN0YWNrIHRyYWNlIGZyb20gdGhlIHdvcmtlci5cIixcbiAgICB9O1xuICB9XG4gIHJldHVybiBmYWxsYmFjaztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2QkMsR0FFRCxTQUFTLFdBQVcsUUFBUSxvQkFBb0I7QUFDaEQsU0FBUyw0QkFBNEIsUUFBUSxpQ0FBaUM7QUFDOUUsU0FFRSxvQkFBb0IsRUFDcEIsb0JBQW9CLFFBQ2YseUJBQXlCO0FBQ2hDLFNBQVMsMkJBQTJCLFFBQVEsNEJBQTRCO0FBcUJ4RSxzRUFBc0UsR0FDdEUsT0FBTyxNQUFNLHNCQUFzQjtFQUNqQztFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0EseUVBQXlFO0VBQ3pFLDRFQUE0RTtFQUM1RTtFQUNBO0NBQ0QsQ0FBVTtBQUVYOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsTUFBTSxrQkFDSjtBQUVGLG1GQUFtRixHQUNuRixNQUFNLDJCQUEyQjtBQUVqQzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJDLEdBQ0QsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sc0JBQ0o7QUFFRiwrRUFBK0UsR0FDL0UsU0FBUyxXQUFXLE9BQWU7RUFDakMsT0FBTyxVQUFVLElBQUksQ0FBQyxZQUFZLG9CQUFvQixJQUFJLENBQUM7QUFDN0Q7QUFFQTs7Ozs7O0NBTUMsR0FDRCxNQUFNLG1CQUNKO0FBRUYsaUVBQWlFLEdBQ2pFLE1BQU0saUJBQ0o7QUFFRjs7Ozs7Ozs7O0NBU0MsR0FDRCxNQUFNLGlCQUFpQjtBQUV2Qjs7Ozs7OztDQU9DLEdBQ0QsTUFBTSx3QkFDSjtBQUVGOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxTQUFTLG9CQUNkLE9BQWU7RUFFZixNQUFNLGFBQXVCLEVBQUU7RUFDL0IsTUFBTSxTQUFTLFFBQVEsT0FBTyxDQUFDLHVCQUF1QixDQUFDO0lBQ3JELFdBQVcsSUFBSSxDQUFDO0lBQ2hCLE9BQU87RUFDVDtFQUNBLE9BQU87SUFBRTtJQUFRLE9BQU8sV0FBVyxJQUFJLENBQUM7RUFBTTtBQUNoRDtBQUVBLGtFQUFrRSxHQUNsRSxNQUFNLGdCQUEwQztFQUM5QyxZQUFZO0VBQ1osY0FBYztFQUNkLFdBQVc7QUFDYjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE1BQU0sdUJBQWlEO0VBQ3JELFlBQVk7RUFDWixjQUFjO0VBQ2QsV0FDRTtBQUNKO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxNQUFNLDBCQUNKO0FBRUYsZ0ZBQWdGLEdBQ2hGLE1BQU0sZ0JBQTBDO0VBQzlDLFlBQVk7RUFDWixjQUFjO0VBQ2QsV0FDRTtBQUNKO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE1BQU0sZUFBeUM7RUFDN0MsWUFBWTtFQUNaLGNBQWM7RUFDZCxXQUNFO0FBQ0o7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sTUFBTSxxQkFBK0M7RUFDMUQsWUFBWTtFQUNaLGNBQWM7RUFDZCxXQUNFO0FBQ0osRUFBRTtBQUVGLHFGQUFxRixHQUNyRixNQUFNLGtCQUF1QyxJQUFJLElBQUk7RUFDbkQ7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELFNBQVMsU0FBUyxLQUFjO0VBQzlCLElBQUksT0FBTyxVQUFVLFlBQVksVUFBVSxRQUFRLE1BQU0sT0FBTyxDQUFDLFFBQVE7SUFDdkUsT0FBTztFQUNUO0VBQ0EsT0FBTztBQUNUO0FBRUEsMkVBQTJFLEdBQzNFLFNBQVMscUJBQXFCLEtBQWM7RUFDMUMsTUFBTSxTQUFTLFNBQVM7RUFDeEIsSUFBSSxDQUFDLFFBQVEsT0FBTztFQUNwQixPQUFPLFNBQVMsT0FBTyxJQUFJLEtBQUssU0FBUyxPQUFPLE9BQU8sS0FBSztBQUM5RDtBQUVBLFNBQVMsU0FBUyxJQUE2QjtFQUM3QyxNQUFNLE1BQU0sS0FBSyxTQUFTLElBQUksS0FBSyxJQUFJO0VBQ3ZDLE9BQU8sT0FBTyxRQUFRLFdBQVcsSUFBSSxXQUFXLEtBQUs7QUFDdkQ7QUFFQSx5RUFBeUUsR0FDekUsU0FBUyxTQUFTLElBQTZCO0VBQzdDLE1BQU0sUUFBa0IsRUFBRTtFQUMxQixLQUFLLE1BQU0sT0FBTztJQUFDO0lBQVc7SUFBUTtJQUFXO0dBQVEsQ0FBRTtJQUN6RCxNQUFNLFFBQVEsSUFBSSxDQUFDLElBQUk7SUFDdkIsSUFBSSxPQUFPLFVBQVUsVUFBVTtNQUM3QixNQUFNLElBQUksQ0FBQztNQUNYO0lBQ0Y7SUFDQSxNQUFNLFNBQVMsU0FBUztJQUN4QixJQUFJLFVBQVUsT0FBTyxPQUFPLE9BQU8sS0FBSyxVQUFVO01BQ2hELE1BQU0sSUFBSSxDQUFDLE9BQU8sT0FBTztJQUMzQjtFQUNGO0VBQ0EsT0FBTyxNQUFNLElBQUksQ0FBQyxNQUFNLFdBQVc7QUFDckM7QUFFQTs7Q0FFQyxHQUNELFNBQVMsMkJBQTJCLElBQTZCO0VBQy9ELElBQUksU0FBUyxVQUFVLFNBQVMsT0FBTztFQUN2QyxNQUFNLE9BQU8sU0FBUztFQUN0QixPQUFPLEtBQUssUUFBUSxDQUFDLCtCQUNuQixLQUFLLFFBQVEsQ0FBQyxvQ0FDYixLQUFLLFFBQVEsQ0FBQyxXQUFXLEtBQUssUUFBUSxDQUFDO0FBQzVDO0FBRUEsU0FBUyxXQUFXLElBQTZCO0VBQy9DLE9BQU8sZ0JBQWdCLEdBQUcsQ0FBQyxTQUFTO0FBQ3RDO0FBRUEsMkVBQTJFLEdBQzNFLFNBQVMsa0JBQWtCLElBQTZCO0VBQ3RELE1BQU0sU0FBUyxPQUFPLEtBQUssTUFBTSxLQUFLLFdBQ2xDLEtBQUssTUFBTSxDQUFDLFdBQVcsS0FDdkI7RUFDSixJQUFJLFdBQVcscUJBQXFCLFdBQVcsZ0JBQWdCLE9BQU87RUFDdEUsTUFBTSxPQUFPLFNBQVM7RUFDdEIsT0FBTyxLQUFLLFFBQVEsQ0FBQyxzQkFDbkIsS0FBSyxRQUFRLENBQUMsdUJBQ2QsS0FBSyxRQUFRLENBQUM7QUFDbEI7QUFFQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNEOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLHFCQUFxQixJQUFZO0VBQy9DLE1BQU0sUUFBbUIsRUFBRTtFQUMzQixLQUFLLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQyxNQUFPO0lBQ25DLE1BQU0sVUFBVSxLQUFLLElBQUk7SUFDekIsSUFBSSxDQUFDLFFBQVEsVUFBVSxDQUFDLE1BQU07SUFDOUIsSUFBSTtNQUNGLE1BQU0sSUFBSSxDQUFDLEtBQUssS0FBSyxDQUFDO0lBQ3hCLEVBQUUsT0FBTTtNQUNOO0lBQ0Y7RUFDRjtFQUNBLE9BQU87QUFDVDtBQUVBLFNBQVMsa0NBQ1AsVUFBMEM7RUFFMUMsSUFBSSxDQUFDLGNBQWMsV0FBVyxNQUFNLEtBQUssR0FBRyxPQUFPO0VBQ25ELE1BQU0sUUFBbUMsRUFBRTtFQUMzQyxLQUFLLE1BQU0sU0FBUyxXQUFZO0lBQzlCLE1BQU0sT0FBTyxxQkFBcUI7SUFDbEMsSUFBSSxNQUFNLE1BQU0sSUFBSSxDQUFDO0VBQ3ZCO0VBQ0EseUVBQXlFO0VBQ3pFLHFFQUFxRTtFQUNyRSxJQUFJLGtCQUFrQjtFQUN0QixJQUFJLDBCQUEwQjtFQUM5QixLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLElBQUksMkJBQTJCLE9BQU8sa0JBQWtCO0lBQ3hELElBQ0UsbUJBQW1CLFdBQVcsU0FBUyxDQUFDLGtCQUFrQixPQUMxRDtNQUNBLDBCQUEwQjtJQUM1QjtFQUNGO0VBQ0EsSUFBSSxtQkFBbUIsQ0FBQyx5QkFBeUIsT0FBTztFQUV4RCxNQUFNLFFBQVEsTUFBTSxNQUFNLENBQUM7RUFDM0IsdUVBQXVFO0VBQ3ZFLDJFQUEyRTtFQUMzRSxJQUFJLE1BQU0sSUFBSSxDQUFDLENBQUMsT0FBUyxDQUFDLGtCQUFrQixRQUFRLE9BQU87RUFDM0QsT0FBTyxNQUFNLE1BQU0sR0FBRyxLQUFLLE1BQU0sS0FBSyxDQUFDO0FBQ3pDO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTZDQyxHQUNELE9BQU8sU0FBUyxtQkFDZCxRQUF5QixFQUN6QixjQUFzQixFQUN0QixnQkFBeUIsRUFDekIsVUFBK0I7RUFFL0IsMEVBQTBFO0VBQzFFLHFGQUFxRjtFQUNyRixnRkFBZ0Y7RUFDaEYsbURBQW1EO0VBQ25ELE1BQU0sVUFBVSxtQkFDWixhQUFhLFlBQVksYUFBYSxnQkFDcEMsYUFBYSxtQkFDYixvQkFBb0Isa0JBQWtCLElBQUksTUFBTSxHQUNoRCxLQUNGLGtCQUFrQjtFQUV0Qix3RUFBd0U7RUFDeEUseUVBQXlFO0VBQ3pFLDJFQUEyRTtFQUMzRSxnREFBZ0Q7RUFDaEQsSUFBSSxrQ0FBa0MsYUFBYSxPQUFPO0VBRTFELDZFQUE2RTtFQUM3RSw0RUFBNEU7RUFDNUUsc0VBQXNFO0VBQ3RFLDJFQUEyRTtFQUMzRSw0RUFBNEU7RUFDNUUsMERBQTBEO0VBQzFELElBQUkscUJBQXFCLFdBQVcsT0FBTztFQUUzQyxzRUFBc0U7RUFDdEUsc0VBQXNFO0VBQ3RFLGlFQUFpRTtFQUNqRSxFQUFFO0VBQ0YsMEVBQTBFO0VBQzFFLDBFQUEwRTtFQUMxRSxzRUFBc0U7RUFDdEUsd0VBQXdFO0VBQ3hFLGdFQUFnRTtFQUNoRSxFQUFFO0VBQ0YscUVBQXFFO0VBQ3JFLDBFQUEwRTtFQUMxRSxpRUFBaUU7RUFDakUsSUFBSSw0QkFBNEIsb0JBQW9CLFNBQVMsTUFBTSxHQUFHO0lBQ3BFLE9BQU87TUFDTCxZQUFZO01BQ1osY0FBYztNQUNkLFdBQ0Usd0VBQ0E7SUFDSjtFQUNGO0VBQ0EsSUFBSSxhQUFhLGNBQWM7SUFDN0IsdUVBQXVFO0lBQ3ZFLDZDQUE2QztJQUM3QyxJQUFJLHFCQUFxQixVQUFVLE9BQU87SUFDMUMsT0FBTztNQUNMLFlBQVk7TUFDWixjQUFjO01BQ2QsV0FDRTtJQUNKO0VBQ0Y7RUFDQSw2RUFBNkU7RUFDN0UseUVBQXlFO0VBQ3pFLElBQUksYUFBYSxlQUFlO0lBQzlCLE9BQU87TUFDTCxZQUFZO01BQ1osY0FBYztNQUNkLFdBQ0U7SUFDSjtFQUNGO0VBQ0EseUVBQXlFO0VBQ3pFLDBFQUEwRTtFQUMxRSx3RUFBd0U7RUFDeEUsbUVBQW1FO0VBQ25FLHdFQUF3RTtFQUN4RSxrQkFBa0I7RUFDbEIsSUFBSSxhQUFhLHFCQUFxQjtJQUNwQyxPQUFPO01BQ0wsWUFBWTtNQUNaLGNBQWM7TUFDZCxXQUNFO0lBQ0o7RUFDRjtFQUNBLElBQUkscUJBQXFCLFVBQVUsT0FBTztFQUMxQyxpRkFBaUY7RUFDakYsSUFDRSxhQUFhLG9CQUNiLHdCQUF3QixJQUFJLENBQzFCLG9CQUFvQixrQkFBa0IsSUFBSSxNQUFNLEdBRWxELE9BQU87RUFFVCx3RUFBd0U7RUFDeEUsMEVBQTBFO0VBQzFFLHlFQUF5RTtFQUN6RSxtRUFBbUU7RUFDbkUsSUFBSSxpQkFBaUIsSUFBSSxDQUFDLFVBQVU7SUFDbEMsT0FBTztNQUNMLFlBQVk7TUFDWixjQUFjO01BQ2QsV0FDRTtJQUNKO0VBQ0Y7RUFFQSx3RUFBd0U7RUFDeEUsMkVBQTJFO0VBQzNFLDJFQUEyRTtFQUMzRSx5RUFBeUU7RUFDekUsMEVBQTBFO0VBQzFFLHNFQUFzRTtFQUN0RSxxRUFBcUU7RUFDckUsSUFDRSxhQUFhLG9CQUNiLDZCQUNFLG9CQUFvQixrQkFBa0IsSUFBSSxNQUFNLEdBRWxEO0lBQ0EsT0FBTztNQUNMLFlBQVk7TUFDWixjQUFjO01BQ2QsV0FDRTtJQUNKO0VBQ0Y7RUFFQSx1RUFBdUU7RUFDdkUsNkNBQTZDO0VBQzdDLCtFQUErRTtFQUMvRSx5RUFBeUU7RUFDekUsc0VBQXNFO0VBQ3RFLElBQ0UsV0FDRSxvQkFBb0IsYUFBYSxZQUFZLGlCQUFpQixVQUVoRTtJQUNBLE9BQU87TUFDTCxZQUFZO01BQ1osY0FBYztNQUNkLFdBQ0U7SUFDSjtFQUNGO0VBRUEsT0FBUTtJQUNOLEtBQUs7TUFDSCxxRUFBcUU7TUFDckUscUVBQXFFO01BQ3JFLHVFQUF1RTtNQUN2RSw0REFBNEQ7TUFDNUQsSUFBSSx5QkFBeUIsSUFBSSxDQUFDLFVBQVU7UUFDMUMsT0FBTztVQUNMLFlBQVk7VUFDWixjQUFjO1VBQ2QsV0FDRTtRQUNKO01BQ0Y7TUFDQSxJQUFJLGdCQUFnQixJQUFJLENBQUMsb0JBQW9CLFNBQVMsTUFBTSxHQUFHO1FBQzdELE9BQU87VUFDTCxZQUFZO1VBQ1osY0FBYztVQUNkLFdBQ0U7UUFDSjtNQUNGO01BQ0EsT0FBTztRQUNMLFlBQVk7UUFDWixjQUFjO1FBQ2QsV0FDRTtNQUNKO0lBQ0YsS0FBSztNQUNILG1DQUFtQztNQUNuQyxPQUFPO1FBQ0wsWUFBWTtRQUNaLGNBQWM7UUFDZCxXQUNFO01BQ0o7SUFDRixLQUFLO01BQ0gsK0NBQStDO01BQy9DLE9BQU87UUFDTCxZQUFZO1FBQ1osY0FBYztRQUNkLFdBQVc7TUFDYjtJQUNGLEtBQUs7TUFDSCxpRUFBaUU7TUFDakUsb0JBQW9CO01BQ3BCLE9BQU8sUUFBUTtRQUNiLFlBQVk7UUFDWixjQUFjO1FBQ2QsV0FDRTtNQUNKLEdBQUc7SUFDTCxLQUFLO01BQ0gsT0FBTyxRQUFRO1FBQ2IsWUFBWTtRQUNaLGNBQWM7UUFDZCxXQUNFO01BQ0osR0FBRztJQUNMLEtBQUs7SUFDTCxLQUFLO0lBQ0wsS0FBSztNQUNILGtFQUFrRTtNQUNsRSxzRUFBc0U7TUFDdEUsb0VBQW9FO01BQ3BFLGtFQUFrRTtNQUNsRSxxRUFBcUU7TUFDckUsa0NBQWtDO01BQ2xDLElBQUksa0NBQWtDLGFBQWEsT0FBTztNQUMxRCxPQUFPO0lBQ1QsS0FBSztNQUNILHdFQUF3RTtNQUN4RSxzRUFBc0U7TUFDdEUsd0VBQXdFO01BQ3hFLHNFQUFzRTtNQUN0RSwwQkFBMEI7TUFDMUIsT0FBTztRQUNMLFlBQVk7UUFDWixjQUFjO1FBQ2QsV0FDRTtNQUNKO0lBQ0YsS0FBSztNQUNILG9FQUFvRTtNQUNwRSxvRUFBb0U7TUFDcEUsMkRBQTJEO01BQzNELE9BQU87UUFDTCxZQUFZO1FBQ1osY0FBYztRQUNkLFdBQ0U7TUFDSjtJQUNGLEtBQUs7TUFDSCx1RUFBdUU7TUFDdkUsdUVBQXVFO01BQ3ZFLG9FQUFvRTtNQUNwRSx1Q0FBdUM7TUFDdkMsT0FBTztRQUNMLFlBQVk7UUFDWixjQUFjO1FBQ2QsV0FDRTtNQUNKO0lBQ0YsS0FBSztNQUNILG9FQUFvRTtNQUNwRSwrREFBK0Q7TUFDL0QsdUVBQXVFO01BQ3ZFLE9BQU87UUFDTCxZQUFZO1FBQ1osY0FBYztRQUNkLFdBQ0U7TUFDSjtJQUNGLEtBQUs7TUFDSCxvRUFBb0U7TUFDcEUsa0VBQWtFO01BQ2xFLDREQUE0RDtNQUM1RCxPQUFPO1FBQ0wsWUFBWTtRQUNaLGNBQWM7UUFDZCxXQUNFO01BQ0o7SUFDRixLQUFLO01BQ0gsb0VBQW9FO01BQ3BFLHFCQUFxQjtNQUNyQixPQUFPLFFBQVE7UUFDYixZQUFZO1FBQ1osY0FBYztRQUNkLFdBQVc7TUFDYixHQUFHO0lBQ0wsS0FBSztNQUNILHNFQUFzRTtNQUN0RSwrREFBK0Q7TUFDL0QsbUNBQW1DO01BQ25DLE9BQU8sUUFBUTtRQUNiLFlBQVk7UUFDWixjQUFjO1FBQ2QsV0FBVztNQUNiLEdBQUc7SUFDTDtNQUNFLG9FQUFvRTtNQUNwRSxPQUFPLFlBQVk7RUFDdkI7QUFDRjtBQUVBOzs7Q0FHQyxHQUNELFNBQVMsUUFDUCxRQUFrQyxFQUNsQyxPQUFlO0VBRWYsc0VBQXNFO0VBQ3RFLHNFQUFzRTtFQUN0RSx3RUFBd0U7RUFDeEUsdUVBQXVFO0VBQ3ZFLDBEQUEwRDtFQUMxRCxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxHQUFHLG9CQUFvQjtFQUM5QyxJQUFJLGVBQWUsSUFBSSxDQUFDLFdBQVcsZUFBZSxJQUFJLENBQUMsUUFBUTtJQUM3RCxPQUFPO01BQ0wsWUFBWTtNQUNaLGNBQWM7TUFDZCxXQUNFO0lBQ0o7RUFDRjtFQUNBLE9BQU87QUFDVCJ9
// denoCacheMetadata=2175169705835892428,11325998565599239552