/**
 * Tests for the pre-push hook entry point (Issue #3394): every refusal path
 * exits 1 with `[PRE_PUSH_BLOCKED]`, and the same input with only the probed
 * value made legal is accepted.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runPrePushGateCli } from "../lib/pre_push_gate_cli.ts";
import type { runPrePushGate } from "../lib/pre_push_gate.ts";

type Gate = typeof runPrePushGate;

const okGate: Gate = () =>
  Promise.resolve({ ok: true, value: { checksRun: [] } });

interface Harness {
  errs: string[];
  gateCalls: number;
  run: (
    args: string[],
    over?: {
      gate?: Gate;
      readStdin?: () => Promise<string>;
    },
  ) => Promise<number>;
}

function harness(): Harness {
  const h: Harness = {
    errs: [],
    gateCalls: 0,
    run(args, over = {}) {
      const gate = over.gate ?? okGate;
      return runPrePushGateCli(args, {
        writeErr: (t) => h.errs.push(t),
        readStdin: over.readStdin ?? (() => Promise.resolve("")),
        cwd: () => "/fake/cwd",
        gate: (o) => {
          h.gateCalls++;
          return gate(o);
        },
      });
    },
  };
  return h;
}

async function withSpec(
  spec: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "pre_push_cli_3394_" });
  try {
    const path = `${dir}/spec.json`;
    await Deno.writeTextFile(path, spec);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID = '{"preFlightCommands":["true"],"timeoutSeconds":30}';

Deno.test("pre-push cli: no --spec blocks; with --spec the same run passes", async () => {
  await withSpec(VALID, async (path) => {
    const h = harness();
    assertEquals(await h.run([]), 1);
    assertStringIncludes(h.errs.join(""), "[PRE_PUSH_BLOCKED]");
    assertStringIncludes(h.errs.join(""), "--spec");
    assertEquals(h.gateCalls, 0);

    const h2 = harness();
    assertEquals(await h2.run(["--spec", path]), 0);
  });
});

Deno.test("pre-push cli: --spec after -- is ignored and blocks", async () => {
  await withSpec(VALID, async (path) => {
    const h = harness();
    assertEquals(await h.run(["--", "--spec", path]), 1);
    assertStringIncludes(h.errs.join(""), "--spec");
    assertEquals(
      await harness().run(["--spec", path, "--", "origin", "url"]),
      0,
    );
  });
});

Deno.test("pre-push cli: missing spec file blocks", async () => {
  const h = harness();
  assertEquals(await h.run(["--spec", "/nonexistent/dir/spec.json"]), 1);
  assertStringIncludes(h.errs.join(""), "[PRE_PUSH_BLOCKED]");
  assertStringIncludes(h.errs.join(""), "cannot read pre-push spec");
  assertEquals(h.gateCalls, 0);
});

Deno.test("pre-push cli: spec that is not a JSON object blocks", async () => {
  await withSpec("[]", async (path) => {
    const h = harness();
    assertEquals(await h.run(["--spec", path]), 1);
    assertStringIncludes(h.errs.join(""), "must be a JSON object");
  });
  await withSpec("{}", async (path) => {
    assertEquals(await harness().run(["--spec", path]), 0);
  });
});

Deno.test("pre-push cli: invalid pre-flight command blocks; legal one passes", async () => {
  await withSpec('{"preFlightCommands":[""]}', async (path) => {
    const h = harness();
    assertEquals(await h.run(["--spec", path]), 1);
    assertStringIncludes(h.errs.join(""), "[PRE_PUSH_BLOCKED]");
    assertEquals(h.gateCalls, 0);
  });
  await withSpec('{"preFlightCommands":["true"]}', async (path) => {
    assertEquals(await harness().run(["--spec", path]), 0);
  });
});

Deno.test("pre-push cli: invalid timeoutSeconds blocks; positive integer passes", async () => {
  for (const bad of ["0", "-1", "1.5", '"30"']) {
    await withSpec(
      `{"preFlightCommands":[],"timeoutSeconds":${bad}}`,
      async (path) => {
        const h = harness();
        assertEquals(await h.run(["--spec", path]), 1, bad);
        assertStringIncludes(
          h.errs.join(""),
          "timeoutSeconds must be a positive integer",
        );
        assertEquals(h.gateCalls, 0);
      },
    );
  }
  await withSpec(
    '{"preFlightCommands":[],"timeoutSeconds":30}',
    async (path) => {
      assertEquals(await harness().run(["--spec", path]), 0);
    },
  );
});

Deno.test("pre-push cli: unreadable stdin blocks; readable stdin passes", async () => {
  await withSpec(VALID, async (path) => {
    const h = harness();
    const code = await h.run(["--spec", path], {
      readStdin: () => Promise.reject(new Error("pipe closed")),
    });
    assertEquals(code, 1);
    assertStringIncludes(h.errs.join(""), "cannot read hook input");
    assertStringIncludes(h.errs.join(""), "pipe closed");
    assertEquals(h.gateCalls, 0);

    assertEquals(await harness().run(["--spec", path]), 0);
  });
});

Deno.test("pre-push cli: gate Err blocks with the message; gate Ok passes", async () => {
  await withSpec(VALID, async (path) => {
    const h = harness();
    const code = await h.run(["--spec", path], {
      gate: () =>
        Promise.resolve({ ok: false, error: new Error("lint broke") }),
    });
    assertEquals(code, 1);
    const text = h.errs.join("");
    assertStringIncludes(text, "[PRE_PUSH_BLOCKED] lint broke");
    assertStringIncludes(text, "never bypass this gate");

    const h2 = harness();
    let seen: Parameters<Gate>[0] | undefined;
    const ok = await h2.run(["--spec", path], {
      gate: (o) => {
        seen = o;
        return okGate(o);
      },
    });
    assertEquals(ok, 0);
    assertStringIncludes(h2.errs.join(""), "pre-push gate passed");
    assert(!h2.errs.join("").includes("PRE_PUSH_BLOCKED"));
    assertEquals(seen?.cwd, "/fake/cwd");
    assertEquals(seen?.preFlightCommands, ["true"]);
    assertEquals(seen?.timeoutSeconds, 30);
  });
});

Deno.test("pre-push cli: a throwing gate blocks", async () => {
  await withSpec(VALID, async (path) => {
    const h = harness();
    const code = await h.run(["--spec", path], {
      gate: () => Promise.reject(new Error("gate exploded")),
    });
    assertEquals(code, 1);
    assertStringIncludes(h.errs.join(""), "[PRE_PUSH_BLOCKED] gate exploded");

    const h2 = harness();
    const code2 = await h2.run(["--spec", path], {
      gate: () => Promise.reject("plain string"),
    });
    assertEquals(code2, 1);
    assertStringIncludes(h2.errs.join(""), "plain string");
  });
});
