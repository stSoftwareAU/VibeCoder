/**
 * Tests for the `idle-task` label back-fill sweep (Issue #2131, extended
 * in Issue #2322 to cover all four wrapper templates).
 *
 * The sweep walks every monitored repo, finds open idle-task wrappers
 * (security-scan, test-audit, best-practices, github-actions-audit) and
 * applies the `idle-task` label where missing. The tests pin:
 *   1. Unlabelled wrapper triggers an `addLabelToIssue` call — one test
 *      per template title (Issue #2322).
 *   2. Already-labelled wrapper produces no label call.
 *   3. A failing repo lookup is captured and the sweep continues.
 *   4. Partial title matches are ignored.
 *   5. Every rescue emits a `[idle-task] ALERT ... backfill_rescued`
 *      event in addition to the existing `[backfill] action=labelled`
 *      event (Issue #2322).
 *   6. A wrapper whose `idle-task` label was deliberately removed (an
 *      `unlabeled` event in the timeline) is skipped, not re-labelled —
 *      the sweep rescues create-path drops only, and must not undo an
 *      operator's re-triage. An unreadable timeline fails closed.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type BackfillEvent,
  backfillIdleTaskLabels,
  formatBackfillEvent,
  formatBackfillSummary,
  IDLE_TASK_WRAPPER_TITLES,
} from "../lib/idle_task_backfill.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import { SECURITY_SCAN_ISSUE_TITLE } from "../lib/idle_task_templates/security_scan_template.ts";
import { TEST_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/test_audit_template.ts";
import { BEST_PRACTICES_ISSUE_TITLE } from "../lib/idle_task_templates/best_practices_template.ts";
import { GITHUB_ACTIONS_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/github_actions_audit_template.ts";
import { SUPPLY_CHAIN_READINESS_ISSUE_TITLE } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import { ORPHAN_DEPS_ISSUE_TITLE } from "../lib/idle_task_templates/orphan_deps_template.ts";
import { DEAD_CODE_ISSUE_TITLE } from "../lib/idle_task_templates/dead_code_template.ts";
import { DOC_COVERAGE_ISSUE_TITLE } from "../lib/idle_task_templates/doc_coverage_template.ts";
import { FORMAT_DRIFT_ISSUE_TITLE } from "../lib/idle_task_templates/format_drift_template.ts";
import { DEPRECATED_API_ISSUE_TITLE } from "../lib/idle_task_templates/deprecated_api_template.ts";
import { BASH_SCRIPT_REFS_ISSUE_TITLE } from "../lib/idle_task_templates/bash_script_refs_template.ts";
import { BASH_SYNTAX_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import { DOCUMENTATION_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/documentation_audit_template.ts";
import { ALERT_FEED_ISSUE_TITLE } from "../lib/idle_task_templates/alert_feed_template.ts";
import { WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE } from "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
import { PRIVATE_REPO_REFERENCE_ISSUE_TITLE } from "../lib/idle_task_templates/private_repo_reference_template.ts";
import { DUPLICATED_KNOWLEDGE_ISSUE_TITLE } from "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import { RETRO_ISSUE_TITLE } from "../lib/idle_task_templates/retro_template.ts";
import type { Result } from "../types.ts";

/**
 * The fleet login every fixture wrapper is filed by (Issue #1124).
 *
 * A wrapper title is a compile-time constant on a public repository, so the
 * author is the only part of a match that is authenticated. The
 * planted-title case is asserted below.
 */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

interface StubLabelCall {
  repo: string;
  number: number;
  label: string;
}

