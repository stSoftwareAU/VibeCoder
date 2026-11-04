import { assertEquals, assertRejects } from "@std/assert";
import {
  appendPrDiscoveryEvent,
  readPrDiscoveryEvents,
  reportHostId,
} from "../lib/pr_discovery_events.ts";

Deno.test("PR discovery event ledger validates and deduplicates transitions", async () => {
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
    await appendPrDiscoveryEvent(path, event);
    assertEquals(await readPrDiscoveryEvents(path), [event]);
    await assertRejects(
      () => appendPrDiscoveryEvent(path, { ...event, hostId: "../escape" }),
      Error,
      "invalid PR discovery event",
    );
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
