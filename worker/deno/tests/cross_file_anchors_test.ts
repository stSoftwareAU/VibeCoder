/**
 * Regression tests for cross-file `#fragment` anchor links (Issue #3337).
 *
 * Markdown-lint's MD051 rule only validates a link's fragment against
 * headings in the *same* file — it has no notion of a `../OTHER.md#frag`
 * link pointing at a heading that doesn't exist (or no longer exists) in
 * `OTHER.md`. That gap let cross-file anchors rot silently. These tests
 * cover:
 *
 *   1. {@link crossFileAnchorLinks} itself — an evasion table of inputs it
 *      must and must not report, including code-fence and code-span
 *      exclusions, and link text that soft-wraps across lines, matched per
 *      paragraph (Issue #4870).
 *   2. {@link decodeFragment} — well-formed and malformed percent-escapes.
 *   3. A growth check that the link-extraction regex stays linear against a
 *      hostile, link-shaped input.
 *   4. A repo-wide sweep: every cross-file `#fragment` link under the repo
 *      root must resolve to a real heading in its target file.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  anchorSet,
  crossFileAnchorLinks,
  decodeFragment,
} from "../lib/markdown_anchors.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// 1. crossFileAnchorLinks — evasion table
// ---------------------------------------------------------------------------

Deno.test("crossFileAnchorLinks - catches every link shape it must (Issue #3337)", () => {
  const markdown = [
    /* 1 */ "See [docs](guide.md#setup) for details.",
    /* 2 */ 'See [docs](guide.md#setup "Setup guide") for details.',
    /* 3 */ "See [angle](<guide.md#setup>) for details.",
    /* 4 */ "[ref]: guide.md#setup",
    /* 5 */ "See [parent](../OTHER.md#frag-one) for details.",
    /* 6 */ "  - [item](nested/page.md#deep-anchor)",
    /* 7 */ "Two: [a](a.md#one) and [b](b.md#two) on one line.",
    /* 8 */ "See [emoji](weird.md#%EF%B8%8F-title) for details.",
  ].join("\n");

  const links = crossFileAnchorLinks(markdown);

  assertEquals(
    links.find((l) => l.line === 1),
    { line: 1, target: "guide.md", fragment: "setup" },
  );
  assertEquals(
    links.find((l) => l.line === 2),
    { line: 2, target: "guide.md", fragment: "setup" },
  );
  assertEquals(
    links.find((l) => l.line === 3),
    { line: 3, target: "guide.md", fragment: "setup" },
  );
  assertEquals(
    links.find((l) => l.line === 4),
    { line: 4, target: "guide.md", fragment: "setup" },
  );
  assertEquals(
    links.find((l) => l.line === 5),
    { line: 5, target: "../OTHER.md", fragment: "frag-one" },
  );
  assertEquals(
    links.find((l) => l.line === 6),
    { line: 6, target: "nested/page.md", fragment: "deep-anchor" },
  );
  const line7 = links.filter((l) => l.line === 7);
  assertEquals(line7.length, 2);
  assert(line7.some((l) => l.target === "a.md" && l.fragment === "one"));
  assert(line7.some((l) => l.target === "b.md" && l.fragment === "two"));
  assertEquals(
    links.find((l) => l.line === 8),
    { line: 8, target: "weird.md", fragment: "%EF%B8%8F-title" },
  );

  assertEquals(links.length, 9);
});

Deno.test("crossFileAnchorLinks - skips everything it must not report (Issue #3337)", () => {
  const markdown = [
    /*  1 */ "```md",
    /*  2 */ "[fenced](inside.md#frag)",
    /*  3 */ "```",
    /*  4 */ "~~~md",
    /*  5 */ "[tilde-fenced](inside.md#frag)",
    /*  6 */ "~~~",
    /*  7 */ "Inline code: `[not a link](code.md#frag)` stays code.",
    /*  8 */ "Double-backtick: ``[also code](code.md#frag)`` stays code.",
    /*  9 */ "See [remote](https://example.com/doc.md#frag) online.",
    /* 10 */ "See [no-frag](guide.md) without a fragment.",
    /* 11 */ "See [same-file](#local-frag) in this document.",
  ].join("\n");

  const links = crossFileAnchorLinks(markdown);
  assertEquals(links, []);
});

// ---------------------------------------------------------------------------
// 1b. crossFileAnchorLinks — soft-wrapped link text (Issue #4870)
// ---------------------------------------------------------------------------

Deno.test("crossFileAnchorLinks - finds a link whose text wraps over two lines (Issue #4870)", () => {
  const markdown = [
    "Intro line.",
    "See [the setup",
    "guide](guide.md#setup) for details.",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 2, target: "guide.md", fragment: "setup" },
  ]);
});

Deno.test("crossFileAnchorLinks - finds a link whose text wraps over three lines (Issue #4870)", () => {
  const markdown = [
    "Read [the very long",
    "setup guide that",
    "wraps](setup.md#install) now.",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 1, target: "setup.md", fragment: "install" },
  ]);
});

