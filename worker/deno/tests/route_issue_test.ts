/**
 * Tests for the `route-issue` command's create mode and argument handling
 * (Issue #3744, part of #3691). The fake `gh` models the real CLI over an
 * in-memory store, so the tests assert what ends up on GitHub, the printed
 * result and the exit status. No network, no real clock.
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  routeIssueCommand,
  type RouteIssueCreateData,
  type RouteIssueDeps,
} from "../commands/route_issue.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDefaultRegistry } from "../mod.ts";
import type { WorkerConfig } from "../types.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import {
  type FakeGh,
  fakeStore,
  isWriteCall,
  routingFakeGh,
} from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const AUTOTRADER = "stSoftwareAU/GRQ-AutoTrader";
const GRQ = "stSoftwareAU/GRQ";

const BODIES: Record<string, string> = {
  "worker.md": "`worker/deno/lib/lane_worktree.ts` wedges when HEAD dangles.",
  "pwa.md":
    "The GRQ-AutoTrader PWA layout leaves a blank space above the header.",
  "vague.md": "Something is off somewhere.",
};

function config(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: [VIBE, GRQ, AUTOTRADER],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

function newGh(): FakeGh {
  return routingFakeGh(
    fakeStore([], { [VIBE]: "WRITE", [GRQ]: "WRITE", [AUTOTRADER]: "WRITE" }),
  );
}

async function run(args: Record<string, unknown>, gh: FakeGh = newGh()) {
  const deps: RouteIssueDeps = {
    ghCommandFn: gh.ghCommandFn,
    readTextFile: async (path) => {
      if (!Object.hasOwn(BODIES, path)) {
        throw new Deno.errors.NotFound(`No such file: ${path}`);
      }
      return BODIES[path]!;
    },
    now: () => new Date("2026-10-15T00:00:00Z"),
    logger: makeRecordingLogger().logger,
  };
  const result = await routeIssueCommand.execute(
    { ...args, __testDeps: deps },
    config(),
  );
  return { result, gh };
}

Deno.test("route-issue - --dry-run --json prints all four audit fields and makes no write call", async () => {
  const { result, gh } = await run({
    repo: VIBE,
    title: "PWA iPhone: too big a gap above the header",
    "body-file": "pwa.md",
    label: "bug",
    "dry-run": true,
    json: true,
  });
  assertEquals(result.success, true);
  const printed = JSON.parse(result.message) as RouteIssueCreateData;
  assertEquals(printed.owner_repository, AUTOTRADER);
  assertEquals(printed.subject_repository, AUTOTRADER);
  assertEquals(printed.issue_kind, "implementation");
  assertStringIncludes(printed.reason, "product change");
  assertEquals(printed.action, "would-create");
  assertEquals(printed.issue, null);
  assertEquals(printed.labels_not_migrated, ["bug"]);
  assertEquals(gh.calls.filter(isWriteCall), []);
  assertEquals(gh.store.issues, []);
});

Deno.test("route-issue - a live run files in the owner repository and prints a summary", async () => {
  const { result, gh } = await run({
    repo: AUTOTRADER,
    title: "Lane worktree heal for a dangling HEAD",
    "body-file": "worker.md",
    label: ["enhancement"],
  });
  assertEquals(result.success, true);
  assertStringIncludes(result.message, `route-issue created: ${VIBE}#1`);
  const [issue] = gh.store.issues;
  assertEquals(issue?.repo, VIBE);
  assertEquals(issue?.labels, []);
  assertStringIncludes(issue!.body, "Labels not migrated: enhancement");
  assertEquals((result.data as RouteIssueCreateData).mode, "create");
});

Deno.test("route-issue - an ambiguous owner files nothing and exits non-zero with the basis", async () => {
  const { result, gh } = await run({
    repo: VIBE,
    title: "Something is off",
    "body-file": "vague.md",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "ambiguous owner");
  assertEquals(gh.calls, []);
});

for (const missing of ["repo", "title", "body-file"]) {
  Deno.test(`route-issue - a missing --${missing} exits non-zero and names it`, async () => {
    const args: Record<string, unknown> = {
      repo: VIBE,
      title: "Lane worktree heal",
      "body-file": "worker.md",
    };
    delete args[missing];
    const { result, gh } = await run(args);
    assertEquals(result.success, false);
    assertEquals(result.message, `Missing required argument --${missing}`);
    assertEquals(gh.calls, []);
  });
}

Deno.test("route-issue - a filing error exits non-zero and names the failed step", async () => {
  const store = fakeStore([], { [VIBE]: "READ" });
  const { result } = await run(
    { repo: VIBE, title: "Lane worktree heal", "body-file": "worker.md" },
    routingFakeGh(store),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, 'step "permission"');
  assertStringIncludes(result.message, VIBE);
  assertEquals(store.issues, []);
});

Deno.test("route-issue - a mistyped option is refused before anything runs", async () => {
  const { result, gh } = await run({
    repo: VIBE,
    title: "Lane worktree heal",
    "body-file": "worker.md",
    "dryrun": true,
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--dryrun");
  assertEquals(gh.calls, []);
});

Deno.test("route-issue - an unreadable --dry-run value is refused, not read as a live run", async () => {
  const { result, gh } = await run({
    repo: VIBE,
    title: "Lane worktree heal",
    "body-file": "worker.md",
    "dry-run": "yes",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Invalid --dry-run");
  assertEquals(gh.calls, []);
});

Deno.test("route-issue - an unreadable body file or invalid --repo is refused", async () => {
  const noFile = await run({
    repo: VIBE,
    title: "Lane worktree heal",
    "body-file": "missing.md",
  });
  assertEquals(noFile.result.success, false);
  assertStringIncludes(
    noFile.result.message,
    "Could not read --body-file missing.md",
  );

  const badRepo = await run({
    repo: "not a repo",
    title: "Lane worktree heal",
    "body-file": "worker.md",
  });
  assertEquals(badRepo.result.success, false);
  assertStringIncludes(badRepo.result.message, "--repo must be owner/name");
});

Deno.test("route-issue - --correct without --resolve-duplicate, and --title with --part, are refused", async () => {
  const correct = await run({
    repo: VIBE,
    title: "t",
    "body-file": "worker.md",
    correct: `${VIBE}#1`,
  });
  assertEquals(correct.result.success, false);
  assertStringIncludes(
    correct.result.message,
    "--correct needs --resolve-duplicate",
  );

  const titled = await run({
    repo: VIBE,
    title: "t",
    "body-file": "worker.md",
    part: [`${VIBE}=a`, `${GRQ}=b`],
  });
  assertEquals(titled.result.success, false);
  assertStringIncludes(
    titled.result.message,
    "--title cannot be combined with --part",
  );
});

Deno.test("route-issue - is listed in the worker command registry", () => {
  const registry = createDefaultRegistry();
  assert(registry.has("route-issue"));
  assertEquals(registry.get("route-issue"), routeIssueCommand);
});
