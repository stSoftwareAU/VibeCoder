/**
 * Tests for slot attribution of log lines and status (Issue #4181, part of
 * #4168).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  attributeToSlot,
  currentSlotContext,
  formatSlotPrefix,
  renderSlotStatus,
  reportRunDeadline,
  runInSlotContext,
} from "../lib/slot_context.ts";
import { createLogger } from "../lib/logger.ts";

Deno.test("slot context - two concurrent slots through the real logger: every line matches the slot-prefix pattern and groups into exactly two work items (Issue #4181)", async () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (m) => lines.push(m) });
  const work = (slotId: string, repo: string, n: number) =>
    runInSlotContext({ slotId, repo, issueNumber: n }, async () => {
      logger.info(`Processing issue ${repo}#${n}`);
      await new Promise((r) => setTimeout(r, 2));
      logger.info(`phase build: started`);
      await new Promise((r) => setTimeout(r, 2));
      logger.warn(`phase build: slow`);
      logger.timing("execute", 12);
      logger.error(`phase build: failed`);
    });
  await Promise.all([work("s1", "o/a", 1), work("s2", "o/b", 22)]);
  assertEquals(lines.length, 10);
  const pattern =
    /^\[[^\]]+\] (?:INFO|WARNING|ERROR): \[(s\d+) ([^ #\]]+)#(\d+)\] |^\[[^\]]+\] \[TIMING\] \[(s\d+) ([^ #\]]+)#(\d+)\] /;
  const groups = new Map<string, number>();
  for (const line of lines) {
    const m = pattern.exec(line);
    assert(m, `unattributed line: ${line}`);
    const key = `${m[1] ?? m[4]} ${m[2] ?? m[5]}#${m[3] ?? m[6]}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  assertEquals([...groups.keys()].sort(), ["s1 o/a#1", "s2 o/b#22"]);
  assertEquals(groups.get("s1 o/a#1"), 5);
  assertEquals(groups.get("s2 o/b#22"), 5);
});

Deno.test("slot context - outside a slot the logger output is unchanged (single-slot format snapshot) (Issue #4181)", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (m) => lines.push(m) });
  logger.info("Processing issue o/a#1: title [build]");
  logger.timing("execute", 5);
  assertEquals(currentSlotContext(), undefined);
  assert(
    /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\] INFO: Processing issue o\/a#1: title \[build\]$/
      .test(lines[0]!),
    lines[0],
  );
  assert(
    /^\[[^\]]+\] \[TIMING\] \[execute\] duration=5s human=/.test(lines[1]!),
    lines[1],
  );
});

Deno.test("slot context - a message that already names its slot is not double-stamped (Issue #4181)", async () => {
  await runInSlotContext({ slotId: "s3", repo: "o/c", issueNumber: 9 }, () => {
    assertEquals(attributeToSlot("[s3 o/c#9] already"), "[s3 o/c#9] already");
    assertEquals(attributeToSlot("[s3] pool line"), "[s3] pool line");
    assertEquals(attributeToSlot("plain"), "[s3 o/c#9] plain");
    // Another slot's marker is not this slot's: stamp it (the line was
    // written on this slot's behalf, whatever it quotes).
    assertEquals(attributeToSlot("[s1] other"), "[s3 o/c#9] [s1] other");
    return Promise.resolve();
  });
  assertEquals(attributeToSlot("plain"), "plain");
  assertEquals(
    formatSlotPrefix({ slotId: "s10", repo: "o/r", issueNumber: 4 }),
    "[s10 o/r#4]",
  );
});

Deno.test("slot context - the context follows the async chain, not the caller (Issue #4181)", async () => {
  const seen: (string | undefined)[] = [];
  const probe = async () => {
    await new Promise((r) => setTimeout(r, 1));
    seen.push(currentSlotContext()?.slotId);
  };
  await Promise.all([
    runInSlotContext({ slotId: "s1", repo: "o/a", issueNumber: 1 }, probe),
    runInSlotContext({ slotId: "s2", repo: "o/b", issueNumber: 2 }, probe),
    probe(),
  ]);
  assertEquals(seen.sort(), ["s1", "s2", undefined]);
});

Deno.test("slot context - renderSlotStatus: none → idle, one → today's repo#issue, several → slot-ordered table (Issue #4181)", () => {
  assertEquals(renderSlotStatus([]), "idle");
  assertEquals(
    renderSlotStatus([{ slotId: "s2", repo: "o/b", issueNumber: 7 }]),
    "o/b#7",
  );
  assertEquals(
    renderSlotStatus([
      { slotId: "s10", repo: "o/j", issueNumber: 10 },
      { slotId: "s2", repo: "o/b", issueNumber: 7 },
      { slotId: "s1", repo: "o/a", issueNumber: 1 },
    ]),
    "s1 o/a#1 | s2 o/b#7 | s10 o/j#10",
  );
});

Deno.test("slot context - a run reports its deadline to the slot's reporter; outside a slot it is a no-op (Issue #4297)", async () => {
  const reported: { deadlineMs: number; extensionsGranted: number }[] = [];
  const delivered = await runInSlotContext(
    {
      slotId: "s1",
      repo: "o/a",
      issueNumber: 4,
      onRunDeadline: (state) => reported.push(state),
    },
    async () => {
      reportRunDeadline({ deadlineMs: 1_000, extensionsGranted: 0 });
      // Async continuations stay inside the context, so an extension
      // granted deep in the runner still reaches the pool.
      await new Promise((r) => setTimeout(r, 2));
      return reportRunDeadline({ deadlineMs: 2_000, extensionsGranted: 1 });
    },
  );
  assertEquals(delivered, true);
  assertEquals(reported, [
    { deadlineMs: 1_000, extensionsGranted: 0 },
    { deadlineMs: 2_000, extensionsGranted: 1 },
  ]);

  // No slot (the CLI single-issue path): nothing is watching, no throw.
  assertEquals(
    reportRunDeadline({ deadlineMs: 3_000, extensionsGranted: 0 }),
    false,
  );
  // A slot that wired no reporter is equally harmless.
  assertEquals(
    await runInSlotContext(
      { slotId: "s2", repo: "o/b", issueNumber: 5 },
      () =>
        Promise.resolve(
          reportRunDeadline({ deadlineMs: 4, extensionsGranted: 0 }),
        ),
    ),
    false,
  );
});
