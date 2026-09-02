/**
 * Unit tests for the fresh first-run verification decisions (Issue #736).
 *
 * `infra/verify/first-run.sh` sequences the run on a real host; every
 * judgement it reports is made in `lib/first_run_verification.ts`, which is
 * what these tests exercise — with no host, no Podman and no image build.
 *
 * The distinctions under test are the ones a reader of the report depends on:
 * a workaround present versus a fresh host, a Codex-only configuration versus
 * any other, an expected warning versus a new defect, and a chain (a refused
 * trim, then a refused launch) versus either message alone.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  analyseDiskChain,
  classifyOutput,
  evaluateClaim,
  evaluateCodexOnlyConfig,
  evaluateFreshState,
  evaluateImage,
  type FreshStateFacts,
  renderReport,
  type RunSummary,
  verdictFor,
  WORKAROUND_ENV_VARS,
} from "../lib/first_run_verification.ts";
import { parseStages } from "../commands/first_run_verify.ts";

/** A host with nothing on it that would refuse a run. */
function freshFacts(overrides: Partial<FreshStateFacts> = {}): FreshStateFacts {
  return {
    env: {},
    configFile: "/home/ubuntu/vibe-coder-runtime/.config.json",
    configFileExists: false,
    claudeOnPath: false,
    localImages: [],
    checkoutStatus: "",
    userRegistriesConf: null,
    systemRegistriesConf: null,
    ...overrides,
  };
}

Deno.test("evaluateFreshState - a genuinely fresh host is not refused", () => {
  const verdict = evaluateFreshState(freshFacts());
  assertEquals(verdict.violations, []);
  assertEquals(verdict.notes, []);
});

Deno.test("evaluateFreshState - every workaround-shaped variable refuses the run", () => {
  for (const { name } of WORKAROUND_ENV_VARS) {
    const verdict = evaluateFreshState(freshFacts({ env: { [name]: "true" } }));
    assertEquals(
      verdict.violations.length,
      1,
      `${name} should refuse the run on its own`,
    );
    assertStringIncludes(verdict.violations[0]!, name);
  }
});

Deno.test("evaluateFreshState - an empty variable is not a workaround", () => {
  const verdict = evaluateFreshState(
    freshFacts({ env: { VIBE_SKIP_PREREQ_CHECK: "" } }),
  );
  assertEquals(verdict.violations, []);
});

Deno.test("evaluateFreshState - a configuration setup did not write refuses the run", () => {
  const verdict = evaluateFreshState(freshFacts({ configFileExists: true }));
  assertEquals(verdict.violations.length, 1);
  assertStringIncludes(verdict.violations[0]!, "already exists");
});

Deno.test("evaluateFreshState - a Claude CLI on PATH refuses a Codex-only run", () => {
  const verdict = evaluateFreshState(freshFacts({ claudeOnPath: true }));
  assertEquals(verdict.violations.length, 1);
  assertStringIncludes(verdict.violations[0]!, "Issue #730");
});

// Business-logic change (Issue #736): the earlier rule refused only a
// pre-built `vibe-coder` image, so a host that already held the base layers
// passed as fresh and the short-name resolution the build is meant to prove
// had already happened. The issue's Scope says "no pre-pulled or manually
// tagged images", so any image at all now refuses the run.
Deno.test("evaluateFreshState - any image already on the host refuses the run", () => {
  for (
    const image of [
      "vibe-coder",
      "localhost/vibe-coder",
      "docker.io/library/node",
    ]
  ) {
    const verdict = evaluateFreshState(freshFacts({ localImages: [image] }));
    assertEquals(verdict.violations.length, 1, `${image} should be refused`);
    assertStringIncludes(verdict.violations[0]!, image);
  }
});

Deno.test("evaluateFreshState - a runtime holding nothing is the fresh case, and blanks are not images", () => {
  assertEquals(
    evaluateFreshState(freshFacts({ localImages: ["", "  ", "<none>"] }))
      .violations,
    [],
  );
});

Deno.test("evaluateFreshState - a patched checkout refuses the run", () => {
  const verdict = evaluateFreshState(
    freshFacts({ checkoutStatus: " M run.sh\n" }),
  );
  assertEquals(verdict.violations.length, 1);
  assertStringIncludes(verdict.violations[0]!, "uncommitted changes");
});