function makeStubAddLabel(): {
  fn: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  calls: StubLabelCall[];
} {
  const calls: StubLabelCall[] = [];
  return {
    calls,
    fn: (repo, issueNumber, label) => {
      calls.push({ repo, number: issueNumber, label });
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

// Per-template "labels an unlabelled wrapper" tests (Issue #2322
// acceptance criterion: one test per wrapper title). The ghCommandFn
// returns the issue only for the query whose `--search` argument names
// the matching title, mirroring how gh's `in:title` search behaves.
const PER_TEMPLATE_CASES: ReadonlyArray<{
  title: string;
  templateName: string;
  repo: string;
  number: number;
}> = [
  {
    title: SECURITY_SCAN_ISSUE_TITLE,
    templateName: "security-scan",
    repo: "stSoftwareAU/private-repo-19",
    number: 180,
  },
  {
    title: TEST_AUDIT_ISSUE_TITLE,
    templateName: "test-audit",
    repo: "stSoftwareAU/private-repo-10",
    number: 48,
  },
  {
    title: BEST_PRACTICES_ISSUE_TITLE,
    templateName: "best-practices",
    repo: "stSoftwareAU/VibeCoder",
    number: 2322,
  },
  {
    title: GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
    templateName: "github-actions-audit",
    repo: "stSoftwareAU/VibeCoder",
    number: 2243,
  },
  {
    title: WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
    templateName: "workflow-annotation-scan",
    repo: "stSoftwareAU/VibeCoder",
    number: 3488,
  },
];

for (const c of PER_TEMPLATE_CASES) {
  Deno.test(
    `backfillIdleTaskLabels - labels an unlabelled ${c.templateName} wrapper`,
    async () => {
      const events: BackfillEvent[] = [];
      const stub = makeStubAddLabel();
      const ghCommandFn = (args: string[]) => {
        // The deliberate-removal guard reads the label-event timeline
        // through the same gh runner; an empty timeline means the label
        // was never removed, so the rescue proceeds.
        if (args[0] === "api") return Promise.resolve("[]");
        assertEquals(args[0], "issue");
        assertEquals(args[1], "list");
        // Only the matching-title query returns the wrapper; the other
        // three title queries return an empty list, exactly as gh's
        // `in:title` search would.
        const searchIdx = args.indexOf("--search");
        const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
        if (search !== `"${c.title}" in:title`) {
          return Promise.resolve("[]");
        }
        return Promise.resolve(JSON.stringify([
          {
            number: c.number,
            title: c.title,
            labels: [],
            author: { login: FLEET_AUTHOR },
          },
        ]));
      };

      const summary = await backfillIdleTaskLabels({
        authorOptions: FLEET_OPTIONS,
        authorLog: () => {},
        repos: [c.repo],
        ghCommandFn,
        addLabelFn: stub.fn,
        log: (event) => events.push(event),
      });

      assertEquals(summary.labelled, [{ repo: c.repo, number: c.number }]);
      assertEquals(summary.alreadyLabelled, 0);
      assertEquals(summary.errors.length, 0);
      assertEquals(stub.calls, [
        { repo: c.repo, number: c.number, label: IDLE_TASK_LABEL },
      ]);
      // One labelled event + one ALERT event per rescue.
      assertEquals(events.length, 2);
      assertEquals(events[0]!.kind, "labelled");
      const alert = events[1]!;
      assertEquals(alert.kind, "alert_rescued");
      if (alert.kind !== "alert_rescued") throw new Error("type guard");
      assertEquals(alert.repo, c.repo);
      assertEquals(alert.number, c.number);
      assertEquals(alert.template, c.templateName);
    },
  );
}

Deno.test("backfillIdleTaskLabels - skips an already-labelled wrapper", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    // Return the already-labelled wrapper only for the security-scan
    // query so we get exactly one match across all four title queries.
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 42,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [{ name: "idle-task" }, { name: "security" }],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.alreadyLabelled, 1);
  assertEquals(summary.errors.length, 0);
  assertEquals(stub.calls.length, 0, "addLabelToIssue must not be called");
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "already_labelled");
  // ALERT line MUST NOT be emitted when the wrapper was already
  // labelled (Issue #2322 acceptance criterion).
  assert(
    !events.some((e) => e.kind === "alert_rescued"),
    "alert_rescued event must not fire when wrapper already had the label",
  );
});

Deno.test("backfillIdleTaskLabels - skips a wrapper whose idle-task label was deliberately removed", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 49,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [{ name: "low-priority" }],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    // The label was applied at filing time and later removed by an
    // operator re-triaging the wrapper to `low-priority` — the exact
    // production sequence this guard exists for.
    fetchTimelineFn: () =>
      Promise.resolve([
        {
          event: "labeled",
          label: { name: "idle-task" },
          actor: { login: "worker-bot" },
          created_at: "2026-08-10T02:28:12Z",
        },
        {
          event: "unlabeled",
          label: { name: "idle-task" },
          actor: { login: "operator" },
          created_at: "2026-08-12T07:23:11Z",
        },
      ]),
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.deliberatelyUnlabelled, [
    { repo: "org/repo", number: 49, removedBy: "operator" },
  ]);
  assertEquals(summary.errors.length, 0);
  assertEquals(stub.calls.length, 0, "addLabelToIssue must not be called");
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "skipped_deliberately_unlabelled");
  assert(
    !events.some((e) => e.kind === "alert_rescued"),
    "alert_rescued must not fire for a deliberately unlabelled wrapper",
  );
});

