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
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
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
  assertEquals(f.steps, [{ job: "test", stepIndex: 0, line: 7 }]);
  assertEquals(f.findingId, "BP-PERSIST-CREDS-ci");
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
  assertEquals(findings[0]!.findingId, "BP-PERSIST-CREDS-lint");
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
  assertEquals(findings[0]!.steps.map((s) => s.job), ["build"]);
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
      - uses: stefanzweifel/git-auto-commit-action@v5
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - endbug/add-and-commit relies on the checkout credential and skips the job", () => {
  const files = [
    wf(
      ".github/workflows/commit.yml",
      `name: Commit
jobs:
  commit:
    steps:
      - uses: actions/checkout@v4
      - uses: endbug/add-and-commit@v9
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

// Issue #4869: each of these authenticates with its own token (or SSH key) and
// never reads the checkout's persisted credential, so a persisting checkout in
// the same job is a real hardening gap and must be flagged. A plain
// `ad-m/github-push-action` step is its HTTPS mode; its `ssh: true` mode is a
// signal and is tested separately below.
const OWN_TOKEN_ACTIONS = [
  "ad-m/github-push-action@master",
  "peaceiris/actions-gh-pages@v4",
  "jamesives/github-pages-deploy-action@v4",
  "JamesIves/github-pages-deploy-action@v4",
  "crazy-max/ghaction-github-pages@v4",
  "cycjimmy/semantic-release-action@v4",
];

for (const action of OWN_TOKEN_ACTIONS) {
  Deno.test(`scan - a job using ${action} with a persisting checkout is flagged`, () => {
    const files = [
      wf(
        ".github/workflows/publish.yml",
        `name: Publish
jobs:
  publish:
    steps:
      - uses: actions/checkout@v4
      - uses: ${action}
`,
      ),
    ];
    const findings = scanCheckoutPersistCredentials(files);
    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.steps.map((s) => s.job), ["publish"]);
  });

  Deno.test(`jobNeedsCheckoutCredentials - ${action} is not a credential signal`, () => {
    assertEquals(jobNeedsCheckoutCredentials([{ uses: action }]), false);
  });
}

Deno.test("scan - ad-m/github-push-action in SSH mode relies on the checkout ssh-key and skips the job", () => {
  for (const ssh of ["true", '"true"']) {
    const files = [
      wf(
        ".github/workflows/push.yml",
        `name: Push
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          ssh-key: \${{ secrets.DEPLOY_KEY }}
          persist-credentials: true
      - uses: ad-m/github-push-action@master
        with:
          ssh: ${ssh}
`,
      ),
    ];
    assertEquals(scanCheckoutPersistCredentials(files), [], ssh);
  }
});

Deno.test("scan - ad-m/github-push-action with ssh: false is HTTPS mode and is flagged", () => {
  const files = [
    wf(
      ".github/workflows/push.yml",
      `name: Push
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: ad-m/github-push-action@master
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          ssh: false
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files).length, 1);
});

Deno.test("jobNeedsCheckoutCredentials - ad-m/github-push-action is a signal only with ssh: true", () => {
  const uses = "ad-m/github-push-action@master";
  assert(jobNeedsCheckoutCredentials([{ uses, with: { ssh: true } }]));
  assert(jobNeedsCheckoutCredentials([{ uses, with: { ssh: "true" } }]));
  assert(jobNeedsCheckoutCredentials([{ uses, with: { ssh: " TRUE " } }]));
  assertEquals(jobNeedsCheckoutCredentials([{ uses }]), false);
  assertEquals(
    jobNeedsCheckoutCredentials([{ uses, with: { ssh: false } }]),
    false,
  );
  assertEquals(
    jobNeedsCheckoutCredentials([{ uses, with: { ssh: "false" } }]),
    false,
  );
  // `ssh: true` on an unrelated action is not a signal.
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses: "peaceiris/actions-gh-pages@v4",
      with: { ssh: true },
    }]),
    false,
  );
});

Deno.test("jobNeedsCheckoutCredentials - JamesIves/github-pages-deploy-action is a signal only with ssh-key: true", () => {
  const uses = "JamesIves/github-pages-deploy-action@v4";
  assert(jobNeedsCheckoutCredentials([{ uses, with: { "ssh-key": true } }]));
  assert(
    jobNeedsCheckoutCredentials([{ uses, with: { "ssh-key": "true" } }]),
  );
  assert(
    jobNeedsCheckoutCredentials([{ uses, with: { "ssh-key": " TRUE " } }]),
  );
  // The lower-cased coordinate is the same action.
  assert(
    jobNeedsCheckoutCredentials([{
      uses: "jamesives/github-pages-deploy-action@v4",
      with: { "ssh-key": true },
    }]),
  );
  assertEquals(jobNeedsCheckoutCredentials([{ uses }]), false);
  assertEquals(
    jobNeedsCheckoutCredentials([{ uses, with: { "ssh-key": false } }]),
    false,
  );
  // A secret-key value (rather than boolean `true`) is the action's own key,
  // not a signal.
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses,
      with: { "ssh-key": "${{ secrets.DEPLOY_KEY }}" },
    }]),
    false,
  );
  // `ssh-key: true` on an unrelated action is not a signal.
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses: "peaceiris/actions-gh-pages@v4",
      with: { "ssh-key": true },
    }]),
    false,
  );
});

