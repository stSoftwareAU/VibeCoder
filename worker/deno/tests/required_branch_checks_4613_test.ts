import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  readRequiredChecksFailed,
  readRequiredChecksPassed,
  requestReadyBranchUpdate,
  requiredChecksPassed,
} from "../lib/required_branch_checks_4613.ts";
import { requestBranchUpdate } from "../lib/merge_block_escalation.ts";

const rules = [{
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: [{ context: "gate" }],
  },
}];
const passed = {
  name: "gate",
  status: "completed",
  conclusion: "success",
  app: { id: 1, slug: "external-ci" },
};

Deno.test("required branch checks use the contract, not optional jobs", () => {
  assertEquals(
    requiredChecksPassed(rules, null, [passed, {
      name: "optional",
      status: "in_progress",
    }], []),
    true,
  );
  assertEquals(
    requiredChecksPassed(rules, null, [{
      ...passed,
      status: "in_progress",
      conclusion: null,
    }], []),
    false,
  );
  assertEquals(
    requiredChecksPassed(
      rules,
      null,
      [{ ...passed, conclusion: "failure" }],
      [],
    ),
    false,
  );
  assertEquals(requiredChecksPassed(rules, null, [], []), false);
  assertEquals(
    requiredChecksPassed(rules, null, [passed], [{
      context: "gate",
      state: "failure",
    }]),
    false,
  );
});

Deno.test("required check failure reconciliation ignores optional and pending jobs", async () => {
  const head = "a".repeat(40);
  let gateStatus = "completed";
  let gateConclusion: string | null = "failure";
  let optionalFailure = false;
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([rules]));
    }
    if (endpoint.includes("/branches/")) {
      return Promise.resolve(JSON.stringify({
        protection: {
          required_status_checks: { contexts: [], checks: [], strict: false },
        },
      }));
    }
    if (endpoint.includes("/check-runs?")) {
      return Promise.resolve(JSON.stringify([{
        check_runs: [
          {
            ...passed,
            status: gateStatus,
            conclusion: gateConclusion,
          },
          ...(optionalFailure
            ? [{
              name: "optional",
              status: "completed",
              conclusion: "failure",
              app: { id: 2, slug: "external-ci" },
            }]
            : []),
        ],
      }]));
    }
    if (endpoint.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
    }
    throw new Error("unexpected required-check failure read");
  };
  assertEquals(
    await readRequiredChecksFailed("owner/repo", "main", head, gh),
    true,
  );
  gateStatus = "in_progress";
  gateConclusion = null;
  assertEquals(
    await readRequiredChecksFailed("owner/repo", "main", head, gh),
    false,
  );
  optionalFailure = true;
  assertEquals(
    await readRequiredChecksFailed("owner/repo", "main", head, gh),
    false,
  );
});

