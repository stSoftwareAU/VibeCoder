/**
 * Release-age verification for the `bump-deps.sh` path (Issue #3659).
 *
 * The quarantine window was advisory: `runBumpDeps` exported
 * `VIBE_BUMP_QUARANTINE_HOURS` into a **repo-supplied** `bump-deps.sh`
 * and never checked that the script honoured it. A managed repository's
 * own script therefore decided whether to respect the worker's
 * supply-chain policy, which inverts the trust relationship.
 *
 * This module verifies the versions a bump actually produced: it reads
 * the added lines of the bump diff, resolves each new external
 * `name@version` publish time from its registry, and blocks the bump
 * when one was published inside the window.
 *
 * Two deliberate boundaries:
 *
 *  - **Internal `@stsoftware/*` packages bypass the window** (0h), the
 *    same internal/external split as Issue #1613.
 *  - **An unverifiable age does not block** (fail-open), matching
 *    `npm_package_age.ts`: an offline or rate-limited host must not turn
 *    every bump into a rejection. Indeterminate verdicts are reported so
 *    the gap is visible rather than silent (Issue #3234).
 *
 * A third boundary was added by Issue #3951: an **unrecognised**
 * dependency change fails **closed**. A line the scanner cannot pin to a
 * single release — an open-ended range, a tag, a foreign ecosystem's
 * manifest — is not the same as a release whose publish time a flaky
 * registry would not serve. The first means the embargo never looked at
 * the code; the second means it looked and could not see. Only the
 * second fails open. An unreadable diff is likewise `ok: false`: before
 * #3951 it returned an empty audit, which the caller read as compliance.
 *
 * Pure and fully injectable so it unit-tests with no network access.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  discardBody,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import { fetchNpmTimeData } from "./npm_package_age.ts";
import { scanBumpDiff } from "./bump_diff_scan.ts";
import type {
  BumpedSpecifier,
  UnverifiableBumpLine,
} from "./bump_diff_scan.ts";

export type {
  BumpDiffScan,
  BumpedSpecifier,
  BumpRegistry,
  UnverifiableBumpLine,
} from "./bump_diff_scan.ts";
export { parseBumpedSpecifiers, scanBumpDiff } from "./bump_diff_scan.ts";

/** Age verdict for a single specifier. */
export interface BumpAgeVerdict {
  specifier: BumpedSpecifier;
  /** True when the version has aged past the quarantine window. */
  eligible: boolean;
  /** True when the publish time could not be determined. */
  indeterminate: boolean;
  /** Age in hours since publication, or `null` when indeterminate. */
  ageHours: number | null;
  /** ISO publish timestamp, or `null` when indeterminate. */
  publishedAt: string | null;
  /** Human-readable explanation suitable for a log line or PR comment. */
  reason: string;
}

/** Aggregate outcome for one bump. */
export interface BumpAgeAuditResult {
  /** All verdicts, in input order (internal packages excluded). */
  verdicts: BumpAgeVerdict[];
  /** Verdicts that are definitively too new. */
  blocked: BumpAgeVerdict[];
  /** Verdicts whose age could not be verified. */
  indeterminate: BumpAgeVerdict[];
  /**
   * Dependency-shaped changes the scanner could not pin to a release
   * (Issue #3951). Non-empty means the bump is refused: the embargo
   * never got to look at these, so they must not pass by silence.
   */
  unverifiable: UnverifiableBumpLine[];
  /**
   * True only when nothing is definitively too new **and** nothing is
   * unverifiable.
   */
  ok: boolean;
  /** Rejection reason when `ok` is false; empty string otherwise. */
  reason: string;
}

/** An audit that examined nothing and blocks nothing. */
export function emptyBumpAgeAudit(): BumpAgeAuditResult {
  return {
    verdicts: [],
    blocked: [],
    indeterminate: [],
    unverifiable: [],
    ok: true,
    reason: "",
  };
}

/**
 * An audit that could not run at all — the bump diff was unreadable
 * (Issue #3951).
 *
 * This fails **closed**. A bump the worker cannot inspect is a bump
 * whose quarantine it cannot vouch for, and reporting that as `ok: true`
 * is exactly the silent pass #3234 forbids.
 */
