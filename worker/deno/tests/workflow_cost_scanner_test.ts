/**
 * Tests for workflow_cost_scanner.ts — the deterministic cost and speed
 * pre-pass behind github-actions-audit checks 37–41 (Issue #2578).
 *
 * The regression fixture is GRQ-AutoTrader's `quality.yml` and `deploy.yml`
 * as they stood before GRQ-AutoTrader#451 (cargo caching), #453 (parallel
 * deploy jobs) and #531 (reuse the Rust build) — trimmed of their comments
 * and of steps that play no part in cost, but structurally unchanged. The
 * scan never raised any of those wins; each was found by hand. The clean
 * fixture is the same repository after those changes landed, plus path
 * gating: it must yield nothing.
 *
 * Every test runs the real `scanWorkflowCost` against in-memory
 * `WorkflowFile` fixtures — no filesystem, no network.
 *
 * Australian English throughout (behaviour, organisation, artefact).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  type CostCandidate,
  renderCostCandidates,
  scanWorkflowCost,
} from "../lib/workflow_cost_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(path: string, rawText: string): WorkflowFile {
  return { path, rawText, parsed: parseYaml(rawText), kind: "workflow" };
}

const CHECKOUT =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
const SETUP_DENO =
  "denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5";
const UPLOAD =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1";
const DOWNLOAD =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";
const RUST_CACHE =
  "Swatinem/rust-cache@98c8021b550208e191a6a3145459bfc9fb29c4c0 # v2.8.0";
const PATHS_FILTER =
  "dorny/paths-filter@de90cc6fb38fc0963ad72b210f1f284cd68cea36 # v3.0.2";

// ---------------------------------------------------------------------------
// Ground truth: GRQ-AutoTrader before #451, #453 and #531
// ---------------------------------------------------------------------------

const GRQ_QUALITY_BEFORE = `name: Quality
on:
  pull_request:
    branches: [Develop, main, milestone/*]
  push:
    branches: [Develop]
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  format:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${CHECKOUT}
      - run: rustup show active-toolchain || rustup toolchain install
      - run: cargo fmt --all -- --check
  clippy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${CHECKOUT}
      - run: rustup component add clippy
      - run: cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${CHECKOUT}
      - run: cargo test --workspace --all-features --locked
      - run: cargo run --locked --bin autotrader-local -- fixtures/shadow-evaluation/basic.json
  markdownlint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${CHECKOUT}
      - uses: ${SETUP_NODE}
        with:
          node-version: "lts/*"
      - run: npm install -g markdownlint-cli2@0.23.2
      - run: markdownlint-cli2
  lambda-artifact:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ${CHECKOUT}
      - run: .github/scripts/lambda-artifact.sh
      - uses: ${UPLOAD}
        with:
          name: bootstrap-zip
          path: target/lambda/bootstrap.zip
  gate:
    if: always()
    needs: [format, clippy, test, markdownlint, lambda-artifact]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: .github/scripts/gate.sh
`;

const GRQ_DEPLOY_BEFORE = `name: Deploy
on:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: deploy-production
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: ${CHECKOUT}
      - run: rustup show active-toolchain || rustup toolchain install
      - name: cargo fmt --check
        run: cargo fmt --all -- --check
      - name: cargo clippy (warnings denied)
        run: cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
      - name: cargo test
        run: cargo test --workspace --all-features --locked
      - name: cargo build --release
        run: cargo build --workspace --release --locked
      - uses: ${SETUP_DENO}
        with:
          deno-version: v2.x
      - name: Build the reporting PWA
        working-directory: web
        run: deno task build
      - name: Build, package and validate the Lambda zip
        run: .github/scripts/lambda-artifact.sh
      - uses: ${UPLOAD}
        with:
          name: release-artifact
          path: dist/
  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 60
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: ${DOWNLOAD}
        with:
          name: release-artifact
      - run: aws cloudformation deploy --template-file infra/application.yaml --stack-name grq
`;

// ---------------------------------------------------------------------------
// Clean: caching, path gating, parallel jobs, deploy reuses the CI artefact
// ---------------------------------------------------------------------------

const CLEAN_QUALITY = `name: Quality
on:
  pull_request:
    branches: [Develop, main, milestone/*]
  push:
    branches: [Develop]
permissions:
  contents: read
jobs:
  changes:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      rust: \${{ steps.filter.outputs.rust }}
      web: \${{ steps.filter.outputs.web }}
    steps:
      - uses: ${CHECKOUT}
      - id: filter
        uses: ${PATHS_FILTER}
        with:
          filters: |
            rust: ['crates/**', 'Cargo.lock']
            web: ['web/**']
  clippy:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${CHECKOUT}
      - uses: ${RUST_CACHE}
      - run: cargo clippy --workspace --all-targets --locked -- -D warnings
  test:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${CHECKOUT}
      - uses: ${RUST_CACHE}
      - run: cargo test --workspace --locked
  web:
    needs: changes
    if: needs.changes.outputs.web == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${CHECKOUT}
      - uses: ${SETUP_NODE}
        with:
          node-version: "lts/*"
          cache: npm
      - run: npm ci
      - run: npm test
  lambda-artifact:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ${CHECKOUT}
      - uses: ${RUST_CACHE}
      - run: .github/scripts/lambda-artifact.sh
      - uses: ${UPLOAD}
        with:
          name: bootstrap-zip
          path: target/lambda/bootstrap.zip
  gate:
    if: always()
    needs: [changes, clippy, test, web, lambda-artifact]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: .github/scripts/gate.sh
`;

const CLEAN_DEPLOY = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      run-id:
        description: The Quality run whose verified artefact to deploy
        required: true
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production
    permissions:
      contents: read
      actions: read
      id-token: write
    steps:
      - uses: ${DOWNLOAD}
        with:
          name: bootstrap-zip
          run-id: \${{ inputs.run-id }}
          github-token: \${{ github.token }}
      - run: aws cloudformation deploy --template-file infra/application.yaml --stack-name grq
`;

/** The checks a candidate list covers, sorted and de-duplicated. */
function checksOf(candidates: readonly CostCandidate[]): number[] {
  return [...new Set(candidates.map((c) => c.check))].sort((a, b) => a - b);
}

