/**
 * The advisor/executor instruction block an `issue`-phase prompt carries when
 * `issue_executor_split` is on (Issue #2343, part of #2320).
 *
 * Issue #2342 gives a split run the `--agents` executor definitions; without
 * this block the advisor is handed executors and never told to use them, so
 * the run behaves exactly as an unsplit one and the key buys nothing. The
 * block is spliced into `prompts/issue/prompt.md` at
 * `{{EXECUTOR_SPLIT_INSTRUCTIONS}}`, which resolves to the empty string on a
 * key-off run.
 *
 * The sub-agent name is interpolated from {@link ISSUE_EXECUTOR_AGENT_NAME},
 * so the name the prompt tells the advisor to dispatch is by construction the
 * name `buildIssueExecutorAgents()` registers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ISSUE_EXECUTOR_AGENT_NAME } from "./issue_executor_agents.ts";

/**
 * Advisor/executor instructions for a split `issue`-phase run.
 *
 * Splices in with a blank line either side; the builder supplies those, so the
 * constant itself starts at its heading and ends without a trailing newline.
 */
export const ISSUE_EXECUTOR_SPLIT_INSTRUCTIONS = `\
## Advisor and Executors — You Plan, They Edit

This run is split across two tiers, and you are the **advisor**: you decide
what the change should be, hand the edits to \`${ISSUE_EXECUTOR_AGENT_NAME}\` sub-agents,
and review what comes back. The executors make every edit.

This section governs delegation for this run. Where it and the
**Delegate sparingly** bullet below differ, this section wins — that bullet
still governs every sub-agent this section does not describe.

- **Make no \`Edit\` or \`Write\` call yourself.** Every edit the change is made
  of — code, tests, documentation — is made by an executor sub-agent:
  \`Agent\` with \`subagent_type: "${ISSUE_EXECUTOR_AGENT_NAME}"\`. Reading, searching,
  planning and verifying stay yours, as does the run's own record — the PR
  summary file and anything else this prompt tells you to write yourself.
- **One executor per independent group of files.** A group is independent when
  no other executor in the same run edits any file in it — two executors must
  never hold the same file. There is no cap on how many run concurrently:
  dispatch every independent group at once, in a single message.
- **Each executor does its own reads, edits and tests.** Give it the files, the
  change you want, and the tests covering those files; it runs those tests —
  stdin redirected from \`/dev/null\` — and reports the output. An executor
  never runs the full gate.
- **You run the full quality gate once, at the end.** The repository's
  \`./quality.sh\`, after the last executor has returned and you have accepted
  its diff. Once for the run, not once per executor.
- **Read each executor's diff before that gate.** \`git diff\` the files it was
  given and check the diff against the task you handed it. Where it does not
  match, re-task that executor with what is wrong — **at most twice**. On a
  third mismatch, write it to the run log (name the executor, its files, and
  how the diff diverged) and proceed to the quality gate instead of re-tasking
  again. An executor that errors, or returns no result, counts as one mismatch
  against that cap.
- **The reviewers are not executors.** The Spec and Standards reviewer
  sub-agents required by
  [Independent Review Before the PR](#independent-review-before-the-pr--spec-and-standards-on-separate-axes)
  are unchanged: you dispatch them yourself, they run on this phase's model
  unless the run defines them as their own agents, and they review rather than
  edit.`;
