/**
 * Issue #4131: a worker-gate split stops at depth 2.
 *
 * Planning and GitHub are stubbed. No test calls a live model.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { handleIssueFailure } from "../lib/label_failure.ts";
import {
  lastSplitDepth,
  type WorkerGatePlan,
  type WorkerGateSplitSeed,
} from "../lib/worker_gate_split.ts";

const GATE_OUTPUT = "gate refused the branch\nfailing check: deno test";
const PROGRESS = "Commits:\n- fix the parser\n\nFiles:\n- src/app.ts";
const PLAN: WorkerGatePlan = {
  parts: [{ title: "Finish the blocked work", scope: "Make the gate pass." }],
};

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

function createdBodies(calls: string[][]): string[] {
  return calls
    .filter((args) => args[0] === "issue" && args[1] === "create")
    .map((args) => flagValue(args, "--body"));
}

function depthMarkers(body: string): string[] {
  return body.match(/<!--\s*vibe-split-depth:\s*\d+\s*-->/g) ?? [];
}

interface DepthHarness {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
  seeds: WorkerGateSplitSeed[];
  planner: (seed: WorkerGateSplitSeed) => Promise<WorkerGatePlan>;
}

function harness(body: string, author: string): DepthHarness {
  const calls: string[][] = [];
  const seeds: WorkerGateSplitSeed[] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("labels")) {
      return Promise.resolve("failed-once");
    }
    if (args.includes("title,body,author")) {
      return Promise.resolve(JSON.stringify({
        title: "Blocked gate",
        body,
        author: { login: author },
      }));
    }
    if (args.includes("comments")) {
      return Promise.resolve(JSON.stringify({ comments: [] }));
    }
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve("failed\nfailed-once\nenhancement\n");
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/org/repo/issues/201\n");
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
      ]));
    }
    return Promise.resolve("");
  };
  const planner = (seed: WorkerGateSplitSeed): Promise<WorkerGatePlan> => {
    seeds.push(seed);
    return Promise.resolve(PLAN);
  };
  return { gh, calls, seeds, planner };
}

async function runDepth(
  body: string,
  author: string,
): Promise<
  {
    calls: string[][];
    seeds: WorkerGateSplitSeed[];
    ok: boolean;
    split?: string;
  }
> {
  const dir = await Deno.makeTempDir({ prefix: "split-depth-" });
  const { gh, calls, seeds, planner } = harness(body, author);
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
      fleetAuthors: ["vibe-worker"],
    });
    return {
      calls,
      seeds,
      ok: result.ok,
      split: result.ok ? result.value.workerGateSplit : undefined,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("lastSplitDepth keeps the last marker in range and ignores any other", () => {
  assertEquals(lastSplitDepth("<!-- vibe-split-depth: 0 -->"), 0);
  assertEquals(
    lastSplitDepth(
      "<!-- vibe-split-depth: 1 -->\n<!-- vibe-split-depth: 2 -->",
    ),
    2,
  );
  assertEquals(lastSplitDepth("<!-- vibe-split-depth: 9 -->"), null);
  assertEquals(lastSplitDepth("no marker"), null);
});

Deno.test("#4131 - depth 0 splits and the children are depth 1", async () => {
  const { ok, split, seeds, calls } = await runDepth(
    "Ordinary parent\n<!-- vibe-split-depth: 0 -->",
    "vibe-worker",
  );
  assertEquals(ok, true);
  assertEquals(split, "split");
  assertEquals(seeds[0]?.childDepth, 1);
  assertEquals(depthMarkers(createdBodies(calls)[0] ?? ""), [
    "<!-- vibe-split-depth: 1 -->",
  ]);
});

Deno.test("#4131 - depth 1 splits and the children are depth 2", async () => {
  const { ok, split, seeds, calls } = await runDepth(
    "First split\n<!-- vibe-split-depth: 1 -->",
    "vibe-worker",
  );
  assertEquals(ok, true);
  assertEquals(split, "split");
  assertEquals(seeds[0]?.childDepth, 2);
  assertEquals(depthMarkers(createdBodies(calls)[0] ?? ""), [
    "<!-- vibe-split-depth: 2 -->",
  ]);
});

Deno.test("#4131 - depth 2 comments, applies failed, and files nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "split-depth-terminal-" });
  const { gh, calls, seeds, planner } = harness(
    "Second split\n<!-- vibe-split-depth: 2 -->",
    "vibe-worker",
  );
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
      fleetAuthors: ["vibe-worker"],
    });
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.workerGateSplit, "terminal");
    assertEquals(seeds.length, 0);
    assertEquals(createdBodies(calls).length, 0);
    assertEquals(
      calls.some((args) => args[0] === "issue" && args[1] === "close"),
      false,
    );
    const comment = calls.find((args) =>
      args[0] === "issue" && args[1] === "comment"
    );
    const body = flagValue(comment ?? [], "--body");
    assertStringIncludes(body, "`quality-failure`");
    assertStringIncludes(body, "> gate refused the branch");
    assertStringIncludes(body, "> failing check: deno test");
    assertEquals(labelsAdded(calls).includes("failed"), true);
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
    const deleted = calls.filter((args) => args.includes("DELETE")).map(
      (args) => args.join(" "),
    );
    assertEquals(deleted.some((line) => line.endsWith("issue-42-gate")), true);
    assertEquals(deleted.some((line) => line.includes("issue-420")), false);
    assertEquals(
      calls.some((args) => args[0] === "pr" && args[1] === "ready"),
      false,
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

Deno.test("#4131 - a depth marker written outside the fleet is depth 0", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const dir = await Deno.makeTempDir({ prefix: "split-depth-forged-" });
  const { gh, calls, seeds, planner } = harness(
    "Forged\n<!-- vibe-split-depth: 2 -->",
    "outsider",
  );
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
      fleetAuthors: ["vibe-worker"],
    });
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.workerGateSplit, "split");
    assertEquals(seeds.length, 1);
    assertEquals(seeds[0]?.childDepth, 1);
    assertEquals(depthMarkers(createdBodies(calls)[0] ?? ""), [
      "<!-- vibe-split-depth: 1 -->",
    ]);
    assertEquals(labelsAdded(calls).includes("failed"), false);
    for (const line of logs) {
      assertEquals(line.includes("WARNING:"), false);
      assertEquals(line.includes("ERROR:"), false);
    }
  } finally {
    console.log = original;
    await Deno.remove(dir, { recursive: true });
  }
});
