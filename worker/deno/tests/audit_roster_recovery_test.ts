/**
 * Crash recovery for a torn audit-roster line (Issue #1202).
 *
 * Issue #1074 gave the journal append a declared-then-settled recovery and
 * left the roster beside it appending with a plain `writeTextFile`. A torn
 * roster line is worse than a torn journal line: `readRosterContents`
 * throws, `verifyAllChains` fails the **whole directory**, and both
 * acknowledgement exits read the roster first, so neither applies. The only
 * way out was hand-editing the tamper-evidence file — exactly what Issue
 * #359 established must never be the remedy.
 *
 * These tests pin both halves: an unterminated, unparseable final line
 * heals itself and is reported, and every shape a kill cannot produce stays
 * red with the roster untouched.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  acknowledgeJournalLoss,
  auditFilePath,
  recordMutation,
  verifyAllChains,
} from "../lib/audit_journal.ts";
import {
  formatRosterRecovery,
  settleTornRosterLine,
} from "../lib/audit_roster_recovery.ts";
import { anchorPath, readRoster, rosterPath } from "../lib/audit_anchor.ts";

/** A fresh audit directory holding one rostered journal of `count` entries. */
async function seeded(
  count = 2,
): Promise<{ baseDir: string; path: string; journal: string }> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir({ prefix: "audit-roster-" });
  const opts = { baseDir, workerId: "test-worker", date: "2026-09-05" };
  for (let i = 0; i < count; i++) {
    const result = await recordMutation({
      runId: "run-1",
      repo: "org/repo",
      target: `n-${i}`,
      verb: "issue-comment",
      outcome: "success",
      caller: "roster-recovery-test",
    }, opts);
    assert(result.ok, "seeding append should succeed");
  }
  const path = auditFilePath(opts);
  return { baseDir, path, journal: path.slice(path.lastIndexOf("/") + 1) };
}

/** Append `text` to the roster exactly as a killed writer would leave it. */
async function tearRoster(baseDir: string, text: string): Promise<void> {
  await Deno.writeTextFile(rosterPath(baseDir), text, { append: true });
}

/** A roster line that stops mid-JSON, as a short write would leave it. */
const TORN = '{"journal":"audit-test-worker-2026-09-0';