Deno.test("scan - JamesIves/github-pages-deploy-action with ssh-key: true relies on the checkout ssh-key and skips the job", () => {
  for (const sshKey of ["true", '"true"']) {
    const files = [
      wf(
        ".github/workflows/pages.yml",
        `name: Pages
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
        with:
          ssh-key: \${{ secrets.DEPLOY_KEY }}
          persist-credentials: true
      - uses: JamesIves/github-pages-deploy-action@v4
        with:
          ssh-key: ${sshKey}
`,
      ),
    ];
    assertEquals(scanCheckoutPersistCredentials(files), [], sshKey);
  }
});

Deno.test("scan - cycjimmy/semantic-release-action with a checkout that sets ssh-key is skipped", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      `name: Release
on: push
jobs:
  release:
    steps:
      - uses: actions/checkout@v4
        with:
          ssh-key: \${{ secrets.DEPLOY_KEY }}
          persist-credentials: true
      - uses: cycjimmy/semantic-release-action@v4
        with:
          semantic_version: 21
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - a checkout that sets ssh-key is skipped", () => {
  const files = [
    wf(
      ".github/workflows/deploy.yml",
      `name: Deploy
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
        with:
          ssh-key: \${{ secrets.DEPLOY_KEY }}
      - run: ./deploy.sh
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - a job using create-pull-request with a persisting checkout is flagged", () => {
  const files = [
    wf(
      ".github/workflows/dependency-update.yml",
      `name: Dependency Updates
on: workflow_dispatch
jobs:
  upgrade:
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v8
        with:
          token: \${{ secrets.ACTIONS_PUSH }}
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.steps.map((s) => s.job), ["upgrade"]);
});

Deno.test("scan - a job using create-pull-request with persist-credentials: false is not flagged", () => {
  const files = [
    wf(
      ".github/workflows/dependency-update.yml",
      `name: Dependency Updates
on: workflow_dispatch
jobs:
  upgrade:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: peter-evans/create-pull-request@v8
        with:
          token: \${{ secrets.ACTIONS_PUSH }}
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("scan - a job using release-please-action with a persisting checkout is flagged", () => {
  for (
    const action of [
      "googleapis/release-please-action",
      "google-github-actions/release-please-action",
    ]
  ) {
    const files = [
      wf(
        ".github/workflows/release.yml",
        `name: Release
on: push
jobs:
  release:
    steps:
      - uses: actions/checkout@v4
      - uses: ${action}@v4
        with:
          token: \${{ secrets.RELEASE_TOKEN }}
`,
      ),
    ];
    const findings = scanCheckoutPersistCredentials(files);
    assertEquals(findings.length, 1, action);
    assertEquals(findings[0]!.steps.map((s) => s.job), ["release"], action);
  }
});

Deno.test("scan - a job using release-please-action with persist-credentials: false is not flagged", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      `name: Release
on: push
jobs:
  release:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: googleapis/release-please-action@v4
        with:
          token: \${{ secrets.RELEASE_TOKEN }}
`,
    ),
  ];
  assertEquals(scanCheckoutPersistCredentials(files), []);
});

Deno.test("jobNeedsCheckoutCredentials - create-pull-request alone is not a credential signal", () => {
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses: "peter-evans/create-pull-request@v8",
    }]),
    false,
  );
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses: "googleapis/release-please-action@v4",
    }]),
    false,
  );
  assertEquals(
    jobNeedsCheckoutCredentials([{
      uses: "google-github-actions/release-please-action@v4",
    }]),
    false,
  );
  assert(
    jobNeedsCheckoutCredentials([{
      uses: "stefanzweifel/git-auto-commit-action@v5",
    }]),
  );
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
    jobNeedsCheckoutCredentials([{
      uses: "stefanzweifel/git-auto-commit-action@v5",
    }]),
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
      knownOpenFindingIds: ["BP-PERSIST-CREDS-ci"],
    }),
    [],
  );
});

