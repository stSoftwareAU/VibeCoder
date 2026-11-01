/**
 * Shift-left detection of repeated fleet PR CI failures (Issue #4610).
 *
 * A fleet PR that fails CI costs a CI run and a second agent session. When the
 * same locally runnable check fails on several fleet PRs, the babysitter files
 * one issue in the repository that owns the fix: VibeCoder when the local gate
 * already runs the tool (the fleet raised or pushed without a passing gate),
 * or the product repository when CI runs a check the local gate lacks.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectTool,
  emptyShiftLeftLedger,
  type FailureObservation,
  formatShiftLeftIssue,
  localGateRunsTool,
  normaliseCheckLabel,
  parseShiftLeftMarker,
  recordObservations,
  repeatedFailures,
  routeShiftLeftFix,
  runShiftLeftScan,
  shiftLeftKey,
  type ShiftLeftLedger,
} from "../lib/shift_left_failures.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-01T01:00:00Z");

function obs(
  overrides: Partial<FailureObservation> = {},
): FailureObservation {
  return {
    repo: "owner/product",
    runId: 1,
    jobId: 1,
    prNumber: 10,
    headSha: "a".repeat(40),
    pushedBy: "fleet-bot",
    check: "rust-checks",
    step: "cargo clippy (warnings denied)",
    tool: "cargo clippy",
    codes: ["clippy::indexing_slicing"],
    observedAtMs: NOW - DAY,
    ...overrides,
  };
}

Deno.test("detectTool names the tool a CI step runs, most specific first", () => {
  assertEquals(detectTool("cargo clippy (warnings denied)"), "cargo clippy");
  assertEquals(
    detectTool("cargo mutants (the pull request's change)"),
    "cargo mutants",
  );
  assertEquals(detectTool("cargo llvm-cov (line coverage)"), "cargo llvm-cov");
  assertEquals(detectTool("Deno tests (shard 2 of 4)"), "deno test");
  assertEquals(detectTool("Deno type check"), "deno check");
  assertEquals(detectTool("Run markdownlint-cli2"), "markdownlint");
  assertEquals(detectTool("cargo fmt --check"), "cargo fmt");
  assertEquals(
    detectTool("deno task check:pr-summary"),
    "deno task check:pr-summary",
  );
  // Aggregators and deployment-state checks have no local tool: never counted.
  assertEquals(detectTool("Require every job to have succeeded"), null);
  assertEquals(
    detectTool(
      "Require the deployed bootstrap to carry this pull request's template",
    ),
    null,
  );
});

Deno.test("normaliseCheckLabel folds matrix shard numbers so shards share one signature", () => {
  assertEquals(
    normaliseCheckLabel("validate-scripts / validate (tests 2/4)"),
    normaliseCheckLabel("validate-scripts / validate (tests 3/4)"),
  );
  assertEquals(
    normaliseCheckLabel("Deno tests (shard 1 of 4)"),
    normaliseCheckLabel("Deno tests (shard 4 of 4)"),
  );
});

Deno.test("shiftLeftKey is stable, hides the repository name, and differs by repo", async () => {
  const a = await shiftLeftKey(
    "owner/private-repo",
    "rust-checks",
    "cargo clippy",
  );
  assertEquals(
    a,
    await shiftLeftKey("owner/private-repo", "rust-checks", "cargo clippy"),
  );
  assert(/^[0-9a-f]{16}$/.test(a));
  assert(!a.includes("private"));
  assert(
    a !== await shiftLeftKey("owner/other", "rust-checks", "cargo clippy"),
  );
});

Deno.test("recordObservations dedupes by job and drops observations outside the window", () => {
  const ledger = emptyShiftLeftLedger();
  recordObservations(ledger, [obs({ jobId: 1 }), obs({ jobId: 1 })], NOW);
  recordObservations(
    ledger,
    [obs({ jobId: 2, observedAtMs: NOW - 30 * DAY })],
    NOW,
  );
  assertEquals(ledger.observations.map((o) => o.jobId), [1]);
});

Deno.test("repeatedFailures needs the threshold of distinct PRs, not repeated runs on one PR", async () => {
  const ledger = emptyShiftLeftLedger();
  // Five failures on one PR: a fix loop, not a repeated pattern.
  recordObservations(
    ledger,
    [1, 2, 3, 4, 5].map((j) => obs({ jobId: j, prNumber: 7 })),
    NOW,
  );
  assertEquals(await repeatedFailures(ledger, NOW), []);
  recordObservations(
    ledger,
    [obs({ jobId: 6, prNumber: 8 }), obs({ jobId: 7, prNumber: 9 })],
    NOW,
  );
  const groups = await repeatedFailures(ledger, NOW);
  assertEquals(groups.length, 1);
  assertEquals(groups[0]!.prNumbers, [7, 8, 9]);
  assertEquals(groups[0]!.tool, "cargo clippy");
});

Deno.test("localGateRunsTool reads the local gate script for the tool", () => {
  const gate =
    'run_check "cargo clippy" cargo clippy --workspace -- -D warnings\n';
  assert(localGateRunsTool(gate, "cargo clippy"));
  assert(!localGateRunsTool(gate, "cargo mutants"));
  assert(!localGateRunsTool(null, "cargo clippy"));
  assert(
    localGateRunsTool(
      "deno task check:pr-summary",
      "deno task check:pr-summary",
    ),
  );
  assert(localGateRunsTool("deno test -A --parallel", "deno test"));
});

Deno.test("routing: covered by the local gate → VibeCoder; not covered → the product repository", () => {
  const gate = "cargo clippy --workspace\n";
  const covered = routeShiftLeftFix(
    { tool: "cargo clippy", pushers: ["fleet-bot"] },
    gate,
    ["babysitter[bot]"],
  );
  assertEquals(covered.target, "vibecoder");
  const uncovered = routeShiftLeftFix(
    { tool: "cargo mutants", pushers: ["fleet-bot"] },
    gate,
    ["babysitter[bot]"],
  );
  assertEquals(uncovered.target, "product");
});

Deno.test("routing: failures pushed by the babysitter are a VibeCoder fix even without a local gate", () => {
  const route = routeShiftLeftFix(
    {
      tool: "cargo mutants",
      pushers: ["babysitter[bot]", "babysitter[bot]", "fleet-bot"],
    },
    null,
    ["babysitter[bot]"],
  );
  assertEquals(route.target, "vibecoder");
  assertStringIncludes(route.reason, "babysitter");
});

Deno.test("a VibeCoder issue for a private source names neither the repository nor its PRs", async () => {
  const [group] = await repeatedFailures(
    seeded([7, 8, 9], "owner/secret-product"),
    NOW,
  );
  const { title, body } = formatShiftLeftIssue(group!, {
    target: "vibecoder",
    reason: "the local gate already runs `cargo clippy`",
  }, { sourcePublic: false });
  assert(!title.includes("secret-product"));
  assert(!body.includes("secret-product"));
  assert(!/#[789]\b/.test(body));
  assertStringIncludes(body, "cargo clippy");
  assertStringIncludes(body, "clippy::indexing_slicing");
  assertEquals(parseShiftLeftMarker(body), group!.key);
});

Deno.test("a product-repository issue links its PRs and asks for a local equivalent", async () => {
  const [group] = await repeatedFailures(
    seeded([7, 8, 9], "owner/product"),
    NOW,
  );
  const { body } = formatShiftLeftIssue(group!, {
    target: "product",
    reason: "the local gate does not run `cargo clippy`",
  }, { sourcePublic: false });
  assertStringIncludes(body, "#7");
  assertStringIncludes(body, "quality.sh");
  assertEquals(parseShiftLeftMarker(body), group!.key);
});

function seeded(prs: number[], repo: string): ShiftLeftLedger {
  const ledger = emptyShiftLeftLedger();
  recordObservations(
    ledger,
    prs.map((pr, i) => obs({ repo, prNumber: pr, jobId: 100 + i })),
    NOW,
  );
  return ledger;
}

// ---------------------------------------------------------------------------
// End to end over a fake gh.
// ---------------------------------------------------------------------------

interface FakeGh {
  calls: string[][];
  gh: (args: string[]) => Promise<string>;
}

function fakeGh(opts: {
  existing?: {
    number: number;
    state: string;
    closedAt?: string;
    body: string;
    author?: { login: string };
  }[];
  gate?: string | null;
  /** Newer gh refuses job logs with terminal escapes unless given a flag. */
  refuseEscapes?: boolean;
  /** GitHub often leaves a run's `pull_requests` empty; find it by branch. */
  unlinkedRuns?: boolean;
  /** Job ids whose log is gone (HTTP 404). */
  missingLogs?: number[];
  /** Each run also fails a second locally runnable job (`cargo fmt`). */
  twoTools?: boolean;
}): FakeGh {
  const calls: string[][] = [];
  const runs = [7, 8, 9].map((pr) => ({
    id: pr * 10,
    created_at: new Date(NOW - DAY).toISOString(),
    head_sha: String(pr).repeat(40).slice(0, 40),
    head_branch: `issue-${pr}`,
    triggering_actor: { login: "fleet-bot" },
    pull_requests: opts.unlinkedRuns ? [] : [{ number: pr }],
  }));
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (path.includes("/actions/runs?")) {
      return Promise.resolve(runs.map((r) => JSON.stringify(r)).join("\n"));
    }
    const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(path);
    if (jobs) {
      const clippy = JSON.stringify({
        id: Number(jobs[1]) + 1,
        name: "rust-checks",
        steps: [{
          name: "cargo clippy (warnings denied)",
          conclusion: "failure",
        }],
      });
      const fmt = JSON.stringify({
        id: Number(jobs[1]) + 2,
        name: "lint",
        steps: [{ name: "cargo fmt --check", conclusion: "failure" }],
      });
      return Promise.resolve(opts.twoTools ? `${clippy}\n${fmt}` : clippy);
    }
    const logJob = /\/actions\/jobs\/(\d+)\/logs/.exec(path);
    if (logJob && opts.missingLogs?.includes(Number(logJob[1]))) {
      return Promise.reject(new Error("gh: HTTP 404"));
    }
    const byBranch = /\/pulls\?state=all&head=[^:]+:issue-(\d+)&/.exec(path);
    if (byBranch) {
      return Promise.resolve(
        JSON.stringify({ number: Number(byBranch[1]), login: "fleet-bot" }),
      );
    }
    if (/\/actions\/jobs\/\d+\/logs/.test(path)) {
      if (opts.refuseEscapes && !args.includes("--allow-escape-sequences")) {
        return Promise.reject(
          new Error(
            "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
          ),
        );
      }
      return Promise.resolve(
        "error: indexing may panic\n= note: `-D clippy::indexing-slicing` implied by `-D warnings`\n##[error]Process completed with exit code 101.\n",
      );
    }
    if (/\/pulls\/\d+$/.test(path)) {
      return Promise.resolve("fleet-bot");
    }
    if (path.endsWith("/contents/quality.sh")) {
      return opts.gate === null
        ? Promise.reject(new Error("HTTP 404"))
        : Promise.resolve(opts.gate ?? "cargo clippy --workspace");
    }
    if (path === "repos/owner/product") return Promise.resolve("private");
    if (args[1]?.startsWith("search/issues?")) {
      return Promise.resolve(
        (opts.existing ?? []).map((i) =>
          JSON.stringify({ author: { login: "fleet-bot" }, ...i })
        ).join("\n"),
      );
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/owner/VibeCoder/issues/99");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { calls, gh };
}

async function scan(
  fake: FakeGh,
  ledger = emptyShiftLeftLedger(),
  repos = ["owner/product"],
) {
  const logs: string[] = [];
  await runShiftLeftScan({
    repos,
    fleetAuthors: ["fleet-bot"],
    babysitterLogins: ["babysitter[bot]"],
    vibeCoderRepo: "owner/VibeCoder",
    ledger,
    nowMs: NOW,
    execute: true,
    gh: fake.gh,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
    withWriteScope: (_repo, action) => action(),
  });
  return { ledger, logs };
}

Deno.test("scan: a clippy failure on three fleet PRs that the local gate runs files one VibeCoder issue", async () => {
  const fake = fakeGh({});
  const { ledger } = await scan(fake);
  const creates = fake.calls.filter((c) =>
    c[0] === "issue" && c[1] === "create"
  );
  assertEquals(creates.length, 1);
  assertEquals(
    creates[0]![creates[0]!.indexOf("--repo") + 1],
    "owner/VibeCoder",
  );
  const body = creates[0]![creates[0]!.indexOf("--body") + 1]!;
  assert(!body.includes("owner/product"));
  assertEquals(Object.values(ledger.filings)[0]?.issueNumber, 99);

  // A second pass with nothing new writes nothing.
  const again = fakeGh({});
  await scan(again, ledger);
  assertEquals(
    again.calls.filter((c) =>
      c[0] === "issue" && (c[1] === "create" || c[1] === "comment")
    ).length,
    0,
  );
});

Deno.test("scan: a tool the local gate lacks files the issue in the product repository", async () => {
  const fake = fakeGh({ gate: null });
  await scan(fake);
  const creates = fake.calls.filter((c) =>
    c[0] === "issue" && c[1] === "create"
  );
  assertEquals(creates.length, 1);
  assertEquals(creates[0]![creates[0]!.indexOf("--repo") + 1], "owner/product");
});

Deno.test("scan: an open issue with the marker gets a comment instead of a duplicate", async () => {
  const key = await shiftLeftKey(
    "owner/product",
    "rust-checks",
    "cargo clippy (warnings denied)",
  );
  const fake = fakeGh({
    existing: [{
      number: 42,
      state: "OPEN",
      body: `<!-- VIBE_SHIFT_LEFT:${key} -->`,
    }],
  });
  await scan(fake);
  assertEquals(
    fake.calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
    0,
  );
  const comments = fake.calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(comments.length, 1);
  assertEquals(comments[0]![2], "42");
});

Deno.test("scan: a dry run records and reports but writes nothing", async () => {
  const fake = fakeGh({});
  const logs: string[] = [];
  await runShiftLeftScan({
    repos: ["owner/product"],
    fleetAuthors: ["fleet-bot"],
    babysitterLogins: ["babysitter[bot]"],
    vibeCoderRepo: "owner/VibeCoder",
    ledger: emptyShiftLeftLedger(),
    nowMs: NOW,
    execute: false,
    gh: fake.gh,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
    withWriteScope: (_repo, action) => action(),
  });
  assertEquals(
    fake.calls.filter((c) => c[0] === "issue" && c[1] !== "list").length,
    0,
  );
  assert(logs.some((l) => l.includes("would file")));
});

function createsIn(fake: FakeGh): string[] {
  return fake.calls
    .filter((c) => c[0] === "issue" && c[1] === "create")
    .map((c) => c[c.indexOf("--repo") + 1]!);
}

Deno.test("scan: filed issues carry the idle-task label so the fleet works them", async () => {
  const fake = fakeGh({});
  await scan(fake);
  const create = fake.calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  const labels = create.flatMap((a, i) =>
    create[i - 1] === "--label" ? [a] : []
  );
  assert(labels.includes("idle-task"), `labels: ${labels}`);
});

Deno.test("scan: a check missing locally in two repositories is generic, filed once in VibeCoder", async () => {
  const fake = fakeGh({ gate: null });
  await scan(fake, emptyShiftLeftLedger(), ["owner/product", "owner/other"]);
  assertEquals(createsIn(fake), ["owner/VibeCoder"]);
  const create = fake.calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  const body = create[create.indexOf("--body") + 1]!;
  assert(!body.includes("owner/product") && !body.includes("owner/other"));
  assertStringIncludes(body, "2 repositories");
});

Deno.test("scan: a check missing locally in one repository is that repository's issue", async () => {
  const fake = fakeGh({ gate: null });
  await scan(fake);
  assertEquals(createsIn(fake), ["owner/product"]);
});

Deno.test("scan: a job log gh refuses for terminal escapes is fetched again with the flag", async () => {
  const fake = fakeGh({ refuseEscapes: true });
  const { ledger } = await scan(fake);
  assertEquals(ledger.observations.length, 3);
  assertEquals(createsIn(fake), ["owner/VibeCoder"]);
});

Deno.test("scan: a run with no linked PR is matched to its PR by head branch", async () => {
  const fake = fakeGh({ unlinkedRuns: true });
  const { ledger } = await scan(fake);
  assertEquals(
    ledger.observations.map((o) => o.prNumber).sort((a, b) => a - b),
    [7, 8, 9],
  );
});

Deno.test("scan: one job whose log is gone is skipped, the rest still count", async () => {
  const fake = fakeGh({ missingLogs: [71] });
  const { ledger, logs } = await scan(fake);
  assertEquals(ledger.observations.length, 2);
  assert(!logs.some((l) => l.includes("scan of owner/product failed")));
});

Deno.test("scan: a marker in an issue someone outside the fleet wrote does not silence the detector", async () => {
  const key = await shiftLeftKey(
    "owner/product",
    "rust-checks",
    "cargo clippy (warnings denied)",
  );
  const fake = fakeGh({
    existing: [{
      number: 13,
      state: "open",
      body: `<!-- VIBE_SHIFT_LEFT:${key} -->`,
      author: { login: "stranger" },
    }],
  });
  await scan(fake);
  assertEquals(createsIn(fake), ["owner/VibeCoder"]);
});

Deno.test("scan: a pass inspects a bounded number of runs and the next pass resumes without re-reading them", async () => {
  const ledger = emptyShiftLeftLedger();
  const run = (fake: FakeGh, nowMs: number) =>
    runShiftLeftScan({
      repos: ["owner/product"],
      fleetAuthors: ["fleet-bot"],
      babysitterLogins: ["babysitter[bot]"],
      vibeCoderRepo: "owner/VibeCoder",
      ledger,
      nowMs,
      execute: false,
      gh: fake.gh,
      log: () => {},
      warn: () => {},
      withWriteScope: (_repo, action) => action(),
      maxRunsPerRepo: 2,
    });
  const first = fakeGh({});
  await run(first, NOW);
  assertEquals(ledger.observations.length, 2);
  const second = fakeGh({});
  await run(second, NOW + 60_000);
  assertEquals(ledger.observations.length, 3);
  const jobReads = second.calls.filter((c) =>
    c.some((a) => /\/actions\/runs\/\d+\/jobs/.test(a))
  );
  assertEquals(jobReads.length, 1);
});

Deno.test("scan: several checks the local gate already runs, in one repository, are one VibeCoder issue", async () => {
  // They share one cause (the fleet pushed without a passing local gate), so
  // one issue lists every tool rather than one near-duplicate per tool.
  const fake = fakeGh({
    twoTools: true,
    gate: "cargo clippy --workspace\ncargo fmt --all -- --check",
  });
  await scan(fake);
  assertEquals(createsIn(fake), ["owner/VibeCoder"]);
  const create = fake.calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(body, "cargo clippy");
  assertStringIncludes(body, "cargo fmt");
});
