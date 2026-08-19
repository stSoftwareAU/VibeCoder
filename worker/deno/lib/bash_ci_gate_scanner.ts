/**
 * Native bash CI-gate detector (Issue #3236, layer 1 of #3223).
 *
 * Bash has no compile step, so an invalid bash script can regress into a
 * repository with no quality gate catching it (the FLEET regression that
 * motivated #3223). This module is the deterministic, Deno-native,
 * network-free **detection core**: given a cloned repo it reports whether
 * the repository's CI blocks PRs on invalid bash across **two independent
 * gates**, mirroring how `linter_in_ci_check.ts` treats linter and compile
 * as separate gates:
 *
 *   1. **`bash -n` / `sh -n`** — a syntax check over the repo's bash
 *      scripts.
 *   2. **`shellcheck`** — a static-analysis lint gate.
 *
 * The two gates are checked independently and reported per-gate. This
 * module does NOT file issues and does NOT execute any script — it is
 * static inspection only (the idle-task template that consumes it is a
 * sibling sub-issue).
 *
 * Detection rules:
 *
 *   - **Script discovery.** Bash scripts are found by `*.sh` / `*.bash`
 *     extension PLUS shebang detection (`#!.../bash`, `#!.../sh`,
 *     `#!/usr/bin/env bash`), excluding vendored / build directories
 *     (`node_modules/`, `vendor/`, `third_party/`, `.git/`, `dist/`,
 *     `build/`, …).
 *   - **CI detection.** `.github/workflows/*.{yml,yaml}` are parsed
 *     in-process with `@std/yaml` (via `readWorkflowFiles`); each
 *     workflow `run:` step is searched for (a) a `bash -n` / `sh -n`
 *     invocation and (b) a `shellcheck` invocation. A step that runs a
 *     **committed gate script** (e.g. `quality/shellcheck.sh`,
 *     `quality/bash_syntax.sh`, `./quality.sh`) also counts as the gate:
 *     the referenced script's committed contents are inspected for the
 *     gate invocation, so the raw `bash -n` / `shellcheck` string need not
 *     appear inline in the workflow YAML.
 *   - **Fail-safe.** A repo with **no bash scripts** yields no finding
 *     (the gate status is *not applicable*, not *missing*). A repo with
 *     **zero loaded workflows** (#2881) or an **unparseable workflow**
 *     degrades the affected gate to *unknown*, never a false *missing*.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { readWorkflowFiles } from "./workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Status of a single CI gate.
 *
 *   - `"present"` — the gate is invoked in CI (inline or via a committed
 *     gate script).
 *   - `"missing"` — workflows are present and parseable but no invocation
 *     of the gate was found. Only this status justifies filing a finding.
 *   - `"unknown"` — the gate status could not be confirmed (no workflows
 *     loaded, or a workflow failed to parse). Never file off `"unknown"`.
 */
export type BashGateStatus = "present" | "missing" | "unknown";

