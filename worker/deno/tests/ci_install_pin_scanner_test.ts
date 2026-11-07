/**
 * Tests for the native unpinned-CI-install pre-filer (Issue #3668, split
 * out of #3642).
 *
 * Two layers:
 *   - `findUnpinnedInstalls` — the promoted `run:`-level detector.
 *   - `scanCiInstallPins` — consolidation into one `BP-CI-INSTALL-PIN-…`
 *     finding per package coordinate, suppression, and dedup.
 *
 * Australian English throughout (behaviour, organisation).
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  type CiInstallPinFinding,
  findUnpinnedInstalls,
  scanCiInstallPins,
} from "../lib/ci_install_pin_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// findUnpinnedInstalls — the detector
// ---------------------------------------------------------------------------

Deno.test("findUnpinnedInstalls - reports package name and version", () => {
  const found = findUnpinnedInstalls("npm install -g pa11y-ci@3");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.tool, "npm");
  assertEquals(found[0]?.spec, "pa11y-ci@3");
  assertEquals(found[0]?.packageName, "pa11y-ci");
  assertEquals(found[0]?.version, "3");
});

Deno.test("findUnpinnedInstalls - unversioned install has a null version", () => {
  const found = findUnpinnedInstalls("npm install -g markdownlint-cli2");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.packageName, "markdownlint-cli2");
  assertEquals(found[0]?.version, null);
});

Deno.test("findUnpinnedInstalls - accepts an exact npm pin", () => {
  assertEquals(findUnpinnedInstalls("npm install -g http-server@14.1.1"), []);
});

Deno.test("findUnpinnedInstalls - scoped package name keeps its scope", () => {
  const found = findUnpinnedInstalls("npm install -g @scope/tool");
  assertEquals(found[0]?.packageName, "@scope/tool");
  assertEquals(findUnpinnedInstalls("npm install -g @scope/tool@1.0.0"), []);
});

Deno.test("findUnpinnedInstalls - flags explicit npx fetches only", () => {
  assertEquals(
    findUnpinnedInstalls("npx --yes wait-on http://x")[0]?.spec,
    "wait-on",
  );
  assertEquals(findUnpinnedInstalls("npx -y wait-on")[0]?.spec, "wait-on");
  assertEquals(
    findUnpinnedInstalls("npx --package wait-on -- x")[0]?.spec,
    "wait-on",
  );
  // Bare `npx <pkg>` resolves the lockfile-governed local binary.
  assertEquals(findUnpinnedInstalls("npx tsc -p ."), []);
  assertEquals(findUnpinnedInstalls("npx --yes wait-on@8.0.5"), []);
});

Deno.test("findUnpinnedInstalls - gem needs an exact -v", () => {
  const found = findUnpinnedInstalls("gem install bundler-audit");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.tool, "gem");
  assertEquals(found[0]?.packageName, "bundler-audit");
  assertEquals(findUnpinnedInstalls("gem install bundler-audit -v 0.9.3"), []);
  assertEquals(
    findUnpinnedInstalls("gem install bundler-audit -v 0.9")[0]?.version,
    "0.9",
  );
});

Deno.test("findUnpinnedInstalls - ignores comments and non-install commands", () => {
  assertEquals(
    findUnpinnedInstalls(
      [
        "# npm install -g example",
        "npm ci --ignore-scripts",
        'npm config set prefix "$HOME/.npm-global"',
        "bundle-audit check --update",
        "",
      ].join("\n"),
    ),
    [],
  );
});

Deno.test("findUnpinnedInstalls - ignores local, URL, and variable specs", () => {
  assertEquals(findUnpinnedInstalls("npm install -g ./local-tool"), []);
  assertEquals(findUnpinnedInstalls("npm install file:../pkg"), []);
  assertEquals(findUnpinnedInstalls("npm install -g https://x/y.tgz"), []);
  assertEquals(findUnpinnedInstalls('npm install -g "$TOOL"'), []);
});

Deno.test("findUnpinnedInstalls - inspects each chained command", () => {
  const found = findUnpinnedInstalls(
    "npm install -g tool-a@1.0.0 && npm install -g tool-b",
  );
  assertEquals(found.map((f) => f.spec), ["tool-b"]);
});

Deno.test("findUnpinnedInstalls - empty input yields no findings", () => {
  assertEquals(findUnpinnedInstalls(""), []);
});

// ---------------------------------------------------------------------------
// Command normalisation (Issue #3953) — prefixes, flags, continuations
// ---------------------------------------------------------------------------

Deno.test("findUnpinnedInstalls - strips a sudo prefix", () => {
  const found = findUnpinnedInstalls("sudo npm install -g pa11y-ci");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.tool, "npm");
  assertEquals(found[0]?.packageName, "pa11y-ci");
  assertEquals(findUnpinnedInstalls("sudo npm install -g pa11y-ci@3.1.0"), []);
});

Deno.test("findUnpinnedInstalls - strips sudo flags and their values", () => {
  assertEquals(
    findUnpinnedInstalls("sudo -E npm install -g pa11y-ci")[0]?.packageName,
    "pa11y-ci",
  );
  assertEquals(
    findUnpinnedInstalls("sudo -u ci npm install -g pa11y-ci")[0]?.packageName,
    "pa11y-ci",
  );
  assertEquals(
    findUnpinnedInstalls("sudo -- gem install bundler-audit")[0]?.tool,
    "gem",
  );
});

Deno.test("findUnpinnedInstalls - strips an env prefix and assignments", () => {
  assertEquals(
    findUnpinnedInstalls("FOO=bar npm install pkg")[0]?.packageName,
    "pkg",
  );
  assertEquals(
    findUnpinnedInstalls("env FOO=bar npm install pkg")[0]?.packageName,
    "pkg",
  );
  assertEquals(
    findUnpinnedInstalls("sudo env NODE_ENV=ci npx --yes wait-on")[0]?.tool,
    "npx",
  );
});

Deno.test("findUnpinnedInstalls - finds the subcommand past leading flags", () => {
  assertEquals(
    findUnpinnedInstalls("npm --global install pa11y-ci")[0]?.packageName,
    "pa11y-ci",
  );
  assertEquals(
    findUnpinnedInstalls("sudo npm -g install pa11y-ci")[0]?.packageName,
    "pa11y-ci",
  );
  assertEquals(
    findUnpinnedInstalls("gem --no-document install bundler-audit")[0]?.tool,
    "gem",
  );
  // A non-install subcommand behind a flag is still not an install.
  assertEquals(findUnpinnedInstalls("npm --silent ci"), []);
});

Deno.test("findUnpinnedInstalls - joins backslash line continuations", () => {
  const found = findUnpinnedInstalls(
    ["npm install -g \\", "  pa11y-ci \\", "  http-server"].join("\n"),
  );
  assertEquals(found.map((f) => f.packageName), ["pa11y-ci", "http-server"]);
  assert(found.every((f) => !f.packageName.includes("\\")));
  assertEquals(found[0]?.command, "npm install -g pa11y-ci http-server");
});

// ---------------------------------------------------------------------------
// scanCiInstallPins — consolidation
// ---------------------------------------------------------------------------

/** Build a workflow file whose single job runs the supplied commands. */
function workflow(path: string, job: string, runs: string[]): WorkflowFile {
  const rawText = [
    "name: CI",
    "on: pull_request",
    "jobs:",
    `  ${job}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...runs.flatMap((r) => ["      - run: |", `          ${r}`]),
  ].join("\n");
  return {
    path,
    rawText,
    parsed: {
      name: "CI",
      on: "pull_request",
      jobs: { [job]: { steps: runs.map((r) => ({ run: r })) } },
    },
    kind: "workflow",
  };
}

Deno.test("scanCiInstallPins - one finding per package coordinate", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g markdownlint-cli2",
    ]),
    workflow(".github/workflows/b.yml", "docs", [
      "npm install -g markdownlint-cli2",
      "gem install bundler-audit",
    ]),
  ]);

  assertEquals(findings.map((f) => f.findingId), [
    "BP-CI-INSTALL-PIN-gem-bundler-audit",
    "BP-CI-INSTALL-PIN-npm-markdownlint-cli2",
  ]);
  const md = findings[1] as CiInstallPinFinding;
  assertEquals(md.callSites.length, 2);
  assertEquals(md.severity, "medium");
  assertEquals(md.file, ".github/workflows/a.yml");
  assertStringIncludes(md.evidence, "2 call-sites:");
  assertStringIncludes(md.evidence, "`.github/workflows/b.yml`");
  assertStringIncludes(md.title, "markdownlint-cli2");
  assertStringIncludes(md.whyItMatters, "registry serves");
  // The postinstall carve-out: never push repos towards --ignore-scripts.
  assertStringIncludes(md.suggestedFix, "pa11y-ci");
});

Deno.test("scanCiInstallPins - pinned installs yield no findings", () => {
  assertEquals(
    scanCiInstallPins([
      workflow(".github/workflows/a.yml", "lint", [
        "npm install -g markdownlint-cli2@0.23.2",
        "npx --yes wait-on@8.0.5 http://localhost:8080",
        "gem install bundler-audit -v 0.9.3",
      ]),
    ]),
    [],
  );
});

Deno.test("scanCiInstallPins - cites the offending line", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "echo hello",
      "gem install bundler-audit",
    ]),
  ]);
  assertEquals(findings.length, 1);
  const site = findings[0]?.callSites[0];
  assertEquals(site?.job, "lint");
  assertEquals(site?.file, ".github/workflows/a.yml");
  // Line 10 is `          gem install bundler-audit` in the rendered YAML.
  assertEquals(site?.line, 10);
});

Deno.test("scanCiInstallPins - honours an in-source suppression marker", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const rawText = [
      "name: CI",
      "on: pull_request",
      "jobs:",
      "  lint:",
      "    steps:",
      "      - run: |",
      "          # best-practice-ignore: BP-CI-INSTALL-PIN-gem-bundler-audit — author=nigel expires=2099-12-31 pinned upstream",
      "          gem install bundler-audit",
    ].join("\n");
    const file: WorkflowFile = {
      path: ".github/workflows/a.yml",
      rawText,
      parsed: {
        jobs: { lint: { steps: [{ run: "gem install bundler-audit" }] } },
      },
      kind: "workflow",
    };
    assertEquals(scanCiInstallPins([file]), []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scanCiInstallPins - drops known-open and suppressed ids", () => {
  const files = [
    workflow(".github/workflows/a.yml", "lint", ["gem install bundler-audit"]),
  ];
  assertEquals(
    scanCiInstallPins(files, {
      knownOpenFindingIds: ["BP-CI-INSTALL-PIN-gem-bundler-audit"],
    }),
    [],
  );
  assertEquals(
    scanCiInstallPins(files, {
      suppressedIds: ["BP-CI-INSTALL-PIN-gem-bundler-audit"],
    }),
    [],
  );
});

Deno.test("scanCiInstallPins - scans composite action runs.steps", () => {
  const rawText = [
    "name: Setup",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - run: npm install -g http-server",
    "      shell: bash",
  ].join("\n");
  const findings = scanCiInstallPins([{
    path: ".github/actions/setup/action.yml",
    rawText,
    parsed: {
      runs: {
        using: "composite",
        steps: [{ run: "npm install -g http-server", shell: "bash" }],
      },
    },
    kind: "composite-action",
  }]);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.findingId, "BP-CI-INSTALL-PIN-npm-http-server");
  assertEquals(findings[0]?.callSites[0]?.job, "runs");
});

Deno.test("scanCiInstallPins - malformed input never throws", () => {
  assertEquals(scanCiInstallPins([]), []);
  assertEquals(
    scanCiInstallPins([
      { path: "a.yml", rawText: ":\n:", parsed: null, kind: "workflow" },
      { path: "b.yml", rawText: "", parsed: "scalar", kind: "workflow" },
      {
        path: "c.yml",
        rawText: "",
        parsed: { jobs: { a: { steps: "nope" } } },
        kind: "workflow",
      },
    ]),
    [],
  );
});

Deno.test("scanCiInstallPins - repeated installs anchor to distinct lines", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "gem install bundler-audit",
      "gem install bundler-audit",
    ]),
  ]);
  assertEquals(findings.length, 1);
  const lines = findings[0]?.callSites.map((s) => s.line);
  assertEquals(lines, [8, 10]);
});

Deno.test("scanCiInstallPins - assert every finding carries the BP- prefix", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g @scope/tool",
    ]),
  ]);
  assert(findings.every((f) => f.findingId.startsWith("BP-")));
  // Issue #3954: `@scope/tool` does not round-trip through the slug, so the
  // id carries a disambiguating digest of the raw package name. Before the
  // fix this was the shared `BP-CI-INSTALL-PIN-npm-scope-tool`.
  assertEquals(
    findings[0]?.findingId,
    "BP-CI-INSTALL-PIN-npm-scope-tool-9ff9b400e96c",
  );
});

// ---------------------------------------------------------------------------
// scanCiInstallPins — stable-id injectivity (Issue #3954)
// ---------------------------------------------------------------------------

Deno.test("scanCiInstallPins: finding ids are injective across @foo/bar, foo.bar, foo_bar", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g @foo/bar",
      "npm install -g foo.bar",
      "npm install -g foo_bar",
    ]),
  ]);

  assertEquals(findings.map((f) => f.packageName).sort(), [
    "@foo/bar",
    "foo.bar",
    "foo_bar",
  ]);
  const ids = findings.map((f) => f.findingId);
  assertEquals(new Set(ids).size, 3, `ids collided: ${ids.join(", ")}`);
  for (const id of ids) {
    assertMatch(id, /^BP-CI-INSTALL-PIN-npm-[a-z0-9-]*[a-z0-9]$/);
  }
});

Deno.test("scanCiInstallPins - suppressing @foo/bar does not silence foo.bar", () => {
  const files = [
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g @foo/bar",
      "npm install -g foo.bar",
    ]),
  ];
  const scoped = scanCiInstallPins(files)
    .find((f) => f.packageName === "@foo/bar") as CiInstallPinFinding;

  const remaining = scanCiInstallPins(files, {
    suppressedIds: [scoped.findingId],
  });
  assertEquals(remaining.map((f) => f.packageName), ["foo.bar"]);
});

Deno.test("scanCiInstallPins - punctuation-only specs never share an empty slug", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g %%%",
      "npm install -g +++",
    ]),
  ]);

  assertEquals(findings.length, 2);
  const ids = findings.map((f) => f.findingId);
  assertEquals(new Set(ids).size, 2, `ids collided: ${ids.join(", ")}`);
  for (const id of ids) {
    assert(
      id !== "BP-CI-INSTALL-PIN-npm-" && !id.endsWith("-"),
      `degenerate empty-slug id: ${id}`,
    );
    assertMatch(id, /^BP-CI-INSTALL-PIN-npm-[a-z0-9-]*[a-z0-9]$/);
  }
});

Deno.test("scanCiInstallPins - a round-tripping package name keeps its plain id", () => {
  // Names already in `[a-z0-9-]` form carry no digest, so ids already filed
  // for them stay stable across the Issue #3954 change.
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "npm install -g markdownlint-cli2",
      "gem install bundler-audit",
    ]),
  ]);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-CI-INSTALL-PIN-gem-bundler-audit",
    "BP-CI-INSTALL-PIN-npm-markdownlint-cli2",
  ]);
});

Deno.test("scanCiInstallPins - a continued command yields a clean id", () => {
  const rawText = [
    "name: CI",
    "on: push",
    "jobs:",
    "  lint:",
    "    steps:",
    "      - run: |",
    "          npm install -g \\",
    "            pa11y-ci",
  ].join("\n");
  const findings = scanCiInstallPins([{
    path: ".github/workflows/a.yml",
    rawText,
    parsed: {
      jobs: { lint: { steps: [{ run: "npm install -g \\\n  pa11y-ci" }] } },
    },
    kind: "workflow",
  }]);

  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.findingId, "BP-CI-INSTALL-PIN-npm-pa11y-ci");
  assert(findings.every((f) => !f.findingId.includes("\\")));
  // Anchored to the first physical line of the continued command.
  assertEquals(findings[0]?.callSites[0]?.line, 7);
});

Deno.test("scanCiInstallPins - detects sudo and global-flag spellings", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "sudo npm install -g pa11y-ci",
      "npm --global install http-server",
      "sudo gem install bundler-audit",
    ]),
  ]);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-CI-INSTALL-PIN-gem-bundler-audit",
    "BP-CI-INSTALL-PIN-npm-http-server",
    "BP-CI-INSTALL-PIN-npm-pa11y-ci",
  ]);
});

// ---------------------------------------------------------------------------
// cargo install (Issue #4683) — an exact version AND --locked
// ---------------------------------------------------------------------------

Deno.test("findUnpinnedInstalls - cargo install needs an exact version and --locked", () => {
  const bare = findUnpinnedInstalls("cargo install cargo-audit");
  assertEquals(bare.length, 1);
  assertEquals(bare[0]?.tool, "cargo");
  assertEquals(bare[0]?.packageName, "cargo-audit");
  assertEquals(bare[0]?.version, null);
  assertEquals(bare[0]?.unlocked, true);

  const locked = findUnpinnedInstalls("cargo install --locked cargo-audit");
  assertEquals(locked.length, 1);
  assertEquals(locked[0]?.version, null);
  assertEquals(locked[0]?.unlocked, false);

  const pinnedUnlocked = findUnpinnedInstalls(
    "cargo install cargo-audit --version 0.22.2",
  );
  assertEquals(pinnedUnlocked.length, 1);
  assertEquals(pinnedUnlocked[0]?.version, "0.22.2");
  assertEquals(pinnedUnlocked[0]?.unlocked, true);
});

Deno.test("findUnpinnedInstalls - accepts a cargo install that is exact and locked", () => {
  for (
    const run of [
      "cargo install --locked cargo-audit@0.22.2",
      "cargo install --locked cargo-audit --version 0.22.2",
      "cargo install --locked --version=0.22.2 cargo-audit",
      "cargo install --locked cargo-audit --vers 0.22.2",
      "cargo install --locked cargo-audit --vers=0.22.2",
      "cargo install cargo-audit@0.22.2 --locked",
      "cargo --locked install cargo-audit --version 0.22.2",
      "cargo install --frozen cargo-audit --version =0.22.2",
    ]
  ) {
    assertEquals(findUnpinnedInstalls(run), [], run);
  }
});

Deno.test("findUnpinnedInstalls - ignores non-install, local, git, and variable cargo runs", () => {
  for (
    const run of [
      "cargo install --locked --path .",
      "cargo install --frozen --git https://example.com/x cargo-x",
      "cargo build --locked",
      "cargo install",
      'cargo install --locked cargo-audit --version "$V"',
      "# cargo install cargo-audit",
    ]
  ) {
    assertEquals(findUnpinnedInstalls(run), [], run);
  }
});

Deno.test("findUnpinnedInstalls - external cargo sources still require a lock", () => {
  for (
    const run of [
      "cargo install --path .",
      "cargo install --git https://example.com/x cargo-x",
      "cargo install --git=https://example.com/x",
    ]
  ) {
    const found = findUnpinnedInstalls(run);
    assertEquals(found.length, 1, run);
    assertEquals(found[0]?.unlocked, true, run);
  }
});

Deno.test("cargo external findings identify sources and request locking only", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "cargo install --path .",
      "cargo install --git https://github.com/org/tool",
      "cargo install --git https://github.com/org/other named-crate",
    ]),
  ]);
  assertEquals(findings.length, 3);
  for (
    const [name, id] of [
      [".", "BP-CI-INSTALL-PIN-cargo-pkg-2b0c98f1b5d3"],
      [
        "https://github.com/org/tool",
        "BP-CI-INSTALL-PIN-cargo-https-github-com-org-tool-aa150d4ebb24",
      ],
      ["named-crate", "BP-CI-INSTALL-PIN-cargo-named-crate"],
    ]
  ) {
    const finding = findings.find((f) => f.packageName === name);
    assert(finding);
    assertEquals(finding.findingId, id);
    assertStringIncludes(finding.title, "Lock the CI install");
    assertStringIncludes(finding.suggestedFix, "--locked");
    assertEquals(finding.suggestedFix.includes("--version"), false);
  }
  assertEquals(new Set(findings.map((f) => f.findingId)).size, 3);
});

Deno.test("cargo quoted values and expressions do not become crates", () => {
  for (
    const run of [
      'cargo install --locked cargo-audit@0.22.2 --features "fix vendored-openssl"',
      "cargo install --locked cargo-audit@${{ env.CARGO_AUDIT_VERSION }}",
      "cargo install --locked cargo-audit --version ${{ env.V }}",
    ]
  ) assertEquals(findUnpinnedInstalls(run), [], run);
  assertEquals(
    findUnpinnedInstalls("cargo install cargo-audit --version ${{ env.V }}")
      .map((f) => f.packageName),
    ["cargo-audit"],
  );
});

Deno.test("cargo shell versions and command boundaries", () => {
  for (
    const run of [
      `cargo install --locked cargo-audit --version="$V"`,
      `cargo install --locked cargo-audit@"$V"`,
      `cargo install --locked cargo-audit --version='0.22.2'`,
      `cargo install --locked cargo-audit@"0.22.2"`,
      'cargo install --locked cargo-audit@"${{ inputs.v }}"',
      `cargo install --locked cargo-audit@0.22.2 & cargo install --locked cargo-edit@0.13.14 & wait`,
    ]
  ) assertEquals(findUnpinnedInstalls(run), [], run);
  for (
    const run of [
      `cargo install --locked cargo-audit@0.22.2 & cargo install other`,
      `node -e "\n console.log(1)\n" && npm install -g pa11y-ci`,
      `git commit -m 'chore: x\nbody' && cargo install other`,
      `if ! command -v cargo-audit; then cargo install other; fi`,
      `time cargo install other`,
      `(cargo install other)`,
    ]
  ) {
    assertEquals(findUnpinnedInstalls(run).map((f) => f.packageName), [
      run.includes("pa11y") ? "pa11y-ci" : "other",
    ], run);
  }
});

Deno.test("heredoc bodies and unfinished quotes do not hide later installs", () => {
  for (
    const [operator, install, name] of [
      ["<<'EOF'", "npm install -g pa11y-ci", "pa11y-ci"],
      ["<<EOF", "gem install bundler", "bundler"],
      ['<<-"EOF"', "cargo install cargo-audit", "cargo-audit"],
    ]
  ) {
    const run =
      `cat ${operator} > notes.md\nIt's done\nEOF\n${install}\necho "it's over"`;
    assertEquals(findUnpinnedInstalls(run).map((f) => f.packageName), [name]);
  }
  assertEquals(
    findUnpinnedInstalls("echo 'unfinished\nnpm install -g pa11y-ci")
      .map((f) => f.packageName),
    ["pa11y-ci"],
  );
  for (const prefix of ["echo '<<EOF'", "cat <<<word"]) {
    assertEquals(
      findUnpinnedInstalls(`${prefix}\nnpm install -g pa11y-ci`)
        .map((f) => f.packageName),
      ["pa11y-ci"],
    );
  }
  assertEquals(
    findUnpinnedInstalls(
      "cat <<A <<-'B'\nnpm install -g phantom\nA\nIt's done\n\tB\ncargo install cargo-audit",
    ).map((f) => f.packageName),
    ["phantom", "cargo-audit"],
  );
});

