/**
 * Unit tests for the PR summary facts helpers (Issue #3535, part of #3396).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  applyBranchOutcomesFacts,
  BRANCH_OUTCOMES_MARKER,
  loadPrSummaryFacts,
  prSummaryDigestInput,
  prSummaryFactsPath,
  resolveBranchOutcomesFacts,
} from "../lib/pr_summary_facts.ts";

Deno.test("applyBranchOutcomesFacts replaces the first marker only", () => {
  const out = applyBranchOutcomesFacts(
    `a\n${BRANCH_OUTCOMES_MARKER}\nb\n${BRANCH_OUTCOMES_MARKER}\n`,
    "LIST",
  );
  assertEquals(out, `a\nLIST\nb\n${BRANCH_OUTCOMES_MARKER}\n`);
});

Deno.test("applyBranchOutcomesFacts appends when the marker is absent", () => {
  assertEquals(applyBranchOutcomesFacts("body\n\n", "LIST"), "body\n\nLIST\n");
});

Deno.test("applyBranchOutcomesFacts returns just the list for an empty summary", () => {
  assertEquals(applyBranchOutcomesFacts("  \n", "LIST"), "LIST\n");
});

Deno.test("prSummaryDigestInput leaves the summary unchanged without facts", () => {
  assertEquals(prSummaryDigestInput("summary", null), "summary");
});

Deno.test("prSummaryDigestInput differs when facts are present", () => {
  const withFacts = prSummaryDigestInput("summary", "{}");
  assertNotEquals(withFacts, "summary");
  assertNotEquals(withFacts, prSummaryDigestInput("summary", '{"a":1}'));
});

Deno.test("loadPrSummaryFacts returns null when the file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadPrSummaryFacts(dir, 7), { ok: true, value: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadPrSummaryFacts reads the file content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${prSummaryFactsPath(7)}`, "{}");
    assertEquals(await loadPrSummaryFacts(dir, 7), {
      ok: true,
      value: { content: "{}", relativePath: prSummaryFactsPath(7) },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadPrSummaryFacts reports an unreadable path, naming it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${prSummaryFactsPath(7)}`, { recursive: true });
    const result = await loadPrSummaryFacts(dir, 7);
    assertEquals(result.ok, false);
    assert(!result.ok);
    assert(result.error.message.includes(prSummaryFactsPath(7)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveBranchOutcomesFacts names the file and has no content when it is unreadable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${prSummaryFactsPath(7)}`, { recursive: true });
    const outcome = await resolveBranchOutcomesFacts(dir, 7);
    assert(outcome.kind === "error");
    assertEquals(outcome.relativePath, prSummaryFactsPath(7));
    assertEquals(outcome.content, null);
    assert(outcome.reason.includes("could not be read"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveBranchOutcomesFacts keeps the file name and raw content when it is invalid", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${prSummaryFactsPath(7)}`, "{ not json");
    const outcome = await resolveBranchOutcomesFacts(dir, 7);
    assert(outcome.kind === "error");
    assertEquals(outcome.relativePath, prSummaryFactsPath(7));
    assertEquals(outcome.content, "{ not json");
    assert(outcome.reason.includes("is invalid"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
