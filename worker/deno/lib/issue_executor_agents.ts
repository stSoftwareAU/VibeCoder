/**
 * The Sonnet executor sub-agents an `issue`-phase run delegates to when
 * `issue_executor_split` is on (Issue #2342, part of #2320).
 *
 * A sub-agent with no definition inherits the phase's model — the expensive
 * advisor tier doing work an executor tier does just as well. These
 * definitions are what change that: the **advisor** stays the main session on
 * the phase's model and effort, and hands mechanical edit-and-test work to
 * executors pinned to Sonnet.
 *
 * A run whose `issue_reviewer_agents` key is on also carries the two
 * independent reviewers (Issue #2575), pinned to a cheaper tier and effort,
 * read-only, and unable to spawn further sub-agents — see
 * {@link buildIssueRunAgents}. The executor is only on a run whose split key
 * resolved on.
 *
 * Nothing here touches phase routing.
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

// ---------------------------------------------------------------------------
// The independent reviewers (Issue #2575)
// ---------------------------------------------------------------------------

/** The sub-agent name the issue prompt dispatches the Spec reviewer as. */
export const SPEC_REVIEWER_AGENT_NAME = "spec-reviewer";

/** The sub-agent name the issue prompt dispatches the Standards reviewer as. */
export const STANDARDS_REVIEWER_AGENT_NAME = "standards-reviewer";

/**
 * The Spec reviewer's tier and effort.
 *
 * Sonnet at `medium`, against the advisor's Opus at `high`: without a
 * definition both reviewers inherited the advisor, so two extra contexts on
 * every criteria-bearing run were billed at the most expensive tier. The
 * Spec reviewer keeps `medium` because judging whether each criterion is
 * met is still judgement; its independence comes from its fresh context,
 * not from its tier.
 */
export const SPEC_REVIEWER_MODEL = "sonnet";
export const SPEC_REVIEWER_EFFORT = "medium";

/**
 * The Standards reviewer's tier and effort.
 *
 * Sonnet at `low`: it checks a diff against one written document, the
 * "simpler task … such as subagents" Anthropic's effort table names `low`
 * for.
 */
export const STANDARDS_REVIEWER_MODEL = "sonnet";
export const STANDARDS_REVIEWER_EFFORT = "low";

/**
 * Read-only tools: a reviewer reads the diff file, the standards and the code
 * the diff touches, and changes nothing. No `Bash` either — the advisor
 * writes the diff to a file and hands the reviewer its path.
 */
export const ISSUE_REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * Tools a reviewer must not use. `Agent` is denied so a reviewer cannot spawn
 * reviewers of its own, whatever {@link ISSUE_REVIEWER_TOOLS} grants.
 */
export const ISSUE_REVIEWER_DISALLOWED_TOOLS: readonly string[] = ["Agent"];

/** The Spec reviewer's own system prompt. */
const SPEC_REVIEWER_PROMPT = [
  "You are the independent Spec reviewer on an issue-work run. You are " +
  "given the path of a diff file and the issue body, verbatim, and nothing " +
  "of the author's reasoning. Judge the diff against the issue body only.",
  "",
  "Answer three questions, and only these:",
  "1. Which stated requirements are missing or partial?",
  "2. What behaviour is in the diff that was not asked for (scope creep)?",
  "3. Which requirements look implemented but are implemented wrongly?",
  "",
  "Return one `met` / `partial` / `missing` verdict per stated acceptance " +
  "criterion, with the evidence you saw (a file, a test name), and one " +
  "`unrequested` entry per change you cannot trace to the issue. Flag only " +
  "gaps that affect correctness or the stated requirements; do not propose " +
  "improvements the issue did not ask for.",
  "",
  "You are read-only and cannot spawn sub-agents. Do the review yourself.",
].join("\n");

/** The Standards reviewer's own system prompt. */
const STANDARDS_REVIEWER_PROMPT = [
  "You are the independent Standards reviewer on an issue-work run. You are " +
  "given the path of a diff file; read it and the repository's " +
  "`CODING-STANDARDS.md`, and nothing of the author's reasoning.",
  "",
  "One question: where does the diff depart from a documented standard in " +
  "a way that affects correctness, security or the stated requirements?",
  "",
  "- Return one `violation` entry per such departure, naming the standard " +
  "and the `file:line` you saw. A `violation` must cite a rule that is " +
  "written in `CODING-STANDARDS.md` — never a preference of your own.",
  "- List any other departure (style, naming, taste) under `optional`, one " +
  "line each. Those are not violations and are not to be chased.",
  "- Name the `clean` areas you checked and found compliant.",
  "",
  "You are read-only and cannot spawn sub-agents. Do the review yourself.",
].join("\n");

/**
 * Build the two reviewer definitions (Issue #2575).
 *
 * @returns The Spec and Standards reviewer definitions, keyed by name.
 */
export function buildIssueReviewerAgents(): Readonly<
  Record<string, AgentDefinition>
> {
  return {
    [SPEC_REVIEWER_AGENT_NAME]: {
      description:
        "Independent Spec reviewer: judges a finished diff against the " +
        "issue body, one verdict per acceptance criterion.",
      prompt: SPEC_REVIEWER_PROMPT,
      model: SPEC_REVIEWER_MODEL,
      effort: SPEC_REVIEWER_EFFORT,
      tools: ISSUE_REVIEWER_TOOLS,
      disallowedTools: ISSUE_REVIEWER_DISALLOWED_TOOLS,
    },
    [STANDARDS_REVIEWER_AGENT_NAME]: {
      description:
        "Independent Standards reviewer: checks a finished diff against " +
        "CODING-STANDARDS.md and reports material departures.",
      prompt: STANDARDS_REVIEWER_PROMPT,
      model: STANDARDS_REVIEWER_MODEL,
      effort: STANDARDS_REVIEWER_EFFORT,
      tools: ISSUE_REVIEWER_TOOLS,
      disallowedTools: ISSUE_REVIEWER_DISALLOWED_TOOLS,
    },
  };
}

/** The two switches that decide which definitions an `issue` run carries. */
export interface IssueRunAgentSwitches {
  /** Whether {@link isIssueExecutorSplitEnabled} resolved true. */
  executorSplit: boolean;
  /** Whether the host's `issue_reviewer_agents` key is on (Issue #2575). */
  reviewerAgents: boolean;
}

/**
 * Build every `--agents` definition an `issue`-phase run carries.
 *
 * The reviewers ride a run whose `issue_reviewer_agents` key is on; the
 * executor rides a run whose split is on. The two are independent, so either
 * can be piloted without the other.
 *
 * @param switches - The run's resolved switches.
 * @returns The definitions keyed by sub-agent name, or `undefined` when both
 *   switches are off — so such a run emits no `--agents` argument at all and
 *   is byte-for-byte the argv it always was.
 */
export function buildIssueRunAgents(
  switches: IssueRunAgentSwitches,
): Readonly<Record<string, AgentDefinition>> | undefined {
  if (!switches.executorSplit && !switches.reviewerAgents) return undefined;
  return {
    ...(switches.reviewerAgents ? buildIssueReviewerAgents() : {}),
    ...(switches.executorSplit ? buildIssueExecutorAgents() : {}),
  };
}
