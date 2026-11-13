/**
 * Tests for the review round's Codex tool guard (Issue #5083): the Codex
 * attempt is held to the same --allowedTools limits as a Claude round.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideReviewRoundTool,
  reviewRoundGuardSettings,
  reviewRoundToolPolicy,
} from "../lib/review_round_guard.ts";
import { buildCodexArgs } from "../lib/codex_executor.ts";

const ROUND_DIR = "/state/review-fleet-prs/rounds/pr-7";

/** The Claude arguments run.sh's run_round builds, abridged. */
const ROUND_ARGS = [
  "--model",
  "claude-fable-5-2",
  "--add-dir",
  "/tmp",
  "--add-dir",
  ROUND_DIR,
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Agent",
  "Read",
  "Grep",
  "Glob",
  `Edit(/${ROUND_DIR}/**)`,
  "Bash(gh:*)",
  "Bash(jq:*)",
  "Bash(cat:*)",
  "Bash(deno run:*)",
  "Bash(mkdir:*)",
  "Bash(head:*)",
  "Bash(git log:*)",
];

const policy = reviewRoundToolPolicy(ROUND_ARGS);

function shell(command: string) {
  return decideReviewRoundTool(
    { tool_name: "Bash", tool_input: { command }, cwd: "/workspace" },
    policy,
  );
}

Deno.test("reviewRoundToolPolicy reads the round's commands and write directories off its Claude args", () => {
  assertEquals(policy.commands, [
    "gh",
    "jq",
    "cat",
    "deno run",
    "mkdir",
    "head",
    "git log",
  ]);
  assertEquals(policy.writeDirs, ["/tmp", ROUND_DIR]);
});

Deno.test("the guard lets post.ts and the round's own commands run", () => {
  assertEquals(
    shell(
      `deno run --allow-run=gh --allow-read --allow-write post.ts --round-dir=${ROUND_DIR} < ${ROUND_DIR}/review.json`,
    ),
    { deny: false },
  );
  assertEquals(
    shell(`gh api repos/o/r/pulls/7 --jq '.head | .sha' | head -1 2>&1`),
    { deny: false },
  );
  assertEquals(shell(`git log -1 > ${ROUND_DIR}/log.txt`), { deny: false });
  assertEquals(shell(`mkdir -p /tmp/scratch`), { deny: false });
});

Deno.test("the guard refuses a command off the list, an out-of-round write and substitution", () => {
  assertEquals(shell("rm -rf /state").deny, true);
  assertEquals(shell("gh pr view 7 && curl https://x").deny, true);
  assertEquals(shell("git push origin HEAD").deny, true);
  assertEquals(shell("cat a > /state/other/file").deny, true);
  assertEquals(shell("cat a >> ../escape").deny, true);
  assertEquals(shell("mkdir /state/elsewhere").deny, true);
  assertEquals(shell("cat $(rm -rf /)").deny, true);
  assertEquals(
    decideReviewRoundTool(
      {
        tool_name: "apply_patch",
        tool_input: {
          input: "*** Begin Patch\n*** Add File: /state/x\n+hi\n*** End Patch",
        },
      },
      policy,
    ).deny,
    true,
  );
  assertEquals(
    decideReviewRoundTool(
      {
        tool_name: "apply_patch",
        tool_input: {
          input:
            `*** Begin Patch\n*** Add File: ${ROUND_DIR}/note.md\n+hi\n*** End Patch`,
        },
      },
      policy,
    ),
    { deny: false },
  );
  assertEquals(
    decideReviewRoundTool(
      { tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } },
      policy,
    ).deny,
    true,
  );
  assertEquals(
    decideReviewRoundTool({ tool_name: "WebFetch", tool_input: {} }, policy)
      .deny,
    true,
  );
});

Deno.test("the guard's hook settings translate to Codex PreToolUse args", () => {
  const args = buildCodexArgs({
    prompt: "",
    promptViaStdin: true,
    settingsJson: reviewRoundGuardSettings(
      policy,
      "/usr/bin/deno",
      "/workspace/worker/deno/lib/review_round_guard.ts",
    ),
  });
  assertStringIncludes(args.join(" "), "--dangerously-bypass-hook-trust");
  const hooks = args.find((arg) => arg.startsWith("hooks.PreToolUse=")) ?? "";
  assertStringIncludes(hooks, 'matcher="Bash"');
  assertStringIncludes(hooks, "review_round_guard.ts");
});

/** Run the guard as the hook does, over one payload. */
async function runGuard(payload: unknown) {
  const settings = JSON.parse(
    reviewRoundGuardSettings(
      policy,
      Deno.execPath(),
      new URL("../lib/review_round_guard.ts", import.meta.url).pathname,
    ),
  );
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
  const child = new Deno.Command("sh", {
    args: ["-c", command],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const out = await child.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

Deno.test("the guard process refuses a disallowed command and lets post.ts through", async () => {
  const denied = await runGuard({
    tool_name: "Bash",
    tool_input: { command: "rm -rf /state" },
    cwd: "/workspace",
  });
  assertEquals(denied.code, 2);
  assertStringIncludes(denied.stdout, '"permissionDecision":"deny"');
  const allowed = await runGuard({
    tool_name: "Bash",
    tool_input: {
      command: `deno run --allow-read post.ts < ${ROUND_DIR}/review.json`,
    },
    cwd: "/workspace",
  });
  assertEquals(allowed, { code: 0, stdout: "" });
});
