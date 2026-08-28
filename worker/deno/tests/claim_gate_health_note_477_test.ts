/**
 * A host that is not claiming work must say so on the fleet board (Issue #477).
 *
 * The fleet-health payload has always carried *conditions* — `host-disk low:
 * …`, `work-volume fault: …` (Issues #226, #229). What it never carried is the
 * *consequence*, and the consequence is the only part an operator scanning a
 * board of hosts can act on. On GRQ-23 the distinction cost three days: the
 * host looked like a working machine with a disk note, not like a machine that
 * had stopped taking work, and the 43 claimable issues it was declining were
 * invisible from anywhere but the machine's own logs.
 *
 * These tests pin the wording contract, not an implementation: the note leads
 * with the consequence, names every gate responsible, and is absent entirely
 * when the host is claiming normally — a healthy host's payload must stay
 * byte-identical to the historical one.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CLAIM_SUPPRESSED_PREFIX,
  claimSuppressedNote,
} from "../lib/claim_gate_health_note.ts";

Deno.test("claimSuppressedNote - a claiming host adds nothing to the payload (Issue #477)", () => {
  assertEquals(
    claimSuppressedNote([]),
    null,
    "a healthy report must stay byte-identical to the historical invocation",
  );
});

Deno.test("claimSuppressedNote - leads with the consequence, not the condition (Issue #477)", () => {
  const note = claimSuppressedNote([
    {
      id: "host-disk-low",
      detail: "42.3 GB free (9.2%) of 460.4 GB, floor 46.0 GB",
    },
  ]);

  assert(note !== null, "an active gate must produce a note");
  assert(
    note.startsWith(CLAIM_SUPPRESSED_PREFIX),
    `the note must lead with the consequence so it cannot be read as ` +
      `informational; got: ${note}`,
  );
  assert(
    note.includes("host-disk-low"),
    `the note must name the gate so the operator knows what to fix; got: ${note}`,
  );
  assert(
    note.includes("floor 46.0 GB"),
    `the gate's detail must survive into the note; got: ${note}`,
  );
});

Deno.test("claimSuppressedNote - names every gate holding the host back (Issue #477)", () => {
  const note = claimSuppressedNote([
    { id: "host-disk-low", detail: "below the floor" },
    { id: "work-volume-fault", detail: "ext4 errors recorded" },
  ]);

  assert(note !== null);
  assert(note.includes("host-disk-low"), note);
  assert(
    note.includes("work-volume-fault"),
    `a second gate must not be dropped — fixing only the one that was ` +
      `reported leaves the host still stuck; got: ${note}`,
  );
});

Deno.test("claimSuppressedNote - a gate with no detail still reports the gate (Issue #477)", () => {
  const note = claimSuppressedNote([{ id: "host-disk-low", detail: "" }]);

  assert(note !== null, "a missing detail must not swallow the whole note");
  assert(note.startsWith(CLAIM_SUPPRESSED_PREFIX), note);
  assert(note.includes("host-disk-low"), note);
});

Deno.test("claimSuppressedNote - blank gate ids are ignored, not reported as anonymous gates (Issue #477)", () => {
  assertEquals(
    claimSuppressedNote([{ id: "   ", detail: "" }]),
    null,
    "an empty gate list dressed up as a blank entry must not raise a false alarm",
  );
});
