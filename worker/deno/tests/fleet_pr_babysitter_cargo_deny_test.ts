/**
 * The fleet babysitter's pre-push cargo-deny gate (Issue #4626). These tests
 * drive the real `finishBabysitterRepair` with injected git, GitHub and gate
 * fakes, and check that a failing or unavailable gate stops the push, and that
 * a passing gate runs before the push.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { finishBabysitterRepair } from "../commands/fleet_pr_babysitter.ts";
import { BabysitterFailure } from "../lib/babysitter_retry_state.ts";
import { createExchangeDir } from "../lib/fleet_babysitter_exchange.ts";
import type { CargoDenyGateError } from "../lib/cargo_deny_gate.ts";

type Reviews = Parameters<typeof finishBabysitterRepair>[4];
type Gate = NonNullable<
  Parameters<typeof finishBabysitterRepair>[5]["cargoDenyGate"]
>;

const REPO = "owner/repo";
const BASE_HEAD = "1".repeat(40);
const PUSHED_HEAD = "2".repeat(40);
const PART_OF_BODY = "## Summary\n\nPart of owner/repo#4611.\n";
const NO_REVIEWS: Reviews = [];

const pr = {
  state: "OPEN",
  number: 4611,
  title: "Refresh the lock file",
  author: { login: "fleet" },
  headRefName: "review-fix-branch",
  headRefOid: BASE_HEAD,
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "CHANGES_REQUESTED",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
};

/** A GitHub stand-in: the PR view reports the pushed head at once. */
const gh = (args: string[]): Promise<string> => {
  if (args[0] === "pr" && args[1] === "view") {
    return Promise.resolve(
      JSON.stringify({
        body: PART_OF_BODY,
        headRefOid: PUSHED_HEAD,
        closingIssuesReferences: [],
      }),
    );
  }
  return Promise.reject(new Error(`unexpected gh: ${args.join(" ")}`));
};

/**
 * A repair's runCommand with the agent's change in the clone. Every git push
 * is recorded in `events`, so a test can see whether the push happened.
 */
function repairCommands(events: string[]) {
  return (command: string, args: string[]): Promise<string> => {
    if (command === "git" && args[0] === "status") {
      return Promise.resolve(" M Cargo.lock");
    }
    if (command === "git" && args[0] === "diff") return Promise.resolve("");
    if (command === "gh" && args[0] === "api") return Promise.resolve("12345");
    if (command === "git" && args[0] === "push") {
      events.push("push");
      return Promise.resolve("");
    }
    if (command === "git" && args[0] === "rev-parse") {
      return Promise.resolve(PUSHED_HEAD);
    }
    return Promise.reject(
      new Error(`unexpected command: ${command} ${args.join(" ")}`),
    );
  };
}

/** A body sync that finds the body current, so only the repair's own publication runs. */
const skipSync = () =>
  Promise.resolve({
    ok: true as const,
    value: { status: "skipped" as const, reason: "body already current" },
  });

/** Runs one finish with the given gate and returns the error it rejected with. */
async function finishRejecting(
  gate: Gate,
  events: string[],
): Promise<BabysitterFailure> {
  const exchange = await createExchangeDir("babysitter-cargo-deny-4626-");
  try {
    const error = await assertRejects(
      () =>
        finishBabysitterRepair(
          REPO,
          pr,
          "/unused-repo",
          "babysitter[bot]",
          NO_REVIEWS,
          {
            renewalFailed: () => false,
            runCommand: repairCommands(events),
            readPr: () => Promise.resolve({ ...pr }),
            validateAndCommit: () => Promise.resolve(),
            gh,
            syncBodyFn: skipSync,
            headWaitDelayMs: 0,
            dismiss: () => Promise.resolve(),
            verifyReviews: () => Promise.resolve([]),
            cargoDenyGate: gate,
          },
          { exchange },
        ),
    );
    assertInstanceOf(error, BabysitterFailure);
    return error;
  } finally {
    await Deno.remove(exchange, { recursive: true });
  }
}

/** Captures console.log lines while `fn` runs. */
async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = log;
  }
}

Deno.test("cargo deny gate: a verdict stops the push as a code failure", async () => {
  const events: string[] = [];
  const verdict: CargoDenyGateError = {
    kind: "verdict",
    message: "error[vulnerability]: Detected vulnerability crate `foo`",
  };
  const error = await finishRejecting(
    () => Promise.resolve({ ok: false as const, error: verdict }),
    events,
  );
  assertEquals(error.blockerClass, "code");
  assertStringIncludes(error.message, "error[vulnerability]");
  assertEquals(events, [], "a failing gate must not push");
});

