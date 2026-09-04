/**
 * Stable finding-id recipe, known-open / suppression prune, and in-source
 * suppression collection for the orphan-deps idle-task scan
 * (Issue #2908, parent #2902).
 *
 * The orphan-deps scan is LLM-driven — Claude files each surviving finding
 * via `gh issue create` — but the worker still needs a single, tested
 * source of truth for three pieces of policy so the prompt, the native
 * detector (sibling sub-issue), and the dedup machinery all agree:
 *
 *   1. **The stable finding-id recipe.** Every finding id is
 *      `BP-<12 hex>` of SHA-256 over
 *      `{ repo, "orphan-deps", signal-class, ecosystem:package }`. The
 *      literal `"orphan-deps"` discriminator keeps the ids disjoint from
 *      the `SEC-` (security-scan) and the other `BP-` families
 *      (best-practices, test-audit, github-actions-audit,
 *      supply-chain-readiness) for the same package — see
 *      {@link computeOrphanDepsFindingId}. This mirrors the recipe the
 *      prompt (`prompts/orphan_deps/prompt.md`) tells Claude to emit and the
 *      `BP-` prefix is load-bearing: `listKnownOpenFindingIds` defaults
 *      its prefix filter to `BP-`, so a non-`BP-` id silently breaks the
 *      known-open dedup.
 *   2. **The known-open + suppression prune and 6-finding cap.** The
 *      worker-side mirror of the prompt's Phase-3 triage — drop any
 *      candidate whose id is already open or suppressed, dedup by id,
 *      order by severity, and cap at six (surplus dropped, no overflow
 *      tracker) — see {@link pruneAndCapOrphanDepsFindings}.
 *   3. **In-source suppression collection.** Gather the `BP-` ids an
 *      operator has silenced with a `best-practice-ignore: BP-…` or
 *      `orphan-deps-ignore: BP-…` marker in a dependency manifest, so the
 *      scan pre-substitutes them into `{{SUPPRESSED_IDS}}` and Claude
 *      drops the finding on the next run — see
 *      {@link collectOrphanDepsSuppressions}. Each manifest is read under
 *      the comment grammar it actually has and only the comment portion of
 *      a line is matched, so a marker planted in a strict-JSON lockfile or
 *      inside a manifest string value waives nothing, and every collected
 *      marker carries the file and line it was declared on (Issue #3947).
 *
 * Pure and side-effect-free. Australian English spelling used throughout
 * (behaviour, organisation, authorised).
 */

import {
  filterByFamily,
  findSuppressions,
  type SupportedLanguage,
  type SuppressionPolicy,
} from "./suppression_comments.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The literal discriminator baked into every orphan-deps finding id. Kept
 * identical to the value the prompt's recipe documents so the worker helper
 * and Claude compute the same id for the same dependency.
 */
export const ORPHAN_DEPS_DISCRIMINATOR = "orphan-deps";

/**
 * Hard cap on findings filed per scan run (noise control). Surplus
 * candidates are silently dropped and re-detected on the next scan — there
 * is no overflow tracker, matching the sibling templates.
 */
export const ORPHAN_DEPS_FINDING_CAP = 6;

/** The orphan signal classes — the prompt's detection-table ID prefixes. */
export const ORPHAN_DEPS_SIGNAL_CLASSES = [
  "ORPHAN-DEPRECATED",
  "ORPHAN-ARCHIVED",
  "ORPHAN-STALE",
  "ORPHAN-EOL",
  "ORPHAN-DEAD-TRANSITIVE",
] as const;

// ---------------------------------------------------------------------------
// Stable finding-id recipe
// ---------------------------------------------------------------------------

/** Inputs to {@link computeOrphanDepsFindingId}. */
export interface OrphanDepsFindingIdInput {
  /** `owner/repo` of the scanned repository. */
  repo: string;
  /** Signal class — the prompt's ID prefix (e.g. `ORPHAN-DEPRECATED`). */
  signalClass: string;
  /** The dependency's package name (a version suffix is normalised away). */
  packageName: string;
  /** Ecosystem the package belongs to (e.g. `npm`, `jsr`, `cargo`). */
  ecosystem: string;
}

