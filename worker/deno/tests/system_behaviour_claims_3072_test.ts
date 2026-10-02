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
 * docs/THREAT-MODEL.md.
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
