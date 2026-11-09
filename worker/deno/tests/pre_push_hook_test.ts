/**
 * Tests for the pre-push hook installer and its end-to-end behaviour
 * (Issue #3394).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  installPrePushHook,
  PRE_PUSH_HOOK_MARKER,
  renderPrePushHookScript,
} from "../lib/pre_push_hook.ts";

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) {
  const out = await new Deno.Command(cmd, {
    args,
    cwd,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: out.code,
    stdout: d.decode(out.stdout),
    stderr: d.decode(out.stderr),
  };
}

Deno.test("renderPrePushHookScript: missing deno blocks the push", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-pp-hook-test-" });
  try {
    const script = renderPrePushHookScript({
      denoPath: `${dir}/no-such-deno`,
      modulePath: `${dir}/m.ts`,
      specPath: `${dir}/s.json`,
    });
    assert(script.includes(PRE_PUSH_HOOK_MARKER));
    await Deno.writeTextFile(`${dir}/hook`, script);
    const result = await run("bash", [`${dir}/hook`], dir);
    assertEquals(result.code, 1);
    assert(result.stderr.includes("[PRE_PUSH_BLOCKED]"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installPrePushHook: appends to an existing GIT_CONFIG_COUNT", async () => {
  const result = await installPrePushHook({
    baseEnv: {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "c.d",
      GIT_CONFIG_VALUE_1: "2",
    },
    preFlightCommands: [],
  });
  assert(result.ok);
  try {
    assertEquals(result.value.env.GIT_CONFIG_COUNT, "3");
    assertEquals(result.value.env.GIT_CONFIG_KEY_2, "core.hooksPath");
    assertEquals(result.value.env.GIT_CONFIG_VALUE_2, result.value.hooksDir);
    assertEquals(result.value.env.GIT_CONFIG_KEY_0, "a.b");
  } finally {
    await result.value.cleanup();
  }
  const gone = await Deno.stat(result.value.dir).then(() => false, () => true);
  assert(gone);
});

Deno.test("pre-push hook uses its worker config and lock independently of the target checkout", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe_hook_lock_" });
  try {
    const worker = `${root}/worker`;
    const target = `${root}/target`;
    await Deno.mkdir(`${worker}/lib`, { recursive: true });
    await Deno.mkdir(target);
    await Deno.writeTextFile(
      `${worker}/deno.json`,
      JSON.stringify({
        imports: { "gate-value": "./value.ts" },
        lock: "./alternative.lock",
      }),
    );
    await Deno.writeTextFile(`${worker}/deno.lock`, '{"version":"5"}\n');
    await Deno.writeTextFile(`${worker}/alternative.lock`, '{"version":"5"}\n');
    await Deno.writeTextFile(
      `${worker}/value.ts`,
      'export default "worker gate";',
    );
    await Deno.writeTextFile(
      `${worker}/lib/gate.ts`,
      'import value from "gate-value"; console.log(value);',
    );
    await Deno.writeTextFile(`${root}/spec.json`, "{}");
    await Deno.writeTextFile(
      `${target}/deno.json`,
      JSON.stringify({ imports: { "gate-value": "./hostile.ts" } }),
    );
    await Deno.writeTextFile(
      `${target}/hostile.ts`,
      'throw new Error("target config reached the worker hook");',
    );
    const hook = `${root}/hook`;
    await Deno.writeTextFile(
      hook,
      renderPrePushHookScript({
        denoPath: Deno.execPath(),
        modulePath: `${worker}/lib/gate.ts`,
        specPath: `${root}/spec.json`,
      }),
    );
    const allowed = await run("bash", [hook], target);
    assertEquals(allowed.code, 0, allowed.stderr);
    assertEquals(allowed.stdout.trim(), "worker gate");

    await Deno.writeTextFile(
      `${worker}/deno.lock`,
      JSON.stringify({
        version: "5",
        workspace: { dependencies: ["jsr:@std/assert@^1.0.18"] },
      }),
    );
    const staleLock = await run("bash", [hook], target);
    assertEquals(staleLock.code, 1);
    assertStringIncludes(staleLock.stderr, "lockfile is out of date");
    assertEquals(staleLock.stdout, "");

    await Deno.remove(`${worker}/deno.lock`);
    const missingLock = await run("bash", [hook], target);
    assertEquals(missingLock.code, 1);
    assertStringIncludes(missingLock.stderr, "worker Deno lock is missing");
    assertEquals(missingLock.stdout, "");

    await Deno.writeTextFile(`${worker}/deno.lock`, '{"version":"5"}\n');
    await Deno.remove(`${worker}/deno.json`);
    const missingConfig = await run("bash", [hook], target);
    assertEquals(missingConfig.code, 1);
    assertStringIncludes(missingConfig.stderr, "worker Deno config is missing");
    assertEquals(missingConfig.stdout, "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPrePushHook: invalid GIT_CONFIG_COUNT is an error", async () => {
  for (const bad of ["abc", "-1", "1.5", ""]) {
    const result = await installPrePushHook({
      baseEnv: { GIT_CONFIG_COUNT: bad },
      preFlightCommands: [],
    });
    assert(!result.ok, `expected error for ${JSON.stringify(bad)}`);
  }
});

// ---- Integration: real git push through the hook ---------------------------

const GIT_ID = ["-c", "user.email=t@e", "-c", "user.name=t"];

interface PushFixture {
  root: string;
  clone: string;
  remote: string;
}

async function makeFixture(): Promise<PushFixture> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-int-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await run("git", ["init", "-q", "--bare", "-b", "main", remote], root);
  await run("git", ["clone", "-q", remote, clone], root);
  return { root, clone, remote };
}

async function commitAll(clone: string, message: string) {
  await run("git", ["add", "-A"], clone);
  const r = await run("git", [...GIT_ID, "commit", "-qm", message], clone);
  assertEquals(r.code, 0, r.stderr);
}

async function remoteHead(remote: string): Promise<string> {
  const r = await run("git", ["rev-parse", "-q", "--verify", "main"], remote);
  return r.code === 0 ? r.stdout.trim() : "";
}

async function hookEnv(
  preFlightCommands: string[],
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const hook = await installPrePushHook({
    baseEnv: Deno.env.toObject(),
    preFlightCommands,
  });
  assert(hook.ok);
  return { env: hook.value.env, cleanup: hook.value.cleanup };
}

Deno.test("integration: agent push is blocked by a failing pre-flight, allowed by a passing one", async () => {
  const fx = await makeFixture();
  const failing = await hookEnv(["false"]);
  const passing = await hookEnv(["true"]);
  try {
    await Deno.writeTextFile(`${fx.clone}/a.txt`, "x\n");
    await commitAll(fx.clone, "one");

    const blocked = await run(
      "git",
      ["push", "-q", "origin", "HEAD:main"],
      fx.clone,
      failing.env,
    );
    assert(blocked.code !== 0);
    assert(blocked.stderr.includes("[PRE_PUSH_BLOCKED]"), blocked.stderr);
    assertEquals(await remoteHead(fx.remote), "");

    const allowed = await run(
      "git",
      ["push", "-q", "origin", "HEAD:main"],
      fx.clone,
      passing.env,
    );
    assertEquals(allowed.code, 0, allowed.stderr);
    assert((await remoteHead(fx.remote)) !== "");
  } finally {
    await failing.cleanup();
    await passing.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});

const STUB_MARKDOWNLINT = `#!/bin/bash
if [ "\${1:-}" = "--help" ]; then exit 0; fi
status=0
for f in "$@"; do
  if grep -Eq '^#+[^# ]' "$f"; then
    echo "$f:1:1 error MD018/no-missing-space-atx No space after hash on atx style heading"
    status=1
  fi
done
exit $status
`;

Deno.test("integration: doc-only push is blocked by markdownlint, fixed content accepted", async () => {
  const fx = await makeFixture();
  const hook = await hookEnv([]);
  try {
    await Deno.writeTextFile(`${fx.clone}/.gitignore`, "node_modules/\n");
    await Deno.writeTextFile(`${fx.clone}/.markdownlint-cli2.jsonc`, "{}\n");
    await commitAll(fx.clone, "init");
    const base = await run(
      "git",
      ["push", "-q", "origin", "HEAD:main"],
      fx.clone,
      hook.env,
    );
    assertEquals(base.code, 0, base.stderr);

    const bin = `${fx.clone}/node_modules/.bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(`${bin}/markdownlint-cli2`, STUB_MARKDOWNLINT);
    await Deno.chmod(`${bin}/markdownlint-cli2`, 0o755);

    await Deno.writeTextFile(`${fx.clone}/README.md`, "#Bad\n");
    await commitAll(fx.clone, "docs");
    const before = await remoteHead(fx.remote);
    const blocked = await run(
      "git",
      ["push", "-q", "origin", "HEAD:main"],
      fx.clone,
      hook.env,
    );
    assert(blocked.code !== 0);
    assert(blocked.stderr.includes("[PRE_PUSH_BLOCKED]"), blocked.stderr);
    assertEquals(await remoteHead(fx.remote), before);

    await Deno.writeTextFile(`${fx.clone}/README.md`, "# Good\n");
    await commitAll(fx.clone, "fix docs");
    const allowed = await run(
      "git",
      ["push", "-q", "origin", "HEAD:main"],
      fx.clone,
      hook.env,
    );
    assertEquals(allowed.code, 0, allowed.stderr);
    assert((await remoteHead(fx.remote)) !== before);
  } finally {
    await hook.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});