/**
 * Normalise the `ecosystem:package` component so the same root dependency
 * yields the same id across runs.
 *
 * - The ecosystem is lower-cased.
 * - A trailing version / range suffix (`@1.2.3`, `@^1`, ` 1.2.3`) is
 *   dropped — a finding is about the *dependency*, not a pinned version.
 *   For a scoped npm / JSR name (`@scope/name`) the leading `@scope` is
 *   preserved; only a version `@` (not at position 0) is stripped.
 * - Internal whitespace runs collapse to a single space.
 */
function normaliseDependency(ecosystem: string, packageName: string): string {
  const eco = ecosystem.trim().toLowerCase();
  let name = packageName.trim();
  // Strip a `@version` suffix while preserving a leading `@scope`.
  const versionAt = name.lastIndexOf("@");
  if (versionAt > 0) name = name.slice(0, versionAt);
  // Strip a trailing whitespace-separated version token (`serde 1.0`,
  // `serde ^1`, `serde v1.2`) while leaving plain names untouched.
  name = name.replace(/\s+v?[\d^~=<>][^\s]*$/i, "");
  name = name.replace(/\s+/g, " ").trim();
  return `${eco}:${name}`;
}

/**
 * Compute the stable `BP-<12 hex>` finding id for an orphan-deps finding.
 *
 * The id is the first 12 hex characters of SHA-256 over
 * `repo | "orphan-deps" | signal-class | ecosystem:package`. The async
 * signature is forced by `crypto.subtle.digest`. Pure — no I/O.
 */