Deno.test("ready updater checks the live head and sends its SHA", async () => {
  let head = "a".repeat(40);
  const mergeHead = "b".repeat(40);
  const baseHead = "c".repeat(40);
  let conclusion = "success";
  let decision = "APPROVED";
  let strictPolicy = true;
  let queued = false;
  const classicProtection: unknown = {
    enabled: false,
    required_status_checks: {
      contexts: [],
      checks: [],
      enforcement_level: "off",
    },
  };
  let retarget = false;
  let wrongParent = false;
  let wrongParentReads = 0;
  let mergeabilityReadings: string[] = [];
  const retryWaits: number[] = [];
  let views = 0;
  const writes: string[][] = [];
  const comments: Array<
    { id: number; body: string; author: string; created_at: string }
  > = [];
  let nextCommentId = 100;
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (args[0] === "pr" && args[1] === "view") {
      if (args.at(-1)?.includes("isDraft")) views++;
      return Promise.resolve(
        JSON.stringify({
          state: "OPEN",
          isDraft: false,
          baseRefName: retarget && views === 2 ? "other-base" : "main",
          headRefOid: head,
          autoMergeRequest: {},
          reviewDecision: decision,
          mergeable: mergeabilityReadings.shift() ?? "MERGEABLE",
          mergeStateStatus: "BEHIND",
        }),
      );
    }
    if (args[0] === "api" && endpoint.includes("/pulls?state=all")) {
      return Promise.resolve("12\n");
    }
    if (args[0] === "pr" && args[1] === "checks") {
      return Promise.resolve(JSON.stringify([]));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const id = nextCommentId++;
      comments.push({
        id,
        body: args[args.indexOf("--body") + 1]!,
        author: "VibeCoderST",
        created_at: new Date().toISOString(),
      });
      return Promise.resolve(
        `https://github.com/owner/repo/issues/12#issuecomment-${id}`,
      );
    }
    if (endpoint === "--method") {
      writes.push(args);
      return Promise.resolve("");
    }
    if (endpoint.includes("/comments?")) {
      return Promise.resolve(JSON.stringify(comments.map((comment) => ({
        ...comment,
        user: { login: comment.author },
      }))));
    }
    if (args.join(" ").includes("/issues/comments/")) {
      const id = Number(args.join(" ").split("/").at(-1));
      const index = comments.findIndex((comment) => comment.id === id);
      if (index >= 0) comments.splice(index, 1);
      return Promise.resolve("");
    }
    if (endpoint.includes("/pulls/")) {
      return Promise.resolve(
        JSON.stringify({
          state: "open",
          mergeable: true,
          merge_commit_sha: mergeHead,
          head: { sha: head },
          base: { ref: "main", sha: baseHead },
        }),
      );
    }
    if (endpoint.includes("/git/commits/")) {
      return Promise.resolve(
        JSON.stringify({
          parents: [{
            sha: wrongParent || wrongParentReads-- > 0
              ? "d".repeat(40)
              : baseHead,
          }, {
            sha: head,
          }],
        }),
      );
    }
    if (endpoint.includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([[
        ...(queued ? [{ type: "merge_queue" }] : []),
        {
          ...rules[0],
          parameters: {
            ...rules[0]!.parameters,
            strict_required_status_checks_policy: strictPolicy,
          },
        },
      ]]));
    }
    if (endpoint.includes("/branches/")) {
      return Promise.resolve(JSON.stringify({ protection: classicProtection }));
    }
    if (endpoint.includes("/check-runs?")) {
      return Promise.resolve(
        JSON.stringify([{
          check_runs: endpoint.includes(mergeHead)
            ? []
            : [{ ...passed, conclusion }],
        }]),
      );
    }
    if (endpoint.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
    }
    throw new Error("unexpected endpoint");
  };
  let baselineRefreshes = 0;
  for (const prNumber of [12, 13]) {
    if ((await requestBranchUpdate("owner/repo", prNumber, gh, head)).ok) {
      baselineRefreshes++;
    }
  }
  assertEquals(baselineRefreshes, 2);
  writes.length = 0;
  const request = (base?: string) =>
    requestReadyBranchUpdate(
      "owner/repo",
      12,
      gh,
      base,
      undefined,
      async (ms) => {
        retryWaits.push(ms);
      },
      { fleetAuthors: ["VibeCoderST"] },
    );
  const firstRequest = await request();
  if (!firstRequest.ok) throw firstRequest.error;
  assertEquals(firstRequest.ok, true);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.slice(-2), ["-f", `expected_head_sha=${head}`]);
  head = "d".repeat(40);
  assertEquals((await request()).ok, true);
  assertEquals(writes.length, 2);
  assertEquals(writes[1]?.slice(-2), ["-f", `expected_head_sha=${head}`]);
  const nextReadyPr = await requestReadyBranchUpdate(
    "owner/repo",
    13,
    gh,
    "main",
    undefined,
    async () => {},
    { fleetAuthors: ["VibeCoderST"] },
  );
  assertEquals(nextReadyPr.ok, false);
  if (!nextReadyPr.ok) {
    assertEquals(
      nextReadyPr.error.message.startsWith(
        "base refresh owned by owner/repo#12 (",
      ),
      true,
    );
  }
  // On this same two-ready-PR backlog, refresh requests drop from two to one.
  assertEquals(writes.length, 2);
  conclusion = "failure";
  assertEquals((await request()).ok, false);
  assertEquals(
    comments.some((comment) =>
      comment.body.startsWith("<!-- BASE_REFRESH_OWNER_4613:")
    ),
    false,
  );
  conclusion = "success";
  const afterFailedOwner = await requestReadyBranchUpdate(
    "owner/repo",
    13,
    gh,
    "main",
    undefined,
    async () => {},
    { fleetAuthors: ["VibeCoderST"] },
  );
  assertEquals(afterFailedOwner.ok, true);
  assertEquals(writes.length, 3);
  strictPolicy = false;
  const nonStrict = await request();
  assertEquals(nonStrict.ok, true);
  assertEquals(writes.length, 4);
  strictPolicy = true;
  queued = true;
  const mergeQueue = await request();
  assertEquals(mergeQueue.ok, false);
  if (!mergeQueue.ok) {
    assertEquals(
      mergeQueue.error.message,
      "merge-queue base is exempt from behind-only refresh",
    );
  }
  queued = false;
  comments.length = 0;
  views = 0;
  retarget = true;
  assertEquals(
    (await request("main")).ok,
    false,
  );
  retarget = false;
  wrongParent = true;
  assertEquals(
    (await request("main")).ok,
    false,
  );
  wrongParent = false;
  assertEquals(
    (await request("other-base")).ok,
    false,
  );
  conclusion = "failure";
  assertEquals(
    (await request()).ok,
    false,
  );
  conclusion = "success";
  decision = "REVIEW_REQUIRED";
  assertEquals(
    (await request()).ok,
    false,
  );
  assertEquals(writes.length, 4);

  decision = "APPROVED";
  mergeabilityReadings = ["UNKNOWN", "MERGEABLE"];
  retryWaits.length = 0;
  const unknownThenReady = await request("main");
  assertEquals(unknownThenReady.ok, true);
  assert(retryWaits.length > 0);
  assertEquals(writes.length, 5);

  wrongParentReads = 1;
  retryWaits.length = 0;
  const staleThenCurrent = await request("main");
  assertEquals(staleThenCurrent.ok, true);
  assert(retryWaits.length > 0);
  assertEquals(writes.length, 6);
});

