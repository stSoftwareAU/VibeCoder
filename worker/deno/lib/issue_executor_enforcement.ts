/**
 * Keeping every `Edit`/`Write` in a split `issue` run inside an executor
 * (Issue #2344, part of #2320).
 *
 * Issue #2343 tells the advisor in prose to make no edit itself. Prose is
 * advice: this module is the enforcement, and the measurement that says
 * whether it held.
 *
 * ## Why a hook, not `--disallowedTools`
 *
 * The session-level `--disallowed-tools` the worker already passes cannot
 * express "the advisor may not edit, the executor may" — a tool removed from
 * the session pool is gone for sub-agents too. The Claude CLI in the
 * container (2.1.261) *can* distinguish the caller: its `PreToolUse` hook
 * payload carries `agent_id`, documented in the CLI's own payload schema as
 *
 * > "Subagent identifier. Present only when the hook fires from within a
 * > subagent (e.g., a tool called by an AgentTool worker). Absent for the
 * > main thread, even in --agent sessions. Use this field (not agent_type) to
 * > distinguish subagent calls from main-thread calls."
 *
 * So the denial branch is the one taken: a `PreToolUse` hook matching
 * `Edit|Write` denies the call when `agent_id` is absent (the advisor) and
 * allows it when it is present (an executor). A denial is a refused tool
 * call, not a failed run — the advisor is told why and delegates instead.
 *
 * The counting stays regardless, because a denial that silently stopped
 * firing would otherwise look identical to a well-behaved run: the run's
 * stream-json is summarised into the advisor edits that got through, the
 * denials that did not, the executors dispatched and the re-tasks issued.
 *
 * With the split key off nothing here is reached: no hook is configured, the
 * stream is not summarised, and the invocation is exactly today's.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ISSUE_EXECUTOR_AGENT_NAME } from "./issue_executor_agents.ts";
import { resolveGuardDenoDir } from "./guard_deno_dir.ts";
import { resolveGuardModulePath } from "./guard_module_path.ts";
import { posixSingleQuote } from "./shell_quote.ts";

/** File name of the guard entry point the hook command executes. */
export const ISSUE_EDIT_GUARD_MODULE = "issue_edit_guard_cli.ts";

/** The edit tools only an executor may call in a split run. */
export const ISSUE_EXECUTOR_EDIT_TOOLS: readonly string[] = ["Edit", "Write"];

/**
 * Marker opening every denial reason and log line this module emits.
 *
 * Stable by contract: the run log is grepped for it when a pilot run's
 * violations are read, so it must not be re-styled.
 */
export const ISSUE_EXECUTOR_DENIAL_MARKER = "[issue-executor-split]";

/** The `PreToolUse` matcher the hook is registered under. */
export const ISSUE_EXECUTOR_HOOK_MATCHER = ISSUE_EXECUTOR_EDIT_TOOLS.join("|");

/** The fields of a `PreToolUse` hook payload this guard reads. */
export interface IssueEditHookPayload {
  /** The event — only `PreToolUse` carries a permission decision. */
  hook_event_name?: unknown;
  /** The tool about to run, e.g. `Edit`. */
  tool_name?: unknown;
  /** Present only when the call comes from a sub-agent (the executors). */
  agent_id?: unknown;
}

/** What the guard decided about one tool call. */
export type IssueEditHookDecision =
  | { readonly deny: false }
  | { readonly deny: true; readonly tool: string; readonly reason: string };

/** A non-empty string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Decide whether one `PreToolUse` call is an advisor edit that must be denied.
 *
 * Deny exactly when the tool is one of {@link ISSUE_EXECUTOR_EDIT_TOOLS} and
 * the payload carries **no** `agent_id` — the CLI's own signal for "the main
 * thread called this", which in a split run is the advisor. Everything else
 * is allowed: an executor's edit (`agent_id` present), any non-edit tool, and
 * any payload for another event.
 *
 * @param payload - The hook payload, as parsed from the guard's stdin
 * @returns The decision, carrying the tool name and reason when denying
 */
