/**
 * Issue #5074: the CI cargo scan read the `||` list operator as a pipe, so a
 * workflow line such as `cargo llvm-cov report ... || status=$?` made every
 * push to that Rust repository fail at completion with "cannot be reproduced
 * faithfully: it contains a pipe".
 *
 * Uses Australian English spelling (behaviour, normalise, recognise, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { scanWorkflowForCargoChecks } from "../lib/ci_cargo_checks.ts";

const FILE = "quality.yml";

/** Removes the common indentation of a fixture written inside a test. */
function yaml(text: string): string {
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.search(/\S/));
  const cut = Math.min(...indents);
  return lines.map((line) => line.slice(cut)).join("\n");
}

function scan(text: string) {
  return scanWorkflowForCargoChecks(FILE, yaml(text));
}

Deno.test("a cargo check followed by `|| status=$?` is reproduced, not refused as a pipe", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets -- -D warnings || status=$?
  `);
  assertEquals(result, {
    checks: [{
      kind: "clippy",
      workingDirectory: ".",
      argv: ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"],
      env: {},
      source: FILE,
    }],
    unverifiable: [],
  });
});

Deno.test("a single pipe after a cargo command is still unverifiable", () => {
  const result = scan(`
    on: pull_request
    jobs:
      test:
        steps:
          - run: cargo test --workspace | tee test.log || status=$?
  `);
  assertEquals(result.checks, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.unverifiable[0]!, "pipe");
});

Deno.test("cargo llvm-cov report, clean and show-env are not checks and never block", () => {
  for (
    const sub of ["report --summary-only", "clean --workspace", "show-env"]
  ) {
    const result = scan(`
      on: pull_request
      jobs:
        coverage:
          steps:
            - run: cargo llvm-cov ${sub} > out.txt 2> err.log
    `);
    assertEquals(result, { checks: [], unverifiable: [] }, sub);
  }
});

Deno.test("the coverage step shape that blocked every push yields its compile and no refusal", () => {
  const result = scan(`
    on: pull_request
    jobs:
      quality:
        steps:
          - uses: actions/checkout@v4
          - name: Coverage
            run: |
              status=0
              cargo llvm-cov --workspace --locked --no-report || status=$?
              cargo llvm-cov report --summary-only > coverage-summary.txt 2> coverage-report.log || status=$?
              exit "\${status}"
  `);
  assertEquals(result.unverifiable, []);
  assertEquals(result.checks.map((c) => [c.kind, c.argv]), [[
    "test-build",
    ["cargo", "test", "--no-run", "--workspace", "--locked"],
  ]]);
});
