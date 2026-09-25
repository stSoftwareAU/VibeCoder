/**
 * Tests for setup's close-out of fleet-filed `BP-REPO-*` audit issues once
 * the read-back confirms the hardening fixed them (Issue #2629).
 *
 * Every test runs against a stub `gh`: the re-scan's read-only settings
 * endpoints answer from a table, `gh issue list` answers with a fixed set of
 * open issues, and `gh issue comment` / `gh issue close` are recorded (or
 * made to fail). Nothing touches the network and nothing sleeps.
 *
 * Each "closes" test has its "does not close" twin, so the suite pins the
 * behaviour in both directions.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  closeFixedRepoSettingsFindings,
  eligibleFindingIds,
  FINDING_STEP_KIND,
} from "../setup/repo_settings_audit_close.ts";
import type {
  HardenRepoOutcome,
  HardenResult,
  HardenStep,
} from "../lib/repo_settings_harden.ts";

const REPO = "org/repo";
const FLEET = ["stservice", "VibeCoderST"];

/** Every settings surface already hardened — the re-scan reports nothing. */
const HARDENED: Record<string, unknown> = {
  [`repos/${REPO}/actions/permissions/workflow`]: {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  },
  [`repos/${REPO}/actions/permissions`]: {
    enabled: true,
    allowed_actions: "selected",
    sha_pinning_required: true,
  },
  [`repos/${REPO}/actions/permissions/selected-actions`]: {
    patterns_allowed: ["denoland/setup-deno@*"],
  },
  [`repos/${REPO}/rules/branches/Develop`]: [
    {
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 0,
      },
    },
  ],
  [`repos/${REPO}`]: {
    visibility: "public",
    private: false,
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  },
  [`repos/${REPO}/contents/.github/CODEOWNERS`]: { name: "CODEOWNERS" },
};

/** The workflow token still read-write — the re-scan reports it. */
const TOKEN_STILL_WRITE: Record<string, unknown> = {
  ...HARDENED,
  [`repos/${REPO}/actions/permissions/workflow`]: {
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: false,
  },
};

interface Issue {
  number: number;
  body: string;
  author: string;
}

const marker = (id: string) => `<!-- finding-id: ${id} -->\n\n## Finding\n`;

interface Stub {
  gh: (args: string[]) => Promise<string>;
  comments: string[][];
  closes: string[][];
}

/**
 * A `gh` stub: `api` answers from `settings` (an Error rejects), `issue list`
 * returns `issues`, and comment/close are recorded; `failClose` / `failList`
 * make those verbs reject.
 */
function stubGh(
  settings: Record<string, unknown>,
  issues: Issue[],
  opts: { failClose?: number; failComment?: number; failList?: boolean } = {},
): Stub {
  const comments: string[][] = [];
  const closes: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      const value = settings[args[1] ?? ""];
      if (value === undefined) {
        return Promise.reject(new Error(`HTTP 404: Not Found (${args[1]})`));
      }
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(JSON.stringify(value));
    }
    if (args[0] === "issue" && args[1] === "list") {
      if (opts.failList) return Promise.reject(new Error("list refused"));
      return Promise.resolve(JSON.stringify(
        issues.map((i) => ({
          number: i.number,
          body: i.body,
          author: { login: i.author },
        })),
      ));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      comments.push(args);
      if (opts.failComment === Number(args[2])) {
        return Promise.reject(new Error("comment refused"));
      }
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "close") {
      closes.push(args);
      if (opts.failClose === Number(args[2])) {
        return Promise.reject(new Error("HTTP 403: close refused"));
      }
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, comments, closes };
}

function step(kind: HardenStep["kind"], title = `harden ${kind}`): HardenStep {
  return { kind, title, method: "PUT", endpoint: "x" };
}

function outcome(results: HardenResult[]): HardenRepoOutcome {
  return {
    results,
    coordinates: ["denoland/setup-deno"],
    referenceCount: 1,
    unreadable: [],
  };
}

const TOKEN_APPLIED = outcome([
  {
    step: step(
      "workflow-token",
      "Default GITHUB_TOKEN read-only; Actions may not create or approve pull requests",
    ),
    status: "applied",
  },
]);

