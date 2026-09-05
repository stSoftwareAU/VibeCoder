/**
 * Tests for the live-versus-committed `main` ruleset check (Issue #858).
 *
 * The check is the half that makes the committed payload more than a wish: it
 * reads the ruleset GitHub actually applies and reports every field that
 * differs. It must skip — loudly — without a credential, and it must never
 * report "no drift" for a ruleset it could not read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { checkMainBranchRuleset } from "../lib/main_branch_ruleset_check.ts";
import { loadMainBranchRuleset } from "../lib/main_branch_ruleset.ts";

/** A `gh` stub returning the ruleset list, then the ruleset detail. */
function ghStub(list: unknown, detail: unknown) {
  const calls: string[][] = [];
  const exec = (args: string[]): Promise<string> => {
    calls.push(args);
    const path = args[args.length - 1] ?? "";
    const body = path.match(/rulesets\/\d+$/) ? detail : list;
    return Promise.resolve(JSON.stringify(body));
  };
  return { exec, calls };
}

/** The committed payload rendered as the API returns it, with an id. */
async function liveFromCommitted(): Promise<Record<string, unknown>> {
  const committed = await loadMainBranchRuleset();
  return {
    id: 21019403,
    ...JSON.parse(JSON.stringify(committed)) as Record<string, unknown>,
  };
}

const SUMMARY = [{ id: 21019403, name: "main", target: "branch" }];

Deno.test("checkMainBranchRuleset - an applied ruleset matching the file is ok", async () => {
  const { exec, calls } = ghStub(SUMMARY, await liveFromCommitted());
  const result = await checkMainBranchRuleset({
    repo: "stSoftwareAU/VibeCoder",
    ghExec: exec,
  });
  assertEquals(result.status, "ok");
  assertEquals(result.findings, []);
  assertEquals(calls.length, 2);
});

Deno.test("checkMainBranchRuleset - reports drift when a required check is missing", async () => {
  const live = await liveFromCommitted() as {
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  const rule = live.rules.find((r) => r.type === "required_status_checks");
  const contexts = rule?.parameters
    ?.required_status_checks as Array<{ context: string }>;
  rule!.parameters!.required_status_checks = contexts.filter((c) =>
    c.context !== "validate"
  );
  const { exec } = ghStub(SUMMARY, live);
  const result = await checkMainBranchRuleset({
    repo: "stSoftwareAU/VibeCoder",
    ghExec: exec,
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.length, 1);
  assertStringIncludes(result.message, "validate");
});

Deno.test("checkMainBranchRuleset - a missing ruleset fails loud, it does not skip", async () => {
  const { exec } = ghStub([{ id: 1, name: "Milestone", target: "branch" }], {});
  const result = await checkMainBranchRuleset({
    repo: "stSoftwareAU/VibeCoder",
    ghExec: exec,
  });
  assertEquals(result.status, "absent");
  assertStringIncludes(result.message, "main");
});

Deno.test("checkMainBranchRuleset - skips with no credential, and says so", async () => {
  for (const message of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden"]) {
    const result = await checkMainBranchRuleset({
      repo: "stSoftwareAU/VibeCoder",
      ghExec: () => Promise.reject(new Error(message)),
    });
    assertEquals(result.status, "skipped");
    assertStringIncludes(result.message, "SKIPPED");
  }
});

Deno.test("checkMainBranchRuleset - skips when GitHub is unreachable", async () => {
  const result = await checkMainBranchRuleset({
    repo: "stSoftwareAU/VibeCoder",
    ghExec: () => Promise.reject(new Error("dial tcp: connection refused")),
  });
  assertEquals(result.status, "skipped");
});

Deno.test("checkMainBranchRuleset - an unexpected failure is never swallowed", async () => {
  await assertRejects(
    () =>
      checkMainBranchRuleset({
        repo: "stSoftwareAU/VibeCoder",
        ghExec: () => Promise.reject(new Error("HTTP 422: unprocessable")),
      }),
    Error,
    "422",
  );
});

Deno.test("checkMainBranchRuleset - rejects an unsafe repo slug", async () => {
  await assertRejects(
    () =>
      checkMainBranchRuleset({
        repo: "stSoftwareAU/VibeCoder; rm -rf /",
        ghExec: () => Promise.resolve("[]"),
      }),
    Error,
    "repo",
  );
});

Deno.test("checkMainBranchRuleset - unreadable JSON fails loud", async () => {
  await assertRejects(
    () =>
      checkMainBranchRuleset({
        repo: "stSoftwareAU/VibeCoder",
        ghExec: () => Promise.resolve("<html>"),
      }),
    Error,
  );
  assert(true);
});