Deno.test("ready updater rejects an invalid PR number before invoking gh", async () => {
  let called = false;
  const result = await requestReadyBranchUpdate("owner/repo", -1, () => {
    called = true;
    return Promise.resolve("");
  });
  assertEquals(result.ok, false);
  assertEquals(called, false);
});

Deno.test("ready updater redacts secrets from failed gh diagnostics", async () => {
  const secret = `ghp_${"a".repeat(36)}`;
  const result = await requestReadyBranchUpdate(
    "owner/repo",
    12,
    () => Promise.reject(new Error(`failed ${secret}`)),
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.message.includes(secret), false);
});

Deno.test("required branch checks combine classic protection and source app", () => {
  const classic = {
    contexts: ["legacy"],
    checks: [{ context: "app", app_id: 42 }],
  };
  assertEquals(
    requiredChecksPassed(rules, classic, [passed, {
      ...passed,
      name: "app",
      app: { id: 42 },
    }], [{ context: "legacy", state: "success" }]),
    true,
  );
  assertEquals(
    requiredChecksPassed(rules, classic, [passed, {
      ...passed,
      name: "app",
      app: { id: 43 },
    }], [{ context: "legacy", state: "success" }]),
    false,
  );
});

Deno.test("an app-pinned check cannot hide a failing same-name status", () => {
  const appRules = [{
    type: "required_status_checks",
    parameters: {
      required_status_checks: [{ context: "gate", integration_id: 1 }],
    },
  }];
  assertEquals(
    requiredChecksPassed(appRules, null, [passed], [{
      context: "gate",
      state: "failure",
    }]),
    false,
  );
  assertThrows(
    () =>
      requiredChecksPassed(appRules, null, [passed], [{
        context: "gate",
        state: "success",
      }]),
    Error,
    "cannot verify publisher",
  );
  assertThrows(
    () =>
      requiredChecksPassed(appRules, null, [], [{
        context: "gate",
        state: "success",
      }]),
    Error,
    "cannot verify publisher",
  );
});

Deno.test("malformed required-check rules never become an empty contract", () => {
  assertThrows(() =>
    requiredChecksPassed([{ type: "required_status_checks" }], null, [], [])
  );
  assertThrows(() => requiredChecksPassed(null, null, [], []));
});

