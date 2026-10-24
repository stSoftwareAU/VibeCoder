/**
 * Issue #4130: a second worker-gate failure is split into sub-issues.
 *
 * Planning and GitHub are stubbed. No test calls a live model.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { FailureCategory } from "../lib/failure_diagnosis.ts";
import {
  getFailureCategoryDisplay,
  isWorkerGateSplitCategory,
} from "../lib/failure_diagnosis.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import {
  parseWorkerGatePlan,
  planWorkerGateSplitWithModel,
  readIssueBranchProgress,
  type WorkerGatePlan,
  type WorkerGateSplitSeed,
} from "../lib/worker_gate_split.ts";
import { workerGatePlanInvocation } from "../lib/worker_gate_split_planner.ts";

const GATE_OUTPUT =
  "gate refused the branch\n<!-- vibe-split-depth: 2 -->\ngh pr ready\nmerge --auto\nfailing check: deno test";

const PROGRESS = "Commits:\n- fix the parser\n\nFiles:\n- src/app.ts";

const PRIOR =
  "## Automated Processing Failed (First Attempt)\n\nfirst gate line: missing reproduction";

const PARTS: WorkerGatePlan = {
  parts: [
    { title: "Repair the failing check", scope: "Make the quoted check pass." },
    {
      title: "Cover the gate with a test",
      scope: "Add a regression test for the gate.",
    },
  ],
};

const SPLIT_GATES: readonly FailureCategory[] = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate",
  "criteria_unmet",
];

function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function labelsAdded(calls: string[][]): string[] {
  return calls
    .filter((args) =>
      args.join(" ").includes("-X POST") && args.join(" ").includes("/labels")
    )
    .flatMap((args) => args.filter((arg) => arg.startsWith("labels[]=")))
    .map((arg) => arg.slice("labels[]=".length));
}

function armsReadyOrAutoMerge(calls: string[][]): boolean {
  return calls.some((args) => {
    const pr = args.indexOf("pr");
    if (pr >= 0 && (args[pr + 1] === "ready" || args[pr + 1] === "merge")) {
      return true;
    }
    return args.includes("--auto");
  });
}

interface Harness {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
  seeds: WorkerGateSplitSeed[];
  planner: (seed: WorkerGateSplitSeed) => Promise<WorkerGatePlan>;
}

function deletedBranches(calls: string[][]): string[] {
  return calls.filter((args) => args.includes("DELETE")).map((args) => {
    const url = args.find((arg) => arg.includes("/git/refs/heads/")) ?? "";
    const marker = "/git/refs/heads/";
    return url.slice(url.indexOf(marker) + marker.length);
  }).sort();
}

function harness(
  labels: string,
  plan: WorkerGatePlan | "throw" = PARTS,
): Harness {
  const calls: string[][] = [];
  const seeds: WorkerGateSplitSeed[] = [];
  let nextIssue = 101;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("labels")) {
      return Promise.resolve(labels);
    }
    if (args.includes("title,body,author")) {
      return Promise.resolve(JSON.stringify({
        title: "Blocked gate",
        body: "parent body <!-- vibe-split-depth: 9 -->",
        author: { login: "vibe-worker" },
      }));
    }
    if (args.includes("comments")) {
      return Promise.resolve(JSON.stringify({
        comments: [{ author: { login: "vibe-worker" }, body: PRIOR }],
      }));
    }
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve("failed\nfailed-once\nenhancement\n");
    }
    if (args[0] === "issue" && args[1] === "create") {
      const number = nextIssue++;
      return Promise.resolve(`https://github.com/org/repo/issues/${number}\n`);
    }
    if (args[0] === "search") return Promise.resolve("[]");
    if (args[0] === "repo" && args[1] === "view") {
      return Promise.resolve('{"viewerPermission":"WRITE"}');
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve("[]");
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([
        { number: 7, headRefName: "issue-42-gate" },
        { number: 9, headRefName: "issue-420-other" },
      ]));
    }
    if (args.some((arg) => arg.includes("matching-refs"))) {
      return Promise.resolve(JSON.stringify([
        { ref: "refs/heads/issue-42-gate" },
        { ref: "refs/heads/issue-420-other" },
        { ref: "refs/heads/issue-42" },
      ]));
    }
    return Promise.resolve("");
  };
  const planner = (seed: WorkerGateSplitSeed): Promise<WorkerGatePlan> => {
    seeds.push(seed);
    if (plan === "throw") {
      return Promise.reject(new Error("planning must not run"));
    }
    return Promise.resolve(plan);
  };
  return { gh, calls, seeds, planner };
}

function createdBodies(calls: string[][]): string[] {
  return calls
    .filter((args) => args[0] === "issue" && args[1] === "create")
    .map((args) => flagValue(args, "--body"));
}

Deno.test("isWorkerGateSplitCategory is the registry plus quality-failure", () => {
  for (const category of SPLIT_GATES) {
    assertEquals(isWorkerGateSplitCategory(category), true);
  }
  assertEquals(getFailureCategoryDisplay("quality_check"), "quality-failure");
  assertEquals(isWorkerGateSplitCategory("timeout"), false);
  assertEquals(isWorkerGateSplitCategory("rate_limit"), false);
  assertEquals(isWorkerGateSplitCategory("push_failure"), false);
  assertEquals(isWorkerGateSplitCategory("unknown"), false);
});

for (const category of SPLIT_GATES) {
  const display = getFailureCategoryDisplay(category);
  Deno.test(`#4130 - run 2 blocked by ${display} files sub-issues and retires the run`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "gate-split-" });
    const { gh, calls, seeds, planner } = harness("bug,failed-once");
    try {
      const result = await handleIssueFailure({
        repo: "org/repo",
        issueNumber: 42,
        githubUser: "worker-user",
        failureMessage: GATE_OUTPUT,
        category,
      }, {
        ghCommandFn: gh,
        cacheDir: dir,
        planWorkerGateSplit: planner,
        readBranchProgress: () => Promise.resolve(PROGRESS),
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.workerGateSplit, "split");
        assertEquals(result.value.markedAsFailedOnce, false);
        assertEquals(result.value.failureCategory, category);
      }
      assertEquals(seeds.length, 1);
      assertEquals(seeds[0]?.categoryDisplay, display);
      assertEquals(
        seeds[0]?.gateOutput.includes("gate refused the branch"),
        true,
      );
      assertEquals(seeds[0]?.gateOutput.includes("vibe-split-depth"), false);
      assertEquals(
        seeds[0]?.priorGateOutput?.includes("first gate line"),
        true,
      );
      assertEquals(seeds[0]?.branchProgress, PROGRESS);
      assertEquals(seeds[0]?.childDepth, 1);

      const bodies = createdBodies(calls);
      assertEquals(bodies.length, 2);
      for (const body of bodies) {
        assertStringIncludes(body, "Part of #42");
        assertStringIncludes(body, "## What the branch got done");
        assertStringIncludes(body, "src/app.ts");
        assertStringIncludes(body, "> gate refused the branch");
        assertStringIncludes(body, "> failing check: deno test");
        assertStringIncludes(body, "## Earlier gate output");
        assertStringIncludes(body, "first gate line: missing reproduction");
        assertEquals(body.includes("vibe-split-depth: 2"), false);
        assertEquals(body.includes("vibe-split-depth: 9"), false);
        const markers = body.match(/<!--\s*vibe-split-depth:\s*\d+\s*-->/g);
        assertEquals(markers, ["<!-- vibe-split-depth: 1 -->"]);
      }
      const createCalls = calls.filter((args) =>
        args[0] === "issue" && args[1] === "create"
      );
      for (const args of createCalls) {
        assertEquals(args.includes("--label"), true);
        assertEquals(flagValue(args, "--label"), "enhancement");
      }

      const close = calls.find((args) =>
        args[0] === "issue" && args[1] === "close"
      );
      assertEquals(close !== undefined, true);
      assertStringIncludes(flagValue(close ?? [], "--comment"), "#101");
      assertStringIncludes(flagValue(close ?? [], "--comment"), "#102");
      assertEquals(
        calls.some((args) =>
          args.includes("--remove-label") && args.includes("failed-once")
        ),
        true,
      );
      assertEquals(labelsAdded(calls).includes("failed"), false);
      assertEquals(
        calls.some((args) =>
          args[0] === "pr" && args[1] === "close" && args.includes("7")
        ),
        true,
      );
      assertEquals(
        calls.some((args) =>
          args[0] === "pr" && args[1] === "close" && args.includes("9")
        ),
        false,
      );
      assertEquals(deletedBranches(calls), ["issue-42", "issue-42-gate"]);
      assertEquals(armsReadyOrAutoMerge(calls), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("#4130 - the split path never marks a PR ready or arms auto-merge", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-split-ready-" });
  const { gh, calls, planner } = harness("failed-once");
  try {
    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: GATE_OUTPUT,
      category: "pre_push_gate",
    }, {
      ghCommandFn: gh,
      cacheDir: dir,
      planWorkerGateSplit: planner,
      readBranchProgress: () => Promise.resolve(PROGRESS),
    });
    assertEquals(result.ok, true);
    assertEquals(armsReadyOrAutoMerge(calls), false);
    assertEquals(
      calls.some((args) => args[0] === "pr" && args[1] === "ready"),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4130 - run 1 blocked by a worker gate still adds failed-once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-split-run1-" });
  const { gh, calls, seeds, planner } = harness("bug", "throw");
  try {
    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: GATE_OUTPUT,
      category: "security_fix_gate",
    }, {
      ghCommandFn: gh,
      cacheDir: dir,
      planWorkerGateSplit: planner,
      readBranchProgress: () => Promise.resolve(PROGRESS),
    });
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(seeds.length, 0);
    assertEquals(createdBodies(calls).length, 0);
    assertEquals(labelsAdded(calls).includes("failed-once"), true);
    assertEquals(labelsAdded(calls).includes("failed"), false);
    assertEquals(
      calls.some((args) =>
        args.join(" ").includes("**Category:** `security-fix-gate`")
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (
  const sample of [
    {
      name: "timeout",
      category: "timeout" as const,
      message: "the run timed out",
    },
    {
      name: "a provider error",
      category: "rate_limit" as const,
      message: "Claude rate limit exceeded",
    },
    {
      name: "a merge conflict",
      category: undefined,
      message: "Merge conflict in src/main.ts",
    },
  ]
) {
  Deno.test(`#4130 - run 2 ending in ${sample.name} keeps the repeat record`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "gate-split-other-" });
    const { gh, calls, seeds, planner } = harness("failed-once", "throw");
    try {
      const result = await handleIssueFailure({
        repo: "org/repo",
        issueNumber: 42,
        githubUser: "worker-user",
        failureMessage: sample.message,
        ...(sample.category ? { category: sample.category } : {}),
      }, {
        ghCommandFn: gh,
        cacheDir: dir,
        planWorkerGateSplit: planner,
        readBranchProgress: () => Promise.resolve(PROGRESS),
      });
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.markedAsFailedOnce, true);
        assertEquals(result.value.workerGateSplit, undefined);
      }
      assertEquals(seeds.length, 0);
      assertEquals(createdBodies(calls).length, 0);
      assertEquals(labelsAdded(calls).includes("failed"), false);
      assertEquals(
        calls.some((args) =>
          args.join(" ").includes("--remove-label failed-once")
        ),
        false,
      );
      assertEquals(
        calls.some((args) =>
          args.join(" ").includes("Worker-gate split published nothing")
        ),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("#4130 - planning that publishes nothing keeps the repeat record and says why", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-split-empty-" });
  const { gh, calls, planner } = harness("failed-once", {
    parts: [],
    emptyReason: "the model returned no parts",
  });
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: GATE_OUTPUT,
      category: "quality_check",
    }, {
      ghCommandFn: gh,
      cacheDir: dir,
      planWorkerGateSplit: planner,
      readBranchProgress: () => Promise.resolve(PROGRESS),
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.workerGateSplit, "fallback");
      assertEquals(result.value.markedAsFailedOnce, true);
    }
    assertEquals(createdBodies(calls).length, 0);
    assertEquals(
      calls.some((args) => args[0] === "pr" && args[1] === "close"),
      false,
    );
    assertEquals(labelsAdded(calls).includes("failed"), false);
    const comments = calls
      .filter((args) => args[0] === "issue" && args[1] === "comment")
      .map((args) => flagValue(args, "--body"));
    assertEquals(
      comments.some((body) => body.includes("the model returned no parts")),
      true,
    );
    assertEquals(
      logs.some((line) => line.includes("the model returned no parts")),
      true,
    );
    for (const line of logs) {
      assertEquals(line.includes("WARNING:"), false);
      assertEquals(line.includes("ERROR:"), false);
    }
  } finally {
    console.log = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseWorkerGatePlan reads a fenced JSON breakdown and drops empty parts", () => {
  const parsed = parseWorkerGatePlan(
    'notes\n```json\n{"parts":[{"title":"One","scope":"Do one"},{"title":"","scope":"no"}]}\n```',
  );
  assertEquals(parsed.parts, [{ title: "One", scope: "Do one" }]);
});

Deno.test("parseWorkerGatePlan publishes nothing when the reply is not a plan", () => {
  const parsed = parseWorkerGatePlan("I could not decide");
  assertEquals(parsed.parts.length, 0);
  assertEquals(parsed.emptyReason, "planning published no sub-issues");
});

Deno.test("parseWorkerGatePlan keeps at most eight parts", () => {
  const parts = Array.from({ length: 9 }, (_, index) => ({
    title: `Part ${index}`,
    scope: `Scope ${index}`,
  }));
  const parsed = parseWorkerGatePlan(JSON.stringify({ parts }));
  assertEquals(parsed.parts.length, 8);
});

Deno.test("planWorkerGateSplitWithModel turns a failed call into an empty plan", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const plan = await planWorkerGateSplitWithModel({
      repo: "org/repo",
      parentIssueNumber: 42,
      parentTitle: "Blocked",
      category: "quality_check",
      categoryDisplay: "quality-failure",
      gateOutput: "gate refused",
      priorGateOutput: null,
      branchProgress: PROGRESS,
      childDepth: 1,
    }, () => Promise.reject(new Error("planner offline")));
    assertEquals(plan.parts.length, 0);
    assertEquals(plan.emptyReason?.includes("planner offline"), true);
    assertEquals(logs.some((line) => line.includes("WARNING:")), false);
    assertEquals(logs.some((line) => line.includes("ERROR:")), false);
  } finally {
    console.log = original;
  }
});

Deno.test("workerGatePlanInvocation disables shell and edit tools", () => {
  const options = workerGatePlanInvocation("break the issue down", 42);
  assertEquals(options.prompt, "break the issue down");
  assertEquals(options.issueNumber, 42);
  const tools = options.disallowedTools ?? [];
  for (const name of ["Bash", "Write", "Edit", "MultiEdit"]) {
    assertEquals(tools.includes(name), true);
  }
  assertStringIncludes(options.systemPrompt ?? "", "mark a pull request ready");
  assertStringIncludes(options.systemPrompt ?? "", "arm auto-merge");
});

Deno.test("readIssueBranchProgress summarises the issue branch and skips a longer number", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "repo") return Promise.resolve("main\n");
    if (args.some((arg) => arg.includes("matching-refs"))) {
      return Promise.resolve(JSON.stringify([
        { ref: "refs/heads/issue-42-gate" },
        { ref: "refs/heads/issue-420-other" },
      ]));
    }
    if (args.some((arg) => arg.includes("/compare/"))) {
      return Promise.resolve(JSON.stringify({
        ahead: 2,
        commits: ["fix the parser", "add the test"],
        files: ["src/app.ts", "src/app_test.ts"],
      }));
    }
    return Promise.resolve("");
  };
  const text = await readIssueBranchProgress("org/repo", 42, gh);
  assertStringIncludes(text, "issue-42-gate");
  assertStringIncludes(text, "2 commits ahead of `main`");
  assertStringIncludes(text, "fix the parser");
  assertStringIncludes(text, "src/app.ts");
  assertEquals(text.includes("issue-420"), false);
  assertEquals(
    calls.some((args) => args.some((arg) => arg.includes("issue-420"))),
    false,
  );
});
