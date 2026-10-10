/**
 * The executor sub-agents an `issue`-phase run delegates to when
 * `issue_executor_split` is on (Issue #2342, part of #2320), on the tier
 * `resolveIssueSubAgentTier` resolved for the run (Issue #3401/#3402).
 *
 * A sub-agent with no definition inherits the phase's model — the expensive
 * advisor tier doing work an executor tier does just as well. These
 * definitions are what change that: the **advisor** stays the main session on
 * the phase's model and effort, and hands mechanical edit-and-test work to
 * executors pinned to the run's sub-agent tier (Sonnet or Haiku).
 *
 * A run whose `issue_reviewer_agents` key is on also carries the two
 * independent reviewers (Issue #2575), pinned to a cheaper tier and effort,
 * read-only, and unable to spawn further sub-agents — see
 * {@link buildIssueRunAgents}. The executor is only on a run whose split key
 * resolved on. A Haiku-tier run additionally carries a read-only explorer
 * (Issue #3402), whatever the split and reviewer switches resolved to.
 *
 * Nothing here touches phase routing.
 */

import type { AgentDefinition } from "./agent_provider.ts";
import type { IssueSubAgentTier } from "../types.ts";

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

/**
 * The Haiku-tier executor's model (Issue #3402).
 *
 * `haiku`, against the Sonnet tier's own alias: a Haiku-tier run hands the
 * same mechanical edit-and-test work to the cheapest tier.
 */
export const HAIKU_ISSUE_EXECUTOR_MODEL = "haiku";

/**
 * The Haiku-tier executor's effort (Issue #3402).
 *
 * `high`, against the Sonnet tier's `medium`: the higher effort compensates
 * for the smaller tier's weaker reasoning on the same task.
 */
export const HAIKU_ISSUE_EXECUTOR_EFFORT = "high";

/**
 * The Haiku-tier Standards reviewer's model (Issue #3402).
 *
 * `haiku`, against the Sonnet tier's own alias.
 */
export const HAIKU_STANDARDS_REVIEWER_MODEL = "haiku";

/**
 * The Haiku-tier Standards reviewer's effort (Issue #3402).
 *
 * `medium`, against the Sonnet tier's `low`: the higher effort compensates
 * for the smaller tier's weaker reasoning on the same task.
 */
export const HAIKU_STANDARDS_REVIEWER_EFFORT = "medium";

/**
 * Guidance appended to every Haiku-tier sub-agent's prompt (Issue #3402).
 *
 * Haiku 5.5 needs an explicit scope and stop condition and benefits from
 * being told to report findings rather than file dumps — Sonnet-tier
 * sub-agents need neither, so this is never appended to their prompts.
 */
export const HAIKU_SUB_AGENT_GUIDANCE = [
  "Haiku guidance:",
  "- Work to an explicit scope and stop condition: do only what the task " +
  "names, and stop once it is done. If the task left either unstated, " +
  "write the scope and stop condition you are working to at the top of " +
  "your reply.",
  "- Return findings, not file dumps: name each `file:line` and quote only " +
  "the lines that matter.",
].join("\n");

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

/** The executor's prompt on the Haiku tier — the Sonnet prompt plus guidance. */
const HAIKU_ISSUE_EXECUTOR_PROMPT = ISSUE_EXECUTOR_PROMPT + "\n\n" +
  HAIKU_SUB_AGENT_GUIDANCE;

/**
 * Build the `--agents` definitions for a split `issue`-phase run.
 *
 * Called only when {@link isIssueExecutorSplitEnabled} has already resolved
 * true; the caller passes the result as `agents` on the invocation, and an
 * invocation without it emits no `--agents` argument at all.
 *
 * @param tier - The run's resolved sub-agent tier.
 * @returns The executor definition, keyed by sub-agent name.
 */