/** Per-gate detection outcome for a repository's bash CI gates. */
export interface BashCiGateResult {
  /**
   * True iff the repository contains at least one bash script. When
   * `false` the gate check is **not applicable** — the consumer must
   * file no finding (mirrors the zero-workflow fail-safe, #2881).
   */
  applicable: boolean;
  /** Number of bash scripts discovered (0 when `applicable` is false). */
  scriptCount: number;
  /**
   * True iff BOTH gates are `"present"`. Only meaningful when
   * `applicable` is true; always `false` otherwise.
   */
  configured: boolean;
  /** Per-gate status. */
  gates: {
    /** `bash -n` / `sh -n` syntax gate. */
    syntax: BashGateStatus;
    /** `shellcheck` lint gate. */
    shellcheck: BashGateStatus;
  };
  /**
   * Fail-safe flag (#2881). `false` iff **zero** workflow files were
   * loaded under `.github/workflows/`. When `false` both gate statuses
   * are `"unknown"` and the consumer must NOT file a "missing gate"
   * finding.
   */
  workflowsLoaded: boolean;
  /**
   * One paragraph suitable for direct use in a GitHub issue body: what
   * was found / what is missing, why it matters, and a concrete
   * suggested invocation for each missing gate.
   */
  details: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Directories never descended into during script discovery. */
const SKIP_DIRECTORIES = new Set<string>([
  ".git",
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  ".venv",
  "_site",
]);

/** Extensions that unambiguously mark a bash script. */
const BASH_EXTENSIONS = [".sh", ".bash"];

/**
 * Extensions that can never carry a bash shebang — skipped when reading
 * first lines for shebang detection, to bound IO on large repos.
 */
const SHEBANG_SKIP_EXTENSIONS = new Set<string>([
  ".md",
  ".markdown",
  ".json",
  ".jsonc",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".yml",
  ".yaml",
  ".txt",
  ".lock",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".map",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".toml",
  ".rs",
  ".java",
  ".go",
  ".py",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cpp",
]);

/** A bash/sh shebang on the first line of a file. */
const BASH_SHEBANG = /^#!.*\b(?:ba)?sh\b/;

/** `bash -n` / `sh -n` invocation (optionally with intervening flags). */
const SYNTAX_GATE = /\b(?:ba)?sh\s+(?:-\S+\s+)*-n\b/;

/** A `shellcheck` invocation. */
const SHELLCHECK_GATE = /\bshellcheck\b/;

/** A committed shell-script reference (e.g. `./quality.sh`, `quality/x.sh`). */
const SCRIPT_REFERENCE = /(?:\.?\/)?[\w./-]+\.(?:sh|bash)\b/g;

/** Cap the depth of committed-gate-script inspection to bound IO/recursion. */
const MAX_SCRIPT_INSPECTION = 64;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the bash CI-gate posture of the repository checked out at
 * `repoPath`. Pure, network-free, static inspection — no script is
 * executed.
 */
export async function checkBashCiGates(
  repoPath: string,
): Promise<BashCiGateResult> {
  const scripts = await discoverBashScripts(repoPath);

  if (scripts.length === 0) {
    // No bash scripts → the gate check is not applicable. No finding.
    return {
      applicable: false,
      scriptCount: 0,
      configured: false,
      gates: { syntax: "unknown", shellcheck: "unknown" },
      workflowsLoaded: false,
      details:
        "No bash scripts (`*.sh` / `*.bash` or bash-shebang files) were " +
        "found in the repository, so bash CI gates are not applicable. " +
        "No action required.",
    };
  }

  const workflows = await readWorkflowFiles(repoPath);
  const workflowsLoaded = workflows.length > 0;
  // A workflow that failed to parse (`parsed === null`) means we cannot
  // reliably enumerate its steps — degrade any un-found gate to unknown
  // rather than assert a false "missing".
  const parseFailure = workflows.some((w) => w.parsed === null);

  // Build the search corpus: every workflow `run:` step, plus the
  // committed contents of any gate scripts those steps invoke.
  const runBlob = collectRunStrings(workflows).join("\n");
  const scriptBlob = await inspectReferencedScripts(repoPath, runBlob);
  const corpus = `${runBlob}\n${scriptBlob}`;

  const syntaxPresent = SYNTAX_GATE.test(corpus);
  const shellcheckPresent = SHELLCHECK_GATE.test(corpus);

  const undetermined = !workflowsLoaded || parseFailure;
  const syntax = resolveGate(syntaxPresent, undetermined);
  const shellcheck = resolveGate(shellcheckPresent, undetermined);

  const configured = syntax === "present" && shellcheck === "present";

  return {
    applicable: true,
    scriptCount: scripts.length,
    configured,
    gates: { syntax, shellcheck },
    workflowsLoaded,
    details: buildDetails({
      scriptCount: scripts.length,
      syntax,
      shellcheck,
      workflowsLoaded,
      parseFailure,
    }),
  };
}

// ---------------------------------------------------------------------------
// Script discovery
// ---------------------------------------------------------------------------

/**
 * Recursively discover bash scripts under `repoPath` by extension
 * (`*.sh` / `*.bash`) and by bash shebang, skipping vendored / build
 * directories. Returns repo-relative paths, sorted for determinism.
 */
export async function discoverBashScripts(
  repoPath: string,
): Promise<string[]> {
  const found: string[] = [];
  await walkForScripts(repoPath, "", found);
  found.sort();
  return found;
}

async function walkForScripts(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(absDir);
  } catch {
    return;
  }
  for await (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absPath = `${absDir}/${entry.name}`;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await walkForScripts(absPath, relPath, acc);
    } else if (entry.isFile) {
      if (await isBashScript(entry.name, absPath)) acc.push(relPath);
    }
  }
}

