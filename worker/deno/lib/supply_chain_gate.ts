/**
 * Supply-chain posture gate (Issue #4192).
 *
 * Verified posture, not assumed posture: every check here used to be a habit
 * ("we always SHA-pin", "run.sh always passes --frozen") that nothing failed
 * on when it decayed. The gate turns each habit into a rule with a finding
 * that names the file, the line and the rule:
 *
 *   - `action-sha-pin`        every `uses:` under `.github/workflows/` and
 *                             `.github/actions/` is a full 40-hex commit SHA
 *                             (tag and branch refs rejected; only local `./`
 *                             actions are exempt).
 *   - `action-pin-comment`    a SHA pin carries the repository's
 *                             `# owner/action@vX.Y.Z` comment so a human (and
 *                             Dependabot) can read the version.
 *   - `deno-frozen`           every dependency-resolving `deno` invocation in
 *                             a shipped script, launcher, container file, CI
 *                             workflow or `deno.json` task passes `--frozen`
 *                             (or `--cached-only`, which forbids fetching at
 *                             all). Deliberate exemptions live in
 *                             {@link DENO_INVOCATION_ALLOWLIST}, each with a
 *                             reason.
 *   - `container-base-digest` every `FROM` under `container/` resolves to an
 *                             `@sha256:` digest, through `ARG` defaults.
 *   - `container-base-registry` every such `FROM` also names its registry, so
 *                             Podman's enforcing short-name mode can resolve
 *                             it on a fresh host (Issue #728).
 *   - `renovate-automerge` /  Renovate may auto-merge only pin-class updates
 *     `renovate-release-age`  and must keep the release-age quarantine.
 *   - `inventory-stale`       `docs/audits/dependency-inventory.md` matches
 *                             what {@link buildDependencyInventory} generates
 *                             from the tree, so the audit record is diffable
 *                             and never silently out of date.
 *
 * All functions are pure over text or read-only over the tree; the command
 * in `commands/supply_chain_gate.ts` does the printing and the exit code.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { extractUsesValue } from "./action_pin_scanner.ts";
import { isRegistryQualifiedImage } from "./container_manifest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Every rule the gate can fail on. */
export type GateRule =
  | "action-sha-pin"
  | "action-pin-comment"
  | "deno-frozen"
  | "container-base-digest"
  | "container-base-registry"
  | "renovate-automerge"
  | "renovate-release-age"
  | "renovate-parse"
  | "inventory-stale";

/** One failing check, precise enough to act on from a CI log. */
export interface GateFinding {
  rule: GateRule;
  /** Repo-relative path. */
  file: string;
  /** 1-based line; `1` when the finding is about the file as a whole. */
  line: number;
  message: string;
}

/** A justified exemption from the `deno-frozen` rule. */
export interface DenoInvocationAllowlistEntry {
  /** Repo-relative path the exemption applies to. */
  file: string;
  /** Substring of the invocation text that identifies it. */
  match: string;
  /** Why this invocation may run without `--frozen`. Never empty. */
  reason: string;
}

/** Counts of what the gate looked at, so "no findings" is not "nothing scanned". */
export interface GateChecked {
  workflowFiles: number;
  usesReferences: number;
  scriptFiles: number;
  denoInvocations: number;
  containerFiles: number;
  baseImages: number;
  renovateConfig: boolean;
}

/** The structured result of one gate run. */
export interface GateReport {
  ok: boolean;
  findings: GateFinding[];
  checked: GateChecked;
  /** The inventory generated from the tree (what the committed file must equal). */
  inventory: string;
  /** Repo-relative path of the committed inventory. */
  inventoryPath: string;
}

/** Options for {@link runSupplyChainGate}. */
export interface GateOptions {
  repoDir: string;
  /** Repo-relative inventory path; defaults to {@link DEFAULT_INVENTORY_PATH}. */
  inventoryPath?: string;
  /** Exemptions from the `deno-frozen` rule; defaults to the built-in list. */
  denoAllowlist?: readonly DenoInvocationAllowlistEntry[];
}

/** Where the committed inventory lives. */
export const DEFAULT_INVENTORY_PATH = "docs/audits/dependency-inventory.md";

// ---------------------------------------------------------------------------
// (a) `uses:` SHA pins
// ---------------------------------------------------------------------------

const SHA_PIN = /^[0-9a-f]{40}$/;
const USES_LINE = /^\s*(?:-\s*)?uses:/;

/** How many lines above a `uses:` the version comment may sit. */
const PIN_COMMENT_REACH = 3;

/**
 * Flag every `uses:` in one workflow / composite-action file that is not a
 * full commit SHA, and every SHA pin that lacks a version comment.
 *
 * Only local `./` references are exempt: first-party tags and `docker://`
 * images are rejected like any other mutable reference (Issue #4192 scope).
 */
export function findUnpinnedUses(file: string, text: string): GateFinding[] {
  const lines = text.split("\n");
  const findings: GateFinding[] = [];
  lines.forEach((line, index) => {
    if (!USES_LINE.test(line)) return;
    const value = extractUsesValue(line);
    if (value === null || value.startsWith("./")) return;
    const finding = judgeUses(file, lines, index, value);
    if (finding) findings.push(finding);
  });
  return findings;
}

