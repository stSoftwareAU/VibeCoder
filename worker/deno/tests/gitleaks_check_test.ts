/**
 * Tests for gitleaks_check.ts (Issue #5121).
 *
 * Covers:
 *   - PASSED only on exit 0 with `no leaks found` and no ERR/FTL line; the
 *     scan receives the commit range and the repository config when present;
 *   - a finding is FAILED with its rule and file, and the secret never appears
 *     in the output (redacted, even when the fake stdout carries it);
 *   - a bad revision range exits 0 yet is FAILED, not PASSED (observed in
 *     gitleaks 8.30.1);
 *   - a missing config and a deadline hit are FAILED;
 *   - loud SKIPPED outside a git repository; an unresolvable diff base (origin/HEAD
 *     unset, a failed history deepen, a failed merge-base) is SKIPPED on a host
 *     but an infrastructure FAILED inside the fleet image;
 *   - the babysitter repair's tree scan (`runGitleaksTreeCheck`): a finding is
 *     `blocked`, a missing scanner or unresolvable history is `infrastructure`;
 *   - gitleaks absent is SKIPPED on a host but FAILED inside the fleet image;
 *   - a version drift is named while the scan still runs;
 *   - the CI pin, flags and fallback command in `gitleaks.yml` match the module;
 *   - the real quality gate registers the stage only where `gitleaks.yml` exists;
 *   - a real-tool scan of a temp repository (skipped where gitleaks is not
 *     installed).
 *
 * Australian English spelling used throughout (behaviour, licence, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  GITLEAKS_CONFIG_PATH,
  GITLEAKS_VERSION,
  type GitleaksCheckOptions,
  gitleaksFileScanArgs,
  gitleaksScanArgs,
  type GitleaksTreeCheckOptions,
  runGitleaksCheck,
  runGitleaksTreeCheck,
} from "../lib/gitleaks_check.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "../lib/failure_diagnosis.ts";
import {
  type EnsureHistory,
  type GitRunner,
  probe,
  type SemgrepRunResult,
} from "../lib/semgrep_check.ts";
import { CONTAINER_IMAGE_STAMP_ENV } from "../lib/container_stamp.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import { runQualityGate } from "../lib/quality_gate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A token-shaped string built at runtime, so this file holds no matchable
 * secret. It goes into the fake stdout to prove the output is redacted.
 */
const FAKE_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(
  "",
);

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Fake `git` answering the same probes `resolveDiffBase` makes. */
function fakeGit(
  overrides: Record<string, { exitCode?: number; stdout?: string }> = {},
): GitRunner {
  const responses: Record<string, { exitCode: number; stdout: string }> = {
    "rev-parse --is-inside-work-tree": { exitCode: 0, stdout: "true\n" },
    "rev-parse --abbrev-ref refs/remotes/origin/HEAD": {
      exitCode: 0,
      stdout: "origin/main\n",
    },
    "merge-base origin/main HEAD": { exitCode: 0, stdout: `${BASE_SHA}\n` },
  };
  for (const [key, value] of Object.entries(overrides)) {
    responses[key] = {
      exitCode: value.exitCode ?? 0,
      stdout: value.stdout ?? "",
    };
  }
  return (args: string[]) => {
    const hit = responses[args.join(" ")];
    return Promise.resolve(hit ?? { exitCode: 1, stdout: "" });
  };
}

/** An ensure-history step that always succeeds. */
const okHistory: EnsureHistory = () =>
  Promise.resolve({ ok: true, value: undefined });

/** Environment with no container stamp: a host run. */
const hostEnv: EnvLookup = () => undefined;

/** Environment carrying the container image stamp: a fleet image run. */
const imageEnv: EnvLookup = (name) =>
  name === CONTAINER_IMAGE_STAMP_ENV ? "claude" : undefined;

/** A scan that must not be reached. Tests that expect no spawn pass it. */
const unexpectedRun = (): Promise<SemgrepRunResult> =>
  Promise.reject(new Error("the scan must not run in this case"));

/** A scan that records its argv and returns a fixed result. */
function recordingRun(result: SemgrepRunResult): {
  calls: string[][];
  run: (args: string[]) => Promise<SemgrepRunResult>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(result);
    },
  };
}

/** Options for a host run that reaches the scan, with the given overrides. */
function options(
  overrides: GitleaksCheckOptions = {},
): GitleaksCheckOptions {
  return {
    git: fakeGit(),
    ensureHistory: okHistory,
    probeVersion: () => Promise.resolve(GITLEAKS_VERSION),
    run: unexpectedRun,
    env: hostEnv,
    ...overrides,
  };
}

