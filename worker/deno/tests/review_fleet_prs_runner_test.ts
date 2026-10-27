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
  ready: [{
    repo: "owner/repo",
    number: 7,
    title: "Fix it",
    headSha: "abc123",
  }],
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
  *review_cost.ts*) echo "GH_TOKEN=\${GH_TOKEN:-} $*" >> "$HOME/cost-args"
    echo '{"round":"r","attempts":[],"amended":0,"errors":[]}'; exit 0 ;;
  *post.ts*) echo "$*" >> "$HOME/post-args"
    for a in "$@"; do case "$a" in --input=*) cat "\${a#--input=}" >> "$HOME/post-inputs"; echo >> "$HOME/post-inputs" ;; esac; done
    echo '{"posted":true,"outcome":"changes_requested"}'; exit 0 ;;
  *container-launch-plan*) out=""; prev=""
    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
    echo "$*" > "$HOME/plan-args"
    [ -f "$HOME/no-plan" ] && { echo "Cannot launch: no config" >&2; exit 1; }
    [ -f "$HOME/plan-refused" ] && {
      echo "container-launch-plan: host disk 65.1 GB free of 460.4 GB" >&2
      echo "Refusing to launch: container name is not a plain name"; exit 1; }
    printf '%s\\000' runtime=fake-runtime image=vibe-coder:test \
      exists=image exists=inspect exists=vibe-coder:test \
      "ensure=$HOME/ensured" volume=vibe-work volume-resettable=vibe-work \
      run=run run=--rm run=--name run=vibe-coder-plan \
      run=--volume run=vibe-work:/home/vibe/auto-issue-work \
      run=--volume "run=$HOME/logs:/home/vibe/logs" \
      run=--volume "run=$HOME/repo:/workspace:ro" \
      run=--workdir run=/workspace run=--env run=VIBE_BASE_DIR=/workspace \
      run=vibe-coder:test > "$out"
    [ -f "$HOME/plan-egress" ] && tr '\\n' '\\000' < "$HOME/plan-egress" >> "$out"
    exit 0 ;;
  *apple_egress_launch_main*) echo "$*" > "$HOME/egress-args"
    [ -f "$HOME/egress-fail" ] && { echo "[egress] apple boom" >&2; exit 1; }
    trap 'echo stopped >> "$HOME/egress-events"; exit 0' TERM
    ready=""; n=0
    for a in "$@"; do
      case "$a" in *apple_egress_launch_main.ts) n=1; continue ;; esac
      [ $n -gt 0 ] && n=$((n + 1)); [ $n = 3 ] && ready="$a"
    done
    printf '%s\\000' run --env HTTPS_PROXY=http://10.0.0.2:3128 --rm \
      --name vibe-coder-plan --network vibe-egress-owned-1-abc \
      --volume vibe-work:/home/vibe/auto-issue-work \
      --volume "$HOME/logs:/home/vibe/logs" \
      --volume "$HOME/repo:/workspace:ro" \
      --workdir /workspace vibe-coder:test > "$ready"
    while :; do sleep 0.1; done ;;
  *claim.ts*) echo "$*" >> "$HOME/claim-args"
    case "$*" in
    *"claim.ts release"*) echo "$*" >> "$HOME/release-args"
      [ -f "$HOME/release-error" ] && { echo "release: boom (HTTP 500)" >&2; exit 1; }
      echo '{"released":1}'; exit 0 ;;
    esac
    [ -f "$HOME/claim-slow" ] && sleep 1
    echo claim >> "$HOME/order"
    [ -f "$HOME/claim-lost" ] && { echo '{"won":false,"id":2}'; exit 0; }
    [ -f "$HOME/claim-error" ] && { echo "claim: boom (HTTP 403)" >&2; exit 1; }
    [ -f "$HOME/claim-garbage" ] && { echo "not json"; exit 0; }
    echo '{"won":true,"id":1}'; exit 0 ;;
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
  // The runner's host name, with a space: run.sh must sanitise it (Issue #4398).
  await stub("hostname", "echo 'fleet host'");
  // Not `container`: run.sh appends the usual install directories to PATH,
  // where a real runtime of that name may sit.
  await stub(
    "fake-runtime",
    `case "$1" in
  image) [ -f "$HOME/no-image" ] && exit 1; exit 0 ;;
  kill) echo "$*" >> "$HOME/container-kills"; exit 0 ;;
esac
echo round >> "$HOME/order"
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
    ready: [{
      repo: "owner/repo",
      number: 7,
      title: "Fix it",
      headSha: "abc123",
    }],
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

// mod.ts reports a refusal on stdout, after its host-disk note on stderr:
// the runner must log the refusal, not the note (Issue #4409).
Deno.test("run.sh logs the launch plan's own refusal, not its host-disk note (Issue #4409)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/plan-refused`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertStringIncludes(
    await runnerLog(home),
    "worker container plan failed: Refusing to launch: container name",
  );
});