Deno.test("evaluateFreshState - the operator's short-name workarounds refuse the run", () => {
  for (
    const conf of [
      '[aliases]\n"node" = "docker.io/library/node"\n',
      'unqualified-search-registries = ["docker.io"]\n',
    ]
  ) {
    const verdict = evaluateFreshState(
      freshFacts({ userRegistriesConf: conf }),
    );
    assertEquals(verdict.violations.length, 1, conf);
    assertStringIncludes(verdict.violations[0]!, "Issue #728");
  }
});

Deno.test("evaluateFreshState - a commented-out setting is not a workaround", () => {
  const verdict = evaluateFreshState(freshFacts({
    userRegistriesConf: '# unqualified-search-registries = ["docker.io"]\n',
  }));
  assertEquals(verdict.violations, []);
});

Deno.test("evaluateFreshState - the distribution's own search registry is recorded, not refused", () => {
  const verdict = evaluateFreshState(freshFacts({
    systemRegistriesConf: 'unqualified-search-registries = ["docker.io"]\n',
  }));
  assertEquals(verdict.violations, []);
  assertEquals(verdict.notes.length, 1);
  assertStringIncludes(verdict.notes[0]!, "distribution default");
});

Deno.test("evaluateFreshState - every workaround present is reported at once", () => {
  const verdict = evaluateFreshState(freshFacts({
    env: { VIBE_SKIP_PREREQ_CHECK: "true", VIBE_HOST_DISK_LOW_FLOOR_GB: "1" },
    claudeOnPath: true,
    configFileExists: true,
  }));
  assertEquals(verdict.violations.length, 4);
});

// Business-logic change (Issue #736): `configFileSplit` was a field no
// production caller ever set — the shell learns of a split `CONFIG_FILE` /
// `CONFIG_PATH` from `resolveHostConfigPath` throwing in `--mode config-path`,
// which fails stage 1 before this decision is reached. The dead field and its
// tautological test are gone; the declared provider takes its place as the one
// thing the run tells the preflight about itself.
Deno.test("evaluateFreshState - the declared provider is recorded, not refused", () => {
  const verdict = evaluateFreshState(freshFacts({ declaredProvider: "codex" }));
  assertEquals(verdict.violations, []);
  assertEquals(verdict.notes.length, 1);
  assertStringIncludes(verdict.notes[0]!, "VIBE_AGENT_PROVIDER=codex");
  assertStringIncludes(verdict.notes[0]!, "docs/SETUP.md");
});

Deno.test("evaluateFreshState - the distribution's own aliases block is recorded, not refused", () => {
  const verdict = evaluateFreshState(freshFacts({
    systemRegistriesConf: '[aliases]\n"node" = "docker.io/library/node"\n',
  }));
  assertEquals(verdict.violations, []);
  assertEquals(verdict.notes.length, 1);
  assertStringIncludes(verdict.notes[0]!, "distribution");
});

Deno.test("evaluateCodexOnlyConfig - a Codex-only configuration passes", () => {
  const verdict = evaluateCodexOnlyConfig(
    JSON.stringify({ agent_providers: ["codex"], repositories: ["o/r"] }),
  );
  assertEquals(verdict.ok, true);
  assertStringIncludes(verdict.findings[0]!, "codex");
});

Deno.test("evaluateCodexOnlyConfig - unreadable JSON fails loud, naming the fault", () => {
  const verdict = evaluateCodexOnlyConfig("{not json");
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.findings[0]!, "not readable JSON");
});

Deno.test("evaluateCodexOnlyConfig - an absent selection is not silently 'not codex'", () => {
  const verdict = evaluateCodexOnlyConfig(JSON.stringify({ repositories: [] }));
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.findings[0]!, "states no agent_providers");
});

Deno.test("evaluateCodexOnlyConfig - another provider fails the Codex-only run", () => {
  assertEquals(
    evaluateCodexOnlyConfig(JSON.stringify({ agent_providers: ["claude"] })).ok,
    false,
  );
  const both = evaluateCodexOnlyConfig(
    JSON.stringify({ agent_providers: ["codex", "claude"] }),
  );
  assertEquals(both.ok, false);
  assertStringIncludes(both.findings.join(" "), "also selects claude");
});

Deno.test("evaluateImage - the Codex image passes", () => {
  const verdict = evaluateImage(
    "PATH=/usr/bin\nVIBE_IMAGE_AGENT_PROVIDERS=codex\n",
    "CODEX_PRESENT\nCLAUDE_ABSENT\n",
  );
  assertEquals(verdict.ok, true);
});

