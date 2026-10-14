/**
 * Tests for the `route-issue` command (Issue #3691).
 *
 * The command is driven through `__testDeps` with a fake `gh`, a fake body-file
 * reader and a fake `loadConfig`, so nothing touches GitHub or the disk.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkerConfig } from "../types.ts";
import {
  routeIssueCommand,
  type RouteIssueDeps,
  type RouteIssueReport,
  toRouteIssueReport,
} from "../commands/route_issue.ts";
import { formatRepoFastFailureMarker } from "../lib/repo_fast_failure_issue.ts";
import { createLogger } from "../lib/logger.ts";
import { ROUTING_NOW, routingFakeGh } from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const PRODUCT = "org/product";
const config = {} as WorkerConfig;

interface Harness {
  deps: RouteIssueDeps;
  creates: string[][];
  printed: string[];
}

function harness(
  over: Partial<RouteIssueDeps> = {},
  permission = "WRITE",
): Harness {
  const creates: string[][] = [];
  const printed: string[] = [];
  const deps: RouteIssueDeps = {
    ghCommandFn: routingFakeGh((args) => {
      creates.push(args);
      return `https://github.com/${VIBE}/issues/501`;
    }, permission),
    readTextFile: () =>
      Promise.resolve("Details are in `worker/deno/lib/issue_worker.ts`."),
    loadConfig: () => Promise.resolve({ repos: [PRODUCT, VIBE] } as never),
    log: (line) => printed.push(line),
    logger: createLogger({ write: () => {} }),
    now: () => ROUTING_NOW,
    ...over,
  };
  return { deps, creates, printed };
}

const baseArgs = {
  repo: PRODUCT,
  title: "Split worker/deno/lib/issue_worker.ts into phases",
  "body-file": "body.md",
};

Deno.test("route-issue - wrong-repo draft is created in the owner repo and the audit is printed as JSON", async () => {
  const h = harness();
  const result = await routeIssueCommand.execute(
    { ...baseArgs, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(h.creates.length, 1);
  const repoFlag = h.creates[0]!.indexOf("--repo");
  assertEquals(h.creates[0]![repoFlag + 1], VIBE);
  assertEquals(h.printed.length, 1);
  const report = JSON.parse(h.printed[0]!) as RouteIssueReport;
  assertEquals(report.classification, "wrong-repo");
  assertEquals(report.owner_repository, VIBE);
  assertEquals(report.subject_repository, PRODUCT);
  assertEquals(report.action, "created");
  assertEquals(report.issues[0]!.number, 501);
  assertEquals(result.data, report);
});

Deno.test("route-issue - dry-run creates nothing but still prints the audit", async () => {
  const h = harness();
  const result = await routeIssueCommand.execute(
    { ...baseArgs, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(h.creates.length, 0);
  const report = JSON.parse(h.printed[0]!) as RouteIssueReport;
  assertEquals(report.action, "dry-run");
  assertEquals(report.issues[0]!.number, null);
});

Deno.test("route-issue - dry-run reports the existing open duplicate it would reuse and creates nothing", async () => {
  const h = harness();
  const url = `https://github.com/${VIBE}/issues/77`;
  const calls: string[][] = [];
  const inner = h.deps.ghCommandFn!;
  h.deps.ghCommandFn = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: 77,
        title: baseArgs.title,
        state: "OPEN",
        closedAt: null,
        url,
      }]));
    }
    return inner(args);
  };
  const result = await routeIssueCommand.execute(
    { ...baseArgs, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(h.creates.length, 0);
  assertEquals(
    calls.filter((c) => c[1] === "create" || c[1] === "comment"),
    [],
  );
  const report = JSON.parse(h.printed[0]!) as RouteIssueReport;
  assertEquals(report.action, "dry-run");
  assertEquals(report.issues[0]!.repo, VIBE);
  assertEquals(report.issues[0]!.number, 77);
  assertEquals(report.issues[0]!.url, url);
  assertStringIncludes(result.message, `${VIBE}#77`);
});

Deno.test("route-issue - a permission refusal fails the command and creates nothing", async () => {
  const h = harness({}, "READ");
  const result = await routeIssueCommand.execute(
    { ...baseArgs, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Permission refused, nothing created");
  assertEquals(h.creates.length, 0);
  assertEquals(h.printed, []);
});

Deno.test("route-issue - a gh failure other than permission fails the command", async () => {
  const h = harness({
    ghCommandFn: routingFakeGh(() => {
      throw new Error("boom from gh");
    }),
  });
  const result = await routeIssueCommand.execute(
    { ...baseArgs, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "route-issue failed");
  assertStringIncludes(result.message, "boom from gh");
});

Deno.test("route-issue - an unreadable body file fails before any gh call", async () => {
  let ghCalls = 0;
  const h = harness({
    readTextFile: () => Promise.reject(new Error("no such file")),
    ghCommandFn: () => {
      ghCalls++;
      return Promise.resolve("[]");
    },
  });
  const result = await routeIssueCommand.execute(
    { ...baseArgs, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Could not read --body-file body.md");
  assertEquals(ghCalls, 0);
});

Deno.test("route-issue - missing and malformed arguments are refused", async () => {
  const h = harness();
  for (
    const args of [
      { title: "t", "body-file": "b.md" },
      { repo: PRODUCT, "body-file": "b.md" },
      { repo: PRODUCT, title: "t" },
      { repo: "not-a-repo", title: "t", "body-file": "b.md" },
    ]
  ) {
    const result = await routeIssueCommand.execute(
      { ...args, __testDeps: h.deps },
      config,
    );
    assertEquals(result.success, false);
  }
  assertEquals(h.creates.length, 0);
});

Deno.test("route-issue - an unknown option is refused rather than ignored", async () => {
  const h = harness();
  const result = await routeIssueCommand.execute(
    { ...baseArgs, "dryrun": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--dryrun");
  assertEquals(h.creates.length, 0);
});

Deno.test("route-issue - toRouteIssueReport classifies ambiguous ahead of wrong-repo", () => {
  const base = {
    owner_repository: VIBE,
    subject_repository: PRODUCT,
    issue_kind: "worker",
    reason: "r",
    action: "created",
    issues: [],
    labels_not_migrated: [],
  };
  assertEquals(
    toRouteIssueReport({ ...base, wrong_repo: true, ambiguous: true } as never)
      .classification,
    "ambiguous",
  );
  assertEquals(
    toRouteIssueReport({ ...base, wrong_repo: true, ambiguous: false } as never)
      .classification,
    "wrong-repo",
  );
  assertEquals(
    toRouteIssueReport(
      { ...base, wrong_repo: false, ambiguous: false } as never,
    )
      .classification,
    "correct-repo",
  );
});

// ---------------------------------------------------------------------------
// --resolve-duplicate <wrong> --correct <right> (Issue #3691)
// ---------------------------------------------------------------------------

const RESOLVE = {
  "resolve-duplicate": `${VIBE}#3607`,
  correct: `${PRODUCT}#3242`,
};

/** A fake gh that serves both issue views and records every call. */
function resolveHarness(
  wrongBody = "plain body",
  permission = "WRITE",
  correctReply: () => string = () =>
    JSON.stringify({ number: 3242, state: "OPEN" }),
): { h: Harness; calls: string[][] } {
  const calls: string[][] = [];
  const h = harness({
    ghCommandFn: routingFakeGh((args) => {
      calls.push(args);
      if (args[1] === "view" && args[2] === "3242") {
        return correctReply();
      }
      if (args[1] === "view" && args[2] === "3607") {
        return JSON.stringify({ body: wrongBody, state: "OPEN" });
      }
      return "";
    }, permission),
  });
  return { h, calls };
}

