/**
 * Documentation-drift tests for the human-authored-PR policy (Issue #4081).
 *
 * The #4074 regression happened because the policy lived only in code: the
 * docs still described `allowed_authors` as a set whose PRs the fleet
 * maintains, which is exactly the reasoning that widened the scans. These
 * tests pin the written policy to the implementation so the two cannot
 * drift apart again:
 *
 *   - `docs/HUMAN-PR-POLICY.md` exists, is reachable from the README, and
 *     carries its own Documentation-table row.
 *   - The invite label the policy documents is fed to the **real**
 *     predicates (`isPrInvited`, `LABEL_DEFAULTS`), so a doc naming a
 *     label that does not work fails the suite.
 *   - The page's claim that a human PR never blocks issue pickup is
 *     checked against the real guard (Issue #4133).
 *   - The two author sets the docs describe are the sets the resolvers
 *     actually return — trusted humans defer-to only, never push-capable.
 *   - `docs/CONFIGURATION.md` states the one-line rule, and
 *     `docs/LESSONS-LEARNT.md` records the incident and links the policy.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";
import {
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "../lib/fleet_authors.ts";
import { isHumanAuthoredPr } from "../lib/fleet_authors.ts";
import { getBlockingPRForIssue } from "../lib/issue_query.ts";
import { isPrInvited } from "../lib/pr_invitation.ts";

const POLICY_DOC = "docs/HUMAN-PR-POLICY.md";
const CONFIG_DOC = "docs/CONFIGURATION.md";
const LESSONS_DOC = "docs/LESSONS-LEARNT.md";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

/** Local markdown link targets of `file`, resolved to repo-relative paths. */
function markdownLinks(file: string): string[] {
  const dir = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/") + 1)
    : "";
  const targets: string[] = [];
  for (const match of read(file).matchAll(/\]\(([^)\s]+)/g)) {
    const raw = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    const withoutAnchor = raw.split("#")[0] ?? "";
    if (!withoutAnchor.endsWith(".md")) continue;
    const resolved = new URL(withoutAnchor, `file:///${dir}`).pathname
      .replace(/^\//, "");
    targets.push(decodeURIComponent(resolved));
  }
  return targets;
}

/** Every markdown file reachable from README.md by following local links. */
function reachableFromReadme(): Set<string> {
  const seen = new Set<string>(["README.md"]);
  const queue = ["README.md"];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let links: string[];
    try {
      links = markdownLinks(current);
    } catch {
      continue; // Missing targets are covered by the dedicated link checker.
    }
    for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);
      queue.push(link);
    }
  }
  return seen;
}

/**
 * The first backticked token in the policy doc's signal-table row whose
 * first cell matches `label` — e.g. the invite label from the `**Label**`
 * row. This is the value the documentation tells an operator to use, so it
 * is what the tests below feed to the real predicates.
 */
