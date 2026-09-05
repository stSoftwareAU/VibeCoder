/**
 * Interrupted-append recovery for the audit journal (Issue #1074).
 *
 * A worker log reported `AUDIT_CHAIN_BROKEN … at entry 29: malformed JSON`
 * and offered the operator a manual `--acknowledge-damage`. These tests
 * pin both halves of the fix: an append the writer never got to confirm
 * heals itself, and every shape that could be tampering stays red.
 *
 * The tamper cases are the ones that matter most — a self-heal that
 * swallowed them would have destroyed the control while appearing to fix
 * the bug — so they outnumber the happy paths here deliberately.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  computeEntryHash,
  loadEntries,
  recordMutation,
  verifyAllChains,
  verifyChain,
} from "../lib/audit_journal.ts";
import {
  formatAppendRecovery,
  settleInterruptedAppend,
} from "../lib/audit_append_recovery.ts";
import {
  anchorPath,
  type ChainAnchor,
  rosterPath,
  writeAnchor,
} from "../lib/audit_anchor.ts";

/** A fresh audit directory with `count` recorded mutations. */
async function seeded(
  count: number,
): Promise<{ baseDir: string; path: string; opts: Record<string, string> }> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir({ prefix: "audit-recovery-" });
  const opts = { baseDir, workerId: "test-worker", date: "2026-09-05" };
  for (let i = 0; i < count; i++) {
    const result = await recordMutation({
      runId: "run-1",
      repo: "org/repo",
      target: `n-${i}`,
      verb: "issue-comment",
      outcome: "success",
      caller: "recovery-test",
    }, opts);
    assert(result.ok, "seeding append should succeed");
  }
  return { baseDir, path: auditFilePath(opts), opts };
}

/** Read the anchor sidecar directly. */
async function readAnchorFile(path: string): Promise<ChainAnchor> {
  return JSON.parse(await Deno.readTextFile(anchorPath(path))) as ChainAnchor;
}

/** Overwrite the anchor sidecar directly. */
async function writeAnchorFile(
  path: string,
  anchor: ChainAnchor,
): Promise<void> {
  await Deno.writeTextFile(anchorPath(path), `${JSON.stringify(anchor)}\n`);
}

/**
 * Simulate a writer killed part-way through appending `text`.
 *
 * The declaration is what the live writer records before it appends, so
 * the fixture writes the same thing: the anchor stays at the confirmed
 * head and names the entry that is in flight.
 */
async function crashMidAppend(
  path: string,
  pendingHash: string,
  text: string,
): Promise<void> {
  const anchor = await readAnchorFile(path);
  await writeAnchorFile(path, {
    ...anchor,
    pending: { hash: pendingHash, startedAt: "2026-09-05T00:49:12.000Z" },
  });
  if (text.length > 0) {
    await Deno.writeTextFile(path, text, { append: true });
  }
}

/** Lowercase hex SHA-256 of a string, as the roster records digests. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A 64-hex hash that is not any real entry's. */
const FAKE_HASH = "a".repeat(64);

