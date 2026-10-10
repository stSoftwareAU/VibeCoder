/**
 * An agent-initiated `git push` is gated by the repo's pre-flight (Issue
 * #3394). The fake agent pushes from a clone of a bare remote; the per-run
 * pre-push hook must refuse the push when pre-flight fails and allow it when
 * it passes, and the hook directory must be removed after the run.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  registerAgentPreFlightConfigs,
  resetAgentPreFlightConfigsForTest,
} from "../lib/agent_pre_flight.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  assert(out.success, new TextDecoder().decode(out.stderr));
  return text;
}

interface Outcome {
  pushExit: number;
  pushStderr: string;
  remoteHasFeature: boolean;
  hooksDir: string;
}

async function runScenario(
  opts: { preFlightCommands?: string[]; repo?: string },
): Promise<Outcome> {
  const root = await Deno.makeTempDir({ prefix: "pre_push_3394_" });
  try {
    const bare = `${root}/remote.git`;
    const clone = `${root}/clone`;
    await git(root, "init", "--bare", "-b", "main", bare);
    await git(root, "clone", bare, clone);
    await Deno.writeTextFile(`${clone}/a.txt`, "a\n");
    await git(clone, "add", "a.txt");
    await git(clone, "commit", "-m", "init");
    await git(clone, "push", "origin", "HEAD:refs/heads/main");
    await Deno.writeTextFile(`${clone}/b.txt`, "b\n");
    await git(clone, "add", "b.txt");
    await git(clone, "commit", "-m", "new");

    const script = [
      `out="${root}"`,
      `env | grep '^GIT_CONFIG_VALUE_' > "$out/cfg.txt"`,
      `git push origin HEAD:refs/heads/feature 2> "$out/stderr.txt"`,
      `echo $? > "$out/exit.txt"`,
      `printf '{"type":"result","result":"done"}\\n'`,
      "exit 0",
    ].join("\n");

    await withAgentStub(script, async (stub) => {
      const result = await runClaudeWithTimeout({
        clock: fakeClock(),
        prompt: "test",
        timeoutSeconds: 60,
        killAfterSeconds: 2,
        agentBinaryPath: stub.path,
        cwd: clone,
        ...opts,
      });
      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
    });

    const cfg = await Deno.readTextFile(`${root}/cfg.txt`);
    const hooksDir = cfg.trim().split("\n").pop()!.split("=").slice(1).join(
      "=",
    );
    const refs = await git(bare, "branch", "--list", "feature");
    return {
      pushExit: Number((await Deno.readTextFile(`${root}/exit.txt`)).trim()),
      pushStderr: await Deno.readTextFile(`${root}/stderr.txt`),
      remoteHasFeature: refs.includes("feature"),
      hooksDir,
    };
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

const PERMS = { run: true, read: true, write: true, env: true };

Deno.test({
  name: "agent git push - refused when pre-flight fails (Issue #3394)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const o = await runScenario({ preFlightCommands: ["false"] });
    assert(o.pushExit !== 0, "push must be refused");
    assertStringIncludes(o.pushStderr, "[PRE_PUSH_BLOCKED]");
    assertEquals(o.remoteHasFeature, false);
    assert(o.hooksDir.length > 0);
    assertEquals(await exists(o.hooksDir), false, "hook dir must be cleaned");
  },
});

Deno.test({
  name: "agent git push - allowed when pre-flight passes (Issue #3394)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const o = await runScenario({ preFlightCommands: ["true"] });
    assertEquals(o.pushExit, 0, o.pushStderr);
    assertEquals(o.remoteHasFeature, true);
  },
});

Deno.test({
  name:
    "agent git push - pre-flight resolved from the registry by repo (Issue #3394)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    try {
      registerAgentPreFlightConfigs({ "o/r": { preFlight: ["false"] } });
      const o = await runScenario({ repo: "o/r" });
      assert(o.pushExit !== 0, "push must be refused");
      assertStringIncludes(o.pushStderr, "[PRE_PUSH_BLOCKED]");
      assertEquals(o.remoteHasFeature, false);
    } finally {
      resetAgentPreFlightConfigsForTest();
    }
  },
});
