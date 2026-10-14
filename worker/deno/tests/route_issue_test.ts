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
