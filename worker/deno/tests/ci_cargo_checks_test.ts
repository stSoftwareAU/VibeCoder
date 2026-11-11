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
          - run: cargo clippy --workspace --all-targets -- -D warnings
          - run: cargo test --all --locked
  `);
  assertEquals(result.checks.map((c) => c.kind), ["clippy"]);
});

Deno.test("a test-target compile is dropped when clippy has the same features, packages and profile in another order or spelling", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --tests -p b --package=a --features "x y" --release -- -D warnings
          - run: cargo test -r --package a -p=b -F x,y
  `);
  assertEquals(result.checks.map((c) => c.kind), ["clippy"]);
});

Deno.test("a test-target compile is kept when its selection differs from the clippy run", () => {
  const kinds = (clippy: string, test: string) =>
    scan(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: ${clippy}
            - run: ${test}
    `).checks.map((c) => c.kind);
  const kept = ["clippy", "test-build"];
  // Clippy has no --workspace but the test run has it and more features.
  assertEquals(
    kinds(
      "cargo clippy --all-targets --locked -- -D warnings",
      "cargo test --workspace --all-features",
    ),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --workspace"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets -p a", "cargo test -p b"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets --features x", "cargo test --features y"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --no-default-features"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --release"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --profile ci"),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --target wasm32-wasip1"),
    kept,
  );
  assertEquals(
    kinds(
      "cargo clippy --all-targets",
      "cargo test --manifest-path a/Cargo.toml",
    ),
    kept,
  );
  assertEquals(
    kinds("cargo clippy --all-targets", "cargo test --exclude a"),
    kept,
  );
});

Deno.test("a test-target compile is kept when its env or toolchain differs from the clippy run", () => {
  const envDiffers = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo clippy --all-targets
          - env:
              RUSTFLAGS: -D warnings
            run: cargo test
  `);
  assertEquals(envDiffers.checks.map((c) => c.kind), ["clippy", "test-build"]);
  const toolchainDiffers = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: cargo +nightly clippy --all-targets
          - run: cargo test
  `);
  assertEquals(toolchainDiffers.checks.map((c) => c.kind), [
    "clippy",
    "test-build",
  ]);
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

Deno.test("every cargo-relevant env key is kept and an unrelated key is dropped", () => {
  const keys = [
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "RUSTUP_TOOLCHAIN",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_INCREMENTAL",
    "CARGO_NET_OFFLINE",
    "CARGO_BUILD_JOBS",
    "CARGO_PROFILE_DEV_DEBUG",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER",
  ];
  for (const key of keys) {
    const result = scan(`
      on: pull_request
      env:
        ${key}: "1"
        UNRELATED: "2"
      jobs:
        lint:
          steps:
            - run: cargo clippy
    `);
    assertEquals(result.checks.map((c) => c.env), [{ [key]: "1" }], key);
  }
});

Deno.test("cargo output directories are ignored even when expressions", () => {
  const result = scan(`
    on: pull_request
    env:
      CARGO_TARGET_DIR: \${{ runner.temp }}/target
      CARGO_BUILD_TARGET_DIR: /tmp/target
    jobs:
      lint:
        steps:
          - run: cargo clippy
  `);
  assertEquals(result.unverifiable, []);
  assertEquals(result.checks.map((c) => c.env), [{}]);
});

Deno.test("every build flag of a test run is kept in the test-target compile", () => {
  const booleans = [
    "--workspace",
    "--all",
    "--all-features",
    "--no-default-features",
    "--locked",
    "--frozen",
    "--offline",
    "--release",
    "-r",
    "--lib",
    "--bins",
    "--tests",
    "--examples",
    "--benches",
    "--all-targets",
  ];
  for (const flag of booleans) {
    const result = scan(`
      on: pull_request
      jobs:
        test:
          steps:
            - run: cargo test ${flag}
    `);
    assertEquals(
      result.checks.map((c) => c.argv),
      [["cargo", "test", "--no-run", flag]],
      flag,
    );
  }
  const valued = [
    "-p",
    "--package",
    "--exclude",
    "--features",
    "-F",
    "--profile",
    "--target",
    "--manifest-path",
    "--test",
    "--bin",
    "--example",
    "--bench",
  ];
  for (const flag of valued) {
    for (const spelling of [`${flag} v`, `${flag}=v`]) {
      const result = scan(`
        on: pull_request
        jobs:
          test:
            steps:
              - run: cargo test ${spelling}
      `);
      assertEquals(
        result.checks.map((c) => c.argv),
        [["cargo", "test", "--no-run", flag, "v"]],
        spelling,
      );
    }
  }
});

Deno.test("a workflow that parses to null or a list is unparseable, not a crash", () => {
  assertEquals(scanWorkflowForCargoChecks(FILE, "null # cargo clippy"), {
    checks: [],
    unverifiable: [
      `${FILE}: the workflow cannot be parsed, so its cargo clippy command cannot be checked`,
    ],
  });
  assertEquals(scanWorkflowForCargoChecks(FILE, "- cargo clippy\n- b"), {
    checks: [],
    unverifiable: [
      `${FILE}: the workflow cannot be parsed, so its cargo clippy command cannot be checked`,
    ],
  });
});

// ---- PR #4896 review: a cd on its own line, and nextest's --profile ---------

Deno.test("a cd on its own line holds for the later lines of the same step only", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: |
              cd rust
              cargo clippy --all-targets -- -D warnings
              cd ../tools
          - run: cargo clippy
          - working-directory: app
            run: |
              echo start
              cd rust
              cargo test --no-run
              cd nested
              cargo clippy
  `);
  assertEquals(
    result.checks.map((c) => [c.kind, c.workingDirectory]),
    [
      ["clippy", "rust"],
      ["clippy", "."],
      ["test-build", "app/rust"],
      ["clippy", "app/rust/nested"],
    ],
  );
  assertEquals(result.unverifiable, []);
});