export function buildIssueExecutorAgents(
  tier: IssueSubAgentTier,
): Readonly<Record<string, AgentDefinition>> {
  return {
    [ISSUE_EXECUTOR_AGENT_NAME]: {
      description:
        "Applies a given set of code edits and runs the tests covering the " +
        "files it edited. Use for mechanical implementation work once the " +
        "change is decided.",
      prompt: tier === "haiku"
        ? HAIKU_ISSUE_EXECUTOR_PROMPT
        : ISSUE_EXECUTOR_PROMPT,
      model: tier === "haiku"
        ? HAIKU_ISSUE_EXECUTOR_MODEL
        : ISSUE_EXECUTOR_MODEL,
      effort: tier === "haiku"
        ? HAIKU_ISSUE_EXECUTOR_EFFORT
        : ISSUE_EXECUTOR_EFFORT,
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
  "A helper, component or policy the issue says to reuse is a stated " +
  "requirement (Issue #3084): a diff that re-implements it by hand instead " +
  "of calling it is not `met`.",
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
  "- Three departures are always a `violation` (Issues #3011, #3021): a " +
  "named-but-absent test — a comment, anchor or test reference in the " +
  "diff naming a test file that is neither in the diff nor in the " +
  "repository; a test stub for another repository's binary or " +
  "script that is more permissive than the real callee — it reads " +
  "different inputs or exits 0 where the callee fails — with no " +
  "real-checkout run and no named contract source; and a workflow " +
  "invariant documented but not validated — a `.github/workflows/*` " +
  "behaviour change the diff's README, comment or PR summary treats as " +
  "load-bearing, which the repository's workflow validator does not " +
  "assert with a negative test.",
  "- A rule the repository's standards say is enforced by review — no " +
  'lint, formatter or CI check catches it, in words such as "by review ' +
  'only" or "a finding a reader has to raise" — is a `violation` ' +
  "whenever a line the diff adds or changes breaches it, whatever its " +
  "effect on correctness: the review is its only enforcement (Issue " +
  "#3230). A review-enforced rule is never `optional`, however " +
  "stylistic it looks.",
  "- List any other departure (style, naming, taste) under `optional`, one " +
  "line each. Those are not violations and are not to be chased.",
  "- Name the `clean` areas you checked and found compliant, naming each " +
  "review-enforced rule you checked, so a rule you skipped shows.",
  "",
  "You are read-only and cannot spawn sub-agents. Do the review yourself.",
].join("\n");

/**
 * The Standards reviewer's prompt on the Haiku tier — the Sonnet prompt plus
 * guidance.
 */
const HAIKU_STANDARDS_REVIEWER_PROMPT = STANDARDS_REVIEWER_PROMPT + "\n\n" +
  HAIKU_SUB_AGENT_GUIDANCE;

/**
 * Build the two reviewer definitions (Issue #2575).
 *
 * The Spec reviewer stays on Sonnet at every tier: judging whether each
 * criterion is met is still judgement, which the smaller tier is not asked
 * to carry (Issue #3402). The Standards reviewer, which checks a diff
 * against one written document, moves to the run's resolved tier.
 *
 * @param tier - The run's resolved sub-agent tier.
 * @returns The Spec and Standards reviewer definitions, keyed by name.
 */
export function buildIssueReviewerAgents(
  tier: IssueSubAgentTier,
): Readonly<Record<string, AgentDefinition>> {
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
      prompt: tier === "haiku"
        ? HAIKU_STANDARDS_REVIEWER_PROMPT
        : STANDARDS_REVIEWER_PROMPT,
      model: tier === "haiku"
        ? HAIKU_STANDARDS_REVIEWER_MODEL
        : STANDARDS_REVIEWER_MODEL,
      effort: tier === "haiku"
        ? HAIKU_STANDARDS_REVIEWER_EFFORT
        : STANDARDS_REVIEWER_EFFORT,
      tools: ISSUE_REVIEWER_TOOLS,
      disallowedTools: ISSUE_REVIEWER_DISALLOWED_TOOLS,
    },
  };
}

// ---------------------------------------------------------------------------
// The read-only explorer (Issue #3402, Haiku tier only)
// ---------------------------------------------------------------------------

