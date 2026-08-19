/**
 * Tests for the broader Markdown wrap behaviour added by Issue #1600.
 *
 * `inject_page_metadata.rb` invokes `wrap_pr_summary_raw.rb`'s `wrap_file`
 * helper against every published Markdown file — `AGENTS.md`, `README.md`,
 * `SECURITY.md`, `index.md`, and the recursive `docs` Markdown glob — so
 * that Liquid-looking tokens in prose (e.g. `{% if x %}`, `{{ page.url }}`)
 * do not break the GitHub Pages build.
 *
 * The wrap must:
 *   - Apply to AGENTS.md / README.md / SECURITY.md / docs Markdown files.
 *   - Skip files that already contain inline `{% raw %}` markers (Liquid
 *     does not support nested raw blocks).
 *   - Be idempotent — re-running produces identical output.
 *   - Preserve any front-matter outside the wrap.
 *
 * Issue #1600 (extends Issue #1575).
 *
 * Australian English throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** Repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

/**
 * Stage a fixture directory with both Ruby scripts and the directory layout
 * `inject_page_metadata.rb` expects (root markdown plus `_data/` and
 * `docs/`).
 */
async function stageFixture(fixtureRoot: string): Promise<void> {
  await Deno.mkdir(`${fixtureRoot}/.github/scripts`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/_data`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/docs`, { recursive: true });

  await Deno.copyFile(
    `${repoRoot()}.github/scripts/inject_page_metadata.rb`,
    `${fixtureRoot}/.github/scripts/inject_page_metadata.rb`,
  );
  await Deno.copyFile(
    `${repoRoot()}.github/scripts/wrap_pr_summary_raw.rb`,
    `${fixtureRoot}/.github/scripts/wrap_pr_summary_raw.rb`,
  );
  await Deno.writeTextFile(`${fixtureRoot}/_data/page_titles.yml`, "{}\n");
}

