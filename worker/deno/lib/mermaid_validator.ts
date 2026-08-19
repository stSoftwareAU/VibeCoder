/**
 * Mermaid gitGraph syntax validation (Issue #525, #914).
 *
 * Validates Mermaid gitGraph blocks in markdown documentation.
 * Ensures documentation diagrams are well-formed with valid commands.
 *
 * Migrated from worker/shared/mermaid_validator.sh.
 *
 * Also provides a lightweight sequenceDiagram validator that catches the
 * common publishing failure where an unescaped `;` inside a message text is
 * interpreted by Mermaid's parser as a statement separator (Issue #1663).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Valid gitGraph commands (after the initial "gitGraph" declaration). */
const VALID_COMMANDS_RE = /^(commit|branch|checkout|merge|cherry-pick)([\s]|$)/;

/** Comment pattern (%% ...). */
const COMMENT_RE = /^%%/;

/** gitGraph declaration pattern (with optional LR/TB direction). */
const GITGRAPH_DECL_RE = /^gitGraph([\s]|$)/;

/**
 * Validation result containing error details.
 */
export interface GitGraphValidationResult {
  /** Whether the block is valid. */
  valid: boolean;
  /** Error message if invalid. */
  error?: string;
}

/**
 * Validate a Mermaid gitGraph block.
 *
 * Checks that:
 * - Block is non-empty
 * - First line starts with "gitGraph" (with optional direction options)
 * - All non-empty, non-comment lines contain valid commands
 * - At least one commit is present
 *
 * @param block - The gitGraph block text to validate
 * @returns Validation result with error details if invalid
 */
export function validateGitgraphSyntax(
  block: string,
): GitGraphValidationResult {
  if (!block || !block.trim()) {
    return { valid: false, error: "Empty gitGraph block" };
  }

  const lines = block.split("\n");
  const firstLine = (lines[0] ?? "").trim();

  if (!GITGRAPH_DECL_RE.test(firstLine)) {
    return {
      valid: false,
      error: `Block must start with 'gitGraph', got: ${firstLine}`,
    };
  }

  let hasCommit = false;

  for (let i = 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();

    // Skip empty lines and comments
    if (!trimmed || COMMENT_RE.test(trimmed)) {
      continue;
    }

    // Check for valid commands
    if (VALID_COMMANDS_RE.test(trimmed)) {
      if (trimmed.startsWith("commit")) {
        hasCommit = true;
      }
      continue;
    }

    return {
      valid: false,
      error: `Invalid gitGraph command on line ${i + 1}: ${trimmed}`,
    };
  }

  if (!hasCommit) {
    return {
      valid: false,
      error: "gitGraph block must contain at least one commit",
    };
  }

  return { valid: true };
}

/**
 * Extract gitGraph blocks from markdown content.
 *
 * Scans for ```mermaid fenced code blocks that contain gitGraph
 * declarations and returns each block's content.
 *
 * @param content - The markdown content to scan
 * @returns Array of gitGraph block strings
 */
export function extractGitgraphBlocks(content: string): string[] {
  const blocks: string[] = [];
  const lines = content.split("\n");

  let inMermaid = false;
  let inGitgraph = false;
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (inMermaid) {
      if (/^\s*```\s*$/.test(line)) {
        // End of mermaid block
        if (inGitgraph && currentBlock.length > 0) {
          blocks.push(currentBlock.join("\n"));
        }
        inMermaid = false;
        inGitgraph = false;
        currentBlock = [];
      } else {
        const trimmed = line.trimStart();
        if (currentBlock.length === 0 && trimmed.startsWith("gitGraph")) {
          inGitgraph = true;
        }
        if (inGitgraph) {
          currentBlock.push(line);
        }
      }
    } else if (/^\s*```mermaid\s*$/.test(line)) {
      inMermaid = true;
      currentBlock = [];
      inGitgraph = false;
    }
  }

  return blocks;
}

/**
 * Extract and validate all gitGraph blocks from a file.
 *
 * Reads a markdown file, extracts gitGraph blocks, and validates each one.
 *
 * @param filePath - Path to the markdown file
 * @returns Result with array of validation results, or error
 */
export async function validateGitgraphFile(
  filePath: string,
): Promise<Result<GitGraphValidationResult[]>> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch {
    return {
      ok: false,
      error: new Error(`File not found: ${filePath}`),
    };
  }

  const blocks = extractGitgraphBlocks(content);
  const results = blocks.map((block) => validateGitgraphSyntax(block));
  return { ok: true, value: results };
}

/** sequenceDiagram declaration pattern. */
const SEQDIAG_DECL_RE = /^sequenceDiagram(\s|$)/;

