/**
 * Canonical "Phase 0 — Adapt to the project" stanza shared by the
 * judgement-bearing idle-task scan prompts (Issue #3610).
 *
 * Every judgement-bearing scan must read the target repo's own committed
 * conventions — `README.md`, `AGENTS.md` / `CLAUDE.md`, `CONTRIBUTING.md`,
 * and any style guide under `docs/` — before deciding what counts as a
 * violation. A repo that made a documented, defensible choice otherwise
 * collects false positives, and a false positive costs a human triage
 * cycle and teaches the fleet that findings are noise.
 *
 * The stanza is worded **once**, here, and copied verbatim into each
 * prompt version. `project_conventions_stanza_test.ts` asserts the exact
 * text is present in every scan listed in `PROJECT_CONVENTIONS_SCANS`, so
 * the eight copies cannot drift apart.
 *
 * Two boundaries are deliberate:
 *   - A convention only counts when it is **written down** — otherwise the
 *     rule degrades into "the scan can talk itself out of anything".
 *   - A documented convention can never soften a **security or fail-loud**
 *     finding, so the purely mechanical scans and `security_scan` are
 *     excluded outright (`PROJECT_CONVENTIONS_EXEMPT_SCANS`).
 *
 * This changes only how a scan *judges* a repo against its own committed
 * conventions. It introduces no cross-repo mechanism — repository
 * isolation (Issue #3239) is untouched.
 *
 * Pure data, no I/O. Australian English throughout.
 */

/**
 * The stanza, verbatim. Inserted immediately before Phase 1 in each
 * prompt version listed in `PROJECT_CONVENTIONS_SCANS`.
 */
export const PROJECT_CONVENTIONS_STANZA = `## Phase 0 — Adapt to the project

Before applying any check, read the target repo's \`README.md\`, its agent
instructions (\`AGENTS.md\`, \`CLAUDE.md\`), \`CONTRIBUTING.md\`, and any
style guide under \`docs/\`. Where a documented project convention
conflicts with a check below, **the project convention wins** — drop the
candidate and do not file it. A convention counts only when it is written
down in the repo; an undocumented habit inferred from the code does not
override a check. If a check fires *because* the documented convention
itself is unsafe (a security or fail-loud violation), file the finding
against the convention and say so explicitly.

Record which convention documents you read and, for every candidate you
dropped, the convention that overrode it — a dropped candidate with no
named convention is a candidate you must still file.

This is a judgement rule about **this** repo's own committed conventions.
It introduces no cross-repo mechanism: each repo still owns and enforces
its own gates (repository isolation).
`;

/**
 * Scans whose latest prompt version must carry the stanza — the
 * judgement-bearing ones, highest value first (Issue #3610).
 */
export const PROJECT_CONVENTIONS_SCANS: readonly string[] = [
  "best_practices",
  "documentation_audit",
  "doc_coverage",
  "test_audit",
  "format_drift",
  "dead_code",
  "duplicated_knowledge",
];

/**
 * Scans that must **never** carry the stanza. `security_scan` is excluded
 * so a repo cannot document its way past a security finding; the other two
 * are purely mechanical (a syntax error or a workflow annotation is not a
 * matter of convention).
 */
export const PROJECT_CONVENTIONS_EXEMPT_SCANS: readonly string[] = [
  "security_scan",
  "bash_syntax_audit",
  "workflow_annotation_scan",
];

/**
 * True when `promptBody` carries the canonical stanza verbatim.
 *
 * @param promptBody - Full text of a loaded prompt version.
 */
export function hasProjectConventionsStanza(promptBody: string): boolean {
  return promptBody.includes(PROJECT_CONVENTIONS_STANZA);
}
