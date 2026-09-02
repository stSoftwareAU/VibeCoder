/**
 * Tests for the `first-run-verify` command seam (Issue #736).
 *
 * `first_run_verification_test.ts` covers the decisions; this file covers the
 * command that carries them — argument validation, the refusal to read an
 * input it cannot, and the mode dispatch. Every one of these is a path where a
 * quiet empty result would be reported as a clean stage, so each is asserted
 * to fail loud naming what went wrong.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { firstRunVerifyCommand } from "../commands/first_run_verify.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { WORKAROUND_ENV_VARS } from "../lib/first_run_verification.ts";

/** The command takes a worker config it never reads; the default stands in. */
const CONFIG = buildDefaultWorkerConfig();

/**
 * Run `body` with every workaround-shaped variable cleared, restoring what was
 * there afterwards.
 *
 * The preflight reads the real environment on purpose — that is the host state
 * it judges — so a test of it must say what that environment holds rather than
 * inherit whatever the suite was launched with.
 */
async function withoutWorkaroundEnv(body: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string>();
  for (const { name } of WORKAROUND_ENV_VARS) {
    const value = Deno.env.get(name);
    if (value !== undefined) saved.set(name, value);
    Deno.env.delete(name);
  }
  try {
    await body();
  } finally {
    // Clear first, then restore: a variable the body set must not survive into
    // the next test. Deno runs a file's tests in one process, and a leaked
    // VIBE_SKIP_PREREQ_CHECK would silently turn every later prerequisite
    // check into a skip.
    for (const { name } of WORKAROUND_ENV_VARS) Deno.env.delete(name);
    for (const [name, value] of saved) Deno.env.set(name, value);
  }
}

