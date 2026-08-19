/**
 * Decision logic for the agent-side `gh` guard (Issue #3643).
 *
 * The worker's egress controls — the per-run write-repo allowlist
 * (`write_repo_allowlist.ts`) and the worker label guard
 * (`worker_label_guard.ts`) — enforce inside the worker's own Deno process,
 * at `runGhCommandRaw`. The party those controls name as the injected one is
 * the **agent subprocess**, which runs unrestricted Bash with an inherited
 * `GH_TOKEN`; its own `gh` calls never traverse `runGhCommandRaw`, so neither
 * control saw them.
 *
 * This module is the single decision the `gh` shim (`gh_guard_shim.ts`)
 * re-enters for every agent `gh` invocation, before the real binary runs. It
 * is pure — the caller supplies the run's allowlist state — so it can be
 * evaluated in a short-lived child process with no permissions at all.
 *
 * Three checks, in order:
 *   1. **Reserved workflow labels.** A *mutation* that adds `top-priority`,
 *      `work-on`, `question`, … is refused. The check is a denylist of the
 *      reserved names (`WORKER_FORBIDDEN_LABEL_LITERALS`), not the worker's
 *      positive allowlist, because the agent's legitimate label surface is
 *      genuinely wider than the worker's enumerable call sites (the scan
 *      templates file findings with content labels such as `confidence:high`).
 *      Reads (`gh issue list --label work-on`) are untouched.
 *   2. **Recognised root command** (Issue #3866). The guard classifies the
 *      *pre-expansion* argv, but the real binary expands a config alias
 *      (`~/.config/gh/config.yml`) or hands an unknown name to an extension —
 *      whatever the alias names is a write the guard never saw. A root the
 *      guard does not recognise as a genuine `gh` command is therefore
 *      refused rather than classified as a read.
 *   3. **Write-repo allowlist.** Mirrors `enforceGhWriteAllowlist`: inert
 *      until the run seeds an allowlist, a no-op for reads and for cwd-repo
 *      writes with no explicit repo, and a refusal for a mutation that
 *      explicitly names an off-allowlist repo.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "./worker_label_guard.ts";

/** The current run's egress state, as passed to the guard child process. */
export interface GhGuardContext {
  /** Whether the run seeded a write-repo allowlist (inert when false). */
  active: boolean;
  /** `owner/repo` slugs the run may write to. */
  allowedRepos: readonly string[];
}

/** Which control refused the command — matches the worker's log markers. */
export type GhGuardMarker =
  | "WRITE_REPO_BLOCKED"
  | "WRITE_TARGET_UNDETERMINABLE"
  | "WORKER_LABEL_REFUSED"
  | "GH_UNKNOWN_COMMAND";

/** The guard's verdict for one `gh` argument vector. */
export interface GhGuardDecision {
  /** Whether the command may proceed to the real `gh` binary. */
  allowed: boolean;
  /** Which control refused it, when refused. */
  marker?: GhGuardMarker;
  /** Log-ready explanation of the refusal. */
  reason?: string;
}

/**
 * Root commands the real `gh` binary implements itself (Issue #3866).
 *
 * `gh` only expands a config alias, or dispatches to an extension, for a name
 * that is *not* one of these — a core command cannot be shadowed. So an
 * argument vector whose root is absent from this set is precisely the case the
 * argv-only guard cannot classify: the write it performs is named somewhere
 * the guard never reads. Such a call is refused, not waved through as a read.
 *
 * Taken from `gh --help` (core, Actions, additional commands and help topics)
 * plus `gh`'s own built-in command aliases (`cs`, `ext`, `at`, …). A genuinely
 * new upstream command is refused until it is listed here — the fail-closed
 * direction, and the refusal says exactly what to do.
 */
export const GH_KNOWN_ROOT_COMMANDS: ReadonlySet<string> = new Set([
  // Core
  "auth",
  "browse",
  "codespace",
  "cs",
  "discussion",
  "gist",
  "issue",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "skill",
  "skills",
  // GitHub Actions
  "cache",
  "run",
  "workflow",
  // Additional
  "agent-task",
  "agent-tasks",
  "alias",
  "api",
  "attestation",
  "at",
  "completion",
  "config",
  "copilot",
  "extension",
  "extensions",
  "ext",
  "gpg-key",
  "label",
  "licenses",
  "preview",
  "ruleset",
  "search",
  "secret",
  "ssh-key",
  "status",
  "variable",
  // Help topics and the built-in help/version verbs
  "accessibility",
  "actions",
  "environment",
  "exit-codes",
  "formatting",
  "help",
  "mintty",
  "reference",
  "telemetry",
  "version",
]);

/**
 * The root command of a `gh` argument vector, if it names one.
 *
 * Mirrors the classifier's own reading: the first argument that is not a flag.
 * `undefined` for `gh`, `gh --version` and friends, which name no command.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns The root command token, or undefined when none is present.
 */
export function ghRootCommand(
  args: readonly string[],
): string | undefined {
  let i = 0;
  while (args[i]?.startsWith("-")) i++;
  return args[i];
}

