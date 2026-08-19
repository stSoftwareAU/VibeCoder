/**
 * Native unpinned-CI-install pre-filer for the github-actions-audit
 * template (Issue #3668, split out of #3642 — fixed in #3667).
 *
 * `action_pin_scanner.ts` only inspects `uses:` references, so a
 * `run:`-level install — `npm install -g <pkg>`, `npx --yes <pkg>`,
 * `gem install <pkg>` — with no version pin was invisible to every native
 * pre-filer. A monitored repo could therefore fetch a third-party package
 * at build time outside any dependency quarantine and the audit would not
 * flag it: #3642 was found by the LLM `security-scan` template, never
 * deterministically.
 *
 * The danger: an unpinned install resolves to whatever the registry serves
 * at run time. A hijacked release therefore executes on the runner — with
 * the workflow's `GITHUB_TOKEN` and any secrets in scope — the moment it is
 * published, with zero embargo. Renovate's `minimumReleaseAge` (and Deno's
 * `minimumDependencyAge`) only cover manifests the tool can manage, and a
 * `run:` block is not a manifest.
 *
 * Scope — deliberately narrow (precision over recall, mirroring the sibling
 * pre-filers):
 *   - `npm install` / `npm i` / `npm add` arguments with no exact version.
 *   - `npx --yes <pkg>` / `npx -p <pkg>` — the **explicit-fetch** forms.
 *     A bare `npx <pkg>` prefers a binary already in `node_modules`, which
 *     the lockfile (and Renovate) already govern, so it is not flagged.
 *   - `gem install <pkg>` with no exact `-v` / `--version`.
 *
 * Local, file, git, and URL specs, shell variables (`$PKG`), comment lines,
 * flags, and non-install subcommands (`npm ci`, `npm config set …`) are
 * never flagged.
 *
 * Commands are normalised before matching (Issue #3953): backslash line
 * continuations are joined, wrapper prefixes (`sudo`, `env`, `command`,
 * `exec`, their flags, and leading `VAR=value` assignments) are stripped,
 * and the subcommand is the first non-flag argument rather than a fixed
 * index. Without that, `sudo npm install -g <pkg>` and
 * `npm --global install <pkg>` — two of the commonest real-world spellings
 * — read as clean, and a continued command produced a garbage finding id.
 *
 * Findings consolidate one per distinct unpinned package coordinate
 * (`<tool>` + package name), listing every call-site `file:line` — mirroring
 * `action_pin_scanner.ts`, which avoids an issue flood when one package is
 * installed by several workflows. Stable id is
 * `BP-CI-INSTALL-PIN-<tool>-<package-slug>`, where `<package-slug>` is
 * injective in the package name (Issue #3954): a name that does not
 * round-trip through the slug carries a digest of the raw name, so a
 * suppression for `@foo/bar` no longer silences a `foo.bar` typosquat. The
 * `BP-` prefix is required:
 * `idle_task_snapshot.listKnownOpenFindingIds` defaults `idPrefix` to
 * `BP-`, so a non-`BP-` id silently breaks dedup and the LLM re-files.
 *
 * Severity is `medium` — a supply-chain exposure gated on an upstream
 * compromise, not a directly-exploitable path.
 *
 * Per Issue #3239 the audit only **reports**: each repo fixes its own
 * workflows on a normal per-repo PR. No cross-repo mechanism is introduced.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`. Never throws on malformed input.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** An exact semver pin — `1.2.3`, optionally with a pre-release suffix. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Specs the registry quarantine never applied to: local paths, `file:`,
 * `git+`, and `http(s):` specs (first-party or already immutable), plus
 * shell variables, whose value is not statically decidable.
 */
const SPEC_EXEMPT = /^(?:\.|\/|file:|git\+|https?:|\$)/;

/** Severity emoji for the `medium` band (matches the sibling pre-filers). */
const MEDIUM_EMOJI = "🟠";

/**
 * Wrappers that sit in front of the real tool (Issue #3953). `sudo npm
 * install -g <pkg>` and `env FOO=bar npm install <pkg>` are ordinary CI
 * spellings; before this the tool had to be token 0, so both read as clean.
 */
const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "exec"]);

/**
 * Prefix flags that consume the following token as their value, so the
 * value is not mistaken for the tool (`sudo -u ci npm install …`).
 */
const PREFIX_VALUE_FLAGS = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-p",
  "--prompt",
  "-C",
  "--chdir",
  "-D",
  "-R",
  "--chroot",
  "-r",
  "--role",
  "-t",
  "--type",
]);

