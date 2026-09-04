/**
 * Tests for the CI-fix lane's shared state directory (Issue #552).
 *
 * Regression: the lane's two halves addressed different stores. Issue #580
 * moved the *processor* onto the work volume but left the *scanner*
 * (`findFailedCiChecks`) on the bare relative default `.ci_check_state`,
 * resolved against a cwd that is read-only in container mode. So the scanner
 * read retry counters that were never written there, and its green-build sweep
 * cleared auto-fix budgets in a directory the processor never touched — a
 * signature that reached the auto-fix cap stayed spent forever and the lane
 * escalated to a human instead of fixing the check. Semgrep failures then sat
 * until somebody asked for a fix by hand.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  CI_CHECK_STATE_DIR_NAME,
  FALLBACK_CI_CHECK_WORK_DIR,
  resolveCiCheckStateDir,
} from "../lib/ci_check_state_dir.ts";
import { recordCiCheckRetry } from "../lib/pr_ci_checks.ts";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import {
  computeFailureSignature,
  getAutoFixAttempts,
  recordAutoFixAttempt,
} from "../lib/auto_fix_attempt_tracker.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Environment stub — nothing here reads the real process environment. */
function envOf(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/**
 * A `gh` stub for one PR whose failed check runs are `checks`.
 *
 * Pass an empty `checks` array to model a green build.
 */
function ghStubFor(
  prNumber: number,
  checks: Array<{ id: number; name: string }>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: prNumber, headRefName: "issue-1-fix", baseRefName: "main" },
      ]));
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      return Promise.resolve(JSON.stringify(
        checks.map((check) => ({
          ...check,
          status: "completed",
          conclusion: "failure",
        })),
      ));
    }
    if (key.includes("annotations")) {
      return Promise.resolve(JSON.stringify([{
        path: "worker/deno/lib/planning_carrier.ts",
        start_line: 371,
        message: "detect-non-literal-regexp",
      }]));
    }
    return Promise.resolve("[]");
  };
}

/**
 * Scan options with **no** `stateDir` — the production default path.
 *
 * `workDir` is what steers that default (Issue #966). It used to be
 * `WORK_DIR`, set on the process and restored afterwards, which races
 * every other worker in the process; the value the scanner resolves its
 * store from is a path, so it is passed as one.
 */
function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
  workDir: string,
  overrides: Partial<CiCheckScanOptions> = {},
): CiCheckScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn,
    workDir,
    ...overrides,
  };
}

// ============================================================================
// resolveCiCheckStateDir
// ============================================================================