export function unreadableBumpAgeAudit(detail: string): BumpAgeAuditResult {
  const reason = `The bump diff could not be read, so the release-age ` +
    `quarantine could not be verified for any of the versions the bump ` +
    `introduced: ${detail}`;
  return {
    verdicts: [],
    blocked: [],
    indeterminate: [],
    unverifiable: [{ file: "", line: "", reason }],
    ok: false,
    reason,
  };
}

/** Injectable side-effects for {@link auditBumpedSpecifiers}. */
export interface BumpAgeDeps {
  /**
   * Return the ISO publish timestamp for a specifier, or `undefined`
   * when it cannot be determined. May reject — callers treat a thrown
   * error as indeterminate.
   */
  fetchPublishTime: (spec: BumpedSpecifier) => Promise<string | undefined>;
  /** Current wall-clock time. */
  now: () => Date;
}

/** Scope of internal packages, which are exempt from the window (#1613). */
const INTERNAL_SCOPE = "@stsoftware/";

/** True when a package is an internal `stSoftwareAU` one. */
export function isInternalPackage(name: string): boolean {
  return name.startsWith(INTERNAL_SCOPE);
}

/** Format a specifier as `name@version` for messages. */
function label(spec: BumpedSpecifier): string {
  return `${spec.name}@${spec.version}`;
}

/** Human-readable registry name for messages. */
function registryLabel(registry: BumpedSpecifier["registry"]): string {
  return registry === "unknown" ? "npm or JSR" : registry;
}

/**
 * Pure age evaluator: decide whether a specifier clears the window.
 *
 * `publishedAt` of `undefined` (unknown) or an unparseable timestamp
 * yields an indeterminate verdict rather than a block.
 */
export function evaluateSpecifierAge(
  spec: BumpedSpecifier,
  publishedAt: string | undefined,
  quarantineHours: number,
  now: Date,
): BumpAgeVerdict {
  const floor = Number.isFinite(quarantineHours) && quarantineHours > 0
    ? quarantineHours
    : 0;

  const publishedMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (Number.isNaN(publishedMs)) {
    return {
      specifier: spec,
      eligible: false,
      indeterminate: true,
      ageHours: null,
      publishedAt: publishedAt ?? null,
      reason: `Could not resolve a ${registryLabel(spec.registry)} publish ` +
        `time for ${label(spec)}; the ${floor}h quarantine could not be ` +
        `verified.`,
    };
  }

  const ageHours = (now.getTime() - publishedMs) / 3_600_000;
  const eligible = ageHours >= floor;
  const ageText = `${ageHours.toFixed(1)}h old`;
  return {
    specifier: spec,
    eligible,
    indeterminate: false,
    ageHours,
    publishedAt: publishedAt ?? null,
    reason: eligible
      ? `${label(spec)} is ${ageText} (>= ${floor}h quarantine).`
      : `${label(spec)} is only ${ageText} (< ${floor}h quarantine).`,
  };
}

/**
 * Verify every specifier a bump introduced against the window.
 *
 * Internal `@stsoftware/*` packages are skipped outright (no lookup).
 * `ok` is false only when a specifier is definitively too new.
 */
export async function auditBumpedSpecifiers(
  specifiers: readonly BumpedSpecifier[],
  quarantineHours: number,
  deps: BumpAgeDeps,
): Promise<BumpAgeAuditResult> {
  const verdicts: BumpAgeVerdict[] = [];
  for (const spec of specifiers) {
    if (isInternalPackage(spec.name)) continue;
    let publishedAt: string | undefined;
    try {
      publishedAt = await deps.fetchPublishTime(spec);
    } catch {
      publishedAt = undefined;
    }
    verdicts.push(
      evaluateSpecifierAge(spec, publishedAt, quarantineHours, deps.now()),
    );
  }

  const blocked = verdicts.filter((v) => !v.eligible && !v.indeterminate);
  const indeterminate = verdicts.filter((v) => v.indeterminate);
  return {
    verdicts,
    blocked,
    indeterminate,
    unverifiable: [],
    ok: blocked.length === 0,
    reason: buildAuditReason(blocked, [], quarantineHours),
  };
}

