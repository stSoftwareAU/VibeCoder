/**
 * Native gate-skip drift scanner (Issue #1597, follow-up from #1574).
 *
 * The drift it catches, in one sentence: a fleet repository's `quality.sh`
 * prints a warning and **skips** a tool when that tool is absent, while the
 * same repository's CI **installs and runs** it — so the Vibe Coder's local
 * gate goes green and the PR fails in CI. NEAT-AI-core PR 597 is the case
 * that motivated it: the local gate printed `bats not installed — skipping`
 * and CI ran all 394 BATS tests.
 *
 * #1574 enumerated those gates by hand. This module makes the enumeration
 * repeatable so the next tool a gate skips is found before a PR fails in CI.
 *
 * Design:
 *
 *   - **Deterministic and native.** No LLM, no network, no script execution
 *     — the gate script and the workflows are read as text and inspected
 *     statically.
 *   - **Fail-loud.** A gate script that exists but cannot be read, or a
 *     manifest that will not parse, surfaces as `ok: false`; absence of a
 *     failure is never reported as a clean scan.
 *   - **Fail-safe.** A repository with no `quality.sh`, or with no
 *     workflows, yields no finding rather than a false one.
 *   - **Suppression, two ways.** A tool `container/tools.json` already
 *     pins as a toolchain naming that repository is dropped (the image
 *     carries it, so the gate no longer skips), and an in-source
 *     `best-practice-ignore: BP-GATE-SKIP-<TOOL>` comment in the gate
 *     script waives it deliberately.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  isFindingSuppressed,
  readWorkflowFiles,
  type WorkflowFile,
} from "./workflow_scan_common.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "./container_manifest.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A tool the gate script skips with a warning when it is absent. */
export interface GateToolSkip {
  /** The command the gate probes for, e.g. `bats`. */
  tool: string;
  /** 1-based line of the `command -v <tool>` guard. */
  guardLine: number;
  /** 1-based line of the `echo … skipping` that announces the skip. */
  skipLine: number;
  /** The skip line as written, trimmed — the evidence a finding cites. */
  skipText: string;
}

/** How a workflow enforces a tool. */
export type CiEnforcementKind = "run" | "uses";

/** A workflow step that enforces the tool the gate skips. */
export interface CiToolEnforcement {
  /** The command the workflow runs, e.g. `bats`. */
  tool: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  file: string;
  /** 1-based line of the enforcing command / action reference. */
  line: number;
  /** The command segment (`run`) or action reference (`uses`), trimmed. */
  text: string;
  /** Whether a `run:` command or a `uses:` action does the enforcing. */
  kind: CiEnforcementKind;
  /** 1-based line of the install step, when the workflow installs it. */
  installLine: number | null;
  /** The install command as written, trimmed, or `null`. */
  installText: string | null;
}

/** One tool the gate skips and the repository's own CI enforces. */
export interface GateSkipDrift {
  /** Stable `BP-GATE-SKIP-<TOOL>` id — the suppression and dedup key. */
  findingId: string;
  /** The drifting command. */
  tool: string;
  /** Where the gate skips it. */
  skip: GateToolSkip;
  /** Where CI enforces it. */
  enforcement: CiToolEnforcement;
}

/** What a completed scan found. */
export interface GateSkipDriftValue {
  /** One entry per tool skipped locally and enforced in CI. */
  drifts: GateSkipDrift[];
  /** Every skip the gate script carries, drifting or not. */
  skips: GateToolSkip[];
  /** Skipped tools the image already carries for this repository. */
  suppressedTools: string[];
  /** Repo-relative gate script path, or `null` when the repo has none. */
  gateScriptPath: string | null;
  /** `false` when no workflow files were loaded (never a false finding). */
  workflowsLoaded: boolean;
}

/** Discriminated failure mode for the fail-loud contract. */
export interface GateSkipDriftError {
  kind: "read" | "manifest";
  message: string;
}

/** `{ ok: true } | { ok: false }` result. */
export type GateSkipDriftResult =
  | { ok: true; value: GateSkipDriftValue }
  | { ok: false; error: GateSkipDriftError };

