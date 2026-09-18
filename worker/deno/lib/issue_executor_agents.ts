/**
 * The Sonnet executor sub-agents an `issue`-phase run delegates to when
 * `issue_executor_split` is on (Issue #2342, part of #2320).
 *
 * The worker passes no `--agents` today, so every sub-agent a run spawns
 * inherits the phase's model — the expensive advisor tier doing work an
 * executor tier does just as well. These definitions are what change that:
 * the **advisor** stays the main session on the phase's model and effort, and
 * hands mechanical edit-and-test work to executors pinned to Sonnet.
 *
 * Nothing here touches phase routing. The definitions are built only at the
 * call site that has already resolved the key on, so a run with the key off
 * builds the same argv it always has.
 */

import type { AgentDefinition } from "./agent_provider.ts";

/** The sub-agent name the CLI routes executor work to. */
export const ISSUE_EXECUTOR_AGENT_NAME = "executor";

/**
 * The tier the executors run on.
 *
 * The **alias**, not a pinned id: every Claude default in this worker is a
 * tier alias (see `docs/MODEL-AND-CACHING.md`), so the CLI resolves it from
 * its own bundled table and a new Sonnet release needs no change here. Sonnet
 * is the tier priced at $2/$10 per MTok in that document — cheaper than the
 * advisor's tier, which is the whole point of the split.
 */
export const ISSUE_EXECUTOR_MODEL = "sonnet";

/**
 * The effort the executors run at.
 *
 * `medium`, against the advisor's `high`: an executor is handed the edits to
 * make rather than asked to decide what they should be, so the reasoning
 * depth the advisor needs would be spent on work that does not use it.
 */
export const ISSUE_EXECUTOR_EFFORT = "medium";

/** Exactly the tools an executor needs to edit files and run the tests. */
export const ISSUE_EXECUTOR_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash",
];

/**
 * Tools an executor must not use, whatever {@link ISSUE_EXECUTOR_TOOLS}
 * grants.
 *
 * `Agent` is denied so an executor cannot spawn further sub-agents: the split
 * is one advisor delegating to executors, and an executor that can delegate
 * again turns a bounded two-tier run into an unbounded tree.
 */
export const ISSUE_EXECUTOR_DISALLOWED_TOOLS: readonly string[] = ["Agent"];

/** The executor's own system prompt. */
const ISSUE_EXECUTOR_PROMPT = [
  "You are an executor sub-agent on an issue-work run. You are handed a " +
  "specific set of edits to make; make exactly those edits and nothing more.",
  "",
  "- Apply the edits you were given. Do not redesign the approach, refactor " +
  "adjacent code, or add behaviour nobody asked for — if the instructions " +
  "look wrong, say so in your reply rather than substituting your own plan.",
  "- After editing, run the tests that cover the files you edited, with " +
  "stdin redirected from /dev/null. Run those tests, not the full suite.",
  "- Report what you changed and the exact test output you saw. A failing " +
  "test is reported as failing — never as a pass, and never worked around " +
  "by weakening the test.",
  "- You cannot spawn further sub-agents. Work the task yourself.",
].join("\n");

/**
 * Build the `--agents` definitions for a split `issue`-phase run.
 *
 * Called only when {@link isIssueExecutorSplitEnabled} has already resolved
 * true; the caller passes the result as `agents` on the invocation, and an
 * invocation without it emits no `--agents` argument at all.
 *
 * @returns The executor definition, keyed by sub-agent name.
 */
export function buildIssueExecutorAgents(): Readonly<
  Record<string, AgentDefinition>
> {
  return {
    [ISSUE_EXECUTOR_AGENT_NAME]: {
      description:
        "Applies a given set of code edits and runs the tests covering the " +
        "files it edited. Use for mechanical implementation work once the " +
        "change is decided.",
      prompt: ISSUE_EXECUTOR_PROMPT,
      model: ISSUE_EXECUTOR_MODEL,
      effort: ISSUE_EXECUTOR_EFFORT,
      tools: ISSUE_EXECUTOR_TOOLS,
      disallowedTools: ISSUE_EXECUTOR_DISALLOWED_TOOLS,
    },
  };
}
