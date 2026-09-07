/**
 * Tests for the one-answer-per-question consent reader (Issue #1296).
 *
 * Setup's ruleset question used to read a fixed 16 bytes from stdin. Anything
 * the operator typed beyond that — the newline and everything after it —
 * stayed in the buffer and was read as the NEXT repository's answer, so a
 * ruleset could be written on a repository nobody was asked about.
 *
 * Each prompt must therefore consume exactly one line and discard whatever
 * follows it: input the operator did not direct at a question can never
 * satisfy it.
 */

import { assertEquals } from "@std/assert";
import {
  type ConsentReader,
  isAffirmative,
  readConsentLine,
} from "../setup/consent_prompt.ts";
import { askCreateMilestoneRuleset } from "../setup/setup_cli.ts";

/** A reader that hands back one scripted chunk per `read`, then EOF. */
function chunkReader(chunks: readonly string[]): ConsentReader {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  return {
    read(buffer: Uint8Array): Promise<number | null> {
      const next = queue.shift();
      if (next === undefined) return Promise.resolve(null);
      const take = Math.min(next.length, buffer.length);
      buffer.set(next.subarray(0, take));
      if (take < next.length) queue.unshift(next.subarray(take));
      return Promise.resolve(take);
    },
  };
}

/** A reader over one string, delivered `size` bytes at a time. */
function slicedReader(text: string, size: number): ConsentReader {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.subarray(i, i + size));
  }
  let index = 0;
  return {
    read(buffer: Uint8Array): Promise<number | null> {
      const next = chunks[index];
      if (next === undefined) return Promise.resolve(null);
      index++;
      buffer.set(next.subarray(0, buffer.length));
      return Promise.resolve(Math.min(next.length, buffer.length));
    },
  };
}

Deno.test("readConsentLine - a 17-character answer does not answer the next question", async () => {
  // The exact trigger from Issue #1296: 16 n's and a trailing y.
  const reader = chunkReader(["nnnnnnnnnnnnnnnny\n"]);

  const first = await readConsentLine(reader);
  const second = await readConsentLine(reader);

  assertEquals(first, "nnnnnnnnnnnnnnnny");
  assertEquals(isAffirmative(first), false);
  // The tail must not survive as the second prompt's answer.
  assertEquals(second, null);
  assertEquals(isAffirmative(second), false);
});

Deno.test("readConsentLine - a second line typed ahead never answers a later prompt", async () => {
  const reader = chunkReader(["y\ny\n"]);

  assertEquals(await readConsentLine(reader), "y");
  assertEquals(await readConsentLine(reader), null);
});

Deno.test("readConsentLine - accepts the affirmative answers, trimmed and case-folded", async () => {
  for (const typed of ["y\n", "  Y  \n", "yes\n", "YES\n"]) {
    const answer = await readConsentLine(chunkReader([typed]));
    assertEquals(isAffirmative(answer), true, `expected ${typed} to affirm`);
  }
});

Deno.test("readConsentLine - declines on no, on a bare Enter and at EOF", async () => {
  for (const typed of ["n\n", "no\n", "\n", "yep\n"]) {
    const answer = await readConsentLine(chunkReader([typed]));
    assertEquals(isAffirmative(answer), false, `expected ${typed} to decline`);
  }
  assertEquals(await readConsentLine(chunkReader([])), null);
});

Deno.test("readConsentLine - assembles an answer split across reads", async () => {
  assertEquals(await readConsentLine(slicedReader("yes\n", 1)), "yes");
});

Deno.test("readConsentLine - decodes multi-byte characters split across reads", async () => {
  // "ouí" is 4 bytes; a 3-byte read splits the í in half.
  assertEquals(await readConsentLine(slicedReader("ouí\n", 3)), "ouí");
});

Deno.test("readConsentLine - honours a final line with no trailing newline", async () => {
  assertEquals(await readConsentLine(chunkReader(["y"])), "y");
});

Deno.test("readConsentLine - a pasted answer longer than the cap still declines", async () => {
  const reader = chunkReader(["z".repeat(5000) + "y\n"]);

  const first = await readConsentLine(reader);

  assertEquals(isAffirmative(first), false);
  // The whole over-long line is consumed, so nothing leaks to the next prompt.
  assertEquals(await readConsentLine(reader), null);
});

Deno.test("askCreateMilestoneRuleset - one long answer cannot approve the next repo", async () => {
  const reader = chunkReader(["nnnnnnnnnnnnnnnny\n"]);
  const written: string[] = [];
  const seams = {
    reader,
    isTerminal: () => true,
    write: (chunk: Uint8Array) => {
      written.push(new TextDecoder().decode(chunk));
      return Promise.resolve(chunk.length);
    },
  };

  const first = await askCreateMilestoneRuleset("org/repo-one", seams);
  const second = await askCreateMilestoneRuleset("org/repo-two", seams);

  assertEquals(first, false);
  assertEquals(second, false);
  assertEquals(written.length, 2);
});

Deno.test("askCreateMilestoneRuleset - a yes on its own line approves", async () => {
  const approved = await askCreateMilestoneRuleset("org/repo-one", {
    reader: chunkReader(["yes\n"]),
    isTerminal: () => true,
    write: (chunk: Uint8Array) => Promise.resolve(chunk.length),
  });

  assertEquals(approved, true);
});

Deno.test("askCreateMilestoneRuleset - never asks without a terminal", async () => {
  let asked = false;
  const approved = await askCreateMilestoneRuleset("org/repo-one", {
    reader: chunkReader(["y\n"]),
    isTerminal: () => false,
    write: (chunk: Uint8Array) => {
      asked = true;
      return Promise.resolve(chunk.length);
    },
  });

  assertEquals(approved, false);
  assertEquals(asked, false);
});
