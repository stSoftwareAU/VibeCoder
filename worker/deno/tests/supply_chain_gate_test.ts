/**
 * Tests for the supply-chain posture gate (Issue #4192).
 *
 * The pure checks are driven over in-memory text and over fixture trees
 * built in temp directories: a clean tree, an unpinned `uses:`, an unfrozen
 * `deno` invocation, a tag-referenced container base image, a permissive
 * Renovate policy and a stale dependency inventory. Each must fail with its
 * own rule naming the file and line. The last test runs the gate over the
 * real repository tree, which must pass with no findings.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDependencyInventory,
  DENO_INVOCATION_ALLOWLIST,
  evaluateRenovatePolicy,
  findTagOnlyBaseImages,
  findUnfrozenDenoInvocations,
  findUnpinnedUses,
  formatGateReport,
  type GateFinding,
  runSupplyChainGate,
} from "../lib/supply_chain_gate.ts";
import { supplyChainGateCommand } from "../commands/supply_chain_gate.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const CONFIG = buildDefaultWorkerConfig();

const SHA_A = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA_B = "667a34cdef165d8d2b2e98dde39547c9daac7282";
const DIGEST_A =
  "sha256:a9d6c36be5d7bc09d275b6df5eba2e98db2e35fcfe132f1fd23cddd91e2d674b";
const DIGEST_B =
  "sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa";

// ---------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------

const CLEAN_WORKFLOW = `name: CI
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        # actions/checkout@v7.0.1
        uses: actions/checkout@${SHA_A}
        with:
          persist-credentials: false
      - name: Install Deno
        # denoland/setup-deno@v2.0.4
        uses: denoland/setup-deno@${SHA_B}
      - uses: ./.github/actions/local-thing
      - name: Gate
        run: |
          cd worker/deno
          deno run --frozen --lock=deno.lock --allow-read mod.ts supply-chain-gate
`;

const CLEAN_RUN_SH = `#!/usr/bin/env bash
# deno run mod.ts run-mode is resolved by the launcher (comment, not code)
DENO_CMD="deno"
if ! bounded 120 "\${DENO_CMD}" run \\
    --frozen --lock="\${BASE_DIR}/worker/deno/deno.lock" \\
    --allow-env --allow-read \\
    "\${BASE_DIR}/worker/deno/mod.ts" run-mode; then
  exit 1
fi
deno lint
`;

const CLEAN_CONTAINERFILE = `# fixture image
ARG DENO_IMAGE="denoland/deno:bin-2.9.5@${DIGEST_B}"
ARG BASE_IMAGE="ruby:3.4-trixie@${DIGEST_A}"

FROM \${DENO_IMAGE} AS deno

FROM \${BASE_IMAGE}
COPY --from=deno /deno /usr/local/bin/deno
RUN set -eu; \\
    deno cache --frozen --config /s/deno.json --lock /s/deno.lock /s/seed.ts; \\
    deno run --cached-only --allow-all npm:@example/pkg@1.0.0 --version
`;

const CLEAN_DENO_JSON = JSON.stringify(
  {
    tasks: {
      test: "deno test --frozen --lock=deno.lock --allow-read",
      lint: "deno lint",
    },
    imports: {
      "@std/assert": "jsr:@std/assert@^1.0.18",
    },
  },
  null,
  2,
);

const CLEAN_DENO_LOCK = JSON.stringify(
  {
    version: "5",
    specifiers: { "jsr:@std/assert@^1.0.18": "1.0.18" },
    jsr: {
      "@std/assert@1.0.18": {
        integrity:
          "270245e9c2c13b446286de475131dc688ca9abcd94fc5db41d43a219b34d1c78",
      },
    },
  },
  null,
  2,
);

const CLEAN_RENOVATE = JSON.stringify(
  {
    extends: ["config:recommended"],
    minimumReleaseAge: "24 hours",
    packageRules: [
      { matchManagers: ["deno"], enabled: false },
    ],
  },
  null,
  2,
);

const CLEAN_TOOLS_JSON = JSON.stringify(
  {
    images: [
      {
        name: "ruby",
        tag: "3.4-trixie",
        digest: DIGEST_A,
        arg: "BASE_IMAGE",
      },
    ],
    tools: [
      {
        name: "gh",
        version: "2.97.0",
        sha256: { amd64: "aa", arm64: "bb" },
      },
    ],
    toolchains: [
      { id: "shellcheck", version: "0.11.0", sha256: { amd64: "cc" } },
    ],
    providers: [
      { id: "claude", version: "2.1.223", sha256: { amd64: "dd" } },
    ],
  },
  null,
  2,
);

/** Every file of the clean fixture tree, keyed by repo-relative path. */
function cleanTree(): Record<string, string> {
  return {
    ".github/workflows/ci.yml": CLEAN_WORKFLOW,
    "run.sh": CLEAN_RUN_SH,
    "container/Containerfile": CLEAN_CONTAINERFILE,
    "container/tools.json": CLEAN_TOOLS_JSON,
    "worker/deno/deno.json": CLEAN_DENO_JSON,
    "worker/deno/deno.lock": CLEAN_DENO_LOCK,
    "renovate.json": CLEAN_RENOVATE,
    ".deno-version": "2.9.5\n",
    ".node-version": "24.19.0\n",
  };
}