/** Inputs for {@link scanGateSkipDrift}. */
export interface ScanGateSkipDriftOptions {
  /** Absolute path of the repository checkout to inspect. */
  repoPath: string;
  /** `owner/repo` slug, matched against each toolchain's `repos` list. */
  repo: string;
  /**
   * `container/tools.json` contents. Defaults to this repository's own
   * committed manifest — the image the fleet actually runs on.
   */
  manifestText?: string;
  /** Gate scripts to inspect, in order. Defaults to `["quality.sh"]`. */
  gateScriptNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Gate script every fleet repository is expected to commit. */
const DEFAULT_GATE_SCRIPTS: readonly string[] = ["quality.sh"];

/** `command -v <tool>` — the probe every skipping gate opens with. */
const GUARD = /command\s+-v\s+["']?([A-Za-z0-9_][A-Za-z0-9_.+-]*)["']?/;

/** An `echo` announcing that the missing tool is being skipped. */
const SKIP_ECHO = /\becho\b.*\bskip(?:ping|ped)?\b/i;

/** A hard failure inside the guard — the gate does not skip, it stops. */
const HARD_FAIL = /(?:^|[\s;&|])exit\s+[1-9]/;

/** Openers/closers used to track when the guard's block has closed. */
const BLOCK_OPEN = /(?:^|[\s;&|])(?:if|for|while|until|case)\b|;\s*then\s*$/;
const BLOCK_CLOSE = /^(?:fi|done|esac)\b/;

/** Cap on how far past a guard the scanner looks for its skip line. */
const MAX_GUARD_BLOCK_LINES = 60;

/** Package managers whose install of the tool counts as install evidence. */
const INSTALL_COMMAND =
  /\b(?:apt-get|apt|apk|brew|dnf|yum|pacman|pip|pip3|pipx|cargo|gem|go|npm|pnpm|yarn)\b[^\n]*?\b(?:install|add)\b/;

/** Shell words that precede the real command in a `run:` segment. */
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "time", "nice"]);

/**
 * A probe rather than a gate: `bats --version` in the install step proves
 * the binary landed, it does not run the suite the local gate skipped.
 */
const VERSION_PROBE = /^(?:--version|-V|--help|-h)$/;

// ---------------------------------------------------------------------------
// Gate-script inspection
// ---------------------------------------------------------------------------

/**
 * Every tool the gate script probes for and then **skips** with a warning.
 *
 * Both shapes in the fleet are recognised:
 *
 * ```bash
 * if command -v bats &>/dev/null; then bats tests/scripts
 * else echo "bats not installed — skipping"; fi
 *
 * command -v codespell >/dev/null || echo "codespell not installed — skipping"
 * ```
 *
 * A guard that **fails** instead of skipping (`exit 1` before any skip
 * echo) is not a skip and yields nothing: the gate already enforces it.
 */
export function findGateToolSkips(script: string): GateToolSkip[] {
  const lines = script.split("\n");
  const skips: GateToolSkip[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;

    const guard = GUARD.exec(trimmed);
    if (guard === null) continue;

    const tool = guard[1] as string;
    const skip = findSkipForGuard(lines, i, tool);
    if (skip === null || seen.has(tool)) continue;

    seen.add(tool);
    skips.push(skip);
  }

  return skips;
}

/**
 * Walk the guard's own block looking for the `echo … skipping` that makes
 * it a skip, stopping at a hard failure, at the next guard, or when the
 * block closes.
 */