/** Judge one non-local `uses:` value. */
function judgeUses(
  file: string,
  lines: readonly string[],
  index: number,
  value: string,
): GateFinding | null {
  const line = index + 1;
  if (value.startsWith("docker://")) {
    if (/@sha256:[0-9a-f]{64}$/.test(value)) return null;
    return {
      rule: "action-sha-pin",
      file,
      line,
      message: `\`uses: ${value}\` is a container action pinned by tag; ` +
        `pin it by @sha256: digest`,
    };
  }
  const at = value.lastIndexOf("@");
  const ref = at >= 0 ? value.slice(at + 1) : "";
  if (!SHA_PIN.test(ref)) {
    return {
      rule: "action-sha-pin",
      file,
      line,
      message: `\`uses: ${value}\` is not pinned to a full 40-character ` +
        `commit SHA (ref "${ref || "<none>"}" is a tag or branch)`,
    };
  }
  const coordinate = value.slice(0, at);
  if (hasPinComment(lines, index, coordinate)) return null;
  return {
    rule: "action-pin-comment",
    file,
    line,
    message:
      `\`uses: ${coordinate}@<sha>\` has no \`# ${coordinate}@vX.Y.Z\` ` +
      `version comment on the line or within ${PIN_COMMENT_REACH} lines above`,
  };
}

/** True when a `# coordinate@version` comment sits inline or just above. */
function hasPinComment(
  lines: readonly string[],
  index: number,
  coordinate: string,
): boolean {
  const needle = `# ${coordinate}@`;
  const from = Math.max(0, index - PIN_COMMENT_REACH);
  for (let i = index; i >= from; i--) {
    if ((lines[i] ?? "").includes(needle)) return true;
  }
  return false;
}

