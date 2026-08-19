/**
 * A human's open PR never blocks issue pickup (Issue #4133).
 *
 * The blocking guard deferred to every PR the fleet *owned* — a set that
 * includes the trusted humans in `allowed_authors` — so one unrelated
 * human PR parked a whole repo's `work-on` queue, and since #4078 also
 * stood the worker down with `needs-human`. The worker is meant to work
 * alongside the other developers, not wait on them.
 *
 * These tests lock in the replacement behaviour: a human-authored open PR
 * is invisible to the guard (issue stays claimable, no label, no comment,
 * no PR writes), while the fleet's own open PR keeps the repo-wide
 * one-at-a-time rule that stops the worker running ahead of itself.
 *
 * Supersedes the #4078 nudge-and-escalate tests this file previously
 * held: that path is unreachable now that a human PR never blocks, and
 * `escalate_human_blocking_pr.ts` was retired with it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { isHumanAuthoredPr } from "../lib/fleet_authors.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { GitHubClient, GitHubComment, WorkerConfig } from "../types.ts";
import type { EscalateUnworkableDeps } from "../lib/escalate_unworkable_work_on.ts";

const HOST = "bot";
const SIBLING = "stsvcbot";
/** A trusted human: in `allowed_authors`, never push-capable (#4075). */
const HUMAN = "alice";

// ---------------------------------------------------------------------------
// Recording harness
// ---------------------------------------------------------------------------

interface Recorder {
  labels: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
  /** Every `gh` invocation the scan made, for the zero-PR-writes assertion. */
  ghCalls: string[][];
}

function newRecorder(): Recorder {
  return { labels: [], comments: [], ghCalls: [] };
}

function recordingClient(recorder: Recorder): GitHubClient {
  const notImpl = (m: string) => () => Promise.reject(new Error(`${m} unused`));
  return {
    getIssue: notImpl("getIssue"),
    getIssueComments: (): Promise<GitHubComment[]> => Promise.resolve([]),
    addLabel: (_repo: string, issue: number, label: string) => {
      recorder.labels.push({ issue, label });
      return Promise.resolve();
    },
    removeLabel: notImpl("removeLabel"),
    postComment: (_repo: string, issue: number, body: string) => {
      recorder.comments.push({ issue, body });
      return Promise.resolve(undefined);
    },
    editIssue: notImpl("editIssue"),
    assignIssue: notImpl("assignIssue"),
    unassignIssue: notImpl("unassignIssue"),
    closeIssue: notImpl("closeIssue"),
  };
}

function escalateDeps(recorder: Recorder): EscalateUnworkableDeps {
  return {
    ghClient: recordingClient(recorder),
    ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
  };
}

/**
 * Any `gh` invocation that could mutate a pull request. A read
 * (`pr list`, `pr view`) is fine; anything else touching a PR is exactly
 * the adoption this issue forbids.
 */
function isPrWrite(args: string[]): boolean {
  const [first, second] = args;
  if (first === "pr") return second !== "list" && second !== "view";
  // `gh api .../pulls/...` with a non-GET method is a PR write too.
  if (first === "api") {
    const touchesPull = args.some((a) => a.includes("/pulls"));
    const method = args[args.indexOf("-X") + 1] ?? "";
    return touchesPull && args.includes("-X") && method !== "GET";
  }
  return false;
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: [HUMAN],
    fleetPrAuthors: [SIBLING],
    workOnLabel: "work-on",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "human-pr-block-workdir-" }),
  };
}

interface IssueSpec {
  number: number;
  title: string;
  labels: string[];
}

function createMockGh(
  specs: IssueSpec[],
  recorder: Recorder,
  /** Who added each label, as the timeline reports it. */
  labelActors: Record<string, string> = { "work-on": HUMAN },
): (args: string[]) => Promise<string> {
  const entries = specs.map((spec) => ({
    number: spec.number,
    title: spec.title,
    url: `https://github.com/owner/repo/issues/${spec.number}`,
    assignees: [],
    labels: spec.labels.map((name) => ({ name })),
    createdAt: "2026-08-01T00:00:00Z",
    author: { login: HUMAN },
    milestone: null,
    body: "No dependencies",
  }));

  return (args: string[]): Promise<string> => {
    recorder.ghCalls.push(args);
    const command = args.join(" ");

    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(entries));
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (command.includes("--json body")) {
        return Promise.resolve(JSON.stringify({ body: "No dependencies" }));
      }
      if (command.includes("number,state,title")) {
        return Promise.resolve(
          JSON.stringify({ number: 0, state: "OPEN", title: "" }),
        );
      }
      if (command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: "Blocked chore", body: "No dependencies" }),
        );
      }
    }
    if (command.includes("timeline") || command.includes("timelineItems")) {
      return Promise.resolve(
        JSON.stringify(
          Object.entries(labelActors).map(([label, actor], i) => ({
            event: "labeled",
            label: { name: label },
            actor: { login: actor },
            created_at: `2026-08-0${i + 1}T00:00:00Z`,
          })),
        ),
      );
    }
    return Promise.resolve("[]");
  };
}

