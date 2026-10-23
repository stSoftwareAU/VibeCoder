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
 * environment it was given, and compare that against the names the runner's
 * process was handed: any name outside the allowlist that reaches the child was
 * inherited. They fail against the unfixed code and pass once each site
 * builds its environment.
 *
 * How the comparison is made (Issue #880). Each runner reads the environment
 * of the deno process it runs in, so each check runs the real runner in a
 * child `deno eval` process. That child's environment is the worker's own
 * environment plus CANARY, a credential-shaped name the allowlist does not
 * name. The child reports every name it was handed, so the positive control
 * (something outside the allowlist must be available to inherit) holds
 * whether or not the worker's own environment is cleared, as it is under the
 * mutation gate's `env -i`. Only the child's environment is set; this process's
 * environment is never written.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_ENV_NAMES,
  isCredentialVariableName,
} from "../lib/untrusted_command_env.ts";

/**
 * A name the allowlist does not name, shaped like a credential, set on the
 * CHILD process only. It is always present in the child's environment, so the
 * positive control holds by construction in any parent environment.
 */
const CANARY = "CONTENT_TOOLING_ENV_CANARY_TOKEN";

/**
 * Names a shell sets for itself, whatever environment it was handed.
 *
 * They appear in the child's `env` output even under `clearEnv`, so they are
 * not evidence of inheritance.
 */
const SHELL_SET_NAMES = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);

/** The modules under test, as URLs the child process can import. */
const MARKDOWNLINT_MODULE = new URL(
  "../lib/markdownlint_check.ts",
  import.meta.url,
).href;
const SWEEP_MODULE = new URL("../lib/security_tree_sweep.ts", import.meta.url)
  .href;

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
 * Run `body` in a child deno process and return what it resolved to, plus the
 * names the child process was handed.
 *
 * `body` is the statements of an async function; its return value is reported
 * back as JSON. The child inherits the worker's environment (Deno.Command's
 * default) with CANARY added, so the runner under test sees the same names the
 * worker would hand it.
 */
async function runInChild<T extends object>(
  body: string,
): Promise<T & { handed: string[] }> {
  const source = [
    "const handed = Object.keys(Deno.env.toObject());",
    `const report = await (async () => {\n${body}\n})();`,
    "console.log(JSON.stringify({ ...report, handed }));",
  ].join("\n");
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", source],
    env: { [CANARY]: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  assert(
    output.success,
    `the child deno process failed: ${decoder.decode(output.stderr)}`,
  );
  const report = JSON.parse(decoder.decode(output.stdout)) as
    & T
    & { handed: string[] };
  assert(
    report.handed.includes(CANARY),
    "the canary did not reach the child, so the positive control cannot hold",
  );
  return report;
}

/**
 * Assert that a child's environment was BUILT, not inherited.
 *
 * `handed` is every name the runner's process was given. Every name in it that
 * the allowlist does not name must be absent from the child. Against the
 * unfixed code the child inherits the lot — `CLAUDE_CODE_OAUTH_TOKEN`,
 * `GH_TOKEN`, CANARY and the rest — and every one of those names is reported
 * here.
 *
 * No test mutates the process environment to prove this (Issue #880): the
 * names come from a child process that was given them.
 */
function assertBuiltEnvironment(
  envDump: string,
  handed: readonly string[],
  site: string,
  extraNames: readonly string[] = [],
): void {
  const allowed = new Set<string>([...ALLOWED_ENV_NAMES, ...extraNames]);
  const inheritable = handed
    .filter((name) => !allowed.has(name) && !SHELL_SET_NAMES.has(name));
  assert(
    inheritable.length > 0,
    `${site}: the runner was handed nothing outside the allowlist, so this ` +
      "test cannot tell a built environment from an inherited one",
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

    const report = await runInChild<{ stdout: string | null }>(`
const { detectMarkdownlintRunner } = await import(${
      JSON.stringify(MARKDOWNLINT_MODULE)
    });
const runner = await detectMarkdownlintRunner(${JSON.stringify(dir)});
if (runner === null) return { stdout: null };
const result = await runner(${JSON.stringify(dir)});
return { stdout: result.stdout };
`);

    assert(report.stdout !== null, "the stub binary must be detected");
    assertBuiltEnvironment(report.stdout, report.handed, "markdownlint runner");
    assertBuiltEnvironment(
      await Deno.readTextFile(capture),
      report.handed,
      "markdownlint probe",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("security tree sweep - scanners run with a built environment, not the worker's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sweep_env_" });
  try {
    const stub = `${dir}/fake-semgrep`;
    await writeStub(stub, "env");

    const report = await runInChild<{ code: number; stdout: string }>(`
const { createDefaultSweepDeps } = await import(${
      JSON.stringify(SWEEP_MODULE)
    });
const deps = createDefaultSweepDeps();
const result = await deps.runner({ bin: ${
      JSON.stringify(stub)
    }, args: ["scan"] }, ${JSON.stringify(dir)});
return { code: result.code, stdout: result.stdout };
`);

    assertEquals(report.code, 0);
    // The container-runtime names are the sweep's declared additions, so they
    // are not evidence of inheritance.
    assertBuiltEnvironment(
      report.stdout,
      report.handed,
      "security tree sweep runner",
      [
        "DOCKER_HOST",
        "XDG_RUNTIME_DIR",
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
