/**
 * Unit tests for the idle-detection audit (Issue #2106).
 *
 * Covers:
 *   1. Pure classifier — every exclusion path (`label_filter`,
 *      `assignee_filter`, `blocking_label`, `stream_occupied`) and the
 *      happy path.
 *   2. `pickDominantReason` specificity ordering.
 *   2b. `classifyProbeFailure` (Issue #4035) — access_denied vs
 *      transient vs parse_failed over real gh error strings, including
 *      the 403-permission / 403-rate-limit hazard pair.
 *   3. `auditClaimableState` end-to-end with a stubbed gh:
 *      - Per-repo `[idle-detect]` lines + per-tick summary.
 *      - Multi-host fields (`host=<hostname>:<pid>`).
 *      - The `mis_classification` ALERT fires when the audit disagrees
 *        with the scan (the original symptom #2106 set out to catch).
 *      - The ALERT is suppressed when the scan agrees.
 *      - gh failure → `reason=probe_error` line + total=0 contribution.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditClaimableState,
  classifyIssues,
  classifyProbeFailure,
  pickDominantReason,
  type ProbeFailureKind,
} from "../lib/idle_detect_diagnostics.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";

// ---------------------------------------------------------------------------
// Pure classifier — exclusion branches
// ---------------------------------------------------------------------------

Deno.test("classifyIssues - claimable when approved label + unassigned + clear stream", () => {
  const verdicts = classifyIssues(
    [
      {
        number: 1,
        labels: ["top-priority"],
        assignees: [],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts.length, 1);
  assertEquals(verdicts[0]!.claimable, true);
  assertEquals(verdicts[0]!.excludedBy, undefined);
});

Deno.test("classifyIssues - excludes issues with no approved-work label as label_filter", () => {
  const verdicts = classifyIssues(
    [
      { number: 5, labels: ["enhancement"], assignees: [], milestone: "" },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.claimable, false);
  assertEquals(verdicts[0]!.excludedBy, "label_filter");
});

Deno.test("classifyIssues - excludes blocked labels (failed, needs-human) as blocking_label", () => {
  const verdicts = classifyIssues(
    [
      {
        number: 7,
        labels: ["work-on", "failed"],
        assignees: [],
        milestone: "",
      },
      {
        number: 8,
        labels: ["top-priority", "needs-human"],
        assignees: [],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.excludedBy, "blocking_label");
  assertEquals(verdicts[1]!.excludedBy, "blocking_label");
});

Deno.test("classifyIssues - excludes assigned issues as assignee_filter", () => {
  const verdicts = classifyIssues(
    [
      {
        number: 9,
        labels: ["top-priority"],
        assignees: ["someone-else"],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.excludedBy, "assignee_filter");
});

Deno.test("classifyIssues - excludes stream_occupied when worker already has an issue in that milestone", () => {
  const verdicts = classifyIssues(
    [
      {
        number: 100,
        labels: ["work-on"],
        assignees: ["vibebot"],
        milestone: "v2",
      },
      {
        number: 101,
        labels: ["work-on"],
        assignees: [],
        milestone: "v2",
      },
    ],
    { workerUser: "vibebot" },
  );
  // 100 is excluded by assignee_filter; 101 by stream_occupied because
  // its milestone is already held by the worker.
  assertEquals(verdicts[0]!.excludedBy, "assignee_filter");
  assertEquals(verdicts[1]!.excludedBy, "stream_occupied");
});

Deno.test("classifyIssues - default branch stream occupancy uses empty milestone string", () => {
  // When the worker already has an issue claimed on the default branch
  // stream (milestone=""), any other unassigned claimable issue on the
  // default branch is `stream_occupied`.
  const verdicts = classifyIssues(
    [
      {
        number: 200,
        labels: ["work-on"],
        assignees: ["vibebot"],
        milestone: "",
      },
      {
        number: 201,
        labels: ["top-priority"],
        assignees: [],
        milestone: "",
      },
      {
        number: 202,
        labels: ["work-on"],
        assignees: [],
        milestone: "v1", // different stream — should remain claimable
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[1]!.excludedBy, "stream_occupied");
  assertEquals(verdicts[2]!.claimable, true);
});

// ---------------------------------------------------------------------------
// pickDominantReason specificity
// ---------------------------------------------------------------------------

Deno.test("pickDominantReason - empty list ⇒ no_open", () => {
  assertEquals(pickDominantReason([]), "no_open");
});

Deno.test("pickDominantReason - stream_occupied wins over assignee_filter / label_filter", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "label_filter",
        milestone: "",
      },
      {
        number: 2,
        claimable: false,
        excludedBy: "assignee_filter",
        milestone: "",
      },
      {
        number: 3,
        claimable: false,
        excludedBy: "stream_occupied",
        milestone: "v1",
      },
    ]),
    "stream_occupied",
  );
});

Deno.test("pickDominantReason - assignee_filter wins over blocking_label / label_filter", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "label_filter",
        milestone: "",
      },
      {
        number: 2,
        claimable: false,
        excludedBy: "blocking_label",
        milestone: "",
      },
      {
        number: 3,
        claimable: false,
        excludedBy: "assignee_filter",
        milestone: "",
      },
    ]),
    "assignee_filter",
  );
});

// ---------------------------------------------------------------------------
// classifyProbeFailure — access_denied vs transient vs parse_failed (#4035)
// ---------------------------------------------------------------------------

Deno.test("classifyProbeFailure - classifies real gh error strings", () => {
  const cases: Array<
    { name: string; message: string; kind: ProbeFailureKind }
  > = [
    // --- access_denied: the repo is invisible to this identity ---------
    {
      name: "gh 404 on a repo the worker can no longer see (#4028)",
      message:
        "gh: Could not resolve to a Repository with the name 'TitlePage/site'. (HTTP 404)",
      kind: "access_denied",
    },
    {
      name: "bare HTTP 404 from the REST path",
      message: "HTTP 404: Not Found (https://api.github.com/repos/org/gone)",
      kind: "access_denied",
    },
    {
      name: "403 permission body — resource not accessible",
      message:
        "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/org/repo/issues)",
      kind: "access_denied",
    },
    {
      name: "403 permission body — must have push access",
      message:
        "HTTP 403: Must have push access to view repository collaborators.",
      kind: "access_denied",
    },
    {
      name: "403 SAML/SSO enforcement",
      message:
        "HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.",
      kind: "access_denied",
    },
    // --- transient: must never affect health ---------------------------
    {
      name: "403 primary rate limit (the 403 hazard pair)",
      message:
        "HTTP 403: API rate limit exceeded for user ID 12345. (https://api.github.com/graphql)",
      kind: "transient",
    },
    {
      name: "403 secondary rate limit",
      message:
        "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      kind: "transient",
    },
    {
      name: "429 with Retry-After",
      message: "HTTP 429: Too Many Requests (Retry-After: 60)",
      kind: "transient",
    },
    {
      name: "exhausted rate-limit header",
      message: "gh: request failed, x-ratelimit-remaining: 0",
      kind: "transient",
    },
    {
      name: "bare 403 with no permission wording (fail safe)",
      message: "HTTP 403: request forbidden",
      kind: "transient",
    },
    {
      name: "server error",
      message: "HTTP 502: Bad Gateway",
      kind: "transient",
    },
    {
      name: "connection reset",
      message:
        'Get "https://api.github.com/repos/org/repo/issues": read tcp 10.0.0.2:443: connection reset by peer',
      kind: "transient",
    },
    {
      name: "DNS failure",
      message: "dial tcp: lookup api.github.com: no such host",
      kind: "transient",
    },
    {
      name: "timeout",
      message:
        'Get "https://api.github.com": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
      kind: "transient",
    },
    {
      name: "unrecognised string defaults to transient (fail safe)",
      message: "gh: something nobody has seen before",
      kind: "transient",
    },
    { name: "empty string", message: "", kind: "transient" },
    // --- parse_failed: gh succeeded, the JSON did not ------------------
    {
      name: "parse failure marker",
      message:
        "parse_failed: Unexpected token 'n', \"not json\" is not valid JSON",
      kind: "parse_failed",
    },
  ];

  for (const c of cases) {
    assertEquals(
      classifyProbeFailure(c.message),
      c.kind,
      `${c.name}: expected ${c.kind} for ${JSON.stringify(c.message)}`,
    );
  }
});

Deno.test("classifyProbeFailure - a 404 repo and a rate-limited repo classify differently", () => {
  // The hazard the classifier exists to remove: both arrive as gh
  // failures, only one means the worker has lost sight of the repo.
  assertEquals(
    classifyProbeFailure(
      "gh: Could not resolve to a Repository with the name 'org/gone'. (HTTP 404)",
    ),
    "access_denied",
  );
  assertEquals(
    classifyProbeFailure(
      "HTTP 403: You have exceeded a secondary rate limit.",
    ),
    "transient",
  );
});

Deno.test("classifyIssues - idle-task with a non-wrapper title is claimable (no title gate)", () => {
  // `idle-task` is just the lowest work-trigger priority, so any
  // unblocked, unassigned idle-task issue is claimable regardless of its
  // title — matching the collector. (There is no wrapper-title gate; the
  // scan-template-vs-standard-pipeline decision is made at dispatch time,
  // not here.)
  const verdicts = classifyIssues(
    [
      {
        number: 11,
        title: "dead-code: unused export `foo` in src/bar.ts",
        labels: ["idle-task"],
        assignees: [],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.claimable, true);
  assertEquals(verdicts[0]!.excludedBy, undefined);
});

Deno.test("classifyIssues - idle-task with registered wrapper title is claimable", () => {
  const verdicts = classifyIssues(
    [
      {
        number: 12,
        title: "Run a security scan",
        labels: ["idle-task"],
        assignees: [],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.claimable, true);
  assertEquals(verdicts[0]!.excludedBy, undefined);
});

Deno.test("classifyIssues - idle-task alongside top-priority is claimable regardless of title", () => {
  // A real-world issue carrying both `idle-task` and another approved
  // work label is claimable just like any other work item.
  const verdicts = classifyIssues(
    [
      {
        number: 13,
        title: "Some hand-typed title",
        labels: ["idle-task", "top-priority"],
        assignees: [],
        milestone: "",
      },
    ],
    { workerUser: "vibebot" },
  );
  assertEquals(verdicts[0]!.claimable, true);
});

Deno.test("pickDominantReason - blocking_label wins over label_filter", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "label_filter",
        milestone: "",
      },
      {
        number: 2,
        claimable: false,
        excludedBy: "blocking_label",
        milestone: "",
      },
    ]),
    "blocking_label",
  );
});

Deno.test("pickDominantReason - label_filter only ⇒ label_filter", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "label_filter",
        milestone: "",
      },
    ]),
    "label_filter",
  );
});

// ---------------------------------------------------------------------------
// auditClaimableState end-to-end
// ---------------------------------------------------------------------------

interface StubIssueRow {
  number: number;
  labels: string[];
  assignees: string[];
  milestone: string;
}

function makeGhStub(byRepo: Record<string, StubIssueRow[] | Error>) {
  return (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
    const entry = byRepo[repo];
    if (entry instanceof Error) return Promise.reject(entry);
    if (entry === undefined) return Promise.resolve("[]");
    const payload = entry.map((row) => ({
      number: row.number,
      labels: row.labels.map((name) => ({ name })),
      assignees: row.assignees.map((login) => ({ login })),
      milestone: row.milestone.length > 0 ? { title: row.milestone } : null,
    }));
    return Promise.resolve(JSON.stringify(payload));
  };
}

Deno.test(
  "auditClaimableState - emits per-repo line + per-tick summary tagged with host:pid",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha", "org/beta"],
      workerUser: "vibebot",
      tick: 7,
      scanFoundClaimable: false,
      ghCommandFn: makeGhStub({
        "org/alpha": [
          { number: 1, labels: ["top-priority"], assignees: [], milestone: "" },
        ],
        "org/beta": [
          { number: 2, labels: ["enhancement"], assignees: [], milestone: "" },
        ],
      }),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.perRepo.length, 2);
    assertEquals(result.perRepo[0]!.claimable, 1);
    assertEquals(result.perRepo[1]!.claimable, 0);
    assertEquals(result.claimableTotal, 1);

    // Per-repo lines carry host tag.
    const alpha = logs.find((l) =>
      l.includes("repo=org/alpha") && l.includes("claimable=1")
    );
    assert(
      alpha !== undefined,
      `missing per-repo line for alpha: ${logs.join("\n")}`,
    );
    assert(alpha.includes("host=host-a:1234"));
    assert(alpha.includes("tick=7"));
    assert(alpha.includes("reason=has_claimable"));

    const beta = logs.find((l) =>
      l.includes("repo=org/beta") && l.includes("claimable=0")
    );
    assert(beta !== undefined);
    assert(beta.includes("reason=label_filter"));

    // Per-tick summary line.
    const summary = logs.find((l) =>
      l.includes("repos=2") && l.includes("claimable_total=1")
    );
    assert(
      summary !== undefined,
      `missing per-tick summary: ${logs.join("\n")}`,
    );
    assert(summary.includes("host=host-a:1234"));
  },
);

Deno.test(
  "auditClaimableState - raises mis_classification ALERT when scan claimed nothing but probe found claimable work (Issue #2106 symptom)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false, // <-- the original symptom
      ghCommandFn: makeGhStub({
        "org/alpha": [
          { number: 1, labels: ["top-priority"], assignees: [], milestone: "" },
        ],
      }),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-x",
      pidFn: () => 99,
    });

    assertEquals(result.misClassification, true);
    assertEquals(result.misClassificationRepos, ["org/alpha"]);

    const alert = logs.find((l) =>
      l.includes("ALERT mis_classification") &&
      l.includes("claimable_total=1") &&
      l.includes("repos=org/alpha") &&
      l.includes("host=host-x:99")
    );
    assert(
      alert !== undefined,
      `expected mis_classification ALERT; got: ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "auditClaimableState - suppresses mis_classification ALERT when scan agrees there is work",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: true,
      ghCommandFn: makeGhStub({
        "org/alpha": [
          { number: 1, labels: ["top-priority"], assignees: [], milestone: "" },
        ],
      }),
      log: (line) => logs.push(line),
    });
    assertEquals(result.misClassification, false);
    assertEquals(logs.find((l) => l.includes("ALERT")), undefined);
  },
);

Deno.test(
  "auditClaimableState - no alert when both scan and probe agree there is no claimable work",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: makeGhStub({
        "org/alpha": [], // empty repo
      }),
      log: (line) => logs.push(line),
    });
    assertEquals(result.misClassification, false);
    assertEquals(result.claimableTotal, 0);
    assertEquals(result.perRepo[0]!.reason, "no_open");
    assertEquals(logs.find((l) => l.includes("ALERT")), undefined);
  },
);

Deno.test(
  "auditClaimableState - gh failure surfaces as reason=probe_error and contributes 0 to total",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha", "org/beta"],
      workerUser: "vibebot",
      tick: 3,
      scanFoundClaimable: false,
      ghCommandFn: makeGhStub({
        "org/alpha": new Error("gh: HTTP 500"),
        "org/beta": [
          { number: 2, labels: ["work-on"], assignees: [], milestone: "" },
        ],
      }),
      log: (line) => logs.push(line),
    });

    const alphaSnap = result.perRepo.find((r) => r.repo === "org/alpha")!;
    assertEquals(alphaSnap.reason, "probe_error");
    assertEquals(alphaSnap.claimable, 0);
    assert(alphaSnap.errorMessage?.includes("gh: HTTP 500"));

    const probeLine = logs.find((l) =>
      l.includes("repo=org/alpha") && l.includes("reason=probe_error")
    );
    assert(probeLine !== undefined);

    // Total reflects only org/beta.
    assertEquals(result.claimableTotal, 1);
  },
);

Deno.test(
  "auditClaimableState - JSON parse failure surfaces as reason=probe_error parse_failed",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: () => Promise.resolve("not json"),
      log: (line) => logs.push(line),
    });
    assertEquals(result.perRepo[0]!.reason, "probe_error");
    assert(result.perRepo[0]!.errorMessage?.startsWith("parse_failed"));
    const line = logs.find((l) =>
      l.includes("reason=probe_error") && l.includes("parse_failed")
    );
    assert(line !== undefined);
  },
);

Deno.test(
  "auditClaimableState - probe_error snapshots carry failureKind and the log line carries failure_kind",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/gone", "org/throttled", "org/ok"],
      workerUser: "vibebot",
      tick: 7,
      scanFoundClaimable: false,
      ghCommandFn: makeGhStub({
        "org/gone": new Error(
          "gh: Could not resolve to a Repository with the name 'org/gone'. (HTTP 404)",
        ),
        "org/throttled": new Error(
          "HTTP 403: You have exceeded a secondary rate limit.",
        ),
        "org/ok": [
          { number: 1, labels: ["work-on"], assignees: [], milestone: "" },
        ],
      }),
      log: (line) => logs.push(line),
    });

    const gone = result.perRepo.find((r) => r.repo === "org/gone")!;
    assertEquals(gone.reason, "probe_error");
    assertEquals(gone.failureKind, "access_denied");

    const throttled = result.perRepo.find((r) => r.repo === "org/throttled")!;
    assertEquals(throttled.reason, "probe_error");
    assertEquals(throttled.failureKind, "transient");

    // Unchanged for every other reason — no classification leaks onto a
    // healthy snapshot.
    const ok = result.perRepo.find((r) => r.repo === "org/ok")!;
    assertEquals(ok.reason, "has_claimable");
    assertEquals(ok.failureKind, undefined);

    const goneLine = logs.find((l) => l.includes("repo=org/gone"))!;
    assert(goneLine.includes("reason=probe_error"), goneLine);
    assert(goneLine.includes("failure_kind=access_denied"), goneLine);
    const throttledLine = logs.find((l) => l.includes("repo=org/throttled"))!;
    assert(throttledLine.includes("failure_kind=transient"), throttledLine);
    const okLine = logs.find((l) => l.includes("repo=org/ok"))!;
    assert(!okLine.includes("failure_kind="), okLine);
  },
);

Deno.test(
  "auditClaimableState - parse failure classifies as failure_kind=parse_failed, not an access signal",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: () => Promise.resolve("not json"),
      log: (line) => logs.push(line),
    });
    assertEquals(result.perRepo[0]!.failureKind, "parse_failed");
    const line = logs.find((l) => l.includes("repo=org/alpha"))!;
    assert(line.includes("failure_kind=parse_failed"), line);
    assert(line.includes("message=parse_failed"), line);
  },
);

Deno.test(
  "auditClaimableState - multi-host visibility: two simulated hosts produce distinct host tags on the same tick",
  async () => {
    // Multi-host idle-decision visibility (acceptance criterion #3) is
    // realised by including `host=<hostname>:<pid>` on every line. We
    // simulate two hosts auditing the same monitored set on the same
    // tick — log aggregation can tell the decisions apart from the host
    // tag alone.
    const logsA: string[] = [];
    const logsB: string[] = [];
    const stub = makeGhStub({
      "org/alpha": [],
    });
    await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: stub,
      log: (line) => logsA.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 100,
    });
    await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: stub,
      log: (line) => logsB.push(line),
      hostnameFn: () => "host-b",
      pidFn: () => 200,
    });

    assert(logsA.every((l) => l.includes("host=host-a:100")));
    assert(logsB.every((l) => l.includes("host=host-b:200")));
    // Both tick-1 summaries should still appear in their own host's log.
    assert(
      logsA.find((l) =>
        l.includes("repos=1") && l.includes("host=host-a:100")
      ) !==
        undefined,
    );
    assert(
      logsB.find((l) =>
        l.includes("repos=1") && l.includes("host=host-b:200")
      ) !==
        undefined,
    );
  },
);

// ---------------------------------------------------------------------------
// PR-blocked work is not claimable work (Issue #4223)
// ---------------------------------------------------------------------------

/** An open fleet PR against the default branch. */
const DEFAULT_BRANCH_PR: OpenPR = {
  number: 900,
  title: "Fix the thing",
  baseRefName: "Develop",
  headRefName: "issue-1-fix-the-thing",
};

