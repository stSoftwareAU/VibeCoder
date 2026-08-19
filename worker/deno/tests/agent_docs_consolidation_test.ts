/**
 * Tests for Issue #3419 — the redundant agent instruction files were
 * consolidated into one set.
 *
 * The audit found two substantive, independently-maintained agent instruction
 * stores (`CLAUDE.md`, `AGENTS.md`) that had drifted apart and contradicted
 * each other on the live model generation. The consolidated end-state:
 *
 *   - `CLAUDE.md` is deleted.
 *   - `CODING-STANDARDS.md` is the single source of truth for coding standards.
 *   - `DESIGN-PRINCIPLES.md` holds the design digest (relocated from CLAUDE.md).
 *   - `AGENTS.md` is a thin pointer into the human documentation, not a
 *     parallel content store.
 *
 * These assertions check the observable deliverable — the presence, absence,
 * and structural shape of the instruction documents — rather than exact prose.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function exists(relative: string): Promise<boolean> {
  try {
    await Deno.stat(repoPath(relative));
    return true;
  } catch {
    return false;
  }
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

Deno.test("consolidation - the provider-specific CLAUDE.md is deleted", async () => {
  assertEquals(
    await exists("CLAUDE.md"),
    false,
    "CLAUDE.md must be removed — its content was folded into CODING-STANDARDS.md and DESIGN-PRINCIPLES.md.",
  );
});

Deno.test("consolidation - the single source of truth documents exist", async () => {
  assert(
    await exists("CODING-STANDARDS.md"),
    "CODING-STANDARDS.md must exist as the single source of truth for coding standards.",
  );
  assert(
    await exists("DESIGN-PRINCIPLES.md"),
    "DESIGN-PRINCIPLES.md must exist as the relocated design digest.",
  );
});

Deno.test("consolidation - AGENTS.md is a thin pointer, not a content store", async () => {
  const agents = await read("AGENTS.md");
  const lineCount = agents.split("\n").length;
  assert(
    lineCount < 120,
    `AGENTS.md must be a thin pointer (was ${lineCount} lines); the standards live in the human docs.`,
  );
  // The retired false claim must be gone — the standards are not owned here.
  assert(
    !/single source of truth for coding standards/i.test(agents),
    "AGENTS.md must not claim to be the single source of truth for coding standards.",
  );
  // It must point at the consolidated homes.
  assert(
    agents.includes("CODING-STANDARDS.md"),
    "AGENTS.md must point at CODING-STANDARDS.md.",
  );
  assert(
    agents.includes("DESIGN-PRINCIPLES.md"),
    "AGENTS.md must point at DESIGN-PRINCIPLES.md.",
  );
});

Deno.test("consolidation - CODING-STANDARDS.md carries the core standards", async () => {
  const std = await read("CODING-STANDARDS.md");
  assert(
    /Australian English/.test(std),
    "CODING-STANDARDS.md must document the Australian English rule.",
  );
  assert(
    std.includes("Result<T, E>") || std.includes("ok: true"),
    "CODING-STANDARDS.md must document the Result type error-handling contract.",
  );
});

Deno.test("consolidation - the stale Opus 4.7 model section is gone from the root docs", async () => {
  for (
    const doc of ["AGENTS.md", "CODING-STANDARDS.md", "DESIGN-PRINCIPLES.md"]
  ) {
    const text = await read(doc);
    assert(
      !/Opus 4\.7 Prompt Engineering Guidance/i.test(text),
      `${doc} still contains the superseded "Opus 4.7 Prompt Engineering Guidance" section — the model contradiction must be resolved in favour of the current generation.`,
    );
  }
});
