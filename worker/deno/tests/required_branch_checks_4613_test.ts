import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  readRequiredChecksPassed,
  requestReadyBranchUpdate,
  requiredChecksPassed,
} from "../lib/required_branch_checks_4613.ts";

const rules = [{
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context: "gate" }] },
}];
const passed = {
  name: "gate",
  status: "completed",
  conclusion: "success",
  app: { id: 1 },
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

Deno.test("ready updater checks the live head and sends its SHA", async () => {
  const head = "a".repeat(40);
  let conclusion = "success";
  let decision = "APPROVED";
  let retarget = false;
  let views = 0;
  const writes: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (args[0] === "pr") {
      views++;
      return Promise.resolve(
        JSON.stringify({
          state: "OPEN",
          baseRefName: retarget && views === 2 ? "other-base" : "main",
          headRefOid: head,
          autoMergeRequest: {},
          reviewDecision: decision,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        }),
      );
    }
    if (endpoint === "--method") {
      writes.push(args);
      return Promise.resolve("");
    }
    if (endpoint.includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([rules]));
    }
    if (endpoint.includes("/branches/")) {
      return Promise.resolve(
        JSON.stringify({
          protection: {
            enabled: false,
            required_status_checks: { contexts: [], checks: [] },
          },
        }),
      );
    }
    if (endpoint.includes("/check-runs?")) {
      return Promise.resolve(
        JSON.stringify([{ check_runs: [{ ...passed, conclusion }] }]),
      );
    }
    if (endpoint.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
    }
    throw new Error("unexpected endpoint");
  };
  assertEquals((await requestReadyBranchUpdate("owner/repo", 12, gh)).ok, true);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.slice(-2), ["-f", `expected_head_sha=${head}`]);
  views = 0;
  retarget = true;
  assertEquals(
    (await requestReadyBranchUpdate("owner/repo", 12, gh, "main")).ok,
    false,
  );
  retarget = false;
  assertEquals(
    (await requestReadyBranchUpdate("owner/repo", 12, gh, "other-base")).ok,
    false,
  );
  conclusion = "failure";
  assertEquals(
    (await requestReadyBranchUpdate("owner/repo", 12, gh)).ok,
    false,
  );
  decision = "REVIEW_REQUIRED";
  assertEquals(
    (await requestReadyBranchUpdate("owner/repo", 12, gh)).ok,
    false,
  );
  assertEquals(writes.length, 1);
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
            required_status_checks: { contexts: [], checks: [] },
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