Deno.test("classifyIssues - an issue blocked by an open PR in its stream is not claimable", () => {
  const verdicts = classifyIssues(
    [{ number: 1, labels: ["work-on"], assignees: [], milestone: "" }],
    { workerUser: "vibe", openPRs: [DEFAULT_BRANCH_PR] },
  );

  // Without the PR gate this issue passes every other check, which is
  // exactly how a PR-blocked backlog produced a permanent
  // `mis_classification` ALERT: the audit counted work the scan correctly
  // refused to claim.
  assertEquals(verdicts[0]?.claimable, false);
  assertEquals(verdicts[0]?.excludedBy, "pr_blocked");
});

Deno.test("classifyIssues - a PR in another stream does not block a milestone issue", () => {
  // The gate is milestone-aware, exactly as `getBlockingPRForIssue` is for
  // the scan: a PR onto the default branch says nothing about a milestone
  // work stream.
  const verdicts = classifyIssues(
    [{ number: 2, labels: ["work-on"], assignees: [], milestone: "m1" }],
    { workerUser: "vibe", openPRs: [DEFAULT_BRANCH_PR] },
  );

  assertEquals(verdicts[0]?.claimable, true);
});

Deno.test("classifyIssues - the ignore-open-prs label bypasses the PR gate", () => {
  const verdicts = classifyIssues(
    [{
      number: 3,
      labels: ["work-on", "ignore-open-prs"],
      assignees: [],
      milestone: "",
    }],
    { workerUser: "vibe", openPRs: [DEFAULT_BRANCH_PR] },
  );

  assertEquals(verdicts[0]?.claimable, true);
});

