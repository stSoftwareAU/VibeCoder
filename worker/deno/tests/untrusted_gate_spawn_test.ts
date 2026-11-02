/**
 * The milestone gates run repository commands without the worker's
 * credentials, as `agent` where usable and otherwise as the worker (Issue
 * #4659).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  manifestsFor,
  runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";
import type { untrustedSpawn } from "../lib/quality_gate_phase.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";

type Spawned = Awaited<ReturnType<typeof runWithTimeout>>;
type SpawnOptions = Parameters<typeof runWithTimeout>[2];
interface Call {
  executable: string;
  args: string[];
  options: SpawnOptions;
}

const OK: SubprocessResult = {
  success: true,
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
};

const SOURCE = {
  PATH: "/usr/bin",
  GH_TOKEN: "ghp_secret",
  ANTHROPIC_API_KEY: "sk-secret",
  HOME: "/h",
};

const identityDrop: typeof untrustedSpawn = async (cmd) => [...cmd];

const agentDrop: typeof untrustedSpawn = async (cmd) => [
  "sudo",
  "-n",
  "-u",
  "agent",
  "--",
  ...cmd,
];

/** A spawn that records each call. The first answers `first`; the rest succeed. */
function recordingSpawn(first: Spawned = { ok: true, value: OK }) {
  const calls: Call[] = [];
  const spawn: typeof runWithTimeout = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return calls.length === 1 ? first : { ok: true, value: OK };
  };
  return { calls, spawn };
}

/** Run `fn` in a fresh temp checkout, removed afterwards. */
async function withCheckout(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await Deno.makeTempDir({ prefix: "vibe_4659_" });
  try {
    await fn(cwd);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}

/** Collect what `run` writes to console.error, restoring it afterwards. */
async function captureConsoleError<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

/** The `index`th recorded call. A missing one fails the test. */
function callAt(calls: Call[], index: number): Call {
  const call = calls[index];
  assert(call !== undefined, `expected a call at index ${index}`);
  return call;
}

/** The probe script: the argument after `-c`. */
function probeScriptOf(call: Call): string {
  return call.args[call.args.indexOf("-c") + 1] ?? "";
}

Deno.test("the parent's credentials do not reach a repository command (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000 },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(calls.length, 1);
    const env = callAt(calls, 0).options.env ?? {};
    assertEquals(env.GH_TOKEN, undefined);
    assertEquals(env.ANTHROPIC_API_KEY, undefined);
    assertEquals(env.PATH, "/usr/bin");
    assertEquals(callAt(calls, 0).options.clearEnv, true);
  });
});

Deno.test("a real repository command sees no parent credential (Issue #4659)", async () => {
  const name = "VIBE_4659_PARENT_SECRET";
  const previous = Deno.env.get(name);
  Deno.env.set(name, "parent-secret-value");
  try {
    await withCheckout(async (cwd) => {
      const script = 'printf %s "${VIBE_4659_PARENT_SECRET-unset}"';
      const isolated = await runRepositoryCommand(
        "sh",
        ["-c", script],
        { cwd, timeoutMs: 10_000 },
        { drop: identityDrop, trimRefused: false },
      );
      assert(isolated.ok);
      assertEquals(isolated.value.stdout, "unset");

      // Positive control: the same script inherits the secret without the helper.
      const inherited = await runWithTimeout("sh", ["-c", script], {
        cwd,
        timeoutMs: 10_000,
      });
      assert(inherited.ok);
      assertEquals(inherited.value.stdout, "parent-secret-value");
    });
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("a usable untrusted account runs the command dropped, with the cargo target carried (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    await withCheckout(async (root) => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        "cargo",
        ["test"],
        { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: true, root },
      );
      assertEquals(calls.length, 2);

      // The probe runs first, against the checkout.
      assertEquals(callAt(calls, 0).executable, "sudo");
      assertEquals(callAt(calls, 0).args.at(-1), cwd);

      const final = callAt(calls, 1);
      assertEquals(final.executable, "sudo");
      const target = final.options.env?.CARGO_TARGET_DIR;
      assert(target !== undefined && target.startsWith(root));
      assertEquals(
        final.args,
        [
          "-n",
          "-u",
          "agent",
          "--",
          "env",
          `CARGO_TARGET_DIR=${target}`,
          "cargo",
          "test",
        ],
      );
      assertEquals(final.options.clearEnv, true);
      assertEquals(final.options.env?.GH_TOKEN, undefined);
    });
  });
});

