/**
 * Tests for routed issue filing (Issue #3743, part of #3691). The fake `gh`
 * models the real CLI over an in-memory store, so the tests assert what ends
 * up on GitHub (which issues exist, which are closed, their bodies and
 * labels) and whether a write was attempted. No network, no real clock.
 * Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { IssueRoutingContext } from "../lib/issue_routing_classifier.ts";
import { IssueRoutingPermissionError } from "../lib/issue_routing_github.ts";
import {
  fileRoutedIssue,
  type FileRoutedIssueOptions,
  formatRoutingAudit,
  ISSUE_ROUTING_MARKER_PREFIX,
  RoutedIssueFilingError,
} from "../lib/issue_routing_filing.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import {
  addIssue,
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
const CTX: IssueRoutingContext = {
  vibeCoderRepo: VIBE,
  productRepos: [GRQ, AUTOTRADER],
};
const NOW = () => new Date("2026-10-15T00:00:00Z");

/** The body an issue this tool filed for WORKER_DRAFT carries: the owned marker. */
const OWNED_BODY =
  `${ISSUE_ROUTING_MARKER_PREFIX}owner=${VIBE} subject=${VIBE} kind=implementation -->`;

/** The owned-artefact lookup, `gh issue list`: after a dedup hit, and the recheck. */
const isLookup = (args: string[]) => args[0] === "issue" && args[1] === "list";

/** A worker change: routes to VibeCoder whatever the target. */
const WORKER_DRAFT = {
  title: "Lane worktree heal for a dangling HEAD",
  body: "`worker/deno/lib/lane_worktree.ts` wedges when HEAD dangles.",
  labels: ["enhancement"],
};

/** A product change drafted in VibeCoder: routes to GRQ-AutoTrader. */
const PRODUCT_DRAFT = {
  title: "PWA iPhone home-screen app: too big a gap above the header",
  body: "The GRQ-AutoTrader PWA layout leaves a blank space above the header.",
  labels: ["bug", "enhancement"],
};

function emptyStore(): FakeStore {
  return fakeStore([], {
    [VIBE]: "WRITE",
    [AUTOTRADER]: "WRITE",
    [GRQ]: "WRITE",
  });
}

function opts(
  ghCommandFn: FileRoutedIssueOptions["ghCommandFn"],
  extra: Partial<FileRoutedIssueOptions> = {},
): FileRoutedIssueOptions {
  return {
    targetRepo: VIBE,
    context: CTX,
    ghCommandFn,
    now: NOW,
    logger: makeRecordingLogger().logger,
    // The fleet is named explicitly, so the tests never read configured identity.
    authors: { fleetAuthors: [FLEET_LOGIN] },
    ...extra,
  };
}

/**
 * File WORKER_DRAFT over one same-titled issue that starts owned, open and
 * fleet-authored, after `shape` has changed it.
 */
async function fileOverExisting(
  shape?: (issue: FakeIssue) => void,
  extra: Partial<FileRoutedIssueOptions> = {},
) {
  const store = emptyStore();
  const existing = addIssue(store, VIBE, WORKER_DRAFT.title, OWNED_BODY);
  shape?.(existing);
  const gh = routingFakeGh(store);
  const result = await fileRoutedIssue(
    WORKER_DRAFT,
    opts(gh.ghCommandFn, extra),
  );
  return { result, gh };
}

Deno.test("fileRoutedIssue - a worker draft is created in VibeCoder with the audit line, marker and labels", async () => {
  const gh = routingFakeGh(emptyStore());
  const result = await fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn));

  assertEquals(result.action, "created");
  assertEquals(result.repository, VIBE);
  assertEquals(result.decision.owner_repository, VIBE);
  assertEquals(result.decision.issue_kind, "implementation");
  assertEquals(result.labels_not_migrated, []);
  const [issue] = gh.store.issues;
  assertEquals(issue?.number, result.number);
  assertEquals(issue?.repo, VIBE);
  assertEquals(issue?.labels, ["enhancement"]);
  assertStringIncludes(issue!.body, WORKER_DRAFT.body);
  assertStringIncludes(issue!.body, formatRoutingAudit(result.decision));
  assertStringIncludes(
    issue!.body,
    `${ISSUE_ROUTING_MARKER_PREFIX}owner=${VIBE} subject=${VIBE} kind=implementation -->`,
  );
});