/** Run inject_page_metadata.rb against the fixture. */
async function runInject(
  fixtureRoot: string,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command("ruby", {
    args: [`${fixtureRoot}/.github/scripts/inject_page_metadata.rb`],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/** Count occurrences of a literal substring. */
function countSubstring(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

Deno.test(
  "inject_page_metadata.rb wraps AGENTS.md body in {% raw %} block",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-agents-" });
    try {
      await stageFixture(fixtureRoot);
      // AGENTS.md-style content: Liquid-looking tokens inside Markdown code
      // spans. This is what currently breaks the Pages build.
      await Deno.writeTextFile(
        `${fixtureRoot}/AGENTS.md`,
        "# Agents\n\n" +
          "Use `{% if x %}` then `{% else %}` and `{{ page.url }}` " +
          "in code spans.\n",
      );
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(`${fixtureRoot}/AGENTS.md`);

      // Front-matter at the very top.
      assert(out.startsWith("---\n"), `expected front-matter; got:\n${out}`);
      // Wrap markers present.
      assertStringIncludes(out, "{% raw %}");
      assert(
        out.trimEnd().endsWith("{% endraw %}"),
        `expected file to end with {% endraw %}; got:\n${out}`,
      );
      // Original Liquid-looking content preserved literally.
      assertStringIncludes(out, "{% if x %}");
      assertStringIncludes(out, "{{ page.url }}");
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb wraps README.md and SECURITY.md bodies",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-readme-sec-" });
    try {
      await stageFixture(fixtureRoot);
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n\nHi.\n");
      await Deno.writeTextFile(
        `${fixtureRoot}/SECURITY.md`,
        "# Security\n\nReport.\n",
      );
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      for (const name of ["README.md", "SECURITY.md"]) {
        const out = await Deno.readTextFile(`${fixtureRoot}/${name}`);
        assertStringIncludes(out, "{% raw %}", `${name} not wrapped`);
        assert(
          out.trimEnd().endsWith("{% endraw %}"),
          `${name} did not end with {% endraw %}; got:\n${out}`,
        );
      }
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb wraps non-pr-summary docs/**/*.md files",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-docs-glob-" });
    try {
      await stageFixture(fixtureRoot);
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");

      // Non-pr-summary doc with Liquid-looking placeholder in prose.
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/OVERVIEW.md`,
        "# Overview\n\nThe `{{VERBOSITY_INSTRUCTIONS}}` placeholder.\n",
      );

      // Nested doc to confirm `**/*.md` glob.
      await Deno.mkdir(`${fixtureRoot}/docs/sub`, { recursive: true });
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/sub/NESTED.md`,
        "# Nested\n\nBody.\n",
      );

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const overview = await Deno.readTextFile(
        `${fixtureRoot}/docs/OVERVIEW.md`,
      );
      assertStringIncludes(overview, "{% raw %}");
      assertStringIncludes(overview, "{{VERBOSITY_INSTRUCTIONS}}");
      assert(overview.trimEnd().endsWith("{% endraw %}"));

      const nested = await Deno.readTextFile(
        `${fixtureRoot}/docs/sub/NESTED.md`,
      );
      assertStringIncludes(nested, "{% raw %}");
      assert(nested.trimEnd().endsWith("{% endraw %}"));
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb is idempotent — re-running does not double-wrap broader files",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({
      prefix: "wrap-idempotent-broad-",
    });
    try {
      await stageFixture(fixtureRoot);
      await Deno.writeTextFile(
        `${fixtureRoot}/AGENTS.md`,
        "# Agents\n\nBody with `{% if x %}`.\n",
      );
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/OVERVIEW.md`,
        "# Overview\n\nBody.\n",
      );

      const first = await runInject(fixtureRoot);
      assertEquals(first.code, 0, `ruby exited non-zero:\n${first.stderr}`);
      const afterFirstAgents = await Deno.readTextFile(
        `${fixtureRoot}/AGENTS.md`,
      );
      const afterFirstOverview = await Deno.readTextFile(
        `${fixtureRoot}/docs/OVERVIEW.md`,
      );

      const second = await runInject(fixtureRoot);
      assertEquals(second.code, 0, `ruby exited non-zero:\n${second.stderr}`);
      const afterSecondAgents = await Deno.readTextFile(
        `${fixtureRoot}/AGENTS.md`,
      );
      const afterSecondOverview = await Deno.readTextFile(
        `${fixtureRoot}/docs/OVERVIEW.md`,
      );

      assertEquals(
        afterSecondAgents,
        afterFirstAgents,
        "AGENTS.md must be byte-identical on second run",
      );
      assertEquals(
        afterSecondOverview,
        afterFirstOverview,
        "docs/OVERVIEW.md must be byte-identical on second run",
      );

      // Exactly one wrap pair per file.
      assertEquals(countSubstring(afterSecondAgents, "{% raw %}"), 1);
      assertEquals(countSubstring(afterSecondAgents, "{% endraw %}"), 1);
      assertEquals(countSubstring(afterSecondOverview, "{% raw %}"), 1);
      assertEquals(countSubstring(afterSecondOverview, "{% endraw %}"), 1);
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb skips published Markdown with pre-existing inline {% raw %} markers",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({
      prefix: "wrap-inline-broad-",
    });
    try {
      await stageFixture(fixtureRoot);
      // AGENTS.md with inline {% raw %} markers — must be left alone
      // because Liquid does not support nested raw blocks.
      const agentsBody =
        "# Agents\n\nMentions {% raw %}`{% if x %}`{% endraw %} inline.\n";
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, agentsBody);
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(`${fixtureRoot}/AGENTS.md`);

      // Front-matter still injected at the top.
      assert(out.startsWith("---\n"), `expected front-matter; got:\n${out}`);
      // Body unchanged after front-matter — no outer wrap added.
      assertStringIncludes(out, agentsBody);
      // Exactly the original two raw markers — not three (no extra wrap).
      assertEquals(countSubstring(out, "{% raw %}"), 1);
      assertEquals(countSubstring(out, "{% endraw %}"), 1);
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb wraps files without Liquid tokens (rendered output unchanged)",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-noliquid-" });
    try {
      await stageFixture(fixtureRoot);
      const original = "# Plain\n\nNo Liquid tokens at all.\n";
      await Deno.writeTextFile(`${fixtureRoot}/docs/PLAIN.md`, original);
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(`${fixtureRoot}/docs/PLAIN.md`);
      assertStringIncludes(out, "{% raw %}");
      assertStringIncludes(out, "# Plain");
      assertStringIncludes(out, "No Liquid tokens at all.");
      assert(out.trimEnd().endsWith("{% endraw %}"));
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "inject_page_metadata.rb still wraps docs/pr-summary-*.md (existing behaviour preserved)",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-prsummary-" });
    try {
      await stageFixture(fixtureRoot);
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# README\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/pr-summary-99992.md`,
        "## Summary\n\nBody with {% if x %} tag.\n",
      );

      const { code, stderr } = await runInject(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(
        `${fixtureRoot}/docs/pr-summary-99992.md`,
      );
      assert(out.startsWith("---\n"), `expected front-matter; got:\n${out}`);
      assertStringIncludes(out, "{% raw %}");
      assertStringIncludes(out, "{% if x %}");
      assert(out.trimEnd().endsWith("{% endraw %}"));
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);