Deno.test("script bodies and full heredoc delimiters remain scanned", () => {
  for (
    const opener of [
      "bash <<'EOF'",
      "sudo sh -s <<EOF",
      "ssh deploy@host <<'EOF'",
      "docker run -i node:22 sh <<'EOF'",
    ]
  ) {
    assertEquals(
      findUnpinnedInstalls(`${opener}\nnpm install -g pa11y-ci\nEOF`)
        .map((f) => f.packageName),
      ["pa11y-ci"],
      opener,
    );
  }
  for (
    const opener of [
      `docker run --rm --entrypoint bash "$IMAGE" -c '`,
      `bash -c "`,
    ]
  ) {
    const close = opener.endsWith("'") ? "'" : '"';
    assertEquals(
      findUnpinnedInstalls(
        `${opener}\nset -euo pipefail\ngem install bundler\n${close} < /dev/null`,
      )
        .map((f) => f.packageName),
      ["bundler"],
      opener,
    );
  }
  for (const delimiter of ["END-OF-FILE", "EOF.md"]) {
    assertEquals(
      findUnpinnedInstalls(
        `cat <<${delimiter}\nIt's done\n${delimiter}\nnpm install -g pa11y-ci`,
      )
        .map((f) => f.packageName),
      ["pa11y-ci"],
      delimiter,
    );
  }
  for (const prefix of ["cat <<EOF\nunfinished", "echo $(( 1 << n ))"]) {
    assertEquals(
      findUnpinnedInstalls(`${prefix}\nnpm install -g pa11y-ci`)
        .map((f) => f.packageName),
      ["pa11y-ci"],
      prefix,
    );
  }
});

