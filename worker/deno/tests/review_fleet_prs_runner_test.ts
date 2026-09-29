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

async function fixture(gateOutput: string, gateExit = 0) {
  const home = await Deno.makeTempDir();
  const bin = `${home}/bin`;
  await Deno.mkdir(bin);
  const stub = async (name: string, body: string) => {
    await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  };
  await stub("deno", `echo '${gateOutput}'; exit ${gateExit}`);
  await stub("claude", `printf '%s\\n' "$@" > "$HOME/claude-args"`);
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

async function claudeArgs(home: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${home}/claude-args`);
  } catch {
    return null;
  }
}

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
