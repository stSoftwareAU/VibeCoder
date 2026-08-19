/**
 * Tests for the wrapper model-tier parser (Issue #4010).
 *
 * The tier a cadence-biased wrapper was filed for travels in the wrapper
 * body's attribution footer (`· Model: \`sonnet\``, Issue #4007), because the
 * filing process and the claiming worker are not the same run. This module
 * is the reading side, and the allowlist is the security boundary: an issue
 * body is user-editable, so only a known tier alias may ever reach
 * `--model`.
 *
 * Coverage:
 *   - a stamped `sonnet` / `fable` footer parses to that tier;
 *   - an unstamped wrapper parses to `undefined` with no warning;
 *   - unknown, empty and junk values are ignored with a warning;
 *   - the filer-appended (last) footer wins over a footer embedded
 *     earlier in the body;
 *   - a body with no footer at all is silent.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseWrapperModelTier } from "../lib/idle_task_model_tier.ts";
import { buildAttributionFooter } from "../lib/idle_task_attribution.ts";
import type { Logger } from "../types.ts";

interface LogRecord {
  message: string;
  context?: unknown;
}

function makeLogger(): { logger: Logger; warnings: LogRecord[] } {
  const warnings: LogRecord[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (message, context) => warnings.push({ message, context }),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

/** Wrapper body shaped like a real filed wrapper, optionally tier-stamped. */
function wrapperBody(model?: string): string {
  return [
    "# Run a security scan",
    "",
    "Audit the repository and file findings.",
    "",
    buildAttributionFooter({
      template: "security-scan",
      runId: "vibe-run-1234",
      ...(model !== undefined ? { model } : {}),
    }),
    "",
    "<!-- vibe-run-id: vibe-run-1234 -->",
  ].join("\n");
}

Deno.test("parseWrapperModelTier - honours a stamped sonnet tier", () => {
  const { logger, warnings } = makeLogger();
  assertEquals(
    parseWrapperModelTier(wrapperBody("sonnet"), { logger }),
    "sonnet",
  );
  assertEquals(warnings.length, 0);
});

Deno.test("parseWrapperModelTier - honours a stamped fable tier", () => {
  const { logger, warnings } = makeLogger();
  assertEquals(
    parseWrapperModelTier(wrapperBody("fable"), { logger }),
    "fable",
  );
  assertEquals(warnings.length, 0);
});

Deno.test(
  "parseWrapperModelTier - unstamped wrapper yields undefined, silently",
  () => {
    const { logger, warnings } = makeLogger();
    assertEquals(parseWrapperModelTier(wrapperBody(), { logger }), undefined);
    assertEquals(warnings.length, 0);
  },
);

Deno.test("parseWrapperModelTier - body with no footer yields undefined", () => {
  const { logger, warnings } = makeLogger();
  assertEquals(
    parseWrapperModelTier("Just an ordinary issue body.", { logger }),
    undefined,
  );
  assertEquals(warnings.length, 0);
});

Deno.test(
  "parseWrapperModelTier - unknown alias is ignored with a warning",
  () => {
    const { logger, warnings } = makeLogger();
    assertEquals(
      parseWrapperModelTier(wrapperBody("gpt-9"), { logger }),
      undefined,
    );
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!.message, "model tier");
  },
);

Deno.test(
  "parseWrapperModelTier - junk value is ignored and the warning is bounded",
  () => {
    const { logger, warnings } = makeLogger();
    const junk = "x".repeat(200);
    assertEquals(
      parseWrapperModelTier(wrapperBody(junk), { logger }),
      undefined,
    );
    assertEquals(warnings.length, 1);
    const tier = (warnings[0]!.context as { tier?: string }).tier ?? "";
    assert(
      tier.length <= 64,
      `expected the logged tier to be truncated, got ${tier.length} chars`,
    );
  },
);

Deno.test(
  "parseWrapperModelTier - an empty stamp is ignored with a warning",
  () => {
    const { logger, warnings } = makeLogger();
    // Hand-edited footer: the segment is present but carries no tier.
    const body = [
      "# Run a security scan",
      "🏷️ Filed by idle-task template: `security-scan` · Run id: " +
      "`vibe-run-1234` · Model: ``",
    ].join("\n");
    assertEquals(parseWrapperModelTier(body, { logger }), undefined);
    assertEquals(warnings.length, 1);
  },
);

Deno.test(
  "parseWrapperModelTier - a shell-flavoured value never reaches the caller",
  () => {
    const { logger, warnings } = makeLogger();
    assertEquals(
      parseWrapperModelTier(wrapperBody("sonnet; rm -rf /"), { logger }),
      undefined,
    );
    assertEquals(warnings.length, 1);
  },
);

Deno.test("parseWrapperModelTier - tier alias matching is case-insensitive", () => {
  const { logger, warnings } = makeLogger();
  assertEquals(
    parseWrapperModelTier(wrapperBody("Sonnet"), { logger }),
    "sonnet",
  );
  assertEquals(warnings.length, 0);
});

Deno.test(
  "parseWrapperModelTier - the filer-appended footer wins over an embedded one",
  () => {
    // A wrapper body can carry a footer *inside* the prompt (the template
    // tells Claude to stamp findings with it) before the filer appends the
    // real one. The appended, last footer is the authoritative stamp.
    const body = [
      "# Run a security scan",
      "Stamp every finding with:",
      buildAttributionFooter({
        template: "security-scan",
        runId: "vibe-run-0001",
      }),
      "",
      buildAttributionFooter({
        template: "security-scan",
        runId: "vibe-run-1234",
        model: "fable",
      }),
    ].join("\n");
    const { logger } = makeLogger();
    assertEquals(parseWrapperModelTier(body, { logger }), "fable");
  },
);

Deno.test("parseWrapperModelTier - works without a logger", () => {
  assertEquals(parseWrapperModelTier(wrapperBody("haiku")), "haiku");
  assertEquals(parseWrapperModelTier(wrapperBody("gpt-9")), undefined);
});
