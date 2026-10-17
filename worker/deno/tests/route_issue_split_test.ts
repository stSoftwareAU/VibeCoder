/**
 * Tests for `route-issue --part` (Issue #3748, part of #3691). The fake `gh`
 * models the real CLI over an in-memory store, so the tests assert the
 * issues that end up on GitHub, their sibling links and labels, and the exit
 * status of an incomplete set. No network.
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  routeIssueCommand,
  type RouteIssueDeps,
  type RouteIssueSplitData,
} from "../commands/route_issue.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { withSiblingBlock } from "../lib/issue_routing_split.ts";
import type { WorkerConfig } from "../types.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import {
  type FakeGh,
  type FakeStore,
  fakeStore,
  isWriteCall,
  routingFakeGh,
} from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const AUTOTRADER = "stSoftwareAU/GRQ-AutoTrader";
const GRQ = "stSoftwareAU/GRQ";
const BODY = "Lane worktree heal and the PWA header gap both need a change.";
const PARTS = [
  `${VIBE}=Heal a dangling HEAD before creating lane worktrees`,
  `${AUTOTRADER}=Shrink the PWA header gap after the worktree heal`,
];

function config(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: [VIBE, GRQ, AUTOTRADER],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

function newStore(): FakeStore {
  return fakeStore([], {
    [VIBE]: "WRITE",
    [GRQ]: "WRITE",
    [AUTOTRADER]: "WRITE",
  });
}

async function split(args: Record<string, unknown>, gh: FakeGh) {
  const deps: RouteIssueDeps = {
    ghCommandFn: gh.ghCommandFn,
    readTextFile: async () => BODY,
    now: () => new Date("2026-10-15T00:00:00Z"),
    logger: makeRecordingLogger().logger,
  };
  const result = await routeIssueCommand.execute(
    { repo: VIBE, "body-file": "body.md", ...args, __testDeps: deps },
    config(),
  );
  return { result, data: result.data as RouteIssueSplitData | undefined };
}

Deno.test("route-issue --part - two parts produce two issues, each linking to the other", async () => {
  const gh = routingFakeGh(newStore());
  const { result, data } = await split({ part: PARTS }, gh);

  assertEquals(result.success, true);
  assertEquals(data?.complete, true);
  assertEquals(data?.linked, true);
  const vibe = gh.store.issues.find((i) => i.repo === VIBE);
  const at = gh.store.issues.find((i) => i.repo === AUTOTRADER);
  assert(vibe && at, "one issue in each repository");
  assertEquals(gh.store.issues.length, 2);
  assertStringIncludes(vibe.body, `- ${AUTOTRADER}#${at.number} — `);
  assertStringIncludes(at.body, `- ${VIBE}#${vibe.number} — `);
  assert(!vibe.body.includes(`${VIBE}#${vibe.number}`), "no self link");
  assertStringIncludes(at.body, "kind `cross-repo`");
  assertStringIncludes(result.message, `${VIBE}#1 (created)`);
});

Deno.test("route-issue --part - labels apply only to the part in --repo; none are copied between parts", async () => {
  const gh = routingFakeGh(newStore());
  await split({ part: PARTS, label: "enhancement" }, gh);
  const vibe = gh.store.issues.find((i) => i.repo === VIBE)!;
  const at = gh.store.issues.find((i) => i.repo === AUTOTRADER)!;
  assertEquals(vibe.labels, ["enhancement"]);
  assertEquals(at.labels, []);
  assertStringIncludes(at.body, "Labels not migrated: enhancement");
});

Deno.test("route-issue --part - a failed part is reported, exits non-zero, and a re-run completes the set without duplicating", async () => {
  const store = newStore();
  let failAt = true;
  const gh = routingFakeGh(store, {
    failWhen: (args) =>
      failAt && args[1] === "create" && args.includes(AUTOTRADER)
        ? new Error("HTTP 502: Bad Gateway")
        : undefined,
  });

  const first = await split({ part: PARTS }, gh);
  assertEquals(first.result.success, false);
  assertEquals(first.data?.complete, false);
  assertEquals(first.data?.missing, [AUTOTRADER]);
  assertStringIncludes(first.result.message, `missing ${AUTOTRADER}`);
  assertStringIncludes(first.result.message, `${VIBE}#1 (created)`);
  assertEquals(store.issues.length, 1);
  assertEquals(
    gh.calls.filter((c) => c[1] === "edit"),
    [],
    "no sibling links on an incomplete set",
  );

  failAt = false;
  const second = await split({ part: PARTS }, gh);
  assertEquals(second.result.success, true);
  assertEquals(
    second.data?.parts.map((p) => p.action),
    ["reused", "created"],
  );
  assertEquals(store.issues.length, 2);
  assertEquals(store.issues.filter((i) => i.repo === VIBE).length, 1);
  assertStringIncludes(store.issues[0]!.body, `${AUTOTRADER}#1`);
});

Deno.test("route-issue --part - a re-run of a complete set changes nothing", async () => {
  const gh = routingFakeGh(newStore());
  await split({ part: PARTS }, gh);
  const before = gh.calls.filter(isWriteCall).length;
  const again = await split({ part: PARTS }, gh);
  assertEquals(again.result.success, true);
  assertEquals(gh.calls.filter(isWriteCall).length, before);
  assertEquals(gh.store.issues.length, 2);
});

Deno.test("route-issue --part - --dry-run prints every planned part and makes no write call", async () => {
  const gh = routingFakeGh(newStore());
  const { result, data } = await split({
    part: PARTS,
    "dry-run": true,
    json: true,
  }, gh);
  assertEquals(result.success, true);
  assertEquals(
    data?.parts.map((p) => [p.repo, p.action]),
    [[VIBE, "would-create"], [AUTOTRADER, "would-create"]],
  );
  assertEquals(JSON.parse(result.message).mode, "split");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --part - fewer than two parts, a repeated repository or an unconfigured one is refused", async () => {
  const gh = routingFakeGh(newStore());
  const one = await split({ part: PARTS[0] }, gh);
  assertEquals(one.result.success, false);
  assertStringIncludes(one.result.message, "at least two --part");

  const twice = await split({ part: [PARTS[0], `${VIBE}=Other`] }, gh);
  assertEquals(twice.result.success, false);
  assertStringIncludes(twice.result.message, "twice");

  const elsewhere = await split({
    part: [PARTS[0], "someone/else=Their part"],
  }, gh);
  assertEquals(elsewhere.result.success, false);
  assertStringIncludes(
    elsewhere.result.message,
    "not stSoftwareAU/VibeCoder or a configured",
  );

  const malformed = await split({ part: ["no-equals", PARTS[1]] }, gh);
  assertEquals(malformed.result.success, false);
  assertStringIncludes(malformed.result.message, "expected owner/name=Title");
  assertEquals(gh.calls, []);
});

Deno.test("withSiblingBlock - replaces an earlier block instead of appending a second", () => {
  const once = withSiblingBlock("Body", ["- a#1 — A"]);
  const twice = withSiblingBlock(once, ["- b#2 — B"]);
  assertEquals(twice.split("<!-- route-issue-siblings -->").length, 2);
  assertStringIncludes(twice, "- b#2 — B");
  assert(!twice.includes("- a#1"));
  assert(twice.startsWith("Body\n\n"));
});

const AT_TITLE = "Shrink the PWA header gap after the worktree heal";
const CLOSED_5_DAYS_AGO = "2026-10-10T00:00:00Z";
const MARKER = (owner: string, kind: string) =>
  `<!-- issue-routing owner=${owner} subject=${VIBE} kind=${kind} -->`;

for (
  const [name, extra] of [
    ["closed within the window, no marker", { closedAt: CLOSED_5_DAYS_AGO }],
    ["open, no marker", {}],
    ["closed but carrying this tool's marker", {
      closedAt: CLOSED_5_DAYS_AGO,
      body: `Old part\n${MARKER(AUTOTRADER, "cross-repo")}`,
    }],
    ["open with a marker for another owner", {
      body: `Old part\n${MARKER(VIBE, "cross-repo")}`,
    }],
    ["open with a marker of another kind", {
      body: `Old part\n${MARKER(AUTOTRADER, "product")}`,
    }],
  ] as const
) {
  Deno.test(`route-issue --part - an unrelated same-titled issue (${name}) is neither reused nor edited`, async () => {
    const store = newStore();
    store.issues.push({
      repo: AUTOTRADER,
      number: 50,
      title: AT_TITLE,
      body: "Unrelated work.",
      closedAt: null,
      isPullRequest: false,
      labels: [],
      comments: [],
      ...extra,
    });
    const before = JSON.stringify(store.issues[0]);
    const gh = routingFakeGh(store);
    const { result, data } = await split({ part: PARTS }, gh);

    assertEquals(result.success, false);
    assertEquals(data?.complete, false);
    assertEquals(data?.missing, [AUTOTRADER]);
    const part = data?.parts.find((p) => p.repo === AUTOTRADER);
    assertEquals(part?.action, "failed");
    assertStringIncludes(part?.error ?? "", `${AUTOTRADER}#50`);
    assertStringIncludes(part?.error ?? "", "not reused");
    assertEquals(JSON.stringify(store.issues[0]), before, "#50 is untouched");
    assertEquals(gh.calls.filter((c) => c[1] === "edit"), []);
    assertEquals(
      store.issues.filter((i) => i.repo === AUTOTRADER).length,
      1,
      "no new issue was filed beside it",
    );
  });
}

Deno.test("route-issue --part - a dry run flags an unrelated same-titled issue instead of planning to reuse it", async () => {
  const store = newStore();
  store.issues.push({
    repo: AUTOTRADER,
    number: 50,
    title: AT_TITLE,
    body: "Unrelated work.",
    closedAt: CLOSED_5_DAYS_AGO,
    isPullRequest: false,
    labels: [],
    comments: [],
  });
  const gh = routingFakeGh(store);
  const { result, data } = await split({ part: PARTS, "dry-run": true }, gh);
  assertEquals(result.success, false);
  assertEquals(
    data?.parts.map((p) => [p.repo, p.action]),
    [[VIBE, "would-create"], [AUTOTRADER, "failed"]],
  );
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --part - an open issue with this tool's marker for the part is reused (positive control)", async () => {
  const store = newStore();
  store.issues.push({
    repo: AUTOTRADER,
    number: 50,
    title: AT_TITLE,
    body: `Earlier part.\n${MARKER(AUTOTRADER, "cross-repo")}`,
    closedAt: null,
    isPullRequest: false,
    labels: [],
    comments: [],
  });
  const gh = routingFakeGh(store);
  const { result, data } = await split({ part: PARTS }, gh);
  assertEquals(result.success, true);
  assertEquals(data?.parts.map((p) => p.action), ["created", "reused"]);
  assertStringIncludes(store.issues[0]!.body, "route-issue-siblings");
});