/** Is `fileName` (at `absPath`) a bash script by extension or shebang? */
async function isBashScript(
  fileName: string,
  absPath: string,
): Promise<boolean> {
  const lower = fileName.toLowerCase();
  if (BASH_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  const ext = extensionOf(lower);
  if (ext !== null && SHEBANG_SKIP_EXTENSIONS.has(ext)) return false;
  return await hasBashShebang(absPath);
}

/** The lowercased extension of `name` (incl. dot), or `null` if none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no dot, or leading-dot dotfile
  return name.slice(dot);
}

/** Read the first line of `absPath` and test for a bash/sh shebang. */
async function hasBashShebang(absPath: string): Promise<boolean> {
  let firstLine: string;
  try {
    firstLine = await readFirstLine(absPath);
  } catch {
    return false;
  }
  return BASH_SHEBANG.test(firstLine);
}

/** Read up to the first newline (or 256 bytes) of a file. */
async function readFirstLine(absPath: string): Promise<string> {
  const file = await Deno.open(absPath, { read: true });
  try {
    const buf = new Uint8Array(256);
    const n = await file.read(buf);
    if (n === null) return "";
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      buf.subarray(0, n),
    );
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------
// Workflow run-step collection
// ---------------------------------------------------------------------------

/**
 * Collect every `run:` string value anywhere in the parsed workflow /
 * composite-action structures. A deep walk covers both the workflow
 * (`jobs.<id>.steps[].run`) and composite-action (`runs.steps[].run`)
 * shapes without special-casing either.
 */
export function collectRunStrings(
  workflows: ReadonlyArray<{ parsed: unknown }>,
): string[] {
  const out: string[] = [];
  for (const wf of workflows) {
    collectRunFrom(wf.parsed, out);
  }
  return out;
}

function collectRunFrom(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRunFrom(item, acc);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "run" && typeof value === "string") acc.push(value);
      else collectRunFrom(value, acc);
    }
  }
}

// ---------------------------------------------------------------------------
// Committed-gate-script inspection
// ---------------------------------------------------------------------------

/**
 * Given the concatenated workflow `run:` text, resolve every committed
 * shell-script it references, read those scripts (and any scripts they in
 * turn reference, bounded by {@link MAX_SCRIPT_INSPECTION}), and return
 * their concatenated contents. This lets a workflow that delegates to a
 * committed gate script (e.g. `./quality.sh` which itself runs
 * `shellcheck`) satisfy the gate without the raw string appearing inline.
 */
async function inspectReferencedScripts(
  repoPath: string,
  runBlob: string,
): Promise<string> {
  const queue = extractScriptReferences(runBlob);
  const visited = new Set<string>();
  const contents: string[] = [];

  while (queue.length > 0 && visited.size < MAX_SCRIPT_INSPECTION) {
    const ref = queue.shift();
    if (ref === undefined) break;
    const rel = normaliseScriptRef(ref);
    if (rel === null || visited.has(rel)) continue;
    visited.add(rel);

    let text: string;
    try {
      text = await Deno.readTextFile(`${repoPath}/${rel}`);
    } catch {
      continue; // Unreadable reference — skip (never assert missing off it).
    }
    contents.push(text);
    // A gate script may delegate further (e.g. quality.sh → shellcheck.sh).
    for (const next of extractScriptReferences(text)) {
      const nrel = normaliseScriptRef(next);
      if (nrel !== null && !visited.has(nrel)) queue.push(next);
    }
  }
  return contents.join("\n");
}