// The runtime takes a container name of at most 64 characters, and the
// egress launch derives `<name>-proxy` from it — so a round's name stays
// within 58 even for a long repository name (Issue #4409).
Deno.test("run.sh gives a long repository's round a container name the runtime accepts (Issue #4409)", async () => {
  const entry = (number: number) => ({
    repo: "stSoftwareAU/GRQ-AutoTraderBackTesting",
    number,
    title: "Fix it",
    headSha: "abc123",
  });
  const names: string[] = [];
  for (const number of [230, 231]) {
    const home = await fixture(
      JSON.stringify({ ready: [entry(number)], skipped: {} }),
    );
    const { code, output } = await run(home, "--once");
    assertEquals(code, 0, output);
    const planArgs = (await recorded(home, "plan-args"))!;
    const name = planArgs.match(/--container-name (\S+)/)?.[1] ?? "";
    assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,57}$/.test(name), name);
    assert(name.startsWith("review-fleet-prs-"), name);
    names.push(name);
  }
  // Two PRs of one repository still get two names.
  assert(names[0] !== names[1], names.join(" "));
});

// On Apple's runtime the plan's run joins an internal network that only its
// egress proxy reaches; the worker's helper builds both for the round and
// hands back the run to start (Issue #4409).
const APPLE_EGRESS =
  "egress-enforced=false\nproxy-name=vibe-coder-plan-proxy\n";

Deno.test("run.sh starts an Apple round on the network its egress helper built, then stops the helper (Issue #4409)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/plan-egress`, APPLE_EGRESS);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = (await claudeArgs(home))!;
  assert(args, "the round was not started");
  assertStringIncludes(args, "--network\nvibe-egress-owned-1-abc\n");
  assertStringIncludes(args, "HTTPS_PROXY=http://10.0.0.2:3128");
  // The helper's run is the round's: its named volumes are still left out.
  assert(!args.includes("vibe-work:"), args);
  assertStringIncludes(args, "vibe-coder:test\nreview-round\n");
  // The helper read the round's own plan and is owned by a live PID.
  const egressArgs = (await recorded(home, "egress-args"))!;
  assert(
    /logs\/review-fleet-prs\/rounds\/[^ ]+\/plan [^ ]+\/plan\.apple-ready [^ ]+ [1-9]\d*$/
      .test(egressArgs.trim()),
    egressArgs,
  );
  assertEquals(await recorded(home, "egress-events"), "stopped\n");
});

Deno.test("run.sh fails, without starting it, a round whose egress helper gives no run (Issue #4409)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/plan-egress`, APPLE_EGRESS);
  await Deno.writeTextFile(`${home}/egress-fail`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(
    await runnerLog(home),
    "egress setup failed: [egress] apple boom",
  );
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "egress setup failed",
  );
});

Deno.test("run.sh refuses a round whose plan needs the docker egress sidecar, rather than start it on an open network (Issue #4409)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(
    `${home}/plan-egress`,
    "egress-enforced=true\nproxy-name=vibe-coder-plan-proxy\n",
  );
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(await runnerLog(home), "egress sidecar");
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

// ---------------------------------------------------------------------------
// Which model wrote each review, and what it cost: the round streams
// stream-json, so its own result carries its per-model usage, and once it is
// over the runner adds each review's share of that cost (review_cost.ts).
// ---------------------------------------------------------------------------

Deno.test("run.sh asks the round for stream-json, so its result carries per-model usage", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const args = (await claudeArgs(home))!;
  assertStringIncludes(args, '"--output-format","stream-json","--verbose"');
  assertStringIncludes(args, '"--model","claude-opus-5-5","--effort","xhigh"');
});

Deno.test("run.sh prices the round's reviews once the round is over, as the reviewer App", async () => {
  const home = await fixture(READY, 0, APP_TOKEN);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const cost = (await recorded(home, "cost-args"))!;
  assert(cost, "review_cost.ts was not run");
  assertStringIncludes(cost, "GH_TOKEN=ghs_test");
  assertStringIncludes(
    cost,
    `--round-dir=${home}/logs/review-fleet-prs/rounds/`,
  );
  assertStringIncludes(await runnerLog(home), "round cost: ");
});