/** Compose the rejection reason from both failure modes. */
function buildAuditReason(
  blocked: readonly BumpAgeVerdict[],
  unverifiable: readonly UnverifiableBumpLine[],
  quarantineHours: number,
): string {
  const parts: string[] = [];
  if (blocked.length > 0) {
    parts.push(
      `The bump introduced ${blocked.length} dependency ` +
        `version(s) published inside the ${quarantineHours}h quarantine ` +
        `window, so \`bump-deps.sh\` did not honour ` +
        `\`VIBE_BUMP_QUARANTINE_HOURS\`: ${
          blocked.map((v) => v.reason).join(" ")
        }`,
    );
  }
  if (unverifiable.length > 0) {
    parts.push(
      `The bump introduced ${unverifiable.length} dependency change(s) the ` +
        `${quarantineHours}h release-age quarantine cannot verify, so the ` +
        `bump is refused rather than passed unchecked: ${
          unverifiable.map((u) => u.reason).join(" ")
        }`,
    );
  }
  return parts.join(" ");
}

/**
 * Audit a whole bump diff: scan it, verify the ages it can, and refuse
 * the dependency changes it cannot (Issue #3951).
 *
 * This is the entry point callers making a pass/fail decision must use.
 * `auditBumpedSpecifiers` alone sees only the verifiable half of a diff,
 * so a diff whose every dependency line is unrecognised would audit
 * clean — the silent pass this issue closed.
 */
export async function auditBumpDiff(
  diff: string,
  quarantineHours: number,
  deps: BumpAgeDeps,
): Promise<BumpAgeAuditResult> {
  const scan = scanBumpDiff(diff);
  const aged = await auditBumpedSpecifiers(
    scan.specifiers,
    quarantineHours,
    deps,
  );
  return {
    ...aged,
    unverifiable: scan.unverifiable,
    ok: aged.blocked.length === 0 && scan.unverifiable.length === 0,
    reason: buildAuditReason(
      aged.blocked,
      scan.unverifiable,
      quarantineHours,
    ),
  };
}

/** Publish time from the JSR API, or `undefined`. Never throws. */
async function fetchJsrPublishTime(
  name: string,
  version: string,
): Promise<string | undefined> {
  const match = /^@([^/]+)\/(.+)$/.exec(name);
  if (!match) return undefined;
  try {
    // Issue #3710: bounded in time and in memory so a hung or hostile JSR
    // cannot wedge the worker.
    const resp = await fetch(
      `https://api.jsr.io/scopes/${encodeURIComponent(match[1]!)}/packages/${
        encodeURIComponent(match[2]!)
      }/versions/${encodeURIComponent(version)}`,
      withRequestTimeout({ method: "GET" }, DEFAULT_FETCH_TIMEOUT_MS),
    );
    if (!resp.ok) {
      await discardBody(resp);
      return undefined;
    }
    const bodyResult = await readTextBounded(resp);
    if (!bodyResult.ok) return undefined;
    const body = JSON.parse(bodyResult.value);
    const created = (body as { createdAt?: unknown })?.createdAt;
    return typeof created === "string" ? created : undefined;
  } catch {
    return undefined;
  }
}

/** Default production deps: real registry lookups + system clock. */
export function defaultBumpAgeDeps(): BumpAgeDeps {
  return {
    fetchPublishTime: async (spec) => {
      // A lockfile entry names a package and version but not always the
      // registry (Issue #3951): try JSR first for scoped names, then npm.
      const tryJsr = spec.registry === "jsr" ||
        (spec.registry === "unknown" && spec.name.startsWith("@"));
      if (tryJsr) {
        const jsr = await fetchJsrPublishTime(spec.name, spec.version);
        if (jsr || spec.registry === "jsr") return jsr;
      }
      const times = await fetchNpmTimeData(spec.name);
      return times?.[spec.version];
    },
    now: () => new Date(),
  };
}
