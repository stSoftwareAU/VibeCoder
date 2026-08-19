/**
 * Tests for .github/scripts/inject_page_metadata.rb — `_data/page_titles.yml`
 * is parsed with a *safe* load (Issue #3661, SEC-73515a44685a).
 *
 * `YAML.load_file` deserialises arbitrary Ruby objects on Psych 3; the Pages
 * build was only safe because `.github/workflows/pages.yml` happens to pin
 * `ruby-version: "3.1"` (Psych 4). A PR that edits `page_titles.yml` runs in
 * that job, so the safety must be explicit in the script rather than
 * incidental to a version pin.
 *
 * The tests run the real script against a temp fixture, so they hold on
 * whatever Ruby the host has — including Ruby 2.6/Psych 3, where the old
 * `load_file` would happily have instantiated the payload.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** Repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

/** True when a `ruby` interpreter is on PATH. */
async function rubyAvailable(): Promise<boolean> {
  try {
    const { code } = await new Deno.Command("ruby", {
      args: ["-e", "exit 0"],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

/** Stage the real script into a fixture root it will operate relative to. */
async function stageFixture(fixtureRoot: string): Promise<void> {
  await Deno.mkdir(`${fixtureRoot}/.github/scripts`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/_data`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/docs`, { recursive: true });
  await Deno.copyFile(
    `${repoRoot()}.github/scripts/inject_page_metadata.rb`,
    `${fixtureRoot}/.github/scripts/inject_page_metadata.rb`,
  );
  await Deno.writeTextFile(`${fixtureRoot}/README.md`, "# Vibe Coder\n");
  await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
  await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");
}

/** Run the staged script and return its exit code and stderr. */
async function runScript(
  fixtureRoot: string,
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await new Deno.Command("ruby", {
    args: [`${fixtureRoot}/.github/scripts/inject_page_metadata.rb`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("inject_page_metadata.rb refuses a Ruby-object payload in page_titles.yml", async () => {
  if (!await rubyAvailable()) return;

  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-safeload-" });
  try {
    await stageFixture(fixtureRoot);
    // The shape a malicious docs PR would use: an explicit Ruby class tag.
    await Deno.writeTextFile(
      `${fixtureRoot}/_data/page_titles.yml`,
      [
        "README.md:",
        '  title: "Vibe Coder: Overview"',
        "  page_icon: !ruby/object:Gem::Requirement",
        "    requirements: []",
        "",
      ].join("\n"),
    );

    const { code, stderr } = await runScript(fixtureRoot);
    assert(code !== 0, "the script must fail loudly on a disallowed class");
    assertStringIncludes(stderr, "DisallowedClass");

    // The front matter was never written — the failure is not partial.
    const readme = await Deno.readTextFile(`${fixtureRoot}/README.md`);
    assertEquals(readme.startsWith("---"), false);
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("inject_page_metadata.rb still parses an ordinary page_titles.yml", async () => {
  if (!await rubyAvailable()) return;

  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-safeload-ok-" });
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

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const readme = await Deno.readTextFile(`${fixtureRoot}/README.md`);
    assertStringIncludes(readme, 'title: "Vibe Coder: Overview"');
    assertStringIncludes(readme, 'page_icon: "🚀"');
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

Deno.test("inject_page_metadata.rb tolerates an empty page_titles.yml", async () => {
  if (!await rubyAvailable()) return;

  const fixtureRoot = await Deno.makeTempDir({ prefix: "inject-safeload-e-" });
  try {
    await stageFixture(fixtureRoot);
    // safe_load returns nil for an empty document — the `|| {}` fallback keeps
    // the derived-title path working rather than raising on nil#[].
    await Deno.writeTextFile(`${fixtureRoot}/_data/page_titles.yml`, "");

    const { code, stderr } = await runScript(fixtureRoot);
    assertEquals(code, 0, `ruby exited non-zero:\n${stderr}`);

    const readme = await Deno.readTextFile(`${fixtureRoot}/README.md`);
    assertStringIncludes(readme, 'title: "Vibe Coder: Readme"');
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});