Deno.test("nested scripts normalise continuations and multiline strings", () => {
  for (
    const [opener, closer] of [
      ["bash <<'EOF'", "EOF"],
      [`docker run --rm --entrypoint bash "$IMAGE" -c '`, "' < /dev/null"],
    ]
  ) {
    for (
      const install of [
        "npm install -g \\\npa11y-ci@1.2.3",
        "gem install \\\nbundler -v 2.5.0",
        "cargo install --locked \\\ncargo-audit --version 0.22.2",
      ]
    ) {
      assertEquals(
        findUnpinnedInstalls(`${opener}\n${install}\n${closer}`),
        [],
      );
    }
    assertEquals(
      findUnpinnedInstalls(`${opener}\nnpm install -g \\\npa11y-ci\n${closer}`)
        .map((f) => f.packageName),
      ["pa11y-ci"],
    );
  }
  assertEquals(
    findUnpinnedInstalls(
      `bash <<'EOF'\necho "a\nb" && npm install -g pa11y-ci\nEOF`,
    ).map((f) => f.packageName),
    ["pa11y-ci"],
  );
});

Deno.test("heredoc delimiters and arithmetic preserve subsequent normalisation", () => {
  for (
    const prefix of [
      "cat <<END-OF-FILE\nIt's done\nEND-OF-FILE",
      "cat <<EOF.md\nIt's done\nEOF.md",
      "cat <<\\EOF\nhello\nEOF",
      `cat <<E"O"F\nhello\nEOF`,
      "(( x = 1 << 2 ))",
      "echo $(( 1 << n ))",
    ]
  ) {
    assertEquals(
      findUnpinnedInstalls(`${prefix}\necho "a\nb" && npm install -g pa11y-ci`)
        .map((f) => f.packageName),
      ["pa11y-ci"],
      prefix,
    );
    assertEquals(
      findUnpinnedInstalls(`${prefix}\nnpm install -g \\\npa11y-ci@1.2.3`),
      [],
      prefix,
    );
  }
  assertEquals(
    findUnpinnedInstalls("cat <<EOF\nunfinished\nnpm install -g \\\npa11y-ci")
      .map((f) => f.packageName),
    ["pa11y-ci"],
  );
  assertEquals(
    findUnpinnedInstalls(
      '(( x = 1 << 2 ))\necho "a\n2\nb" && npm install -g pa11y-ci',
    ).map((f) => f.packageName),
    ["pa11y-ci"],
  );
});

