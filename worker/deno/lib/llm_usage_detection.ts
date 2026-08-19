/**
 * Shared LLM-usage detection (Issues #3013, #3014, parent #3009).
 *
 * Decides whether a repository is an **LLM-using** repo — one that talks
 * to a Large Language Model in code — so the `security_scan` prompt can
 * apply the OWASP GenAI / LLM Top 10 (2025) classes to it. The same
 * mechanism is shared by the precision-first generic gate (#3014); there
 * is exactly **one** detection rule, not two.
 *
 * Detection is **precision-first**: a repo is flagged only on a concrete
 * integration signal in code or dependency manifests, never on prose,
 * naming, READMEs, docs, examples, or comparison files. Absence of a
 * signal means "not LLM-using" (skip on absence).
 *
 * Two signal tiers (from the parent #3009 recommendation):
 *
 * - **Primary** — a declared LLM client SDK dependency in a manifest /
 *   import map (e.g. `@anthropic-ai/sdk`, `openai`, `@google/genai`,
 *   `cohere-ai`, `@mistralai/*`, `langchain` / `@langchain/*`,
 *   `llamaindex`; Python `anthropic`, `openai`, `google-generativeai`,
 *   `litellm`; the Claude Agent SDK), **or** an AI coding-agent action
 *   invoked from a GitHub Actions workflow
 *   (`anthropics/claude-code-action`, Copilot, Gemini CLI — the
 *   agentic-workflow signal, Issue #3313). The latter closes the gap
 *   where a repo whose *only* LLM surface is an issue-triggered agent
 *   action was misclassified as not LLM-using, so the OWASP LLM01
 *   prompt-injection class was wrongly skipped for exactly the repos most
 *   at risk of a GitLost-style attack.
 * - **Secondary** — a live LLM API host, endpoint path, or model id in
 *   source (`api.anthropic.com`, `api.openai.com`,
 *   `generativelanguage.googleapis.com`, `/v1/messages`,
 *   `/v1/chat/completions`, or model ids `claude-*`, `gpt-4*`,
 *   `gemini-*`).
 *
 * VibeCoder self-identifies under this rule (no hardcoded repo name): it
 * references `api.anthropic.com` / `/v1/messages` and `claude-*` model
 * ids in `worker/deno/lib/` source.
 *
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

import {
  readWorkflowFiles,
  type WorkflowFile,
} from "./workflow_scan_common.ts";
import { isAiAction, normaliseUses } from "./ai_action_identifiers.ts";

/** One concrete signal that a repo uses an LLM. */
export interface LlmUsageSignal {
  /** Which tier of evidence matched. */
  tier: "primary" | "secondary";
  /** Human-readable description of the matched pattern. */
  pattern: string;
  /**
   * Where the signal was found: a dependency specifier (primary) or a
   * `file:line` citation (secondary).
   */
  evidence: string;
}

/** The detection verdict for a repository. */
export interface LlmUsageVerdict {
  /** True when at least one primary or secondary signal matched. */
  isLlmUsing: boolean;
  /** Every signal found, primary first then secondary. */
  signals: LlmUsageSignal[];
}

/** A source file gathered for secondary-signal scanning. */
export interface SourceFile {
  /** Repo-relative path, e.g. `worker/deno/lib/batch_api.ts`. */
  path: string;
  /** File contents. */
  content: string;
}

/**
 * Primary signal — declared LLM client SDK package names. A dependency
 * matches when its (registry-prefix-stripped, version-stripped) package
 * name equals one of these or sits under a scoped family listed here.
 */
export const LLM_SDK_PACKAGES: readonly string[] = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-code",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "@mistralai/mistralai",
  "langchain",
  "@langchain/core",
  "llamaindex",
  "litellm",
  "anthropic",
  "google-generativeai",
];

/** Scoped families where any sub-package counts as a primary signal. */
const LLM_SDK_SCOPES: readonly string[] = [
  "@langchain/",
  "@mistralai/",
];

