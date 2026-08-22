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

import {
  classifyGhMutation,
  type MutationInfo,
} from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "./worker_label_guard.ts";
import {
  classifyIssueLifecycle,
  ISSUE_LIFECYCLE_VERBS,
} from "./gh_issue_lifecycle.ts";
import type { ClaimedIssue } from "./claimed_issue_guard.ts";
import type { BodyFileReader } from "./gh_body_redaction.ts";

/** The current run's egress state, as passed to the guard child process. */
export interface GhGuardContext {
  /** Whether the run seeded a write-repo allowlist (inert when false). */
  active: boolean;
  /** `owner/repo` slugs the run may write to. */
  allowedRepos: readonly string[];
  /**
   * The issue this run claimed, when it seeded one (Issue #222).
   *
   * Present → issue-lifecycle verbs (`close`, `reopen`, `delete`, …) are
   * refused for every issue in the claimed repo unless the verb is on
   * {@link ClaimedIssue.allowedVerbs}. Absent → inert, exactly as before.
   */
  claimedIssue?: ClaimedIssue;
  /**
   * Filesystem reader for a `--input <file>` body (Issue #91). Injected rather
   * than called directly so this module stays pure — it can run in a child
   * process with no `--allow-read`, and a caller with no reader (the safe
   * default) simply fails closed on every unreadable body, matching #90.
   * `gh_guard_cli.ts` supplies `denoBodyFileReader`.
   */
  readBodyFile?: BodyFileReader;
}

/** Which control refused the command — matches the worker's log markers. */
export type GhGuardMarker =
  | "WRITE_REPO_BLOCKED"
  | "WRITE_TARGET_UNDETERMINABLE"
  | "WORKER_LABEL_REFUSED"
  | "GH_BODY_UNREADABLE"
  | "GH_UNKNOWN_COMMAND"
  | "ISSUE_LIFECYCLE_REFUSED";

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

/**
 * The subset of field flags whose `@`-prefixed value `gh` reads from a file
 * (`@-` from stdin) — verified against gh 2.97.0 (Issue #93). `-f`/
 * `--raw-field` add a static string and never expand `@`, so a literal
 * `@name` there is a real label name, not a file.
 */
const FIELD_FILE_FLAGS: ReadonlySet<string> = new Set(["-F", "--field"]);

/** Reserved workflow labels, lower-cased for case-insensitive matching. */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set(
  WORKER_FORBIDDEN_LABEL_LITERALS.map((l) => l.toLowerCase()),
);

/** Split a comma-separated label value into trimmed, non-empty names. */
function splitLabels(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Label names carried by a `gh api` field value such as `labels[]=x`.
 *
 * An `@`-prefixed value on a `-F`/`--field` flag is read from a file by `gh`,
 * so the label names never reach the argv (Issue #93). Emitting the literal
 * `@path` as a label would be worse than emitting nothing — it would look as
 * if the guard inspected the value when it did not — so return no names and
 * let the `unreadableBody` backstop refuse the command. `expandsAtFile` is
 * false for `-f`/`--raw-field`, where `@literal` really is the label name.
 */
function labelsFromField(field: string, expandsAtFile: boolean): string[] {
  const match = field.match(/^labels(?:\[\])?=([\s\S]*)$/);
  if (!match) return [];
  const value = match[1] ?? "";
  if (expandsAtFile && value.startsWith("@")) return [];
  return splitLabels(value);
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
        labels.push(...labelsFromField(value, FIELD_FILE_FLAGS.has(token)));
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && FIELD_FLAGS.has(token.slice(0, eq))) {
      labels.push(
        ...labelsFromField(
          token.slice(eq + 1),
          FIELD_FILE_FLAGS.has(token.slice(0, eq)),
        ),
      );
    }
  }
  return labels;
}

/** Outcome of scanning a `--input` body file for reserved workflow labels. */
type BodyScan =
  | { kind: "clean" }
  | { kind: "forbidden"; label: string }
  | { kind: "unreadable" };

/**
 * Label names from a `["a", {"name":"b"}]` array, or `null` if any element is
 * a shape the extractor does not understand (fail closed on the unknown).
 */
function labelNamesFromArray(arr: readonly unknown[]): string[] | null {
  const names: string[] = [];
  for (const el of arr) {
    if (typeof el === "string") {
      names.push(el);
    } else if (
      el !== null && typeof el === "object" &&
      typeof (el as { name?: unknown }).name === "string"
    ) {
      names.push((el as { name: string }).name);
    } else {
      return null;
    }
  }
  return names;
}

/**
 * Scan a `gh api --input` body for reserved workflow labels (Issue #91).
 *
 * Understands the three shapes GitHub's REST API accepts for labels — the bare
 * array `["a"]`, `{"labels": ["a"]}`, and `{"labels": [{"name":"a"}]}` — plus
 * a body carrying no `labels` field at all (an issue create/edit). Anything
 * else — invalid JSON, a non-object/array top level, a `labels` field that is
 * not an array, an array element that is neither a string nor `{name}` — is
 * reported `unreadable` so the caller fails closed, never allowed unscanned.
 * The extracted names run through the same {@link FORBIDDEN_LABELS} denylist,
 * case-insensitively, as argv-sourced labels — one authoritative list.
 */
