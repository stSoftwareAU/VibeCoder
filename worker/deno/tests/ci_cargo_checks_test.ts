/**
 * Tests for lib/ci_cargo_checks.ts: the cargo clippy and test-target compile
 * commands a repository's pull-request workflows run (Issue #4630). Fixtures are
 * realistic workflow text; the repository test writes its files into a fresh
 * temporary directory, removed in `finally`.
 *
 * Uses Australian English throughout (behaviour, normalise, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  repoCiCargoChecks,
  scanWorkflowForCargoChecks,
} from "../lib/ci_cargo_checks.ts";

const FILE = "ci.yml";

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

Deno.test("clippy argv is kept verbatim, flags and the lint arguments after --", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets --all-features -- -D warnings
  `);
  assertEquals(result, {
    checks: [{
      kind: "clippy",
      workingDirectory: ".",
      argv: [
        "cargo",
        "clippy",
        "--all-targets",
        "--all-features",
        "--",
        "-D",
        "warnings",
      ],
      env: {},
      source: FILE,
    }],
    unverifiable: [],
  });
});

Deno.test("workspace, package, features and locked flags are kept in clippy argv", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --workspace --package app --features "a b" --locked -- -D warnings
  `);
  assertEquals(result.checks.map((c) => c.argv), [[
    "cargo",
    "clippy",
    "--workspace",
    "--package",
    "app",
    "--features",
    "a b",
    "--locked",
    "--",
    "-D",
    "warnings",
  ]]);
  assertEquals(result.unverifiable, []);
});

Deno.test("working directory comes from the step, then job, then workflow defaults", () => {
  const dirOf = (text: string) =>
    scan(text).checks.map((c) => c.workingDirectory);
  assertEquals(
    dirOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - working-directory: rust
              run: cargo clippy -- -D warnings
    `),
    ["rust"],
  );
  assertEquals(
    dirOf(`
      on: pull_request
      jobs:
        lint:
          defaults:
            run:
              working-directory: ./backend/
          steps:
            - run: cargo clippy -- -D warnings
    `),
    ["backend"],
  );
  assertEquals(
    dirOf(`
      on: pull_request
      defaults:
        run:
          working-directory: svc
      jobs:
        lint:
          steps:
            - run: cargo clippy -- -D warnings
    `),
    ["svc"],
  );
  assertEquals(
    dirOf(`
      on: pull_request
      jobs:
        lint:
          defaults:
            run:
              working-directory: backend
          steps:
            - working-directory: rust
              run: cargo clippy -- -D warnings
    `),
    ["rust"],
  );
});

Deno.test("a preceding cd segment sets the working directory of the cargo command", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cd rust && cargo clippy -- -D warnings
          - working-directory: app
            run: cd rust && cargo clippy -- -D warnings
  `);
  assertEquals(result.checks.map((c) => c.workingDirectory), [
    "rust",
    "app/rust",
  ]);
  assertEquals(result.unverifiable, []);
});

Deno.test("RUSTFLAGS is taken from workflow, job, step and inline env, and other keys are dropped", () => {
  const envOf = (text: string) => scan(text).checks.map((c) => c.env);
  assertEquals(
    envOf(`
      on: pull_request
      env:
        RUSTFLAGS: -D warnings
        FOO: bar
      jobs:
        lint:
          steps:
            - run: cargo clippy
    `),
    [{ RUSTFLAGS: "-D warnings" }],
  );
  assertEquals(
    envOf(`
      on: pull_request
      jobs:
        lint:
          env:
            RUSTFLAGS: -D warnings
          steps:
            - run: cargo clippy
    `),
    [{ RUSTFLAGS: "-D warnings" }],
  );
  assertEquals(
    envOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - env:
                RUSTFLAGS: -D warnings
              run: cargo clippy
    `),
    [{ RUSTFLAGS: "-D warnings" }],
  );
  const inline = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: RUSTFLAGS="-D warnings" cargo clippy
  `);
  assertEquals(inline.checks.map((c) => c.env), [{ RUSTFLAGS: "-D warnings" }]);
  assertEquals(inline.checks.map((c) => c.argv), [["cargo", "clippy"]]);
});

Deno.test("a secret env var with an expression is ignored, but RUSTFLAGS with an expression is unverifiable", () => {
  const secret = scan(`
    on: pull_request
    env:
      GH_TOKEN: \${{ secrets.GH_TOKEN }}
    jobs:
      lint:
        steps:
          - run: cargo clippy -- -D warnings
  `);
  assertEquals(secret.checks.map((c) => c.env), [{}]);
  assertEquals(secret.unverifiable, []);

  const flags = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - env:
              RUSTFLAGS: \${{ matrix.flags }}
            run: cargo clippy -- -D warnings
  `);
  assertEquals(flags.checks, []);
  assertEquals(flags.unverifiable.length, 1);
  assertStringIncludes(flags.unverifiable[0]!, FILE);
  assertStringIncludes(flags.unverifiable[0]!, "RUSTFLAGS");
});

Deno.test("the toolchain from a setup action is inserted, and an explicit +toolchain is not overridden", () => {
  const argvOf = (text: string) => scan(text).checks.map((c) => c.argv[1]);
  assertEquals(
    argvOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - uses: dtolnay/rust-toolchain@1.80
            - run: cargo clippy -- -D warnings
    `),
    ["+1.80"],
  );
  assertEquals(
    argvOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - uses: dtolnay/rust-toolchain@stable
              with:
                toolchain: nightly
            - run: cargo clippy
    `),
    ["+nightly"],
  );
  assertEquals(
    argvOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - uses: actions-rust-lang/setup-rust-toolchain@v1
              with:
                toolchain: "1.80.0"
            - run: cargo clippy
    `),
    ["+1.80.0"],
  );
  assertEquals(
    argvOf(`
      on: pull_request
      jobs:
        lint:
          steps:
            - uses: dtolnay/rust-toolchain@1.80
            - run: cargo +nightly clippy
    `),
    ["+nightly"],
  );
  assertEquals(
    scan(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: cargo clippy
    `).checks.map((c) => c.argv.slice(0, 2)),
    [["cargo", "clippy"]],
  );
});

Deno.test("a toolchain given by an expression is unverifiable", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - uses: dtolnay/rust-toolchain@stable
            with:
              toolchain: \${{ matrix.rust }}
          - run: cargo clippy -- -D warnings
  `);
  assertEquals(result.checks, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.unverifiable[0]!, FILE);
});

Deno.test("an unquoted YAML number toolchain is unverifiable and asks for quotes, while a quoted one is used", () => {
  const unquoted = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - uses: dtolnay/rust-toolchain@stable
            with:
              toolchain: 1.80
          - run: cargo clippy -- -D warnings
  `);
  assertEquals(unquoted.checks, []);
  assertEquals(unquoted.unverifiable.length, 1);
  assertStringIncludes(unquoted.unverifiable[0]!, FILE);
  assertStringIncludes(unquoted.unverifiable[0]!, "quote");

  const quoted = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - uses: dtolnay/rust-toolchain@stable
            with:
              toolchain: "1.80"
          - run: cargo clippy -- -D warnings
  `);
  assertEquals(quoted.checks.map((c) => c.argv.slice(0, 2)), [[
    "cargo",
    "+1.80",
  ]]);
  assertEquals(quoted.unverifiable, []);
});

Deno.test("a multi-line run block joined by a backslash continuation is one clippy command", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - name: Clippy
            run: |
              cargo clippy \\
                --workspace \\
                --all-targets -- -D warnings
  `);
  assertEquals(result.checks.map((c) => c.argv), [[
    "cargo",
    "clippy",
    "--workspace",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]]);
});

Deno.test("a clippy command after && in the same line is found", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo fmt --check && cargo clippy --all-targets -- -D warnings
  `);
  assertEquals(result.checks.map((c) => c.argv), [[
    "cargo",
    "clippy",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]]);
});

Deno.test("a line ending in a no-op tail is not a check", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets || true
  `);
  assertEquals(result, { checks: [], unverifiable: [] });
});

Deno.test("a step with continue-on-error is not a check", () => {
  for (const flag of ["true", '"true"']) {
    const result = scan(`
      on: pull_request
      jobs:
        lint:
          steps:
            - continue-on-error: ${flag}
              run: cargo clippy --all-targets
    `);
    assertEquals(result, { checks: [], unverifiable: [] });
  }
});

Deno.test("a workflow not triggered on pull_request is ignored", () => {
  const result = scan(`
    on: push
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets -- -D warnings
  `);
  assertEquals(result, { checks: [], unverifiable: [] });
});

Deno.test("a matrix expression in a cargo argument is unverifiable and names the file", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        strategy:
          matrix:
            features: [a, b]
        steps:
          - run: cargo clippy --features \${{ matrix.features }} -- -D warnings
  `);
  assertEquals(result.checks, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.unverifiable[0]!, FILE);
});

Deno.test("a pipe in a cargo command line is unverifiable and names the file", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy -- -D warnings | tee clippy.log
  `);
  assertEquals(result.checks, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.unverifiable[0]!, FILE);
  assertStringIncludes(result.unverifiable[0]!, "pipe");
});

Deno.test("a working directory that escapes the repository or is an expression is unverifiable", () => {
  for (const dir of ["../x", "/abs", "$X"]) {
    const result = scan(`
      on: pull_request
      jobs:
        lint:
          steps:
            - working-directory: "${dir}"
              run: cargo clippy -- -D warnings
    `);
    assertEquals(result.checks, [], dir);
    assertEquals(result.unverifiable.length, 1, dir);
    assertStringIncludes(result.unverifiable[0]!, FILE);
    assertStringIncludes(result.unverifiable[0]!, dir);
  }
});

Deno.test("a comment line and an echo of cargo clippy are not checks", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: |
              # cargo clippy --all-targets -- -D warnings
              echo cargo clippy --all-targets
  `);
  assertEquals(result, { checks: [], unverifiable: [] });
});

Deno.test("cargo test with --no-run keeps only build-relevant flags and drops the test arguments", () => {
  const result = scan(`
    on: pull_request
    jobs:
      test:
        steps:
          - run: cargo test --workspace --locked -- --nocapture
  `);
  assertEquals(result.checks, [{
    kind: "test-build",
    workingDirectory: ".",
    argv: ["cargo", "test", "--no-run", "--workspace", "--locked"],
    env: {},
    source: FILE,
  }]);
});

Deno.test("cargo llvm-cov derives a test-target compile from its build flags", () => {
  const result = scan(`
    on: pull_request
    jobs:
      coverage:
        steps:
          - run: cargo llvm-cov --workspace --locked
  `);
  assertEquals(result.checks.map((c) => [c.kind, c.argv]), [[
    "test-build",
    ["cargo", "test", "--no-run", "--workspace", "--locked"],
  ]]);
});

Deno.test("a test-target compile is not derived for --doc", () => {
  const result = scan(`
    on: pull_request
    jobs:
      test:
        steps:
          - run: cargo test --doc
  `);
  assertEquals(result, { checks: [], unverifiable: [] });
});

Deno.test("a test-target compile is dropped when clippy with --all-targets runs in the same directory", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets -- -D warnings
          - run: cargo test --workspace
  `);
  assertEquals(result.checks.map((c) => c.kind), ["clippy"]);
});

Deno.test("a test-target compile is kept when clippy runs in a different directory", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - working-directory: rust
            run: cargo clippy --all-targets -- -D warnings
          - run: cargo test --workspace
  `);
  assertEquals(result.checks.map((c) => [c.kind, c.workingDirectory]), [
    ["clippy", "rust"],
    ["test-build", "."],
  ]);
});

Deno.test("a test-target compile is kept when clippy has neither --all-targets nor --tests", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy -- -D warnings
          - run: cargo test --workspace
  `);
  assertEquals(result.checks.map((c) => c.kind), ["clippy", "test-build"]);
});

Deno.test("repoCiCargoChecks merges identical checks from two workflows and reads only tracked workflow files", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    const clippy = yaml(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: cargo clippy --all-targets -- -D warnings
    `);
    await Deno.writeTextFile(`${root}/.github/workflows/ci.yml`, clippy);
    await Deno.writeTextFile(`${root}/.github/workflows/lint.yaml`, clippy);
    await Deno.writeTextFile(`${root}/scripts/ci.yml`, clippy);
    const result = await repoCiCargoChecks(root, [
      ".github/workflows/ci.yml",
      ".github/workflows/lint.yaml",
      "scripts/ci.yml",
      "docs/notes.md",
    ]);
    assertEquals(result, {
      checks: [{
        kind: "clippy",
        workingDirectory: ".",
        argv: ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"],
        env: {},
        source: ".github/workflows/ci.yml",
      }],
      unverifiable: [],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("repoCiCargoChecks reports an unparseable workflow that names cargo clippy and ignores one without it", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.github/workflows/broken.yml`,
      "on: pull_request\njobs: [\n  run: cargo clippy --all-targets\n",
    );
    await Deno.writeTextFile(
      `${root}/.github/workflows/junk.yml`,
      "on: pull_request\njobs: [\n",
    );
    const result = await repoCiCargoChecks(root, [
      ".github/workflows/broken.yml",
      ".github/workflows/junk.yml",
      ".github/workflows/absent.yml",
    ]);
    assertEquals(result.checks, []);
    assertEquals(result.unverifiable.length, 1);
    assertStringIncludes(result.unverifiable[0]!, "broken.yml");
    assert(!result.unverifiable[0]!.includes("junk.yml"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hostile input: a 200,000-character run line and a long run of spaces return promptly", () => {
  const started = performance.now();
  const longArgument = scanWorkflowForCargoChecks(
    FILE,
    yaml(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: ${JSON.stringify("cargo clippy " + "x".repeat(200_000))}
    `),
  );
  assertEquals(longArgument.checks.length, 1);
  assertEquals(longArgument.checks[0]!.argv.length, 3);

  const spaces = scanWorkflowForCargoChecks(
    FILE,
    yaml(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: ${JSON.stringify("cargo" + " ".repeat(200_000) + "x")}
    `),
  );
  assertEquals(spaces, { checks: [], unverifiable: [] });

  const spacesThenPipe = scanWorkflowForCargoChecks(
    FILE,
    yaml(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: ${
      JSON.stringify("cargo clippy" + " ".repeat(200_000) + "| tee")
    }
    `),
  );
  assertEquals(spacesThenPipe.checks, []);
  assertEquals(spacesThenPipe.unverifiable.length, 1);
  assert(spacesThenPipe.unverifiable[0]!.length < 400);
  assert(performance.now() - started < 10_000);
});
