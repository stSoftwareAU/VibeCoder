/**
 * Native SHA-pin pre-filer for the github-actions-audit template
 * (Issue #2501, part of #2497).
 *
 * Deterministically flags every third-party `uses:` (action and cross-repo
 * reusable workflow) that is **not** pinned to a full 40-character commit
 * SHA. This is the native, deterministic counterpart to v7 prompt check #1
 * ("third-party actions pinned to a commit SHA") and #13 ("reusable
 * workflows pinned by commit SHA"). The v7 prompt checks are retained for
 * the judgement-heavy long tail (container `@sha256:` digests,
 * provenance-as-sole-gate); this scanner files the unambiguous cases so the
 * native and LLM paths agree.
 *
 * Carve-outs (mirroring v7 #1/#13):
 *   - SHA-pinned `uses:` (`/^[0-9a-f]{40}$/` ref) — already correct.
 *   - First-party `stSoftwareAU/*` actions — may pin to a tag.
 *   - Local `./…` references (same-repo composite actions and
 *     same-repo reusable-workflow calls) — exempt.
 *   - `docker://…` container images — left to the LLM (v7 #25).
 *
 * Cross-repo reusable-workflow calls
 * (`owner/repo/.github/workflows/x.yml@<ref>`) are in scope (v7 #13).
 *
 * Findings consolidate one per distinct unpinned action/workflow
 * coordinate, listing every call-site `file:line` (mirrors v7 #16 "one
 * finding per action per repo" — avoids issue floods). Stable id is
 * `BP-SHA-PIN-<owner>-<action-slug>`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** A full 40-character lower-case hex commit SHA. */
const SHA_PIN = /^[0-9a-f]{40}$/;

/** First-party org whose actions may pin to a tag (v7 #1 carve-out). */
const FIRST_PARTY_OWNER = "stsoftwareau";

/** Matches a `uses:` line and captures its raw value (incl. list dash). */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S.*)$/;

/** A single unpinned call-site for a consolidated coordinate. */
export interface ActionPinCallSite {
  /** Repo-relative file path, e.g. `.github/workflows/ci.yml`. */
  file: string;
  /** 1-based line number of the `uses:` reference. */
  line: number;
  /** The ref after `@`, e.g. `v4` or `main`. */
  ref: string;
}

/** A consolidated SHA-pin finding for one action/workflow coordinate. */
export interface ActionPinFinding {
  /** Stable id `BP-SHA-PIN-<owner>-<action-slug>`. */
  findingId: string;
  /** The `owner/...path` coordinate (the `uses:` value without `@ref`). */
  coordinate: string;
  /** Always `high` — an unpinned third-party action is a high-band risk. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** First call-site file (the consolidated lead). */
  file: string;
  /** First call-site line. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block listing every call-site. */
  evidence: string;
  /** Every call-site this finding consolidates. */
  callSites: ActionPinCallSite[];
}

/** Options for {@link scanActionPins}. */
export interface ScanActionPinsOptions {
  /** Stable ids suppressed by prior triage — skip these coordinates. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these coordinates. */
  knownOpenFindingIds?: Iterable<string>;
}

/** Slugify a path fragment into `[a-z0-9-]` for the stable id. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Result of classifying a single `uses:` value.
 *
 *   - `flag` — third-party, not SHA-pinned: file a finding.
 *   - `exempt` — SHA-pinned, first-party, local, or not an
 *     action/reusable-workflow pin (container, malformed): skip silently.
 */
interface ParsedUses {
  flag: boolean;
  coordinate: string;
  owner: string;
  ref: string;
}

/**
 * Parse and classify a raw `uses:` value (already stripped of quotes and
 * inline comments). Returns `null` when the value is exempt — SHA-pinned,
 * first-party, local, a container image, or otherwise not a flaggable
 * action/reusable-workflow pin.
 *
 * Pure — no I/O.
 */
export function classifyUses(value: string): ParsedUses | null {
  const trimmed = value.trim();
  // Local references (`./…`) are same-repo — exempt.
  if (trimmed.startsWith(".")) return null;
  // Container images are the LLM's job (v7 #25).
  if (trimmed.startsWith("docker://")) return null;

  const at = trimmed.indexOf("@");
  // No ref at all — not a flaggable pin (cannot recommend a SHA cleanly).
  if (at < 0) return null;
  const coordinate = trimmed.slice(0, at);
  const ref = trimmed.slice(at + 1);
  if (coordinate.length === 0 || ref.length === 0) return null;

  const segments = coordinate.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0] as string;

  // First-party carve-out — may pin to a tag.
  if (owner.toLowerCase() === FIRST_PARTY_OWNER) return null;

  // Already SHA-pinned — correct, not flagged.
  if (SHA_PIN.test(ref)) return null;

  return { flag: true, coordinate, owner, ref };
}