/** A sandbox directory removed however the test ends. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "first-run-verify-cmd-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("first-run-verify - an unknown mode names the modes it accepts", async () => {
  const result = await firstRunVerifyCommand.execute({ mode: "guess" }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "config-path");
  assertStringIncludes(result.message, "claim");
  assertStringIncludes(result.message, '"guess"');
});

Deno.test("first-run-verify - a missing mode is refused rather than defaulted", async () => {
  const result = await firstRunVerifyCommand.execute({}, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--mode must be one of");
});

Deno.test("first-run-verify - a required path that was not given is named", async () => {
  const result = await firstRunVerifyCommand.execute(
    { mode: "config" },
    CONFIG,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--config is required");
});

Deno.test("first-run-verify - a configuration that cannot be read fails loud with its path", async () => {
  const result = await firstRunVerifyCommand.execute({
    mode: "config",
    config: "/nonexistent/vibe/.config.json",
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "/nonexistent/vibe/.config.json");
});

Deno.test("first-run-verify - config reports a Codex-only file as the pass it is", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ agent_providers: ["codex"] }),
    );
    const result = await firstRunVerifyCommand.execute({
      mode: "config",
      config: path,
    }, CONFIG);
    assertEquals(result.success, true);
    assertStringIncludes(result.message, path);
  });
});

Deno.test("first-run-verify - a workaround on the host refuses the run before setup", async () => {
  await withoutWorkaroundEnv(async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile(`${dir}/images.txt`, "");
      await Deno.writeTextFile(`${dir}/status.txt`, "");
      Deno.env.set("VIBE_SKIP_PREREQ_CHECK", "true");
      const result = await firstRunVerifyCommand.execute({
        mode: "preflight",
        "config-file": `${dir}/.config.json`,
        "claude-on-path": "false",
        images: `${dir}/images.txt`,
        "checkout-status": `${dir}/status.txt`,
      }, CONFIG);
      assertEquals(result.success, false);
      assertStringIncludes(result.message, "VIBE_SKIP_PREREQ_CHECK");
    });
  });
});

Deno.test("first-run-verify - a boolean flag given as prose is refused", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/images.txt`, "");
    await Deno.writeTextFile(`${dir}/status.txt`, "");
    const result = await firstRunVerifyCommand.execute({
      mode: "preflight",
      "config-file": `${dir}/.config.json`,
      "claude-on-path": "maybe",
      images: `${dir}/images.txt`,
      "checkout-status": `${dir}/status.txt`,
    }, CONFIG);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--claude-on-path");
  });
});

Deno.test("first-run-verify - preflight writes the verdict the report reads back", async () => {
  await withoutWorkaroundEnv(async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile(`${dir}/images.txt`, "");
      await Deno.writeTextFile(`${dir}/status.txt`, "");
      const out = `${dir}/fresh-state.json`;
      const result = await firstRunVerifyCommand.execute({
        mode: "preflight",
        "config-file": `${dir}/.config.json`,
        "claude-on-path": "false",
        "declared-provider": "codex",
        images: `${dir}/images.txt`,
        "checkout-status": `${dir}/status.txt`,
        out,
      }, CONFIG);
      assertEquals(result.success, true, result.message);
      const written = JSON.parse(await Deno.readTextFile(out));
      assertEquals(written.violations, []);
      assertEquals(written.notes.length, 1);
      assertStringIncludes(written.notes[0], "VIBE_AGENT_PROVIDER=codex");
    });
  });
});

Deno.test("first-run-verify - claim reads the worker log the run actually wrote", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/worker.log`;
    await Deno.writeTextFile(
      path,
      "Processing issue o/r#7\nSuccessfully processed o/r#7\n",
    );
    const done = await firstRunVerifyCommand.execute({
      mode: "claim",
      "worker-log": path,
    }, CONFIG);
    assertEquals(done.success, true);

    await Deno.writeTextFile(path, "Processing issue o/r#7\n");
    const stalled = await firstRunVerifyCommand.execute({
      mode: "claim",
      "worker-log": path,
    }, CONFIG);
    assertEquals(stalled.success, false);
    assertStringIncludes(stalled.message, "did not complete");
  });
});

Deno.test("first-run-verify - a worker log that was never written is not a pass", async () => {
  const result = await firstRunVerifyCommand.execute({
    mode: "claim",
    "worker-log": "/nonexistent/logs/worker.log",
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "claimed no issue");
});

Deno.test("first-run-verify - a stage log that exists but cannot be read stops the report", async () => {
  await withTempDir(async (dir) => {
    // A directory where a file was named: readable path, unreadable content.
    // Silently contributing zero findings would let the report say "no
    // workaround was required" about output nobody read.
    await Deno.mkdir(`${dir}/03-setup.log`);
    await Deno.writeTextFile(
      `${dir}/stages.tsv`,
      "setup\tPASS\texit 0\t03-setup.log\n",
    );
    await Deno.writeTextFile(
      `${dir}/fresh-state.json`,
      JSON.stringify({ violations: [], notes: [] }),
    );
    const result = await firstRunVerifyCommand.execute({
      mode: "report",
      stages: `${dir}/stages.tsv`,
      "fresh-state": `${dir}/fresh-state.json`,
      transcript: dir,
      checkout: dir,
      out: `${dir}/report.md`,
    }, CONFIG);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "03-setup.log");
  });
});

Deno.test("first-run-verify - a preflight that wrote no verdict is a host never confirmed fresh", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/stages.tsv`,
      "fresh-state\tFAIL\texit 1\t01-fresh-state.log\n",
    );
    await Deno.writeTextFile(`${dir}/01-fresh-state.log`, "podman: ABSENT\n");
    const out = `${dir}/report.md`;
    const result = await firstRunVerifyCommand.execute({
      mode: "report",
      stages: `${dir}/stages.tsv`,
      "fresh-state": `${dir}/never-written.json`,
      transcript: dir,
      checkout: dir,
      out,
    }, CONFIG);
    assertEquals(result.success, false);
    const report = await Deno.readTextFile(out);
    assertStringIncludes(report, "never confirmed fresh");
    assertStringIncludes(report, "verdict: **FAIL**");
  });
});

Deno.test("first-run-verify - a stage record with no stages is refused, not reported empty", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/stages.tsv`, "\n\n");
    const result = await firstRunVerifyCommand.execute({
      mode: "report",
      stages: `${dir}/stages.tsv`,
      "fresh-state": `${dir}/fresh-state.json`,
      transcript: dir,
      checkout: dir,
      out: `${dir}/report.md`,
    }, CONFIG);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "records no stages");
  });
});

Deno.test("first-run-verify - the same fault seen in two stages is one finding", async () => {
  await withTempDir(async (dir) => {
    const fault = 'Error: unknown mount option "uid=1000"\n';
    await Deno.writeTextFile(`${dir}/05-launch.log`, fault);
    await Deno.writeTextFile(`${dir}/07-claim.log`, fault);
    await Deno.writeTextFile(
      `${dir}/stages.tsv`,
      "launch\tFAIL\texit 1\t05-launch.log\n" +
        "claim\tSKIPPED\tan earlier stage failed\t07-claim.log\n",
    );
    await Deno.writeTextFile(
      `${dir}/fresh-state.json`,
      JSON.stringify({ violations: [], notes: [] }),
    );
    const out = `${dir}/report.md`;
    const result = await firstRunVerifyCommand.execute({
      mode: "report",
      stages: `${dir}/stages.tsv`,
      "fresh-state": `${dir}/fresh-state.json`,
      transcript: dir,
      checkout: dir,
      out,
    }, CONFIG);
    assertEquals(result.success, false);
    const report = await Deno.readTextFile(out);
    const occurrences = report.split("Podman refused a tmpfs mount option")
      .length - 1;
    assertEquals(occurrences, 1);
    // The volume-init row is synthesised from evidence, not from a stage that
    // ran, and with none it must be SKIPPED rather than a pass.
    assert(report.includes("| volume-init | SKIPPED |"), report);
  });
});
