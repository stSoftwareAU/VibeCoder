/**
 * Issue #1226: the tooling that PROCESSES untrusted content must not inherit
 * the worker's credentials either.
 *
 * Issue #1214 built the environment for the three spawns of
 * repository-supplied code. A second band was left inheriting everything:
 * `markdownlint-cli2` out of this repo's own `node_modules`, `bundle`/`ruby`
 * resolving gems from its `Gemfile.lock`, and `semgrep`/`git` run over an
 * attacker-authored tree. A compromised npm dependency, gem or scanner image
 * therefore saw `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` and any cloud
 * credential the run held.
 *
 * These tests drive the real spawn paths with a stub binary that reports the
 * environment it was given, and compare that against the worker's own
 * environment: any name outside the allowlist that reaches the child was
 * inherited. They fail against the unfixed code and pass once each site
 * builds its environment.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { detectMarkdownlintRunner } from "../lib/markdownlint_check.ts";
import { makeRubyLiquidParser } from "../lib/pages_liquid_check.ts";
import { createDefaultSweepDeps } from "../lib/security_tree_sweep.ts";
import {
  ALLOWED_ENV_NAMES,
  isCredentialVariableName,
} from "../lib/untrusted_command_env.ts";

/**
 * Names a shell sets for itself, whatever environment it was handed.
 *
 * They appear in the child's `env` output even under `clearEnv`, so they are
 * not evidence of inheritance.
 */
const SHELL_SET_NAMES = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);

/** Write an executable stub at `path` with the given shell body. */
async function writeStub(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, `#!/bin/bash\n${body}\n`);
  await Deno.chmod(path, 0o755);
}

/** The variable names in a child's `env` dump. */
function namesIn(envDump: string): Set<string> {
  const names = new Set<string>();
  for (const line of envDump.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) names.add(line.slice(0, separator));
  }
  return names;
}

/**
 * Assert that a child's environment was BUILT, not inherited.
 *
 * The discriminator is the worker's own environment: every name it carries
 * that the allowlist does not name must be absent from the child. Against the
 * unfixed code the child inherits the lot — `CLAUDE_CODE_OAUTH_TOKEN`,
 * `GH_TOKEN` and the rest — and every one of those names is reported here.
 *
 * No test mutates the process environment to prove this (Issue #880): the
 * worker's real environment is the input, read rather than written.
 */
function assertBuiltEnvironment(
  envDump: string,
  site: string,
  extraNames: readonly string[] = [],
): void {
  const allowed = new Set<string>([...ALLOWED_ENV_NAMES, ...extraNames]);
  const inheritable = Object.keys(Deno.env.toObject())
    .filter((name) => !allowed.has(name) && !SHELL_SET_NAMES.has(name));
  assert(
    inheritable.length > 0,
    `${site}: the worker's own environment carries nothing outside the ` +
      "allowlist, so this test cannot tell a built environment from an " +
      "inherited one",
  );

  const childNames = namesIn(envDump);
  assertEquals(
    inheritable.filter((name) => childNames.has(name)),
    [],
    `${site}: these names were inherited rather than built from the allowlist`,
  );
  for (const name of childNames) {
    if (SHELL_SET_NAMES.has(name)) continue;
    assertEquals(
      isCredentialVariableName(name),
      false,
      `${site}: ${name} reached a content-processing child`,
    );
  }
  assert(
    childNames.has("PATH"),
    `${site}: PATH must survive — the tool cannot run without it`,
  );
}

Deno.test("markdownlint - the linter runs with a built environment, not the worker's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mdl_env_" });
  try {
    await Deno.mkdir(`${dir}/node_modules/.bin`, { recursive: true });
    const capture = `${dir}/probe-env.txt`;
    // Dumps its environment twice: to a file (so the `--help` probe spawn is
    // observable too) and to stdout (what the runner returns).
    await writeStub(
      `${dir}/node_modules/.bin/markdownlint-cli2`,
      `env >> "${capture}"\nenv\n`,
    );

    const runner = await detectMarkdownlintRunner(dir);
    assert(runner !== null, "the stub binary must be detected");
    const result = await runner(dir);

    assertBuiltEnvironment(result.stdout, "markdownlint runner");
    assertBuiltEnvironment(
      await Deno.readTextFile(capture),
      "markdownlint probe",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pages-liquid - the Ruby driver runs with a built environment, not the worker's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "liquid_env_" });
  try {
    const stub = `${dir}/fake-ruby`;
    // The parser reads `ERR\t<file>\t<message>` lines, so the stub reports
    // one record per environment variable through that channel.
    await writeStub(
      stub,
      `env | while read -r line; do` +
        ` printf 'ERR\\tenv\\t%s\\n' "$line"; done`,
    );

    const parse = makeRubyLiquidParser([stub], dir);
    const errors = await parse([{ path: "docs/x.md", content: "# x" }]);

    const dump = errors.map((error) => error.message).join("\n");
    assertBuiltEnvironment(dump, "pages-liquid ruby driver");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("security tree sweep - scanners run with a built environment, not the worker's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sweep_env_" });
  try {
    const stub = `${dir}/fake-semgrep`;
    await writeStub(stub, "env");

    const deps = createDefaultSweepDeps();
    const result = await deps.runner({ bin: stub, args: ["scan"] }, dir);

    assertEquals(result.code, 0);
    // The container-runtime names are the sweep's declared additions, so they
    // are not evidence of inheritance.
    assertBuiltEnvironment(result.stdout, "security tree sweep runner", [
      "DOCKER_HOST",
      "XDG_RUNTIME_DIR",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