Deno.test("evaluateImage - an unstamped image fails", () => {
  const verdict = evaluateImage(
    "PATH=/usr/bin\n",
    "CODEX_PRESENT\nCLAUDE_ABSENT",
  );
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.findings[0]!, "no VIBE_IMAGE_AGENT_PROVIDERS");
});

Deno.test("evaluateImage - the Claude image built from a Codex configuration fails", () => {
  const verdict = evaluateImage(
    "VIBE_IMAGE_AGENT_PROVIDERS=claude\n",
    "CODEX_ABSENT\nCLAUDE_PRESENT\n",
  );
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.findings.join(" "), "Issue #729");
});

Deno.test("evaluateImage - a probe that did not run is never read as an answer", () => {
  // The dangerous reading: no CLAUDE_PRESENT marker taken as "Claude absent",
  // or worse, a failed probe reported as a defect it never observed.
  const verdict = evaluateImage("VIBE_IMAGE_AGENT_PROVIDERS=codex\n", "");
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.findings.join(" "), "did not run");
});

Deno.test("classifyOutput - the ruleset 403 is an expected warning, not a defect", () => {
  const findings = classifyOutput(
    "Ruleset sync for o/r: repository rulesets need GitHub Pro on a private " +
      "repository (non-fatal)",
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.kind, "expected");
  assertStringIncludes(findings[0]!.summary, "Issue #733");
});

Deno.test("classifyOutput - each fault a sibling issue removed is named if it returns", () => {
  const cases: Array<[string, string]> = [
    ['Error: unknown mount option "uid=1000"', "Issue #727"],
    ["Error: short-name resolution enforced but cannot prompt", "Issue #728"],
    ["✗ claude CLI is not installed", "Issue #730"],
    ["Error: unrecognized command `podman volume delete`", "Issue #731"],
    ["[run.sh] [WORK_VOLUME_UNRECOVERED] vibe-work", "Issue #731"],
  ];
  for (const [line, issue] of cases) {
    const findings = classifyOutput(line);
    assertEquals(findings.length, 1, line);
    assertEquals(findings[0]!.kind, "defect", line);
    assertStringIncludes(findings[0]!.summary, issue);
  }
});

Deno.test("classifyOutput - ordinary output carries no finding", () => {
  assertEquals(
    classifyOutput("[run.sh] building image vibe-coder:abc\nSTEP 1/12"),
    [],
  );
});

Deno.test("classifyOutput - the same fault printed twice is one finding", () => {
  const findings = classifyOutput(
    'unknown mount option "uid=1000"\nunknown mount option "gid=1000"',
  );
  assertEquals(findings.length, 1);
});

Deno.test("analyseDiskChain - a refused trim alone is expected and starts nothing", () => {
  const verdict = analyseDiskChain(
    "volume-init: /work - this runtime does not support discard",
    "2026-09-02T00:00:00Z host-disk: 38400 MB free on /var/lib/containers",
  );
  assertEquals(verdict.volumeInitSeen, true);
  assertEquals(verdict.refused, false);
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "expected");
});

Deno.test("analyseDiskChain - the refusal is read from run_core.log as well as the launcher", () => {
  // run.sh captures volume-init's stdout, so the refusal reaches the operator
  // through run_core.log — reading only the launcher output would miss it.
  const verdict = analyseDiskChain(
    "[run.sh] built",
    "host-disk: this runtime refused to trim vibe-work on this launch",
  );
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "expected");
  assertStringIncludes(verdict.findings[0]!.summary, "Issue #734");
});

Deno.test("analyseDiskChain - a refused trim followed by a refused launch is the reported chain", () => {
  const verdict = analyseDiskChain(
    "volume-init: /work - this runtime does not support discard\n" +
      "[run.sh] refusing to launch: 900 MB free, below the 5 GB hard floor",
    "",
  );
  assertEquals(verdict.refused, true);
  const defects = verdict.findings.filter((f) => f.kind === "defect");
  assertEquals(defects.length, 1);
  assertStringIncludes(defects[0]!.summary, "Issue #734");
});

