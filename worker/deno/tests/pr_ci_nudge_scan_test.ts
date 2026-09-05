/**
 * Tests for pr_ci_nudge_scan.ts — periodic CI-nudge scan (Issue #2100).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MIN_AGE_SECONDS,
  findPrsNeedingCiNudge,
  NUDGE_COMMENT_MARKER,
  processCiNudgeCandidate,
} from "../lib/pr_ci_nudge_scan.ts";
import { resolveFleetMaintenanceAuthorSet } from "../lib/fleet_authors.ts";
import { INVITATION_PR_FIELDS } from "../lib/pr_invitation_lookup.ts";

const USER = "vibe-coder";
const REPO = "owner/repo";
/** The fleet login the nudge stubs write their own marker comments as. */
const FLEET_LOGIN = "vibe-coder-bot";
/** Fleet identity the marker-author check is given instead of a config. */
const FLEET_DEDUP = { fleetAuthors: [FLEET_LOGIN] };

/**
 * Whether a captured `gh` call is the invitation listing (Issue #4077).
 *
 * Both listings are `gh pr list --author …`; only the invitation listing
 * asks for the fields the invitation predicate needs.
 */
function isInvitationListing(call: string[]): boolean {
  if (call[0] !== "pr" || call[1] !== "list") return false;
  const json = call[call.indexOf("--json") + 1] ?? "";
  return INVITATION_PR_FIELDS.every((field) => json.split(",").includes(field));
}

interface PrFixture {
  number: number;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
  /** Status returned by getCiStartStatus stub for this PR. */
  ciStatus?: "started" | "queued" | "none";
  /** GitHub mergeability the `gh pr list` stub reports (Issue #52). */
  mergeable?: string;
}

/** Build a stub `gh` runner driven by per-repo PR fixtures and a status map. */
function buildGhStub(
  fixtures: Record<string, PrFixture[]>,
  options: {
    commentSnapshot?: Record<string, string>;
    onCall?: (args: string[]) => void;
  } = {},
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    options.onCall?.(args);

    if (args[0] === "pr" && args[1] === "list") {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
      const prs = fixtures[repo] ?? [];
      const json = prs.map((p) => ({
        number: p.number,
        headRefName: p.headRefName,
        headRefOid: p.headRefOid,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        author: { login: p.authorLogin },
        mergeable: p.mergeable,
      }));
      return Promise.resolve(JSON.stringify(json));
    }

    if (args[0] === "api") {
      const path = args[1] ?? "";
      const m = path.match(
        /^repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs/,
      );
      if (m) {
        const repo = m[1]!;
        const sha = m[2]!;
        const pr = (fixtures[repo] ?? []).find((p) => p.headRefOid === sha);
        const status = pr?.ciStatus ?? "none";
        if (status === "started") {
          return Promise.resolve(JSON.stringify({
            total_count: 1,
            check_runs: [{ id: 1, name: "x", status: "in_progress" }],
          }));
        }
        return Promise.resolve(
          JSON.stringify({ total_count: 0, check_runs: [] }),
        );
      }
      const m2 = path.match(
        /^repos\/([^/]+\/[^/]+)\/actions\/runs\?head_sha=([^&]+)/,
      );
      if (m2) {
        const repo = m2[1]!;
        const sha = m2[2]!;
        const pr = (fixtures[repo] ?? []).find((p) => p.headRefOid === sha);
        if (pr?.ciStatus === "queued") {
          return Promise.resolve(JSON.stringify({
            workflow_runs: [
              {
                id: 555,
                status: "queued",
                head_sha: sha,
                created_at: "2026-05-18T00:00:00Z",
              },
            ],
          }));
        }
        return Promise.resolve(JSON.stringify({ workflow_runs: [] }));
      }
      const m3 = path.match(/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments/);
      if (m3) {
        const repo = m3[1]!;
        const num = m3[2]!;
        const key = `${repo}#${num}`;
        return Promise.resolve(options.commentSnapshot?.[key] ?? "[]");
      }
    }

    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// findPrsNeedingCiNudge
// ---------------------------------------------------------------------------

Deno.test("findPrsNeedingCiNudge - returns Vibe Coder PR older than 5min with no CI", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 10,
        headRefName: "vibe/fix",
        headRefOid: "sha10",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: USER,
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0]!.prNumber, 10);
  assertEquals(result.value[0]!.status, "none");
  assertEquals(result.value[0]!.headSha, "sha10");
});