/** Finding output as gitleaks prints it on stdout, with the token inline. */
const LEAK_STDOUT = [
  `Finding:     const token = "${FAKE_TOKEN}";`,
  "Secret:      REDACTED",
  "RuleID:      github-pat",
  "Entropy:     4.912345",
  "File:        worker/deno/lib/leaky.ts",
  "Line:        3",
  `Commit:      ${BASE_SHA}`,
].join("\n");

const LEAK_STDERR =
  "6:39PM INF 1 commits scanned.\n6:39PM WRN leaks found: 1\n";

const CLEAN_STDERR =
  "6:39PM INF 1 commits scanned.\n6:39PM INF no leaks found\n";

/** Observed in gitleaks 8.30.1: a bad range still exits 0. */
const AMBIGUOUS_STDERR = [
  "6:39PM ERR [git] fatal: ambiguous argument 'nosuchref..HEAD': unknown revision or path not in the working tree.",
  '6:39PM ERR error="stderr is not empty"',
  "6:39PM INF no leaks found",
  "",
].join("\n");

const MISSING_CONFIG_STDERR =
  "6:39PM FTL unable to load gitleaks config, err: open /tmp/x/.github/gitleaks.toml: no such file or directory\n";

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

Deno.test("gitleaksScanArgs - scans the range with the CI flags and an optional config", () => {
  assertEquals(
    gitleaksScanArgs("aaa..bbb", "/repo/.github/gitleaks.toml"),
    [
      "git",
      "--config",
      "/repo/.github/gitleaks.toml",
      "--redact",
      "--no-banner",
      "--exit-code",
      "1",
      "--verbose",
      "--no-color",
      "--log-opts=aaa..bbb",
      ".",
    ],
  );
  assertEquals(
    gitleaksScanArgs("aaa..bbb", null),
    [
      "git",
      "--redact",
      "--no-banner",
      "--exit-code",
      "1",
      "--verbose",
      "--no-color",
      "--log-opts=aaa..bbb",
      ".",
    ],
  );
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

Deno.test("runGitleaksCheck - PASSED on exit 0 with no leaks, passing the range and the config", async () => {
  const scriptDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${scriptDir}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${scriptDir}/${GITLEAKS_CONFIG_PATH}`,
      "[extend]\n",
    );
    const recorded = recordingRun({
      exitCode: 0,
      stdout: "",
      stderr: CLEAN_STDERR,
    });

    const result = await runGitleaksCheck(
      scriptDir,
      options({ run: recorded.run }),
    );

    assertEquals(result.status, "PASSED");
    assertStringIncludes(result.output, "gitleaks: PASSED");
    assertStringIncludes(result.output, BASE_SHA.slice(0, 12));
    assertStringIncludes(
      result.output,
      "uncommitted changes are not scanned, as in CI",
    );
    assertEquals(recorded.calls.length, 1);
    assertEquals(
      recorded.calls[0],
      gitleaksScanArgs(
        `${BASE_SHA}..HEAD`,
        `${scriptDir}/${GITLEAKS_CONFIG_PATH}`,
      ),
    );
  } finally {
    await Deno.remove(scriptDir, { recursive: true });
  }
});

Deno.test("runGitleaksCheck - passes no config when the repository has none", async () => {
  const scriptDir = await Deno.makeTempDir();
  try {
    const recorded = recordingRun({
      exitCode: 0,
      stdout: "",
      stderr: CLEAN_STDERR,
    });

    const result = await runGitleaksCheck(
      scriptDir,
      options({ run: recorded.run }),
    );

    assertEquals(result.status, "PASSED");
    assertEquals(
      recorded.calls[0],
      gitleaksScanArgs(`${BASE_SHA}..HEAD`, null),
    );
  } finally {
    await Deno.remove(scriptDir, { recursive: true });
  }
});

Deno.test("runGitleaksCheck - FAILED on a finding, naming the rule and file, never the secret", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      run: recordingRun({
        exitCode: 1,
        stdout: LEAK_STDOUT,
        stderr: LEAK_STDERR,
      }).run,
    }),
  );

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "RuleID:      github-pat");
  assertStringIncludes(result.output, "File:        worker/deno/lib/leaky.ts");
  assertStringIncludes(result.output, "leaks found: 1");
  assertStringIncludes(result.output, ".github/workflows/gitleaks.yml");
  assert(
    !result.output.includes(FAKE_TOKEN),
    "the raw token must not reach the output",
  );
});

Deno.test("runGitleaksCheck - FAILED, not PASSED, on exit 0 with a bad revision range", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      run: recordingRun({
        exitCode: 0,
        stdout: "",
        stderr: AMBIGUOUS_STDERR,
      }).run,
    }),
  );

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "scanner error");
  assertStringIncludes(result.output, "ambiguous argument");
});

Deno.test("runGitleaksCheck - FAILED on a missing config, quoting the cause", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      run: recordingRun({
        exitCode: 1,
        stdout: "",
        stderr: MISSING_CONFIG_STDERR,
      }).run,
    }),
  );

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "unable to load gitleaks config");
});

Deno.test("runGitleaksCheck - FAILED when the scan exceeds its deadline", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      run: () =>
        Promise.resolve({
          exitCode: -1,
          stdout: "",
          stderr: "",
          timedOut: true,
        }),
    }),
  );

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "local deadline");
});

// ---------------------------------------------------------------------------
// SKIPPED outcomes
// ---------------------------------------------------------------------------

Deno.test("runGitleaksCheck - SKIPPED outside a git repository, with the reason", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      git: fakeGit({
        "rev-parse --is-inside-work-tree": { exitCode: 128 },
      }),
    }),
  );

  assertEquals(result.status, "SKIPPED");
  assertEquals(
    result.output,
    "gitleaks: SKIPPED (not a git repository — no commit range to scan)",
  );
});

Deno.test("runGitleaksCheck - SKIPPED with the reason when origin/HEAD is unset", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      git: fakeGit({
        "rev-parse --abbrev-ref refs/remotes/origin/HEAD": { exitCode: 128 },
      }),
    }),
  );

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, "origin/HEAD is unset");
});

/** The three ways the diff base fails to resolve, each with its host wording. */
const UNRESOLVED_BASE_CASES: {
  name: string;
  options: Partial<GitleaksCheckOptions>;
  reason: string;
}[] = [
  {
    name: "origin/HEAD unset",
    options: {
      git: fakeGit({
        "rev-parse --abbrev-ref refs/remotes/origin/HEAD": { exitCode: 128 },
      }),
    },
    reason: "origin/HEAD is unset",
  },
  {
    name: "history deepening failed",
    options: {
      ensureHistory: () =>
        Promise.resolve({ ok: false, error: new Error("fetch refused") }),
    },
    reason: "could not deepen history before resolving the diff base",
  },
  {
    name: "merge-base failed",
    options: {
      git: fakeGit({ "merge-base origin/main HEAD": { exitCode: 1 } }),
    },
    reason: "merge-base with origin/main failed after deepening",
  },
];

for (const unresolved of UNRESOLVED_BASE_CASES) {
  Deno.test(`runGitleaksCheck - ${unresolved.name} is SKIPPED on a host and FAILED, as an infrastructure fault, inside the fleet image`, async () => {
    const host = await runGitleaksCheck(
      "/unused-scriptdir",
      options({ ...unresolved.options, env: hostEnv }),
    );
    const image = await runGitleaksCheck(
      "/unused-scriptdir",
      options({ ...unresolved.options, env: imageEnv }),
    );

    assertEquals(host.status, "SKIPPED");
    assertStringIncludes(host.output, unresolved.reason);
    assertEquals(image.status, "FAILED");
    assertStringIncludes(image.output, unresolved.reason);
    assertStringIncludes(image.output, "never scanned");
    // The worker's recovery reads the output: this must be a retried fault,
    // not a failure the remediation agent is asked to fix.
    assert(
      isInfrastructureFailure(detectFailureCategory(image.output)),
      `not classed as infrastructure: ${image.output}`,
    );
  });
}

Deno.test("runGitleaksCheck - gitleaks absent is SKIPPED on a host", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      probeVersion: () => Promise.resolve(null),
      env: hostEnv,
    }),
  );

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, `install gitleaks ${GITLEAKS_VERSION}`);
});

Deno.test("runGitleaksCheck - gitleaks absent is FAILED inside the fleet image", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      probeVersion: () => Promise.resolve(null),
      env: imageEnv,
    }),
  );

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "fleet container image");
  assertStringIncludes(result.output, "the image is broken, not the change");
});

Deno.test("runGitleaksCheck - a blank container stamp is a host run, so gitleaks absent is SKIPPED", async () => {
  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      probeVersion: () => Promise.resolve(null),
      env: (name) => (name === CONTAINER_IMAGE_STAMP_ENV ? "   " : undefined),
    }),
  );

  assertEquals(result.status, "SKIPPED");
});

Deno.test("runGitleaksCheck - a version drift is named and the scan still runs", async () => {
  const recorded = recordingRun({
    exitCode: 0,
    stdout: "",
    stderr: CLEAN_STDERR,
  });

  const result = await runGitleaksCheck(
    "/unused-scriptdir",
    options({
      probeVersion: () => Promise.resolve("8.29.0"),
      run: recorded.run,
    }),
  );

  assertEquals(recorded.calls.length, 1);
  assertEquals(result.status, "PASSED");
  assertStringIncludes(result.output, "gitleaks 8.29.0");
  assertStringIncludes(
    result.output,
    `differs from the CI pin ${GITLEAKS_VERSION}`,
  );
});

// ---------------------------------------------------------------------------
// Twin of the CI fallback in gitleaks.yml
// ---------------------------------------------------------------------------

Deno.test("gitleaks.yml - every pinned GITLEAKS_VERSION matches the module, and the fallback flags are scanned", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../../../.github/workflows/gitleaks.yml", import.meta.url),
  );

  const pins = [...workflow.matchAll(/GITLEAKS_VERSION:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(pins.length >= 1, "gitleaks.yml must pin GITLEAKS_VERSION");
  for (const pin of pins) {
    assertEquals(pin, GITLEAKS_VERSION);
  }

  // The pin is read from the CI fallback command itself, so adding, removing
  // or changing a flag in gitleaks.yml (or in gitleaksScanArgs) turns this red.
  const ciArgs = ciFallbackScanArgs(workflow);
  const ciRange = ciArgs.find((arg) => arg.startsWith("--log-opts="));
  assertEquals(
    ciRange,
    "--log-opts=${BASE_SHA}..${HEAD_SHA}",
    "the CI fallback must scan the <base>..<head> commit range",
  );

  // The local stage adds only --verbose and --no-color (for readable gate
  // output); the config path and the range differ by environment.
  const localArgs = gitleaksScanArgs(
    `${BASE_SHA}..HEAD`,
    `/repo/${GITLEAKS_CONFIG_PATH}`,
  ).filter((arg) => arg !== "--verbose" && arg !== "--no-color");
  assertEquals(normaliseScanArgs(localArgs), normaliseScanArgs(ciArgs));
});

/**
 * Extract the `./gitleaks git …` command from the CLI-fallback step of
 * gitleaks.yml, joining `\` continuation lines, and split it into arguments
 * with shell-style double quotes removed.
 */
function ciFallbackScanArgs(workflow: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) =>
    line.trim().startsWith("./gitleaks git ")
  );
  assert(start >= 0, "gitleaks.yml must run `./gitleaks git` in the fallback");
  let command = "";
  for (let i = start; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.endsWith("\\")) {
      command += line.slice(0, -1) + " ";
    } else {
      command += line;
      break;
    }
  }
  const tokens = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return tokens.slice(1).map((token) => token.replaceAll('"', ""));
}

/** Replace the environment-specific config path and range with placeholders. */
function normaliseScanArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    if (args[i - 1] === "--config") return "<config>";
    if (/^--log-opts=[^.\s]+\.\.[^.\s]+$/.test(arg)) {
      return "--log-opts=<base>..<head>";
    }
    return arg;
  });
}

// ---------------------------------------------------------------------------
// Registration in the real quality gate
// ---------------------------------------------------------------------------

Deno.test("runQualityGate - registers gitleaks only where gitleaks.yml exists", async () => {
  const withWorkflow = await Deno.makeTempDir();
  const withoutWorkflow = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${withWorkflow}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${withWorkflow}/.github/workflows/gitleaks.yml`,
      "name: gitleaks\n",
    );

    const gateOptions = {
      strict: false,
      sequential: true,
      validatePrompts: false,
    };

    // The temp directory is not a git repository, so the stage is SKIPPED
    // before any scanner is probed.
    const present = await runQualityGate({
      scriptDir: withWorkflow,
      options: gateOptions,
    });
    assert(present.ok, "quality gate should return a result");
    const gitleaks = present.value.checks.find((check) =>
      check.name === "gitleaks"
    );
    assert(
      gitleaks !== undefined,
      "Gate must run gitleaks where gitleaks.yml exists (Issue #5121)",
    );
    assertEquals(gitleaks?.status, "SKIPPED");

    const absent = await runQualityGate({
      scriptDir: withoutWorkflow,
      options: gateOptions,
    });
    assert(absent.ok, "quality gate should return a result");
    const absentNames = absent.value.checks.map((check) => check.name);
    assert(
      !absentNames.includes("gitleaks"),
      `Gate must not run gitleaks where gitleaks.yml is absent; recorded: ${
        absentNames.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(withWorkflow, { recursive: true });
    await Deno.remove(withoutWorkflow, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Real tools: a temp repository scanned by the installed gitleaks
// ---------------------------------------------------------------------------

/** Whether a gitleaks binary runs on this host. Probed once, at load. */
const gitleaksAvailable = (await probe("gitleaks", ["version"])) !== null;

/** Run git in the given cwd with a clean, non-interactive environment. */
async function runGit(cwd: string, args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

/**
 * A repository with `main` as the remote's default branch and a `feature`
 * branch carrying one commit that adds `fileName` with `content`.
 */
async function repoWithFeatureFile(
  fileName: string,
  content: string,
): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "gitleaks-check-" });
  await runGit(repo, ["init", "-b", "main"]);
  await Deno.writeTextFile(`${repo}/README.md`, "base\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "base"]);
  await runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await runGit(repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  await runGit(repo, ["checkout", "-b", "feature"]);
  await Deno.writeTextFile(`${repo}/${fileName}`, content);
  await runGit(repo, ["add", fileName]);
  await runGit(repo, ["commit", "-m", "feature"]);
  return repo;
}

Deno.test({
  name:
    "runGitleaksCheck - real gitleaks FAILED on a committed fake token (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const repo = await repoWithFeatureFile(
      "leak.ts",
      `export const token = "${FAKE_TOKEN}";\n`,
    );
    try {
      const result = await runGitleaksCheck(repo, { ensureHistory: okHistory });
      assertEquals(result.status, "FAILED");
      assertStringIncludes(result.output, "github-pat");
      assert(
        !result.output.includes(FAKE_TOKEN),
        "the raw token must not reach the output",
      );
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runGitleaksCheck - real gitleaks PASSED on a clean branch (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const repo = await repoWithFeatureFile("clean.ts", "export const n = 1;\n");
    try {
      const result = await runGitleaksCheck(repo, { ensureHistory: okHistory });
      assertEquals(result.status, "PASSED");
      assertStringIncludes(result.output, "gitleaks: PASSED");
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runGitleaksCheck - real gitleaks FAILED on a fake token an earlier branch commit added and a later commit deleted (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const repo = await repoWithFeatureFile(
      "leak.ts",
      `export const token = "${FAKE_TOKEN}";\n`,
    );
    try {
      await runGit(repo, ["rm", "-q", "leak.ts"]);
      await runGit(repo, ["commit", "-m", "remove the secret"]);
      // Control: the token is gone from HEAD, so only history still holds it.
      await assertRejects(
        () => Deno.stat(`${repo}/leak.ts`),
        Deno.errors.NotFound,
      );

      const result = await runGitleaksCheck(repo, { ensureHistory: okHistory });

      assertEquals(result.status, "FAILED");
      assertStringIncludes(result.output, "github-pat");
      assert(
        !result.output.includes(FAKE_TOKEN),
        "the raw token must not reach the output",
      );
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Babysitter repair tree scan (PR #5129 review)
// ---------------------------------------------------------------------------

/**
 * Fake `git` for the tree scan. `merge-base` answers with `mergeBase`; a path
 * is in `HEAD` only when `diffs` holds its `git diff -U0 HEAD` output.
 */
function treeGit(
  mergeBase: { exitCode: number; stdout: string } = {
    exitCode: 0,
    stdout: `${BASE_SHA}\n`,
  },
  diffs: Record<string, { exitCode: number; stdout: string }> = {},
): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  return {
    calls,
    git: (args: string[]) => {
      calls.push(args);
      if (args[0] === "merge-base") return Promise.resolve(mergeBase);
      const path = args[args.length - 1]!;
      if (args[0] === "cat-file") {
        const tracked = Object.keys(diffs).some((p) => `HEAD:${p}` === path);
        return Promise.resolve({ exitCode: tracked ? 0 : 1, stdout: "" });
      }
      const diff = diffs[path];
      return Promise.resolve(diff ?? { exitCode: 128, stdout: "" });
    },
  };
}

/** A JSON report, as `gitleaks dir --report-format json` writes it. */
function jsonReport(
  findings: { file: string; start: number; end?: number }[],
): string {
  return JSON.stringify(findings.map((finding) => ({
    RuleID: "github-pat",
    StartLine: finding.start,
    EndLine: finding.end ?? finding.start,
    Match: `const token = "${FAKE_TOKEN}";`,
    Secret: "REDACTED",
    File: finding.file,
  })));
}

/** `git diff -U0 HEAD` output adding `count` lines at `start`. */
function diffAdding(start: number, count: number): {
  exitCode: number;
  stdout: string;
} {
  return {
    exitCode: 0,
    stdout: `diff --git a/x b/x\n@@ -${start},0 +${start},${count} @@\n+x\n`,
  };
}

/** A temp clone holding the given files, removed after `body`. */
async function withTree(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "gitleaks-tree-5129-" });
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.mkdir(`${dir}/${name.split("/").slice(0, -1).join("/")}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Tree-scan options that reach the scan, with a scripted result per call. */
function treeOptions(
  results: SemgrepRunResult[],
  overrides: GitleaksTreeCheckOptions = {},
): { calls: string[][]; options: GitleaksTreeCheckOptions } {
  const calls: string[][] = [];
  return {
    calls,
    options: {
      git: treeGit().git,
      probeVersion: () => Promise.resolve(GITLEAKS_VERSION),
      run: (args) => {
        calls.push(args);
        const next = results[calls.length - 1];
        return next === undefined
          ? Promise.reject(new Error("an unscripted scan ran"))
          : Promise.resolve(next);
      },
      ...overrides,
    },
  };
}

const CLEAN_RUN: SemgrepRunResult = {
  exitCode: 0,
  stdout: "",
  stderr: CLEAN_STDERR,
};

Deno.test("runGitleaksTreeCheck - a clean range and clean uncommitted files pass, scanning the range and each file that still exists", async () => {
  await withTree({ "a/new.ts": "export const n = 1;\n" }, async (dir) => {
    const { calls, options } = treeOptions([CLEAN_RUN, CLEAN_RUN]);

    const outcome = await runGitleaksTreeCheck(
      dir,
      "main",
      ["a/new.ts", "deleted.ts"],
      options,
    );

    assertEquals(outcome.kind, "passed");
    assertEquals(calls.length, 2, "the range and the one surviving file");
    assertEquals(calls[0], gitleaksScanArgs(`${BASE_SHA}..HEAD`, null));
    assertEquals(calls[1], gitleaksFileScanArgs("a/new.ts", null));
  });
});

Deno.test("runGitleaksTreeCheck - the base is merged against origin/<baseBranch>, or origin/HEAD with none", async () => {
  await withTree({}, async (dir) => {
    for (
      const [baseBranch, ref] of [
        ["release/1", "refs/remotes/origin/release/1"],
        [undefined, "refs/remotes/origin/HEAD"],
      ] as const
    ) {
      const fake = treeGit();
      const { options } = treeOptions([CLEAN_RUN], { git: fake.git });

      const outcome = await runGitleaksTreeCheck(dir, baseBranch, [], options);

      assertEquals(outcome.kind, "passed");
      assertEquals(fake.calls, [["merge-base", ref, "HEAD"]]);
    }
  });
});

Deno.test("runGitleaksTreeCheck - a finding in an uncommitted file is blocked with its rule and path, and never prints the secret", async () => {
  await withTree({ "leak.ts": "x\n" }, async (dir) => {
    const { options } = treeOptions([
      CLEAN_RUN,
      {
        exitCode: 1,
        stdout: jsonReport([{ file: "leak.ts", start: 1 }]),
        stderr: LEAK_STDERR,
      },
    ]);

    const outcome = await runGitleaksTreeCheck(
      dir,
      "main",
      ["leak.ts"],
      options,
    );

    assertEquals(outcome.kind, "blocked");
    const message = (outcome as { message: string }).message;
    assertStringIncludes(message, "github-pat");
    assertStringIncludes(message, "uncommitted file leak.ts");
    assertStringIncludes(message, "Line: 1");
    assert(!message.includes(FAKE_TOKEN), "the raw token must not be quoted");
  });
});

Deno.test("runGitleaksTreeCheck - a finding in a tracked file blocks only when it touches a line the repair added, as CI's patch scan does", async () => {
  await withTree({ "auth.ts": "x\n" }, async (dir) => {
    // The base already holds a match at lines 10-15 (like the PEM markers in
    // github_app_auth.ts); CI never re-reads it unless the PR adds those lines.
    const report = jsonReport([{ file: "auth.ts", start: 10, end: 15 }]);
    const leak = { exitCode: 1, stdout: report, stderr: LEAK_STDERR };
    for (
      const [diff, expected] of [
        [diffAdding(1, 1), "passed"],
        [diffAdding(16, 3), "passed"],
        [diffAdding(12, 1), "blocked"],
        [diffAdding(9, 2), "blocked"],
      ] as const
    ) {
      const { options } = treeOptions([CLEAN_RUN, leak], {
        git: treeGit(undefined, { "auth.ts": diff }).git,
      });

      const outcome = await runGitleaksTreeCheck(
        dir,
        "main",
        ["auth.ts"],
        options,
      );

      assertEquals(outcome.kind, expected, diff.stdout);
    }
  });
});

Deno.test("runGitleaksTreeCheck - an unreadable report or a failed diff is infrastructure, never a pass", async () => {
  await withTree({ "auth.ts": "x\n" }, async (dir) => {
    const unreadable = await runGitleaksTreeCheck(
      dir,
      "main",
      ["auth.ts"],
      treeOptions([CLEAN_RUN, {
        exitCode: 1,
        stdout: LEAK_STDOUT,
        stderr: LEAK_STDERR,
      }]).options,
    );
    assertEquals(unreadable.kind, "infrastructure");
    assert(
      !(unreadable as { message: string }).message.includes(FAKE_TOKEN),
      "the raw token must not be quoted",
    );

    const failedDiff = await runGitleaksTreeCheck(
      dir,
      "main",
      ["auth.ts"],
      treeOptions([CLEAN_RUN, {
        exitCode: 1,
        stdout: jsonReport([{ file: "auth.ts", start: 1 }]),
        stderr: LEAK_STDERR,
      }], {
        git: treeGit(undefined, {
          "auth.ts": { exitCode: 128, stdout: "" },
        }).git,
      }).options,
    );
    assertEquals(failedDiff.kind, "infrastructure");
    assertStringIncludes(
      (failedDiff as { message: string }).message,
      "git diff HEAD",
    );
  });
});

Deno.test("runGitleaksTreeCheck - a finding in the commit range is blocked, and no file is scanned after it", async () => {
  await withTree({ "a.ts": "x\n" }, async (dir) => {
    const { calls, options } = treeOptions([
      { exitCode: 1, stdout: LEAK_STDOUT, stderr: LEAK_STDERR },
    ]);

    const outcome = await runGitleaksTreeCheck(dir, "main", ["a.ts"], options);

    assertEquals(outcome.kind, "blocked");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "leaks found in commit range",
    );
    assertEquals(calls.length, 1);
  });
});

Deno.test("runGitleaksTreeCheck - a missing scanner is infrastructure and nothing is scanned", async () => {
  await withTree({ "a.ts": "x\n" }, async (dir) => {
    const { calls, options } = treeOptions([], {
      probeVersion: () => Promise.resolve(null),
    });

    const outcome = await runGitleaksTreeCheck(dir, "main", ["a.ts"], options);

    assertEquals(outcome.kind, "infrastructure");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "not installed or not in PATH",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("runGitleaksTreeCheck - an unresolvable diff base is infrastructure and nothing is scanned", async () => {
  await withTree({ "a.ts": "x\n" }, async (dir) => {
    for (
      const mergeBase of [
        { exitCode: 128, stdout: "" },
        { exitCode: 0, stdout: "\n" },
      ]
    ) {
      const { calls, options } = treeOptions([], {
        git: treeGit(mergeBase).git,
      });

      const outcome = await runGitleaksTreeCheck(
        dir,
        "main",
        ["a.ts"],
        options,
      );

      assertEquals(outcome.kind, "infrastructure");
      assertStringIncludes(
        (outcome as { message: string }).message,
        "refs/remotes/origin/main",
      );
      assertEquals(calls.length, 0);
    }
  });
});

Deno.test("runGitleaksTreeCheck - a scanner error and a deadline hit are infrastructure, never a pass", async () => {
  await withTree({ "a.ts": "x\n" }, async (dir) => {
    const errored = await runGitleaksTreeCheck(
      dir,
      "main",
      ["a.ts"],
      treeOptions([
        CLEAN_RUN,
        { exitCode: 1, stdout: "", stderr: MISSING_CONFIG_STDERR },
      ]).options,
    );
    const timedOut = await runGitleaksTreeCheck(
      dir,
      "main",
      ["a.ts"],
      treeOptions([{ exitCode: 143, stdout: "", stderr: "", timedOut: true }])
        .options,
    );

    assertEquals(errored.kind, "infrastructure");
    assertStringIncludes(
      (errored as { message: string }).message,
      "unable to load gitleaks config",
    );
    assertEquals(timedOut.kind, "infrastructure");
    assertStringIncludes(
      (timedOut as { message: string }).message,
      "local deadline",
    );
  });
});

Deno.test("runGitleaksTreeCheck - a path that is absolute or leaves the clone is blocked before any scan", async () => {
  await withTree({}, async (dir) => {
    for (const path of ["/etc/passwd", "../outside.txt", "a/../../b.txt"]) {
      const { calls, options } = treeOptions([]);

      const outcome = await runGitleaksTreeCheck(dir, "main", [path], options);

      assertEquals(outcome.kind, "blocked");
      assertEquals(calls.length, 0);
    }
  });
});

Deno.test("runGitleaksTreeCheck - a dash-leading file name is passed after `--` and a symlink is not scanned", async () => {
  await withTree({ "-flag.ts": "x\n" }, async (dir) => {
    await Deno.symlink("/etc/hostname", `${dir}/link.txt`);
    const { calls, options } = treeOptions([CLEAN_RUN, CLEAN_RUN]);

    const outcome = await runGitleaksTreeCheck(
      dir,
      "main",
      ["-flag.ts", "link.txt"],
      options,
    );

    assertEquals(outcome.kind, "passed");
    assertEquals(calls.length, 2);
    assertEquals(calls[1]!.slice(-2), ["--", "-flag.ts"]);
  });
});

Deno.test({
  name:
    "runGitleaksTreeCheck - real gitleaks blocks a fake token in an uncommitted new file and passes a clean tree (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const repo = await repoWithFeatureFile("clean.ts", "export const n = 1;\n");
    try {
      const clean = await runGitleaksTreeCheck(repo, "main", []);
      assertEquals(clean.kind, "passed");

      await Deno.writeTextFile(
        `${repo}/untracked.ts`,
        `export const token = "${FAKE_TOKEN}";\n`,
      );
      const untracked = await runGitleaksTreeCheck(repo, "main", [
        "untracked.ts",
      ]);
      assertEquals(untracked.kind, "blocked");
      const message = (untracked as { message: string }).message;
      assertStringIncludes(message, "github-pat");
      assertStringIncludes(message, "untracked.ts");
      assert(!message.includes(FAKE_TOKEN), "the raw token must not be quoted");
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runGitleaksTreeCheck - real gitleaks ignores a committed match on an untouched line and blocks an edit that adds one (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    // The base branch already holds the token (as the base holds the PEM
    // markers in github_app_auth.ts), so the PR's own range is clean.
    const repo = await repoWithFeatureFile("clean.ts", "export const n = 1;\n");
    try {
      await Deno.writeTextFile(
        `${repo}/held.ts`,
        `export const token = "${FAKE_TOKEN}";\n`,
      );
      await runGit(repo, ["add", "held.ts"]);
      await runGit(repo, ["commit", "-m", "held"]);
      await runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      await Deno.writeTextFile(
        `${repo}/held.ts`,
        `// a comment\nexport const token = "${FAKE_TOKEN}";\n`,
      );
      const untouched = await runGitleaksTreeCheck(repo, "main", ["held.ts"]);
      assertEquals(untouched.kind, "passed");

      await Deno.writeTextFile(
        `${repo}/held.ts`,
        `export const token = "${FAKE_TOKEN}";\n` +
          `export const again = "${FAKE_TOKEN}";\n`,
      );
      const added = await runGitleaksTreeCheck(repo, "main", ["held.ts"]);
      assertEquals(added.kind, "blocked");
      const message = (added as { message: string }).message;
      assertStringIncludes(message, "github-pat");
      assertStringIncludes(message, "Line: 2");
      assert(!message.includes("Line: 1"), "the untouched line must not block");
      assert(!message.includes(FAKE_TOKEN), "the raw token must not be quoted");
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});