/** Write `files` under a fresh temp dir and return its path. */
async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "supply-chain-gate-" });
  for (const [rel, text] of Object.entries(files)) {
    const abs = `${root}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, text);
  }
  return root;
}

/** Build a clean tree with a current inventory committed. */
async function makeCleanTreeWithInventory(): Promise<string> {
  const root = await makeTree(cleanTree());
  const inventory = await buildDependencyInventory(root);
  await Deno.mkdir(`${root}/docs/audits`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/audits/dependency-inventory.md`,
    inventory,
  );
  return root;
}

function rules(findings: readonly GateFinding[]): string[] {
  return findings.map((f) => f.rule);
}

// ---------------------------------------------------------------------------
// (a) `uses:` SHA pins
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: findUnpinnedUses flags a tag ref with file, line and rule", () => {
  const text = "steps:\n  - uses: actions/checkout@v4\n";
  const findings = findUnpinnedUses(".github/workflows/ci.yml", text);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.rule, "action-sha-pin");
  assertEquals(f.file, ".github/workflows/ci.yml");
  assertEquals(f.line, 2);
  assertStringIncludes(f.message, "actions/checkout@v4");
});

Deno.test("supply-chain-gate: findUnpinnedUses flags a branch ref and a first-party tag", () => {
  const text = [
    "  - uses: some/action@main",
    "  # example-org/private-repo-59@v1",
    "  - uses: example-org/private-repo-59@v1",
  ].join("\n");
  const findings = findUnpinnedUses("wf.yml", text);
  assertEquals(rules(findings), ["action-sha-pin", "action-sha-pin"]);
});

Deno.test("supply-chain-gate: findUnpinnedUses accepts a 40-hex SHA with a version comment", () => {
  const text =
    `  # actions/checkout@v7.0.1\n  - uses: actions/checkout@${SHA_A}\n`;
  assertEquals(findUnpinnedUses("wf.yml", text), []);
});

Deno.test("supply-chain-gate: findUnpinnedUses requires the version comment beside a SHA pin", () => {
  const text = `  - uses: actions/checkout@${SHA_A}\n`;
  const findings = findUnpinnedUses("wf.yml", text);
  assertEquals(rules(findings), ["action-pin-comment"]);
  assertEquals(findings[0]!.line, 1);
});

Deno.test("supply-chain-gate: findUnpinnedUses accepts a version comment up to three lines above", () => {
  const text = [
    "  # denoland/setup-deno@v2.0.4",
    "  - if: steps.detect.outputs.present == 'true'",
    `    uses: denoland/setup-deno@${SHA_B}`,
  ].join("\n");
  assertEquals(findUnpinnedUses("wf.yml", text), []);
});

Deno.test("supply-chain-gate: findUnpinnedUses exempts local ./ actions only", () => {
  const text = [
    "  - uses: ./.github/actions/local",
    "  - uses: docker://alpine:3.20",
  ].join("\n");
  const findings = findUnpinnedUses("wf.yml", text);
  assertEquals(rules(findings), ["action-sha-pin"]);
  assertStringIncludes(findings[0]!.message, "docker://alpine:3.20");
});