Deno.test("audit recovery - a torn final line heals back to the anchored head", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // Exactly the reported damage: the last line stops mid-JSON.
    await crashMidAppend(path, FAKE_HASH, '{"timestamp":"2026-09-05T00:4');

    const before = await verifyChain(path);
    assert(before.ok);
    assert(!before.value.valid, "the torn line must break verification first");

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.broken, [], "a torn tail must not stay broken");
    assertEquals(swept.value.recovered.length, 1);

    const recovery = swept.value.recovered[0];
    assertEquals(recovery?.kind, "discarded");
    assertEquals(recovery?.count, 3);
    assertEquals(recovery?.droppedText, '{"timestamp":"2026-09-05T00:4');

    // The dropped bytes are preserved, not deleted.
    assert(recovery?.preservedAs, "the torn bytes must be preserved");
    assertEquals(
      await Deno.readTextFile(recovery.preservedAs),
      '{"timestamp":"2026-09-05T00:4',
    );

    const entries = await loadEntries(path);
    assert(entries.ok);
    assertEquals(entries.value.length, 3, "no confirmed entry may be dropped");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a declared entry that landed is kept, not discarded", async () => {
  const { baseDir, path } = await seeded(2);
  try {
    // The line reached the file; only the confirming anchor write was lost.
    const third = await recordMutation({
      runId: "run-1",
      target: "n-2",
      verb: "issue-comment",
      outcome: "success",
      caller: "recovery-test",
    }, { baseDir, workerId: "test-worker", date: "2026-09-05" });
    assert(third.ok);
    const seededEntries = await loadEntries(path);
    assert(seededEntries.ok);
    const anchor = await readAnchorFile(path);
    await writeAnchorFile(path, {
      ...anchor,
      count: 2,
      headHash: seededEntries.value[1]?.hash ?? "",
      pending: {
        hash: third.value.hash,
        startedAt: "2026-09-05T00:49:12.000Z",
      },
    });

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.broken, []);
    assertEquals(swept.value.recovered[0]?.kind, "completed");
    assertEquals(swept.value.recovered[0]?.droppedBytes, 0);

    const entries = await loadEntries(path);
    assert(entries.ok);
    assertEquals(entries.value.length, 3, "the landed entry must survive");
    assertEquals((await readAnchorFile(path)).count, 3);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a declared append that never landed needs no repair", async () => {
  const { baseDir, path, opts } = await seeded(2);
  try {
    await crashMidAppend(path, FAKE_HASH, "");

    // The journal already matches its anchor, so the chain is intact and
    // nothing is repaired — the stale declaration is left where it is
    // rather than rewriting the anchor of a healthy file.
    const verified = await verifyChain(path);
    assert(verified.ok);
    assert(verified.value.valid, `chain broke: ${verified.value.reason}`);
    const settled = await settleInterruptedAppend(path);
    assert(settled.ok);
    assertEquals(settled.value, null);

    // The next append overwrites the whole anchor record, declaration
    // included, so the stale one cannot outlive it.
    const next = await recordMutation({
      runId: "run-2",
      target: "after-stale-declaration",
      verb: "git-push",
      outcome: "success",
      caller: "recovery-test",
    }, opts);
    assert(next.ok);
    assertEquals((await readAnchorFile(path)).pending, undefined);
    assertEquals((await readAnchorFile(path)).count, 3);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - an undeclared valid tail still fails loudly", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // A correctly-chained entry appended past the anchor with no pending
    // record: the forged-tail shape Issue #3949 exists to catch.
    const entries = await loadEntries(path);
    assert(entries.ok);
    const head = entries.value[2];
    assert(head);
    const payload = { ...head, target: "forged" };
    const forged = {
      ...payload,
      prevHash: head.hash,
      hash: await computeEntryHash(payload, head.hash),
    };
    await Deno.writeTextFile(path, `${JSON.stringify(forged)}\n`, {
      append: true,
    });

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, [], "nothing may be settled here");
    assertEquals(swept.value.broken.length, 1);
    assertStringIncludes(
      swept.value.broken[0]?.reason ?? "",
      "appended past the anchor",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a rewritten middle entry still fails loudly", async () => {
  const { baseDir, path } = await seeded(4);
  try {
    const raw = (await Deno.readTextFile(path)).split("\n");
    const middle = JSON.parse(raw[1] ?? "{}");
    middle.target = "tampered";
    raw[1] = JSON.stringify(middle);
    await Deno.writeTextFile(path, raw.join("\n"));

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, []);
    assertEquals(swept.value.broken.length, 1);
    assertEquals(swept.value.broken[0]?.brokenIndex, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a torn middle line still fails loudly", async () => {
  const { baseDir, path } = await seeded(4);
  try {
    // Entry 1 truncated, with valid entries after it — the tamper shape
    // that must never be mistaken for an interrupted append. A pending
    // record is present too: even a declared append cannot excuse damage
    // at or before the anchored head.
    const raw = (await Deno.readTextFile(path)).split("\n");
    raw[1] = (raw[1] ?? "").slice(0, 20);
    await Deno.writeTextFile(path, raw.join("\n"));
    const anchor = await readAnchorFile(path);
    await writeAnchorFile(path, {
      ...anchor,
      pending: { hash: FAKE_HASH, startedAt: "2026-09-05T00:49:12.000Z" },
    });

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, []);
    assertEquals(swept.value.broken.length, 1);
    assertEquals(swept.value.broken[0]?.brokenIndex, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - two torn lines do not self-heal", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    await crashMidAppend(path, FAKE_HASH, '{"broken":1\n{"broken":2');

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, [], "only one tail line may settle");
    assertEquals(swept.value.broken.length, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a torn line followed by a valid one does not self-heal", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    const entries = await loadEntries(path);
    assert(entries.ok);
    const head = entries.value[2];
    assert(head);
    const after = JSON.stringify({ ...head, target: "after-the-tear" });
    await crashMidAppend(path, FAKE_HASH, `{"torn":\n${after}\n`);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, []);
    assertEquals(swept.value.broken.length, 1);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

// Behaviour deliberately reversed (Issue #1074 review). This test
// previously asserted that a forged tail claiming the declared hash was
// `discarded` and the sweep then went green. That was a hole, not a
// feature: a stale `pending` record is a state the fix itself creates
// routinely — any writer killed after declaring and before appending
// leaves one — so "there is a declaration, therefore any unexpected tail
// is crash damage" let a forged, chain-valid entry be swept away with a
// clean report. A kill cannot produce a *complete* entry the writer never
// declared; only a forger can. So a parseable tail now stays red and
// needs a signature, which is what the acceptance criterion asks for.
Deno.test("audit recovery - a tail claiming the declared hash stays broken", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // A forger who can read the pending record still cannot satisfy it:
    // the entry must re-derive the declared hash from its own payload.
    const entries = await loadEntries(path);
    assert(entries.ok);
    const head = entries.value[2];
    assert(head);
    const forged = {
      ...head,
      target: "forged",
      prevHash: head.hash,
      hash: FAKE_HASH,
    };
    await crashMidAppend(path, FAKE_HASH, `${JSON.stringify(forged)}\n`);

    const settled = await settleInterruptedAppend(path);
    assert(settled.ok);
    // Nothing is settled: the tail is whole, so it is not damage.
    assertEquals(settled.value, null);
    assertEquals((await readAnchorFile(path)).count, 3);
    // Still on disk — a self-heal must not be the way a forgery is
    // removed, and the operator has to see it to sign for it.
    assertStringIncludes(await Deno.readTextFile(path), "forged");
    const verified = await verifyChain(path);
    assert(verified.ok);
    assert(!verified.value.valid, "a forged tail must still fail loudly");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a forged chain-valid tail is not laundered by a stale declaration", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // The sharper form of the same hole: the forged entry chains
    // correctly onto the anchored head, so it is indistinguishable from a
    // real append except that the anchor never declared *it*. The chain
    // hash is unkeyed, so any local actor can compute one.
    const entries = await loadEntries(path);
    assert(entries.ok);
    const head = entries.value[2];
    assert(head);
    const payload = {
      timestamp: new Date().toISOString(),
      runId: "attacker",
      repo: "o/r",
      target: "main",
      verb: "git-push" as const,
      outcome: "success" as const,
      caller: "forged",
    };
    const forged = {
      ...payload,
      prevHash: head.hash,
      hash: await computeEntryHash(payload, head.hash),
    };
    await crashMidAppend(path, FAKE_HASH, `${JSON.stringify(forged)}\n`);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, []);
    assertEquals(swept.value.broken.length, 1, "the forgery must stay red");
    assertStringIncludes(await Deno.readTextFile(path), "attacker");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a legacy torn tail with no intent record heals", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // Journals written before Issue #1074 carry no pending record. An
    // unterminated, unparseable tail past the anchored head is still a
    // partial write and nothing else: a forgery has to parse to be worth
    // anything.
    await Deno.writeTextFile(path, '{"timestamp":"2026-09', { append: true });

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.broken, []);
    assertEquals(swept.value.recovered[0]?.kind, "discarded");
    assertEquals(swept.value.recovered[0]?.droppedBytes, 21);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - recording continues in the same journal after a heal", async () => {
  const { baseDir, path, opts } = await seeded(2);
  try {
    await crashMidAppend(path, FAKE_HASH, '{"half":');

    // No quarantine segment: the day's journal is healthy again, so the
    // trail carries on in it.
    const next = await recordMutation({
      runId: "run-2",
      target: "after-heal",
      verb: "git-push",
      outcome: "success",
      caller: "recovery-test",
    }, opts);
    assert(next.ok, "the append after a heal should succeed");

    const entries = await loadEntries(path);
    assert(entries.ok);
    assertEquals(entries.value.length, 3);
    assertEquals(entries.value[2]?.target, "after-heal");
    const verified = await verifyChain(path);
    assert(verified.ok);
    assert(verified.value.valid, `chain broke: ${verified.value.reason}`);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

/** A child that appends to the journal in `baseDir` until it is killed. */
const KILLABLE_WRITER = `
import { recordMutation } from ${
  JSON.stringify(new URL("../lib/audit_journal.ts", import.meta.url).href)
};
const [baseDir] = Deno.args;
for (let i = 0; i < 100_000; i++) {
  const result = await recordMutation({
    runId: "kill-repro",
    verb: "api-patch",
    target: "n-" + i,
    outcome: "success",
    caller: "kill-test",
  }, { baseDir, workerId: "killed-worker", date: "2026-09-05" });
  if (!result.ok) {
    console.error(result.error.message);
    Deno.exit(1);
  }
  // One line, once the writer is well inside its loop: the parent kills
  // on that signal rather than after a sleep, and the kill then lands on
  // an append rather than on a process that has barely started.
  if (i === 50) console.log("running");
}
`;

Deno.test("audit recovery - a real SIGKILL mid-append needs no signature", async () => {
  _resetAuditCaches();
  const dir = await Deno.makeTempDir({ prefix: "audit-sigkill-" });
  const script = `${dir}/writer.ts`;
  await Deno.writeTextFile(script, KILLABLE_WRITER);
  const baseDir = `${dir}/audit`;
  await Deno.mkdir(baseDir, { recursive: true });
  const journal = `${baseDir}/audit-killed-worker-2026-09-05.jsonl`;

  try {
    let previous = 0;
    // Three kills: the window between the journal write and its confirming
    // anchor write is small, so one round can easily miss it.
    for (let round = 0; round < 3; round++) {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-run",
          "--allow-sys=hostname",
          script,
          baseDir,
        ],
        stdout: "piped",
        // Inherited so a writer that gives up says why in the test output
        // instead of dying quietly behind a "already terminated" error.
        stderr: "piped",
      }).spawn();
      // Rendezvous, never sleep: the child announces itself once it is
      // fifty appends deep, so the kill lands on a working writer rather
      // than after a stopwatch.
      const reader = child.stdout.getReader();
      const announced = await reader.read();
      if (announced.done) {
        const why = new TextDecoder().decode(
          (await child.stderr.getReader().read()).value ?? new Uint8Array(),
        );
        assert(false, `writer exited early (round ${round}): ${why}`);
      }
      child.kill("SIGKILL");
      await reader.cancel();
      await child.status;

      // This is the criterion: the next run verifies clean, with no
      // operator signing anything.
      const swept = await verifyAllChains(baseDir);
      assert(swept.ok, "the sweep should read the directory");
      assertEquals(
        swept.value.broken.map((b) => b.reason),
        [],
        `a killed writer left a chain needing a signature (round ${round})`,
      );

      const entries = await loadEntries(journal);
      assert(entries.ok, "the journal should still load");
      assert(
        entries.value.length >= previous,
        "a recovery must never drop confirmed entries",
      );
      assert(entries.value.length > 0, "the child should have recorded work");
      previous = entries.value.length;

      const verified = await verifyChain(journal);
      assert(verified.ok);
      assert(verified.value.valid, `chain broke: ${verified.value.reason}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("audit recovery - a malformed intent record is a tamper signal", async () => {
  const { baseDir, path } = await seeded(2);
  try {
    const anchor = await readAnchorFile(path);
    await writeAnchorFile(path, {
      ...anchor,
      pending: { hash: "not-a-hash", startedAt: "" },
    } as unknown as ChainAnchor);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.recovered, []);
    assertEquals(swept.value.broken.length, 1);
    assertStringIncludes(
      swept.value.broken[0]?.reason ?? "",
      "unexpected shape",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - an unreadable anchor is an error, not a repair", async () => {
  const { baseDir, path } = await seeded(2);
  try {
    await Deno.writeTextFile(anchorPath(path), "{not json");

    const settled = await settleInterruptedAppend(path);
    assert(!settled.ok, "a corrupt anchor must not read as nothing to settle");
    if (settled.ok) return;
    assertStringIncludes(settled.error.message, "malformed JSON");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a journal out of torn sidecars refuses to discard", async () => {
  const { baseDir, path } = await seeded(2);
  try {
    // Every sidecar name taken: overwriting one would destroy bytes an
    // earlier repair set aside, so the repair refuses instead.
    for (let n = 1; n <= 100; n++) {
      await Deno.writeTextFile(`${path}.torn-${n}`, "earlier damage");
    }
    await crashMidAppend(path, FAKE_HASH, '{"torn":');

    const settled = await settleInterruptedAppend(path);
    assert(!settled.ok, "the repair must refuse rather than overwrite");
    if (settled.ok) return;
    assertStringIncludes(settled.error.message, "already exist beside it");
    // The journal is untouched, so the sweep keeps reporting it.
    assertEquals((await Deno.readTextFile(path)).endsWith('{"torn":'), true);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - the report names what was dropped and where", async () => {
  assertStringIncludes(
    formatAppendRecovery({
      path: "/audit/j.jsonl",
      kind: "completed",
      count: 7,
      droppedBytes: 0,
    }),
    "nothing was dropped",
  );
  const discarded = formatAppendRecovery({
    path: "/audit/j.jsonl",
    kind: "discarded",
    count: 7,
    droppedBytes: 12,
    preservedAs: "/audit/j.jsonl.torn-1",
    droppedText: '{"half":',
  });
  assertStringIncludes(discarded, "[SECURITY] [AUDIT_APPEND_RECOVERED]");
  assertStringIncludes(discarded, "12 torn byte(s)");
  assertStringIncludes(discarded, "/audit/j.jsonl.torn-1");
  assertStringIncludes(discarded, '{\\"half\\":');
});

Deno.test("audit recovery - a very long dropped line is quoted, not copied whole", async () => {
  const { baseDir, path } = await seeded(2);
  try {
    const long = `{"torn":"${"x".repeat(4000)}`;
    await crashMidAppend(path, FAKE_HASH, long);

    const settled = await settleInterruptedAppend(path);
    assert(settled.ok);
    const recovery = settled.value;
    assert(recovery?.droppedText);
    assert(
      recovery.droppedText.length < long.length,
      "the report should quote the dropped bytes, not copy them",
    );
    assertStringIncludes(recovery.droppedText, "bytes in total");
    // Every byte is still on disk, whatever the report quoted.
    assert(recovery.preservedAs);
    assertEquals(await Deno.readTextFile(recovery.preservedAs), long);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - an erased journal cannot be laundered by its anchor", async () => {
  const { baseDir, path } = await seeded(3);
  try {
    // The anchor is plain JSON anyone who can reach the audit directory
    // may rewrite, so "no entries, and one in flight" cannot be taken on
    // the anchor's word alone: that is also what an erasure looks like
    // once the attacker has tidied up after itself. The roster is the
    // independent witness — a journal that ever took an append is on it.
    await Deno.remove(path);
    const laundered = await writeAnchor(path, {
      count: 0,
      headHash: "",
      pending: { hash: FAKE_HASH, startedAt: "2026-09-05T00:49:12.000Z" },
    });
    assert(laundered.ok);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.broken.length, 1, "an erasure must stay red");
    assertStringIncludes(
      swept.value.broken[0]?.reason ?? "",
      "journal deleted",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a journal killed before its first line is not a deletion", async () => {
  // The other side of the same rule: a writer killed after declaring its
  // first append and before writing it leaves an anchor and no journal,
  // and never reached the roster. Nothing is missing, so nothing is red.
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir({ prefix: "audit-recovery-" });
  try {
    const path = auditFilePath({
      baseDir,
      workerId: "test-worker",
      date: "2026-09-05",
    });
    const declared = await writeAnchor(path, {
      count: 0,
      headHash: "",
      pending: { hash: FAKE_HASH, startedAt: "2026-09-05T00:49:12.000Z" },
    });
    assert(declared.ok);

    const swept = await verifyAllChains(baseDir);
    assert(swept.ok);
    assertEquals(swept.value.broken, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("audit recovery - a journal signed for by an operator is not healed by the next append", async () => {
  const { baseDir, path, opts } = await seeded(3);
  try {
    // The sweep refuses to heal a journal an operator has signed for,
    // because the signature is pinned to its exact bytes. That guarantee
    // is only worth something if the *write* path honours it too: healing
    // on the next ordinary mutation would lapse the signature and quietly
    // close a finding the operator had deliberately left open.
    //
    // The signature is written straight to the roster rather than through
    // `acknowledgeJournalDamage`, because that call records its own
    // chained entry and so drives the very append path under test.
    await crashMidAppend(path, FAKE_HASH, '{"timestamp":"2026-09-05T00:4');
    const bytesWhenSigned = await Deno.readTextFile(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    await Deno.writeTextFile(
      rosterPath(baseDir),
      `${
        JSON.stringify({
          journal: name,
          kind: "damage",
          digest: await sha256Hex(bytesWhenSigned),
          entries: 3,
          reason: "torn tail reviewed and accepted",
          by: "operator",
          acknowledgedAt: "2026-09-05T01:00:00.000Z",
        })
      }\n`,
      { append: true },
    );

    // An ordinary mutation must still be journalled — somewhere else.
    const next = await recordMutation({
      runId: "run-2",
      target: "after-signature",
      verb: "git-push",
      outcome: "success",
      caller: "recovery-test",
    }, opts);
    assert(next.ok, "journalling must continue after a signature");

    assertEquals(
      await Deno.readTextFile(path),
      bytesWhenSigned,
      "the signed-for bytes must be exactly as the operator left them",
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(`${baseDir}.roster.jsonl`).catch(() => {});
  }
});