export function decideIssueEditHook(payload: unknown): IssueEditHookDecision {
  if (typeof payload !== "object" || payload === null) return { deny: false };
  const input = payload as IssueEditHookPayload;

  const event = text(input.hook_event_name);
  if (event !== undefined && event !== "PreToolUse") return { deny: false };

  const tool = text(input.tool_name);
  if (tool === undefined || !ISSUE_EXECUTOR_EDIT_TOOLS.includes(tool)) {
    return { deny: false };
  }

  // The caller test. Present → a sub-agent called it, which in a split run is
  // an executor and exactly where the edit belongs.
  if (text(input.agent_id) !== undefined) return { deny: false };

  return {
    deny: true,
    tool,
    reason: `${ISSUE_EXECUTOR_DENIAL_MARKER} ${tool} denied: in a split run ` +
      `every Edit/Write is made by an "${ISSUE_EXECUTOR_AGENT_NAME}" ` +
      `sub-agent. Dispatch one with the edit instead (Issue #2344).`,
  };
}

/**
 * Render the guard's stdout for a decision.
 *
 * A denial is the CLI's documented `PreToolUse` shape
 * (`hookSpecificOutput.permissionDecision`); an allow writes nothing at all,
 * which the CLI reads as "no opinion" and runs the tool.
 *
 * @param decision - What {@link decideIssueEditHook} returned
 * @returns The JSON line to write to stdout, or `""` to stay silent
 */
export function renderIssueEditHookOutput(
  decision: IssueEditHookDecision,
): string {
  if (!decision.deny) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}

/**
 * The log line a denial writes, naming the tool that was denied.
 *
 * @param tool - The denied tool name, e.g. `Edit`
 * @returns A single line, no trailing newline
 */
export function formatIssueEditDenialLog(tool: string): string {
  return `${ISSUE_EXECUTOR_DENIAL_MARKER} denied advisor ${tool} call — the ` +
    `edit belongs to an "${ISSUE_EXECUTOR_AGENT_NAME}" sub-agent ` +
    `(Issue #2344); the run continues.`;
}

/**
 * Build the `--settings` payload that installs the guard for one run.
 *
 * Passed as a JSON **string**, which `--settings` accepts beside a path, so a
 * split run writes no file and a key-off run carries no argument at all.
 *
 * @param opts.denoPath - Absolute path of the `deno` binary running the guard
 * @param opts.guardModulePath - Absolute path of the guard entry point
 * @param opts.denoDir - Read-only Deno cache to pin the guard child to, so the
 *   agent's own environment cannot point it at a cache it prepared
 *   (Issue #1448's finding, applied to this guard). Omitted inherits the
 *   environment, as on a host with no baked seed.
 * @returns The settings object the CLI merges for this invocation
 */
export function buildIssueExecutorHookSettings(opts: {
  denoPath: string;
  guardModulePath: string;
  denoDir?: string;
}): Record<string, unknown> {
  const pinnedCache = opts.denoDir
    ? `DENO_DIR=${posixSingleQuote(opts.denoDir)} `
    : "";
  const command = `${pinnedCache}${posixSingleQuote(opts.denoPath)} run ` +
    `--quiet --no-config --no-lock ${posixSingleQuote(opts.guardModulePath)}`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: ISSUE_EXECUTOR_HOOK_MATCHER,
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
}

/**
 * The settings a production split run installs the guard with.
 *
 * Resolves the running `deno` binary and the guard module — through
 * {@link resolveGuardModulePath}, so the guard executed is the read-only
 * checkout's copy rather than the writable staged one the agent could edit
 * (Issue #1444). Both are injectable, so a test asserts the shape without
 * depending on where it runs.
 *
 * @param opts.denoPath - Override the resolved `deno` binary
 * @param opts.guardModulePath - Override the resolved guard entry point
 * @returns The settings object, ready to be JSON-stringified into `--settings`
 */
export function resolveIssueExecutorHookSettings(
  opts: { denoPath?: string; guardModulePath?: string } = {},
): Record<string, unknown> {
  // The image's baked read-only Deno seed, when there is one. `""` asks for
  // no per-run fallback: where no read-only seed exists — a developer host,
  // the test suite — the guard child inherits the environment's cache, as
  // every other Deno the worker spawns there does.
  const cache = resolveGuardDenoDir("");
  return buildIssueExecutorHookSettings({
    denoPath: opts.denoPath ?? Deno.execPath(),
    guardModulePath: opts.guardModulePath ??
      resolveGuardModulePath(ISSUE_EDIT_GUARD_MODULE, import.meta.url),
    ...(cache.readOnly ? { denoDir: cache.path } : {}),
  });
}

