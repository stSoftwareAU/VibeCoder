/**
 * The agent-subprocess label denylist covers both source lists (Issue #1422).
 *
 * `gh_guard_decision.ts` builds `FORBIDDEN_LABELS` — the denylist the `gh`
 * PATH shim re-enters for every label mutation the agent issues directly —
 * and it used to build it from `WORKER_FORBIDDEN_LABEL_LITERALS` alone. That
 * list is hand-maintained and had drifted from the canonical `RESERVED_LABELS`
 * in both directions:
 *
 * - reserved but NOT enforced against the agent: `claude`, `help wanted`,
 *   `failed`, `failed-once`, `needs-clarification`, `needs-human`,
 *   `grill-me`, `needs-failure-detection-repair`;
 * - enforced but NOT reserved: `best-model`.
 *
 * `failed` and `needs-human` gate the fleet's own escalation, and
 * `label_security.ts` cannot strip them because it trusts the identity the
 * agent subprocess authenticates as. So an agent able to apply them could
 * park an unrelated issue out of discovery with nothing downstream to undo it.
 *
 * These tests assert containment in BOTH directions. A one-directional test is
 * what let the drift happen: it would have passed throughout, because the
 * shorter list was always a subset of itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "../lib/worker_label_guard.ts";

/** An active run whose allowlist permits its own repo — the ordinary case. */
const CTX = { active: true, allowedRepos: ["owner/repo"] } as const;

/** The same run, having claimed issue 42 — the ordinary coding run. */
const CLAIMED = {
  ...CTX,
  claimedIssue: {
    repo: "owner/repo",
    issueNumber: 42,
    allowedVerbs: ["edit"],
  },
} as const;

/** Ask the guard whether the agent may add `label` to issue `n`. */
function mayAddLabelTo(
  label: string,
  issue: number,
  ctx: typeof CTX | typeof CLAIMED = CTX,
): boolean {
  return evaluateGhCommand(
    [
      "issue",
      "edit",
      String(issue),
      "--repo",
      "owner/repo",
      "--add-label",
      label,
    ],
    ctx,
  ).allowed;
}

/** Ask the guard whether the agent may add `label`, with no claim seeded. */
function mayAddLabel(label: string): boolean {
  return mayAddLabelTo(label, 42);
}

// ---------------------------------------------------------------------------
// Direction 1: everything reserved is refused
// ---------------------------------------------------------------------------

Deno.test("label denylist - every RESERVED_LABELS entry is refused on someone else's issue", () => {
  // Scoped to a run that has claimed issue 42; issue 99 is a sibling it has
  // no business labelling. `needs-human` included — the escalation is only
  // legitimate on the run's OWN issue.
  const permitted: string[] = [];
  for (const label of RESERVED_LABELS) {
    if (mayAddLabelTo(label, 99, CLAIMED)) permitted.push(label);
  }
  assertEquals(
    permitted,
    [],
    "a reserved label the agent can apply to an unrelated issue is the hole",
  );
});

// ---------------------------------------------------------------------------
// Direction 2: the literals list keeps what RESERVED_LABELS does not carry
// ---------------------------------------------------------------------------

Deno.test("label denylist - every forbidden literal is refused, reserved or not", () => {
  const permitted: string[] = [];
  for (const label of WORKER_FORBIDDEN_LABEL_LITERALS) {
    if (mayAddLabelTo(label, 99, CLAIMED)) permitted.push(label);
  }
  assertEquals(
    permitted,
    [],
    "deriving from RESERVED_LABELS alone would drop these",
  );
});

