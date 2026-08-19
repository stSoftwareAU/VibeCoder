/**
 * Tests for .github/scripts/inject_page_metadata.rb — verifies that
 * `index.md` (created from README.md by the pages workflow) ends up with
 * full front-matter including `title` and `page_icon` so the site homepage
 * has a favicon. Issue #1540.
 *
 * The pages workflow writes index.md as a bare `---\nlayout: default\n---`
 * wrapper around README.md's content, then runs inject_page_metadata.rb.
 * That Ruby script must rewrite index.md's front-matter to include the
 * README.md entry's `title` and `page_icon` from _data/page_titles.yml.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/**
 * Repository root (two levels up from worker/deno/tests/).
 */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

/**
 * Copy the real inject_page_metadata.rb into a fixture directory so it
 * operates relative to that fixture's root (the script resolves its data
 * and root paths from `__dir__`).
 */
async function stageFixture(fixtureRoot: string): Promise<void> {
  await Deno.mkdir(`${fixtureRoot}/.github/scripts`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/_data`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/docs`, { recursive: true });

  const scriptSrc = `${repoRoot()}.github/scripts/inject_page_metadata.rb`;
  const scriptDst = `${fixtureRoot}/.github/scripts/inject_page_metadata.rb`;
  await Deno.copyFile(scriptSrc, scriptDst);
}

/**
 * Run the Ruby script against the fixture. `env` overrides environment
 * variables for the child process — used to pin an ASCII locale so the
 * output encoding is exercised independently of the host's locale.
 */
async function runScript(
  fixtureRoot: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command("ruby", {
    args: [`${fixtureRoot}/.github/scripts/inject_page_metadata.rb`],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("inject_page_metadata.rb rewrites index.md with README's title and page_icon", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-index-" });
  try {
    await stageFixture(fixtureRoot);

    await Deno.writeTextFile(
      `${fixtureRoot}/_data/page_titles.yml`,
      [
        "README.md:",
        '  title: "Vibe Coder: Overview"',
        '  page_icon: "🚀"',
        "",
      ].join("\n"),
    );

    // README.md without front-matter, as it appears before the script runs.
    const readmeBody = "# Vibe Coder\n\nWelcome.\n";
    await Deno.writeTextFile(`${fixtureRoot}/README.md`, readmeBody);
    await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
    await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");

    // index.md as produced by the "Use README as site index" step.
    const bareIndex = `---\nlayout: default\n---\n\n${readmeBody}`;
    await Deno.writeTextFile(`${fixtureRoot}/index.md`, bareIndex);

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const indexOut = await Deno.readTextFile(`${fixtureRoot}/index.md`);

    // Full front-matter equivalent to README's metadata.
    assertStringIncludes(indexOut, "layout: default");
    assertStringIncludes(indexOut, 'title: "Vibe Coder: Overview"');
    assertStringIncludes(indexOut, 'page_icon: "🚀"');

    // No duplicated front-matter block — exactly one opening `---\n` and
    // one closing `\n---\n` before the content.
    const openCount = (indexOut.match(/^---\s*$/gm) || []).length;
    assertEquals(
      openCount,
      2,
      `expected one front-matter block, got ${openCount} ` +
        `'---' markers:\n${indexOut}`,
    );

    // README body preserved.
    assertStringIncludes(indexOut, "# Vibe Coder");
    assertStringIncludes(indexOut, "Welcome.");
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("inject_page_metadata.rb still injects README.md with title and page_icon", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-readme-" });
  try {
    await stageFixture(fixtureRoot);

    await Deno.writeTextFile(
      `${fixtureRoot}/_data/page_titles.yml`,
      [
        "README.md:",
        '  title: "Vibe Coder: Overview"',
        '  page_icon: "🚀"',
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# Vibe Coder\n");
    await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
    await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const readmeOut = await Deno.readTextFile(`${fixtureRoot}/README.md`);
    assert(
      readmeOut.startsWith("---\n"),
      `README.md should have front-matter injected; got:\n${readmeOut}`,
    );
    assertStringIncludes(readmeOut, 'title: "Vibe Coder: Overview"');
    assertStringIncludes(readmeOut, 'page_icon: "🚀"');
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

// Regression test for Issue #3590: under an ASCII locale (LC_ALL=C) Ruby's
// Encoding.default_external is US-ASCII, which made String#inspect emit the
// page_icon emoji as a \u{1F680} escape and mangled non-ASCII body bytes.
// The script now pins UTF-8 I/O, so output must be byte-identical to a
// UTF-8-locale run.
Deno.test("inject_page_metadata.rb emits literal UTF-8 under an ASCII locale", async () => {
  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-ascii-" });
  try {
    await stageFixture(fixtureRoot);

    await Deno.writeTextFile(
      `${fixtureRoot}/_data/page_titles.yml`,
      [
        "README.md:",
        '  title: "Vibe Coder: Übersicht"',
        '  page_icon: "🚀"',
        "",
      ].join("\n"),
    );

    // Non-ASCII body content must survive the read/write round-trip too.
    const readmeBody = "# Vibe Coder\n\nBehaviour — 100 metres. 🎉\n";
    await Deno.writeTextFile(`${fixtureRoot}/README.md`, readmeBody);
    await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
    await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
    await Deno.writeTextFile(
      `${fixtureRoot}/index.md`,
      `---\nlayout: default\n---\n\n${readmeBody}`,
    );

    const { code, stderr } = await runScript(fixtureRoot, {
      LC_ALL: "C",
      LANG: "C",
      PATH: Deno.env.get("PATH") ?? "",
    });
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    for (const file of ["index.md", "README.md"]) {
      const out = await Deno.readTextFile(`${fixtureRoot}/${file}`);
      assertStringIncludes(out, 'title: "Vibe Coder: Übersicht"');
      assertStringIncludes(out, 'page_icon: "🚀"');
      assert(
        !out.includes("\\u{"),
        `${file} must not contain \\u{...} escapes; got:\n${out}`,
      );
      assertStringIncludes(out, "Behaviour — 100 metres. 🎉");
    }
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});