/** Counts read off a split run's own stream, for the run-stats comment. */
export interface IssueExecutorSplitStats {
  /**
   * Advisor `Edit`/`Write` calls that went through — the violations.
   *
   * `0` on a run where the guard is enforcing, because a denied call made no
   * edit. The denials are counted separately by {@link deniedAdvisorEdits}.
   */
  advisorEditCalls: number;
  /** Tool names of the advisor edit calls the guard denied, in call order. */
  deniedAdvisorEdits: readonly string[];
  /** Executor sub-agents dispatched by the advisor. */
  executorDispatches: number;
  /** Re-tasks issued to an executor already dispatched. */
  executorRetasks: number;
}

/** A `tool_use` block, as far as this summariser reads one. */
interface ToolUseBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: Record<string, unknown>;
}

/** Tool names the CLI dispatches a sub-agent under. */
const DISPATCH_TOOLS: readonly string[] = ["Task", "Agent"];

/** Tool name that continues an already-dispatched sub-agent. */
const CONTINUE_TOOL = "SendMessage";

/** Whether a dispatch/continue tool call names an executor sub-agent. */
function namesExecutor(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  const named = text(input.subagent_type) ?? text(input.agent_type) ??
    text(input.to);
  return named === ISSUE_EXECUTOR_AGENT_NAME;
}

/** Flatten a `tool_result` content field to the text it carries. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null
        ? text((block as { text?: unknown }).text) ?? ""
        : ""
    )
    .join("\n");
}

/**
 * Summarise a split run's stream-json into the counts the pilot is read by.
 *
 * Attribution is the CLI's own: a stream line whose `parent_tool_use_id` is
 * null was produced by the main thread — the advisor — and a non-null one was
 * produced inside the sub-agent that tool call started. So an executor's edits
 * are never counted against the advisor, and vice versa.
 *
 * A **dispatch** is a `Task`/`Agent` call naming the executor sub-agent; a
 * **re-task** is a `SendMessage` continuation addressed to an executor already
 * running, which is how the advisor hands back a diff that did not match. A
 * fresh dispatch starts a fresh executor and is counted as a dispatch.
 *
 * Malformed lines are skipped rather than thrown on: the summary is
 * observability, and a truncated stream must not fail a run that otherwise
 * succeeded.
 *
 * @param rawStreamOutput - The run's raw stream-json (NDJSON) output
 * @returns The four counts, all zero on a stream with nothing to count
 */
export function summariseIssueExecutorSplitRun(
  rawStreamOutput: string,
): IssueExecutorSplitStats {
  /** Advisor edit `tool_use` ids → the tool they called. */
  const advisorEdits = new Map<string, string>();
  const denied: string[] = [];
  let executorDispatches = 0;
  let executorRetasks = 0;

  for (const line of rawStreamOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Skip malformed NDJSON lines.
    }

    const message = parsed.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    // Null/absent parent = the main thread, i.e. the advisor.
    const fromAdvisor = parsed.parent_tool_use_id == null;

    if (parsed.type === "assistant" && fromAdvisor) {
      for (const block of blocks as ToolUseBlock[]) {
        if (block?.type !== "tool_use") continue;
        const name = text(block.name);
        if (name === undefined) continue;
        if (ISSUE_EXECUTOR_EDIT_TOOLS.includes(name)) {
          advisorEdits.set(text(block.id) ?? `${advisorEdits.size}`, name);
        } else if (
          DISPATCH_TOOLS.includes(name) && namesExecutor(block.input)
        ) {
          executorDispatches++;
        } else if (name === CONTINUE_TOOL && namesExecutor(block.input)) {
          executorRetasks++;
        }
      }
      continue;
    }

    if (parsed.type !== "user") continue;
    for (const block of blocks as { type?: unknown; tool_use_id?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      const id = text(block.tool_use_id);
      const tool = id === undefined ? undefined : advisorEdits.get(id);
      if (tool === undefined) continue;
      const body = resultText((block as { content?: unknown }).content);
      if (!body.includes(ISSUE_EXECUTOR_DENIAL_MARKER)) continue;
      // The guard refused this one: it made no edit, so it is a denial
      // rather than a violation.
      advisorEdits.delete(id!);
      denied.push(tool);
    }
  }

  return {
    advisorEditCalls: advisorEdits.size,
    deniedAdvisorEdits: denied,
    executorDispatches,
    executorRetasks,
  };
}
