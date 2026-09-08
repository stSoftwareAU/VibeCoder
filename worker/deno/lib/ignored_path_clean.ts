/**
 * Erase the ignored paths a previous run could have left executable content in
 * (Issue #1443).
 *
 * ## The gap this closes
 *
 * Every reused clone and worktree is re-asserted before work starts with
 * `git reset --hard` followed by `git clean -fd`. That pair restores tracked
 * files and removes untracked ones, so tampering with source under version
 * control is transient — the next run discards it.
 *
 * Ignored paths are the exception: `-fd` leaves everything `.gitignore`
 * matches, which is precisely where a repository keeps the content a later
 * run **executes** — `node_modules/.bin` shims a gate invokes, a `.venv`
 * whose interpreter and site-packages are imported, a `target/` or `dist/`
 * holding compiled output a benchmark runs. So a modification there outlives
 * the cleanup meant to erase it and is picked up by the next, entirely
 * legitimate run of that repository. That is persistence, not access: the
 * mount bounds (#1407, #1442) say who can reach what *now*; this says what
 * survives the reset.
 *
 * ## Why not plain `-fdx`
 *
 * `git clean -fdx` would discard **everything** ignored on every run,
 * including the pure download caches warm clones exist to keep — the cost
 * `work_volume_tiers.ts` already works to avoid on large data repositories.
 * So the clean is **pathspec-scoped** to the directory names that carry
 * executable content, and everything else ignored (download caches, coverage
 * output, logs, the worker's own dot-state) stays warm. What is discarded is
 * rebuilt from tracked sources plus caches that live *outside* the clone
 * (`DENO_DIR`, `~/.npm`, `~/.cargo`, the pip cache), so the cost is an
 * install from a warm cache, not a cold download.
 *
 * The residual — an ignored path that carries executable content under some
 * *other* name — is recorded in `docs/THREAT-MODEL.md` (R12) rather than
 * assumed away.
 *
 * ## Why `-ff`
 *
 * A single `-f` makes git **skip** an untracked directory that contains a
 * nested `.git` ("Skipping repository node_modules/dep"), which is exactly
 * where a git-installed dependency lives — and exactly the content that must
 * not survive. `-ff` removes it. The scope is the pathspec, so no path
 * outside the executable-bearing set can be reached by the extra force.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { type GitCommandOptions, runGitCommand } from "./git_timeout.ts";

/**
 * Ignored directory names that can carry executable content into a later run.
 *
 * Deliberately a short, named set rather than "everything ignored": each entry
 * is a place a tool *runs* something from, and each is rebuildable from
 * tracked sources plus an out-of-clone cache.
 */
export const EXECUTABLE_IGNORED_DIRS: readonly string[] = [
  "node_modules", // npm/pnpm/yarn installs — `.bin` shims a gate invokes
  ".venv", // Python virtualenv — `bin/python`, site-packages
  "venv", // the same, unhidden spelling
  ".tox", // tox's per-environment virtualenvs
  "__pycache__", // compiled bytecode imported in place of a source file
  "target", // Rust/Java build output — binaries a bench or gate runs
  "build", // generic build output
  "dist", // packaged output that is served or executed
  "out", // the same, alternative spelling
  "vendor", // vendored dependency source that is compiled and run
];

/**
 * The `git clean` invocation that erases {@link EXECUTABLE_IGNORED_DIRS} at
 * any depth, and nothing else.
 *
 * `:(glob)**\/<name>/**` is the pathspec form that actually matches: a bare
 * `<name>` matches only at the repository root (monorepo
 * `packages/*\/node_modules` would survive), and `:(glob)**\/<name>` matches
 * nothing at all — git needs the trailing `/**` to match the directory's
 * contents, and removes the directory with them.
 */
export function ignoredExecutableCleanArgs(): string[] {
  return [
    "clean",
    "-ffdx",
    "--",
    ...EXECUTABLE_IGNORED_DIRS.map((dir) => `:(glob)**/${dir}/**`),
  ];
}

/**
 * The full reset-clean sequence every reused clone or worktree runs: the
 * existing untracked clean, then the scoped ignored clean.
 *
 * Returned as argument vectors so a caller that drives git through its own
 * step runner (`checkout_update.ts`) can splice them into its sequence.
 */
export function workingTreeCleanSteps(): string[][] {
  return [["clean", "-fd"], ignoredExecutableCleanArgs()];
}

/**
 * Run {@link workingTreeCleanSteps} in `options.cwd`.
 *
 * The untracked clean keeps its existing best-effort semantics — callers have
 * always treated a failed clean as non-fatal, and a clone that cannot be
 * cleaned still fails loudly at the checkout that follows. The **ignored**
 * clean is a security control, so a failure of that step is reported on
 * stderr with the path and git's own message rather than being swallowed: a
 * run that could not erase last run's executable content must be visible in
 * the log.
 */
export async function cleanWorkingTree(
  options: GitCommandOptions = {},
): Promise<void> {
  await runGitCommand(["clean", "-fd"], options);

  const ignored = await runGitCommand(ignoredExecutableCleanArgs(), options);
  if (!ignored.ok) {
    console.error(
      `[clean] SECURITY (Issue #1443): could not erase ignored executable ` +
        `paths in ${options.cwd ?? Deno.cwd()} — ${ignored.error.message}. ` +
        `Content a previous run left there may still be present.`,
    );
    return;
  }
  if (ignored.value.code !== 0) {
    console.error(
      `[clean] SECURITY (Issue #1443): could not erase ignored executable ` +
        `paths in ${options.cwd ?? Deno.cwd()} — git exited ` +
        `${ignored.value.code}: ${ignored.value.stderr.trim()}. ` +
        `Content a previous run left there may still be present.`,
    );
  }
}