export async function computeOrphanDepsFindingId(
  input: OrphanDepsFindingIdInput,
): Promise<string> {
  const canonical = [
    input.repo.trim(),
    ORPHAN_DEPS_DISCRIMINATOR,
    input.signalClass.trim(),
    normaliseDependency(input.ecosystem, input.packageName),
  ].join("|");
  const encoded = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `BP-${hex.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Known-open + suppression prune and cap
// ---------------------------------------------------------------------------

/** Minimal shape a candidate finding must expose to be pruned / capped. */
export interface OrphanDepsCandidate {
  /** Stable `BP-` id from {@link computeOrphanDepsFindingId}. */
  id: string;
  /** Severity, used only for cap ordering. Defaults to `low` ranking. */
  severity?: "high" | "medium" | "low";
}

/** Options for {@link pruneAndCapOrphanDepsFindings}. */
export interface PruneOptions {
  /** Stable ids already open as `orphan-deps` issues — dropped. */
  knownOpenIds?: Iterable<string>;
  /** Stable ids suppressed in source / by prior triage — dropped. */
  suppressedIds?: Iterable<string>;
  /** Hard cap; defaults to {@link ORPHAN_DEPS_FINDING_CAP}. */
  cap?: number;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Drop known-open, suppressed, and duplicate candidates, order the
 * survivors by severity (high → medium → low, stable within a severity),
 * and keep at most `cap`.
 *
 * This is the worker-side mirror of the prompt's Phase-3 triage so the
 * dedup + suppression + cap policy has one tested source of truth shared
 * with the native detector. Pure — no I/O.
 */
export function pruneAndCapOrphanDepsFindings<T extends OrphanDepsCandidate>(
  candidates: readonly T[],
  opts: PruneOptions = {},
): T[] {
  const known = new Set(opts.knownOpenIds ?? []);
  const suppressed = new Set(opts.suppressedIds ?? []);
  const cap = opts.cap ?? ORPHAN_DEPS_FINDING_CAP;
  const seen = new Set<string>();

  const surviving: T[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.id) || suppressed.has(candidate.id)) continue;
    if (seen.has(candidate.id)) continue; // dedup by id
    seen.add(candidate.id);
    surviving.push(candidate);
  }

  // Array.prototype.sort is stable in V8, so input order is preserved
  // within a severity band.
  surviving.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity ?? "low"] ?? 2) -
      (SEVERITY_RANK[b.severity ?? "low"] ?? 2),
  );

  return cap >= 0 ? surviving.slice(0, cap) : surviving;
}

// ---------------------------------------------------------------------------
// In-source suppression collection
// ---------------------------------------------------------------------------

/**
 * The comment grammar a dependency manifest actually has.
 *
 * - `slash` — `//` and `/* … *\/` (JSONC, and `deno.json`, which Deno
 *   parses as JSONC).
 * - `hash` — `#` (TOML).
 * - `none` — strict JSON and generated lockfiles. These have no comment
 *   grammar at all, so *nothing* in them is a marker (Issue #3947).
 */
export type ManifestCommentGrammar = "slash" | "hash" | "none";

/** One manifest handed to {@link collectOrphanDepsSuppressions}. */
export interface OrphanDepsManifestText {
  /** Repo-relative manifest name, recorded on every collected record. */
  file: string;
  /** The manifest's raw text. */
  text: string;
  /** The comment grammar that manifest's format actually supports. */
  grammar: ManifestCommentGrammar;
}

/** A marker found in a manifest, scoped to where it was declared. */
export interface OrphanDepsSuppression {
  /** The `BP-` finding id the marker targets. */
  id: string;
  /** Manifest the marker was declared in. */
  file: string;
  /** 1-based line the marker sits on. */
  line: number;
  /** True only when the #3712 governance fields all pass. */
  valid: boolean;
}

/** The suppression-parser language each comment grammar is read as. */
const GRAMMAR_LANGUAGE: Record<
  Exclude<ManifestCommentGrammar, "none">,
  SupportedLanguage
> = { slash: "ts", hash: "sh" };

// Scan each manifest text twice — once as a slash/block-comment language
// (`ts`) and once as a hash-comment language (`sh`) — so a marker written in
// any manifest comment style (jsonc `//`, TOML / YAML `#`) is recognised
// regardless of the file's real type.
const SCAN_LANGUAGES: readonly SupportedLanguage[] = ["ts", "sh"];

/** A manifest text to scan, optionally naming its source file. */
export interface SuppressionScanText {
  text: string;
  /** Repo-relative file the text came from, named in the run report. */
  file?: string;
}

/**
 * Reduce `line` to its comment tail, or `""` when the line has no comment
 * under `grammar`.
 *
 * Quoted string values are walked over first, so a `#` or `//` inside a
 * dependency string is never mistaken for a comment start — that was the
 * hole that let a marker planted in a manifest *value* waive a finding
 * (Issue #3947). Only text from the comment token onwards is returned, so
 * the marker patterns are effectively anchored to a real comment.
 */
function commentTail(
  line: string,
  grammar: Exclude<ManifestCommentGrammar, "none">,
): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      // Backslash escapes apply to double-quoted strings only; TOML
      // literal (single-quoted) strings take the backslash verbatim.
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (grammar === "hash" && ch === "#") return line.slice(i);
    if (
      grammar === "slash" && ch === "/" &&
      (line[i + 1] === "/" || line[i + 1] === "*")
    ) {
      return line.slice(i);
    }
  }
  return "";
}

/**
 * Collect the `best-practice-ignore: BP-…` / `orphan-deps-ignore: BP-…`
 * markers declared in the supplied manifests, each scoped to the file and
 * line it was declared on.
 *
 * A manifest whose `grammar` is `none` — strict JSON and generated
 * lockfiles — is skipped outright: it has no comment syntax, so any marker
 * text in it is a string value, not a waiver. Every other manifest is read
 * under its own grammar and only the comment portion of each line is
 * matched.
 *
 * Only `BP-`-prefixed ids in the `best-practices` suppression family are
 * returned (orphan-deps ids share that `BP-` space); `SEC-` ids and other
 * families are ignored. Order-stable, de-duplicated by file+line+id. Pure
 * — no I/O.
 */
