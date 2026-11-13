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

Deno.test("the guard fails closed on shell syntax it does not model (Issue #5083)", () => {
  // Each line runs an off-list command or writes outside the round in bash.
  for (
    const line of [
      // `>&word` is a file redirect unless the word is a descriptor.
      "cat x >&/state/guidance.md",
      // `$'\''` is one quote char to bash, so `;` and `rm` are unquoted.
      "gh $'\\'' ; rm -rf /state #'",
      'gh $"x" > /tmp/a',
      // A quote in an input-redirect target opens a quote bash also sees.
      "gh <x' '; rm -rf /state; echo '",
      // A quote in a comment is not a quote.
      "gh x #'\nrm -rf /state\n'",
      // Brace, parameter and tilde expansion move the write target.
      "mkdir /tmp/{a,../../state/b}",
      "cat x > /tmp/${X:-../state/y}",
      "cat x > $HOME/x",
      "mkdir ~/x",
      // `<>` opens for writing; `&>` and `>|` write too.
      "cat <>/state/new",
      "cat x &>/state/y",
      "cat x >| /state/q",
      // An unquoted here-document body is expanded; a quoted one ends at
      // its marker, and what follows is checked.
      "cat <<EOF > /tmp/x\n$(rm -rf /state)\nEOF",
      "cat <<'EOF' > /tmp/x\nhi\nEOF\nrm -rf /state",
      "gh x >",
    ]
  ) {
    assertEquals(shell(line).deny, true, line);
  }
  for (
    const line of [
      "gh x 2>&1 >&2 | cat",
      `cat <<'EOF' > ${ROUND_DIR}/review.json\n{"a": "$(not run)"}\nEOF`,
      "gh x < 'a b' | head -1",
      "cat <<< 'a; b'",
      "gh x &>> /tmp/z",
    ]
  ) {
    assertEquals(shell(line), { deny: false }, line);
  }
});

Deno.test("the guard checks a shell line that carries a patch as shell (Issue #5083)", () => {
  const patch = (path: string) =>
    `*** Begin Patch\n*** Add File: ${path}\n+hi\n*** End Patch`;
  assertEquals(shell(`rm -rf /state # *** Begin Patch`).deny, true);
  assertEquals(
    shell(`apply_patch <<'EOF'\n${patch(`${ROUND_DIR}/a.md`)}\nEOF`),
    { deny: false },
  );
  assertEquals(
    shell(`apply_patch <<'EOF'\n${patch("/state/x")}\nEOF`).deny,
    true,
  );
  // A marker line inside the body ends the here-document early in bash.
  assertEquals(
    shell(
      `apply_patch <<'EOF'\n*** Begin Patch\nEOF\nrm -rf /state\n*** End Patch\nEOF`,
    ).deny,
    true,
  );
  const argv = (command: string[]) =>
    decideReviewRoundTool(
      { tool_name: "Bash", tool_input: { command }, cwd: "/workspace" },
      policy,
    );
  assertEquals(argv(["apply_patch", patch("/tmp/a")]), { deny: false });
  assertEquals(argv(["apply_patch", patch("/state/a")]).deny, true);
  assertEquals(argv(["bash", "-lc", "rm -rf /state"]).deny, true);
  // A patch field does not stand in for the shell command beside it.
  assertEquals(
    decideReviewRoundTool(
      {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /state", input: patch("/tmp/a") },
      },
      policy,
    ).deny,
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

Deno.test("the guard refuses a relative write or mkdir target on a line that changes directory (Issue #5083)", () => {
  // run.sh's round list carries `cd`, which the guard does not follow, so a
  // relative target after one would resolve against a directory it never saw.
  const cdPolicy = reviewRoundToolPolicy([...ROUND_ARGS, "Bash(cd:*)"]);
  const cdShell = (command: string) =>
    decideReviewRoundTool(
      { tool_name: "Bash", tool_input: { command }, cwd: "/workspace" },
      cdPolicy,
    );
  // Bash would write /state/review-fleet-prs/tmp/y, outside /tmp and the round.
  assertEquals(
    cdShell("cd /state/review-fleet-prs && cat /tmp/a > ../tmp/y").deny,
    true,
  );
  assertEquals(
    cdShell("cd /state/review-fleet-prs && mkdir -p ../tmp/q").deny,
    true,
  );
  assertEquals(
    cdShell("(cd /state/review-fleet-prs; cat /tmp/a >> tmp/y)").deny,
    true,
  );
  assertEquals(
    cdShell("cd /state/review-fleet-prs && cat /tmp/a 2> y").deny,
    true,
  );
  // An absolute target after `cd` is still checked, and allowed under /tmp.
  assertEquals(
    cdShell("cd /state/review-fleet-prs && cat /tmp/a > /tmp/y"),
    { deny: false },
  );
  assertEquals(
    cdShell("cd /state/review-fleet-prs && mkdir -p /tmp/q"),
    { deny: false },
  );
  assertEquals(
    cdShell("cd /state/review-fleet-prs && cat /tmp/a > /state/x").deny,
    true,
  );
  // With no `cd` on the line, a relative target still resolves from the cwd.
  assertEquals(
    decideReviewRoundTool(
      {
        tool_name: "Bash",
        tool_input: { command: "cat a > out.txt" },
        cwd: "/tmp",
      },
      cdPolicy,
    ),
    { deny: false },
  );
});