Deno.test("findPrsNeedingCiNudge - never returns a non-Vibe-Coder PR", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 20,
        headRefName: "human/fix",
        headRefOid: "sha20",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        // Author is a human; the stub's `--author` filter mirrors the
        // server-side filter the real `gh pr list` applies, but we also
        // verify the defensive client-side guard by injecting a stray PR
        // with a different author.
        authorLogin: "human-dev",
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  // For this test, force the stub to return the human PR regardless of
  // the --author filter by patching the fixtures under the same repo.
  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  // Defensive author guard must drop the non-USER PR.
  assertEquals(result.value.length, 0);
});

Deno.test("findPrsNeedingCiNudge - skips PR younger than minAgeSec", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 30,
        headRefName: "vibe/fresh",
        headRefOid: "sha30",
        createdAt: "2026-05-18T00:09:00Z",
        updatedAt: "2026-05-18T00:09:00Z",
        authorLogin: USER,
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 0);
});

Deno.test("findPrsNeedingCiNudge - skips PRs with status started even if old", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 40,
        headRefName: "vibe/running",
        headRefOid: "sha40",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: USER,
        ciStatus: "started",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T01:00:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 0);
});

Deno.test("findPrsNeedingCiNudge - returns queued PRs", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 50,
        headRefName: "vibe/queued",
        headRefOid: "sha50",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: USER,
        ciStatus: "queued",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0]!.status, "queued");
});

Deno.test("findPrsNeedingCiNudge - default minAge is 5 minutes", () => {
  assertEquals(DEFAULT_MIN_AGE_SECONDS, 300);
});

Deno.test("findPrsNeedingCiNudge - per-repo list failure is logged and skipped", async () => {
  const failing = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.reject(new Error("boom"));
    }
    return Promise.resolve("[]");
  };
  const logs: string[] = [];
  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: failing,
    log: (m) => logs.push(m),
  });
  assert(result.ok);
  assertEquals(result.value.length, 0);
  assert(logs.some((l) => l.includes("list failed")));
});

// ---------------------------------------------------------------------------
// processCiNudgeCandidate
// ---------------------------------------------------------------------------

Deno.test("processCiNudgeCandidate - posts audit comment exactly once (none path)", async () => {
  const ghCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const gh = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  const git = (args: string[]) => {
    gitCalls.push(args);
    return Promise.resolve("");
  };

  const result = await processCiNudgeCandidate(
    {
      repo: REPO,
      prNumber: 99,
      headBranch: "vibe/foo",
      headSha: "abc1234",
      status: "none",
    },
    { ghCommandFn: gh, gitCommandFn: git },
  );

  assert(result.ok);
  assertEquals(result.value.nudge.action, "empty-commit");
  assertEquals(result.value.commentPosted, true);

  // Exactly one `pr comment` call posted.
  const commentCalls = ghCalls.filter((a) =>
    a[0] === "pr" && a[1] === "comment"
  );
  assertEquals(commentCalls.length, 1);
  // Body contains the marker.
  const bodyIdx = commentCalls[0]!.indexOf("--body");
  assert(bodyIdx >= 0);
  assert(commentCalls[0]![bodyIdx + 1]!.includes(NUDGE_COMMENT_MARKER));

  // The git commands for empty-commit path fired.
  assert(gitCalls.some((a) => a[0] === "checkout"));
  assert(gitCalls.some((a) => a[0] === "commit"));
  assert(gitCalls.some((a) => a[0] === "push"));
});

Deno.test("processCiNudgeCandidate - a nudge marker planted by an outsider does not skip the comment (Issue #1216)", async () => {
  // Suppressing the audit comment on a body match alone let any account erase
  // the nudge's paper trail by posting the marker itself.
  const ghCalls: string[][] = [];
  const gh = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.resolve(JSON.stringify([
        {
          id: 1,
          body: `${NUDGE_COMMENT_MARKER}\nnot the worker`,
          user: { login: "drive-by-attacker" },
        },
      ]));
    }
    return Promise.resolve(JSON.stringify({
      workflow_runs: [
        { id: 7, status: "queued", created_at: "2026-05-18T00:00:00Z" },
      ],
    }));
  };
  const git = (_args: string[]) => Promise.resolve("");

  const result = await processCiNudgeCandidate(
    {
      repo: REPO,
      prNumber: 99,
      headBranch: "vibe/foo",
      headSha: "abc1234",
      status: "queued",
    },
    { ghCommandFn: gh, gitCommandFn: git, dedupAuthors: FLEET_DEDUP },
  );

  assert(result.ok);
  assertEquals(result.value.commentPosted, true);
  assert(ghCalls.some((a) => a[0] === "pr" && a[1] === "comment"));
});