/**
 * Mermaid sequenceDiagram reserved keywords. A participant whose ID matches
 * any of these (case-insensitively) collides with the parser's keyword set
 * and breaks rendering — for example, naming a participant `Loop` makes
 * Mermaid interpret the next `Loop->>...` line as the start of a
 * `loop ... end` block (Issue #1989).
 *
 * Sourced from the Mermaid grammar; the alias after `as` is display text and
 * is exempt, so this set is only checked against the participant identifier
 * itself.
 */
const SEQDIAG_RESERVED_KEYWORDS = new Set<string>([
  "participant",
  "actor",
  "as",
  "box",
  "autonumber",
  "loop",
  "end",
  "alt",
  "else",
  "opt",
  "par",
  "and",
  "rect",
  "critical",
  "option",
  "break",
  "note",
  "over",
  "of",
  "activate",
  "deactivate",
  "links",
  "link",
  "properties",
  "details",
  "title",
]);

/**
 * Match a `participant <ID>[ as <label>]` or `actor <ID>[ as <label>]`
 * declaration. The capture group is the participant ID.
 */
const SEQDIAG_PARTICIPANT_RE =
  /^\s*(?:participant|actor)\s+([A-Za-z_][\w-]*)(?:\s+as\b.*)?\s*$/;

/**
 * Lines inside a sequenceDiagram that carry user-supplied text after a colon.
 * These are the lines whose tail is parsed by Mermaid as statement-terminated
 * text — an unescaped `;` here breaks the parse.
 *
 * Covers message arrows (->>, -->>, ->, -->, -x, --x, -), and Note lines.
 */
const SEQDIAG_MESSAGE_RE =
  /^\s*(?:[A-Za-z_][\w-]*\s*(?:->>?|-->?>?|-[xX]|--[xX])\s*[A-Za-z_][\w-]*|Note\s+(?:left of|right of|over)\s+[^:]+):\s*(.*)$/;

/**
 * Validate a Mermaid sequenceDiagram block.
 *
 * Catches the common authoring mistake where a message text contains an
 * unescaped `;`. Mermaid treats `;` as a statement separator regardless of
 * surrounding parentheses or HTML tags, so `TL;DR` in a message is a parse
 * error even though it is fine inside a flowchart node label like `["TL;DR"]`.
 *
 * Note: this does NOT exhaustively validate sequenceDiagram syntax — it only
 * catches the specific class of failure that broke the published page in
 * Issue #1663. Authors should still rely on Mermaid itself for full
 * validation.
 *
 * @param block - The sequenceDiagram block text to validate
 * @returns Validation result with error details if invalid
 */
