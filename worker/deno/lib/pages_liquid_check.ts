/**
 * Quality gate check: published Markdown files parse as valid Liquid (Issue #1601).
 *
 * Catches the class of regression that broke the GitHub Pages build in
 * Issue #1599: literal `{% ... %}` or `{{ ... }}` in published Markdown
 * prose (AGENTS.md, README.md, SECURITY.md, docs/**\/*.md) that Liquid
 * tries to interpret as template tags.
 *
 * The Pages build pre-processes every published Markdown body via
 * `.github/scripts/wrap_pr_summary_raw.rb` (called from
 * `.github/scripts/inject_page_metadata.rb`), which wraps the body in a
 * `{% raw %} ... {% endraw %}` block — but only when no inline raw
 * markers already exist (Liquid does not support nested raw blocks).
 * This check replicates that preprocessing in TypeScript and then asks
 * a Ruby + Liquid toolchain to parse the resulting content. Files that
 * already contain inline `{% raw %}` markers must balance their own
 * Liquid syntax; this is exactly the case that broke in #1599.
 *
 * The Liquid parser is invoked out-of-process because parsing must
 * exactly match what Jekyll does in production. When Ruby + Liquid is
 * not installed locally the check returns SKIPPED, so contributors
 * without the Pages toolchain are not blocked. `./quality.sh --strict`
 * promotes SKIPPED to FAILED so CI catches missing toolchains.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single Liquid syntax failure. */
export interface PagesLiquidError {
  /** Repo-relative path to the offending file. */
  file: string;
  /** Liquid error message (typically includes the line number). */
  message: string;
}

/** Status of the pages-liquid check. */
export type PagesLiquidStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Structured result of running the pages-liquid check. */
export interface PagesLiquidCheckResult {
  status: PagesLiquidStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** Files that failed Liquid parsing (only populated on FAILED). */
  errors: PagesLiquidError[];
  /** Number of files that were preprocessed and parsed. */
  filesChecked: number;
  /** Reason for SKIPPED, when applicable. */
  skipReason?: string;
}

/**
 * Set of published Markdown files mirrored from
 * `.github/scripts/inject_page_metadata.rb`. Kept in sync with the
 * `wrap_paths` list there.
 *
 * `index.md` is intentionally omitted because it is generated at build
 * time from `README.md`; checking `README.md` covers it.
 */
const ROOT_PUBLISHED_FILES = ["AGENTS.md", "README.md", "SECURITY.md"];

const MARKDOWN_EXT_PATTERN = /\.md$/;

/**
 * Split a Markdown file into [front matter (with trailing newline), body].
 *
 * Mirrors `split_front_matter` in `.github/scripts/wrap_pr_summary_raw.rb`.
 */
export function splitFrontMatter(content: string): [string, string] {
  // Match a leading "---\n...---\n" block.
  const match = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(content);
  if (!match) return ["", content];
  const end = match[0].length;
  return [content.slice(0, end), content.slice(end)];
}

/**
 * Returns true when the body already contains any inline `{% raw %}` or
 * `{% endraw %}` marker.
 *
 * Mirrors `already_wrapped?` in
 * `.github/scripts/wrap_pr_summary_raw.rb`. Liquid does not support
 * nested raw blocks, so files with inline raw markers must balance
 * their own Liquid syntax.
 */
export function alreadyWrapped(body: string): boolean {
  return body.includes("{% raw %}") || body.includes("{% endraw %}");
}

/**
 * Wrap `body` in `{% raw %} ... {% endraw %}` on their own lines.
 *
 * Mirrors `wrap_body` in `.github/scripts/wrap_pr_summary_raw.rb`.
 */
export function wrapBody(body: string): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\n+$/, "");
  return `{% raw %}\n${trimmed}\n{% endraw %}\n`;
}

/**
 * Apply the full Pages preprocessing pipeline to a Markdown file's content.
 *
 * Equivalent to running `wrap_pr_summary_raw.rb` over the file: front
 * matter is preserved, the body is wrapped in a raw block when no
 * inline raw markers are present, and otherwise left alone.
 *
 * Idempotent — running it twice on the same content is a no-op.
 */
export function preprocessForLiquid(content: string): string {
  const [front, body] = splitFrontMatter(content);
  if (alreadyWrapped(body)) return content;
  return front + wrapBody(body);
}

