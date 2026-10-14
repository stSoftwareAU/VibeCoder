/**
 * The review-fleet-prs guidance ledger (Issue #3539, part of #3396): each
 * guidance issue the learning loop files is tracked against its target
 * pattern, matching findings are recorded as hits, and `due` reports the
 * guidance whose window has passed with the pattern still recurring.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  appendRecord,
  due,
  LEDGER_FILE,
  parseLedger,
  readLedger,
} from "../../../.claude/skills/review-fleet-prs/scripts/guidance.ts";

const DAY = 86_400_000;
const CLOSED_AT = "2026-09-01T00:00:00Z";
const closed = Date.parse(CLOSED_AT);
const at = (days: number) => new Date(closed + days * DAY).toISOString();

/** A `gh issue view` stub answering one state per issue number. */
function ghFor(
  states: Record<number, { state: string; stateReason?: string | null }>,
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const n = Number(args[2]);
    const s = states[n];
    if (!s) return Promise.reject(new Error(`gh: no issue ${n}`));
    return Promise.resolve(JSON.stringify({
      state: s.state,
      stateReason: s.stateReason ?? null,
      closedAt: s.state === "CLOSED" ? CLOSED_AT : null,
    }));
  };
  return { gh, calls };
}

const completed = { 10: { state: "CLOSED", stateReason: "COMPLETED" } };

const track = {
  kind: "track" as const,
  issue: 10,
  pattern: "untested-call-site",
  at: at(-5),
};
const hit = (pr: string, days: number) => ({
  kind: "hit" as const,
  pattern: "untested-call-site",
  pr,
  at: at(days),
});

Deno.test("track, hit and retire append records that readLedger reads back in order (Issue #3539)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await appendRecord(dir, track);
    await appendRecord(dir, hit("owner/repo#1", 3));
    await appendRecord(dir, { kind: "retire", issue: 10, by: 99, at: at(40) });
    const records = await readLedger(dir);
    assertEquals(records.map((r) => r.kind), ["track", "hit", "retire"]);
    assertEquals(
      (await Deno.readTextFile(`${dir}/${LEDGER_FILE}`)).trim().split("\n")
        .length,
      3,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLedger on a machine with no ledger yet is empty, not an error (Issue #3539)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readLedger(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("due: day 29 after the close is held, day 31 is recurring (Issue #3539)", async () => {
  const records = [track, hit("owner/a#1", 2), hit("owner/b#2", 5)];
  const { gh } = ghFor(completed);
  const day29 = await due(records, gh, new Date(closed + 29 * DAY));
  const day31 = await due(records, gh, new Date(closed + 31 * DAY));
  assertEquals(day29.map((e) => e.status), ["held"]);
  assertEquals(day31.map((e) => e.status), ["recurring"]);
});

Deno.test("due: hits on one PR count once; two independent PRs make it recurring (Issue #3539)", async () => {
  const now = new Date(closed + 31 * DAY);
  const { gh } = ghFor(completed);
  const onePr = await due(
    [track, hit("owner/a#1", 2), hit("owner/a#1", 6), hit("owner/a#1", 9)],
    gh,
    now,
  );
  assertEquals(onePr[0]!.status, "held");
  assertEquals(onePr[0]!.independentPrs, 1);
  const twoPrs = await due(
    [track, hit("owner/a#1", 2), hit("owner/b#7", 6)],
    gh,
    now,
  );
  assertEquals(twoPrs[0]!.status, "recurring");
  assertEquals(twoPrs[0]!.independentPrs, 2);
});

Deno.test("due: hits before the guidance closed are not counted (Issue #3539)", async () => {
  const { gh } = ghFor(completed);
  const entries = await due(
    [track, hit("owner/a#1", -3), hit("owner/b#2", -1), hit("owner/c#3", 4)],
    gh,
    new Date(closed + 31 * DAY),
  );
  assertEquals(entries[0]!.independentPrs, 1);
  assertEquals(entries[0]!.status, "held");
});

Deno.test("due: an open guidance issue is pending; one closed as not planned is dropped (Issue #3539)", async () => {
  const now = new Date(closed + 31 * DAY);
  const records = [
    track,
    { ...track, issue: 11 },
    hit("owner/a#1", 2),
    hit("owner/b#2", 5),
  ];
  const { gh } = ghFor({
    10: { state: "OPEN" },
    11: { state: "CLOSED", stateReason: "NOT_PLANNED" },
  });
  const entries = await due(records, gh, now);
  assertEquals(
    entries.map((e) => [e.issue, e.status]),
    [[10, "pending"], [11, "dropped"]],
  );
});

Deno.test("due: a retired entry is not reported again (Issue #3539)", async () => {
  const { gh, calls } = ghFor(completed);
  const entries = await due(
    [
      track,
      hit("owner/a#1", 2),
      hit("owner/b#2", 5),
      { kind: "retire", issue: 10, by: 99, at: at(32) },
    ],
    gh,
    new Date(closed + 40 * DAY),
  );
  assertEquals(entries, []);
  assertEquals(calls.length, 0, "a retired issue's state is not even read");
});

Deno.test("due: a gh failure rejects with the reason, never 'no recurrence' (Issue #3539)", async () => {
  const { gh } = ghFor({});
  await assertRejects(
    () => due([track], gh, new Date(closed + 31 * DAY)),
    Error,
    "#10",
  );
});

Deno.test("parseLedger: a malformed line throws naming its line number (Issue #3539)", () => {
  const good = JSON.stringify(track);
  for (
    const bad of [
      "not json",
      JSON.stringify({ kind: "track", issue: "10", pattern: "x", at: at(0) }),
      JSON.stringify({ kind: "hit", pattern: "x", pr: "not-a-pr", at: at(0) }),
      JSON.stringify({
        kind: "track",
        issue: 10,
        pattern: "Bad Slug",
        at: at(0),
      }),
      JSON.stringify({ kind: "mystery", at: at(0) }),
    ]
  ) {
    assertThrows(
      () => parseLedger(`${good}\n${bad}\n`),
      Error,
      `${LEDGER_FILE} line 2`,
    );
  }
  assertEquals(parseLedger(`${good}\n\n`).length, 1, "blank lines are fine");
});
