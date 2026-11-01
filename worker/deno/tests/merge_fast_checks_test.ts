/**
 * Tests for the fast local checks a base merge must pass before it is pushed
 * (Issue #4616).
 *
 * Planning runs against real manifest fixtures in temporary directories. The
 * toolchain, git and the repair agent are injected fakes, and the budget is
 * driven by an injected clock, so no check is spawned and no wall-clock time
 * is read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger, Result } from "../types.ts";
import type { MergeConflictAgentOutcome } from "../lib/merge_conflict_agent.ts";
import type { MergeConflictRepairContext } from "../lib/prompt_builder.ts";
import {
  type FastCheck,
  type FastCheckGit,
  type FastCheckRunner,
  listMergeTouchedPaths,
  MERGE_FAST_CHECK_REPAIR_ROUNDS,
  MERGE_FAST_CHECKS_BUDGET_MS,
  type MergeFastChecksOutcome,
  planFastChecks,
  readCiClippyArgs,
  runMergeFastChecks,
  type VerifyBeforePushOptions,
  verifyMergeBeforePush,
} from "../lib/merge_fast_checks.ts";

const DENO_MANIFEST = JSON.stringify({
  tasks: {
    check: "deno check **/*.ts",
    "check:manifests": "deno run check_manifests.ts",
    "test:unit": "deno test",
    test: "deno test --all",
  },
});
const CARGO_MANIFEST = '[package]\nname = "crate"\nversion = "0.1.0"\n';