Deno.test("classifyIssues - no PR data keeps today's behaviour", () => {
  // Callers that cannot supply PRs (or whose fetch failed) must not have
  // issues silently reclassified as blocked — the census takes the same
  // fail-safe.
  const verdicts = classifyIssues(
    [{ number: 4, labels: ["work-on"], assignees: [], milestone: "" }],
    { workerUser: "vibe" },
  );

  assertEquals(verdicts[0]?.claimable, true);
});

Deno.test("pickDominantReason - pr_blocked is the most specific reason", () => {
  const reason = pickDominantReason([
    { number: 1, claimable: false, excludedBy: "label_filter", milestone: "" },
    { number: 2, claimable: false, excludedBy: "pr_blocked", milestone: "" },
    {
      number: 3,
      claimable: false,
      excludedBy: "stream_occupied",
      milestone: "",
    },
  ]);

  // "everything is waiting on an open PR" is the actionable answer to
  // "why was nothing picked up".
  assertEquals(reason, "pr_blocked");
});

Deno.test("auditClaimableState - a PR-blocked backlog raises no mis_classification ALERT", async () => {
  const logs: string[] = [];
  const result = await auditClaimableState({
    repos: ["owner/repo"],
    workerUser: "vibe",
    tick: 1,
    // The scan claimed nothing — correctly, because the work is PR-blocked.
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 1, labels: [{ name: "work-on" }], assignees: [] },
        { number: 2, labels: [{ name: "work-on" }], assignees: [] },
      ])),
    openPRsFn: () => Promise.resolve([DEFAULT_BRANCH_PR]),
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 0);
  assertEquals(result.misClassification, false);
  assert(
    !logs.some((l) => l.includes("ALERT mis_classification")),
    `PR-blocked work must not alert; got:\n${logs.join("\n")}`,
  );
  assert(
    logs.some((l) => l.includes("reason=pr_blocked")),
    `the per-repo line must say why; got:\n${logs.join("\n")}`,
  );
});