/** Version from the `# coordinate@vX` comment near a pin, or "". */
function pinCommentVersion(
  lines: readonly string[],
  index: number,
  coordinate: string,
): string {
  const needle = `# ${coordinate}@`;
  const from = Math.max(0, index - PIN_COMMENT_REACH);
  for (let i = index; i >= from; i--) {
    const at = (lines[i] ?? "").indexOf(needle);
    if (at >= 0) {
      const rest = (lines[i] ?? "").slice(at + needle.length);
      return (rest.split(/\s/)[0] ?? "").trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// (b) frozen deno invocations
// ---------------------------------------------------------------------------

/**
 * Deno subcommands that resolve (and, without a lock, fetch) dependencies.
 * `task` delegates to a task string that is scanned in `deno.json`; `lint`,
 * `fmt` and `audit` resolve nothing.
 */
const RESOLVING_SUBCOMMANDS =
  "run|test|cache|install|check|compile|eval|bench|serve|doc|bundle";

/**
 * A `deno` command token — the bare word (optionally path-qualified) or a
 * shell / PowerShell variable holding it — followed by a resolving
 * subcommand. Group 1 is the character before the token; group 2 the token;
 * group 3 the subcommand.
 */
const DENO_TOKEN = new RegExp(
  "(^|[\\s;&|(!'\"`])" +
    '((?:"?\\$\\{?[A-Za-z_]*[Dd][Ee][Nn][Oo][A-Za-z_]*(?:\\[@\\])?\\}?' +
    '(?:\\.Source)?"?)|(?:[\\w./~-]*/)?deno(?:\\.exe)?)' +
    `\\s+(${RESOLVING_SUBCOMMANDS})\\b`,
  "g",
);

/**
 * PowerShell argument arrays: `-ArgumentList @( "run", … )`, `& $deno @(…)`
 * or an `$argv = @( "run", … )` splatted later. Any `@(` whose first element
 * is a resolving Deno subcommand string is treated as a Deno invocation.
 */
const PS_ARRAY_OPEN = /@\(/g;

const PS_ARRAY_SUBCOMMAND = new RegExp(
  `^\\s*"(${RESOLVING_SUBCOMMANDS})"`,
);

/** Where an invocation ends: the next command separator or newline. */
const INVOCATION_END = /;|&&|\|\||\||\n|\)(?=["'\s]|$)/;

/** Continuation marker: a backslash-newline flattened into one line. */
const JOIN = "\u001f";

/**
 * Justified exemptions from the `deno-frozen` rule for this repository.
 * Every entry names the invocation and says why it may run unfrozen; the
 * tests fail on an entry without a reason.
 */
export const DENO_INVOCATION_ALLOWLIST:
  readonly DenoInvocationAllowlistEntry[] = [
    {
      file: "container/Containerfile",
      match: 'deno run --allow-all "$m" --version',
      reason:
        "The one online run that fills the transitive npm registry.json files " +
        "the seed lock cannot list; it resolves the exact npm:@playwright/mcp " +
        "pin from the seed cache `deno cache --frozen` just built under the " +
        "same DENO_DIR, and the following `--cached-only` run proves the " +
        "seed is whole without any network (Issue #4392).",
    },
    {
      file: ".github/workflows/validate-scripts.yml",
      match: "deno eval '",
      reason:
        "The benchmark audit is inline source with no imports (Issue #583); " +
        "it resolves no dependencies, so there is no lockfile to enforce.",
    },
    {
      file: ".github/workflows/container-build.yml",
      match: "deno run --allow-net=127.0.0.1:8931 --allow-read=. serve.ts",
      reason:
        "A throwaway static file server the step writes into a temp dir for " +
        "the MCP screenshot probe; it imports nothing, so no dependencies are " +
        "resolved and no lockfile applies.",
    },
    {
      file: ".github/workflows/container-build.yml",
      match: "deno run --allow-env --allow-read mcp-config-probe.ts",
      reason:
        "A throwaway probe the step writes at the checkout root to print the " +
        "MCP config the shipped worker code generates; it imports only " +
        "checked-out first-party source, and the run has no lockfile in " +
        "scope because it executes outside worker/deno.",
    },
  ];

/** One dependency-resolving `deno` invocation found in a file. */
export interface DenoInvocation {
  /** 1-based line of the `deno` token. */
  line: number;
  /** The invocation from its `deno` token to the next command separator. */
  text: string;
  /** Context prefix for messages, e.g. `task 'test': `. */
  label: string;
}

/**
 * List every dependency-resolving `deno` invocation in one file.
 *
 * Handles POSIX shell (backslash continuations, `;`/`&&`/`|` chains inside
 * one `RUN` line, `"${DENO_CMD}" run` variables), YAML workflows (only text
 * inside `run:` steps is shell), PowerShell (`@( "run", ... )` argument
 * arrays and backtick continuations) and `deno.json` task strings.
 */
export function listDenoInvocations(
  file: string,
  text: string,
): DenoInvocation[] {
  if (/deno\.jsonc?$/.test(file)) return listDenoJsonTaskInvocations(text);
  const ps = file.endsWith(".ps1");
  const source = ps ? blankPowerShellBlockComments(text) : text;
  const shellLine = /\.ya?ml$/.test(file) ? yamlRunLines(source) : null;
  const out: DenoInvocation[] = [];
  for (const segment of logicalSegments(source, ps, shellLine)) {
    out.push(...segmentInvocations(segment));
    if (ps) out.push(...powerShellArrayInvocations(segment));
  }
  return out;
}

/**
 * Flag every dependency-resolving `deno` invocation in one file that carries
 * neither `--frozen` nor `--cached-only`, unless an allowlist entry for
 * this file matches the invocation text.
 */
export function findUnfrozenDenoInvocations(
  file: string,
  text: string,
  allowlist: readonly DenoInvocationAllowlistEntry[] =
    DENO_INVOCATION_ALLOWLIST,
): GateFinding[] {
  const allowed = allowlist.filter((entry) => entry.file === file);
  const findings: GateFinding[] = [];
  for (const invocation of listDenoInvocations(file, text)) {
    const finding = judgeInvocation(file, invocation, allowed);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** A run of source lines that form one logical command. */
interface Segment {
  /** 1-based line of the first source line. */
  startLine: number;
  /** Lines joined; backslash / backtick continuations become JOIN. */
  text: string;
}

/**
 * Split source into logical segments: full-line comments are dropped,
 * backslash (and, for PowerShell, backtick and open-paren) continuations
 * are joined so a flag on the next line still belongs to the invocation.
 */
function logicalSegments(
  text: string,
  ps: boolean,
  shellLine: readonly boolean[] | null,
): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i] ?? "";
    if (/^\s*#/.test(first) || (shellLine && !shellLine[i])) {
      i++;
      continue;
    }
    const startLine = i + 1;
    let joined = "";
    let depth = 0;
    let count = 0;
    while (i < lines.length && count < 80) {
      const line = lines[i] ?? "";
      i++;
      count++;
      const trimmed = line.trimEnd();
      if (ps) depth += parenDelta(trimmed);
      if (trimmed.endsWith("\\") || (ps && trimmed.endsWith("`"))) {
        joined += trimmed.slice(0, -1) + JOIN;
        continue;
      }
      joined += line;
      if (ps && depth > 0) {
        joined += "\n";
        continue;
      }
      break;
    }
    segments.push({ startLine, text: joined });
  }
  return segments;
}

/** Net change in parenthesis depth over one line, ignoring quoted text. */
function parenDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") delta++;
    else if (ch === ")") delta--;
  }
  return delta;
}

/** The `deno <subcommand>` invocations of one logical segment. */
function segmentInvocations(segment: Segment): DenoInvocation[] {
  const out: DenoInvocation[] = [];
  for (const m of segment.text.matchAll(DENO_TOKEN)) {
    const tokenAt = (m.index ?? 0) + (m[1] ?? "").length;
    if (isProcessTitle(segment.text, tokenAt)) continue;
    if (isEchoed(segment.text, tokenAt)) continue;
    out.push({
      line: lineAt(segment, tokenAt),
      text: invocationText(segment.text, tokenAt),
      label: "",
    });
  }
  return out;
}

/** `exec -a 'deno run …'` sets a process title; it is not an invocation. */
function isProcessTitle(text: string, at: number): boolean {
  return /exec\s+-a\s+['"]?$/.test(text.slice(Math.max(0, at - 40), at));
}

/** `echo "=== Running deno check ==="` prints, it does not run. */
function isEchoed(text: string, at: number): boolean {
  const before = text.slice(0, at);
  const lastSep = Math.max(
    before.lastIndexOf("\n"),
    before.lastIndexOf(";"),
    before.lastIndexOf("&&"),
    before.lastIndexOf("|"),
    before.lastIndexOf(JOIN),
  );
  const command = before.slice(lastSep + 1).trimStart();
  return /^(?:echo|printf|log\w*|warn\w*)\b/.test(command);
}

/** The invocation from its `deno` token to the next command separator. */
function invocationText(text: string, at: number): string {
  const rest = text.slice(at);
  const end = rest.search(INVOCATION_END);
  const raw = end >= 0 ? rest.slice(0, end) : rest;
  return raw.replaceAll(JOIN, " ").replace(/\s+/g, " ").trim();
}

/** Line number of an offset inside a segment. */
function lineAt(segment: Segment, offset: number): number {
  const before = segment.text.slice(0, offset);
  const joins = before.split(JOIN).length - 1;
  const newlines = before.split("\n").length - 1;
  return segment.startLine + joins + newlines;
}

/** True when the invocation's arguments enforce the lockfile. */
function isFrozen(invocation: string): boolean {
  const tokens = invocation.split(/\s+/).map((t) =>
    t.replace(/^["']|["']$/g, "")
  );
  return tokens.some((t) =>
    t === "--frozen" || t === "--frozen=true" || t === "--cached-only"
  );
}

/** Judge one invocation, honouring the allowlist. */
function judgeInvocation(
  file: string,
  invocation: DenoInvocation,
  allowed: readonly DenoInvocationAllowlistEntry[],
): GateFinding | null {
  if (isFrozen(invocation.text)) return null;
  if (allowed.some((entry) => invocation.text.includes(entry.match))) {
    return null;
  }
  const shown = invocation.text.length > 100
    ? `${invocation.text.slice(0, 100)}…`
    : invocation.text;
  return {
    rule: "deno-frozen",
    file,
    line: invocation.line,
    message: `${invocation.label}\`${shown}\` resolves dependencies ` +
      `without --frozen (or --cached-only); add --frozen ` +
      `--lock=<path>/deno.lock, or allowlist it in ` +
      `lib/supply_chain_gate.ts with a reason`,
  };
}

/** PowerShell `@( "run", … )` argument arrays passed to a Deno command. */
function powerShellArrayInvocations(segment: Segment): DenoInvocation[] {
  const out: DenoInvocation[] = [];
  for (const m of segment.text.matchAll(PS_ARRAY_OPEN)) {
    const open = (m.index ?? 0) + m[0].length;
    const block = parenBlock(segment.text, open);
    if (!PS_ARRAY_SUBCOMMAND.test(block)) continue;
    out.push({
      line: lineAt(segment, m.index ?? 0),
      text: "deno " +
        block.replaceAll(JOIN, " ").replace(/\n+/g, " ").replace(/,\s*/g, " ")
          .trim(),
      label: "",
    });
  }
  return out;
}

/** Text from just after an opening paren to its matching close. */
function parenBlock(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Replace `<# … #>` block comments with blank lines (line count kept). */
function blankPowerShellBlockComments(text: string): string {
  return text.replace(
    /<#[\s\S]*?#>/g,
    (block) => block.replace(/[^\n]/g, ""),
  );
}

/**
 * Mark which lines of a workflow file are shell: the value of a `run:` key
 * (inline, or every deeper-indented line of a `|` / `>` block scalar).
 */
export function yamlRunLines(text: string): boolean[] {
  const lines = text.split("\n");
  const shell = lines.map(() => false);
  let blockIndent = -1;
  lines.forEach((line, i) => {
    if (blockIndent >= 0) {
      const blank = line.trim() === "";
      const indent = line.length - line.trimStart().length;
      if (blank || indent > blockIndent) {
        shell[i] = !blank;
        return;
      }
      blockIndent = -1;
    }
    const m = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) return;
    const value = (m[2] ?? "").trim();
    if (/^[|>]/.test(value)) {
      blockIndent = (m[1] ?? "").length;
    } else if (value !== "") {
      shell[i] = true;
    }
  });
  return shell;
}

/** The `tasks` of a `deno.json` — each task string is one shell line. */
function listDenoJsonTaskInvocations(text: string): DenoInvocation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!isRecord(tasks)) return [];
  const out: DenoInvocation[] = [];
  const lines = text.split("\n");
  for (const [name, value] of Object.entries(tasks)) {
    const command = typeof value === "string"
      ? value
      : isRecord(value) && typeof value["command"] === "string"
      ? value["command"]
      : "";
    if (command === "") continue;
    const at = lines.findIndex((l) => l.includes(`"${name}"`));
    for (const m of command.matchAll(DENO_TOKEN)) {
      const tokenAt = (m.index ?? 0) + (m[1] ?? "").length;
      out.push({
        line: at >= 0 ? at + 1 : 1,
        text: invocationText(command, tokenAt),
        label: `task '${name}': `,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) container base images
// ---------------------------------------------------------------------------

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

/** A `FROM` reference after `ARG` substitution. */
export interface BaseImageRef {
  /** 1-based line of the `FROM`. */
  line: number;
  /** The literal token on the `FROM` line, e.g. `${BASE_IMAGE}`. */
  raw: string;
  /** The reference after substituting `ARG` defaults. */
  resolved: string;
  /** The `ARG` name the reference came from, if any. */
  arg: string | null;
}

/**
 * List every `FROM` in a Containerfile that names an external image (stage
 * names and `scratch` are skipped), resolving `${ARG}` defaults declared
 * earlier in the file.
 */
export function listBaseImages(text: string): BaseImageRef[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const refs: BaseImageRef[] = [];
  text.split("\n").forEach((line, index) => {
    const arg = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (arg) {
      args.set(arg[1] ?? "", stripQuotes((arg[2] ?? "").trim()));
      return;
    }
    const from = line.match(/^\s*FROM\s+(.*)$/i);
    if (!from) return;
    const parts = (from[1] ?? "").trim().split(/\s+/).filter((p) =>
      !p.startsWith("--")
    );
    const raw = parts[0] ?? "";
    const asIndex = parts.findIndex((p) => p.toUpperCase() === "AS");
    if (asIndex >= 0) stages.add((parts[asIndex + 1] ?? "").toLowerCase());
    if (raw === "" || raw.toLowerCase() === "scratch") return;
    if (stages.has(raw.toLowerCase()) && !raw.includes("$")) return;
    const argName = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1] ??
      null;
    const resolved = argName ? args.get(argName) ?? raw : raw;
    refs.push({ line: index + 1, raw, resolved, arg: argName });
  });
  return refs;
}

/** Drop one layer of matching quotes. */
function stripQuotes(value: string): string {
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/** Flag every `FROM` whose resolved image is not `@sha256:` digest-pinned. */
export function findTagOnlyBaseImages(
  file: string,
  text: string,
): GateFinding[] {
  return listBaseImages(text)
    .filter((ref) => !DIGEST_REF.test(ref.resolved))
    .map((ref) => ({
      rule: "container-base-digest" as const,
      file,
      line: ref.line,
      message: `FROM ${ref.raw}` +
        (ref.arg ? ` resolves via ARG ${ref.arg} to` : " is") +
        ` "${ref.resolved}", which is not pinned by @sha256: digest`,
    }));
}

/**
 * Flag every `FROM` whose resolved image does not name its registry
 * (Issue #728).
 *
 * Docker resolves a short name against Docker Hub; Podman's default
 * `short-name-mode = "enforcing"` refuses to guess one, so an unqualified
 * base image fails to build on a host with no `unqualified-search-registries`.
 *
 * @param file - Repo-relative path, for the finding.
 * @param text - Raw Containerfile text.
 * @returns One finding per unqualified reference; empty when all are
 *   registry-qualified.
 */
export function findUnqualifiedBaseImages(
  file: string,
  text: string,
): GateFinding[] {
  return listBaseImages(text)
    .filter((ref) => !isRegistryQualifiedImage(ref.resolved))
    .map((ref) => ({
      rule: "container-base-registry" as const,
      file,
      line: ref.line,
      message: `FROM ${ref.raw}` +
        (ref.arg ? ` resolves via ARG ${ref.arg} to` : " is") +
        ` "${ref.resolved}", a short name Podman cannot resolve without a ` +
        `search registry — name the registry (e.g. docker.io/library/...)`,
    }));
}

// ---------------------------------------------------------------------------
// (d) Renovate policy
// ---------------------------------------------------------------------------

/**
 * The only update classes Renovate may auto-merge: converting a floating
 * reference into an exact one changes no resolved code. Everything else —
 * patch, minor, major, digest bumps, lock-file maintenance — lands new code
 * and needs a human merge.
 */
export const RENOVATE_AUTOMERGE_ALLOWED_UPDATE_TYPES: readonly string[] = [
  "pin",
  "pinDigest",
];

/** Presets that only choose *how* to automerge, not *what*. */
const MECHANISM_ONLY_PRESETS = new Set([
  ":automergeBranch",
  ":automergePr",
  ":automergeRequireAllStatusChecks",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert the Renovate auto-merge policy explicitly: no top-level or nested
 * `automerge: true` outside pin-class updates, no automerge presets, and a
 * release-age quarantine in place.
 */
export function evaluateRenovatePolicy(
  file: string,
  config: unknown,
): GateFinding[] {
  if (!isRecord(config)) {
    return [{
      rule: "renovate-parse",
      file,
      line: 1,
      message: "renovate config is not a JSON object",
    }];
  }
  const findings: GateFinding[] = [];
  const age = config["minimumReleaseAge"];
  if (typeof age !== "string" || age.trim() === "") {
    findings.push({
      rule: "renovate-release-age",
      file,
      line: 1,
      message: "top-level minimumReleaseAge is missing; the supply-chain " +
        "quarantine must stay explicit",
    });
  }
  const presets = Array.isArray(config["extends"]) ? config["extends"] : [];
  for (const preset of presets) {
    if (typeof preset !== "string" || !/automerge/i.test(preset)) continue;
    if (MECHANISM_ONLY_PRESETS.has(preset)) continue;
    findings.push(automergeFinding(file, `extends "${preset}"`));
  }
  walkAutomerge(config, "", (path, allowedHere) => {
    if (!allowedHere) findings.push(automergeFinding(file, path));
  });
  return findings;
}

function automergeFinding(file: string, where: string): GateFinding {
  return {
    rule: "renovate-automerge",
    file,
    line: 1,
    message: `${where} enables automerge beyond the agreed low-risk classes ` +
      `(only packageRules with matchUpdateTypes ⊆ ` +
      `[${RENOVATE_AUTOMERGE_ALLOWED_UPDATE_TYPES.join(", ")}] may automerge)`,
  };
}

/** Visit every object with `automerge: true`, saying whether its place allows it. */
function walkAutomerge(
  node: unknown,
  path: string,
  visit: (path: string, allowed: boolean) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkAutomerge(item, `${path}[${i}]`, visit));
    return;
  }
  if (!isRecord(node)) return;
  if (node["automerge"] === true) {
    visit(path === "" ? "top-level" : path, automergeAllowedAt(node, path));
  }
  for (const [key, value] of Object.entries(node)) {
    walkAutomerge(value, path === "" ? key : `${path}.${key}`, visit);
  }
}

/** Pin-class update-type objects and pin-only packageRules may automerge. */
function automergeAllowedAt(
  node: Record<string, unknown>,
  path: string,
): boolean {
  if (RENOVATE_AUTOMERGE_ALLOWED_UPDATE_TYPES.includes(path)) return true;
  if (!/^packageRules\[\d+\]$/.test(path)) return false;
  const types = node["matchUpdateTypes"];
  if (!Array.isArray(types) || types.length === 0) return false;
  return types.every((t) =>
    typeof t === "string" && RENOVATE_AUTOMERGE_ALLOWED_UPDATE_TYPES.includes(t)
  );
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/** Read a repo-relative file, or `null` when it does not exist. */
async function readOptional(
  repoDir: string,
  rel: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${repoDir}/${rel}`);
  } catch {
    return null;
  }
}

/** Recursively list files under `repoDir/rel` (repo-relative, sorted). */
async function listFiles(repoDir: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(`${repoDir}/${dir}`)) {
        entries.push(entry);
      }
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) out.push(path);
    }
  }
  await walk(rel);
  return out.sort();
}

/** Top-level files of `repoDir` matching `pattern` (repo-relative, sorted). */
async function listTopLevel(
  repoDir: string,
  pattern: RegExp,
): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(repoDir)) {
      if (entry.isFile && pattern.test(entry.name)) out.push(entry.name);
    }
  } catch {
    return [];
  }
  return out.sort();
}

/** `.github/workflows/*.yml` and `.github/actions/**\/*.yml`. */
async function listWorkflowFiles(repoDir: string): Promise<string[]> {
  const isYaml = (p: string) => /\.ya?ml$/.test(p);
  const workflows = (await listFiles(repoDir, ".github/workflows")).filter(
    isYaml,
  );
  const actions = (await listFiles(repoDir, ".github/actions")).filter(isYaml);
  return [...workflows, ...actions];
}

/** Every shipped script surface the `deno-frozen` rule scans. */
async function listScriptFiles(repoDir: string): Promise<string[]> {
  const shell = (p: string) => /\.(sh|ps1)$/.test(p);
  const container = (await listFiles(repoDir, "container")).filter((p) =>
    /(?:^|\/)(?:Containerfile|Dockerfile)[^/]*$/.test(p) || /\.sh$/.test(p)
  );
  const files = [
    ...await listTopLevel(repoDir, /\.(sh|ps1)$/),
    ...container,
    ...(await listFiles(repoDir, "worker/shared")).filter(shell),
    ...await listFiles(repoDir, "hooks"),
    ...(await listFiles(repoDir, ".github/scripts")).filter(shell),
    ...await listWorkflowFiles(repoDir),
  ];
  if (await readOptional(repoDir, "worker/deno/deno.json") !== null) {
    files.push("worker/deno/deno.json");
  }
  return files;
}

/** Container files whose `FROM` lines are checked. */
async function listContainerFiles(repoDir: string): Promise<string[]> {
  return (await listFiles(repoDir, "container")).filter((p) =>
    /(?:^|\/)(?:Containerfile|Dockerfile)[^/]*$/.test(p)
  );
}

// ---------------------------------------------------------------------------
// (e) dependency inventory
// ---------------------------------------------------------------------------

/** One GitHub Action coordinate as used across the workflows. */
interface ActionUse {
  coordinate: string;
  ref: string;
  version: string;
  files: Set<string>;
}

/** Collect every `uses:` coordinate + ref across the workflow files. */
async function collectActionUses(repoDir: string): Promise<ActionUse[]> {
  const byKey = new Map<string, ActionUse>();
  for (const file of await listWorkflowFiles(repoDir)) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!USES_LINE.test(line)) return;
      const value = extractUsesValue(line);
      if (value === null || value.startsWith("./")) return;
      const at = value.lastIndexOf("@");
      const coordinate = at >= 0 ? value.slice(0, at) : value;
      const ref = at >= 0 ? value.slice(at + 1) : "";
      const key = `${coordinate}@${ref}`;
      const use = byKey.get(key) ??
        { coordinate, ref, version: "", files: new Set<string>() };
      use.files.add(file);
      if (use.version === "") {
        use.version = pinCommentVersion(lines, index, coordinate);
      }
      byKey.set(key, use);
    });
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.coordinate}@${a.ref}`.localeCompare(`${b.coordinate}@${b.ref}`)
  );
}

function actionVerdict(use: ActionUse): string {
  if (!SHA_PIN.test(use.ref)) return "UNPINNED (tag or branch ref)";
  return use.version === ""
    ? "pinned to commit SHA (no version comment)"
    : "pinned to commit SHA";
}

/** Markdown table cell: escape pipes, show empty as an em dash. */
function cell(value: string): string {
  return value === "" ? "—" : value.replaceAll("|", "\\|");
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  const head = `| ${headers.join(" | ")} |\n| ${
    headers.map(() => "---").join(" | ")
  } |\n`;
  const filled = rows.length > 0
    ? rows
    : [["(none)", ...headers.slice(1).map(() => "")]];
  const body = filled.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
  return head + body + "\n";
}

async function actionsSection(repoDir: string): Promise<string> {
  const uses = await collectActionUses(repoDir);
  const rows = uses.map((u) => [
    u.coordinate,
    u.version,
    u.ref,
    [...u.files].sort().join(", "),
    actionVerdict(u),
  ]);
  return "## GitHub Actions\n\n" +
    "Every third-party action and reusable workflow referenced under " +
    "`.github/`, keyed by coordinate and pinned ref.\n\n" +
    table(["Action", "Version", "Commit SHA", "Used in", "Verdict"], rows);
}

async function baseImagesSection(repoDir: string): Promise<string> {
  const rows: string[][] = [];
  for (const file of await listContainerFiles(repoDir)) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    for (const ref of listBaseImages(text)) {
      const at = ref.resolved.indexOf("@");
      const named = at >= 0 ? ref.resolved.slice(0, at) : ref.resolved;
      const digest = at >= 0 ? ref.resolved.slice(at + 1) : "";
      rows.push([
        named,
        digest,
        `${file}:${ref.line}${ref.arg ? ` (ARG ${ref.arg})` : ""}`,
        DIGEST_REF.test(ref.resolved) ? "digest-pinned" : "TAG ONLY",
      ]);
    }
  }
  return "## Container base images\n\n" +
    table(["Image", "Digest", "Declared in", "Verdict"], rows);
}

/** Pinned tools from `container/tools.json` (tools, toolchains, providers). */
async function containerToolsSection(repoDir: string): Promise<string> {
  const text = await readOptional(repoDir, "container/tools.json");
  if (text === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "## Container tools\n\n(container/tools.json did not parse)\n";
  }
  if (!isRecord(parsed)) return "";
  const rows: string[][] = [];
  for (const kind of ["tools", "toolchains", "providers"] as const) {
    const list = parsed[kind];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const name = typeof item["name"] === "string"
        ? item["name"]
        : typeof item["id"] === "string"
        ? item["id"]
        : "";
      const version = typeof item["version"] === "string"
        ? item["version"]
        : "";
      const sha = isRecord(item["sha256"]) ? item["sha256"] : {};
      const digests = Object.entries(sha)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([arch, d]) => `${arch}: ${d}`)
        .join("<br>");
      rows.push([
        name,
        kind.replace(/s$/, ""),
        version,
        digests,
        digests === "" ? "version only" : "exact version + SHA-256 verified",
      ]);
    }
  }
  rows.sort((a, b) => `${a[1]}/${a[0]}`.localeCompare(`${b[1]}/${b[0]}`));
  return "## Container tools (container/tools.json)\n\n" +
    table(["Tool", "Kind", "Version", "SHA-256", "Verdict"], rows);
}

/** Lockfile lookup: specifier → { version, integrity }. */
interface LockedDep {
  version: string;
  integrity: string;
}

function parseLock(text: string | null): Map<string, LockedDep> {
  const out = new Map<string, LockedDep>();
  if (text === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;
  const specifiers = isRecord(parsed["specifiers"]) ? parsed["specifiers"] : {};
  for (const [spec, version] of Object.entries(specifiers)) {
    if (typeof version !== "string") continue;
    const scheme = spec.startsWith("jsr:")
      ? "jsr"
      : spec.startsWith("npm:")
      ? "npm"
      : "";
    const bare = spec.slice(spec.indexOf(":") + 1);
    const nameOnly = bare.slice(
      0,
      bare.lastIndexOf("@") > 0 ? bare.lastIndexOf("@") : bare.length,
    );
    const registry = isRecord(parsed[scheme]) ? parsed[scheme] : {};
    const entry = registry[`${nameOnly}@${version}`];
    const integrity = isRecord(entry) && typeof entry["integrity"] === "string"
      ? entry["integrity"]
      : "";
    out.set(spec, { version, integrity });
  }
  return out;
}

/** Strip a subpath (`jsr:@std/yaml@^1/parse` → `jsr:@std/yaml@^1`). */
function lockKeyFor(specifier: string): string {
  const scoped = specifier.replace(/^(jsr|npm):/, "");
  const at = scoped.lastIndexOf("@");
  if (at <= 0) return specifier;
  const afterVersion = scoped.indexOf("/", at);
  return afterVersion >= 0
    ? specifier.slice(0, specifier.length - (scoped.length - afterVersion))
    : specifier;
}

async function denoImportsSection(
  repoDir: string,
  title: string,
  dir: string,
): Promise<string> {
  const config = await readOptional(repoDir, `${dir}/deno.json`);
  if (config === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return `## ${title}\n\n(${dir}/deno.json did not parse)\n`;
  }
  const imports = isRecord(parsed) && isRecord(parsed["imports"])
    ? parsed["imports"]
    : {};
  const lock = parseLock(await readOptional(repoDir, `${dir}/deno.lock`));
  const rows = Object.entries(imports)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, specifier]) => {
      const locked = lock.get(lockKeyFor(specifier));
      const verdict = locked === undefined
        ? "NOT IN LOCKFILE"
        : locked.integrity === ""
        ? "locked (exact version)"
        : "locked (exact version + integrity)";
      return [
        alias,
        specifier,
        locked?.version ?? "",
        locked?.integrity ?? "",
        verdict,
      ];
    });
  return `## ${title}\n\n` +
    `Top-level imports of \`${dir}/deno.json\` resolved through ` +
    `\`${dir}/deno.lock\`.\n\n` +
    table(
      ["Import", "Specifier", "Locked version", "Integrity", "Verdict"],
      rows,
    );
}

async function toolchainSection(repoDir: string): Promise<string> {
  const rows: string[][] = [];
  for (
    const [tool, file] of [["Deno", ".deno-version"], [
      "Node.js",
      ".node-version",
    ]] as const
  ) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    rows.push([tool, text.trim(), file, "exact version"]);
  }
  return "## Toolchain versions\n\n" +
    table(["Tool", "Version", "Source", "Verdict"], rows);
}

