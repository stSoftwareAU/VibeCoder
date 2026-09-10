/**
 * A credential label at the end of a line must not consume the next Markdown
 * line as its value (Issue #1727).
 *
 * The `secret-assignment` rule's separator (`["']?\s*[=:]\s*`) spans line
 * breaks, so prose ending in `credential:` adopted the following line as the
 * assignment's value. When that line was a Mermaid fence the fence itself was
 * replaced with the placeholder and the diagram stopped rendering in the
 * published PR body — `CODING-STANDARDS.md` requires that diagram.
 *
 * The rule masks strictly less than it did, so most of this file guards the
 * *other* direction: the coverage that must not move. An adversarial review of
 * the first cut found that excluding a Markdown *prefix* on *any* line turned
 * the chokepoint off — `SECRET: ` + fence + a 40-character AWS key was
 * published verbatim — and that an unbounded "plain word" test let a
 * lower-case passphrase through. Both are pinned below, as is the linearity of
 * the emphasis strip that replaced an unbounded one.
 *
 * Tests drive the public chokepoints (`redactSecrets`, `redactGhBodyText`,
 * `redactGhBodyArgs`, `containsSecret`) so they keep holding if the rule is
 * reimplemented, plus the value-side predicate for its own boundaries.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  redactGhBodyArgs,
  redactGhBodyText,
} from "../lib/gh_body_redaction.ts";
import {
  containsSecret,
  isCredentialShapedValue,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/** The PR body shape from Issue #1726 that lost its diagram. */
const MERMAID_BODY = [
  "How a spawn or a mid-run switch now picks a credential:",
  "",
  "```mermaid",
  "flowchart TD",
  "    A[Pool] --> B[Selected credential]",
  "```",
].join("\n");

/**
 * A generic credential with no provider prefix, so only this rule catches it.
 *
 * Assembled from halves at run time: written in one piece, this synthetic
 * fixture is a high-entropy literal beside a `SECRET` identifier, which is
 * exactly the shape `generic-api-key` flags. The value assembles identically.
 */
const SECRET = ["aB3dE6gH", "9jK2mN5p"].join("");

/**
 * A 40-hex ImgBB-shaped key, assembled from a short half at run time for the
 * same reason as `SECRET` above. The value assembles identically.
 */
const IMGBB_SHAPED_KEY = ["01234567", "89abcdef"].join("").repeat(2) +
  "01234567";

/** An AWS secret access key: 40 characters, no prefix any signature rule sees. */
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** Assert `body` is published byte-for-byte and reads as carrying no secret. */
function assertSurvives(body: string, label: string): void {
  assertEquals(redactSecrets(body), body, label);
  assertEquals(containsSecret(body), false, label);
}

/** Assert `body` is masked and still reads as carrying a secret. */
function assertMasked(body: string, secret: string, label: string): void {
  const out = redactSecrets(body);
  assertEquals(out.includes(secret), false, label);
  assertStringIncludes(out, REDACTION_PLACEHOLDER, label);
  assertEquals(containsSecret(body), true, label);
}

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

Deno.test("Issue #1727 - a credential lead-in keeps its Mermaid fence", () => {
  assertEquals(redactSecrets(MERMAID_BODY), MERMAID_BODY);
  assertEquals(redactGhBodyText(MERMAID_BODY), MERMAID_BODY);
  assertEquals(containsSecret(MERMAID_BODY), false);
  assertEquals(
    redactGhBodyArgs(["pr", "create", "--body", MERMAID_BODY]),
    ["pr", "create", "--body", MERMAID_BODY],
  );
});

Deno.test("Issue #1727 - every credential label spelling keeps the fence", () => {
  for (
    const label of [
      "credential:",
      "x credential:",
      "credential :",
      "the API_KEY:",
      "PASSWORD:",
      "a token:",
      "SECRET=",
    ]
  ) {
    for (const gap of ["\n\n", "\n", "\r\n\r\n"]) {
      const body =
        `${label}${gap}\`\`\`mermaid\nflowchart TD\n    A --> B\n\`\`\`\n`;
      assertSurvives(body, `${JSON.stringify(label + gap)}`);
    }
  }
});

Deno.test("Issue #1727 - Markdown after a trailing label survives redaction", () => {
  for (
    const value of [
      "```mermaid",
      "```typescript",
      "~~~mermaid",
      "![diagram](docs/evidence/a.png)",
      "`inline code`",
      "# Heading",
      "> quoted",
      "| table cell |",
      "- item",
      "1. item",
    ]
  ) {
    assertSurvives(`credential:\n\n${value}\n`, value);
  }
});

