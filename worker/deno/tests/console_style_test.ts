/**
 * The shared console styling the setup surfaces print through (Issue #870,
 * part of #863).
 *
 * The formatters return strings, so every case here is a plain equality check
 * — no stdout capture, no terminal, no subprocess.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  bracketedDefault,
  colourEnabled,
  type ConsoleSeverity,
  CONTINUATION_INDENT,
  createConsoleStyler,
  terminalStyler,
} from "../lib/console_style.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";

/** Does this text carry an ANSI escape sequence? */
function hasEscapes(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[[0-9;]*m/.test(text);
}

// ---------------------------------------------------------------------------
// When colour is emitted
// ---------------------------------------------------------------------------

Deno.test("colourEnabled - a TTY with no NO_COLOR is coloured", () => {
  assertEquals(colourEnabled({ tty: true }), true);
  assertEquals(colourEnabled({ tty: true, noColor: undefined }), true);
  // An empty NO_COLOR is an unset NO_COLOR, per the no-color.org convention.
  assertEquals(colourEnabled({ tty: true, noColor: "" }), true);
});

Deno.test("colourEnabled - no TTY means no colour", () => {
  assertEquals(colourEnabled({ tty: false }), false);
  assertEquals(colourEnabled({ tty: false, noColor: "" }), false);
});

Deno.test("colourEnabled - NO_COLOR beats a TTY", () => {
  assertEquals(colourEnabled({ tty: true, noColor: "true" }), false);
  assertEquals(colourEnabled({ tty: true, noColor: "1" }), false);
});

Deno.test("createConsoleStyler - a TTY emits colour escapes", () => {
  const style = createConsoleStyler({ tty: true });

  assert(style.coloured, "a bare TTY styler is coloured");
  assertEquals(style.info("hello"), "\x1b[0;34mℹ\x1b[0m  hello");
  assertEquals(style.success("hello"), "\x1b[0;32m✓\x1b[0m  hello");
  assertEquals(style.warning("hello"), "\x1b[1;33m⚠\x1b[0m  hello");
  assertEquals(style.error("hello"), "\x1b[0;31m✗\x1b[0m  hello");
  assertEquals(style.question("hello"), "\x1b[1;33m?\x1b[0m  hello");
});

Deno.test("createConsoleStyler - without a TTY the output is byte-clean", () => {
  const style = createConsoleStyler({ tty: false });

  assertEquals(style.coloured, false);
  assertEquals(style.info("hello"), "ℹ  hello");
  assertEquals(style.success("hello"), "✓  hello");
  assertEquals(style.warning("hello"), "⚠  hello");
  assertEquals(style.error("hello"), "✗  hello");
  assertEquals(style.question("hello"), "?  hello");
  for (const line of [style.info("x"), style.error("x"), style.plain("x")]) {
    assert(!hasEscapes(line), `no escapes may leak into "${line}"`);
  }
});

Deno.test("createConsoleStyler - NO_COLOR on a TTY is byte-clean too", () => {
  const style = createConsoleStyler({ tty: true, noColor: "true" });

  assertEquals(style.coloured, false);
  assertEquals(style.info("hello"), "ℹ  hello");
  assertEquals(style.warning("hello"), "⚠  hello");
  assert(!hasEscapes(style.success("hello")), "NO_COLOR must strip colour");
});

// ---------------------------------------------------------------------------
// Glyph → severity
// ---------------------------------------------------------------------------

Deno.test("createConsoleStyler - each glyph maps to its documented severity", () => {
  const style = createConsoleStyler({ tty: false });
  const expected: [ConsoleSeverity, string][] = [
    ["info", "ℹ"],
    ["success", "✓"],
    ["warning", "⚠"],
    ["error", "✗"],
    ["question", "?"],
  ];

  for (const [severity, glyph] of expected) {
    assertEquals(
      style[severity]("body"),
      `${glyph}  body`,
      `${severity} must print ${glyph}`,
    );
  }
});

Deno.test("createConsoleStyler - a continuation line aligns under the message", () => {
  const style = createConsoleStyler({ tty: true });

  // The glyph column plus its two-space gap: three columns before the text.
  assertEquals(CONTINUATION_INDENT.length, 3);
  assertEquals(style.plain("more"), "   more");
  assertEquals(
    style.info("first").indexOf("first"),
    "\x1b[0;34mℹ\x1b[0m".length + 2,
  );
});

// ---------------------------------------------------------------------------
// Bracketed defaults
// ---------------------------------------------------------------------------

Deno.test("bracketedDefault - a value renders in brackets", () => {
  assertEquals(
    bracketedDefault("Update mode", "frozen"),
    "Update mode [frozen]",
  );
});

Deno.test("bracketedDefault - no default never renders a stray []", () => {
  assertEquals(bracketedDefault("Pinned ref", undefined), "Pinned ref");
  assertEquals(bracketedDefault("Pinned ref", ""), "Pinned ref");
  assertEquals(bracketedDefault("Pinned ref", "   "), "Pinned ref");
});

// ---------------------------------------------------------------------------
// The process styler
// ---------------------------------------------------------------------------

Deno.test("terminalStyler - reads NO_COLOR through the injected lookup", () => {
  // The lookup is a parameter, so nothing here touches the process
  // environment that every parallel test shares (Issues #880, #956).
  const set: EnvLookup = (name) => name === "NO_COLOR" ? "true" : undefined;
  const unset: EnvLookup = () => undefined;

  const suppressed = terminalStyler({ isTerminal: () => true }, set);
  assertEquals(suppressed.coloured, false);
  assertStringIncludes(suppressed.info("hi"), "ℹ  hi");

  assertEquals(
    terminalStyler({ isTerminal: () => true }, unset).coloured,
    true,
  );
  assertEquals(
    terminalStyler({ isTerminal: () => false }, unset).coloured,
    false,
  );
});
