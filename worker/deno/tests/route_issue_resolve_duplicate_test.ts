/**
 * Tests for `route-issue --resolve-duplicate` (Issue #3747, part of #3691).
 * The fake `gh` models the real CLI over an in-memory store, so the tests
 * assert the end state on GitHub — which issues are open, closed and linked —
 * and that X is never closed before both links exist. No network.
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  routeIssueCommand,
  type RouteIssueDeps,
  type RouteIssueResolveData,
} from "../commands/route_issue.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  correctLinkMarker,
  wrongLinkMarker,
} from "../lib/issue_routing_resolve.ts";
import { formatRepoFastFailureTallyMarker } from "../lib/repo_fast_failure_issue.ts";
import type { WorkerConfig } from "../types.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import {
  type FakeGh,
  type FakeGhHooks,
  type FakeIssue,
  type FakeStore,
  fakeStore,
  FLEET_LOGIN,
  isWriteCall,
  routingFakeGh,
} from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const AUTOTRADER = "stSoftwareAU/GRQ-AutoTrader";
const GRQ = "stSoftwareAU/GRQ";

function fixture(name: string): { title: string; body: string } {
  return JSON.parse(
    Deno.readTextFileSync(
      new URL(`./fixtures/issue_routing/${name}.json`, import.meta.url),
    ),
  );
}

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

/** VibeCoder#3607 (the wrong-repo copy) and GRQ-AutoTrader#3242 (the owner's). */
function pairStore(): FakeStore {
  const vibe = fixture("vibecoder_3607");
  const at = fixture("grq_autotrader_3242");
  return fakeStore([
    { repo: VIBE, number: 3607, ...vibe },
    { repo: AUTOTRADER, number: 3242, ...at },
  ], { [GRQ]: "WRITE" });
}

function issue(store: FakeStore, repo: string, number: number): FakeIssue {
  const found = store.issues.find((i) =>
    i.repo === repo && i.number === number
  );
  assert(found, `${repo}#${number} exists`);
  return found;
}

async function resolve(
  args: Record<string, unknown>,
  gh: FakeGh,
  logger = makeRecordingLogger().logger,
) {
  const deps: RouteIssueDeps = {
    ghCommandFn: gh.ghCommandFn,
    now: () => new Date("2026-10-15T00:00:00Z"),
    logger,
    authors: { fleetAuthors: [FLEET_LOGIN] },
  };
  const result = await routeIssueCommand.execute(
    { ...args, __testDeps: deps },
    config(),
  );
  return { result, data: result.data as RouteIssueResolveData | undefined };
}

Deno.test("route-issue --resolve-duplicate - #3607 vs GRQ-AutoTrader#3242 ends cross-linked with #3607 closed", async () => {
  const gh = routingFakeGh(pairStore());
  const { result, data } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, gh);

  assertEquals(result.success, true);
  assertEquals(data?.outcome, "resolved");
  assertEquals(data?.owner_repository, AUTOTRADER);
  const wrong = issue(gh.store, VIBE, 3607);
  const correct = issue(gh.store, AUTOTRADER, 3242);
  assert(wrong.closedAt !== null, "#3607 is closed");
  assertEquals(wrong.stateReason, "not planned");
  assertEquals(correct.closedAt, null);
  assert(
    correct.comments.some((c) =>
      c.includes(correctLinkMarker({ repo: VIBE, number: 3607 }))
    ),
    "#3242 links back to #3607",
  );
  assert(
    wrong.comments.some((c) =>
      c.includes(wrongLinkMarker({ repo: AUTOTRADER, number: 3242 }))
    ),
    "#3607 links to #3242",
  );
  assertStringIncludes(wrong.comments.join("\n"), `${AUTOTRADER}#3242`);
  // No labels or assignees moved, nothing deleted.
  assertEquals(gh.store.issues.length, 2);
  assertEquals(correct.labels, []);
});

Deno.test("route-issue --resolve-duplicate - X is closed only after both links exist", async () => {
  const gh = routingFakeGh(pairStore());
  await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, gh);
  const writes = gh.calls.filter(isWriteCall).map((c) => `${c[1]} ${c[2]}`);
  assertEquals(writes, ["comment 3242", "comment 3607", "close 3607"]);
});