Deno.test("Issue #1727 - prose after a trailing label is not a credential", () => {
  for (
    const sentence of [
      "The pool ranks every candidate by remaining quota.",
      "Selection happens once per spawn.",
      "**Note** that a mid-run switch re-reads the pool.",
      "Although the pool is shared, each slot picks alone.",
      "That's the pool deciding, not the slot.",
      "(see the pool documentation for the ranking)",
      "1. the pool ranks every candidate",
    ]
  ) {
    assertSurvives(
      `How a spawn picks a credential:\n\n${sentence}\n`,
      sentence,
    );
  }
});

// ---------------------------------------------------------------------------
// Coverage that must not move — the review findings
// ---------------------------------------------------------------------------

Deno.test("Issue #1727 - a fence must not smuggle a secret past an inline assignment", () => {
  // Excluding a Markdown *prefix* on *any* line turned the chokepoint off.
  for (
    const [body, secret] of [
      [`AWS_SECRET_ACCESS_KEY: \`\`\`${AWS_SECRET}\`\`\``, AWS_SECRET],
      [`AWS_SECRET_ACCESS_KEY=~~~${AWS_SECRET}`, AWS_SECRET],
      [`AWS_SECRET_ACCESS_KEY=![${AWS_SECRET}`, AWS_SECRET],
      [`TOKEN: \`\`\`\`${AWS_SECRET}\`\`\`\``, AWS_SECRET],
      ["PASSWORD: ```Tr0ub4dor&3```", "Tr0ub4dor&3"],
      [
        `VIBE_IMGBB_API_KEY: \`\`\`${IMGBB_SHAPED_KEY}\`\`\``,
        IMGBB_SHAPED_KEY,
      ],
    ] as const
  ) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #1727 - a fence must not smuggle a secret across a line break either", () => {
  // The exclusion matches a *complete* fence or image, never a prefix, so a
  // secret wearing one as a costume is still masked.
  for (
    const body of [
      `AWS_SECRET_ACCESS_KEY:\n\`\`\`${AWS_SECRET}\`\`\`\n`,
      `API_KEY:\n![${AWS_SECRET}\n`,
      `API_KEY:\n~~~${AWS_SECRET}\n`,
    ]
  ) {
    assertMasked(body, AWS_SECRET, body);
  }
});

Deno.test("Issue #1727 - a lower-case passphrase is a credential, not a plain word", () => {
  // An unbounded plain-word test let any all-letters value through, however
  // long — which is a credential shape, not a prose shape.
  for (
    const [body, secret] of [
      ["PASSWORD:\ncorrecthorsebatterystaple\n", "correcthorsebatterystaple"],
      ["API_KEY:\nCorrecthorsebatterystaple\n", "Correcthorsebatterystaple"],
      ["password:\n  mysecretpassphrase\n", "mysecretpassphrase"],
      ["SECRET:\ndeadbeefcafebabe\n", "deadbeefcafebabe"],
      [`CREDENTIAL:\n${"z".repeat(30)}\n`, "z".repeat(30)],
    ] as const
  ) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #1727 - a credential-shaped value across a line break stays masked", () => {
  for (
    const [body, secret] of [
      [`CREDENTIAL:\n${SECRET}\n`, SECRET],
      [`CREDENTIAL:\r\n${SECRET}\r\n`, SECRET],
      [`credential:\n\n**${SECRET}**\n`, SECRET],
      [`credential:\n\n"short"\n`, "short"],
      [`API_KEY:\n${AWS_SECRET}\n`, AWS_SECRET],
    ] as const
  ) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #1727 - the accepted cost is one rule, and it is only this", () => {
  // The rule masks strictly less than it did. Every value it stops masking is
  // a cross-line one under the eight-character floor, or one whose scalar is a
  // plain word — pinned here so the cost cannot widen unnoticed. A quoted
  // value of the same length is still explicit assignment syntax.
  for (
    const body of [
      "PASSWORD:\nhunter7\n",
      "SECRET:\n__abc__\n",
      "SECRET:\n*hunter*\n",
    ]
  ) {
    assertSurvives(body, body);
  }
  assertMasked(`PASSWORD:\n"hunter7"\n`, "hunter7", "quoted, so still masked");
  assertMasked("PASSWORD: hunter7", "hunter7", "inline, so still masked");
});

