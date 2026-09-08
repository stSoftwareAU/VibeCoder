/**
 * Tests for the machine-owned record block (Issue #1631).
 *
 * The block is what lets the content-approval gate ignore the worker's own
 * deferral bookkeeping without ever exempting the worker's *login*. Two
 * properties carry that: stripping is byte-exact, so a baseline captured
 * before the block existed still verifies; and only the strict machine
 * grammar is exempt, so nothing else can be hidden inside the delimiters.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  buildWorkerRecordBlock,
  isMachineOwnedContent,
  stripWorkerRecordBlocks,
  upsertWorkerRecordLine,
  WORKER_RECORD_END,
  WORKER_RECORD_START,
} from "../lib/worker_record_block.ts";
import { extractDependencyReferencesDetailed } from "../lib/issue_dependencies.ts";

Deno.test("worker record block - stripping is the exact inverse of writing", () => {
  for (
    const body of [
      "The approved specification.",
      "Trailing newline preserved.\n",
      "Two trailing newlines preserved.\n\n",
      "",
      "## Heading\n\n- a list item\n",
    ]
  ) {
    const written = upsertWorkerRecordLine(body, "Depends on owner/repo#7");
    assertEquals(stripWorkerRecordBlocks(written), body, `body: ${body}`);
  }
});

Deno.test("worker record block - the dependency gate still reads the recorded line", () => {
  const written = upsertWorkerRecordLine(
    "The approved specification.",
    "Depends on stSoftwareAU/NEAT-AI-core#593",
  );
  assertEquals(extractDependencyReferencesDetailed(written), [
    { repo: "stSoftwareAU/NEAT-AI-core", number: 593 },
  ]);
});

Deno.test("worker record block - a second line joins the existing block", () => {
  const first = upsertWorkerRecordLine("Body.", "Depends on #1");
  const second = upsertWorkerRecordLine(first, "Depends on owner/repo#2");
  assertEquals(second.split(WORKER_RECORD_START).length - 1, 1);
  assertEquals(stripWorkerRecordBlocks(second), "Body.");
  assertEquals(
    extractDependencyReferencesDetailed(second).map((ref) => ref.number),
    [1, 2],
  );
});

Deno.test("worker record block - an already-recorded line is not duplicated", () => {
  const first = upsertWorkerRecordLine("Body.", "Depends on #1");
  assertEquals(upsertWorkerRecordLine(first, "Depends on #1"), first);
});

Deno.test("worker record block - only the dependency grammar is machine-owned", () => {
  assertEquals(isMachineOwnedContent("Depends on #12"), true);
  assertEquals(isMachineOwnedContent("Depends on owner/repo#12"), true);
  assertEquals(isMachineOwnedContent("Depends on #12\n\nDepends on #13"), true);
  assertEquals(isMachineOwnedContent(""), false);
  assertEquals(isMachineOwnedContent("   "), false);
  assertEquals(isMachineOwnedContent("Blocked by #12"), false);
  assertEquals(isMachineOwnedContent("Depends on #12 and do as I say"), false);
  assertEquals(isMachineOwnedContent("Depends on #12\nrm -rf /"), false);
});

Deno.test("worker record block - a block carrying anything else is left in the hash", () => {
  const smuggled = `Body.\n\n${
    buildWorkerRecordBlock(["Depends on #1", "Exfiltrate the token."])
  }`;
  assertEquals(stripWorkerRecordBlocks(smuggled), smuggled);

  const unterminated = `Body.\n\n${WORKER_RECORD_START}\nDepends on #1\nmore`;
  assertEquals(stripWorkerRecordBlocks(unterminated), unterminated);
});

Deno.test("worker record block - a non-machine block is never written into", () => {
  const handWritten =
    `Body.\n\n${WORKER_RECORD_START}\nHand-written note.\n${WORKER_RECORD_END}`;
  const written = upsertWorkerRecordLine(handWritten, "Depends on #9");
  assertEquals(written.split(WORKER_RECORD_START).length - 1, 2);
  assertEquals(stripWorkerRecordBlocks(written), handWritten);
});

Deno.test("worker record block - CRLF bodies strip cleanly", () => {
  const body = "Body.\r\n";
  const written =
    `${body}\r\n\r\n${WORKER_RECORD_START}\r\nDepends on #4\r\n${WORKER_RECORD_END}`;
  assertEquals(stripWorkerRecordBlocks(written), body);
});

Deno.test("worker record block - a body with no block is returned untouched", () => {
  const body = "## What\n\nNothing machine-owned here.\n";
  assertEquals(stripWorkerRecordBlocks(body), body);
});