/**
 * Generate the dependency inventory Markdown for `repoDir`. Deterministic:
 * sorted rows, no timestamps, so a committed copy can be compared byte for
 * byte and re-generated in a reviewable diff.
 */
export async function buildDependencyInventory(
  repoDir: string,
): Promise<string> {
  const sections = [
    await actionsSection(repoDir),
    await baseImagesSection(repoDir),
    await containerToolsSection(repoDir),
    await denoImportsSection(
      repoDir,
      "Worker Deno dependencies",
      "worker/deno",
    ),
    await denoImportsSection(
      repoDir,
      "Container Deno seed",
      "container/deno-seed",
    ),
    await toolchainSection(repoDir),
  ].filter((s) => s !== "");
  return "# 🔗 Dependency inventory\n\n" +
    "Generated by `supply-chain-gate --write-inventory` (Issue #4192) from " +
    "the tree it describes. Do not edit by hand: the gate fails when this " +
    "file no longer matches what the tree declares, so every dependency " +
    "change lands with a reviewable diff of this record. The verdict column " +
    "is the gate's deterministic posture reading of each entry, not a " +
    "vulnerability assessment (that is `dependency-audit.yml`).\n\n" +
    sections.join("\n");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Compare the committed inventory with the generated one. */
export function checkInventoryCurrent(
  inventoryPath: string,
  committed: string | null,
  generated: string,
): GateFinding[] {
  if (committed !== null && committed.trimEnd() === generated.trimEnd()) {
    return [];
  }
  return [{
    rule: "inventory-stale",
    file: inventoryPath,
    line: 1,
    message: committed === null
      ? "dependency inventory is missing; run supply-chain-gate " +
        "--write-inventory and commit the result"
      : "dependency inventory is stale — the tree's dependencies changed; " +
        "run supply-chain-gate --write-inventory and commit the result",
  }];
}

/** Run every check over the tree and return the structured report. */
export async function runSupplyChainGate(
  options: GateOptions,
): Promise<GateReport> {
  const { repoDir } = options;
  const inventoryPath = options.inventoryPath ?? DEFAULT_INVENTORY_PATH;
  const allowlist = options.denoAllowlist ?? DENO_INVOCATION_ALLOWLIST;
  const findings: GateFinding[] = [];
  const checked: GateChecked = {
    workflowFiles: 0,
    usesReferences: 0,
    scriptFiles: 0,
    denoInvocations: 0,
    containerFiles: 0,
    baseImages: 0,
    renovateConfig: false,
  };

  for (const file of await listWorkflowFiles(repoDir)) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    checked.workflowFiles++;
    checked.usesReferences += text.split("\n").filter((l) =>
      USES_LINE.test(l)
    ).length;
    findings.push(...findUnpinnedUses(file, text));
  }

  for (const file of await listScriptFiles(repoDir)) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    checked.scriptFiles++;
    checked.denoInvocations += listDenoInvocations(file, text).length;
    findings.push(...findUnfrozenDenoInvocations(file, text, allowlist));
  }

  for (const file of await listContainerFiles(repoDir)) {
    const text = await readOptional(repoDir, file);
    if (text === null) continue;
    checked.containerFiles++;
    checked.baseImages += listBaseImages(text).length;
    findings.push(...findTagOnlyBaseImages(file, text));
    findings.push(...findUnqualifiedBaseImages(file, text));
  }

  const renovate = await readOptional(repoDir, "renovate.json");
  if (renovate !== null) {
    checked.renovateConfig = true;
    findings.push(...evaluateRenovate("renovate.json", renovate));
  }

  const inventory = await buildDependencyInventory(repoDir);
  findings.push(
    ...checkInventoryCurrent(
      inventoryPath,
      await readOptional(repoDir, inventoryPath),
      inventory,
    ),
  );

  findings.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line ||
    a.rule.localeCompare(b.rule)
  );
  return {
    ok: findings.length === 0,
    findings,
    checked,
    inventory,
    inventoryPath,
  };
}

/** Parse then evaluate a renovate config, failing loud on bad JSON. */
function evaluateRenovate(file: string, text: string): GateFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [{
      rule: "renovate-parse",
      file,
      line: 1,
      message: `renovate.json did not parse: ${(error as Error).message}`,
    }];
  }
  return evaluateRenovatePolicy(file, parsed);
}

/** Human-readable report: one `file:line: [rule] message` per finding. */
export function formatGateReport(report: GateReport): string {
  const c = report.checked;
  const scanned = `Scanned ${c.workflowFiles} workflow file(s) / ` +
    `${c.usesReferences} uses: reference(s), ${c.scriptFiles} script file(s) / ` +
    `${c.denoInvocations} deno invocation(s), ${c.containerFiles} container ` +
    `file(s) / ${c.baseImages} base image(s), renovate.json ` +
    `${c.renovateConfig ? "present" : "absent"}.`;
  if (report.findings.length === 0) {
    return `✅ supply-chain-gate: no findings. ${scanned}`;
  }
  const lines = report.findings.map((f) =>
    `${f.file}:${f.line}: [${f.rule}] ${f.message}`
  );
  return `❌ supply-chain-gate: ${report.findings.length} finding(s). ` +
    `${scanned}\n${lines.join("\n")}`;
}
