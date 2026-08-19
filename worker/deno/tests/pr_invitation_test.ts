/**
 * Tests for the explicit-invitation predicate (Issue #4077).
 *
 * The matrix below is the fail-closed contract: any regression that widens
 * admission (the dangerous direction) turns a specific case red, and the
 * trusted-label / trusted-mention cases guard the opposite failure — an
 * invitation silently ignored, reverting to #4076's blanket ignore.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  bodyMentionsAnyLogin,
  DEFAULT_INVITE_LABEL,
  type InvitationPr,
  isPrInvited,
  type PrInvitationOptions,
} from "../lib/pr_invitation.ts";

/** Host login. */
const HOST = "VibeCoderBot";
/** Sibling fleet host — also a valid @mention target, never an inviter. */
const SIBLING = "stsvcbot";
/** Trusted human (`allowed_authors`). */
const HUMAN = "courtyen";
/** Untrusted actor with triage rights. */
const OUTSIDER = "drive-by";

const OPTIONS: PrInvitationOptions = {
  githubUser: HOST,
  allowedAuthors: [HUMAN, SIBLING],
  fleetPrAuthors: [SIBLING],
};

/** A human-authored PR with the given labels/comments/reviews. */
function humanPr(overrides: Partial<InvitationPr> = {}): InvitationPr {
  return {
    number: 2312,
    author: { login: HUMAN },
    labels: [],
    comments: [],
    reviews: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Label signal
// ---------------------------------------------------------------------------

Deno.test("isPrInvited - trusted human labels their own PR (Issue #4077)", () => {
  const result = isPrInvited(
    humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: HUMAN }] }),
    OPTIONS,
  );
  assertEquals(result, { invited: true, via: "label", invitedBy: HUMAN });
});

Deno.test("isPrInvited - label match is case-insensitive on name and login", () => {
  const result = isPrInvited(
    humanPr({ labels: [{ name: "Work-On", addedBy: HUMAN.toUpperCase() }] }),
    OPTIONS,
  );
  assertEquals(result.invited, true);
  assertEquals(result.via, "label");
  assertEquals(result.invitedBy, HUMAN.toUpperCase());
});

Deno.test("isPrInvited - untrusted actor applying the label does not invite", () => {
  const result = isPrInvited(
    humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: OUTSIDER }] }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a fleet account cannot conscript the worker by labelling", () => {
  for (const login of [HOST, SIBLING]) {
    const result = isPrInvited(
      humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: login }] }),
      OPTIONS,
    );
    assertEquals(result, { invited: false, via: null }, `login=${login}`);
  }
});

Deno.test("isPrInvited - an unattributable label add does not invite", () => {
  for (const addedBy of [null, undefined, "", "   "]) {
    const result = isPrInvited(
      humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy }] }),
      OPTIONS,
    );
    assertEquals(result, { invited: false, via: null }, `addedBy=${addedBy}`);
  }
});

Deno.test("isPrInvited - a different label from a trusted human does not invite", () => {
  const result = isPrInvited(
    humanPr({ labels: [{ name: "top-priority", addedBy: HUMAN }] }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a configured invite label overrides the default", () => {
  const opts = { ...OPTIONS, inviteLabel: "vibe-please" };
  assertEquals(
    isPrInvited(
      humanPr({ labels: [{ name: "vibe-please", addedBy: HUMAN }] }),
      opts,
    )
      .via,
    "label",
  );
  assertEquals(
    isPrInvited(
      humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: HUMAN }] }),
      opts,
    ).invited,
    false,
  );
});

Deno.test("isPrInvited - label dropped after a previous admission is not invited", () => {
  // Revocation: the verdict is derived from current state only, so the
  // next scan of the same PR with the label gone admits nothing.
  const admitted = isPrInvited(
    humanPr({ labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: HUMAN }] }),
    OPTIONS,
  );
  assertEquals(admitted.invited, true);
  assertEquals(isPrInvited(humanPr({ labels: [] }), OPTIONS), {
    invited: false,
    via: null,
  });
});

// ---------------------------------------------------------------------------
// Mention signal
// ---------------------------------------------------------------------------

Deno.test("isPrInvited - trusted human @mentions the host login", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{ author: { login: HUMAN }, body: `@${HOST} please fix CI` }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: true, via: "mention", invitedBy: HUMAN });
});

Deno.test("isPrInvited - a mention of a sibling fleet login also invites", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: `hey @${SIBLING}, take this`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result.invited, true);
  assertEquals(result.via, "mention");
});

Deno.test("isPrInvited - a review body counts as a mention", () => {
  const result = isPrInvited(
    humanPr({
      reviews: [{ author: { login: HUMAN }, body: `@${HOST} over to you.` }],
    }),
    OPTIONS,
  );
  assertEquals(result.invited, true);
  assertEquals(result.via, "mention");
});

