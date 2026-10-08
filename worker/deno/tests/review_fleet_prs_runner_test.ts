/**
 * The unattended runner of the review-fleet-prs Claude Code skill (run.sh).
 * The gate, the worker's launch plan and the container runtime are stubbed on
 * PATH, so these pin the runner's own contract: one headless round per gate
 * result, run in the worker container (Issue #3293), nothing when nothing is
 * ready, and one runner per machine.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const RUNNER = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/scripts/run.sh",
    import.meta.url,
  ),
);

// The old root-level path (Issue #3299): a forwarding shim now sits here,
// `exec`ing scripts/run.sh with the shim's own arguments.
const SHIM = fromFileUrl(
  new URL("../../../.claude/skills/review-fleet-prs/run.sh", import.meta.url),
);

const READY = JSON.stringify({
  ready: [{ repo: "owner/repo", number: 7, title: "Fix it" }],
  skipped: {},
});

// The App token stub prints `tokenOutput` (empty = no pr_reviewer_app) and
// exits `tokenExit`; the gate stub records its token and arguments; the
// escalate stub records its arguments and GH_TOKEN, and exits `escalateExit`.
// The launch-plan stub writes a worker plan with one named volume, the log
// directory's mount and the checkout's; the `container` stub records a run's
// arguments and environment, then runs `$HOME/round` when there is one.
async function fixture(
  gateOutput: string,
  gateExit = 0,
  tokenOutput = "",
  tokenExit = 0,
  escalateExit = 0,
  gateStderr = "",
) {
  const home = await Deno.makeTempDir();
  const bin = `${home}/bin`;
  await Deno.mkdir(bin);
  const stub = async (name: string, body: string) => {
    await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  };
  await stub(
    "deno",
    `case "$*" in
  *review_log.ts*) echo "$HOME/logs/review-fleet-prs"; exit 0 ;;
  *app_token.ts*) printf '%s' '${tokenOutput}'
    [ ${tokenExit} = 0 ] || echo "reviewer App token: Bad credentials" >&2
    exit ${tokenExit} ;;
  *post.ts*) for a in "$@"; do case "$a" in --input=*) cat "\${a#--input=}" >> "$HOME/post-inputs"; echo >> "$HOME/post-inputs" ;; esac; done
    echo '{"posted":true,"outcome":"changes_requested"}'; exit 0 ;;
  *container-launch-plan*) out=""; prev=""
    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
    echo "$*" > "$HOME/plan-args"
    [ -f "$HOME/no-plan" ] && { echo "Cannot launch: no config" >&2; exit 1; }
    printf '%s\\000' runtime=fake-runtime image=vibe-coder:test \
      exists=image exists=inspect exists=vibe-coder:test \
      "ensure=$HOME/ensured" volume=vibe-work volume-resettable=vibe-work \
      run=run run=--rm run=--name run=vibe-coder-plan \
      run=--volume run=vibe-work:/home/vibe/auto-issue-work \
      run=--volume "run=$HOME/logs:/home/vibe/logs" \
      run=--volume "run=$HOME/repo:/workspace:ro" \
      run=--workdir run=/workspace run=--env run=VIBE_BASE_DIR=/workspace \
      run=vibe-coder:test > "$out"; exit 0 ;;
  *escalate.ts*) echo "$*" >> "$HOME/escalate-args"
    echo "GH_TOKEN=\${GH_TOKEN:-unset}" >> "$HOME/escalate-env"
    [ ${escalateExit} = 0 ] || echo "escalate: boom" >&2
    exit ${escalateExit} ;;
esac
[ ${gateExit} = 0 ] || echo "gate: boom" >&2
[ -n '${gateStderr}' ] && echo '${gateStderr}' >&2
echo "GH_TOKEN=\${GH_TOKEN:-} $*" > "$HOME/gate-args"
echo '${gateOutput}'; exit ${gateExit}`,
  );
  // Not `container`: run.sh appends the usual install directories to PATH,
  // where a real runtime of that name may sit.
  await stub(
    "fake-runtime",
    `case "$1" in
  image) [ -f "$HOME/no-image" ] && exit 1; exit 0 ;;
  kill) echo "$*" >> "$HOME/container-kills"; exit 0 ;;
esac
echo "GH_TOKEN=\${GH_TOKEN:-}" > "$HOME/claude-args"
printf '%s\\n' "$@" >> "$HOME/claude-args"
[ -x "$HOME/round" ] && exec "$HOME/round"
exit 0`,
  );
  return home;
}

async function run(home: string, ...args: string[]) {
  return runBash(home, [RUNNER, ...args]);
}

// What the round inside the stub container does, or, when `body` is null,
// no container runtime on PATH at all.
async function claudeStub(home: string, body: string | null) {
  if (body === null) {
    await Deno.remove(`${home}/bin/fake-runtime`);
    return;
  }
  await Deno.writeTextFile(`${home}/round`, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(`${home}/round`, 0o755);
}

// Runs under `bash -x`, to check the minted token is never traced.
async function runTraced(home: string, ...args: string[]) {
  return runBash(home, ["-x", RUNNER, ...args]);
}

async function runBash(
  home: string,
  bashArgs: string[],
  env: Record<string, string> = {},
) {
  const out = await new Deno.Command("bash", {
    args: bashArgs,
    env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin`, ...env },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    output: new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr),
  };
}

async function recorded(home: string, file: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${home}/${file}`);
  } catch {
    return null;
  }
}
const claudeArgs = (home: string) => recorded(home, "claude-args");

// The prompt the runner wrote for the (one) round.
async function roundPrompt(home: string): Promise<string> {
  const rounds = `${home}/logs/review-fleet-prs/rounds`;
  for await (const entry of Deno.readDir(rounds)) {
    return await Deno.readTextFile(`${rounds}/${entry.name}/prompt.md`);
  }
  throw new Error("no round directory");
}

Deno.test("run.sh --once reviews the gate's ready PRs in one headless round in the worker container", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = await claudeArgs(home);
  assert(args, "the round was not started");
  // The worker image, run in the entrypoint's review-round mode.
  assertStringIncludes(args, "vibe-coder:test\nreview-round\n--prompt-file\n");
  assertStringIncludes(args, "--claude-args");
  const prompt = await roundPrompt(home);
  assertStringIncludes(prompt, '"repo":"owner/repo","number":7');
  assertStringIncludes(prompt, "do NOT start gate.ts");
  // Every path the round is given is the container's.
  assertStringIncludes(
    prompt,
    "/workspace/.claude/skills/review-fleet-prs/scripts",
  );
  assertStringIncludes(prompt, "--state-dir=/home/vibe/logs/review-fleet-prs");
  // The headless session may write its round files: only an Edit rule on
  // an absolute (//-anchored) path allows that.
  assertStringIncludes(
    args,
    '"Edit(//home/vibe/logs/review-fleet-prs/rounds/',
  );
  // The log sits beside the Vibe Coder's own, not in a hidden directory.
  assertStringIncludes(
    await Deno.readTextFile(`${home}/logs/review-fleet-prs/runner.log`),
    "gate: owner/repo#7",
  );
});

Deno.test("run.sh --once starts no Claude session when nothing is ready", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh logs an idle pass as one line with the gate's skip counts", async () => {
  const home = await fixture(
    JSON.stringify({ ready: [], skipped: { "ci-failed": 4, "waiting-ci": 2 } }),
  );
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const log = await runnerLog(home);
  assertStringIncludes(log, "gate: nothing ready (ci-failed 4, waiting-ci 2)");
  assertEquals(log.trim().split("\n").length, 1, log);
});

Deno.test("run.sh --once fails without a Claude session when the gate fails", async () => {
  const home = await fixture("", 1);
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh refuses to start while another runner holds the lock", async () => {
  const home = await fixture(READY);
  const lock = `${home}/logs/review-fleet-prs/runner.lock`;
  await Deno.mkdir(lock, { recursive: true });
  await Deno.writeTextFile(`${lock}/pid`, String(Deno.pid)); // alive
  const { code, output } = await run(home, "--once");
  assertEquals(code, 1);
  assertStringIncludes(output, "already running");
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh takes over a lock left by a runner that died", async () => {
  const home = await fixture(READY);
  const lock = `${home}/logs/review-fleet-prs/runner.lock`;
  await Deno.mkdir(lock, { recursive: true });
  await Deno.writeTextFile(`${lock}/pid`, "999999"); // no such process
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assert(await claudeArgs(home), "Claude was not started");
});

const APP_TOKEN = JSON.stringify({
  token: "ghs_test",
  login: "stsoftware-pr-reviewer[bot]",
});

Deno.test("run.sh reviews as the reviewer App when pr_reviewer_app is set", async () => {
  const home = await fixture(READY, 0, APP_TOKEN);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const gate = await recorded(home, "gate-args");
  assertStringIncludes(gate!, "GH_TOKEN=ghs_test");
  assertStringIncludes(gate!, "--reviewer=stsoftware-pr-reviewer[bot]");
  assertStringIncludes((await claudeArgs(home))!, "GH_TOKEN=ghs_test");
});

Deno.test("run.sh reviews as the gh user when no reviewer App is configured", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const gate = await recorded(home, "gate-args");
  assertStringIncludes(gate!, "GH_TOKEN= ");
  assertEquals(gate!.includes("--reviewer"), false);
});

Deno.test("run.sh never falls back to the gh user when the App token fails", async () => {
  const home = await fixture(READY, 0, "", 1);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 1);
  // The reason reaches the terminal, not only the log.
  assertStringIncludes(output, "reviewer App token: Bad credentials");
  assertEquals(await recorded(home, "gate-args"), null);
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh --once also runs housekeep, pruning old round directories", async () => {
  const home = await fixture(READY);
  const roundsDir = `${home}/logs/review-fleet-prs/rounds`;
  await Deno.mkdir(roundsDir, { recursive: true });
  const oldRound = `${roundsDir}/20200101-000000`;
  await Deno.mkdir(oldRound);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await Deno.utime(oldRound, old, old);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  let pruned = false;
  try {
    await Deno.stat(oldRound);
  } catch {
    pruned = true;
  }
  assert(pruned, "a round older than 30 days was not pruned");
});

Deno.test("run.sh housekeep empties an oversized service.out in place", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  const dir = `${home}/logs/review-fleet-prs`;
  await Deno.mkdir(dir, { recursive: true });
  const big = `${dir}/service.out`;
  await Deno.writeFile(big, new Uint8Array(10_000_001));
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  // Emptied, not renamed: launchd keeps writing to the same open file.
  assertEquals((await Deno.stat(big)).size, 0);
  // A file at the limit is left alone.
  await Deno.writeFile(big, new Uint8Array(10_000_000));
  await run(home, "--once");
  assertEquals((await Deno.stat(big)).size, 10_000_000);
});

Deno.test("run.sh never traces the minted App token, even under bash -x", async () => {
  const home = await fixture(READY, 0, APP_TOKEN);
  const { code, output } = await runTraced(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(output.includes("ghs_test"), false);
  // The token was still used, just never printed to the trace.
  const gate = await recorded(home, "gate-args");
  assertStringIncludes(gate!, "GH_TOKEN=ghs_test");
  assertStringIncludes((await claudeArgs(home))!, "GH_TOKEN=ghs_test");
});

Deno.test("run.sh escalates a failing gate pass without leaking the App token to escalate.ts", async () => {
  // A token is minted (and exported for gate.ts and Claude) before the gate
  // fails, so this actually exercises escalate_result's `env -u GH_TOKEN`:
  // with no token minted, GH_TOKEN was never set and the assertion below
  // would pass even if `env -u GH_TOKEN` were dropped.
  const home = await fixture("", 1, APP_TOKEN);
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  const args = await recorded(home, "escalate-args");
  assertStringIncludes(args!, "--result=fail");
  assertStringIncludes(args!, "--error=");
  assertStringIncludes(args!, "gate: boom");
  assertStringIncludes(
    (await recorded(home, "escalate-env"))!,
    "GH_TOKEN=unset",
  );
});

Deno.test("run.sh logs gate.ts's non-fatal stderr even when the gate pass succeeds", async () => {
  // gate.ts reports refused Dependabot upkeep (rebase/auto-merge failures)
  // on stderr while still exiting 0 (#2950); that must still reach the log.
  const home = await fixture(
    JSON.stringify({ ready: [], skipped: {} }),
    0,
    "",
    0,
    0,
    "owner/repo#7 auto-merge failed: review required",
  );
  const { code } = await run(home, "--once");
  assertEquals(code, 0);
  assertStringIncludes(
    await Deno.readTextFile(`${home}/logs/review-fleet-prs/runner.log`),
    "owner/repo#7 auto-merge failed: review required",
  );
});

Deno.test("run.sh escalates a successful pass as ok", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = await recorded(home, "escalate-args");
  assertStringIncludes(args!, "--result=ok");
});

Deno.test("run.sh logs, but does not fail on, an escalate.ts failure", async () => {
  const home = await fixture(
    JSON.stringify({ ready: [], skipped: {} }),
    0,
    "",
    0,
    1,
  );
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertStringIncludes(
    await Deno.readTextFile(`${home}/logs/review-fleet-prs/runner.log`),
    "escalation failed",
  );
});

const runnerLog = (home: string) =>
  Deno.readTextFile(`${home}/logs/review-fleet-prs/runner.log`);

Deno.test("run.sh fails and escalates a Claude round that exits non-zero", async () => {
  const home = await fixture(READY);
  await claudeStub(home, 'echo "model overloaded" >&2; exit 3');
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  const log = await runnerLog(home);
  assertStringIncludes(log, "round failed (exit 3)");
  assert(!log.includes("round done"), log);
  const args = await recorded(home, "escalate-args");
  assertStringIncludes(args!, "--result=fail");
  assertStringIncludes(args!, "model overloaded");
});

Deno.test("run.sh fails a round whose container runtime is not on PATH, rather than reporting it done", async () => {
  const home = await fixture(READY);
  await claudeStub(home, null);
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  const log = await runnerLog(home);
  assertStringIncludes(log, "round not started");
  assertStringIncludes(log, "cannot run fake-runtime");
  assert(!log.includes("round done"), log);
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "--result=fail",
  );
});

Deno.test("run.sh reports a round the alarm killed as timed out", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exec sleep 30");
  const { code } = await runBash(home, [RUNNER, "--once"], {
    REVIEW_FLEET_PRS_ROUND_TIMEOUT: "1",
  });
  assertEquals(code, 1);
  const log = await runnerLog(home);
  assertStringIncludes(log, "round timed out after 1s");
  assert(!log.includes("round done"), log);
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "--error=round timed out after 1s",
  );
});

Deno.test("run.sh logs round done and escalates ok when the round succeeds", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertStringIncludes(await runnerLog(home), "round done");
  assertStringIncludes((await recorded(home, "escalate-args"))!, "--result=ok");
});

// Issue #3142: a red dependency audit CI-fix could not clear is sent back by
// post.ts with the gate's ready-made review, with no Claude round.
const AUDIT_BLOCKED = {
  repo: "owner/repo",
  number: 9,
  headSha: "abc123",
  check: "audit",
  review: {
    summary: "audit red",
    findings: [{ file: "audit", line: 0, problem: "fix it in this PR" }],
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
  },
};

Deno.test("run.sh posts each auditBlocked PR with post.ts and starts no Claude round for it (Issue #3142)", async () => {
  const home = await fixture(
    JSON.stringify({ ready: [], auditBlocked: [AUDIT_BLOCKED], skipped: {} }),
  );
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await claudeArgs(home), null);
  const inputs = (await recorded(home, "post-inputs") ?? "").trim()
    .split("\n").filter((l) => l !== "");
  assertEquals(inputs.length, 1, inputs.join("\n"));
  const input = JSON.parse(inputs[0]!);
  assertEquals(input.pr.repo, "owner/repo");
  assertEquals(input.pr.number, 9);
  assertEquals(input.pr.headSha, "abc123");
  assertEquals(input.review, AUDIT_BLOCKED.review);
  assertStringIncludes(await runnerLog(home), "audit send-back: owner/repo#9");
});

Deno.test("run.sh keeps auditBlocked PRs out of the Claude round's prompt (Issue #3142)", async () => {
  const home = await fixture(JSON.stringify({
    ready: [{ repo: "owner/repo", number: 7, title: "Fix it" }],
    auditBlocked: [AUDIT_BLOCKED],
    skipped: {},
  }));
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assert(await claudeArgs(home), "the round was not started");
  const prompt = await roundPrompt(home);
  assertStringIncludes(prompt, '"repo":"owner/repo","number":7');
  assertEquals(prompt.includes("auditBlocked"), false, prompt);
  assertEquals(
    ((await recorded(home, "post-inputs")) ?? "").includes('"number":9'),
    true,
  );
});

// ---------------------------------------------------------------------------
// Issue #3293: the round runs in the worker container, from the worker's own
// launch plan; the subscription and its rotation are the driver's (see
// review_round_test.ts).
// ---------------------------------------------------------------------------

Deno.test("run.sh leaves the worker's named volumes out of the round's container (Issue #3293)", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = (await claudeArgs(home))!;
  assertEquals(args.includes("vibe-work:"), false, args);
  assertStringIncludes(args, `${home}/logs:/home/vibe/logs`);
  assertStringIncludes(args, `${home}/repo:/workspace:ro`);
  // The plan's ensured directories are made before the run.
  assert((await Deno.stat(`${home}/ensured`)).isDirectory);
});

Deno.test("run.sh passes the reviewer App token to the container by name only (Issue #3293)", async () => {
  const home = await fixture(READY, 0, APP_TOKEN);
  const { code, output } = await runTraced(home, "--once");
  assertEquals(code, 0, output);
  const args = (await claudeArgs(home))!;
  assertStringIncludes(args, "--env\nGH_TOKEN\n");
  // The value reaches the runtime's environment, never its command line,
  // the trace or the round's files.
  assertStringIncludes(args, "GH_TOKEN=ghs_test");
  assertEquals(
    args.split("\n").slice(1).join("\n").includes("ghs_test"),
    false,
  );
  assertEquals(output.includes("ghs_test"), false);
  assertEquals((await roundPrompt(home)).includes("ghs_test"), false);
});

Deno.test("run.sh passes no GH_TOKEN to the container without a reviewer App (Issue #3293)", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals((await claudeArgs(home))!.includes("--env\nGH_TOKEN\n"), false);
});

Deno.test("run.sh fails a pass whose worker image is not built, naming the fix (Issue #3293)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/no-image`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(await runnerLog(home), "the worker image is not built");
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "--result=fail",
  );
});

Deno.test("run.sh fails a pass whose worker launch plan fails (Issue #3293)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/no-plan`, "");
  const { code, output } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(output, "Cannot launch: no config");
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "worker container plan failed",
  );
});

Deno.test("run.sh kills a timed-out round's container by name (Issue #3293)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exec sleep 30");
  const { code } = await runBash(home, [RUNNER, "--once"], {
    REVIEW_FLEET_PRS_ROUND_TIMEOUT: "1",
  });
  assertEquals(code, 1);
  assertStringIncludes(
    (await recorded(home, "container-kills"))!,
    "kill review-fleet-prs-",
  );
});

// ---------------------------------------------------------------------------
// Issue #3299: the root-level run.sh is now a forwarding shim that execs
// scripts/run.sh; hosts installed before the move still start the old path.
// ---------------------------------------------------------------------------

Deno.test("run.sh's root-level shim reaches scripts/run.sh and runs a headless round (Issue #3299)", async () => {
  const home = await fixture(READY);
  const { code, output } = await runBash(home, [SHIM, "--once"]);
  assertEquals(code, 0, output);
  // A positive signal the call actually reached scripts/run.sh: only
  // scripts/run.sh's own `pass` starts a Claude round in the container.
  const args = await claudeArgs(home);
  assert(args, "the shim did not reach scripts/run.sh (no round was started)");
  assertStringIncludes(
    await runnerLog(home),
    "gate: owner/repo#7",
  );
});

Deno.test("run.sh's root-level shim forwards scripts/run.sh's non-zero exit status (Issue #3299)", async () => {
  // A gate failure is a reliable non-zero case for scripts/run.sh --once.
  const direct = await fixture("", 1);
  const { code: directCode } = await run(direct, "--once");
  assert(directCode !== 0, "scripts/run.sh did not fail as expected");

  const home = await fixture("", 1);
  const { code, output } = await runBash(home, [SHIM, "--once"]);
  assertEquals(code, directCode, output);
  assertEquals(code === 0, false, output);
});

// ---------------------------------------------------------------------------
// Issue #3299: --install must point the service manager at scripts/run.sh,
// not the root-level shim, whichever path is used to invoke it.
// ---------------------------------------------------------------------------

// Stubs the service-manager commands --install shells out to, recording
// their arguments so the generated unit/plist can be inspected.
async function installStubs(home: string, platform: "Darwin" | "Linux") {
  const bin = `${home}/bin`;
  const stub = async (name: string, body: string) => {
    await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  };
  await stub("uname", `[ "$1" = "-s" ] && echo ${platform}; exit 0`);
  await stub(
    "launchctl",
    `echo "$*" >> "$HOME/launchctl-args"; exit 0`,
  );
  await stub(
    "systemctl",
    `echo "$*" >> "$HOME/systemctl-args"; exit 0`,
  );
  await stub("loginctl", `echo "$*" >> "$HOME/loginctl-args"; exit 0`);
}

Deno.test("run.sh --install writes the scripts/run.sh path into the launchd plist on macOS (Issue #3299)", async () => {
  const home = await fixture(READY);
  await installStubs(home, "Darwin");
  const { code, output } = await run(home, "--install");
  assertEquals(code, 0, output);
  const plist = await Deno.readTextFile(
    `${home}/Library/LaunchAgents/au.com.stsoftware.review-fleet-prs.plist`,
  );
  assertStringIncludes(plist, "<string>" + RUNNER + "</string>");
  assertEquals(plist.includes(`<string>${SHIM}</string>`), false, plist);
});

Deno.test("run.sh --install writes the scripts/run.sh path into the systemd unit on Linux (Issue #3299)", async () => {
  const home = await fixture(READY);
  await installStubs(home, "Linux");
  const { code, output } = await runBash(home, [RUNNER, "--install"], {
    USER: "tester",
  });
  assertEquals(code, 0, output);
  const unit = await Deno.readTextFile(
    `${home}/.config/systemd/user/review-fleet-prs.service`,
  );
  const execStart = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert(execStart, unit);
  assertStringIncludes(execStart!, `/bin/bash ${RUNNER}`);
  assert(execStart!.endsWith("/scripts/run.sh"), execStart);
  assertEquals(execStart!.includes(SHIM), false, execStart);
});

Deno.test("run.sh's root-level shim still installs the scripts/run.sh path (Issue #3299)", async () => {
  const home = await fixture(READY);
  await installStubs(home, "Linux");
  const { code, output } = await runBash(home, [SHIM, "--install"], {
    USER: "tester",
  });
  assertEquals(code, 0, output);
  const unit = await Deno.readTextFile(
    `${home}/.config/systemd/user/review-fleet-prs.service`,
  );
  const execStart = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert(execStart, unit);
  assert(execStart!.endsWith("/scripts/run.sh"), execStart);
  assertEquals(execStart!.includes(SHIM), false, execStart);
});
