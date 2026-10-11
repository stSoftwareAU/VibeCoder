/**
 * Conformance of the agent gh guard across gh- and GitHub-equivalent
 * spellings (Issue #3568).
 *
 * Each registered rule is one canonical argv the guard refuses. The helper in
 * `support/gh_guard_conformance.ts` generates every spelling `gh` parses the
 * same way and GitHub routes the same way, and each must get the same refusal
 * marker as the canonical form. A rule whose guard misses a spelling fails
 * here with the spelling named, instead of in the next review round.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  evaluateGhCommand,
  type GhGuardContext,
  type GhGuardMarker,
} from "../lib/gh_guard_decision.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import {
  foreignHostSpellings,
  ghEquivalentSpellings,
} from "./support/gh_guard_conformance.ts";

const REPO = "acme/widgets";

/** An active allowlist with a claimed issue, as during a coding run. */
const CODING_RUN: GhGuardContext = {
  active: true,
  allowedRepos: [REPO],
  claimedIssue: { repo: REPO, issueNumber: 5, allowedVerbs: ["edit"] },
};

/** No allowlist and no claim, as during a PR-feedback run. */
const INACTIVE: GhGuardContext = { active: false, allowedRepos: [] };

/** One canonical refused argv and the verdict every spelling must share. */
interface GuardRule {
  name: string;
  argv: string[];
  ctx: GhGuardContext;
  marker: GhGuardMarker;
  updateRoute?: boolean;
}

/**
 * Every refusal rule of the agent gh guard that a `gh api` spelling can
 * reach. Register a new rule here and every spelling is checked.
 */
export const GH_GUARD_RULES: readonly GuardRule[] = [
  {
    name: "REST PR merge (Issue #1462)",
    argv: ["api", `repos/${REPO}/pulls/1219/merge`, "-X", "PUT"],
    ctx: CODING_RUN,
    marker: "PR_LIFECYCLE_REFUSED",
  },
  {
    name: "REST PR close (Issue #1462)",
    argv: [
      "api",
      `repos/${REPO}/pulls/1219`,
      "-X",
      "PATCH",
      "-f",
      "state=closed",
    ],
    ctx: CODING_RUN,
    marker: "PR_LIFECYCLE_REFUSED",
    updateRoute: true,
  },
  {
    name: "REST PR approval (Issue #1462)",
    argv: [
      "api",
      `repos/${REPO}/pulls/1219/reviews`,
      "-X",
      "POST",
      "-f",
      "event=APPROVE",
    ],
    ctx: CODING_RUN,
    marker: "PR_LIFECYCLE_REFUSED",
  },
  {
    name: "REST issue close (Issue #222)",
    argv: [
      "api",
      `repos/${REPO}/issues/905`,
      "-X",
      "PATCH",
      "-f",
      "state=closed",
    ],
    ctx: CODING_RUN,
    marker: "ISSUE_LIFECYCLE_REFUSED",
    updateRoute: true,
  },
  {
    name: "REST issue lock (Issue #222)",
    argv: ["api", `repos/${REPO}/issues/905/lock`, "-X", "PUT"],
    ctx: CODING_RUN,
    marker: "ISSUE_LIFECYCLE_REFUSED",
  },
  {
    name: "reserved label applied over REST (Issue #11)",
    argv: [
      "api",
      `repos/${REPO}/issues/905/labels`,
      "-X",
      "POST",
      "-f",
      "labels[]=failed",
    ],
    ctx: INACTIVE,
    marker: "WORKER_LABEL_REFUSED",
  },
  {
    name: "reserved label definition deleted over REST (Issue #2518)",
    argv: ["api", `repos/${REPO}/labels/top-priority`, "-X", "DELETE"],
    ctx: INACTIVE,
    marker: "WORKER_LABEL_REFUSED",
  },
  {
    name: "reserved label definition renamed over REST (Issue #2518)",
    argv: [
      "api",
      `repos/${REPO}/labels/bug`,
      "-X",
      "PATCH",
      "-f",
      "new_name=top-priority",
    ],
    ctx: INACTIVE,
    marker: "WORKER_LABEL_REFUSED",
  },
  {
    name: "write to a repo off the allowlist (Issue #3703)",
    argv: ["api", "repos/attacker/evil/issues", "-X", "POST", "-f", "title=x"],
    ctx: CODING_RUN,
    marker: "WRITE_REPO_BLOCKED",
  },
  {
    name: "write to an endpoint naming no repo (Issue #3703)",
    argv: ["api", "gists", "-X", "POST", "-f", "description=x"],
    ctx: CODING_RUN,
    marker: "WRITE_TARGET_UNDETERMINABLE",
  },
  {
    name: "unsanctioned GraphQL mutation (Issue #3703)",
    argv: [
      "api",
      "graphql",
      "-f",
      'query=mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }',
    ],
    ctx: CODING_RUN,
    marker: "WRITE_TARGET_UNDETERMINABLE",
  },
  {
    name: "body from stdin (Issue #3937)",
    argv: ["api", `repos/${REPO}/issues`, "-X", "POST", "--input", "-"],
    ctx: INACTIVE,
    marker: "GH_BODY_UNREADABLE",
  },
];

