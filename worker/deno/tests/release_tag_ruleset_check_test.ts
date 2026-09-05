/**
 * Tests for the live-versus-committed release-tag ruleset check (Issue #1049).
 *
 * `infra/rulesets/release-tags.json` called itself the source of truth for the
 * applied tag ruleset, and nothing compared the two. The applied ruleset was
 * carrying `deletion` and `non_fast_forward` only — the `update` rule that
 * refuses to fast-forward `1.2.0` onto a later commit had been dropped when a
 * human applied it, and the file could have said one thing while the
 * repository did another indefinitely.
 *
 * These tests drive the reconciliation one drift direction at a time. The
 * `bypass_actors` case matters most: a ruleset carrying a bypass actor is
 * still `active` and protects nothing, so a check comparing only rule types
 * would pass on the worst real-world drift.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { checkReleaseTagRuleset } from "../lib/release_tag_ruleset_check.ts";
import { loadReleaseTagRuleset } from "../lib/release_tag_ruleset.ts";
import { diffRulesetPayloads } from "../lib/ruleset_reconcile.ts";

const REPO = "stSoftwareAU/VibeCoder";
const RULESET_ID = 22264472;
const SUMMARY = [{ id: RULESET_ID, name: "Release tags", target: "tag" }];

/** A `gh` stub returning the ruleset list, then the ruleset detail. */
function ghStub(list: unknown, detail: unknown) {
  const calls: string[][] = [];
  const exec = (args: string[]): Promise<string> => {
    calls.push(args);
    const path = args[args.length - 1] ?? "";
    return Promise.resolve(
      JSON.stringify(path.match(/rulesets\/\d+$/) ? detail : list),
    );
  };
  return { exec, calls };
}

/** The committed payload rendered as the API returns it, with an id. */
async function liveFromCommitted(): Promise<Record<string, unknown>> {
  const committed = await loadReleaseTagRuleset();
  return {
    id: RULESET_ID,
    ...JSON.parse(JSON.stringify(committed)) as Record<string, unknown>,
  };
}

/** Run the check against a live payload the caller has mutated. */
async function checkAgainst(
  mutate: (live: Record<string, unknown>) => void,
) {
  const live = await liveFromCommitted();
  mutate(live);
  const { exec } = ghStub(SUMMARY, live);
  return await checkReleaseTagRuleset({ repo: REPO, ghExec: exec });
}

Deno.test("checkReleaseTagRuleset - an applied ruleset matching the file is ok", async () => {
  const { exec, calls } = ghStub(SUMMARY, await liveFromCommitted());
  const result = await checkReleaseTagRuleset({ repo: REPO, ghExec: exec });
  assertEquals(result.status, "ok");
  assertEquals(result.findings, []);
  assertEquals(calls.length, 2);
  assertStringIncludes(result.message, "infra/rulesets/release-tags.json");
});

