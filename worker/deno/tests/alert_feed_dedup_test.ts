/**
 * Tests for alert_fingerprint.ts — per-alert dedup for the alert-feed idle
 * task (Issue #3395, part of #3386 / #3394).
 *
 * Every test exercises the real functions against injected snapshot data — no
 * filesystem, no network. The load-bearing behaviours are pinned:
 *
 *   - a fingerprint for a given alert is byte-identical across runs (no
 *     timestamps, ordering, or run-scoped data in it),
 *   - the same injected alert snapshot across two runs proposes zero new
 *     issues on the second run (dedup against the known-open list),
 *   - one genuinely new alert proposes exactly one new issue,
 *   - the known-open list is parsed from the repo's open finding-labelled
 *     issue bodies (the `idle_task_snapshot.ts` convention, adapted for the
 *     colon-bearing alert fingerprint).
 */

import { assert, assertEquals } from "@std/assert";
import type { DependabotAlert } from "../lib/alert_feeds/dependabot_alerts.ts";
import {
  alertFingerprintMarker,
  codeScanningAlertFingerprint,
  dependabotAlertFingerprint,
  extractAlertFingerprints,
  listKnownOpenAlertFingerprints,
  selectNewAlerts,
} from "../lib/alert_feeds/alert_fingerprint.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dependabotAlert(
  number: number,
  ghsaId: string,
  pkg = "lodash",
): DependabotAlert {
  return {
    number,
    ghsaId,
    packageName: pkg,
    ecosystem: "npm",
    severity: "high",
    summary: `Advisory for ${pkg}`,
    htmlUrl: `https://github.com/o/r/security/dependabot/${number}`,
  };
}

// ---------------------------------------------------------------------------
// dependabotAlertFingerprint
// ---------------------------------------------------------------------------

Deno.test("dependabotAlertFingerprint - repo-scoped, GHSA-based, stable", () => {
  const alert = dependabotAlert(7, "GHSA-1111-2222-3333");
  const fp = dependabotAlertFingerprint("o/r", alert);
  assertEquals(fp, "dependabot:o/r:GHSA-1111-2222-3333");
});

Deno.test("dependabotAlertFingerprint - byte-identical across repeated calls", () => {
  const alert = dependabotAlert(7, "GHSA-1111-2222-3333");
  const first = dependabotAlertFingerprint("o/r", alert);
  const second = dependabotAlertFingerprint("o/r", alert);
  assertEquals(first, second);
});

Deno.test("dependabotAlertFingerprint - falls back to alert number when GHSA absent", () => {
  const alert = dependabotAlert(42, "");
  assertEquals(dependabotAlertFingerprint("o/r", alert), "dependabot:o/r:n42");
});

Deno.test("dependabotAlertFingerprint - distinct alerts yield distinct fingerprints", () => {
  const a = dependabotAlertFingerprint("o/r", dependabotAlert(1, "GHSA-aaaa"));
  const b = dependabotAlertFingerprint("o/r", dependabotAlert(2, "GHSA-bbbb"));
  assert(a !== b);
});

// ---------------------------------------------------------------------------
// codeScanningAlertFingerprint
// ---------------------------------------------------------------------------

Deno.test("codeScanningAlertFingerprint - rule-id + alert-number, repo-scoped", () => {
  const fp = codeScanningAlertFingerprint("o/r", "js/xss", 12);
  assertEquals(fp, "code-scanning:o/r:js/xss:12");
});

Deno.test("codeScanningAlertFingerprint - stable across calls", () => {
  const a = codeScanningAlertFingerprint("o/r", "js/sql-injection", 5);
  const b = codeScanningAlertFingerprint("o/r", "js/sql-injection", 5);
  assertEquals(a, b);
});

// ---------------------------------------------------------------------------
// marker round-trip
// ---------------------------------------------------------------------------

Deno.test("alertFingerprintMarker + extractAlertFingerprints - round-trip", () => {
  const fp = dependabotAlertFingerprint("o/r", dependabotAlert(7, "GHSA-x"));
  const body = `Some finding text.\n\n${alertFingerprintMarker(fp)}\n`;
  assertEquals(extractAlertFingerprints(body), [fp]);
});

Deno.test("extractAlertFingerprints - handles colons and slashes in the token", () => {
  const fp = codeScanningAlertFingerprint("o/r", "js/xss", 12);
  assertEquals(extractAlertFingerprints(alertFingerprintMarker(fp)), [fp]);
});

Deno.test("extractAlertFingerprints - no marker returns empty", () => {
  assertEquals(extractAlertFingerprints("no marker here"), []);
});

Deno.test("extractAlertFingerprints - multiple markers in one body", () => {
  const a = dependabotAlertFingerprint("o/r", dependabotAlert(1, "GHSA-a"));
  const b = dependabotAlertFingerprint("o/r", dependabotAlert(2, "GHSA-b"));
  const body = `${alertFingerprintMarker(a)}\n${alertFingerprintMarker(b)}`;
  assertEquals(extractAlertFingerprints(body).sort(), [a, b].sort());
});

// ---------------------------------------------------------------------------
// listKnownOpenAlertFingerprints (injected gh runner — no network)
// ---------------------------------------------------------------------------

