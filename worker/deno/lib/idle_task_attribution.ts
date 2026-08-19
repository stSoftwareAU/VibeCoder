/**
 * Idle-task attribution footer (Issue #2438).
 *
 * Every idle-task wrapper issue — and, via sub-issue #2, every filed
 * finding issue — carries a single visible footer line naming the
 * template that filed it and the worker run id. This makes any future
 * "why did this run?" question answerable from the issue body alone.
 *
 * The footer is plain Markdown (no hidden HTML marker) so it renders on
 * GitHub, and both fields are backtick-wrapped so they survive
 * copy/paste. This module is the single source of truth — the wrapper
 * body builder and the finding-issue builder both compose on top of it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { buildRunIdMetadataBlock } from "./run_id.ts";

/**
 * Fixed leading text shared by every attribution footer line. Exported so
 * the idempotent append guard ({@link appendIdleTaskAttribution}) can detect
 * an already-embedded footer without depending on the volatile template name
 * or run id.
 */
export const ATTRIBUTION_FOOTER_PREFIX = "🏷️ Filed by idle-task template:";

/**
 * Label introducing the footer's optional model segment. Exported so readers
 * of the tier stamp (Issue #4010) locate the segment through the same
 * constant the writer emits, rather than a second copy of the wording.
 */
export const ATTRIBUTION_MODEL_LABEL = "Model:";

/**
 * Regex consuming everything after {@link ATTRIBUTION_FOOTER_PREFIX} on a
 * footer line. The single source of truth for the footer's shape on the
 * reading side — {@link buildAttributionFooter} is the writing side, and the
 * round-trip test pins the two together.
 *
 * The model segment is optional so pre-#4007 wrappers still parse, and
 * trailing whitespace is tolerated because issue bodies routinely carry it.
 */
const FOOTER_LINE_PATTERN =
  /^\s*`([^`]+)`\s*·\s*Run id:\s*`([^`]+)`(?:\s*·\s*Model:\s*`([^`]+)`)?\s*$/;

/** Inputs for {@link buildAttributionFooter}. */
export interface AttributionFooterOptions {
  /** Name of the idle-task template that filed the issue. */
  template: string;
  /** Canonical worker run id (see {@link getRunId} in `run_id.ts`). */
  runId: string;
  /**
   * Model tier the scan ran on (e.g. `sonnet`, `fable`) — Issue #4007.
   *
   * Omitted entirely from the rendered footer when absent, so bodies from
   * callers that do not stamp a tier stay byte-identical to the pre-#4007
   * format.
   */
  model?: string;
}

/** Fields recovered from an attribution footer by {@link parseAttributionFooter}. */
export interface ParsedAttributionFooter {
  template: string;
  runId: string;
  /** Model tier, or null when the footer carries no model segment. */
  model: string | null;
}

/**
 * Build the visible attribution footer line for an idle-task issue body.
 *
 * Produces a single line of the form:
 *
 *   ``🏷️ Filed by idle-task template: `test-audit` · Run id: `vibe-...` ``
 *
 * When `model` is supplied, one further segment is appended:
 *
 *   `` … · Model: `fable` ``
 *
 * Every field is emitted verbatim inside backticks — no escaping is
 * applied, so special characters survive intact. Throws when a supplied
 * field is empty or whitespace-only, since an attribution line with a
 * blank template, run id or tier traces nothing.
 */
export function buildAttributionFooter(opts: AttributionFooterOptions): string {
  if (opts.template.trim().length === 0) {
    throw new Error(
      "buildAttributionFooter: template must be a non-empty string",
    );
  }
  if (opts.runId.trim().length === 0) {
    throw new Error(
      "buildAttributionFooter: runId must be a non-empty string",
    );
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new Error(
      "buildAttributionFooter: model must be a non-empty string when supplied",
    );
  }
  const base =
    `${ATTRIBUTION_FOOTER_PREFIX} \`${opts.template}\` · Run id: \`${opts.runId}\``;
  return opts.model === undefined
    ? base
    : `${base} · ${ATTRIBUTION_MODEL_LABEL} \`${opts.model}\``;
}

/**
 * Recover the fields of the first attribution footer in an issue body, or
 * null when the body carries no well-formed footer (Issue #4007).
 *
 * This is the reading counterpart of {@link buildAttributionFooter}: both
 * sides share one format definition so a tier stamp can never go silently
 * missing from downstream reports. Never throws — a hand-edited or truncated
 * footer simply reads as "no attribution", which callers already handle.
 */
export function parseAttributionFooter(
  body: string,
): ParsedAttributionFooter | null {
  const idx = body.indexOf(ATTRIBUTION_FOOTER_PREFIX);
  if (idx < 0) return null;
  const rest = body.slice(idx + ATTRIBUTION_FOOTER_PREFIX.length);
  const line = rest.split("\n")[0] ?? "";
  const match = FOOTER_LINE_PATTERN.exec(line);
  if (match === null) return null;
  const template = match[1]?.trim() ?? "";
  const runId = match[2]?.trim() ?? "";
  if (template.length === 0 || runId.length === 0) return null;
  const model = match[3]?.trim();
  return {
    template,
    runId,
    model: model !== undefined && model.length > 0 ? model : null,
  };
}

/**
 * Append the visible attribution footer and the machine-readable run-id
 * metadata block to an idle-task issue body — stamping the footer exactly
 * once (Issue #3513).
 *
 * Some templates pre-embed the footer in their wrapper body by substituting a
 * `{{ATTRIBUTION_FOOTER}}` placeholder inside their own `buildIssueBody`, so
 * an unconditional append double-stamps the footer (seen in cross-repo-filed
 * bodies such as `example-org/private-repo-29#3394`). This helper is the single guard
 * both filers share: it appends the footer only when the body does not already
 * end with an attribution-footer line, then always appends the run-id metadata
 * block (which templates never embed). Trailing whitespace on the incoming
 * body is trimmed first so the layout stays stable.
 */
export function appendIdleTaskAttribution(
  body: string,
  opts: AttributionFooterOptions,
): string {
  const trimmed = body.replace(/\s+$/, "");
  const lastLine = trimmed.split("\n").at(-1)?.trim() ?? "";
  const parts: string[] = [trimmed];
  if (!lastLine.startsWith(ATTRIBUTION_FOOTER_PREFIX)) {
    parts.push("", buildAttributionFooter(opts));
  }
  parts.push("", buildRunIdMetadataBlock(opts.runId));
  return parts.join("\n");
}