Deno.test("required-check reader collects effective rules and current-head checks", async () => {
  const seen: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    seen.push(endpoint);
    if (endpoint.includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([rules]));
    }
    if (endpoint.includes("/branches/")) {
      return Promise.resolve(
        JSON.stringify({
          protection: {
            enabled: false,
            required_status_checks: { contexts: [], checks: [], strict: false },
          },
        }),
      );
    }
    if (endpoint.includes("/check-runs?")) {
      return Promise.resolve(JSON.stringify([{ check_runs: [passed] }]));
    }
    if (endpoint.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
    }
    throw new Error("unexpected endpoint");
  };
  const head = "a".repeat(40);
  assertEquals(
    await readRequiredChecksPassed("owner/repo", "main", head, gh),
    true,
  );
  assertEquals(seen.filter((endpoint) => endpoint.includes(head)).length, 2);
  await assertRejects(
    () =>
      readRequiredChecksPassed(
        "owner/repo",
        "main",
        head,
        () => Promise.reject(new Error("forbidden")),
      ),
    Error,
    "forbidden",
  );
});

Deno.test("required-check reader refuses a missing classic protection summary", async () => {
  const gh = (args: string[]): Promise<string> => {
    if ((args[1] ?? "").includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([rules]));
    }
    return Promise.resolve(JSON.stringify({ protected: true }));
  };
  await assertRejects(
    () => readRequiredChecksPassed("owner/repo", "main", "a".repeat(40), gh),
    Error,
    "branch protection summary",
  );
});

Deno.test("reader checks Actions event eligibility and test-merge status", async () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  let event: string | null = "pull_request";
  let mergeConclusion: string | null = null;
  let headChecks = true;
  const actions = {
    ...passed,
    app: { id: 15368, slug: "github-actions" },
    check_suite: { id: 99 },
  };
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([rules]));
    }
    if (endpoint.includes("/branches/")) {
      return Promise.resolve(
        JSON.stringify({
          protection: {
            enabled: false,
            required_status_checks: { contexts: [], checks: [], strict: false },
          },
        }),
      );
    }
    if (endpoint.includes("/check-runs?")) {
      return Promise.resolve(
        JSON.stringify([{
          check_runs: endpoint.includes(merge)
            ? (mergeConclusion === null
              ? []
              : [{ ...actions, conclusion: mergeConclusion }])
            : headChecks
            ? [actions]
            : [],
        }]),
      );
    }
    if (endpoint.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
    }
    if (endpoint.includes("/actions/runs?")) {
      return Promise.resolve(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [{ check_suite_id: 99, event }],
        }),
      );
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  assertEquals(
    await readRequiredChecksPassed("owner/repo", "main", head, gh, merge),
    true,
  );
  event = "workflow_dispatch";
  assertEquals(
    await readRequiredChecksPassed("owner/repo", "main", head, gh, merge),
    false,
  );
  event = null;
  await assertRejects(
    () => readRequiredChecksPassed("owner/repo", "main", head, gh, merge),
    Error,
    "invalid event metadata",
  );
  event = "pull_request";
  mergeConclusion = "failure";
  assertEquals(
    await readRequiredChecksPassed("owner/repo", "main", head, gh, merge),
    false,
  );
  mergeConclusion = "success";
  headChecks = false;
  assertEquals(
    await readRequiredChecksPassed("owner/repo", "main", head, gh, merge),
    true,
  );
});

import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

const authors = { fleetAuthors: ["VibeCoderST"] };
const noSleep = async () => {};

for (const status of ["pending", "success", "failure", "error"]) {
  Deno.test(`required commit status ${status} releases only terminal failures`, async () => {
    const f = strictRefreshFixture();
    f.state.statuses = [{ context: "gate", state: status }];
    assertEquals(
      await readRequiredChecksFailed("owner/repo", "main", f.head, f.gh),
      status === "failure" || status === "error",
    );
  });
}

for (const order of [[false, true], [true, false]]) {
  Deno.test(`strict policy combines every applicable rule: ${order}`, async () => {
    const f = strictRefreshFixture();
    f.state.decision = "REVIEW_REQUIRED";
    f.state.rules = order.map((strict) => ({
      ...rules[0],
      parameters: {
        ...rules[0]!.parameters,
        strict_required_status_checks_policy: strict,
      },
    }));
    const result = await requestReadyBranchUpdate(
      "owner/repo",
      10,
      f.gh,
      "main",
      f.head,
      noSleep,
      authors,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.message,
        "PR no longer ready for a branch update",
      );
    }
    assertEquals(f.calls.some((args) => args.includes("PUT")), false);
  });
}