Deno.test("auditClaimableState - genuinely claimable work still alerts", async () => {
  // The #2106 symptom must survive the #4223 fix: unblocked work the scan
  // missed is still the thing this alert exists to catch.
  const logs: string[] = [];
  const result = await auditClaimableState({
    repos: ["owner/repo"],
    workerUser: "vibe",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 1, labels: [{ name: "work-on" }], assignees: [] },
      ])),
    openPRsFn: () => Promise.resolve([]),
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 1);
  assertEquals(result.misClassification, true);
  assert(logs.some((l) => l.includes("ALERT mis_classification")));
});

Deno.test("auditClaimableState - a failing PR fetch never blocks the audit", async () => {
  // Fail-safe: an unavailable PR list falls back to no PR blocking rather
  // than reporting a repo as having nothing to do.
  const logs: string[] = [];
  const result = await auditClaimableState({
    repos: ["owner/repo"],
    workerUser: "vibe",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 1, labels: [{ name: "work-on" }], assignees: [] },
      ])),
    openPRsFn: () => Promise.reject(new Error("rate limited")),
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 1);
});

// ---------------------------------------------------------------------------
// Merged-PR permanent block (GRQ#4419 / VibeCoder#429)
// ---------------------------------------------------------------------------

/** Merged fleet PR naming GRQ#4326, the live permanent strand. */
const MERGED_PR_4336: ClosedPR = {
  number: 4336,
  title: "bug: Learn threw away most of its seeds (Issue #4326) (#4336)",
  closedAt: "2026-08-23T07:52:58Z",
  merged: true,
};

