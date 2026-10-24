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
 * (Issue #4253) name a runtime path that does not exist, so every runtime step
 * fails to start and no container is touched; the reaper's read-only process
 * listing is the only subprocess they run. Nothing here signals a process.
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
  const evidenceDir = await Deno.makeTempDir({ prefix: "hard-kill-evidence-" });
  const workDir = await Deno.makeTempDir({ prefix: "hard-kill-work-" });
  try {
    const result = await reap({
      runtime: "/nonexistent-dir/docker",
      name: "vibe-coder-4253",
      "evidence-dir": evidenceDir,
      "work-dir": workDir,
      "grace-seconds": 0,
    });

    // The runtime cannot run, so the container survives and the reap fails.
    assertEquals(result.success, false);

    const names: string[] = [];
    for await (const entry of Deno.readDir(evidenceDir)) {
      names.push(entry.name);
    }
    const evidenceFiles = names.filter((name) =>
      /^hard-kill-vibe-coder-4253-\d+\.json$/.test(name)
    );
    assertEquals(evidenceFiles.length, 1);
    assertEquals(
      result.data?.reaped[0]?.evidenceFile,
      `${evidenceDir}/${evidenceFiles[0]}`,
    );

    const record = JSON.parse(
      await Deno.readTextFile(`${evidenceDir}/${evidenceFiles[0]}`),
    ) as { container: string; evidence: { bootLogs: string } };
    assertEquals(record.container, "vibe-coder-4253");
    assertStringIncludes(record.evidence.bootLogs, "unavailable: exit -1:");
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("container-reap - without --evidence-dir no evidence file is written", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hard-kill-work-" });
  try {
    const result = await reap({
      runtime: "/nonexistent-dir/docker",
      name: "vibe-coder-4254",
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