Deno.test("Issue #1727 - the exclusion does not reach legitimate password characters", () => {
  // A backtick, `#`, `>` and `|` all occur in real passwords, so an inline
  // assignment carrying one must stay masked.
  for (
    const [body, secret] of [
      ["PASSWORD: `hunter2hunter2`", "hunter2hunter2"],
      ["SECRET: #hunter2!", "#hunter2!"],
      ["API_KEY: >hunter2hunter2", "hunter2hunter2"],
      ["CREDENTIAL: |hunter2hunter2", "hunter2hunter2"],
    ] as const
  ) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #1727 - an inline assignment value is masked exactly as before", () => {
  for (
    const body of [
      `credential: ${SECRET}`,
      `credential : ${SECRET}`,
      `CREDENTIAL="${SECRET}"`,
      `PASSWORD: **${SECRET}**`,
      `{"api_key":"${SECRET}"}`,
      "secret_scanning: enabled",
      "PASSWORD=12345",
    ]
  ) {
    assertStringIncludes(redactSecrets(body), REDACTION_PLACEHOLDER, body);
    assertEquals(containsSecret(body), true, body);
  }
});

Deno.test("Issue #1727 - a provider token after a fence is masked, fence intact", () => {
  const token = "ghp_" + "A".repeat(36);
  const body = `${MERMAID_BODY}\n\ncredential:\n\n${token}\n`;
  const out = redactGhBodyText(body);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, "```mermaid\nflowchart TD");
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

// ---------------------------------------------------------------------------
// Detection must answer the same question as replacement
// ---------------------------------------------------------------------------

Deno.test("Issue #1727 - the decode-then-rescan pass keeps the same verdicts", () => {
  // containsSecret feeds redactTransformedSecrets, so a detection that drifted
  // from the replacement would let a base64'd secret through.
  const hidden = "blob " + btoa(`PASSWORD:\n${SECRET}`);
  assertEquals(containsSecret(hidden), true, hidden);
  assertEquals(redactSecrets(hidden).includes("***REDACTED***"), true, hidden);

  // A non-uniform PEM body run: its replacement returns the input unchanged,
  // so a detection defined as "the replacement changed something" would have
  // silently dropped it.
  const pem = "blob " +
    btoa("A".repeat(40) + "\n" + "B".repeat(50) + "\n" + "C");
  assertEquals(containsSecret(pem), true, pem);
});

Deno.test("Issue #1727 - detection carries no lastIndex between calls", () => {
  const secret = `PASSWORD: ${SECRET}`;
  const clean = "a perfectly ordinary log line";
  for (let i = 0; i < 6; i++) {
    assertEquals(containsSecret(secret), true, `iteration ${i}`);
    assertEquals(containsSecret(clean), false, `iteration ${i}`);
    assertEquals(containsSecret(MERMAID_BODY), false, `iteration ${i}`);
  }
  // A long input followed by a short one must not depend on the long one.
  assertEquals(containsSecret(`${"x".repeat(5_000)}\n${secret}`), true);
  assertEquals(containsSecret(secret), true);
});

// ---------------------------------------------------------------------------
// The predicate's own boundaries
// ---------------------------------------------------------------------------

Deno.test("Issue #1727 - the predicate never judges an inline value", () => {
  // Inline assignments keep the rule's original blunt behaviour. That boundary
  // is load-bearing: judging them is what let a fence-wrapped secret through.
  for (
    const value of [
      "```mermaid",
      "~~~mermaid",
      "![a](b.png)",
      "hunter",
      "a",
      "`inline",
    ]
  ) {
    assertEquals(isCredentialShapedValue(value, true), true, value);
  }
});

Deno.test("Issue #1727 - a complete fence or image is rejected across a line break", () => {
  for (
    const value of [
      "```",
      "```mermaid",
      "```typescript",
      "~~~",
      "~~~mermaid",
      "![a](b.png)",
    ]
  ) {
    assertEquals(isCredentialShapedValue(value, false), false, value);
  }
  // A fence or an image that is only a *prefix* is not Markdown — it is a
  // secret wearing one as a costume.
  for (
    const value of [
      "```" + AWS_SECRET + "```",
      "~~~" + AWS_SECRET,
      "![" + AWS_SECRET,
      "![a](b.png)trailing",
    ]
  ) {
    assertEquals(isCredentialShapedValue(value, false), true, value);
  }
});

Deno.test("Issue #1727 - the cross-line shape boundaries", () => {
  for (
    const [value, expected] of [
      ["hunter7", false], // under the eight-character floor
      ["`inline", false], // a code span opening a sentence, likewise
      ["correcthorsebatterystaple", true],
      ["Selection", false], // a plain word, whatever its length
      ["notwithstanding", false],
      ["'abc'", true], // a quoted value is explicit syntax at any length
      ['"a"', true],
      ["**hunter7**", true],
      ["**Note**", false],
    ] as const
  ) {
    assertEquals(isCredentialShapedValue(value, false), expected, value);
  }
});