Deno.test("backfillIdleTaskLabels - unlabeled events for other labels do not block a rescue", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 7,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    fetchTimelineFn: () =>
      Promise.resolve([
        {
          event: "unlabeled",
          label: { name: "work-on" },
          actor: { login: "operator" },
          created_at: "2026-08-12T07:23:11Z",
        },
      ]),
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled, [{ repo: "org/repo", number: 7 }]);
  assertEquals(summary.deliberatelyUnlabelled.length, 0);
  assertEquals(stub.calls, [
    { repo: "org/repo", number: 7, label: IDLE_TASK_LABEL },
  ]);
});

Deno.test("backfillIdleTaskLabels - timeline fetch failure fails closed (no label written)", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 11,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    fetchTimelineFn: () => Promise.reject(new Error("HTTP 502 from gh")),
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.errors.length, 1);
  assert(summary.errors[0]!.message.includes("timeline fetch failed"));
  assertEquals(stub.calls.length, 0, "must fail closed — no label written");
});

Deno.test("backfillIdleTaskLabels - unreadable timeline (null) fails closed", async () => {
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 12,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    fetchTimelineFn: () => Promise.resolve(null),
  });

  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.errors.length, 1);
  assert(summary.errors[0]!.message.includes("timeline unreadable"));
  assertEquals(stub.calls.length, 0, "must fail closed — no label written");
});

Deno.test("backfillIdleTaskLabels - captures gh failure and continues sweep", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    // The second positional arg in our query is `--repo`, then the repo name.
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
    if (repo === "org/broken") {
      return Promise.reject(new Error("HTTP 502 from gh"));
    }
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 9,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/broken", "org/ok"],
    ghCommandFn,
    addLabelFn: stub.fn,
    log: (event) => events.push(event),
  });

  // Per-repo short-circuit: one error per failed repo, not one per title.
  assertEquals(summary.errors.length, 1);
  assertEquals(summary.errors[0]!.repo, "org/broken");
  assert(summary.errors[0]!.message.includes("HTTP 502"));
  // The healthy repo was still swept after the broken one failed.
  assertEquals(summary.labelled, [{ repo: "org/ok", number: 9 }]);
  assertEquals(stub.calls.length, 1);
  assertEquals(stub.calls[0]!.repo, "org/ok");
});

Deno.test("backfillIdleTaskLabels - ignores partial title matches", async () => {
  const events: BackfillEvent[] = [];
  const stub = makeStubAddLabel();
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 1,
        title: "Run a security scan in /tmp",
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
      {
        number: 2,
        title: `${SECURITY_SCAN_ISSUE_TITLE} (follow-up)`,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
      {
        number: 3,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn: stub.fn,
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled, [{ repo: "org/repo", number: 3 }]);
  assertEquals(summary.alreadyLabelled, 0);
  assertEquals(summary.errors.length, 0);
  assertEquals(stub.calls, [
    { repo: "org/repo", number: 3, label: IDLE_TASK_LABEL },
  ]);
});

Deno.test("backfillIdleTaskLabels - empty repo list returns empty summary", async () => {
  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: [],
    ghCommandFn: () => Promise.reject(new Error("should not be called")),
  });
  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.alreadyLabelled, 0);
  assertEquals(summary.errors.length, 0);
});

Deno.test("formatBackfillEvent - renders each event kind", () => {
  assertEquals(
    formatBackfillEvent({ kind: "labelled", repo: "org/repo", number: 7 }),
    "[backfill] repo=org/repo issue=7 action=labelled",
  );
  assertEquals(
    formatBackfillEvent({
      kind: "alert_rescued",
      repo: "org/repo",
      number: 7,
      template: "test-audit",
    }),
    "[idle-task] ALERT severity=warn action=backfill_rescued " +
      "template=test-audit repo=org/repo issue=7 " +
      "url=https://github.com/org/repo/issues/7 — " +
      "orphan wrapper missing idle-task label was rescued by the backfill sweep",
  );
  assertEquals(
    formatBackfillEvent({
      kind: "already_labelled",
      repo: "org/repo",
      number: 7,
    }),
    "[backfill] repo=org/repo issue=7 action=already_labelled",
  );
  assertEquals(
    formatBackfillEvent({
      kind: "skipped_deliberately_unlabelled",
      repo: "org/repo",
      number: 7,
      removedBy: "operator",
    }),
    "[backfill] repo=org/repo issue=7 " +
      "action=skipped_deliberately_unlabelled removed_by=operator — " +
      "idle-task label was deliberately removed after filing; " +
      "leaving the re-triage in place",
  );
  assertEquals(
    formatBackfillEvent({
      kind: "error",
      repo: "org/repo",
      message: "boom",
    }),
    "[backfill] repo=org/repo action=error reason=boom",
  );
});