/**
 * Discover the published Markdown files that the Pages workflow wraps.
 *
 * Returns repo-relative paths, sorted, matching the set processed by
 * `inject_page_metadata.rb`'s `wrap_paths`.
 */
export async function collectPublishedMarkdownFiles(
  scriptDir: string,
): Promise<string[]> {
  const files: string[] = [];

  for (const name of ROOT_PUBLISHED_FILES) {
    const path = `${scriptDir}/${name}`;
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) files.push(name);
    } catch {
      // missing file — silently skip (matches Ruby behaviour)
    }
  }

  const docsDir = `${scriptDir}/docs`;
  try {
    const stat = await Deno.stat(docsDir);
    if (stat.isDirectory) {
      await collectMarkdownInDir(docsDir, "docs", files);
    }
  } catch {
    // no docs directory — nothing to add
  }

  return files.sort();
}

async function collectMarkdownInDir(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(absDir)) {
    const absPath = `${absDir}/${entry.name}`;
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectMarkdownInDir(absPath, relPath, acc);
    } else if (entry.isFile && MARKDOWN_EXT_PATTERN.test(entry.name)) {
      acc.push(relPath);
    }
  }
}

/**
 * Function that parses preprocessed-content snippets via Liquid.
 *
 * Returns one error per failing file (empty array when all pass). Input
 * tuples carry the repo-relative path (for error reporting) and the
 * already-preprocessed content.
 */
export type LiquidParser = (
  files: Array<{ path: string; content: string }>,
) => Promise<PagesLiquidError[]>;

/** Factory that resolves a Liquid parser, or null if no toolchain is available. */
export type DetectLiquidParser = (
  scriptDir: string,
) => Promise<LiquidParser | null>;

/**
 * Detect a working `ruby -rliquid` invocation and return a parser that
 * uses it, or null when no toolchain is available.
 *
 * Tries `bundle exec ruby` first (so the project's Gemfile.lock pin is
 * honoured) and falls back to plain `ruby` if Liquid is installed
 * system-wide.
 */
export const detectLiquidParser: DetectLiquidParser = async (
  scriptDir: string,
): Promise<LiquidParser | null> => {
  const candidates: string[][] = [
    ["bundle", "exec", "ruby"],
    ["ruby"],
  ];

  for (const cmd of candidates) {
    if (await canRunLiquid(cmd, scriptDir)) {
      return makeRubyLiquidParser(cmd, scriptDir);
    }
  }
  return null;
};

async function canRunLiquid(
  cmd: string[],
  scriptDir: string,
): Promise<boolean> {
  try {
    const command = new Deno.Command(cmd[0]!, {
      args: [...cmd.slice(1), "-rliquid", "-e", "exit 0"],
      cwd: scriptDir,
      stdout: "null",
      stderr: "null",
    });
    const result = await command.output();
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Build a LiquidParser that drives Ruby out-of-process.
 *
 * Writes each preprocessed file to a unique temp file, then runs a
 * single Ruby process that parses each one via Liquid. Using a temp
 * directory rather than passing content through argv avoids any
 * argv length / binary-byte limits.
 */
function makeRubyLiquidParser(cmd: string[], scriptDir: string): LiquidParser {
  // Driver expects:
  //   ARGV[0]  = path to a manifest file
  // Manifest format: one record per line, "<temp path>|<repo-relative path>".
  // Pipe is unlikely to appear in either path; we additionally insist that
  // the temp file path comes first so it is unambiguous on the receiving
  // side. The manifest never contains Markdown content directly.
  const driver = [
    "require 'liquid'",
    "manifest = ARGV[0]",
    "fail_count = 0",
    "File.foreach(manifest) do |line|",
    "  line = line.chomp",
    "  next if line.empty?",
    "  temp_path, rel_path = line.split('|', 2)",
    "  begin",
    "    Liquid::Template.parse(File.read(temp_path))",
    "  rescue Liquid::SyntaxError => e",
    "    msg = e.message.to_s.gsub(/\\s+/, ' ').strip",
    '    $stdout.puts "ERR\\t#{rel_path}\\t#{msg}"',
    "    fail_count += 1",
    "  end",
    "end",
    "exit(fail_count.zero? ? 0 : 1)",
  ].join("\n");

  return async (files: Array<{ path: string; content: string }>) => {
    if (files.length === 0) return [];

    const tempDir = await Deno.makeTempDir({ prefix: "pages_liquid_" });
    try {
      const manifestLines: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const tempPath = `${tempDir}/file_${i}.md`;
        await Deno.writeTextFile(tempPath, file.content);
        manifestLines.push(`${tempPath}|${file.path}`);
      }
      const manifestPath = `${tempDir}/manifest.txt`;
      await Deno.writeTextFile(manifestPath, manifestLines.join("\n") + "\n");

      const command = new Deno.Command(cmd[0]!, {
        args: [...cmd.slice(1), "-e", driver, "--", manifestPath],
        cwd: scriptDir,
        stdout: "piped",
        stderr: "piped",
      });

      const output = await command.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);

      const errors: PagesLiquidError[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("ERR\t")) continue;
        const parts = line.split("\t");
        if (parts.length >= 3) {
          errors.push({
            file: parts[1]!,
            message: parts.slice(2).join("\t"),
          });
        }
      }

      // If Ruby died with a non-zero exit code but produced no parsed
      // ERR lines, surface stderr as a single synthetic error so the
      // failure does not silently disappear.
      if (!output.success && errors.length === 0) {
        errors.push({
          file: "<ruby driver>",
          message: stderr.trim() || `ruby exited with code ${output.code}`,
        });
      }

      return errors;
    } finally {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    }
  };
}

