/**
 * Canonical **content** label definitions for the fleet (Issue #368).
 *
 * These are the classification and finding labels the worker (and the
 * agent templates it drives) attach to issues: the `severity:*` ramp, the
 * `confidence:*` ramp, the `lang:*` buckets, and the per-scan category
 * labels. Unlike the workflow labels in `label_definitions.ts` they are
 * **not seeded onto every monitored repo** at onboarding — a repo only
 * grows `severity:critical` once a scan actually files a finding there.
 *
 * Issue #368 — before this table existed each call site hard-coded its own
 * colour literal, so a label's colour was decided by whichever call site
 * created it first in that repo. The measured result was
 * `severity:critical` grey in one repo and red in the next, which makes the
 * colour meaningless at a glance. Every colour below is lower-case hex so
 * comparisons never become a string-normalisation problem.
 *
 * Australian English throughout (colour, behaviour, organisation).
 */

import type { LabelDefinition } from "./label_definitions.ts";

/**
 * Severity ramp — red → orange → yellow → green as severity falls.
 *
 * Applied by every finding-emitting scan template. The ramp is the whole
 * point: a reader scanning an issue list must be able to tell a critical
 * finding from a low one without reading the title.
 */
const SEVERITY_LABELS: readonly LabelDefinition[] = [
  {
    name: "severity:critical",
    colour: "b60205",
    description: "Critical severity finding — fix before anything else",
    category: "content",
  },
  {
    name: "severity:high",
    colour: "d93f0b",
    description: "High severity finding",
    category: "content",
  },
  {
    name: "severity:medium",
    colour: "fbca04",
    description: "Medium severity finding",
    category: "content",
  },
  {
    name: "severity:low",
    colour: "0e8a16",
    description: "Low severity finding",
    category: "content",
  },
];

/**
 * Confidence ramp — green (certain) → yellow → pale green (speculative).
 *
 * Deliberately a different hue family from the severity ramp so the two
 * never read as the same signal on one issue.
 */
const CONFIDENCE_LABELS: readonly LabelDefinition[] = [
  {
    name: "confidence:high",
    colour: "0e8a16",
    description: "Finding is confirmed — high confidence",
    category: "content",
  },
  {
    name: "confidence:medium",
    colour: "fbca04",
    description: "Finding is likely but unverified — medium confidence",
    category: "content",
  },
  {
    name: "confidence:low",
    colour: "c2e0c6",
    description: "Finding is speculative — low confidence",
    category: "content",
  },
];

/**
 * Security-family labels — the security scan, its whole-tree sweep, the
 * supply-chain audits, and the dependency-audit failure notifier.
 */
const SECURITY_LABELS: readonly LabelDefinition[] = [
  {
    name: "security",
    colour: "b60205",
    description: "Security finding raised by the security scan",
    category: "content",
  },
  {
    name: "security-tree-sweep",
    colour: "5319e7",
    description: "Whole-tree security sweep finding",
    category: "content",
  },
  {
    name: "security-scan-overflow",
    colour: "fbca04",
    description: "Security scan produced more findings than one batch carries",
    category: "content",
  },
  {
    name: "supply-chain-readiness",
    colour: "5319e7",
    description: "Supply-chain readiness finding",
    category: "content",
  },
  {
    name: "supply-chain:quarantine-missing",
    colour: "5319e7",
    description: "Dependency updates run with no quarantine window configured",
    category: "content",
  },
  {
    name: "supply-chain:quarantine-misconfigured",
    colour: "5319e7",
    description: "Dependency quarantine window is configured incorrectly",
    category: "content",
  },
  {
    name: "dependency-audit-failure",
    colour: "d73a4a",
    description:
      "A scheduled dependency audit failed — a committed dependency has a known advisory.",
    category: "content",
  },
];

/**
 * Scan-category labels — one per idle-task scan template, so a repo's
 * findings can be filtered by which scan produced them.
 */
