/**
 * Tests for the callback conformance fixture (Issue #807, parent #796).
 *
 * The fixture is what an external extension runs to prove the post-run
 * callback contract holds where it is deployed. These tests drive the fixture
 * itself: it must pass against a conforming environment, and it must **fail
 * loudly** against a hook that does not conform — a fixture that cannot go red
 * proves nothing.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CONFORMANCE_CHECK_IDS,
  type ConformanceCheckId,
  formatConformanceReport,
  runCallbackConformance,
  writeHook,
} from "../lib/callback_conformance.ts";
import { callbackConformanceCommand } from "../commands/callback_conformance.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const notPosix = Deno.build.os === "windows";

/** Scratch directory for hooks written by a test. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-conformance-test-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The check with this id, or a failed assertion naming what was returned. */
function check(
  checks: readonly {
    id: ConformanceCheckId;
    passed: boolean;
    detail: string;
  }[],
  id: ConformanceCheckId,
) {
  const found = checks.find((c) => c.id === id);
  assert(
    found,
    `no check named ${id} in ${checks.map((c) => c.id).join(", ")}`,
  );
  return found;
}

Deno.test({
  name:
    "callback_conformance - the fixture proves all six contract properties in this environment",
  ignore: notPosix,
  fn: async () => {
    const report = await runCallbackConformance();

    assertEquals(
      report.checks.map((c) => c.id),
      [...CONFORMANCE_CHECK_IDS],
      "every documented check runs, in the documented order",
    );
    for (const one of report.checks) {
      assert(one.passed, `${one.id} failed: ${one.detail}`);
      assert(one.title !== "", `${one.id} has no title`);
      assert(one.detail !== "", `${one.id} reported no detail`);
    }
    assert(report.passed);
  },
});

Deno.test({
  name:
    "callback_conformance - an extension's own hooks are driven through the real contract",
  ignore: notPosix,
  fn: async () => {
    await withDir(async (dir) => {
      const marker = `${dir}/extension-ran.txt`;
      const hooks = {
        success: await writeHook(dir, "s.sh", `echo success >> "${marker}"`),
        failure: await writeHook(dir, "f.sh", `echo failure >> "${marker}"`),
        always: await writeHook(dir, "a.sh", `echo always >> "${marker}"`),
      };

      const report = await runCallbackConformance({ hooks });

      assert(report.passed, formatConformanceReport(report));
      assertEquals(report.hooks, hooks, "the report echoes the hooks it drove");
      // The extension's own executables really ran: success and failure once
      // each (one per scenario), and always alongside both.
      const ran = (await Deno.readTextFile(marker)).split("\n").filter((l) =>
        l !== ""
      );
      assertEquals(ran.filter((l) => l === "success").length, 1);
      assertEquals(ran.filter((l) => l === "failure").length, 1);
      assert(ran.filter((l) => l === "always").length >= 2, ran.join(","));
    });
  },
});

Deno.test({
  name:
    "callback_conformance - a hook that exits non-zero fails the conformance run",
  ignore: notPosix,
  fn: async () => {
    await withDir(async (dir) => {
      const report = await runCallbackConformance({
        hooks: { success: await writeHook(dir, "s.sh", "exit 3") },
      });

      assertEquals(report.passed, false);
      const one = check(report.checks, "success-then-always");
      assertEquals(one.passed, false);
      assert(one.detail.includes("failed"), one.detail);
      // The failure hook was never asked to run, so its check still passes.
      assertEquals(check(report.checks, "failure-then-always").passed, true);
    });
  },
});

Deno.test({
  name:
    "callback_conformance - a hook path that cannot be spawned fails loudly, never quietly",
  ignore: notPosix,
  fn: async () => {
    await withDir(async (dir) => {
      const report = await runCallbackConformance({
        hooks: { always: `${dir}/does-not-exist.sh` },
      });

      assertEquals(report.passed, false);
      for (
        const id of [
          "success-then-always",
          "failure-then-always",
          "always-after-outcome-fault",
        ] as const
      ) {
        const one = check(report.checks, id);
        assertEquals(one.passed, false, `${id}: ${one.detail}`);
        assert(one.detail.includes("spawn_failed"), one.detail);
      }
    });
  },
});

Deno.test({
  name:
    "callback_conformance - a hook that ignores the timeout budget fails the run",
  ignore: notPosix,
  fn: async () => {
    await withDir(async (dir) => {
      const report = await runCallbackConformance({
        hooks: { always: await writeHook(dir, "a.sh", "exec sleep 30") },
        timeoutSeconds: 1,
      });

      assertEquals(report.passed, false);
      const one = check(report.checks, "success-then-always");
      assert(one.detail.includes("timed_out"), one.detail);
    });
  },
});

Deno.test({
  name:
    "callback_conformance - the report renders every check with a verdict a person can read",
  ignore: notPosix,
  fn: async () => {
    const report = await runCallbackConformance();
    const text = formatConformanceReport(report);

    for (const id of CONFORMANCE_CHECK_IDS) {
      assert(text.includes(id), `${id} missing from the report`);
    }
    assert(text.includes("PASS"), text);
    assert(text.includes("6/6"), text);
  },
});

Deno.test({
  name: "callback_conformance command - a conforming environment succeeds",
  ignore: notPosix,
  fn: async () => {
    const result = await callbackConformanceCommand.execute(
      {},
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true, result.message);
    assert(result.message.includes("success-then-always"), result.message);
  },
});

Deno.test({
  name:
    "callback_conformance command - a non-conforming hook exits the command non-zero",
  ignore: notPosix,
  fn: async () => {
    await withDir(async (dir) => {
      const result = await callbackConformanceCommand.execute(
        { always: await writeHook(dir, "a.sh", "exit 1") },
        buildDefaultWorkerConfig(),
      );

      assertEquals(result.success, false);
      assert(result.message.includes("FAIL"), result.message);
    });
  },
});

Deno.test("callback_conformance command - a non-string hook path is refused", async () => {
  const result = await callbackConformanceCommand.execute(
    { success: 42 },
    buildDefaultWorkerConfig(),
  );

  assertEquals(result.success, false);
  assert(result.message.includes("--success"), result.message);
});

Deno.test("callback_conformance command - argument paths are judged by the production parser", async () => {
  // Each of these is rejected by `.config.json` validation, so the fixture
  // must refuse it too rather than passing for an unloadable configuration.
  const cases: [Record<string, unknown>, string][] = [
    [{ success: "hooks/success.sh" }, "absolute"],
    [{ failure: "~/hooks/failure.sh" }, "absolute"],
    [{ always: "/opt/hooks/a\u0000.sh" }, "NUL"],
    [{ success: "   " }, "--success"],
    [{ always: true }, "--always"],
  ];

  for (const [args, expected] of cases) {
    const result = await callbackConformanceCommand.execute(
      args,
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false, JSON.stringify(args));
    assert(
      result.message.includes(expected),
      `${JSON.stringify(args)} → ${result.message}`,
    );
    // The operator typed flags, so the message must name flags.
    assert(!result.message.includes("callbacks."), result.message);
  }
});

Deno.test("callback_conformance command - an out-of-range timeout is refused", async () => {
  for (const value of [0, -1, 1.5, 3601, "soon"]) {
    const result = await callbackConformanceCommand.execute(
      { "timeout-seconds": value },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false, String(value));
    assert(
      result.message.includes("--timeout-seconds"),
      `${value} → ${result.message}`,
    );
  }
});
