/**
 * Tests for lib/ci_mutation_lookup.ts and `readRequiredCheckNames`: the GitHub
 * reads behind the CI mutation contract (Issue #4617), driven by a stub `gh`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ciMutationLookupOptions } from "../lib/ci_mutation_lookup.ts";
import { readRequiredCheckNames } from "../lib/required_branch_checks_4613.ts";

const RULES = [[{
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context: "gate" }] },
}]];

/** A stub `gh` that answers the three reads and records each argument list. */
function stubGh(opts: {
  protection?: unknown;
  rulesFail?: boolean;
  files?: Record<string, string>;
} = {}) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const url = args[1] ?? "";
    if (url.includes("/rules/branches/")) {
      return opts.rulesFail
        ? Promise.reject(new Error("HTTP 403"))
        : Promise.resolve(JSON.stringify(RULES));
    }
    if (url.includes("/branches/")) {
      return Promise.resolve(JSON.stringify({
        protection: opts.protection ?? null,
      }));
    }
    const file = opts.files?.[url];
    return file === undefined
      ? Promise.reject(new Error("HTTP 404"))
      : Promise.resolve(file);
  };
  return { calls, gh };
}

Deno.test("readRequiredCheckNames merges rulesets and classic protection without duplicates", async () => {
  const { gh } = stubGh({
    protection: {
      required_status_checks: {
        contexts: ["gate", "legacy"],
        checks: [{ context: "gate" }, { context: "mutants" }],
      },
    },
  });
  assertEquals(await readRequiredCheckNames("acme/app", "main", gh), [
    "gate",
    "legacy",
    "mutants",
  ]);
});

Deno.test("readRequiredCheckNames returns an empty list when nothing is required", async () => {
  const gh = (args: string[]) =>
    Promise.resolve(
      (args[1] ?? "").includes("/rules/branches/")
        ? "[[]]"
        : JSON.stringify({ protection: null }),
    );
  assertEquals(await readRequiredCheckNames("acme/app", "main", gh), []);
});

Deno.test("readRequiredCheckNames rejects a bad repository or an unreadable branch", async () => {
  const { gh } = stubGh();
  await assertRejects(() => readRequiredCheckNames("not a repo", "main", gh));
  await assertRejects(() => readRequiredCheckNames("acme/app", "", gh));
  const failing = stubGh({ rulesFail: true });
  await assertRejects(
    () => readRequiredCheckNames("acme/app", "main", failing.gh),
    Error,
    "403",
  );
});

Deno.test("ciMutationLookupOptions reads required checks and serves remote workflow text", async () => {
  const url = "repos/acme/ci/contents/.github/workflows/m.yml?ref=v1";
  const { calls, gh } = stubGh({ files: { [url]: "on: workflow_call\n" } });
  const warnings: string[] = [];
  const options = await ciMutationLookupOptions({
    repo: "acme/app",
    base: "release/1.0",
    runGh: gh,
    logger: { warn: (m) => warnings.push(m) },
  });
  assertEquals(options.requiredChecks, ["gate"]);
  assertEquals(
    await options.fetchRemoteWorkflow!({
      repo: "acme/ci",
      path: ".github/workflows/m.yml",
      ref: "v1",
    }),
    "on: workflow_call\n",
  );
  // The branch name is one encoded path segment; the raw media type is asked for.
  assertEquals(
    calls[0]![1],
    "repos/acme/app/rules/branches/release%2F1.0?per_page=100",
  );
  assertEquals(calls.at(-1), [
    "api",
    url,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  assertEquals(warnings, []);
});

Deno.test("ciMutationLookupOptions treats a failed read as unknown, never as none required", async () => {
  const { gh } = stubGh({ rulesFail: true });
  const warnings: string[] = [];
  const options = await ciMutationLookupOptions({
    repo: "acme/app",
    base: "main",
    runGh: gh,
    logger: { warn: (m) => warnings.push(m) },
  });
  assertEquals("requiredChecks" in options, false);
  assertEquals(
    await options.fetchRemoteWorkflow!({
      repo: "acme/ci",
      path: ".github/workflows/m.yml",
      ref: "v1",
    }),
    null,
  );
  assertEquals(warnings.length, 2);
});