const SCAN_CATEGORY_LABELS: readonly LabelDefinition[] = [
  {
    name: "best-practices",
    colour: "5319e7",
    description: "Best-practices scan finding",
    category: "content",
  },
  {
    name: "test-audit",
    colour: "b60205",
    description: "Test-audit scan finding",
    category: "content",
  },
  {
    name: "github-actions-audit",
    colour: "b60205",
    description: "GitHub Actions audit finding",
    category: "content",
  },
  {
    name: "bash-syntax-audit",
    colour: "b60205",
    description: "Bash syntax audit finding",
    category: "content",
  },
  {
    name: "bash-missing-script",
    colour: "b60205",
    description: "A referenced bash script is missing from the repository",
    category: "content",
  },
  {
    name: "documentation-audit",
    colour: "1d76db",
    description: "Documentation audit finding",
    category: "content",
  },
  {
    name: "duplicated-knowledge",
    colour: "1d76db",
    description: "Duplicated-knowledge scan finding",
    category: "content",
  },
  {
    name: "format-drift",
    colour: "1d76db",
    description: "Formatting drift finding",
    category: "content",
  },
  {
    name: "dead-code",
    colour: "5319e7",
    description: "Dead-code scan finding",
    category: "content",
  },
  {
    name: "deprecated-api",
    colour: "0e8a16",
    description: "Deprecated-API scan finding",
    category: "content",
  },
  {
    name: "doc-coverage",
    colour: "0e8a16",
    description: "Documentation-coverage scan finding",
    category: "content",
  },
  {
    name: "workflow-annotation-scan",
    colour: "0e8a16",
    description: "Workflow annotation scan finding",
    category: "content",
  },
  {
    name: "private-repo-reference",
    colour: "5319e7",
    description: "Reference to a private repository from a public one",
    category: "content",
  },
  {
    name: "alert-feed",
    colour: "d93f0b",
    description: "Finding raised from a monitored security alert feed",
    category: "content",
  },
];

/**
 * Outcome labels — applied by the worker to record how a piece of work
 * ended rather than what it found.
 */
const OUTCOME_LABELS: readonly LabelDefinition[] = [
  {
    name: "negative-result",
    colour: "c5def5",
    description:
      "Performance work measured no improvement — do not re-attempt without new evidence",
    category: "content",
  },
  {
    name: "merge-conflict",
    colour: "b60205",
    description: "PR conflicts with its base branch and needs a real merge",
    category: "content",
  },
  {
    name: "escalated",
    colour: "d4c5f9",
    description:
      "The fleet filed this PR's blockage as work; it is not waiting on a human",
    category: "content",
  },
];

/**
 * `lang:*` buckets from the best-practices scan.
 *
 * One entry per {@link SupportedLanguage} bucket, plus the two
 * language-agnostic buckets (`general`, `design`) and the legacy
 * `lang:github-actions` bucket. Colours follow each language's own brand
 * colour so the bucket is recognisable at a glance.
 */
const LANGUAGE_LABELS: readonly LabelDefinition[] = [
  ["general", "c2e0c6"],
  ["design", "bfd4f2"],
  ["rust", "dea584"],
  ["typescript", "1d76db"],
  ["react", "61dafb"],
  ["java", "b07219"],
  ["html", "e34c26"],
  ["aws-cloudformation", "ff9900"],
  ["terraform", "7b42bc"],
  ["github-actions", "2088ff"],
].map(([bucket, colour]) => ({
  name: `lang:${bucket}`,
  colour: colour!,
  description: `Best-practices finding for the \`${bucket}\` bucket`,
  category: "content" as const,
}));

/**
 * Every content label the fleet manages, grouped by family.
 *
 * Order is family-by-family so the table reads as families rather than an
 * alphabetical soup.
 */
export const CONTENT_LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  ...SEVERITY_LABELS,
  ...CONFIDENCE_LABELS,
  ...SECURITY_LABELS,
  ...SCAN_CATEGORY_LABELS,
  ...OUTCOME_LABELS,
  ...LANGUAGE_LABELS,
];
