/**
 * An untrusted body's image references are observed independently (Refs #1385).
 *
 * The agent's suspicious-image self-check asks the injection target to report
 * itself, and an image can instruct it to stay quiet. These tests pin the one
 * thing the model cannot suppress: the reference is in the body text the
 * worker parsed before the agent saw any of it.
 *
 * This records; it does not gate. The tests assert that too — a trusted
 * author's images are not reported, and no case here changes what the worker
 * decides to do.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeUntrustedImages,
  findImageReferences,
} from "../lib/untrusted_image_signal.ts";
import { annotateIssueContentWithTrust } from "../lib/issue_content_trust_filter.ts";

const UNTRUSTED = { allowedAuthors: ["maintainer"], authorisedCommenters: [] };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

Deno.test("image signal - markdown image syntax is found", () => {
  const refs = findImageReferences(
    "see ![screenshot](https://example.test/a.png) here",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0]?.kind, "markdown");
  assertEquals(refs[0]?.url, "https://example.test/a.png");
});

Deno.test("image signal - an HTML img element is found, attribute order independent", () => {
  const refs = findImageReferences(
    '<img alt="x" width="20" src="https://example.test/b.png">',
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0]?.kind, "html");
  assertEquals(refs[0]?.url, "https://example.test/b.png");
});

Deno.test("image signal - a bare GitHub attachment link is found", () => {
  // GitHub renders these as images with no markdown syntax at all, so a body
  // carrying only the raw link still shows the agent a picture.
  const refs = findImageReferences(
    "https://github.com/user-attachments/assets/0191cd7a-2b6e-47cc-9f11-2b0a9f2f77aa",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0]?.kind, "attachment");
});

Deno.test("image signal - the same URL written twice is reported once", () => {
  const refs = findImageReferences(
    "![a](https://example.test/x.png) and again ![b](https://example.test/x.png)",
  );
  assertEquals(refs.length, 1);
});

Deno.test("image signal - prose and ordinary links are not images", () => {
  assertEquals(
    findImageReferences(
      "see [the docs](https://example.test/page) and !not-an-image",
    ),
    [],
  );
  assertEquals(findImageReferences(""), []);
});

Deno.test("image signal - an unterminated markdown image does not match", () => {
  // Bounded patterns: a hostile body must not turn detection into a stall.
  assertEquals(findImageReferences(`![${"a".repeat(5000)}`), []);
});

Deno.test("image signal - a very long body is handled promptly", () => {
  const body = `${
    "lorem ipsum ".repeat(20000)
  }![s](https://example.test/c.png)`;
  const started = performance.now();
  const refs = findImageReferences(body);
  assertEquals(refs.length, 1);
  assertEquals(
    performance.now() - started < 2000,
    true,
    "detection must stay linear",
  );
});

// ---------------------------------------------------------------------------
// The audit line
// ---------------------------------------------------------------------------

Deno.test("image signal - the audit line reports counts and kinds, never the URLs", () => {
  const refs = findImageReferences(
    '![a](https://attacker.test/one.png) <img src="https://attacker.test/two.png">',
  );
  const line = describeUntrustedImages(refs, "outsider", "issue body") ?? "";
  assertStringIncludes(line, "[SECURITY]");
  assertStringIncludes(line, "2 image reference(s)");
  assertStringIncludes(line, "outsider");
  // A URL lifted from attacker-controlled text is attacker-chosen content in
  // a log a human reads; the count is what the signal is about.
  assertEquals(line.includes("attacker.test"), false);
});

Deno.test("image signal - no images means no audit line", () => {
  assertEquals(
    describeUntrustedImages([], "outsider", "issue body"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Wiring: the existing trust classification decides, not a second notion
// ---------------------------------------------------------------------------

Deno.test("image signal - an untrusted author's images are recorded", () => {
  const result = annotateIssueContentWithTrust(
    "outsider",
    "Bug report",
    "steps to reproduce ![screenshot](https://example.test/s.png)",
    UNTRUSTED,
  );
  assertEquals(result.trustLevel, "UNTRUSTED");
  assertEquals(result.untrustedImages.length, 1);
  assertEquals(
    result.securityAuditMessages.some((m) => m.includes("image reference(s)")),
    true,
  );
});

Deno.test("image signal - a trusted author's images are not reported", () => {
  // The trusted fast path is preserved exactly: no detection, no audit events.
  const result = annotateIssueContentWithTrust(
    "maintainer",
    "Bug report",
    "steps to reproduce ![screenshot](https://example.test/s.png)",
    UNTRUSTED,
  );
  assertEquals(result.trustLevel, "TRUSTED");
  assertEquals(result.untrustedImages, []);
  assertEquals(result.securityAuditMessages, []);
});

Deno.test("image signal - an untrusted body with no image reports nothing extra", () => {
  const result = annotateIssueContentWithTrust(
    "outsider",
    "Bug report",
    "plain text, no attachments",
    UNTRUSTED,
  );
  assertEquals(result.untrustedImages, []);
  assertEquals(
    result.securityAuditMessages.some((m) => m.includes("image reference(s)")),
    false,
  );
});

Deno.test("image signal - recording an image does not mark the body suspicious", () => {
  // The signal must not gate. An ordinary screenshot in a bug report is not a
  // finding, and a control that fires on ordinary behaviour gets switched off.
  const result = annotateIssueContentWithTrust(
    "outsider",
    "Bug report",
    "here is what I see ![screenshot](https://example.test/s.png)",
    UNTRUSTED,
  );
  assertEquals(result.bodySuspicious, false);
  assertEquals(result.titleSuspicious, false);
});
