/**
 * Shared helpers left in place after the automatic mutation check was retired
 * by Issue #5095. This module used to decide whether the repository's CI
 * blocks on a mutation-testing job; that logic is gone. It holds only the
 * helpers other checks still use:
 *
 * - {@link triggersOn}: whether a workflow document is triggered by an event.
 * - {@link isNonFailing}: whether a command line ends in a no-op tail (`|| true`,
 *   `|| :`, `|| exit 0` or `|| /bin/true`), so the line cannot fail the step.
 * - {@link logicalLines}: splits a `run:` script into logical lines, joining
 *   backslash continuations.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */
type Mapping = Record<string, unknown>;
function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the trigger includes `event`, such as `pull_request` or
 * `workflow_call`. The `on` key may parse as the string "on" or as "true" (YAML
 * 1.1 boolean). Other events, such as `pull_request_target`, do not count.
 */
export function triggersOn(doc: Mapping, event: string): boolean {
  const trigger = doc.on !== undefined ? doc.on : doc["true"];
  if (typeof trigger === "string") return trigger === event;
  if (Array.isArray(trigger)) return trigger.includes(event);
  if (isMapping(trigger)) return Object.hasOwn(trigger, event);
  return false;
}

/** No-op tails that stop a command from failing the step, matched at line end. */
const NON_FAILING_TAILS = [
  "|| true",
  "||true",
  "|| :",
  "|| exit 0",
  "|| /bin/true",
];

/** A ` #` comment marker: a tail after it would sit inside the comment. */
const COMMENT_MARKER = /(?:^|\s)#/;

/**
 * Whether a logical line ends in a no-op tail, so its command cannot fail the
 * step. The line is trimmed and one trailing `;` removed before matching. A
 * line with a ` #` comment marker is never non-failing, because the tail would
 * sit inside the comment and the command would still fail the step.
 */
export function isNonFailing(line: string): boolean {
  if (COMMENT_MARKER.test(line)) return false;
  const body = line.trim().replace(/;$/, "").trimEnd();
  return NON_FAILING_TAILS.some((tail) => body.endsWith(tail));
}

/**
 * The logical lines of a `run` script. A line ending in `\` continues onto the
 * next line, so the two are joined with one space.
 */
export function logicalLines(run: string): string[] {
  const lines: string[] = [];
  let parts: string[] = [];
  for (const raw of run.split("\n")) {
    const text = parts.length === 0 ? raw : raw.trimStart();
    const trimmed = text.trimEnd();
    if (trimmed.endsWith("\\")) {
      parts.push(trimmed.slice(0, -1).trimEnd());
    } else {
      parts.push(text);
      lines.push(parts.join(" "));
      parts = [];
    }
  }
  if (parts.length > 0) lines.push(parts.join(" "));
  return lines;
}