Deno.test("fileRoutedIssue - #3607 drafted in VibeCoder is filed in GRQ-AutoTrader with no labels carried across", async () => {
  const gh = routingFakeGh(emptyStore());
  const result = await fileRoutedIssue(PRODUCT_DRAFT, opts(gh.ghCommandFn));

  assertEquals(result.action, "created");
  assertEquals(result.repository, AUTOTRADER);
  assertEquals(result.labels_not_migrated, ["bug", "enhancement"]);
  const [issue] = gh.store.issues;
  assertEquals(issue?.repo, AUTOTRADER);
  assertEquals(issue?.labels, []);
  assertStringIncludes(issue!.body, "Labels not migrated: bug, enhancement");
  assert(!gh.store.issues.some((i) => i.repo === VIBE), "nothing in VibeCoder");
});

Deno.test("fileRoutedIssue - dry-run makes zero write calls and reports what it would do", async () => {
  const gh = routingFakeGh(emptyStore());
  const result = await fileRoutedIssue(
    PRODUCT_DRAFT,
    opts(gh.ghCommandFn, { dryRun: true }),
  );

  assertEquals(result.action, "would-create");
  assertEquals(result.repository, AUTOTRADER);
  assertEquals(result.number, null);
  assertEquals(gh.calls.filter(isWriteCall), []);
  assertEquals(gh.store.issues, []);
  // The read-only steps still ran: the search and the permission check.
  assert(gh.calls.some((c) => c[0] === "search"));
  assert(gh.calls.some((c) => c[0] === "repo" && c[1] === "view"));
});

Deno.test("fileRoutedIssue - an owned, open, fleet-authored match is reused, not refiled; dry-run reports would-reuse", async () => {
  const store = emptyStore();
  addIssue(store, VIBE, "lane worktree heal for a dangling HEAD!", OWNED_BODY);
  const gh = routingFakeGh(store);

  const dry = await fileRoutedIssue(
    WORKER_DRAFT,
    opts(gh.ghCommandFn, { dryRun: true }),
  );
  assertEquals(dry.action, "would-reuse");
  assertEquals(dry.number, 1);

  const live = await fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn));
  assertEquals(live.action, "reused");
  assertEquals(live.number, 1);
  assertEquals(gh.store.issues.length, 1);
  assertEquals(gh.calls.filter(isWriteCall), []);
  // The owned lookup is narrowed to the draft's title, not every open issue.
  const lookup = gh.calls.find(isLookup) ?? [];
  assertEquals(
    lookup[lookup.indexOf("--search") + 1],
    `"${WORKER_DRAFT.title}" in:title`,
  );
});

const NOT_OWNED_AND_OPEN: Array<[string, (issue: FakeIssue) => void]> = [
  ["closed within the window", (issue) => {
    issue.closedAt = "2026-10-01T00:00:00Z";
  }],
  ["by another author", (issue) => {
    issue.author = "someone-else";
  }],
  ["with no owned marker", (issue) => {
    issue.body = "filed by hand";
  }],
  ["a pull request", (issue) => {
    issue.isPullRequest = true;
  }],
];

for (const [name, shape] of NOT_OWNED_AND_OPEN) {
  for (const dryRun of [false, true]) {
    Deno.test(`fileRoutedIssue - a same-titled match ${name} suppresses the filing, is not reused and is not written to (dry-run ${dryRun})`, async () => {
      const control = await fileOverExisting(undefined, { dryRun });
      assertEquals(control.result.action, dryRun ? "would-reuse" : "reused");

      const { result, gh } = await fileOverExisting(shape, { dryRun });
      assertEquals(result.action, "suppressed");
      assertEquals(result.number, 1);
      assertEquals(gh.store.issues.length, 1, "no second issue was filed");
      assertEquals(gh.calls.filter(isWriteCall), []);
    });
  }
}

Deno.test("fileRoutedIssue - a suppressed filing logs the match it did not reuse, and the author check logs the foreign row", async () => {
  const { logger, records } = makeRecordingLogger();
  const { result } = await fileOverExisting((issue) => {
    issue.author = "someone-else";
  }, { logger });
  assertEquals(result.action, "suppressed");
  const messages = records.map(([m]) => m);
  assert(
    messages.some((m) => m.includes("authored outside the fleet")),
    `the owned lookup logs the foreign row: ${JSON.stringify(messages)}`,
  );
  const suppression = records.find(([m]) =>
    m.includes("Issue routing filed nothing") && m.includes("not reused")
  );
  assert(suppression, `the suppression is logged: ${JSON.stringify(messages)}`);
  assertEquals(suppression[1], { repo: VIBE, duplicate: 1 });
});