Deno.test("analyseDiskChain - a refusal that names its floor and free space explains itself", () => {
  const verdict = analyseDiskChain(
    "[run.sh] refusing to launch: 900 MB free on /var/lib/containers, below " +
      "the 5 GB hard floor (VIBE_HOST_DISK_HARD_FLOOR_GB)",
    "",
  );
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "expected");
  assertStringIncludes(verdict.findings[0]!.summary, "Issue #732");
});

Deno.test("analyseDiskChain - an unexplained refusal is the defect Issue #732 removed", () => {
  const verdict = analyseDiskChain("[run.sh] refusing to launch", "");
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "defect");
});

Deno.test("analyseDiskChain - no volume-init output means nothing was confirmed", () => {
  const verdict = analyseDiskChain("[run.sh] built", "");
  assertEquals(verdict.volumeInitSeen, false);
  assertEquals(verdict.findings, []);
});

/** A run in which everything held. */
function passingRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    host: "Linux 6.8.0 x86_64",
    checkout: "/home/ubuntu/vibe-coder-runtime",
    commit: "abc1234",
    transcript: "/home/ubuntu/vibe-first-run-verification/run",
    stages: [
      { name: "setup", status: "PASS", detail: "exit 0", log: "03-setup.log" },
      { name: "claim", status: "PASS", detail: "exit 0", log: "07-claim.log" },
    ],
    freshState: { violations: [], notes: [] },
    findings: [],
    ...overrides,
  };
}

Deno.test("verdictFor - PASS needs every stage passed, no workaround and no defect", () => {
  assertEquals(verdictFor(passingRun()), "PASS");
  assertEquals(
    verdictFor(passingRun({
      freshState: { violations: ["VIBE_SKIP_PREREQ_CHECK is set"], notes: [] },
    })),
    "FAIL",
  );
  assertEquals(
    verdictFor(passingRun({
      findings: [{
        kind: "defect",
        summary: "Podman refused a tmpfs mount option (Issue #727)",
        evidence: "unknown mount option",
      }],
    })),
    "FAIL",
  );
});

Deno.test("verdictFor - a skipped stage is not a pass", () => {
  assertEquals(
    verdictFor(passingRun({
      stages: [
        { name: "setup", status: "PASS", detail: "exit 0", log: "s.log" },
        { name: "claim", status: "SKIPPED", detail: "not run", log: "c.log" },
      ],
    })),
    "FAIL",
  );
});

Deno.test("verdictFor - an expected warning does not fail the run", () => {
  assertEquals(
    verdictFor(passingRun({
      findings: [{
        kind: "expected",
        summary: "private-repository ruleset 403, non-fatal (Issue #733)",
        evidence: "repository rulesets need GitHub Pro",
      }],
    })),
    "PASS",
  );
});

Deno.test("renderReport - separates expected warnings from defects to file", () => {
  const markdown = renderReport(passingRun({
    stages: [
      {
        name: "launch",
        status: "FAIL",
        detail: "exit 1",
        log: "05-launch.log",
      },
    ],
    freshState: { violations: [], notes: ["a distribution default"] },
    findings: [
      {
        kind: "expected",
        summary: "private-repository ruleset 403, non-fatal (Issue #733)",
        evidence: "repository rulesets need GitHub Pro",
      },
      {
        kind: "defect",
        summary: "Podman refused a tmpfs mount option (Issue #727)",
        evidence: 'unknown mount option "uid=1000"',
      },
    ],
  }));
  assertStringIncludes(markdown, "verdict: **FAIL**");
  assertStringIncludes(markdown, "| 1 | launch | FAIL |");
  assertStringIncludes(markdown, "Issue #733");
  assertStringIncludes(markdown, "file as a further sub-issue of #722");
  assertStringIncludes(markdown, "a distribution default");
  assert(
    markdown.indexOf("## Expected warnings") <
      markdown.indexOf("## New defects"),
    "the two lists must stay separate and ordered",
  );
});

Deno.test("renderReport - a clean run says so in both lists", () => {
  const markdown = renderReport(passingRun());
  assertStringIncludes(markdown, "verdict: **PASS**");
  assertStringIncludes(markdown, "None — the host carried no workaround.");
  assertStringIncludes(markdown, "None — no workaround was required.");
});

Deno.test("parseStages - reads the stage record the shell writes", () => {
  const stages = parseStages(
    "fresh-state\tPASS\texit 0\t01-fresh-state.log\n" +
      "setup\tSKIPPED\tan earlier stage failed\t03-setup.log\n",
    "stages.tsv",
  );
  assertEquals(stages.length, 2);
  assertEquals(stages[1]!.status, "SKIPPED");
});

