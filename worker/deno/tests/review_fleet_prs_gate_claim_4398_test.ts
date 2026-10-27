/**
 * The review-fleet-prs gate and review claims (Issue #4398).
 *
 * Several hosts gate the same PRs. A ready PR that another host holds a live
 * review claim on at its current head is `claimed-elsewhere`: it is not ready,
 * it never takes a slot, and no file list is read for it. This host's own
 * claim does not count (its own rounds are `in-flight`), and an expired claim,
 * a claim at an old head, or a human comment quoting the marker in prose does
 * not count either. The claim race itself is covered in
 * review_fleet_prs_claim_4398_test.ts.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  pass,
  type Review,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import { claimBody } from "../../../.claude/skills/review-fleet-prs/scripts/claim.ts";

const REVIEWER = "nleck";
const FLEET = new Set(["VibeCoderST"]);
const REPOS = new Set(["acme/app"]);
// A fixed clock for the pass; claims expire LIVE_MS after it unless stated.
const NOW = Date.parse("2026-10-26T10:00:00Z");
const LIVE_MS = 600_000;
const GATE = decodeURIComponent(
  new URL(
    "../../../.claude/skills/review-fleet-prs/scripts/gate.ts",
    import.meta.url,
  )
    .pathname,
);

const review = (login: string, state: string, oid: string): Review => ({
  author: { login },
  state,
  body: "",
  commit: { oid },
});

const green = {
  nodes: [{
    commit: {
      statusCheckRollup: { state: "SUCCESS" },
      checkSuites: { nodes: [] },
    },
  }],
};
const red = {
  nodes: [{
    commit: {
      statusCheckRollup: { state: "FAILURE" },
      checkSuites: { nodes: [] },
    },
  }],
};

function fleetPr(
  number: number,
  overrides: Partial<SearchPr> = {},
): SearchPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: { enabledAt: "2026-10-05T00:00:00Z" },
    headRefOid: `head-${number}`,
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
    },
    author: { login: "VibeCoderST" },
    commits: green,
    reviews: { nodes: [] },
    ...overrides,
  };
}

// One comment as GitHub's list-comments endpoint returns it, created just
// before NOW so that a claim's clamp (two hours after creation) does not bite.
type Row = {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
};
const row = (id: number, body: string, login: string): Row => ({
  id,
  body,
  created_at: new Date(NOW - 120_000).toISOString(),
  user: { login },
});

// Fake gh for one pass. `store` is the PR's comment thread, read on every
// call, so a test can post a claim between passes.
function makeGh(prs: SearchPr[], store: Row[], failComments = false) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: prs,
          },
        },
      }));
    }
    if (args[0] === "api" && args[1]?.endsWith("/files")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      if (failComments) {
        return Promise.reject(new Error("gh: HTTP 500: Internal Server Error"));
      }
      return Promise.resolve(JSON.stringify(store));
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

const fileCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "api" && c[1]?.endsWith("/files")).length;
const commentCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "api" && c[1]?.endsWith("/comments")).length;

Deno.test("claim (Issue #4398): another host's live claim at the head skips the PR as claimed-elsewhere, and this host's own claim does not", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prs = [fleetPr(12)];
    const store = [
      row(1, claimBody("head-12", "laptop", NOW + LIVE_MS), "laptop"),
    ];

    const other = makeGh(prs, store);
    const elsewhere = await pass(REPOS, FLEET, REVIEWER, {
      gh: other.gh,
      dir,
      host: "grq-25",
      now: () => NOW,
    });
    assertEquals(elsewhere.ready, []);
    assertEquals(elsewhere.skipped, { "claimed-elsewhere": 1 });
    // No file list is read for a PR another host holds.
    assertEquals(fileCalls(other.calls), 0);

    const own = makeGh(prs, store);
    const mine = await pass(REPOS, FLEET, REVIEWER, {
      gh: own.gh,
      dir,
      host: "laptop",
      now: () => NOW,
    });
    assertEquals(mine.ready.map((p) => p.number), [12]);
    assertEquals(mine.skipped, {});
    assertEquals(fileCalls(own.calls), 1);

    // Without --host the host is "", so every live claim counts as elsewhere.
    const anon = makeGh(prs, store);
    const noHost = await pass(REPOS, FLEET, REVIEWER, {
      gh: anon.gh,
      dir,
      now: () => NOW,
    });
    assertEquals(noHost.ready, []);
    assertEquals(noHost.skipped, { "claimed-elsewhere": 1 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claim (Issue #4398): two hosts gating the same ready PR: both see it ready before a claim; once A's claim is posted B skips it and A still reviews it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prs = [fleetPr(12)];
    const store: Row[] = [];
    const beforeA = await pass(REPOS, FLEET, REVIEWER, {
      gh: makeGh(prs, store).gh,
      dir,
      host: "laptop",
      now: () => NOW,
    });
    const beforeB = await pass(REPOS, FLEET, REVIEWER, {
      gh: makeGh(prs, store).gh,
      dir,
      host: "grq-25",
      now: () => NOW,
    });
    assertEquals(beforeA.ready.map((p) => p.number), [12]);
    assertEquals(beforeB.ready.map((p) => p.number), [12]);

    // Host A's claim is now in the thread, as claim.ts would post it.
    store.push(row(1, claimBody("head-12", "laptop", NOW + LIVE_MS), "laptop"));

    const afterB = await pass(REPOS, FLEET, REVIEWER, {
      gh: makeGh(prs, store).gh,
      dir,
      host: "grq-25",
      now: () => NOW,
    });
    assertEquals(afterB.ready, []);
    assertEquals(afterB.skipped, { "claimed-elsewhere": 1 });

    const afterA = await pass(REPOS, FLEET, REVIEWER, {
      gh: makeGh(prs, store).gh,
      dir,
      host: "laptop",
      now: () => NOW,
    });
    assertEquals(afterA.ready.map((p) => p.number), [12]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claim (Issue #4398): an expired claim, a claim at an old head, and a human comment quoting the marker are all ignored", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prose =
      `Quoting the marker: <!-- vibe-review-claim sha=head-12 host=laptop expires=${
        new Date(NOW + LIVE_MS).toISOString()
      } --> is what a claim looks like.`;
    const store = [
      // Expired before NOW.
      row(1, claimBody("head-12", "laptop", NOW - 1000), "laptop"),
      // Live, but at a head the PR has since moved past.
      row(2, claimBody("head-11", "laptop", NOW + LIVE_MS), "laptop"),
      // Live-looking, but written in prose by a human.
      row(3, prose, "owner"),
    ];
    const { gh, calls } = makeGh([fleetPr(12)], store);
    const result = await pass(REPOS, FLEET, REVIEWER, {
      gh,
      dir,
      host: "grq-25",
      now: () => NOW,
    });
    assertEquals(result.ready.map((p) => p.number), [12]);
    assertEquals(result.skipped, {});
    assertEquals(fileCalls(calls), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claim (Issue #4398): a claimed PR never takes a slot, whichever order the PRs come in", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = [
      row(1, claimBody("head-11", "laptop", NOW + LIVE_MS), "laptop"),
    ];
    const opts = { dir, limit: 1, host: "grq-25", now: () => NOW };

    // The claimed PR comes first: the free PR takes the one slot.
    const claimedFirst = makeGh([fleetPr(11), fleetPr(12)], store);
    const a = await pass(REPOS, FLEET, REVIEWER, {
      ...opts,
      gh: claimedFirst.gh,
    });
    assertEquals(a.ready.map((p) => p.number), [12]);
    assertEquals(a.skipped, { "claimed-elsewhere": 1 });

    // The free PR comes first and fills the slot: the claimed PR must still
    // be reported as claimed, not as over-limit.
    const freeFirst = makeGh([fleetPr(12), fleetPr(11)], store);
    const b = await pass(REPOS, FLEET, REVIEWER, { ...opts, gh: freeFirst.gh });
    assertEquals(b.ready.map((p) => p.number), [12]);
    assertEquals(b.skipped, { "claimed-elsewhere": 1 });
    assertEquals(fileCalls(freeFirst.calls), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claim (Issue #4398): only an otherwise-ready PR costs a comments read; a red, approved or in-flight PR costs none", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prs = [
      fleetPr(10, { commits: red }),
      fleetPr(11, {
        reviews: { nodes: [review("owner", "APPROVED", "head-11")] },
      }),
      fleetPr(12),
      fleetPr(13),
    ];
    const { gh, calls } = makeGh(prs, []);
    const result = await pass(REPOS, FLEET, REVIEWER, {
      gh,
      dir,
      inFlight: new Set(["acme/app#13"]),
      now: () => NOW,
    });
    assertEquals(result.ready.map((p) => p.number), [12]);
    assertEquals(result.skipped, {
      "ci-failed": 1,
      approved: 1,
      "in-flight": 1,
    });
    assertEquals(commentCalls(calls), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claim (Issue #4398): a failed comments read fails the pass loudly, naming the PR, rather than reading as no claim", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { gh } = makeGh([fleetPr(12)], [], true);
    await assertRejects(
      () =>
        pass(REPOS, FLEET, REVIEWER, {
          gh,
          dir,
          host: "grq-25",
          now: () => NOW,
        }),
      Error,
      "acme/app#12: listing comments failed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// gate.ts's main() reads --host and passes it to pass(). A subprocess run
// with a gh shim on PATH pins that wiring: the claim is by grq-25, so the
// PR is ready only when the gate is told it is grq-25.
Deno.test("claim (Issue #4398): gate.ts --host=<name> reaches pass(), so this host's own claim does not skip its PR", async () => {
  const home = await Deno.makeTempDir();
  try {
    const bin = `${home}/bin`;
    await Deno.mkdir(bin);
    const searchFile = `${home}/search.json`;
    const commentsFile = `${home}/comments.json`;
    await Deno.writeTextFile(
      searchFile,
      JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [fleetPr(12)],
          },
        },
      }),
    );
    // Live from the real clock: the subprocess cannot take an injected now.
    const created = new Date();
    await Deno.writeTextFile(
      commentsFile,
      JSON.stringify([{
        id: 1,
        body: claimBody("head-12", "grq-25", Date.now() + 3_600_000),
        created_at: created.toISOString(),
        user: { login: "grq-25" },
      }]),
    );
    // A gh shim: the search, the comment list, an empty file list, and a 404
    // for the checklist file, which the gate reads as absent.
    await Deno.writeTextFile(
      `${bin}/gh`,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  "api graphql"*) cat '${searchFile}' ;;`,
        `  *"/issues/12/comments"*) cat '${commentsFile}' ;;`,
        `  *"/pulls/12/files"*) echo "[]" ;;`,
        `  *"/contents/"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
        "  *) ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    const config = `${home}/config.json`;
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        fleet_pr_authors: ["VibeCoderST"],
        repos: ["acme/app"],
      }),
    );

    const run = async (extra: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-lock",
          "--allow-run=gh",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          GATE,
          `--config=${config}`,
          "--repo=acme/app",
          `--reviewer=${REVIEWER}`,
          ...extra,
        ],
        env: {
          HOME: home,
          XDG_STATE_HOME: `${home}/state`,
          PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      return JSON.parse(new TextDecoder().decode(out.stdout));
    };

    const withHost = await run(["--host=grq-25"]);
    assertEquals(withHost.ready.map((p: { number: number }) => p.number), [12]);
    assertEquals(withHost.skipped, {});

    const noHost = await run([]);
    assertEquals(noHost.ready, []);
    assertEquals(noHost.skipped, { "claimed-elsewhere": 1 });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