Deno.test("fileRoutedIssue - the recheck closes the new issue only for an owned, open, lower-numbered match", async () => {
  const cases: Array<{
    name: string;
    shape: (issue: FakeIssue) => void;
    closes: boolean;
  }> = [
    { name: "owned, open (control)", shape: () => undefined, closes: true },
    {
      name: "closed",
      shape: (issue) => {
        issue.closedAt = "2026-10-01T00:00:00Z";
      },
      closes: false,
    },
    {
      name: "foreign author",
      shape: (issue) => {
        issue.author = "someone-else";
      },
      closes: false,
    },
  ];
  for (const { name, shape, closes } of cases) {
    const store = emptyStore();
    let raced = false;
    const gh = routingFakeGh(store, {
      // A racing filer's issue is numbered below ours, so it is the older match.
      beforeCreate: (s) => {
        if (raced) return;
        raced = true;
        shape(addIssue(s, VIBE, WORKER_DRAFT.title, OWNED_BODY));
      },
    });
    const result = await fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn));
    const closeCalls = gh.calls.filter((c) => c[1] === "close");
    if (closes) {
      assertEquals(result.action, "reused", name);
      assertEquals(result.number, 1, name);
      assertEquals(result.closed_duplicate, 2, name);
      assertEquals(closeCalls.length, 1, name);
    } else {
      assertEquals(result.action, "created", name);
      assertEquals(result.number, 2, name);
      assertEquals(result.closed_duplicate, undefined, name);
      assertEquals(closeCalls, [], name);
      assertEquals(gh.store.issues[1]?.closedAt, null, name);
    }
  }
});

Deno.test("fileRoutedIssue - two concurrent filers converge: the higher number is closed and links to the lower", async () => {
  const store = emptyStore();
  let raced = false;
  const gh = routingFakeGh(store, {
    // Another owned filer creates the same issue between our search and our create.
    beforeCreate: (s) => {
      if (raced) return;
      raced = true;
      addIssue(s, VIBE, WORKER_DRAFT.title, OWNED_BODY);
    },
  });
  const result = await fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn));

  assertEquals(result.action, "reused");
  assertEquals(result.number, 1);
  assertEquals(result.closed_duplicate, 2);
  const [kept, closed] = gh.store.issues;
  assertEquals(kept?.closedAt, null);
  assert(closed?.closedAt !== null, "the higher-numbered issue is closed");
  assertEquals(closed?.stateReason, "not planned");
  assertStringIncludes(closed!.comments.join("\n"), "Duplicate of #1");
});