Deno.test("label denylist - the union is load-bearing, not belt-and-braces", () => {
  // If this ever becomes empty, the two lists have converged and the union
  // could be simplified. While it is non-empty, replacing the union with
  // either list alone silently loses coverage — which is exactly the mistake
  // the issue's own suggested fix would have produced.
  const reserved = new Set([...RESERVED_LABELS].map((l) => l.toLowerCase()));
  const onlyInLiterals = WORKER_FORBIDDEN_LABEL_LITERALS.filter(
    (l) => !reserved.has(l.toLowerCase()),
  );
  assert(
    onlyInLiterals.length > 0,
    "expected at least one forbidden literal outside RESERVED_LABELS",
  );
  assert(
    onlyInLiterals.includes("best-model"),
    `best-model must be one of them; got ${onlyInLiterals.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// The specific labels the drift left unguarded
// ---------------------------------------------------------------------------

Deno.test("label denylist - the escalation-control labels are refused (Issue #1422)", () => {
  // These gate the fleet's own scheduling and escalation. `label_security.ts`
  // cannot strip them from the agent, because it trusts the identity the
  // agent authenticates as — so this guard is the only thing standing here.
  for (
    const label of [
      "failed",
      "failed-once",
      "needs-human",
      "needs-clarification",
      "claude",
      "help wanted",
      "needs-failure-detection-repair",
    ]
  ) {
    assertEquals(
      mayAddLabelTo(label, 99, CLAIMED),
      false,
      `${label} on an unrelated issue must be refused`,
    );
  }
});

Deno.test("label denylist - matching is case-insensitive", () => {
  assertEquals(mayAddLabelTo("NEEDS-HUMAN", 99, CLAIMED), false);
  assertEquals(mayAddLabelTo("Needs-Human", 99, CLAIMED), false);
  assertEquals(mayAddLabelTo("TOP-PRIORITY", 42, CLAIMED), false);
});

// ---------------------------------------------------------------------------
// The escalation the prompts prescribe must keep working
// ---------------------------------------------------------------------------

Deno.test("label denylist - needs-human on the run's OWN claimed issue is allowed", () => {
  // `prompts/issue/prompt.md:179` gives this call verbatim and
  // `prompts/coding_guidelines/prompt.md:531` says it "keeps working". The
  // label is suppression-only (`isSuppressionOnlyLabel`, PR #1321): applying
  // it removes the issue from the work pool, so it can only cost the applier
  // throughput. Denying it would remove the agent's only way to ask for a
  // human — a regression already reported once.
  assertEquals(mayAddLabelTo("needs-human", 42, CLAIMED), true);
});

Deno.test("label denylist - needs-human with no claim seeded is unchanged", () => {
  // No claim means no "own issue" to scope to; this is the behaviour that has
  // always applied and must not change.
  assertEquals(mayAddLabel("needs-human"), true);
});

Deno.test("label denylist - a permitted escalation does not smuggle a forbidden label beside it", () => {
  // `--add-label needs-human,failed` must still be refused for `failed`.
  // Checking only the FIRST forbidden label would let this through.
  assertEquals(mayAddLabelTo("needs-human,failed", 42, CLAIMED), false);
  assertEquals(mayAddLabelTo("needs-human,top-priority", 42, CLAIMED), false);
});

// ---------------------------------------------------------------------------
// The permit direction — ordinary labels still work
// ---------------------------------------------------------------------------

Deno.test("label denylist - an ordinary content label is still allowed", () => {
  // The agent legitimately files scan findings with content labels, which is
  // why this is a denylist rather than the worker's positive allowlist. A
  // guard that refused these would stop the fleet doing its job.
  for (const label of ["bug", "security", "severity:high", "enhancement"]) {
    assertEquals(mayAddLabel(label), true, `${label} must stay allowed`);
  }
});

// ---------------------------------------------------------------------------
// `gh label` — the definition side of the same denylist (Issue #2518)
// ---------------------------------------------------------------------------

/** Run one `gh` vector past the guard and report whether it may proceed. */
function mayRun(
  args: readonly string[],
  ctx: typeof CTX | typeof CLAIMED = CTX,
): boolean {
  return evaluateGhCommand(args, ctx).allowed;
}

Deno.test("label denylist - gh label create/edit/delete cannot target a reserved label (Issue #2518)", () => {
  // The name is POSITIONAL on all three verbs, so the flag-only extractor saw
  // no labels at all and the cwd-scoped mutation fell through to the
  // write-repo allowlist's `allowed: true`. Deleting `top-priority` removes
  // the fleet's scheduling control from the repo outright — a worse outcome
  // than the label application this denylist was written to stop.
  for (
    const args of [
      ["label", "delete", "top-priority", "--yes"],
      ["label", "create", "top-priority", "--color", "FF0000"],
      ["label", "edit", "top-priority", "--color", "FF0000"],
      ["label", "delete", "work-on", "--yes"],
      ["label", "create", "best-model"],
    ]
  ) {
    const decision = evaluateGhCommand(args, CTX);
    assertEquals(
      decision.allowed,
      false,
      `gh ${args.join(" ")} must be refused`,
    );
    assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  }
});

Deno.test("label denylist - every gh label edit rename spelling is refused (Issue #2518)", () => {
  // `--name` renames an ordinary label INTO a reserved one, which is the same
  // capability as creating it. `normaliseGhArgs` normalises only R/l/X/f/F, so
  // the attached `-n` spellings reach the guard unexpanded and have to be
  // understood here.
  for (
    const rename of [
      ["-n", "top-priority"],
      ["--name", "top-priority"],
      ["--name=top-priority"],
      ["-n=top-priority"],
      ["-ntop-priority"],
    ]
  ) {
    const args = ["label", "edit", "any-label", ...rename];
    assertEquals(
      mayRun(args),
      false,
      `gh ${args.join(" ")} must be refused`,
    );
  }
});

Deno.test("label denylist - every forbidden label is covered on the definition path (Issue #2518)", () => {
  const permitted: string[] = [];
  for (
    const label of [...RESERVED_LABELS, ...WORKER_FORBIDDEN_LABEL_LITERALS]
  ) {
    if (mayRun(["label", "delete", label, "--yes"])) permitted.push(label);
  }
  assertEquals(
    permitted,
    [],
    "a reserved label the agent can delete outright is the hole",
  );
});

Deno.test("label denylist - definition spellings that dodge the naive scan (Issue #2518)", () => {
  // Case folding, the `--` end-of-flags marker, a flag ahead of the
  // positional, and a repo flag in its attached pflag spelling.
  for (
    const args of [
      ["label", "delete", "TOP-PRIORITY", "--yes"],
      ["label", "delete", "--yes", "top-priority"],
      ["label", "delete", "--", "top-priority"],
      ["label", "create", "-f", "top-priority"],
      ["label", "delete", "top-priority", "-Rowner/repo"],
    ]
  ) {
    assertEquals(
      mayRun(args),
      false,
      `gh ${args.join(" ")} must be refused`,
    );
  }
});

Deno.test("label denylist - the needs-human escalation does not extend to defining it (Issue #2518)", () => {
  // Applying `needs-human` to the run's own issue is the sanctioned ask for a
  // human; deleting or renaming the label itself removes that escalation
  // route for every later run, so the exemption must not reach this path.
  assertEquals(
    mayRun(["label", "delete", "needs-human", "--yes"], CLAIMED),
    false,
  );
  assertEquals(
    mayRun(["label", "edit", "bug", "-n", "needs-human"], CLAIMED),
    false,
  );
  // …while the escalation itself is untouched.
  assertEquals(mayAddLabelTo("needs-human", 42, CLAIMED), true);
});

Deno.test("label denylist - ordinary gh label work is still allowed (Issue #2518)", () => {
  for (
    const args of [
      ["label", "list"],
      ["label", "create", "bug", "--color", "FF0000"],
      ["label", "edit", "bug", "--color", "FF0000"],
      ["label", "edit", "bug", "-n", "defect"],
      ["label", "delete", "stale", "--yes"],
      // A description that merely MENTIONS a reserved label is not a
      // definition of one — refusing this would be a false positive.
      ["label", "create", "bug", "-d", "raise with top-priority if urgent"],
      ["label", "create", "bug", "--description", "see work-on"],
      // `gh label clone <source-repository>` names a REPO, never a label, and
      // creates only labels absent from the destination — it can neither
      // rename nor delete a reserved label.
      ["label", "clone", "owner/other-repo"],
    ]
  ) {
    assertEquals(
      mayRun(args),
      true,
      `gh ${args.join(" ")} must stay allowed`,
    );
  }
});

// ---------------------------------------------------------------------------
// The REST spelling of the same capability (Issue #2518)
// ---------------------------------------------------------------------------

Deno.test("label denylist - gh api cannot define, rename or destroy a reserved label (Issue #2518)", () => {
  for (
    const args of [
      // Destroy.
      ["api", "-X", "DELETE", "repos/owner/repo/labels/top-priority"],
      ["api", "--method", "DELETE", "repos/owner/repo/labels/work-on"],
      // Percent-encoded, and gh's own `{owner}/{repo}` placeholder form.
      ["api", "-X", "DELETE", "repos/owner/repo/labels/best%2Dmodel"],
      ["api", "-X", "DELETE", "repos/{owner}/{repo}/labels/top-priority"],
      // Define.
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/labels",
        "-f",
        "name=top-priority",
      ],
      ["api", "--method=POST", "repos/owner/repo/labels", "-fname=work-on"],
      // Rename an ordinary label INTO a reserved one.
      [
        "api",
        "-X",
        "PATCH",
        "repos/owner/repo/labels/bug",
        "-f",
        "new_name=top-priority",
      ],
    ]
  ) {
    const decision = evaluateGhCommand(args, CTX);
    assertEquals(
      decision.allowed,
      false,
      `gh ${args.join(" ")} must be refused`,
    );
    assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  }
});

Deno.test("label denylist - ordinary gh api label work is still allowed (Issue #2518)", () => {
  for (
    const args of [
      // Reads are not definitions.
      ["api", "repos/owner/repo/labels"],
      ["api", "repos/owner/repo/labels/top-priority"],
      // Ordinary content labels.
      ["api", "-X", "POST", "repos/owner/repo/labels", "-f", "name=bug"],
      ["api", "-X", "DELETE", "repos/owner/repo/labels/stale"],
      [
        "api",
        "-X",
        "PATCH",
        "repos/owner/repo/labels/bug",
        "-f",
        "color=FF0000",
      ],
      // A DIFFERENT endpoint that merely ends in a reserved-looking segment:
      // applying a label to an issue is the flag path's business, and an
      // ordinary label there must not be caught by the definition scan.
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/issues/5/labels",
        "-f",
        "labels[]=bug",
      ],
    ]
  ) {
    assertEquals(
      mayRun(args),
      true,
      `gh ${args.join(" ")} must stay allowed`,
    );
  }
});
