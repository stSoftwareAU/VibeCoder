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
 * independent reviewers (Issue #2575), pinned to Opus at every tier (owner
 * decision 2026-10-22: Opus does the code reviews), read-only, and unable to
 * spawn further sub-agents — see
 * {@link buildIssueRunAgents}. The executor is only on a run whose split key
 * resolved on. A Haiku-tier run additionally carries a read-only explorer
 * (Issue #3402), whatever the split and reviewer switches resolved to.
 *
 * Nothing here touches phase routing.
 */ /** The sub-agent name the CLI routes executor work to. */ export const ISSUE_EXECUTOR_AGENT_NAME = "executor";
/**
 * The tier the executors run on.
 *
 * The **alias**, not a pinned id: every Claude default in this worker is a
 * tier alias (see `docs/MODEL-AND-CACHING.md`), so the CLI resolves it from
 * its own bundled table and a new Sonnet release needs no change here. Sonnet
 * is the tier priced at $2/$10 per MTok in that document — cheaper than the
 * advisor's tier, which is the whole point of the split.
 */ export const ISSUE_EXECUTOR_MODEL = "sonnet";
/**
 * The effort the executors run at.
 *
 * `medium`, against the advisor's `high`: an executor is handed the edits to
 * make rather than asked to decide what they should be, so the reasoning
 * depth the advisor needs would be spent on work that does not use it.
 */ export const ISSUE_EXECUTOR_EFFORT = "medium";
/**
 * The Haiku-tier executor's model (Issue #3402).
 *
 * `haiku`, against the Sonnet tier's own alias: a Haiku-tier run hands the
 * same mechanical edit-and-test work to the cheapest tier.
 */ export const HAIKU_ISSUE_EXECUTOR_MODEL = "haiku";
/**
 * The Haiku-tier executor's effort (Issue #3402).
 *
 * `high`, against the Sonnet tier's `medium`: the higher effort compensates
 * for the smaller tier's weaker reasoning on the same task.
 */ export const HAIKU_ISSUE_EXECUTOR_EFFORT = "high";
/**
 * Guidance appended to every Haiku-tier sub-agent's prompt (Issue #3402).
 *
 * Haiku 5.5 needs an explicit scope and stop condition and benefits from
 * being told to report findings rather than file dumps — Sonnet-tier
 * sub-agents need neither, so this is never appended to their prompts.
 */ export const HAIKU_SUB_AGENT_GUIDANCE = [
  "Haiku guidance:",
  "- Work to an explicit scope and stop condition: do only what the task " + "names, and stop once it is done. If the task left either unstated, " + "write the scope and stop condition you are working to at the top of " + "your reply.",
  "- Return findings, not file dumps: name each `file:line` and quote only " + "the lines that matter."
].join("\n");
/** Exactly the tools an executor needs to edit files and run the tests. */ export const ISSUE_EXECUTOR_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash"
];
/**
 * Tools an executor must not use, whatever {@link ISSUE_EXECUTOR_TOOLS}
 * grants.
 *
 * `Agent` is denied so an executor cannot spawn further sub-agents: the split
 * is one advisor delegating to executors, and an executor that can delegate
 * again turns a bounded two-tier run into an unbounded tree.
 */ export const ISSUE_EXECUTOR_DISALLOWED_TOOLS = [
  "Agent"
];
/** The executor's own system prompt. */ const ISSUE_EXECUTOR_PROMPT = [
  "You are an executor sub-agent on an issue-work run. You are handed a " + "specific set of edits to make; make exactly those edits and nothing more.",
  "",
  "- Apply the edits you were given. Do not redesign the approach, refactor " + "adjacent code, or add behaviour nobody asked for — if the instructions " + "look wrong, say so in your reply rather than substituting your own plan.",
  "- After editing, run the tests that cover the files you edited, with " + "stdin redirected from /dev/null. Run those tests, not the full suite.",
  "- Report what you changed and the exact test output you saw. A failing " + "test is reported as failing — never as a pass, and never worked around " + "by weakening the test.",
  "- You cannot spawn further sub-agents. Work the task yourself."
].join("\n");
/** The executor's prompt on the Haiku tier — the Sonnet prompt plus guidance. */ const HAIKU_ISSUE_EXECUTOR_PROMPT = ISSUE_EXECUTOR_PROMPT + "\n\n" + HAIKU_SUB_AGENT_GUIDANCE;
/**
 * Build the `--agents` definitions for a split `issue`-phase run.
 *
 * Called only when {@link isIssueExecutorSplitEnabled} has already resolved
 * true; the caller passes the result as `agents` on the invocation, and an
 * invocation without it emits no `--agents` argument at all.
 *
 * @param tier - The run's resolved sub-agent tier.
 * @returns The executor definition, keyed by sub-agent name.
 */ export function buildIssueExecutorAgents(tier) {
  return {
    [ISSUE_EXECUTOR_AGENT_NAME]: {
      description: "Applies a given set of code edits and runs the tests covering the " + "files it edited. Use for mechanical implementation work once the " + "change is decided.",
      prompt: tier === "haiku" ? HAIKU_ISSUE_EXECUTOR_PROMPT : ISSUE_EXECUTOR_PROMPT,
      model: tier === "haiku" ? HAIKU_ISSUE_EXECUTOR_MODEL : ISSUE_EXECUTOR_MODEL,
      effort: tier === "haiku" ? HAIKU_ISSUE_EXECUTOR_EFFORT : ISSUE_EXECUTOR_EFFORT,
      tools: ISSUE_EXECUTOR_TOOLS,
      disallowedTools: ISSUE_EXECUTOR_DISALLOWED_TOOLS
    }
  };
}
// ---------------------------------------------------------------------------
// The independent reviewers (Issue #2575)
// ---------------------------------------------------------------------------
/** The sub-agent name the issue prompt dispatches the Spec reviewer as. */ export const SPEC_REVIEWER_AGENT_NAME = "spec-reviewer";
/** The sub-agent name the issue prompt dispatches the Standards reviewer as. */ export const STANDARDS_REVIEWER_AGENT_NAME = "standards-reviewer";
/**
 * The Spec reviewer's tier and effort.
 *
 * Opus at `medium`, at every executor tier: the owner's decision of
 * 2026-10-22 is that Opus does the code reviews, Sonnet manages and Haiku
 * executes. The review is what keeps merged quality high, and a send-back
 * round costs more than the review. The reviewer's independence still comes
 * from its fresh context; `medium` rather than the advisor's `high` because
 * it judges a finished diff rather than planning one.
 */ export const SPEC_REVIEWER_MODEL = "opus";
export const SPEC_REVIEWER_EFFORT = "medium";
/**
 * The Standards reviewer's tier and effort.
 *
 * Opus at `medium`, at every executor tier, for the same owner decision as
 * {@link SPEC_REVIEWER_MODEL}. It used to follow the run's sub-agent tier
 * down to Haiku (Issue #3402); a review is no longer the place the tier
 * saves money.
 */ export const STANDARDS_REVIEWER_MODEL = "opus";