Deno.test("fileRoutedIssue - a permission failure creates nothing and names the repository", async () => {
  const store = emptyStore();
  store.viewerPermission[AUTOTRADER] = "READ";
  const gh = routingFakeGh(store);

  const error = await assertRejects(
    () => fileRoutedIssue(PRODUCT_DRAFT, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "permission");
  assertEquals(error.repository, AUTOTRADER);
  assertStringIncludes(error.message, AUTOTRADER);
  assertStringIncludes(error.message, '"permission"');
  assertInstanceOf(error.cause, IssueRoutingPermissionError);
  assertEquals(gh.store.issues, []);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("fileRoutedIssue - a failed step carries the routing decision, or null when classify failed", async () => {
  const store = emptyStore();
  store.viewerPermission[VIBE] = "READ";
  const gh = routingFakeGh(store);

  const refused = await assertRejects(
    () => fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(refused.step, "permission");
  assertEquals(refused.decision?.owner_repository, VIBE);

  const classify = await assertRejects(
    () => fileRoutedIssue({ title: " " }, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(classify.step, "classify");
  assertEquals(classify.decision, null);
});

Deno.test("fileRoutedIssue - a failure at the search, create, recheck and close-duplicate steps carries the routing decision", async () => {
  let lookups = 0;
  const cases: Array<{
    step: string;
    race: boolean;
    failWhen: (args: string[]) => Error | undefined;
  }> = [
    {
      step: "search",
      race: false,
      failWhen: (args) =>
        args[0] === "search" ? new Error("HTTP 503: unavailable") : undefined,
    },
    {
      step: "create",
      race: false,
      failWhen: (args) =>
        args[1] === "create" ? new Error("HTTP 500: create failed") : undefined,
    },
    {
      step: "recheck",
      race: false,
      // With no dedup hit, the first owned lookup is the post-create recheck.
      failWhen: (args) => {
        if (!isLookup(args)) return undefined;
        lookups++;
        return lookups === 1 ? new Error("HTTP 502: Bad Gateway") : undefined;
      },
    },
    {
      step: "close-duplicate",
      race: true,
      failWhen: (args) =>
        args[1] === "close" ? new Error("HTTP 504: timeout") : undefined,
    },
  ];
  for (const { step, race, failWhen } of cases) {
    lookups = 0;
    let raced = !race;
    const gh = routingFakeGh(emptyStore(), {
      failWhen,
      beforeCreate: (s) => {
        if (raced) return;
        raced = true;
        // An owned raced issue is the older match, so the recheck closes ours.
        addIssue(s, VIBE, WORKER_DRAFT.title, OWNED_BODY);
      },
    });
    const error = await assertRejects(
      () => fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn)),
      RoutedIssueFilingError,
    );
    assertEquals(error.step, step);
    assertEquals(error.decision?.owner_repository, VIBE, `step: ${step}`);
    assertEquals(error.decision?.issue_kind, "implementation", `step: ${step}`);
  }
});

Deno.test("fileRoutedIssue - a failure after create is not success, and a retry files no second issue", async () => {
  const store = emptyStore();
  let lookups = 0;
  const gh = routingFakeGh(store, {
    // Fail the post-create recheck (the first owned lookup) on the first run only.
    failWhen: (args) => {
      if (!isLookup(args)) return undefined;
      lookups++;
      return lookups === 1 ? new Error("HTTP 502: Bad Gateway") : undefined;
    },
  });

  const error = await assertRejects(
    () => fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "recheck");
  assertStringIncludes(error.message, "502");
  assertEquals(gh.store.issues.length, 1);

  const retry = await fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn));
  assertEquals(retry.action, "reused");
  assertEquals(retry.number, 1);
  assertEquals(gh.store.issues.length, 1);
});

Deno.test("fileRoutedIssue - a failed create names the create step", async () => {
  const gh = routingFakeGh(emptyStore(), {
    failWhen: (args) =>
      args[1] === "create" ? new Error("HTTP 500: create failed") : undefined,
  });
  const error = await assertRejects(
    () => fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "create");
  assertStringIncludes(error.message, '"create"');
  assertStringIncludes(error.message, "create failed");
});

Deno.test("fileRoutedIssue - create output with no issue URL is a create failure", async () => {
  const store = emptyStore();
  const real = routingFakeGh(store);
  const gh = async (args: string[]) =>
    args[1] === "create" ? "Creating issue…\n" : await real.ghCommandFn(args);
  const error = await assertRejects(
    () => fileRoutedIssue(WORKER_DRAFT, opts(gh)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "create");
  assertStringIncludes(error.message, "no issue URL");
});

Deno.test("fileRoutedIssue - reserved and configured custom labels are never applied", async () => {
  const gh = routingFakeGh(emptyStore());
  const { logger, records } = makeRecordingLogger();
  await fileRoutedIssue(
    { ...WORKER_DRAFT, labels: ["enhancement", "work-on", "deploy-me"] },
    opts(gh.ghCommandFn, { logger, extraReservedLabels: ["deploy-me"] }),
  );
  assertEquals(gh.store.issues[0]?.labels, ["enhancement"]);
  const stripped = records
    .filter(([m]) => m === "Stripped reserved label from worker-created issue")
    .map(([, c]) => (c as { label: string }).label);
  assertEquals(stripped, ["work-on", "deploy-me"]);
});

Deno.test("fileRoutedIssue - an ambiguous owner files nothing and returns the basis", async () => {
  const gh = routingFakeGh(emptyStore());
  const result = await fileRoutedIssue(
    { title: "Something is off", body: "No signal here at all." },
    opts(gh.ghCommandFn),
  );
  assertEquals(result.action, "ambiguous");
  assertEquals(result.number, null);
  assertEquals(result.decision.issue_kind, "ambiguous");
  assertStringIncludes(result.decision.reason, "no worker or product signal");
  assertEquals(gh.calls, []);
});

Deno.test("fileRoutedIssue - a missing title fails at the classify step with no gh call", async () => {
  const gh = routingFakeGh(emptyStore());
  const error = await assertRejects(
    () => fileRoutedIssue({ title: " " }, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "classify");
  assertStringIncludes(error.message, "draft.title is missing");
  assertEquals(gh.calls, []);
});

Deno.test("fileRoutedIssue - a failed duplicate search names the search step and creates nothing", async () => {
  const gh = routingFakeGh(emptyStore(), {
    failWhen: (args) =>
      args[0] === "search" ? new Error("HTTP 503: unavailable") : undefined,
  });
  const error = await assertRejects(
    () => fileRoutedIssue(WORKER_DRAFT, opts(gh.ghCommandFn)),
    RoutedIssueFilingError,
  );
  assertEquals(error.step, "search");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("formatRoutingAudit - the reason is folded onto one visible line", () => {
  const text = formatRoutingAudit({
    owner_repository: VIBE,
    subject_repository: AUTOTRADER,
    issue_kind: "cross-repo",
    reason: "first line\n  second line",
  });
  assertEquals(
    text,
    "Routing: owner `stSoftwareAU/VibeCoder`, subject " +
      "`stSoftwareAU/GRQ-AutoTrader`, kind `cross-repo` — first line second line\n" +
      "<!-- issue-routing owner=stSoftwareAU/VibeCoder " +
      "subject=stSoftwareAU/GRQ-AutoTrader kind=cross-repo -->",
  );
});