/** Write a tree under a fresh temporary root, run the body, then remove it. */
async function withTree<T>(
  files: Record<string, string>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "issue-4616-" });
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = `${root}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, contents);
    }
    return await body(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/** A logger that records informational lines and drops everything else. */
function makeLogger(lines: string[]): Logger {
  const drop = () => {};
  return {
    info: (message) => lines.push(message),
    warn: drop,
    error: drop,
    debug: drop,
    security: drop,
    skipReason: drop,
    timing: drop,
    scanSummary: drop,
    workerSummary: drop,
  };
}

/** The labels a Deno project with {@link DENO_MANIFEST} plans, in order. */
function denoLabels(dir: string): string[] {
  return [
    `deno fmt --check in ${dir}`,
    `deno lint in ${dir}`,
    `deno task check in ${dir}`,
    `deno task check:manifests in ${dir}`,
    `deno task test:unit in ${dir}`,
  ];
}

/** A check runner that answers from a table keyed by label; others pass. */
function scriptedRunner(
  results: Record<string, { code: number; output: string }>,
  calls: FastCheck[] = [],
): FastCheckRunner {
  return (check) => {
    calls.push(check);
    return Promise.resolve(results[check.label] ?? { code: 0, output: "" });
  };
}

/** A clock the test moves by hand, so the budget is deterministic. */
function manualClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

// --- planFastChecks ---------------------------------------------------------

Deno.test("planFastChecks: a Deno project runs fmt, lint, check and its manifest tasks in order", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const plan = await planFastChecks(root, ["pkgs/app/main.ts"]);
    assertEquals(plan.map((c) => c.label), denoLabels(`${root}/pkgs/app`));
    assertEquals(plan.map((c) => c.args), [
      ["fmt", "--check"],
      ["lint"],
      ["task", "check"],
      ["task", "check:manifests"],
      ["task", "test:unit"],
    ]);
    assert(plan.every((c) => c.kind === "deno" && c.timeoutMs === 0));
    assertEquals(plan.map((c) => c.dir), plan.map(() => `${root}/pkgs/app`));
  });
});

Deno.test("planFastChecks: a Deno project with no check task type-checks the whole tree", async () => {
  const manifest = JSON.stringify({ tasks: { "test:unit": "deno test" } });
  await withTree({ "pkgs/app/deno.json": manifest }, async (root) => {
    const plan = await planFastChecks(root, ["pkgs/app/main.ts"]);
    const dir = `${root}/pkgs/app`;
    assertEquals(plan.map((c) => c.label), [
      `deno fmt --check in ${dir}`,
      `deno lint in ${dir}`,
      `deno check **/*.ts in ${dir}`,
      `deno task test:unit in ${dir}`,
    ]);
  });
});

Deno.test("planFastChecks: Cargo runs --locked only where a Cargo.lock is committed", async () => {
  await withTree({
    "crate/Cargo.toml": CARGO_MANIFEST,
    "locked/Cargo.toml": CARGO_MANIFEST,
    "locked/Cargo.lock": "# lock\n",
  }, async (root) => {
    const plan = await planFastChecks(root, ["crate/a.rs", "locked/b.rs"]);
    const unlocked = `${root}/crate`;
    const locked = `${root}/locked`;
    assertEquals(plan.map((c) => c.label), [
      `cargo fmt --all -- --check in ${unlocked}`,
      `cargo clippy --workspace --all-targets -- -D warnings in ${unlocked}`,
      `cargo test --workspace in ${unlocked}`,
      `cargo fmt --all -- --check in ${locked}`,
      `cargo clippy --workspace --all-targets --locked -- -D warnings in ${locked}`,
      `cargo test --workspace --locked in ${locked}`,
    ]);
    assert(plan.every((c) => c.kind === "cargo"));
    assertEquals(
      plan.map((c) => c.dir),
      [unlocked, unlocked, unlocked, locked, locked, locked],
    );
  });
});

const CI_WORKFLOW = (run: string) =>
  `name: ci\njobs:\n  lint:\n    steps:\n      - run: ${run}\n`;

Deno.test("planFastChecks: clippy takes the flags the repository's CI declares, and changing them changes the command", async () => {
  const workflowFor = (run: string) => ({
    "crate/Cargo.toml": CARGO_MANIFEST,
    ".github/workflows/ci.yml": CI_WORKFLOW(run),
  });
  const clippyOf = async (run: string) =>
    await withTree(workflowFor(run), async (root) => {
      const plan = await planFastChecks(root, ["crate/a.rs"]);
      return plan[1]!.args;
    });
  assertEquals(
    await clippyOf(
      "cargo clippy --all-targets --all-features -- -D warnings -W clippy::too_many_lines",
    ),
    [
      "clippy",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
      "-W",
      "clippy::too_many_lines",
    ],
  );
  assertEquals(
    await clippyOf("cargo clippy --workspace -- -D clippy::pedantic"),
    ["clippy", "--workspace", "--", "-D", "clippy::pedantic"],
  );
});

Deno.test("planFastChecks: a CI-declared clippy gets --locked before the separator, once", async () => {
  await withTree({
    "crate/Cargo.toml": CARGO_MANIFEST,
    "crate/Cargo.lock": "# lock\n",
    ".github/workflows/ci.yml": CI_WORKFLOW(
      "cargo clippy --all-targets -- -D warnings",
    ),
    ".github/workflows/zz.yml": CI_WORKFLOW("cargo clippy --locked"),
  }, async (root) => {
    const plan = await planFastChecks(root, ["crate/a.rs"]);
    assertEquals(plan[1]!.args, [
      "clippy",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ]);
  });
  await withTree({
    "crate/Cargo.toml": CARGO_MANIFEST,
    "crate/Cargo.lock": "# lock\n",
    ".github/workflows/ci.yml": CI_WORKFLOW("cargo clippy --locked -- -D x"),
  }, async (root) => {
    const plan = await planFastChecks(root, ["crate/a.rs"]);
    assertEquals(plan[1]!.args, ["clippy", "--locked", "--", "-D", "x"]);
  });
});

Deno.test("readCiClippyArgs: skips comments and unreproducible lines, joins continuations, and reads none from a repo that declares none", async () => {
  await withTree({
    ".github/workflows/a.yml": [
      "# cargo clippy -- -D commented",
      "      - run: cargo clippy -- -D ${{ matrix.lint }}",
      '      - run: cargo clippy -- -D "quoted"',
      "      - run: |",
      "          cargo +nightly clippy --all-targets \\",
      "            -- -D warnings && echo done",
      "",
    ].join("\n"),
    ".github/workflows/notes.txt": "cargo clippy -- -D ignored\n",
  }, async (root) => {
    assertEquals(await readCiClippyArgs(root), [
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
  });
  await withTree({
    ".github/workflows/a.yml": CI_WORKFLOW("deno task test"),
  }, async (root) => {
    assertEquals(await readCiClippyArgs(root), undefined);
  });
  await withTree({ "crate/Cargo.toml": CARGO_MANIFEST }, async (root) => {
    assertEquals(await readCiClippyArgs(root), undefined);
  });
});

Deno.test("planFastChecks: a project the merge did not touch gets no checks", async () => {
  await withTree({
    "pkgs/a/deno.json": DENO_MANIFEST,
    "pkgs/b/deno.json": DENO_MANIFEST,
    "crate/Cargo.toml": CARGO_MANIFEST,
  }, async (root) => {
    const plan = await planFastChecks(root, ["pkgs/b/mod.ts"]);
    assertEquals(plan.map((c) => c.label), denoLabels(`${root}/pkgs/b`));
  });
});

Deno.test("planFastChecks: a docs-only change in a tree with no root manifest plans nothing", async () => {
  await withTree({ "pkgs/a/deno.json": DENO_MANIFEST }, async (root) => {
    assertEquals(await planFastChecks(root, ["docs/README.md"]), []);
  });
});

Deno.test("planFastChecks: a root project is touched by any path, and no path touches nothing", async () => {
  await withTree({ "deno.json": DENO_MANIFEST }, async (root) => {
    const plan = await planFastChecks(root, ["docs/README.md"]);
    assertEquals(plan.map((c) => c.label), denoLabels(root));
    assertEquals(await planFastChecks(root, []), []);
  });
});

// --- runMergeFastChecks -----------------------------------------------------

Deno.test("runMergeFastChecks: every check passing reports them all as ran", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const calls: FastCheck[] = [];
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({}, calls),
      manualClock().now,
    );
    assertEquals(outcome, {
      status: "passed",
      ran: denoLabels(`${root}/pkgs/app`),
      leftToCi: [],
    });
    assertEquals(calls.length, 5);
  });
});

Deno.test("runMergeFastChecks: the first failure stops later checks and names its command and output", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const dir = `${root}/pkgs/app`;
    const calls: FastCheck[] = [];
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({
        [`deno lint in ${dir}`]: {
          code: 1,
          output: "main.ts:3:1 no-unused-vars\nfound 1 problem",
        },
      }, calls),
      manualClock().now,
    );
    assertEquals(outcome, {
      status: "failed",
      failingCommand: `deno lint in ${dir}`,
      output: "main.ts:3:1 no-unused-vars\nfound 1 problem",
    });
    assertEquals(calls.length, 2);
  });
});

Deno.test("runMergeFastChecks: a remote-module gap is left to CI, not failed, and the run goes on", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const dir = `${root}/pkgs/app`;
    const calls: FastCheck[] = [];
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({
        [`deno task test:unit in ${dir}`]: {
          code: 1,
          output: "error: Import 'https://esm.sh/std@1/testing' failed.\n" +
            "    0: error sending request for url (https://esm.sh/std@1/testing)",
        },
      }, calls),
      manualClock().now,
    );
    assertEquals(outcome.status, "passed");
    if (outcome.status !== "passed") return;
    assertEquals(outcome.ran.length, 4);
    assertEquals(outcome.leftToCi.length, 1);
    assertStringIncludes(
      outcome.leftToCi[0]!,
      `deno task test:unit in ${dir} could not fetch its remote modules`,
    );
    assertEquals(calls.length, 5);
  });
});

Deno.test("runMergeFastChecks: a rustc older than the workspace requires is left to CI and the run goes on", async () => {
  await withTree({ "crate/Cargo.toml": CARGO_MANIFEST }, async (root) => {
    const dir = `${root}/crate`;
    const outcome = await runMergeFastChecks(
      root,
      ["crate/src/lib.rs"],
      scriptedRunner({
        [`cargo clippy --workspace --all-targets -- -D warnings in ${dir}`]: {
          code: 101,
          output: "error: rustc 1.80.0 is not supported by the following " +
            "packages:\n  foo@1.0.0 requires rustc 1.85\n",
        },
      }),
      manualClock().now,
    );
    assertEquals(outcome.status, "passed");
    if (outcome.status !== "passed") return;
    assertEquals(outcome.ran, [
      `cargo fmt --all -- --check in ${dir}`,
      `cargo test --workspace in ${dir}`,
    ]);
    assertEquals(outcome.leftToCi.length, 1);
    assertStringIncludes(outcome.leftToCi[0]!, "rust-version 1.85");
  });
});

Deno.test("runMergeFastChecks: a runner that throws is unverified, never clean", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const calls: FastCheck[] = [];
    const runner: FastCheckRunner = (check) => {
      calls.push(check);
      return Promise.reject(new Error("spawn deno ENOENT"));
    };
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      runner,
      manualClock().now,
    );
    assertEquals(outcome.status, "unverified");
    if (outcome.status !== "unverified") return;
    assertStringIncludes(outcome.detail, `deno fmt --check in ${root}`);
    assertStringIncludes(outcome.output, "spawn deno ENOENT");
    assertEquals(calls.length, 1);
  });
});

Deno.test("runMergeFastChecks: a timed-out check is unverified, stops the run, and is not repaired", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const dir = `${root}/pkgs/app`;
    const calls: FastCheck[] = [];
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({
        [`deno lint in ${dir}`]: {
          code: 124,
          output: `deno lint in ${dir} timed out after 900000ms`,
        },
      }, calls),
      manualClock().now,
    );
    assertEquals(outcome.status, "unverified");
    if (outcome.status !== "unverified") return;
    assertStringIncludes(outcome.detail, `deno lint in ${dir} timed out`);
    assertStringIncludes(outcome.output, "timed out after 900000ms");
    // fmt ran and passed; lint timed out and nothing after it was run.
    assertEquals(calls.length, 2);
  });
});

Deno.test("runMergeFastChecks: a budget spent before a check starts is unverified", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const clock = manualClock();
    const calls: FastCheck[] = [];
    const runner: FastCheckRunner = (check) => {
      calls.push(check);
      // The first check uses up the whole budget.
      clock.advance(MERGE_FAST_CHECKS_BUDGET_MS);
      return Promise.resolve({ code: 0, output: "" });
    };
    const outcome = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      runner,
      clock.now,
    );
    assertEquals(outcome.status, "unverified");
    if (outcome.status !== "unverified") return;
    assertStringIncludes(outcome.detail, `deno lint in ${root}/pkgs/app`);
    assertEquals(calls.length, 1);
  });
});

Deno.test("runMergeFastChecks: each check is given what is left of the one budget", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const clock = manualClock();
    const calls: FastCheck[] = [];
    const runner: FastCheckRunner = (check) => {
      calls.push(check);
      clock.advance(400_000);
      return Promise.resolve({ code: 0, output: "" });
    };
    await runMergeFastChecks(root, ["pkgs/app/main.ts"], runner, clock.now);
    assertEquals(
      calls.slice(0, 3).map((c) => c.timeoutMs),
      [900_000, 500_000, 100_000],
    );
  });
});

Deno.test("runMergeFastChecks: nothing touched runs nothing and passes", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const calls: FastCheck[] = [];
    const outcome = await runMergeFastChecks(
      root,
      [],
      scriptedRunner({}, calls),
      manualClock().now,
    );
    assertEquals(outcome, { status: "passed", ran: [], leftToCi: [] });
    assertEquals(calls.length, 0);
  });
});

Deno.test("runMergeFastChecks: a hostile long output is trimmed to its last lines and characters", async () => {
  await withTree({ "pkgs/app/deno.json": DENO_MANIFEST }, async (root) => {
    const label = `deno lint in ${root}/pkgs/app`;
    const noisy = [
      ...Array.from({ length: 300 }, (_, i) => `progress ${i}`),
      ...Array.from({ length: 50 }, () => "same warning"),
      "error: final cause",
    ].join("\n");
    const many = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({ [label]: { code: 1, output: noisy } }),
      manualClock().now,
    );
    assertEquals(many.status, "failed");
    if (many.status !== "failed") return;
    const kept = many.output.split("\n");
    assert(kept.length <= 40);
    assertEquals(kept.at(-1), "error: final cause");
    assert(kept.includes("same warning (×50)"));
    assert(!kept.includes("progress 0"));

    const wide = await runMergeFastChecks(
      root,
      ["pkgs/app/main.ts"],
      scriptedRunner({
        [label]: { code: 1, output: "x".repeat(10_000) + "\nerror: end" },
      }),
      manualClock().now,
    );
    assertEquals(wide.status, "failed");
    if (wide.status !== "failed") return;
    assert(wide.output.length <= 4000);
    assert(wide.output.endsWith("error: end"));
  });
});

// --- listMergeTouchedPaths --------------------------------------------------

Deno.test("listMergeTouchedPaths: splits -z output on NUL, keeping unusual names whole", async () => {
  const calls: string[][] = [];
  const git: FastCheckGit = (args) => {
    calls.push(args);
    return Promise.resolve({
      code: 0,
      stdout: "pkgs/a/x.ts\0docs/with space.md\0new\nline.txt\0",
      stderr: "",
    });
  };
  assertEquals(await listMergeTouchedPaths(git, "abc123"), {
    ok: true,
    value: ["pkgs/a/x.ts", "docs/with space.md", "new\nline.txt"],
  });
  assertEquals(calls, [["diff", "--name-only", "-z", "abc123"]]);
});

Deno.test("listMergeTouchedPaths: a nonzero exit or a thrown git call is an error carrying the message", async () => {
  const failed: FastCheckGit = () =>
    Promise.resolve({
      code: 128,
      stdout: "",
      stderr: "fatal: bad object abc123\n",
    });
  const thrown: FastCheckGit = () =>
    Promise.reject(new Error("spawn git ENOENT"));

  const nonzero = await listMergeTouchedPaths(failed, "abc123");
  assertEquals(nonzero.ok, false);
  if (!nonzero.ok) {
    assertStringIncludes(nonzero.error.message, "exit 128");
    assertStringIncludes(nonzero.error.message, "fatal: bad object abc123");
  }
  const raised = await listMergeTouchedPaths(thrown, "abc123");
  assertEquals(raised.ok, false);
  if (!raised.ok) {
    assertEquals(
      raised.error.message,
      "git diff --name-only failed: spawn git ENOENT",
    );
  }
  const text = await listMergeTouchedPaths(
    () => Promise.reject("boom"),
    "abc123",
  );
  assertEquals(text.ok, false);
  if (!text.ok) {
    assertEquals(text.error.message, "git diff --name-only failed: boom");
  }
  const raisedAgain = await listMergeTouchedPaths(thrown, "abc123");
  assertEquals(raised.ok, false);
  if (!raisedAgain.ok) {
    assertStringIncludes(raisedAgain.error.message, "spawn git ENOENT");
  }
});

// --- verifyMergeBeforePush --------------------------------------------------

/** A git reply for the diff: a list of paths, or a failure. */
type DiffReply = string[] | { code: number; stderr: string };