function findSkipForGuard(
  lines: readonly string[],
  guardIndex: number,
  tool: string,
): GateToolSkip | null {
  const guardLine = lines[guardIndex] as string;
  // A bare `command -v x || echo …` guard is a single logical line; an
  // `if command -v x; then … fi` guard owns the block it opens.
  const blockMode = BLOCK_OPEN.test(guardLine.trim());
  let depth = 0;

  const last = blockMode
    ? Math.min(lines.length - 1, guardIndex + MAX_GUARD_BLOCK_LINES)
    : guardIndex;

  for (let j = guardIndex; j <= last; j++) {
    const raw = lines[j] as string;
    const trimmed = raw.trim();
    if (trimmed.startsWith("#")) continue;

    // A second guard starts a new block — this one never skipped.
    if (j > guardIndex && GUARD.test(trimmed)) return null;
    // The gate stops rather than skipping: already enforced locally.
    if (HARD_FAIL.test(trimmed)) return null;

    if (SKIP_ECHO.test(trimmed)) {
      return {
        tool,
        guardLine: guardIndex + 1,
        skipLine: j + 1,
        skipText: trimmed,
      };
    }

    if (blockMode) {
      if (BLOCK_CLOSE.test(trimmed)) {
        depth--;
        if (depth <= 0) return null;
      } else if (BLOCK_OPEN.test(trimmed)) {
        depth++;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Workflow inspection
// ---------------------------------------------------------------------------

/** A `run`/`uses` step as declared in a workflow or composite action. */
interface WorkflowStep {
  run?: string;
  uses?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `run`/`uses` step of a workflow or composite action, in order. */
function collectSteps(file: WorkflowFile): WorkflowStep[] {
  const root = file.parsed;
  if (!isRecord(root)) return [];

  const out: WorkflowStep[] = [];
  const push = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const run = typeof step.run === "string" ? step.run : undefined;
      const uses = typeof step.uses === "string" ? step.uses : undefined;
      if (run !== undefined || uses !== undefined) out.push({ run, uses });
    }
  };

  if (file.kind === "composite-action") {
    const runs = root.runs;
    if (isRecord(runs)) push(runs.steps);
    return out;
  }

  const jobs = root.jobs;
  if (!isRecord(jobs)) return out;
  for (const job of Object.values(jobs)) {
    if (isRecord(job)) push(job.steps);
  }
  return out;
}

/** Split a `run:` script into command segments, dropping comment lines. */
function commandSegments(run: string): string[] {
  const out: string[] = [];
  for (const rawLine of run.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    for (const segment of line.split(/&&|\|\||[;|]/)) {
      const command = segment.trim();
      if (command !== "") out.push(command);
    }
  }
  return out;
}

/**
 * The command a segment invokes, with any path and prefix words removed.
 * A bare version/help probe returns `null`: it proves the tool exists, it
 * does not enforce anything.
 */
function invokedCommand(segment: string): string | null {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    // Skip `FOO=bar` environment prefixes and shell keywords.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const name = token.slice(token.lastIndexOf("/") + 1);
    if (COMMAND_PREFIXES.has(name)) continue;
    const args = tokens.slice(i + 1);
    if (args.length > 0 && args.every((arg) => VERSION_PROBE.test(arg))) {
      return null;
    }
    return name;
  }
  return null;
}

/** Does this segment install `tool` (as itself or as `<tool>-…`)? */
function installsTool(segment: string, tool: string): boolean {
  if (!INSTALL_COMMAND.test(segment)) return false;
  return segment.split(/\s+/).some((token) => {
    const name = token.slice(token.lastIndexOf("/") + 1);
    return name === tool || name.startsWith(`${tool}-`);
  });
}

/**
 * Does a `uses:` action run `tool`? An action whose name carries the tool
 * (`codespell-project/actions-codespell`) runs it; a `setup-*` action only
 * puts it on the PATH for a later step, which that step's own `run` is
 * what enforces.
 */
function actionRunsTool(ref: string, tool: string): boolean {
  const path = (ref.split("@")[0] as string).toLowerCase();
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  if (lastSegment === "setup" || lastSegment.startsWith("setup-")) return false;
  return path.split(/[^a-z0-9]+/).includes(tool.toLowerCase());
}

/**
 * Best-effort 1-based line of `anchor` in the raw file, skipping lines an
 * earlier call-site already claimed. Falls back to line 1.
 */
function lineOf(
  lines: readonly string[],
  anchor: string,
  claimed: Set<number>,
): number {
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i + 1)) continue;
    if ((lines[i] as string).includes(anchor)) {
      claimed.add(i + 1);
      return i + 1;
    }
  }
  return 1;
}

/**
 * The workflow steps that enforce each of `tools` — one enforcement per
 * tool, the first found in path then step order, with the install step
 * recorded as supporting evidence when the same workflow installs it.
 */
export function findCiToolEnforcements(
  files: readonly WorkflowFile[],
  tools: readonly string[],
): CiToolEnforcement[] {
  const found = new Map<string, CiToolEnforcement>();

  for (const file of files) {
    const rawLines = file.rawText.split("\n");
    const claimed = new Set<number>();
    const steps = collectSteps(file);

    for (const tool of tools) {
      if (found.has(tool)) continue;

      let installLine: number | null = null;
      let installText: string | null = null;
      let enforcement: CiToolEnforcement | null = null;

      for (const step of steps) {
        if (step.run !== undefined) {
          for (const segment of commandSegments(step.run)) {
            if (installText === null && installsTool(segment, tool)) {
              installText = segment;
              installLine = lineOf(rawLines, segment, claimed);
            }
            if (enforcement === null && invokedCommand(segment) === tool) {
              enforcement = {
                tool,
                file: file.path,
                line: lineOf(rawLines, segment, claimed),
                text: segment,
                kind: "run",
                installLine: null,
                installText: null,
              };
            }
          }
        }
        if (
          enforcement === null && step.uses !== undefined &&
          actionRunsTool(step.uses, tool)
        ) {
          enforcement = {
            tool,
            file: file.path,
            line: lineOf(rawLines, step.uses, claimed),
            text: step.uses,
            kind: "uses",
            installLine: null,
            installText: null,
          };
        }
      }

      if (enforcement !== null) {
        found.set(tool, { ...enforcement, installLine, installText });
      }
    }
  }

  return tools
    .map((tool) => found.get(tool))
    .filter((e): e is CiToolEnforcement => e !== undefined);
}