Deno.test(
  "IDLE_TASK_WRAPPER_TITLES - allowlist contains exactly the eighteen wrapper titles (Issues #2322, #2398, #2904, #2930, #3228, #3238, #3319, #3394, #3488, #3549, #3609, #664)",
  () => {
    assertEquals(IDLE_TASK_WRAPPER_TITLES.length, 18);
    assert(IDLE_TASK_WRAPPER_TITLES.includes(SECURITY_SCAN_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(TEST_AUDIT_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(BEST_PRACTICES_ISSUE_TITLE));
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(GITHUB_ACTIONS_AUDIT_ISSUE_TITLE),
    );
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(SUPPLY_CHAIN_READINESS_ISSUE_TITLE),
    );
    assert(IDLE_TASK_WRAPPER_TITLES.includes(ORPHAN_DEPS_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(DEAD_CODE_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(DOC_COVERAGE_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(FORMAT_DRIFT_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(DEPRECATED_API_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(BASH_SCRIPT_REFS_ISSUE_TITLE));
    assert(IDLE_TASK_WRAPPER_TITLES.includes(BASH_SYNTAX_AUDIT_ISSUE_TITLE));
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(DOCUMENTATION_AUDIT_ISSUE_TITLE),
    );
    assert(IDLE_TASK_WRAPPER_TITLES.includes(ALERT_FEED_ISSUE_TITLE));
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE),
    );
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(PRIVATE_REPO_REFERENCE_ISSUE_TITLE),
    );
    assert(
      IDLE_TASK_WRAPPER_TITLES.includes(DUPLICATED_KNOWLEDGE_ISSUE_TITLE),
    );
    assert(IDLE_TASK_WRAPPER_TITLES.includes(RETRO_ISSUE_TITLE));
  },
);

Deno.test("formatBackfillEvent - assertNever guard throws on unknown variant (Issue #2310)", () => {
  // Simulate a future variant slipping past the type checker (e.g. JSON
  // deserialised from an untrusted source). The `default` branch must
  // route to `assertNever`, which throws — a silent fall-through would
  // return `undefined` and break the structured `[backfill] ...` log.
  const rogue = {
    kind: "skipped",
    repo: "org/repo",
    number: 9,
  } as unknown as BackfillEvent;
  assertThrows(
    () => formatBackfillEvent(rogue),
    Error,
    "Unreachable",
  );
});

Deno.test("formatBackfillSummary - renders the summary line", () => {
  assertEquals(
    formatBackfillSummary({
      labelled: [{ repo: "a/b", number: 1 }, { repo: "a/b", number: 2 }],
      alreadyLabelled: 3,
      deliberatelyUnlabelled: [{ repo: "a/b", number: 4, removedBy: "op" }],
      errors: [{ repo: "a/b", message: "x" }],
    }),
    "[backfill] action=summary labelled=2 already=3 deliberately_unlabelled=1 errors=1",
  );
});

Deno.test("backfillIdleTaskLabels - addLabelToIssue failure recorded as error", async () => {
  const events: BackfillEvent[] = [];
  const ghCommandFn = (args: string[]) => {
    const searchIdx = args.indexOf("--search");
    const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
    if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
      return Promise.resolve("[]");
    }
    return Promise.resolve(JSON.stringify([
      {
        number: 5,
        title: SECURITY_SCAN_ISSUE_TITLE,
        labels: [],
        author: { login: FLEET_AUTHOR },
      },
    ]));
  };
  const addLabelFn = () =>
    Promise.resolve<Result<void>>({
      ok: false,
      error: new Error("REST and CLI both failed"),
    });

  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    addLabelFn,
    log: (event) => events.push(event),
  });

  assertEquals(summary.labelled.length, 0);
  assertEquals(summary.errors.length, 1);
  assert(summary.errors[0]!.message.includes("REST and CLI"));
  assertEquals(events[0]!.kind, "error");
});