Deno.test("processCiNudgeCandidate - dedup: existing marker skips comment", async () => {
  const ghCalls: string[][] = [];
  const gh = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.resolve(JSON.stringify([
        {
          id: 1,
          body: `${NUDGE_COMMENT_MARKER}\nearlier nudge`,
          user: { login: FLEET_LOGIN },
        },
      ]));
    }
    return Promise.resolve(JSON.stringify({
      workflow_runs: [
        { id: 7, status: "queued", created_at: "2026-05-18T00:00:00Z" },
      ],
    }));
  };
  const git = (_args: string[]) => Promise.resolve("");

  const result = await processCiNudgeCandidate(
    {
      repo: REPO,
      prNumber: 99,
      headBranch: "vibe/foo",
      headSha: "abc1234",
      status: "queued",
    },
    { ghCommandFn: gh, gitCommandFn: git, dedupAuthors: FLEET_DEDUP },
  );

  assert(result.ok);
  assertEquals(result.value.commentPosted, false);
  // No `pr comment` call should have been made.
  assert(!ghCalls.some((a) => a[0] === "pr" && a[1] === "comment"));
});

Deno.test("processCiNudgeCandidate - queued path runs gh run rerun", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("actions/runs")) {
      return Promise.resolve(JSON.stringify({
        workflow_runs: [
          { id: 8888, status: "queued", created_at: "2026-05-18T00:00:00Z" },
        ],
      }));
    }
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  const git = (_args: string[]) => Promise.resolve("");

  const result = await processCiNudgeCandidate(
    {
      repo: REPO,
      prNumber: 101,
      headBranch: "vibe/queued",
      headSha: "shaQ",
      status: "queued",
    },
    { ghCommandFn: gh, gitCommandFn: git },
  );

  assert(result.ok);
  assertEquals(result.value.nudge.action, "rerun");
  const rerun = calls.find((a) => a[0] === "run" && a[1] === "rerun");
  assert(rerun);
});

// ---------------------------------------------------------------------------
// Fleet-author scoping — sibling rescue (#4023) without adopting human PRs
// (#4074/#4076)
// ---------------------------------------------------------------------------

/** Sibling fleet host (`fleet_pr_authors`) — its PRs are still nudged. */
const SIBLING = "maintainer";
/** Trusted human (`allowed_authors`) — their PRs are never nudged. */
const HUMAN_AUTHOR = "courtyen";

Deno.test("findPrsNeedingCiNudge - returns a sibling fleet host's PR (Issue #4023)", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 103,
        headRefName: "milestone/69-cache",
        headRefOid: "sha103",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: SIBLING,
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    fleetPrAuthors: [SIBLING],
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  // De-duplicated across the per-author queries the stub answers alike.
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0]!.prNumber, 103);
});

Deno.test("findPrsNeedingCiNudge - queries the push-capable maintenance set only (Issue #4076)", async () => {
  const queried: string[] = [];
  const stub = buildGhStub({}, {
    onCall: (args) => {
      // Issue #4077: the separate invitation listing is asserted below —
      // it is told apart by the fields only it asks for.
      if (
        args[0] === "pr" && args[1] === "list" && !isInvitationListing(args)
      ) {
        const idx = args.indexOf("--author");
        if (idx >= 0) queried.push(args[idx + 1]!);
      }
    },
  });

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    allowedAuthors: [HUMAN_AUTHOR],
    fleetPrAuthors: ["stsvcbot"],
    repos: [REPO],
    ghCommandFn: stub,
    nowSeconds: () => 0,
  });

  assert(result.ok);
  assertEquals(
    queried,
    // Issue #4076: the scan comments on the PRs it finds, so it resolves
    // through the push-capable set — the human login never reaches `gh`.
    resolveFleetMaintenanceAuthorSet({
      githubUser: USER,
      allowedAuthors: [HUMAN_AUTHOR],
      fleetPrAuthors: ["stsvcbot"],
    }),
  );
  assertEquals(queried.includes(HUMAN_AUTHOR), false);
});

Deno.test("findPrsNeedingCiNudge - post-list guard drops an allowed-author PR (Issue #4076)", async () => {
  // The stub answers every `--author` query with the same list, so the
  // human PR reaches the post-list guard even though the query filter
  // would have excluded it — the guard must be checked against the
  // maintenance set, not the wider fleet-owned set.
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 2312,
        headRefName: "courtyen/hand-written-fix",
        headRefOid: "sha2312",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: HUMAN_AUTHOR,
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    allowedAuthors: [HUMAN_AUTHOR],
    fleetPrAuthors: ["stsvcbot"],
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 0);
});

Deno.test("findPrsNeedingCiNudge - a non-fleet author is still dropped (Issue #4023)", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 44,
        headRefName: "human/fix",
        headRefOid: "sha44",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: "outsider",
        ciStatus: "none",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    fleetPrAuthors: [SIBLING],
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 0);
});