const PROBE_FAILURES: [string, Spawned][] = [
  [
    "exits non-zero",
    { ok: true, value: { ...OK, success: false, code: 1 } },
  ],
  ["is not ok", { ok: false, error: new Error("spawn failed") }],
  [
    "times out",
    { ok: true, value: { ...OK, success: false, code: 124, timedOut: true } },
  ],
];

for (const [label, first] of PROBE_FAILURES) {
  Deno.test(`an untrusted probe that ${label} runs the command as the worker (Issue #4659)`, async () => {
    await withCheckout(async (cwd) => {
      const { calls, spawn } = recordingSpawn(first);
      const { lines } = await captureConsoleError(() =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        )
      );
      assertEquals(calls.length, 2);
      assertEquals(callAt(calls, 1).executable, "cargo");
      assertEquals(callAt(calls, 1).args, ["test"]);
      assertEquals(callAt(calls, 1).options.env?.GH_TOKEN, undefined);
      assertEquals(callAt(calls, 1).options.clearEnv, true);
      assert(
        lines.some((line) =>
          line.includes("[SECURITY]") && line.includes(`'${cwd}'`)
        ),
      );
    });
  });
}

Deno.test("a command that does not drop account runs once, with no probe (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000 },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(calls.length, 1);
    assertEquals(callAt(calls, 0).executable, "npm");
    assertEquals(callAt(calls, 0).args, ["test"]);
  });
});

Deno.test("the probe checks the manifests, and the target only for cargo (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const probeFor = async (
      executable: string,
      manifests: string[],
    ): Promise<string> => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        executable,
        ["run"],
        { cwd, timeoutMs: 1000, manifests },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
      );
      assertEquals(callAt(calls, 0).args.at(-1), cwd);
      return probeScriptOf(callAt(calls, 0));
    };

    const cargoNoTarget = await probeFor("cargo", ["Cargo.toml"]);
    assert(cargoNoTarget.includes(`"$1/Cargo.toml"`));
    assert(cargoNoTarget.includes(`test -w "$1"`));
    assert(!cargoNoTarget.includes("find"));
    assert(!cargoNoTarget.includes(cwd));

    await Deno.mkdir(`${cwd}/target`);
    const cargoWithTarget = await probeFor("cargo", ["Cargo.toml"]);
    assert(cargoWithTarget.includes(`find "$1/target"`));
    assert(!cargoWithTarget.includes(`test -w`));

    const deno = await probeFor("deno", ["deno.json"]);
    assert(deno.includes(`"$1/deno.json"`));
    assert(!deno.includes("test -w"));
    assert(!deno.includes("find"));
  });
});

Deno.test("a manifest name that is not a plain file name is refused (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { spawn } = recordingSpawn();
    await assertRejects(
      () =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["../x"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        ),
      Error,
      "refusing to probe manifest",
    );
  });
});

Deno.test("manifestsFor names the manifests each kind of checkout is probed for (Issue #4659)", async () => {
  await withCheckout(async (dir) => {
    assertEquals(await manifestsFor("cargo", dir), ["Cargo.toml"]);
    assertEquals(await manifestsFor("script", dir), ["quality.sh"]);
    assertEquals(await manifestsFor("deno", dir), []);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.json"]);
    await Deno.remove(`${dir}/deno.json`);
    await Deno.writeTextFile(`${dir}/deno.jsonc`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.jsonc"]);
  });
});
