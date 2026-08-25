/**
 * Tests for canonical colour resolution in `ensureLabelExists` (Issue #368).
 *
 * `ensureLabelExists` used to take `colour: string = "d73a4a"`, so a label's
 * colour was whatever the first call site to create it happened to pass.
 * It now resolves the colour and description from the canonical table when
 * the caller passes none.
 */

import { assertEquals } from "@std/assert";
import { ensureLabelExists } from "../lib/label_operations.ts";

/** Capture the `gh api` label-create call ensureLabelExists issues. */
function captureCreate(): {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    // The cache refresh lists labels first — report an empty repo so the
    // create path always runs.
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("");
    return Promise.resolve("");
  };
  return { ghCommandFn, calls };
}

/** Extract a `-f key=value` field from a captured `gh api` call. */
function field(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${key}=`));
  return hit?.slice(key.length + 1);
}

async function ensureAndCapture(
  labelName: string,
  colour?: string,
): Promise<string[]> {
  const cacheDir = await Deno.makeTempDir({ prefix: "vibe-label-colour-" });
  try {
    const { ghCommandFn, calls } = captureCreate();
    const result = await ensureLabelExists(
      "org/repo",
      labelName,
      colour,
      undefined,
      { ghCommandFn, cacheDir },
    );
    assertEquals(result.ok, true);
    return calls.find((c) => c[0] === "api") ?? [];
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
}

Deno.test("ensureLabelExists - resolves a content label's colour from the canonical table", async () => {
  const create = await ensureAndCapture("severity:critical");
  assertEquals(field(create, "color"), "b60205");
  assertEquals(field(create, "name"), "severity:critical");
});

Deno.test("ensureLabelExists - resolves a workflow label's colour and description", async () => {
  const create = await ensureAndCapture("needs-human");
  assertEquals(field(create, "color"), "fbca04");
  assertEquals(
    field(create, "description"),
    "Worker has escalated this issue to a human",
  );
});

Deno.test("ensureLabelExists - two different labels no longer share one hard-coded red", async () => {
  const failed = await ensureAndCapture("failed");
  const merge = await ensureAndCapture("merge-conflict");
  assertEquals(field(failed, "color"), "d73a4a");
  assertEquals(field(merge, "color"), "b60205");
});

Deno.test("ensureLabelExists - falls back to the default colour for an unmanaged label", async () => {
  const create = await ensureAndCapture("someones-own-label");
  assertEquals(field(create, "color"), "d73a4a");
});

Deno.test("ensureLabelExists - an explicit colour still wins over the table", async () => {
  const create = await ensureAndCapture("severity:critical", "123abc");
  assertEquals(field(create, "color"), "123abc");
});
