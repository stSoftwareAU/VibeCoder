/**
 * Type-check gate for the `main` → `milestone/<name>` sync merge (Issue #974).
 *
 * The sync pushed whatever the merge produced. Git reported no conflict
 * because both sides were internally consistent — only their combination was
 * not — so a resolution that dropped live wiring reached the milestone branch
 * three times running, and `milestone/*` has no required checks to catch it
 * downstream (#928, #796).
 *
 * This module answers one question about the merged tree, before the push:
 * does it still compile? The repository's own check is used — its
 * `deno task check` where one is defined, otherwise `deno check '**\/*.ts'` —
 * so the gate is the repo's gate rather than a second opinion invented here.
 *
 * A check that cannot be run reports `failed`, not `passed`: absence of a
 * failure is not success, and a tree nobody verified is exactly the tree this
 * gate exists to keep off the branch.
 *
 * A `cargo check` can also fail because a workspace package's `rust-version`
 * is newer than the container's pinned `rustc` (Issue #3255) — a refusal no
 * resolution change can answer. That is reported as a {@link RustToolchainGap}
 * rather than an ordinary failure, so the repair rounds in
 * `milestone_gate_repair.ts` are not spent retrying a host toolchain limit as
 * though it were a bad resolution. When only dependencies are too new, cargo
 * itself names a `Cargo.lock` remedy (`cargo update --precise`), so that form
 * stays an ordinary, repairable failure.
 *
 * A `cargo check` can also fail because the host cannot reach the crate
 * registry (Issue #4786). That is a host fault, not a bad resolution, so the
 * check is retried once offline, from the local cargo cache, and if the retry
 * still cannot reach the registry the project is left to CI as a timed-out
 * check is.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { GateAccountUnavailable, manifestsFor, runRepositoryCommand } from "./untrusted_gate_spawn.ts";
import { stripJsonc } from "./jsonc.ts";
import { stripAnsi } from "./github_actions_log_fetcher.ts";
import { CARGO_BUILD_SKIPPED_FOR_MERGE, shouldSkipEphemeralCargoBuild } from "./heavy_build_gate.ts";
import { findProjectManifests, isFile } from "./project_manifests.ts";
export { findProjectManifests, MERGE_GATE_MAX_DEPTH } from "./project_manifests.ts";
/**
 * How long a Deno project's merged-tree type check may run before it is
 * killed. A Cargo project has its own limit, {@link CARGO_MERGE_GATE_TIMEOUT_MS}.
 */ export const MERGE_GATE_TIMEOUT_MS = 300_000;
/**
 * How long a Cargo project's merged-tree type check may run before it is
 * killed (Issue #4787). A cold `cargo check --workspace --all-targets` of a
 * large workspace outruns the Deno limit, so a Cargo tree was killed at that
 * limit and refused on every cycle.
 */ export const CARGO_MERGE_GATE_TIMEOUT_MS = 900_000;
/**
 * The time limit for a project's type check, chosen by its toolchain: the
 * Cargo limit for `cargo`, and {@link MERGE_GATE_TIMEOUT_MS} otherwise.
 *
 * @param kind - The toolchain that checks the project
 * @returns The limit, in milliseconds
 */ export function typeCheckTimeoutMs(kind) {
  return kind === "cargo" ? CARGO_MERGE_GATE_TIMEOUT_MS : MERGE_GATE_TIMEOUT_MS;
}
/** Error name carried by the refusal, so callers can escalate on it. */ export const MILESTONE_MERGE_GATE_ERROR = "MilestoneMergeGateFailure";
/** Longest check output carried into a log line or an escalation comment. */ const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;
/** How a project's check is spelled in a log line or an escalation. */ export function describeProject(project) {
  return `${project.kind} ${project.args.join(" ")}`;
}
/**
 * The causes that mean the tree was not verified at all (Issue #4847): the
 * check could not give a verdict, so nothing shows the tree is bad. Every cause
 * except `tree-check-failed`.
 */ export const MERGE_GATE_UNVERIFIED_CAUSES = new Set([
  "check-timed-out",
  "check-could-not-run",
  "tree-unreadable",
  "rust-toolchain-too-old"
]);
/**
 * Fixed short phrase for each cause (Issue #4847). It names no path and no
 * tool output, so it is safe to carry into a ledger reason and an issue body.
 */ const MERGE_GATE_CAUSE_PHRASES = {
  "tree-check-failed": "the repository's check failed",
  "check-timed-out": "the check timed out",
  "check-could-not-run": "the check could not be run",
  "tree-unreadable": "the tree could not be read",
  "rust-toolchain-too-old": "Rust toolchain too old"
};
/** Whether a value is one of the known merge-gate causes (Issue #4847). */ export function isMergeGateCause(value) {
  return typeof value === "string" && Object.hasOwn(MERGE_GATE_CAUSE_PHRASES, value);
}
/** The fixed short phrase that describes a cause (Issue #4847). */ export function describeMergeGateCause(cause) {
  return MERGE_GATE_CAUSE_PHRASES[cause];
}
/**
 * Which arguments run this project's type check.
 *
 * A `check` task in the manifest is the repository's own gate — flags,
 * lockfile pins and all — so it is preferred. `deno.jsonc` may carry comments,
 * so the manifest is stripped before parsing rather than quietly losing the
 * repo's own task to a `JSON.parse` failure. A manifest that still cannot be
 * read falls back to a whole-tree `deno check`, which type-checks the same
 * files with default flags.
 */ async function resolveCheckArgs(manifestPath) {
  return (await readManifestTasks(manifestPath)).includes("check") ? [
    "task",
    "check"
  ] : [
    "check",
    "**/*.ts"
  ];
}
/** The command text in a Deno string-form or command-bearing object task. */ function manifestTaskCommand(task) {
  const command = typeof task === "string" ? task : task?.command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}
/**
 * `cargo check` over the whole workspace, every target (Issue #2138) —
 * `--locked` only when a `Cargo.lock` is committed, so a merged lockfile
 * that no longer matches is a failure and an unlocked crate is not refused
 * for a file it never had.
 */ export async function cargoCheckArgs(dir) {
  const args = [
    "check",
    "--workspace",
    "--all-targets"
  ];
  if (await isFile(`${dir}/Cargo.lock`)) args.push("--locked");
  return args;
}
/**
 * The task names a Deno manifest defines.
 *
 * String tasks and object tasks with a non-empty `command` count. A
 * dependencies-only object is excluded because these gates discover commands
 * to run, not task aliases. A manifest whose `tasks` key is malformed defines
 * none, and an unparseable manifest is read the same way — the caller then
 * falls back to a check it can run rather than trying a task that may not exist.
 *
 * Shared with the conflict-resolution gate (Issue #1559), which runs more of a
 * repository's own tasks than a type check alone.
 *
 * @param manifestPath - Path to `deno.json` or `deno.jsonc`
 * @returns Every task name the manifest defines; empty when it defines none
 */ export async function readManifestTasks(manifestPath) {
  try {
    const parsed = JSON.parse(stripJsonc(await Deno.readTextFile(manifestPath)));
    const tasks = parsed?.tasks;
    if (!tasks || typeof tasks !== "object") return [];
    return Object.entries(tasks).filter(([, task])=>manifestTaskCommand(task) !== undefined).map(([name])=>name);
  } catch  {
    // Unparseable manifest — it defines nothing this gate can run.
    return [];
  }
}
/**
 * The type check to run for every Deno project in a tree.
 *
 * @param repoDir - Root of the merged working tree
 * @returns Every project to check; empty when the tree defines none
 */ export async function findTypeCheckProjects(repoDir) {
  const found = [];
  for (const project of (await findProjectManifests(repoDir))){
    found.push({
      dir: project.dir,
      kind: project.kind,
      args: project.kind === "cargo" ? await cargoCheckArgs(project.dir) : await resolveCheckArgs(project.manifest)
    });
  }
  return found;
}
/**
 * Collapse consecutive identical lines into one line marked `(×N)`.
 *
 * Cargo's "requires rustc" refusal repeats the same line once per target —
 * `neat_ai_discovery@0.74.279 requires rustc 1.99` forty times over — which
 * pushed the one line that mattered for Issue #3255 out of the kept tail
 * entirely. Only *consecutive* duplicates collapse: lines repeated with other
 * output between them are a weaker signal of the same cause and are kept as
 * they were.
 *
 * @param output - The raw check output, before it is trimmed to a tail
 * @returns The same lines, with consecutive runs collapsed
 */ export function collapseRepeatedLines(output) {
  const lines = output.split("\n");
  const collapsed = [];
  let i = 0;
  while(i < lines.length){
    const line = lines[i];
    let run = 1;
    while(i + run < lines.length && lines[i + run] === line)run++;
    collapsed.push(run > 1 ? `${line} (×${run})` : line);
    i += run;
  }
  return collapsed.join("\n");
}
/** Keep the tail of the output — the errors sit at the end of a check run. */ function tail(output) {
  const lines = collapseRepeatedLines(output.trim()).split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}
/** Longest line considered for a toolchain-gap pattern (Issue #3255). */ const MAX_GAP_LINE_CHARS = 4000;
/**
 * Cargo's "rustc X is not supported" header, naming the host's version.
 *
 * Anchored on a literal prefix before the numeric capture and a literal
 * suffix after it, so the capture's `[0-9.]*` cannot backtrack against
 * hostile input — each character is either a digit/dot (consumed by the
 * class) or the first character of the literal suffix (which the class never
 * matches), so the match is a single linear pass.
 */ const RUSTC_HEADER_RE = /^error: rustc ([0-9][0-9.]*) is not supported/;
/**
 * One cargo "package@version requires rustc X" line.
 *
 * The same anchoring reasoning as {@link RUSTC_HEADER_RE}: `[^\s@]+` is
 * disjoint from the literal `@` and ` ` that follow it, so neither capture
 * group can backtrack into the next.
 */ const RUSTC_REQUIRES_RE = /^([^\s@]+)@([^\s@]+) requires rustc ([0-9][0-9.]*)/;
/**
 * The hint cargo appends only when every incompatible package is a
 * dependency, never a workspace member (`local_incompatible` in cargo's
 * `ops/cargo_compile/mod.rs`): the refusal is then fixable by selecting older
 * dependency versions in `Cargo.lock`, which a resolution can do.
 */ const DEPENDENCY_ONLY_HINT = "Either upgrade rustc or select compatible dependency versions";
/** Numeric, dot-separated version comparison (`"1.99"` > `"1.98.0"`). */ function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for(let i = 0; i < length; i++){
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
/**
 * Detect a cargo refusal caused by the host's `rustc` being older than a
 * workspace package's `rust-version` (Issue #3255).
 *
 * No resolution change can fix that — only raising the container's Rust pin
 * (`container/tools.json`) can — so the caller treats it as an environment
 * fault rather than an ordinary check failure, and skips the repair rounds
 * built for a bad resolution. A refusal carrying cargo's dependency-only hint
 * ({@link DEPENDENCY_ONLY_HINT}) is not a gap: a `Cargo.lock` change can fix
 * it, so it stays an ordinary failure that a repair round may answer.
 *
 * @param output - The raw `cargo check` output (untrimmed)
 * @returns The gap, or undefined when no "requires rustc" line is found or
 *   cargo says only dependencies are incompatible
 */ export function detectRustToolchainGap(output) {
  let installed;
  let required;
  const packages = [];
  const seen = new Set();
  for (const rawLine of output.split("\n")){
    const line = rawLine.trim().slice(0, MAX_GAP_LINE_CHARS);
    const header = RUSTC_HEADER_RE.exec(line);
    if (header) {
      installed = header[1];
      continue;
    }
    const requires = RUSTC_REQUIRES_RE.exec(line);
    if (requires) {
      const [, name, version, requiredVersion] = requires;
      const pkg = `${name}@${version}`;
      if (!seen.has(pkg)) {
        seen.add(pkg);
        packages.push(pkg);
      }
      if (!required || compareVersions(requiredVersion, required) > 0) {
        required = requiredVersion;
      }
    }
  }
  if (!required || output.includes(DEPENDENCY_ONLY_HINT)) return undefined;
  return {
    installed,
    required,
    packages
  };
}
/**
 * One-line failure detail for a {@link RustToolchainGap} (Issue #3255),
 * naming the installed and required rustc, the packages and the pin to raise.
 */ export function describeRustToolchainGap(where, code, gap) {
  return `${where} failed (exit ${code}): the host's rustc ` + `${gap.installed ?? "(unknown)"} is older than the rust-version ${gap.required} that ` + `${gap.packages.join(", ")} require(s) — raise the container's Rust pin ` + `(container/tools.json) to at least ${gap.required}; a workspace ` + "package requires it, so no change to the resolution can fix this";
}
/**
 * Import-failure line naming a remote module, e.g.
 * `error: Import 'https://esm.sh/x' failed`. Anchored on the literal prefix;
 * `[^'\s]+` is disjoint from the closing quote, so the match is linear.
 */ const REMOTE_IMPORT_FAILED_RE = /^error: Import '(https?:\/\/[^'\s]+)' failed/;
/**
 * npm package-cache failure line, e.g.
 * `error: Failed caching npm package 'playwright-core@1.60.0'` (Issue #4848).
 * Anchored on the literal prefix; `[^'\s]+` is disjoint from the closing quote,
 * so the match is linear.
 */ const REMOTE_NPM_CACHE_FAILED_RE = /^error: Failed caching npm package '([^'\s]+)'/;
/**
 * npm metadata-load failure line, e.g.
 * `error: Failed loading https://registry.npmjs.org/x for package "x"` (Issue
 * #4848). Anchored on the literal prefix; `[^\s]+` is disjoint from the space
 * that opens the literal ` for package "`, so the match is linear.
 */ const REMOTE_NPM_METADATA_FAILED_RE = /^error: Failed loading (https?:\/\/[^\s]+) for package "/;
/**
 * A connection-class cause: the host could not open a route to the module
 * host. Literal alternatives only, so the match is linear in the line length.
 */ const REMOTE_FETCH_CAUSE_RE = /error sending request for url|unsuccessful tunnel|dns error|client error \(Connect\)|connection (refused|reset|timed out)/i;
