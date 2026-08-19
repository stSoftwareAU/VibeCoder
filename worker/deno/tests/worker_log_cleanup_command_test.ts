/**
 * CLI tests for the worker-log-cleanup command.
 *
 * Unit tests for the policy logic live in worker_log_cleanup_test.ts.
 * Issue #1902.
 */

import { assertEquals } from "@std/assert";
import { workerLogCleanupCommand } from "../commands/worker_log_cleanup.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerLogCleanupResult } from "../lib/worker_log_cleanup.ts";
import type { WorkerConfig } from "../types.ts";

function mockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

Deno.test("worker-log-cleanup command - has correct name", () => {
  assertEquals(workerLogCleanupCommand.name, "worker-log-cleanup");
});

Deno.test("worker-log-cleanup command - succeeds against empty directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await workerLogCleanupCommand.execute(
      { "log-dir": tmpDir },
      mockConfig(),
    );
    assertEquals(result.success, true);
    const data = result.data as WorkerLogCleanupResult | undefined;
    assertEquals(data?.deleted.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker-log-cleanup command - parses numeric overrides from string args", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Create 4 large young logs; hard cap of 2 (passed as string) should delete 2.
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const p = `${tmpDir}/worker-${100 + i}.log`;
      await Deno.writeFile(p, new Uint8Array(5_000));
      const mtime = new Date(now - (4 - i) * 60_000);
      await Deno.utime(p, mtime, mtime);
    }

    const result = await workerLogCleanupCommand.execute(
      {
        "log-dir": tmpDir,
        "hard-cap-count": "2",
        "max-age-days": "30",
      },
      mockConfig(),
    );
    assertEquals(result.success, true);
    const data = result.data as WorkerLogCleanupResult | undefined;
    assertEquals(data?.deleted.length, 2);
    assertEquals(data?.kept, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker-log-cleanup command - handles missing directory gracefully", async () => {
  const result = await workerLogCleanupCommand.execute(
    { "log-dir": "/tmp/does-not-exist-cmd-1902" },
    mockConfig(),
  );
  assertEquals(result.success, true);
});