Deno.test("cargo expressions preserve logical operators and command boundaries", () => {
  for (
    const run of [
      "cargo install --locked cargo-audit --version ${{ inputs.version || '0.22.2' }}",
      "cargo install --locked cargo-audit@${{ inputs.version || '0.22.2' }}",
      "cargo install --locked cargo-audit --version ${{ github.event_name == 'push' && '0.22.2' || '0.22.1' }}",
      'cargo install --locked cargo-audit@0.22.2 --features "a || b"',
    ]
  ) assertEquals(findUnpinnedInstalls(run), [], run);
  assertEquals(
    findUnpinnedInstalls(
      "cargo install --locked cargo-audit@${{ inputs.version || '0.22.2' }} && cargo install other",
    ).map((f) => f.packageName),
    ["other"],
  );
});

Deno.test("cargo ignores shell comments and redirections", () => {
  for (
    const suffix of [
      "2>&1",
      "2>&1 | tee install.log",
      "> /dev/null",
      ">> log",
      "< input",
      "&> log",
      "2>log",
      "# pinned",
    ]
  ) {
    assertEquals(
      findUnpinnedInstalls(
        `cargo install --locked cargo-audit@0.22.2 ${suffix}`,
      ),
      [],
      suffix,
    );
  }
  assertEquals(
    findUnpinnedInstalls("cargo install cargo-audit # exact and locked")
      .map((f) => f.packageName),
    ["cargo-audit"],
  );
  assertEquals(
    findUnpinnedInstalls(
      "cargo install cargo-audit # comment && cargo install phantom",
    )
      .map((f) => f.packageName),
    ["cargo-audit"],
  );
  assertEquals(
    findUnpinnedInstalls(
      'cargo install --locked cargo-audit@0.22.2 --features "# feature"',
    ),
    [],
  );
});