async function run(
  stub: Stub,
  hardened: HardenRepoOutcome,
  fleetLogins: readonly string[] = FLEET,
) {
  const lines: string[] = [];
  const result = await closeFixedRepoSettingsFindings({
    repo: REPO,
    outcome: hardened,
    ghCommandFn: stub.gh,
    fleetLogins,
    runLabel: "setup --harden-repo-settings (2026-09-25)",
    log: (line) => lines.push(line),
    defaultBranch: "Develop",
  });
  return { result, lines };
}

// ---------------------------------------------------------------------------
// The acceptance criteria (Issue #2629)
// ---------------------------------------------------------------------------

Deno.test("a fixed finding with a fleet-filed issue gets exactly one comment and one close --reason completed", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "stservice",
    },
  ]);
  const { result, lines } = await run(stub, TOKEN_APPLIED);

  assertEquals(result.closed, [41]);
  assertEquals(result.warnings, []);
  assertEquals(lines, []);
  assertEquals(stub.comments.length, 1);
  assertEquals(stub.closes.length, 1);
  assertEquals(stub.comments[0]!.slice(0, 5), [
    "issue",
    "comment",
    "41",
    "--repo",
    REPO,
  ]);
  const body = stub.comments[0]![stub.comments[0]!.indexOf("--body") + 1]!;
  assertStringIncludes(body, "setup --harden-repo-settings (2026-09-25)");
  assertStringIncludes(body, "Default GITHUB_TOKEN read-only");
  assertStringIncludes(body, "BP-REPO-DEFAULT-TOKEN-WRITE");
  assertEquals(stub.closes[0], [
    "issue",
    "close",
    "41",
    "--repo",
    REPO,
    "--reason",
    "completed",
  ]);
});

Deno.test("a finding still reported by the re-scan closes nothing", async () => {
  const stub = stubGh(TOKEN_STILL_WRITE, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "stservice",
    },
  ]);
  const { result } = await run(stub, TOKEN_APPLIED);

  assertEquals(result.closed, []);
  assertEquals(stub.comments, []);
  assertEquals(stub.closes, []);
});

Deno.test("a failed re-scan lookup closes nothing and prints a warning", async () => {
  const stub = stubGh(
    {
      ...HARDENED,
      [`repos/${REPO}/rules/branches/Develop`]: new Error(
        "HTTP 502: Bad Gateway",
      ),
    },
    [
      {
        number: 41,
        body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
        author: "stservice",
      },
    ],
  );
  const { result, lines } = await run(stub, TOKEN_APPLIED);

  assertEquals(result.closed, []);
  assertEquals(stub.comments, []);
  assertEquals(stub.closes, []);
  assertEquals(result.warnings.length, 1);
  assertEquals(lines, result.warnings);
  assertStringIncludes(result.warnings[0]!, "re-scan");
  assertStringIncludes(result.warnings[0]!, REPO);
});

Deno.test("an issue filed by a non-fleet author with the same marker is untouched", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "outsider",
    },
    {
      number: 42,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "VibeCoderST",
    },
  ]);
  const { result } = await run(stub, TOKEN_APPLIED);

  // The fleet-filed twin is the positive control: the finding IS fixed.
  assertEquals(result.closed, [42]);
  assertEquals(stub.comments.map((a) => a[2]), ["42"]);
  assertEquals(stub.closes.map((a) => a[2]), ["42"]);
});

Deno.test("a failed close prints a warning naming the issue number and does not throw", async () => {
  const stub = stubGh(
    HARDENED,
    [
      {
        number: 41,
        body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
        author: "stservice",
      },
      {
        number: 43,
        body: marker("BP-REPO-ACTIONS-MAY-APPROVE-PRS"),
        author: "stservice",
      },
    ],
    { failClose: 41 },
  );
  const { result, lines } = await run(stub, TOKEN_APPLIED);

  // One failure never stops the next issue.
  assertEquals(result.closed, [43]);
  assertEquals(result.warnings.length, 1);
  assertStringIncludes(result.warnings[0]!, "#41");
  assertStringIncludes(result.warnings[0]!, "close refused");
  assertEquals(lines, result.warnings);
});

// ---------------------------------------------------------------------------
// The eligibility rule — both directions
// ---------------------------------------------------------------------------

Deno.test("an already-compliant setting (no step of its kind) counts as unchanged and closes", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 50,
      body: marker("BP-REPO-SHA-PIN-NOT-ENFORCED"),
      author: "stservice",
    },
  ]);
  const { result } = await run(stub, outcome([]));

  assertEquals(result.closed, [50]);
  const body = stub.comments[0]![stub.comments[0]!.indexOf("--body") + 1]!;
  assertStringIncludes(body, "already");
});