// ---------------------------------------------------------------------------
// Explicit invitation onto a human-authored PR (Issue #4077)
// ---------------------------------------------------------------------------

/** The human's PR number, mirroring TitlePage/tp-web-react#2312. */
const HUMAN_PR = 2312;

/**
 * Build a `gh` stub whose only open PR is the human's, returned by the
 * invitation listing alone, with CI never started.
 */
function buildInvitedPrGh(
  invitation: {
    labels?: Array<{ name: string }>;
    labelledBy?: string;
    comments?: Array<{ author: { login: string }; body: string }>;
  },
  log?: (message: string) => void,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      if (!key.includes(`--author ${HUMAN_AUTHOR}`)) {
        return Promise.resolve("[]");
      }
      return Promise.resolve(JSON.stringify([{
        number: HUMAN_PR,
        headRefName: "courtyen/hand-written-fix",
        headRefOid: "sha2312",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        author: { login: HUMAN_AUTHOR },
        labels: invitation.labels ?? [],
        comments: invitation.comments ?? [],
        reviews: [],
      }]));
    }
    if (key.includes("timeline")) {
      const events = invitation.labelledBy === undefined ? [] : [{
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: invitation.labelledBy },
        created_at: "2026-05-18T00:00:00Z",
      }];
      return Promise.resolve(JSON.stringify(events));
    }
    if (key.includes("check-runs")) {
      return Promise.resolve(
        JSON.stringify({ total_count: 0, check_runs: [] }),
      );
    }
    if (key.includes("actions/runs")) {
      return Promise.resolve(JSON.stringify({ workflow_runs: [] }));
    }
    log?.(key);
    return Promise.resolve("[]");
  };
}

Deno.test("findPrsNeedingCiNudge - nudges a human PR the author handed over (Issue #4077)", async () => {
  const lines: string[] = [];
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    allowedAuthors: [HUMAN_AUTHOR],
    fleetPrAuthors: [SIBLING],
    repos: [REPO],
    ghCommandFn: buildInvitedPrGh({
      labels: [{ name: "work-on" }],
      labelledBy: HUMAN_AUTHOR,
    }),
    nowSeconds: () => now,
    log: (message) => lines.push(message),
  });

  assert(result.ok);
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0]!.prNumber, HUMAN_PR);
  assertEquals(
    lines.filter((l) => l.startsWith("[pr-invitation] admitted")),
    [
      `[pr-invitation] admitted repo=${REPO} prNumber=${HUMAN_PR} ` +
      `author=${HUMAN_AUTHOR} via=label invitedBy=${HUMAN_AUTHOR}`,
    ],
  );
});

Deno.test("findPrsNeedingCiNudge - an uninvited human PR is still never nudged (Issue #4077)", async () => {
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    allowedAuthors: [HUMAN_AUTHOR],
    fleetPrAuthors: [SIBLING],
    repos: [REPO],
    // The label is present but an untrusted actor applied it.
    ghCommandFn: buildInvitedPrGh({
      labels: [{ name: "work-on" }],
      labelledBy: "drive-by",
      comments: [{ author: { login: "drive-by" }, body: `@${USER} fix this` }],
    }),
    nowSeconds: () => now,
  });

  assert(result.ok);
  assertEquals(result.value.length, 0);
});

Deno.test("findPrsNeedingCiNudge - skips a CONFLICTING PR (CI cannot start) (Issue #52)", async () => {
  const fixtures: Record<string, PrFixture[]> = {
    [REPO]: [
      {
        number: 48,
        headRefName: "issue-16-fix",
        headRefOid: "sha48",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: USER,
        ciStatus: "none",
        mergeable: "CONFLICTING",
      },
      {
        number: 49,
        headRefName: "issue-17-fix",
        headRefOid: "sha49",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
        authorLogin: USER,
        ciStatus: "none",
        mergeable: "MERGEABLE",
      },
    ],
  };
  const now = Math.floor(Date.parse("2026-05-18T00:10:00Z") / 1000);
  const logs: string[] = [];

  const result = await findPrsNeedingCiNudge({
    githubUser: USER,
    repos: [REPO],
    ghCommandFn: buildGhStub(fixtures),
    nowSeconds: () => now,
    log: (m) => logs.push(m),
  });

  assert(result.ok);
  // Only the mergeable PR is a candidate; the conflicting one is skipped.
  assertEquals(result.value.map((c) => c.prNumber), [49]);
  assert(
    logs.some((l) => l.includes("#48") && l.includes("conflicting")),
    `expected a skip log for #48: ${logs.join(" | ")}`,
  );
});