Deno.test("findUnpinnedInstalls - flags cargo versions that are not exact", () => {
  for (
    const [run, version] of [
      ["cargo install --locked cargo-audit --version 0.22", "0.22"],
      ["cargo install --locked cargo-audit --vers 0.22", "0.22"],
      ["cargo install --locked cargo-audit@^0.22.2", "^0.22.2"],
      ["cargo install --locked cargo-audit@0.22", "0.22"],
    ] as const
  ) {
    const found = findUnpinnedInstalls(run);
    assertEquals(found.length, 1, run);
    assertEquals(found[0]?.version, version, run);
    assertEquals(found[0]?.packageName, "cargo-audit", run);
  }
});

Deno.test("findUnpinnedInstalls - cargo evasions still flag the unpinned install", () => {
  for (
    const [run, unlocked] of [
      ["sudo cargo install cargo-audit", true],
      ["env CARGO_TERM_COLOR=always cargo install --locked cargo-audit", false],
      ["cargo +stable install --locked cargo-audit", false],
      ["rustup update && cargo install cargo-audit --version 0.22.2", true],
      ["cargo install --locked --features foo cargo-audit", false],
      ["cargo install --root /usr/local cargo-audit", true],
    ] as const
  ) {
    const found = findUnpinnedInstalls(run);
    assertEquals(found.map((f) => f.packageName), ["cargo-audit"], run);
    assertEquals(found[0]?.unlocked, unlocked, run);
  }
});