Deno.test("a step that failed, was only planned, or was skipped this run closes nothing", async () => {
  for (const status of ["failed", "planned", "skipped"] as const) {
    const stub = stubGh(HARDENED, [
      {
        number: 41,
        body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
        author: "stservice",
      },
    ]);
    const { result } = await run(
      stub,
      outcome([{ step: step("workflow-token"), status }]),
    );
    assertEquals(result.closed, [], status);
    assertEquals(stub.closes, [], status);
  }
});

Deno.test("an applied step alongside a failed one of the same kind closes nothing", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "stservice",
    },
  ]);
  const { result } = await run(
    stub,
    outcome([
      { step: step("workflow-token"), status: "applied" },
      { step: step("workflow-token"), status: "failed", detail: "HTTP 500" },
    ]),
  );
  assertEquals(result.closed, []);
});

Deno.test("a hardening pass that aborted before planning closes nothing and warns", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 50,
      body: marker("BP-REPO-SHA-PIN-NOT-ENFORCED"),
      author: "stservice",
    },
  ]);
  const { result } = await run(
    stub,
    outcome([
      {
        step: {
          kind: "ruleset-reviews",
          title: `Read repos/${REPO}`,
          method: "PUT",
          endpoint: `repos/${REPO}`,
        },
        status: "failed",
        detail: "default branch unknown: HTTP 502",
      },
    ]),
  );
  assertEquals(result.closed, []);
  assertEquals(stub.closes, []);
  assertEquals(result.warnings.length, 1);
  assertStringIncludes(result.warnings[0]!, "did not complete");
});

Deno.test("BP-WORKER-TOKEN-CAN-EDIT-RULESETS is never closed", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 60,
      body: marker("BP-WORKER-TOKEN-CAN-EDIT-RULESETS"),
      author: "stservice",
    },
  ]);
  const { result } = await run(stub, outcome([]));
  assertEquals(result.closed, []);
  assertEquals(stub.comments, []);
  assertEquals(stub.closes, []);
  assert(!("BP-WORKER-TOKEN-CAN-EDIT-RULESETS" in FINDING_STEP_KIND));
});

Deno.test("secret-scanning findings close only on a positive read of 'enabled'", async () => {
  // A token without admin sees no security_and_analysis: the scanner reports
  // nothing, but nothing is confirmed either.
  const hidden = { ...HARDENED, [`repos/${REPO}`]: { visibility: "public" } };
  const issues = [
    {
      number: 70,
      body: marker("BP-REPO-SECRET-SCANNING-OFF"),
      author: "stservice",
    },
  ];
  const blind = stubGh(hidden, issues);
  assertEquals((await run(blind, outcome([]))).result.closed, []);

  const seen = stubGh(HARDENED, issues);
  assertEquals((await run(seen, outcome([]))).result.closed, [70]);
});

Deno.test("a private repo whose secret scanning stays off (exempted) closes nothing", async () => {
  const exempt = {
    ...HARDENED,
    [`repos/${REPO}`]: {
      visibility: "private",
      private: true,
      security_and_analysis: {
        secret_scanning: { status: "disabled" },
        secret_scanning_push_protection: { status: "disabled" },
      },
    },
  };
  const stub = stubGh(exempt, [
    {
      number: 70,
      body: marker("BP-REPO-SECRET-SCANNING-OFF"),
      author: "stservice",
    },
    {
      number: 71,
      body: marker("BP-REPO-PUSH-PROTECTION-OFF"),
      author: "stservice",
    },
  ]);
  const { result } = await run(stub, outcome([]));
  assertEquals(result.closed, []);
  assertEquals(stub.closes, []);
});

Deno.test("CODEOWNERS-NOT-ENFORCED closes only when CODEOWNERS exists and the rule is enforced", async () => {
  const issues = [
    {
      number: 80,
      body: marker("BP-REPO-CODEOWNERS-NOT-ENFORCED"),
      author: "stservice",
    },
  ];
  // No CODEOWNERS file: the scanner does not make the check, so its absence
  // proves nothing.
  const noFile = { ...HARDENED };
  delete noFile[`repos/${REPO}/contents/.github/CODEOWNERS`];
  const blind = stubGh(noFile, issues);
  assertEquals((await run(blind, outcome([]))).result.closed, []);

  const seen = stubGh(HARDENED, issues);
  assertEquals((await run(seen, outcome([]))).result.closed, [80]);
});