// Issue #2221 migration: a repository that already carries an open
// per-step issue for the file must not be re-filed under the per-file id.
Deno.test("scan - an open legacy per-step id covers the per-file finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  check-changes:
    steps:
      - uses: actions/checkout@v4
      - run: deno task changed
  quality:
    steps:
      - uses: actions/checkout@v4
      - run: ./quality.sh
`,
    ),
  ];
  assertEquals(
    scanCheckoutPersistCredentials(files, {
      knownOpenFindingIds: ["BP-PERSIST-CREDS-ci-quality-0"],
    }),
    [],
  );
});

Deno.test("scan - a legacy per-step id for another file does not suppress this one", () => {
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
  const findings = scanCheckoutPersistCredentials(files, {
    knownOpenFindingIds: ["BP-PERSIST-CREDS-sbom-build-0"],
  });
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, "BP-PERSIST-CREDS-ci");
});

Deno.test("scan - suppressedIds on a legacy per-step id drops only that step", () => {
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
  const findings = scanCheckoutPersistCredentials(files, {
    suppressedIds: ["BP-PERSIST-CREDS-ci-test-0"],
  });
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.steps.map((s) => s.job), ["lint"]);
});

Deno.test("scan - in-source best-practice-ignore marker suppresses the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
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
    _clearSuppressionCommitAuthors();
  }
});

// Issue #2221: N offending steps in one file yield exactly one finding
// whose body names all N — the fix is one edit to that one file.
Deno.test("scan - three flaggable jobs in one file yield ONE finding naming all three", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
jobs:
  check-changes:
    steps:
      - uses: actions/checkout@v4
      - run: deno task changed
  quality:
    steps:
      - uses: actions/checkout@v4
      - run: ./quality.sh
  version-guard:
    steps:
      - uses: actions/checkout@v4
      - run: deno task version-guard
`,
    ),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, "BP-PERSIST-CREDS-ci");
  assertEquals(f.steps.map((s) => s.job), [
    "check-changes",
    "quality",
    "version-guard",
  ]);
  // The body names every offending job, and the citation anchors to the
  // first offending checkout.
  for (const job of ["check-changes", "quality", "version-guard"]) {
    assert(f.whyItMatters.includes(job), `whyItMatters names ${job}`);
    assert(f.evidence.includes(job), `evidence names ${job}`);
  }
  assertEquals(f.lines, f.steps[0]!.line);
});

// The filed issue's title and body are the human-facing surface, so the
// one-step and many-step wordings are both asserted (Issue #2221).
Deno.test("scan - the title and body read correctly for a single offending step", () => {
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
  const f = scanCheckoutPersistCredentials(files)[0]!;
  assertEquals(
    f.title,
    "🟠 A checkout step persists credentials (`.github/workflows/ci.yml`)",
  );
  assert(f.whyItMatters.includes("has 1 `actions/checkout` step without"));
  assert(f.whyItMatters.includes("That job shows no static sign"));
  assert(f.whyItMatters.includes("using the checkout credential"));
  assert(
    !f.whyItMatters.includes("All 1"),
    "no plural-count sentence for a single step",
  );
  assert(
    f.suggestedFix.includes(
      "Add `persist-credentials: false` to the checkout step listed above",
    ),
  );
});

Deno.test("scan - the title and body read correctly for several offending steps", () => {
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
  const f = scanCheckoutPersistCredentials(files)[0]!;
  assertEquals(
    f.title,
    "🟠 2 checkout steps persist credentials (`.github/workflows/ci.yml`)",
  );
  assert(f.whyItMatters.includes("has 2 `actions/checkout` steps without"));
  assert(f.whyItMatters.includes("None of these jobs shows"));
  assert(f.whyItMatters.includes("All 2 steps are fixed by the same edit"));
  assert(
    f.suggestedFix.includes("each of the 2 checkout steps listed above"),
  );
});

Deno.test("scan - two workflow files yield one finding each, sorted by id", () => {
  const steps = `jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: deno test
`;
  const files = [
    wf(".github/workflows/sbom.yml", steps),
    wf(".github/workflows/ci.yml", steps),
  ];
  const findings = scanCheckoutPersistCredentials(files);
  assertEquals(findings.length, 2);
  assertEquals(findings[0]!.findingId, "BP-PERSIST-CREDS-ci");
  assertEquals(findings[1]!.findingId, "BP-PERSIST-CREDS-sbom");
});

Deno.test("scan - a marker above one checkout drops that step only", () => {
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI
jobs:
  test:
    steps:
      # best-practice-ignore: BP-PERSIST-CREDS-ci — author=nigel expires=2099-12-31 needs the token
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
    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.steps.map((s) => s.job), ["lint"]);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scan - a marker above every checkout drops the file entirely", () => {
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI
jobs:
  test:
    steps:
      # best-practice-ignore: BP-PERSIST-CREDS-ci — author=nigel expires=2099-12-31 needs the token
      - uses: actions/checkout@v4
      - run: deno test
  lint:
    steps:
      # best-practice-ignore: BP-PERSIST-CREDS-ci — author=nigel expires=2099-12-31 needs the token
      - uses: actions/checkout@v4
      - run: deno lint
`,
      ),
    ];
    assertEquals(scanCheckoutPersistCredentials(files), []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});