function candidatesFor(
  candidates: readonly CostCandidate[],
  check: number,
): CostCandidate[] {
  return candidates.filter((c) => c.check === check);
}

// ---------------------------------------------------------------------------
// Regression against ground truth
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowCost - GRQ-AutoTrader before #451/#453/#531 yields 37, 39, 40 and 41", () => {
  const candidates = scanWorkflowCost([
    wf(".github/workflows/deploy.yml", GRQ_DEPLOY_BEFORE),
    wf(".github/workflows/quality.yml", GRQ_QUALITY_BEFORE),
  ]);
  const checks = checksOf(candidates);
  for (const expected of [37, 39, 40, 41]) {
    assert(
      checks.includes(expected),
      `expected a check ${expected} candidate, got ${JSON.stringify(checks)}`,
    );
  }
});

Deno.test("scanWorkflowCost - the GRQ candidates cite the jobs the hand-filed fixes changed", () => {
  const candidates = scanWorkflowCost([
    wf(".github/workflows/deploy.yml", GRQ_DEPLOY_BEFORE),
    wf(".github/workflows/quality.yml", GRQ_QUALITY_BEFORE),
  ]);

  // 37: Quality runs every job on every PR and push, with no change gating.
  const scoped = candidatesFor(candidates, 37);
  assertEquals(scoped.map((c) => c.file), [".github/workflows/quality.yml"]);

  // 39 (#451): every cargo job compiles from nothing, in both workflows.
  const cacheJobs = candidatesFor(candidates, 39).map((c) =>
    `${c.file}#${c.job}`
  );
  for (
    const job of [
      ".github/workflows/quality.yml#clippy",
      ".github/workflows/quality.yml#test",
      ".github/workflows/deploy.yml#build",
    ]
  ) {
    assert(cacheJobs.includes(job), `no cache candidate for ${job}`);
  }
  // `cargo fmt` compiles nothing, and a global tool install has no lockfile
  // for `setup-node`'s cache to key on.
  assert(!cacheJobs.includes(".github/workflows/quality.yml#format"));
  assert(!cacheJobs.includes(".github/workflows/quality.yml#markdownlint"));

  // 40 (#453): deploy's build job lints, tests and builds back to back.
  const serial = candidatesFor(candidates, 40);
  assertEquals(serial.map((c) => `${c.file}#${c.job}`), [
    ".github/workflows/deploy.yml#build",
  ]);

  // 41 (#531): deploy rebuilds the Lambda zip Quality already built.
  const rebuild = candidatesFor(candidates, 41);
  assertEquals(rebuild.length, 1);
  assertEquals(rebuild[0]!.file, ".github/workflows/deploy.yml");
  assertStringIncludes(rebuild[0]!.detail, "lambda-artifact.sh");
  assertStringIncludes(rebuild[0]!.detail, ".github/workflows/quality.yml");
});