// ---------------------------------------------------------------------------
// (b) frozen deno invocations
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations flags a bare deno run", () => {
  const text = "set -e\ndeno run --allow-read worker/deno/mod.ts version\n";
  const findings = findUnfrozenDenoInvocations("run.sh", text);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.rule, "deno-frozen");
  assertEquals(findings[0]!.line, 2);
  assertStringIncludes(findings[0]!.message, "--frozen");
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations accepts --frozen on a continuation line", () => {
  assertEquals(findUnfrozenDenoInvocations("run.sh", CLEAN_RUN_SH), []);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations treats --frozen=false as unfrozen", () => {
  const text = "deno test --frozen=false --allow-read\n";
  assertEquals(rules(findUnfrozenDenoInvocations("x.sh", text)), [
    "deno-frozen",
  ]);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations accepts --cached-only", () => {
  const text = "deno run --cached-only --allow-all npm:@x/y@1.0.0 --version\n";
  assertEquals(findUnfrozenDenoInvocations("Containerfile", text), []);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations judges each command in a RUN chain separately", () => {
  const text = [
    "RUN set -eu; \\",
    "    deno cache --config s/deno.json --lock s/deno.lock s/seed.ts; \\",
    "    deno run --frozen --allow-all npm:@x/y@1.0.0 --version",
  ].join("\n");
  const findings = findUnfrozenDenoInvocations("container/Containerfile", text);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.line, 2);
  assertStringIncludes(findings[0]!.message, "deno cache");
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations ignores comments, non-resolving subcommands and exec -a titles", () => {
  const text = [
    "# deno run mod.ts run-mode (prose)",
    "deno lint",
    "deno fmt --check",
    "deno audit",
    "deno task test",
    "bash -c \"exec -a 'deno run mod.ts run-entrypoint' sleep 300\" &",
    "echo 'loop.sh: cannot record (deno or mod missing)'",
  ].join("\n");
  assertEquals(findUnfrozenDenoInvocations("x.sh", text), []);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations covers deno check, test, cache, install, compile and eval", () => {
  const text = [
    "deno check '**/*.ts'",
    "deno test --allow-read",
    "deno cache mod.ts",
    "deno install --allow-read -n x mod.ts",
    "deno compile mod.ts",
    "deno eval 'console.log(1)'",
  ].join("\n");
  assertEquals(findUnfrozenDenoInvocations("x.sh", text).length, 6);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations scans deno.json tasks", () => {
  const text = JSON.stringify({
    tasks: {
      test: "deno test --allow-read",
      quality: "deno run --frozen --lock=deno.lock quality.ts",
      lint: "deno lint",
    },
  });
  const findings = findUnfrozenDenoInvocations("worker/deno/deno.json", text);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0]!.message, "task 'test'");
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations understands PowerShell argument arrays", () => {
  const frozen = [
    "Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(",
    '    "run",',
    '    "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",',
    '    "$BaseDir/worker/deno/mod.ts", "run-mode"',
    ")",
    '& $deno @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $SetupCli)',
    "$answer = & $DenoCmd.Source run `",
    '    "--frozen" "--lock=$ScriptDir/worker/deno/deno.lock" `',
    '    "$WorkerMod" container-restart-backoff',
    '$argv = @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $Cli) +',
    "    $Arguments",
    "& $deno @argv",
  ].join("\n");
  assertEquals(findUnfrozenDenoInvocations("run.ps1", frozen), []);

  const unfrozen = [
    "Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(",
    '    "run",',
    '    "$BaseDir/worker/deno/mod.ts", "run-mode"',
    ")",
    '$argv = @("run", "--allow-all", $Cli)',
  ].join("\n");
  const findings = findUnfrozenDenoInvocations("run.ps1", unfrozen);
  assertEquals(findings.map((f) => f.line), [1, 5]);
});

Deno.test("supply-chain-gate: findUnfrozenDenoInvocations honours the justified allowlist", () => {
  const text = "deno eval 'const x = 1;'\n";
  const allow = [{
    file: "audit.sh",
    match: "deno eval 'const x",
    reason: "inline source with no imports",
  }];
  assertEquals(findUnfrozenDenoInvocations("audit.sh", text, allow), []);
  assertEquals(findUnfrozenDenoInvocations("other.sh", text, allow).length, 1);
});

Deno.test("supply-chain-gate: every built-in allowlist entry carries a reason", () => {
  assert(DENO_INVOCATION_ALLOWLIST.length > 0);
  for (const entry of DENO_INVOCATION_ALLOWLIST) {
    assert(entry.reason.trim().length > 20, `${entry.file}: ${entry.match}`);
  }
});

// ---------------------------------------------------------------------------
// (c) container base images
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: findTagOnlyBaseImages flags a tag-only FROM", () => {
  const text = "FROM ruby:3.4-trixie\nRUN true\n";
  const findings = findTagOnlyBaseImages("container/Containerfile", text);
  assertEquals(rules(findings), ["container-base-digest"]);
  assertEquals(findings[0]!.line, 1);
  assertStringIncludes(findings[0]!.message, "ruby:3.4-trixie");
});

