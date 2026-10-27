/**
 * Tests for lib/merge_queue.ts — merge queue availability and opt-out (Issue #4424).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  buildMergeQueueParameters,
  detectMergeQueueAvailability,
  MERGE_QUEUE_OPT_OUT_TOPIC,
  MERGE_QUEUE_PROBE_NAME,
  MERGE_QUEUE_RULE_TYPE,
  type MergeQueueAvailability,
  readMergeQueueOptOut,
} from "../lib/merge_queue.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

type Reply = string | Error;

/** The id GitHub gives the probe ruleset in these tests. */
const PROBE_ID = 9;

const REPO_KEY = "api repos/org/repo";
const ORG_KEY = "api orgs/org";
const TOPICS_KEY = "api repos/org/repo/topics";
const CREATE_KEY = "api -X POST repos/org/repo/rulesets --input -";
const DELETE_KEY = `api -X DELETE repos/org/repo/rulesets/${PROBE_ID}`;

/**
 * A `gh` fake that answers known calls by their joined argument list and
 * records every call. An unknown call rejects, so a test fails loudly on it.
 */
function routedGh(routes: Record<string, Reply>): {
  gh: GhExec;
  calls: string[][];
  stdins: Array<string | undefined>;
} {
  const calls: string[][] = [];
  const stdins: Array<string | undefined> = [];
  const gh: GhExec = (args, stdin) => {
    calls.push(args);
    stdins.push(stdin);
    const reply: Reply | undefined = routes[args.join(" ")];
    if (reply === undefined) {
      return Promise.reject(
        new Error(`unexpected gh call: ${args.join(" ")}`),
      );
    }
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  };
  return { gh, calls, stdins };
}

/** A `GET repos/{repo}` body; every field the decision reads is present. */
function repoJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    owner: { type: "Organization" },
    private: false,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    ...overrides,
  });
}

/** The create response for the probe ruleset. */
const PROBE_CREATED = JSON.stringify({
  id: PROBE_ID,
  name: MERGE_QUEUE_PROBE_NAME,
});

/** The status and (for a decided outcome) the via of a result, for comparison. */
function summary(
  result: MergeQueueAvailability,
): { status: string; via?: string } {
  return "via" in result
    ? { status: result.status, via: result.via }
    : { status: result.status };
}

function mergeMethodOf(result: MergeQueueAvailability): string | undefined {
  return result.status === "available" ? result.mergeMethod : undefined;
}

// ---------------------------------------------------------------------------
// Constants and parameters
// ---------------------------------------------------------------------------

Deno.test("merge queue - the parameters are the worker's fixed settings", () => {
  assertEquals(buildMergeQueueParameters("REBASE"), {
    check_response_timeout_minutes: 60,
    grouping_strategy: "ALLGREEN",
    max_entries_to_build: 5,
    max_entries_to_merge: 5,
    merge_method: "REBASE",
    min_entries_to_merge: 1,
    min_entries_to_merge_wait_minutes: 1,
  });
  assertEquals(MERGE_QUEUE_RULE_TYPE, "merge_queue");
  assertEquals(MERGE_QUEUE_OPT_OUT_TOPIC, "no-merge-queue");
});

// ---------------------------------------------------------------------------
// Metadata path
// ---------------------------------------------------------------------------

Deno.test("merge queue - a public organisation repo is available from metadata with no ruleset write", async () => {
  const fake = routedGh({ [REPO_KEY]: repoJson({ private: false }) });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "metadata" });
  assertEquals(fake.calls, [["api", "repos/org/repo"]]);
});

Deno.test("merge queue - a user-owned repo is unavailable from metadata with no ruleset write", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({ owner: { type: "User" }, private: true }),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unavailable", via: "metadata" });
  assertStringIncludes(result.reason, "user account");
  assertEquals(fake.calls, [["api", "repos/org/repo"]]);
});

Deno.test("merge queue - a private organisation on the team plan is unavailable from metadata", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({ private: true }),
    [ORG_KEY]: JSON.stringify({ plan: { name: "team" } }),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unavailable", via: "metadata" });
  assertStringIncludes(result.reason, "team");
  assertStringIncludes(result.reason, "Enterprise Cloud");
  assertEquals(fake.calls, [
    ["api", "repos/org/repo"],
    ["api", "orgs/org"],
  ]);
});

Deno.test("merge queue - a private organisation on the enterprise plan is available from metadata", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({ private: true }),
    [ORG_KEY]: JSON.stringify({ plan: { name: "enterprise" } }),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "metadata" });
});

