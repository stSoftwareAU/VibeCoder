/**
 * The unattended runner of the review-fleet-prs Claude Code skill (run.sh).
 * The gate and Claude are stubbed on PATH, so these pin the runner's own
 * contract: one headless Claude round per gate result, nothing when nothing
 * is ready, and one runner per machine.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const RUNNER = fromFileUrl(
  new URL("../../../.claude/skills/review-fleet-prs/run.sh", import.meta.url),
);

const READY = JSON.stringify({
  ready: [{ repo: "owner/repo", number: 7, title: "Fix it" }],
  skipped: {},
});

// The App token stub prints `tokenOutput` (empty = no pr_reviewer_app) and
// exits `tokenExit`; the gate stub records its token and arguments; the
// escalate stub records its arguments and GH_TOKEN, and exits `escalateExit`.
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
  await stub(
    "claude",
    `echo "GH_TOKEN=\${GH_TOKEN:-}" > "$HOME/claude-args"
printf '%s\\n' "$@" >> "$HOME/claude-args"`,
  );
  return home;
}

async function run(home: string, ...args: string[]) {
  return runBash(home, [RUNNER, ...args]);
}

// Replaces the Claude stub with `body`, or removes it when `body` is null so
// `claude` is not on PATH at all.
async function claudeStub(home: string, body: string | null) {
  const path = `${home}/bin/claude`;
  if (body === null) {
    await Deno.remove(path);
    return;
  }
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
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

Deno.test("run.sh --once reviews the gate's ready PRs in one headless Claude round", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = await claudeArgs(home);
  assert(args, "Claude was not started");
  assertStringIncludes(args, "-p");
  assertStringIncludes(args, '"repo":"owner/repo","number":7');
  assertStringIncludes(args, "do NOT start gate.ts");
  // The headless session may write its round files: only an Edit rule on
  // an absolute (//-anchored) path allows that.
  assertStringIncludes(args, "Edit(//");
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

Deno.test("run.sh fails a round whose claude is not on PATH, rather than reporting it done", async () => {
  const home = await fixture(READY);
  await claudeStub(home, null);
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  const log = await runnerLog(home);
  assertStringIncludes(log, "round failed");
  assertStringIncludes(log, "cannot run claude");
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
