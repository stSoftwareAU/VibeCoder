/**
 * Conditional screenshot/Playwright stripping for prompt templates
 * (Issues #377, #3812).
 *
 * A repository configured with `skip_screenshot_check` must not be told to
 * produce screenshot evidence it cannot produce. Stripping used to be
 * line-anchored on literal template prose, so a template reword silently
 * disabled a rule and left orphaned continuation lines behind. Rules are now
 * named and exported so a drift test can assert every one of them still fires
 * against the latest template, and blocks are removed whole — a matched line
 * plus its indented continuation lines.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * A named conditional-strip rule.
 *
 * `matches()` exists so tests can fail loudly when a template reword stops a
 * rule matching, instead of the rule quietly becoming dead code.
 */
export interface StripRule {
  /** Stable id, used in drift-test failure messages. */
  readonly id: string;
  /** Whether the rule still matches anything in `text`. */
  matches(text: string): boolean;
  /** Apply the rule, returning the rewritten text. */
  apply(text: string): string;
}

/** Leading-space count of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Remove each matched line together with its continuation lines — the
 * following lines indented more deeply than the match, including blank lines
 * that are themselves followed by a more-indented line.
 *
 * @param replacement - Optional line emitted in place of the removed block.
 */
function applyBlockRule(
  text: string,
  match: (line: string) => boolean,
  replacement?: string,
): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    if (!match(current)) {
      output.push(current);
      continue;
    }
    if (replacement !== undefined) output.push(replacement);

    const indent = indentOf(current);
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (line.trim() === "") {
        const next = lines[end + 1];
        // A blank line continues the block only when the block does.
        if (!next || next.trim() === "" || indentOf(next) <= indent) break;
        end++;
        continue;
      }
      if (indentOf(line) <= indent) break;
      end++;
    }
    i = end - 1;
  }

  return output.join("\n");
}

/** A rule that removes a matched line and its indented continuation lines. */
function blockRule(
  id: string,
  match: (line: string) => boolean,
  replacement?: string,
): StripRule {
  return {
    id,
    matches: (text) => text.split("\n").some(match),
    apply: (text) => applyBlockRule(text, match, replacement),
  };
}

/** A rule that rewrites a matched span of text. */
function textRule(id: string, pattern: RegExp, replacement: string): StripRule {
  return {
    id,
    matches: (text) => pattern.test(text),
    apply: (text) => text.replace(pattern, replacement),
  };
}

/** A rule that removes a heading and everything up to the next `## ` heading. */
function sectionRule(id: string, heading: string): StripRule {
  const startsSection = (line: string) => line.startsWith(heading);
  return {
    id,
    matches: (text) => text.split("\n").some(startsSection),
    apply: (text) => {
      const output: string[] = [];
      let skip = false;
      for (const line of text.split("\n")) {
        if (startsSection(line)) {
          skip = true;
          continue;
        }
        if (skip && line.startsWith("## ")) skip = false;
        if (skip) continue;
        output.push(line);
      }
      return output.join("\n");
    },
  };
}

/**
 * Evidence line substituted into the worked PR-summary example when
 * screenshots are stripped (Issue #3812, Gap 6).
 *
 * Deleting the example's only Evidence line left the one worked example
 * modelling an empty Evidence section — the opposite of what the surrounding
 * instructions require. A non-screenshot evidence line keeps the example
 * honest for a repository that has no UI to capture.
 */
const NON_SCREENSHOT_EVIDENCE_EXAMPLE =
  "Backend-only change — no web interface to screenshot. Verified by the unit " +
  "tests listed below.";

/**
 * Rules stripping screenshot mandates from the issue template.
 *
 * Every rule is asserted to still match the latest `prompts/issue/vN.md` by
 * `prompt_strip_drift_test.ts`, so a template reword fails a test rather than
 * silently leaving a screenshot mandate in a no-UI repository's prompt.
 */
export const SCREENSHOT_STRIP_RULES: readonly StripRule[] = [
  // Anchor on the stable `- **UI Changes**:` key, not the prose after it.
  blockRule("ui-changes-bullet", (l) => l.startsWith("- **UI Changes**:")),
  blockRule(
    "pr-summary-evidence",
    (l) => l.includes("For UI changes: Include a screenshot"),
  ),
  // Matched on the bullet heading alone (Issue #4364): the wording after it
  // changed when the escape hatch was removed, and the whole numbered block
  // (heading plus its indented continuation lines) is what must go.
  blockRule(
    "error-recovery-screenshot",
    (l) => l.includes("**Screenshot failures**"),
  ),
  blockRule(
    "worked-example-evidence",
    (l) => l.includes("![Screenshot of fixed buttons]"),
    NON_SCREENSHOT_EVIDENCE_EXAMPLE,
  ),
];

/**
 * Rules stripping Playwright guidance from the coding guidelines.
 *
 * Removing the `### Playwright MCP` subsection alone orphaned every reference
 * to it elsewhere in the guidelines (Issue #3812, Gap 4), so those references
 * are removed with it.
 */
export const PLAYWRIGHT_STRIP_RULES: readonly StripRule[] = [
  sectionRule("playwright-subsection", "### Playwright MCP"),
  textRule(
    "available-tools-intro",
    /Use the container's headless browser \(Playwright MCP\) when the change alters[\s\S]*?not for backend-only work\.\s*/,
    "",
  ),
  // Issue #4070: the sandboxed-environment section points at the headless
  // browser tooling, so it orphans the same way the intro sentence did when
  // the subsection goes. The rest of that section — unattended execution, no
  // host GUI, never wait on an operator — applies to every repository and
  // stays.
  textRule(
    "sandbox-browser-tooling",
    /\*\*Browser work runs in the container\.\*\*[\s\S]*?\n\n/,
    "",
  ),
  textRule(
    "cypress-source-of-truth",
    /\s*—\s*Playwright MCP is the source of truth for screenshots\./,
    ".",
  ),
  textRule(
    "image-provenance-carve-out",
    /\*\*Provenance carve-out:\*\*[\s\S]*?\n\n/,
    "",
  ),
];

/** Apply every rule in order. */
function applyRules(text: string, rules: readonly StripRule[]): string {
  return rules.reduce((acc, rule) => rule.apply(acc), text);
}

/**
 * Strip screenshot instructions from an issue template (Issue #377).
 *
 * @param template - The template text to strip
 * @returns Stripped template text
 */
export function stripScreenshotInstructions(template: string): string {
  return applyRules(template, SCREENSHOT_STRIP_RULES);
}

/**
 * Strip the Playwright MCP subsection — and its orphaned references — from the
 * coding guidelines (Issues #377, #3812).
 *
 * @param text - The guidelines text
 * @returns Stripped text
 */
export function stripPlaywrightSection(text: string): string {
  return applyRules(text, PLAYWRIGHT_STRIP_RULES);
}