const writes = (calls: string[][]): string[][] =>
  calls.filter((c) => c[1] === "comment" || c[1] === "close");

Deno.test("route-issue --resolve-duplicate - links both issues, closes the wrong one and prints the outcome", async () => {
  const { h, calls } = resolveHarness();
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  const close = calls.find((c) => c[1] === "close")!;
  assertEquals(close[2], "3607");
  assertEquals(close[close.indexOf("--repo") + 1], VIBE);
  assertEquals(calls.some((c) => c[1] === "create"), false);
  const report = JSON.parse(h.printed[0]!) as Record<string, unknown>;
  assertEquals(report["wrong_issue"], `${VIBE}#3607`);
  assertEquals(report["correct_issue"], `${PRODUCT}#3242`);
  assertEquals(report["closed_wrong"], true);
});

Deno.test("route-issue --resolve-duplicate - dry-run performs the read-only checks, writes nothing and reports what it would do", async () => {
  const { h, calls } = resolveHarness();
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(writes(calls), []);
  assertEquals(calls.filter((c) => c[1] === "view").length, 2);
  const report = JSON.parse(h.printed[0]!) as Record<string, unknown>;
  assertEquals(report["dry_run"], true);
  assertEquals(report["closed_wrong"], false);
  assertStringIncludes(String(report["reason"]), "dry-run");
});