for (
  const protection of [{ required_status_checks: null }, {
    required_status_checks: { contexts: ["gate"], checks: [] },
  }]
) {
  Deno.test(`strict policy supports classic contract ${JSON.stringify(protection)}`, async () => {
    const f = strictRefreshFixture();
    f.state.protection = protection;
    if (protection.required_status_checks !== null) f.state.rules = [];
    const result = await requestReadyBranchUpdate(
      "owner/repo",
      10,
      f.gh,
      "main",
      f.head,
      noSleep,
      authors,
    );
    if (!result.ok) throw result.error;
    assertEquals(f.calls.some((args) => args.includes("PUT")), true);
  });
}

Deno.test("enabled protection with no required checks uses ruleset without classic endpoint", async () => {
  const f = strictRefreshFixture();
  f.state.protection = {
    enabled: true,
    required_status_checks: {
      enforcement_level: "off",
      contexts: [],
      checks: [],
    },
  };
  const gh = (args: string[]) => {
    if (args[1]?.endsWith("/protection/required_status_checks")) {
      throw new Error("unexpected classic endpoint");
    }
    return f.gh(args);
  };
  const result = await requestReadyBranchUpdate(
    "owner/repo",
    10,
    gh,
    "main",
    f.head,
    noSleep,
    authors,
  );
  if (!result.ok) throw result.error;
  assertEquals(f.calls.some((args) => args.includes("PUT")), true);
});

for (
  const [message, succeeds] of [
    ["HTTP 404: Branch not protected", true],
    ["HTTP 404: Required status checks not enabled", true],
    ["HTTP 403: Resource not accessible by integration", false],
    ["HTTP 404: Not Found", false],
  ] as const
) {
  Deno.test(`classic strictness endpoint: ${message}`, async () => {
    const f = strictRefreshFixture();
    f.state.protection = {
      enabled: true,
      required_status_checks: { contexts: [], checks: [] },
    };
    const gh = (args: string[]) => {
      if (args[1]?.endsWith("/protection/required_status_checks")) {
        throw new Error(message);
      }
      return f.gh(args);
    };
    const result = await requestReadyBranchUpdate(
      "owner/repo",
      10,
      gh,
      "main",
      f.head,
      noSleep,
      authors,
    );
    assertEquals(result.ok, succeeds);
    assertEquals(f.calls.some((args) => args.includes("PUT")), succeeds);
  });
}

for (
  const [field, view, reason] of [
    ["reviewDecision", 1, "PR no longer ready for a branch update"],
    ["baseRefName", 1, "PR base or head changed before branch update"],
    ["headRefOid", 1, "PR base or head changed before branch update"],
    ["baseRefName", 2, "PR changed while its required checks were read"],
    ["headRefOid", 2, "PR changed while its required checks were read"],
    ["reviewDecision", 2, "PR changed while its required checks were read"],
    ["baseRefName", 3, "PR base or head changed before branch update"],
    ["headRefOid", 3, "PR base or head changed before branch update"],
    ["reviewDecision", 3, "PR base or head changed before branch update"],
  ] as const
) {
  Deno.test(`ready updater isolates ${field} guard on candidate read ${view}`, async () => {
    const f = strictRefreshFixture();
    f.state.changeAtView = view;
    f.state.changeField = field;
    const result = await requestReadyBranchUpdate(
      "owner/repo",
      10,
      f.gh,
      "main",
      f.head,
      noSleep,
      authors,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.message.includes(reason),
        true,
        result.error.message,
      );
    }
    assertEquals(f.calls.some((args) => args.includes("PUT")), false);
    assertEquals(
      f.comments.some((row) => row.body.includes("BASE_REFRESH_OWNER")),
      false,
    );
  });
}

for (const mergeRead of [2, 3]) {
  Deno.test(`ready updater refuses moving test merge at read ${mergeRead}`, async () => {
    const f = strictRefreshFixture();
    f.state.changeAtMerge = mergeRead;
    const result = await requestReadyBranchUpdate(
      "owner/repo",
      10,
      f.gh,
      "main",
      f.head,
      noSleep,
      authors,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.message.includes(
          mergeRead === 2
            ? "PR test merge changed while required checks were read"
            : "PR test merge or required checks changed before branch update",
        ),
        true,
        result.error.message,
      );
    }
    assertEquals(f.calls.some((args) => args.includes("PUT")), false);
    assertEquals(
      f.comments.some((row) => row.body.includes("BASE_REFRESH_OWNER")),
      false,
    );
  });
}