export const STANDARDS_REVIEWER_EFFORT = "medium";
/**
 * Read-only tools: a reviewer reads the diff file, the standards and the code
 * the diff touches, and changes nothing. No `Bash` either — the advisor
 * writes the diff to a file and hands the reviewer its path.
 */ export const ISSUE_REVIEWER_TOOLS = [
  "Read",
  "Grep",
  "Glob"
];
/**
 * Tools a reviewer must not use. `Agent` is denied so a reviewer cannot spawn
 * reviewers of its own, whatever {@link ISSUE_REVIEWER_TOOLS} grants.
 */ export const ISSUE_REVIEWER_DISALLOWED_TOOLS = [
  "Agent"
];
/** The Spec reviewer's own system prompt. */ const SPEC_REVIEWER_PROMPT = [
  "You are the independent Spec reviewer on an issue-work run. You are " + "given the path of a diff file and the issue body, verbatim, and nothing " + "of the author's reasoning. Judge the diff against the issue body only.",
  "",
  "Answer three questions, and only these:",
  "1. Which stated requirements are missing or partial?",
  "2. What behaviour is in the diff that was not asked for (scope creep)?",
  "3. Which requirements look implemented but are implemented wrongly?",
  "",
  "Return one `met` / `partial` / `missing` verdict per stated acceptance " + "criterion, with the evidence you saw (a file, a test name), and one " + "`unrequested` entry per change you cannot trace to the issue. Flag only " + "gaps that affect correctness or the stated requirements; do not propose " + "improvements the issue did not ask for.",
  "",
  "A helper, component or policy the issue says to reuse is a stated " + "requirement (Issue #3084): a diff that re-implements it by hand instead " + "of calling it is not `met`.",
  "",
  "You are read-only and cannot spawn sub-agents. Do the review yourself."
].join("\n");
/** The Standards reviewer's own system prompt. */ const STANDARDS_REVIEWER_PROMPT = [
  "You are the independent Standards reviewer on an issue-work run. You are " + "given the path of a diff file; read it and the repository's " + "`CODING-STANDARDS.md`, and nothing of the author's reasoning.",
  "",
  "One question: where does the diff depart from a documented standard in " + "a way that affects correctness, security or the stated requirements?",
  "",
  "- Return one `violation` entry per such departure, naming the standard " + "and the `file:line` you saw. A `violation` must cite a rule that is " + "written in `CODING-STANDARDS.md` — never a preference of your own.",
  "- Three departures are always a `violation` (Issues #3011, #3021): a " + "named-but-absent test — a comment, anchor or test reference in the " + "diff naming a test file that is neither in the diff nor in the " + "repository; a test stub for another repository's binary or " + "script that is more permissive than the real callee — it reads " + "different inputs or exits 0 where the callee fails — with no " + "real-checkout run and no named contract source; and a workflow " + "invariant documented but not validated — a `.github/workflows/*` " + "behaviour change the diff's README, comment or PR summary treats as " + "load-bearing, which the repository's workflow validator does not " + "assert with a negative test.",
  "- A rule the repository's standards say is enforced by review — no " + 'lint, formatter or CI check catches it, in words such as "by review ' + 'only" or "a finding a reader has to raise" — is a `violation` ' + "whenever a line the diff adds or changes breaches it, whatever its " + "effect on correctness: the review is its only enforcement (Issue " + "#3230). A review-enforced rule is never `optional`, however " + "stylistic it looks.",
  "- List any other departure (style, naming, taste) under `optional`, one " + "line each. Those are not violations and are not to be chased.",
  "- Name the `clean` areas you checked and found compliant, naming each " + "review-enforced rule you checked, so a rule you skipped shows.",
  "",
  "You are read-only and cannot spawn sub-agents. Do the review yourself."
].join("\n");
/**
 * Build the two reviewer definitions (Issue #2575).
 *
 * Both reviewers run on Opus whatever the run's sub-agent tier resolved to
 * (owner decision 2026-10-22): the tier picks the executor's model, never the
 * reviewers'.
 *
 * @returns The Spec and Standards reviewer definitions, keyed by name.
 */ export function buildIssueReviewerAgents() {
  return {
    [SPEC_REVIEWER_AGENT_NAME]: {
      description: "Independent Spec reviewer: judges a finished diff against the " + "issue body, one verdict per acceptance criterion.",
      prompt: SPEC_REVIEWER_PROMPT,
      model: SPEC_REVIEWER_MODEL,
      effort: SPEC_REVIEWER_EFFORT,
      tools: ISSUE_REVIEWER_TOOLS,
      disallowedTools: ISSUE_REVIEWER_DISALLOWED_TOOLS
    },
    [STANDARDS_REVIEWER_AGENT_NAME]: {
      description: "Independent Standards reviewer: checks a finished diff against " + "CODING-STANDARDS.md and reports material departures.",
      prompt: STANDARDS_REVIEWER_PROMPT,
      model: STANDARDS_REVIEWER_MODEL,
      effort: STANDARDS_REVIEWER_EFFORT,
      tools: ISSUE_REVIEWER_TOOLS,
      disallowedTools: ISSUE_REVIEWER_DISALLOWED_TOOLS
    }
  };
}
// ---------------------------------------------------------------------------
// The read-only explorer (Issue #3402, Haiku tier only)
// ---------------------------------------------------------------------------
/** The sub-agent name the CLI routes read-only lookups to. */ export const EXPLORER_AGENT_NAME = "explorer";
/** The explorer's model — always Haiku; it only ever rides a Haiku-tier run. */ export const EXPLORER_MODEL = "haiku";
/** The explorer's effort. */ export const EXPLORER_EFFORT = "medium";
/** Exactly the tools an explorer needs to look things up, nothing else. */ export const EXPLORER_TOOLS = [
  "Read",
  "Grep",
  "Glob"
];
/**
 * Tools the explorer must not use, whatever {@link EXPLORER_TOOLS} grants.
 * `Agent` is denied so it cannot spawn further sub-agents.
 */ export const EXPLORER_DISALLOWED_TOOLS = [
  "Agent"
];
/** The explorer's own system prompt. */ const EXPLORER_PROMPT = [
  "You are a read-only explorer sub-agent on an issue-work run. You are " + "given a lookup to answer — where code lives, who calls what, what a " + "function does — and answer exactly that lookup.",
  "",
  "- Report `file:line` for each thing you found, and quote only the few " + "lines that matter.",
  "- You change nothing: no edits, no commands.",
  "- You cannot spawn further sub-agents. Do the lookup yourself.",
  "",
  HAIKU_SUB_AGENT_GUIDANCE
].join("\n");
/**
 * Build the explorer definition (Issue #3402).
 *
 * Carried by every Haiku-tier `issue` run, whatever the executor-split and
 * reviewer switches resolved to: the advisor hands it read-only lookups
 * instead of spending its own context reading code.
 *
 * @returns The explorer definition, keyed by sub-agent name.
 */ export function buildIssueExplorerAgents() {
  return {
    [EXPLORER_AGENT_NAME]: {
      description: "Read-only codebase lookups: finds where code lives and what it " + "does, and returns findings with file:line, not file dumps. Cannot " + "edit files or run commands.",
      prompt: EXPLORER_PROMPT,
      model: EXPLORER_MODEL,
      effort: EXPLORER_EFFORT,
      tools: EXPLORER_TOOLS,
      disallowedTools: EXPLORER_DISALLOWED_TOOLS
    }
  };
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
 */ export function buildIssueRunAgents(switches) {
  const isHaiku = switches.subAgentTier === "haiku";
  if (!switches.executorSplit && !switches.reviewerAgents && !isHaiku) {
    return undefined;
  }
  return {
    ...switches.reviewerAgents ? buildIssueReviewerAgents() : {},
    ...switches.executorSplit ? buildIssueExecutorAgents(switches.subAgentTier) : {},
    ...isHaiku ? buildIssueExplorerAgents() : {}
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9leGVjdXRvcl9hZ2VudHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgZXhlY3V0b3Igc3ViLWFnZW50cyBhbiBgaXNzdWVgLXBoYXNlIHJ1biBkZWxlZ2F0ZXMgdG8gd2hlblxuICogYGlzc3VlX2V4ZWN1dG9yX3NwbGl0YCBpcyBvbiAoSXNzdWUgIzIzNDIsIHBhcnQgb2YgIzIzMjApLCBvbiB0aGUgdGllclxuICogYHJlc29sdmVJc3N1ZVN1YkFnZW50VGllcmAgcmVzb2x2ZWQgZm9yIHRoZSBydW4gKElzc3VlICMzNDAxLyMzNDAyKS5cbiAqXG4gKiBBIHN1Yi1hZ2VudCB3aXRoIG5vIGRlZmluaXRpb24gaW5oZXJpdHMgdGhlIHBoYXNlJ3MgbW9kZWwg4oCUIHRoZSBleHBlbnNpdmVcbiAqIGFkdmlzb3IgdGllciBkb2luZyB3b3JrIGFuIGV4ZWN1dG9yIHRpZXIgZG9lcyBqdXN0IGFzIHdlbGwuIFRoZXNlXG4gKiBkZWZpbml0aW9ucyBhcmUgd2hhdCBjaGFuZ2UgdGhhdDogdGhlICoqYWR2aXNvcioqIHN0YXlzIHRoZSBtYWluIHNlc3Npb24gb25cbiAqIHRoZSBwaGFzZSdzIG1vZGVsIGFuZCBlZmZvcnQsIGFuZCBoYW5kcyBtZWNoYW5pY2FsIGVkaXQtYW5kLXRlc3Qgd29yayB0b1xuICogZXhlY3V0b3JzIHBpbm5lZCB0byB0aGUgcnVuJ3Mgc3ViLWFnZW50IHRpZXIgKFNvbm5ldCBvciBIYWlrdSkuXG4gKlxuICogQSBydW4gd2hvc2UgYGlzc3VlX3Jldmlld2VyX2FnZW50c2Aga2V5IGlzIG9uIGFsc28gY2FycmllcyB0aGUgdHdvXG4gKiBpbmRlcGVuZGVudCByZXZpZXdlcnMgKElzc3VlICMyNTc1KSwgcGlubmVkIHRvIE9wdXMgYXQgZXZlcnkgdGllciAob3duZXJcbiAqIGRlY2lzaW9uIDIwMjYtMTAtMjI6IE9wdXMgZG9lcyB0aGUgY29kZSByZXZpZXdzKSwgcmVhZC1vbmx5LCBhbmQgdW5hYmxlIHRvXG4gKiBzcGF3biBmdXJ0aGVyIHN1Yi1hZ2VudHMg4oCUIHNlZVxuICoge0BsaW5rIGJ1aWxkSXNzdWVSdW5BZ2VudHN9LiBUaGUgZXhlY3V0b3IgaXMgb25seSBvbiBhIHJ1biB3aG9zZSBzcGxpdCBrZXlcbiAqIHJlc29sdmVkIG9uLiBBIEhhaWt1LXRpZXIgcnVuIGFkZGl0aW9uYWxseSBjYXJyaWVzIGEgcmVhZC1vbmx5IGV4cGxvcmVyXG4gKiAoSXNzdWUgIzM0MDIpLCB3aGF0ZXZlciB0aGUgc3BsaXQgYW5kIHJldmlld2VyIHN3aXRjaGVzIHJlc29sdmVkIHRvLlxuICpcbiAqIE5vdGhpbmcgaGVyZSB0b3VjaGVzIHBoYXNlIHJvdXRpbmcuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBBZ2VudERlZmluaXRpb24gfSBmcm9tIFwiLi9hZ2VudF9wcm92aWRlci50c1wiO1xuaW1wb3J0IHR5cGUgeyBJc3N1ZVN1YkFnZW50VGllciB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG4vKiogVGhlIHN1Yi1hZ2VudCBuYW1lIHRoZSBDTEkgcm91dGVzIGV4ZWN1dG9yIHdvcmsgdG8uICovXG5leHBvcnQgY29uc3QgSVNTVUVfRVhFQ1VUT1JfQUdFTlRfTkFNRSA9IFwiZXhlY3V0b3JcIjtcblxuLyoqXG4gKiBUaGUgdGllciB0aGUgZXhlY3V0b3JzIHJ1biBvbi5cbiAqXG4gKiBUaGUgKiphbGlhcyoqLCBub3QgYSBwaW5uZWQgaWQ6IGV2ZXJ5IENsYXVkZSBkZWZhdWx0IGluIHRoaXMgd29ya2VyIGlzIGFcbiAqIHRpZXIgYWxpYXMgKHNlZSBgZG9jcy9NT0RFTC1BTkQtQ0FDSElORy5tZGApLCBzbyB0aGUgQ0xJIHJlc29sdmVzIGl0IGZyb21cbiAqIGl0cyBvd24gYnVuZGxlZCB0YWJsZSBhbmQgYSBuZXcgU29ubmV0IHJlbGVhc2UgbmVlZHMgbm8gY2hhbmdlIGhlcmUuIFNvbm5ldFxuICogaXMgdGhlIHRpZXIgcHJpY2VkIGF0ICQyLyQxMCBwZXIgTVRvayBpbiB0aGF0IGRvY3VtZW50IOKAlCBjaGVhcGVyIHRoYW4gdGhlXG4gKiBhZHZpc29yJ3MgdGllciwgd2hpY2ggaXMgdGhlIHdob2xlIHBvaW50IG9mIHRoZSBzcGxpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IElTU1VFX0VYRUNVVE9SX01PREVMID0gXCJzb25uZXRcIjtcblxuLyoqXG4gKiBUaGUgZWZmb3J0IHRoZSBleGVjdXRvcnMgcnVuIGF0LlxuICpcbiAqIGBtZWRpdW1gLCBhZ2FpbnN0IHRoZSBhZHZpc29yJ3MgYGhpZ2hgOiBhbiBleGVjdXRvciBpcyBoYW5kZWQgdGhlIGVkaXRzIHRvXG4gKiBtYWtlIHJhdGhlciB0aGFuIGFza2VkIHRvIGRlY2lkZSB3aGF0IHRoZXkgc2hvdWxkIGJlLCBzbyB0aGUgcmVhc29uaW5nXG4gKiBkZXB0aCB0aGUgYWR2aXNvciBuZWVkcyB3b3VsZCBiZSBzcGVudCBvbiB3b3JrIHRoYXQgZG9lcyBub3QgdXNlIGl0LlxuICovXG5leHBvcnQgY29uc3QgSVNTVUVfRVhFQ1VUT1JfRUZGT1JUID0gXCJtZWRpdW1cIjtcblxuLyoqXG4gKiBUaGUgSGFpa3UtdGllciBleGVjdXRvcidzIG1vZGVsIChJc3N1ZSAjMzQwMikuXG4gKlxuICogYGhhaWt1YCwgYWdhaW5zdCB0aGUgU29ubmV0IHRpZXIncyBvd24gYWxpYXM6IGEgSGFpa3UtdGllciBydW4gaGFuZHMgdGhlXG4gKiBzYW1lIG1lY2hhbmljYWwgZWRpdC1hbmQtdGVzdCB3b3JrIHRvIHRoZSBjaGVhcGVzdCB0aWVyLlxuICovXG5leHBvcnQgY29uc3QgSEFJS1VfSVNTVUVfRVhFQ1VUT1JfTU9ERUwgPSBcImhhaWt1XCI7XG5cbi8qKlxuICogVGhlIEhhaWt1LXRpZXIgZXhlY3V0b3IncyBlZmZvcnQgKElzc3VlICMzNDAyKS5cbiAqXG4gKiBgaGlnaGAsIGFnYWluc3QgdGhlIFNvbm5ldCB0aWVyJ3MgYG1lZGl1bWA6IHRoZSBoaWdoZXIgZWZmb3J0IGNvbXBlbnNhdGVzXG4gKiBmb3IgdGhlIHNtYWxsZXIgdGllcidzIHdlYWtlciByZWFzb25pbmcgb24gdGhlIHNhbWUgdGFzay5cbiAqL1xuZXhwb3J0IGNvbnN0IEhBSUtVX0lTU1VFX0VYRUNVVE9SX0VGRk9SVCA9IFwiaGlnaFwiO1xuXG4vKipcbiAqIEd1aWRhbmNlIGFwcGVuZGVkIHRvIGV2ZXJ5IEhhaWt1LXRpZXIgc3ViLWFnZW50J3MgcHJvbXB0IChJc3N1ZSAjMzQwMikuXG4gKlxuICogSGFpa3UgNS41IG5lZWRzIGFuIGV4cGxpY2l0IHNjb3BlIGFuZCBzdG9wIGNvbmRpdGlvbiBhbmQgYmVuZWZpdHMgZnJvbVxuICogYmVpbmcgdG9sZCB0byByZXBvcnQgZmluZGluZ3MgcmF0aGVyIHRoYW4gZmlsZSBkdW1wcyDigJQgU29ubmV0LXRpZXJcbiAqIHN1Yi1hZ2VudHMgbmVlZCBuZWl0aGVyLCBzbyB0aGlzIGlzIG5ldmVyIGFwcGVuZGVkIHRvIHRoZWlyIHByb21wdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBIQUlLVV9TVUJfQUdFTlRfR1VJREFOQ0UgPSBbXG4gIFwiSGFpa3UgZ3VpZGFuY2U6XCIsXG4gIFwiLSBXb3JrIHRvIGFuIGV4cGxpY2l0IHNjb3BlIGFuZCBzdG9wIGNvbmRpdGlvbjogZG8gb25seSB3aGF0IHRoZSB0YXNrIFwiICtcbiAgXCJuYW1lcywgYW5kIHN0b3Agb25jZSBpdCBpcyBkb25lLiBJZiB0aGUgdGFzayBsZWZ0IGVpdGhlciB1bnN0YXRlZCwgXCIgK1xuICBcIndyaXRlIHRoZSBzY29wZSBhbmQgc3RvcCBjb25kaXRpb24geW91IGFyZSB3b3JraW5nIHRvIGF0IHRoZSB0b3Agb2YgXCIgK1xuICBcInlvdXIgcmVwbHkuXCIsXG4gIFwiLSBSZXR1cm4gZmluZGluZ3MsIG5vdCBmaWxlIGR1bXBzOiBuYW1lIGVhY2ggYGZpbGU6bGluZWAgYW5kIHF1b3RlIG9ubHkgXCIgK1xuICBcInRoZSBsaW5lcyB0aGF0IG1hdHRlci5cIixcbl0uam9pbihcIlxcblwiKTtcblxuLyoqIEV4YWN0bHkgdGhlIHRvb2xzIGFuIGV4ZWN1dG9yIG5lZWRzIHRvIGVkaXQgZmlsZXMgYW5kIHJ1biB0aGUgdGVzdHMuICovXG5leHBvcnQgY29uc3QgSVNTVUVfRVhFQ1VUT1JfVE9PTFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIlJlYWRcIixcbiAgXCJHcmVwXCIsXG4gIFwiR2xvYlwiLFxuICBcIkVkaXRcIixcbiAgXCJXcml0ZVwiLFxuICBcIkJhc2hcIixcbl07XG5cbi8qKlxuICogVG9vbHMgYW4gZXhlY3V0b3IgbXVzdCBub3QgdXNlLCB3aGF0ZXZlciB7QGxpbmsgSVNTVUVfRVhFQ1VUT1JfVE9PTFN9XG4gKiBncmFudHMuXG4gKlxuICogYEFnZW50YCBpcyBkZW5pZWQgc28gYW4gZXhlY3V0b3IgY2Fubm90IHNwYXduIGZ1cnRoZXIgc3ViLWFnZW50czogdGhlIHNwbGl0XG4gKiBpcyBvbmUgYWR2aXNvciBkZWxlZ2F0aW5nIHRvIGV4ZWN1dG9ycywgYW5kIGFuIGV4ZWN1dG9yIHRoYXQgY2FuIGRlbGVnYXRlXG4gKiBhZ2FpbiB0dXJucyBhIGJvdW5kZWQgdHdvLXRpZXIgcnVuIGludG8gYW4gdW5ib3VuZGVkIHRyZWUuXG4gKi9cbmV4cG9ydCBjb25zdCBJU1NVRV9FWEVDVVRPUl9ESVNBTExPV0VEX1RPT0xTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcIkFnZW50XCJdO1xuXG4vKiogVGhlIGV4ZWN1dG9yJ3Mgb3duIHN5c3RlbSBwcm9tcHQuICovXG5jb25zdCBJU1NVRV9FWEVDVVRPUl9QUk9NUFQgPSBbXG4gIFwiWW91IGFyZSBhbiBleGVjdXRvciBzdWItYWdlbnQgb24gYW4gaXNzdWUtd29yayBydW4uIFlvdSBhcmUgaGFuZGVkIGEgXCIgK1xuICBcInNwZWNpZmljIHNldCBvZiBlZGl0cyB0byBtYWtlOyBtYWtlIGV4YWN0bHkgdGhvc2UgZWRpdHMgYW5kIG5vdGhpbmcgbW9yZS5cIixcbiAgXCJcIixcbiAgXCItIEFwcGx5IHRoZSBlZGl0cyB5b3Ugd2VyZSBnaXZlbi4gRG8gbm90IHJlZGVzaWduIHRoZSBhcHByb2FjaCwgcmVmYWN0b3IgXCIgK1xuICBcImFkamFjZW50IGNvZGUsIG9yIGFkZCBiZWhhdmlvdXIgbm9ib2R5IGFza2VkIGZvciDigJQgaWYgdGhlIGluc3RydWN0aW9ucyBcIiArXG4gIFwibG9vayB3cm9uZywgc2F5IHNvIGluIHlvdXIgcmVwbHkgcmF0aGVyIHRoYW4gc3Vic3RpdHV0aW5nIHlvdXIgb3duIHBsYW4uXCIsXG4gIFwiLSBBZnRlciBlZGl0aW5nLCBydW4gdGhlIHRlc3RzIHRoYXQgY292ZXIgdGhlIGZpbGVzIHlvdSBlZGl0ZWQsIHdpdGggXCIgK1xuICBcInN0ZGluIHJlZGlyZWN0ZWQgZnJvbSAvZGV2L251bGwuIFJ1biB0aG9zZSB0ZXN0cywgbm90IHRoZSBmdWxsIHN1aXRlLlwiLFxuICBcIi0gUmVwb3J0IHdoYXQgeW91IGNoYW5nZWQgYW5kIHRoZSBleGFjdCB0ZXN0IG91dHB1dCB5b3Ugc2F3LiBBIGZhaWxpbmcgXCIgK1xuICBcInRlc3QgaXMgcmVwb3J0ZWQgYXMgZmFpbGluZyDigJQgbmV2ZXIgYXMgYSBwYXNzLCBhbmQgbmV2ZXIgd29ya2VkIGFyb3VuZCBcIiArXG4gIFwiYnkgd2Vha2VuaW5nIHRoZSB0ZXN0LlwiLFxuICBcIi0gWW91IGNhbm5vdCBzcGF3biBmdXJ0aGVyIHN1Yi1hZ2VudHMuIFdvcmsgdGhlIHRhc2sgeW91cnNlbGYuXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbi8qKiBUaGUgZXhlY3V0b3IncyBwcm9tcHQgb24gdGhlIEhhaWt1IHRpZXIg4oCUIHRoZSBTb25uZXQgcHJvbXB0IHBsdXMgZ3VpZGFuY2UuICovXG5jb25zdCBIQUlLVV9JU1NVRV9FWEVDVVRPUl9QUk9NUFQgPSBJU1NVRV9FWEVDVVRPUl9QUk9NUFQgKyBcIlxcblxcblwiICtcbiAgSEFJS1VfU1VCX0FHRU5UX0dVSURBTkNFO1xuXG4vKipcbiAqIEJ1aWxkIHRoZSBgLS1hZ2VudHNgIGRlZmluaXRpb25zIGZvciBhIHNwbGl0IGBpc3N1ZWAtcGhhc2UgcnVuLlxuICpcbiAqIENhbGxlZCBvbmx5IHdoZW4ge0BsaW5rIGlzSXNzdWVFeGVjdXRvclNwbGl0RW5hYmxlZH0gaGFzIGFscmVhZHkgcmVzb2x2ZWRcbiAqIHRydWU7IHRoZSBjYWxsZXIgcGFzc2VzIHRoZSByZXN1bHQgYXMgYGFnZW50c2Agb24gdGhlIGludm9jYXRpb24sIGFuZCBhblxuICogaW52b2NhdGlvbiB3aXRob3V0IGl0IGVtaXRzIG5vIGAtLWFnZW50c2AgYXJndW1lbnQgYXQgYWxsLlxuICpcbiAqIEBwYXJhbSB0aWVyIC0gVGhlIHJ1bidzIHJlc29sdmVkIHN1Yi1hZ2VudCB0aWVyLlxuICogQHJldHVybnMgVGhlIGV4ZWN1dG9yIGRlZmluaXRpb24sIGtleWVkIGJ5IHN1Yi1hZ2VudCBuYW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRJc3N1ZUV4ZWN1dG9yQWdlbnRzKFxuICB0aWVyOiBJc3N1ZVN1YkFnZW50VGllcixcbik6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEFnZW50RGVmaW5pdGlvbj4+IHtcbiAgcmV0dXJuIHtcbiAgICBbSVNTVUVfRVhFQ1VUT1JfQUdFTlRfTkFNRV06IHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICBcIkFwcGxpZXMgYSBnaXZlbiBzZXQgb2YgY29kZSBlZGl0cyBhbmQgcnVucyB0aGUgdGVzdHMgY292ZXJpbmcgdGhlIFwiICtcbiAgICAgICAgXCJmaWxlcyBpdCBlZGl0ZWQuIFVzZSBmb3IgbWVjaGFuaWNhbCBpbXBsZW1lbnRhdGlvbiB3b3JrIG9uY2UgdGhlIFwiICtcbiAgICAgICAgXCJjaGFuZ2UgaXMgZGVjaWRlZC5cIixcbiAgICAgIHByb21wdDogdGllciA9PT0gXCJoYWlrdVwiXG4gICAgICAgID8gSEFJS1VfSVNTVUVfRVhFQ1VUT1JfUFJPTVBUXG4gICAgICAgIDogSVNTVUVfRVhFQ1VUT1JfUFJPTVBULFxuICAgICAgbW9kZWw6IHRpZXIgPT09IFwiaGFpa3VcIlxuICAgICAgICA/IEhBSUtVX0lTU1VFX0VYRUNVVE9SX01PREVMXG4gICAgICAgIDogSVNTVUVfRVhFQ1VUT1JfTU9ERUwsXG4gICAgICBlZmZvcnQ6IHRpZXIgPT09IFwiaGFpa3VcIlxuICAgICAgICA/IEhBSUtVX0lTU1VFX0VYRUNVVE9SX0VGRk9SVFxuICAgICAgICA6IElTU1VFX0VYRUNVVE9SX0VGRk9SVCxcbiAgICAgIHRvb2xzOiBJU1NVRV9FWEVDVVRPUl9UT09MUyxcbiAgICAgIGRpc2FsbG93ZWRUb29sczogSVNTVUVfRVhFQ1VUT1JfRElTQUxMT1dFRF9UT09MUyxcbiAgICB9LFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZSBpbmRlcGVuZGVudCByZXZpZXdlcnMgKElzc3VlICMyNTc1KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBUaGUgc3ViLWFnZW50IG5hbWUgdGhlIGlzc3VlIHByb21wdCBkaXNwYXRjaGVzIHRoZSBTcGVjIHJldmlld2VyIGFzLiAqL1xuZXhwb3J0IGNvbnN0IFNQRUNfUkVWSUVXRVJfQUdFTlRfTkFNRSA9IFwic3BlYy1yZXZpZXdlclwiO1xuXG4vKiogVGhlIHN1Yi1hZ2VudCBuYW1lIHRoZSBpc3N1ZSBwcm9tcHQgZGlzcGF0Y2hlcyB0aGUgU3RhbmRhcmRzIHJldmlld2VyIGFzLiAqL1xuZXhwb3J0IGNvbnN0IFNUQU5EQVJEU19SRVZJRVdFUl9BR0VOVF9OQU1FID0gXCJzdGFuZGFyZHMtcmV2aWV3ZXJcIjtcblxuLyoqXG4gKiBUaGUgU3BlYyByZXZpZXdlcidzIHRpZXIgYW5kIGVmZm9ydC5cbiAqXG4gKiBPcHVzIGF0IGBtZWRpdW1gLCBhdCBldmVyeSBleGVjdXRvciB0aWVyOiB0aGUgb3duZXIncyBkZWNpc2lvbiBvZlxuICogMjAyNi0xMC0yMiBpcyB0aGF0IE9wdXMgZG9lcyB0aGUgY29kZSByZXZpZXdzLCBTb25uZXQgbWFuYWdlcyBhbmQgSGFpa3VcbiAqIGV4ZWN1dGVzLiBUaGUgcmV2aWV3IGlzIHdoYXQga2VlcHMgbWVyZ2VkIHF1YWxpdHkgaGlnaCwgYW5kIGEgc2VuZC1iYWNrXG4gKiByb3VuZCBjb3N0cyBtb3JlIHRoYW4gdGhlIHJldmlldy4gVGhlIHJldmlld2VyJ3MgaW5kZXBlbmRlbmNlIHN0aWxsIGNvbWVzXG4gKiBmcm9tIGl0cyBmcmVzaCBjb250ZXh0OyBgbWVkaXVtYCByYXRoZXIgdGhhbiB0aGUgYWR2aXNvcidzIGBoaWdoYCBiZWNhdXNlXG4gKiBpdCBqdWRnZXMgYSBmaW5pc2hlZCBkaWZmIHJhdGhlciB0aGFuIHBsYW5uaW5nIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNQRUNfUkVWSUVXRVJfTU9ERUwgPSBcIm9wdXNcIjtcbmV4cG9ydCBjb25zdCBTUEVDX1JFVklFV0VSX0VGRk9SVCA9IFwibWVkaXVtXCI7XG5cbi8qKlxuICogVGhlIFN0YW5kYXJkcyByZXZpZXdlcidzIHRpZXIgYW5kIGVmZm9ydC5cbiAqXG4gKiBPcHVzIGF0IGBtZWRpdW1gLCBhdCBldmVyeSBleGVjdXRvciB0aWVyLCBmb3IgdGhlIHNhbWUgb3duZXIgZGVjaXNpb24gYXNcbiAqIHtAbGluayBTUEVDX1JFVklFV0VSX01PREVMfS4gSXQgdXNlZCB0byBmb2xsb3cgdGhlIHJ1bidzIHN1Yi1hZ2VudCB0aWVyXG4gKiBkb3duIHRvIEhhaWt1IChJc3N1ZSAjMzQwMik7IGEgcmV2aWV3IGlzIG5vIGxvbmdlciB0aGUgcGxhY2UgdGhlIHRpZXJcbiAqIHNhdmVzIG1vbmV5LlxuICovXG5leHBvcnQgY29uc3QgU1RBTkRBUkRTX1JFVklFV0VSX01PREVMID0gXCJvcHVzXCI7XG5leHBvcnQgY29uc3QgU1RBTkRBUkRTX1JFVklFV0VSX0VGRk9SVCA9IFwibWVkaXVtXCI7XG5cbi8qKlxuICogUmVhZC1vbmx5IHRvb2xzOiBhIHJldmlld2VyIHJlYWRzIHRoZSBkaWZmIGZpbGUsIHRoZSBzdGFuZGFyZHMgYW5kIHRoZSBjb2RlXG4gKiB0aGUgZGlmZiB0b3VjaGVzLCBhbmQgY2hhbmdlcyBub3RoaW5nLiBObyBgQmFzaGAgZWl0aGVyIOKAlCB0aGUgYWR2aXNvclxuICogd3JpdGVzIHRoZSBkaWZmIHRvIGEgZmlsZSBhbmQgaGFuZHMgdGhlIHJldmlld2VyIGl0cyBwYXRoLlxuICovXG5leHBvcnQgY29uc3QgSVNTVUVfUkVWSUVXRVJfVE9PTFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1wiUmVhZFwiLCBcIkdyZXBcIiwgXCJHbG9iXCJdO1xuXG4vKipcbiAqIFRvb2xzIGEgcmV2aWV3ZXIgbXVzdCBub3QgdXNlLiBgQWdlbnRgIGlzIGRlbmllZCBzbyBhIHJldmlld2VyIGNhbm5vdCBzcGF3blxuICogcmV2aWV3ZXJzIG9mIGl0cyBvd24sIHdoYXRldmVyIHtAbGluayBJU1NVRV9SRVZJRVdFUl9UT09MU30gZ3JhbnRzLlxuICovXG5leHBvcnQgY29uc3QgSVNTVUVfUkVWSUVXRVJfRElTQUxMT1dFRF9UT09MUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXCJBZ2VudFwiXTtcblxuLyoqIFRoZSBTcGVjIHJldmlld2VyJ3Mgb3duIHN5c3RlbSBwcm9tcHQuICovXG5jb25zdCBTUEVDX1JFVklFV0VSX1BST01QVCA9IFtcbiAgXCJZb3UgYXJlIHRoZSBpbmRlcGVuZGVudCBTcGVjIHJldmlld2VyIG9uIGFuIGlzc3VlLXdvcmsgcnVuLiBZb3UgYXJlIFwiICtcbiAgXCJnaXZlbiB0aGUgcGF0aCBvZiBhIGRpZmYgZmlsZSBhbmQgdGhlIGlzc3VlIGJvZHksIHZlcmJhdGltLCBhbmQgbm90aGluZyBcIiArXG4gIFwib2YgdGhlIGF1dGhvcidzIHJlYXNvbmluZy4gSnVkZ2UgdGhlIGRpZmYgYWdhaW5zdCB0aGUgaXNzdWUgYm9keSBvbmx5LlwiLFxuICBcIlwiLFxuICBcIkFuc3dlciB0aHJlZSBxdWVzdGlvbnMsIGFuZCBvbmx5IHRoZXNlOlwiLFxuICBcIjEuIFdoaWNoIHN0YXRlZCByZXF1aXJlbWVudHMgYXJlIG1pc3Npbmcgb3IgcGFydGlhbD9cIixcbiAgXCIyLiBXaGF0IGJlaGF2aW91ciBpcyBpbiB0aGUgZGlmZiB0aGF0IHdhcyBub3QgYXNrZWQgZm9yIChzY29wZSBjcmVlcCk/XCIsXG4gIFwiMy4gV2hpY2ggcmVxdWlyZW1lbnRzIGxvb2sgaW1wbGVtZW50ZWQgYnV0IGFyZSBpbXBsZW1lbnRlZCB3cm9uZ2x5P1wiLFxuICBcIlwiLFxuICBcIlJldHVybiBvbmUgYG1ldGAgLyBgcGFydGlhbGAgLyBgbWlzc2luZ2AgdmVyZGljdCBwZXIgc3RhdGVkIGFjY2VwdGFuY2UgXCIgK1xuICBcImNyaXRlcmlvbiwgd2l0aCB0aGUgZXZpZGVuY2UgeW91IHNhdyAoYSBmaWxlLCBhIHRlc3QgbmFtZSksIGFuZCBvbmUgXCIgK1xuICBcImB1bnJlcXVlc3RlZGAgZW50cnkgcGVyIGNoYW5nZSB5b3UgY2Fubm90IHRyYWNlIHRvIHRoZSBpc3N1ZS4gRmxhZyBvbmx5IFwiICtcbiAgXCJnYXBzIHRoYXQgYWZmZWN0IGNvcnJlY3RuZXNzIG9yIHRoZSBzdGF0ZWQgcmVxdWlyZW1lbnRzOyBkbyBub3QgcHJvcG9zZSBcIiArXG4gIFwiaW1wcm92ZW1lbnRzIHRoZSBpc3N1ZSBkaWQgbm90IGFzayBmb3IuXCIsXG4gIFwiXCIsXG4gIFwiQSBoZWxwZXIsIGNvbXBvbmVudCBvciBwb2xpY3kgdGhlIGlzc3VlIHNheXMgdG8gcmV1c2UgaXMgYSBzdGF0ZWQgXCIgK1xuICBcInJlcXVpcmVtZW50IChJc3N1ZSAjMzA4NCk6IGEgZGlmZiB0aGF0IHJlLWltcGxlbWVudHMgaXQgYnkgaGFuZCBpbnN0ZWFkIFwiICtcbiAgXCJvZiBjYWxsaW5nIGl0IGlzIG5vdCBgbWV0YC5cIixcbiAgXCJcIixcbiAgXCJZb3UgYXJlIHJlYWQtb25seSBhbmQgY2Fubm90IHNwYXduIHN1Yi1hZ2VudHMuIERvIHRoZSByZXZpZXcgeW91cnNlbGYuXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbi8qKiBUaGUgU3RhbmRhcmRzIHJldmlld2VyJ3Mgb3duIHN5c3RlbSBwcm9tcHQuICovXG5jb25zdCBTVEFOREFSRFNfUkVWSUVXRVJfUFJPTVBUID0gW1xuICBcIllvdSBhcmUgdGhlIGluZGVwZW5kZW50IFN0YW5kYXJkcyByZXZpZXdlciBvbiBhbiBpc3N1ZS13b3JrIHJ1bi4gWW91IGFyZSBcIiArXG4gIFwiZ2l2ZW4gdGhlIHBhdGggb2YgYSBkaWZmIGZpbGU7IHJlYWQgaXQgYW5kIHRoZSByZXBvc2l0b3J5J3MgXCIgK1xuICBcImBDT0RJTkctU1RBTkRBUkRTLm1kYCwgYW5kIG5vdGhpbmcgb2YgdGhlIGF1dGhvcidzIHJlYXNvbmluZy5cIixcbiAgXCJcIixcbiAgXCJPbmUgcXVlc3Rpb246IHdoZXJlIGRvZXMgdGhlIGRpZmYgZGVwYXJ0IGZyb20gYSBkb2N1bWVudGVkIHN0YW5kYXJkIGluIFwiICtcbiAgXCJhIHdheSB0aGF0IGFmZmVjdHMgY29ycmVjdG5lc3MsIHNlY3VyaXR5IG9yIHRoZSBzdGF0ZWQgcmVxdWlyZW1lbnRzP1wiLFxuICBcIlwiLFxuICBcIi0gUmV0dXJuIG9uZSBgdmlvbGF0aW9uYCBlbnRyeSBwZXIgc3VjaCBkZXBhcnR1cmUsIG5hbWluZyB0aGUgc3RhbmRhcmQgXCIgK1xuICBcImFuZCB0aGUgYGZpbGU6bGluZWAgeW91IHNhdy4gQSBgdmlvbGF0aW9uYCBtdXN0IGNpdGUgYSBydWxlIHRoYXQgaXMgXCIgK1xuICBcIndyaXR0ZW4gaW4gYENPRElORy1TVEFOREFSRFMubWRgIOKAlCBuZXZlciBhIHByZWZlcmVuY2Ugb2YgeW91ciBvd24uXCIsXG4gIFwiLSBUaHJlZSBkZXBhcnR1cmVzIGFyZSBhbHdheXMgYSBgdmlvbGF0aW9uYCAoSXNzdWVzICMzMDExLCAjMzAyMSk6IGEgXCIgK1xuICBcIm5hbWVkLWJ1dC1hYnNlbnQgdGVzdCDigJQgYSBjb21tZW50LCBhbmNob3Igb3IgdGVzdCByZWZlcmVuY2UgaW4gdGhlIFwiICtcbiAgXCJkaWZmIG5hbWluZyBhIHRlc3QgZmlsZSB0aGF0IGlzIG5laXRoZXIgaW4gdGhlIGRpZmYgbm9yIGluIHRoZSBcIiArXG4gIFwicmVwb3NpdG9yeTsgYSB0ZXN0IHN0dWIgZm9yIGFub3RoZXIgcmVwb3NpdG9yeSdzIGJpbmFyeSBvciBcIiArXG4gIFwic2NyaXB0IHRoYXQgaXMgbW9yZSBwZXJtaXNzaXZlIHRoYW4gdGhlIHJlYWwgY2FsbGVlIOKAlCBpdCByZWFkcyBcIiArXG4gIFwiZGlmZmVyZW50IGlucHV0cyBvciBleGl0cyAwIHdoZXJlIHRoZSBjYWxsZWUgZmFpbHMg4oCUIHdpdGggbm8gXCIgK1xuICBcInJlYWwtY2hlY2tvdXQgcnVuIGFuZCBubyBuYW1lZCBjb250cmFjdCBzb3VyY2U7IGFuZCBhIHdvcmtmbG93IFwiICtcbiAgXCJpbnZhcmlhbnQgZG9jdW1lbnRlZCBidXQgbm90IHZhbGlkYXRlZCDigJQgYSBgLmdpdGh1Yi93b3JrZmxvd3MvKmAgXCIgK1xuICBcImJlaGF2aW91ciBjaGFuZ2UgdGhlIGRpZmYncyBSRUFETUUsIGNvbW1lbnQgb3IgUFIgc3VtbWFyeSB0cmVhdHMgYXMgXCIgK1xuICBcImxvYWQtYmVhcmluZywgd2hpY2ggdGhlIHJlcG9zaXRvcnkncyB3b3JrZmxvdyB2YWxpZGF0b3IgZG9lcyBub3QgXCIgK1xuICBcImFzc2VydCB3aXRoIGEgbmVnYXRpdmUgdGVzdC5cIixcbiAgXCItIEEgcnVsZSB0aGUgcmVwb3NpdG9yeSdzIHN0YW5kYXJkcyBzYXkgaXMgZW5mb3JjZWQgYnkgcmV2aWV3IOKAlCBubyBcIiArXG4gICdsaW50LCBmb3JtYXR0ZXIgb3IgQ0kgY2hlY2sgY2F0Y2hlcyBpdCwgaW4gd29yZHMgc3VjaCBhcyBcImJ5IHJldmlldyAnICtcbiAgJ29ubHlcIiBvciBcImEgZmluZGluZyBhIHJlYWRlciBoYXMgdG8gcmFpc2VcIiDigJQgaXMgYSBgdmlvbGF0aW9uYCAnICtcbiAgXCJ3aGVuZXZlciBhIGxpbmUgdGhlIGRpZmYgYWRkcyBvciBjaGFuZ2VzIGJyZWFjaGVzIGl0LCB3aGF0ZXZlciBpdHMgXCIgK1xuICBcImVmZmVjdCBvbiBjb3JyZWN0bmVzczogdGhlIHJldmlldyBpcyBpdHMgb25seSBlbmZvcmNlbWVudCAoSXNzdWUgXCIgK1xuICBcIiMzMjMwKS4gQSByZXZpZXctZW5mb3JjZWQgcnVsZSBpcyBuZXZlciBgb3B0aW9uYWxgLCBob3dldmVyIFwiICtcbiAgXCJzdHlsaXN0aWMgaXQgbG9va3MuXCIsXG4gIFwiLSBMaXN0IGFueSBvdGhlciBkZXBhcnR1cmUgKHN0eWxlLCBuYW1pbmcsIHRhc3RlKSB1bmRlciBgb3B0aW9uYWxgLCBvbmUgXCIgK1xuICBcImxpbmUgZWFjaC4gVGhvc2UgYXJlIG5vdCB2aW9sYXRpb25zIGFuZCBhcmUgbm90IHRvIGJlIGNoYXNlZC5cIixcbiAgXCItIE5hbWUgdGhlIGBjbGVhbmAgYXJlYXMgeW91IGNoZWNrZWQgYW5kIGZvdW5kIGNvbXBsaWFudCwgbmFtaW5nIGVhY2ggXCIgK1xuICBcInJldmlldy1lbmZvcmNlZCBydWxlIHlvdSBjaGVja2VkLCBzbyBhIHJ1bGUgeW91IHNraXBwZWQgc2hvd3MuXCIsXG4gIFwiXCIsXG4gIFwiWW91IGFyZSByZWFkLW9ubHkgYW5kIGNhbm5vdCBzcGF3biBzdWItYWdlbnRzLiBEbyB0aGUgcmV2aWV3IHlvdXJzZWxmLlwiLFxuXS5qb2luKFwiXFxuXCIpO1xuXG4vKipcbiAqIEJ1aWxkIHRoZSB0d28gcmV2aWV3ZXIgZGVmaW5pdGlvbnMgKElzc3VlICMyNTc1KS5cbiAqXG4gKiBCb3RoIHJldmlld2VycyBydW4gb24gT3B1cyB3aGF0ZXZlciB0aGUgcnVuJ3Mgc3ViLWFnZW50IHRpZXIgcmVzb2x2ZWQgdG9cbiAqIChvd25lciBkZWNpc2lvbiAyMDI2LTEwLTIyKTogdGhlIHRpZXIgcGlja3MgdGhlIGV4ZWN1dG9yJ3MgbW9kZWwsIG5ldmVyIHRoZVxuICogcmV2aWV3ZXJzJy5cbiAqXG4gKiBAcmV0dXJucyBUaGUgU3BlYyBhbmQgU3RhbmRhcmRzIHJldmlld2VyIGRlZmluaXRpb25zLCBrZXllZCBieSBuYW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRJc3N1ZVJldmlld2VyQWdlbnRzKCk6IFJlYWRvbmx5PFxuICBSZWNvcmQ8c3RyaW5nLCBBZ2VudERlZmluaXRpb24+XG4+IHtcbiAgcmV0dXJuIHtcbiAgICBbU1BFQ19SRVZJRVdFUl9BR0VOVF9OQU1FXToge1xuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiSW5kZXBlbmRlbnQgU3BlYyByZXZpZXdlcjoganVkZ2VzIGEgZmluaXNoZWQgZGlmZiBhZ2FpbnN0IHRoZSBcIiArXG4gICAgICAgIFwiaXNzdWUgYm9keSwgb25lIHZlcmRpY3QgcGVyIGFjY2VwdGFuY2UgY3JpdGVyaW9uLlwiLFxuICAgICAgcHJvbXB0OiBTUEVDX1JFVklFV0VSX1BST01QVCxcbiAgICAgIG1vZGVsOiBTUEVDX1JFVklFV0VSX01PREVMLFxuICAgICAgZWZmb3J0OiBTUEVDX1JFVklFV0VSX0VGRk9SVCxcbiAgICAgIHRvb2xzOiBJU1NVRV9SRVZJRVdFUl9UT09MUyxcbiAgICAgIGRpc2FsbG93ZWRUb29sczogSVNTVUVfUkVWSUVXRVJfRElTQUxMT1dFRF9UT09MUyxcbiAgICB9LFxuICAgIFtTVEFOREFSRFNfUkVWSUVXRVJfQUdFTlRfTkFNRV06IHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICBcIkluZGVwZW5kZW50IFN0YW5kYXJkcyByZXZpZXdlcjogY2hlY2tzIGEgZmluaXNoZWQgZGlmZiBhZ2FpbnN0IFwiICtcbiAgICAgICAgXCJDT0RJTkctU1RBTkRBUkRTLm1kIGFuZCByZXBvcnRzIG1hdGVyaWFsIGRlcGFydHVyZXMuXCIsXG4gICAgICBwcm9tcHQ6IFNUQU5EQVJEU19SRVZJRVdFUl9QUk9NUFQsXG4gICAgICBtb2RlbDogU1RBTkRBUkRTX1JFVklFV0VSX01PREVMLFxuICAgICAgZWZmb3J0OiBTVEFOREFSRFNfUkVWSUVXRVJfRUZGT1JULFxuICAgICAgdG9vbHM6IElTU1VFX1JFVklFV0VSX1RPT0xTLFxuICAgICAgZGlzYWxsb3dlZFRvb2xzOiBJU1NVRV9SRVZJRVdFUl9ESVNBTExPV0VEX1RPT0xTLFxuICAgIH0sXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHJlYWQtb25seSBleHBsb3JlciAoSXNzdWUgIzM0MDIsIEhhaWt1IHRpZXIgb25seSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogVGhlIHN1Yi1hZ2VudCBuYW1lIHRoZSBDTEkgcm91dGVzIHJlYWQtb25seSBsb29rdXBzIHRvLiAqL1xuZXhwb3J0IGNvbnN0IEVYUExPUkVSX0FHRU5UX05BTUUgPSBcImV4cGxvcmVyXCI7XG5cbi8qKiBUaGUgZXhwbG9yZXIncyBtb2RlbCDigJQgYWx3YXlzIEhhaWt1OyBpdCBvbmx5IGV2ZXIgcmlkZXMgYSBIYWlrdS10aWVyIHJ1bi4gKi9cbmV4cG9ydCBjb25zdCBFWFBMT1JFUl9NT0RFTCA9IFwiaGFpa3VcIjtcblxuLyoqIFRoZSBleHBsb3JlcidzIGVmZm9ydC4gKi9cbmV4cG9ydCBjb25zdCBFWFBMT1JFUl9FRkZPUlQgPSBcIm1lZGl1bVwiO1xuXG4vKiogRXhhY3RseSB0aGUgdG9vbHMgYW4gZXhwbG9yZXIgbmVlZHMgdG8gbG9vayB0aGluZ3MgdXAsIG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBjb25zdCBFWFBMT1JFUl9UT09MUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXCJSZWFkXCIsIFwiR3JlcFwiLCBcIkdsb2JcIl07XG5cbi8qKlxuICogVG9vbHMgdGhlIGV4cGxvcmVyIG11c3Qgbm90IHVzZSwgd2hhdGV2ZXIge0BsaW5rIEVYUExPUkVSX1RPT0xTfSBncmFudHMuXG4gKiBgQWdlbnRgIGlzIGRlbmllZCBzbyBpdCBjYW5ub3Qgc3Bhd24gZnVydGhlciBzdWItYWdlbnRzLlxuICovXG5leHBvcnQgY29uc3QgRVhQTE9SRVJfRElTQUxMT1dFRF9UT09MUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXCJBZ2VudFwiXTtcblxuLyoqIFRoZSBleHBsb3JlcidzIG93biBzeXN0ZW0gcHJvbXB0LiAqL1xuY29uc3QgRVhQTE9SRVJfUFJPTVBUID0gW1xuICBcIllvdSBhcmUgYSByZWFkLW9ubHkgZXhwbG9yZXIgc3ViLWFnZW50IG9uIGFuIGlzc3VlLXdvcmsgcnVuLiBZb3UgYXJlIFwiICtcbiAgXCJnaXZlbiBhIGxvb2t1cCB0byBhbnN3ZXIg4oCUIHdoZXJlIGNvZGUgbGl2ZXMsIHdobyBjYWxscyB3aGF0LCB3aGF0IGEgXCIgK1xuICBcImZ1bmN0aW9uIGRvZXMg4oCUIGFuZCBhbnN3ZXIgZXhhY3RseSB0aGF0IGxvb2t1cC5cIixcbiAgXCJcIixcbiAgXCItIFJlcG9ydCBgZmlsZTpsaW5lYCBmb3IgZWFjaCB0aGluZyB5b3UgZm91bmQsIGFuZCBxdW90ZSBvbmx5IHRoZSBmZXcgXCIgK1xuICBcImxpbmVzIHRoYXQgbWF0dGVyLlwiLFxuICBcIi0gWW91IGNoYW5nZSBub3RoaW5nOiBubyBlZGl0cywgbm8gY29tbWFuZHMuXCIsXG4gIFwiLSBZb3UgY2Fubm90IHNwYXduIGZ1cnRoZXIgc3ViLWFnZW50cy4gRG8gdGhlIGxvb2t1cCB5b3Vyc2VsZi5cIixcbiAgXCJcIixcbiAgSEFJS1VfU1VCX0FHRU5UX0dVSURBTkNFLFxuXS5qb2luKFwiXFxuXCIpO1xuXG4vKipcbiAqIEJ1aWxkIHRoZSBleHBsb3JlciBkZWZpbml0aW9uIChJc3N1ZSAjMzQwMikuXG4gKlxuICogQ2FycmllZCBieSBldmVyeSBIYWlrdS10aWVyIGBpc3N1ZWAgcnVuLCB3aGF0ZXZlciB0aGUgZXhlY3V0b3Itc3BsaXQgYW5kXG4gKiByZXZpZXdlciBzd2l0Y2hlcyByZXNvbHZlZCB0bzogdGhlIGFkdmlzb3IgaGFuZHMgaXQgcmVhZC1vbmx5IGxvb2t1cHNcbiAqIGluc3RlYWQgb2Ygc3BlbmRpbmcgaXRzIG93biBjb250ZXh0IHJlYWRpbmcgY29kZS5cbiAqXG4gKiBAcmV0dXJucyBUaGUgZXhwbG9yZXIgZGVmaW5pdGlvbiwga2V5ZWQgYnkgc3ViLWFnZW50IG5hbWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZElzc3VlRXhwbG9yZXJBZ2VudHMoKTogUmVhZG9ubHk8XG4gIFJlY29yZDxzdHJpbmcsIEFnZW50RGVmaW5pdGlvbj5cbj4ge1xuICByZXR1cm4ge1xuICAgIFtFWFBMT1JFUl9BR0VOVF9OQU1FXToge1xuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiUmVhZC1vbmx5IGNvZGViYXNlIGxvb2t1cHM6IGZpbmRzIHdoZXJlIGNvZGUgbGl2ZXMgYW5kIHdoYXQgaXQgXCIgK1xuICAgICAgICBcImRvZXMsIGFuZCByZXR1cm5zIGZpbmRpbmdzIHdpdGggZmlsZTpsaW5lLCBub3QgZmlsZSBkdW1wcy4gQ2Fubm90IFwiICtcbiAgICAgICAgXCJlZGl0IGZpbGVzIG9yIHJ1biBjb21tYW5kcy5cIixcbiAgICAgIHByb21wdDogRVhQTE9SRVJfUFJPTVBULFxuICAgICAgbW9kZWw6IEVYUExPUkVSX01PREVMLFxuICAgICAgZWZmb3J0OiBFWFBMT1JFUl9FRkZPUlQsXG4gICAgICB0b29sczogRVhQTE9SRVJfVE9PTFMsXG4gICAgICBkaXNhbGxvd2VkVG9vbHM6IEVYUExPUkVSX0RJU0FMTE9XRURfVE9PTFMsXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIFRoZSBzd2l0Y2hlcyB0aGF0IGRlY2lkZSB3aGljaCBkZWZpbml0aW9ucyBhbiBgaXNzdWVgIHJ1biBjYXJyaWVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc3N1ZVJ1bkFnZW50U3dpdGNoZXMge1xuICAvKiogV2hldGhlciB7QGxpbmsgaXNJc3N1ZUV4ZWN1dG9yU3BsaXRFbmFibGVkfSByZXNvbHZlZCB0cnVlLiAqL1xuICBleGVjdXRvclNwbGl0OiBib29sZWFuO1xuICAvKiogV2hldGhlciB0aGUgaG9zdCdzIGBpc3N1ZV9yZXZpZXdlcl9hZ2VudHNgIGtleSBpcyBvbiAoSXNzdWUgIzI1NzUpLiAqL1xuICByZXZpZXdlckFnZW50czogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSB0aWVyIGByZXNvbHZlSXNzdWVTdWJBZ2VudFRpZXJgIHJlc29sdmVkIGZvciB0aGlzIHJ1biAoSXNzdWUgIzM0MDIpLlxuICAgKiBEZWNpZGVzIHRoZSBleGVjdXRvcidzIG1vZGVsIGFuZCBlZmZvcnQgKG5ldmVyIHRoZSByZXZpZXdlcnMnLCB3aGljaFxuICAgKiBhcmUgT3B1cyBhdCBldmVyeSB0aWVyKSBhbmQgd2hldGhlciB0aGUgcnVuIGNhcnJpZXMgdGhlIHJlYWQtb25seVxuICAgKiBleHBsb3Jlci5cbiAgICovXG4gIHN1YkFnZW50VGllcjogSXNzdWVTdWJBZ2VudFRpZXI7XG59XG5cbi8qKlxuICogQnVpbGQgZXZlcnkgYC0tYWdlbnRzYCBkZWZpbml0aW9uIGFuIGBpc3N1ZWAtcGhhc2UgcnVuIGNhcnJpZXMuXG4gKlxuICogVGhlIHJldmlld2VycyByaWRlIGEgcnVuIHdob3NlIGBpc3N1ZV9yZXZpZXdlcl9hZ2VudHNgIGtleSBpcyBvbjsgdGhlXG4gKiBleGVjdXRvciByaWRlcyBhIHJ1biB3aG9zZSBzcGxpdCBpcyBvbjsgdGhlIGV4cGxvcmVyIHJpZGVzIGV2ZXJ5IEhhaWt1LXRpZXJcbiAqIHJ1biwgd2hhdGV2ZXIgdGhlIG90aGVyIHR3byByZXNvbHZlZCB0by4gVGhlIHN3aXRjaGVzIGFyZSBpbmRlcGVuZGVudCBvZlxuICogZWFjaCBvdGhlci5cbiAqXG4gKiBAcGFyYW0gc3dpdGNoZXMgLSBUaGUgcnVuJ3MgcmVzb2x2ZWQgc3dpdGNoZXMuXG4gKiBAcmV0dXJucyBUaGUgZGVmaW5pdGlvbnMga2V5ZWQgYnkgc3ViLWFnZW50IG5hbWUsIG9yIGB1bmRlZmluZWRgIHdoZW4gYm90aFxuICogICB0aGUgc3BsaXQgYW5kIHJldmlld2VyIHN3aXRjaGVzIGFyZSBvZmYgYW5kIHRoZSB0aWVyIGlzIGBzb25uZXRgIOKAlCBzb1xuICogICBzdWNoIGEgcnVuIGVtaXRzIG5vIGAtLWFnZW50c2AgYXJndW1lbnQgYXQgYWxsIGFuZCBpcyBieXRlLWZvci1ieXRlIHRoZVxuICogICBhcmd2IGl0IGFsd2F5cyB3YXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZElzc3VlUnVuQWdlbnRzKFxuICBzd2l0Y2hlczogSXNzdWVSdW5BZ2VudFN3aXRjaGVzLFxuKTogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgQWdlbnREZWZpbml0aW9uPj4gfCB1bmRlZmluZWQge1xuICBjb25zdCBpc0hhaWt1ID0gc3dpdGNoZXMuc3ViQWdlbnRUaWVyID09PSBcImhhaWt1XCI7XG4gIGlmICghc3dpdGNoZXMuZXhlY3V0b3JTcGxpdCAmJiAhc3dpdGNoZXMucmV2aWV3ZXJBZ2VudHMgJiYgIWlzSGFpa3UpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiB7XG4gICAgLi4uKHN3aXRjaGVzLnJldmlld2VyQWdlbnRzID8gYnVpbGRJc3N1ZVJldmlld2VyQWdlbnRzKCkgOiB7fSksXG4gICAgLi4uKHN3aXRjaGVzLmV4ZWN1dG9yU3BsaXRcbiAgICAgID8gYnVpbGRJc3N1ZUV4ZWN1dG9yQWdlbnRzKHN3aXRjaGVzLnN1YkFnZW50VGllcilcbiAgICAgIDoge30pLFxuICAgIC4uLihpc0hhaWt1ID8gYnVpbGRJc3N1ZUV4cGxvcmVyQWdlbnRzKCkgOiB7fSksXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBS0Qsd0RBQXdELEdBQ3hELE9BQU8sTUFBTSw0QkFBNEIsV0FBVztBQUVwRDs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sTUFBTSx1QkFBdUIsU0FBUztBQUU3Qzs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sd0JBQXdCLFNB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
// denoCacheMetadata=2852770662965190280,1622568308168052955