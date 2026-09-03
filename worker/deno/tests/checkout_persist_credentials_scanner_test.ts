/**
 * Tests for checkout_persist_credentials_scanner.ts — native
 * checkout-persist-credentials pre-filer for the github-actions-audit
 * template (Issue #2845, gap from #2834).
 *
 * Every test exercises the real `scanCheckoutPersistCredentials` /
 * `jobNeedsCheckoutCredentials` / `checkoutSetsPersistCredentialsFalse`
 * against in-memory `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  checkoutSetsPersistCredentialsFalse,
  jobNeedsCheckoutCredentials,
  scanCheckoutPersistCredentials,
} from "../lib/checkout_persist_credentials_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(
  path: string,
  rawText: string,
  kind: WorkflowFile["kind"] = "workflow",
): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind };
}

// ---------------------------------------------------------------------------
// Positive: a build/test job's checkout without persist-credentials: false
// ---------------------------------------------------------------------------

Deno.test("scan - checkout in a test job without persist-credentials is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: deno test
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.severity, "medium");
  assertEquals(f.job, "test");
  assertEquals(f.stepIndex, 0);
  assertEquals(f.findingId, "BP-PERSIST-CREDS-ci-test-0");
  assert(f.findingId.startsWith("BP-"));
  // Citation anchored to the checkout line (line 7).
  assertEquals(f.lines, 7);
});

Deno.test("scan - SHA-pinned checkout is still flagged when persist-credentials absent", () => {
  const sha = "a".repeat(40);
  const files = [
    wf(
      ".github/workflows/lint.yml",
      `name: Lint
jobs:
  lint:
    steps:
      - uses: actions/checkout@${sha}
      - run: deno lint
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, "BP-PERSIST-CREDS-lint-lint-0");
});

Deno.test("scan - persist-credentials: true (explicit) is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - run: make build
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.job, "build");
});

// ---------------------------------------------------------------------------
// Negative: persist-credentials: false is safe
// ---------------------------------------------------------------------------

Deno.test("scan - persist-credentials: false is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: deno test
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("checkoutSetsPersistCredentialsFalse - boolean and string false", () => {
  assert(
    checkoutSetsPersistCredentialsFalse({
      uses: "actions/checkout@v4",
      with: { "persist-credentials": false },
    }),
  );
  assert(
    checkoutSetsPersistCredentialsFalse({
      uses: "actions/checkout@v4",
      with: { "persist-credentials": "false" },
    }),
  );
  assertEquals(
    checkoutSetsPersistCredentialsFalse({
      uses: "actions/checkout@v4",
      with: { "persist-credentials": true },
    }),
    false,
  );
  assertEquals(
    checkoutSetsPersistCredentialsFalse({ uses: "actions/checkout@v4" }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Negative: jobs that need the persisted credential are skipped
// ---------------------------------------------------------------------------

Deno.test("scan - a job that runs `git push` is skipped", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      `name: Release
jobs:
  publish:
    steps:
      - uses: actions/checkout@v4
      - run: |
          git commit -am "release"
          git push origin main
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - a job using a known push action is skipped", () => {
  const files = [
    wf(
      ".github/workflows/pages.yml",
      `name: Pages
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
      - uses: peaceiris/actions-gh-pages@v3
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - a checkout requesting submodules is skipped", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - run: make
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("jobNeedsCheckoutCredentials - git fetch/pull/submodule detected", () => {
  assert(jobNeedsCheckoutCredentials([{ run: "git fetch --tags" }]));
  assert(jobNeedsCheckoutCredentials([{ run: "git pull" }]));
  assert(jobNeedsCheckoutCredentials([{ run: "git submodule update --init" }]));
  assert(
    jobNeedsCheckoutCredentials([{ uses: "ad-m/github-push-action@master" }]),
  );
  assertEquals(jobNeedsCheckoutCredentials([{ run: "deno test" }]), false);
  // `digit` must not match the `\bgit` word boundary.
  assertEquals(jobNeedsCheckoutCredentials([{ run: "echo digital" }]), false);
});

// ---------------------------------------------------------------------------
// Negative: non-checkout uses, composite actions, malformed input
// ---------------------------------------------------------------------------

Deno.test("scan - a non-checkout uses is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  build:
    steps:
      - uses: actions/setup-node@v4
      - run: npm test
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - composite-action files are ignored", () => {
  const files = [
    wf(
      ".github/actions/x/action.yml",
      `runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
`,
      "composite-action",
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - unparseable / non-record workflow yields no finding", () => {
  const files = [
    {
      path: ".github/workflows/bad.yml",
      rawText: ":\n  bad",
      parsed: null,
      kind: "workflow" as const,
    },
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

// ---------------------------------------------------------------------------
// Dedup + suppression
// ---------------------------------------------------------------------------

Deno.test("scan - knownOpenFindingIds suppresses the finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: deno test
`,
    ),
  ];
  assertEquals(
    scanCheckoutPersistCredentials(files, {
      knownOpenFindingIds: ["BP-PERSIST-CREDS-ci-test-0"],
    }),
    [],
  );
});

Deno.test("scan - in-source best-practice-ignore marker suppresses the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI
  jobs:
    test:
      steps:
        # best-practice-ignore: BP-PERSIST-CREDS-ci-test-0 — author=nigel expires=2099-12-31 needs the token
        - uses: actions/checkout@v4
        - run: deno test
  `,
      ),
    ];
    assertEquals(scanCheckoutPersistCredentials(files), []);
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("scan - two flaggable jobs both produce findings, sorted by id", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: deno test
  lint:
    steps:
      - uses: actions/checkout@v4
      - run: deno lint
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 2);
  // Sorted by stable id: "...-lint-0" < "...-test-0".
  assertEquals(findings[0]!.findingId, "BP-PERSIST-CREDS-ci-lint-0");
  assertEquals(findings[1]!.findingId, "BP-PERSIST-CREDS-ci-test-0");
});