Deno.test("findUnpinnedInstalls - cargo value flags do not leak their value as a crate", () => {
  for (
    const flag of [
      "--branch",
      "--tag",
      "--rev",
      "--root",
      "--registry",
      "--index",
      "-F",
      "--bin",
      "--example",
      "--target",
      "--target-dir",
      "--profile",
      "--jobs",
      "-j",
      "--config",
      "--color",
      "-Z",
      "--message-format",
      "--lockfile-path",
      "--manifest-path",
      "-C",
    ]
  ) {
    const run = `cargo install --locked ${flag} some-value cargo-audit`;
    assertEquals(
      findUnpinnedInstalls(run).map((f) => f.packageName),
      ["cargo-audit"],
      run,
    );
  }
});

Deno.test("findUnpinnedInstalls - npm, npx and gem findings are not marked unlocked", () => {
  for (
    const run of [
      "npm install -g pa11y-ci@3",
      "npx -y pa11y-ci",
      "gem install bundler",
    ]
  ) {
    const found = findUnpinnedInstalls(run);
    assertEquals(found.length, 1, run);
    assertEquals(found[0]?.unlocked, false, run);
  }
});

Deno.test("findUnpinnedInstalls - joins cargo backslash continuations onto the first line", () => {
  const found = findUnpinnedInstalls(
    ["cargo install \\", "  --locked \\", "  cargo-audit"].join("\n"),
  );
  assertEquals(found.map((f) => f.packageName), ["cargo-audit"]);
  assertEquals(found[0]?.anchor, "cargo install \\");
  assertEquals(found[0]?.unlocked, false);
});