function documentedToken(rowLabel: string): string {
  const row = read(POLICY_DOC)
    .split("\n")
    .find((line) =>
      new RegExp(`^\\|\\s*\\*\\*${rowLabel}\\*\\*\\s*\\|`).test(line)
    );
  assert(row, `${POLICY_DOC} must have a table row for **${rowLabel}**`);
  const cells = row.split("|").slice(2); // skip the leading empty + name cell
  const token = /`([^`]+)`/.exec(cells.join("|"))?.[1];
  assert(token, `The **${rowLabel}** row must name its value in backticks`);
  return token;
}

// ---------------------------------------------------------------------------
// The policy document exists and is reachable
// ---------------------------------------------------------------------------

Deno.test("human-PR policy - the policy document exists", () => {
  assert(
    Deno.statSync(repoPath(POLICY_DOC)).isFile,
    `${POLICY_DOC} must exist`,
  );
});

Deno.test("human-PR policy - README Documentation table links the policy", () => {
  const lines = read("README.md").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("## 📖 Documentation")
  );
  assert(start >= 0, "README must have a '📖 Documentation' section");
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("|")) rows.push(line);
  }
  const row = rows.find((line) => line.includes(`(${POLICY_DOC})`));
  assert(row, `No README Documentation-table row links ${POLICY_DOC}`);
  assert(
    row.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0)
      .length >= 2,
    `The ${POLICY_DOC} row needs a description cell`,
  );
});

Deno.test("human-PR policy - the policy is reachable from the README", () => {
  assert(
    reachableFromReadme().has(POLICY_DOC),
    `${POLICY_DOC} must be reachable from README.md by following links`,
  );
});

// ---------------------------------------------------------------------------
// The documented invitation signals are the ones the code honours
// ---------------------------------------------------------------------------

const HOST = "VibeCoderBot";
const SIBLING = "stsvcbot";
const HUMAN = "trusted-human";
const INVITE_OPTIONS = {
  githubUser: HOST,
  allowedAuthors: [HUMAN, SIBLING],
  fleetPrAuthors: [SIBLING],
};

Deno.test("human-PR policy - the documented invite label really invites", () => {
  const label = documentedToken("Label");
  const verdict = isPrInvited(
    {
      number: 7,
      author: { login: HUMAN },
      labels: [{ name: label, addedBy: HUMAN }],
    },
    { ...INVITE_OPTIONS, inviteLabel: label },
  );
  assertEquals(verdict, { invited: true, via: "label", invitedBy: HUMAN });
});

Deno.test("human-PR policy - the documented invite label matches the default", () => {
  assertEquals(documentedToken("Label"), LABEL_DEFAULTS.workOnLabel);
});

Deno.test("human-PR policy - a documented @mention really invites", () => {
  const verdict = isPrInvited(
    {
      number: 7,
      author: { login: HUMAN },
      comments: [{
        author: { login: HUMAN },
        body: `please fix this @${HOST}`,
      }],
    },
    INVITE_OPTIONS,
  );
  assertEquals(verdict, { invited: true, via: "mention", invitedBy: HUMAN });
});

Deno.test("human-PR policy - removing the label revokes the invitation", () => {
  const label = documentedToken("Label");
  const verdict = isPrInvited(
    { number: 7, author: { login: HUMAN }, labels: [] },
    { ...INVITE_OPTIONS, inviteLabel: label },
  );
  assertEquals(verdict, { invited: false, via: null });
});

Deno.test("human-PR policy - a fleet account cannot invite itself", () => {
  const label = documentedToken("Label");
  const verdict = isPrInvited(
    {
      number: 7,
      author: { login: HUMAN },
      labels: [{ name: label, addedBy: SIBLING }],
      comments: [{ author: { login: HOST }, body: `@${HOST} please` }],
    },
    { ...INVITE_OPTIONS, inviteLabel: label },
  );
  assertEquals(verdict, { invited: false, via: null });
});

// ---------------------------------------------------------------------------
// The two author sets behave as the documents describe
// ---------------------------------------------------------------------------

Deno.test("human-PR policy - trusted humans are deferred to, never maintained", () => {
  const input = {
    githubUser: HOST,
    allowedAuthors: [HUMAN],
    fleetPrAuthors: [SIBLING],
  };
  assert(
    resolveFleetPrAuthorSet(input).includes(HUMAN),
    "The defer-to set must include trusted humans",
  );
  assert(
    !resolveFleetMaintenanceAuthorSet(input).includes(HUMAN),
    "The push-capable set must never include a trusted human",
  );
  assertEquals(resolveFleetMaintenanceAuthorSet(input), [HOST, SIBLING]);
});

Deno.test("human-PR policy - CONFIGURATION.md states the one-line rule", () => {
  assert(
    /trusted to command, not to be commanded/i.test(read(CONFIG_DOC)),
    `${CONFIG_DOC} must state the rule "trusted to command, not to be ` +
      `commanded" so the two sets cannot be misread`,
  );
  assert(
    markdownLinks(CONFIG_DOC).includes(POLICY_DOC),
    `${CONFIG_DOC} must link ${POLICY_DOC}`,
  );
});

// ---------------------------------------------------------------------------
// The blocked-`work-on` branch (Issue #4133)
// ---------------------------------------------------------------------------

Deno.test("human-PR policy - the page says a human PR never blocks pickup", () => {
  const policy = read(POLICY_DOC);
  assert(
    /never (?:parks|blocks)|does not block/i.test(policy),
    `${POLICY_DOC} must state that a human PR does not block issue pickup`,
  );
  assert(
    /#4133/.test(policy),
    `${POLICY_DOC} must cite Issue #4133 for the blocking change`,
  );
});

Deno.test("human-PR policy - the real guard ignores a human PR and keeps fleet PRs", () => {
  const pushCapable = resolveFleetMaintenanceAuthorSet({
    githubUser: HOST,
    allowedAuthors: [HUMAN],
    fleetPrAuthors: [SIBLING],
  });
  const humanPr = {
    number: 2312,
    title: "Human work in progress",
    baseRefName: "main", // allow-hardcoded-branch — fixture only
    headRefName: "feature",
    author: HUMAN,
  };
  assertEquals(getBlockingPRForIssue([humanPr], "", pushCapable), null);
  assertEquals(
    getBlockingPRForIssue([{ ...humanPr, author: SIBLING }], "", pushCapable)
      ?.number,
    2312,
  );
  // The predicate the guard filters on, checked directly.
  assert(isHumanAuthoredPr(HUMAN, pushCapable));
  assert(!isHumanAuthoredPr(SIBLING, pushCapable));
});

// ---------------------------------------------------------------------------
// The incident is on record
// ---------------------------------------------------------------------------

Deno.test("human-PR policy - LESSONS-LEARNT records the #4074 incident", () => {
  const lessons = read(LESSONS_DOC);
  assert(
    /#4074/.test(lessons),
    `${LESSONS_DOC} must record the #4074 incident by number`,
  );
  assert(
    markdownLinks(LESSONS_DOC).includes(POLICY_DOC),
    `${LESSONS_DOC} must link ${POLICY_DOC} so the lesson leads to the policy`,
  );
});