export function validateSequenceDiagramSyntax(
  block: string,
): GitGraphValidationResult {
  if (!block || !block.trim()) {
    return { valid: false, error: "Empty sequenceDiagram block" };
  }

  const lines = block.split("\n");
  const firstLine = (lines[0] ?? "").trim();

  if (!SEQDIAG_DECL_RE.test(firstLine)) {
    return {
      valid: false,
      error: `Block must start with 'sequenceDiagram', got: ${firstLine}`,
    };
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Reserved-keyword participant detection (Issue #1989).
    const participantMatch = SEQDIAG_PARTICIPANT_RE.exec(line);
    if (participantMatch) {
      const id = participantMatch[1]!;
      if (SEQDIAG_RESERVED_KEYWORDS.has(id.toLowerCase())) {
        return {
          valid: false,
          error:
            `Line ${i + 1}: participant ID '${id}' collides with a Mermaid ` +
            `reserved keyword (case-insensitive). Rename the participant ` +
            `(e.g. 'Main', 'Worker', 'Driver') so Mermaid does not parse ` +
            `subsequent statements as '${id.toLowerCase()} ... end' blocks. ` +
            `Offending line: ${line.trim()}`,
        };
      }
    }

    const match = SEQDIAG_MESSAGE_RE.exec(line);
    if (!match) continue;
    const message = match[1] ?? "";
    if (message.includes(";")) {
      return {
        valid: false,
        error:
          `Line ${i + 1}: message text contains unescaped ';' which Mermaid ` +
          `parses as a statement separator. Replace ';' with ',' or ' — ' ` +
          `(or remove it). Offending line: ${line.trim()}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Extract Mermaid blocks from markdown content matching a given declaration.
 *
 * Generic version of extractGitgraphBlocks that accepts any leading keyword
 * (e.g. `sequenceDiagram`, `flowchart`, `gitGraph`).
 *
 * @param content - The markdown content to scan
 * @param declaration - The Mermaid diagram keyword (matched at the start of
 *   the first non-blank line of each block, allowing trailing options)
 * @returns Array of block strings
 */
export function extractMermaidBlocksByType(
  content: string,
  declaration: string,
): string[] {
  const blocks: string[] = [];
  const lines = content.split("\n");
  // Avoid dynamic RegExp — use a simple prefix+boundary check instead.
  const isDeclarationLine = (line: string): boolean => {
    if (!line.startsWith(declaration)) return false;
    const rest = line.slice(declaration.length);
    return rest === "" || rest[0] === " " || rest[0] === "\t";
  };

  let inMermaid = false;
  let inTarget = false;
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (inMermaid) {
      if (/^\s*```\s*$/.test(line)) {
        if (inTarget && currentBlock.length > 0) {
          blocks.push(currentBlock.join("\n"));
        }
        inMermaid = false;
        inTarget = false;
        currentBlock = [];
      } else {
        const trimmed = line.trimStart();
        if (currentBlock.length === 0 && isDeclarationLine(trimmed)) {
          inTarget = true;
        }
        if (inTarget) {
          currentBlock.push(line);
        }
      }
    } else if (/^\s*```mermaid\s*$/.test(line)) {
      inMermaid = true;
      currentBlock = [];
      inTarget = false;
    }
  }

  return blocks;
}

/**
 * Extract sequenceDiagram blocks from markdown content.
 */
export function extractSequenceDiagramBlocks(content: string): string[] {
  return extractMermaidBlocksByType(content, "sequenceDiagram");
}

/**
 * Extract and validate all sequenceDiagram blocks from a file.
 *
 * @param filePath - Path to the markdown file
 * @returns Result with array of validation results, or error
 */
export async function validateSequenceDiagramFile(
  filePath: string,
): Promise<Result<GitGraphValidationResult[]>> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch {
    return {
      ok: false,
      error: new Error(`File not found: ${filePath}`),
    };
  }

  const blocks = extractSequenceDiagramBlocks(content);
  const results = blocks.map((block) => validateSequenceDiagramSyntax(block));
  return { ok: true, value: results };
}

/**
 * A Mermaid block extracted from markdown, with diagram type and source location.
 *
 * Used by the repo-wide quality gate (Issue #1683) so failures can be
 * reported with file path, opening-fence line number, and diagram type.
 */
export interface MermaidBlock {
  /** Diagram declaration keyword from the first non-blank line (e.g. "flowchart"). */
  type: string;
  /** Block content between the ```mermaid fences (excluding the fences). */
  content: string;
  /** 1-indexed line number of the opening ```mermaid fence in the source file. */
  startLine: number;
}

/**
 * Extract every Mermaid block from markdown content with line numbers.
 *
 * Captures one entry per ```mermaid ... ``` fenced block, including the
 * declaration type read from the block's first non-blank line. Empty
 * blocks have an empty `type` and `content`.
 */
export function extractMermaidBlocks(content: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const lines = content.split("\n");

  let inMermaid = false;
  let blockStartLine = 0;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inMermaid) {
      if (/^\s*```\s*$/.test(line)) {
        // Find the first non-blank, non-directive line as the declaration.
        // Mermaid permits `%%{init: ... }%%` config directives ahead of
        // the actual diagram keyword.
        const firstReal = blockLines.find((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("%%");
        }) ?? "";
        const type = firstReal.trim().split(/\s+/)[0] ?? "";
        blocks.push({
          type,
          content: blockLines.join("\n"),
          startLine: blockStartLine,
        });
        inMermaid = false;
        blockLines = [];
      } else {
        blockLines.push(line);
      }
    } else if (/^\s*```mermaid\s*$/.test(line)) {
      inMermaid = true;
      blockStartLine = i + 1;
      blockLines = [];
    }
  }

  return blocks;
}

/**
 * Validate a Mermaid block of any supported type.
 *
 * Routes to the dedicated validator when one exists:
 *   - `gitGraph`         → `validateGitgraphSyntax`
 *   - `sequenceDiagram`  → `validateSequenceDiagramSyntax`
 *
 * For any other diagram declaration (`flowchart`, `graph`, `classDiagram`,
 * `stateDiagram`, etc.), applies a minimum-sanity check that catches the
 * obviously-malformed cases the issue calls out:
 *   - Missing or unknown declaration line.
 *   - Empty body after the declaration line.
 *   - Unmatched `{` `}`, `[` `]`, or `(` `)`. Characters inside
 *     double-quoted node labels and `%%` comment lines are excluded so
 *     legitimate constructs like `A["foo (bar)"]` are accepted.
 *
 * Note: this is not a full Mermaid parser. It is a fast, low-false-positive
 * gate that catches the regression class described in Issue #1683 — broken
 * diagrams shipping into published Markdown — without requiring a Node
 * toolchain in the quality gate.
 */
export function validateMermaidBlock(
  block: MermaidBlock,
): GitGraphValidationResult {
  if (!block.content.trim()) {
    return { valid: false, error: "Empty mermaid block" };
  }
  // Strip leading blank lines and `%%`-prefixed config directives
  // (e.g. `%%{init: ...}%%`) before handing off to validators that
  // expect the diagram declaration on the first line.
  const stripped = stripLeadingDirectives(block.content);
  switch (block.type) {
    case "gitGraph":
      return validateGitgraphSyntax(stripped);
    case "sequenceDiagram":
      return validateSequenceDiagramSyntax(stripped);
    default:
      return validateGenericMermaidBlock({ ...block, content: stripped });
  }
}

/**
 * Drop blank lines and `%%`-prefixed comment/directive lines from the start
 * of a Mermaid block so the declaration line is the first remaining line.
 */
function stripLeadingDirectives(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = (lines[i] ?? "").trim();
    if (t === "" || t.startsWith("%%")) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

/** Mermaid declarations the generic validator recognises. */
const KNOWN_GENERIC_DIAGRAM_TYPES = new Set([
  "flowchart",
  "graph",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "mindmap",
  "timeline",
  "quadrantChart",
  "xychart-beta",
  "block-beta",
  "sankey-beta",
  "packet-beta",
  "zenuml",
  "info",
]);

/**
 * Minimum-sanity validator for Mermaid blocks without a dedicated validator.
 *
 * Exported for direct testing. Most callers should use `validateMermaidBlock`,
 * which routes by diagram type.
 */
export function validateGenericMermaidBlock(
  block: MermaidBlock,
): GitGraphValidationResult {
  if (!block.type) {
    return { valid: false, error: "Mermaid block has no declaration line" };
  }
  if (!KNOWN_GENERIC_DIAGRAM_TYPES.has(block.type)) {
    return {
      valid: false,
      error: `Unknown Mermaid diagram type: ${block.type}`,
    };
  }

  const lines = block.content.split("\n");
  const declIdx = lines.findIndex((l) => l.trim() !== "");
  const body = lines.slice(declIdx + 1).join("\n").trim();
  if (!body) {
    return { valid: false, error: `Empty ${block.type} body` };
  }

  // Count brackets outside double-quoted strings and `%%` comments.
  // Quotes are tracked per-line (mermaid does not allow multi-line strings).
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  for (const line of lines) {
    if (line.trim().startsWith("%%")) continue;
    let inString = false;
    for (const ch of line) {
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      switch (ch) {
        case "{":
          brace++;
          break;
        case "}":
          brace--;
          break;
        case "[":
          bracket++;
          break;
        case "]":
          bracket--;
          break;
        case "(":
          paren++;
          break;
        case ")":
          paren--;
          break;
      }
    }
  }

  if (brace !== 0) {
    return {
      valid: false,
      error: `Unmatched braces in ${block.type} block (delta ${brace})`,
    };
  }
  if (bracket !== 0) {
    return {
      valid: false,
      error: `Unmatched brackets in ${block.type} block (delta ${bracket})`,
    };
  }
  if (paren !== 0) {
    return {
      valid: false,
      error: `Unmatched parentheses in ${block.type} block (delta ${paren})`,
    };
  }

  return { valid: true };
}

/**
 * A single failed Mermaid block in a markdown file.
 *
 * Carries enough context (file path, opening-fence line, diagram type, error)
 * for the quality gate to produce an actionable error message.
 */
export interface MermaidFileFailure {
  /** Path to the offending file (caller-supplied; usually repo-relative). */
  file: string;
  /** 1-indexed line number of the opening ```mermaid fence. */
  startLine: number;
  /** Diagram declaration type (or empty string when missing). */
  type: string;
  /** Validator error message. */
  error: string;
}

/**
 * Validate every Mermaid block in a markdown file.
 *
 * Returns the list of failing blocks (empty array on success). The `file`
 * field on each failure echoes the path the caller supplied — pass a
 * repo-relative path here and the gate reports it verbatim.
 */
export async function validateMermaidFile(
  filePath: string,
  reportedPath: string = filePath,
): Promise<Result<MermaidFileFailure[]>> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Could not read ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  const failures: MermaidFileFailure[] = [];
  for (const block of extractMermaidBlocks(content)) {
    const result = validateMermaidBlock(block);
    if (!result.valid) {
      failures.push({
        file: reportedPath,
        startLine: block.startLine,
        type: block.type,
        error: result.error ?? "unknown validation error",
      });
    }
  }
  return { ok: true, value: failures };
}
