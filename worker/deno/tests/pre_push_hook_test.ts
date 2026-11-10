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

Deno.test('installPrePushHook: writes compareRef into the spec, "" included, and omits it when unset', async () => {
  for (const compareRef of ["origin/main", "", undefined]) {
    const result = await installPrePushHook({
      baseEnv: {},
      preFlightCommands: [],
      ...(compareRef === undefined ? {} : { compareRef }),
    });
    assert(result.ok);
    try {
      const spec = JSON.parse(
        await Deno.readTextFile(`${result.value.dir}/pre-push-spec.json`),
      );
      assertEquals(spec.compareRef, compareRef);
      assertEquals("compareRef" in spec, compareRef !== undefined);
    } finally {
      await result.value.cleanup();
    }
  }
});

Deno.test("installPrePushHook: writes ciCargo into the spec", async () => {
  const scan = {
    checks: [{
      kind: "clippy" as const,
      workingDirectory: ".",
      argv: ["cargo", "clippy", "--all-targets"],
      env: {},
      source: ".github/workflows/ci.yml",
    }],
    unverifiable: ["ci.yml: the workflow cannot be reproduced"],
  };
  const result = await installPrePushHook({
    baseEnv: {},
    preFlightCommands: [],
    ciCargo: scan,
  });
  assert(result.ok);
  try {
    const spec = JSON.parse(
      await Deno.readTextFile(`${result.value.dir}/pre-push-spec.json`),
    );
    assertEquals(spec.ciCargo, scan);
  } finally {
    await result.value.cleanup();
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

// ---- Integration: the repo CI's cargo checks on the agent's own push -------
// (Issue #4630 review). A fake `cargo` on PATH stands in for the toolchain: it
// answers `--version` probes, and fails a `clippy` run whenever `src/lib.rs` in
// its working directory holds the word BAD, with the diagnostic clippy prints.

const FAKE_CARGO = `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then echo "cargo 1.80.0"; exit 0; fi
done
for arg in "$@"; do
  if [ "$arg" = "clippy" ] && [ -f src/lib.rs ] && grep -q BAD src/lib.rs; then
    printf 'error: this lint is denied\\n  --> src/lib.rs:1:1\\n  = note: \`-D clippy::assert_is_empty\` implied by \`-D warnings\`\\n' >&2
    exit 101
  fi
done
exit 0
`;

const CLIPPY_SCAN = {
  checks: [{
    kind: "clippy" as const,
    workingDirectory: ".",
    argv: ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"],
    env: {},
    source: ".github/workflows/ci.yml",
  }],
  unverifiable: [] as string[],
};

/** An agent hook env with the fake cargo first on PATH, built from the checkout's own gate module. */
async function cargoHookEnv(
  fx: PushFixture,
  spec: { ciCargo?: typeof CLIPPY_SCAN; compareRef?: string },
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const bin = `${fx.root}/bin`;
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(`${bin}/cargo`, FAKE_CARGO);
  await Deno.chmod(`${bin}/cargo`, 0o755);
  const base = Deno.env.toObject();
  const hook = await installPrePushHook({
    baseEnv: { ...base, PATH: `${bin}:${base.PATH ?? ""}` },
    preFlightCommands: [],
    modulePath: new URL("../lib/pre_push_gate_cli.ts", import.meta.url)
      .pathname,
    ...spec,
  });
  assert(hook.ok);
  return { env: hook.value.env, cleanup: hook.value.cleanup };
}

/** Commits `src/lib.rs` (and a manifest) with `source`, as one commit. */
async function commitRust(fx: PushFixture, source: string, message: string) {
  await Deno.mkdir(`${fx.clone}/src`, { recursive: true });
  await Deno.writeTextFile(`${fx.clone}/Cargo.toml`, '[package]\nname = "d"\n');
  await Deno.writeTextFile(`${fx.clone}/src/lib.rs`, source);
  await commitAll(fx.clone, message);
}

const push = (fx: PushFixture, env: Record<string, string>) =>
  run("git", ["push", "-q", "origin", "HEAD:main"], fx.clone, env);

Deno.test("integration: an agent's self-pushed Rust change that fails CI clippy is refused; the same push with clippy passing is accepted", async () => {
  const fx = await makeFixture();
  const hook = await cargoHookEnv(fx, { ciCargo: CLIPPY_SCAN });
  try {
    await commitRust(fx, "pub fn f() {} // BAD\n", "bad");
    const blocked = await push(fx, hook.env);
    assert(blocked.code !== 0);
    assert(blocked.stderr.includes("[PRE_PUSH_BLOCKED]"), blocked.stderr);
    assert(blocked.stderr.includes("this lint is denied"), blocked.stderr);
    assertEquals(await remoteHead(fx.remote), "");

    await commitRust(fx, "pub fn f() {}\n", "fixed");
    const allowed = await push(fx, hook.env);
    assertEquals(allowed.code, 0, allowed.stderr);
    assert((await remoteHead(fx.remote)) !== "");
  } finally {
    await hook.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("integration: a hook spec with no ciCargo runs no CI clippy, so the same failing Rust push is accepted", async () => {
  const fx = await makeFixture();
  const hook = await cargoHookEnv(fx, {});
  try {
    await commitRust(fx, "pub fn f() {} // BAD\n", "bad");
    const allowed = await push(fx, hook.env);
    assertEquals(allowed.code, 0, allowed.stderr);
  } finally {
    await hook.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("integration: a CI scan the worker could not produce refuses a Rust push as infrastructure, and lets a doc push through", async () => {
  const fx = await makeFixture();
  const reason =
    "the worker could not scan the CI workflows before the agent ran: git ls-files exited 128";
  const hook = await cargoHookEnv(fx, {
    ciCargo: { checks: [], unverifiable: [reason] },
  });
  try {
    await commitRust(fx, "pub fn f() {}\n", "rust");
    const blocked = await push(fx, hook.env);
    assert(blocked.code !== 0);
    assert(
      blocked.stderr.includes(
        `CI's cargo checks cannot be reproduced locally: ${reason}`,
      ),
      blocked.stderr,
    );
    assertEquals(await remoteHead(fx.remote), "");

    // Positive control: the refusal is the unverifiable scan, not the push.
    await Deno.remove(`${fx.clone}/src`, { recursive: true });
    await Deno.remove(`${fx.clone}/Cargo.toml`);
    await Deno.writeTextFile(`${fx.clone}/notes.txt`, "x\n");
    await commitAll(fx.clone, "notes only");
    const allowed = await push(fx, hook.env);
    assertEquals(allowed.code, 0, allowed.stderr);
  } finally {
    await hook.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("integration: the hook compares a failing CI clippy against the PR base (compareRef)", async () => {
  // Base already red: a repair that leaves it red is not blamed.
  const same = await makeFixture();
  const sameHook = await cargoHookEnv(same, {
    ciCargo: CLIPPY_SCAN,
    compareRef: "origin/main",
  });
  try {
    await commitRust(same, "pub fn f() {} // BAD\n", "base is red");
    const seed = await push(same, Deno.env.toObject());
    assertEquals(seed.code, 0, seed.stderr);
    await commitRust(same, "pub fn f() {} // BAD\npub fn g() {}\n", "repair");
    const allowed = await push(same, sameHook.env);
    assertEquals(allowed.code, 0, allowed.stderr);
    assert(
      allowed.stderr.includes("[PRE_PUSH_WARNING]"),
      `the base-only failure is logged: ${allowed.stderr}`,
    );
  } finally {
    await sameHook.cleanup();
    await Deno.remove(same.root, { recursive: true });
  }

  // Base green, the push breaks it: a verdict on the push (positive control for
  // the comparison above: only the base's state differs).
  const fresh = await makeFixture();
  const freshHook = await cargoHookEnv(fresh, {
    ciCargo: CLIPPY_SCAN,
    compareRef: "origin/main",
  });
  try {
    await commitRust(fresh, "pub fn f() {}\n", "base is green");
    const seed = await push(fresh, Deno.env.toObject());
    assertEquals(seed.code, 0, seed.stderr);
    await commitRust(fresh, "pub fn f() {} // BAD\n", "repair breaks it");
    const blocked = await push(fresh, freshHook.env);
    assert(blocked.code !== 0);
    assert(blocked.stderr.includes("this lint is denied"), blocked.stderr);
  } finally {
    await freshHook.cleanup();
    await Deno.remove(fresh.root, { recursive: true });
  }
});

Deno.test('integration: an unknown PR base (compareRef "") makes a failing CI clippy infrastructure, not a verdict', async () => {
  const fx = await makeFixture();
  const hook = await cargoHookEnv(fx, { ciCargo: CLIPPY_SCAN, compareRef: "" });
  try {
    await commitRust(fx, "pub fn f() {} // BAD\n", "bad");
    const blocked = await push(fx, hook.env);
    assert(blocked.code !== 0);
    assert(
      blocked.stderr.includes(
        "Could not compare the failed CI cargo check against the PR base",
      ),
      blocked.stderr,
    );
    // The head's diagnostics are retained, labelled as an unavailable comparison.
    assert(
      blocked.stderr.includes("Head diagnostics (comparison unavailable):"),
      blocked.stderr,
    );
    assert(blocked.stderr.includes("this lint is denied"), blocked.stderr);
  } finally {
    await hook.cleanup();
    await Deno.remove(fx.root, { recursive: true });
  }
});
