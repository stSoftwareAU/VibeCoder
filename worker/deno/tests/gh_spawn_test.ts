/**
 * Tests for the shared `gh` spawn chokepoint (Issue #3703).
 *
 * The chokepoint's contract is that no `gh` process starts until the
 * write-repo allowlist has approved the arguments, and that the mutation is
 * journalled afterwards. Both are exercised here through the injectable
 * low-level runner, so no real `gh` binary is spawned.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type PrimaryQuotaRefusal,
  resetGhRestageAttempts,
  runGhOrThrow,
  setPrimaryQuotaExhaustionHook,
  spawnGh,
} from "../lib/gh_spawn.ts";
import {
  resetSharedProcessedIssues,
  sharedProcessedIssues,
} from "../lib/processed_issue_registry.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteRepoBlockedError,
  WriteTargetUndeterminableError,
} from "../lib/write_repo_allowlist.ts";
import { envFrom } from "./support/env_lookup.ts";
import { UnredactableBodyError } from "../lib/gh_body_redaction.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

/** True when the path exists; used to assert a masked copy was removed. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

import {
  getGhCallMetrics,
  resetGhCallMetrics,
} from "../lib/gh_call_metrics.ts";
import {
  clearPrimaryQuotaLatch,
  latchPrimaryQuota,
} from "../lib/primary_quota_latch.ts";
import { probeGraphqlQuota } from "../lib/graphql_quota_probe.ts";

/** Record the arguments each spawn attempt would have used. */
function recordingRunner(
  result: { code: number; stdout?: string; stderr?: string } = { code: 0 },
): { calls: string[][] } {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    return Promise.resolve({
      code: result.code,
      success: result.code === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  });
  return { calls };
}

/** Silence the allowlist's audit/log sinks for one test. */
function silenceAllowlist(): void {
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: () => {},
  });
}

function restore(): void {
  _resetGhSpawnRunner();
  resetWriteRepoAllowlist();
  _resetWriteRepoAllowlistSinks();
}

Deno.test("spawnGh - returns the runner's outcome without throwing on failure", async () => {
  const { calls } = recordingRunner({ code: 1, stderr: "boom" });
  try {
    const result = await spawnGh(["issue", "view", "1"]);
    assertEquals(result.code, 1);
    assertEquals(result.success, false);
    assertEquals(result.stderr, "boom");
    assertEquals(calls, [["issue", "view", "1"]]);
  } finally {
    restore();
  }
});

Deno.test("runGhOrThrow - returns stdout and throws with the exit code", async () => {
  const ok = recordingRunner({ code: 0, stdout: "hello" });
  try {
    assertEquals(await runGhOrThrow(["pr", "view", "1"]), "hello");
    assertEquals(ok.calls.length, 1);
  } finally {
    restore();
  }

  recordingRunner({ code: 22, stderr: "HTTP 422" });
  try {
    const error = await assertRejects(
      () => runGhOrThrow(["pr", "view", "1"]),
      Error,
    );
    assertEquals(error.message, "gh command failed (exit 22): HTTP 422");
  } finally {
    restore();
  }
});

Deno.test("spawnGh - refuses an off-allowlist write before spawning gh", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        spawnGh([
          "issue",
          "comment",
          "1",
          "-R",
          "victim/repo",
          "--body",
          "leak",
        ]),
      WriteRepoBlockedError,
    );
    // The refusal must happen before the subprocess would have started.
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("spawnGh - refuses an undeterminable write before spawning gh", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () => spawnGh(["gist", "create", "dump.txt"]),
      WriteTargetUndeterminableError,
    );
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("spawnGh - allows an on-allowlist write through to the runner", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await spawnGh(["issue", "close", "9", "-R", "me/target"]);
    assertEquals(calls, [["issue", "close", "9", "-R", "me/target"]]);
  } finally {
    restore();
  }
});