Deno.test("scanWorkflowCost - a repo already caching, path-gating and running in parallel yields nothing", () => {
  const candidates = scanWorkflowCost([
    wf(".github/workflows/deploy.yml", CLEAN_DEPLOY),
    wf(".github/workflows/quality.yml", CLEAN_QUALITY),
  ]);
  assertEquals(candidates, []);
});

// ---------------------------------------------------------------------------
// Check 37 — runs only when relevant
// ---------------------------------------------------------------------------

const TEST_JOB = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: deno test
`;

Deno.test("scanWorkflowCost - 37: a paths filter on every event scopes the workflow", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `on:\n  push:\n    paths: ['src/**']\n  pull_request:\n    paths-ignore: ['docs/**']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 37), []);
});

Deno.test("scanWorkflowCost - 37: a paths filter on only one of push and pull_request still flags", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `on:\n  push:\n    paths: ['src/**']\n  pull_request:\n${TEST_JOB}`,
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 37).length, 1);
});

Deno.test("scanWorkflowCost - 37: a scalar or list trigger with no filter flags", () => {
  for (const on of ["on: push", "on: [push, pull_request]"]) {
    const files = [wf(".github/workflows/ci.yml", `${on}\n${TEST_JOB}`)];
    assertEquals(
      candidatesFor(scanWorkflowCost(files), 37).length,
      1,
      `expected a 37 candidate for '${on}'`,
    );
  }
});

Deno.test("scanWorkflowCost - 37: schedule and dispatch-only workflows are out of scope", () => {
  const files = [
    wf(
      ".github/workflows/nightly.yml",
      `on:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\n${TEST_JOB}`,
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 37), []);
});

// ---------------------------------------------------------------------------
// Check 39 — cached from previous runs
// ---------------------------------------------------------------------------

function job(steps: string): string {
  return `on: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
}

Deno.test("scanWorkflowCost - 39: setup-node installing from a lockfile with no cache flags", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      job(`      - uses: ${SETUP_NODE}\n      - run: npm ci\n`),
    ),
  ];
  const found = candidatesFor(scanWorkflowCost(files), 39);
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!.detail, "actions/setup-node");
});

Deno.test("scanWorkflowCost - 39: setup-node with a cache input, or an actions/cache step, is clean", () => {
  const withInput = job(
    `      - uses: ${SETUP_NODE}\n        with:\n          cache: npm\n      - run: npm ci\n`,
  );
  const withCache = job(
    `      - uses: ${SETUP_NODE}\n      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4\n        with:\n          path: ~/.npm\n          key: npm-\${{ hashFiles('package-lock.json') }}\n      - run: npm ci\n`,
  );
  for (const text of [withInput, withCache]) {
    const files = [wf(".github/workflows/ci.yml", text)];
    assertEquals(candidatesFor(scanWorkflowCost(files), 39), []);
  }
});

Deno.test("scanWorkflowCost - 39: a cache key unique to the run with no restore-keys flags", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      job(
        `      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4\n        with:\n          path: target\n          key: cargo-\${{ github.run_id }}\n      - run: cargo build --locked\n`,
      ),
    ),
  ];
  const found = candidatesFor(scanWorkflowCost(files), 39);
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!.detail, "never");
});

Deno.test("scanWorkflowCost - 39: the same run-unique key with restore-keys is clean", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      job(
        `      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4\n        with:\n          path: target\n          key: cargo-\${{ github.run_id }}\n          restore-keys: cargo-\n      - run: cargo build --locked\n`,
      ),
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 39), []);
});

Deno.test("scanWorkflowCost - 39: docker/build-push-action without cache-from flags; with it is clean", () => {
  const action =
    "docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0";
  const bare = job(
    `      - uses: ${action}\n        with:\n          push: true\n`,
  );
  const cached = job(
    `      - uses: ${action}\n        with:\n          push: true\n          cache-from: type=gha\n          cache-to: type=gha,mode=max\n`,
  );
  assertEquals(
    candidatesFor(
      scanWorkflowCost([wf(".github/workflows/img.yml", bare)]),
      39,
    ).length,
    1,
  );
  assertEquals(
    candidatesFor(
      scanWorkflowCost([wf(".github/workflows/img.yml", cached)]),
      39,
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// Check 40 — runs in parallel
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowCost - 40: a job that only lints and tests is not flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      job(
        `      - run: cargo clippy --locked\n      - run: cargo test --locked\n`,
      ),
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 40), []);
});

// ---------------------------------------------------------------------------
// Check 41 — build once, deploy the artefact
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowCost - 41: a deploy build nothing else builds is not a rebuild", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo test --locked\n`,
    ),
    wf(
      ".github/workflows/deploy.yml",
      `on: workflow_dispatch\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo build --release --locked\n      - run: aws lambda update-function-code --function-name f --zip-file fileb://f.zip\n`,
    ),
  ];
  assertEquals(candidatesFor(scanWorkflowCost(files), 41), []);
});