Deno.test("route-issue --resolve-duplicate - with no --correct, Y is filed in the owner repository first", async () => {
  const store = pairStore();
  store.issues = store.issues.filter((i) => i.repo === VIBE);
  const gh = routingFakeGh(store);
  const { result, data } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
  }, gh);

  assertEquals(result.success, true);
  const created = store.issues.find((i) => i.repo === AUTOTRADER);
  assert(created, "the owning issue was filed");
  assertEquals(data?.correct_issue, `${AUTOTRADER}#${created.number}`);
  assertStringIncludes(created.body, `wrong repository as ${VIBE}#3607`);
  assert(issue(store, VIBE, 3607).closedAt !== null);
});

Deno.test("route-issue --resolve-duplicate - a re-run after a part-way failure skips the links already written", async () => {
  const store = pairStore();
  let failClose = true;
  const gh = routingFakeGh(store, {
    failWhen: (args) =>
      failClose && args[1] === "close"
        ? new Error("HTTP 502: Bad Gateway")
        : undefined,
  });
  const args = {
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  };
  const first = await resolve(args, gh);
  assertEquals(first.result.success, false);
  assertStringIncludes(first.result.message, 'step "close-wrong"');
  assertEquals(issue(store, VIBE, 3607).closedAt, null);

  failClose = false;
  const second = await resolve(args, gh);
  assertEquals(second.result.success, true);
  assertEquals(issue(store, VIBE, 3607).comments.length, 2); // link + close
  assertEquals(issue(store, AUTOTRADER, 3242).comments.length, 1);
  assertEquals(
    second.data?.steps.filter((s) => s.status === "skipped").map((s) => s.step),
    ["link-correct", "link-wrong"],
  );
});

Deno.test("route-issue --resolve-duplicate - an already-closed X changes nothing and says so", async () => {
  const store = pairStore();
  issue(store, VIBE, 3607).closedAt = "2026-10-14T00:00:00Z";
  const gh = routingFakeGh(store);
  const { result, data } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, gh);
  assertEquals(result.success, false);
  assertEquals(data?.outcome, "refused");
  assertStringIncludes(result.message, "already closed");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - an ambiguous owner closes nothing and prints the basis", async () => {
  const store = fakeStore([
    { repo: VIBE, number: 7, title: "Something is off", body: "Vague." },
  ], { [AUTOTRADER]: "WRITE" });
  const gh = routingFakeGh(store);
  const { result } = await resolve({ "resolve-duplicate": `${VIBE}#7` }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "ambiguous owner");
  assertStringIncludes(result.message, "no worker or product signal");
  assertEquals(issue(store, VIBE, 7).closedAt, null);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - a #2592 diagnostic is refused and stays open", async () => {
  const diag = fixture("grq_autotrader_3184");
  const store = fakeStore([
    { repo: AUTOTRADER, number: 3184, ...diag },
  ], { [VIBE]: "WRITE" });
  const gh = routingFakeGh(store);
  const { result } = await resolve({
    "resolve-duplicate": `${AUTOTRADER}#3184`,
    correct: `${VIBE}#3630`,
  }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "repo-scoped diagnostic (#2592)");
  assertEquals(issue(store, AUTOTRADER, 3184).closedAt, null);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - a diagnostic marker for another repository is still refused", async () => {
  const store = fakeStore([{
    repo: VIBE,
    number: 9,
    title: "GRQ-AutoTrader fast failures",
    body: formatRepoFastFailureTallyMarker(AUTOTRADER),
  }], { [AUTOTRADER]: "WRITE" });
  const gh = routingFakeGh(store);
  const { result } = await resolve({ "resolve-duplicate": `${VIBE}#9` }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "#2592");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - a permission failure on Y leaves X open", async () => {
  const store = pairStore();
  store.viewerPermission[AUTOTRADER] = "READ";
  const gh = routingFakeGh(store);
  const { result } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, 'step "permission"');
  assertStringIncludes(result.message, AUTOTRADER);
  assertEquals(issue(store, VIBE, 3607).closedAt, null);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - a failed comment on Y exits non-zero and leaves X open", async () => {
  const store = pairStore();
  const gh = routingFakeGh(store, {
    failWhen: (args) =>
      args[1] === "comment" && args[2] === "3242"
        ? new Error("HTTP 500")
        : undefined,
  });
  const { result } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, 'step "link-correct"');
  assertEquals(issue(store, VIBE, 3607).closedAt, null);
  assertEquals(issue(store, VIBE, 3607).comments, []);
});

