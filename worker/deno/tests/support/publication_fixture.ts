/** Execution fixtures for publication callers; no network or test doubles for checks. */
import { validateRepositoryForPublication } from "../../lib/publication_validation.ts";
import { runWithTimeout } from "../../lib/subprocess_timeout.ts";

export type PublicationFixtureMode = "full" | "sharded" | "impacted" | "empty";

export async function writePublicationFixture(
  cwd: string,
  mode: PublicationFixtureMode,
  regression = false,
): Promise<void> {
  const test = "deno test --no-config --no-lock --no-check";
  const unitTask = mode === "sharded"
    ? `${test} first_test.ts && ${test} required_test.ts`
    : test;
  const gate = mode === "impacted"
    ? `${test} --filter=passing first_test.ts`
    : mode === "empty"
    ? `${test} --filter=absent first_test.ts`
    : "deno task test:unit";
  await Deno.writeTextFile(`${cwd}/quality.sh`, `#!/bin/sh\nexec ${gate}\n`);
  await Deno.chmod(`${cwd}/quality.sh`, 0o755);
  await Deno.writeTextFile(
    `${cwd}/deno.json`,
    JSON.stringify({ tasks: { "test:unit": unitTask } }),
  );
  await Deno.writeTextFile(
    `${cwd}/first_test.ts`,
    'Deno.test("passing", () => {});\n',
  );
  await Deno.writeTextFile(
    `${cwd}/required_test.ts`,
    regression
      ? 'Deno.test("required regression", () => { throw new Error("required regression"); });\n'
      : 'Deno.test("required regression", () => {});\n',
  );
  for (
    const args of [
      ["init", "-q"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "publication fixture"],
    ]
  ) {
    const result = await runWithTimeout("git", args, {
      cwd,
      timeoutMs: 10_000,
    });
    if (!result.ok || result.value.code !== 0) {
      throw new Error(result.ok ? result.value.stderr : result.error.message);
    }
  }
}

export const runPublicationFixtureChecks:
  typeof validateRepositoryForPublication = (cwd, deps = {}) =>
    validateRepositoryForPublication(cwd, { ...deps, run: runWithTimeout });
