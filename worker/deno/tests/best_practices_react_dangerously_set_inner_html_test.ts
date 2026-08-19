/**
 * Tests for the `dangerouslySetInnerHTML` check added to the
 * `react` best-practices bucket guide (Issue #2364).
 *
 * The react bucket guide must call out unsanitised
 * `dangerouslySetInnerHTML` as an XSS sink, name `DOMPurify` as the
 * canonical sanitiser, and state the severity scheme (high when the
 * value is attacker-controllable, otherwise medium).
 *
 * Australian English spelling used throughout.
 */

import { assert } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function readReactBucket(): Promise<string> {
  return await Deno.readTextFile(
    `${PROMPTS_DIR}/best_practices/buckets/react.md`,
  );
}

Deno.test(
  "buckets/react.md - flags dangerouslySetInnerHTML as an XSS sink",
  async () => {
    const body = await readReactBucket();
    assert(
      body.includes("dangerouslySetInnerHTML"),
      "react bucket must call out dangerouslySetInnerHTML",
    );
    const lower = body.toLowerCase();
    assert(
      lower.includes("xss"),
      "react bucket must label dangerouslySetInnerHTML as an XSS sink",
    );
  },
);

Deno.test(
  "buckets/react.md - names DOMPurify as the canonical sanitiser",
  async () => {
    const body = await readReactBucket();
    assert(
      body.includes("DOMPurify"),
      "react bucket must name DOMPurify as the canonical sanitiser",
    );
  },
);

Deno.test(
  "buckets/react.md - states the severity scheme for dangerouslySetInnerHTML",
  async () => {
    const body = await readReactBucket().then((s) => s.toLowerCase());
    // The finding is `severity:high` when the value is
    // attacker-controllable, `severity:medium` otherwise.
    assert(
      body.includes("severity:high") || body.includes("`high`") ||
        body.includes("high "),
      "react bucket must state the high severity for attacker-controllable values",
    );
    assert(
      body.includes("severity:medium") || body.includes("`medium`") ||
        body.includes("medium "),
      "react bucket must state the medium severity fallback",
    );
  },
);

Deno.test(
  // Issue #3509: the react bucket guide is inlined verbatim into the
  // best-practices wrapper body filed cross-repo, so a bare `#2364`
  // reference would mislink to the *target* repo's issue 2364. The check
  // must stand on its own content with the issue citation dropped. (This
  // assertion replaced an earlier one that required `#2364` to be present.)
  "buckets/react.md - dangerouslySetInnerHTML check carries no bare #NNN citation",
  async () => {
    const body = await readReactBucket();
    assert(
      body.includes("dangerouslySetInnerHTML"),
      "react bucket must still describe the dangerouslySetInnerHTML check",
    );
    assert(
      !/(?<!\w)#\d+/.test(body),
      "react bucket must not carry a bare `#NNN` reference (it mislinks " +
        "when filed cross-repo — see Issue #3509)",
    );
  },
);
