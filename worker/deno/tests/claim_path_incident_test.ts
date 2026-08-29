/**
 * Every recorded incident, replayed in CI (Issue #524).
 *
 * Each incident behind "the worker isn't picking up work" was found on live
 * fleet state that then evaporated — #319, #375, #429, #437 and #499 alike.
 * `tests/fixtures/claim_path_incidents/` keeps those states, and this test
 * replays every one of them through both instruments: the idle-decision census
 * and the real claim scan. A state that once produced a census-vs-scan
 * disagreement now fails the build if it ever produces one again.
 *
 * Adding an incident is adding a file — see the directory's README. The corpus
 * grows more valuable with every gate added, instead of less.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type RepoState,
  runCensus,
  runClaimScan,
} from "./fixtures/claim_path_state.ts";

/** The on-disk shape of a recorded incident. */
interface RecordedIncident {
  /** Repo and date, e.g. "stSoftwareAU/NEAT-AI-Rebase 2026-08-28". */
  incident: string;
  /** The issue that diagnosed it. */
  issue: string;
  /** The `[idle-census]` line the fleet actually logged. */
  observed: string;
  /** What was abridged when recording, and why it is not material. */
  note?: string;
  /** The repository state, in the shared description shape. */
  state: RepoState;
  /** What the fleet should have done with that state. */
  expect: { claimable: number[]; scanClaims: boolean };
}

const INCIDENT_DIR = new URL(
  "./fixtures/claim_path_incidents/",
  import.meta.url,
);

async function loadIncidents(): Promise<RecordedIncident[]> {
  const incidents: RecordedIncident[] = [];
  for await (const entry of Deno.readDir(INCIDENT_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const raw = await Deno.readTextFile(new URL(entry.name, INCIDENT_DIR));
    incidents.push(JSON.parse(raw) as RecordedIncident);
  }
  return incidents.sort((a, b) => a.incident.localeCompare(b.incident));
}

const INCIDENTS = await loadIncidents();

Deno.test("claim path incidents - the corpus is not empty", () => {
  // A corpus that quietly emptied itself would make every test below vacuous.
  assertEquals(INCIDENTS.length > 0, true);
});

for (const incident of INCIDENTS) {
  Deno.test(
    `claim path incident - ${incident.incident} (${incident.issue})`,
    async () => {
      const entry = runCensus(incident.state);
      assertEquals(
        entry.claimableIssues,
        incident.expect.claimable,
        `census disagrees with the recorded outcome — observed at the time: ` +
          `${incident.observed}`,
      );

      const outcome = await runClaimScan(incident.state);
      assertEquals(
        outcome.claimed,
        incident.expect.scanClaims,
        `claim scan disagrees with the recorded outcome — observed at the ` +
          `time: ${incident.observed}`,
      );

      // The differential itself: whatever the recorded expectation says, the
      // two instruments must not contradict each other. This is the check the
      // fleet only runs once per cycle, three cycles before it speaks.
      assertEquals(
        outcome.claimed,
        entry.claimableIssues.length > 0,
        `census and scan disagree on ${incident.incident}: census claimable ` +
          `[${entry.claimableIssues}] vs scan claimed ${outcome.claimedIssue}`,
      );
      if (outcome.claimedIssue !== null) {
        assertEquals(
          entry.claimableIssues.includes(outcome.claimedIssue),
          true,
        );
      }
    },
  );
}
