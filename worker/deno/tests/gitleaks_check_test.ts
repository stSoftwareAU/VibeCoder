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
 *   - loud SKIPPED outside a git repository and with an unresolvable diff base;
 *   - gitleaks absent is SKIPPED on a host but FAILED inside the fleet image;
 *   - a version drift is named while the scan still runs;
 *   - the CI pin, flags and fallback command in `gitleaks.yml` match the module;
 *   - the real quality gate registers the stage only where `gitleaks.yml` exists;
 *   - a real-tool scan of a temp repository (skipped where gitleaks is not
 *     installed).
 *
 * Australian English spelling used throughout (behaviour, licence, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GITLEAKS_CONFIG_PATH,
  GITLEAKS_VERSION,
  type GitleaksCheckOptions,
  gitleaksScanArgs,
  runGitleaksCheck,
} from "../lib/gitleaks_check.ts";
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

  const args = gitleaksScanArgs(
    `${BASE_SHA}..HEAD`,
    `/repo/${GITLEAKS_CONFIG_PATH}`,
  ).join(" ");
  assertStringIncludes(workflow, "./gitleaks git --config");
  for (const flag of ["--redact", "--no-banner", "--exit-code 1", "--config"]) {
    assertStringIncludes(workflow, flag);
    assertStringIncludes(args, flag);
  }
});

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
