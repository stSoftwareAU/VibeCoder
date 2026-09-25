/**
 * Every raw `deno test` a workflow runs is quiet on green (Issue #2608).
 *
 * The quality gate's own test passes print nothing for a passing test —
 * `TEST_REPORTER_FLAG` (`--reporter=dot`, Issue #2430), because the gate's
 * output is read back into prompts and the default `pretty` reporter spends a
 * line on every test that passed. Three CI steps called `deno test` /
 * `deno task test` directly and skipped that flag, so a green PR still logged
 * one line per test there. This pins the convention for every workflow, so a
 * new step cannot drift from it either.
 *
 * `deno task test:unit` and `deno task test:integration` are not raw calls:
 * they run through `unit_test_runner.ts`, which already applies the flag.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { TEST_REPORTER_FLAG } from "../lib/unit_test_passes.ts";

const WORKFLOWS = new URL("../../../.github/workflows/", import.meta.url);

/** A raw test command: `deno test …` or `deno task test …` (not `test:…`). */
const RAW_TEST_RE = /\bdeno (?:test\b|task test(?![:\w-]))/;

/** Join `\`-continued lines, so a command split over several lines is one. */
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const physical = text.split("\n");
  for (let i = 0; i < physical.length; i++) {
    const start = i;
    let joined = physical[i]!;
    while (joined.trimEnd().endsWith("\\") && i + 1 < physical.length) {
      joined = joined.trimEnd().slice(0, -1) + " " + physical[++i]!.trim();
    }
    out.push({ line: start + 1, text: joined });
  }
  return out;
}

/** Raw test commands in one workflow that lack the quiet reporter. */
export function noisyTestCalls(name: string, text: string): string[] {
  return logicalLines(text)
    .filter(({ text }) => !text.trimStart().startsWith("#"))
    .filter(({ text }) => RAW_TEST_RE.test(text))
    .filter(({ text }) => !text.includes(TEST_REPORTER_FLAG))
    .map(({ line }) => `${name}:${line}`);
}

Deno.test("workflows - every raw deno test runs with the quiet reporter (Issue #2608)", async () => {
  const noisy: string[] = [];
  for await (const entry of Deno.readDir(WORKFLOWS)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    const text = await Deno.readTextFile(new URL(entry.name, WORKFLOWS));
    noisy.push(...noisyTestCalls(entry.name, text));
  }
  assertEquals(
    noisy.sort(),
    [],
    `add ${TEST_REPORTER_FLAG} to: ${noisy.join(", ")}`,
  );
});

Deno.test("noisyTestCalls - catches single-line and continued commands, ignores the runner tasks and comments", () => {
  const text = [
    "        run: deno test --allow-read tests/a_test.ts",
    "          deno task test \\",
    "            tests/b_test.ts < /dev/null",
    "          deno task test:unit",
    "          deno task test:integration",
    "  # the same `deno task test` the local gate runs",
    `          deno test --allow-read ${TEST_REPORTER_FLAG} tests/c_test.ts`,
    "          deno task test \\",
    `            ${TEST_REPORTER_FLAG} tests/d_test.ts`,
  ].join("\n");
  assertEquals(noisyTestCalls("w.yml", text), ["w.yml:1", "w.yml:2"]);
});