Deno.test("checkReleaseTagRuleset - a missing rule is named, not just counted", async () => {
  // The drift this issue was filed for: `update` applied nowhere, so a
  // release tag can still be fast-forwarded onto a later commit.
  const result = await checkAgainst((live) => {
    live.rules = (live.rules as Array<{ type: string }>).filter((rule) =>
      rule.type !== "update"
    );
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.length, 1);
  assertEquals(result.findings[0]?.field, "rules");
  assertStringIncludes(result.findings[0]?.detail ?? "", "update");
  assertStringIncludes(result.message, "gh api --method PUT");
});

Deno.test("checkReleaseTagRuleset - an extra applied rule is drift too", async () => {
  const result = await checkAgainst((live) => {
    (live.rules as Array<{ type: string }>).push({ type: "creation" });
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.length, 1);
  assertEquals(result.findings[0]?.field, "rules");
  assertStringIncludes(result.findings[0]?.detail ?? "", "creation");
});

Deno.test("checkReleaseTagRuleset - enforcement dropped to evaluate is drift", async () => {
  const result = await checkAgainst((live) => {
    live.enforcement = "evaluate";
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings[0]?.field, "enforcement");
  assertStringIncludes(result.findings[0]?.detail ?? "", "evaluate");
});

Deno.test("checkReleaseTagRuleset - a bypass actor is drift, not a pass", async () => {
  // The worst real-world drift: still "active", protects nobody.
  const result = await checkAgainst((live) => {
    live.bypass_actors = [{ actor_id: 1, actor_type: "OrganizationAdmin" }];
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings[0]?.field, "bypass_actors");
  assertStringIncludes(result.findings[0]?.detail ?? "", "protect nothing");
});

Deno.test("checkReleaseTagRuleset - a changed ref_name include is named", async () => {
  const result = await checkAgainst((live) => {
    const refName = (live.conditions as {
      ref_name: { include: string[] };
    }).ref_name;
    refName.include = ["refs/tags/v[0-9]*.[0-9]*.[0-9]*"];
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.length, 1);
  assertEquals(result.findings[0]?.field, "conditions.ref_name.include");
  assertStringIncludes(
    result.findings[0]?.detail ?? "",
    "refs/tags/[0-9]*.[0-9]*.[0-9]*",
  );
});

Deno.test("checkReleaseTagRuleset - a changed ref_name exclude is named", async () => {
  const result = await checkAgainst((live) => {
    (live.conditions as { ref_name: { exclude: string[] } }).ref_name
      .exclude = [];
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings[0]?.field, "conditions.ref_name.exclude");
});

Deno.test("checkReleaseTagRuleset - a deleted or renamed ruleset fails loud", async () => {
  // Absent is indistinguishable from unprotected, so it must never skip.
  const { exec } = ghStub([{ id: 1, name: "main", target: "branch" }], {});
  const result = await checkReleaseTagRuleset({ repo: REPO, ghExec: exec });
  assertEquals(result.status, "absent");
  assertStringIncludes(result.message, "Release tags");
  assertStringIncludes(result.message, "--method POST");
});

Deno.test("checkReleaseTagRuleset - a branch ruleset of the same name is not a match", async () => {
  const { exec } = ghStub(
    [{ id: 7, name: "Release tags", target: "branch" }],
    {},
  );
  const result = await checkReleaseTagRuleset({ repo: REPO, ghExec: exec });
  assertEquals(result.status, "absent");
});

Deno.test("checkReleaseTagRuleset - skips with no credential, and says so", async () => {
  for (const message of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden"]) {
    const result = await checkReleaseTagRuleset({
      repo: REPO,
      ghExec: () => Promise.reject(new Error(message)),
    });
    // Asserted explicitly: a skip must never be reported as agreement.
    assertEquals(result.status, "skipped");
    assertStringIncludes(result.message, "SKIPPED");
    assertStringIncludes(result.message, "not a pass");
  }
});

Deno.test("checkReleaseTagRuleset - the literal no-credential cases skip", async () => {
  // None of these carry an HTTP status, so the shared classifier files them
  // under `unknown` — they propagated, and the gate went red on every fork.
  const messages = [
    "gh: To get started with GitHub CLI, please run: gh auth login",
    "Failed to spawn 'gh': entity not found",
    "gh: command not found",
    "gh command failed (exit 1): gh: Not Found (HTTP 404)",
  ];
  for (const message of messages) {
    const result = await checkReleaseTagRuleset({
      repo: REPO,
      ghExec: () => Promise.reject(new Error(message)),
    });
    assertEquals(result.status, "skipped", `did not skip on: ${message}`);
    assertStringIncludes(result.message, "not a pass");
  }
});

Deno.test("checkReleaseTagRuleset - a detail read that fails skips, never passes", async () => {
  // A credential that can list rulesets but not read one must not be able to
  // report agreement by reading nothing.
  const exec = (args: string[]): Promise<string> =>
    (args[args.length - 1] ?? "").match(/rulesets\/\d+$/)
      ? Promise.reject(new Error("HTTP 403: Forbidden"))
      : Promise.resolve(JSON.stringify(SUMMARY));
  const result = await checkReleaseTagRuleset({ repo: REPO, ghExec: exec });
  assertEquals(result.status, "skipped");
  assertStringIncludes(result.message, String(RULESET_ID));
});

Deno.test("diffRulesetPayloads - a swapped bypass actor is drift at equal count", async () => {
  // The count-only comparison this replaced read a swap as agreement: the
  // bypass moves to somebody else while the tally stays put.
  const committed = await loadReleaseTagRuleset();
  const live = await liveFromCommitted();
  const actor = { actor_id: 5, actor_type: "Team", bypass_mode: "always" };
  live.bypass_actors = [actor];
  committed.bypass_actors = [{ ...actor, actor_id: 6 }];

  const drift = diffRulesetPayloads(live, committed);
  assertEquals(drift.length, 2);
  for (const finding of drift) assertEquals(finding.field, "bypass_actors");
  assertStringIncludes(drift.map((d) => d.detail).join(" "), "Team:6");
  assertStringIncludes(drift.map((d) => d.detail).join(" "), "Team:5");
});

Deno.test("diffRulesetPayloads - an identical bypass list is not drift", async () => {
  const committed = await loadReleaseTagRuleset();
  const live = await liveFromCommitted();
  const actor = { actor_id: 5, actor_type: "Team", bypass_mode: "always" };
  live.bypass_actors = [actor];
  committed.bypass_actors = [{ ...actor }];
  assertEquals(diffRulesetPayloads(live, committed), []);
});

Deno.test("checkReleaseTagRuleset - skips when GitHub is unreachable", async () => {
  const result = await checkReleaseTagRuleset({
    repo: REPO,
    ghExec: () => Promise.reject(new Error("dial tcp: connection refused")),
  });
  assertEquals(result.status, "skipped");
});

Deno.test("checkReleaseTagRuleset - an unexpected failure is never swallowed", async () => {
  await assertRejects(
    () =>
      checkReleaseTagRuleset({
        repo: REPO,
        ghExec: () => Promise.reject(new Error("HTTP 422: unprocessable")),
      }),
    Error,
    "422",
  );
});

Deno.test("checkReleaseTagRuleset - unreadable JSON fails loud", async () => {
  await assertRejects(
    () =>
      checkReleaseTagRuleset({
        repo: REPO,
        ghExec: () => Promise.resolve("<html>"),
      }),
    Error,
    "could not read",
  );
});

Deno.test("checkReleaseTagRuleset - rejects an unsafe repo slug", async () => {
  await assertRejects(
    () =>
      checkReleaseTagRuleset({
        repo: "stSoftwareAU/VibeCoder; rm -rf /",
        ghExec: () => Promise.resolve("[]"),
      }),
    Error,
    "repo",
  );
});