Deno.test("scanWorkflowCost - 41: deploy rebuilding what CI builds flags until it downloads the CI run's artefact", () => {
  const ci = wf(
    ".github/workflows/ci.yml",
    `on: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n`,
  );
  const rebuilding = wf(
    ".github/workflows/deploy.yml",
    `on:\n  push:\n    paths: ['web/**']\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n      - run: aws s3 sync dist s3://bucket\n`,
  );
  assertEquals(candidatesFor(scanWorkflowCost([ci, rebuilding]), 41).length, 1);

  const reusing = wf(
    ".github/workflows/deploy.yml",
    `on:\n  push:\n    paths: ['web/**']\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${DOWNLOAD}\n        with:\n          name: web-dist\n          run-id: \${{ github.event.workflow_run.id }}\n      - run: npm run build\n      - run: aws s3 sync dist s3://bucket\n`,
  );
  assertEquals(candidatesFor(scanWorkflowCost([ci, reusing]), 41), []);
});

// ---------------------------------------------------------------------------
// Robustness and rendering
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowCost - unparseable files and composite actions are skipped", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/workflows/bad.yml",
      rawText: ":",
      parsed: null,
      kind: "workflow",
    },
    {
      path: ".github/actions/x/action.yml",
      rawText: "runs:\n  using: composite\n",
      parsed: { runs: { using: "composite" } },
      kind: "composite-action",
    },
  ];
  assertEquals(scanWorkflowCost(files), []);
});

Deno.test("scanWorkflowCost - every candidate carries a 1-based line in its file", () => {
  const candidates = scanWorkflowCost([
    wf(".github/workflows/deploy.yml", GRQ_DEPLOY_BEFORE),
    wf(".github/workflows/quality.yml", GRQ_QUALITY_BEFORE),
  ]);
  const texts: Record<string, string> = {
    ".github/workflows/deploy.yml": GRQ_DEPLOY_BEFORE,
    ".github/workflows/quality.yml": GRQ_QUALITY_BEFORE,
  };
  for (const c of candidates) {
    const lines = texts[c.file]!.split("\n");
    assert(c.line >= 1 && c.line <= lines.length, JSON.stringify(c));
    if (c.job !== undefined) {
      assertStringIncludes(lines[c.line - 1]!, `${c.job}:`);
    }
  }
});

Deno.test("renderCostCandidates - empty renders the (none) sentinel", () => {
  assertEquals(renderCostCandidates([]), "(none)");
});

Deno.test("renderCostCandidates - one line per candidate with check, location, job and detail", () => {
  const text = renderCostCandidates([
    {
      check: 39,
      file: ".github/workflows/ci.yml",
      line: 12,
      job: "test",
      detail: "runs cargo with no cache",
    },
  ]);
  assertEquals(
    text,
    "- check 39 | .github/workflows/ci.yml:12 | job `test` | runs cargo with no cache",
  );
});