Deno.test("classifyIssues - a merged fleet PR excludes the issue it names (GRQ#4419)", () => {
  const verdicts = classifyIssues(
    [{ number: 4326, labels: ["work-on"], assignees: [], milestone: "" }],
    { workerUser: "vibe", mergedPRs: [MERGED_PR_4336] },
  );

  assertEquals(verdicts[0]?.claimable, false);
  assertEquals(verdicts[0]?.excludedBy, "merged_pr_blocked");
});

Deno.test("classifyIssues - a closed-unmerged PR does not exclude (GRQ#4419)", () => {
  const verdicts = classifyIssues(
    [{ number: 4326, labels: ["work-on"], assignees: [], milestone: "" }],
    {
      workerUser: "vibe",
      mergedPRs: [{ ...MERGED_PR_4336, merged: false }],
    },
  );

  assertEquals(verdicts[0]?.claimable, true);
});

Deno.test("pickDominantReason - merged_pr_blocked outranks pr_blocked (GRQ#4419)", () => {
  const reason = pickDominantReason([
    { number: 1, claimable: false, excludedBy: "pr_blocked", milestone: "" },
    {
      number: 2,
      claimable: false,
      excludedBy: "merged_pr_blocked",
      milestone: "",
    },
  ]);

  // A permanent strand is the most actionable answer to "why nothing".
  assertEquals(reason, "merged_pr_blocked");
});

Deno.test("auditClaimableState - a merged-PR-stranded backlog raises no ALERT (GRQ#4419)", async () => {
  const logs: string[] = [];
  const result = await auditClaimableState({
    repos: ["stSoftwareAU/GRQ"],
    workerUser: "vibe",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 4326, labels: [{ name: "work-on" }], assignees: [] },
      ])),
    openPRsFn: () => Promise.resolve([]),
    mergedPRsFn: () => Promise.resolve([MERGED_PR_4336]),
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 0);
  assertEquals(result.misClassification, false);
  assert(
    logs.some((l) => l.includes("reason=merged_pr_blocked")),
    `the per-repo line must say why; got:\n${logs.join("\n")}`,
  );
});

Deno.test("auditClaimableState - a failing merged-PR fetch never blocks the audit (GRQ#4419)", async () => {
  const result = await auditClaimableState({
    repos: ["stSoftwareAU/GRQ"],
    workerUser: "vibe",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 4326, labels: [{ name: "work-on" }], assignees: [] },
      ])),
    mergedPRsFn: () => Promise.reject(new Error("rate limited")),
    log: () => {},
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 1);
});