Deno.test("cargo deny gate: an unavailable tool stops the push as an infrastructure failure", async () => {
  const events: string[] = [];
  const unavailable: CargoDenyGateError = {
    kind: "infrastructure",
    message: "cargo deny could not run, so the dependency audit was not " +
      'checked (this is not a pass): "cargo-deny not found"',
  };
  const error = await finishRejecting(
    () => Promise.resolve({ ok: false as const, error: unavailable }),
    events,
  );
  assertEquals(error.blockerClass, "infrastructure");
  assertStringIncludes(error.message, "this is not a pass");
  assertEquals(events, [], "an unavailable gate must not push");
});

Deno.test("cargo deny gate: a passing gate runs before the push and the push happens", async () => {
  const events: string[] = [];
  const gateInputs: { repoPath: string; baseHead: string }[] = [];
  const gate: Gate = (input) => {
    events.push("cargo-deny");
    gateInputs.push(input);
    return Promise.resolve({
      ok: true as const,
      value: { checksRun: ["'cargo' 'deny' 'check'"] },
    });
  };
  const { value: finish, logs } = await captureLogs(async () => {
    const exchange = await createExchangeDir("babysitter-cargo-deny-4626-");
    try {
      return await finishBabysitterRepair(
        REPO,
        pr,
        "/unused-repo",
        "babysitter[bot]",
        NO_REVIEWS,
        {
          renewalFailed: () => false,
          runCommand: repairCommands(events),
          readPr: () => Promise.resolve({ ...pr }),
          validateAndCommit: () => Promise.resolve(),
          gh,
          syncBodyFn: skipSync,
          headWaitDelayMs: 0,
          dismiss: () => Promise.resolve(),
          verifyReviews: () => Promise.resolve([]),
          cargoDenyGate: gate,
        },
        { exchange },
      );
    } finally {
      await Deno.remove(exchange, { recursive: true });
    }
  });
  assertEquals(
    events,
    ["cargo-deny", "push"],
    "the gate must run before the push",
  );
  assertEquals(gateInputs, [{ repoPath: "/unused-repo", baseHead: BASE_HEAD }]);
  assertEquals(finish.reviewsDismissed, false);
  assert(
    logs.includes(
      `${REPO}#${pr.number}: cargo deny passed locally (1 check(s))`,
    ),
    `expected the cargo-deny log line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("cargo deny gate: the default gate reads the repair's own commit and refuses an unreproducible CI invocation", async () => {
  // A real repository: the workflow's cargo-deny step uses a matrix expression,
  // so the default gate refuses before any cargo-deny process starts.
  const dir = await Deno.makeTempDir({ prefix: "vibe-babysitter-deny-" });
  const realGit = async (args: string[]): Promise<string> => {
    const out = await new Deno.Command("git", {
      args: ["-c", "user.email=t@e", "-c", "user.name=t", ...args],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(new TextDecoder().decode(out.stderr));
    }
    return new TextDecoder().decode(out.stdout);
  };
  try {
    await realGit(["init", "-q", "-b", "main"]);
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      [
        "name: ci",
        "on: push",
        "jobs:",
        "  deny:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cargo deny --all-features check ${{ matrix.check }}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(`${dir}/Cargo.lock`, "version = 4\n");
    await realGit(["add", "."]);
    await realGit(["commit", "-qm", "base"]);
    const baseHead = (await realGit(["rev-parse", "HEAD"])).trim();
    await Deno.writeTextFile(`${dir}/Cargo.lock`, "version = 4\n# repair\n");
    await realGit(["commit", "-qam", "repair"]);

    const events: string[] = [];
    const exchange = await createExchangeDir("babysitter-cargo-deny-4626-");
    try {
      const error = await assertRejects(
        () =>
          finishBabysitterRepair(
            REPO,
            { ...pr, headRefOid: baseHead },
            dir,
            "babysitter[bot]",
            NO_REVIEWS,
            {
              renewalFailed: () => false,
              // Real git for the commit's changed and tracked files.
              runCommand: (command, args, cwd) => {
                if (
                  command === "git" &&
                  (args[0] === "ls-files" ||
                    (args[0] === "diff" && args.includes("--name-only")))
                ) {
                  return realGit(args);
                }
                return repairCommands(events)(command, args);
              },
              readPr: () => Promise.resolve({ ...pr, headRefOid: baseHead }),
              validateAndCommit: () => Promise.resolve(),
              gh,
              syncBodyFn: skipSync,
              headWaitDelayMs: 0,
              dismiss: () => Promise.resolve(),
              verifyReviews: () => Promise.resolve([]),
            },
            { exchange },
          ),
      );
      assertInstanceOf(error, BabysitterFailure);
      assertEquals(error.blockerClass, "code");
      assertStringIncludes(error.message, ".github/workflows/ci.yml");
      assertStringIncludes(error.message, "cannot be reproduced locally");
      assertEquals(events, [], "an unreproducible CI invocation must not push");
    } finally {
      await Deno.remove(exchange, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