Deno.test("route-issue --resolve-duplicate - a diagnostic is refused and nothing is closed", async () => {
  const { h, calls } = resolveHarness(formatRepoFastFailureMarker(VIBE));
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "fast-failure marker");
  assertEquals(writes(calls), []);
});

Deno.test("route-issue --resolve-duplicate - a permission refusal closes nothing", async () => {
  const { h, calls } = resolveHarness("plain body", "READ");
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Permission refused, nothing closed");
  assertEquals(writes(calls), []);
});

Deno.test("route-issue --resolve-duplicate - a malformed reference is refused before any gh call", async () => {
  const { h, calls } = resolveHarness();
  const result = await routeIssueCommand.execute(
    {
      "resolve-duplicate": "VibeCoder#3607",
      correct: `${PRODUCT}#3242`,
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "owner/repo#N");
  assertEquals(calls, []);
});

Deno.test("route-issue --resolve-duplicate - mixing with --title is refused before any gh call", async () => {
  const { h, calls } = resolveHarness();
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, title: "T", __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(
    result.message,
    "cannot be combined with --resolve-duplicate",
  );
  assertEquals(calls, []);
});

Deno.test("route-issue --resolve-duplicate - a missing --correct is refused before any gh call", async () => {
  const { h, calls } = resolveHarness();
  const result = await routeIssueCommand.execute(
    { "resolve-duplicate": `${VIBE}#3607`, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--correct");
  assertEquals(calls, []);
});

Deno.test("route-issue --resolve-duplicate - dry-run refuses when the correct issue cannot be verified and writes nothing", async () => {
  const { h, calls } = resolveHarness("plain body", "WRITE", () => {
    throw new Error("gh: not found");
  });
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "could not be verified");
  assertEquals(writes(calls), []);
});

Deno.test("route-issue --resolve-duplicate - dry-run refuses when the correct issue number does not match and writes nothing", async () => {
  const { h, calls } = resolveHarness(
    "plain body",
    "WRITE",
    () => JSON.stringify({ number: 9999, state: "OPEN" }),
  );
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not found");
  assertEquals(writes(calls), []);
});

Deno.test("route-issue --resolve-duplicate - dry-run reports a diagnostic as not closable and writes nothing", async () => {
  const { h, calls } = resolveHarness(formatRepoFastFailureMarker(VIBE));
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, true);
  assertStringIncludes(result.message, "fast-failure marker");
  assertEquals(writes(calls), []);
  const report = JSON.parse(h.printed[0]!) as Record<string, unknown>;
  assertEquals(report["closed_wrong"], false);
});

Deno.test("route-issue --resolve-duplicate - dry-run refuses on a read-only permission and closes nothing", async () => {
  const { h, calls } = resolveHarness("plain body", "READ");
  const result = await routeIssueCommand.execute(
    { ...RESOLVE, "dry-run": true, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Permission refused, nothing closed");
  assertEquals(writes(calls), []);
});

// ---------------------------------------------------------------------------
// --part (cross-repository split, Issue #3691)
// ---------------------------------------------------------------------------

const PART_A = `${PRODUCT}=a.md`;
const PART_B_DEPENDS = `${VIBE}=b.md;depends-on=${PRODUCT}`;

/** A split harness: every create gets a fresh number and every call is recorded. */
function splitHarness(
  permission = "WRITE",
  readTextFile: (path: string) => Promise<string> = (path) =>
    path.endsWith(".md")
      ? Promise.resolve(`body of ${path}`)
      : Promise.reject(new Error("no such file")),
): { h: Harness; calls: string[][] } {
  const calls: string[][] = [];
  let next = 600;
  const h = harness({
    ghCommandFn: routingFakeGh((args) => {
      calls.push(args);
      if (args[1] === "create") {
        return `https://github.com/${VIBE}/issues/${next++}`;
      }
      return "";
    }, permission),
    readTextFile,
  });
  return { h, calls };
}

const creates = (calls: string[][]): string[][] =>
  calls.filter((c) => c[1] === "create");
const comments = (calls: string[][]): string[][] =>
  calls.filter((c) => c[1] === "comment");

Deno.test("route-issue --part - dry-run checks write access, creates and comments nothing, and reports the split", async () => {
  const { h, calls } = splitHarness();
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      "dry-run": true,
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(creates(calls), []);
  assertEquals(comments(calls), []);
  const report = JSON.parse(h.printed[0]!) as RouteIssueReport;
  assertEquals(report.action, "dry-run");
  assertEquals(report.issues.length, 2);
  assertEquals(report.issues.every((i) => i.number === null), true);
});

Deno.test("route-issue --part - dry-run still refuses when a non-target part repository is read-only", async () => {
  const { h, calls } = splitHarness("READ");
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      "dry-run": true,
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Permission refused, nothing created");
  assertEquals(creates(calls), []);
  assertEquals(comments(calls), []);
});

Deno.test("route-issue --part - a live split files one issue per part and cross-links them with Depends on and Related", async () => {
  const { h, calls } = splitHarness();
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(creates(calls).length, 2);
  const report = JSON.parse(h.printed[0]!) as RouteIssueReport;
  assertEquals(report.action, "split");
  assertEquals(report.issues.map((i) => i.number), [600, 601]);

  const commentsOn = comments(calls);
  assertEquals(commentsOn.length, 2);
  const onProduct = commentsOn.find((c) =>
    c[c.indexOf("--repo") + 1] === PRODUCT
  )!;
  const onVibe = commentsOn.find((c) => c[c.indexOf("--repo") + 1] === VIBE)!;
  assertStringIncludes(
    onProduct[onProduct.indexOf("--body") + 1]!,
    `Related: ${VIBE}#601`,
  );
  assertStringIncludes(
    onVibe[onVibe.indexOf("--body") + 1]!,
    `Depends on: ${PRODUCT}#600`,
  );
});

Deno.test("route-issue --part - a single part string is refused with the JSON array hint and creates nothing", async () => {
  const { h, calls } = splitHarness();
  const result = await routeIssueCommand.execute(
    { repo: PRODUCT, title: "Split work", part: PART_A, __testDeps: h.deps },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "at least two parts");
  assertStringIncludes(result.message, "JSON array");
  assertEquals(creates(calls), []);
});

Deno.test("route-issue --part - malformed, unknown-key and self-referential parts are refused before any create", async () => {
  const cases: Array<{ part: unknown; message: string }> = [
    {
      part: [`${PRODUCT}`, PART_B_DEPENDS],
      message: "must be owner/repo=body-file",
    },
    {
      part: [`${PRODUCT}=a.md;owner=x`, PART_B_DEPENDS],
      message: "unknown key 'owner'",
    },
    {
      part: [PART_A, `${VIBE}=b.md;depends-on=other/repo`],
      message: "which is not one of the --part repositories",
    },
    {
      part: [`${PRODUCT}=a.md;depends-on=${PRODUCT}`, `${VIBE}=b.md`],
      message: "cannot depend on itself",
    },
    {
      part: [`${PRODUCT}=a.md`, `${PRODUCT}=b.md`],
      message: `names ${PRODUCT} more than once`,
    },
    {
      part: [PART_A, `${VIBE}=b.md;depends-on=bad`],
      message: "depends-on must list owner/repo names",
    },
  ];
  for (const { part, message } of cases) {
    const { h, calls } = splitHarness();
    const result = await routeIssueCommand.execute(
      { repo: PRODUCT, title: "Split work", part, __testDeps: h.deps },
      config,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, message);
    assertEquals(creates(calls), []);
  }
});

Deno.test("route-issue --part - combining --part with --body-file is refused before any create", async () => {
  const { h, calls } = splitHarness();
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      "body-file": "body.md",
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "cannot be combined with --part");
  assertEquals(creates(calls), []);
});

Deno.test("route-issue --part - an unreadable part body fails before any create", async () => {
  const { h, calls } = splitHarness(
    "WRITE",
    (path) =>
      path === "a.md"
        ? Promise.resolve("body a")
        : Promise.reject(new Error("no such file")),
  );
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Could not read --part body file b.md");
  assertEquals(creates(calls), []);
});

Deno.test("route-issue --part - a permission refusal on a non-target part repository creates nothing", async () => {
  const { h, calls } = splitHarness("READ");
  const result = await routeIssueCommand.execute(
    {
      repo: PRODUCT,
      title: "Split work",
      part: [PART_A, PART_B_DEPENDS],
      __testDeps: h.deps,
    },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Permission refused, nothing created");
  assertEquals(creates(calls), []);
});