/** How the fake git answers. Diff replies repeat their last entry. */
interface GitSetup {
  diffs?: DiffReply[];
  mergeHeadCode?: number;
  logCode?: number;
  logStdout?: string;
}

/** A fake git that records every call and answers each command it knows. */
function gitStub(setup: GitSetup) {
  const calls: string[][] = [];
  let diffCount = 0;
  const git: FastCheckGit = (args) => {
    calls.push(args);
    if (args[0] === "diff") {
      const replies = setup.diffs ?? [["pkgs/app/main.ts"]];
      const reply = replies[Math.min(diffCount, replies.length - 1)]!;
      diffCount++;
      return Promise.resolve(
        Array.isArray(reply)
          ? {
            code: 0,
            stdout: reply.map((path) => `${path}\0`).join(""),
            stderr: "",
          }
          : { code: reply.code, stdout: "", stderr: reply.stderr },
      );
    }
    if (args[0] === "rev-parse") {
      return Promise.resolve({
        code: setup.mergeHeadCode ?? 1,
        stdout: "",
        stderr: "",
      });
    }
    if (args[0] === "log") {
      return Promise.resolve({
        code: setup.logCode ?? 0,
        stdout: setup.logStdout ?? "",
        stderr: "",
      });
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { git, calls };
}

/** A harness: fake git, scripted check outcomes and scripted agent replies. */
function harness(
  setup: GitSetup & {
    outcomes: MergeFastChecksOutcome[];
    replies?: Result<MergeConflictAgentOutcome>[];
  },
) {
  const stub = gitStub(setup);
  const seen: { touched: string[] }[] = [];
  const agentCalls: MergeConflictRepairContext[] = [];
  const lines: string[] = [];
  const options: VerifyBeforePushOptions = {
    repoDir: "/merge-tree",
    headBeforeMerge: "abc123",
    baseBranch: "main",
    git: stub.git,
    runChecks: (_repoDir, touched) => {
      seen.push({ touched: [...touched] });
      const { outcomes } = setup;
      return Promise.resolve(
        outcomes[Math.min(seen.length - 1, outcomes.length - 1)]!,
      );
    },
    runRepairAgent: (repair) => {
      agentCalls.push(repair);
      const replies = setup.replies ?? [];
      return Promise.resolve(
        replies.length === 0
          ? { ok: true, value: { terminated: false } }
          : replies[Math.min(agentCalls.length - 1, replies.length - 1)]!,
      );
    },
    logger: makeLogger(lines),
  };
  return { stub, seen, agentCalls, lines, options };
}

const LINT_FAILURE: MergeFastChecksOutcome = {
  status: "failed",
  failingCommand: "deno lint in /merge-tree/pkgs/app",
  output: "lint out",
};

Deno.test("verifyMergeBeforePush: a clean pass never calls the repair agent", async () => {
  const h = harness({
    outcomes: [{
      status: "passed",
      ran: ["deno lint in /merge-tree/pkgs/app"],
      leftToCi: [],
    }],
  });
  assertEquals(await verifyMergeBeforePush(h.options), {
    kind: "passed",
    ran: ["deno lint in /merge-tree/pkgs/app"],
    leftToCi: [],
    repairRounds: 0,
  });
  assertEquals(h.agentCalls.length, 0);
  assertEquals(h.seen, [{ touched: ["pkgs/app/main.ts"] }]);
});

Deno.test("verifyMergeBeforePush: a failure the agent fixes is repaired once, re-listed and re-checked", async () => {
  for (const mergeHeadCode of [0, 1]) {
    const h = harness({
      diffs: [["pkgs/app/main.ts"], ["pkgs/app/main.ts", "pkgs/app/fix.ts"]],
      mergeHeadCode,
      logStdout: "feat: add the widget\nfix: correct the import\n",
      outcomes: [LINT_FAILURE, {
        status: "passed",
        ran: ["deno lint in /merge-tree/pkgs/app"],
        leftToCi: [],
      }],
    });
    assertEquals(await verifyMergeBeforePush(h.options), {
      kind: "passed",
      ran: ["deno lint in /merge-tree/pkgs/app"],
      leftToCi: [],
      repairRounds: 1,
    });
    assertEquals(h.agentCalls, [{
      round: 1,
      maxRounds: MERGE_FAST_CHECK_REPAIR_ROUNDS,
      failingCommand: "deno lint in /merge-tree/pkgs/app",
      output: "lint out",
      mergedCommitSubjects: ["feat: add the widget", "fix: correct the import"],
      mergeStaged: mergeHeadCode === 0,
    }]);
    assertEquals(h.stub.calls.filter((args) => args[0] === "log"), [[
      "log",
      "--format=%s",
      "-n",
      "20",
      "abc123..origin/main",
    ]]);
    assertEquals(h.lines.length, 1);
    assertStringIncludes(h.lines[0]!, "repair round 1 of 2");
    assertEquals(h.seen[1]!.touched, ["pkgs/app/main.ts", "pkgs/app/fix.ts"]);
  }
});

Deno.test("verifyMergeBeforePush: a failure that survives every round is refused, naming the command and the rounds", async () => {
  const h = harness({
    outcomes: [{
      status: "failed",
      failingCommand: "deno task test:unit in /merge-tree/pkgs/app",
      output: "FAILED assertion in widget_test.ts",
    }],
  });
  const result = await verifyMergeBeforePush(h.options);
  assertEquals(result.kind, "refused");
  if (result.kind !== "refused") return;
  assertStringIncludes(
    result.detail,
    "deno task test:unit in /merge-tree/pkgs/app still fails after 2 repair round(s)",
  );
  assertStringIncludes(result.detail, "FAILED assertion in widget_test.ts");
  // Exactly maxRounds agent calls, then the refusal.
  assertEquals(h.agentCalls.map((r) => r.round), [1, 2]);
  assertEquals(h.seen.length, MERGE_FAST_CHECK_REPAIR_ROUNDS + 1);
});

Deno.test("verifyMergeBeforePush: the maxRounds option bounds the repair rounds", async () => {
  const h = harness({ outcomes: [LINT_FAILURE] });
  const result = await verifyMergeBeforePush({
    ...h.options,
    maxRounds: 1,
  });
  assertEquals(result.kind, "refused");
  assertEquals(h.agentCalls.length, 1);
  assertEquals(h.seen.length, 2);
});

Deno.test("verifyMergeBeforePush: an unverified check is refused at once, with no repair", async () => {
  const h = harness({
    outcomes: [{
      status: "unverified",
      detail: "deno lint in /merge-tree/pkgs/app could not be run",
      output: "spawn deno ENOENT",
    }],
  });
  const result = await verifyMergeBeforePush(h.options);
  assertEquals(h.agentCalls.length, 0);
  assertEquals(h.seen.length, 1);
  assertEquals(result.kind, "refused");
  if (result.kind !== "refused") return;
  assertStringIncludes(result.detail, "could not be run");
  assertStringIncludes(result.detail, "spawn deno ENOENT");
});

Deno.test("verifyMergeBeforePush: a repair agent that fails refuses the push with its message", async () => {
  const h = harness({
    outcomes: [LINT_FAILURE],
    replies: [{ ok: false, error: new Error("boom") }],
  });
  assertEquals(await verifyMergeBeforePush(h.options), {
    kind: "refused",
    detail: "repair agent failed: boom",
  });
  assertEquals(h.seen.length, 1);
});

Deno.test("verifyMergeBeforePush: a repair run the worker or provider ended is cut short, not judged", async () => {
  const outcomes: MergeConflictAgentOutcome[] = [
    { terminated: true },
    { terminated: false, providerUnavailable: "quota exhausted" },
    { terminated: false, finishDeadline: true },
  ];
  for (const outcome of outcomes) {
    const h = harness({
      outcomes: [LINT_FAILURE],
      replies: [{ ok: true, value: outcome }],
    });
    assertEquals(await verifyMergeBeforePush(h.options), {
      kind: "cut-short",
      outcome,
    });
    assertEquals(h.seen.length, 1);
  }
});

Deno.test("verifyMergeBeforePush: a failed path listing is refused naming git's error, before any check", async () => {
  const h = harness({
    diffs: [{ code: 128, stderr: "fatal: bad revision abc123" }],
    outcomes: [LINT_FAILURE],
  });
  const result = await verifyMergeBeforePush(h.options);
  assertEquals(result.kind, "refused");
  if (result.kind !== "refused") return;
  assertStringIncludes(result.detail, "fatal: bad revision abc123");
  assertEquals(h.seen.length, 0);
});

Deno.test("verifyMergeBeforePush: a path listing that fails after a repair is refused, not re-checked", async () => {
  const h = harness({
    diffs: [
      ["pkgs/app/main.ts"],
      { code: 128, stderr: "fatal: index is locked" },
    ],
    outcomes: [LINT_FAILURE],
  });
  const result = await verifyMergeBeforePush(h.options);
  assertEquals(h.agentCalls.length, 1);
  assertEquals(h.seen.length, 1);
  assertEquals(result.kind, "refused");
  if (result.kind !== "refused") return;
  assertStringIncludes(result.detail, "fatal: index is locked");
});

Deno.test("verifyMergeBeforePush: a failing merged-subjects log gives the repair round no subjects", async () => {
  const h = harness({
    logCode: 128,
    mergeHeadCode: 0,
    outcomes: [LINT_FAILURE, { status: "passed", ran: [], leftToCi: [] }],
  });
  const result = await verifyMergeBeforePush(h.options);
  assertEquals(result.kind, "passed");
  assertEquals(h.agentCalls[0]!.mergedCommitSubjects, []);
  assertEquals(h.agentCalls[0]!.mergeStaged, true);
});