Deno.test("route-issue --resolve-duplicate - a closed or wrong-repository Y is refused", async () => {
  const closed = pairStore();
  issue(closed, AUTOTRADER, 3242).closedAt = "2026-10-14T00:00:00Z";
  const a = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
  }, routingFakeGh(closed));
  assertEquals(a.result.success, false);
  assertStringIncludes(a.result.message, "is not open");
  assertEquals(issue(closed, VIBE, 3607).closedAt, null);

  const mismatch = pairStore();
  const b = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${GRQ}#1`,
  }, routingFakeGh(mismatch));
  assertEquals(b.result.success, false);
  assertStringIncludes(
    b.result.message,
    `routes ${VIBE}#3607 to ${AUTOTRADER}`,
  );
});

Deno.test("route-issue --resolve-duplicate - an issue the classifier keeps in its own repo is refused", async () => {
  const store = pairStore();
  const gh = routingFakeGh(store);
  const { result } = await resolve({
    "resolve-duplicate": `${AUTOTRADER}#3242`,
    correct: `${VIBE}#3607`,
  }, gh);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a wrong-repository issue");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("route-issue --resolve-duplicate - --dry-run prints the planned steps and makes no write call", async () => {
  const store = pairStore();
  const gh = routingFakeGh(store);
  const { result, data } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    correct: `${AUTOTRADER}#3242`,
    "dry-run": true,
    json: true,
  }, gh);
  assertEquals(result.success, true);
  assertEquals(data?.outcome, "would-resolve");
  assertEquals(
    data?.steps.filter((s) => s.status === "planned").map((s) => s.step),
    ["link-correct", "link-wrong", "close-wrong"],
  );
  assertEquals(JSON.parse(result.message).outcome, "would-resolve");
  assertEquals(gh.calls.filter(isWriteCall), []);
  assertEquals(issue(store, VIBE, 3607).closedAt, null);
});

Deno.test("route-issue --resolve-duplicate - a malformed reference or a create-mode option is refused", async () => {
  const gh = routingFakeGh(pairStore());
  const bad = await resolve({ "resolve-duplicate": "VibeCoder#x" }, gh);
  assertEquals(bad.result.success, false);
  assertStringIncludes(bad.result.message, "must be owner/name#N");
  const mixed = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
    title: "t",
  }, gh);
  assertEquals(mixed.result.success, false);
  assertStringIncludes(mixed.result.message, "--title cannot be combined");
  assertEquals(gh.calls, []);
});

/** The owned-issue marker this tool writes for the owner repository (AUTOTRADER). */
const OWNED_MARKER =
  `<!-- issue-routing owner=${AUTOTRADER} subject=${VIBE} kind=implementation -->`;

/** X (open, VibeCoder#3607) plus a same-titled, owned issue in the owner repository. */
function sameTitledStore(closedAt: string | null): FakeStore {
  const store = pairStore();
  const at = issue(store, AUTOTRADER, 3242);
  at.number = 50;
  at.title = issue(store, VIBE, 3607).title;
  at.body = `${OWNED_MARKER}\n\n${at.body}`;
  at.closedAt = closedAt;
  return store;
}

for (const dryRun of [false, true]) {
  Deno.test(`route-issue --resolve-duplicate - with no --correct, a same-titled owner issue closed within the window is refused and X stays open (dry-run ${dryRun})`, async () => {
    const store = sameTitledStore("2026-10-10T00:00:00Z");
    const gh = routingFakeGh(store);
    const { result, data } = await resolve({
      "resolve-duplicate": `${VIBE}#3607`,
      ...(dryRun ? { "dry-run": true } : {}),
    }, gh);

    assertEquals(result.success, false);
    assertEquals(data?.outcome, "refused");
    assertStringIncludes(result.message, `${AUTOTRADER}#50`);
    assertStringIncludes(result.message, "not open");
    assertEquals(issue(store, VIBE, 3607).closedAt, null);
    assertEquals(issue(store, AUTOTRADER, 50).comments, []);
    assertEquals(gh.calls.filter(isWriteCall), []);
    assertEquals(store.issues.length, 2, "no fresh Y was filed");
  });
}