/** The sub-agent name the CLI routes read-only lookups to. */
export const EXPLORER_AGENT_NAME = "explorer";

/** The explorer's model — always Haiku; it only ever rides a Haiku-tier run. */
export const EXPLORER_MODEL = "haiku";

/** The explorer's effort. */
export const EXPLORER_EFFORT = "medium";

/** Exactly the tools an explorer needs to look things up, nothing else. */
export const EXPLORER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * Tools the explorer must not use, whatever {@link EXPLORER_TOOLS} grants.
 * `Agent` is denied so it cannot spawn further sub-agents.
 */
export const EXPLORER_DISALLOWED_TOOLS: readonly string[] = ["Agent"];

/** The explorer's own system prompt. */
const EXPLORER_PROMPT = [
  "You are a read-only explorer sub-agent on an issue-work run. You are " +
  "given a lookup to answer — where code lives, who calls what, what a " +
  "function does — and answer exactly that lookup.",
  "",
  "- Report `file:line` for each thing you found, and quote only the few " +
  "lines that matter.",
  "- You change nothing: no edits, no commands.",
  "- You cannot spawn further sub-agents. Do the lookup yourself.",
  "",
  HAIKU_SUB_AGENT_GUIDANCE,
].join("\n");

/**
 * Build the explorer definition (Issue #3402).
 *
 * Carried by every Haiku-tier `issue` run, whatever the executor-split and
 * reviewer switches resolved to: the advisor hands it read-only lookups
 * instead of spending its own context reading code.
 *
 * @returns The explorer definition, keyed by sub-agent name.
 */
export function buildIssueExplorerAgents(): Readonly<
  Record<string, AgentDefinition>
> {
  return {
    [EXPLORER_AGENT_NAME]: {
      description:
        "Read-only codebase lookups: finds where code lives and what it " +
        "does, and returns findings with file:line, not file dumps. Cannot " +
        "edit files or run commands.",
      prompt: EXPLORER_PROMPT,
      model: EXPLORER_MODEL,
      effort: EXPLORER_EFFORT,
      tools: EXPLORER_TOOLS,
      disallowedTools: EXPLORER_DISALLOWED_TOOLS,
    },
  };
}

/** The switches that decide which definitions an `issue` run carries. */
export interface IssueRunAgentSwitches {
  /** Whether {@link isIssueExecutorSplitEnabled} resolved true. */
  executorSplit: boolean;
  /** Whether the host's `issue_reviewer_agents` key is on (Issue #2575). */
  reviewerAgents: boolean;
  /**
   * The tier `resolveIssueSubAgentTier` resolved for this run (Issue #3402).
   * Decides the executor's and Standards reviewer's model and effort, and
   * whether the run carries the read-only explorer.
   */
  subAgentTier: IssueSubAgentTier;
}

/**
 * Build every `--agents` definition an `issue`-phase run carries.
 *
 * The reviewers ride a run whose `issue_reviewer_agents` key is on; the
 * executor rides a run whose split is on; the explorer rides every Haiku-tier
 * run, whatever the other two resolved to. The switches are independent of
 * each other.
 *
 * @param switches - The run's resolved switches.
 * @returns The definitions keyed by sub-agent name, or `undefined` when both
 *   the split and reviewer switches are off and the tier is `sonnet` — so
 *   such a run emits no `--agents` argument at all and is byte-for-byte the
 *   argv it always was.
 */
export function buildIssueRunAgents(
  switches: IssueRunAgentSwitches,
): Readonly<Record<string, AgentDefinition>> | undefined {
  const isHaiku = switches.subAgentTier === "haiku";
  if (!switches.executorSplit && !switches.reviewerAgents && !isHaiku) {
    return undefined;
  }
  return {
    ...(switches.reviewerAgents
      ? buildIssueReviewerAgents(switches.subAgentTier)
      : {}),
    ...(switches.executorSplit
      ? buildIssueExecutorAgents(switches.subAgentTier)
      : {}),
    ...(isHaiku ? buildIssueExplorerAgents() : {}),
  };
}
