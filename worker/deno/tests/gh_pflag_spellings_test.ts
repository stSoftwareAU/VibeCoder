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
import { classifyIssueLifecycle } from "../lib/gh_issue_lifecycle.ts";

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

// ---------------------------------------------------------------------------
// Shorthand groups (Issue #1219, SEC-1219-01)
//
// pflag lets the first value-carrying flag in a shorthand *group* swallow the
// remainder of the token, so `-iXDELETE` is `-i -X DELETE`. Verified against
// the installed `gh`: `gh api -iXGET rate_limit` returns 200 with response
// headers, and `-iXBOGUSMETHOD` is refused by the server with a 403 — the
// method really is parsed out of the group and sent.
//
// Fail direction: every assertion below fails against the pre-fix parser,
// which only inspected `token[1]` and knew nothing of `f`/`F`.
// ---------------------------------------------------------------------------

Deno.test("normaliseGhArgs - expands a value flag buried in a shorthand group", () => {
  assertEquals(normaliseGhArgs(["api", "-iXDELETE"]), [
    "api",
    "-i",
    "-X",
    "DELETE",
  ]);
  assertEquals(normaliseGhArgs(["-ivXPOST"]), ["-i", "-v", "-X", "POST"]);
  assertEquals(normaliseGhArgs(["-iX=PATCH"]), ["-i", "-X", "PATCH"]);
  // An empty remainder is already the separated form: the value is next.
  assertEquals(normaliseGhArgs(["-iX", "DELETE"]), ["-i", "-X", "DELETE"]);
});

Deno.test("normaliseGhArgs - expands attached -f and -F field values", () => {
  assertEquals(normaliseGhArgs(["-fstate=closed"]), ["-f", "state=closed"]);
  assertEquals(normaliseGhArgs(["-Fstate=closed"]), ["-F", "state=closed"]);
  assertEquals(normaliseGhArgs(["-f=state=closed"]), ["-f", "state=closed"]);
});

Deno.test("normaliseGhArgs - never invents a flag out of another flag's value", () => {
  // `-q` is `--jq` and takes the rest of the token, so the `f` inside a jq
  // expression must not be read as `--raw-field`. Passed through byte-identical.
  assertEquals(normaliseGhArgs(["api", "-q.fields", "rate_limit"]), [
    "api",
    "-q.fields",
    "rate_limit",
  ]);
  assertEquals(normaliseGhArgs(["-bXDELETE"]), ["-bXDELETE"]);
  // All-boolean groups and long flags are untouched.
  assertEquals(normaliseGhArgs(["-iv", "--method=POST"]), [
    "-iv",
    "--method=POST",
  ]);
});

Deno.test("normaliseGhArgs - a value shorthand outside the guard set ends the walk", () => {
  // Issue #1219 review: `-D` (`gh run download --dir`) and `-j` (`gh run view
  // --job`) take values but were missing from the value set, so the walk read
  // past them into the directory or job name. A path beginning `X`, `f` or `R`
  // then had a flag invented out of it — `-DXPOST` became `-D -X POST`, which
  // is fabricated mutation evidence against an ordinary download.
  //
  // Fail direction: against the pre-fix set (no `D`/`j`) the first assertion
  // yields ["-D", "-X", "POST"] and this test goes red.
  assertEquals(normaliseGhArgs(["run", "download", "-DXPOST"]), [
    "run",
    "download",
    "-DXPOST",
  ]);
  assertEquals(normaliseGhArgs(["run", "view", "-jfstate=closed"]), [
    "run",
    "view",
    "-jfstate=closed",
  ]);
  // The `api` shapes the fix exists for still expand — `i` stays boolean.
  assertEquals(normaliseGhArgs(["api", "-iXDELETE", "repos/o/r"]), [
    "api",
    "-i",
    "-X",
    "DELETE",
    "repos/o/r",
  ]);
});

Deno.test("classifyGhMutation - a method hidden in a shorthand group is still a mutation", () => {
  const info = classifyGhMutation([
    "api",
    "-iXDELETE",
    "repos/attacker/evil/git/refs/heads/main",
  ]);
  assertEquals(info?.verb, "api-delete");
  assertEquals(info?.repo, "attacker/evil");
});

Deno.test("gh-guard - refuses an off-allowlist api write hidden in a shorthand group", () => {
  const decision = evaluateGhCommand(
    ["api", "-iXDELETE", "repos/attacker/evil/git/refs/heads/main"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

Deno.test("classifyIssueLifecycle - an attached -fstate=closed is a close, not an edit", () => {
  for (const token of ["-fstate=closed", "-Fstate=closed"]) {
    const args = [
      "api",
      "-XPATCH",
      "repos/stSoftwareAU/VibeCoder/issues/1219",
      token,
    ];
    const info = classifyGhMutation(args);
    const attempt = classifyIssueLifecycle(args, info!);
    assertEquals(attempt?.verb, "close", `spelling ${token}`);
    assertEquals(attempt?.issueNumber, 1219, `spelling ${token}`);
  }
});

Deno.test("gh-guard - refuses closing the claimed issue via an attached -fstate=closed", () => {
  const decision = evaluateGhCommand(
    [
      "api",
      "-XPATCH",
      "repos/stSoftwareAU/VibeCoder/issues/1219",
      "-fstate=closed",
    ],
    {
      ...ACTIVE,
      claimedIssue: {
        repo: "stSoftwareAU/VibeCoder",
        issueNumber: 1219,
        allowedVerbs: ["edit"],
      },
    },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
});
