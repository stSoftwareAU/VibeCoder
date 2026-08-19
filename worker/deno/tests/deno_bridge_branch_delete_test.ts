/**
 * Tests for `handle_issue_failure`'s remote-branch deletion (Issue #3931).
 *
 * The failure handler used to delete the remote branch unless the Deno safety
 * check returned `HAS_OPEN_PR:<n>` — so a check that failed, timed out, or
 * refused for any other reason fell through to the delete. Deleting a branch
 * other PRs are based on makes GitHub close them.
 *
 * These are behavioural tests: they source the real `deno_bridge.sh`, stub
 * `deno_run_command` and `git`, invoke the real `handle_issue_failure`, and
 * assert on whether `git push origin --delete` actually ran.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const bridgePath = new URL("../../shared/deno_bridge.sh", import.meta.url)
  .pathname;

/**
 * Run `handle_issue_failure` with a stubbed safety check.
 *
 * @param checkOutput - What the `check-branch-has-open-pr` stub prints
 * @param checkStatus - Exit status of that stub (non-zero = check failed)
 * @returns The git commands the handler issued, and the worker log text
 */
async function runHandleIssueFailure(
  checkOutput: string,
  checkStatus = 0,
): Promise<{ gitCalls: string[]; logText: string }> {
  const tmp = await Deno.makeTempDir();
  try {
    const gitCallsFile = `${tmp}/git-calls`;
    const logFile = `${tmp}/worker.log`;
    const fakeGit = `${tmp}/git`;
    await Deno.writeTextFile(
      fakeGit,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "${gitCallsFile}"\nexit 0\n`,
    );
    await Deno.chmod(fakeGit, 0o755);
    await Deno.writeTextFile(gitCallsFile, "");

    // `git` is resolved from PATH, so the stub directory goes first.
    const script = `
      set -uo pipefail
      export PATH="${tmp}:$PATH"
      export LOG_FILE="${logFile}"
      source "${bridgePath}"
      # Stub the Deno bridge: the label-manager call is a no-op, the
      # branch-cleanup safety check answers with the scripted verdict.
      deno_run_command() {
        if [[ "\${*}" == *"check-branch-has-open-pr"* ]]; then
          printf '%s\\n' "${checkOutput}"
          return ${checkStatus}
        fi
        return 0
      }
      get_repo_default_branch() { echo "Develop"; }
      handle_issue_failure "org/repo" "42" "worker" "boom" "issue-42-thing" \
        >/dev/null 2>&1 || true
    `;

    const cmd = new Deno.Command("bash", { args: ["-c", script] });
    const { code } = await cmd.output();
    assertEquals(code, 0, "bash harness should exit cleanly");

    const gitCalls = (await Deno.readTextFile(gitCallsFile))
      .split("\n")
      .filter((line) => line.length > 0);
    const logText = await Deno.readTextFile(logFile).catch(() => "");
    return { gitCalls, logText };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** True when the handler pushed a remote branch deletion. */
function deletedRemote(gitCalls: string[]): boolean {
  return gitCalls.some((call) => call.includes("push origin --delete"));
}

Deno.test("handle_issue_failure deletes the remote branch on SAFE_TO_DELETE", async () => {
  const { gitCalls } = await runHandleIssueFailure("SAFE_TO_DELETE");
  assertEquals(
    deletedRemote(gitCalls),
    true,
    `expected a remote delete in: ${gitCalls.join(" | ")}`,
  );
});

Deno.test("handle_issue_failure keeps the branch when an open PR has it as head", async () => {
  const { gitCalls } = await runHandleIssueFailure("HAS_OPEN_PR:42");
  assertEquals(deletedRemote(gitCalls), false);
});

Deno.test("handle_issue_failure keeps a branch an open child PR is based on", async () => {
  const { gitCalls, logText } = await runHandleIssueFailure(
    "HAS_OPEN_CHILD_PR:3928",
  );
  assertEquals(deletedRemote(gitCalls), false);
  assertStringIncludes(logText, "HAS_OPEN_CHILD_PR:3928");
});

Deno.test("handle_issue_failure keeps a protected branch", async () => {
  const { gitCalls } = await runHandleIssueFailure("PROTECTED_BRANCH");
  assertEquals(deletedRemote(gitCalls), false);
});

Deno.test("handle_issue_failure keeps the branch when the safety check fails", async () => {
  const { gitCalls, logText } = await runHandleIssueFailure(
    "UNDECIDABLE: gh timed out",
    1,
  );
  assertEquals(
    deletedRemote(gitCalls),
    false,
    "a failed safety check must never authorise a deletion",
  );
  assertStringIncludes(logText, "Skipping remote branch deletion");
});

Deno.test("handle_issue_failure keeps the branch when the check prints nothing", async () => {
  const { gitCalls } = await runHandleIssueFailure("", 0);
  assertEquals(deletedRemote(gitCalls), false);
});

Deno.test("handle_issue_failure still removes the local branch after a refusal", async () => {
  const { gitCalls } = await runHandleIssueFailure("PROTECTED_BRANCH");
  assertEquals(
    gitCalls.some((call) => call.startsWith("branch -D")),
    true,
    `expected a local branch delete in: ${gitCalls.join(" | ")}`,
  );
});