Deno.test("a cd the scanner cannot follow makes the later cargo lines of that step unverifiable", () => {
  for (
    const unfollowable of [
      "cd $HOME/rust",
      "cd",
      "cd a b",
      "pushd rust",
      "popd",
      "cd rust || true",
      "if [ -d rust ]; then cd rust; fi",
      "for d in rust; do cd $d; done",
      "{ cd rust; }",
    ]
  ) {
    const result = scan(`
      on: pull_request
      jobs:
        lint:
          steps:
            - run: |
                ${unfollowable}
                cargo clippy --all-targets -- -D warnings
    `);
    assertEquals(result.checks, [], unfollowable);
    assertEquals(result.unverifiable.length, 1, unfollowable);
    assertStringIncludes(result.unverifiable[0]!, "cd form", unfollowable);
  }
});

Deno.test("nextest's --profile names a nextest profile and is not passed to cargo as a build profile", () => {
  const argvOf = (line: string) =>
    scan(`
      on: pull_request
      jobs:
        test:
          steps:
            - run: ${line}
    `).checks.map((c) => c.argv);
  assertEquals(argvOf("cargo nextest run --workspace --profile ci"), [[
    "cargo",
    "test",
    "--no-run",
    "--workspace",
  ]]);
  assertEquals(argvOf("cargo nextest run -P ci --locked"), [[
    "cargo",
    "test",
    "--no-run",
    "--locked",
  ]]);
  assertEquals(argvOf("cargo nextest run --profile=ci -p core"), [[
    "cargo",
    "test",
    "--no-run",
    "-p",
    "core",
  ]]);
  assertEquals(
    argvOf("cargo nextest run --cargo-profile release --profile ci"),
    [["cargo", "test", "--no-run", "--profile", "release"]],
  );
  assertEquals(argvOf("cargo nextest run --cargo-profile=release"), [[
    "cargo",
    "test",
    "--no-run",
    "--profile",
    "release",
  ]]);
  assertEquals(argvOf("cargo llvm-cov nextest --workspace --profile ci"), [[
    "cargo",
    "test",
    "--no-run",
    "--workspace",
  ]]);
  // cargo test and llvm-cov without nextest keep --profile as cargo's profile.
  assertEquals(argvOf("cargo test --profile release"), [[
    "cargo",
    "test",
    "--no-run",
    "--profile",
    "release",
  ]]);
  assertEquals(argvOf("cargo llvm-cov --profile release"), [[
    "cargo",
    "test",
    "--no-run",
    "--profile",
    "release",
  ]]);
});

Deno.test("a cd after a cd the scanner could not follow does not revive the directory", () => {
  const result = scan(`
    on: pull_request
    jobs:
      lint:
        steps:
          - run: |
              cd $HOME/tools
              cd rust
              cargo clippy --all-targets
  `);
  assertEquals(result.checks, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.unverifiable[0]!, "cd form");
});

Deno.test("a nextest --cargo-profile with no value after it keeps no profile", () => {
  const result = scan(`
    on: pull_request
    jobs:
      test:
        steps:
          - run: cargo nextest run --workspace --cargo-profile
  `);
  assertEquals(result.checks.map((c) => c.argv), [
    ["cargo", "test", "--no-run", "--workspace"],
  ]);
});

Deno.test("review 4896: optional jobs are skipped and expression policy is unverifiable", () => {
  for (
    const flag of ["true", '"true"', "false", "${{ matrix.experimental }}"]
  ) {
    const result = scan(`
      on: pull_request
      jobs:
        lint:
          continue-on-error: ${flag}
          steps:
            - uses: dtolnay/rust-toolchain@beta
            - run: cargo clippy --all-targets -- -D warnings
    `);
    assertEquals(result.checks.length, flag === "false" ? 1 : 0, flag);
    assertEquals(
      result.unverifiable.length,
      flag.includes("matrix") ? 1 : 0,
      flag,
    );
  }
  assertEquals(
    scan(`
    on: pull_request
    jobs:
      unrelated:
        continue-on-error: \${{ matrix.experimental }}
        steps:
          - run: echo hello
  `),
    { checks: [], unverifiable: [] },
  );
});
