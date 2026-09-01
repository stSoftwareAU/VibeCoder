/**
 * Tests for Issue #665 — the `references-refresh` command wiring.
 *
 * The sweep itself is covered by `references_refresh_test.ts`; these tests pin
 * the command surface: it is registered, it parses its arguments, it reports
 * the sweep's outcome faithfully, and a sweep that could not run exits
 * non-zero rather than reporting a clean pass.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createReferencesRefreshCommand,
  parseMaxIssues,
  referencesRefreshCommand,
} from "../commands/references_refresh.ts";
import {
  DEFAULT_MAX_ISSUES,
  type RefreshDeps,
} from "../lib/references_refresh.ts";
import { createDefaultRegistry } from "../mod.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;

const REFERENCES = [
  "| Source | What we took | Where it shows up |",
  "| ------ | ------------ | ----------------- |",
  "| [mattpocock/skills](https://github.com/mattpocock/skills) | The grilling " +
  "session | `prompts/grill-me/` |",
].join("\n");

interface Stub {
  deps: RefreshDeps;
  ghCalls: string[][];
  writes: Map<string, string>;
}

function stub(gaps: string[] = []): Stub {
  const ghCalls: string[][] = [];
  const writes = new Map<string, string>();
  const deps: RefreshDeps = {
    probeFn: (_entry, _since) =>
      Promise.resolve({
        revision: "rev-2",
        gaps: gaps.map((unit) => ({
          key: `${unit}@abc1234`,
          unit,
          detail: [],
        })),
      }),
    readTextFn: (path) =>
      path.endsWith("docs/REFERENCES.md")
        ? Promise.resolve(REFERENCES)
        : Promise.reject(new Deno.errors.NotFound(path)),
    writeTextFn: (path, contents) => {
      writes.set(path, contents);
      return Promise.resolve();
    },
    ghCommandFn: (args) => {
      ghCalls.push(args);
      if (args[0] === "repo") {
        return Promise.resolve("stSoftwareAU/VibeCoder\n");
      }
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve(
        "https://github.com/stSoftwareAU/VibeCoder/issues/777\n",
      );
    },
  };
  return { deps, ghCalls, writes };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

Deno.test("references-refresh is registered on the default registry", () => {
  assertEquals(referencesRefreshCommand.name, "references-refresh");
  assertStringIncludes(referencesRefreshCommand.description, "665");
  assert(
    createDefaultRegistry().has("references-refresh"),
    "the command must be reachable from mod.ts",
  );
});

Deno.test("worker/deno/deno.json registers a references-refresh task", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { tasks: Record<string, string> };
  const task = config.tasks["references-refresh"];

  assert(task !== undefined, "deno.json must carry the task");
  assertStringIncludes(task, "mod.ts references-refresh");
  // The sweep fetches sources and files issues, so it needs both.
  assertStringIncludes(task, "--allow-net");
  assertStringIncludes(task, "--allow-run");
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

Deno.test("parseMaxIssues defaults, accepts an integer and rejects nonsense", () => {
  assertEquals(parseMaxIssues(undefined), {
    ok: true,
    value: DEFAULT_MAX_ISSUES,
  });
  assertEquals(parseMaxIssues("3"), { ok: true, value: 3 });
  assertEquals(parseMaxIssues(7), { ok: true, value: 7 });
  assertEquals(parseMaxIssues("0").ok, false);
  assertEquals(parseMaxIssues("-2").ok, false);
  assertEquals(parseMaxIssues("many").ok, false);
});

Deno.test("an unusable --max-issues fails before anything is swept", async () => {
  const s = stub(["a"]);

  const result = await createReferencesRefreshCommand(s.deps).execute(
    { "max-issues": "0" },
    CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--max-issues");
  assertEquals(s.ghCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

Deno.test("a report-only run names the gaps and files nothing", async () => {
  const s = stub(["skills/engineering/code-review"]);

  const result = await createReferencesRefreshCommand(s.deps).execute(
    { slug: "stSoftwareAU/VibeCoder", state: "/nowhere/state.json" },
    CONFIG,
  );

  assertEquals(result.success, true);
  assertStringIncludes(result.message, "skills/engineering/code-review");
  assertStringIncludes(result.message, "report only");
  assertEquals(
    s.ghCalls.some((args) => args[1] === "create"),
    false,
    "report-only must not file anything",
  );
});

Deno.test("--file-issues files the suggestion and records the revision", async () => {
  const s = stub(["skills/engineering/code-review"]);

  const result = await createReferencesRefreshCommand(s.deps).execute(
    {
      slug: "stSoftwareAU/VibeCoder",
      state: "/nowhere/state.json",
      "file-issues": true,
    },
    CONFIG,
  );

  assertEquals(result.success, true);
  assertStringIncludes(result.message, "Filed: #777");
  assertStringIncludes(result.message, "commit it");
  assert(s.writes.has("/nowhere/state.json"));
});

Deno.test("a sweep that could not run reports failure", async () => {
  const s = stub();
  const deps: RefreshDeps = {
    ...s.deps,
    probeFn: () => Promise.reject(new Error("request timed out after 30000ms")),
  };

  const result = await createReferencesRefreshCommand(deps).execute(
    { slug: "stSoftwareAU/VibeCoder", state: "/nowhere/state.json" },
    CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "timed out");
});

Deno.test("an unresolvable slug fails loud rather than sweeping blind", async () => {
  const s = stub();
  const deps: RefreshDeps = {
    ...s.deps,
    ghCommandFn: (args) =>
      args[0] === "repo" ? Promise.resolve("") : Promise.resolve("[]"),
  };

  const result = await createReferencesRefreshCommand(deps).execute({}, CONFIG);

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--slug");
});
