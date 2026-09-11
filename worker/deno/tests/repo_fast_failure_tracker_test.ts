/**
 * Tests for the durable per-repository fast-failure tracker (Issue #1950).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  backedOffRepos,
  clearRepoFastFailures,
  DEFAULT_FAST_FAILURE_SECONDS,
  formatRepoFastFailureSummary,
  isFastFailure,
  lastErrorLine,
  loadRepoFastFailureStates,
  readRepoFastFailureFile,
  recordRepoFastFailure,
  recordRepoFastFailureDiagnostic,
  refreshRepoFastFailureBackOffs,
  repoFastFailurePath,
  resolveRepoFastFailurePolicy,
} from "../lib/repo_fast_failure_tracker.ts";

const HOST = "test-host";
const REPO = "stSoftwareAU/example";

/**
 * PEM header pieces for the synthetic private-key fixture below.
 *
 * Assembled at run time rather than written as one literal so no commit in
 * this repository ever carries a contiguous private-key-shaped string for the
 * secret scanners to flag. The fixture is not a real key.
 */
const PEM_DASHES = "-".repeat(5);
const PEM_LABEL = ["PRIVATE", "KEY"].join(" ");

/** A fixed clock so nothing in these tests depends on wall time. */
function clockAt(seconds: number): () => number {
  return () => seconds;
}

async function withWorkDir(
  fn: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "fast-failure-" });
  try {
    await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** Record one fast failure at `at`, returning the repository's new state. */
async function record(
  workDir: string,
  at: number,
  overrides: { repo?: string; phase?: string; message?: string } = {},
) {
  const result = await recordRepoFastFailure({
    workDir,
    hostname: HOST,
    nowSeconds: clockAt(at),
    repo: overrides.repo ?? REPO,
    failure: {
      phase: overrides.phase ?? "setup",
      message: overrides.message ?? "bootstrap failed\nquality.sh: not found",
      issueNumber: 7,
      elapsedSeconds: 12,
    },
  });
  assert(result.ok, `record failed: ${result.ok ? "" : result.error.message}`);
  return result.value;
}

Deno.test("isFastFailure - a sub-threshold failure counts", () => {
  const policy = resolveRepoFastFailurePolicy();
  assertEquals(
    isFastFailure({ category: "internal_error", elapsedSeconds: 30 }, policy),
    true,
  );
});

Deno.test("isFastFailure - a long agent failure does not count", () => {
  const policy = resolveRepoFastFailurePolicy();
  assertEquals(
    isFastFailure({ category: "internal_error", elapsedSeconds: 3300 }, policy),
    false,
  );
});

Deno.test("isFastFailure - zero_output counts however long it took", () => {
  const policy = resolveRepoFastFailurePolicy();
  assertEquals(
    isFastFailure({ category: "zero_output", elapsedSeconds: 2000 }, policy),
    true,
  );
});

Deno.test("isFastFailure - host-wide causes never back off a repository", () => {
  const policy = resolveRepoFastFailurePolicy();
  assertEquals(
    isFastFailure({ category: "rate_limit", elapsedSeconds: 3 }, policy),
    false,
  );
  assertEquals(
    isFastFailure({ category: "scheduled_release", elapsedSeconds: 3 }, policy),
    false,
  );
});

Deno.test("isFastFailure - an unknown elapsed time is not a fast failure", () => {
  const policy = resolveRepoFastFailurePolicy();
  assertEquals(isFastFailure({ category: "internal_error" }, policy), false);
});

Deno.test("isFastFailure - honours a configured fast_failure_seconds", () => {
  const policy = resolveRepoFastFailurePolicy({ fastFailureSeconds: 300 });
  assertEquals(
    isFastFailure({ category: "internal_error", elapsedSeconds: 120 }, policy),
    true,
  );
});

Deno.test("resolveRepoFastFailurePolicy - guards invalid operator values", () => {
  const policy = resolveRepoFastFailurePolicy({
    fastFailureSeconds: -1,
    threshold: 0,
    windowHours: Number.NaN,
  });
  assertEquals(policy.fastFailureSeconds, DEFAULT_FAST_FAILURE_SECONDS);
  assertEquals(policy.threshold, 3);
  assertEquals(policy.windowSeconds, 24 * 3600);
});

Deno.test("lastErrorLine - keeps the last non-empty line", () => {
  assertEquals(
    lastErrorLine("starting\n\ndeno: command not found\n\n"),
    "deno: command not found",
  );
});

Deno.test("lastErrorLine - a multi-line secret is redacted even though one line is kept", () => {
  const message = [
    "cloning the repo",
    `${PEM_DASHES}BEGIN RSA ${PEM_LABEL}${PEM_DASHES}`,
    "MIIEowIBAAKCAQEAx7Vn9kCk3nR2yQ1sWq8pLd4fThisIsNotARealKeyAtAll==",
    `${PEM_DASHES}END RSA ${PEM_LABEL}${PEM_DASHES}`,
  ].join("\n");
  const line = lastErrorLine(message);
  // The BEGIN marker is on a line the selection drops, so the rule only
  // fires when the whole message is redacted first (Issue #1257).
  assert(!line.includes("PRIVATE KEY"), `leaked: ${line}`);
});

Deno.test("lastErrorLine - bounds a very long line", () => {
  const line = "x".repeat(5000);
  assert(lastErrorLine(line).length <= 400);
});

Deno.test("recordRepoFastFailure - three failures in the window back the repo off", async () => {
  await withWorkDir(async (workDir) => {
    const first = await record(workDir, 1_000);
    assertEquals(first.count, 1);
    assertEquals(first.backedOff, false);

    const second = await record(workDir, 2_000);
    assertEquals(second.count, 2);
    assertEquals(second.backedOff, false);

    const third = await record(workDir, 3_000);
    assertEquals(third.count, 3);
    assertEquals(third.backedOff, true);
    // The back-off lapses when the threshold-th newest event decays.
    assertEquals(third.backedOffUntil, 1_000 + 24 * 3600);
    assertEquals(third.lastPhase, "setup");
    assertEquals(third.lastDetail, "quality.sh: not found");
  });
});

Deno.test("recordRepoFastFailure - one fast failure then successes leaves the repo alone", async () => {
  await withWorkDir(async (workDir) => {
    const state = await record(workDir, 1_000);
    assertEquals(state.backedOff, false);

    const cleared = await clearRepoFastFailures({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(1_100),
      repo: REPO,
    });
    assert(cleared.ok);
    assertEquals(cleared.value, true);

    const blocked = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(1_200),
    });
    assertEquals(blocked.size, 0);

    const states = await loadRepoFastFailureStates({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(1_200),
    });
    assertEquals(states.length, 0);
  });
});

