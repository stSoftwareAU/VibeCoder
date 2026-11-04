import { assertEquals, assertRejects } from "@std/assert";
import {
  appendPrDiscoveryEvent,
  readPrDiscoveryEvents,
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