/** A leading `VAR=value` shell assignment, e.g. `NODE_ENV=ci`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * One unpinned install found in a `run:` block: the offending command and
 * the package it would have resolved at run time.
 */
export interface UnpinnedInstall {
  /** `npm`, `npx`, or `gem`. */
  tool: string;
  /** The package argument as written, e.g. `pa11y-ci@3`. */
  spec: string;
  /** The package name without any version suffix, e.g. `pa11y-ci`. */
  packageName: string;
  /** The unpinned version as written (`3`, `^14.1.1`), or `null` if absent. */
  version: string | null;
  /** The whole command the spec came from, backslash continuations joined. */
  command: string;
  /**
   * First physical line of that command as written in the file — the text
   * used to anchor the call-site's line number when the command spans
   * several lines (Issue #3953). Equals `command` when it does not.
   */
  anchor: string;
}

/** A single call-site a consolidated finding covers. */
export interface CiInstallCallSite {
  /** Repo-relative file path, e.g. `.github/workflows/ci.yml`. */
  file: string;
  /** Best-effort 1-based line number of the offending command. */
  line: number;
  /** Job (or `runs` for a composite action) the step belongs to. */
  job: string;
  /** The package argument as written at this call-site. */
  spec: string;
  /** The command line the spec came from. */
  command: string;
}

/** A consolidated unpinned-install finding for one package coordinate. */
export interface CiInstallPinFinding {
  /** Stable id `BP-CI-INSTALL-PIN-<tool>-<package-slug>`. */
  findingId: string;
  /** `npm`, `npx`, or `gem`. */
  tool: string;
  /** The package name the finding is raised against. */
  packageName: string;
  /** Always `medium` — a supply-chain exposure, not a direct-RCE path. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** First call-site file (the consolidated lead). */
  file: string;
  /** First call-site line. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block listing every call-site. */
  evidence: string;
  /** Every call-site this finding consolidates. */
  callSites: CiInstallCallSite[];
}

/** Options for {@link scanCiInstallPins}. */
export interface ScanCiInstallPinsOptions {
  /** Stable ids suppressed by prior triage — skip these coordinates. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these coordinates. */
  knownOpenFindingIds?: Iterable<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Slugify a package name into `[a-z0-9-]`. Lossy: `@`, `/`, `.` and `_` all
 * collapse to `-`, so this is never the whole id — see {@link packageSlug}.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 48-bit digest of a package name, as 12 lower-case hex characters. Two
 * independent 32-bit hashes (FNV-1a and djb2) are combined so accidental
 * collisions stay negligible, mirroring `duplicate_block_scanner.ts`.
 */
function nameDigest(value: string): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return fnv.toString(16).padStart(8, "0") +
    (djb & 0xffff).toString(16).padStart(4, "0");
}

/**
 * The `<package-slug>` portion of the stable id — injective in the package
 * name (Issue #3954).
 *
 * The bare slug collapses `@foo/bar`, `foo.bar` and `foo_bar` onto one id,
 * and a punctuation-only spec onto the empty string. That id is the
 * suppression and known-open key, so a waiver granted for one package
 * silently swallowed a typosquat sharing its slug.
 *
 * A name that round-trips through {@link slugify} is already unique, so it
 * keeps its plain slug and previously-filed ids stay stable; every other
 * name carries a digest of the raw name, and an empty slug is marked `pkg`
 * rather than emitting a shared, dangling-hyphen id.
 */
function packageSlug(packageName: string): string {
  const slug = slugify(packageName);
  if (slug === packageName) return slug;
  const digest = nameDigest(packageName);
  return slug === "" ? `pkg-${digest}` : `${slug}-${digest}`;
}

/** Strip one layer of surrounding single/double quotes from a token. */
function unquote(token: string): string {
  const q = token[0];
  if ((q === '"' || q === "'") && token.endsWith(q) && token.length >= 2) {
    return token.slice(1, -1);
  }
  return token;
}

/** Split a `name@version` spec, honouring a leading `@scope/`. */
function versionOf(spec: string): string | null {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : null;
}

/** The package name of a spec, with any `@version` suffix removed. */
function nameOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** True when the spec carries an exact `name@1.2.3` pin. */
function isExactlyPinned(spec: string): boolean {
  const version = versionOf(spec);
  return version !== null && EXACT_VERSION.test(version);
}