Deno.test("run.sh still prices a failed round's reviews, and the round stays failed", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exit 3");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assert(await recorded(home, "cost-args"), "review_cost.ts was not run");
});

Deno.test("run.sh prices nothing when nothing is ready", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await recorded(home, "cost-args"), null);
});

Deno.test("run.sh posts an audit send-back as a review with no model run", async () => {
  const home = await fixture(
    JSON.stringify({ ready: [], auditBlocked: [AUDIT_BLOCKED], skipped: {} }),
  );
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertStringIncludes((await recorded(home, "post-args"))!, "--no-model");
});

// ---------------------------------------------------------------------------
// Issues #4395-#4397: one round per ready PR, several at once; a freed slot
// is filled at the next tick; learning from recurring findings runs in a
// round of its own.
// ---------------------------------------------------------------------------

const TWO_READY = JSON.stringify({
  ready: [
    { repo: "owner/repo", number: 7, title: "Fix it", headSha: "abc123" },
    { repo: "owner/repo", number: 8, title: "Fix that", headSha: "def456" },
  ],
  skipped: {},
});

// Every round directory's prompt, by directory name.
async function roundPrompts(home: string): Promise<Map<string, string>> {
  const rounds = `${home}/logs/review-fleet-prs/rounds`;
  const prompts = new Map<string, string>();
  for await (const entry of Deno.readDir(rounds)) {
    try {
      prompts.set(
        entry.name,
        await Deno.readTextFile(`${rounds}/${entry.name}/prompt.md`),
      );
    } catch {
      // A directory with no prompt is not a round.
    }
  }
  return prompts;
}

// Runs the for-ever loop for `ms`, then stops it as a service manager would.
async function runFor(
  home: string,
  ms: number,
  env: Record<string, string> = {},
) {
  const child = new Deno.Command("bash", {
    args: [RUNNER],
    env: {
      HOME: home,
      PATH: `${home}/bin:/usr/bin:/bin`,
      REVIEW_FLEET_PRS_TICK: "1",
      ...env,
    },
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  await new Promise((r) => setTimeout(r, ms));
  child.kill("SIGTERM");
  await child.status;
}

const gateLines = (log: string) =>
  log.split("\n").filter((l) => / gate: /.test(l)).length;

Deno.test("run.sh reviews each ready PR in its own round, the rounds running at once (Issue #4395)", async () => {
  const home = await fixture(TWO_READY);
  // Each round waits until both have started: run one after the other, the
  // first would give up and fail.
  await claudeStub(
    home,
    `touch "$HOME/started-$$"
for i in $(seq 50); do
  [ "$(ls "$HOME" | grep -c '^started-')" -ge 2 ] && exit 0
  sleep 0.2
done
echo "rounds ran one at a time" >&2; exit 9`,
  );
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const prompts = [...(await roundPrompts(home)).values()];
  assertEquals(prompts.length, 2);
  // Each round is given its own PR and only that one.
  assertEquals(
    prompts.filter((p) => p.includes('"number":7')).length,
    1,
  );
  assertEquals(
    prompts.filter((p) => p.includes('"number":8')).length,
    1,
  );
  assert(
    prompts.every((p) =>
      !(p.includes('"number":7') && p.includes('"number":8'))
    ),
  );
  const log = await runnerLog(home);
  assertStringIncludes(log, "owner/repo#7: round done");
  assertStringIncludes(log, "owner/repo#8: round done");
});

Deno.test("run.sh names each round's container after its PR, so rounds started together never clash (Issue #4395)", async () => {
  const home = await fixture(TWO_READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const names = [...(await roundPrompts(home)).keys()].sort();
  assertEquals(names.length, 2);
  assert(names[0]!.endsWith("-owner-repo-7"), names[0]);
  assert(names[1]!.endsWith("-owner-repo-8"), names[1]);
});

Deno.test("run.sh asks the gate for as many PRs as pr_reviewer_parallel allows, 3 by default (Issue #4395)", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  await run(home, "--once");
  assertStringIncludes((await recorded(home, "gate-args"))!, "--limit=3");

  const config = `${home}/config.json`;
  await Deno.writeTextFile(config, JSON.stringify({ pr_reviewer_parallel: 1 }));
  await runBash(home, [RUNNER, "--once"], { REVIEW_FLEET_PRS_CONFIG: config });
  assertStringIncludes((await recorded(home, "gate-args"))!, "--limit=1");

  await Deno.writeTextFile(config, JSON.stringify({ pr_reviewer_parallel: 0 }));
  await runBash(home, [RUNNER, "--once"], { REVIEW_FLEET_PRS_CONFIG: config });
  assertStringIncludes((await recorded(home, "gate-args"))!, "--limit=3");
  assertStringIncludes(
    await runnerLog(home),
    "pr_reviewer_parallel must be a whole number above 0",
  );
});

Deno.test("run.sh's review round skips learning from recurring findings (Issue #4397)", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const prompt = await roundPrompt(home);
  assertStringIncludes(prompt, "Skip step 3 (Learn from recurring");
});

Deno.test("run.sh tells the gate which PRs are in a round, and never starts a PR twice (Issue #4395)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exec sleep 30");
  await runFor(home, 3500, { REVIEW_FLEET_PRS_INTERVAL: "1" });
  // The later gate passes ran while PR 7's round was still going.
  assertStringIncludes(
    (await recorded(home, "gate-args"))!,
    "--in-flight=owner/repo#7",
  );
  // The stub gate still reports it; the runner does not start it again.
  assertStringIncludes(
    await runnerLog(home),
    "owner/repo#7: already in a round",
  );
  assertEquals((await roundPrompts(home)).size, 1);
  // Stopping the runner stops the round it left running.
  assertStringIncludes(
    (await recorded(home, "container-kills"))!,
    "kill review-fleet-prs-",
  );
});

