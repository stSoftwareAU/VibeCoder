/**
 * Repository language detection library.
 *
 * Detects programming languages and frameworks used in a repository
 * by inspecting marker files (via GitHub Contents API) and supplementary
 * language byte-count data (via GitHub Languages API).
 *
 * Issue #1391: Create language detection library for repository language analysis.
 */

import type { Result } from "../types.ts";
import { spawnGh } from "./gh_spawn.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Options for language detection. */
export interface LanguageDetectorOptions {
  /** Override for command execution (useful for testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
}

/** Information about a single detected language. */
export interface LanguageInfo {
  /** Language or framework name (e.g. "Rust", "Deno", "Node"). */
  language: string;
  /** How the language was detected. */
  confidence: "marker" | "api";
  /** The file that triggered detection (marker-based only). */
  markerFile?: string;
}

/**
 * Optional marker-file metadata for the best-practices bucket picker
 * (Issue #2144).
 *
 * The GitHub Languages API does not surface React-vs-plain-TypeScript or
 * framework/IaC buckets (GitHub Actions, CloudFormation, Terraform) on its
 * own, so callers may attach this richer metadata when they want the
 * picker to consider those buckets. All fields are optional and additive;
 * downstream code that doesn't populate them sees no behavioural change.
 */
export interface BestPracticesMarkers {
  /** True if `package.json` declares a React dependency
   * (`react`, `react-dom`, `@types/react`, …). */
  hasReactDependency?: boolean;
  /** True if at least one `.jsx` or `.tsx` file exists in the repo. */
  hasJsxFiles?: boolean;
  /** Total byte count of `.github/workflows/*.yml` / `*.yaml` files. */
  githubActionsBytes?: number;
  /** Total byte count of detected AWS CloudFormation template files. */
  cloudFormationBytes?: number;
  /** Total byte count of `*.tf` Terraform files. */
  terraformBytes?: number;
}

/** Aggregated language information for a repository. */
export interface RepoLanguages {
  /** All detected languages, marker-based first. */
  detected: LanguageInfo[];
  /** Primary language determined by highest API byte count or first detected. */
  primary: string;
  /** Raw byte counts from the GitHub Languages API. */
  raw: Record<string, number>;
  /**
   * Optional marker-file metadata for the best-practices bucket picker
   * (Issue #2144). Populated by the language detector when callers request
   * the richer scan; absent otherwise.
   */
  bestPracticesMarkers?: BestPracticesMarkers;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create the default command runner.
 *
 * Issue #1378: this module only ever runs `gh`, so the runner is the shared
 * chokepoint (`spawnGh`) rather than a `Deno.Command` built from `cmd[0]` —
 * an indirection that skipped the write-repo allowlist and the audit journal
 * while the quality gate's literal-string scan saw nothing. Any other binary
 * is refused loudly rather than spawned outside the chokepoint.
 */
function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  const env = ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : undefined;
  return async (cmd: string[]): Promise<CommandOutput> => {
    if (cmd[0] !== "gh") {
      throw new Error(
        `language_detector only spawns gh through the chokepoint; ` +
          `refusing to run "${cmd[0] ?? ""}"`,
      );
    }
    const result = await spawnGh(cmd.slice(1), env ? { env } : {});
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  };
}

/** File entry from GitHub Contents API. */
interface ContentEntry {
  name: string;
  type: string;
}

/** Fetch the root-level file listing for a repository. */
async function fetchRootContents(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
): Promise<Result<ContentEntry[], string>> {
  const result = await runner([
    "gh",
    "api",
    `repos/${repo}/contents/`,
  ]);

  if (!result.success) {
    return {
      ok: false,
      error: `Failed to fetch repository contents: ${result.stderr}`,
    };
  }

  try {
    const entries = JSON.parse(result.stdout) as ContentEntry[];
    return { ok: true, value: entries };
  } catch {
    return { ok: false, error: `Failed to parse repository contents response` };
  }
}

/** Fetch byte-count language data from the GitHub Languages API. */
async function fetchLanguagesApi(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
): Promise<Result<Record<string, number>, string>> {
  const result = await runner([
    "gh",
    "api",
    `repos/${repo}/languages`,
  ]);

  if (!result.success) {
    return {
      ok: false,
      error: `Failed to fetch repository languages: ${result.stderr}`,
    };
  }

  try {
    const data = JSON.parse(result.stdout) as Record<string, number>;
    return { ok: true, value: data };
  } catch {
    return {
      ok: false,
      error: `Failed to parse repository languages response`,
    };
  }
}

/** Check whether the file list contains a file matching the given name. */
function hasFile(entries: ContentEntry[], name: string): boolean {
  return entries.some((e) => e.name === name);
}

/** Check whether any file ends with the given extension. */
function hasFileWithExtension(entries: ContentEntry[], ext: string): boolean {
  return entries.some((e) => e.name.endsWith(ext));
}

/**
 * Detect languages from marker files in the repository root.
 *
 * Order matters: Deno is checked before Node so that repos with both
 * `deno.json` and `package.json` are correctly identified as Deno projects.
 */
function detectFromMarkers(entries: ContentEntry[]): LanguageInfo[] {
  const detected: LanguageInfo[] = [];

  // Rust
  if (hasFile(entries, "Cargo.toml")) {
    detected.push({
      language: "Rust",
      confidence: "marker",
      markerFile: "Cargo.toml",
    });
  }

  // Deno (check deno.json and deno.jsonc)
  const hasDeno = hasFile(entries, "deno.json") ||
    hasFile(entries, "deno.jsonc");
  if (hasDeno) {
    const markerFile = hasFile(entries, "deno.json")
      ? "deno.json"
      : "deno.jsonc";
    detected.push({ language: "Deno", confidence: "marker", markerFile });
  }

  // Node — only if package.json exists WITHOUT a Deno config
  if (!hasDeno && hasFile(entries, "package.json")) {
    detected.push({
      language: "Node",
      confidence: "marker",
      markerFile: "package.json",
    });
  }

  // Java (pom.xml, build.gradle, build.gradle.kts)
  const javaMarkers: string[] = ["pom.xml", "build.gradle", "build.gradle.kts"];
  for (const marker of javaMarkers) {
    if (hasFile(entries, marker)) {
      detected.push({
        language: "Java",
        confidence: "marker",
        markerFile: marker,
      });
      break; // Only add Java once
    }
  }

  // Bash — any .sh file in root
  if (hasFileWithExtension(entries, ".sh")) {
    detected.push({ language: "Bash", confidence: "marker" });
  }

  // React/Web — index.html with at least one .css or .js file
  if (hasFile(entries, "index.html")) {
    const hasWebAssets = hasFileWithExtension(entries, ".css") ||
      hasFileWithExtension(entries, ".js");
    if (hasWebAssets) {
      detected.push({
        language: "React/Web",
        confidence: "marker",
        markerFile: "index.html",
      });
    }
  }

  return detected;
}

/**
 * Determine the primary language from API byte counts, falling back to the
 * first marker-detected language.
 */
function determinePrimary(
  detected: LanguageInfo[],
  raw: Record<string, number>,
): string {
  // Use the language with the highest byte count from the API
  const entries = Object.entries(raw);
  entries.sort((a, b) => b[1] - a[1]);
  const topEntry = entries[0];
  if (topEntry !== undefined) {
    return topEntry[0];
  }

  // Fall back to first detected language
  const first = detected[0];
  if (first !== undefined) {
    return first.language;
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect what programming languages and frameworks are used in a repository.
 *
 * Inspects marker files in the repository root (e.g. Cargo.toml, deno.json)
 * and supplements with byte-count data from the GitHub Languages API.
 *
 * @param repo - Repository in "owner/repo" format.
 * @param options - Optional configuration for command execution and gh identity.
 * @returns Result containing detected languages or an error message.
 */
export async function detectRepoLanguages(
  repo: string,
  options: LanguageDetectorOptions = {},
): Promise<Result<RepoLanguages, string>> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);

  // Fetch root contents and language API data in parallel
  const [contentsResult, languagesResult] = await Promise.all([
    fetchRootContents(repo, runner),
    fetchLanguagesApi(repo, runner),
  ]);

  if (!contentsResult.ok) {
    return { ok: false, error: contentsResult.error };
  }

  if (!languagesResult.ok) {
    return { ok: false, error: languagesResult.error };
  }

  const entries = contentsResult.value;
  const raw = languagesResult.value;

  // Detect from marker files
  const detected = detectFromMarkers(entries);

  // Add API-only languages that were not already detected via markers
  const markerLanguageNames = new Set(detected.map((d) => d.language));
  for (const apiLang of Object.keys(raw)) {
    if (!markerLanguageNames.has(apiLang)) {
      detected.push({ language: apiLang, confidence: "api" });
    }
  }

  const primary = determinePrimary(detected, raw);

  return {
    ok: true,
    value: { detected, primary, raw },
  };
}