Deno.test("isPrInvited - a mention from an untrusted commenter does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: OUTSIDER },
        body: `@${HOST} please fix CI`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - the worker cannot @mention itself into an invitation", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HOST },
        body: `@${HOST} adopting this PR`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a mention inside a fenced code block does not invite", () => {
  const body = [
    "CI log:",
    "```",
    `@${HOST} please fix CI`,
    "```",
    "any ideas?",
  ].join("\n");
  const result = isPrInvited(
    humanPr({ comments: [{ author: { login: HUMAN }, body }] }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a mention inside an inline code span does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: `the log line was \`@${HOST} please fix CI\` — odd`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a mention inside a quoted line does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: `> @${HOST} please fix CI\n\nI disagree, leave it.`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - an email address containing the login does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: `mail ${HOST.toLowerCase()}@${HOST}.example.com about it`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - an @ token that is not the worker login does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: "@someone-else can you look?",
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - a longer login sharing the prefix does not invite", () => {
  const result = isPrInvited(
    humanPr({
      comments: [{
        author: { login: HUMAN },
        body: `@${HOST}-staging owns this`,
      }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

// ---------------------------------------------------------------------------
// Fail-closed defaults
// ---------------------------------------------------------------------------

Deno.test("isPrInvited - a human PR with neither signal is not invited (Issue #4074)", () => {
  const result = isPrInvited(
    humanPr({
      labels: [{ name: "bug", addedBy: HUMAN }],
      comments: [{ author: { login: HUMAN }, body: "rebased onto main" }],
      reviews: [{ author: { login: OUTSIDER }, body: "looks good" }],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: false, via: null });
});

Deno.test("isPrInvited - unparseable or empty input is not invited", () => {
  assertEquals(isPrInvited(null, OPTIONS), { invited: false, via: null });
  assertEquals(isPrInvited(undefined, OPTIONS), { invited: false, via: null });
  assertEquals(isPrInvited({}, OPTIONS), { invited: false, via: null });
  assertEquals(
    isPrInvited(
      { labels: null, comments: null, reviews: null },
      OPTIONS,
    ),
    { invited: false, via: null },
  );
});

Deno.test("isPrInvited - no configured allowed authors means nobody can invite", () => {
  const opts: PrInvitationOptions = { githubUser: HOST, allowedAuthors: [] };
  assertEquals(
    isPrInvited(
      humanPr({
        labels: [{ name: DEFAULT_INVITE_LABEL, addedBy: HUMAN }],
        comments: [{ author: { login: HUMAN }, body: `@${HOST} fix it` }],
      }),
      opts,
    ),
    { invited: false, via: null },
  );
});

Deno.test("isPrInvited - a malformed comment entry is skipped, not thrown on", () => {
  const result = isPrInvited(
    humanPr({
      comments: [
        null as unknown as { author: null; body: null },
        { author: null, body: `@${HOST} fix it` },
        { author: { login: HUMAN }, body: null },
        { author: { login: HUMAN }, body: `@${HOST} please fix CI` },
      ],
    }),
    OPTIONS,
  );
  assertEquals(result, { invited: true, via: "mention", invitedBy: HUMAN });
});

// ---------------------------------------------------------------------------
// Mention tokenisation (exported helper)
// ---------------------------------------------------------------------------

Deno.test("bodyMentionsAnyLogin - token boundaries and quoting", () => {
  const targets = [HOST];
  assertEquals(bodyMentionsAnyLogin(`@${HOST}`, targets), true);
  assertEquals(bodyMentionsAnyLogin(`(@${HOST}) please`, targets), true);
  assertEquals(bodyMentionsAnyLogin(`hi @${HOST}.`, targets), true);
  assertEquals(
    bodyMentionsAnyLogin(`@${HOST.toLowerCase()} hi`, targets),
    true,
  );
  assertEquals(bodyMentionsAnyLogin(`x@${HOST}`, targets), false);
  assertEquals(bodyMentionsAnyLogin(`owner/${HOST}@${HOST}`, targets), false);
  assertEquals(bodyMentionsAnyLogin(`@${HOST}_bot`, targets), false);
  assertEquals(bodyMentionsAnyLogin(HOST, targets), false);
  assertEquals(bodyMentionsAnyLogin("", targets), false);
  assertEquals(bodyMentionsAnyLogin(null, targets), false);
  assertEquals(bodyMentionsAnyLogin(`@${HOST}`, []), false);
});

Deno.test("bodyMentionsAnyLogin - a target is matched literally, never as a pattern", () => {
  // Targets come from configuration; they are compared as text, so regex
  // metacharacters match only themselves and never a constructed pattern.
  assertEquals(bodyMentionsAnyLogin("@axb", ["a.b"]), false);
  assertEquals(bodyMentionsAnyLogin("@aaaa", ["a+"]), false);
  assertEquals(bodyMentionsAnyLogin("@bot", [" BOT "]), true);
  // A mention of one target still matches when other targets do not.
  assertEquals(bodyMentionsAnyLogin(`hi @${HOST}!`, ["other", HOST]), true);
});
