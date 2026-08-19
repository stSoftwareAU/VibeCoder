/**
 * Tests for .github/scripts/wrap_pr_summary_raw.rb — verifies that every
 * `docs/pr-summary-*.md` file is wrapped in a `{% raw %} ... {% endraw %}`
 * block before `jekyll build` runs, immunising the Pages workflow against
 * Liquid-looking syntax in PR summary prose. Issue #1575.
 *
 * The wrap must:
 *   - Skip files already wrapped (idempotent).
 *   - Preserve any leading front-matter (`---` block) outside the wrap.
 *   - Wrap the body in `{% raw %}\n ... \n{% endraw %}`.
 *
 * The script is also called from inject_page_metadata.rb so the workflow
 * YAML stays unchanged.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
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
 * Stage a fixture directory with the wrap script and a docs/ folder so the
 * Ruby script can be invoked relative to the fixture root.
 */
async function stageFixture(fixtureRoot: string): Promise<void> {
  await Deno.mkdir(`${fixtureRoot}/.github/scripts`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/docs`, { recursive: true });

  const scriptSrc = `${repoRoot()}.github/scripts/wrap_pr_summary_raw.rb`;
  const scriptDst = `${fixtureRoot}/.github/scripts/wrap_pr_summary_raw.rb`;
  await Deno.copyFile(scriptSrc, scriptDst);
}

/** Run the wrap script against the fixture. */
async function runScript(
  fixtureRoot: string,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command("ruby", {
    args: [`${fixtureRoot}/.github/scripts/wrap_pr_summary_raw.rb`],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("wrap_pr_summary_raw.rb wraps a plain pr-summary in {% raw %}", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-plain-" });
  try {
    await stageFixture(fixtureRoot);

    const body = "## Summary\n\nMentions {% if foo %} and {% else %} tags.\n";
    await Deno.writeTextFile(
      `${fixtureRoot}/docs/pr-summary-99999.md`,
      body,
    );

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const out = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99999.md`,
    );

    assert(
      out.startsWith("{% raw %}\n"),
      `expected file to start with {% raw %}\\n; got:\n${out}`,
    );
    assert(
      out.trimEnd().endsWith("{% endraw %}"),
      `expected file to end with {% endraw %}; got:\n${out}`,
    );
    assertStringIncludes(out, "## Summary");
    assertStringIncludes(out, "{% if foo %}");
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("wrap_pr_summary_raw.rb is idempotent — re-running does not double-wrap", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-idempotent-" });
  try {
    await stageFixture(fixtureRoot);

    const body = "## Summary\n\nBody with {% if x %} tag.\n";
    await Deno.writeTextFile(
      `${fixtureRoot}/docs/pr-summary-99998.md`,
      body,
    );

    const first = await runScript(fixtureRoot);
    assertEquals(first.code, 0, `ruby exited non-zero:\n${first.stderr}`);
    const afterFirst = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99998.md`,
    );

    const second = await runScript(fixtureRoot);
    assertEquals(second.code, 0, `ruby exited non-zero:\n${second.stderr}`);
    const afterSecond = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99998.md`,
    );

    assertEquals(
      afterSecond,
      afterFirst,
      `re-running should produce identical output; got difference:\n` +
        `--- first ---\n${afterFirst}\n--- second ---\n${afterSecond}`,
    );

    // Exactly one opening and one closing marker.
    const openCount = (afterSecond.match(/\{% raw %\}/g) || []).length;
    const closeCount = (afterSecond.match(/\{% endraw %\}/g) || []).length;
    assertEquals(
      openCount,
      1,
      `expected exactly 1 {% raw %}; got ${openCount}`,
    );
    assertEquals(
      closeCount,
      1,
      `expected exactly 1 {% endraw %}; got ${closeCount}`,
    );
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("wrap_pr_summary_raw.rb preserves front-matter outside the raw block", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-frontmatter-" });
  try {
    await stageFixture(fixtureRoot);

    const original =
      '---\nlayout: default\ntitle: "Vibe Coder: PR 99997"\n---\n\n' +
      "## Summary\n\nBody with {% if x %}.\n";
    await Deno.writeTextFile(
      `${fixtureRoot}/docs/pr-summary-99997.md`,
      original,
    );

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const out = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99997.md`,
    );

    // Front-matter remains at the very top, untouched.
    assert(
      out.startsWith("---\nlayout: default\ntitle:"),
      `expected front-matter preserved at top; got:\n${out}`,
    );

    // The {% raw %} marker must appear AFTER the closing `---` of the
    // front-matter, not before it.
    const fmEndIdx = out.indexOf("\n---\n", 4);
    assert(
      fmEndIdx > 0,
      `expected closing front-matter marker; got:\n${out}`,
    );
    const rawIdx = out.indexOf("{% raw %}");
    assert(
      rawIdx > fmEndIdx,
      `expected {% raw %} after front-matter close (rawIdx=${rawIdx}, ` +
        `fmEndIdx=${fmEndIdx}); got:\n${out}`,
    );

    assert(
      out.trimEnd().endsWith("{% endraw %}"),
      `expected file to end with {% endraw %}; got:\n${out}`,
    );
    assertStringIncludes(out, "{% if x %}");
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("wrap_pr_summary_raw.rb skips files that already contain a top-level {% raw %} wrap", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-already-" });
  try {
    await stageFixture(fixtureRoot);

    const original =
      "{% raw %}\n## Summary\n\nBody with literal {% if x %} tag.\n{% endraw %}\n";
    await Deno.writeTextFile(
      `${fixtureRoot}/docs/pr-summary-99996.md`,
      original,
    );

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const out = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99996.md`,
    );
    assertEquals(
      out,
      original,
      "file should be unchanged when already wrapped",
    );
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test(
  "wrap_pr_summary_raw.rb skips files with inline {% raw %} markers (no nested raw)",
  async () => {
    // Liquid does not support nested raw blocks: the first {% endraw %}
    // closes the outer one. Files that have been manually escaped with
    // inline raw markers (e.g. PR summary #1574) must therefore be left
    // alone — wrapping them would break the build.
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-inline-" });
    try {
      await stageFixture(fixtureRoot);

      const original =
        "## Summary\n\nMentions {% raw %}`{% if x %}`{% endraw %} inline.\n";
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/pr-summary-99993.md`,
        original,
      );

      const { code, stderr } = await runScript(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(
        `${fixtureRoot}/docs/pr-summary-99993.md`,
      );
      assertEquals(
        out,
        original,
        "files with inline {% raw %} markers must be left untouched",
      );
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test(
  "wrap_pr_summary_raw.rb wraps archived pr-summaries too (Issue #2173)",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-archive-" });
    try {
      await stageFixture(fixtureRoot);
      await Deno.mkdir(`${fixtureRoot}/docs/archive/pr-summaries`, {
        recursive: true,
      });

      const body = "## Summary\n\nLiteral {% if x %} from prose.\n";
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/archive/pr-summaries/pr-summary-99991.md`,
        body,
      );

      const { code, stderr } = await runScript(fixtureRoot);
      assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

      const out = await Deno.readTextFile(
        `${fixtureRoot}/docs/archive/pr-summaries/pr-summary-99991.md`,
      );
      assert(
        out.startsWith("{% raw %}\n"),
        `expected archive summary wrapped; got:\n${out}`,
      );
      assert(
        out.trimEnd().endsWith("{% endraw %}"),
        `expected trailing {% endraw %}; got:\n${out}`,
      );
      assertStringIncludes(out, "{% if x %}");
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);

Deno.test("wrap_pr_summary_raw.rb only touches docs/pr-summary-*.md files", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-scope-" });
  try {
    await stageFixture(fixtureRoot);

    // pr-summary file — should be wrapped.
    const summary = "## Summary\n\nBody.\n";
    await Deno.writeTextFile(
      `${fixtureRoot}/docs/pr-summary-99995.md`,
      summary,
    );

    // Other docs file — should NOT be wrapped.
    const other = "# Other doc\n\nUnrelated.\n";
    await Deno.writeTextFile(`${fixtureRoot}/docs/OVERVIEW.md`, other);

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const summaryOut = await Deno.readTextFile(
      `${fixtureRoot}/docs/pr-summary-99995.md`,
    );
    assert(summaryOut.startsWith("{% raw %}\n"));

    const otherOut = await Deno.readTextFile(`${fixtureRoot}/docs/OVERVIEW.md`);
    assertEquals(otherOut, other, "non-pr-summary docs must not be wrapped");
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test(
  "inject_page_metadata.rb invokes wrap_pr_summary_raw.rb so workflow YAML stays unchanged",
  async () => {
    const fixtureRoot = await Deno.makeTempDir({ prefix: "wrap-via-inject-" });
    try {
      // Stage both scripts.
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

      await Deno.writeTextFile(
        `${fixtureRoot}/_data/page_titles.yml`,
        "{}\n",
      );
      await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# Hi\n");
      await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Sec\n");
      await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
      await Deno.writeTextFile(
        `${fixtureRoot}/docs/pr-summary-99994.md`,
        "## Summary\n\nBody with {% if x %}.\n",
      );

      const cmd = new Deno.Command("ruby", {
        args: [`${fixtureRoot}/.github/scripts/inject_page_metadata.rb`],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await cmd.output();
      assertEquals(
        code,
        0,
        `inject_page_metadata.rb exited non-zero:\n` +
          new TextDecoder().decode(stderr),
      );

      const out = await Deno.readTextFile(
        `${fixtureRoot}/docs/pr-summary-99994.md`,
      );
      // inject_page_metadata.rb adds front-matter; wrap_pr_summary_raw.rb
      // must wrap the body after the front-matter.
      assert(out.startsWith("---\n"), `expected front-matter; got:\n${out}`);
      assertStringIncludes(out, "{% raw %}");
      assert(
        out.trimEnd().endsWith("{% endraw %}"),
        `expected trailing {% endraw %}; got:\n${out}`,
      );
    } finally {
      await Deno.remove(fixtureRoot, { recursive: true });
    }
  },
);
