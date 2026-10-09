/**
 * Root-level forwarders for review-fleet-prs's moved helpers (PR #3417
 * review). Issue #3299's `run.sh` shim only helps a runner that starts
 * again: a loop already running when the scripts/ move lands never exits
 * (`while true`, no restart), so it keeps calling `app_token.ts`, `gate.ts`,
 * `post.ts`, `escalate.ts` and `review_log.ts` at the old skill-root path
 * forever. These tests pin that each name still resolves at the skill root
 * and runs the moved helper's own code — not a copy of it — by comparing a
 * cheap, deterministic, network-free invocation against the real
 * `scripts/` file side by side.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);
const ROOT = fromFileUrl(
  new URL("../../../.claude/skills/review-fleet-prs/", import.meta.url),
);
const SCRIPTS = `${ROOT}scripts/`;

async function runDeno(
  file: string,
  args: string[],
  perms: string[],
  env: Record<string, string>,
) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-lock", ...perms, file, ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// Asserts the root forwarder and the real scripts/ file exit the same way
// for one deterministic, network-free invocation — proving the forwarder
// reached the moved helper's own code, rather than failing to resolve the
// module at all (the reported symptom) or silently diverging from it. Stderr
// is checked by the caller for the error message, not compared verbatim:
// an uncaught throw's stack trace legitimately names the forwarder's own
// file:line in its last frame.
async function assertForwards(
  name: string,
  args: string[],
  perms: string[],
  env: Record<string, string>,
) {
  const direct = await runDeno(`${SCRIPTS}${name}`, args, perms, env);
  const forwarded = await runDeno(`${ROOT}${name}`, args, perms, env);
  assertEquals(
    forwarded.code,
    direct.code,
    `${name}: exit code diverged — forwarded ${forwarded.stderr}`,
  );
  assertEquals(forwarded.stdout, direct.stdout, `${name}: stdout diverged`);
  return forwarded;
}

Deno.test("review_log.ts's root forwarder prints the same state dir as scripts/review_log.ts", async () => {
  const home = await Deno.makeTempDir();
  const result = await assertForwards(
    "review_log.ts",
    [],
    ["--allow-read", "--allow-env=HOME,XDG_STATE_HOME"],
    { HOME: home },
  );
  assertStringIncludes(result.stdout, "review-fleet-prs");
});

Deno.test("app_token.ts's root forwarder mints nothing when no reviewer App is configured", async () => {
  const home = await Deno.makeTempDir();
  const config = `${home}/config.json`;
  await Deno.writeTextFile(config, "{}");
  const result = await assertForwards(
    "app_token.ts",
    [`--config=${config}`],
    ["--allow-read", "--allow-net=api.github.com", "--allow-env"],
    { HOME: home },
  );
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "");
});

Deno.test("post.ts's root forwarder fails the same way as scripts/post.ts on a missing --input", async () => {
  const home = await Deno.makeTempDir();
  const result = await assertForwards(
    "post.ts",
    [],
    [
      "--allow-run=gh,osascript",
      "--allow-read",
      "--allow-write",
      "--allow-env=HOME,XDG_STATE_HOME",
    ],
    { HOME: home },
  );
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "--input=<file> is required");
});

Deno.test("escalate.ts's root forwarder fails the same way as scripts/escalate.ts on bad args", async () => {
  const home = await Deno.makeTempDir();
  const result = await assertForwards(
    "escalate.ts",
    [],
    ["--allow-run=gh", "--allow-read", "--allow-write"],
    { HOME: home },
  );
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "usage: escalate.ts");
});

Deno.test("gate.ts's root forwarder fails the same way as scripts/gate.ts on a missing config", async () => {
  const home = await Deno.makeTempDir();
  const result = await assertForwards(
    "gate.ts",
    [`--config=${home}/does-not-exist.json`],
    [
      "--allow-run=gh",
      "--allow-read",
      "--allow-write",
      "--allow-env=HOME,XDG_STATE_HOME",
    ],
    { HOME: home },
  );
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "does-not-exist.json");
});
