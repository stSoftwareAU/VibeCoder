import { assertEquals } from "@std/assert";
import { cleanupWorkerLogs } from "../lib/worker_log_cleanup.ts";

Deno.test("transcripts survive 30 days even when tiny, rotated or beside capped worker logs", async () => {
  const dir = await Deno.makeTempDir();
  const now = new Date("2026-10-01T00:00:00Z");
  try {
    const survivors = [
      "agent-vibe-tiny.jsonl",
      "agent-vibe-rotated.jsonl.1",
      "agent-vibe-compressed.jsonl.gz",
    ];
    for (
      const name of [...survivors, "agent-vibe-expired.jsonl", "worker-1.log"]
    ) {
      await Deno.writeTextFile(`${dir}/${name}`, "{}");
      const age = name.includes("expired") ? 31 : 30;
      await Deno.utime(
        `${dir}/${name}`,
        now.getTime() / 1000 - age * 86400,
        now.getTime() / 1000 - age * 86400,
      );
    }
    const result = await cleanupWorkerLogs(dir, { now, hardCapCount: 0 });
    assertEquals(result.deleted.map((p) => p.split("/").at(-1)).sort(), [
      "agent-vibe-expired.jsonl",
      "worker-1.log",
    ]);
    for (const name of survivors) {
      assertEquals((await Deno.stat(`${dir}/${name}`)).isFile, true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transcript cap evicts oldest evidence separately and reports shortened retention", async () => {
  const dir = await Deno.makeTempDir();
  const now = new Date();
  try {
    for (
      const [name, age] of [["agent-vibe-older.jsonl", 2], [
        "agent-vibe-newer.jsonl",
        1,
      ], ["worker-1.log", 1]] as const
    ) {
      await Deno.writeTextFile(`${dir}/${name}`, "x".repeat(300));
      await Deno.utime(
        `${dir}/${name}`,
        now.getTime() / 1000 - age * 60,
        now.getTime() / 1000 - age * 60,
      );
    }
    const result = await cleanupWorkerLogs(dir, {
      now,
      transcriptHardCapCount: 1,
    });
    assertEquals(result.deleted, [`${dir}/agent-vibe-older.jsonl`]);
    assertEquals(
      result.message.includes(
        "transcript cap removed 1 (may shorten 30-day retention)",
      ),
      true,
    );
    assertEquals((await Deno.stat(`${dir}/worker-1.log`)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
