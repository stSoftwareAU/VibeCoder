/**
 * Tests for the idle-task attribution footer helper (Issue #2438), including
 * the optional model-tier segment and its parser (Issue #4007).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  appendIdleTaskAttribution,
  buildAttributionFooter,
  parseAttributionFooter,
} from "../lib/idle_task_attribution.ts";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

Deno.test("buildAttributionFooter - happy path returns a single backtick-wrapped line", () => {
  const footer = buildAttributionFooter({
    template: "test-audit",
    runId: "vibe-lkz3p9x-1a2b3c",
  });

  // Single line — no embedded newlines.
  assertEquals(footer.includes("\n"), false);
  // Emoji prefix.
  assertStringIncludes(footer, "🏷️");
  // Both fields are backtick-wrapped so they survive copy/paste.
  assertStringIncludes(footer, "`test-audit`");
  assertStringIncludes(footer, "`vibe-lkz3p9x-1a2b3c`");
  // Names the template and the run id.
  assertStringIncludes(footer, "template");
  assertStringIncludes(footer, "Run id");
});

Deno.test("buildAttributionFooter - empty template throws", () => {
  assertThrows(
    () => buildAttributionFooter({ template: "", runId: "vibe-1-2" }),
    Error,
    "template",
  );
});

Deno.test("buildAttributionFooter - whitespace-only template throws", () => {
  assertThrows(
    () => buildAttributionFooter({ template: "   ", runId: "vibe-1-2" }),
    Error,
    "template",
  );
});

Deno.test("buildAttributionFooter - empty runId throws", () => {
  assertThrows(
    () => buildAttributionFooter({ template: "test-audit", runId: "" }),
    Error,
    "runId",
  );
});

Deno.test("buildAttributionFooter - whitespace-only runId throws", () => {
  assertThrows(
    () => buildAttributionFooter({ template: "test-audit", runId: "  " }),
    Error,
    "runId",
  );
});

Deno.test("buildAttributionFooter - special characters are emitted verbatim", () => {
  const template = "weird*bucket_<name>";
  const runId = "vibe-id-with-`tick`-and-$dollar";
  const footer = buildAttributionFooter({ template, runId });

  assertStringIncludes(footer, template);
  assertStringIncludes(footer, runId);
});

// ---------------------------------------------------------------------------
// appendIdleTaskAttribution — the single idempotent guard (Issue #3513)
// ---------------------------------------------------------------------------

const FOOTER_PREFIX = "🏷️ Filed by idle-task template:";

Deno.test(
  "appendIdleTaskAttribution - footerless body gets exactly one footer plus run-id block",
  () => {
    const out = appendIdleTaskAttribution("# Wrapper body\n\nSome prose.", {
      template: "dead-code",
      runId: "vibe-abc-123",
    });

    assertEquals(countOccurrences(out, FOOTER_PREFIX), 1);
    assertStringIncludes(out, "`dead-code`");
    assertStringIncludes(out, "`vibe-abc-123`");
    // The machine-readable run-id block is always appended.
    assertStringIncludes(out, "```\nrun-id: vibe-abc-123\n```");
  },
);

Deno.test(
  "appendIdleTaskAttribution - body already ending with the footer is not double-stamped (Issue #3513)",
  () => {
    const template = "workflow-annotation-scan";
    const runId = "vibe-mrohvwmj-f55930";
    // Mirror a template whose buildIssueBody pre-embedded the footer via the
    // {{ATTRIBUTION_FOOTER}} placeholder — the exact private-repo-14#3394 shape.
    const embedded = buildAttributionFooter({ template, runId });
    const preStamped =
      `# Workflow-Run Annotation Scan\n\nprose\n\n---\n\n${embedded}`;

    const out = appendIdleTaskAttribution(preStamped, { template, runId });

    // Exactly one footer — the pre-embedded one is reused, not duplicated.
    assertEquals(countOccurrences(out, FOOTER_PREFIX), 1);
    // The run-id metadata block is still appended after the single footer.
    assertStringIncludes(out, "```\nrun-id: vibe-mrohvwmj-f55930\n```");
  },
);

Deno.test(
  "appendIdleTaskAttribution - trailing whitespace after an embedded footer still de-dupes",
  () => {
    const template = "dead-code";
    const runId = "vibe-xyz-999";
    const embedded = buildAttributionFooter({ template, runId });
    const preStamped = `body\n\n${embedded}\n\n   \n`;

    const out = appendIdleTaskAttribution(preStamped, { template, runId });

    assertEquals(countOccurrences(out, FOOTER_PREFIX), 1);
  },
);

Deno.test(
  "appendIdleTaskAttribution - inline placeholder mid-body still gets a trailing footer",
  () => {
    // The 9 LLM-driven prompts reference the footer inline in instructions,
    // so the last line is NOT a footer — the trailing footer must be appended.
    const template = "security-scan";
    const runId = "vibe-inline-1";
    const footer = buildAttributionFooter({ template, runId });
    const body = `instructions mention ${footer} here\n\nmore prose`;

    const out = appendIdleTaskAttribution(body, { template, runId });

    // One inline mention + one appended trailing footer = two occurrences,
    // and the body must END with the footer then the run-id block.
    assertEquals(countOccurrences(out, FOOTER_PREFIX), 2);
    const lines = out.trimEnd().split("\n");
    assertEquals(lines.at(-1), "```");
    assertEquals(lines.at(-2), "run-id: vibe-inline-1");
  },
);

// ---------------------------------------------------------------------------
// Model-tier segment and parser (Issue #4007)
// ---------------------------------------------------------------------------

Deno.test(
  "buildAttributionFooter - without model is unchanged character-for-character",
  () => {
    // Pinned literal: the line-oriented matching in idle_task_freshness.ts,
    // idle_task_backfill.ts and the single-stamp guard (#3513) all key off
    // this exact shape, so any byte drift must fail here first.
    assertEquals(
      buildAttributionFooter({
        template: "security-scan",
        runId: "vibe-lkz3p9x-1a2b3c",
      }),
      "🏷️ Filed by idle-task template: `security-scan` · Run id: `vibe-lkz3p9x-1a2b3c`",
    );
  },
);

Deno.test("buildAttributionFooter - a model appends one extra segment", () => {
  const legacy = buildAttributionFooter({
    template: "security-scan",
    runId: "vibe-lkz3p9x-1a2b3c",
  });
  const stamped = buildAttributionFooter({
    template: "security-scan",
    runId: "vibe-lkz3p9x-1a2b3c",
    model: "fable",
  });

  assertEquals(stamped, `${legacy} · Model: \`fable\``);
  // Still a single line — both freshness and backfill match line-wise.
  assertEquals(stamped.includes("\n"), false);
});

Deno.test(
  "buildAttributionFooter - an explicitly blank model fails loud",
  () => {
    assertThrows(
      () =>
        buildAttributionFooter({
          template: "security-scan",
          runId: "vibe-1-2",
          model: "   ",
        }),
      Error,
      "model",
    );
  },
);

Deno.test(
  "parseAttributionFooter - recovers template, runId and model from a stamped footer",
  () => {
    const opts = {
      template: "security-scan",
      runId: "vibe-lkz3p9x-1a2b3c",
      model: "fable",
    };
    assertEquals(parseAttributionFooter(buildAttributionFooter(opts)), {
      template: "security-scan",
      runId: "vibe-lkz3p9x-1a2b3c",
      model: "fable",
    });
  },
);

Deno.test("parseAttributionFooter - an unstamped footer yields a null model", () => {
  const footer = buildAttributionFooter({
    template: "test-audit",
    runId: "vibe-1-2",
  });
  assertEquals(parseAttributionFooter(footer), {
    template: "test-audit",
    runId: "vibe-1-2",
    model: null,
  });
});

Deno.test("parseAttributionFooter - reads a footer embedded in a full body", () => {
  const body = appendIdleTaskAttribution("# Wrapper\n\nprose", {
    template: "dead-code",
    runId: "vibe-abc-123",
    model: "sonnet",
  });
  assertEquals(parseAttributionFooter(body), {
    template: "dead-code",
    runId: "vibe-abc-123",
    model: "sonnet",
  });
});

Deno.test("parseAttributionFooter - an odd tier string is recovered verbatim", () => {
  const footer = buildAttributionFooter({
    template: "dead-code",
    runId: "vibe-1-2",
    model: "some-future-tier-9",
  });
  assertEquals(parseAttributionFooter(footer)?.model, "some-future-tier-9");
});

Deno.test("parseAttributionFooter - tolerates trailing whitespace", () => {
  const footer = buildAttributionFooter({
    template: "dead-code",
    runId: "vibe-1-2",
    model: "sonnet",
  });
  assertEquals(
    parseAttributionFooter(`${footer}   \r\nnext line`)?.model,
    "sonnet",
  );
});

Deno.test("parseAttributionFooter - returns null on malformed bodies, never throws", () => {
  for (
    const body of [
      "",
      "A plain issue body.",
      "🏷️ Filed by idle-task template:",
      "🏷️ Filed by idle-task template: `dead-code`",
      "🏷️ Filed by idle-task template: dead-code · Run id: vibe-1-2",
      "🏷️ Filed by idle-task template: `dead-code` · Run id: `vibe-1-2` · junk",
    ]
  ) {
    assertEquals(parseAttributionFooter(body), null, `parsed: ${body}`);
  }
});

Deno.test(
  "appendIdleTaskAttribution - a model-stamped body is still stamped exactly once",
  () => {
    const opts = {
      template: "workflow-annotation-scan",
      runId: "vibe-mrohvwmj-f55930",
      model: "fable",
    };
    const preStamped = `# Scan\n\nprose\n\n${buildAttributionFooter(opts)}`;

    const out = appendIdleTaskAttribution(preStamped, opts);

    assertEquals(countOccurrences(out, FOOTER_PREFIX), 1);
    assertEquals(parseAttributionFooter(out)?.model, "fable");
  },
);
