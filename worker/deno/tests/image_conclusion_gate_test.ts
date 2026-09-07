/**
 * A privileged conclusion is withheld when an untrusted image was in front of
 * the agent (Issue #1385).
 *
 * The agent's suspicious-image self-check asks the injection target to report
 * itself, and an image can instruct it to act on hidden content *and* to stay
 * quiet. These tests pin the code-level backstop that holds when it does stay
 * quiet: the worker refuses to close an issue on the run's own "already
 * resolved" claim when an untrusted author's body carried an image.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { gateAlreadyResolvedClose } from "../lib/image_conclusion_gate.ts";
import { observeUntrustedIssueImages } from "../lib/issue_content_trust_filter.ts";
import { findImageReferences } from "../lib/untrusted_image_signal.ts";

const TRUST = { allowedAuthors: ["maintainer"], authorisedCommenters: [] };

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

Deno.test("image conclusion gate - an untrusted image withholds the already-resolved close", () => {
  const decision = gateAlreadyResolvedClose(
    findImageReferences("![shot](https://example.test/a.png)"),
  );
  assert(decision.withheld);
  assertEquals(decision.imageCount, 1);
  assertStringIncludes(decision.auditMessage ?? "", "[SECURITY]");
  assertStringIncludes(decision.auditMessage ?? "", "Issue #1385");
});

Deno.test("image conclusion gate - the audit line reports the count, never the URL", () => {
  // A URL lifted from attacker-controlled text is attacker-chosen content in a
  // log a human reads; the count is what the signal is about.
  const decision = gateAlreadyResolvedClose(
    findImageReferences("![a](https://evil.test/pwn.png)"),
  );
  assert(!(decision.auditMessage ?? "").includes("evil.test"));
});

Deno.test("image conclusion gate - several images are counted, not just flagged", () => {
  const decision = gateAlreadyResolvedClose(
    findImageReferences(
      "![a](https://example.test/a.png) ![b](https://example.test/b.png)",
    ),
  );
  assertEquals(decision.imageCount, 2);
});

Deno.test("image conclusion gate - no images leaves the close exactly as it was", () => {
  const decision = gateAlreadyResolvedClose([]);
  assertEquals(decision.withheld, false);
  assertEquals(decision.imageCount, 0);
  assertEquals(decision.auditMessage, undefined);
});

Deno.test("image conclusion gate - an unobserved route does not gate", () => {
  // `untrustedImages` is absent on routes that never classified the body, and
  // absent must not read as "an image was there".
  const decision = gateAlreadyResolvedClose(undefined);
  assertEquals(decision.withheld, false);
  assertEquals(decision.imageCount, 0);
});

// ---------------------------------------------------------------------------
// What feeds the gate
// ---------------------------------------------------------------------------

Deno.test("image conclusion gate - a trusted author's screenshot is not observed", () => {
  const refs = observeUntrustedIssueImages(
    "maintainer",
    "![shot](https://example.test/a.png)",
    TRUST,
  );
  assertEquals(refs.length, 0);
  assertEquals(gateAlreadyResolvedClose(refs).withheld, false);
});

Deno.test("image conclusion gate - an untrusted author's screenshot is observed and gates", () => {
  const refs = observeUntrustedIssueImages(
    "outsider",
    'repro:\n\n<img src="https://example.test/a.png">',
    TRUST,
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0]?.kind, "html");
  assert(gateAlreadyResolvedClose(refs).withheld);
});

Deno.test("image conclusion gate - an untrusted body with no image does not gate", () => {
  const refs = observeUntrustedIssueImages(
    "outsider",
    "The login button does not work — see `src/auth/login.ts:45`.",
    TRUST,
  );
  assertEquals(refs.length, 0);
  assertEquals(gateAlreadyResolvedClose(refs).withheld, false);
});