// Issue #3748: the production runner passed the caller's stdout/stderr
// options through to Deno.Command but then unconditionally destructured
// both streams from the command output. Deno's CommandOutput getters THROW
// (`TypeError: Cannot get 'stderr': 'stderr' is not piped`) when the stream
// was opened with "null", so every spawnGh call discarding a stream failed
// even when gh itself succeeded — silently breaking heartbeat markers,
// stale-claim recovery scans and claim release. These tests exercise the
// REAL production runner (no injected mock) with a harmless read-only
// command; `gh --version` classifies as a non-mutation so it bypasses the
// write allowlist and audit journal.

Deno.test("spawnGh - production runner tolerates a discarded stderr (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  const result = await spawnGh(["--version"], { stderr: "null" });
  assertEquals(result.success, true);
  assertEquals(result.stderr, "");
  // stdout stays captured — the discarded stream must not blank the piped one.
  assertEquals(result.stdout.includes("gh version"), true);
});

Deno.test("spawnGh - production runner tolerates discarding both streams (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  const result = await spawnGh(["--version"], {
    stdout: "null",
    stderr: "null",
  });
  assertEquals(result.success, true);
  assertEquals(result.stdout, "");
  assertEquals(result.stderr, "");
});

Deno.test("spawnGh - production runner tolerates discarded streams on the stdin path (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  // `gh --version` ignores stdin; supplying it routes through the spawn()
  // branch of the production runner, which had the same throwing getters.
  const result = await spawnGh(["--version"], {
    stdin: "",
    stderr: "null",
  });
  assertEquals(result.success, true);
  assertEquals(result.stderr, "");
  assertEquals(result.stdout.includes("gh version"), true);
});

