import { assertEquals, assertRejects } from "@std/assert";
import {
  appendPrDiscoveryEvent,
  readPrDiscoveryEvents,
  reportHostId,
} from "../lib/pr_discovery_events.ts";

Deno.test("PR discovery event ledger rotates daily and repairs a torn tail", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/events.jsonl`;
    const event = {
      event: "discovered" as const,
      hostId: "host-a",
      repo: "org/repo",
      prNumber: 17,
      headSha: "head-1",
      recordedAt: "2026-11-01T00:00:00Z",
    };
    await appendPrDiscoveryEvent(path, event);
    assertEquals(await readPrDiscoveryEvents(path), [event]);
    const later = {
      ...event,
      event: "eligible" as const,
      recordedAt: "2026-11-01T00:05:00Z",
    };
    await appendPrDiscoveryEvent(path, later);
    assertEquals(await readPrDiscoveryEvents(path), [event, later]);
    await Deno.writeTextFile(`${path}.2026-11-01`, '{"torn":', {
      append: true,
    });
    const next = {
      ...event,
      event: "processed" as const,
      recordedAt: "2026-11-01T00:10:00Z",
    };
    await appendPrDiscoveryEvent(path, next);
    assertEquals(await readPrDiscoveryEvents(path), [event, later, next]);
    const tomorrow = { ...event, recordedAt: "2026-11-02T00:00:00Z" };
    await appendPrDiscoveryEvent(path, tomorrow);
    assertEquals(await readPrDiscoveryEvents(path), [
      event,
      later,
      next,
      tomorrow,
    ]);
    assertEquals(
      await readPrDiscoveryEvents(path, Date.parse("2026-11-02T00:00:00Z")),
      [tomorrow],
    );
    assertEquals((await Deno.stat(`${path}.2026-11-02`)).isFile, true);
    await assertRejects(
      () => appendPrDiscoveryEvent(path, { ...event, hostId: "../escape" }),
      Error,
      "invalid PR discovery event",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("discovery suppresses repeated scans and excludes later days", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/events`;
    const event = {
      event: "discovered" as const,
      hostId: "host",
      repo: "org/repo",
      prNumber: 1,
      headSha: "head",
      recordedAt: "2026-10-01T01:00:00Z",
    };
    for (let i = 0; i < 100; i++) await appendPrDiscoveryEvent(path, event);
    await Deno.writeTextFile(`${path}.2026-10-17`, "invalid");
    const rows = await readPrDiscoveryEvents(
      path,
      Date.parse("2026-10-01T00:00:00Z"),
      Date.parse("2026-10-15T00:00:00Z"),
    );
    assertEquals(rows, [event]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PR discovery reader refuses an oversized ledger", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/events.jsonl`;
    await Deno.writeFile(path, new Uint8Array(16 * 1024 * 1024 + 1));
    await assertRejects(() => readPrDiscoveryEvents(path), Error, "exceeds");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reportHostId leaves a legal host identifier unchanged", () => {
  for (const id of ["host-a", "a.b_c-1", "Z9", "x".repeat(128)]) {
    assertEquals(reportHostId(id), id);
  }
});

Deno.test("reportHostId maps free-form labels onto a valid identifier", () => {
  assertEquals(reportHostId("my host/näme"), "my-host-n-me");
  assertEquals(reportHostId("  "), "host");
  assertEquals(reportHostId(""), "host");
  assertEquals(reportHostId("-_-"), "host");
  assertEquals(reportHostId("🚀box"), "box");
  assertEquals(reportHostId("x".repeat(300)), "x".repeat(128));
});

Deno.test("PR discovery events accept every reportHostId mapping of a free-form label", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/events.jsonl`;
    const labels = [
      "lab box/ü",
      "/leading/slash",
      "hosté\u{1F680}",
      "x".repeat(300),
      "host-a",
    ];
    for (const [index, raw] of labels.entries()) {
      await appendPrDiscoveryEvent(path, {
        event: "discovered",
        hostId: reportHostId(raw),
        repo: "org/repo",
        prNumber: index + 1,
        headSha: "head-1",
        recordedAt: "2026-11-01T00:00:00Z",
      });
    }
    assertEquals(
      (await readPrDiscoveryEvents(path)).map((row) => row.hostId),
      [
        "lab-box--",
        "leading-slash",
        "host---",
        "x".repeat(128),
        "host-a",
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
