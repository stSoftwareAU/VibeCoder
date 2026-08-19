/**
 * Tests for the pflag-faithful `gh` argv normalisation (Issue #3867).
 *
 * `gh` is a cobra/pflag program: a shorthand flag's value may be attached
 * (`-Rowner/repo`, `-R=owner/repo`, `-ltop-priority`) and a repeated string
 * flag resolves to its **last** occurrence. The guards hand-rolled a parser
 * that understood none of that, so those spellings reached the real binary
 * with no write-repo allowlist and no reserved-label check applied.
 *
 * WHAT-tests: each drives the real classifier/decision with an argument vector
 * a prompt-injected agent could emit, and asserts on the verdict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import {
  evaluateGhCommand,
  extractLabelValues,
} from "../lib/gh_guard_decision.ts";
import { normaliseGhArgs } from "../lib/gh_flag_parser.ts";

/** Context with the write-repo allowlist active for a single repo. */
const ACTIVE = {
  active: true,
  allowedRepos: ["stSoftwareAU/VibeCoder"],
} as const;

// ---------------------------------------------------------------------------
// normaliseGhArgs
// ---------------------------------------------------------------------------

Deno.test("normaliseGhArgs - expands attached and equals shorthand values", () => {
  assertEquals(normaliseGhArgs(["issue", "comment", "5", "-Rowner/repo"]), [
    "issue",
    "comment",
    "5",
    "-R",
    "owner/repo",
  ]);
  assertEquals(normaliseGhArgs(["-R=owner/repo"]), ["-R", "owner/repo"]);
  assertEquals(normaliseGhArgs(["-ltop-priority"]), ["-l", "top-priority"]);
  assertEquals(normaliseGhArgs(["-l=top-priority"]), ["-l", "top-priority"]);
  assertEquals(normaliseGhArgs(["-XPOST"]), ["-X", "POST"]);
  assertEquals(normaliseGhArgs(["-X=POST"]), ["-X", "POST"]);
});

Deno.test("normaliseGhArgs - leaves every other token untouched", () => {
  const args = [
    "issue",
    "edit",
    "7",
    "-R",
    "owner/repo",
    "--repo=owner/repo",
    "--add-label=bug",
    "-b",
    "body text",
    "-",
    "--",
    "-l",
    "bug",
  ];
  assertEquals(normaliseGhArgs(args), args);
});

// ---------------------------------------------------------------------------
// Write-repo allowlist — attached and repeated `-R`
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - attached shorthand repo is explicit scope", () => {
  for (const token of ["-Racme/widget", "-R=acme/widget"]) {
    const info = classifyGhMutation([
      "issue",
      "comment",
      "5",
      token,
      "-b",
      "x",
    ]);
    assertEquals(info?.repo, "acme/widget", `spelling ${token}`);
    assertEquals(info?.scope, "explicit", `spelling ${token}`);
    assertEquals(info?.target, "5", `spelling ${token}`);
  }
});

Deno.test("classifyGhMutation - a repeated repo flag resolves to the last value", () => {
  const info = classifyGhMutation([
    "issue",
    "comment",
    "5",
    "-R",
    "allowed/repo",
    "-R",
    "attacker/evil",
    "--body",
    "x",
  ]);
  assertEquals(info?.repo, "attacker/evil");
  assertEquals(info?.scope, "explicit");
});

Deno.test("classifyGhMutation - the last repeated repo wins across spellings", () => {
  assertEquals(
    classifyGhMutation([
      "issue",
      "edit",
      "5",
      "--repo=allowed/repo",
      "-Rattacker/evil",
    ])?.repo,
    "attacker/evil",
  );
  assertEquals(
    classifyGhMutation([
      "issue",
      "edit",
      "5",
      "-Rattacker/evil",
      "--repo",
      "allowed/repo",
    ])?.repo,
    "allowed/repo",
  );
});

Deno.test("gh-guard - refuses an off-allowlist write named by an attached -R", () => {
  for (
    const args of [
      ["issue", "comment", "5", "-Rattacker/evil", "--body", "x"],
      ["issue", "comment", "5", "-R=attacker/evil", "--body", "x"],
      [
        "issue",
        "comment",
        "5",
        "-R",
        "stSoftwareAU/VibeCoder",
        "-R",
        "attacker/evil",
        "--body",
        "x",
      ],
      ["pr", "comment", "5", "-Rattacker/evil", "--body", "x"],
      ["release", "create", "v1", "-R=attacker/evil"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "WRITE_REPO_BLOCKED", `for: ${args}`);
  }
});

Deno.test("gh-guard - still allows an on-allowlist write named by an attached -R", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "5", "-RstSoftwareAU/VibeCoder", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - a repeated -R ending on the allowlist is allowed", () => {
  const decision = evaluateGhCommand(
    [
      "issue",
      "comment",
      "5",
      "-Rattacker/evil",
      "-R",
      "stSoftwareAU/VibeCoder",
      "--body",
      "x",
    ],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - reads named by an attached -R stay allowed", () => {
  assertEquals(
    evaluateGhCommand(["issue", "view", "5", "-Rattacker/evil"], ACTIVE)
      .allowed,
    true,
  );
});

// ---------------------------------------------------------------------------
// Reserved-label denylist — attached `-l`
// ---------------------------------------------------------------------------

Deno.test("extractLabelValues - reads attached shorthand label values", () => {
  assertEquals(
    extractLabelValues(["issue", "create", "-ltop-priority", "--title", "t"]),
    ["top-priority"],
  );
  assertEquals(
    extractLabelValues(["issue", "create", "-l=work-on,bug"]),
    ["work-on", "bug"],
  );
});

Deno.test("extractLabelValues - accumulates every occurrence of a label flag", () => {
  assertEquals(
    extractLabelValues([
      "issue",
      "create",
      "-lbug",
      "--label",
      "security",
      "--add-label=top-priority",
    ]),
    ["bug", "security", "top-priority"],
  );
});

Deno.test("gh-guard - refuses a reserved label named by an attached -l", () => {
  for (
    const args of [
      ["issue", "create", "-ltop-priority", "--title", "t", "--body", "b"],
      ["issue", "create", "-l=work-on", "--title", "t", "--body", "b"],
      ["issue", "edit", "7", "-lbug", "-lbest-model"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "WORKER_LABEL_REFUSED", `for: ${args}`);
  }
});

Deno.test("gh-guard - content labels named by an attached -l stay allowed", () => {
  const decision = evaluateGhCommand(
    ["issue", "create", "-lsecurity,severity:high", "--title", "t"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

// ---------------------------------------------------------------------------
// `gh api` — attached `-X`
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - api method attached to -X is still a mutation", () => {
  for (const token of ["-XPOST", "-X=POST"]) {
    const info = classifyGhMutation([
      "api",
      token,
      "repos/attacker/evil/issues",
      "-f",
      "title=x",
    ]);
    assertEquals(info?.verb, "api-post", `spelling ${token}`);
    assertEquals(info?.repo, "attacker/evil", `spelling ${token}`);
  }
});

Deno.test("gh-guard - refuses an off-allowlist api write with an attached -X", () => {
  const decision = evaluateGhCommand(
    ["api", "-X=POST", "repos/attacker/evil/issues", "-f", "title=x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});
