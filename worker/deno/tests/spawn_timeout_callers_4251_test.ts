/**
 * A zero timeout on every remaining raw spawn is a failure (Issue #4251).
 *
 * The timeout is rejected before the process starts, so the test does not
 * wait on a real command and does not treat the timeout as a successful
 * probe.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { realHostname, realPsSupervisors } from "../commands/diagnose.ts";
import { runDirectCommand as runAddRepoCommand } from "../commands/process_add_repo.ts";
import { runDirectCommand as runResolveCommand } from "../commands/resolve_cross_repo_dep.ts";
import {
  isCommandAvailable,
  readAgentProcessTable,
} from "../lib/claude_runner.ts";
import { readTailProcessTable } from "../lib/claude_tail_cleanup.ts";
import { probeCodexSubscriptionQuota } from "../lib/codex_quota.ts";
import { probePidAlive } from "../lib/container_watchdog.ts";
import { holderGone } from "../lib/file_lock.ts";
import {
  readKillKernelLog,
  readKillProcessTable,
} from "../lib/kill_diagnostics.ts";
import {
  canRunBinary,
  runMarkdownlintBinary,
} from "../lib/markdownlint_check.ts";
import { readDarwinPressureLevel } from "../lib/memory_pressure.ts";
import { readParentPid, signalOrphanProcess } from "../lib/orphan_collector.ts";
import {
  defaultRunPgidCommand,
  getCommand,
  getDescendants,
  getElapsedSeconds,
  getStartTime,
  isRunning,
  listChildPids,
  listChildPidsFromPs,
  readElapsedClock,
  sendSignal,
} from "../lib/pid_guard.ts";
import { runDirectCommand as runPurgeCommand } from "../lib/purge_stale_workflow_issues.ts";
import { runCredentialCommand } from "../lib/repo_credentials.ts";
import { probe } from "../lib/semgrep_check.ts";
import {
  commandOutputSyncWithTimeout,
  spawnCommandWithTimeout,
} from "../lib/subprocess_timeout.ts";
import { readHostnameCommand } from "../lib/worker_identity.ts";
import { listLivePids } from "../lib/worker_log_gzip.ts";

async function timedOut(run: () => Promise<unknown>): Promise<void> {
  await assertRejects(run, Error, "timed out");
}

Deno.test("diagnose process table timeout is not an empty report (Issue #4251)", () =>
  timedOut(() => realPsSupervisors(0)));

Deno.test("diagnose hostname timeout is not unknown-host (Issue #4251)", () =>
  timedOut(() => realHostname(0)));

Deno.test("add-repo direct command timeout is not a zero exit (Issue #4251)", () =>
  timedOut(() => runAddRepoCommand(["sleep", "30"], 0)));

Deno.test("cross-repo direct command timeout is not a zero exit (Issue #4251)", () =>
  timedOut(() => runResolveCommand(["sleep", "30"], 0)));

Deno.test("workflow-purge direct command timeout is not a zero exit (Issue #4251)", () =>
  timedOut(() => runPurgeCommand(["sleep", "30"], 0)));

Deno.test("agent spawn timeout does not start the child (Issue #4251)", () => {
  assertThrows(
    () => spawnCommandWithTimeout("sleep", { args: ["30"], timeoutMs: 0 }),
    Error,
    "timed out",
  );
});

Deno.test("agent process-table timeout is not an empty table (Issue #4251)", () =>
  timedOut(() => readAgentProcessTable(0)));

Deno.test("which timeout is not 'tool missing' (Issue #4251)", () =>
  timedOut(() => isCommandAvailable("git", 0)));

Deno.test("claude-tail process table timeout is not an empty sweep (Issue #4251)", () =>
  timedOut(() => readTailProcessTable(0)));

Deno.test("codex quota timeout is not a known budget (Issue #4251)", async () => {
  const budget = await probeCodexSubscriptionQuota({
    codexHome: "/tmp",
    timeoutMs: 0,
    parentEnv: {},
  });
  assertEquals(budget.known, false);
});

Deno.test("container liveness timeout is not 'already dead' (Issue #4251)", () => {
  assertThrows(() => probePidAlive(1, 0), Error, "timed out");
});

Deno.test("lock-holder probe timeout is not 'holder gone' (Issue #4251)", () =>
  timedOut(() => holderGone(1, 0)));

Deno.test("kill process-table timeout is not an empty snapshot (Issue #4251)", () =>
  timedOut(() => readKillProcessTable(0)));

Deno.test("kill kernel-log timeout is not an empty snapshot (Issue #4251)", () =>
  timedOut(() => readKillKernelLog(0)));

Deno.test("markdownlint run timeout is not a pass (Issue #4251)", () =>
  timedOut(() => runMarkdownlintBinary("markdownlint-cli2", "/tmp", 0)));

Deno.test("markdownlint probe timeout is not 'binary absent' (Issue #4251)", () =>
  timedOut(() => canRunBinary("markdownlint-cli2", 0)));

Deno.test("memory-pressure timeout is not 'unknown' (Issue #4251)", () =>
  timedOut(() => readDarwinPressureLevel(0)));

Deno.test("orphan parent-pid timeout is not 'no parent' (Issue #4251)", () =>
  timedOut(() => readParentPid(1, 0)));

Deno.test("orphan signal timeout is not a sent signal (Issue #4251)", () =>
  timedOut(() => signalOrphanProcess(1, "TERM", 0)));

Deno.test("pid isRunning timeout is not 'not running' (Issue #4251)", () =>
  timedOut(() => isRunning(1, 0)));

Deno.test("pid command timeout is not an empty command (Issue #4251)", () =>
  timedOut(() => getCommand(1, 0)));

Deno.test("pid etimes timeout is not 'age unknown' (Issue #4251)", () =>
  timedOut(() => getElapsedSeconds(1, 0)));

Deno.test("pid etime timeout is not 'age unknown' (Issue #4251)", () =>
  timedOut(() => readElapsedClock(1, 0)));

Deno.test("pid start-time timeout is not an empty identity (Issue #4251)", () =>
  timedOut(() => getStartTime(1, 0)));

Deno.test("pgrep timeout is not 'no children' (Issue #4251)", () =>
  timedOut(() => listChildPids(1, 0)));

Deno.test("ps parent fallback timeout is not 'no children' (Issue #4251)", () =>
  timedOut(() => listChildPidsFromPs(1, 0)));

Deno.test("pid signal timeout is not a sent signal (Issue #4251)", () =>
  timedOut(() => sendSignal(1, "TERM", 0)));

Deno.test("pgid timeout is not 'no process group' (Issue #4251)", () =>
  timedOut(() => defaultRunPgidCommand(1, 0)));

Deno.test("descendant walk timeout is not an empty tree (Issue #4251)", () =>
  timedOut(() => getDescendants(1, 0, 0)));

Deno.test("credential mint timeout is not exit 0 (Issue #4251)", () =>
  timedOut(() => runCredentialCommand("true", 0)));

Deno.test("semgrep probe timeout is not 'semgrep absent' (Issue #4251)", () =>
  timedOut(() => probe("semgrep", ["--version"], 0)));

Deno.test("hostname command timeout is not unknown-host (Issue #4251)", () => {
  assertThrows(() => readHostnameCommand(0), Error, "timed out");
});

Deno.test("sync command timeout does not spawn (Issue #4251)", () => {
  assertThrows(
    () => commandOutputSyncWithTimeout("hostname", { timeoutMs: 0 }),
    Error,
    "timed out",
  );
});

Deno.test("live-pid snapshot timeout is not 'nothing is running' (Issue #4251)", () =>
  timedOut(() => listLivePids(0)));