Deno.test("crossFileAnchorLinks - reports a wrapped link in a list item continuation on the item's line (Issue #4870)", () => {
  const markdown = [
    "Steps:",
    "- see [the",
    "  guide](guide.md#setup)",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 2, target: "guide.md", fragment: "setup" },
  ]);
});

Deno.test("crossFileAnchorLinks - finds a wrapped angle-bracket link with a title (Issue #4870)", () => {
  const markdown = [
    "See [the setup",
    'guide](<guide.md#setup> "Setup guide") now.',
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 1, target: "guide.md", fragment: "setup" },
  ]);
});

Deno.test("crossFileAnchorLinks - finds a wrapped link that is the second link in a paragraph (Issue #4870)", () => {
  const markdown = [
    "Plain [one](one.md#first) link.",
    "Then [the",
    "second](two.md#second) wraps.",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 1, target: "one.md", fragment: "first" },
    { line: 2, target: "two.md", fragment: "second" },
  ]);
});

Deno.test("crossFileAnchorLinks - reports a link at column 0 of a continuation line on that line (Issue #4870)", () => {
  const markdown = [
    "For details see",
    "[the guide](x.md#f).",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 2, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - reports a wrapped link whose opening bracket ends a non-first line on that line (Issue #4870)", () => {
  const markdown = [
    "Intro words here.",
    "And see [",
    "the guide](x.md#f).",
  ].join("\n");

  assertEquals(crossFileAnchorLinks(markdown), [
    { line: 2, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins a paragraph across a blank line (Issue #4870)", () => {
  const separated = ["Intro [text", "", "more](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(separated), []);

  // Positive control: with the blank line removed the same link is reported.
  const joined = ["Intro [text", "more](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(joined), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins a paragraph across a fenced block (Issue #4870)", () => {
  const fenced = ["[text", "```md", "code", "```", "more](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(fenced), []);

  // Positive control: with the fence removed the same two lines are reported.
  const adjacent = ["[text", "more](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(adjacent), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins two list items (Issue #4870)", () => {
  const items = ["- [a", "- b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(items), []);

  // Positive control: the two lines joined with one space, which is what
  // removing the line break between the items would give.
  const joined = "- [a - b](x.md#f)";
  assertEquals(crossFileAnchorLinks(joined), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins a heading to the line after it (Issue #4870)", () => {
  const heading = ["# [a", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(heading), []);

  // Positive control: the same two lines joined with one space is one heading
  // line, which is scanned on its own and reported.
  const joined = "# [a b](x.md#f)";
  assertEquals(crossFileAnchorLinks(joined), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins table rows (Issue #4870)", () => {
  const rows = ["| [a |", "| b](x.md#f) |"].join("\n");
  assertEquals(crossFileAnchorLinks(rows), []);

  // Positive control: the two rows joined with one space.
  const joined = "| [a | | b](x.md#f) |";
  assertEquals(crossFileAnchorLinks(joined), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins a paragraph across a reference definition (Issue #4870)", () => {
  const separated = ["[a", "[r]: y.md#r", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(separated), [
    { line: 2, target: "y.md", fragment: "r" },
  ]);

  // Positive control: without the definition the same two lines are reported.
  const adjacent = ["[a", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(adjacent), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - never joins a paragraph across a heading or table row (Issue #4870)", () => {
  const heading = ["[a", "# Title", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(heading), []);

  const row = ["[a", "| cell |", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(row), []);

  // Positive control: without the separating line the same two lines are
  // reported.
  const adjacent = ["[a", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(adjacent), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - skips a wrapped link inside a code span spanning two lines (Issue #4870)", () => {
  const wrappedCode = ["Use `[a", "b](x.md#f)` to link."].join("\n");
  assertEquals(crossFileAnchorLinks(wrappedCode), []);

  // Positive control: without the closing backtick the span does not close,
  // so the same wrapped link is a real link and is reported.
  const unclosed = ["Use `[a", "b](x.md#f) to link."].join("\n");
  assertEquals(crossFileAnchorLinks(unclosed), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

Deno.test("crossFileAnchorLinks - skips a wrapped link inside a fenced block (Issue #4870)", () => {
  const fenced = ["```md", "[a", "b](x.md#f)", "```"].join("\n");
  assertEquals(crossFileAnchorLinks(fenced), []);

  // Positive control: the same two lines outside the fence are reported.
  const outside = ["[a", "b](x.md#f)"].join("\n");
  assertEquals(crossFileAnchorLinks(outside), [
    { line: 1, target: "x.md", fragment: "f" },
  ]);
});

// ---------------------------------------------------------------------------
// 2. decodeFragment
// ---------------------------------------------------------------------------

Deno.test("decodeFragment - decodes well-formed percent-escapes", () => {
  assertEquals(decodeFragment("%EF%B8%8F-x"), "️-x");
});

Deno.test("decodeFragment - returns null for a malformed percent-escape", () => {
  assertEquals(decodeFragment("%E0%A4%A"), null);
});

// ---------------------------------------------------------------------------
// 3. Hostile-input growth check
// ---------------------------------------------------------------------------

Deno.test("crossFileAnchorLinks - stays linear against a hostile link-shaped input (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on repeated unterminated link-opens",
    (chars) => "](a".repeat(Math.ceil(chars / 3)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against INLINE_LINK link-text brackets (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on repeated unterminated link-text opens",
    (chars) => "[".repeat(chars),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against INLINE_LINK bare-destination opens (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on repeated unterminated bare destinations",
    (chars) => "[](".repeat(Math.ceil(chars / 3)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against INLINE_LINK angle-destination opens (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on repeated unterminated angle destinations",
    (chars) => "[](<".repeat(Math.ceil(chars / 4)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against blankCodeSpans single-backtick runs (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on a single backtick followed by a long run",
    (chars) => "`" + "x".repeat(chars),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against blankCodeSpans repeated double-backtick spans (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on repeated double-backtick code spans",
    (chars) => "``x`".repeat(Math.ceil(chars / 4)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against REF_DEF unterminated label opens (Issue #3337)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on a single unterminated reference-definition label",
    (chars) => "[" + "a".repeat(chars),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against many link-text opens in one soft-wrapped paragraph (Issue #4870)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on many lines each opening a link, with no blank line",
    (chars) => "[a\n".repeat(Math.ceil(chars / 3)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

Deno.test("crossFileAnchorLinks - stays linear against many lines each holding an unmatched backtick (Issue #4870)", () => {
  assertLinearGrowth(
    "crossFileAnchorLinks on many lines each holding one backtick, joined into one paragraph",
    (chars) => "x `y\n".repeat(Math.ceil(chars / 5)),
    (input) => crossFileAnchorLinks(input),
    { baseChars: 20_000 },
  );
});

// ---------------------------------------------------------------------------
// 4. Repo-wide sweep
// ---------------------------------------------------------------------------

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const REPO_ROOT_PATH = decodeURIComponent(new URL(REPO_ROOT).pathname).replace(
  /\/$/,
  "",
);

/** Skip VCS internals, vendored deps, and the historical docs archive. */
function shouldSkipDir(relativePath: string): boolean {
  if (relativePath === ".git" || relativePath === "node_modules") {
    return true;
  }
  return relativePath === "docs/archive" ||
    relativePath.startsWith("docs/archive/");
}

/** Recursively yield every `.md` file's path, relative to the repo root. */
async function* markdownFiles(
  root: string,
  relativeDir = "",
): AsyncGenerator<string> {
  const absoluteDir = relativeDir === "" ? root : `${root}/${relativeDir}`;
  for await (const entry of Deno.readDir(absoluteDir)) {
    const relative = relativeDir === ""
      ? entry.name
      : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory) {
      if (shouldSkipDir(relative)) continue;
      yield* markdownFiles(root, relative);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield relative;
    }
  }
}

/**
 * Resolve a link's target path relative to the file that contains it. A
 * leading `/` is repo-root-relative; everything else is relative to the
 * source file's directory.
 */
function resolveTarget(sourceRelative: string, target: string): string {
  const decoded = decodeURIComponent(target);
  if (decoded.startsWith("/")) {
    return decoded.slice(1);
  }
  const sourceDir = sourceRelative.includes("/")
    ? sourceRelative.slice(0, sourceRelative.lastIndexOf("/"))
    : "";
  const combined = sourceDir === "" ? decoded : `${sourceDir}/${decoded}`;

  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

Deno.test("every cross-file #fragment link resolves to a heading in its target (Issue #3337)", async () => {
  const offenders: string[] = [];
  let linkCount = 0;

  for await (const sourceRelative of markdownFiles(REPO_ROOT_PATH)) {
    const body = await Deno.readTextFile(`${REPO_ROOT_PATH}/${sourceRelative}`);
    const links = crossFileAnchorLinks(body);

    for (const link of links) {
      linkCount++;
      const targetRelative = resolveTarget(sourceRelative, link.target);
      const targetPath = `${REPO_ROOT_PATH}/${targetRelative}`;

      let targetBody: string;
      try {
        targetBody = await Deno.readTextFile(targetPath);
      } catch {
        offenders.push(
          `${sourceRelative}:${link.line} ${link.target}#${link.fragment} (MISSING)`,
        );
        continue;
      }

      const decoded = decodeFragment(link.fragment);
      if (decoded === null) {
        offenders.push(
          `${sourceRelative}:${link.line} ${link.target}#${link.fragment} (UNDECODABLE)`,
        );
        continue;
      }

      const anchors = anchorSet(targetBody);
      if (!anchors.has(decoded)) {
        offenders.push(
          `${sourceRelative}:${link.line} ${link.target}#${link.fragment} (no heading produces this anchor)`,
        );
      }
    }
  }

  assertGreater(
    linkCount,
    300,
    `expected to check more than 300 cross-file anchor links, only found ${linkCount} — the extractor may be broken`,
  );
  assertEquals(
    offenders,
    [],
    `broken cross-file anchor links:\n${offenders.join("\n")}`,
  );
});
