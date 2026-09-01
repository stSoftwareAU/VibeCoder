/**
 * SLOC-weighted bucket picker for the best-practices idle task (Issue #2144).
 *
 * Picks one of the supported language buckets — or one of the two
 * language-agnostic buckets, `general` (repo hygiene) and `design`
 * (design smells, Issue #662) — for a best-practices idle-task run,
 * weighted by per-language byte counts
 * (a KISS SLOC proxy: bytes correlate strongly with SLOC within a single
 * language ecosystem).
 *
 * Foundation for #2143 — the picked bucket goes into the wrapper-issue body
 * so a human reviewer sees up-front which best-practice guide the run will
 * target.
 *
 * Design notes:
 *
 *   - Each *detected and supported* language is weighted by its byte count
 *     from `RepoLanguages.raw` (the GitHub Languages API).
 *   - `general` and `design` (Issue #662) are each added as a single bucket
 *     whose weight equals the largest detected language's weight, so both
 *     compete on par with the dominant language. Neither names a language,
 *     so a repo written entirely in unsupported languages still draws one of
 *     them — its dominant raw byte count supplies the weight. A repo with no
 *     detected code at all has nothing to design-review, so it falls back to
 *     `general` alone.
 *   - React vs plain-TypeScript decision: the bucket is `react` only when
 *     `package.json` declares a React dependency AND at least one `.jsx`/`.tsx`
 *     file is present; otherwise the TypeScript byte-count flows to the
 *     `typescript` bucket. The picker reads these signals from
 *     `RepoLanguages.bestPracticesMarkers` and applies the rule itself.
 *   - CloudFormation / Terraform: weight comes from marker file byte counts
 *     in `bestPracticesMarkers` (Terraform falls back to `raw["HCL"]` when no
 *     marker count is supplied).
 *   - An injectable RNG (`() => number` in `[0, 1)`) makes the picker
 *     deterministic under test.
 */

import type {
  BestPracticesMarkers,
  RepoLanguages,
} from "./language_detector.ts";

/**
 * Languages supported by the best-practices idle task. Each value names a
 * dedicated best-practice bucket the LLM can target on a run.
 */
export type SupportedLanguage =
  | "rust"
  | "typescript"
  | "react"
  | "java"
  | "html"
  | "aws-cloudformation"
  | "terraform";

/**
 * The outcome of a bucket pick.
 *
 * `general` (repo-level hygiene) and `design` (language-agnostic design
 * smells, Issue #662) are the two language-agnostic buckets — neither names
 * a language, so both are candidates on every repo that has code.
 */
export type BucketPick =
  | { kind: "language"; language: SupportedLanguage }
  | { kind: "general" }
  | { kind: "design" };

/** Internal weighted-entry shape. */
interface WeightedBucket {
  bucket: BucketPick;
  weight: number;
}

/**
 * Pick a best-practices bucket — a specific supported language, or one of
 * the language-agnostic `general` / `design` buckets — weighted by
 * per-bucket byte counts.
 *
 * @param repoLanguages Detected language stats for the repo. May include
 *   optional `bestPracticesMarkers` for framework/IaC buckets the GitHub
 *   Languages API does not surface directly.
 * @param rng Random number generator returning a value in `[0, 1)`.
 *   Defaults to `Math.random` — pass a seeded RNG for deterministic tests.
 * @returns The picked bucket, or `{ kind: "general" }` if the repo has no
 *   detected code at all.
 */
export function pickBucket(
  repoLanguages: RepoLanguages,
  rng: () => number = Math.random,
): BucketPick {
  const weighted = collectWeightedBuckets(repoLanguages);

  // Weight of the repo's dominant language: the largest supported bucket
  // when one is detected, otherwise the largest language the Languages API
  // reported at all. The second case is what lets an unsupported-language
  // repo (Bash, Python, COBOL) still draw a language-agnostic bucket.
  const dominantWeight = weighted.length > 0
    ? Math.max(...weighted.map((w) => w.weight))
    : dominantRawWeight(repoLanguages);

  if (dominantWeight <= 0) {
    // No code at all — only repo-level hygiene has anything to review.
    return { kind: "general" };
  }

  // Both language-agnostic buckets compete on par with the dominant language.
  weighted.push({ bucket: { kind: "general" }, weight: dominantWeight });
  weighted.push({ bucket: { kind: "design" }, weight: dominantWeight });

  return weightedPick(weighted, rng);
}

/**
 * Largest byte count across every language the Languages API reported,
 * supported or not. Returns 0 for a repo with no detected code.
 */
function dominantRawWeight(langs: RepoLanguages): number {
  return Math.max(0, ...Object.values(langs.raw));
}

/**
 * Walk the language stats and produce one weighted entry per *supported*
 * bucket actually present in this repo. Buckets with zero or undefined
 * weight are omitted.
 */
function collectWeightedBuckets(langs: RepoLanguages): WeightedBucket[] {
  const out: WeightedBucket[] = [];
  const raw = langs.raw;
  const markers = langs.bestPracticesMarkers ?? {};

  // Rust ────────────────────────────────────────────────────────────────
  pushIfPositive(out, "rust", raw.Rust);

  // TypeScript / React — mutually exclusive: react replaces typescript
  // when both a React dep is declared and a .jsx/.tsx file is present.
  const tsBytes = raw.TypeScript ?? 0;
  if (tsBytes > 0) {
    pushIfPositive(out, isReactRepo(markers) ? "react" : "typescript", tsBytes);
  }

  // Java, HTML ──────────────────────────────────────────────────────────
  pushIfPositive(out, "java", raw.Java);
  pushIfPositive(out, "html", raw.HTML);

  // Terraform — prefer explicit marker bytes, fall back to HCL raw count.
  const tfBytes = markers.terraformBytes ?? raw.HCL ?? 0;
  pushIfPositive(out, "terraform", tfBytes);

  // CloudFormation — marker-only.
  pushIfPositive(out, "aws-cloudformation", markers.cloudFormationBytes);

  return out;
}

/**
 * React-vs-plain-TypeScript decision, shared by the bucket picker and the
 * language-validity-gate detector (Issue #3237): a repo counts as React only
 * when it both declares a React dependency AND has at least one `.jsx`/`.tsx`
 * file. Otherwise its TypeScript bytes flow to the plain `typescript` bucket.
 */
export function isReactRepo(
  markers: BestPracticesMarkers | undefined,
): boolean {
  return markers?.hasReactDependency === true &&
    markers?.hasJsxFiles === true;
}

/** Add a weighted entry when the weight is a positive number. */
function pushIfPositive(
  out: WeightedBucket[],
  language: SupportedLanguage,
  weight: number | undefined,
): void {
  if (typeof weight === "number" && weight > 0) {
    out.push({ bucket: { kind: "language", language }, weight });
  }
}

/**
 * Standard weighted random pick over a non-empty list of weighted buckets.
 * Walks the cumulative weight until the RNG draw is consumed.
 */
function weightedPick(
  weighted: WeightedBucket[],
  rng: () => number,
): BucketPick {
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let draw = rng() * total;
  for (const { bucket, weight } of weighted) {
    draw -= weight;
    if (draw < 0) {
      return bucket;
    }
  }
  // Floating-point edge case: return the last bucket.
  const last = weighted[weighted.length - 1];
  if (last === undefined) {
    throw new Error("weightedPick requires a non-empty list");
  }
  return last.bucket;
}