function scanBodyForForbiddenLabel(text: string): BodyScan {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  let names: string[] | null;
  if (Array.isArray(doc)) {
    names = labelNamesFromArray(doc);
  } else if (doc !== null && typeof doc === "object") {
    const labels = (doc as { labels?: unknown }).labels;
    if (labels === undefined) {
      names = [];
    } else if (Array.isArray(labels)) {
      names = labelNamesFromArray(labels);
    } else {
      names = null;
    }
  } else {
    return { kind: "unreadable" };
  }
  if (names === null) return { kind: "unreadable" };
  const forbidden = names.find((l) => FORBIDDEN_LABELS.has(l.toLowerCase()));
  if (forbidden !== undefined) return { kind: "forbidden", label: forbidden };
  return { kind: "clean" };
}

/** The #90 fail-closed refusal for an unscannable REST body. */
function unreadableBodyRefusal(verb: string): GhGuardDecision {
  return {
    allowed: false,
    marker: "GH_BODY_UNREADABLE",
    reason: `Refused ${verb} from the agent subprocess — the request body ` +
      `is supplied by \`--input\` and this guard cannot scan it for reserved ` +
      `workflow labels (stdin, an unreadable path, or a body whose shape it ` +
      `does not understand). Pass the fields inline with \`-f\`/\`--field\`, ` +
      `or supply a readable JSON file.`,
  };
}

/** Case-insensitive `owner/repo` comparison. */
function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Refuse an issue-lifecycle change in the claimed repo (Issue #222).
 *
 * The implementing agent decides what the *code* should be; it does not decide
 * that an issue is closed, reopened, moved or locked. A run that has seeded a
 * claim therefore refuses those verbs for every issue in its claimed repo —
 * not only the claimed issue, because closing a "duplicate" or reopening a
 * sibling is the same lifecycle call the agent is not making — unless the run
 * explicitly permits the verb (`allowedVerbs`, `edit` by default so the
 * `needs-human` escalation the prompts prescribe keeps working).
 *
 * A command naming a *different* repo is left to the write-repo allowlist,
 * which refuses it already. A command naming no repo is `gh`'s cwd form, and
 * during a coding run the clone is the claimed repo — so it is treated as
 * naming the claim, the fail-closed direction.
 */
function refuseClaimedIssueLifecycle(
  args: readonly string[],
  info: MutationInfo,
  ctx: GhGuardContext,
): GhGuardDecision | undefined {
  const claim = ctx.claimedIssue;
  if (!claim) return undefined;

  const attempt = classifyIssueLifecycle(args, info);
  if (!attempt) return undefined;

  const allowed = new Set(
    claim.allowedVerbs.map((v) => v.trim().toLowerCase()),
  );
  if (allowed.has(attempt.verb)) return undefined;

  const targetRepo = attempt.repo ?? claim.repo;
  if (!sameRepo(targetRepo, claim.repo)) return undefined;

  const target = attempt.issueNumber === undefined
    ? targetRepo
    : `${targetRepo}#${attempt.issueNumber}`;
  const isClaim = attempt.issueNumber === claim.issueNumber;
  return {
    allowed: false,
    marker: "ISSUE_LIFECYCLE_REFUSED",
    reason: `Refused 'gh ${info.verb}' on ${target} from the agent ` +
      `subprocess — issue lifecycle changes (` +
      `${ISSUE_LIFECYCLE_VERBS.join(", ")}) on ${claim.repo} are the ` +
      `worker's or a human's decision, not the implementing agent's` +
      (isClaim ? ` (this run's claimed issue)` : "") +
      `. Post your findings as a comment instead: a run that is blocked on ` +
      `another issue should say so in a section beginning "## Blocked:" and ` +
      `name the dependency as "Depends on owner/repo#N", and the worker ` +
      `defers the issue rather than closing it.`,
  };
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

    const lifecycleRefusal = refuseClaimedIssueLifecycle(args, info, ctx);
    if (lifecycleRefusal) return lifecycleRefusal;

    // Issue #11/#90/#91: a REST mutation whose body is supplied by `--input`
    // (or an `@file`-sourced query) is argv-invisible, so `extractLabelValues`
    // above saw nothing to reject — a prompt-injected agent could hide a
    // reserved label in the file. #90 failed closed on every such body; #91
    // restores the legitimate case: when the argv names a *readable file* and
    // a reader is supplied, read it and scan for reserved labels. Only a body
    // that is successfully parsed and fully understood is allowed through;
    // stdin (`--input -`), a `@file` field value, an unreadable path, invalid
    // JSON, or an unrecognised shape all carry no readable `bodyFilePath` (or
    // fail the scan) and stay refused. This sits WITH the reserved-label
    // check, before the `ctx.active` early return, so the backstop is as
    // unconditional as the denylist it guards. TOCTOU: the agent could rewrite
    // the file between this read and `gh`'s — not closable from a PATH shim,
    // and no worse than #90; the argv-visible path has no such window.
    if (info.unreadableBody) {
      if (info.bodyFilePath !== undefined && ctx.readBodyFile) {
        let text: string;
        try {
          text = ctx.readBodyFile(info.bodyFilePath);
        } catch {
          return unreadableBodyRefusal(info.verb);
        }
        const scan = scanBodyForForbiddenLabel(text);
        if (scan.kind === "forbidden") {
          return {
            allowed: false,
            marker: "WORKER_LABEL_REFUSED",
            reason: `label=${scan.label} verb=${info.verb} ` +
              `caller=agent-subprocess ` +
              `reason=reserved_workflow_label_in_input_body`,
          };
        }
        if (scan.kind === "unreadable") return unreadableBodyRefusal(info.verb);
        // scan.kind === "clean": the body carries no reserved label — fall
        // through to the write-repo allowlist checks below, which still apply.
      } else {
        return unreadableBodyRefusal(info.verb);
      }
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