/** Flags whose value is one or more comma-separated label names. */
const LABEL_FLAGS: ReadonlySet<string> = new Set([
  "--add-label",
  "--label",
  "-l",
]);

/** `gh api` field flags whose value may carry `labels[]=<name>`. */
const FIELD_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
]);

/** Reserved workflow labels, lower-cased for case-insensitive matching. */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set(
  WORKER_FORBIDDEN_LABEL_LITERALS.map((l) => l.toLowerCase()),
);

/** Split a comma-separated label value into trimmed, non-empty names. */
function splitLabels(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Label names carried by a `gh api` field value such as `labels[]=x`. */
function labelsFromField(field: string): string[] {
  const match = field.match(/^labels(?:\[\])?=([\s\S]*)$/);
  return match ? splitLabels(match[1] ?? "") : [];
}

/**
 * Collect every label name named by a `gh` argument vector.
 *
 * Covers the space form (`--add-label x`), the equals form (`--label=x`), the
 * short form (`-l x`), the attached shorthand form (`-lx`, `-l=x` — pflag
 * spellings normalised by {@link normaliseGhArgs}, Issue #3867),
 * comma-separated lists, and `gh api` label fields. Every occurrence
 * contributes, because `--label` is a pflag string *slice*: repeating it
 * accumulates rather than replaces.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns Label names in the order they appear.
 */
export function extractLabelValues(rawArgs: readonly string[]): string[] {
  const args = normaliseGhArgs(rawArgs);
  const labels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;

    if (LABEL_FLAGS.has(token)) {
      // pflag takes the following token as the value whatever it looks like.
      const value = args[i + 1];
      if (value !== undefined) {
        labels.push(...splitLabels(value));
        i++;
      }
      continue;
    }
    if (token.startsWith("--add-label=")) {
      labels.push(...splitLabels(token.slice("--add-label=".length)));
      continue;
    }
    if (token.startsWith("--label=")) {
      labels.push(...splitLabels(token.slice("--label=".length)));
      continue;
    }
    if (FIELD_FLAGS.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        labels.push(...labelsFromField(value));
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && FIELD_FLAGS.has(token.slice(0, eq))) {
      labels.push(...labelsFromField(token.slice(eq + 1)));
    }
  }
  return labels;
}

/**
 * Decide whether one agent `gh` invocation may proceed.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @param ctx - The run's write-repo allowlist state.
 * @returns The verdict; `allowed: false` carries a marker and a reason.
 */
export function evaluateGhCommand(
  args: readonly string[],
  ctx: GhGuardContext,
): GhGuardDecision {
  const info = classifyGhMutation(args);

  if (info) {
    const forbidden = extractLabelValues(args).find((l) =>
      FORBIDDEN_LABELS.has(l.toLowerCase())
    );
    if (forbidden !== undefined) {
      return {
        allowed: false,
        marker: "WORKER_LABEL_REFUSED",
        reason: `label=${forbidden} verb=${info.verb} ` +
          `caller=agent-subprocess reason=reserved_workflow_label`,
      };
    }
  }

  // Issue #3866: a root the real binary does not implement is expanded from
  // the `gh` config aliases (or an extension) before it runs, so the write it
  // performs appears nowhere in this argv. Fail closed — including when the
  // allowlist is inert, because the reserved-label check above is unconditional
  // and an alias hides its labels just as effectively as its repo.
  const root = ghRootCommand(args);
  if (root !== undefined && !GH_KNOWN_ROOT_COMMANDS.has(root)) {
    return {
      allowed: false,
      marker: "GH_UNKNOWN_COMMAND",
      reason: `Refused 'gh ${root}' from the agent subprocess — not a known ` +
        `gh command, so it is an alias or an extension whose real command ` +
        `this guard cannot see. Run the underlying gh command directly.`,
    };
  }

  // Reads change nothing on GitHub and are never the exfiltration sink — the
  // worker's own chokepoint takes the same view.
  if (!info) return { allowed: true };

  if (!ctx.active) return { allowed: true };

  // Issue #3703: fail closed on an undeterminable target — a GraphQL
  // mutation, a `gh gist create`, an endpoint that names no repo. Mirrors
  // `enforceGhWriteAllowlist`.
  if (info.scope === "unknown") {
    return {
      allowed: false,
      marker: "WRITE_TARGET_UNDETERMINABLE",
      reason: `Refused ${info.verb} from the agent subprocess — target repo ` +
        `not derivable${info.target ? ` (${info.target})` : ""}, ` +
        `failing closed`,
    };
  }

  if (!info.repo) return { allowed: true };

  const allowed = new Set(
    ctx.allowedRepos.map((r) => r.trim().toLowerCase()).filter((r) =>
      r.length > 0
    ),
  );
  if (allowed.has(info.repo.trim().toLowerCase())) return { allowed: true };

  return {
    allowed: false,
    marker: "WRITE_REPO_BLOCKED",
    reason: `Refused ${info.verb} to ${info.repo} from the agent subprocess ` +
      `— not on run allowlist [${[...allowed].sort().join(", ")}]`,
  };
}