/** Extract shell-script path tokens from arbitrary text. */
function extractScriptReferences(text: string): string[] {
  const matches = text.match(SCRIPT_REFERENCE);
  return matches ?? [];
}

/**
 * Normalise a script reference to a repo-relative path, or `null` when it
 * escapes the repo (absolute path, or a `..` traversal). Leading `./` is
 * stripped.
 */
function normaliseScriptRef(ref: string): string | null {
  let rel = ref.trim();
  if (rel.startsWith("/")) return null; // absolute — outside the clone
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (rel === "" || rel.split("/").includes("..")) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function resolveGate(present: boolean, undetermined: boolean): BashGateStatus {
  if (present) return "present";
  return undetermined ? "unknown" : "missing";
}

function buildDetails(args: {
  scriptCount: number;
  syntax: BashGateStatus;
  shellcheck: BashGateStatus;
  workflowsLoaded: boolean;
  parseFailure: boolean;
}): string {
  const { scriptCount, syntax, shellcheck, workflowsLoaded, parseFailure } =
    args;
  const scriptWord = scriptCount === 1 ? "script" : "scripts";
  const lead = `${scriptCount} bash ${scriptWord} were discovered. `;

  if (syntax === "present" && shellcheck === "present") {
    return (
      lead +
      "Both a `bash -n` / `sh -n` syntax gate and a `shellcheck` gate are " +
      "invoked by CI (inline or via a committed gate script), so invalid " +
      "bash cannot regress unnoticed. No action required."
    );
  }

  if (!workflowsLoaded) {
    return (
      lead +
      "No GitHub Actions workflows were found under `.github/workflows/`, " +
      "so the bash CI-gate status is unknown — the `bash -n` and " +
      "`shellcheck` gates cannot be confirmed. This is not treated as a " +
      "confirmed-missing gate."
    );
  }

  const parts: string[] = [];
  parts.push(describeGate("syntax", syntax));
  parts.push(describeGate("shellcheck", shellcheck));

  const tail = parseFailure
    ? " (Note: at least one workflow failed to parse, so gates not found " +
      "there are reported as unknown rather than missing.)"
    : "";

  return lead + parts.join(" ") + tail;
}

function describeGate(
  gate: "syntax" | "shellcheck",
  status: BashGateStatus,
): string {
  if (gate === "syntax") {
    switch (status) {
      case "present":
        return "The `bash -n` / `sh -n` syntax gate is invoked in CI.";
      case "unknown":
        return "The `bash -n` / `sh -n` syntax gate status is unknown.";
      case "missing":
        return (
          "No `bash -n` / `sh -n` syntax gate is invoked in CI — invalid " +
          "bash can land on the default branch because bash has no compile " +
          "step. Add a CI step that runs `bash -n` over every script (e.g. " +
          "`find . -name '*.sh' -not -path './node_modules/*' -exec bash -n " +
          "{} +`), or invoke a committed gate script such as " +
          "`quality/bash_syntax.sh`."
        );
    }
  }
  switch (status) {
    case "present":
      return "The `shellcheck` gate is invoked in CI.";
    case "unknown":
      return "The `shellcheck` gate status is unknown.";
    case "missing":
      return (
        "No `shellcheck` gate is invoked in CI — common bash mistakes " +
        "(unquoted expansions, undefined variables) go uncaught. Add a CI " +
        "step that runs `shellcheck` over the repo's scripts (blocking at " +
        "error severity at rollout), e.g. `shellcheck **/*.sh`, or invoke a " +
        "committed gate script such as `quality/shellcheck.sh`."
      );
  }
}