for (const rule of GH_GUARD_RULES) {
  Deno.test(`gh guard conformance (Issue #3568) - ${rule.name}: canonical form is refused`, () => {
    const decision = evaluateGhCommand(rule.argv, rule.ctx);
    assertEquals(decision.allowed, false, rule.argv.join(" "));
    assertEquals(decision.marker, rule.marker, decision.reason);
  });

  Deno.test(`gh guard conformance (Issue #3568) - ${rule.name}: every equivalent spelling gets the same refusal`, () => {
    const missed: string[] = [];
    for (
      const spelling of ghEquivalentSpellings(rule.argv, {
        updateRoute: rule.updateRoute,
      })
    ) {
      const decision = evaluateGhCommand(spelling.argv, rule.ctx);
      if (decision.allowed || decision.marker !== rule.marker) {
        missed.push(
          `${spelling.label}: gh ${spelling.argv.join(" ")} -> ` +
            (decision.allowed ? "allowed" : decision.marker),
        );
      }
    }
    assertEquals(missed, [], `spellings that escaped ${rule.marker}`);
  });

  Deno.test(`gh guard conformance (Issue #3568) - ${rule.name}: the audit journal sees the same mutation in every spelling`, () => {
    const canonical = classifyGhMutation(rule.argv);
    assert(canonical !== null, "the canonical form is a mutation");
    const missed: string[] = [];
    for (
      const spelling of ghEquivalentSpellings(rule.argv, {
        updateRoute: rule.updateRoute,
      })
    ) {
      const info = classifyGhMutation(spelling.argv);
      if (
        info === null || info.repo !== canonical.repo ||
        info.verb !== canonical.verb || info.target !== canonical.target
      ) {
        missed.push(`${spelling.label}: ${JSON.stringify(info)}`);
      }
    }
    assertEquals(missed, []);
  });
}

// A write the guard allows on GitHub must be refused when gh would send it to
// another host, whatever placement of --hostname gh honours (#1420, #3540).
const ALLOWED_WRITE = [
  "api",
  `repos/${REPO}/issues/905/comments`,
  "-X",
  "POST",
  "-f",
  "body=hello",
];

Deno.test("gh guard conformance (Issue #3568) - the control write is allowed on GitHub in every spelling", () => {
  for (const spelling of ghEquivalentSpellings(ALLOWED_WRITE)) {
    const decision = evaluateGhCommand(spelling.argv, CODING_RUN);
    assertEquals(
      decision.allowed,
      true,
      `${spelling.label}: gh ${spelling.argv.join(" ")} -> ${decision.marker}`,
    );
  }
});

Deno.test("gh guard conformance (Issue #3568) - a foreign --hostname is refused in every placement", () => {
  for (const spelling of foreignHostSpellings(ALLOWED_WRITE)) {
    const decision = evaluateGhCommand(spelling.argv, CODING_RUN);
    assertEquals(
      decision.allowed,
      false,
      `${spelling.label}: gh ${spelling.argv.join(" ")}`,
    );
  }
});

// Issue #3566: gh fills `{owner}`/`{repo}`/`{branch}` (and `:owner`, …) in a
// magic field's value after the guard has read it, and the agent chooses the
// branch name — so the text gh sends is not the text classified.
const PLACEHOLDER_DOCUMENT =
  'query=mutation { changeUserStatus(input: {message: "{branch}"}) { clientMutationId } }';

for (const flag of ["-F", "--field"]) {
  Deno.test(`gh guard conformance (Issue #3568, #3566) - a GraphQL document with a placeholder under ${flag} fails closed`, () => {
    const decision = evaluateGhCommand(
      ["api", "graphql", flag, PLACEHOLDER_DOCUMENT],
      CODING_RUN,
    );
    assertEquals(decision.allowed, false);
  });
}

for (const placeholder of ["{owner}", "{repo}", ":branch", ":owner"]) {
  Deno.test(`gh guard conformance (Issue #3568, #3566) - a label value carrying ${placeholder} under -F fails closed`, () => {
    const decision = evaluateGhCommand(
      [
        "api",
        `repos/${REPO}/issues/905/labels`,
        "-X",
        "POST",
        "-F",
        `labels[]=${placeholder}`,
      ],
      INACTIVE,
    );
    assertEquals(decision.allowed, false);
  });
}

Deno.test("gh guard conformance (Issue #3568, #3566) - the same placeholder text under -f is sent verbatim and classified normally", () => {
  // `-f`/`--raw-field` values are never substituted, so the sanctioned
  // non-repo mutation stays allowed and a plain label stays allowed.
  assertEquals(
    evaluateGhCommand(
      ["api", "graphql", "-f", PLACEHOLDER_DOCUMENT],
      CODING_RUN,
    )
      .allowed,
    true,
  );
  assertEquals(
    evaluateGhCommand(
      [
        "api",
        `repos/${REPO}/issues/905/labels`,
        "-X",
        "POST",
        "-f",
        "labels[]={branch}",
      ],
      INACTIVE,
    ).allowed,
    true,
  );
});

Deno.test("gh guard conformance (Issue #3568, #3566) - a placeholder in an ordinary REST field is left alone", () => {
  // `gh api repos/{owner}/{repo}/pulls -F head={branch}` is how an agent
  // raises a PR over REST; `head` carries no label and no document.
  assertEquals(
    evaluateGhCommand(
      [
        "api",
        "repos/{owner}/{repo}/pulls",
        "-X",
        "POST",
        "-F",
        "head={branch}",
        "-f",
        "base=main",
      ],
      CODING_RUN,
    ).allowed,
    true,
  );
});
