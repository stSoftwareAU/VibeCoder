/**
 * Tests for the container-reap command's contract (Issue #4173).
 *
 * The launchers call this command when their watchdog fires and before every
 * launch, so what it refuses matters as much as what it reaps: a request it
 * cannot carry out must be a loud, named failure rather than a quiet success
 * that leaves a wedged container running (Issue #3234).
 *
 * The reaping behaviour itself is covered by `container_watchdog_test.ts`
 * (injected seams) and end-to-end by the launcher tests. The evidence tests
 * (Issue #4253) run the real `reap()` against `/nonexistent-dir/docker`, a
 * runtime path that does not exist: every runtime invocation fails to start,
 * so no container is touched. The reaper's process-table scan does run a real,
 * read-only `ps -A`. It can match only a process whose executable is `docker`
 * and whose argv carries the probe's container name. That name is random for
 * each run, so no real process can match and nothing is signalled.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ANOTHER_WORKER_RUNNING_EXIT,
  reap,
} from "../commands/container_reap.ts";

Deno.test("container-reap - refuses a request with no runtime", async () => {
  const result = await reap({ name: "vibe-coder-1" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--runtime");
});

Deno.test("container-reap - refuses a request that names nothing to reap", async () => {
  const result = await reap({ runtime: "docker" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--stale");
});

Deno.test("container-reap - refuses a runtime the launchers do not support", async () => {
  const result = await reap({ runtime: "kubectl", name: "vibe-coder-1" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a container runtime");
  // The message names the runtimes that are supported, so an operator reading
  // a host log can act on it.
  assertStringIncludes(result.message, "docker");
});

Deno.test("container-reap - a stale scan without a deadline is refused", async () => {
  const result = await reap({ runtime: "docker", stale: true });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--max-age-seconds");
});

Deno.test("container-reap - the 'another worker is running' status is its own number, distinct from pass and fail (Issue #26)", () => {
  // The launchers branch on this exact value; 0 and 1 already mean "clean
  // host" and "the reaper could not run".
  assertEquals(ANOTHER_WORKER_RUNNING_EXIT, 4);
});

Deno.test("container-reap - --evidence-dir writes exactly one hard-kill file, even when every runtime step fails", async () => {
  const name = `vibe-coder-probe-${crypto.randomUUID().slice(0, 8)}`;
  const evidenceDir = await Deno.makeTempDir({ prefix: "hard-kill-evidence-" });
  const workDir = await Deno.makeTempDir({ prefix: "hard-kill-work-" });
  try {
    const result = await reap({
      runtime: "/nonexistent-dir/docker",
      name,
      "evidence-dir": evidenceDir,
      "work-dir": workDir,
      "grace-seconds": 0,
    });

    const names: string[] = [];
    for await (const entry of Deno.readDir(evidenceDir)) {
      names.push(entry.name);
    }
    const evidenceFiles = names.filter((entry) =>
      new RegExp(`^hard-kill-${name}-\\d+\\.json$`).test(entry)
    );
    assertEquals(evidenceFiles.length, 1);
    assertEquals(
      result.data?.reaped[0]?.evidenceFile,
      `${evidenceDir}/${evidenceFiles[0]}`,
    );

    const record = JSON.parse(
      await Deno.readTextFile(`${evidenceDir}/${evidenceFiles[0]}`),
    ) as { container: string; evidence: { bootLogs: string } };
    assertEquals(record.container, name);
    assertStringIncludes(record.evidence.bootLogs, "unavailable: exit -1:");
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("container-reap - without --evidence-dir no evidence file is written", async () => {
  const name = `vibe-coder-probe-${crypto.randomUUID().slice(0, 8)}`;
  const workDir = await Deno.makeTempDir({ prefix: "hard-kill-work-" });
  try {
    const result = await reap({
      runtime: "/nonexistent-dir/docker",
      name,
      "work-dir": workDir,
      "grace-seconds": 0,
    });

    assertEquals(result.data?.reaped[0]?.evidenceFile, null);
    const names: string[] = [];
    for await (const entry of Deno.readDir(workDir)) {
      names.push(entry.name);
    }
    assertEquals(
      names.filter((name) => name.startsWith("hard-kill-")),
      [],
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