Deno.test("supply-chain-gate: findTagOnlyBaseImages resolves ARG defaults and exempts stage names", () => {
  assertEquals(
    findTagOnlyBaseImages("container/Containerfile", CLEAN_CONTAINERFILE),
    [],
  );
  const tagged = CLEAN_CONTAINERFILE.replace(
    `ruby:3.4-trixie@${DIGEST_A}`,
    "ruby:3.4-trixie",
  );
  const findings = findTagOnlyBaseImages("container/Containerfile", tagged);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0]!.message, "BASE_IMAGE");
});

Deno.test("supply-chain-gate: findTagOnlyBaseImages rejects a malformed digest", () => {
  const text = "FROM ruby:3.4@sha256:abc\n";
  assertEquals(rules(findTagOnlyBaseImages("Containerfile", text)), [
    "container-base-digest",
  ]);
});

// ---------------------------------------------------------------------------
// (d) Renovate policy
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: evaluateRenovatePolicy accepts the repository's shape", () => {
  assertEquals(
    evaluateRenovatePolicy("renovate.json", JSON.parse(CLEAN_RENOVATE)),
    [],
  );
});

Deno.test("supply-chain-gate: evaluateRenovatePolicy rejects top-level automerge", () => {
  const findings = evaluateRenovatePolicy("renovate.json", {
    minimumReleaseAge: "24 hours",
    automerge: true,
  });
  assertEquals(rules(findings), ["renovate-automerge"]);
});

Deno.test("supply-chain-gate: evaluateRenovatePolicy allows automerge only for pin-class updates", () => {
  const ok = evaluateRenovatePolicy("renovate.json", {
    minimumReleaseAge: "24 hours",
    packageRules: [
      { matchUpdateTypes: ["pin", "pinDigest"], automerge: true },
    ],
  });
  assertEquals(ok, []);
  const bad = evaluateRenovatePolicy("renovate.json", {
    minimumReleaseAge: "24 hours",
    packageRules: [
      { matchUpdateTypes: ["minor", "patch"], automerge: true },
      { matchPackageNames: ["foo"], automerge: true },
    ],
  });
  assertEquals(rules(bad), ["renovate-automerge", "renovate-automerge"]);
});

Deno.test("supply-chain-gate: evaluateRenovatePolicy rejects automerge presets and nested automerge", () => {
  const findings = evaluateRenovatePolicy("renovate.json", {
    extends: ["config:recommended", ":automergeMinor"],
    minimumReleaseAge: "24 hours",
    lockFileMaintenance: { enabled: true, automerge: true },
  });
  assertEquals(rules(findings), ["renovate-automerge", "renovate-automerge"]);
});

Deno.test("supply-chain-gate: evaluateRenovatePolicy requires the release-age quarantine", () => {
  const findings = evaluateRenovatePolicy("renovate.json", {
    extends: ["config:recommended"],
  });
  assertEquals(rules(findings), ["renovate-release-age"]);
});

// ---------------------------------------------------------------------------
// (e) inventory + whole-tree gate
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: buildDependencyInventory is deterministic and lists every source", async () => {
  const root = await makeTree(cleanTree());
  const first = await buildDependencyInventory(root);
  const second = await buildDependencyInventory(root);
  assertEquals(first, second);
  assertStringIncludes(first, "actions/checkout");
  assertStringIncludes(first, SHA_A);
  assertStringIncludes(first, "v7.0.1");
  assertStringIncludes(first, "ruby:3.4-trixie");
  assertStringIncludes(first, DIGEST_A);
  assertStringIncludes(first, "jsr:@std/assert@^1.0.18");
  assertStringIncludes(first, "1.0.18");
  assertStringIncludes(first, "2.9.5");
  assertStringIncludes(first, "24.19.0");
  assertStringIncludes(first, "shellcheck");
  assert(!/20\d\d-\d\d-\d\d/.test(first), "no timestamps in the inventory");
});

Deno.test("supply-chain-gate: a clean tree with a current inventory passes", async () => {
  const root = await makeCleanTreeWithInventory();
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(report.findings, []);
  assert(report.ok);
  assertStringIncludes(formatGateReport(report), "no findings");
});