Deno.test("recordRepoFastFailure - counters survive a restart (a fresh read of the sidecar)", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);

    // A restart is simply another process reading the same sidecar path.
    const file = await readRepoFastFailureFile(workDir, HOST);
    assert(typeof file !== "string", `sidecar unusable: ${file}`);
    assertEquals(file.repos[REPO]?.failures.length, 2);

    const third = await record(workDir, 3_000);
    assertEquals(third.count, 3);
    assertEquals(third.backedOff, true);
  });
});

Deno.test("recordRepoFastFailure - a decayed record drops its diagnostic pointer so the next break files again", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    await recordRepoFastFailureDiagnostic({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_000),
      repo: REPO,
      diagnosticRepo: "stSoftwareAU/VibeCoder",
      diagnosticIssue: 4242,
    });

    // A full window later the events have decayed. The record — pointer and
    // all — must go with them, or the next back-off silently files nothing.
    const later = 3_000 + 24 * 3600 + 1;
    const fresh = await record(workDir, later);
    assertEquals(fresh.count, 1);
    assertEquals(fresh.diagnosticIssue, undefined);

    await record(workDir, later + 10);
    const tripped = await record(workDir, later + 20);
    assertEquals(tripped.backedOff, true);
    assertEquals(tripped.diagnosticIssue, undefined);
  });
});

Deno.test("backedOffRepos - the back-off decays once the window lapses", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    const third = await record(workDir, 3_000);
    assertEquals(third.backedOff, true);

    const duringWindow = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_500),
    });
    assertEquals([...duringWindow], [REPO]);

    // One second past the oldest event's expiry only two remain — under the
    // threshold, so the repository is claimable again.
    const afterDecay = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(1_000 + 24 * 3600 + 1),
    });
    assertEquals(afterDecay.size, 0);
  });
});

Deno.test("backedOffRepos - only the failing repository is backed off", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    await record(workDir, 3_100, { repo: "stSoftwareAU/healthy" });

    const blocked = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_200),
    });
    assertEquals([...blocked], [REPO]);
  });
});

Deno.test("formatRepoFastFailureSummary - names the count and the back-off", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    const states = await loadRepoFastFailureStates({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_100),
    });
    const line = formatRepoFastFailureSummary(states);
    assert(line !== null);
    assertStringIncludes(line, `${REPO}: 3 fast failures`);
    assertStringIncludes(line, "backed off until");
  });
});

