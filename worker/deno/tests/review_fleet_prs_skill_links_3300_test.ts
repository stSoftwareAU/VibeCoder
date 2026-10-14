/**
 * Guards the review-fleet-prs skill's split into `references/` (Issue #3300).
 *
 * `SKILL.md` keeps its core loop and links out to `references/`
 * ({running-unattended,edge-cases,notes}.md from that split, and
 * `trigger-queries.md` since Issue #3426), and `docs/CONFIGURATION.md`'s
 * deep link into the skill moved with it. A split like that breaks easily:
 * a relative `../` count that no longer matches the new file's depth, a
 * heading anchor that moved to a different file, or a `references/` file
 * nobody links from `SKILL.md` any more. {@link skillLinkProblems} checks:
 *
 *   a. every relative Markdown link in `SKILL.md` resolves, and resolves its
 *      `#fragment` (if any) against the target file's real headings;
 *   b. the same for every file under `references/`;
 *   c. every link in `docs/CONFIGURATION.md` that points into the skill
 *      directory resolves, fragment included, and at least one such link
 *      exists (otherwise the check would be vacuous);
 *   d. every file under `references/` is linked from `SKILL.md`.
 *
 * Each problem string names the rule it violates so a failing assertion says
 * exactly what broke, not just that something did.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { anchorSet } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const REPO_ROOT_PATH = decodeURIComponent(new URL(REPO_ROOT).pathname).replace(
  /\/$/,
  "",
);

const SKILL_DIR = ".claude/skills/review-fleet-prs";

/** A Markdown inline link target: `[text](target)`. */
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** Strip fenced code blocks so links inside them are never checked. */
function stripFences(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^\s*(`|~)\1\1/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").repeat(3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      out.push("");
      continue;
    }
    out.push(fence === null ? rawLine : "");
  }
  return out.join("\n");
}

interface ParsedLink {
  target: string;
  fragment: string | null;
}

/** Extract relative links (skipping external/pure-fragment ones) from `markdown`. */
function relativeLinks(markdown: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const match of stripFences(markdown).matchAll(LINK)) {
    const raw = match[1]?.trim() ?? "";
    if (!raw || raw.startsWith("#")) continue;
    if (/^(https?|mailto):/i.test(raw)) continue;
    const hashIndex = raw.indexOf("#");
    const target = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
    const fragment = hashIndex < 0 ? null : raw.slice(hashIndex + 1);
    if (!target) continue;
    links.push({ target, fragment });
  }
  return links;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Resolve `target` (as written in `fromFile`) to an absolute filesystem path. */
function resolveTarget(fromFile: string, target: string): string {
  const base = new URL(`file://${fromFile}`);
  return decodeURIComponent(new URL(target, base).pathname);
}

/**
 * Check one parsed link from `fromFile`: it must resolve to an existing
 * file, and if it carries a `#fragment` into a `.md` file, that fragment
 * must be a real heading anchor. Appends problems to `problems`, reporting
 * paths relative to `root`.
 */
async function checkLink(
  root: string,
  fromFile: string,
  link: ParsedLink,
  problems: string[],
): Promise<void> {
  const rel = fromFile.slice(root.length + 1);
  const resolved = resolveTarget(fromFile, link.target);
  if (!(await exists(resolved))) {
    problems.push(`missing link target: ${rel} -> ${link.target}`);
    return;
  }
  if (link.fragment && resolved.endsWith(".md")) {
    const targetBody = await Deno.readTextFile(resolved);
    const anchors = anchorSet(targetBody);
    const decodedFragment = decodeURIComponent(link.fragment);
    if (!anchors.has(decodedFragment)) {
      const targetRel = resolved.slice(root.length + 1);
      problems.push(
        `missing anchor: ${rel} -> ${targetRel}#${link.fragment}`,
      );
    }
  }
}

/**
 * Check every relative link in `absFile` (read relative to `root`, reported
 * relative to `root`) resolves to an existing file, with any `.md` fragment
 * resolving to a real heading anchor. Appends problems to `problems`.
 */
async function checkLinksInFile(
  root: string,
  absFile: string,
  problems: string[],
): Promise<void> {
  let body: string;
  try {
    body = await Deno.readTextFile(absFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const rel = absFile.slice(root.length + 1);
    problems.push(`missing file: ${rel}`);
    return;
  }
  for (const link of relativeLinks(body)) {
    await checkLink(root, absFile, link, problems);
  }
}

/** Recursively yield every `.md` file under `dir`. */
async function* markdownFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* markdownFiles(full);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

/**
 * Check the review-fleet-prs skill's Markdown links for a repo rooted at
 * `root`. Returns human-readable problem strings; an empty array means the
 * skill's links and the references/SKILL.md split are consistent.
 */
async function skillLinkProblems(root: string): Promise<string[]> {
  const problems: string[] = [];
  const skillDir = `${root}/${SKILL_DIR}`;
  const skillMd = `${skillDir}/SKILL.md`;
  const referencesDir = `${skillDir}/references`;
  const configurationMd = `${root}/docs/CONFIGURATION.md`;

  // a. SKILL.md's own links.
  await checkLinksInFile(root, skillMd, problems);

  // b. Every file under references/.
  const referenceFiles: string[] = [];
  for await (const file of markdownFiles(referencesDir)) {
    referenceFiles.push(file);
    await checkLinksInFile(root, file, problems);
  }
  if (referenceFiles.length === 0) {
    problems.push(`no reference files found under ${SKILL_DIR}/references/`);
  }

  // c. docs/CONFIGURATION.md links that point into the skill directory.
  let configBody: string;
  try {
    configBody = await Deno.readTextFile(configurationMd);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    configBody = "";
    problems.push(`missing file: docs/CONFIGURATION.md`);
  }
  let skillLinksInConfiguration = 0;
  for (const link of relativeLinks(configBody)) {
    const resolved = resolveTarget(configurationMd, link.target);
    if (!resolved.startsWith(`${skillDir}/`)) continue;
    skillLinksInConfiguration++;
    await checkLink(root, configurationMd, link, problems);
  }
  if (skillLinksInConfiguration === 0) {
    problems.push(
      "no link from docs/CONFIGURATION.md into .claude/skills/review-fleet-prs/ found",
    );
  }

  // d. Every references/ file is linked from SKILL.md. SKILL.md's own
  // absence is already reported by (a), so skip this check then rather
  // than reporting every reference file as unlinked too.
  if (referenceFiles.length > 0) {
    let skillBody: string | undefined;
    try {
      skillBody = await Deno.readTextFile(skillMd);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (skillBody !== undefined) {
      const linkedTargets = new Set(
        relativeLinks(skillBody).map((link) =>
          resolveTarget(skillMd, link.target)
        ),
      );
      for (const file of referenceFiles) {
        if (!linkedTargets.has(file)) {
          const rel = file.slice(root.length + 1);
          problems.push(`unlinked references file: ${rel}`);
        }
      }
    }
  }

  return problems;
}

Deno.test("skillLinkProblems - real repo", async () => {
  assertEquals(await skillLinkProblems(REPO_ROOT_PATH), []);
});

/** Write `files` (path relative to `root` -> content) under `root`. */
async function writeFixture(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = `${root}/${relPath}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(full, content);
  }
}

const CLEAN_FIXTURE: Record<string, string> = {
  [`${SKILL_DIR}/SKILL.md`]:
    "# Skill\n\nSee [a](references/a.md) and [b](references/b.md#some-heading).\n",
  [`${SKILL_DIR}/references/a.md`]: "# A\n\nNothing here.\n",
  [`${SKILL_DIR}/references/b.md`]: "# B\n\n## Some heading\n\nBody.\n",
  "docs/CONFIGURATION.md":
    "# Configuration\n\nSee [b](../.claude/skills/review-fleet-prs/references/b.md#some-heading).\n",
};

async function withFixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await writeFixture(root, files);
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("skillLinkProblems - clean fixture is clean", async () => {
  await withFixture(CLEAN_FIXTURE, async (root) => {
    assertEquals(await skillLinkProblems(root), []);
  });
});

Deno.test("skillLinkProblems - unlinked references file", async () => {
  await withFixture(
    {
      ...CLEAN_FIXTURE,
      [`${SKILL_DIR}/references/c.md`]: "# C\n\nUnlinked.\n",
    },
    async (root) => {
      const problems = await skillLinkProblems(root);
      assertEquals(problems.length, 1);
      assertMatch(problems[0]!, /^unlinked references file/);
      assertMatch(problems[0]!, /c\.md$/);
    },
  );
});

Deno.test("skillLinkProblems - missing link target", async () => {
  await withFixture(
    {
      ...CLEAN_FIXTURE,
      [`${SKILL_DIR}/SKILL.md`]:
        "# Skill\n\nSee [a](references/a.md), [b](references/b.md#some-heading) " +
        "and [missing](references/missing.md).\n",
    },
    async (root) => {
      const problems = await skillLinkProblems(root);
      assertEquals(problems.length, 1);
      assertMatch(problems[0]!, /^missing link target/);
    },
  );
});

Deno.test("skillLinkProblems - missing CONFIGURATION anchor", async () => {
  await withFixture(
    {
      ...CLEAN_FIXTURE,
      "docs/CONFIGURATION.md":
        "# Configuration\n\nSee [b](../.claude/skills/review-fleet-prs/references/b.md#gone).\n",
    },
    async (root) => {
      const problems = await skillLinkProblems(root);
      assertEquals(problems.length, 1);
      assertMatch(problems[0]!, /^missing anchor/);
      assertMatch(problems[0]!, /CONFIGURATION\.md/);
    },
  );
});

Deno.test("skillLinkProblems - no reference files", async () => {
  // Drop both reference files, give SKILL.md no links, and point
  // CONFIGURATION.md straight at SKILL.md so that check stays clean.
  const {
    [`${SKILL_DIR}/references/a.md`]: _a,
    [`${SKILL_DIR}/references/b.md`]: _b,
    ...rest
  } = CLEAN_FIXTURE;
  await withFixture(
    {
      ...rest,
      [`${SKILL_DIR}/SKILL.md`]: "# Skill\n\nNo links.\n",
      "docs/CONFIGURATION.md":
        "# Configuration\n\nSee [s](../.claude/skills/review-fleet-prs/SKILL.md).\n",
    },
    async (root) => {
      const problems = await skillLinkProblems(root);
      assertEquals(problems.length, 1);
      assertMatch(problems[0]!, /^no reference files found/);
    },
  );
});

Deno.test("skillLinkProblems - CONFIGURATION has no skill link", async () => {
  await withFixture(
    {
      ...CLEAN_FIXTURE,
      "docs/CONFIGURATION.md": "# Configuration\n\nNo skill link.\n",
    },
    async (root) => {
      const problems = await skillLinkProblems(root);
      assertEquals(problems.length, 1);
      assertMatch(problems[0]!, /^no link from docs\/CONFIGURATION\.md/);
    },
  );
});

Deno.test("skillLinkProblems - missing SKILL.md", async () => {
  // Drop SKILL.md itself; CONFIGURATION.md still links into references/b.md,
  // so the only expected problem is the missing SKILL.md file.
  const { [`${SKILL_DIR}/SKILL.md`]: _skillMd, ...rest } = CLEAN_FIXTURE;
  await withFixture(rest, async (root) => {
    const problems = await skillLinkProblems(root);
    assertEquals(problems.length, 1);
    assertMatch(problems[0]!, /^missing file: .*SKILL\.md$/);
  });
});

Deno.test("skillLinkProblems - missing CONFIGURATION.md", async () => {
  // Drop docs/CONFIGURATION.md itself; the only expected problem is the
  // missing CONFIGURATION.md file.
  const { "docs/CONFIGURATION.md": _configurationMd, ...rest } = CLEAN_FIXTURE;
  await withFixture(rest, async (root) => {
    const problems = await skillLinkProblems(root);
    assertEquals(
      problems.filter((p) => p === "missing file: docs/CONFIGURATION.md")
        .length,
      1,
    );
  });
});