Deno.test("spawnGh - forwards stdin and stream options to the runner", async () => {
  const seen: Array<Record<string, unknown>> = [];
  _setGhSpawnRunner((_args, options) => {
    seen.push({ ...options });
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: "",
      stderr: "",
    });
  });
  try {
    await spawnGh(["api", "repos/me/target/x", "--input", "-"], {
      stdin: '{"a":1}',
      stdout: "null",
    });
    assertEquals(seen[0]?.stdin, '{"a":1}');
    assertEquals(seen[0]?.stdout, "null");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Issue close bookkeeping at the chokepoint (Issue #181)
// ---------------------------------------------------------------------------

Deno.test("spawnGh - a successful issue close marks the issue finished for this run", async () => {
  recordingRunner({ code: 0 });
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  resetSharedProcessedIssues();
  try {
    await spawnGh(["issue", "close", "9", "-R", "me/target"]);

    assertEquals(
      sharedProcessedIssues().wasClosedByWorker("me/target", 9),
      true,
    );
  } finally {
    resetSharedProcessedIssues();
    restore();
  }
});

Deno.test("spawnGh - a failed issue close marks nothing", async () => {
  recordingRunner({ code: 1, stderr: "boom" });
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  resetSharedProcessedIssues();
  try {
    await spawnGh(["issue", "close", "9", "-R", "me/target"]);

    assertEquals(sharedProcessedIssues().has("me/target", 9), false);
  } finally {
    resetSharedProcessedIssues();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Credential recovery at the chokepoint (Issue #564). A call that failed for
// want of authentication did nothing, so retrying it is safe — and the copy
// of `hosts.yml` that went missing mid-run is rebuildable from the mount that
// still has it.
// ---------------------------------------------------------------------------

Deno.test("spawnGh - an auth failure re-stages the credential and retries once", async () => {
  const home = await Deno.makeTempDir();
  try {
    // The mount holds the credential; the staged copy is gone, exactly as it
    // was found on the fleet.
    await Deno.mkdir(`${home}/.vibe-coder/credentials/gh`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n",
    );
    // The run environment as a map the chokepoint reads and writes, rather
    // than the process every parallel worker shares (Issue #967). The roots
    // are throwaway temporary directories that appear in no real environment,
    // so a fall back to `Deno.env.get` fails here rather than passing on the
    // ambient value.
    const hostVars: Record<string, string> = {
      HOME: home,
      VIBE_STATE_DIR: `${home}/state`,
      GH_CONFIG_DIR: `${home}/gone`,
    };
    const hostEnv = envFrom(hostVars);
    const setHostEnv = (name: string, value: string) => {
      hostVars[name] = value;
    };
    resetGhRestageAttempts();

    const calls: string[][] = [];
    _setGhSpawnRunner((args) => {
      calls.push([...args]);
      return Promise.resolve(
        calls.length === 1
          ? {
            code: 4,
            success: false,
            stdout: "",
            stderr: "To get started with GitHub CLI, please run: gh auth login",
          }
          : { code: 0, success: true, stdout: "vibe-bot", stderr: "" },
      );
    });

    const result = await spawnGh(["api", "user", "--jq", ".login"], {
      hostEnv,
      setHostEnv,
    });

    assertEquals(result.success, true);
    assertEquals(result.stdout, "vibe-bot");
    assertEquals(calls.length, 2, "the call must be retried exactly once");
    // The retry ran against a rebuilt configuration, not the missing one.
    assertEquals(hostVars.GH_CONFIG_DIR, `${home}/state/gh-config`);
    assertEquals(
      await Deno.readTextFile(`${home}/state/gh-config/hosts.yml`),
      "github.com:\n",
    );
    // Nothing was written to the process: the re-stage went to the injected
    // map, so this suite races no other worker.
    assertEquals(
      Deno.env.get("GH_CONFIG_DIR") === `${home}/state/gh-config`,
      false,
    );
  } finally {
    _resetGhSpawnRunner();
    resetGhRestageAttempts();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("spawnGh - the injected roots are the only ones the re-stage reads", async () => {
  // The state root exists only in the injected map. A code path that read
  // the process environment instead would find no VIBE_STATE_DIR, stage into
  // the scratch or TMPDIR candidate, and fail this assertion (Issue #967).
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.vibe-coder/credentials/gh`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n",
    );
    const hostVars: Record<string, string> = {
      HOME: home,
      VIBE_STATE_DIR: `${home}/durable`,
    };
    resetGhRestageAttempts();
    let attempt = 0;
    _setGhSpawnRunner(() => {
      attempt++;
      return Promise.resolve(
        attempt === 1
          ? {
            code: 4,
            success: false,
            stdout: "",
            stderr: "no accounts configured",
          }
          : { code: 0, success: true, stdout: "ok", stderr: "" },
      );
    });

    await spawnGh(["api", "user"], {
      hostEnv: envFrom(hostVars),
      setHostEnv: (name, value) => {
        hostVars[name] = value;
      },
    });

    assertEquals(hostVars.GH_CONFIG_DIR, `${home}/durable/gh-config`);
  } finally {
    _resetGhSpawnRunner();
    resetGhRestageAttempts();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("spawnGh - masks a secret read from a --body-file body (Issue #1254)", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  const path = await Deno.makeTempFile({ prefix: "vibe-body-", suffix: ".md" });
  try {
    await Deno.writeTextFile(path, `token ${GH_TOKEN_SAMPLE}\n`);

    await spawnGh([
      "issue",
      "comment",
      "1",
      "-R",
      "me/target",
      "--body-file",
      path,
    ]);

    assertEquals(calls, [[
      "issue",
      "comment",
      "1",
      "-R",
      "me/target",
      "--body",
      `token ${REDACTION_PLACEHOLDER}\n`,
    ]]);
    // The agent's own file is never rewritten.
    assertEquals(await Deno.readTextFile(path), `token ${GH_TOKEN_SAMPLE}\n`);
  } finally {
    await Deno.remove(path).catch(() => {});
    restore();
  }
});

Deno.test("spawnGh - refuses a body file it cannot read rather than publishing it unscanned (Issue #1254)", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        spawnGh([
          "issue",
          "comment",
          "1",
          "-R",
          "me/target",
          "--body-file",
          "/nonexistent/vibe-1254-body.md",
        ]),
      UnredactableBodyError,
    );
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("spawnGh - masks an --input file body into a fresh file (Issue #1254)", async () => {
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  const original = `{"body":"token ${GH_TOKEN_SAMPLE}"}`;
  const path = await Deno.makeTempFile({
    prefix: "vibe-input-",
    suffix: ".json",
  });
  // The masked copy is read by the `gh` child *during* the call and removed
  // once it exits (Issue #1364), so its contents are captured here rather
  // than after the call — reading it afterwards would assert a leak.
  let maskedPath: string | undefined;
  let maskedBody: string | undefined;
  _setGhSpawnRunner((args) => {
    maskedPath = [...args][5];
    maskedBody = Deno.readTextFileSync(maskedPath as string);
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: "",
      stderr: "",
    });
  });
  try {
    await Deno.writeTextFile(path, original);

    await spawnGh([
      "api",
      "-X",
      "PATCH",
      "repos/me/target/issues/1",
      "--input",
      path,
    ]);

    assertEquals(typeof maskedPath, "string");
    assertEquals(maskedPath === path, false);
    assertEquals(maskedBody, `{"body":"token ${REDACTION_PLACEHOLDER}"}`);
    // The caller's own file is left exactly as it was.
    assertEquals(await Deno.readTextFile(path), original);
    // And the masked copy is not left behind (Issue #1364): the chokepoint
    // owns the directory it wrote into and removes it once the child exits.
    assertEquals(await exists(maskedPath as string), false);
  } finally {
    await Deno.remove(path).catch(() => {});
    restore();
  }
});

Deno.test("spawnGh - leaves the secret-scanning hardening body untouched (Issue #1254)", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  // The body `repo_settings_harden` PATCHes to enable secret scanning: no
  // secret, but keys a signature rule reads as one. Scanning it must neither
  // refuse the call nor rewrite the request.
  const body = JSON.stringify({
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  });
  const path = await Deno.makeTempFile({
    prefix: "vibe-settings-",
    suffix: ".json",
  });
  try {
    await Deno.writeTextFile(path, body);

    await spawnGh([
      "api",
      "--method",
      "PATCH",
      "repos/me/target",
      "--input",
      path,
    ]);

    assertEquals(calls, [[
      "api",
      "--method",
      "PATCH",
      "repos/me/target",
      "--input",
      path,
    ]]);
    assertEquals(await Deno.readTextFile(path), body);
  } finally {
    await Deno.remove(path).catch(() => {});
    restore();
  }
});

Deno.test("spawnGh - redacts the stdin body of an --input - call (Issue #1254)", async () => {
  const seen: Array<Record<string, unknown>> = [];
  _setGhSpawnRunner((_args, options) => {
    seen.push({ ...options });
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: "",
      stderr: "",
    });
  });
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    // `--input -` is the live spelling used by the SARIF upload and the
    // ruleset writes: the body never appears in argv, so only a stdin scan
    // can reach it — and the call must still be allowed to proceed.
    await spawnGh([
      "api",
      "-X",
      "POST",
      "repos/me/target/code-scanning/sarifs",
      "--input",
      "-",
    ], { stdin: `{"body":"token ${GH_TOKEN_SAMPLE}"}` });

    assertEquals(
      seen[0]?.stdin,
      `{"body":"token ${REDACTION_PLACEHOLDER}"}`,
    );
  } finally {
    restore();
  }
});

Deno.test("spawnGh - a non-auth failure is returned as-is, never retried", async () => {
  try {
    resetGhRestageAttempts();
    const calls: string[][] = [];
    _setGhSpawnRunner((args) => {
      calls.push([...args]);
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: "",
        stderr: "Could not resolve to an Issue with the number of 999",
      });
    });

    const result = await spawnGh(["issue", "view", "999"]);

    assertEquals(result.success, false);
    assertEquals(calls.length, 1);
  } finally {
    _resetGhSpawnRunner();
    resetGhRestageAttempts();
  }
});

// ---------------------------------------------------------------------------
// Issue #1485: telemetry and the primary-quota latch live at the chokepoint,
// so a module that spawns `gh` directly is counted and short-circuited
// exactly like one that goes through `runGhCommandRaw`.
// ---------------------------------------------------------------------------

Deno.test("spawnGh - records every spawn in the gh call metrics (Issue #1485)", async () => {
  resetGhCallMetrics();
  clearPrimaryQuotaLatch();
  const { calls } = recordingRunner({ code: 0, stdout: "[]" });
  try {
    await spawnGh(["issue", "list", "--repo", "o/r"]);
    await spawnGh(["pr", "view", "7", "--json", "state"]);
    await spawnGh(["api", "rate_limit"]);
    await runGhOrThrow(["api", "graphql", "-f", "query=Q"]);
    assertEquals(calls.length, 4);
    const snap = getGhCallMetrics();
    assertEquals(snap.total, 4, "one record per spawned gh process");
    assertEquals(snap.graphqlTotal, 3, "only the REST api call is not GraphQL");
    assertEquals(snap.bySubCommand["issue list"], 1);
    assertEquals(snap.bySubCommand["pr view"], 1);
    assertEquals(snap.bySubCommand["api"], 1);
    assertEquals(snap.bySubCommand["api graphql"], 1);
  } finally {
    restore();
    resetGhCallMetrics();
  }
});

Deno.test("spawnGh - a latched GraphQL-backed call fails without spawning or counting (Issue #1485)", async () => {
  resetGhCallMetrics();
  clearPrimaryQuotaLatch();
  const { calls } = recordingRunner({ code: 0, stdout: "[]" });
  try {
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    const result = await spawnGh(["issue", "list", "--repo", "o/r"]);
    assertEquals(result.success, false);
    assertEquals(result.code, 1);
    // The skip message carries the primary-quota phrase so the scans' log
    // lines and the Issue #1780 pause still classify it correctly.
    assertEquals(
      /api rate limit already exceeded/i.test(result.stderr),
      true,
      `skip message should name the primary quota: ${result.stderr}`,
    );
    assertEquals(calls, [], "a latched call must not spawn gh");
    assertEquals(getGhCallMetrics().total, 0, "a skipped call is not a call");

    // runGhOrThrow surfaces the same skip as its usual failure shape.
    const error = await assertRejects(
      () => runGhOrThrow(["pr", "list", "--repo", "o/r"]),
      Error,
    );
    assertEquals(/api rate limit already exceeded/i.test(error.message), true);
    assertEquals(calls, []);
  } finally {
    restore();
    clearPrimaryQuotaLatch();
    resetGhCallMetrics();
  }
});

Deno.test("spawnGh - a REST `gh api <path>` still runs while latched (Issue #1485)", async () => {
  resetGhCallMetrics();
  clearPrimaryQuotaLatch();
  const { calls } = recordingRunner({ code: 0, stdout: "{}" });
  try {
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    const result = await spawnGh(["api", "rate_limit"]);
    assertEquals(result.success, true);
    await spawnGh(["api", "-X", "DELETE", "repos/o/r/issues/1/assignees"]);
    assertEquals(calls.length, 2, "REST rides the core quota, not GraphQL");
    assertEquals(getGhCallMetrics().total, 2);
    assertEquals(getGhCallMetrics().graphqlTotal, 0);
  } finally {
    restore();
    clearPrimaryQuotaLatch();
    resetGhCallMetrics();
  }
});

Deno.test("spawnGh - bypassQuotaLatch lets the quota probe run while latched (Issue #1485)", async () => {
  clearPrimaryQuotaLatch();
  const resetAt = new Date(Date.now() + 1800_000).toISOString();
  const { calls } = recordingRunner({
    code: 0,
    stdout: JSON.stringify({
      data: { rateLimit: { limit: 5000, remaining: 0, used: 5000, resetAt } },
    }),
  });
  try {
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    // The explicit escape hatch.
    const direct = await spawnGh(["api", "graphql", "-f", "query=Q"], {
      bypassQuotaLatch: true,
    });
    assertEquals(direct.success, true);
    assertEquals(calls.length, 1);
    // And the probe's default spawn uses it — the probe is what learns the
    // reset that lifts the latch, so it can never be latched out.
    const reading = await probeGraphqlQuota();
    assertEquals(reading.ok, true);
    assertEquals(calls.length, 2, "the probe must reach the runner");
  } finally {
    restore();
    clearPrimaryQuotaLatch();
    resetGhCallMetrics();
  }
});

// ---------------------------------------------------------------------------
// Issue #1540: the chokepoint recognises a primary-quota refusal itself and
// hands it to the registered hook — whichever module made the call.
// ---------------------------------------------------------------------------

const QUOTA_REFUSED = "GraphQL: API rate limit already exceeded for user ID 1.";

Deno.test("spawnGh - a GraphQL-backed refusal reaches the exhaustion hook once, with the call and the signal dir (Issue #1540)", async () => {
  clearPrimaryQuotaLatch();
  const seen: PrimaryQuotaRefusal[] = [];
  setPrimaryQuotaExhaustionHook((refusal) => {
    seen.push(refusal);
    return Promise.resolve();
  });
  recordingRunner({ code: 1, stderr: QUOTA_REFUSED });
  try {
    const result = await spawnGh(["pr", "list", "--repo", "o/r"], {
      workDir: "/work/dir",
    });
    assertEquals(result.success, false, "the caller still sees its failure");
    assertEquals(seen.length, 1);
    assertEquals(seen[0]?.args, ["pr", "list", "--repo", "o/r"]);
    assertEquals(seen[0]?.stderr, QUOTA_REFUSED);
    assertEquals(seen[0]?.workDir, "/work/dir");
    // runGhOrThrow rides the same chokepoint.
    await assertRejects(() => runGhOrThrow(["issue", "list"]), Error);
    assertEquals(seen.length, 2);
    assertEquals(seen[1]?.workDir, undefined);
  } finally {
    setPrimaryQuotaExhaustionHook(null);
    restore();
    clearPrimaryQuotaLatch();
  }
});

Deno.test("spawnGh - the hook is not called for REST, for success, for the probe, or for another failure (Issue #1540)", async () => {
  clearPrimaryQuotaLatch();
  let calls = 0;
  setPrimaryQuotaExhaustionHook(() => {
    calls++;
    return Promise.resolve();
  });
  try {
    // REST rides the core quota; the same wording there is not the latch's.
    recordingRunner({ code: 1, stderr: QUOTA_REFUSED });
    await spawnGh(["api", "repos/o/r/issues/1"]);
    // The probe learns the reset and must never feed the hook.
    await spawnGh(["api", "graphql", "-f", "query=Q"], {
      bypassQuotaLatch: true,
    });
    // An ordinary failure.
    recordingRunner({ code: 1, stderr: "HTTP 404: Not Found" });
    await spawnGh(["pr", "list", "--repo", "o/r"]);
    // A success.
    recordingRunner({ code: 0, stdout: "[]" });
    await spawnGh(["pr", "list", "--repo", "o/r"]);
    assertEquals(calls, 0);
  } finally {
    setPrimaryQuotaExhaustionHook(null);
    restore();
    clearPrimaryQuotaLatch();
  }
});

Deno.test("spawnGh - a throwing hook never masks the call's own result (Issue #1540)", async () => {
  clearPrimaryQuotaLatch();
  setPrimaryQuotaExhaustionHook(() => Promise.reject(new Error("probe died")));
  recordingRunner({ code: 1, stderr: QUOTA_REFUSED });
  try {
    const result = await spawnGh(["pr", "list", "--repo", "o/r"]);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, QUOTA_REFUSED);
  } finally {
    setPrimaryQuotaExhaustionHook(null);
    restore();
    clearPrimaryQuotaLatch();
  }
});

Deno.test("spawnGh - with no hook registered a refusal is just a failed call (Issue #1540)", async () => {
  clearPrimaryQuotaLatch();
  setPrimaryQuotaExhaustionHook(null);
  const { calls } = recordingRunner({ code: 1, stderr: QUOTA_REFUSED });
  try {
    await spawnGh(["pr", "list", "--repo", "o/r"]);
    await spawnGh(["pr", "list", "--repo", "o/r"]);
    assertEquals(calls.length, 2, "nothing latched, nothing short-circuited");
  } finally {
    restore();
    clearPrimaryQuotaLatch();
  }
});