Deno.test("listKnownOpenAlertFingerprints - parses fingerprints from open issue bodies", async () => {
  const a = dependabotAlertFingerprint("o/r", dependabotAlert(1, "GHSA-a"));
  const b = codeScanningAlertFingerprint("o/r", "js/xss", 3);
  const gh = (_args: string[]) =>
    Promise.resolve(JSON.stringify([
      { number: 10, body: `finding one\n${alertFingerprintMarker(a)}` },
      { number: 11, body: `finding two\n${alertFingerprintMarker(b)}` },
    ]));
  const set = await listKnownOpenAlertFingerprints("o/r", "alert-feed", gh);
  assertEquals(set, new Set([a, b]));
});

Deno.test("listKnownOpenAlertFingerprints - gh failure returns empty set (never throws)", async () => {
  const gh = (_args: string[]) => Promise.reject(new Error("gh boom"));
  const set = await listKnownOpenAlertFingerprints("o/r", "alert-feed", gh);
  assertEquals(set, new Set<string>());
});

Deno.test("listKnownOpenAlertFingerprints - passes the label through to gh", async () => {
  let captured: string[] = [];
  const gh = (args: string[]) => {
    captured = args;
    return Promise.resolve("[]");
  };
  await listKnownOpenAlertFingerprints("o/r", "alert-feed", gh);
  assert(captured.includes("alert-feed"));
  assert(captured.includes("o/r"));
});

// ---------------------------------------------------------------------------
// selectNewAlerts — the core dedup contract
// ---------------------------------------------------------------------------

Deno.test("selectNewAlerts - empty known-open proposes every alert once", () => {
  const alerts = [
    dependabotAlert(1, "GHSA-a"),
    dependabotAlert(2, "GHSA-b"),
  ];
  const result = selectNewAlerts(
    alerts,
    (a) => dependabotAlertFingerprint("o/r", a),
    new Set<string>(),
  );
  assertEquals(result.toFile.length, 2);
  assertEquals(result.skipped.length, 0);
});

Deno.test("selectNewAlerts - alert already in known-open is skipped", () => {
  const alert = dependabotAlert(1, "GHSA-a");
  const fp = dependabotAlertFingerprint("o/r", alert);
  const result = selectNewAlerts(
    [alert],
    (a) => dependabotAlertFingerprint("o/r", a),
    new Set([fp]),
  );
  assertEquals(result.toFile.length, 0);
  assertEquals(result.skipped.length, 1);
  assertEquals(result.skipped[0]?.fingerprint, fp);
});

Deno.test("selectNewAlerts - de-dups within the batch (defence in depth)", () => {
  // Two alerts collapsing to the same fingerprint (same GHSA) → filed once.
  const alerts = [
    dependabotAlert(1, "GHSA-dup"),
    dependabotAlert(2, "GHSA-dup"),
  ];
  const result = selectNewAlerts(
    alerts,
    (a) => dependabotAlertFingerprint("o/r", a),
    new Set<string>(),
  );
  assertEquals(result.toFile.length, 1);
  assertEquals(result.skipped.length, 1);
});

// ---------------------------------------------------------------------------
// End-to-end acceptance: two runs, same alerts → zero on the second run
// ---------------------------------------------------------------------------

/**
 * Simulate one alert-feed run: given the fetched alerts and the current
 * known-open snapshot, return the fingerprints that would be newly filed and
 * the snapshot that would exist afterwards (previous known-open plus the
 * freshly-filed fingerprints).
 */
function simulateRun(
  repo: string,
  alerts: DependabotAlert[],
  knownOpen: Set<string>,
): { filed: string[]; nextKnownOpen: Set<string> } {
  const result = selectNewAlerts(
    alerts,
    (a) => dependabotAlertFingerprint(repo, a),
    knownOpen,
  );
  const filed = result.toFile.map((t) => t.fingerprint);
  const nextKnownOpen = new Set(knownOpen);
  for (const fp of filed) nextKnownOpen.add(fp);
  return { filed, nextKnownOpen };
}

Deno.test("acceptance - same alert set across two runs: second run files nothing", () => {
  const repo = "o/r";
  const alerts = [
    dependabotAlert(1, "GHSA-a"),
    dependabotAlert(2, "GHSA-b"),
  ];

  const run1 = simulateRun(repo, alerts, new Set<string>());
  assertEquals(run1.filed.length, 2);

  // Second run sees the same alerts but the first run's issues are now open.
  const run2 = simulateRun(repo, alerts, run1.nextKnownOpen);
  assertEquals(run2.filed.length, 0);
});

Deno.test("acceptance - a genuinely new alert produces exactly one new issue", () => {
  const repo = "o/r";
  const alerts = [
    dependabotAlert(1, "GHSA-a"),
    dependabotAlert(2, "GHSA-b"),
  ];

  const run1 = simulateRun(repo, alerts, new Set<string>());

  // A new high/critical alert appears alongside the two already-open ones.
  const withNew = [...alerts, dependabotAlert(3, "GHSA-c")];
  const run2 = simulateRun(repo, withNew, run1.nextKnownOpen);

  assertEquals(run2.filed.length, 1);
  assertEquals(
    run2.filed[0],
    dependabotAlertFingerprint(repo, dependabotAlert(3, "GHSA-c")),
  );
});

Deno.test("acceptance - fingerprint is byte-identical across runs (no run-scoped data)", () => {
  const repo = "o/r";
  const alert = dependabotAlert(9, "GHSA-stable");
  const first = dependabotAlertFingerprint(repo, alert);
  // A later "run" recomputes from a freshly-fetched (but equal) alert object.
  const refetched = dependabotAlert(9, "GHSA-stable");
  const second = dependabotAlertFingerprint(repo, refetched);
  assertEquals(first, second);
});