function openPr(author: string): OpenPR {
  return {
    number: 103,
    title: "Tidy the config loader",
    baseRefName: "main",
    headRefName: "tidy-config",
    author,
  };
}

async function collect(
  specs: IssueSpec[],
  prs: OpenPR[],
  recorder: Recorder,
  config: WorkerConfig = makeConfig(),
  labelActors?: Record<string, string>,
) {
  const mockGh = createMockGh(specs, recorder, labelActors);
  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "human-pr-block-cache-" }),
    600,
  );
  const options: FindIssuesOptions = {
    githubUser: HOST,
    ghCommandFn: mockGh,
    cache,
    escalateDeps: escalateDeps(recorder),
  };
  return await collectWorkOnCandidates(
    "owner/repo",
    config,
    options,
    prs,
    [] as FilterableIssue[],
    createIssueFetcher(mockGh),
    [] as ClosedPR[],
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test("isHumanAuthoredPr - a trusted human's PR is human-authored", () => {
  assertEquals(isHumanAuthoredPr(HUMAN, [HOST, SIBLING]), true);
});

Deno.test("isHumanAuthoredPr - a fleet PR is not, case-insensitively", () => {
  assertEquals(isHumanAuthoredPr(HOST, [HOST, SIBLING]), false);
  assertEquals(isHumanAuthoredPr("STSVCBOT", [HOST, SIBLING]), false);
});

Deno.test("isHumanAuthoredPr - an unclassifiable author is not human", () => {
  // A pre-#4024 cache entry carries no author, and an unresolved fleet
  // set classifies nothing. Both keep the one-PR-at-a-time fail-safe.
  assertEquals(isHumanAuthoredPr("", [HOST]), false);
  assertEquals(isHumanAuthoredPr("   ", [HOST]), false);
  assertEquals(isHumanAuthoredPr(undefined, [HOST]), false);
  assertEquals(isHumanAuthoredPr(HUMAN, []), false);
  assertEquals(isHumanAuthoredPr(HUMAN, ["  "]), false);
});

// ---------------------------------------------------------------------------
// Scan behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - a human-authored open PR does not block the queue (Issue #4133)",
  async () => {
    const recorder = newRecorder();
    const result = await collect(
      [{ number: 700, title: "Blocked chore", labels: ["work-on"] }],
      [openPr(HUMAN)],
      recorder,
    );

    // The issue stays claimable — the developer's PR is unrelated to it.
    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 700);
    // No stand-down: no `needs-human`, no comment …
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
    // … and nothing touched the human's PR (#4074 policy unchanged).
    assertEquals(recorder.ghCalls.filter(isPrWrite), []);
  },
);

Deno.test(
  "collectWorkOnCandidates - the fleet's own open PR still blocks (Issue #4133)",
  async () => {
    const recorder = newRecorder();
    const result = await collect(
      [{ number: 700, title: "Blocked chore", labels: ["work-on"] }],
      [openPr(SIBLING)],
      recorder,
    );

    // One open fleet PR per repo at a time — the worker waits rather than
    // running a second PR into the same work stream.
    assertEquals(result.candidates, []);
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
    assertEquals(recorder.ghCalls.filter(isPrWrite), []);
  },
);

Deno.test(
  "collectWorkOnCandidates - an unstamped blocking PR still blocks (Issue #4133)",
  async () => {
    const recorder = newRecorder();
    const { author: _dropped, ...unstamped } = openPr(HUMAN);
    const result = await collect(
      [{ number: 700, title: "Blocked chore", labels: ["work-on"] }],
      [unstamped],
      recorder,
    );

    assertEquals(result.candidates, []);
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
  },
);

Deno.test(
  "collectWorkOnCandidates - a human PR alongside a fleet PR still blocks (Issue #4133)",
  async () => {
    const recorder = newRecorder();
    const result = await collect(
      [{ number: 700, title: "Blocked chore", labels: ["work-on"] }],
      [openPr(HUMAN), { ...openPr(SIBLING), number: 104 }],
      recorder,
    );

    assertEquals(result.candidates, []);
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
  },
);

Deno.test(
  "collectWorkOnCandidates - an unblocked work-on issue is unaffected by the guard (Issue #4133)",
  async () => {
    const recorder = newRecorder();
    const result = await collect(
      [{ number: 700, title: "Ready chore", labels: ["work-on"] }],
      [],
      recorder,
    );

    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 700);
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
  },
);