Deno.test("resolveCiCheckStateDir - places the store inside an explicit work directory", () => {
  assertEquals(
    resolveCiCheckStateDir("/home/vibe/auto-issue-work", envOf({})),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - strips trailing slashes from the work directory", () => {
  assertEquals(
    resolveCiCheckStateDir("/var/work//", envOf({})),
    `/var/work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - falls back to WORK_DIR when no work directory is passed", () => {
  assertEquals(
    resolveCiCheckStateDir(
      undefined,
      envOf({ WORK_DIR: "/srv/work", HOME: "/home/vibe" }),
    ),
    `/srv/work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - falls back to the home work directory when WORK_DIR is unset", () => {
  assertEquals(
    resolveCiCheckStateDir(undefined, envOf({ HOME: "/home/vibe" })),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - never returns a path relative to the working directory", () => {
  // The read-only-cwd regression: a blank, relative or root-only base must
  // still resolve somewhere absolute and writable.
  for (const workDir of ["", "   ", ".", "relative/dir", "/"]) {
    const resolved = resolveCiCheckStateDir(workDir, envOf({}));
    assertEquals(
      resolved.startsWith("/"),
      true,
      `expected an absolute path for work dir '${workDir}', got '${resolved}'`,
    );
    assertEquals(
      resolved,
      `${FALLBACK_CI_CHECK_WORK_DIR}/${CI_CHECK_STATE_DIR_NAME}`,
    );
  }
});

Deno.test("resolveCiCheckStateDir - ignores a relative WORK_DIR and uses HOME instead", () => {
  assertEquals(
    resolveCiCheckStateDir(
      undefined,
      envOf({ WORK_DIR: "some/relative/dir", HOME: "/home/vibe" }),
    ),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

// ============================================================================
// findFailedCiChecks — the scanner shares the processor's store
// ============================================================================

Deno.test("findFailedCiChecks - observes the retry cap written by the processor's store", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // The counter the processor writes, at the cap.
    const stateDir = resolveCiCheckStateDir(tmpDir);
    for (let i = 0; i < 3; i++) {
      await recordCiCheckRetry(stateDir, "org/repo", "99156131115");
    }

    const result = await findFailedCiChecks(scanOptions(
      ghStubFor(548, [{ id: 99156131115, name: "semgrep" }]),
      tmpDir,
      { maxRetries: 3 },
    ));

    assertEquals(result.ok, true);
    // Capped, so the scan must skip it rather than hand it back for a
    // fourth attempt. Against the unfixed code the scanner read
    // `.ci_check_state` under the cwd, saw zero, and returned the check.
    if (result.ok) assertEquals(result.value, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a green build clears the auto-fix budget the processor recorded", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = resolveCiCheckStateDir(tmpDir);
    const signature = computeFailureSignature({
      repo: "org/repo",
      locus: { kind: "pr", number: 548 },
      checkName: "semgrep",
      logExcerpt: "detect-non-literal-regexp",
    });
    await recordAutoFixAttempt(stateDir, signature, {
      repo: "org/repo",
      locus: { kind: "pr", number: 548 },
      checkName: "semgrep",
      diagnosis: "regexp built from a variable",
      change: "hoisted the pattern to a literal",
      outcome: "check still failing",
    });
    assertEquals((await getAutoFixAttempts(stateDir, signature)).length, 1);

    // PR 548 now reports no failing checks — the build is green.
    const result = await findFailedCiChecks(
      scanOptions(ghStubFor(548, []), tmpDir),
    );
    assertEquals(result.ok, true);

    // The budget must be back to zero. Against the unfixed code the sweep
    // ran over `.ci_check_state` in the cwd, cleared nothing, and the
    // signature stayed spent — so the next real failure was escalated to a
    // human instead of fixed.
    assertEquals((await getAutoFixAttempts(stateDir, signature)).length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - still returns a failure whose retry budget is unspent", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = resolveCiCheckStateDir(tmpDir);
    await recordCiCheckRetry(stateDir, "org/repo", "99156131115");

    const result = await findFailedCiChecks(scanOptions(
      ghStubFor(548, [{ id: 99156131115, name: "semgrep" }]),
      tmpDir,
      { maxRetries: 3 },
    ));

    assertEquals(result.ok, true);
    if (result.ok && result.value) {
      assertEquals(result.value.checkName, "semgrep");
      assertEquals(result.value.prNumber, 548);
    } else {
      throw new Error("expected the semgrep failure to be returned");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - the scan's store follows the injected work directory, not WORK_DIR (Issue #966)", async () => {
  // Two temp roots, and the counter at the cap sits in only one of them.
  // The scan is pointed at that one through `workDir`; a code path that
  // resolved its store from `Deno.env.get("WORK_DIR")` would read the
  // other (or the ambient one), see zero retries, and hand the check back.
  const pointedAt = await Deno.makeTempDir({ prefix: "ci_state_used_" });
  const decoy = await Deno.makeTempDir({ prefix: "ci_state_decoy_" });
  try {
    const stateDir = resolveCiCheckStateDir(pointedAt);
    for (let i = 0; i < 3; i++) {
      await recordCiCheckRetry(stateDir, "org/repo", "99156131115");
    }

    const capped = await findFailedCiChecks(scanOptions(
      ghStubFor(548, [{ id: 99156131115, name: "semgrep" }]),
      pointedAt,
      { maxRetries: 3 },
    ));
    assertEquals(capped.ok, true);
    if (capped.ok) assertEquals(capped.value, null);

    // The same scan against the decoy root has no counter to read, so the
    // failure comes straight back — which is what makes the assertion
    // above about the injected directory rather than about the cap.
    const uncapped = await findFailedCiChecks(scanOptions(
      ghStubFor(548, [{ id: 99156131115, name: "semgrep" }]),
      decoy,
      { maxRetries: 3 },
    ));
    assertEquals(uncapped.ok, true);
    if (uncapped.ok && uncapped.value) {
      assertEquals(uncapped.value.checkName, "semgrep");
    } else {
      throw new Error("the decoy root should carry no retry budget");
    }
    // Neither scan touched the root it was not pointed at.
    assertEquals([...Deno.readDirSync(decoy)], []);
    assertEquals(
      [...Deno.readDirSync(pointedAt)].map((e) => e.name),
      [CI_CHECK_STATE_DIR_NAME],
    );
  } finally {
    await Deno.remove(pointedAt, { recursive: true });
    await Deno.remove(decoy, { recursive: true });
  }
});

// ============================================================================
// recordCiCheckRetry — the counter lands in the resolved directory
// ============================================================================

Deno.test("recordCiCheckRetry - writes the counter into the state directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/${CI_CHECK_STATE_DIR_NAME}`;
    assertEquals(await recordCiCheckRetry(stateDir, "org/repo", "12345"), 1);
    assertEquals(await recordCiCheckRetry(stateDir, "org/repo", "12345"), 2);
    assertEquals(
      (await Deno.readTextFile(`${stateDir}/org_repo_12345.retries`)).trim(),
      "2",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