// ---------------------------------------------------------------------------
// Manifest suppression
// ---------------------------------------------------------------------------

/**
 * The commands `container/tools.json` already bakes into the image **for
 * this repository** — a toolchain whose `repos` list names it. Those are
 * the tools the gate no longer skips, so they are never a finding.
 */
export function bakedToolsForRepo(
  manifest: ContainerManifest,
  repo: string,
): string[] {
  const wanted = repo.toLowerCase();
  const commands = new Set<string>();

  for (const toolchain of manifest.toolchains) {
    if (!toolchain.repos.some((r) => r.toLowerCase() === wanted)) continue;
    for (const command of toolchain.commands) commands.add(command);
  }

  return [...commands].sort();
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/** The stable finding id for a drifting tool. */
export function gateSkipFindingId(tool: string): string {
  return `BP-GATE-SKIP-${tool.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`;
}

/** Inputs for {@link correlateGateSkipDrift}. */
export interface CorrelateGateSkipDriftOptions {
  skips: readonly GateToolSkip[];
  enforcements: readonly CiToolEnforcement[];
  /** Commands the image already carries for the repository. */
  bakedTools: readonly string[];
  /** Gate script text and path, for in-source waiver detection. */
  gateScript?: { path: string; text: string };
}

/**
 * Pair each skip with the CI enforcement of the same tool, dropping the
 * tools the image already carries and the ones waived in source.
 */
export function correlateGateSkipDrift(
  opts: CorrelateGateSkipDriftOptions,
): GateSkipDrift[] {
  const baked = new Set(opts.bakedTools);
  const byTool = new Map(opts.enforcements.map((e) => [e.tool, e]));
  const drifts: GateSkipDrift[] = [];

  for (const skip of opts.skips) {
    if (baked.has(skip.tool)) continue;
    const enforcement = byTool.get(skip.tool);
    if (enforcement === undefined) continue;

    const findingId = gateSkipFindingId(skip.tool);
    if (
      opts.gateScript !== undefined && isFindingSuppressed(
        opts.gateScript.text,
        skip.skipLine,
        findingId,
        opts.gateScript.path,
      )
    ) {
      continue;
    }

    drifts.push({ findingId, tool: skip.tool, skip, enforcement });
  }

  return drifts;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** This repository's own committed container manifest. */
const OWN_MANIFEST = new URL("../../../container/tools.json", import.meta.url);

/**
 * Scan one repository checkout for gates that skip a tool its own CI
 * enforces. Pure static inspection — nothing is executed, nothing is
 * fetched.
 */
export async function scanGateSkipDrift(
  opts: ScanGateSkipDriftOptions,
): Promise<GateSkipDriftResult> {
  let manifest: ContainerManifest;
  try {
    const text = opts.manifestText ?? await Deno.readTextFile(OWN_MANIFEST);
    manifest = parseContainerManifest(text);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "manifest",
        message: `container/tools.json could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  let gateScript: { path: string; text: string } | null = null;
  for (const name of opts.gateScriptNames ?? DEFAULT_GATE_SCRIPTS) {
    const path = `${opts.repoPath}/${name}`;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      // The gate exists but cannot be read — fail loud rather than green.
      return {
        ok: false,
        error: {
          kind: "read",
          message: `${name} could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
    gateScript = { path: name, text };
    break;
  }

  const skips = gateScript === null ? [] : findGateToolSkips(gateScript.text);
  const bakedTools = bakedToolsForRepo(manifest, opts.repo);
  const files = await readWorkflowFiles(opts.repoPath);
  const enforcements = findCiToolEnforcements(
    files,
    skips.map((s) => s.tool).filter((tool) => !bakedTools.includes(tool)),
  );

  return {
    ok: true,
    value: {
      drifts: correlateGateSkipDrift({
        skips,
        enforcements,
        bakedTools,
        ...(gateScript === null ? {} : { gateScript }),
      }),
      skips,
      suppressedTools: skips
        .map((s) => s.tool)
        .filter((tool) => bakedTools.includes(tool))
        .sort(),
      gateScriptPath: gateScript?.path ?? null,
      workflowsLoaded: files.length > 0,
    },
  };
}
