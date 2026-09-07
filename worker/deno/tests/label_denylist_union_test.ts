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