Deno.test("merge queue - a private organisation with an unreadable plan falls through to the probe", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({ private: true }),
    [ORG_KEY]: JSON.stringify({ login: "org" }),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "probe" });
  assert(fake.calls.some((args) => args.includes("POST")));
  assertEquals(fake.calls.at(-1), [
    "api",
    "-X",
    "DELETE",
    `repos/org/repo/rulesets/${PROBE_ID}`,
  ]);
});

// ---------------------------------------------------------------------------
// Merge method selection
// ---------------------------------------------------------------------------

Deno.test("merge queue - the merge method is SQUASH when squash is allowed", async () => {
  const fake = routedGh({ [REPO_KEY]: repoJson({ private: false }) });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(mergeMethodOf(result), "SQUASH");
});

Deno.test("merge queue - the merge method is MERGE when squash is disallowed", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({ private: false, allow_squash_merge: false }),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(mergeMethodOf(result), "MERGE");
});

Deno.test("merge queue - the merge method is REBASE when squash and merge commits are disallowed", async () => {
  const fake = routedGh({
    [REPO_KEY]: repoJson({
      private: false,
      allow_squash_merge: false,
      allow_merge_commit: false,
    }),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(mergeMethodOf(result), "REBASE");
});

// ---------------------------------------------------------------------------
// Probe path
// ---------------------------------------------------------------------------

Deno.test("merge queue - an unreadable repo metadata probes, creating then deleting the probe", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "probe" });
  assertEquals(fake.calls, [
    ["api", "repos/org/repo"],
    ["api", "-X", "POST", "repos/org/repo/rulesets", "--input", "-"],
    ["api", "-X", "DELETE", `repos/org/repo/rulesets/${PROBE_ID}`],
  ]);
  // The probe is disabled, targets the default branch and carries one
  // merge_queue rule using the chosen merge method.
  const probeBody = JSON.parse(fake.stdins[1] ?? "{}");
  assertEquals(probeBody.name, MERGE_QUEUE_PROBE_NAME);
  assertEquals(probeBody.enforcement, "disabled");
  assertEquals(probeBody.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assertEquals(probeBody.rules.length, 1);
  assertEquals(probeBody.rules[0].type, "merge_queue");
  assertEquals(probeBody.rules[0].parameters.merge_method, "SQUASH");
});

Deno.test("merge queue - malformed repo metadata probes rather than deciding", async () => {
  const fake = routedGh({
    [REPO_KEY]: "<html>not json</html>",
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "probe" });
});

Deno.test("merge queue - a probe refused with 422 is unavailable and quotes the cause", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: new Error(
      "gh: Invalid rule 'merge_queue' (HTTP 422)",
    ),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unavailable", via: "probe" });
  assertStringIncludes(result.reason, "Invalid rule");
  assertStringIncludes(result.reason, "Invalid rule 'merge_queue' (HTTP 422)");
  // Nothing was created, so there is nothing to delete.
  assertEquals(fake.calls.length, 2);
});

Deno.test("merge queue - a probe whose create succeeds is deleted and reports available", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "available", via: "probe" });
  const deletes = fake.calls.filter((args) => args.includes("DELETE"));
  assertEquals(deletes, [[
    "api",
    "-X",
    "DELETE",
    `repos/org/repo/rulesets/${PROBE_ID}`,
  ]]);
});

Deno.test("merge queue - a probe created but not deleted is unknown and names the leftover id", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: new Error("gh failed: HTTP 403 Forbidden"),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unknown" });
  assertStringIncludes(result.reason, `${PROBE_ID}`);
  assertStringIncludes(result.reason, "disabled");
  assertStringIncludes(result.reason, "must be deleted by hand");
});

Deno.test("merge queue - a probe created with no readable id is unknown and says it may need deleting", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: "{}",
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unknown" });
  assertStringIncludes(result.reason, MERGE_QUEUE_PROBE_NAME);
  assertStringIncludes(result.reason, "must be deleted by hand if present");
  // No id, so no delete was attempted.
  assertEquals(fake.calls.length, 2);
});

Deno.test("merge queue - a probe failing with a 500 is unknown and is not called a 422", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: new Error("gh failed: server error (HTTP 500)"),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(summary(result), { status: "unknown" });
  assertStringIncludes(result.reason, "probe failed:");
  assertFalse(result.reason.includes("422"));
  assertFalse(result.reason.includes("Invalid rule"));
});

