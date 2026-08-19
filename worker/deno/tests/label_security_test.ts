/**
 * Tests for label_security.ts (Issue #1344).
 *
 * Verifies that operational labels are checked against the timeline API
 * and only trusted label additions are honoured.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  filterTrustedLabels,
  isOperationalLabel,
  OPERATIONAL_LABEL_NAMES,
  type OperationalLabelResult,
  verifyOperationalLabels,
} from "../lib/label_security.ts";

// =============================================================================
// OPERATIONAL_LABEL_NAMES constant tests
// =============================================================================

Deno.test("label_security - OPERATIONAL_LABEL_NAMES contains expected labels", () => {
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("planning"), true);
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("question"), true);
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("needs-revision"), true);
  // Issue #2031: skip-clarification retired from OPERATIONAL_LABEL_NAMES.
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("skip-clarification"), false);
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("best-model"), true);
});

Deno.test("label_security - OPERATIONAL_LABEL_NAMES includes needs-human (Issue #1470)", () => {
  // needs-human is a worker-to-human escalation signal that skips discovery.
  // It must be listed as operational so a non-trusted user cannot grief the
  // worker by adding it to stall issues.
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("needs-human"), true);
});

Deno.test("label_security - OPERATIONAL_LABEL_NAMES does not contain non-operational labels", () => {
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("bug"), false);
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("enhancement"), false);
  assertEquals(OPERATIONAL_LABEL_NAMES.includes("work-on"), false);
});

Deno.test("label_security - isOperationalLabel matches case-insensitively (Issue #3088)", () => {
  // GitHub treats label names case-insensitively, so a non-lower-case
  // canonical label must still be recognised as operational.
  assertEquals(isOperationalLabel("planning"), true);
  assertEquals(isOperationalLabel("Planning"), true);
  assertEquals(isOperationalLabel("NEEDS-HUMAN"), true);
  assertEquals(isOperationalLabel("Best-Model"), true);
  // Non-operational labels stay non-operational regardless of case.
  assertEquals(isOperationalLabel("Bug"), false);
  assertEquals(isOperationalLabel("Work-On"), false);
});

// =============================================================================
// verifyOperationalLabels tests
// =============================================================================

Deno.test("label_security - verifyOperationalLabels returns all labels trusted when added by allowed author", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
      },
      {
        event: "labeled",
        label: { name: "question" },
        actor: { login: "alice" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning", "question", "bug"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, ["planning", "question"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - verifyOperationalLabels identifies untrusted label additions", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "mallory" },
      },
      {
        event: "labeled",
        label: { name: "question" },
        actor: { login: "alice" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning", "question"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, ["question"]);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]?.label, "planning");
  assertEquals(result.untrustedLabels[0]?.addedBy, "mallory");
});

Deno.test("label_security - title-case operational label by untrusted author is verified and stripped (Issue #3088)", async () => {
  // A canonical label stored as `Planning` must still be treated as
  // operational (verified against the timeline) and, when added by an
  // untrusted author, stripped — not silently honoured.
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        event: "labeled",
        label: { name: "Planning" },
        actor: { login: "mallory" },
      },
    ]));

  const result = await verifyOperationalLabels(
    "owner/repo",
    7,
    ["Planning"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]?.label, "Planning");
  assertEquals(result.untrustedLabels[0]?.addedBy, "mallory");

  // The untrusted label is dropped by filterTrustedLabels.
  assertEquals(filterTrustedLabels(["Planning", "bug"], result), ["bug"]);
});

Deno.test("label_security - title-case needs-human by workerUser is trusted (Issue #3088)", async () => {
  // The worker-trust special case must also be case-insensitive so a
  // `Needs-Human` canonical label applied by the worker is not stripped.
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        event: "labeled",
        label: { name: "Needs-Human" },
        actor: { login: "vibe-bot" },
      },
    ]));

  const result = await verifyOperationalLabels(
    "owner/repo",
    8,
    ["Needs-Human"],
    ["alice"],
    mockGh,
    "vibe-bot",
  );

  assertEquals(result.trustedLabels, ["Needs-Human"]);
  assertEquals(result.untrustedLabels.length, 0);
});

Deno.test("label_security - verifyOperationalLabels ignores non-operational labels", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { event: "labeled", label: { name: "bug" }, actor: { login: "mallory" } },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["bug", "enhancement"],
    ["alice"],
    mockGh,
  );

  // Non-operational labels are not checked — returned empty
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - verifyOperationalLabels uses last label event (re-add scenario)", async () => {
  // Mallory adds planning, then alice re-adds it — should be trusted
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "mallory" },
      },
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, ["planning"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - verifyOperationalLabels requests an untruncated timeline window (Issue #3089)", async () => {
  // The genuine most-recent `planning` add is by an untrusted actor (mallory)
  // and only appears once the full window is fetched. The gate must request
  // per_page=100 so it sees mallory's add and strips the label as untrusted.
  let requestedPath = "";
  const mockGh = async (args: string[]): Promise<string> => {
    requestedPath = args[1] ?? "";
    const truncatedWindow = [
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
      },
    ];
    const fullWindow = [
      ...truncatedWindow,
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "mallory" },
      },
    ];
    return JSON.stringify(
      requestedPath.includes("per_page=100") ? fullWindow : truncatedWindow,
    );
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  assertStringIncludes(requestedPath, "per_page=100");
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.map((u) => u.label), ["planning"]);
});

Deno.test("label_security - verifyOperationalLabels paginates past page 1 so the true most-recent add is read (Issue #3165)", async () => {
  // A busy issue: page 1 (oldest 100 events) holds a stale TRUSTED `planning`
  // add by alice; the genuine most-recent add — an untrusted re-add by mallory
  // after an intervening unlabel — sits on page 2. Reading only page 1 would
  // honour the stale trusted add. Pagination must fetch page 2 and strip it.
  const requestedPages: string[] = [];
  const fullPage = Array.from({ length: 100 }, () => ({
    event: "commented",
    actor: { login: "someone" },
  }));
  // Put the stale trusted `planning` add inside page 1.
  fullPage[0] = {
    event: "labeled",
    label: { name: "planning" },
    actor: { login: "alice" },
  } as unknown as typeof fullPage[number];
  const page2 = [
    {
      event: "unlabeled",
      label: { name: "planning" },
      actor: { login: "alice" },
    },
    {
      event: "labeled",
      label: { name: "planning" },
      actor: { login: "mallory" },
    },
  ];
  const mockGh = async (args: string[]): Promise<string> => {
    const path = args[1] ?? "";
    requestedPages.push(path);
    if (path.includes("page=2")) return JSON.stringify(page2);
    return JSON.stringify(fullPage); // page 1 (exactly 100 → more pages exist)
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  // Both pages were fetched (page 1 was full, so pagination continued).
  assertEquals(requestedPages.length, 2);
  assertStringIncludes(requestedPages[0] ?? "", "page=1");
  assertStringIncludes(requestedPages[1] ?? "", "page=2");
  // mallory's re-add is the genuine most-recent event → stripped as untrusted.
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.map((u) => u.label), ["planning"]);
});

Deno.test("label_security - verifyOperationalLabels stops paginating on a short page (Issue #3165)", async () => {
  // A short first page (fewer than 100 events) means there are no more pages,
  // so exactly one API call is made.
  let apiCallCount = 0;
  const mockGh = async (_args: string[]): Promise<string> => {
    apiCallCount++;
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  assertEquals(apiCallCount, 1);
  assertEquals(result.trustedLabels, ["planning"]);
});

Deno.test("label_security - verifyOperationalLabels handles case-insensitive author matching", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "Alice" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, ["planning"]);
  assertEquals(result.untrustedLabels, []);
});

// Issue #2874: a timeline-read failure must fail CLOSED. Previously this test
// asserted an empty result (fail-open) — every operational label was honoured
// during the failure window. The contract now marks all present operational
// labels untrusted so filterTrustedLabels() strips them.
Deno.test("label_security - verifyOperationalLabels fails closed on API failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API rate limit");
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning", "question"],
    ["alice"],
    mockGh,
  );

  // Fail closed: nothing trusted, every present operational label untrusted.
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 2);
  assertEquals(
    result.untrustedLabels.map((u) => u.label).sort(),
    ["planning", "question"],
  );
  for (const u of result.untrustedLabels) {
    assertEquals(u.addedBy, "unknown");
  }
});

// Issue #2874: a malformed timeline response (unparseable JSON) must also fail
// closed via the same catch branch.
Deno.test("label_security - verifyOperationalLabels fails closed on unparseable timeline", async () => {
  const mockGh = async (_args: string[]): Promise<string> => "not json{";

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]?.label, "planning");
});

// Issue #2874: end-to-end — on a timeline failure the untrusted operational
// labels are stripped by filterTrustedLabels(), leaving only safe labels.
Deno.test("label_security - operational labels stripped after API failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("timeline boom");
  };

  const labels = ["bug", "planning", "question"];
  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    labels,
    ["alice"],
    mockGh,
  );

  const filtered = filterTrustedLabels(labels, result);
  // Non-operational label kept; both operational labels stripped.
  assertEquals(filtered, ["bug"]);
});

Deno.test("label_security - verifyOperationalLabels handles missing actor", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { event: "labeled", label: { name: "planning" }, actor: null },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  // No actor means untrusted
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]?.label, "planning");
  assertEquals(result.untrustedLabels[0]?.addedBy, "unknown");
});

Deno.test("label_security - verifyOperationalLabels caches timeline across multiple labels", async () => {
  let apiCallCount = 0;
  const mockGh = async (_args: string[]): Promise<string> => {
    apiCallCount++;
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
      },
      {
        event: "labeled",
        label: { name: "question" },
        actor: { login: "alice" },
      },
      {
        event: "labeled",
        label: { name: "needs-revision" },
        actor: { login: "mallory" },
      },
    ]);
  };

  await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning", "question", "needs-revision"],
    ["alice"],
    mockGh,
  );

  // Should only make one API call for the timeline, not one per label
  assertEquals(apiCallCount, 1);
});

Deno.test("label_security - verifyOperationalLabels returns empty when no operational labels present", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["bug", "enhancement"],
    ["alice"],
    mockGh,
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - verifyOperationalLabels handles label not found in timeline", async () => {
  // Label exists on issue but no matching timeline event found
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { event: "labeled", label: { name: "bug" }, actor: { login: "alice" } },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["planning"],
    ["alice"],
    mockGh,
  );

  // No timeline event = treat as untrusted
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]?.label, "planning");
  assertEquals(result.untrustedLabels[0]?.addedBy, "unknown");
});

// =============================================================================
// filterTrustedLabels tests
// =============================================================================

Deno.test("label_security - filterTrustedLabels keeps non-operational labels unchanged", () => {
  const labels = ["bug", "enhancement", "help wanted"];
  const verificationResult: OperationalLabelResult = {
    trustedLabels: [],
    untrustedLabels: [],
  };

  const filtered = filterTrustedLabels(labels, verificationResult);
  assertEquals(filtered, ["bug", "enhancement", "help wanted"]);
});

Deno.test("label_security - filterTrustedLabels removes untrusted operational labels", () => {
  const labels = ["planning", "bug", "question"];
  const verificationResult: OperationalLabelResult = {
    trustedLabels: ["question"],
    untrustedLabels: [{ label: "planning", addedBy: "mallory" }],
  };

  const filtered = filterTrustedLabels(labels, verificationResult);
  assertEquals(filtered, ["bug", "question"]);
});

Deno.test("label_security - filterTrustedLabels keeps all trusted operational labels", () => {
  const labels = ["planning", "bug", "question"];
  const verificationResult: OperationalLabelResult = {
    trustedLabels: ["planning", "question"],
    untrustedLabels: [],
  };

  const filtered = filterTrustedLabels(labels, verificationResult);
  assertEquals(filtered, ["planning", "bug", "question"]);
});

Deno.test("label_security - filterTrustedLabels removes all untrusted operational labels", () => {
  const labels = ["planning", "question", "needs-revision"];
  const verificationResult: OperationalLabelResult = {
    trustedLabels: [],
    untrustedLabels: [
      { label: "planning", addedBy: "mallory" },
      { label: "question", addedBy: "mallory" },
      { label: "needs-revision", addedBy: "mallory" },
    ],
  };

  const filtered = filterTrustedLabels(labels, verificationResult);
  assertEquals(filtered, []);
});

Deno.test("label_security - filterTrustedLabels handles empty labels", () => {
  const verificationResult: OperationalLabelResult = {
    trustedLabels: [],
    untrustedLabels: [],
  };

  const filtered = filterTrustedLabels([], verificationResult);
  assertEquals(filtered, []);
});

// ---------------------------------------------------------------------------
// Worker-applied needs-human (Issue #1951)
// ---------------------------------------------------------------------------

Deno.test("label_security - needs-human applied by workerUser is trusted", async () => {
  // The worker user applies needs-human as the worker-to-human escalation
  // signal. It must NOT be treated as untrusted even though the worker is
  // not in allowedAuthors.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "stsvcbot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["needs-human"],
    ["alice"], // worker NOT in allowedAuthors
    mockGh,
    "stsvcbot", // workerUser
  );

  assertEquals(result.trustedLabels, ["needs-human"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - needs-human applied by untrusted non-worker is still stripped", async () => {
  // A user who is neither in allowedAuthors nor the worker must not be able
  // to apply needs-human to starve the worker.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "mallory" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["needs-human"],
    ["alice"],
    mockGh,
    "stsvcbot",
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, [{
    label: "needs-human",
    addedBy: "mallory",
  }]);
});

Deno.test("label_security - needs-human applied by workerUser is trusted case-insensitively", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "stsvcbot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["needs-human"],
    ["alice"],
    mockGh,
    "stsvcbot",
  );

  assertEquals(result.trustedLabels, ["needs-human"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - without workerUser, worker-applied needs-human is untrusted", async () => {
  // When workerUser is omitted, the old behaviour applies — needs-human from
  // an unlisted user is treated as untrusted.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "stsvcbot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["needs-human"],
    ["alice"],
    mockGh,
    // workerUser not provided
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, [{
    label: "needs-human",
    addedBy: "stsvcbot",
  }]);
});

// ---------------------------------------------------------------------------
// Fleet sibling-worker operational-label trust exclusion (Issue #3225)
// ---------------------------------------------------------------------------

Deno.test("label_security - needs-revision added by a sibling fleet worker is untrusted", async () => {
  // In a multi-account fleet, sibling worker logins must appear in
  // allowed_authors (the PR-dedup requirement). An operational label a
  // sibling worker applies directly (bypassing the addLabelToIssue allowlist)
  // must still be stripped — the backstop must exclude fleet workers.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-revision" },
        actor: { login: "VibeCoderBot" }, // sibling worker, in allowed_authors
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    42,
    ["needs-revision"],
    ["alice", "VibeCoderBot"], // human + sibling worker
    mockGh,
    "stsvcbot", // this host's worker login
    ["VibeCoderBot", "stsvcbot"], // fleet worker logins
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, [{
    label: "needs-revision",
    addedBy: "VibeCoderBot",
  }]);
});

Deno.test("label_security - planning added by a sibling fleet worker is untrusted", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "VibeCoderBot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    7,
    ["planning"],
    ["alice", "VibeCoderBot"],
    mockGh,
    "stsvcbot",
    ["VibeCoderBot", "stsvcbot"],
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, [{
    label: "planning",
    addedBy: "VibeCoderBot",
  }]);
});

Deno.test("label_security - operational label added by this host's own worker is untrusted", async () => {
  // The scanning host's own worker login must also be excluded from the
  // operational-label trust set (only needs-human self-escalation is trusted).
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "question" },
        actor: { login: "stsvcbot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    9,
    ["question"],
    ["alice", "stsvcbot"],
    mockGh,
    "stsvcbot",
    ["stsvcbot", "VibeCoderBot"],
  );

  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels, [{
    label: "question",
    addedBy: "stsvcbot",
  }]);
});

Deno.test("label_security - planning added by a genuine human is still trusted", async () => {
  // The fleet-worker exclusion must NOT distrust genuine trusted humans in
  // allowed_authors — only fleet worker logins are excluded.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" }, // human, not a fleet worker
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    11,
    ["planning"],
    ["alice", "VibeCoderBot"],
    mockGh,
    "stsvcbot",
    ["VibeCoderBot", "stsvcbot"],
  );

  assertEquals(result.trustedLabels, ["planning"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("label_security - needs-human by worker stays trusted despite fleet-worker exclusion", async () => {
  // needs-human is the worker's designated escalation signal — it must remain
  // trusted when applied by the scanning host's worker even though the worker
  // is a fleet account excluded from every other operational label.
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "stsvcbot" },
      },
    ]);
  };

  const result = await verifyOperationalLabels(
    "owner/repo",
    13,
    ["needs-human"],
    ["alice", "stsvcbot"],
    mockGh,
    "stsvcbot",
    ["stsvcbot", "VibeCoderBot"],
  );

  assertEquals(result.trustedLabels, ["needs-human"]);
  assertEquals(result.untrustedLabels, []);
});
