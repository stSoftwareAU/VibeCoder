/**
 * Per-alert dedup fingerprints for the alert-feed idle task
 * (Issue #3395, part of #3386 / #3394).
 *
 * The alert-feed template (#3394) must file **at most one open issue per
 * alert** and never re-file on a re-run, matching the label-based dedup the
 * other idle-task templates use. This module supplies the two building blocks
 * that guarantee it:
 *
 *   1. A **stable per-alert fingerprint** — a repo-scoped, colon-separated
 *      identity (e.g. `dependabot:owner/repo:GHSA-xxxx-xxxx-xxxx`,
 *      `code-scanning:owner/repo:<rule-id>:<alert-number>`) computed purely
 *      from the alert's own durable fields. It contains **no** timestamps,
 *      ordering, or run-scoped data, so it is byte-identical across runs.
 *   2. A **known-open list** read from the repo's existing open
 *      finding-labelled issues (the `idle_task_snapshot.ts` /
 *      `listKnownOpenFindingIds` convention, adapted for the colon-bearing
 *      fingerprint), plus a {@link selectNewAlerts} filter that skips any
 *      alert whose fingerprint is already open.
 *
 * The fingerprint is embedded in each filed issue body as a hidden
 * machine-readable marker ({@link alertFingerprintMarker}); the next run reads
 * every open issue's markers back ({@link listKnownOpenAlertFingerprints}) and
 * drops alerts that already have an open issue. Re-running the scan with the
 * same open alerts therefore proposes zero new issues.
 *
 * The `gh` runner is dependency-injected so tests never hit the network,
 * matching the DI convention across `idle_task_templates/` and
 * `idle_task_snapshot.ts`.
 *
 * Australian English throughout (behaviour, normalise, authorised).
 */

import { parseGhJsonArray } from "../idle_task_snapshot.ts";

/** The subset of a Dependabot alert a fingerprint depends on. */
export interface DependabotFingerprintInput {
  /** Repo-scoped alert number (stable identifier within the repo). */
  number: number;
  /** GitHub Security Advisory id, e.g. `GHSA-xxxx-xxxx-xxxx` (may be ""). */
  ghsaId: string;
}

/**
 * Build the stable fingerprint for a Dependabot alert, scoped to `repo`.
 *
 * Prefers the GHSA advisory id (stable across re-runs and across the alert's
 * lifetime); falls back to the repo-scoped alert `number` (prefixed `n` to
 * keep the token unambiguous) only when the advisory id is absent. Never
 * incorporates run-scoped data, so the result is byte-identical every run.
 */
export function dependabotAlertFingerprint(
  repo: string,
  alert: DependabotFingerprintInput,
): string {
  const ghsa = (alert.ghsaId ?? "").trim();
  const key = ghsa !== "" ? ghsa : `n${alert.number}`;
  return `dependabot:${repo}:${key}`;
}

/**
 * Build the stable fingerprint for a code-scanning alert, scoped to `repo`.
 *
 * A code-scanning alert is uniquely identified within a repo by its rule id
 * plus its alert number, so the fingerprint carries both. Kept as a
 * primitive-argument builder (rather than taking a code-scanning alert type)
 * so it does not couple this module to the not-yet-merged code-scanning
 * fetcher (#3393) — the caller passes the two fields directly.
 */
export function codeScanningAlertFingerprint(
  repo: string,
  ruleId: string,
  alertNumber: number,
): string {
  return `code-scanning:${repo}:${ruleId}:${alertNumber}`;
}

/**
 * Render the hidden machine-readable body marker carrying `fingerprint`.
 *
 * Mirrors the `<!-- finding-id: … -->` convention but uses a distinct
 * `alert-fingerprint` key because the fingerprint contains colons and slashes
 * that the finding-id grammar (`[A-Za-z0-9-]+`) does not admit.
 */
export function alertFingerprintMarker(fingerprint: string): string {
  return `<!-- alert-fingerprint: ${fingerprint} -->`;
}

// Hardcoded regex — no dynamic RegExp, no ReDoS risk. The token is any run of
// non-whitespace, non-`>` characters, which admits the colons and slashes in
// a fingerprint while stopping before the trailing `-->`.
const ALERT_FINGERPRINT_RE = /<!--\s*alert-fingerprint:\s*([^\s>]+)\s*-->/gi;

/**
 * Extract every alert fingerprint embedded in an issue body via
 * {@link alertFingerprintMarker}. Returns `[]` when none are present.
 */
export function extractAlertFingerprints(body: string): string[] {
  const out: string[] = [];
  if (typeof body !== "string") return out;
  for (const match of body.matchAll(ALERT_FINGERPRINT_RE)) {
    const token = match[1];
    if (token) out.push(token);
  }
  return out;
}

/**
 * Return the set of alert fingerprints already carried by open issues in
 * `repo` labelled `label` — the known-open list the next run dedups against.
 *
 * A gh failure or malformed payload returns an empty set so a transient lookup
 * hiccup never crashes the run — the worst case is the run re-proposes a
 * finding, which the template's snapshot diff still catches (mirrors
 * `listKnownOpenFindingIds`).
 */
export async function listKnownOpenAlertFingerprints(
  repo: string,
  label: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      label,
      "--json",
      "number,body",
      "--limit",
      "200",
    ]);
  } catch {
    return out;
  }
  for (
    const item of parseGhJsonArray(raw, `list ${label} alert fingerprints`)
  ) {
    if (item === null || typeof item !== "object") continue;
    const body = (item as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    for (const fingerprint of extractAlertFingerprints(body)) {
      out.add(fingerprint);
    }
  }
  return out;
}

/** One alert paired with its computed fingerprint. */
export interface FingerprintedAlert<T> {
  /** The original alert. */
  alert: T;
  /** The stable fingerprint computed for it. */
  fingerprint: string;
}

/** The partition {@link selectNewAlerts} returns. */
export interface AlertSelection<T> {
  /** Alerts with no open issue yet — one issue should be filed per entry. */
  toFile: FingerprintedAlert<T>[];
  /** Alerts skipped because their fingerprint is already open (or a
   * duplicate earlier in the same batch). */
  skipped: FingerprintedAlert<T>[];
}

/**
 * Partition `alerts` into the ones to file and the ones to skip.
 *
 * An alert is skipped when its fingerprint is already in `knownOpen` (a
 * previous run already filed an open issue for it) **or** when an earlier
 * alert in this same batch produced the same fingerprint (defence in depth
 * against a fetcher returning the same advisory twice). The result therefore
 * contains at most one entry per distinct fingerprint in `toFile`, so a
 * re-run over the same open alerts proposes zero new issues.
 *
 * `fingerprintOf` computes the stable fingerprint for each alert (typically a
 * closure over {@link dependabotAlertFingerprint} /
 * {@link codeScanningAlertFingerprint} bound to the repo). Pure — no side
 * effects, no network.
 */
export function selectNewAlerts<T>(
  alerts: readonly T[],
  fingerprintOf: (alert: T) => string,
  knownOpen: ReadonlySet<string>,
): AlertSelection<T> {
  const toFile: FingerprintedAlert<T>[] = [];
  const skipped: FingerprintedAlert<T>[] = [];
  const seenThisBatch = new Set<string>();
  for (const alert of alerts) {
    const fingerprint = fingerprintOf(alert);
    if (knownOpen.has(fingerprint) || seenThisBatch.has(fingerprint)) {
      skipped.push({ alert, fingerprint });
      continue;
    }
    seenThisBatch.add(fingerprint);
    toFile.push({ alert, fingerprint });
  }
  return { toFile, skipped };
}