Deno.test("run.sh gates again at the next tick after a round succeeds, not after the full interval (Issue #4396)", async () => {
  const home = await fixture(READY);
  await runFor(home, 4000, { REVIEW_FLEET_PRS_INTERVAL: "300" });
  const log = await runnerLog(home);
  assert(gateLines(log) >= 2, log);
});

Deno.test("run.sh waits the full interval after a failed round, so a failing PR is not retried hot (Issue #4396)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exit 3");
  await runFor(home, 4000, { REVIEW_FLEET_PRS_INTERVAL: "300" });
  const log = await runnerLog(home);
  assertEquals(gateLines(log), 1, log);
  assertStringIncludes(log, "round failed (exit 3)");
});

// A log.jsonl with these outcomes, and learned-lines saying how many of its
// lines a learning round has already covered.
async function reviewLog(home: string, outcomes: string[], learned: number) {
  const dir = `${home}/logs/review-fleet-prs`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/log.jsonl`,
    outcomes.map((outcome, i) =>
      JSON.stringify({ repo: "owner/repo", number: i + 1, outcome }) + "\n"
    ).join(""),
  );
  await Deno.writeTextFile(`${dir}/learned-lines`, `${learned}\n`);
}

Deno.test("run.sh runs a learning round for reviews sent back since the last one (Issue #4397)", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  await reviewLog(home, ["approved", "approved", "changes_requested"], 1);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const prompt = await roundPrompt(home);
  assertStringIncludes(prompt, "step '3. Learn from recurring findings'");
  assertStringIncludes(prompt, "lines 2 to 3");
  assertStringIncludes(prompt, "do not review or");
  // Covered now, so the next pass does not learn from them again.
  assertEquals(
    (await Deno.readTextFile(
      `${home}/logs/review-fleet-prs/learned-lines`,
    )).trim(),
    "3",
  );
});

Deno.test("run.sh runs no learning round when nothing was sent back since the last one (Issue #4397)", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  await reviewLog(home, ["changes_requested", "approved", "held"], 1);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh leaves a failed learning round's reviews to learn from next time (Issue #4397)", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  await reviewLog(home, ["changes_requested"], 0);
  await claudeStub(home, "exit 3");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(
    (await Deno.readTextFile(
      `${home}/logs/review-fleet-prs/learned-lines`,
    )).trim(),
    "0",
  );
});

Deno.test("run.sh's first start learns only from reviews posted from then on (Issue #4397)", async () => {
  const home = await fixture(JSON.stringify({ ready: [], skipped: {} }));
  await reviewLog(home, ["changes_requested", "changes_requested"], 0);
  await Deno.remove(`${home}/logs/review-fleet-prs/learned-lines`);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await claudeArgs(home), null);
});

// ---------------------------------------------------------------------------
// Issue #4398: several hosts may run the runner. Each ready PR is claimed on
// GitHub before its round starts and released when the round is over; a PR
// another host has claimed gets no round.
// ---------------------------------------------------------------------------

Deno.test("run.sh claims a ready PR for this host, with the round timeout as its lease (Issue #4398)", async () => {
  const home = await fixture(READY);
  const { code, output } = await runBash(home, [RUNNER, "--once"], {
    REVIEW_FLEET_PRS_ROUND_TIMEOUT: "1234",
  });
  assertEquals(code, 0, output);
  assertStringIncludes(
    (await recorded(home, "claim-args"))!,
    "claim.ts claim --repo=owner/repo --number=7 --sha=abc123 --host=fleet-host --ttl=1234",
  );
  assert(await claudeArgs(home), "the round was not started");
});

Deno.test("run.sh caps the claim lease at 7200 seconds when the round timeout is longer (Issue #4398)", async () => {
  const home = await fixture(READY);
  const { code, output } = await runBash(home, [RUNNER, "--once"], {
    REVIEW_FLEET_PRS_ROUND_TIMEOUT: "9000",
  });
  assertEquals(code, 0, output);
  const args = (await recorded(home, "claim-args"))!;
  assertStringIncludes(args, "--ttl=7200");
  assert(!args.includes("--ttl=9000"), args);
  assert(await claudeArgs(home), "the round was not started");
});

Deno.test("run.sh tells the gate this host, so the gate can skip a PR claimed elsewhere (Issue #4398)", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertStringIncludes(
    (await recorded(home, "gate-args"))!,
    "--host=fleet-host",
  );
});

Deno.test("run.sh claims a PR before its round's container starts (Issue #4398)", async () => {
  const home = await fixture(READY);
  // The claim answers slowly, so a round started before it would be recorded
  // first, whatever the scheduling.
  await Deno.writeTextFile(`${home}/claim-slow`, "");
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await recorded(home, "order"), "claim\nround\n");
});

Deno.test("run.sh starts no round for a PR another host has claimed, and escalates no failure (Issue #4398)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/claim-lost`, "");
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(await runnerLog(home), "claimed by another host");
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "--result=ok",
  );
  // Not this host's claim, so not this host's to release.
  assertEquals(await recorded(home, "release-args"), null);
});

