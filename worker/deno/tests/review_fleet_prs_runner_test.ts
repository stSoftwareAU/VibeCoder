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
// exits `tokenExit`; the gate stub records its token and arguments.
async function fixture(
  gateOutput: string,
  gateExit = 0,
  tokenOutput = "",
  tokenExit = 0,
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
  *app_token.ts*) printf '%s' '${tokenOutput}'
    [ ${tokenExit} = 0 ] || echo "reviewer App token: Bad credentials" >&2
    exit ${tokenExit} ;;
esac
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
  const out = await new Deno.Command("bash", {
    args: [RUNNER, ...args],
    env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` },
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
  const lock = `${home}/.review-fleet-prs/runner.lock`;
  await Deno.mkdir(lock, { recursive: true });
  await Deno.writeTextFile(`${lock}/pid`, String(Deno.pid)); // alive
  const { code, output } = await run(home, "--once");
  assertEquals(code, 1);
  assertStringIncludes(output, "already running");
  assertEquals(await claudeArgs(home), null);
});

Deno.test("run.sh takes over a lock left by a runner that died", async () => {
  const home = await fixture(READY);
  const lock = `${home}/.review-fleet-prs/runner.lock`;
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