const NOT_OWNED: [string, (owner: FakeIssue) => void][] = [
  ["by another author", (owner) => {
    owner.author = "someone-else";
  }],
  ["with no owned marker", (owner) => {
    owner.body = owner.body.replace(OWNED_MARKER, "");
  }],
];

for (const [label, shape] of NOT_OWNED) {
  Deno.test(`route-issue --resolve-duplicate - with no --correct, an open same-titled owner issue ${label} is refused, not reused, and no fresh Y is filed`, async () => {
    const store = sameTitledStore(null);
    shape(issue(store, AUTOTRADER, 50));
    const gh = routingFakeGh(store);
    const { result, data } = await resolve({
      "resolve-duplicate": `${VIBE}#3607`,
    }, gh);

    assertEquals(result.success, false);
    assertEquals(data?.outcome, "refused");
    assertStringIncludes(
      result.message,
      `${AUTOTRADER}#50 has the same title in ${AUTOTRADER} but is not open, or is not an issue this tool filed`,
    );
    assertEquals(issue(store, VIBE, 3607).closedAt, null);
    assertEquals(issue(store, AUTOTRADER, 50).comments, []);
    assertEquals(gh.calls.filter(isWriteCall), []);
    assertEquals(store.issues.length, 2, "no fresh Y was filed");
  });
}

Deno.test("route-issue --resolve-duplicate - with no --correct, an open owned same-titled owner issue is reused (positive control)", async () => {
  const store = sameTitledStore(null);
  const gh = routingFakeGh(store);
  const { result, data } = await resolve({
    "resolve-duplicate": `${VIBE}#3607`,
  }, gh);
  assertEquals(result.success, true);
  assertEquals(data?.outcome, "resolved");
  assertEquals(data?.correct_issue, `${AUTOTRADER}#50`);
  assert(issue(store, VIBE, 3607).closedAt !== null);
  assertEquals(issue(store, AUTOTRADER, 50).closedAt, null);
  assertEquals(issue(store, AUTOTRADER, 50).comments.length, 1);
});

/**
 * Hooks gh so that the owner issue changes between the lookup and the verify:
 * `mutate` runs on the first view of AUTOTRADER#50, which is the verify call.
 */
function mutateOnVerify(
  store: FakeStore,
  mutate: (owner: FakeIssue) => void,
): FakeGhHooks {
  let done = false;
  return {
    failWhen: (args) => {
      if (
        !done && args[0] === "issue" && args[1] === "view" &&
        args[2] === "50" && args.includes(AUTOTRADER)
      ) {
        done = true;
        mutate(issue(store, AUTOTRADER, 50));
      }
      return undefined;
    },
  };
}

const VERIFY_PROBES: [string, (owner: FakeIssue) => void, string][] = [
  [
    "the owned marker is gone",
    (owner) => {
      owner.body = owner.body.replace(OWNED_MARKER, "");
    },
    "body does not contain the marker",
  ],
  [
    "the author is not a fleet account",
    (owner) => {
      owner.author = "someone-else";
    },
    "author is not a fleet account",
  ],
  [
    "the owner issue is closed",
    (owner) => {
      owner.closedAt = "2026-10-14T00:00:00Z";
    },
    "state is CLOSED, not OPEN",
  ],
];

for (const [label, mutate, reason] of VERIFY_PROBES) {
  Deno.test(`route-issue --resolve-duplicate - refuses when the owned-issue check fails at verify time (${label}), with the reason in the error`, async () => {
    const store = sameTitledStore(null);
    const gh = routingFakeGh(store, mutateOnVerify(store, mutate));
    const { logger, records } = makeRecordingLogger();
    const { result, data } = await resolve(
      {
        "resolve-duplicate": `${VIBE}#3607`,
      },
      gh,
      logger,
    );

    assertEquals(result.success, false);
    assertEquals(data?.outcome, "refused");
    assertStringIncludes(
      result.message,
      `${AUTOTRADER}#50 is not an owned, open issue in ${AUTOTRADER} (${reason})`,
    );
    assertEquals(issue(store, VIBE, 3607).closedAt, null);
    assertEquals(gh.calls.filter(isWriteCall), []);
    // A foreign author is logged by the verify's author check.
    const loggedForeign = records.some(([m]) =>
      m.includes("authored outside the fleet")
    );
    assertEquals(loggedForeign, reason === "author is not a fleet account");
  });
}
