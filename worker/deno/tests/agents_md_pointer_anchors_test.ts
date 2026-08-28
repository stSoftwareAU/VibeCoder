/**
 * Regression tests for — broken `AGENTS.md#<section>` deep links.
 *
 * When `AGENTS.md` was reduced to a thin pointer it kept only two
 * headings, but ~20 internal links still pointed at its old subsection anchors
 * (`#worker-label-policy`, `#commit-safety`, `#idle-task-framework`, …). Every
 * such link now resolves to nothing. These tests:
 *
 *   1. Assert no Markdown file (outside the historical `docs/archive/` PR
 *      summaries) still contains an `AGENTS.md#<anchor>` deep link.
 *   2. Assert each repointed link resolves to a real heading in the doc that
 *      now owns that content.
 *
 * They fail against the pre-fix docs and pass once the anchors are corrected.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { anchorSet } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const REPO_ROOT_PATH = decodeURIComponent(new URL(REPO_ROOT).pathname);

function repoPath(relative: string): URL {
  return new URL(relative, REPO_ROOT);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

/** Skip historical archives, vendored deps, and VCS internals. */
const SKIP_DIRS = new Set(["node_modules", ".git", "archive"]);

/** Recursively yield every `.md` file under `dir`, skipping {@link SKIP_DIRS}. */
async function* markdownFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* markdownFiles(full);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

/** Any Markdown link target that dereferences an AGENTS.md subsection anchor. */
const AGENTS_DEEP_LINK = /AGENTS\.md#[\w-]+/g;

Deno.test("no Markdown file retains an AGENTS.md#section deep link", async () => {
  const offenders: string[] = [];
  for await (const path of markdownFiles(REPO_ROOT_PATH.replace(/\/$/, ""))) {
    const body = await Deno.readTextFile(path);
    const matches = body.match(AGENTS_DEEP_LINK);
    if (matches) {
      const rel = path.slice(REPO_ROOT_PATH.length);
      offenders.push(`${rel}: ${[...new Set(matches)].join(", ")}`);
    }
  }
  assertEquals(
    offenders,
    [],
    `AGENTS.md is a thin pointer — these deep links are dead:\n` +
      offenders.join("\n"),
  );
});

/**
 * Each repointed reference: the referencing file, the exact `target#fragment`
 * substring it must now contain, the target doc, and the fragment that must
 * resolve against that doc's headings.
 */
const REPOINTED: Array<{
  source: string;
  link: string;
  target: string;
  fragment: string;
}> = [
  // #worker-label-policy → README Supported Labels.
  {
    source: "DESIGN-PRINCIPLES.md",
    link: "README.md#-supported-labels",
    target: "README.md",
    fragment: "-supported-labels",
  },
  {
    source: "docs/workflows/planning-and-questions.md",
    link: "../../README.md#-supported-labels",
    target: "README.md",
    fragment: "-supported-labels",
  },
  {
    source: "docs/workflows/README.md",
    link: "../../README.md#-supported-labels",
    target: "README.md",
    fragment: "-supported-labels",
  },
  {
    source: "docs/SUPPLY-CHAIN-TRIAGE.md",
    link: "../README.md#-supported-labels",
    target: "README.md",
    fragment: "-supported-labels",
  },
  // #commit-safety + #test-driven-development-tdd → CODING-STANDARDS.md.
  {
    source: "CONTRIBUTING.md",
    link: "CODING-STANDARDS.md#commit-safety--never-commit-hidden-files",
    target: "CODING-STANDARDS.md",
    fragment: "commit-safety--never-commit-hidden-files",
  },
  {
    source: "CONTRIBUTING.md",
    link: "CODING-STANDARDS.md#test-driven-development-tdd",
    target: "CODING-STANDARDS.md",
    fragment: "test-driven-development-tdd",
  },
  // #prompt-template-versioning-issue-235 → CODING-STANDARDS.md.
  {
    source: "docs/PROMPTS.md",
    link: "../CODING-STANDARDS.md#prompt-template-versioning",
    target: "CODING-STANDARDS.md",
    fragment: "prompt-template-versioning",
  },
  // #idle-task-framework → DESIGN-PRINCIPLES.md.
  {
    source: "docs/IDLE-TASK-FRAMEWORK.md",
    link: "../DESIGN-PRINCIPLES.md#idle-task-framework",
    target: "DESIGN-PRINCIPLES.md",
    fragment: "idle-task-framework",
  },
  // #branch-protection-configured-by-setup → MERGE.md Layer 1 (self-link).
  // Retitled to "ruleset" when classic branch protection was retired.
  {
    source: "docs/MERGE.md",
    link: "#layer-1--the-github-ruleset-wall",
    target: "docs/MERGE.md",
    fragment: "layer-1--the-github-ruleset-wall",
  },
  // docs/USAGE.md TOC self-link → current archive-path heading slug.
  {
    source: "docs/USAGE.md",
    link: "#-pr-summary-file-docsarchivepr-summariespr-summary-issuemd",
    target: "docs/USAGE.md",
    fragment: "-pr-summary-file-docsarchivepr-summariespr-summary-issuemd",
  },
];

Deno.test("repointed anchors - every fragment resolves to a real heading", async () => {
  for (const ref of REPOINTED) {
    const anchors = anchorSet(await read(ref.target));
    assert(
      anchors.has(ref.fragment),
      `${ref.target} has no heading with anchor #${ref.fragment} ` +
        `(referenced from ${ref.source})`,
    );
  }
});