Deno.test("audit roster - a torn final line no longer fails the whole sweep", async () => {
  const { baseDir, journal } = await seeded();
  try {
    // The reported damage: a writer killed part-way through the append.
    await tearRoster(baseDir, TORN);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok, "a torn roster line must not fail the sweep");
    if (!swept.ok) return;
    assertEquals(swept.value.broken, [], "no journal is damaged here");

    const repaired = swept.value.rosterRepaired;
    assert(repaired, "the repair must be reported, never silent");
    assertEquals(repaired.droppedText, TORN);
    assertEquals(repaired.droppedBytes, TORN.length);

    // The bytes are preserved beside the roster, not deleted.
    assertEquals(await Deno.readTextFile(repaired.preservedAs), TORN);

    // The expectation the roster exists to hold survives the repair.
    assertEquals(await readRoster(baseDir), [journal]);

    // And the next sweep is clean, with nothing left to repair.
    const again = await verifyAllChains(baseDir);
    assert(again.ok);
    if (!again.ok) return;
    assertEquals(again.value.rosterRepaired, undefined);
    assertEquals(again.value.broken, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - a terminated malformed line stays loud", async () => {
  const { baseDir } = await seeded();
  try {
    // Newline-terminated: the writer finished, so this is not a torn write
    // and healing it would be trimming the tamper-evidence file.
    await tearRoster(baseDir, "not json at all\n");
    const before = await Deno.readTextFile(rosterPath(baseDir));

    const swept = await verifyAllChains(baseDir);
    assert(!swept.ok, "a complete malformed line must keep failing the sweep");
    if (swept.ok) return;
    assertStringIncludes(swept.error.message, "malformed line");
    assertEquals(
      await Deno.readTextFile(rosterPath(baseDir)),
      before,
      "a roster that is not torn must never be touched",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - an unterminated but complete line stays loud", async () => {
  const { baseDir } = await seeded();
  try {
    // Parseable JSON of the wrong shape. A kill cannot leave a *complete*
    // line the writer never set out to append, so this is the forged-tail
    // shape and the missing newline must not launder it.
    await tearRoster(baseDir, '{"journal":"ghost.jsonl"}');
    const before = await Deno.readTextFile(rosterPath(baseDir));

    const swept = await verifyAllChains(baseDir);
    assert(!swept.ok, "a complete forged line must keep failing the sweep");
    if (swept.ok) return;
    assertStringIncludes(swept.error.message, "unexpected shape");
    assertEquals(await Deno.readTextFile(rosterPath(baseDir)), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - a healthy roster has nothing to settle", async () => {
  const { baseDir } = await seeded();
  try {
    const before = await Deno.readTextFile(rosterPath(baseDir));

    const settled = await settleTornRosterLine(baseDir);
    assert(settled.ok);
    if (!settled.ok) return;
    assertEquals(settled.value, null, "a healthy roster must be left alone");
    assertEquals(await Deno.readTextFile(rosterPath(baseDir)), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - a valid final line without its newline is not torn", async () => {
  const { baseDir, journal } = await seeded();
  try {
    // `readRosterContents` reads this perfectly well, so there is nothing
    // to repair even though the file does not end in a newline.
    await tearRoster(
      baseDir,
      `${JSON.stringify({ journal: "other.jsonl", addedAt: "2026-09-05" })}`,
    );

    const settled = await settleTornRosterLine(baseDir);
    assert(settled.ok);
    if (!settled.ok) return;
    assertEquals(settled.value, null);
    assertEquals(await readRoster(baseDir), [journal, "other.jsonl"]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - an absent roster has nothing to settle", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "audit-roster-none-" });
  try {
    const settled = await settleTornRosterLine(baseDir);
    assert(settled.ok);
    if (!settled.ok) return;
    assertEquals(settled.value, null);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - out of torn sidecars, the repair refuses rather than overwriting", async () => {
  const { baseDir } = await seeded();
  try {
    const roster = rosterPath(baseDir);
    for (let n = 1; n <= 100; n++) {
      await Deno.writeTextFile(`${roster}.torn-${n}`, "earlier damage");
    }
    await tearRoster(baseDir, '{"journal":"audit-');

    const settled = await settleTornRosterLine(baseDir);
    assert(!settled.ok, "the repair must refuse rather than overwrite");
    if (settled.ok) return;
    assertStringIncludes(settled.error.message, "already exist beside it");
    // Untouched, so the sweep keeps reporting it.
    assertEquals(
      (await Deno.readTextFile(roster)).endsWith('{"journal":"audit-'),
      true,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - a torn roster no longer blocks the acknowledgement exit", async () => {
  const { baseDir, path, journal } = await seeded();
  try {
    // The journal and its anchor are genuinely gone — the shape an
    // operator signs for — and the roster is torn as well.
    await Deno.remove(path);
    await Deno.remove(anchorPath(path));
    await tearRoster(baseDir, '{"journal":"audit-test-worker-2026-09');

    const signed = await acknowledgeJournalLoss({
      baseDir,
      journalName: journal,
      reason: "work volume pruned by housekeeping",
      by: "operator-1202",
    }, { baseDir, workerId: "test-worker", date: "2026-09-06" });

    assert(
      signed.ok,
      `a torn roster must not block the exit: ${
        signed.ok ? "" : signed.error.message
      }`,
    );
    if (!signed.ok) return;
    assertEquals(signed.value.journal, journal);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit roster - the report names what was dropped and where", () => {
  const line = formatRosterRecovery({
    path: "/audit.roster.jsonl",
    droppedBytes: 12,
    preservedAs: "/audit.roster.jsonl.torn-1",
    droppedText: '{"journal":',
  });
  assertStringIncludes(line, "[SECURITY] [AUDIT_ROSTER_RECOVERED]");
  assertStringIncludes(line, "12 torn byte(s)");
  assertStringIncludes(line, "/audit.roster.jsonl.torn-1");
  assertStringIncludes(line, '{\\"journal\\":');
});