/** Secondary signal — live LLM API host / endpoint / model-id patterns. */
export const LLM_API_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: "Anthropic API host", re: /api\.anthropic\.com/ },
  { label: "OpenAI API host", re: /api\.openai\.com/ },
  {
    label: "Google Generative Language host",
    re: /generativelanguage\.googleapis\.com/,
  },
  { label: "Messages API endpoint", re: /\/v1\/messages\b/ },
  { label: "Chat-completions endpoint", re: /\/v1\/chat\/completions\b/ },
  { label: "Claude model id", re: /\bclaude-(?:opus|sonnet|haiku|instant|\d)/ },
  { label: "GPT-4 model id", re: /\bgpt-4/ },
  { label: "Gemini model id", re: /\bgemini-(?:pro|flash|ultra|nano|\d)/ },
];

/**
 * Normalise a dependency specifier to a bare package name.
 *
 * Strips a leading registry prefix (`npm:`, `jsr:`) and any version /
 * range suffix, preserving the scope of scoped packages. Examples:
 * `npm:openai@^4` → `openai`, `@anthropic-ai/sdk@1.2.3` →
 * `@anthropic-ai/sdk`, `anthropic==0.39.0` → `anthropic`.
 */
export function normaliseDependencyName(specifier: string): string {
  let name = specifier.trim();
  // Strip a registry prefix (npm:, jsr:, https: never a package name).
  const prefixMatch = name.match(/^(npm|jsr):(.*)$/);
  if (prefixMatch) name = prefixMatch[2]!;
  // Python-style version pins (anthropic==0.39, openai>=1.0, foo~=2).
  name = name.replace(/\s*(==|>=|<=|~=|!=|>|<).*$/, "");
  // Trim quotes / whitespace left by manifest parsing.
  name = name.replace(/^["']|["']$/g, "").trim();
  // Strip an npm version suffix: the LAST '@' that is not the leading
  // scope '@' separates name from version.
  const at = name.lastIndexOf("@");
  if (at > 0) name = name.slice(0, at);
  return name;
}

/** True when a bare package name is a known LLM client SDK. */
function isLlmSdk(packageName: string): boolean {
  if (LLM_SDK_PACKAGES.includes(packageName)) return true;
  return LLM_SDK_SCOPES.some((scope) => packageName.startsWith(scope));
}

/**
 * Match primary (dependency) signals from a set of dependency specifiers.
 */
export function matchPrimarySignals(
  dependencies: Iterable<string>,
): LlmUsageSignal[] {
  const signals: LlmUsageSignal[] = [];
  const seen = new Set<string>();
  for (const specifier of dependencies) {
    const name = normaliseDependencyName(specifier);
    if (!name || seen.has(name)) continue;
    if (isLlmSdk(name)) {
      seen.add(name);
      signals.push({
        tier: "primary",
        pattern: `LLM client SDK dependency: ${name}`,
        evidence: specifier.trim(),
      });
    }
  }
  return signals;
}

/**
 * Match secondary (source) signals in a single file's content. Reports at
 * most one citation per pattern per file (KISS — the first occurrence is
 * enough evidence).
 */
export function matchSecondarySignals(
  path: string,
  content: string,
): LlmUsageSignal[] {
  const signals: LlmUsageSignal[] = [];
  for (const { label, re } of LLM_API_PATTERNS) {
    const m = re.exec(content);
    if (!m) continue;
    const line = content.slice(0, m.index).split("\n").length;
    signals.push({
      tier: "secondary",
      pattern: label,
      evidence: `${path}:${line}`,
    });
  }
  return signals;
}

/**
 * Pure classifier: decide LLM-usage from already-gathered dependencies
 * and source files. Exposed so callers (and the sibling #3014 gate) can
 * reuse the rule without re-walking the filesystem.
 */
export function classifyLlmUsage(
  dependencies: Iterable<string>,
  sources: Iterable<SourceFile>,
): LlmUsageVerdict {
  const signals = matchPrimarySignals(dependencies);
  for (const { path, content } of sources) {
    signals.push(...matchSecondarySignals(path, content));
  }
  return { isLlmUsing: signals.length > 0, signals };
}

/**
 * Match agentic-workflow (primary) signals: an AI coding-agent action
 * invoked from a GitHub Actions workflow or composite action (Issue
 * #3313). Scans raw `uses:` lines so it is robust to a workflow that
 * does not parse as YAML.
 *
 * At most one signal per (file, agent-action slug) pair — a workflow that
 * calls the same agent in several jobs yields one signal, not many. Pure
 * — no I/O; callers pass already-read workflow files.
 */
export function matchAgenticWorkflowSignals(
  files: Iterable<Pick<WorkflowFile, "path" | "rawText">>,
): LlmUsageSignal[] {
  const signals: LlmUsageSignal[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const lines = file.rawText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/(?:^|\s)uses:\s*(\S+)/);
      if (!m) continue;
      const uses = m[1]!;
      if (!isAiAction(uses)) continue;
      const slug = normaliseUses(uses);
      const key = `${file.path}::${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        tier: "primary",
        pattern: `Agentic GitHub Actions workflow (AI agent action): ${slug}`,
        evidence: `${file.path}:${i + 1}`,
      });
    }
  }
  return signals;
}

/**
 * Read a repo's workflow and composite-action files and return the
 * agentic-workflow signals they carry. Best-effort: an unreadable
 * `.github` tree yields no signals rather than throwing.
 */
async function detectAgenticWorkflowSignals(
  repoRoot: string,
): Promise<LlmUsageSignal[]> {
  let files: WorkflowFile[];
  try {
    files = await readWorkflowFiles(repoRoot);
  } catch {
    return [];
  }
  return matchAgenticWorkflowSignals(files);
}

/** Directory names never scanned for secondary signals. */
const EXCLUDED_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "coverage",
  ".claude",
  // `docs/`, READMEs, and examples are prose — explicitly ignored so a
  // mention there never flags a non-LLM repo (precision-first).
  "docs",
  "examples",
  "example",
]);

/** Source extensions scanned for secondary signals (code, not prose). */
const SOURCE_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".cs",
  ".kt",
]);

/** Manifest files parsed for primary (dependency) signals. */
const MANIFEST_FILES: readonly string[] = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
];

const MAX_FILE_BYTES = 512 * 1024;

/** Options for {@link detectLlmUsage}. */
export interface DetectLlmUsageOptions {
  /**
   * Repo-relative path of the detection module itself, skipped so its
   * own pattern table is never counted as a signal. Defaults to the
   * canonical location.
   */
  selfPath?: string;
}

/**
 * Walk a cloned repository and decide whether it is LLM-using.
 *
 * Reads root + nested manifests for primary signals and scans source
 * files (excluding prose / vendored / build directories) for secondary
 * signals, then applies {@link classifyLlmUsage}. Static only — it reads
 * files, never executes repo code.
 */
export async function detectLlmUsage(
  repoRoot: string,
  opts: DetectLlmUsageOptions = {},
): Promise<LlmUsageVerdict> {
  const selfPath = opts.selfPath ??
    "worker/deno/lib/llm_usage_detection.ts";
  const dependencies: string[] = [];
  const sources: SourceFile[] = [];

  await walk(repoRoot, "", { dependencies, sources, selfPath });

  const verdict = classifyLlmUsage(dependencies, sources);

  // Agentic-workflow signal (Issue #3313): an AI coding-agent action in a
  // workflow is an LLM surface even when no SDK dependency or API host
  // appears in source. Insert its (primary) signals ahead of any
  // secondary signals so the "primary first" ordering holds.
  const agentic = await detectAgenticWorkflowSignals(repoRoot);
  if (agentic.length === 0) return verdict;
  const primaries = verdict.signals.filter((s) => s.tier === "primary");
  const secondaries = verdict.signals.filter((s) => s.tier === "secondary");
  const signals = [...primaries, ...agentic, ...secondaries];
  return { isLlmUsing: signals.length > 0, signals };
}

/**
 * Repositories always audited against the OWASP GenAI / LLM Top 10,
 * regardless of detected signals — the **always-on allowlist floor**
 * (Issue #3014). This is the single, authoritative floor shared with the
 * `security_scan` prompt gate: there is one floor, not two. Kept
 * deliberately narrow (precision-first) — VibeCoder only, "until we work
 * out a better way" — never broadened to a heuristic.
 */
export const LLM_AUDIT_ALLOWLIST: readonly string[] = [
  "stSoftwareAU/VibeCoder",
];

/** Case-insensitive membership test for the always-on LLM-audit floor. */
export function isLlmAuditAllowlisted(repo: string): boolean {
  const norm = repo.trim().toLowerCase();
  return LLM_AUDIT_ALLOWLIST.some((r) => r.toLowerCase() === norm);
}

/**
 * Repo-aware detection with the always-on allowlist floor applied.
 *
 * An allowlisted repo (VibeCoder) is **always** LLM-using regardless of
 * signals — the floor signal is prepended and any genuine signals found by
 * {@link detectLlmUsage} are preserved after it. Every other repo follows
 * the precision-first signal rule unchanged (skip on absence).
 *
 * This is the entry point the `security_scanner.ts` gate consumes: it
 * takes the `owner/repo` plus the clone root and returns the verdict that
 * decides whether the prompt's LLM Top 10 taxonomy applies.
 */
export async function detectLlmUsageForRepo(
  repo: string,
  repoRoot: string,
  opts: DetectLlmUsageOptions = {},
): Promise<LlmUsageVerdict> {
  const verdict = await detectLlmUsage(repoRoot, opts);
  if (!isLlmAuditAllowlisted(repo)) return verdict;
  const floor: LlmUsageSignal = {
    tier: "primary",
    pattern: "Always-on allowlist floor",
    evidence: repo.trim(),
  };
  return { isLlmUsing: true, signals: [floor, ...verdict.signals] };
}

interface WalkAcc {
  dependencies: string[];
  sources: SourceFile[];
  selfPath: string;
}

async function walk(
  absDir: string,
  relDir: string,
  acc: WalkAcc,
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(absDir)) entries.push(entry);
  } catch {
    return; // unreadable directory — skip
  }

  for (const entry of entries) {
    const absPath = `${absDir}/${entry.name}`;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(absPath, relPath, acc);
      continue;
    }
    if (!entry.isFile) continue;
    if (relPath === acc.selfPath) continue;

    if (MANIFEST_FILES.includes(entry.name)) {
      await readManifest(absPath, acc.dependencies);
    }

    const dot = entry.name.lastIndexOf(".");
    const ext = dot >= 0 ? entry.name.slice(dot) : "";
    if (SOURCE_EXTENSIONS.has(ext)) {
      const content = await readBounded(absPath);
      if (content !== null) acc.sources.push({ path: relPath, content });
    }
  }
}

/** Read a file, returning null when missing or larger than the cap. */
async function readBounded(absPath: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return await Deno.readTextFile(absPath);
  } catch {
    return null;
  }
}

/**
 * Extract dependency package names from a manifest. Best-effort: JSON
 * manifests are parsed for dependency maps; other manifests are scanned
 * line-by-line. A parse failure contributes nothing rather than throwing.
 */
async function readManifest(
  absPath: string,
  out: string[],
): Promise<void> {
  const content = await readBounded(absPath);
  if (content === null) return;
  const lower = absPath.toLowerCase();

  if (lower.endsWith("package.json")) {
    extractJsonDeps(content, out, [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]);
  } else if (lower.endsWith("deno.json") || lower.endsWith("deno.jsonc")) {
    extractDenoImports(content, out);
  } else {
    // requirements.txt / pyproject.toml / Cargo.toml — scan each line for
    // a bare package name at the start.
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^["']?([@A-Za-z0-9._/-]+)["']?\s*(=|==|>=|<=)?/);
      if (m) out.push(m[1]!);
    }
  }
}

/** Pull every key from the named dependency maps of a package.json. */
function extractJsonDeps(
  content: string,
  out: string[],
  keys: readonly string[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  for (const key of keys) {
    const map = record[key];
    if (typeof map === "object" && map !== null) {
      for (const dep of Object.keys(map as Record<string, unknown>)) {
        out.push(dep);
      }
    }
  }
}

/** Pull import specifiers from a deno.json(c) `imports` map. */
function extractDenoImports(content: string, out: string[]): void {
  // Strip // line comments so JSONC parses as JSON (block comments are
  // rare in deno.json import maps — KISS).
  const stripped = content.replace(/^\s*\/\/.*$/gm, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const imports = (parsed as Record<string, unknown>).imports;
  if (typeof imports !== "object" || imports === null) return;
  for (const value of Object.values(imports as Record<string, unknown>)) {
    if (typeof value === "string") out.push(value);
  }
}
