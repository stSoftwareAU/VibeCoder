/**
 * Code-owner review stays off on every fleet repository: the fleet reviewer
 * is a GitHub App, which can never be a code owner, so its approval is the
 * gate (THREAT-MODEL R14). `repo-settings-harden` turns the ruleset flag off;
 * nothing that scans the fleet may ask for it back, or the two oscillate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */
import { assert, assertEquals } from "@std/assert";

const repoFile = (path: string) =>
  Deno.readTextFile(new URL(`../../../${path}`, import.meta.url));

Deno.test("code-owner policy - the best-practice prompt forbids recommending code-owner review", async () => {
  const prompt = await repoFile("prompts/best_practices/buckets/general.md");
  assert(
    prompt.includes("**Never** recommend enabling code-owner review"),
    "the Branch protection check must carry the fleet policy",
  );
  // The old guidance promoted a missing CODEOWNERS rule to high severity as
  // if it were a merge gate.
  assert(
    !/promote to `severity:high`\s+when the repo has \*\*privileged workflows/
      .test(prompt),
  );
});

Deno.test("code-owner policy - no scanner files a code-owner finding", async () => {
  for (
    const path of [
      "worker/deno/lib/repo_settings_scanner.ts",
      "worker/deno/setup/repo_settings_audit_close.ts",
    ]
  ) {
    const source = await repoFile(path);
    assertEquals(
      [...source.matchAll(/"BP-REPO-[A-Z-]*CODEOWNER[A-Z-]*"/g)].map((m) =>
        m[0]
      ),
      [],
      path,
    );
  }
});

Deno.test("code-owner policy - VibeCoder's own main ruleset leaves code-owner review off", async () => {
  const ruleset = JSON.parse(await repoFile("infra/rulesets/main.json")) as {
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  const pr = ruleset.rules.find((r) => r.type === "pull_request");
  assertEquals(pr?.parameters?.require_code_owner_review, false);
});
