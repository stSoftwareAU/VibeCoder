/**
 * Tests for run_injection_scanner.ts — native script-injection pre-filer
 * for the github-actions-audit template (Issue #2503, part of #2497).
 *
 * Every test exercises the real `scanRunInjection` / `findInjectedFields`
 * against in-memory `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  ATTACKER_CONTROLLABLE_FIELDS,
  findInjectedFields,
  findInjectedWithFields,
  scanRunInjection,
  TRUSTED_FIELDS,
} from "../lib/run_injection_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(path: string, rawText: string): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind: "workflow" };
}

// ---------------------------------------------------------------------------
// Positive: attacker-controllable fields are flagged
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - pull_request.title in run: is flagged high", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\non: pull_request_target\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n',
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.severity, "high");
  assertEquals(f.job, "build");
  assertEquals(f.stepIndex, 0);
  assertEquals(f.fields, ["github.event.pull_request.title"]);
  assertEquals(f.findingId, "BP-INJECTION-ci-build-0");
  assert(f.findingId.startsWith("BP-"));
});

Deno.test("scanRunInjection - github.head_ref in run: is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\njobs:\n  build:\n    steps:\n      - run: git checkout ${{ github.head_ref }}\n",
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.fields, ["github.head_ref"]);
});

Deno.test("scanRunInjection - commits message wildcard (index form) is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.commits[0].message }}"\n',
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.fields, ["github.event.commits.*.message"]);
});

Deno.test("scanRunInjection - every allow-list field is detected", () => {
  for (const field of ATTACKER_CONTROLLABLE_FIELDS) {
    // Render the wildcard form with a concrete index for the run script.
    const expr = field.replace(".*.", "[0].");
    const detected = findInjectedFields(`echo "\${{ ${expr} }}"`);
    assertEquals(detected, [field], `field not detected: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// Negative: trusted fields and the env-var fix are NOT flagged
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - trusted github.sha in run: is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "Commit: ${{ github.sha }}"\n',
    ),
  ];
  assertEquals(scanRunInjection(files), []);
});

Deno.test("scanRunInjection - every trusted field is excluded", () => {
  for (const field of TRUSTED_FIELDS) {
    const detected = findInjectedFields(`echo "\${{ ${field} }}"`);
    assertEquals(detected, [], `trusted field flagged: ${field}`);
  }
});

Deno.test("scanRunInjection - env-var fix (no expression in run:) is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - env:\n          TITLE: ${{ github.event.pull_request.title }}\n        run: echo "Title: $TITLE"\n',
    ),
  ];
  assertEquals(scanRunInjection(files), []);
});

Deno.test("scanRunInjection - longer sibling field does not match a shorter one", () => {
  // `.titles` (hypothetical) must not match `.title`.
  const detected = findInjectedFields(
    "echo ${{ github.event.pull_request.titles }}",
  );
  assertEquals(detected, []);
});

Deno.test("scanRunInjection - field as plain shell text (no ${{ }}) is NOT flagged", () => {
  const detected = findInjectedFields(
    "echo github.event.pull_request.title",
  );
  assertEquals(detected, []);
});

// ---------------------------------------------------------------------------
// Multiple steps / jobs
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - one finding per affected step", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n      - run: echo safe\n      - run: echo "${{ github.event.comment.body }}"\n',
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-INJECTION-ci-build-0",
    "BP-INJECTION-ci-build-2",
  ]);
});

// ---------------------------------------------------------------------------
// Suppression and dedup
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - in-source suppression marker is honoured", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}" # best-practice-ignore: BP-INJECTION-ci-build-0 — author=nigel expires=2099-12-31 sanitised downstream\n',
      ),
    ];
    assertEquals(scanRunInjection(files), []);
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("scanRunInjection - knownOpenFindingIds are skipped", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n',
    ),
  ];
  assertEquals(
    scanRunInjection(files, {
      knownOpenFindingIds: ["BP-INJECTION-ci-build-0"],
    }),
    [],
  );
});

Deno.test("scanRunInjection - suppressedIds are skipped", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      'name: CI\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n',
    ),
  ];
  assertEquals(
    scanRunInjection(files, {
      suppressedIds: ["BP-INJECTION-ci-build-0"],
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Scope and robustness
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - composite actions are ignored", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/actions/setup/action.yml",
      rawText:
        'name: setup\nruns:\n  using: composite\n  steps:\n    - run: echo "${{ github.event.pull_request.title }}"\n',
      parsed: {
        name: "setup",
        runs: {
          using: "composite",
          steps: [{ run: 'echo "${{ github.event.pull_request.title }}"' }],
        },
      },
      kind: "composite-action",
    },
  ];
  assertEquals(scanRunInjection(files), []);
});

Deno.test("scanRunInjection - unparseable workflow yields no finding", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/workflows/broken.yml",
      rawText: ":::not yaml:::",
      parsed: null,
      kind: "workflow",
    },
  ];
  assertEquals(scanRunInjection(files), []);
});

// ---------------------------------------------------------------------------
// AI-action prompt-injection sink (Issue #3313, parent #3309)
// ---------------------------------------------------------------------------

Deno.test("scanRunInjection - issue.body into claude-code-action prompt: is flagged high", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issues\njobs:\n  triage:\n    runs-on: ubuntu-latest\n    steps:\n" +
        "      - uses: anthropics/claude-code-action@beta\n" +
        "        with:\n" +
        "          prompt: ${{ github.event.issue.body }}\n",
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.severity, "high");
  assertEquals(f.sink, "ai-prompt");
  assertEquals(f.job, "triage");
  assertEquals(f.stepIndex, 0);
  assertEquals(f.fields, ["github.event.issue.body"]);
  assertEquals(f.aiAction, "anthropics/claude-code-action");
  assertEquals(f.findingId, "BP-AI-INJECTION-agent-triage-0");
  assert(f.findingId.startsWith("BP-"));
});

Deno.test("scanRunInjection - comment.body into an AI action with.args is flagged", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issue_comment\njobs:\n  respond:\n    steps:\n" +
        "      - uses: google-gemini/run-gemini-cli@v1\n" +
        "        with:\n" +
        '          args: "Respond to: ${{ github.event.comment.body }}"\n',
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.sink, "ai-prompt");
  assertEquals(findings[0]!.fields, ["github.event.comment.body"]);
  assertEquals(findings[0]!.findingId, "BP-AI-INJECTION-agent-respond-0");
});

Deno.test("scanRunInjection - AI action with a list-valued args input is flagged", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issues\njobs:\n  triage:\n    steps:\n" +
        "      - uses: anthropics/claude-code-action@beta\n" +
        "        with:\n" +
        "          args:\n" +
        "            - --prompt\n" +
        "            - ${{ github.event.issue.title }}\n",
    ),
  ];
  const findings = scanRunInjection(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.fields, ["github.event.issue.title"]);
});

Deno.test("scanRunInjection - hardened AI action (trusted field in prompt) is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issues\njobs:\n  triage:\n    steps:\n" +
        "      - uses: anthropics/claude-code-action@beta\n" +
        "        with:\n" +
        '          prompt: "Summarise the release for ${{ github.repository }}"\n',
    ),
  ];
  assertEquals(scanRunInjection(files), []);
});

Deno.test("scanRunInjection - untrusted field into a NON-AI action with: is NOT flagged", () => {
  // `actions/checkout` receiving an attacker-controllable ref is check
  // #10 territory (untrusted checkout), not the prompt-injection sink.
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\non: pull_request_target\njobs:\n  build:\n    steps:\n" +
        "      - uses: actions/checkout@v4\n" +
        "        with:\n" +
        "          ref: ${{ github.event.pull_request.head.ref }}\n",
    ),
  ];
  assertEquals(scanRunInjection(files), []);
});

Deno.test("scanRunInjection - run: and AI-prompt sinks yield distinct ids in one workflow", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issues\njobs:\n  triage:\n    steps:\n" +
        '      - run: echo "${{ github.event.issue.title }}"\n' +
        "      - uses: anthropics/claude-code-action@beta\n" +
        "        with:\n" +
        "          prompt: ${{ github.event.issue.body }}\n",
    ),
  ];
  const ids = scanRunInjection(files).map((f) => f.findingId);
  assertEquals(ids, [
    "BP-AI-INJECTION-agent-triage-1",
    "BP-INJECTION-agent-triage-0",
  ]);
});

Deno.test("scanRunInjection - AI-prompt in-source suppression marker is honoured", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/agent.yml",
        "name: Agent\non: issues\njobs:\n  triage:\n    steps:\n" +
          "      - uses: anthropics/claude-code-action@beta\n" +
          "        with:\n" +
          "          # best-practice-ignore: BP-AI-INJECTION-agent-triage-0 — author=nigel expires=2099-12-31 guarded\n" +
          "          prompt: ${{ github.event.issue.body }}\n",
      ),
    ];
    assertEquals(scanRunInjection(files), []);
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("scanRunInjection - AI-prompt knownOpenFindingIds are skipped", () => {
  const files = [
    wf(
      ".github/workflows/agent.yml",
      "name: Agent\non: issues\njobs:\n  triage:\n    steps:\n" +
        "      - uses: anthropics/claude-code-action@beta\n" +
        "        with:\n" +
        "          prompt: ${{ github.event.issue.body }}\n",
    ),
  ];
  assertEquals(
    scanRunInjection(files, {
      knownOpenFindingIds: ["BP-AI-INJECTION-agent-triage-0"],
    }),
    [],
  );
});

Deno.test("findInjectedWithFields - collects across every string input", () => {
  const detected = findInjectedWithFields({
    model: "claude-sonnet-4",
    prompt: "${{ github.event.issue.body }}",
    system: "You are helpful.",
    args: ["--title", "${{ github.event.issue.title }}"],
  });
  assertEquals(detected, [
    "github.event.issue.title",
    "github.event.issue.body",
  ]);
});

Deno.test("findInjectedWithFields - trusted-only inputs yield nothing", () => {
  assertEquals(
    findInjectedWithFields({ prompt: "Repo: ${{ github.repository }}" }),
    [],
  );
});

Deno.test("scanRunInjection - findings are sorted by stable id", () => {
  const files = [
    wf(
      ".github/workflows/zeta.yml",
      'name: Z\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.issue.body }}"\n',
    ),
    wf(
      ".github/workflows/alpha.yml",
      'name: A\njobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.issue.body }}"\n',
    ),
  ];
  const ids = scanRunInjection(files).map((f) => f.findingId);
  assertEquals(ids, [
    "BP-INJECTION-alpha-build-0",
    "BP-INJECTION-zeta-build-0",
  ]);
});