Deno.test("supply-chain-gate: a stale inventory fails with inventory-stale", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/docs/audits/dependency-inventory.md`,
    "# old\n",
  );
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["inventory-stale"]);
  assertStringIncludes(report.findings[0]!.message, "--write-inventory");
});

Deno.test("supply-chain-gate: a missing inventory fails with inventory-stale", async () => {
  const root = await makeTree(cleanTree());
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["inventory-stale"]);
});

Deno.test("supply-chain-gate: introducing actions/checkout@v4 fails naming file, line and rule", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/.github/workflows/extra.yml`,
    "jobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n",
  );
  const report = await runSupplyChainGate({ repoDir: root });
  // The new action also enters the inventory (verdict UNPINNED), so the
  // committed inventory goes stale at the same time.
  assertEquals(rules(report.findings), ["action-sha-pin", "inventory-stale"]);
  const text = formatGateReport(report);
  assertStringIncludes(text, ".github/workflows/extra.yml:4: [action-sha-pin]");
});

Deno.test("supply-chain-gate: removing --frozen from run.sh fails", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/run.sh`,
    CLEAN_RUN_SH.replace("--frozen ", ""),
  );
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["deno-frozen"]);
  assertEquals(report.findings[0]!.file, "run.sh");
  assertEquals(report.findings[0]!.line, 4);
});

Deno.test("supply-chain-gate: an unfrozen deno.json task fails", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/worker/deno/deno.json`,
    CLEAN_DENO_JSON.replace("--frozen --lock=deno.lock ", ""),
  );
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["deno-frozen"]);
  assertEquals(report.findings[0]!.file, "worker/deno/deno.json");
});

Deno.test("supply-chain-gate: a tag-referenced container base fails", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/container/Containerfile`,
    CLEAN_CONTAINERFILE.replace(`@${DIGEST_A}`, ""),
  );
  const report = await runSupplyChainGate({ repoDir: root });
  // The inventory records the digest too, so it goes stale as well.
  assertEquals(rules(report.findings), [
    "container-base-digest",
    "inventory-stale",
  ]);
});

Deno.test("supply-chain-gate: a permissive Renovate policy fails", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/renovate.json`,
    JSON.stringify({ minimumReleaseAge: "24 hours", automerge: true }),
  );
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["renovate-automerge"]);
});

Deno.test("supply-chain-gate: a malformed renovate.json fails loud", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(`${root}/renovate.json`, "{ not json");
  const report = await runSupplyChainGate({ repoDir: root });
  assertEquals(rules(report.findings), ["renovate-parse"]);
});

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: command writes the inventory then passes", async () => {
  const root = await makeTree(cleanTree());
  const written = await supplyChainGateCommand.execute({
    repo: root,
    "write-inventory": true,
  }, CONFIG);
  assert(written.success, written.message);
  const inventory = await Deno.readTextFile(
    `${root}/docs/audits/dependency-inventory.md`,
  );
  assertStringIncludes(inventory, "actions/checkout");

  const again = await supplyChainGateCommand.execute({ repo: root }, CONFIG);
  assert(again.success, again.message);
  assertStringIncludes(again.message, "no findings");
});

Deno.test("supply-chain-gate: command fails on an unpinned action and names it", async () => {
  const root = await makeCleanTreeWithInventory();
  await Deno.writeTextFile(
    `${root}/.github/workflows/extra.yml`,
    "jobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n",
  );
  const result = await supplyChainGateCommand.execute({ repo: root }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "extra.yml:4");
  assertStringIncludes(result.message, "action-sha-pin");
});

Deno.test("supply-chain-gate: command honours --inventory", async () => {
  const root = await makeTree(cleanTree());
  const written = await supplyChainGateCommand.execute({
    repo: root,
    inventory: "docs/audits/custom.md",
    "write-inventory": true,
  }, CONFIG);
  assert(written.success, written.message);
  await Deno.stat(`${root}/docs/audits/custom.md`);
  const checked = await supplyChainGateCommand.execute({
    repo: root,
    inventory: "docs/audits/custom.md",
  }, CONFIG);
  assert(checked.success, checked.message);
});

// ---------------------------------------------------------------------------
// The real repository tree
// ---------------------------------------------------------------------------

Deno.test("supply-chain-gate: the real repository tree passes with no findings", async () => {
  const repoDir = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const report = await runSupplyChainGate({ repoDir });
  assertEquals(report.findings, [], formatGateReport(report));
  assert(report.checked.usesReferences > 10, "workflow uses: were scanned");
  assert(report.checked.denoInvocations > 10, "deno invocations were scanned");
  assert(report.checked.baseImages >= 2, "container base images were scanned");
});