Deno.test("merge queue - a long probe error is capped in the reason", async () => {
  const fake = routedGh({
    [REPO_KEY]: new Error("gh failed: server error (HTTP 500)"),
    [CREATE_KEY]: new Error("x".repeat(1000)),
  });

  const result = await detectMergeQueueAvailability("org/repo", true, fake.gh);

  assertEquals(result.status, "unknown");
  assert(result.reason.length <= "probe failed: ".length + 300);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

Deno.test("merge queue - an invalid repo slug is unknown with no gh call", async () => {
  const fake = routedGh({});

  const result = await detectMergeQueueAvailability("bad slug", true, fake.gh);

  assertEquals(result.status, "unknown");
  assertEquals(fake.calls, []);
});

Deno.test("merge queue - a gh executor that throws synchronously still yields a result, never a throw", async () => {
  const gh: GhExec = () => {
    throw new Error("boom");
  };

  const result = await detectMergeQueueAvailability("org/repo", true, gh);

  assertEquals(result.status, "unknown");
  assertStringIncludes(result.reason, "boom");
});

// ---------------------------------------------------------------------------
// Opt-out topic
// ---------------------------------------------------------------------------

Deno.test("merge queue - a repo carrying the opt-out topic is opted out", async () => {
  const fake = routedGh({
    [TOPICS_KEY]: JSON.stringify({
      names: ["python", MERGE_QUEUE_OPT_OUT_TOPIC],
    }),
  });

  assertEquals(await readMergeQueueOptOut("org/repo", fake.gh), {
    ok: true,
    optedOut: true,
  });
  assertEquals(fake.calls, [["api", "repos/org/repo/topics"]]);
});

Deno.test("merge queue - a repo without the opt-out topic is not opted out", async () => {
  const fake = routedGh({
    [TOPICS_KEY]: JSON.stringify({ names: ["python"] }),
  });

  assertEquals(await readMergeQueueOptOut("org/repo", fake.gh), {
    ok: true,
    optedOut: false,
  });
});

Deno.test("merge queue - an unreadable topic list is an error, not 'not opted out'", async () => {
  const forbidden = routedGh({
    [TOPICS_KEY]: new Error("gh failed: HTTP 403"),
  });
  const malformed = routedGh({ [TOPICS_KEY]: JSON.stringify({ names: "x" }) });

  const denied = await readMergeQueueOptOut("org/repo", forbidden.gh);
  const broken = await readMergeQueueOptOut("org/repo", malformed.gh);

  assertFalse(denied.ok);
  assertFalse(broken.ok);
});

Deno.test("merge queue - the opt-out read rejects an invalid slug with no gh call", async () => {
  const fake = routedGh({});

  assertFalse((await readMergeQueueOptOut("bad slug", fake.gh)).ok);
  assertEquals(fake.calls, []);
});

// ---------------------------------------------------------------------------
// Read-only runs never probe (Issue #4424)
// ---------------------------------------------------------------------------

/** Every call that is not a GET: a create, an update or a delete. */
function writeCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args.includes("-X"));
}

Deno.test("merge queue - a read-only run never probes an unreadable metadata read (Issue #4424)", async () => {
  const routes: Record<string, Reply> = {
    [REPO_KEY]: new Error("gh failed: HTTP 503: unavailable"),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  };
  const readOnly = routedGh(routes);

  const result = await detectMergeQueueAvailability(
    "org/repo",
    false,
    readOnly.gh,
  );

  assertEquals(result.status, "unknown");
  assertStringIncludes(result.reason, "read-only");
  assertStringIncludes(result.reason, "probe was skipped");
  assertEquals(writeCalls(readOnly.calls), []);

  // Positive control: the same metadata failure with the probe allowed does
  // create and delete the probe ruleset, and is then available.
  const allowed = routedGh(routes);
  const probed = await detectMergeQueueAvailability(
    "org/repo",
    true,
    allowed.gh,
  );
  assertEquals(summary(probed), { status: "available", via: "probe" });
  assertEquals(writeCalls(allowed.calls).length, 2);
});

Deno.test("merge queue - a read-only run never probes an unreadable organisation plan (Issue #4424)", async () => {
  const routes: Record<string, Reply> = {
    [REPO_KEY]: repoJson({ private: true }),
    [ORG_KEY]: new Error("gh failed: HTTP 404: Not Found"),
    [CREATE_KEY]: PROBE_CREATED,
    [DELETE_KEY]: "",
  };
  const readOnly = routedGh(routes);

  const result = await detectMergeQueueAvailability(
    "org/repo",
    false,
    readOnly.gh,
  );

  assertEquals(result.status, "unknown");
  assertStringIncludes(result.reason, "probe was skipped");
  assertEquals(writeCalls(readOnly.calls), []);

  // Positive control: with the probe allowed the same plan is answered by it.
  const allowed = routedGh(routes);
  const probed = await detectMergeQueueAvailability(
    "org/repo",
    true,
    allowed.gh,
  );
  assertEquals(summary(probed), { status: "available", via: "probe" });
});