Deno.test("parseStages - a malformed record fails loud rather than dropping a stage", () => {
  for (
    const [text, expected] of [
      ["setup\tPASS\texit 0\n", "not name/status/detail/log"],
      ["setup\tOK\texit 0\ts.log\n", "which is not"],
      ["\n", "records no stages"],
    ] as Array<[string, string]>
  ) {
    let message = "";
    try {
      parseStages(text, "stages.tsv");
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, expected);
  }
});

Deno.test("evaluateClaim - a worker that finished one issue passes", () => {
  const verdict = evaluateClaim(
    "Processing issue owner/repo#42\nSuccessfully processed owner/repo#42\n",
  );
  assertEquals(verdict, {
    claimed: true,
    completed: true,
    detail: "one issue completed",
  });
});

Deno.test("evaluateClaim - a worker that claimed but finished nothing is not a pass", () => {
  const verdict = evaluateClaim("Processing issue owner/repo#42\n");
  assertEquals(verdict.claimed, true);
  assertEquals(verdict.completed, false);
  assertStringIncludes(verdict.detail, "did not complete");
});

Deno.test("evaluateClaim - a silent log is nothing seen, never a pass", () => {
  const verdict = evaluateClaim("");
  assertEquals(verdict.claimed, false);
  assertEquals(verdict.completed, false);
  assertStringIncludes(verdict.detail, "claimed no issue");
});

Deno.test("analyseDiskChain - the worker's claim-time refusal names its floor and free space", () => {
  // The worker refuses to claim in worker.log, in GB; the launcher refuses to
  // start in run_core.log, in MB. Criterion 7 of Issue #736 is about the
  // claim, so a run that reads only the launcher would report this as "claimed
  // nothing" with neither figure.
  const verdict = analyseDiskChain(
    "",
    "",
    "[HOST_DISK_LOW] 3.2 GB free (4.1%) of 78.0 GB, floor 8.0 GB — below the " +
      "floor — draining the issue pool before claiming further work (Issue #226).",
  );
  assertEquals(verdict.refused, true);
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "expected");
  assertStringIncludes(verdict.findings[0]!.summary, "named both");
});

Deno.test("analyseDiskChain - a claim refusal that names neither figure is the Issue #732 defect", () => {
  const verdict = analyseDiskChain("", "", "[HOST_DISK_LOW] draining the pool");
  assertEquals(verdict.findings.length, 1);
  assertEquals(verdict.findings[0]!.kind, "defect");
  assertStringIncludes(verdict.findings[0]!.summary, "Issue #732");
});

Deno.test("renderReport - a secret quoted from a stage log never reaches the issue", () => {
  const report = renderReport({
    host: "Linux",
    checkout: "/home/ubuntu/vibe-coder-runtime",
    commit: "abc1234",
    transcript: "/tmp/t",
    stages: [{
      name: "setup",
      status: "PASS",
      detail: "exit 0",
      log: "03.log",
    }],
    freshState: { violations: [], notes: [] },
    findings: [{
      kind: "defect",
      summary:
        "setup demanded the Claude CLI on a Codex-only host (Issue #730)",
      evidence: "token=sk-ant-api03-" + "A".repeat(80) + "AA",
    }],
  });
  assertEquals(report.includes("sk-ant-api03-AAAA"), false);
});

Deno.test("analyseDiskChain - a claim refusal does not implicate the volume", () => {
  // The volume-init row and the disk refusal have different owners: reporting
  // a claim-time refusal against volume initialisation sends a reader to the
  // wrong subsystem.
  const verdict = analyseDiskChain(
    "volume-init: trimmed /work",
    "",
    "[HOST_DISK_LOW] 3.2 GB free (4.1%) of 78.0 GB, floor 8.0 GB — below the floor",
  );
  assertEquals(verdict.volumeInitSeen, true);
  assertEquals(verdict.volumeImplicated, false);
});

Deno.test("analyseDiskChain - a refused trim followed by a refused launch implicates the volume", () => {
  const verdict = analyseDiskChain(
    "volume-init: /work - this runtime does not support discard",
    "[run.sh] refusing to launch: / has 900 MB free, below the 8 GB hard floor",
    "",
  );
  assertEquals(verdict.volumeImplicated, true);
});