/** Build an {@link UnpinnedInstall} from a spec as written. */
function hit(
  tool: string,
  spec: string,
  line: LogicalLine,
  version: string | null = versionOf(spec),
): UnpinnedInstall {
  return {
    tool,
    spec,
    packageName: nameOf(spec),
    version,
    command: line.command,
    anchor: line.anchor,
  };
}

/** One shell command, with the first physical line it started on. */
interface LogicalLine {
  /** The command with any backslash continuations joined onto one line. */
  command: string;
  /** The first physical line as written, used to anchor the file line. */
  anchor: string;
}

/**
 * Join backslash line continuations so a wrapped install reads as one
 * command (Issue #3953). Without this, `npm install -g \` flagged the
 * trailing `\` as the package and produced the garbage id `…-npm-`.
 */
function joinContinuations(run: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let buffer = "";
  let anchor: string | null = null;

  for (const rawLine of run.split("\n")) {
    const line = rawLine.trim();
    if (anchor === null) anchor = line;
    if (line.endsWith("\\")) {
      buffer += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push({ command: `${buffer}${line}`.trim(), anchor });
    buffer = "";
    anchor = null;
  }
  // A trailing continuation with nothing after it still yields its command.
  if (buffer.length > 0) {
    out.push({ command: buffer.trim(), anchor: anchor ?? buffer.trim() });
  }
  return out;
}

/**
 * Drop the wrapper prefix in front of the real tool — `sudo`, `env`,
 * `command`, `exec`, their flags, and leading `VAR=value` assignments —
 * so the tool is found wherever it sits (Issue #3953).
 */
function stripCommandPrefix(tokens: readonly string[]): readonly string[] {
  let i = 0;
  let sawWrapper = false;

  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (ENV_ASSIGNMENT.test(token)) {
      i++;
      continue;
    }
    if (COMMAND_PREFIXES.has(token)) {
      sawWrapper = true;
      i++;
      continue;
    }
    // `--` ends the wrapper's own options; the tool follows immediately.
    if (sawWrapper && token === "--") {
      i++;
      break;
    }
    if (sawWrapper && token.startsWith("-")) {
      if (PREFIX_VALUE_FLAGS.has(token)) i++;
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * The index of the subcommand — the first non-flag argument after the tool
 * — or `-1` when the command carries none. `npm --global install <pkg>`
 * spells the subcommand at index 2, so a fixed index misses it.
 */
function subcommandIndex(args: readonly string[]): number {
  return args.findIndex((t) => !t.startsWith("-"));
}

/**
 * Find every unpinned third-party package install in a shell snippet taken
 * from a workflow `run:` block.
 *
 * Flags:
 *   - `npm install`/`npm i`/`npm add` arguments without an exact version;
 *   - `npx --yes <pkg>` / `npx -p <pkg>` (the explicit-fetch forms) without
 *     an exact version — a bare `npx <pkg>` prefers the lockfile-governed
 *     binary in `node_modules` and is not flagged;
 *   - `gem install <pkg>` without an exact `-v`/`--version`.
 *
 * Comment lines, flags, local/URL/variable specs, and non-install npm
 * subcommands (`npm ci`, `npm config set …`) are ignored.
 *
 * Pure — no I/O. Never throws.
 */
export function findUnpinnedInstalls(run: string): UnpinnedInstall[] {
  const found: UnpinnedInstall[] = [];

  for (const logical of joinContinuations(run)) {
    if (logical.command.length === 0 || logical.command.startsWith("#")) {
      continue;
    }

    // A line may chain commands; inspect each segment separately.
    for (const segment of logical.command.split(/&&|\|\||;|\|/)) {
      const command = segment.trim();
      // Quotes are shell syntax, not part of the spec — `"$TOOL"` must
      // read as the variable `$TOOL` so it stays exempt.
      const tokens = stripCommandPrefix(
        command.split(/\s+/).filter((t) => t.length > 0).map(unquote),
      );
      if (tokens.length === 0) continue;
      // Evidence keeps the command as written; only matching is normalised.
      const line: LogicalLine = { command, anchor: logical.anchor };

      const tool = tokens[0] as string;
      if (tool === "npm") {
        collectNpmInstalls(tokens, line, found);
      } else if (tool === "npx") {
        collectNpxFetches(tokens, line, found);
      } else if (tool === "gem") {
        collectGemInstalls(tokens, line, found);
      }
    }
  }

  return found;
}

/** `npm install|i|add <spec>…` — every non-flag spec must be exact. */
function collectNpmInstalls(
  tokens: readonly string[],
  line: LogicalLine,
  found: UnpinnedInstall[],
): void {
  const args = tokens.slice(1);
  const at = subcommandIndex(args);
  if (at < 0) return;
  const sub = args[at];
  if (sub !== "install" && sub !== "i" && sub !== "add") return;
  for (const spec of args.slice(at + 1)) {
    if (spec.startsWith("-")) continue;
    if (SPEC_EXEMPT.test(spec)) continue;
    if (isExactlyPinned(spec)) continue;
    found.push(hit("npm", spec, line));
  }
}

/**
 * `npx --yes <spec>` / `npx -p <spec>` — only the explicit-fetch forms.
 * A bare `npx <spec>` prefers a binary already installed in
 * `node_modules`, which the lockfile already pins, so it is not flagged.
 */
function collectNpxFetches(
  tokens: readonly string[],
  line: LogicalLine,
  found: UnpinnedInstall[],
): void {
  let explicitFetch = false;
  let expectPackage = false;
  for (const token of tokens.slice(1)) {
    if (token === "-p" || token === "--package") {
      explicitFetch = true;
      expectPackage = true;
      continue;
    }
    if (token === "-y" || token === "--yes") {
      explicitFetch = true;
      continue;
    }
    if (token.startsWith("-") && !expectPackage) continue;
    if (!explicitFetch) return; // Bare `npx <pkg>` — lockfile-governed.
    if (!SPEC_EXEMPT.test(token) && !isExactlyPinned(token)) {
      found.push(hit("npx", token, line));
    }
    return; // Only the package argument is inspected.
  }
}

/** `gem install <spec>… [-v <version>]` — the `-v` must be exact. */
function collectGemInstalls(
  tokens: readonly string[],
  line: LogicalLine,
  found: UnpinnedInstall[],
): void {
  const args = tokens.slice(1);
  const at = subcommandIndex(args);
  if (at < 0 || args[at] !== "install") return;
  const rest = args.slice(at + 1);
  const flagIndex = rest.findIndex((t) => t === "-v" || t === "--version");
  const version = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  const pinned = version !== undefined && EXACT_VERSION.test(version);
  if (pinned) return;
  for (const [i, spec] of rest.entries()) {
    if (spec.startsWith("-")) continue;
    if (flagIndex >= 0 && i === flagIndex + 1) continue; // the version
    if (SPEC_EXEMPT.test(spec)) continue;
    found.push(hit("gem", spec, line, version ?? null));
  }
}

/** One `run:` step paired with the job it belongs to. */
interface RunStep {
  job: string;
  run: string;
}

/**
 * Collect every `run:` step of a workflow (`jobs.*.steps[]`) or composite
 * action (`runs.steps[]`), paired with its job name. Composite-action steps
 * are attributed to the pseudo-job `runs`.
 *
 * Pure — no I/O. Malformed structures yield no steps.
 */
function collectRunSteps(parsed: unknown, kind: string): RunStep[] {
  const out: RunStep[] = [];
  if (!isRecord(parsed)) return out;

  const pushSteps = (job: string, steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const run = step.run;
      if (typeof run === "string" && run.length > 0) out.push({ job, run });
    }
  };

  if (kind === "composite-action") {
    const runs = parsed.runs;
    if (isRecord(runs)) pushSteps("runs", runs.steps);
    return out;
  }

  const jobs = parsed.jobs;
  if (!isRecord(jobs)) return out;
  for (const [jobName, jobValue] of Object.entries(jobs)) {
    if (!isRecord(jobValue)) continue;
    pushSteps(jobName, jobValue.steps);
  }
  return out;
}

/**
 * Best-effort 1-based line of `anchor` in the raw file, skipping lines
 * already claimed by an earlier call-site so repeated installs of the same
 * package anchor to distinct lines. Falls back to 1 when nothing matches.
 *
 * The anchor is the command's first physical line, so a backslash-continued
 * install still cites the line it starts on (Issue #3953).
 */
function lineOfCommand(
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
 * Scan every workflow and composite action for `run:`-level package
 * installs with no exact version pin, returning one consolidated
 * {@link CiInstallPinFinding} per distinct `<tool>`/package coordinate.
 *
 * Behaviour:
 *   - Workflows (`jobs.*.steps[].run`) and composite actions
 *     (`runs.steps[].run`) are both scanned.
 *   - Unparseable files (parsed `null`) and non-record roots yield no
 *     finding.
 *   - Exactly-pinned installs, local/URL/variable specs, and bare
 *     `npx <pkg>` invocations are never flagged.
 *   - Call-sites suppressed by an in-source `best-practice-ignore:
 *     BP-CI-INSTALL-PIN-…` marker are dropped; a coordinate with no
 *     surviving call-sites yields no finding.
 *   - Coordinates whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 */
export function scanCiInstallPins(
  files: readonly WorkflowFile[],
  opts: ScanCiInstallPinsOptions = {},
): CiInstallPinFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);

  // findingId → { tool, packageName, callSites }
  const byCoordinate = new Map<string, {
    tool: string;
    packageName: string;
    callSites: CiInstallCallSite[];
  }>();

  for (const file of files) {
    const lines = file.rawText.split("\n");
    const claimed = new Set<number>();

    for (const step of collectRunSteps(file.parsed, file.kind)) {
      for (const install of findUnpinnedInstalls(step.run)) {
        const findingId = `BP-CI-INSTALL-PIN-${install.tool}-${
          packageSlug(install.packageName)
        }`;
        const line = lineOfCommand(lines, install.anchor, claimed);
        // Honour in-source suppression markers per call-site.
        if (isFindingSuppressed(file.rawText, line, findingId, file.path)) {
          continue;
        }

        let entry = byCoordinate.get(findingId);
        if (entry === undefined) {
          entry = {
            tool: install.tool,
            packageName: install.packageName,
            callSites: [],
          };
          byCoordinate.set(findingId, entry);
        }
        entry.callSites.push({
          file: file.path,
          line,
          job: step.job,
          spec: install.spec,
          command: install.command,
        });
      }
    }
  }

  const findings: CiInstallPinFinding[] = [];
  for (const [findingId, entry] of byCoordinate) {
    if (entry.callSites.length === 0) continue;
    if (suppressed.has(findingId)) continue;
    if (knownOpen.has(findingId)) continue;
    findings.push(buildFinding(findingId, entry));
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

/** Render the exact-pin example for the tool that raised the finding. */
function pinExample(tool: string, packageName: string): string {
  if (tool === "gem") {
    return `gem install ${packageName} -v 1.2.3`;
  }
  if (tool === "npx") {
    return `npx --yes ${packageName}@1.2.3`;
  }
  return `npm install -g ${packageName}@1.2.3`;
}

/** Assemble the consolidated finding body for one coordinate. */
function buildFinding(
  findingId: string,
  entry: {
    tool: string;
    packageName: string;
    callSites: CiInstallCallSite[];
  },
): CiInstallPinFinding {
  const sites = [...entry.callSites].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  );
  const first = sites[0] as CiInstallCallSite;
  const count = sites.length;
  const pkg = entry.packageName;

  const evidenceLines = sites.map((s) =>
    `- \`${s.file}\`:${s.line} — job \`${s.job}\`: \`${s.command}\``
  );

  return {
    findingId,
    tool: entry.tool,
    packageName: pkg,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Pin the CI install of \`${pkg}\` to an exact ` +
      "version",
    file: first.file,
    lines: first.line,
    whyItMatters:
      `A \`run:\` step installs \`${pkg}\` with no exact version, so the ` +
      "build resolves whatever the registry serves at that moment. A " +
      "hijacked or malicious release therefore executes on the runner — " +
      "with the workflow's `GITHUB_TOKEN` and any secrets in scope — the " +
      "instant it is published, with no embargo. Renovate's " +
      "`minimumReleaseAge` (and Deno's `minimumDependencyAge`) only cover " +
      "manifests the tool can manage, and a `run:` block is not a " +
      "manifest, so the repository's dependency quarantine does not apply " +
      "here. `uses:` SHA-pinning does not cover this either — " +
      "`action_pin_scanner.ts` never inspects `run:`.",
    suggestedFix:
      `Pin the install to an exact version, e.g. \`${
        pinExample(entry.tool, pkg)
      }\`, and add a Renovate \`customManagers\` regex entry covering ` +
      ".github/workflows so the pin is kept current inside the quarantine " +
      "window. Do not add `--ignore-scripts` blindly: some packages need " +
      "their postinstall step (for example `pa11y-ci` fetching a browser), " +
      "and dropping it breaks the job — pinning is the fix here, " +
      "`--ignore-scripts` is a separate judgement per package. If this " +
      "install is intentionally floating, suppress it with an in-source " +
      `\`# best-practice-ignore: ${findingId} — <reason>\` comment on or ` +
      "above the offending line.",
    evidence: count === 1
      ? evidenceLines.join("\n")
      : `${count} call-sites:\n${evidenceLines.join("\n")}`,
    callSites: sites,
  };
}