Deno.test("findUnpinnedInstalls - hostile cargo input completes deterministically", () => {
  const repeatedFlags = `cargo install ${"--locked ".repeat(5000)}cargo-audit`;
  const first = findUnpinnedInstalls(repeatedFlags);
  assertEquals(first.map((f) => f.packageName), ["cargo-audit"]);
  assertEquals(first, findUnpinnedInstalls(repeatedFlags));

  const padded = `cargo install ${" ".repeat(5000)}${
    "- ".repeat(5000)
  }cargo-audit`;
  assertEquals(findUnpinnedInstalls(padded).map((f) => f.packageName), [
    "cargo-audit",
  ]);
});

Deno.test("scanCiInstallPins - cargo install gets the pin-and-lock finding", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", ["cargo install cargo-audit"]),
  ]);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-CI-INSTALL-PIN-cargo-cargo-audit",
  ]);
  const finding = findings[0] as CiInstallPinFinding;
  assertEquals(finding.tool, "cargo");
  assertStringIncludes(finding.title, "Pin and lock");
  assertEquals(finding.callSites[0]?.line, 8);
  assertEquals(finding.callSites[0]?.unlocked, true);
  assertStringIncludes(finding.evidence, "no `--locked`");
  assertStringIncludes(finding.whyItMatters, "re-resolves");
  assertStringIncludes(
    finding.suggestedFix,
    "cargo install --locked cargo-audit --version 1.2.3",
  );
});

Deno.test("scanCiInstallPins - a pinned and locked cargo install yields no finding", () => {
  assertEquals(
    scanCiInstallPins([
      workflow(".github/workflows/a.yml", "lint", [
        "cargo install --locked cargo-audit --version 0.22.2",
      ]),
    ]),
    [],
  );
});

Deno.test("scanCiInstallPins - cargo evidence marks only the unlocked call-sites", () => {
  const findings = scanCiInstallPins([
    workflow(".github/workflows/a.yml", "lint", [
      "cargo install --locked cargo-audit",
    ]),
    workflow(".github/workflows/b.yml", "docs", [
      "cargo install cargo-audit --version 0.22.2",
    ]),
  ]);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.callSites.map((s) => s.unlocked), [false, true]);
  const [, lockedLine, unlockedLine] = (findings[0]?.evidence ?? "").split(
    "\n",
  );
  assertEquals(
    lockedLine?.endsWith("`cargo install --locked cargo-audit`"),
    true,
  );
  assertEquals(unlockedLine?.endsWith("(no `--locked`)"), true);
});
