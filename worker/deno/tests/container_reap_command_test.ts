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
import type { ReapDeps } from "../lib/container_watchdog.ts";
import { GUEST_ANSWERING_EXIT } from "../lib/guest_silence_watch.ts";

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

/**
 * Stateful seams for the --if-silent mode (Issue #5161): nothing real runs.
 *
 * The fake runtime keeps a table of running containers: `kill` removes the
 * named one and the listing reports what is left, so a test reads the state a
 * reap leaves behind rather than which calls were made.
 */
function silenceDeps(guestAnswers: boolean, container: string): {
  deps: ReapDeps;
  running: Set<string>;
  writes: Map<string, string>;
} {
  const running = new Set([container]);
  const writes = new Map<string, string>();
  const deps: ReapDeps = {
    runtimeExecutable: "container",
    listArgs: ["ps", "--format", "json"],
    runRuntime: (args) => {
      if (args[0] === "kill") running.delete(args[1] ?? "");
      return Promise.resolve({
        code: 0,
        stdout: args[0] === "ps" ? [...running].join("\n") : "",
        stderr: "",
      });
    },
    listProcesses: () => Promise.resolve([]),
    killProcess: () => true,
    isProcessAlive: () => false,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    emit: () => Promise.resolve(true),
    log: () => {},
    evidence: {
      runRuntime: (args) => {
        const probe = args[0] === "exec" && args[2] === "true" &&
          running.has(args[1] ?? "");
        return Promise.resolve(
          probe && guestAnswers
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 1, stdout: "", stderr: "no answer" },
        );
      },
      listLogFiles: () =>
        Promise.resolve([{ name: "worker.log", mtimeMs: 1000 }]),
      readTail: () => Promise.resolve("[2026-10-25 01:27:18Z] INFO: quiet"),
      writeFile: (path, text) => {
        writes.set(path, text);
        return Promise.resolve();
      },
      diskReading: () => Promise.resolve(null),
      memoryReading: () => Promise.resolve({ level: "unknown" }),
      hostname: () => "test-host",
      timeout: () => ({
        promise: new Promise<void>(() => {}),
        cancel: () => {},
      }),
    },
  };
  return { deps, running, writes };
}

Deno.test("container-reap --if-silent - an answering guest exits 3, stays running and writes nothing", async () => {
  const { deps, running, writes } = silenceDeps(true, "vibe-coder-1");
  const result = await reap({
    runtime: "container",
    name: "vibe-coder-1",
    "if-silent": true,
    "evidence-dir": "/logs",
    "wedge-marker": "/logs/marker",
  }, { deps });
  assertEquals(result.success, true);
  assertEquals(result.exitCode, GUEST_ANSWERING_EXIT);
  assertEquals(result.data?.reaped, []);
  assertEquals([...running], ["vibe-coder-1"]);
  assertEquals(writes.size, 0);
});

Deno.test("container-reap --if-silent - a silent, non-answering guest is marked and reaped with the silence reason", async () => {
  const { deps, running, writes } = silenceDeps(false, "vibe-coder-1");
  const result = await reap({
    runtime: "container",
    name: "vibe-coder-1",
    "if-silent": true,
    "evidence-dir": "/logs",
    "wedge-marker": "/logs/marker",
    "grace-seconds": 0,
  }, { deps });
  assertEquals(result.exitCode, undefined);
  assertEquals(result.success, true);
  assertEquals(writes.get("/logs/marker"), "container_silent\n");
  assertEquals([...running], []);
  assertEquals(result.data?.reaped[0]?.reaped, true);
  const file = [...writes.keys()].find((path) =>
    /\/hard-kill-vibe-coder-1-\d+\.json$/.test(path)
  );
  const record = JSON.parse(writes.get(file!)!) as {
    reason: string;
    trigger: string;
  };
  assertStringIncludes(
    record.reason,
    "the launcher's watchdog found the guest silent for ",
  );
  assertStringIncludes(record.reason, "s and not answering");
  assertEquals(record.trigger, "watchdog");
});

Deno.test("container-reap --if-silent - without --evidence-dir is refused", async () => {
  const { deps, running } = silenceDeps(false, "vibe-coder-1");
  const result = await reap({
    runtime: "container",
    name: "vibe-coder-1",
    "if-silent": true,
  }, { deps });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--evidence-dir");
  assertEquals([...running], ["vibe-coder-1"]);
});