/**
 * Extract the raw `uses:` value from a workflow line, stripping the list
 * dash, surrounding quotes, and any trailing inline comment. Returns
 * `null` when the line is not a `uses:` declaration.
 *
 * Pure — no I/O.
 */
export function extractUsesValue(line: string): string | null {
  const m = line.match(USES_LINE);
  if (!m || !m[1]) return null;
  const raw = m[1].trim();
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  // Unquoted: the value runs up to the first whitespace (drops inline
  // `# comment`). Action refs never contain whitespace.
  const ws = raw.search(/\s/);
  return ws >= 0 ? raw.slice(0, ws) : raw;
}

/**
 * Scan every `uses:` reference across the supplied workflow and
 * composite-action files and return one consolidated {@link
 * ActionPinFinding} per distinct unpinned action/workflow coordinate.
 *
 * Behaviour:
 *   - SHA-pinned, `stSoftwareAU/*`, local `./…`, and `docker://…` refs are
 *     never flagged.
 *   - Call-sites suppressed by an in-source `best-practice-ignore:
 *     BP-SHA-PIN-…` marker are dropped; a coordinate with no surviving
 *     call-sites yields no finding.
 *   - Coordinates whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 *
 * Pure aside from reading the already-loaded `WorkflowFile.rawText` —
 * callers read the files via `readWorkflowFiles`.
 */
export function scanActionPins(
  files: readonly WorkflowFile[],
  opts: ScanActionPinsOptions = {},
): ActionPinFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);

  // coordinate → { owner, findingId, callSites }
  const byCoordinate = new Map<string, {
    owner: string;
    findingId: string;
    callSites: ActionPinCallSite[];
  }>();

  for (const file of files) {
    const lines = file.rawText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const value = extractUsesValue(lines[i] as string);
      if (value === null) continue;
      const parsed = classifyUses(value);
      if (parsed === null) continue;

      const owner = parsed.owner;
      const rest = parsed.coordinate.slice(owner.length + 1);
      const findingId = `BP-SHA-PIN-${slugify(owner)}-${slugify(rest)}`;

      const lineNumber = i + 1;
      // Honour in-source suppression markers per call-site.
      if (isFindingSuppressed(file.rawText, lineNumber, findingId, file.path)) {
        continue;
      }

      let entry = byCoordinate.get(parsed.coordinate);
      if (entry === undefined) {
        entry = { owner, findingId, callSites: [] };
        byCoordinate.set(parsed.coordinate, entry);
      }
      entry.callSites.push({
        file: file.path,
        line: lineNumber,
        ref: parsed.ref,
      });
    }
  }

  const findings: ActionPinFinding[] = [];
  for (const [coordinate, entry] of byCoordinate) {
    if (entry.callSites.length === 0) continue;
    if (suppressed.has(entry.findingId)) continue;
    if (knownOpen.has(entry.findingId)) continue;
    findings.push(buildFinding(coordinate, entry));
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

/** Assemble the consolidated finding body for one coordinate. */
function buildFinding(
  coordinate: string,
  entry: {
    owner: string;
    findingId: string;
    callSites: ActionPinCallSite[];
  },
): ActionPinFinding {
  const sites = [...entry.callSites].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  );
  const first = sites[0] as ActionPinCallSite;
  const count = sites.length;

  const title =
    `🔴 Pin third-party action \`${coordinate}\` to a 40-char commit SHA`;

  const whyItMatters =
    `\`${coordinate}\` is referenced by a mutable tag or branch rather ` +
    "than a full 40-character commit SHA. A tag is mutable: whoever " +
    "controls the upstream repository (or an attacker who compromises it) " +
    "can repoint the tag at malicious code, which then runs with this " +
    "workflow's permissions and secrets. Pinning to an immutable commit " +
    "SHA removes that supply-chain risk. First-party `stSoftwareAU/*` " +
    "actions and local `./` references are exempt.";

  const suggestedFix =
    `Pin every \`${coordinate}\` reference to a full 40-character commit ` +
    "SHA, keeping the human-readable version in a trailing comment, e.g. " +
    "`uses: " + coordinate + "@<40-hex-sha> # v1.2.3`. Resolve the SHA " +
    "with `git ls-remote` or the action's release page.";

  const evidenceLines = sites.map((s) =>
    `- \`${s.file}\`:${s.line} — \`uses: ${coordinate}@${s.ref}\``
  );
  const evidence = count === 1
    ? evidenceLines.join("\n")
    : `${count} call-sites:\n${evidenceLines.join("\n")}`;

  return {
    findingId: entry.findingId,
    coordinate,
    severity: "high",
    title,
    file: first.file,
    lines: first.line,
    whyItMatters,
    suggestedFix,
    evidence,
    callSites: sites,
  };
}
