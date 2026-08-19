/**
 * Version-agnostic classifier for GitHub Actions workflow-run annotations
 * (Issue #3487, part of #3485).
 *
 * The fetcher sub-issue (`workflow_annotation_fetcher.ts`) produces a raw
 * stream of {@link WorkflowRunAnnotation}s. The same annotation recurs across
 * dozens of runs (for example one deprecated-runtime warning fires on every
 * push), so filing an issue per raw annotation would flood the repo. This
 * module collapses the stream into a small set of **distinct annotation
 * classes**, each with a stable dedup key, so the downstream filing sub-issue
 * files exactly one issue per class and never duplicates against an
 * already-open issue.
 *
 * How classes are formed:
 *
 *   - Each annotation is keyed by a **version-agnostic** normalisation of
 *     `(level, workflowPath, message-shape)`. Volatile tokens — runtime
 *     versions (`node20`, `v3`, `18.x`), commit ids, timestamps, URLs and
 *     file line offsets — are stripped from the message before keying, so
 *     `node20` today and `node22` next year collapse to the same class while
 *     genuinely different problems stay distinct.
 *   - The stable class id is produced via {@link makeStableId} from
 *     `workflow_scan_common.ts` (reused, not reinvented), so the dedup key is
 *     byte-identical run-to-run and shares the `BP-` prefix that
 *     `idle_task_snapshot.listKnownOpenFindingIds` and `isFindingSuppressed`
 *     match against open-issue titles/markers.
 *
 * It is deliberately **runtime-version-agnostic**: no runtime version string
 * (`node20`, etc.) is ever hardcoded as a match anchor — versions are removed
 * structurally by {@link normaliseAnnotationMessage}.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { makeStableId } from "./workflow_scan_common.ts";
import type {
  AnnotationLevel,
  WorkflowRunAnnotation,
} from "./workflow_annotation_fetcher.ts";

export type { AnnotationLevel, WorkflowRunAnnotation };

/**
 * Discriminator baked into every class id so annotation-scan ids never
 * collide with another scan's `BP-` findings for the same file/message.
 */
export const ANNOTATION_CLASS_DISCRIMINATOR = "workflow-annotation-scan";

/** Unambiguous separator for the in-memory group key (never in real text). */
const KEY_SEP = "\n";

/**
 * A distinct class of annotation: the collapse of every annotation sharing the
 * same version-agnostic `(level, workflowPath, message-shape)` key.
 */
export interface AnnotationClass {
  /** Stable `BP-`-prefixed dedup key (from {@link makeStableId}). */
  classId: string;
  /** Severity shared by every annotation in the class. */
  level: AnnotationLevel;
  /** A verbatim example message (first-seen), for the issue body. */
  representativeMessage: string;
  /** One example run URL (first-seen), so a human can jump to a real run. */
  runUrl: string;
  /** Distinct non-empty workflow definition paths affected, sorted. */
  workflowPaths: string[];
  /** How many raw annotations collapsed into this class. */
  count: number;
}

// ---------------------------------------------------------------------------
// classifyAnnotations
// ---------------------------------------------------------------------------

/** Mutable accumulator while grouping; frozen into an {@link AnnotationClass}. */
interface Bucket {
  level: AnnotationLevel;
  representativeMessage: string;
  runUrl: string;
  workflowPaths: Set<string>;
  count: number;
  /** Pre-hash key parts, retained so the id is computed once at the end. */
  keyParts: string[];
}

/**
 * Group `annotations` into version-agnostic classes.
 *
 * Two annotations differing only by runtime version (e.g. `node20` vs
 * `node22`) collapse to one class; genuinely different messages stay in
 * separate classes. The returned array is sorted by `classId`, so the order —
 * and every `classId` — is deterministic for identical input regardless of the
 * input ordering. An empty input returns `[]`.
 */
export async function classifyAnnotations(
  annotations: readonly WorkflowRunAnnotation[],
): Promise<AnnotationClass[]> {
  const buckets = new Map<string, Bucket>();

  for (const a of annotations) {
    const effective = effectiveText(a);
    const shape = normaliseAnnotationMessage(effective);
    const keyParts = [
      ANNOTATION_CLASS_DISCRIMINATOR,
      a.level,
      a.workflowPath,
      shape,
    ];
    const mapKey = keyParts.join(KEY_SEP);

    let bucket = buckets.get(mapKey);
    if (!bucket) {
      bucket = {
        level: a.level,
        representativeMessage: effective,
        runUrl: a.runUrl,
        workflowPaths: new Set<string>(),
        count: 0,
        keyParts,
      };
      buckets.set(mapKey, bucket);
    }
    bucket.count += 1;
    if (a.workflowPath !== "") bucket.workflowPaths.add(a.workflowPath);
  }

  const classes: AnnotationClass[] = [];
  for (const bucket of buckets.values()) {
    const classId = await makeStableId(bucket.keyParts);
    classes.push({
      classId,
      level: bucket.level,
      representativeMessage: bucket.representativeMessage,
      runUrl: bucket.runUrl,
      workflowPaths: [...bucket.workflowPaths].sort(),
      count: bucket.count,
    });
  }

  classes.sort((x, y) => x.classId.localeCompare(y.classId));
  return classes;
}

/** The text used for both the shape and the representative message. */
function effectiveText(a: WorkflowRunAnnotation): string {
  return a.message !== "" ? a.message : a.title;
}

// ---------------------------------------------------------------------------
// normaliseAnnotationMessage
// ---------------------------------------------------------------------------

/**
 * Reduce an annotation message to a **version-agnostic shape** by stripping
 * volatile tokens, so repeat instances and version-only differences collapse
 * to the same key while distinct wording stays distinct.
 *
 * Stripped, in order (each replaced with a space so adjacent words never fuse):
 *
 *   1. ISO-8601 timestamps (`2026-07-17T09:15:03Z`).
 *   2. URLs (`https://…`) — they embed run/commit ids.
 *   3. Commit/object ids — hex runs of 7–40 chars containing a digit.
 *   4. Numeric and dotted-version runs (`20`, `1.2.3`, `18.x`) — this is what
 *      turns `node20`/`node22` and `@v3`/`@v4` into the same shape without any
 *      hardcoded runtime string.
 *
 * Whitespace is then collapsed and the result trimmed. Case is preserved so
 * genuinely different wording keeps distinct classes.
 */
export function normaliseAnnotationMessage(text: string): string {
  let out = text;

  // 1. ISO-8601 timestamps.
  out = out.replace(
    /\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[zZ]|[+-]\d{2}:?\d{2})?/g,
    " ",
  );

  // 2. URLs (run/commit ids live inside them).
  out = out.replace(/https?:\/\/\S+/g, " ");

  // 3. Commit/object ids: hex runs of 7–40 chars that contain at least one
  //    digit (so ordinary words like "deadbeef" are left alone).
  out = out.replace(/\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,40}\b/g, " ");

  // 4. Numeric and dotted-version runs, including `.x` suffixes. Removing the
  //    digits — not matching a known version string — is what makes the shape
  //    runtime-version-agnostic (node20 -> node, @v3 -> @v, 18.x -> ).
  out = out.replace(/\d+(?:\.\d+)*(?:\.[xX])?/g, " ");

  // Collapse whitespace and trim.
  return out.replace(/\s+/g, " ").trim();
}