Deno.test("run.sh fails and escalates a PR whose claim fails, starting no round (Issue #4398)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/claim-error`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  const args = (await recorded(home, "escalate-args"))!;
  assertStringIncludes(args, "--result=fail");
  assertStringIncludes(args, "claim failed");
  assertStringIncludes(args, "HTTP 403");
});

Deno.test("run.sh treats claim output that is not a won answer as a failed claim (Issue #4398)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/claim-garbage`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(
    (await recorded(home, "escalate-args"))!,
    "malformed claim output",
  );
});

Deno.test("run.sh releases a PR's claim once its round is done (Issue #4398)", async () => {
  const home = await fixture(READY);
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  assertStringIncludes(
    (await recorded(home, "release-args"))!,
    "claim.ts release --repo=owner/repo --number=7 --host=fleet-host",
  );
});

Deno.test("run.sh releases a PR's claim after its round fails (Issue #4398)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exit 3");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertStringIncludes(
    (await recorded(home, "release-args"))!,
    "--repo=owner/repo --number=7 --host=fleet-host",
  );
});

Deno.test("run.sh releases a PR's claim after its round times out (Issue #4398)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exec sleep 30");
  const { code } = await runBash(home, [RUNNER, "--once"], {
    REVIEW_FLEET_PRS_ROUND_TIMEOUT: "1",
  });
  assertEquals(code, 1);
  assertStringIncludes(
    (await recorded(home, "release-args"))!,
    "--repo=owner/repo --number=7 --host=fleet-host",
  );
});

Deno.test("run.sh releases a PR's claim when its round's container cannot start (Issue #4398)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/no-image`, "");
  const { code } = await run(home, "--once");
  assertEquals(code, 1);
  assertEquals(await claudeArgs(home), null);
  assertStringIncludes(
    (await recorded(home, "release-args"))!,
    "--repo=owner/repo --number=7 --host=fleet-host",
  );
});

Deno.test("run.sh logs, but does not fail on, a failed claim release (Issue #4398)", async () => {
  const home = await fixture(READY);
  await Deno.writeTextFile(`${home}/release-error`, "");
  const { code, output } = await run(home, "--once");
  assertEquals(code, 0, output);
  const log = await runnerLog(home);
  assertStringIncludes(log, "could not release the claim");
  assertStringIncludes(log, "release: boom (HTTP 500)");
});

Deno.test("run.sh releases the claim of a round it leaves running when it stops (Issue #4398)", async () => {
  const home = await fixture(READY);
  await claudeStub(home, "exec sleep 30");
  await runFor(home, 2000, { REVIEW_FLEET_PRS_INTERVAL: "300" });
  assertStringIncludes(
    (await recorded(home, "release-args"))!,
    "--repo=owner/repo --number=7 --host=fleet-host",
  );
});