/** Options for runPagesLiquidCheck (mostly for testing). */
export interface PagesLiquidCheckOptions {
  /**
   * Inject a custom toolchain detector. The default uses Ruby + Liquid
   * via `bundle exec` or system `ruby`.
   *
   * Returning null forces the SKIPPED path.
   */
  detectParser?: DetectLiquidParser;
  /** Override the file list (relative to scriptDir). Defaults to auto-discovery. */
  files?: string[];
}

/**
 * Run the pages-liquid quality check.
 *
 * Pipeline:
 *   1. Discover published Markdown files (or use the override).
 *   2. Detect a Ruby + Liquid toolchain. If unavailable → SKIPPED.
 *   3. Apply `preprocessForLiquid` (the same wrap step Pages uses) to
 *      every file's content in memory.
 *   4. Parse each preprocessed body with Liquid.
 *   5. Report PASSED, FAILED (with per-file errors), or SKIPPED.
 */
export async function runPagesLiquidCheck(
  scriptDir: string,
  options: PagesLiquidCheckOptions = {},
): Promise<PagesLiquidCheckResult> {
  const detect = options.detectParser ?? detectLiquidParser;
  const files = options.files ?? await collectPublishedMarkdownFiles(scriptDir);

  if (files.length === 0) {
    return {
      status: "SKIPPED",
      output: "pages-liquid: SKIPPED (no published Markdown files found)",
      errors: [],
      filesChecked: 0,
      skipReason: "no files",
    };
  }

  const parser = await detect(scriptDir);
  if (parser === null) {
    const reason =
      "Ruby + Liquid toolchain not available (run `bundle install` to enable)";
    return {
      status: "SKIPPED",
      output: `pages-liquid: SKIPPED (${reason})`,
      errors: [],
      filesChecked: 0,
      skipReason: reason,
    };
  }

  const inputs: Array<{ path: string; content: string }> = [];
  for (const relPath of files) {
    const absPath = `${scriptDir}/${relPath}`;
    let raw: string;
    try {
      raw = await Deno.readTextFile(absPath);
    } catch (err) {
      return {
        status: "FAILED",
        output: `pages-liquid: FAILED\nCould not read ${relPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        errors: [{ file: relPath, message: "read error" }],
        filesChecked: 0,
      };
    }
    inputs.push({ path: relPath, content: preprocessForLiquid(raw) });
  }

  const errors = await parser(inputs);

  if (errors.length === 0) {
    return {
      status: "PASSED",
      output: `pages-liquid: PASSED (${inputs.length} file(s) checked)`,
      errors: [],
      filesChecked: inputs.length,
    };
  }

  const lines = [
    `pages-liquid: FAILED (${errors.length} of ${inputs.length} file(s) failed Liquid parsing)`,
    "",
    "Files with Liquid syntax errors after Pages preprocessing:",
    ...errors.map((e) => `  ${e.file}: ${e.message}`),
    "",
    "Wrap Liquid-looking syntax in `{% raw %} ... {% endraw %}` blocks " +
    "(Issues #1575, #1599, #1600).",
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    errors,
    filesChecked: inputs.length,
  };
}
