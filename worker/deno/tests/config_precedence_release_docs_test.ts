/**
 * Documentation-drift tests for Issue #1380 — the config-versus-environment
 * precedence flip (Issue #1032) shipped in release **1.4.0**, but the operator
 * manuals still labelled it "2.0.0" and the release note still carried an
 * "Unreleased" blockquote written before the milestone merged.
 *
 * The tests drive the real resolver (`resolveSetting`) to establish that the
 * behaviour the manuals describe is live, then assert the docs label it with a
 * release that actually exists — a version at or below
 * [`.release-floor`](../../../.release-floor) — and that every link into the
 * release note resolves to a heading that is really there. They assert against
 * the resolver's real output and the headings the file really has rather than
 * on prose wording, so a harmless reword never reddens the suite.
 *
 * Australian English spelling used throughout (behaviour, labelled).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveSetting } from "../lib/config_precedence.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);

/** Every doc that labels the shipped precedence behaviour with a release. */
const DOCS_LABELLING_THE_FLIP = [
  "README.md",
  "docs/RELEASE-NOTES.md",
  "docs/CONFIGURATION.md",
  "docs/SETUP.md",
  "docs/DEPLOYMENT.md",
  "docs/CONTAINER.md",
] as const;

function readRepoFile(relative: string): Promise<string> {
  return Deno.readTextFile(new URL(relative, REPO_ROOT));
}

/** The major of a semver string, or `null` when it is not a semver. */
function majorOf(raw: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The major the released series is on.
 *
 * `.release-floor` states the **lowest** version the next release tag may
 * take, so it is not an upper bound on the tags that exist — the series runs
 * past it on the automatic patch increment. Its major is the bound that does
 * hold: a release in the *next* major cannot exist until the floor moves to
 * it, so a document dating already-shipped behaviour to a higher major is
 * describing a release nobody can install.
 */
async function releasedMajor(): Promise<{ floor: string; major: number }> {
  const raw = await readRepoFile(".release-floor");
  const floor = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))[0] ?? "";
  const major = majorOf(floor);
  assert(major !== null, `.release-floor must state a semver, got "${floor}"`);
  return { floor, major };
}

/** GitHub's heading-anchor slug for a Markdown `##` heading. */
function anchorFor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/ /g, "-");
}

/** Every `##`/`###` heading in the release note, in file order. */
function headings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{2,3} /.test(line))
    .map((line) => line.replace(/^#{2,3} /, "").trim());
}

/**
 * The units a version label can belong to: one Markdown table row, or one
 * blank-line-separated paragraph. A table is not one paragraph — neighbouring
 * rows describe unrelated settings.
 */
function chunks(markdown: string): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(paragraph.join("\n"));
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    if (line.trim().length === 0) flush();
    else if (line.trimStart().startsWith("|")) {
      flush();
      out.push(line);
    } else paragraph.push(line);
  }
  flush();
  return out;
}

Deno.test("RELEASE-NOTES.md - the config-precedence note names a release that exists (Issue #1380)", async () => {
  // The premise: the flip is live in this tree, so the note describes shipped
  // behaviour and owes a release that an operator can actually install.
  const resolved = resolveSetting({
    configKey: "agent_provider",
    envVar: "VIBE_AGENT_PROVIDER",
    env: (name) => name === "VIBE_AGENT_PROVIDER" ? "codex" : undefined,
    configured: "claude",
    fallback: "claude",
    parse: (raw) => raw,
  });
  assertEquals(resolved.source, "config");

  const notes = await readRepoFile("docs/RELEASE-NOTES.md");
  const heading = headings(notes).find((h) =>
    h.includes("the config file wins over the environment")
  );
  assert(
    heading,
    "docs/RELEASE-NOTES.md must keep a section for the config-precedence change",
  );

  const stated = (heading.split("—")[0] ?? "").trim();
  const major = majorOf(stated);
  assert(
    major !== null,
    `the section heading must name a semver, got "${heading}"`,
  );
  const series = await releasedMajor();
  assert(
    major <= series.major,
    `the config-precedence change shipped already, so its release note must ` +
      `name a release that exists — "${heading}" is in a major above the ` +
      `series the floor (${series.floor}) is on`,
  );
});

Deno.test("RELEASE-NOTES.md - no section is still marked Unreleased (Issue #1380)", async () => {
  const notes = await readRepoFile("docs/RELEASE-NOTES.md");
  assert(
    !/^>\s*\*\*Unreleased\.\*\*/m.test(notes),
    "docs/RELEASE-NOTES.md records shipped releases; an Unreleased blockquote " +
      "means a milestone merged without the note being relabelled",
  );
});

Deno.test("docs - every link into RELEASE-NOTES.md resolves to a real heading (Issue #1380)", async () => {
  const notes = await readRepoFile("docs/RELEASE-NOTES.md");
  const anchors = new Set(headings(notes).map(anchorFor));
  assert(anchors.size > 0, "the release note must have headings to link to");

  for (const doc of DOCS_LABELLING_THE_FLIP) {
    const text = await readRepoFile(doc);
    for (const [, anchor] of text.matchAll(/RELEASE-NOTES\.md#([\w-]+)/g)) {
      assert(
        anchors.has(anchor ?? ""),
        `${doc} links to RELEASE-NOTES.md#${anchor}, which is not a heading ` +
          `in docs/RELEASE-NOTES.md`,
      );
    }
  }
});

Deno.test("docs - no manual dates the shipped precedence flip to an unreleased version (Issue #1380)", async () => {
  const series = await releasedMajor();
  // Only the paragraphs that talk about the precedence flip: they either cite
  // Issue #1032 or link/point at the release note section by name.
  const aboutTheFlip =
    /#?1032|the config file wins over the environment|the-config-file-wins-over-the-environment/;

  for (const doc of DOCS_LABELLING_THE_FLIP) {
    const text = await readRepoFile(doc);
    for (const paragraph of chunks(text)) {
      if (!aboutTheFlip.test(paragraph)) continue;
      for (const [stated] of paragraph.matchAll(/\d+\.\d+\.\d+/g)) {
        const major = majorOf(stated);
        if (major === null) continue;
        assert(
          major <= series.major,
          `${doc} dates the shipped config-precedence flip to ${stated}, a ` +
            `release that cannot exist — the series is still on ` +
            `${series.major}.x (floor ${series.floor})`,
        );
      }
    }
  }
});