export function collectOrphanDepsSuppressions(
  manifests: Iterable<OrphanDepsManifestText>,
  policy: Omit<SuppressionPolicy, "file"> = {},
): OrphanDepsSuppression[] {
  const collected: OrphanDepsSuppression[] = [];
  const seen = new Set<string>();

  for (const manifest of manifests) {
    if (manifest.grammar === "none") continue;
    const grammar = manifest.grammar;
    // Blank every non-comment span while preserving line numbering, so a
    // record's `line` still points at the real source line.
    const commentsOnly = manifest.text
      .split("\n")
      .map((line) => commentTail(line, grammar))
      .join("\n");

    for (
      const record of filterByFamily(
        findSuppressions(commentsOnly, GRAMMAR_LANGUAGE[grammar], {
          ...policy,
          file: manifest.file,
        }),
        "best-practices",
      )
    ) {
      if (!record.id.startsWith("BP-")) continue;
      const key = `${manifest.file}:${record.line}:${record.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        id: record.id,
        file: manifest.file,
        line: record.line,
        valid: record.valid,
      });
    }
  }

  return collected;
}

/**
 * Collect the suppressed `BP-` finding ids declared by
 * `best-practice-ignore: BP-…` / `orphan-deps-ignore: BP-…` markers in the
 * supplied manifest texts.
 *
 * Only `BP-`-prefixed ids in the `best-practices` suppression family are
 * returned (orphan-deps ids share that `BP-` space); `SEC-` ids and other
 * families are ignored. Only markers that pass the governance policy
 * (`valid: true`) are collected (Issue #3941) — an unattributed,
 * expired, or unauthorised marker is recorded and reported but never
 * reaches the prompt as a suppressed id. The result is de-duplicated and
 * order-stable. Pure — no I/O.
 *
 * Use {@link collectOrphanDepsSuppressions} when the declaring file and
 * line matter (auditing a run, or applying the proximity rule).
 *
 * @param fileTexts - Manifest texts (optionally with their file names)
 * @param policy - Governance overrides (mainly for tests); the process
 *   allowlist configured at startup applies when absent
 */
export function collectOrphanDepsSuppressedIds(
  fileTexts: Iterable<string | SuppressionScanText>,
  policy: Omit<SuppressionPolicy, "file"> = {},
): string[] {
  const ids = new Set<string>();
  for (const item of fileTexts) {
    const { text, file } = typeof item === "string" ? { text: item } : item;
    for (const lang of SCAN_LANGUAGES) {
      for (
        const record of filterByFamily(
          findSuppressions(text, lang, {
            ...policy,
            ...(file ? { file } : {}),
          }),
          "best-practices",
        )
      ) {
        if (record.valid && record.id.startsWith("BP-")) ids.add(record.id);
      }
    }
  }
  return [...ids];
}

/**
 * Does a marker collected by {@link collectOrphanDepsSuppressions} waive
 * the finding `findingId` declared at `location`?
 *
 * The rule is deliberately identical to
 * {@link import("./suppression_comments.ts").isSuppressed}: the marker must
 * have passed the governance policy, and must sit on the finding's own line
 * or the line immediately above it — additionally, in the same file. A
 * marker declared elsewhere in the repo waives nothing (Issue #3947).
 */
export function isOrphanDepsSuppressed(
  findingId: string,
  suppressions: readonly OrphanDepsSuppression[],
  location: { file: string; line: number },
): boolean {
  for (const s of suppressions) {
    if (!s.valid) continue;
    if (s.id !== findingId) continue;
    if (s.file !== location.file) continue;
    if (s.line === location.line || s.line === location.line - 1) return true;
  }
  return false;
}
