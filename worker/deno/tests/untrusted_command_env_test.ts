/**
 * Tests for untrusted_command_env.ts — what the repository's own code sees
 * when the worker runs it (Issues #571, #572).
 *
 * The exploit these close needs nothing exotic: `echo $AWS_SECRET_ACCESS_KEY`
 * in a postinstall script, in any public repository the fleet builds. The
 * environment allowlist removes the variable; the separate account removes
 * the credential FILE the same uid could otherwise just open.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ALLOWED_ENV_NAMES,
  asUntrustedUser,
  buildUntrustedCommandEnv,
  canRunAsUntrustedUser,
  isCredentialVariableName,
  UNTRUSTED_USER,
} from "../lib/untrusted_command_env.ts";

/** The environment a worker actually carries, credentials included. */
const WORKER_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/vibe",
  TMPDIR: "/tmp",
  DENO_DIR: "/home/vibe/auto-issue-work/.deno-cache",
  LANG: "C.UTF-8",
  CI: "true",
  // …and the things a build must never see.
  CLAUDE_CODE_OAUTH_TOKEN: "sk-live-provider-token",
  GH_TOKEN: "ghp_live_github_token",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  GH_CONFIG_DIR: "/run/vibe-secrets/gh",
  NPM_TOKEN: "npm_secret",
};

Deno.test("buildUntrustedCommandEnv - no credential survives into the child", () => {
  const env = buildUntrustedCommandEnv({ source: WORKER_ENV });

  // The exploit, directly: nothing credential-shaped is in scope.
  for (const name of Object.keys(env)) {
    assertEquals(
      isCredentialVariableName(name),
      false,
      `${name} reached a repository-controlled command`,
    );
  }
  // And by value, so a differently-named credential cannot slip through.
  const values = Object.values(env).join("\n");
  for (const secret of Object.values(WORKER_ENV).filter((v) => v.length > 12)) {
    if (secret.startsWith("/") || secret.includes(":")) continue;
    assertEquals(
      values.includes(secret),
      false,
      `a credential value leaked into the child environment: ${secret}`,
    );
  }
});

Deno.test("buildUntrustedCommandEnv - keeps what a build genuinely needs", () => {
  const env = buildUntrustedCommandEnv({ source: WORKER_ENV });

  assertEquals(env.PATH, "/usr/local/bin:/usr/bin");
  assertEquals(env.HOME, "/home/vibe");
  assertEquals(env.TMPDIR, "/tmp");
  // The toolchain cache matters: without it every quality run re-downloads
  // its dependencies, which is slow enough to change behaviour under a
  // timeout.
  assertEquals(env.DENO_DIR, "/home/vibe/auto-issue-work/.deno-cache");
  assertEquals(env.CI, "true");
});

Deno.test("buildUntrustedCommandEnv - a repository may name extra variables", () => {
  // The seam per-repo credential scoping will use (Issue #573): a repository
  // whose checks genuinely need something names it, rather than every
  // repository inheriting everything.
  const env = buildUntrustedCommandEnv({
    source: { ...WORKER_ENV, MY_BUILD_FLAG: "on" },
    extraNames: ["MY_BUILD_FLAG"],
  });
  assertEquals(env.MY_BUILD_FLAG, "on");
  assertEquals(env.GH_TOKEN, undefined);
});

Deno.test("buildUntrustedCommandEnv - an absent allowlisted name is simply absent", () => {
  const env = buildUntrustedCommandEnv({ source: { PATH: "/usr/bin" } });
  assertEquals(Object.keys(env), ["PATH"]);
});

Deno.test("ALLOWED_ENV_NAMES - the allowlist itself carries no credential name", () => {
  // A guard on the guard: adding a name here is a decision about what
  // repository-controlled code may see, and this catches the careless one.
  for (const name of ALLOWED_ENV_NAMES) {
    assertEquals(
      isCredentialVariableName(name),
      false,
      `${name} must not be allowlisted`,
    );
  }
});

Deno.test("asUntrustedUser - drops to the separate account when enabled", () => {
  const wrapped = asUntrustedUser(["./quality.sh"], { enabled: true });
  assertEquals(wrapped, [
    "sudo",
    "-n",
    "-u",
    UNTRUSTED_USER,
    "--",
    "./quality.sh",
  ]);
  // `-n` never prompts: a missing rule fails immediately rather than hanging
  // on a password nobody can type.
  assert(wrapped.includes("-n"));
});

Deno.test("asUntrustedUser - leaves the command alone when the account is unavailable", () => {
  // An image predating the `agent` account keeps working — degraded, not
  // broken.
  assertEquals(
    asUntrustedUser(["./quality.sh", "--fast"], { enabled: false }),
    ["./quality.sh", "--fast"],
  );
  assertEquals(asUntrustedUser([], { enabled: true }), []);
});

Deno.test("canRunAsUntrustedUser - requires BOTH the account and a way to reach it", async () => {
  const probed: string[][] = [];
  const answer = (ok: boolean) => (cmd: string[]) => {
    probed.push(cmd);
    return Promise.resolve(ok);
  };

  assertEquals(await canRunAsUntrustedUser(answer(true)), true);
  assertEquals(probed.length, 2, "both halves must be probed");
  assertStringIncludes(probed[0]!.join(" "), UNTRUSTED_USER);
  assertStringIncludes(probed[1]!.join(" "), "sudo");

  // The account exists but sudo cannot reach it — still unavailable.
  let call = 0;
  assertEquals(
    await canRunAsUntrustedUser(() => Promise.resolve(call++ === 0)),
    false,
  );
});

Deno.test("quality_gate_phase - spawns with a built environment, never an inherited one", async () => {
  const source = await Deno.readTextFile(
    new URL("../lib/quality_gate_phase.ts", import.meta.url),
  );
  assertStringIncludes(source, "buildUntrustedCommandEnv()");
  // `clearEnv` is what makes the allowlist real: without it Deno merges the
  // built env over the inherited one and every credential is still there.
  assertStringIncludes(source, "clearEnv: true");
  assertStringIncludes(source, "untrustedSpawn(cmd)");
});