Deno.test("backfillIdleTaskLabels - malformed gh JSON captured as error", async () => {
  const events: BackfillEvent[] = [];
  const ghCommandFn = (_args: string[]) => Promise.resolve("not-json");
  const summary = await backfillIdleTaskLabels({
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
    repos: ["org/repo"],
    ghCommandFn,
    log: (event) => events.push(event),
  });
  assertEquals(summary.errors.length, 1);
  assert(summary.errors[0]!.message.includes("malformed gh JSON"));
  assertEquals(events[0]!.kind, "error");
});

// ---------------------------------------------------------------------------
// Wrapper-author verification (Issue #1124)
// ---------------------------------------------------------------------------

/** A gh stub returning one wrapper row authored by `login`. */
function wrapperListStub(
  number: number,
  login: string | null,
): { fn: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      if (args[0] === "api") return Promise.resolve("[]");
      const searchIdx = args.indexOf("--search");
      const search = searchIdx >= 0 ? args[searchIdx + 1] : "";
      if (search !== `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`) {
        return Promise.resolve("[]");
      }
      return Promise.resolve(JSON.stringify([
        {
          number,
          title: SECURITY_SCAN_ISSUE_TITLE,
          labels: [],
          ...(login === null ? {} : { author: { login } }),
        },
      ]));
    },
  };
}

Deno.test("backfillIdleTaskLabels - asks GitHub who filed each wrapper", async () => {
  const gh = wrapperListStub(1, FLEET_AUTHOR);
  await backfillIdleTaskLabels({
    repos: ["org/repo"],
    ghCommandFn: gh.fn,
    addLabelFn: makeStubAddLabel().fn,
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
  });
  const list = gh.calls.find((args) => args[0] === "issue");
  assert(list !== undefined);
  const json = list![list!.indexOf("--json") + 1] ?? "";
  assert(
    json.split(",").includes("author"),
    "a wrapper title anybody can reproduce is not evidence the fleet filed " +
      "it; the author is the only authenticated part of the row",
  );
});

Deno.test("backfillIdleTaskLabels - a planted wrapper title is never labelled", async () => {
  const stub = makeStubAddLabel();
  const gh = wrapperListStub(4242, "drive-by-account");
  const summary = await backfillIdleTaskLabels({
    repos: ["org/repo"],
    ghCommandFn: gh.fn,
    addLabelFn: stub.fn,
    authorOptions: FLEET_OPTIONS,
    authorLog: () => {},
  });
  assertEquals(stub.calls, []);
  assertEquals(summary.labelled, []);
  assertEquals(summary.errors, []);
});

Deno.test("backfillIdleTaskLabels - a sibling fleet host's wrapper is still rescued", async () => {
  // The guard that stops the fix becoming "never write": a wrapper filed
  // by another fleet account is still the fleet's own.
  const stub = makeStubAddLabel();
  const gh = wrapperListStub(55, "sibling-fleet-host");
  const summary = await backfillIdleTaskLabels({
    repos: ["org/repo"],
    ghCommandFn: gh.fn,
    addLabelFn: stub.fn,
    authorOptions: { fleetAuthors: [FLEET_AUTHOR, "sibling-fleet-host"] },
    authorLog: () => {},
  });
  assertEquals(summary.labelled, [{ repo: "org/repo", number: 55 }]);
  assertEquals(stub.calls.length, 1);
});

Deno.test("backfillIdleTaskLabels - an unresolvable fleet writes no label and logs", async () => {
  // The chosen fail direction, asserted. This site drives a write, so the
  // harmless outcome is to write nothing: the sweep is idempotent and the
  // next run rescues the wrapper once the fleet resolves.
  const stub = makeStubAddLabel();
  const gh = wrapperListStub(77, FLEET_AUTHOR);
  const lines: string[] = [];
  const summary = await backfillIdleTaskLabels({
    repos: ["org/repo"],
    ghCommandFn: gh.fn,
    addLabelFn: stub.fn,
    authorOptions: { fleetAuthors: [] },
    authorLog: (message) => lines.push(message),
  });
  assertEquals(stub.calls, []);
  assertEquals(summary.labelled, []);
  assertEquals(lines.length, 1);
  assert(lines[0]!.includes("no `idle-task` label is written"));
});
