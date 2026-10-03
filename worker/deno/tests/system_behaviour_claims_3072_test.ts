/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3072 — two fleet PRs stated false exclusive/negative claims about
 * another component's behaviour: one told the scan prompts a known-open list
 * was "the only dedup source" while every security_scan caller passed it
 * empty (#3068); one said the worker files an agent's `gh issue create` body
 * unscrubbed, when the `gh` guard shim redacts it (#3071). CODING-STANDARDS.md
 * and the issue prompt must both require verifying a claim about another
 * component's behaviour against the code that implements it before writing
 * it, with security-control claims checked against SECURITY.md and
 * docs/THREAT-MODEL.md. Issue #3090 — review-fix runs rewrote such a claim
 * with a new unverified one (#3075, #3068), so the pr_feedback prompt's
 * Making Changes section must carry the same rule for a fix run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const STANDARDS_KEY_PHRASES = [
  "Verify a claim about another component before you write it",
  "find the code that implements that behaviour",
  "cite the file in the PR body",
  "exclusive or negative claim",
  "must agree with [SECURITY.md](SECURITY.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)",
  "raise the discrepancy",
  "leave the claim out",
];

Deno.test("CODING-STANDARDS.md Prompt Engineering Guidance requires verifying claims about other components (Issue #3072)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Prompt Engineering Guidance",
    ),
  );

  for (const phrase of STANDARDS_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Prompt Engineering Guidance is missing "${phrase}": ${text}`,
    );
  }
});

const ISSUE_PROMPT_KEY_PHRASES = [
  "open the code that implements it and cite that file in the PR summary",
  "exclusive or negative claim",
  "must agree with `SECURITY.md` and `docs/THREAT-MODEL.md`",
  "raise the discrepancy",
  "Prompt Engineering Guidance",
];

Deno.test("issue prompt docs-change step requires verifying claims about other components (Issue #3072)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (const phrase of ISSUE_PROMPT_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Instructions is missing "${phrase}": ${text}`,
    );
  }
});

const PR_FEEDBACK_PROMPT_KEY_PHRASES = [
  "Verify a claim about another component before you write it",
  "open the code that implements that behaviour before you write the replacement",
  "cite the file and the function or line in `.pr_response_message`",
  "in the PR summary when it repeats the claim",
  "any new statement your fix adds",
  "exclusive or negative claim",
  "must agree with `SECURITY.md` and `docs/THREAT-MODEL.md`",
  "raise the discrepancy",
  "drop it: state the rule and the risk it addresses",
  "Prompt Engineering Guidance",
];

Deno.test("pr_feedback prompt Making Changes requires verifying claims about other components before rewriting them (Issue #3090)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (const phrase of PR_FEEDBACK_PROMPT_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}": ${text}`,
    );
  }
});