Deno.test("formatRepoFastFailureSummary - a healthy fleet adds no line", () => {
  assertEquals(formatRepoFastFailureSummary([]), null);
});

Deno.test("refreshRepoFastFailureBackOffs - a closed diagnostic releases the repository", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    const attached = await recordRepoFastFailureDiagnostic({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_000),
      repo: REPO,
      diagnosticRepo: "stSoftwareAU/VibeCoder",
      diagnosticIssue: 4242,
    });
    assert(attached.ok);

    const probed: string[] = [];
    const cleared = await refreshRepoFastFailureBackOffs({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_000),
      isIssueClosed: (repo, issueNumber) => {
        probed.push(`${repo}#${issueNumber}`);
        return Promise.resolve(true);
      },
    });
    assertEquals(cleared, [REPO]);
    assertEquals(probed, ["stSoftwareAU/VibeCoder#4242"]);

    const blocked = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_100),
    });
    assertEquals(blocked.size, 0);
  });
});

Deno.test("refreshRepoFastFailureBackOffs - an open diagnostic leaves the back-off standing", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    await recordRepoFastFailureDiagnostic({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_000),
      repo: REPO,
      diagnosticRepo: "stSoftwareAU/VibeCoder",
      diagnosticIssue: 4242,
    });

    let probes = 0;
    const cleared = await refreshRepoFastFailureBackOffs({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_000),
      isIssueClosed: () => {
        probes += 1;
        return Promise.resolve(false);
      },
    });
    assertEquals(cleared, []);
    assertEquals(probes, 1);

    // Probed again inside the recheck interval: no second GitHub call.
    await refreshRepoFastFailureBackOffs({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_100),
      isIssueClosed: () => {
        probes += 1;
        return Promise.resolve(false);
      },
    });
    assertEquals(probes, 1);

    const blocked = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_200),
    });
    assertEquals([...blocked], [REPO]);
  });
});

Deno.test("refreshRepoFastFailureBackOffs - an unreadable diagnostic is not treated as closed", async () => {
  await withWorkDir(async (workDir) => {
    await record(workDir, 1_000);
    await record(workDir, 2_000);
    await record(workDir, 3_000);
    await recordRepoFastFailureDiagnostic({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(3_000),
      repo: REPO,
      diagnosticRepo: "stSoftwareAU/VibeCoder",
      diagnosticIssue: 4242,
    });

    const logs: string[] = [];
    const cleared = await refreshRepoFastFailureBackOffs({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_000),
      isIssueClosed: () => Promise.reject(new Error("gh exploded")),
      log: (message) => logs.push(message),
    });
    assertEquals(cleared, []);
    assert(logs.some((line) => line.includes("back-off for")));

    const blocked = await backedOffRepos({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(10_100),
    });
    assertEquals([...blocked], [REPO]);
  });
});

Deno.test("readRepoFastFailureFile - an absent sidecar is distinguished from a corrupt one", async () => {
  await withWorkDir(async (workDir) => {
    assertEquals(await readRepoFastFailureFile(workDir, HOST), "absent");

    await Deno.writeTextFile(repoFastFailurePath(workDir, HOST), "{ not json");
    assertEquals(await readRepoFastFailureFile(workDir, HOST), "unparseable");

    await Deno.writeTextFile(
      repoFastFailurePath(workDir, HOST),
      JSON.stringify({ schema: 99, host: HOST, updatedAt: "", repos: {} }),
    );
    assertEquals(await readRepoFastFailureFile(workDir, HOST), "future-schema");
  });
});

Deno.test("recordRepoFastFailure - a corrupt sidecar is reported, never silently reset", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(repoFastFailurePath(workDir, HOST), "{ not json");
    const warnings: string[] = [];
    const result = await recordRepoFastFailure({
      workDir,
      hostname: HOST,
      nowSeconds: clockAt(1_000),
      repo: REPO,
      failure: { phase: "setup", message: "boom" },
      warn: (message) => warnings.push(message),
    });
    assert(result.ok);
    assertEquals(result.value.count, 1);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "unparseable");
  });
});

Deno.test("repoFastFailurePath - a hostile hostname cannot escape the work directory", () => {
  assertEquals(
    repoFastFailurePath("/work", "../../etc/passwd"),
    "/work/repo_fast_failures_.._.._etc_passwd.json",
  );
});