Deno.test("an unreadable CODEOWNERS lookup is a failed re-scan: closes nothing, warns", async () => {
  const stub = stubGh(
    {
      ...HARDENED,
      [`repos/${REPO}/contents/.github/CODEOWNERS`]: new Error("HTTP 502"),
    },
    [
      {
        number: 41,
        body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
        author: "stservice",
      },
    ],
  );
  const { result } = await run(stub, TOKEN_APPLIED);
  assertEquals(result.closed, []);
  assertEquals(result.warnings.length, 1);
});

Deno.test("a failed comment warns naming the issue and leaves it open", async () => {
  const stub = stubGh(
    HARDENED,
    [
      {
        number: 41,
        body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
        author: "stservice",
      },
    ],
    { failComment: 41 },
  );
  const { result } = await run(stub, TOKEN_APPLIED);
  assertEquals(result.closed, []);
  assertEquals(stub.closes, []);
  assertEquals(result.warnings.length, 1);
  assertStringIncludes(result.warnings[0]!, "#41");
});

Deno.test("a failed issue list closes nothing and warns", async () => {
  const stub = stubGh(HARDENED, [], { failList: true });
  const { result } = await run(stub, TOKEN_APPLIED);
  assertEquals(result.closed, []);
  assertEquals(result.warnings.length, 1);
  assertStringIncludes(result.warnings[0]!, "list refused");
});

Deno.test("an empty fleet login list closes nothing and warns", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "stservice",
    },
  ]);
  const { result } = await run(stub, TOKEN_APPLIED, []);
  assertEquals(result.closed, []);
  assertEquals(stub.closes, []);
  assertEquals(result.warnings.length, 1);
});

Deno.test("fleet login matching is case-insensitive", async () => {
  const stub = stubGh(HARDENED, [
    {
      number: 41,
      body: marker("BP-REPO-DEFAULT-TOKEN-WRITE"),
      author: "StService",
    },
  ]);
  const { result } = await run(stub, TOKEN_APPLIED);
  assertEquals(result.closed, [41]);
});

Deno.test("an unrelated finding id not in the step map is never closed", async () => {
  const stub = stubGh(HARDENED, [
    { number: 90, body: marker("BP-REPO-SOMETHING-NEW"), author: "stservice" },
  ]);
  const { result } = await run(stub, outcome([]));
  assertEquals(result.closed, []);
});

Deno.test("never throws — a gh seam that throws synchronously is a warning", async () => {
  const lines: string[] = [];
  const result = await closeFixedRepoSettingsFindings({
    repo: REPO,
    outcome: TOKEN_APPLIED,
    ghCommandFn: () => {
      throw new Error("boom");
    },
    fleetLogins: FLEET,
    runLabel: "setup",
    log: (line) => lines.push(line),
    defaultBranch: "Develop",
  });
  assertEquals(result.closed, []);
  assert(result.warnings.length >= 1);
});

// ---------------------------------------------------------------------------
// The mapping itself
// ---------------------------------------------------------------------------

Deno.test("eligibleFindingIds - applied or absent kinds are eligible; failed, planned or skipped are not", () => {
  const ids = eligibleFindingIds(
    outcome([
      { step: step("workflow-token"), status: "applied" },
      { step: step("sha-pinning-required"), status: "planned" },
      { step: step("actions-allow-list"), status: "skipped" },
      { step: step("secret-scanning"), status: "failed" },
    ]),
  );
  assertEquals(
    [...ids].sort(),
    [
      "BP-REPO-ACTIONS-MAY-APPROVE-PRS",
      "BP-REPO-CODEOWNERS-NOT-ENFORCED",
      "BP-REPO-DEFAULT-TOKEN-WRITE",
      "BP-REPO-RULESET-NO-REVIEW",
    ],
  );
});

Deno.test("FINDING_STEP_KIND covers every BP-REPO id the scanner files", async () => {
  const source = await Deno.readTextFile(
    new URL("../lib/repo_settings_scanner.ts", import.meta.url),
  );
  const filed = [...source.matchAll(/findingId: "(BP-REPO-[A-Z0-9-]+)"/g)]
    .map((m) => m[1]!).sort();
  assert(filed.length > 0);
  assertEquals(Object.keys(FINDING_STEP_KIND).sort(), filed);
});