/**
 * An SGR colour remnant whose escape byte was already stripped upstream, e.g.
 * by an issue or log sanitiser, leaving a bare `[0m` or `[1m[31m` (Issue
 * #4853). Matched anywhere in the line. Each match starts at a `[`, and
 * `[0-9;]*` is disjoint from the closing `m`, so the scan is linear.
 */ const ORPHAN_SGR_RE = /\[[0-9;]*m/g;
/**
 * A line in which cargo refuses to get its dependencies from the registry
 * (Issue #4786). Each alternative is a fixed literal anchored at the start of
 * the line and followed by a word boundary, so the match is linear in the line
 * length: there is no quantifier for it to backtrack through.
 */ const CARGO_REGISTRY_REFUSAL_RE = /^error: failed to (?:get|download|fetch|update)\b|^(?:unable to update registry|failed to download|download of config\.json failed|failed to load source for dependency|failed to query replaced source)\b/;
/**
 * A connection-class cause: the host could not open a route to the crate
 * registry, or cargo was told not to try (`--offline`). Fixed literals only and
 * not anchored, so each alternative is a plain substring scan and the match is
 * linear in the line length.
 */ const CARGO_REGISTRY_CAUSE_RE = /could not resolve host(?:name)?|couldn't connect|failed to connect|connection (?:refused|reset|timed out)|network is unreachable|temporary failure in name resolution|operation timed out|attempting to make an HTTP request, but --offline was specified|offline mode/i;
/**
 * cargo's own retry warning, `warning: spurious network error (N tries
 * remaining): …`. It repeats the cause while cargo retries, so it is kept only
 * as a fallback cause.
 */ const CARGO_SPURIOUS_RETRY_RE = /spurious network error/i;
/**
 * Detect a cargo refusal caused by the host being unable to reach the crate
 * registry (Issue #4786).
 *
 * An unreachable registry is a host fault, like an unreachable module host
 * (Issue #4422), not a bad resolution. A gap needs both a registry-fetch refusal
 * line and a connection-class cause line. The cause reported is the last
 * connection-class line that is not a `spurious network error` warning, falling
 * back to the last such warning. A compile error, a `--locked` lockfile refusal,
 * a manifest parse error, or a rustc-version gap is not a registry gap.
 *
 * @param output - The raw cargo output (untrimmed)
 * @returns The gap, or undefined when no registry refusal and cause both appear
 */ export function detectCargoRegistryGap(output) {
  let refused = false;
  let cause;
  let retryCause;
  for (const rawLine of output.split("\n")){
    const line = rawLine.trim().slice(0, MAX_GAP_LINE_CHARS);
    if (CARGO_REGISTRY_REFUSAL_RE.test(line)) {
      refused = true;
      continue;
    }
    if (!CARGO_REGISTRY_CAUSE_RE.test(line)) continue;
    if (CARGO_SPURIOUS_RETRY_RE.test(line)) {
      retryCause = line;
    } else {
      cause = line;
    }
  }
  const picked = cause ?? retryCause;
  return refused && picked !== undefined ? {
    cause: picked
  } : undefined;
}
/** Classify an offline retry only after the initial registry gap is established. */ export function isCargoOfflineRegistryGap(output) {
  if (detectCargoRegistryGap(output)) return true;
  const lines = output.split("\n").map((line)=>line.trim().slice(0, MAX_GAP_LINE_CHARS));
  return lines.some((line)=>/^(?:error: )?(?:no matching package named|failed to select a version for the requirement)\b/.test(line)) && lines.some((line)=>/(?:you're using offline mode|offline mode \(via `--offline`\))/i.test(line));
}
/**
 * The same cargo argv with `--offline` straight after the subcommand (Issue
 * #4786), so the local cargo cache can satisfy a registry the host cannot
 * reach. An argv that already carries the flag is returned unchanged, so the
 * call is idempotent.
 *
 * @param args - The argv after the executable, its first element the subcommand
 * @returns A new argv with `--offline` in second place
 */ export function withCargoOffline(args) {
  if (args.length === 0 || args.includes("--offline")) return [
    ...args
  ];
  return [
    args[0],
    "--offline",
    ...args.slice(1)
  ];
}
/**
 * Detect a Deno task that could not fetch a remote module because the host
 * cannot reach the module host (Issue #4422), or an npm package or registry
 * (Issue #4848).
 *
 * An unreachable host is an environment fault, like the Rust toolchain gap of
 * Issue #3255, not a bad resolution: a repair round cannot fix it. A gap is
 * reported only when a failure header names the remote and a connection-class
 * cause line follows it. The headers are the legacy `error: Import '<url>'
 * failed`, the npm package-cache `error: Failed caching npm package '<spec>'`
 * (reported as `npm:<spec>`), and the npm metadata `error: Failed loading <url>
 * for package "<name>"`. Each line is read with ANSI colour stripped, so a
 * coloured `error` prefix matches as a plain one (Issue #4848). SGR remnants
 * whose escape byte was already lost, a bare `[0m`, are ignored wherever they
 * sit in the line (Issue #4853), so `error[0m: Failed ...` still matches. An
 * import or
 * package that failed for any other reason (a 404, a bad certificate, a
 * checksum mismatch, a missing module, a type error) is an ordinary failure and
 * returns undefined.
 *
 * @param output - The raw task output (untrimmed, possibly ANSI-coloured)
 * @returns The gap, or undefined when no connection-class cause follows a
 *   failure header
 */ export function detectRemoteModuleGap(output) {
  let failedUrl;
  for (const rawLine of output.split("\n")){
    const line = stripAnsi(rawLine.slice(0, MAX_GAP_LINE_CHARS)).replace(ORPHAN_SGR_RE, "").trim();
    const imported = REMOTE_IMPORT_FAILED_RE.exec(line);
    if (imported) {
      failedUrl = imported[1];
      continue;
    }
    const cached = REMOTE_NPM_CACHE_FAILED_RE.exec(line);
    if (cached) {
      failedUrl = `npm:${cached[1]}`;
      continue;
    }
    const loaded = REMOTE_NPM_METADATA_FAILED_RE.exec(line);
    if (loaded) {
      failedUrl = loaded[1];
      continue;
    }
    if (failedUrl !== undefined && REMOTE_FETCH_CAUSE_RE.test(line)) {
      return {
        url: failedUrl,
        cause: line
      };
    }
  }
  return undefined;
}
/** Whether Deno reports that a project's lockfile cannot be written. */ export function denoLockfileWriteRefused(dir, output) {
  return output.includes("Failed writing lockfile") && output.includes("Permission denied (os error 13)") && output.includes(`(for '${dir.replace(/\/$/, "")}/deno.lock')`);
}
/**
 * Whether a Deno check can attempt to run without a writable directory
 * (Issue #4782). A stale lockfile can still require a write.
 *
 * Deno writes `deno.lock` when it has to create or update one, and writes
 * `node_modules` for `nodeModulesDir: "auto"` or beside a `package.json`,
 * and writes `vendor` when vendoring is enabled.
 * A present lockfile and none of the other conditions allow an attempt.
 * A string-form check task, or an object-form check with a non-empty command,
 * must also be a simple `deno check` with known safe flags and no dependencies.
 * Dependencies may write files. Anything else, or a manifest that cannot be
 * read, keeps the write requirement.
 *
 * @param dir - The Deno project directory
 * @param args - Arguments selected for the project check
 * @returns True when the check can attempt a read-only checkout
 */ export async function denoCheckLeavesDirUntouched(dir, args = [
  "check"
]) {
  if (!await isFile(`${dir}/deno.lock`)) return false;
  if (await isFile(`${dir}/package.json`)) return false;
  const taskCheck = args.length === 2 && args[0] === "task" && args[1] === "check";
  if (!taskCheck && args[0] !== "check") return false;
  for (const name of [
    "deno.json",
    "deno.jsonc"
  ]){
    if (!await isFile(`${dir}/${name}`)) continue;
    try {
      const config = JSON.parse(stripJsonc(await Deno.readTextFile(`${dir}/${name}`)));
      if (taskCheck) {
        const task = config?.tasks?.check;
        const command = manifestTaskCommand(task) ?? "";
        if (/[\r\n]/.test(command)) return false;
        // Accept only a simple invocation with known non-writing flags. Shell
        // expansions, operators and unknown options retain the write probe.
        const words = command.trim().split(/\s+/);
        if (words[0] !== "deno" || words[1] !== "check") return false;
        // A dependency may write project files even when this task's command
        // is read-only, so keep the checkout write probe for the whole task.
        if (typeof task === "object" && "dependencies" in task) return false;
        if (!words.slice(2).every((word)=>{
          if (/^['"]-/.test(word)) return false;
          if (word.startsWith("-")) {
            return [
              "--frozen",
              "--lock=deno.lock",
              "--no-lock",
              "--all",
              "--quiet"
            ].includes(word);
          }
          return /^(?:[\w./*?@:-]+|'[\w./*?@:-]+'|"[\w./*?@:-]+")$/.test(word);
        })) return false;
      }
      if (config?.vendor) return false;
      const mode = config?.nodeModulesDir;
      if (mode !== undefined && mode !== "none" && mode !== "manual" && mode !== false) return false;
    } catch  {
      return false;
    }
    return true;
  }
  return !taskCheck;
}
/**
 * Spawn the repository's own check with a bounded timeout, the limit for its
 * toolchain (Issue #4787).
 */ export const spawnTypeCheck = async (project, /** The command runner. Production uses the real one; tests inject a fake. */ run = runRepositoryCommand)=>{
  const executable = project.kind === "cargo" ? "cargo" : Deno.execPath();
  const limitMs = typeCheckTimeoutMs(project.kind);
  const readOnlyCheckout = project.kind === "deno" && await denoCheckLeavesDirUntouched(project.dir, project.args);
  // The repository's own check runs with a stated environment and no parent
  // credential (Issue #4659). Build-cache placement for the checkout (Issue
  // #2247) is decided inside runRepositoryCommand, not here. A Deno check
  // writes its cache to DENO_DIR, so it does not need the project directory
  // writable by the account, unless it must write deno.lock, node_modules or vendor
  // there (Issue #4782). A cargo check writes Cargo.lock, so it keeps the
  // requirement.
  const result = await run(executable, project.args, {
    cwd: project.dir,
    timeoutMs: limitMs,
    manifests: await manifestsFor(project.kind, project.dir),
    readOnlyCheckout
  });
  if (!result.ok) {
    // A spawn that failed for any reason but the host's account is a check
    // that could not run (Issue #4847), not a verdict on the merged tree.
    return {
      code: 1,
      output: result.error.message,
      ...result.error instanceof GateAccountUnavailable ? {
        accountUnavailable: result.error.message
      } : {
        unrunnable: true
      }
    };
  }
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [
    stdout,
    stderr
  ].map((s)=>s.trim()).filter(Boolean).join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\nType check timed out after ${limitMs}ms`.trim(),
      timedOut: true
    };
  }
  // A present but stale lockfile may still need rewriting. Only this specific
  // permission refusal is a host limitation; other check failures remain failures.
  if (code !== 0 && readOnlyCheckout && denoLockfileWriteRefused(project.dir, output)) {
    return {
      code,
      output,
      accountUnavailable: output
    };
  }
  return {
    code,
    output
  };
};
/**
 * Run the repository's own type check against a merged working tree.
 *
 * @param repoDir - Root of the merged working tree (the clone's cwd)
 * @param runner - Override the spawned check (tests)
 * @returns The verdict, with the check output when one ran
 */ export async function checkMergedTree(repoDir, runner = spawnTypeCheck, /**
   * Whether the ephemeral cargo build must not run (Issue #4326).
   * Defaults to the host-disk budget. A merge still lands; CI builds it.
   */ skipCargoBuild = ()=>shouldSkipEphemeralCargoBuild(repoDir)) {
  // A tree that cannot be read is a check that could not be run, not a
  // repository without one — refuse rather than wave it through as "skipped".
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail: `merged tree '${repoDir}' is not a directory — nothing checked it`,
        output: "",
        cause: "tree-unreadable"
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing checked it`,
      output: tail(err instanceof Error ? err.message : String(err)),
      cause: "tree-unreadable"
    };
  }
  const projects = await findTypeCheckProjects(repoDir);
  if (projects.length === 0) {
    return {
      status: "skipped",
      detail: `no deno.json(c) or Cargo.toml under '${repoDir}' — the merged ` + "tree was not type-checked",
      output: ""
    };
  }
  const checked = [];
  const leftToCi = [];
  // Cargo checks that hit their time limit (Issue #4786).
  const cargoTimedOut = [];
  // Cargo checks that could not reach their crate registry, even offline
  // (Issue #4786).
  const cargoRegistryGaps = [];
  const skipCargo = await skipCargoBuild();
  let skippedCargo = false;
  for (const project of projects){
    if (project.kind === "cargo" && skipCargo) {
      // The host is above its floor and short of cargo headroom, and
      // pruning freed nothing. Running cargo here is what would take free
      // space through the floor, so the merge lands and CI builds it.
      skippedCargo = true;
      continue;
    }
    const where = `${describeProject(project)} in ${project.dir}`;
    let result;
    // The cause the first attempt named when it could not reach the registry
    // (Issue #4786); set only when the check was retried offline.
    let registryCause;
    try {
      result = await runner(project);
      // A cargo check that ran out of time has still compiled part of the
      // workspace into the target, so one more run resumes from that and can
      // finish and verify a tree whose only check is cargo (Issue #4786). A
      // second timeout is left to CI below.
      if (project.kind === "cargo" && result.code !== 0 && result.timedOut) {
        result = await runner(project);
      }
      // A cargo check that could not reach its crate registry is a host fault,
      // so it is retried once offline: the local cargo cache may hold every
      // locked crate (Issue #4786). A Deno project is never retried this way.
      const firstGap = project.kind === "cargo" && result.code !== 0 && !result.timedOut && !result.accountUnavailable ? detectCargoRegistryGap(result.output) : undefined;
      if (firstGap) {
        registryCause = firstGap.cause;
        result = await runner({
          ...project,
          args: withCargoOffline(project.args)
        });
      }
    } catch (err) {
      // Unrunnable is not clean: refuse the push rather than assume it
      // compiles.
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(message),
        cause: "check-could-not-run"
      };
    }
    if (result.accountUnavailable) {
      leftToCi.push(`${where}: ${result.accountUnavailable}`);
      continue;
    }
    // A check the runner could not start is not a verdict on the tree, so it
    // is not reported as a failing check (Issue #4847).
    if (result.unrunnable) {
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(result.output),
        cause: "check-could-not-run"
      };
    }
    // The offline retry could not reach the registry either: the cargo half
    // cannot be verified here, so it is left to CI as a timed-out check is
    // (Issue #4786). The note keeps the first attempt's cause.
    if (registryCause !== undefined && result.code !== 0 && isCargoOfflineRegistryGap(result.output)) {
      skippedCargo = true;
      cargoRegistryGaps.push(`${where} could not reach its crate registry (${registryCause})`);
      continue;
    }
    if (result.code !== 0) {
      // A cargo check that hit its time limit says nothing about the merged
      // tree: on a cold ephemeral target it is the build that ran out of
      // time, not a bad resolution. It is left to CI, as a skipped cargo
      // build is (Issue #4786). A Deno timeout still fails the gate, with
      // cause `check-timed-out`, so the sync does not charge it as a bad tree
      // (Issue #4847).
      if (project.kind === "cargo" && result.timedOut) {
        skippedCargo = true;
        cargoTimedOut.push(where);
        continue;
      }
      // A Deno check that could not reach its module host says nothing about
      // the merged tree: it is left to CI, as the resolution gate leaves it
      // (Issue #4422). Refusing here charged a conflict attempt for a network
      // fault and walked every milestone to the merge-fallback rung.
      const remote = project.kind === "cargo" ? undefined : detectRemoteModuleGap(result.output);
      if (remote) {
        leftToCi.push(`${where} could not fetch its remote modules (${remote.cause})`);
        continue;
      }
      const gap = project.kind === "cargo" ? detectRustToolchainGap(result.output) : undefined;
      if (gap) {
        return {
          status: "failed",
          detail: describeRustToolchainGap(where, result.code, gap),
          output: tail(result.output),
          toolchainGap: gap,
          cause: "rust-toolchain-too-old"
        };
      }
      // A Deno check that hit its time limit did not reach a verdict on the
      // tree, so it is not charged as a failing check (Issue #4847).
      return {
        status: "failed",
        detail: `${where} failed (exit ${result.code})`,
        output: tail(result.output),
        cause: result.timedOut ? "check-timed-out" : "tree-check-failed"
      };
    }
    // A check that passed only on the offline retry says so (Issue #4786).
    checked.push(registryCause !== undefined ? `${where} (verified offline from the local cargo cache, Issue #4786)` : where);
  }
  const notes = [
    ...cargoTimedOut.map((where)=>`${where} timed out after ${CARGO_MERGE_GATE_TIMEOUT_MS}ms — left to CI (Issue #4786)`),
    ...cargoRegistryGaps.map((note)=>`${note} — left to CI (Issue #4786)`),
    ...skippedCargo ? [
      `${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #4326)`
    ] : [],
    ...leftToCi.map((note)=>`${note} — left to CI (Issue #4422)`)
  ];
  const checkLeftToCi = leftToCi.length > 0 ? leftToCi.join("; ") : undefined;
  if (checked.length === 0 && notes.length > 0) {
    return {
      status: "skipped",
      detail: notes.join("; "),
      output: "",
      ...skippedCargo ? {
        cargoSkipped: true
      } : {},
      ...checkLeftToCi ? {
        checkLeftToCi
      } : {}
    };
  }
  return {
    status: "passed",
    detail: [
      `${checked.join("; ")} passed`,
      ...notes
    ].join("; "),
    output: "",
    ...skippedCargo ? {
      cargoSkipped: true
    } : {},
    ...checkLeftToCi ? {
      checkLeftToCi
    } : {}
  };
}
/**
 * The refusal raised when a merged tree does not compile (Issue #974).
 *
 * Typed with {@link MILESTONE_MERGE_GATE_ERROR} so the sync can tell it apart
 * from an ordinary merge failure and escalate on the first occurrence — a
 * tree that does not compile is not a transient condition that a retry fixes.
 */ export function mergeGateFailureError(milestoneBranch, defaultBranch, outcome) {
  const err = new Error(`Refused to push the merge of '${defaultBranch}' into ` + `'${milestoneBranch}': the merged tree does not pass the repository's ` + `own check (Issue #974) — ${outcome.detail}${outcome.output ? `\n${outcome.output}` : ""}`);
  err.name = MILESTONE_MERGE_GATE_ERROR;
  if (outcome.cause !== undefined) err.gateCause = outcome.cause;
  return err;
}
/**
 * The cause a merge-gate refusal carries (Issue #4847), or undefined when the
 * error is not a refusal or carries no known cause. A forged or unknown value
 * is rejected, so nothing it holds reaches a ledger reason.
 */ export function mergeGateFailureCause(err) {
  if (!isMergeGateFailure(err)) return undefined;
  const cause = err.gateCause;
  return isMergeGateCause(cause) ? cause : undefined;
}
/** Whether an error is the merge-gate refusal. */ export function isMergeGateFailure(err) {
  return err instanceof Error && err.name === MILESTONE_MERGE_GATE_ERROR;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfbWVyZ2VfZ2F0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFR5cGUtY2hlY2sgZ2F0ZSBmb3IgdGhlIGBtYWluYCDihpIgYG1pbGVzdG9uZS88bmFtZT5gIHN5bmMgbWVyZ2UgKElzc3VlICM5NzQpLlxuICpcbiAqIFRoZSBzeW5jIHB1c2hlZCB3aGF0ZXZlciB0aGUgbWVyZ2UgcHJvZHVjZWQuIEdpdCByZXBvcnRlZCBubyBjb25mbGljdFxuICogYmVjYXVzZSBib3RoIHNpZGVzIHdlcmUgaW50ZXJuYWxseSBjb25zaXN0ZW50IOKAlCBvbmx5IHRoZWlyIGNvbWJpbmF0aW9uIHdhc1xuICogbm90IOKAlCBzbyBhIHJlc29sdXRpb24gdGhhdCBkcm9wcGVkIGxpdmUgd2lyaW5nIHJlYWNoZWQgdGhlIG1pbGVzdG9uZSBicmFuY2hcbiAqIHRocmVlIHRpbWVzIHJ1bm5pbmcsIGFuZCBgbWlsZXN0b25lLypgIGhhcyBubyByZXF1aXJlZCBjaGVja3MgdG8gY2F0Y2ggaXRcbiAqIGRvd25zdHJlYW0gKCM5MjgsICM3OTYpLlxuICpcbiAqIFRoaXMgbW9kdWxlIGFuc3dlcnMgb25lIHF1ZXN0aW9uIGFib3V0IHRoZSBtZXJnZWQgdHJlZSwgYmVmb3JlIHRoZSBwdXNoOlxuICogZG9lcyBpdCBzdGlsbCBjb21waWxlPyBUaGUgcmVwb3NpdG9yeSdzIG93biBjaGVjayBpcyB1c2VkIOKAlCBpdHNcbiAqIGBkZW5vIHRhc2sgY2hlY2tgIHdoZXJlIG9uZSBpcyBkZWZpbmVkLCBvdGhlcndpc2UgYGRlbm8gY2hlY2sgJyoqXFwvKi50cydgIOKAlFxuICogc28gdGhlIGdhdGUgaXMgdGhlIHJlcG8ncyBnYXRlIHJhdGhlciB0aGFuIGEgc2Vjb25kIG9waW5pb24gaW52ZW50ZWQgaGVyZS5cbiAqXG4gKiBBIGNoZWNrIHRoYXQgY2Fubm90IGJlIHJ1biByZXBvcnRzIGBmYWlsZWRgLCBub3QgYHBhc3NlZGA6IGFic2VuY2Ugb2YgYVxuICogZmFpbHVyZSBpcyBub3Qgc3VjY2VzcywgYW5kIGEgdHJlZSBub2JvZHkgdmVyaWZpZWQgaXMgZXhhY3RseSB0aGUgdHJlZSB0aGlzXG4gKiBnYXRlIGV4aXN0cyB0byBrZWVwIG9mZiB0aGUgYnJhbmNoLlxuICpcbiAqIEEgYGNhcmdvIGNoZWNrYCBjYW4gYWxzbyBmYWlsIGJlY2F1c2UgYSB3b3Jrc3BhY2UgcGFja2FnZSdzIGBydXN0LXZlcnNpb25gXG4gKiBpcyBuZXdlciB0aGFuIHRoZSBjb250YWluZXIncyBwaW5uZWQgYHJ1c3RjYCAoSXNzdWUgIzMyNTUpIOKAlCBhIHJlZnVzYWwgbm9cbiAqIHJlc29sdXRpb24gY2hhbmdlIGNhbiBhbnN3ZXIuIFRoYXQgaXMgcmVwb3J0ZWQgYXMgYSB7QGxpbmsgUnVzdFRvb2xjaGFpbkdhcH1cbiAqIHJhdGhlciB0aGFuIGFuIG9yZGluYXJ5IGZhaWx1cmUsIHNvIHRoZSByZXBhaXIgcm91bmRzIGluXG4gKiBgbWlsZXN0b25lX2dhdGVfcmVwYWlyLnRzYCBhcmUgbm90IHNwZW50IHJldHJ5aW5nIGEgaG9zdCB0b29sY2hhaW4gbGltaXQgYXNcbiAqIHRob3VnaCBpdCB3ZXJlIGEgYmFkIHJlc29sdXRpb24uIFdoZW4gb25seSBkZXBlbmRlbmNpZXMgYXJlIHRvbyBuZXcsIGNhcmdvXG4gKiBpdHNlbGYgbmFtZXMgYSBgQ2FyZ28ubG9ja2AgcmVtZWR5IChgY2FyZ28gdXBkYXRlIC0tcHJlY2lzZWApLCBzbyB0aGF0IGZvcm1cbiAqIHN0YXlzIGFuIG9yZGluYXJ5LCByZXBhaXJhYmxlIGZhaWx1cmUuXG4gKlxuICogQSBgY2FyZ28gY2hlY2tgIGNhbiBhbHNvIGZhaWwgYmVjYXVzZSB0aGUgaG9zdCBjYW5ub3QgcmVhY2ggdGhlIGNyYXRlXG4gKiByZWdpc3RyeSAoSXNzdWUgIzQ3ODYpLiBUaGF0IGlzIGEgaG9zdCBmYXVsdCwgbm90IGEgYmFkIHJlc29sdXRpb24sIHNvIHRoZVxuICogY2hlY2sgaXMgcmV0cmllZCBvbmNlIG9mZmxpbmUsIGZyb20gdGhlIGxvY2FsIGNhcmdvIGNhY2hlLCBhbmQgaWYgdGhlIHJldHJ5XG4gKiBzdGlsbCBjYW5ub3QgcmVhY2ggdGhlIHJlZ2lzdHJ5IHRoZSBwcm9qZWN0IGlzIGxlZnQgdG8gQ0kgYXMgYSB0aW1lZC1vdXRcbiAqIGNoZWNrIGlzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIEdhdGVBY2NvdW50VW5hdmFpbGFibGUsXG4gIG1hbmlmZXN0c0ZvcixcbiAgcnVuUmVwb3NpdG9yeUNvbW1hbmQsXG59IGZyb20gXCIuL3VudHJ1c3RlZF9nYXRlX3NwYXduLnRzXCI7XG5pbXBvcnQgeyBzdHJpcEpzb25jIH0gZnJvbSBcIi4vanNvbmMudHNcIjtcbmltcG9ydCB7IHN0cmlwQW5zaSB9IGZyb20gXCIuL2dpdGh1Yl9hY3Rpb25zX2xvZ19mZXRjaGVyLnRzXCI7XG5pbXBvcnQge1xuICBDQVJHT19CVUlMRF9TS0lQUEVEX0ZPUl9NRVJHRSxcbiAgc2hvdWxkU2tpcEVwaGVtZXJhbENhcmdvQnVpbGQsXG59IGZyb20gXCIuL2hlYXZ5X2J1aWxkX2dhdGUudHNcIjtcbmltcG9ydCB7XG4gIGZpbmRQcm9qZWN0TWFuaWZlc3RzLFxuICBpc0ZpbGUsXG4gIHR5cGUgUHJvamVjdEtpbmQsXG59IGZyb20gXCIuL3Byb2plY3RfbWFuaWZlc3RzLnRzXCI7XG5leHBvcnQge1xuICBmaW5kUHJvamVjdE1hbmlmZXN0cyxcbiAgTUVSR0VfR0FURV9NQVhfREVQVEgsXG4gIHR5cGUgUHJvamVjdEtpbmQsXG4gIHR5cGUgUHJvamVjdE1hbmlmZXN0LFxufSBmcm9tIFwiLi9wcm9qZWN0X21hbmlmZXN0cy50c1wiO1xuXG4vKipcbiAqIEhvdyBsb25nIGEgRGVubyBwcm9qZWN0J3MgbWVyZ2VkLXRyZWUgdHlwZSBjaGVjayBtYXkgcnVuIGJlZm9yZSBpdCBpc1xuICoga2lsbGVkLiBBIENhcmdvIHByb2plY3QgaGFzIGl0cyBvd24gbGltaXQsIHtAbGluayBDQVJHT19NRVJHRV9HQVRFX1RJTUVPVVRfTVN9LlxuICovXG5leHBvcnQgY29uc3QgTUVSR0VfR0FURV9USU1FT1VUX01TID0gMzAwXzAwMDtcblxuLyoqXG4gKiBIb3cgbG9uZyBhIENhcmdvIHByb2plY3QncyBtZXJnZWQtdHJlZSB0eXBlIGNoZWNrIG1heSBydW4gYmVmb3JlIGl0IGlzXG4gKiBraWxsZWQgKElzc3VlICM0Nzg3KS4gQSBjb2xkIGBjYXJnbyBjaGVjayAtLXdvcmtzcGFjZSAtLWFsbC10YXJnZXRzYCBvZiBhXG4gKiBsYXJnZSB3b3Jrc3BhY2Ugb3V0cnVucyB0aGUgRGVubyBsaW1pdCwgc28gYSBDYXJnbyB0cmVlIHdhcyBraWxsZWQgYXQgdGhhdFxuICogbGltaXQgYW5kIHJlZnVzZWQgb24gZXZlcnkgY3ljbGUuXG4gKi9cbmV4cG9ydCBjb25zdCBDQVJHT19NRVJHRV9HQVRFX1RJTUVPVVRfTVMgPSA5MDBfMDAwO1xuXG4vKipcbiAqIFRoZSB0aW1lIGxpbWl0IGZvciBhIHByb2plY3QncyB0eXBlIGNoZWNrLCBjaG9zZW4gYnkgaXRzIHRvb2xjaGFpbjogdGhlXG4gKiBDYXJnbyBsaW1pdCBmb3IgYGNhcmdvYCwgYW5kIHtAbGluayBNRVJHRV9HQVRFX1RJTUVPVVRfTVN9IG90aGVyd2lzZS5cbiAqXG4gKiBAcGFyYW0ga2luZCAtIFRoZSB0b29sY2hhaW4gdGhhdCBjaGVja3MgdGhlIHByb2plY3RcbiAqIEByZXR1cm5zIFRoZSBsaW1pdCwgaW4gbWlsbGlzZWNvbmRzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0eXBlQ2hlY2tUaW1lb3V0TXMoa2luZDogUHJvamVjdEtpbmQpOiBudW1iZXIge1xuICByZXR1cm4ga2luZCA9PT0gXCJjYXJnb1wiID8gQ0FSR09fTUVSR0VfR0FURV9USU1FT1VUX01TIDogTUVSR0VfR0FURV9USU1FT1VUX01TO1xufVxuXG4vKiogRXJyb3IgbmFtZSBjYXJyaWVkIGJ5IHRoZSByZWZ1c2FsLCBzbyBjYWxsZXJzIGNhbiBlc2NhbGF0ZSBvbiBpdC4gKi9cbmV4cG9ydCBjb25zdCBNSUxFU1RPTkVfTUVSR0VfR0FURV9FUlJPUiA9IFwiTWlsZXN0b25lTWVyZ2VHYXRlRmFpbHVyZVwiO1xuXG4vKiogTG9uZ2VzdCBjaGVjayBvdXRwdXQgY2FycmllZCBpbnRvIGEgbG9nIGxpbmUgb3IgYW4gZXNjYWxhdGlvbiBjb21tZW50LiAqL1xuY29uc3QgTUFYX09VVFBVVF9MSU5FUyA9IDQwO1xuY29uc3QgTUFYX09VVFBVVF9DSEFSUyA9IDQwMDA7XG5cbi8qKiBUaGUgdHlwZSBjaGVjayBhIHJlcG9zaXRvcnkgZGVmaW5lcyBmb3IgaXRzZWxmLiAqL1xuZXhwb3J0IGludGVyZmFjZSBUeXBlQ2hlY2tQcm9qZWN0IHtcbiAgLyoqIERpcmVjdG9yeSB0aGUgY2hlY2sgcnVucyBpbi4gKi9cbiAgZGlyOiBzdHJpbmc7XG4gIC8qKiBBcmd1bWVudHMgcGFzc2VkIHRvIHRoZSBleGVjdXRhYmxlIHtAbGluayBraW5kfSBuYW1lcy4gKi9cbiAgYXJnczogc3RyaW5nW107XG4gIC8qKlxuICAgKiBXaGljaCB0b29sY2hhaW4gY2hlY2tzIHRoaXMgcHJvamVjdCAoSXNzdWUgIzIxMzgpOiBhIGBkZW5vLmpzb24oYylgIGlzXG4gICAqIGNoZWNrZWQgd2l0aCBgZGVub2AsIGEgYENhcmdvLnRvbWxgIHdpdGggYGNhcmdvYC4gQSB0cmVlIHdpdGggbmVpdGhlciBpc1xuICAgKiBzdGlsbCByZWZ1c2VkIGFzIHVudmVyaWZpYWJsZSwgZXhhY3RseSBhcyBJc3N1ZSAjMTU1OSBzZXQgaXQuXG4gICAqL1xuICBraW5kOiBQcm9qZWN0S2luZDtcbn1cblxuLyoqIEhvdyBhIHByb2plY3QncyBjaGVjayBpcyBzcGVsbGVkIGluIGEgbG9nIGxpbmUgb3IgYW4gZXNjYWxhdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZVByb2plY3QocHJvamVjdDogVHlwZUNoZWNrUHJvamVjdCk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcm9qZWN0LmtpbmR9ICR7cHJvamVjdC5hcmdzLmpvaW4oXCIgXCIpfWA7XG59XG5cbi8qKiBXaGF0IHRoZSBnYXRlIGNvbmNsdWRlZCBhYm91dCB0aGUgbWVyZ2VkIHRyZWUuICovXG5leHBvcnQgdHlwZSBNZXJnZUdhdGVTdGF0dXMgPVxuICAvKiogVGhlIHRyZWUgY29tcGlsZXMg4oCUIHRoZSBwdXNoIG1heSBwcm9jZWVkLiAqL1xuICB8IFwicGFzc2VkXCJcbiAgLyoqIFRoZSB0cmVlIGRvZXMgbm90IGNvbXBpbGUsIG9yIGNvdWxkIG5vdCBiZSBjaGVja2VkIOKAlCBkbyBub3QgcHVzaC4gKi9cbiAgfCBcImZhaWxlZFwiXG4gIC8qKiBUaGUgcmVwb3NpdG9yeSBkZWZpbmVzIG5vIHR5cGUgY2hlY2ssIHNvIG5vbmUgd2FzIHJ1bi4gKi9cbiAgfCBcInNraXBwZWRcIjtcblxuLyoqXG4gKiBXaHkgdGhlIGdhdGUgZmFpbGVkIGEgbWVyZ2VkIHRyZWUgKElzc3VlICM0ODQ3KS4gQSByZWZ1c2FsIG9uIHRoZSB0cmVlJ3NcbiAqIG1lcml0cyBpcyBgdHJlZS1jaGVjay1mYWlsZWRgOyBldmVyeSBvdGhlciBjYXVzZSBtZWFucyB0aGUgdHJlZSB3YXMgbm90XG4gKiB2ZXJpZmllZCwgc28gdGhlIHN5bmMgbXVzdCBub3QgY2hhcmdlIGl0IGFzIGEgYmFkIHRyZWUuXG4gKi9cbmV4cG9ydCB0eXBlIE1lcmdlR2F0ZUNhdXNlID1cbiAgLyoqIFRoZSByZXBvc2l0b3J5J3Mgb3duIGNoZWNrIHJhbiBhbmQgcmVqZWN0ZWQgdGhlIG1lcmdlZCB0cmVlLiAqL1xuICB8IFwidHJlZS1jaGVjay1mYWlsZWRcIlxuICAvKiogVGhlIGNoZWNrIGhpdCBpdHMgdGltZSBsaW1pdCAoYSBEZW5vIGNoZWNrOyBjYXJnbyBpcyBsZWZ0IHRvIENJKS4gKi9cbiAgfCBcImNoZWNrLXRpbWVkLW91dFwiXG4gIC8qKiBUaGUgY2hlY2sgY291bGQgbm90IGJlIHN0YXJ0ZWQsIG9yIGl0cyBjb21tYW5kIGNvdWxkIG5vdCBydW4uICovXG4gIHwgXCJjaGVjay1jb3VsZC1ub3QtcnVuXCJcbiAgLyoqIFRoZSBtZXJnZWQgdHJlZSdzIGRpcmVjdG9yeSBpcyBtaXNzaW5nIG9yIGNvdWxkIG5vdCBiZSByZWFkLiAqL1xuICB8IFwidHJlZS11bnJlYWRhYmxlXCJcbiAgLyoqIFRoZSBob3N0J3MgYHJ1c3RjYCBpcyBvbGRlciB0aGFuIGEgd29ya3NwYWNlIHBhY2thZ2UgcmVxdWlyZXMgKElzc3VlICMzMjU1KS4gKi9cbiAgfCBcInJ1c3QtdG9vbGNoYWluLXRvby1vbGRcIjtcblxuLyoqXG4gKiBUaGUgY2F1c2VzIHRoYXQgbWVhbiB0aGUgdHJlZSB3YXMgbm90IHZlcmlmaWVkIGF0IGFsbCAoSXNzdWUgIzQ4NDcpOiB0aGVcbiAqIGNoZWNrIGNvdWxkIG5vdCBnaXZlIGEgdmVyZGljdCwgc28gbm90aGluZyBzaG93cyB0aGUgdHJlZSBpcyBiYWQuIEV2ZXJ5IGNhdXNlXG4gKiBleGNlcHQgYHRyZWUtY2hlY2stZmFpbGVkYC5cbiAqL1xuZXhwb3J0IGNvbnN0IE1FUkdFX0dBVEVfVU5WRVJJRklFRF9DQVVTRVM6IFJlYWRvbmx5U2V0PE1lcmdlR2F0ZUNhdXNlPiA9XG4gIG5ldyBTZXQ8TWVyZ2VHYXRlQ2F1c2U+KFtcbiAgICBcImNoZWNrLXRpbWVkLW91dFwiLFxuICAgIFwiY2hlY2stY291bGQtbm90LXJ1blwiLFxuICAgIFwidHJlZS11bnJlYWRhYmxlXCIsXG4gICAgXCJydXN0LXRvb2xjaGFpbi10b28tb2xkXCIsXG4gIF0pO1xuXG4vKipcbiAqIEZpeGVkIHNob3J0IHBocmFzZSBmb3IgZWFjaCBjYXVzZSAoSXNzdWUgIzQ4NDcpLiBJdCBuYW1lcyBubyBwYXRoIGFuZCBub1xuICogdG9vbCBvdXRwdXQsIHNvIGl0IGlzIHNhZmUgdG8gY2FycnkgaW50byBhIGxlZGdlciByZWFzb24gYW5kIGFuIGlzc3VlIGJvZHkuXG4gKi9cbmNvbnN0IE1FUkdFX0dBVEVfQ0FVU0VfUEhSQVNFUzogUmVhZG9ubHk8UmVjb3JkPE1lcmdlR2F0ZUNhdXNlLCBzdHJpbmc+PiA9IHtcbiAgXCJ0cmVlLWNoZWNrLWZhaWxlZFwiOiBcInRoZSByZXBvc2l0b3J5J3MgY2hlY2sgZmFpbGVkXCIsXG4gIFwiY2hlY2stdGltZWQtb3V0XCI6IFwidGhlIGNoZWNrIHRpbWVkIG91dFwiLFxuICBcImNoZWNrLWNvdWxkLW5vdC1ydW5cIjogXCJ0aGUgY2hlY2sgY291bGQgbm90IGJlIHJ1blwiLFxuICBcInRyZWUtdW5yZWFkYWJsZVwiOiBcInRoZSB0cmVlIGNvdWxkIG5vdCBiZSByZWFkXCIsXG4gIFwicnVzdC10b29sY2hhaW4tdG9vLW9sZFwiOiBcIlJ1c3QgdG9vbGNoYWluIHRvbyBvbGRcIixcbn07XG5cbi8qKiBXaGV0aGVyIGEgdmFsdWUgaXMgb25lIG9mIHRoZSBrbm93biBtZXJnZS1nYXRlIGNhdXNlcyAoSXNzdWUgIzQ4NDcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzTWVyZ2VHYXRlQ2F1c2UodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBNZXJnZUdhdGVDYXVzZSB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiZcbiAgICBPYmplY3QuaGFzT3duKE1FUkdFX0dBVEVfQ0FVU0VfUEhSQVNFUywgdmFsdWUpO1xufVxuXG4vKiogVGhlIGZpeGVkIHNob3J0IHBocmFzZSB0aGF0IGRlc2NyaWJlcyBhIGNhdXNlIChJc3N1ZSAjNDg0NykuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVNZXJnZUdhdGVDYXVzZShjYXVzZTogTWVyZ2VHYXRlQ2F1c2UpOiBzdHJpbmcge1xuICByZXR1cm4gTUVSR0VfR0FURV9DQVVTRV9QSFJBU0VTW2NhdXNlXTtcbn1cblxuLyoqIE91dGNvbWUgb2Yge0BsaW5rIGNoZWNrTWVyZ2VkVHJlZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIE1lcmdlR2F0ZU91dGNvbWUge1xuICBzdGF0dXM6IE1lcmdlR2F0ZVN0YXR1cztcbiAgLyoqIE9uZS1saW5lIHN1bW1hcnkgZm9yIHRoZSBsb2cgYW5kIHRoZSBlc2NhbGF0aW9uIGNvbW1lbnQuICovXG4gIGRldGFpbDogc3RyaW5nO1xuICAvKiogVHJpbW1lZCB0YWlsIG9mIHRoZSBjaGVjayBvdXRwdXQ7IGVtcHR5IHdoZW4gbm90aGluZyByYW4uICovXG4gIG91dHB1dDogc3RyaW5nO1xuICAvKipcbiAgICogU2V0IG9uIGV2ZXJ5IGBmYWlsZWRgIG91dGNvbWUge0BsaW5rIGNoZWNrTWVyZ2VkVHJlZX0gcmV0dXJucyAoSXNzdWUgIzQ4NDcpLFxuICAgKiBuYW1pbmcgd2h5IHRoZSB0cmVlIHdhcyByZWZ1c2VkIG9yIGNvdWxkIG5vdCBiZSB2ZXJpZmllZC5cbiAgICovXG4gIGNhdXNlPzogTWVyZ2VHYXRlQ2F1c2U7XG4gIC8qKlxuICAgKiBTZXQgb25seSB3aGVuIGEgYGNhcmdvIGNoZWNrYCBmYWlsZWQgYmVjYXVzZSB0aGUgaG9zdCdzIGBydXN0Y2AgaXMgb2xkZXJcbiAgICogdGhhbiB0aGUgYHJ1c3QtdmVyc2lvbmAgYSB3b3Jrc3BhY2UgcGFja2FnZSBvZiB0aGUgbWVyZ2VkIHRyZWUgcmVxdWlyZXNcbiAgICogKElzc3VlICMzMjU1KSDigJQgYW4gZW52aXJvbm1lbnQgZmF1bHQgbm8gcmVzb2x1dGlvbiBjaGFuZ2UgY2FuIGZpeCwgc28gdGhlXG4gICAqIGNhbGxlciBtdXN0IG5vdCBzcGVuZCBhIHJlcGFpciByb3VuZCBvbiBpdC5cbiAgICovXG4gIHRvb2xjaGFpbkdhcD86IFJ1c3RUb29sY2hhaW5HYXA7XG4gIC8qKlxuICAgKiBTZXQgb25seSBieSBhIG1lcmdlLW9ubHkgZ2F0ZSAoSXNzdWUgIzQzMjYpIG9uIGEgYHNraXBwZWRgIHZlcmRpY3Q6IHRoZVxuICAgKiBob3N0IGNhbm5vdCBhZmZvcmQgdGhlIGJ1aWxkLCBzbyBhIGNvbmZsaWN0IHRoZSBkZXRlcm1pbmlzdGljIHJ1bGVzXG4gICAqIHNldHRsZWQgaXMgcHVzaGVkIHVudmVyaWZpZWQgd2l0aCB0aGUgYFVOR0FURUQ6YCBub3RlIHJhdGhlciB0aGFuIHJlZnVzZWRcbiAgICogYXMgYSByZXNvbHV0aW9uIG5vdGhpbmcgdmVyaWZpZWQgKElzc3VlICMxNTU5KS5cbiAgICovXG4gIGxhbmRVbnZlcmlmaWVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFNldCB3aGVuIGEgY2FyZ28gcHJvamVjdCB3YXMgbGVmdCB0byBDSSAoSXNzdWUgIzQzMjYpIOKAlCBza2lwcGVkIGZvciB0aGVcbiAgICogaG9zdCdzIGJ1ZGdldCwgb3IgYmVjYXVzZSBpdHMgYGNhcmdvIGNoZWNrYCB0aW1lZCBvdXQgb3IgY291bGQgbm90IHJlYWNoXG4gICAqIHRoZSBjcmF0ZSByZWdpc3RyeSAoSXNzdWUgIzQ3ODYpLiBBIGBwYXNzZWRgIG91dGNvbWUgd2l0aCB0aGlzIHNldCBoYXNcbiAgICogdmVyaWZpZWQgb25seSB0aGUgRGVubyBoYWxmOyB0aGUgcmVwb3J0IG11c3Qgbm90IGNsYWltIHRoZSBjYXJnbyBoYWxmXG4gICAqIHBhc3NlZC4gQSBgc2tpcHBlZGAgb3V0Y29tZSB3aXRoIHRoaXMgc2V0IHZlcmlmaWVkIG5vdGhpbmcuXG4gICAqL1xuICBjYXJnb1NraXBwZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogU2V0IG9uIGEgYHBhc3NlZGAgb3V0Y29tZSB3aGVuIGEgRGVubyB0YXNrIGNvdWxkIG5vdCBmZXRjaCBpdHMgcmVtb3RlXG4gICAqIG1vZHVsZXMgYmVjYXVzZSB0aGUgaG9zdCBpcyBvZmZsaW5lIG9yIGJsb2NrZWQgKElzc3VlICM0NDIyKS4gSXQgbmFtZXMgdGhlXG4gICAqIHRhc2sgYW5kIHRoZSBjYXVzZS4gVGhhdCB0YXNrIGRpZCBub3QgcnVuLCBzbyB0aGUgcmVwb3J0IG11c3Qgbm90IGNsYWltIGl0XG4gICAqIHBhc3NlZDsgdGhlIG1pbGVzdG9uZSBQUidzIENJIHJ1bnMgaXQuXG4gICAqL1xuICBzdWl0ZUxlZnRUb0NpPzogc3RyaW5nO1xuICAvKipcbiAgICogU2V0IHdoZW4gdGhlIHJlcG9zaXRvcnkncyBvd24gdHlwZSBjaGVjayBmb3IgYSBEZW5vIHByb2plY3QgY291bGQgbm90XG4gICAqIGZldGNoIGl0cyByZW1vdGUgbW9kdWxlcyAoSXNzdWUgIzQ0MjIpLiBJdCBuYW1lcyB0aGUgdGFzayBhbmQgdGhlIGNhdXNlLlxuICAgKiBUaGF0IGNoZWNrIGRpZCBub3QgcnVuLCBzbyB0aGUgcmVwb3J0IG11c3Qgbm90IGNsYWltIGl0IHBhc3NlZDsgdGhlXG4gICAqIG1pbGVzdG9uZSBQUidzIENJIHJ1bnMgaXQgKElzc3VlICM0NDQxKS5cbiAgICovXG4gIGNoZWNrTGVmdFRvQ2k/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSBEZW5vIHRhc2sgdGhhdCBjb3VsZCBub3QgZmV0Y2ggYSByZW1vdGUgbW9kdWxlIGJlY2F1c2UgdGhlIGhvc3QgY2Fubm90XG4gKiByZWFjaCB0aGUgbW9kdWxlIGhvc3QgKElzc3VlICM0NDIyKSwgb3IgYW4gbnBtIHBhY2thZ2Ugb3IgcmVnaXN0cnkgaXQgY291bGRcbiAqIG5vdCByZWFjaCAoSXNzdWUgIzQ4NDgpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZU1vZHVsZUdhcCB7XG4gIC8qKlxuICAgKiBUaGUgYGh0dHAocylgIFVSTCB0aGUgZmFpbGVkIGltcG9ydCBuYW1lZDsgYG5wbTo8c3BlYz5gIGZvciBhIGZhaWxlZCBucG1cbiAgICogcGFja2FnZSBjYWNoZSAoZS5nLiBgbnBtOnBsYXl3cmlnaHQtY29yZUAxLjYwLjBgKTsgb3IgdGhlIHJlZ2lzdHJ5IFVSTCBvZiBhXG4gICAqIGZhaWxlZCBucG0gbWV0YWRhdGEgbG9hZCAoSXNzdWUgIzQ4NDgpLlxuICAgKi9cbiAgdXJsOiBzdHJpbmc7XG4gIC8qKiBUaGUgdHJpbW1lZCBvdXRwdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBjb25uZWN0aW9uLWNsYXNzIGNhdXNlLiAqL1xuICBjYXVzZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIEEgYGNhcmdvYCByZWZ1c2FsIHRoYXQgbmFtZXMgYSBgcnVzdC12ZXJzaW9uYCBuZXdlciB0aGFuIHRoZSBob3N0J3MgYHJ1c3RjYC5cbiAqXG4gKiBDYXJnbyBwcmludHMgb25lIFwicmVxdWlyZXMgcnVzdGMgWFwiIGxpbmUgcGVyIGFmZmVjdGVkIHRhcmdldCwgc28gdGhlIHNhbWVcbiAqIHBhY2thZ2UgY2FuIGFwcGVhciBkb3plbnMgb2YgdGltZXMgZm9yIG9uZSBnYXAgKElzc3VlICMzMjU1KSDigJQgYHBhY2thZ2VzYFxuICogaXMgZGVkdXBsaWNhdGVkLCBhbmQgYHJlcXVpcmVkYCBpcyB0aGUgaGlnaGVzdCB2ZXJzaW9uIGFueSBsaW5lIG5hbWVkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1c3RUb29sY2hhaW5HYXAge1xuICAvKiogVGhlIGhvc3QncyBgcnVzdGNgIHZlcnNpb24sIHdoZW4gY2FyZ28ncyBoZWFkZXIgbGluZSBuYW1lZCBpdC4gKi9cbiAgaW5zdGFsbGVkPzogc3RyaW5nO1xuICAvKiogVGhlIGhpZ2hlc3QgYHJ1c3QtdmVyc2lvbmAgYW55IGFmZmVjdGVkIHBhY2thZ2UgcmVxdWlyZWQuICovXG4gIHJlcXVpcmVkOiBzdHJpbmc7XG4gIC8qKiBEaXN0aW5jdCBgbmFtZUB2ZXJzaW9uYCBwYWNrYWdlcyB0aGF0IG5hbWVkIHRoZSByZXF1aXJlbWVudCwgaW4gb3JkZXIuICovXG4gIHBhY2thZ2VzOiBzdHJpbmdbXTtcbn1cblxuLyoqIEdhdGUgc2lnbmF0dXJlIGluamVjdGVkIGludG8gdGhlIHN5bmMsIHNvIHRlc3RzIGNhbiBkcml2ZSBib3RoIHZlcmRpY3RzLiAqL1xuZXhwb3J0IHR5cGUgTWVyZ2VHYXRlRm4gPSAocmVwb0Rpcjogc3RyaW5nKSA9PiBQcm9taXNlPE1lcmdlR2F0ZU91dGNvbWU+O1xuXG4vKiogUnVucyB0aGUgcmVzb2x2ZWQgY2hlY2suIEluamVjdGVkIGluIHRlc3RzOyBzcGF3bnMgYGRlbm9gIGluIHByb2R1Y3Rpb24uICovXG5leHBvcnQgdHlwZSBUeXBlQ2hlY2tSdW5uZXIgPSAoXG4gIHByb2plY3Q6IFR5cGVDaGVja1Byb2plY3QsXG4pID0+IFByb21pc2U8XG4gIHtcbiAgICBjb2RlOiBudW1iZXI7XG4gICAgb3V0cHV0OiBzdHJpbmc7XG4gICAgYWNjb3VudFVuYXZhaWxhYmxlPzogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIFNldCB3aGVuIHRoZSBjaGVjayBoaXQgaXRzIHRpbWUgbGltaXQgKElzc3VlICM0Nzg2KSwgc28gdGhlIGNhbGxlciBjYW5cbiAgICAgKiB0ZWxsIGEgdGltZW91dCBmcm9tIGEgZmFpbGluZyBjaGVjay4gU2V0IGJ5IHRoZSBwcm9kdWN0aW9uIHJ1bm5lciBvbmx5LlxuICAgICAqL1xuICAgIHRpbWVkT3V0PzogYm9vbGVhbjtcbiAgICAvKipcbiAgICAgKiBTZXQgd2hlbiB0aGUgY2hlY2sgY291bGQgbm90IGJlIHN0YXJ0ZWQgYXQgYWxsLCBhbmQgdGhlIGZhaWx1cmUgaXMgbm90IGFcbiAgICAgKiBob3N0IGFjY291bnQgcmVmdXNhbCAoSXNzdWUgIzQ4NDcpLiBUaGUgY2FsbGVyIHJlcG9ydHMgdGhlIHRyZWUgYXNcbiAgICAgKiBgY2hlY2stY291bGQtbm90LXJ1bmAsIG5vdCBhcyBhIGZhaWxpbmcgY2hlY2suIFNldCBieSB0aGUgcHJvZHVjdGlvblxuICAgICAqIHJ1bm5lciBvbmx5LlxuICAgICAqL1xuICAgIHVucnVubmFibGU/OiB0cnVlO1xuICB9XG4+O1xuXG4vKipcbiAqIFdoaWNoIGFyZ3VtZW50cyBydW4gdGhpcyBwcm9qZWN0J3MgdHlwZSBjaGVjay5cbiAqXG4gKiBBIGBjaGVja2AgdGFzayBpbiB0aGUgbWFuaWZlc3QgaXMgdGhlIHJlcG9zaXRvcnkncyBvd24gZ2F0ZSDigJQgZmxhZ3MsXG4gKiBsb2NrZmlsZSBwaW5zIGFuZCBhbGwg4oCUIHNvIGl0IGlzIHByZWZlcnJlZC4gYGRlbm8uanNvbmNgIG1heSBjYXJyeSBjb21tZW50cyxcbiAqIHNvIHRoZSBtYW5pZmVzdCBpcyBzdHJpcHBlZCBiZWZvcmUgcGFyc2luZyByYXRoZXIgdGhhbiBxdWlldGx5IGxvc2luZyB0aGVcbiAqIHJlcG8ncyBvd24gdGFzayB0byBhIGBKU09OLnBhcnNlYCBmYWlsdXJlLiBBIG1hbmlmZXN0IHRoYXQgc3RpbGwgY2Fubm90IGJlXG4gKiByZWFkIGZhbGxzIGJhY2sgdG8gYSB3aG9sZS10cmVlIGBkZW5vIGNoZWNrYCwgd2hpY2ggdHlwZS1jaGVja3MgdGhlIHNhbWVcbiAqIGZpbGVzIHdpdGggZGVmYXVsdCBmbGFncy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNoZWNrQXJncyhtYW5pZmVzdFBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgcmV0dXJuIChhd2FpdCByZWFkTWFuaWZlc3RUYXNrcyhtYW5pZmVzdFBhdGgpKS5pbmNsdWRlcyhcImNoZWNrXCIpXG4gICAgPyBbXCJ0YXNrXCIsIFwiY2hlY2tcIl1cbiAgICA6IFtcImNoZWNrXCIsIFwiKiovKi50c1wiXTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIHRleHQgaW4gYSBEZW5vIHN0cmluZy1mb3JtIG9yIGNvbW1hbmQtYmVhcmluZyBvYmplY3QgdGFzay4gKi9cbmZ1bmN0aW9uIG1hbmlmZXN0VGFza0NvbW1hbmQodGFzazogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGNvbW1hbmQgPSB0eXBlb2YgdGFzayA9PT0gXCJzdHJpbmdcIlxuICAgID8gdGFza1xuICAgIDogKHRhc2sgYXMgeyBjb21tYW5kPzogdW5rbm93biB9IHwgbnVsbCB8IHVuZGVmaW5lZCk/LmNvbW1hbmQ7XG4gIHJldHVybiB0eXBlb2YgY29tbWFuZCA9PT0gXCJzdHJpbmdcIiAmJiBjb21tYW5kLnRyaW0oKS5sZW5ndGggPiAwXG4gICAgPyBjb21tYW5kXG4gICAgOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogYGNhcmdvIGNoZWNrYCBvdmVyIHRoZSB3aG9sZSB3b3Jrc3BhY2UsIGV2ZXJ5IHRhcmdldCAoSXNzdWUgIzIxMzgpIOKAlFxuICogYC0tbG9ja2VkYCBvbmx5IHdoZW4gYSBgQ2FyZ28ubG9ja2AgaXMgY29tbWl0dGVkLCBzbyBhIG1lcmdlZCBsb2NrZmlsZVxuICogdGhhdCBubyBsb25nZXIgbWF0Y2hlcyBpcyBhIGZhaWx1cmUgYW5kIGFuIHVubG9ja2VkIGNyYXRlIGlzIG5vdCByZWZ1c2VkXG4gKiBmb3IgYSBmaWxlIGl0IG5ldmVyIGhhZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcmdvQ2hlY2tBcmdzKGRpcjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICBjb25zdCBhcmdzID0gW1wiY2hlY2tcIiwgXCItLXdvcmtzcGFjZVwiLCBcIi0tYWxsLXRhcmdldHNcIl07XG4gIGlmIChhd2FpdCBpc0ZpbGUoYCR7ZGlyfS9DYXJnby5sb2NrYCkpIGFyZ3MucHVzaChcIi0tbG9ja2VkXCIpO1xuICByZXR1cm4gYXJncztcbn1cblxuLyoqXG4gKiBUaGUgdGFzayBuYW1lcyBhIERlbm8gbWFuaWZlc3QgZGVmaW5lcy5cbiAqXG4gKiBTdHJpbmcgdGFza3MgYW5kIG9iamVjdCB0YXNrcyB3aXRoIGEgbm9uLWVtcHR5IGBjb21tYW5kYCBjb3VudC4gQVxuICogZGVwZW5kZW5jaWVzLW9ubHkgb2JqZWN0IGlzIGV4Y2x1ZGVkIGJlY2F1c2UgdGhlc2UgZ2F0ZXMgZGlzY292ZXIgY29tbWFuZHNcbiAqIHRvIHJ1biwgbm90IHRhc2sgYWxpYXNlcy4gQSBtYW5pZmVzdCB3aG9zZSBgdGFza3NgIGtleSBpcyBtYWxmb3JtZWQgZGVmaW5lc1xuICogbm9uZSwgYW5kIGFuIHVucGFyc2VhYmxlIG1hbmlmZXN0IGlzIHJlYWQgdGhlIHNhbWUgd2F5IOKAlCB0aGUgY2FsbGVyIHRoZW5cbiAqIGZhbGxzIGJhY2sgdG8gYSBjaGVjayBpdCBjYW4gcnVuIHJhdGhlciB0aGFuIHRyeWluZyBhIHRhc2sgdGhhdCBtYXkgbm90IGV4aXN0LlxuICpcbiAqIFNoYXJlZCB3aXRoIHRoZSBjb25mbGljdC1yZXNvbHV0aW9uIGdhdGUgKElzc3VlICMxNTU5KSwgd2hpY2ggcnVucyBtb3JlIG9mIGFcbiAqIHJlcG9zaXRvcnkncyBvd24gdGFza3MgdGhhbiBhIHR5cGUgY2hlY2sgYWxvbmUuXG4gKlxuICogQHBhcmFtIG1hbmlmZXN0UGF0aCAtIFBhdGggdG8gYGRlbm8uanNvbmAgb3IgYGRlbm8uanNvbmNgXG4gKiBAcmV0dXJucyBFdmVyeSB0YXNrIG5hbWUgdGhlIG1hbmlmZXN0IGRlZmluZXM7IGVtcHR5IHdoZW4gaXQgZGVmaW5lcyBub25lXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkTWFuaWZlc3RUYXNrcyhcbiAgbWFuaWZlc3RQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShcbiAgICAgIHN0cmlwSnNvbmMoYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUobWFuaWZlc3RQYXRoKSksXG4gICAgKTtcbiAgICBjb25zdCB0YXNrcyA9IHBhcnNlZD8udGFza3M7XG4gICAgaWYgKCF0YXNrcyB8fCB0eXBlb2YgdGFza3MgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgICByZXR1cm4gT2JqZWN0LmVudHJpZXModGFza3MgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgICAuZmlsdGVyKChbLCB0YXNrXSkgPT4gbWFuaWZlc3RUYXNrQ29tbWFuZCh0YXNrKSAhPT0gdW5kZWZpbmVkKVxuICAgICAgLm1hcCgoW25hbWVdKSA9PiBuYW1lKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVW5wYXJzZWFibGUgbWFuaWZlc3Qg4oCUIGl0IGRlZmluZXMgbm90aGluZyB0aGlzIGdhdGUgY2FuIHJ1bi5cbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgdHlwZSBjaGVjayB0byBydW4gZm9yIGV2ZXJ5IERlbm8gcHJvamVjdCBpbiBhIHRyZWUuXG4gKlxuICogQHBhcmFtIHJlcG9EaXIgLSBSb290IG9mIHRoZSBtZXJnZWQgd29ya2luZyB0cmVlXG4gKiBAcmV0dXJucyBFdmVyeSBwcm9qZWN0IHRvIGNoZWNrOyBlbXB0eSB3aGVuIHRoZSB0cmVlIGRlZmluZXMgbm9uZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmluZFR5cGVDaGVja1Byb2plY3RzKFxuICByZXBvRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPFR5cGVDaGVja1Byb2plY3RbXT4ge1xuICBjb25zdCBmb3VuZDogVHlwZUNoZWNrUHJvamVjdFtdID0gW107XG4gIGZvciAoY29uc3QgcHJvamVjdCBvZiBhd2FpdCBmaW5kUHJvamVjdE1hbmlmZXN0cyhyZXBvRGlyKSkge1xuICAgIGZvdW5kLnB1c2goe1xuICAgICAgZGlyOiBwcm9qZWN0LmRpcixcbiAgICAgIGtpbmQ6IHByb2plY3Qua2luZCxcbiAgICAgIGFyZ3M6IHByb2plY3Qua2luZCA9PT0gXCJjYXJnb1wiXG4gICAgICAgID8gYXdhaXQgY2FyZ29DaGVja0FyZ3MocHJvamVjdC5kaXIpXG4gICAgICAgIDogYXdhaXQgcmVzb2x2ZUNoZWNrQXJncyhwcm9qZWN0Lm1hbmlmZXN0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogQ29sbGFwc2UgY29uc2VjdXRpdmUgaWRlbnRpY2FsIGxpbmVzIGludG8gb25lIGxpbmUgbWFya2VkIGAow5dOKWAuXG4gKlxuICogQ2FyZ28ncyBcInJlcXVpcmVzIHJ1c3RjXCIgcmVmdXNhbCByZXBlYXRzIHRoZSBzYW1lIGxpbmUgb25jZSBwZXIgdGFyZ2V0IOKAlFxuICogYG5lYXRfYWlfZGlzY292ZXJ5QDAuNzQuMjc5IHJlcXVpcmVzIHJ1c3RjIDEuOTlgIGZvcnR5IHRpbWVzIG92ZXIg4oCUIHdoaWNoXG4gKiBwdXNoZWQgdGhlIG9uZSBsaW5lIHRoYXQgbWF0dGVyZWQgZm9yIElzc3VlICMzMjU1IG91dCBvZiB0aGUga2VwdCB0YWlsXG4gKiBlbnRpcmVseS4gT25seSAqY29uc2VjdXRpdmUqIGR1cGxpY2F0ZXMgY29sbGFwc2U6IGxpbmVzIHJlcGVhdGVkIHdpdGggb3RoZXJcbiAqIG91dHB1dCBiZXR3ZWVuIHRoZW0gYXJlIGEgd2Vha2VyIHNpZ25hbCBvZiB0aGUgc2FtZSBjYXVzZSBhbmQgYXJlIGtlcHQgYXNcbiAqIHRoZXkgd2VyZS5cbiAqXG4gKiBAcGFyYW0gb3V0cHV0IC0gVGhlIHJhdyBjaGVjayBvdXRwdXQsIGJlZm9yZSBpdCBpcyB0cmltbWVkIHRvIGEgdGFpbFxuICogQHJldHVybnMgVGhlIHNhbWUgbGluZXMsIHdpdGggY29uc2VjdXRpdmUgcnVucyBjb2xsYXBzZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbGxhcHNlUmVwZWF0ZWRMaW5lcyhvdXRwdXQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBjb2xsYXBzZWQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbaV0hO1xuICAgIGxldCBydW4gPSAxO1xuICAgIHdoaWxlIChpICsgcnVuIDwgbGluZXMubGVuZ3RoICYmIGxpbmVzW2kgKyBydW5dID09PSBsaW5lKSBydW4rKztcbiAgICBjb2xsYXBzZWQucHVzaChydW4gPiAxID8gYCR7bGluZX0gKMOXJHtydW59KWAgOiBsaW5lKTtcbiAgICBpICs9IHJ1bjtcbiAgfVxuICByZXR1cm4gY29sbGFwc2VkLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBLZWVwIHRoZSB0YWlsIG9mIHRoZSBvdXRwdXQg4oCUIHRoZSBlcnJvcnMgc2l0IGF0IHRoZSBlbmQgb2YgYSBjaGVjayBydW4uICovXG5mdW5jdGlvbiB0YWlsKG91dHB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXMgPSBjb2xsYXBzZVJlcGVhdGVkTGluZXMob3V0cHV0LnRyaW0oKSkuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGtlcHQgPSBsaW5lcy5zbGljZSgtTUFYX09VVFBVVF9MSU5FUykuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGtlcHQubGVuZ3RoID4gTUFYX09VVFBVVF9DSEFSUyA/IGtlcHQuc2xpY2UoLU1BWF9PVVRQVVRfQ0hBUlMpIDoga2VwdDtcbn1cblxuLyoqIExvbmdlc3QgbGluZSBjb25zaWRlcmVkIGZvciBhIHRvb2xjaGFpbi1nYXAgcGF0dGVybiAoSXNzdWUgIzMyNTUpLiAqL1xuY29uc3QgTUFYX0dBUF9MSU5FX0NIQVJTID0gNDAwMDtcblxuLyoqXG4gKiBDYXJnbydzIFwicnVzdGMgWCBpcyBub3Qgc3VwcG9ydGVkXCIgaGVhZGVyLCBuYW1pbmcgdGhlIGhvc3QncyB2ZXJzaW9uLlxuICpcbiAqIEFuY2hvcmVkIG9uIGEgbGl0ZXJhbCBwcmVmaXggYmVmb3JlIHRoZSBudW1lcmljIGNhcHR1cmUgYW5kIGEgbGl0ZXJhbFxuICogc3VmZml4IGFmdGVyIGl0LCBzbyB0aGUgY2FwdHVyZSdzIGBbMC05Ll0qYCBjYW5ub3QgYmFja3RyYWNrIGFnYWluc3RcbiAqIGhvc3RpbGUgaW5wdXQg4oCUIGVhY2ggY2hhcmFjdGVyIGlzIGVpdGhlciBhIGRpZ2l0L2RvdCAoY29uc3VtZWQgYnkgdGhlXG4gKiBjbGFzcykgb3IgdGhlIGZpcnN0IGNoYXJhY3RlciBvZiB0aGUgbGl0ZXJhbCBzdWZmaXggKHdoaWNoIHRoZSBjbGFzcyBuZXZlclxuICogbWF0Y2hlcyksIHNvIHRoZSBtYXRjaCBpcyBhIHNpbmdsZSBsaW5lYXIgcGFzcy5cbiAqL1xuY29uc3QgUlVTVENfSEVBREVSX1JFID0gL15lcnJvcjogcnVzdGMgKFswLTldWzAtOS5dKikgaXMgbm90IHN1cHBvcnRlZC87XG5cbi8qKlxuICogT25lIGNhcmdvIFwicGFja2FnZUB2ZXJzaW9uIHJlcXVpcmVzIHJ1c3RjIFhcIiBsaW5lLlxuICpcbiAqIFRoZSBzYW1lIGFuY2hvcmluZyByZWFzb25pbmcgYXMge0BsaW5rIFJVU1RDX0hFQURFUl9SRX06IGBbXlxcc0BdK2AgaXNcbiAqIGRpc2pvaW50IGZyb20gdGhlIGxpdGVyYWwgYEBgIGFuZCBgIGAgdGhhdCBmb2xsb3cgaXQsIHNvIG5laXRoZXIgY2FwdHVyZVxuICogZ3JvdXAgY2FuIGJhY2t0cmFjayBpbnRvIHRoZSBuZXh0LlxuICovXG5jb25zdCBSVVNUQ19SRVFVSVJFU19SRSA9IC9eKFteXFxzQF0rKUAoW15cXHNAXSspIHJlcXVpcmVzIHJ1c3RjIChbMC05XVswLTkuXSopLztcblxuLyoqXG4gKiBUaGUgaGludCBjYXJnbyBhcHBlbmRzIG9ubHkgd2hlbiBldmVyeSBpbmNvbXBhdGlibGUgcGFja2FnZSBpcyBhXG4gKiBkZXBlbmRlbmN5LCBuZXZlciBhIHdvcmtzcGFjZSBtZW1iZXIgKGBsb2NhbF9pbmNvbXBhdGlibGVgIGluIGNhcmdvJ3NcbiAqIGBvcHMvY2FyZ29fY29tcGlsZS9tb2QucnNgKTogdGhlIHJlZnVzYWwgaXMgdGhlbiBmaXhhYmxlIGJ5IHNlbGVjdGluZyBvbGRlclxuICogZGVwZW5kZW5jeSB2ZXJzaW9ucyBpbiBgQ2FyZ28ubG9ja2AsIHdoaWNoIGEgcmVzb2x1dGlvbiBjYW4gZG8uXG4gKi9cbmNvbnN0IERFUEVOREVOQ1lfT05MWV9ISU5UID1cbiAgXCJFaXRoZXIgdXBncmFkZSBydXN0YyBvciBzZWxlY3QgY29tcGF0aWJsZSBkZXBlbmRlbmN5IHZlcnNpb25zXCI7XG5cbi8qKiBOdW1lcmljLCBkb3Qtc2VwYXJhdGVkIHZlcnNpb24gY29tcGFyaXNvbiAoYFwiMS45OVwiYCA+IGBcIjEuOTguMFwiYCkuICovXG5mdW5jdGlvbiBjb21wYXJlVmVyc2lvbnMoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBwYXJ0c0EgPSBhLnNwbGl0KFwiLlwiKS5tYXAoTnVtYmVyKTtcbiAgY29uc3QgcGFydHNCID0gYi5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG4gIGNvbnN0IGxlbmd0aCA9IE1hdGgubWF4KHBhcnRzQS5sZW5ndGgsIHBhcnRzQi5sZW5ndGgpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZGlmZiA9IChwYXJ0c0FbaV0gPz8gMCkgLSAocGFydHNCW2ldID8/IDApO1xuICAgIGlmIChkaWZmICE9PSAwKSByZXR1cm4gZGlmZjtcbiAgfVxuICByZXR1cm4gMDtcbn1cblxuLyoqXG4gKiBEZXRlY3QgYSBjYXJnbyByZWZ1c2FsIGNhdXNlZCBieSB0aGUgaG9zdCdzIGBydXN0Y2AgYmVpbmcgb2xkZXIgdGhhbiBhXG4gKiB3b3Jrc3BhY2UgcGFja2FnZSdzIGBydXN0LXZlcnNpb25gIChJc3N1ZSAjMzI1NSkuXG4gKlxuICogTm8gcmVzb2x1dGlvbiBjaGFuZ2UgY2FuIGZpeCB0aGF0IOKAlCBvbmx5IHJhaXNpbmcgdGhlIGNvbnRhaW5lcidzIFJ1c3QgcGluXG4gKiAoYGNvbnRhaW5lci90b29scy5qc29uYCkgY2FuIOKAlCBzbyB0aGUgY2FsbGVyIHRyZWF0cyBpdCBhcyBhbiBlbnZpcm9ubWVudFxuICogZmF1bHQgcmF0aGVyIHRoYW4gYW4gb3JkaW5hcnkgY2hlY2sgZmFpbHVyZSwgYW5kIHNraXBzIHRoZSByZXBhaXIgcm91bmRzXG4gKiBidWlsdCBmb3IgYSBiYWQgcmVzb2x1dGlvbi4gQSByZWZ1c2FsIGNhcnJ5aW5nIGNhcmdvJ3MgZGVwZW5kZW5jeS1vbmx5IGhpbnRcbiAqICh7QGxpbmsgREVQRU5ERU5DWV9PTkxZX0hJTlR9KSBpcyBub3QgYSBnYXA6IGEgYENhcmdvLmxvY2tgIGNoYW5nZSBjYW4gZml4XG4gKiBpdCwgc28gaXQgc3RheXMgYW4gb3JkaW5hcnkgZmFpbHVyZSB0aGF0IGEgcmVwYWlyIHJvdW5kIG1heSBhbnN3ZXIuXG4gKlxuICogQHBhcmFtIG91dHB1dCAtIFRoZSByYXcgYGNhcmdvIGNoZWNrYCBvdXRwdXQgKHVudHJpbW1lZClcbiAqIEByZXR1cm5zIFRoZSBnYXAsIG9yIHVuZGVmaW5lZCB3aGVuIG5vIFwicmVxdWlyZXMgcnVzdGNcIiBsaW5lIGlzIGZvdW5kIG9yXG4gKiAgIGNhcmdvIHNheXMgb25seSBkZXBlbmRlbmNpZXMgYXJlIGluY29tcGF0aWJsZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0UnVzdFRvb2xjaGFpbkdhcChcbiAgb3V0cHV0OiBzdHJpbmcsXG4pOiBSdXN0VG9vbGNoYWluR2FwIHwgdW5kZWZpbmVkIHtcbiAgbGV0IGluc3RhbGxlZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgcmVxdWlyZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcGFja2FnZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHJhd0xpbmUgb2Ygb3V0cHV0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbGluZSA9IHJhd0xpbmUudHJpbSgpLnNsaWNlKDAsIE1BWF9HQVBfTElORV9DSEFSUyk7XG5cbiAgICBjb25zdCBoZWFkZXIgPSBSVVNUQ19IRUFERVJfUkUuZXhlYyhsaW5lKTtcbiAgICBpZiAoaGVhZGVyKSB7XG4gICAgICBpbnN0YWxsZWQgPSBoZWFkZXJbMV07XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCByZXF1aXJlcyA9IFJVU1RDX1JFUVVJUkVTX1JFLmV4ZWMobGluZSk7XG4gICAgaWYgKHJlcXVpcmVzKSB7XG4gICAgICBjb25zdCBbLCBuYW1lLCB2ZXJzaW9uLCByZXF1aXJlZFZlcnNpb25dID0gcmVxdWlyZXM7XG4gICAgICBjb25zdCBwa2cgPSBgJHtuYW1lfUAke3ZlcnNpb259YDtcbiAgICAgIGlmICghc2Vlbi5oYXMocGtnKSkge1xuICAgICAgICBzZWVuLmFkZChwa2cpO1xuICAgICAgICBwYWNrYWdlcy5wdXNoKHBrZyk7XG4gICAgICB9XG4gICAgICBpZiAoIXJlcXVpcmVkIHx8IGNvbXBhcmVWZXJzaW9ucyhyZXF1aXJlZFZlcnNpb24hLCByZXF1aXJlZCkgPiAwKSB7XG4gICAgICAgIHJlcXVpcmVkID0gcmVxdWlyZWRWZXJzaW9uO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmICghcmVxdWlyZWQgfHwgb3V0cHV0LmluY2x1ZGVzKERFUEVOREVOQ1lfT05MWV9ISU5UKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHsgaW5zdGFsbGVkLCByZXF1aXJlZCwgcGFja2FnZXMgfTtcbn1cblxuLyoqXG4gKiBPbmUtbGluZSBmYWlsdXJlIGRldGFpbCBmb3IgYSB7QGxpbmsgUnVzdFRvb2xjaGFpbkdhcH0gKElzc3VlICMzMjU1KSxcbiAqIG5hbWluZyB0aGUgaW5zdGFsbGVkIGFuZCByZXF1aXJlZCBydXN0YywgdGhlIHBhY2thZ2VzIGFuZCB0aGUgcGluIHRvIHJhaXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVSdXN0VG9vbGNoYWluR2FwKFxuICB3aGVyZTogc3RyaW5nLFxuICBjb2RlOiBudW1iZXIsXG4gIGdhcDogUnVzdFRvb2xjaGFpbkdhcCxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHt3aGVyZX0gZmFpbGVkIChleGl0ICR7Y29kZX0pOiB0aGUgaG9zdCdzIHJ1c3RjIGAgK1xuICAgIGAke1xuICAgICAgZ2FwLmluc3RhbGxlZCA/PyBcIih1bmtub3duKVwiXG4gICAgfSBpcyBvbGRlciB0aGFuIHRoZSBydXN0LXZlcnNpb24gJHtnYXAucmVxdWlyZWR9IHRoYXQgYCArXG4gICAgYCR7Z2FwLnBhY2thZ2VzLmpvaW4oXCIsIFwiKX0gcmVxdWlyZShzKSDigJQgcmFpc2UgdGhlIGNvbnRhaW5lcidzIFJ1c3QgcGluIGAgK1xuICAgIGAoY29udGFpbmVyL3Rvb2xzLmpzb24pIHRvIGF0IGxlYXN0ICR7Z2FwLnJlcXVpcmVkfTsgYSB3b3Jrc3BhY2UgYCArXG4gICAgXCJwYWNrYWdlIHJlcXVpcmVzIGl0LCBzbyBubyBjaGFuZ2UgdG8gdGhlIHJlc29sdXRpb24gY2FuIGZpeCB0aGlzXCI7XG59XG5cbi8qKlxuICogSW1wb3J0LWZhaWx1cmUgbGluZSBuYW1pbmcgYSByZW1vdGUgbW9kdWxlLCBlLmcuXG4gKiBgZXJyb3I6IEltcG9ydCAnaHR0cHM6Ly9lc20uc2gveCcgZmFpbGVkYC4gQW5jaG9yZWQgb24gdGhlIGxpdGVyYWwgcHJlZml4O1xuICogYFteJ1xcc10rYCBpcyBkaXNqb2ludCBmcm9tIHRoZSBjbG9zaW5nIHF1b3RlLCBzbyB0aGUgbWF0Y2ggaXMgbGluZWFyLlxuICovXG5jb25zdCBSRU1PVEVfSU1QT1JUX0ZBSUxFRF9SRSA9IC9eZXJyb3I6IEltcG9ydCAnKGh0dHBzPzpcXC9cXC9bXidcXHNdKyknIGZhaWxlZC87XG5cbi8qKlxuICogbnBtIHBhY2thZ2UtY2FjaGUgZmFpbHVyZSBsaW5lLCBlLmcuXG4gKiBgZXJyb3I6IEZhaWxlZCBjYWNoaW5nIG5wbSBwYWNrYWdlICdwbGF5d3JpZ2h0LWNvcmVAMS42MC4wJ2AgKElzc3VlICM0ODQ4KS5cbiAqIEFuY2hvcmVkIG9uIHRoZSBsaXRlcmFsIHByZWZpeDsgYFteJ1xcc10rYCBpcyBkaXNqb2ludCBmcm9tIHRoZSBjbG9zaW5nIHF1b3RlLFxuICogc28gdGhlIG1hdGNoIGlzIGxpbmVhci5cbiAqL1xuY29uc3QgUkVNT1RFX05QTV9DQUNIRV9GQUlMRURfUkUgPVxuICAvXmVycm9yOiBGYWlsZWQgY2FjaGluZyBucG0gcGFja2FnZSAnKFteJ1xcc10rKScvO1xuXG4vKipcbiAqIG5wbSBtZXRhZGF0YS1sb2FkIGZhaWx1cmUgbGluZSwgZS5nLlxuICogYGVycm9yOiBGYWlsZWQgbG9hZGluZyBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy94IGZvciBwYWNrYWdlIFwieFwiYCAoSXNzdWVcbiAqICM0ODQ4KS4gQW5jaG9yZWQgb24gdGhlIGxpdGVyYWwgcHJlZml4OyBgW15cXHNdK2AgaXMgZGlzam9pbnQgZnJvbSB0aGUgc3BhY2VcbiAqIHRoYXQgb3BlbnMgdGhlIGxpdGVyYWwgYCBmb3IgcGFja2FnZSBcImAsIHNvIHRoZSBtYXRjaCBpcyBsaW5lYXIuXG4gKi9cbmNvbnN0IFJFTU9URV9OUE1fTUVUQURBVEFfRkFJTEVEX1JFID1cbiAgL15lcnJvcjogRmFpbGVkIGxvYWRpbmcgKGh0dHBzPzpcXC9cXC9bXlxcc10rKSBmb3IgcGFja2FnZSBcIi87XG5cbi8qKlxuICogQSBjb25uZWN0aW9uLWNsYXNzIGNhdXNlOiB0aGUgaG9zdCBjb3VsZCBub3Qgb3BlbiBhIHJvdXRlIHRvIHRoZSBtb2R1bGVcbiAqIGhvc3QuIExpdGVyYWwgYWx0ZXJuYXRpdmVzIG9ubHksIHNvIHRoZSBtYXRjaCBpcyBsaW5lYXIgaW4gdGhlIGxpbmUgbGVuZ3RoLlxuICovXG5jb25zdCBSRU1PVEVfRkVUQ0hfQ0FVU0VfUkUgPVxuICAvZXJyb3Igc2VuZGluZyByZXF1ZXN0IGZvciB1cmx8dW5zdWNjZXNzZnVsIHR1bm5lbHxkbnMgZXJyb3J8Y2xpZW50IGVycm9yIFxcKENvbm5lY3RcXCl8Y29ubmVjdGlvbiAocmVmdXNlZHxyZXNldHx0aW1lZCBvdXQpL2k7XG5cbi8qKlxuICogQW4gU0dSIGNvbG91ciByZW1uYW50IHdob3NlIGVzY2FwZSBieXRlIHdhcyBhbHJlYWR5IHN0cmlwcGVkIHVwc3RyZWFtLCBlLmcuXG4gKiBieSBhbiBpc3N1ZSBvciBsb2cgc2FuaXRpc2VyLCBsZWF2aW5nIGEgYmFyZSBgWzBtYCBvciBgWzFtWzMxbWAgKElzc3VlXG4gKiAjNDg1MykuIE1hdGNoZWQgYW55d2hlcmUgaW4gdGhlIGxpbmUuIEVhY2ggbWF0Y2ggc3RhcnRzIGF0IGEgYFtgLCBhbmRcbiAqIGBbMC05O10qYCBpcyBkaXNqb2ludCBmcm9tIHRoZSBjbG9zaW5nIGBtYCwgc28gdGhlIHNjYW4gaXMgbGluZWFyLlxuICovXG5jb25zdCBPUlBIQU5fU0dSX1JFID0gL1xcW1swLTk7XSptL2c7XG5cbi8qKlxuICogQSBgY2FyZ29gIHJlZnVzYWwgdG8gZmV0Y2ggZnJvbSB0aGUgY3JhdGUgcmVnaXN0cnksIHdpdGggdGhlIGNvbm5lY3Rpb24tY2xhc3NcbiAqIGNhdXNlIHRoZSBob3N0IHJlcG9ydGVkIChJc3N1ZSAjNDc4NikuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2FyZ29SZWdpc3RyeUdhcCB7XG4gIC8qKiBUaGUgdHJpbW1lZCBvdXRwdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBjb25uZWN0aW9uLWNsYXNzIGNhdXNlLiAqL1xuICBjYXVzZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIEEgbGluZSBpbiB3aGljaCBjYXJnbyByZWZ1c2VzIHRvIGdldCBpdHMgZGVwZW5kZW5jaWVzIGZyb20gdGhlIHJlZ2lzdHJ5XG4gKiAoSXNzdWUgIzQ3ODYpLiBFYWNoIGFsdGVybmF0aXZlIGlzIGEgZml4ZWQgbGl0ZXJhbCBhbmNob3JlZCBhdCB0aGUgc3RhcnQgb2ZcbiAqIHRoZSBsaW5lIGFuZCBmb2xsb3dlZCBieSBhIHdvcmQgYm91bmRhcnksIHNvIHRoZSBtYXRjaCBpcyBsaW5lYXIgaW4gdGhlIGxpbmVcbiAqIGxlbmd0aDogdGhlcmUgaXMgbm8gcXVhbnRpZmllciBmb3IgaXQgdG8gYmFja3RyYWNrIHRocm91Z2guXG4gKi9cbmNvbnN0IENBUkdPX1JFR0lTVFJZX1JFRlVTQUxfUkUgPVxuICAvXmVycm9yOiBmYWlsZWQgdG8gKD86Z2V0fGRvd25sb2FkfGZldGNofHVwZGF0ZSlcXGJ8Xig/OnVuYWJsZSB0byB1cGRhdGUgcmVnaXN0cnl8ZmFpbGVkIHRvIGRvd25sb2FkfGRvd25sb2FkIG9mIGNvbmZpZ1xcLmpzb24gZmFpbGVkfGZhaWxlZCB0byBsb2FkIHNvdXJjZSBmb3IgZGVwZW5kZW5jeXxmYWlsZWQgdG8gcXVlcnkgcmVwbGFjZWQgc291cmNlKVxcYi87XG5cbi8qKlxuICogQSBjb25uZWN0aW9uLWNsYXNzIGNhdXNlOiB0aGUgaG9zdCBjb3VsZCBub3Qgb3BlbiBhIHJvdXRlIHRvIHRoZSBjcmF0ZVxuICogcmVnaXN0cnksIG9yIGNhcmdvIHdhcyB0b2xkIG5vdCB0byB0cnkgKGAtLW9mZmxpbmVgKS4gRml4ZWQgbGl0ZXJhbHMgb25seSBhbmRcbiAqIG5vdCBhbmNob3JlZCwgc28gZWFjaCBhbHRlcm5hdGl2ZSBpcyBhIHBsYWluIHN1YnN0cmluZyBzY2FuIGFuZCB0aGUgbWF0Y2ggaXNcbiAqIGxpbmVhciBpbiB0aGUgbGluZSBsZW5ndGguXG4gKi9cbmNvbnN0IENBUkdPX1JFR0lTVFJZX0NBVVNFX1JFID1cbiAgL2NvdWxkIG5vdCByZXNvbHZlIGhvc3QoPzpuYW1lKT98Y291bGRuJ3QgY29ubmVjdHxmYWlsZWQgdG8gY29ubmVjdHxjb25uZWN0aW9uICg/OnJlZnVzZWR8cmVzZXR8dGltZWQgb3V0KXxuZXR3b3JrIGlzIHVucmVhY2hhYmxlfHRlbXBvcmFyeSBmYWlsdXJlIGluIG5hbWUgcmVzb2x1dGlvbnxvcGVyYXRpb24gdGltZWQgb3V0fGF0dGVtcHRpbmcgdG8gbWFrZSBhbiBIVFRQIHJlcXVlc3QsIGJ1dCAtLW9mZmxpbmUgd2FzIHNwZWNpZmllZHxvZmZsaW5lIG1vZGUvaTtcblxuLyoqXG4gKiBjYXJnbydzIG93biByZXRyeSB3YXJuaW5nLCBgd2FybmluZzogc3B1cmlvdXMgbmV0d29yayBlcnJvciAoTiB0cmllc1xuICogcmVtYWluaW5nKTog4oCmYC4gSXQgcmVwZWF0cyB0aGUgY2F1c2Ugd2hpbGUgY2FyZ28gcmV0cmllcywgc28gaXQgaXMga2VwdCBvbmx5XG4gKiBhcyBhIGZhbGxiYWNrIGNhdXNlLlxuICovXG5jb25zdCBDQVJHT19TUFVSSU9VU19SRVRSWV9SRSA9IC9zcHVyaW91cyBuZXR3b3JrIGVycm9yL2k7XG5cbi8qKlxuICogRGV0ZWN0IGEgY2FyZ28gcmVmdXNhbCBjYXVzZWQgYnkgdGhlIGhvc3QgYmVpbmcgdW5hYmxlIHRvIHJlYWNoIHRoZSBjcmF0ZVxuICogcmVnaXN0cnkgKElzc3VlICM0Nzg2KS5cbiAqXG4gKiBBbiB1bnJlYWNoYWJsZSByZWdpc3RyeSBpcyBhIGhvc3QgZmF1bHQsIGxpa2UgYW4gdW5yZWFjaGFibGUgbW9kdWxlIGhvc3RcbiAqIChJc3N1ZSAjNDQyMiksIG5vdCBhIGJhZCByZXNvbHV0aW9uLiBBIGdhcCBuZWVkcyBib3RoIGEgcmVnaXN0cnktZmV0Y2ggcmVmdXNhbFxuICogbGluZSBhbmQgYSBjb25uZWN0aW9uLWNsYXNzIGNhdXNlIGxpbmUuIFRoZSBjYXVzZSByZXBvcnRlZCBpcyB0aGUgbGFzdFxuICogY29ubmVjdGlvbi1jbGFzcyBsaW5lIHRoYXQgaXMgbm90IGEgYHNwdXJpb3VzIG5ldHdvcmsgZXJyb3JgIHdhcm5pbmcsIGZhbGxpbmdcbiAqIGJhY2sgdG8gdGhlIGxhc3Qgc3VjaCB3YXJuaW5nLiBBIGNvbXBpbGUgZXJyb3IsIGEgYC0tbG9ja2VkYCBsb2NrZmlsZSByZWZ1c2FsLFxuICogYSBtYW5pZmVzdCBwYXJzZSBlcnJvciwgb3IgYSBydXN0Yy12ZXJzaW9uIGdhcCBpcyBub3QgYSByZWdpc3RyeSBnYXAuXG4gKlxuICogQHBhcmFtIG91dHB1dCAtIFRoZSByYXcgY2FyZ28gb3V0cHV0ICh1bnRyaW1tZWQpXG4gKiBAcmV0dXJucyBUaGUgZ2FwLCBvciB1bmRlZmluZWQgd2hlbiBubyByZWdpc3RyeSByZWZ1c2FsIGFuZCBjYXVzZSBib3RoIGFwcGVhclxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0Q2FyZ29SZWdpc3RyeUdhcChcbiAgb3V0cHV0OiBzdHJpbmcsXG4pOiBDYXJnb1JlZ2lzdHJ5R2FwIHwgdW5kZWZpbmVkIHtcbiAgbGV0IHJlZnVzZWQgPSBmYWxzZTtcbiAgbGV0IGNhdXNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCByZXRyeUNhdXNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGZvciAoY29uc3QgcmF3TGluZSBvZiBvdXRwdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3TGluZS50cmltKCkuc2xpY2UoMCwgTUFYX0dBUF9MSU5FX0NIQVJTKTtcbiAgICBpZiAoQ0FSR09fUkVHSVNUUllfUkVGVVNBTF9SRS50ZXN0KGxpbmUpKSB7XG4gICAgICByZWZ1c2VkID0gdHJ1ZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIUNBUkdPX1JFR0lTVFJZX0NBVVNFX1JFLnRlc3QobGluZSkpIGNvbnRpbnVlO1xuICAgIGlmIChDQVJHT19TUFVSSU9VU19SRVRSWV9SRS50ZXN0KGxpbmUpKSB7XG4gICAgICByZXRyeUNhdXNlID0gbGluZTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2F1c2UgPSBsaW5lO1xuICAgIH1cbiAgfVxuICBjb25zdCBwaWNrZWQgPSBjYXVzZSA/PyByZXRyeUNhdXNlO1xuICByZXR1cm4gcmVmdXNlZCAmJiBwaWNrZWQgIT09IHVuZGVmaW5lZCA/IHsgY2F1c2U6IHBpY2tlZCB9IDogdW5kZWZpbmVkO1xufVxuXG4vKiogQ2xhc3NpZnkgYW4gb2ZmbGluZSByZXRyeSBvbmx5IGFmdGVyIHRoZSBpbml0aWFsIHJlZ2lzdHJ5IGdhcCBpcyBlc3RhYmxpc2hlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0NhcmdvT2ZmbGluZVJlZ2lzdHJ5R2FwKG91dHB1dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChkZXRlY3RDYXJnb1JlZ2lzdHJ5R2FwKG91dHB1dCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsaW5lcyA9IG91dHB1dC5zcGxpdChcIlxcblwiKS5tYXAoKGxpbmUpID0+XG4gICAgbGluZS50cmltKCkuc2xpY2UoMCwgTUFYX0dBUF9MSU5FX0NIQVJTKVxuICApO1xuICByZXR1cm4gbGluZXMuc29tZSgobGluZSkgPT5cbiAgICAvXig/OmVycm9yOiApPyg/Om5vIG1hdGNoaW5nIHBhY2thZ2UgbmFtZWR8ZmFpbGVkIHRvIHNlbGVjdCBhIHZlcnNpb24gZm9yIHRoZSByZXF1aXJlbWVudClcXGIvXG4gICAgICAudGVzdChsaW5lKVxuICApICYmIGxpbmVzLnNvbWUoKGxpbmUpID0+XG4gICAgLyg/OnlvdSdyZSB1c2luZyBvZmZsaW5lIG1vZGV8b2ZmbGluZSBtb2RlIFxcKHZpYSBgLS1vZmZsaW5lYFxcKSkvaS50ZXN0KGxpbmUpXG4gICk7XG59XG5cbi8qKlxuICogVGhlIHNhbWUgY2FyZ28gYXJndiB3aXRoIGAtLW9mZmxpbmVgIHN0cmFpZ2h0IGFmdGVyIHRoZSBzdWJjb21tYW5kIChJc3N1ZVxuICogIzQ3ODYpLCBzbyB0aGUgbG9jYWwgY2FyZ28gY2FjaGUgY2FuIHNhdGlzZnkgYSByZWdpc3RyeSB0aGUgaG9zdCBjYW5ub3RcbiAqIHJlYWNoLiBBbiBhcmd2IHRoYXQgYWxyZWFkeSBjYXJyaWVzIHRoZSBmbGFnIGlzIHJldHVybmVkIHVuY2hhbmdlZCwgc28gdGhlXG4gKiBjYWxsIGlzIGlkZW1wb3RlbnQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBUaGUgYXJndiBhZnRlciB0aGUgZXhlY3V0YWJsZSwgaXRzIGZpcnN0IGVsZW1lbnQgdGhlIHN1YmNvbW1hbmRcbiAqIEByZXR1cm5zIEEgbmV3IGFyZ3Ygd2l0aCBgLS1vZmZsaW5lYCBpbiBzZWNvbmQgcGxhY2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhDYXJnb09mZmxpbmUoYXJnczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGlmIChhcmdzLmxlbmd0aCA9PT0gMCB8fCBhcmdzLmluY2x1ZGVzKFwiLS1vZmZsaW5lXCIpKSByZXR1cm4gWy4uLmFyZ3NdO1xuICByZXR1cm4gW2FyZ3NbMF0hLCBcIi0tb2ZmbGluZVwiLCAuLi5hcmdzLnNsaWNlKDEpXTtcbn1cblxuLyoqXG4gKiBEZXRlY3QgYSBEZW5vIHRhc2sgdGhhdCBjb3VsZCBub3QgZmV0Y2ggYSByZW1vdGUgbW9kdWxlIGJlY2F1c2UgdGhlIGhvc3RcbiAqIGNhbm5vdCByZWFjaCB0aGUgbW9kdWxlIGhvc3QgKElzc3VlICM0NDIyKSwgb3IgYW4gbnBtIHBhY2thZ2Ugb3IgcmVnaXN0cnlcbiAqIChJc3N1ZSAjNDg0OCkuXG4gKlxuICogQW4gdW5yZWFjaGFibGUgaG9zdCBpcyBhbiBlbnZpcm9ubWVudCBmYXVsdCwgbGlrZSB0aGUgUnVzdCB0b29sY2hhaW4gZ2FwIG9mXG4gKiBJc3N1ZSAjMzI1NSwgbm90IGEgYmFkIHJlc29sdXRpb246IGEgcmVwYWlyIHJvdW5kIGNhbm5vdCBmaXggaXQuIEEgZ2FwIGlzXG4gKiByZXBvcnRlZCBvbmx5IHdoZW4gYSBmYWlsdXJlIGhlYWRlciBuYW1lcyB0aGUgcmVtb3RlIGFuZCBhIGNvbm5lY3Rpb24tY2xhc3NcbiAqIGNhdXNlIGxpbmUgZm9sbG93cyBpdC4gVGhlIGhlYWRlcnMgYXJlIHRoZSBsZWdhY3kgYGVycm9yOiBJbXBvcnQgJzx1cmw+J1xuICogZmFpbGVkYCwgdGhlIG5wbSBwYWNrYWdlLWNhY2hlIGBlcnJvcjogRmFpbGVkIGNhY2hpbmcgbnBtIHBhY2thZ2UgJzxzcGVjPidgXG4gKiAocmVwb3J0ZWQgYXMgYG5wbTo8c3BlYz5gKSwgYW5kIHRoZSBucG0gbWV0YWRhdGEgYGVycm9yOiBGYWlsZWQgbG9hZGluZyA8dXJsPlxuICogZm9yIHBhY2thZ2UgXCI8bmFtZT5cImAuIEVhY2ggbGluZSBpcyByZWFkIHdpdGggQU5TSSBjb2xvdXIgc3RyaXBwZWQsIHNvIGFcbiAqIGNvbG91cmVkIGBlcnJvcmAgcHJlZml4IG1hdGNoZXMgYXMgYSBwbGFpbiBvbmUgKElzc3VlICM0ODQ4KS4gU0dSIHJlbW5hbnRzXG4gKiB3aG9zZSBlc2NhcGUgYnl0ZSB3YXMgYWxyZWFkeSBsb3N0LCBhIGJhcmUgYFswbWAsIGFyZSBpZ25vcmVkIHdoZXJldmVyIHRoZXlcbiAqIHNpdCBpbiB0aGUgbGluZSAoSXNzdWUgIzQ4NTMpLCBzbyBgZXJyb3JbMG06IEZhaWxlZCAuLi5gIHN0aWxsIG1hdGNoZXMuIEFuXG4gKiBpbXBvcnQgb3JcbiAqIHBhY2thZ2UgdGhhdCBmYWlsZWQgZm9yIGFueSBvdGhlciByZWFzb24gKGEgNDA0LCBhIGJhZCBjZXJ0aWZpY2F0ZSwgYVxuICogY2hlY2tzdW0gbWlzbWF0Y2gsIGEgbWlzc2luZyBtb2R1bGUsIGEgdHlwZSBlcnJvcikgaXMgYW4gb3JkaW5hcnkgZmFpbHVyZSBhbmRcbiAqIHJldHVybnMgdW5kZWZpbmVkLlxuICpcbiAqIEBwYXJhbSBvdXRwdXQgLSBUaGUgcmF3IHRhc2sgb3V0cHV0ICh1bnRyaW1tZWQsIHBvc3NpYmx5IEFOU0ktY29sb3VyZWQpXG4gKiBAcmV0dXJucyBUaGUgZ2FwLCBvciB1bmRlZmluZWQgd2hlbiBubyBjb25uZWN0aW9uLWNsYXNzIGNhdXNlIGZvbGxvd3MgYVxuICogICBmYWlsdXJlIGhlYWRlclxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0UmVtb3RlTW9kdWxlR2FwKFxuICBvdXRwdXQ6IHN0cmluZyxcbik6IFJlbW90ZU1vZHVsZUdhcCB8IHVuZGVmaW5lZCB7XG4gIGxldCBmYWlsZWRVcmw6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCByYXdMaW5lIG9mIG91dHB1dC5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IGxpbmUgPSBzdHJpcEFuc2kocmF3TGluZS5zbGljZSgwLCBNQVhfR0FQX0xJTkVfQ0hBUlMpKS5yZXBsYWNlKFxuICAgICAgT1JQSEFOX1NHUl9SRSxcbiAgICAgIFwiXCIsXG4gICAgKS50cmltKCk7XG4gICAgY29uc3QgaW1wb3J0ZWQgPSBSRU1PVEVfSU1QT1JUX0ZBSUxFRF9SRS5leGVjKGxpbmUpO1xuICAgIGlmIChpbXBvcnRlZCkge1xuICAgICAgZmFpbGVkVXJsID0gaW1wb3J0ZWRbMV07XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2FjaGVkID0gUkVNT1RFX05QTV9DQUNIRV9GQUlMRURfUkUuZXhlYyhsaW5lKTtcbiAgICBpZiAoY2FjaGVkKSB7XG4gICAgICBmYWlsZWRVcmwgPSBgbnBtOiR7Y2FjaGVkWzFdfWA7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgbG9hZGVkID0gUkVNT1RFX05QTV9NRVRBREFUQV9GQUlMRURfUkUuZXhlYyhsaW5lKTtcbiAgICBpZiAobG9hZGVkKSB7XG4gICAgICBmYWlsZWRVcmwgPSBsb2FkZWRbMV07XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZhaWxlZFVybCAhPT0gdW5kZWZpbmVkICYmIFJFTU9URV9GRVRDSF9DQVVTRV9SRS50ZXN0KGxpbmUpKSB7XG4gICAgICByZXR1cm4geyB1cmw6IGZhaWxlZFVybCwgY2F1c2U6IGxpbmUgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqIFdoZXRoZXIgRGVubyByZXBvcnRzIHRoYXQgYSBwcm9qZWN0J3MgbG9ja2ZpbGUgY2Fubm90IGJlIHdyaXR0ZW4uICovXG5leHBvcnQgZnVuY3Rpb24gZGVub0xvY2tmaWxlV3JpdGVSZWZ1c2VkKGRpcjogc3RyaW5nLCBvdXRwdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gb3V0cHV0LmluY2x1ZGVzKFwiRmFpbGVkIHdyaXRpbmcgbG9ja2ZpbGVcIikgJiZcbiAgICBvdXRwdXQuaW5jbHVkZXMoXCJQZXJtaXNzaW9uIGRlbmllZCAob3MgZXJyb3IgMTMpXCIpICYmXG4gICAgb3V0cHV0LmluY2x1ZGVzKGAoZm9yICcke2Rpci5yZXBsYWNlKC9cXC8kLywgXCJcIil9L2Rlbm8ubG9jaycpYCk7XG59XG5cbi8qKlxuICogV2hldGhlciBhIERlbm8gY2hlY2sgY2FuIGF0dGVtcHQgdG8gcnVuIHdpdGhvdXQgYSB3cml0YWJsZSBkaXJlY3RvcnlcbiAqIChJc3N1ZSAjNDc4MikuIEEgc3RhbGUgbG9ja2ZpbGUgY2FuIHN0aWxsIHJlcXVpcmUgYSB3cml0ZS5cbiAqXG4gKiBEZW5vIHdyaXRlcyBgZGVuby5sb2NrYCB3aGVuIGl0IGhhcyB0byBjcmVhdGUgb3IgdXBkYXRlIG9uZSwgYW5kIHdyaXRlc1xuICogYG5vZGVfbW9kdWxlc2AgZm9yIGBub2RlTW9kdWxlc0RpcjogXCJhdXRvXCJgIG9yIGJlc2lkZSBhIGBwYWNrYWdlLmpzb25gLFxuICogYW5kIHdyaXRlcyBgdmVuZG9yYCB3aGVuIHZlbmRvcmluZyBpcyBlbmFibGVkLlxuICogQSBwcmVzZW50IGxvY2tmaWxlIGFuZCBub25lIG9mIHRoZSBvdGhlciBjb25kaXRpb25zIGFsbG93IGFuIGF0dGVtcHQuXG4gKiBBIHN0cmluZy1mb3JtIGNoZWNrIHRhc2ssIG9yIGFuIG9iamVjdC1mb3JtIGNoZWNrIHdpdGggYSBub24tZW1wdHkgY29tbWFuZCxcbiAqIG11c3QgYWxzbyBiZSBhIHNpbXBsZSBgZGVubyBjaGVja2Agd2l0aCBrbm93biBzYWZlIGZsYWdzIGFuZCBubyBkZXBlbmRlbmNpZXMuXG4gKiBEZXBlbmRlbmNpZXMgbWF5IHdyaXRlIGZpbGVzLiBBbnl0aGluZyBlbHNlLCBvciBhIG1hbmlmZXN0IHRoYXQgY2Fubm90IGJlXG4gKiByZWFkLCBrZWVwcyB0aGUgd3JpdGUgcmVxdWlyZW1lbnQuXG4gKlxuICogQHBhcmFtIGRpciAtIFRoZSBEZW5vIHByb2plY3QgZGlyZWN0b3J5XG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBzZWxlY3RlZCBmb3IgdGhlIHByb2plY3QgY2hlY2tcbiAqIEByZXR1cm5zIFRydWUgd2hlbiB0aGUgY2hlY2sgY2FuIGF0dGVtcHQgYSByZWFkLW9ubHkgY2hlY2tvdXRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlbm9DaGVja0xlYXZlc0RpclVudG91Y2hlZChcbiAgZGlyOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdID0gW1wiY2hlY2tcIl0sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKCEoYXdhaXQgaXNGaWxlKGAke2Rpcn0vZGVuby5sb2NrYCkpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChhd2FpdCBpc0ZpbGUoYCR7ZGlyfS9wYWNrYWdlLmpzb25gKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB0YXNrQ2hlY2sgPSBhcmdzLmxlbmd0aCA9PT0gMiAmJiBhcmdzWzBdID09PSBcInRhc2tcIiAmJlxuICAgIGFyZ3NbMV0gPT09IFwiY2hlY2tcIjtcbiAgaWYgKCF0YXNrQ2hlY2sgJiYgYXJnc1swXSAhPT0gXCJjaGVja1wiKSByZXR1cm4gZmFsc2U7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJkZW5vLmpzb25cIiwgXCJkZW5vLmpzb25jXCJdKSB7XG4gICAgaWYgKCEoYXdhaXQgaXNGaWxlKGAke2Rpcn0vJHtuYW1lfWApKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEpTT04ucGFyc2UoXG4gICAgICAgIHN0cmlwSnNvbmMoYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoYCR7ZGlyfS8ke25hbWV9YCkpLFxuICAgICAgKTtcbiAgICAgIGlmICh0YXNrQ2hlY2spIHtcbiAgICAgICAgY29uc3QgdGFzayA9IGNvbmZpZz8udGFza3M/LmNoZWNrO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gbWFuaWZlc3RUYXNrQ29tbWFuZCh0YXNrKSA/PyBcIlwiO1xuICAgICAgICBpZiAoL1tcXHJcXG5dLy50ZXN0KGNvbW1hbmQpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIC8vIEFjY2VwdCBvbmx5IGEgc2ltcGxlIGludm9jYXRpb24gd2l0aCBrbm93biBub24td3JpdGluZyBmbGFncy4gU2hlbGxcbiAgICAgICAgLy8gZXhwYW5zaW9ucywgb3BlcmF0b3JzIGFuZCB1bmtub3duIG9wdGlvbnMgcmV0YWluIHRoZSB3cml0ZSBwcm9iZS5cbiAgICAgICAgY29uc3Qgd29yZHMgPSBjb21tYW5kLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICAgICAgICBpZiAod29yZHNbMF0gIT09IFwiZGVub1wiIHx8IHdvcmRzWzFdICE9PSBcImNoZWNrXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgLy8gQSBkZXBlbmRlbmN5IG1heSB3cml0ZSBwcm9qZWN0IGZpbGVzIGV2ZW4gd2hlbiB0aGlzIHRhc2sncyBjb21tYW5kXG4gICAgICAgIC8vIGlzIHJlYWQtb25seSwgc28ga2VlcCB0aGUgY2hlY2tvdXQgd3JpdGUgcHJvYmUgZm9yIHRoZSB3aG9sZSB0YXNrLlxuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIHRhc2sgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgICBcImRlcGVuZGVuY2llc1wiIGluIHRhc2tcbiAgICAgICAgKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhd29yZHMuc2xpY2UoMikuZXZlcnkoKHdvcmQ6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgaWYgKC9eWydcIl0tLy50ZXN0KHdvcmQpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBpZiAod29yZC5zdGFydHNXaXRoKFwiLVwiKSkge1xuICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgIFwiLS1mcm96ZW5cIixcbiAgICAgICAgICAgICAgICBcIi0tbG9jaz1kZW5vLmxvY2tcIixcbiAgICAgICAgICAgICAgICBcIi0tbm8tbG9ja1wiLFxuICAgICAgICAgICAgICAgIFwiLS1hbGxcIixcbiAgICAgICAgICAgICAgICBcIi0tcXVpZXRcIixcbiAgICAgICAgICAgICAgXS5pbmNsdWRlcyh3b3JkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiAvXig/OltcXHcuLyo/QDotXSt8J1tcXHcuLyo/QDotXSsnfFwiW1xcdy4vKj9AOi1dK1wiKSQvLnRlc3QoXG4gICAgICAgICAgICAgIHdvcmQsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICkgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgaWYgKGNvbmZpZz8udmVuZG9yKSByZXR1cm4gZmFsc2U7XG4gICAgICBjb25zdCBtb2RlID0gY29uZmlnPy5ub2RlTW9kdWxlc0RpcjtcbiAgICAgIGlmIChcbiAgICAgICAgbW9kZSAhPT0gdW5kZWZpbmVkICYmIG1vZGUgIT09IFwibm9uZVwiICYmIG1vZGUgIT09IFwibWFudWFsXCIgJiZcbiAgICAgICAgbW9kZSAhPT0gZmFsc2VcbiAgICAgICkgcmV0dXJuIGZhbHNlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gIXRhc2tDaGVjaztcbn1cblxuLyoqXG4gKiBTcGF3biB0aGUgcmVwb3NpdG9yeSdzIG93biBjaGVjayB3aXRoIGEgYm91bmRlZCB0aW1lb3V0LCB0aGUgbGltaXQgZm9yIGl0c1xuICogdG9vbGNoYWluIChJc3N1ZSAjNDc4NykuXG4gKi9cbmV4cG9ydCBjb25zdCBzcGF3blR5cGVDaGVjayA9IGFzeW5jIChcbiAgcHJvamVjdDogVHlwZUNoZWNrUHJvamVjdCxcbiAgLyoqIFRoZSBjb21tYW5kIHJ1bm5lci4gUHJvZHVjdGlvbiB1c2VzIHRoZSByZWFsIG9uZTsgdGVzdHMgaW5qZWN0IGEgZmFrZS4gKi9cbiAgcnVuOiB0eXBlb2YgcnVuUmVwb3NpdG9yeUNvbW1hbmQgPSBydW5SZXBvc2l0b3J5Q29tbWFuZCxcbik6IFJldHVyblR5cGU8VHlwZUNoZWNrUnVubmVyPiA9PiB7XG4gIGNvbnN0IGV4ZWN1dGFibGUgPSBwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIiA/IFwiY2FyZ29cIiA6IERlbm8uZXhlY1BhdGgoKTtcbiAgY29uc3QgbGltaXRNcyA9IHR5cGVDaGVja1RpbWVvdXRNcyhwcm9qZWN0LmtpbmQpO1xuICBjb25zdCByZWFkT25seUNoZWNrb3V0ID0gcHJvamVjdC5raW5kID09PSBcImRlbm9cIiAmJlxuICAgIGF3YWl0IGRlbm9DaGVja0xlYXZlc0RpclVudG91Y2hlZChwcm9qZWN0LmRpciwgcHJvamVjdC5hcmdzKTtcbiAgLy8gVGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2sgcnVucyB3aXRoIGEgc3RhdGVkIGVudmlyb25tZW50IGFuZCBubyBwYXJlbnRcbiAgLy8gY3JlZGVudGlhbCAoSXNzdWUgIzQ2NTkpLiBCdWlsZC1jYWNoZSBwbGFjZW1lbnQgZm9yIHRoZSBjaGVja291dCAoSXNzdWVcbiAgLy8gIzIyNDcpIGlzIGRlY2lkZWQgaW5zaWRlIHJ1blJlcG9zaXRvcnlDb21tYW5kLCBub3QgaGVyZS4gQSBEZW5vIGNoZWNrXG4gIC8vIHdyaXRlcyBpdHMgY2FjaGUgdG8gREVOT19ESVIsIHNvIGl0IGRvZXMgbm90IG5lZWQgdGhlIHByb2plY3QgZGlyZWN0b3J5XG4gIC8vIHdyaXRhYmxlIGJ5IHRoZSBhY2NvdW50LCB1bmxlc3MgaXQgbXVzdCB3cml0ZSBkZW5vLmxvY2ssIG5vZGVfbW9kdWxlcyBvciB2ZW5kb3JcbiAgLy8gdGhlcmUgKElzc3VlICM0NzgyKS4gQSBjYXJnbyBjaGVjayB3cml0ZXMgQ2FyZ28ubG9jaywgc28gaXQga2VlcHMgdGhlXG4gIC8vIHJlcXVpcmVtZW50LlxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW4oZXhlY3V0YWJsZSwgcHJvamVjdC5hcmdzLCB7XG4gICAgY3dkOiBwcm9qZWN0LmRpcixcbiAgICB0aW1lb3V0TXM6IGxpbWl0TXMsXG4gICAgbWFuaWZlc3RzOiBhd2FpdCBtYW5pZmVzdHNGb3IocHJvamVjdC5raW5kLCBwcm9qZWN0LmRpciksXG4gICAgcmVhZE9ubHlDaGVja291dCxcbiAgfSk7XG4gIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgLy8gQSBzcGF3biB0aGF0IGZhaWxlZCBmb3IgYW55IHJlYXNvbiBidXQgdGhlIGhvc3QncyBhY2NvdW50IGlzIGEgY2hlY2tcbiAgICAvLyB0aGF0IGNvdWxkIG5vdCBydW4gKElzc3VlICM0ODQ3KSwgbm90IGEgdmVyZGljdCBvbiB0aGUgbWVyZ2VkIHRyZWUuXG4gICAgcmV0dXJuIHtcbiAgICAgIGNvZGU6IDEsXG4gICAgICBvdXRwdXQ6IHJlc3VsdC5lcnJvci5tZXNzYWdlLFxuICAgICAgLi4uKHJlc3VsdC5lcnJvciBpbnN0YW5jZW9mIEdhdGVBY2NvdW50VW5hdmFpbGFibGVcbiAgICAgICAgPyB7IGFjY291bnRVbmF2YWlsYWJsZTogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfVxuICAgICAgICA6IHsgdW5ydW5uYWJsZTogdHJ1ZSB9KSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIsIHRpbWVkT3V0IH0gPSByZXN1bHQudmFsdWU7XG4gIGNvbnN0IG91dHB1dCA9IFtzdGRvdXQsIHN0ZGVycl0ubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIGlmICh0aW1lZE91dCkge1xuICAgIHJldHVybiB7XG4gICAgICBjb2RlOiAxMjQsXG4gICAgICBvdXRwdXQ6IGAke291dHB1dH1cXG5UeXBlIGNoZWNrIHRpbWVkIG91dCBhZnRlciAke2xpbWl0TXN9bXNgLnRyaW0oKSxcbiAgICAgIHRpbWVkT3V0OiB0cnVlLFxuICAgIH07XG4gIH1cbiAgLy8gQSBwcmVzZW50IGJ1dCBzdGFsZSBsb2NrZmlsZSBtYXkgc3RpbGwgbmVlZCByZXdyaXRpbmcuIE9ubHkgdGhpcyBzcGVjaWZpY1xuICAvLyBwZXJtaXNzaW9uIHJlZnVzYWwgaXMgYSBob3N0IGxpbWl0YXRpb247IG90aGVyIGNoZWNrIGZhaWx1cmVzIHJlbWFpbiBmYWlsdXJlcy5cbiAgaWYgKFxuICAgIGNvZGUgIT09IDAgJiYgcmVhZE9ubHlDaGVja291dCAmJlxuICAgIGRlbm9Mb2NrZmlsZVdyaXRlUmVmdXNlZChwcm9qZWN0LmRpciwgb3V0cHV0KVxuICApIHtcbiAgICByZXR1cm4geyBjb2RlLCBvdXRwdXQsIGFjY291bnRVbmF2YWlsYWJsZTogb3V0cHV0IH07XG4gIH1cbiAgcmV0dXJuIHsgY29kZSwgb3V0cHV0IH07XG59O1xuXG4vKipcbiAqIFJ1biB0aGUgcmVwb3NpdG9yeSdzIG93biB0eXBlIGNoZWNrIGFnYWluc3QgYSBtZXJnZWQgd29ya2luZyB0cmVlLlxuICpcbiAqIEBwYXJhbSByZXBvRGlyIC0gUm9vdCBvZiB0aGUgbWVyZ2VkIHdvcmtpbmcgdHJlZSAodGhlIGNsb25lJ3MgY3dkKVxuICogQHBhcmFtIHJ1bm5lciAtIE92ZXJyaWRlIHRoZSBzcGF3bmVkIGNoZWNrICh0ZXN0cylcbiAqIEByZXR1cm5zIFRoZSB2ZXJkaWN0LCB3aXRoIHRoZSBjaGVjayBvdXRwdXQgd2hlbiBvbmUgcmFuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja01lcmdlZFRyZWUoXG4gIHJlcG9EaXI6IHN0cmluZyxcbiAgcnVubmVyOiBUeXBlQ2hlY2tSdW5uZXIgPSBzcGF3blR5cGVDaGVjayxcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIGVwaGVtZXJhbCBjYXJnbyBidWlsZCBtdXN0IG5vdCBydW4gKElzc3VlICM0MzI2KS5cbiAgICogRGVmYXVsdHMgdG8gdGhlIGhvc3QtZGlzayBidWRnZXQuIEEgbWVyZ2Ugc3RpbGwgbGFuZHM7IENJIGJ1aWxkcyBpdC5cbiAgICovXG4gIHNraXBDYXJnb0J1aWxkOiAoKSA9PiBQcm9taXNlPGJvb2xlYW4+ID0gKCkgPT5cbiAgICBzaG91bGRTa2lwRXBoZW1lcmFsQ2FyZ29CdWlsZChyZXBvRGlyKSxcbik6IFByb21pc2U8TWVyZ2VHYXRlT3V0Y29tZT4ge1xuICAvLyBBIHRyZWUgdGhhdCBjYW5ub3QgYmUgcmVhZCBpcyBhIGNoZWNrIHRoYXQgY291bGQgbm90IGJlIHJ1biwgbm90IGFcbiAgLy8gcmVwb3NpdG9yeSB3aXRob3V0IG9uZSDigJQgcmVmdXNlIHJhdGhlciB0aGFuIHdhdmUgaXQgdGhyb3VnaCBhcyBcInNraXBwZWRcIi5cbiAgdHJ5IHtcbiAgICBpZiAoIShhd2FpdCBEZW5vLnN0YXQocmVwb0RpcikpLmlzRGlyZWN0b3J5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIGRldGFpbDpcbiAgICAgICAgICBgbWVyZ2VkIHRyZWUgJyR7cmVwb0Rpcn0nIGlzIG5vdCBhIGRpcmVjdG9yeSDigJQgbm90aGluZyBjaGVja2VkIGl0YCxcbiAgICAgICAgb3V0cHV0OiBcIlwiLFxuICAgICAgICBjYXVzZTogXCJ0cmVlLXVucmVhZGFibGVcIixcbiAgICAgIH07XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgZGV0YWlsOiBgbWVyZ2VkIHRyZWUgJyR7cmVwb0Rpcn0nIGNvdWxkIG5vdCBiZSByZWFkIOKAlCBub3RoaW5nIGNoZWNrZWQgaXRgLFxuICAgICAgb3V0cHV0OiB0YWlsKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSksXG4gICAgICBjYXVzZTogXCJ0cmVlLXVucmVhZGFibGVcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcHJvamVjdHMgPSBhd2FpdCBmaW5kVHlwZUNoZWNrUHJvamVjdHMocmVwb0Rpcik7XG4gIGlmIChwcm9qZWN0cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcInNraXBwZWRcIixcbiAgICAgIGRldGFpbDogYG5vIGRlbm8uanNvbihjKSBvciBDYXJnby50b21sIHVuZGVyICcke3JlcG9EaXJ9JyDigJQgdGhlIG1lcmdlZCBgICtcbiAgICAgICAgXCJ0cmVlIHdhcyBub3QgdHlwZS1jaGVja2VkXCIsXG4gICAgICBvdXRwdXQ6IFwiXCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNoZWNrZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGxlZnRUb0NpOiBzdHJpbmdbXSA9IFtdO1xuICAvLyBDYXJnbyBjaGVja3MgdGhhdCBoaXQgdGhlaXIgdGltZSBsaW1pdCAoSXNzdWUgIzQ3ODYpLlxuICBjb25zdCBjYXJnb1RpbWVkT3V0OiBzdHJpbmdbXSA9IFtdO1xuICAvLyBDYXJnbyBjaGVja3MgdGhhdCBjb3VsZCBub3QgcmVhY2ggdGhlaXIgY3JhdGUgcmVnaXN0cnksIGV2ZW4gb2ZmbGluZVxuICAvLyAoSXNzdWUgIzQ3ODYpLlxuICBjb25zdCBjYXJnb1JlZ2lzdHJ5R2Fwczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2tpcENhcmdvID0gYXdhaXQgc2tpcENhcmdvQnVpbGQoKTtcbiAgbGV0IHNraXBwZWRDYXJnbyA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHByb2plY3Qgb2YgcHJvamVjdHMpIHtcbiAgICBpZiAocHJvamVjdC5raW5kID09PSBcImNhcmdvXCIgJiYgc2tpcENhcmdvKSB7XG4gICAgICAvLyBUaGUgaG9zdCBpcyBhYm92ZSBpdHMgZmxvb3IgYW5kIHNob3J0IG9mIGNhcmdvIGhlYWRyb29tLCBhbmRcbiAgICAgIC8vIHBydW5pbmcgZnJlZWQgbm90aGluZy4gUnVubmluZyBjYXJnbyBoZXJlIGlzIHdoYXQgd291bGQgdGFrZSBmcmVlXG4gICAgICAvLyBzcGFjZSB0aHJvdWdoIHRoZSBmbG9vciwgc28gdGhlIG1lcmdlIGxhbmRzIGFuZCBDSSBidWlsZHMgaXQuXG4gICAgICBza2lwcGVkQ2FyZ28gPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHdoZXJlID0gYCR7ZGVzY3JpYmVQcm9qZWN0KHByb2plY3QpfSBpbiAke3Byb2plY3QuZGlyfWA7XG4gICAgbGV0IHJlc3VsdDoge1xuICAgICAgY29kZTogbnVtYmVyO1xuICAgICAgb3V0cHV0OiBzdHJpbmc7XG4gICAgICBhY2NvdW50VW5hdmFpbGFibGU/OiBzdHJpbmc7XG4gICAgICB0aW1lZE91dD86IGJvb2xlYW47XG4gICAgICB1bnJ1bm5hYmxlPzogdHJ1ZTtcbiAgICB9O1xuICAgIC8vIFRoZSBjYXVzZSB0aGUgZmlyc3QgYXR0ZW1wdCBuYW1lZCB3aGVuIGl0IGNvdWxkIG5vdCByZWFjaCB0aGUgcmVnaXN0cnlcbiAgICAvLyAoSXNzdWUgIzQ3ODYpOyBzZXQgb25seSB3aGVuIHRoZSBjaGVjayB3YXMgcmV0cmllZCBvZmZsaW5lLlxuICAgIGxldCByZWdpc3RyeUNhdXNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdCA9IGF3YWl0IHJ1bm5lcihwcm9qZWN0KTtcbiAgICAgIC8vIEEgY2FyZ28gY2hlY2sgdGhhdCByYW4gb3V0IG9mIHRpbWUgaGFzIHN0aWxsIGNvbXBpbGVkIHBhcnQgb2YgdGhlXG4gICAgICAvLyB3b3Jrc3BhY2UgaW50byB0aGUgdGFyZ2V0LCBzbyBvbmUgbW9yZSBydW4gcmVzdW1lcyBmcm9tIHRoYXQgYW5kIGNhblxuICAgICAgLy8gZmluaXNoIGFuZCB2ZXJpZnkgYSB0cmVlIHdob3NlIG9ubHkgY2hlY2sgaXMgY2FyZ28gKElzc3VlICM0Nzg2KS4gQVxuICAgICAgLy8gc2Vjb25kIHRpbWVvdXQgaXMgbGVmdCB0byBDSSBiZWxvdy5cbiAgICAgIGlmIChwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIiAmJiByZXN1bHQuY29kZSAhPT0gMCAmJiByZXN1bHQudGltZWRPdXQpIHtcbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgcnVubmVyKHByb2plY3QpO1xuICAgICAgfVxuICAgICAgLy8gQSBjYXJnbyBjaGVjayB0aGF0IGNvdWxkIG5vdCByZWFjaCBpdHMgY3JhdGUgcmVnaXN0cnkgaXMgYSBob3N0IGZhdWx0LFxuICAgICAgLy8gc28gaXQgaXMgcmV0cmllZCBvbmNlIG9mZmxpbmU6IHRoZSBsb2NhbCBjYXJnbyBjYWNoZSBtYXkgaG9sZCBldmVyeVxuICAgICAgLy8gbG9ja2VkIGNyYXRlIChJc3N1ZSAjNDc4NikuIEEgRGVubyBwcm9qZWN0IGlzIG5ldmVyIHJldHJpZWQgdGhpcyB3YXkuXG4gICAgICBjb25zdCBmaXJzdEdhcCA9IHByb2plY3Qua2luZCA9PT0gXCJjYXJnb1wiICYmIHJlc3VsdC5jb2RlICE9PSAwICYmXG4gICAgICAgICAgIXJlc3VsdC50aW1lZE91dCAmJiAhcmVzdWx0LmFjY291bnRVbmF2YWlsYWJsZVxuICAgICAgICA/IGRldGVjdENhcmdvUmVnaXN0cnlHYXAocmVzdWx0Lm91dHB1dClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoZmlyc3RHYXApIHtcbiAgICAgICAgcmVnaXN0cnlDYXVzZSA9IGZpcnN0R2FwLmNhdXNlO1xuICAgICAgICByZXN1bHQgPSBhd2FpdCBydW5uZXIoe1xuICAgICAgICAgIC4uLnByb2plY3QsXG4gICAgICAgICAgYXJnczogd2l0aENhcmdvT2ZmbGluZShwcm9qZWN0LmFyZ3MpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIFVucnVubmFibGUgaXMgbm90IGNsZWFuOiByZWZ1c2UgdGhlIHB1c2ggcmF0aGVyIHRoYW4gYXNzdW1lIGl0XG4gICAgICAvLyBjb21waWxlcy5cbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIGRldGFpbDogYCR7d2hlcmV9IGNvdWxkIG5vdCBiZSBydW5gLFxuICAgICAgICBvdXRwdXQ6IHRhaWwobWVzc2FnZSksXG4gICAgICAgIGNhdXNlOiBcImNoZWNrLWNvdWxkLW5vdC1ydW5cIixcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChyZXN1bHQuYWNjb3VudFVuYXZhaWxhYmxlKSB7XG4gICAgICBsZWZ0VG9DaS5wdXNoKGAke3doZXJlfTogJHtyZXN1bHQuYWNjb3VudFVuYXZhaWxhYmxlfWApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEEgY2hlY2sgdGhlIHJ1bm5lciBjb3VsZCBub3Qgc3RhcnQgaXMgbm90IGEgdmVyZGljdCBvbiB0aGUgdHJlZSwgc28gaXRcbiAgICAvLyBpcyBub3QgcmVwb3J0ZWQgYXMgYSBmYWlsaW5nIGNoZWNrIChJc3N1ZSAjNDg0NykuXG4gICAgaWYgKHJlc3VsdC51bnJ1bm5hYmxlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIGRldGFpbDogYCR7d2hlcmV9IGNvdWxkIG5vdCBiZSBydW5gLFxuICAgICAgICBvdXRwdXQ6IHRhaWwocmVzdWx0Lm91dHB1dCksXG4gICAgICAgIGNhdXNlOiBcImNoZWNrLWNvdWxkLW5vdC1ydW5cIixcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIFRoZSBvZmZsaW5lIHJldHJ5IGNvdWxkIG5vdCByZWFjaCB0aGUgcmVnaXN0cnkgZWl0aGVyOiB0aGUgY2FyZ28gaGFsZlxuICAgIC8vIGNhbm5vdCBiZSB2ZXJpZmllZCBoZXJlLCBzbyBpdCBpcyBsZWZ0IHRvIENJIGFzIGEgdGltZWQtb3V0IGNoZWNrIGlzXG4gICAgLy8gKElzc3VlICM0Nzg2KS4gVGhlIG5vdGUga2VlcHMgdGhlIGZpcnN0IGF0dGVtcHQncyBjYXVzZS5cbiAgICBpZiAoXG4gICAgICByZWdpc3RyeUNhdXNlICE9PSB1bmRlZmluZWQgJiYgcmVzdWx0LmNvZGUgIT09IDAgJiZcbiAgICAgIGlzQ2FyZ29PZmZsaW5lUmVnaXN0cnlHYXAocmVzdWx0Lm91dHB1dClcbiAgICApIHtcbiAgICAgIHNraXBwZWRDYXJnbyA9IHRydWU7XG4gICAgICBjYXJnb1JlZ2lzdHJ5R2Fwcy5wdXNoKFxuICAgICAgICBgJHt3aGVyZX0gY291bGQgbm90IHJlYWNoIGl0cyBjcmF0ZSByZWdpc3RyeSAoJHtyZWdpc3RyeUNhdXNlfSlgLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAocmVzdWx0LmNvZGUgIT09IDApIHtcbiAgICAgIC8vIEEgY2FyZ28gY2hlY2sgdGhhdCBoaXQgaXRzIHRpbWUgbGltaXQgc2F5cyBub3RoaW5nIGFib3V0IHRoZSBtZXJnZWRcbiAgICAgIC8vIHRyZWU6IG9uIGEgY29sZCBlcGhlbWVyYWwgdGFyZ2V0IGl0IGlzIHRoZSBidWlsZCB0aGF0IHJhbiBvdXQgb2ZcbiAgICAgIC8vIHRpbWUsIG5vdCBhIGJhZCByZXNvbHV0aW9uLiBJdCBpcyBsZWZ0IHRvIENJLCBhcyBhIHNraXBwZWQgY2FyZ29cbiAgICAgIC8vIGJ1aWxkIGlzIChJc3N1ZSAjNDc4NikuIEEgRGVubyB0aW1lb3V0IHN0aWxsIGZhaWxzIHRoZSBnYXRlLCB3aXRoXG4gICAgICAvLyBjYXVzZSBgY2hlY2stdGltZWQtb3V0YCwgc28gdGhlIHN5bmMgZG9lcyBub3QgY2hhcmdlIGl0IGFzIGEgYmFkIHRyZWVcbiAgICAgIC8vIChJc3N1ZSAjNDg0NykuXG4gICAgICBpZiAocHJvamVjdC5raW5kID09PSBcImNhcmdvXCIgJiYgcmVzdWx0LnRpbWVkT3V0KSB7XG4gICAgICAgIHNraXBwZWRDYXJnbyA9IHRydWU7XG4gICAgICAgIGNhcmdvVGltZWRPdXQucHVzaCh3aGVyZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gQSBEZW5vIGNoZWNrIHRoYXQgY291bGQgbm90IHJlYWNoIGl0cyBtb2R1bGUgaG9zdCBzYXlzIG5vdGhpbmcgYWJvdXRcbiAgICAgIC8vIHRoZSBtZXJnZWQgdHJlZTogaXQgaXMgbGVmdCB0byBDSSwgYXMgdGhlIHJlc29sdXRpb24gZ2F0ZSBsZWF2ZXMgaXRcbiAgICAgIC8vIChJc3N1ZSAjNDQyMikuIFJlZnVzaW5nIGhlcmUgY2hhcmdlZCBhIGNvbmZsaWN0IGF0dGVtcHQgZm9yIGEgbmV0d29ya1xuICAgICAgLy8gZmF1bHQgYW5kIHdhbGtlZCBldmVyeSBtaWxlc3RvbmUgdG8gdGhlIG1lcmdlLWZhbGxiYWNrIHJ1bmcuXG4gICAgICBjb25zdCByZW1vdGUgPSBwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIlxuICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICA6IGRldGVjdFJlbW90ZU1vZHVsZUdhcChyZXN1bHQub3V0cHV0KTtcbiAgICAgIGlmIChyZW1vdGUpIHtcbiAgICAgICAgbGVmdFRvQ2kucHVzaChcbiAgICAgICAgICBgJHt3aGVyZX0gY291bGQgbm90IGZldGNoIGl0cyByZW1vdGUgbW9kdWxlcyAoJHtyZW1vdGUuY2F1c2V9KWAsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgZ2FwID0gcHJvamVjdC5raW5kID09PSBcImNhcmdvXCJcbiAgICAgICAgPyBkZXRlY3RSdXN0VG9vbGNoYWluR2FwKHJlc3VsdC5vdXRwdXQpXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKGdhcCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICBkZXRhaWw6IGRlc2NyaWJlUnVzdFRvb2xjaGFpbkdhcCh3aGVyZSwgcmVzdWx0LmNvZGUsIGdhcCksXG4gICAgICAgICAgb3V0cHV0OiB0YWlsKHJlc3VsdC5vdXRwdXQpLFxuICAgICAgICAgIHRvb2xjaGFpbkdhcDogZ2FwLFxuICAgICAgICAgIGNhdXNlOiBcInJ1c3QtdG9vbGNoYWluLXRvby1vbGRcIixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIC8vIEEgRGVubyBjaGVjayB0aGF0IGhpdCBpdHMgdGltZSBsaW1pdCBkaWQgbm90IHJlYWNoIGEgdmVyZGljdCBvbiB0aGVcbiAgICAgIC8vIHRyZWUsIHNvIGl0IGlzIG5vdCBjaGFyZ2VkIGFzIGEgZmFpbGluZyBjaGVjayAoSXNzdWUgIzQ4NDcpLlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgICBkZXRhaWw6IGAke3doZXJlfSBmYWlsZWQgKGV4aXQgJHtyZXN1bHQuY29kZX0pYCxcbiAgICAgICAgb3V0cHV0OiB0YWlsKHJlc3VsdC5vdXRwdXQpLFxuICAgICAgICBjYXVzZTogcmVzdWx0LnRpbWVkT3V0ID8gXCJjaGVjay10aW1lZC1vdXRcIiA6IFwidHJlZS1jaGVjay1mYWlsZWRcIixcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIEEgY2hlY2sgdGhhdCBwYXNzZWQgb25seSBvbiB0aGUgb2ZmbGluZSByZXRyeSBzYXlzIHNvIChJc3N1ZSAjNDc4NikuXG4gICAgY2hlY2tlZC5wdXNoKFxuICAgICAgcmVnaXN0cnlDYXVzZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gYCR7d2hlcmV9ICh2ZXJpZmllZCBvZmZsaW5lIGZyb20gdGhlIGxvY2FsIGNhcmdvIGNhY2hlLCBJc3N1ZSAjNDc4NilgXG4gICAgICAgIDogd2hlcmUsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IG5vdGVzID0gW1xuICAgIC4uLmNhcmdvVGltZWRPdXQubWFwKCh3aGVyZSkgPT5cbiAgICAgIGAke3doZXJlfSB0aW1lZCBvdXQgYWZ0ZXIgJHtDQVJHT19NRVJHRV9HQVRFX1RJTUVPVVRfTVN9bXMg4oCUIGxlZnQgdG8gQ0kgKElzc3VlICM0Nzg2KWBcbiAgICApLFxuICAgIC4uLmNhcmdvUmVnaXN0cnlHYXBzLm1hcCgobm90ZSkgPT4gYCR7bm90ZX0g4oCUIGxlZnQgdG8gQ0kgKElzc3VlICM0Nzg2KWApLFxuICAgIC4uLihza2lwcGVkQ2FyZ28gPyBbYCR7Q0FSR09fQlVJTERfU0tJUFBFRF9GT1JfTUVSR0V9IChJc3N1ZSAjNDMyNilgXSA6IFtdKSxcbiAgICAuLi5sZWZ0VG9DaS5tYXAoKG5vdGUpID0+IGAke25vdGV9IOKAlCBsZWZ0IHRvIENJIChJc3N1ZSAjNDQyMilgKSxcbiAgXTtcbiAgY29uc3QgY2hlY2tMZWZ0VG9DaSA9IGxlZnRUb0NpLmxlbmd0aCA+IDAgPyBsZWZ0VG9DaS5qb2luKFwiOyBcIikgOiB1bmRlZmluZWQ7XG4gIGlmIChjaGVja2VkLmxlbmd0aCA9PT0gMCAmJiBub3Rlcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogXCJza2lwcGVkXCIsXG4gICAgICBkZXRhaWw6IG5vdGVzLmpvaW4oXCI7IFwiKSxcbiAgICAgIG91dHB1dDogXCJcIixcbiAgICAgIC4uLihza2lwcGVkQ2FyZ28gPyB7IGNhcmdvU2tpcHBlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgLi4uKGNoZWNrTGVmdFRvQ2kgPyB7IGNoZWNrTGVmdFRvQ2kgfSA6IHt9KSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXM6IFwicGFzc2VkXCIsXG4gICAgZGV0YWlsOiBbYCR7Y2hlY2tlZC5qb2luKFwiOyBcIil9IHBhc3NlZGAsIC4uLm5vdGVzXS5qb2luKFwiOyBcIiksXG4gICAgb3V0cHV0OiBcIlwiLFxuICAgIC4uLihza2lwcGVkQ2FyZ28gPyB7IGNhcmdvU2tpcHBlZDogdHJ1ZSB9IDoge30pLFxuICAgIC4uLihjaGVja0xlZnRUb0NpID8geyBjaGVja0xlZnRUb0NpIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKlxuICogVGhlIHJlZnVzYWwgcmFpc2VkIHdoZW4gYSBtZXJnZWQgdHJlZSBkb2VzIG5vdCBjb21waWxlIChJc3N1ZSAjOTc0KS5cbiAqXG4gKiBUeXBlZCB3aXRoIHtAbGluayBNSUxFU1RPTkVfTUVSR0VfR0FURV9FUlJPUn0gc28gdGhlIHN5bmMgY2FuIHRlbGwgaXQgYXBhcnRcbiAqIGZyb20gYW4gb3JkaW5hcnkgbWVyZ2UgZmFpbHVyZSBhbmQgZXNjYWxhdGUgb24gdGhlIGZpcnN0IG9jY3VycmVuY2Ug4oCUIGFcbiAqIHRyZWUgdGhhdCBkb2VzIG5vdCBjb21waWxlIGlzIG5vdCBhIHRyYW5zaWVudCBjb25kaXRpb24gdGhhdCBhIHJldHJ5IGZpeGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VHYXRlRmFpbHVyZUVycm9yKFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICBvdXRjb21lOiBNZXJnZUdhdGVPdXRjb21lLFxuKTogTWVyZ2VHYXRlRmFpbHVyZUVycm9yIHtcbiAgY29uc3QgZXJyOiBNZXJnZUdhdGVGYWlsdXJlRXJyb3IgPSBuZXcgRXJyb3IoXG4gICAgYFJlZnVzZWQgdG8gcHVzaCB0aGUgbWVyZ2Ugb2YgJyR7ZGVmYXVsdEJyYW5jaH0nIGludG8gYCArXG4gICAgICBgJyR7bWlsZXN0b25lQnJhbmNofSc6IHRoZSBtZXJnZWQgdHJlZSBkb2VzIG5vdCBwYXNzIHRoZSByZXBvc2l0b3J5J3MgYCArXG4gICAgICBgb3duIGNoZWNrIChJc3N1ZSAjOTc0KSDigJQgJHtvdXRjb21lLmRldGFpbH0ke1xuICAgICAgICBvdXRjb21lLm91dHB1dCA/IGBcXG4ke291dGNvbWUub3V0cHV0fWAgOiBcIlwiXG4gICAgICB9YCxcbiAgKTtcbiAgZXJyLm5hbWUgPSBNSUxFU1RPTkVfTUVSR0VfR0FURV9FUlJPUjtcbiAgaWYgKG91dGNvbWUuY2F1c2UgIT09IHVuZGVmaW5lZCkgZXJyLmdhdGVDYXVzZSA9IG91dGNvbWUuY2F1c2U7XG4gIHJldHVybiBlcnI7XG59XG5cbi8qKlxuICogVGhlIG1lcmdlLWdhdGUgcmVmdXNhbCwgY2Fycnlpbmcgd2h5IHRoZSBnYXRlIGZhaWxlZCB0aGUgdHJlZSAoSXNzdWUgIzQ4NDcpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIE1lcmdlR2F0ZUZhaWx1cmVFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLyoqIFRoZSBjYXVzZSB0aGUgZ2F0ZSBuYW1lZC4gUmVhZCBpdCB0aHJvdWdoIHtAbGluayBtZXJnZUdhdGVGYWlsdXJlQ2F1c2V9LiAqL1xuICBnYXRlQ2F1c2U/OiBNZXJnZUdhdGVDYXVzZTtcbn1cblxuLyoqXG4gKiBUaGUgY2F1c2UgYSBtZXJnZS1nYXRlIHJlZnVzYWwgY2FycmllcyAoSXNzdWUgIzQ4NDcpLCBvciB1bmRlZmluZWQgd2hlbiB0aGVcbiAqIGVycm9yIGlzIG5vdCBhIHJlZnVzYWwgb3IgY2FycmllcyBubyBrbm93biBjYXVzZS4gQSBmb3JnZWQgb3IgdW5rbm93biB2YWx1ZVxuICogaXMgcmVqZWN0ZWQsIHNvIG5vdGhpbmcgaXQgaG9sZHMgcmVhY2hlcyBhIGxlZGdlciByZWFzb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUdhdGVGYWlsdXJlQ2F1c2UoXG4gIGVycjogdW5rbm93bixcbik6IE1lcmdlR2F0ZUNhdXNlIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFpc01lcmdlR2F0ZUZhaWx1cmUoZXJyKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgY2F1c2UgPSAoZXJyIGFzIE1lcmdlR2F0ZUZhaWx1cmVFcnJvcikuZ2F0ZUNhdXNlO1xuICByZXR1cm4gaXNNZXJnZUdhdGVDYXVzZShjYXVzZSkgPyBjYXVzZSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqIFdoZXRoZXIgYW4gZXJyb3IgaXMgdGhlIG1lcmdlLWdhdGUgcmVmdXNhbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc01lcmdlR2F0ZUZhaWx1cmUoZXJyOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIubmFtZSA9PT0gTUlMRVNUT05FX01FUkdFX0dBVEVfRVJST1I7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQ0MsR0FFRCxTQUNFLHNCQUFzQixFQUN0QixZQUFZLEVBQ1osb0JBQW9CLFFBQ2YsNEJBQTRCO0FBQ25DLFNBQVMsVUFBVSxRQUFRLGFBQWE7QUFDeEMsU0FBUyxTQUFTLFFBQVEsa0NBQWtDO0FBQzVELFNBQ0UsNkJBQTZCLEVBQzdCLDZCQUE2QixRQUN4Qix3QkFBd0I7QUFDL0IsU0FDRSxvQkFBb0IsRUFDcEIsTUFBTSxRQUVELHlCQUF5QjtBQUNoQyxTQUNFLG9CQUFvQixFQUNwQixvQkFBb0IsUUFHZix5QkFBeUI7QUFFaEM7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLHdCQUF3QixRQUFRO0FBRTdDOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLDhCQUE4QixRQUFRO0FBRW5EOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsSUFBaUI7RUFDbEQsT0FBTyxTQUFTLFVBQVUsOEJBQThCO0FBQzFEO0FBRUEsc0VBQXNFLEdBQ3RFLE9BQU8sTUFBTSw2QkFBNkIsNEJBQTRCO0FBRXRFLDJFQUEyRSxHQUMzRSxNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQjtBQWdCekIscUVBQXFFLEdBQ3JFLE9BQU8sU0FBUyxnQkFBZ0IsT0FBeUI7RUFDdkQsT0FBTyxHQUFHLFFBQVEsSUFBSSxDQUFDLENBQUMsRUFBRSxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTTtBQUNwRDtBQTRCQTs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLCtCQUNYLElBQUksSUFBb0I7RUFDdEI7RUFDQTtFQUNBO0VBQ0E7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
// denoCacheMetadata=9386395156744147356,13586429523455705431