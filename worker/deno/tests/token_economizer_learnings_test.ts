/**
 * Tests for token_economizer_learnings.ts (Issue #4957).
 *
 * Every transfer runs against a real local bare repository in a temp directory,
 * with real git. The planted-secret case runs the real gitleaks when it is
 * installed, and an injected gitleaks report otherwise. Visibility and the
 * latch are injected. Nothing is written outside the temp roots, which are removed.
 *
 * Covers: the two-run acceptance flow and an isolated key; the visibility
 * refusals (pull, the stale check at push, and an unverifiable check); a planted
 * fake PAT, with the real stop record; cross-repo isolation; pull and push
 * failures; the non-fast-forward replay (clean and conflicting); the size cap and
 * the allow-list; the latch; the scratch clone kept for a later push of the same
 * persistence and a removed clone inside a parent repository; and the repository
 * key goldens.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  githubVisibilityCheck,
  LEARNINGS_CONFIG_CAP_BYTES,
  LEARNINGS_KEY_CAP_BYTES,
  type LearningsLogger,
  type LearningsPersistence,
  learningsRepoKey,
  normaliseRemote,
  pullLearnings,
  type PullLearningsOptions,
  pushLearnings,
  type PushLearningsOptions,
  repoKeyForCheckout,
  type StagedScan,
  type VisibilityVerdict,
} from "../lib/token_economizer_learnings.ts";
import type { TokenEconomizerFinding } from "../lib/token_economizer_control.ts";
import {
  stopTokenEconomizerTrial,
  tokenEconomizerMaySync,
} from "../lib/token_economizer_control.ts";
import { readTokenEconomizerStop } from "../lib/token_economizer_plugin.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _resetWriteRepoPins,
  _setWriteRepoAllowlistSinks,
  installationTokenRepoScope,
  isWriteRepoAllowed,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";

const REPO = "stSoftwareAU/VibeCoder";
const SUBJECT = "stSoftwareAU/VibeCoder#4957";
const KEY_A = "vibecoder-9dcdf6cc4d";
const KEY_B = "my-repo-x-4949a686c3";
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@invalid.example",
];

/** A GitHub PAT shape, built at runtime so this file carries no literal secret. */
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_PAT = "ghp_" +
  Array.from({ length: 36 }, (_, i) => ALNUM.charAt((i * 7) % ALNUM.length))
    .join("");

const PRIVATE = () => Promise.resolve<VisibilityVerdict>({ private: true });
const ALWAYS = () => Promise.resolve(true);
const NEVER = () => Promise.resolve(false);

/** What gitleaks 8.30.1 prints for a clean staged scan (observed). */
const CLEAN_SCAN: StagedScan = {
  exitCode: 0,
  stdout: "[]",
  stderr: "INF no leaks found",
};
const cleanScan = () => Promise.resolve(CLEAN_SCAN);

/** The report gitleaks 8.30.1 prints for the planted PAT (observed), injected where the binary is absent. */
function leakScan(key: string): StagedScan {
  const report = [{
    RuleID: "github-pat",
    Description:
      "Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.",
    StartLine: 1,
    EndLine: 1,
    StartColumn: 24,
    EndColumn: 63,
    Match: "REDACTED",
    Secret: "REDACTED",
    File: `token-economizer/${key}/claude/injection.json`,
    SymlinkFile: "",
    Commit: "",
    Entropy: 5.321928,
    Author: "",
    Email: "",
    Date: "0001-01-01T00:00:00Z",
    Message: "",
    Tags: [],
    Fingerprint: `token-economizer/${key}/claude/injection.json:github-pat:1`,
  }];
  return { exitCode: 1, stdout: JSON.stringify(report, null, 1), stderr: "" };
}

/** Whether a command runs and exits 0. A missing binary is false, never an error. */
async function runs(cmd: string, args: string[]): Promise<boolean> {
  try {
    const run = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return run.success;
  } catch {
    return false;
  }
}

/** Whether the real gitleaks binary is installed. CI unit shards may not have it. */
const hasGitleaks = await runs("gitleaks", ["version"]);

/**
 * Whether git finds `object` in `dir` without lazily fetching it from the
 * promisor remote. `GIT_NO_LAZY_FETCH` makes a missing blob a plain miss.
 */
async function hasObjectLocally(dir: string, object: string): Promise<boolean> {
  const run = await new Deno.Command("git", {
    args: ["-C", dir, "cat-file", "-e", object],
    env: { GIT_NO_LAZY_FETCH: "1" },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return run.success;
}

/** A logger that keeps every line for assertions. */
function capture(): {
  warnings: string[];
  infos: string[];
  logger: LearningsLogger;
} {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    logger: {
      info: (message) => {
        infos.push(message);
      },
      warn: (message) => {
        warnings.push(message);
      },
    },
  };
}

/** A stop callback that records each finding. */
function recorder(): {
  stops: TokenEconomizerFinding[];
  stop: (finding: TokenEconomizerFinding) => Promise<unknown>;
} {
  const stops: TokenEconomizerFinding[] = [];
  return {
    stops,
    stop: (finding) => {
      stops.push(finding);
      return Promise.resolve();
    },
  };
}

/** Run one git command, throwing on failure. */
async function git(args: string[]): Promise<string> {
  const result = await runGitCommand(args);
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } exited ${result.value.code}: ${result.value.stderr}`,
    );
  }
  return result.value.stdout;
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Run a test body in a fresh temp root, removed afterwards. */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "learnings-test-" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A new empty bare repository whose default branch is `main`. */
async function newStore(
  root: string,
  name: string,
): Promise<{ dir: string; url: string }> {
  const dir = join(root, `${name}.git`);
  await git(["init", "--bare", "--quiet", "--initial-branch=main", dir]);
  return { dir, url: pathToFileURL(dir).href };
}

/** A file's content: text, or a symlink to `link`. */
type Content = string | { link: string };

/** Commit files onto the store's `main` (the store may be empty). */
async function commitToStore(
  root: string,
  storeUrl: string,
  files: Record<string, Content>,
): Promise<void> {
  const work = await Deno.makeTempDir({ dir: root, prefix: "work-" });
  await git(["clone", "--quiet", "--", storeUrl, work]);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(work, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    if (typeof content === "string") {
      await Deno.writeTextFile(path, content);
    } else {
      await Deno.symlink(content.link, path);
    }
  }
  await git(["-C", work, "add", "-A"]);
  await git(["-C", work, ...IDENTITY, "commit", "--quiet", "-m", "seed"]);
  await git(["-C", work, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
}

/** The files on the store's `main`, sorted. Empty when there is no `main`. */
async function storeFiles(storeDir: string): Promise<string[]> {
  const listed = await runGitCommand([
    "-C",
    storeDir,
    "ls-tree",
    "-r",
    "--name-only",
    "main",
  ]);
  if (!listed.ok || listed.value.code !== 0) return [];
  return listed.value.stdout.split("\n").filter((line) => line !== "").sort();
}

/** The number of commits on the store's `main`. Zero when there is none. */
async function commitCount(storeDir: string): Promise<number> {
  const counted = await runGitCommand([
    "-C",
    storeDir,
    "rev-list",
    "--count",
    "main",
  ]);
  if (!counted.ok || counted.value.code !== 0) return 0;
  return Number(counted.value.stdout.trim());
}

/** Write a file into a home, as the plugin would under `repos/<key>/`. */
async function plant(
  home: string,
  key: string,
  rel: string,
  content: string,
): Promise<void> {
  const path = join(home, "repos", key, rel);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

/** Pull options: the named run's home and scratch are siblings under `root`. */
function pullOpts(
  root: string,
  name: string,
  key: string,
  storeUrl: string,
  logger: LearningsLogger,
  extra: Partial<PullLearningsOptions> = {},
): PullLearningsOptions {
  return {
    learningsRepo: REPO,
    repoKey: key,
    home: join(root, `${name}-home`),
    scratchDir: join(root, `${name}-scratch`),
    storeUrl,
    checkVisibility: PRIVATE,
    mayTransfer: ALWAYS,
    logger,
    ...extra,
  };
}

/** Push options for the named run, whose home matches its pull. */
function pushOpts(
  root: string,
  name: string,
  persistence: LearningsPersistence,
  logger: LearningsLogger,
  stop: PushLearningsOptions["stop"],
  extra: Partial<PushLearningsOptions> = {},
): PushLearningsOptions {
  return {
    learningsRepo: REPO,
    persistence,
    home: join(root, `${name}-home`),
    subject: SUBJECT,
    runId: name,
    checkVisibility: PRIVATE,
    mayTransfer: ALWAYS,
    stop,
    logger,
    scanStaged: cleanScan,
    ...extra,
  };
}

Deno.test("acceptance: a run pushes its state, a later run restores it, and another key stays isolated", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    // The store serves partial clones, so the isolation proof below can inspect blobs.
    await git(["-C", store.dir, "config", "uploadpack.allowFilter", "true"]);
    await git([
      "-C",
      store.dir,
      "config",
      "uploadpack.allowAnySHA1InWant",
      "true",
    ]);
    const run1 = capture();
    const stops1 = recorder();

    const p1 = await pullLearnings(
      pullOpts(root, "run1", KEY_A, store.url, run1.logger),
    );
    assertEquals(p1.status, "empty");
    assertEquals(run1.warnings, []);

    const home1 = join(root, "run1-home");
    await plant(home1, KEY_A, "claude/injection.json", '{"facts":["alpha"]}\n');
    await plant(home1, KEY_A, "sessions/x.json", "{}\n");
    await plant(home1, KEY_A, "errors.log", "boom\n");
    await plant(home1, KEY_A, "transcript.jsonl", "{}\n");
    await plant(home1, KEY_A, "bin/te", "#!/bin/sh\n");

    const out1 = await pushLearnings(
      pushOpts(root, "run1", p1, run1.logger, stops1.stop),
    );
    assertEquals(out1.kind, "pushed");
    if (out1.kind === "pushed") assertEquals(out1.commit.length, 40);
    assertEquals(await storeFiles(store.dir), [
      `token-economizer/${KEY_A}/claude/injection.json`,
    ]);
    const message = await git([
      "-C",
      store.dir,
      "log",
      "-1",
      "--format=%B",
      "main",
    ]);
    assertStringIncludes(
      message,
      `token-economizer: learnings for ${KEY_A} from ${SUBJECT}`,
    );
    assertStringIncludes(message, "Vibe-Coder-Run-Id: run1");
    assertEquals(stops1.stops, []);
    assertEquals(run1.warnings, []);
    // A pushed clone is clean and at the store tip, so it is kept for a later push.
    assertEquals(await exists(join(root, "run1-scratch")), true);

    // The shared settings file is pulled into the home, and never pushed.
    await commitToStore(root, store.url, {
      "token-economizer/config.json": '{"mode":"on"}\n',
    });
    const run2 = capture();
    const p2 = await pullLearnings(
      pullOpts(root, "run2", KEY_A, store.url, run2.logger),
    );
    assertEquals(p2.status, "restored");
    assertEquals(run2.warnings, []);
    const home2 = join(root, "run2-home");
    assertEquals(
      await Deno.readTextFile(
        join(home2, "repos", KEY_A, "claude", "injection.json"),
      ),
      '{"facts":["alpha"]}\n',
    );
    assertEquals(
      await Deno.readTextFile(join(home2, "config.json")),
      '{"mode":"on"}\n',
    );
    assertEquals(
      await exists(join(home2, "repos", KEY_A, "errors.log")),
      false,
    );

    // Another key: no state of key A in its home, nor in its sparse worktree.
    const runB = capture();
    const pB = await pullLearnings(
      pullOpts(root, "runB", KEY_B, store.url, runB.logger),
    );
    // Key B has no state in the store (only the shared settings file), so it is empty, not restored.
    assertEquals(pB.status, "empty");
    assertEquals(
      await exists(join(root, "runB-home", "repos", KEY_A)),
      false,
    );
    assertEquals(
      await exists(join(root, "runB-scratch", "token-economizer", KEY_A)),
      false,
    );

    // Isolation proof: key A's blob is absent from run B's clone. Run 2's clone,
    // which pulled key A, holds it (the positive control).
    const blobA = (await git([
      "-C",
      store.dir,
      "rev-parse",
      `HEAD:token-economizer/${KEY_A}/claude/injection.json`,
    ])).trim();
    assertEquals(await hasObjectLocally(store.dir, blobA), true);
    assertEquals(
      await hasObjectLocally(join(root, "run2-scratch"), blobA),
      true,
    );
    assertEquals(
      await hasObjectLocally(join(root, "runB-scratch"), blobA),
      false,
    );
    const objectsB = await git([
      "-C",
      join(root, "runB-scratch"),
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ]);
    assertEquals(objectsB.split("\n").includes(blobA), false);
  }));

Deno.test("reuse: the same persistence pushed twice pushes both states, and the clean clone is kept after unchanged", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "reuse", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    const home = join(root, "reuse-home");
    const scratch = join(root, "reuse-scratch");
    await plant(home, KEY_A, "claude/a.json", '{"a":1}\n');

    const first = await pushLearnings(
      pushOpts(root, "reuse", p, log.logger, stops.stop),
    );
    assertEquals(first.kind, "pushed");
    assertEquals(await exists(scratch), true);

    // A later spawn of the same run pushes again with the same persistence.
    await plant(home, KEY_A, "claude/a.json", '{"a":2}\n');
    const second = await pushLearnings(
      pushOpts(root, "reuse", p, log.logger, stops.stop),
    );
    assertEquals(second.kind, "pushed");
    assertEquals(await commitCount(store.dir), 2);
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/a.json`,
      ]),
      '{"a":2}\n',
    );

    // Nothing new to push: unchanged, and the clean clone is still kept.
    const third = await pushLearnings(
      pushOpts(root, "reuse", p, log.logger, stops.stop),
    );
    assertEquals(third.kind, "unchanged");
    assertEquals(await exists(scratch), true);
    assertEquals(await commitCount(store.dir), 2);
    assertEquals(log.warnings, []);
    assertEquals(stops.stops, []);
  }));

Deno.test("skipped: a removed clone inside a parent repository is skipped, and the parent is untouched", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const parent = join(root, "parent");
    await git(["init", "--quiet", parent]);
    const scratch = join(parent, "scratch");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "removed", KEY_A, store.url, log.logger, {
        scratchDir: scratch,
      }),
    );
    assertEquals(p.status, "empty");
    assertEquals(p.storeDir, scratch);
    await Deno.remove(scratch, { recursive: true });
    await plant(
      join(root, "removed-home"),
      KEY_A,
      "claude/a.json",
      '{"a":1}\n',
    );

    const out = await pushLearnings(
      pushOpts(root, "removed", p, log.logger, stops.stop),
    );
    assertEquals(out.kind, "skipped");
    if (out.kind === "skipped") {
      assertStringIncludes(out.reason, "store clone is gone");
    }
    assertEquals(await exists(scratch), false);
    assertEquals(stops.stops, []);
    const parentHead = await runGitCommand([
      "-C",
      parent,
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ]);
    assert(!parentHead.ok || parentHead.value.code !== 0);
    assertEquals(await git(["-C", parent, "status", "--porcelain"]), "");
  }));

Deno.test("refused: a public or unverifiable learnings repository is never transferred", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const publicCheck = () =>
      Promise.resolve<VisibilityVerdict>({
        private: false,
        reason: `learnings repository ${REPO} is public`,
      });

    const pub = capture();
    const refused = await pullLearnings(
      pullOpts(root, "pub", KEY_A, store.url, pub.logger, {
        checkVisibility: publicCheck,
      }),
    );
    assertEquals(refused.status, "refused");
    assertStringIncludes(refused.reason, "is public");
    assert(pub.warnings.some((w) => w.includes("is public")));
    assertEquals(await exists(join(root, "pub-scratch")), false);

    // Private at the pull, public by the push: the stale check does not authorise.
    const stale = capture();
    const staleStops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "stale", KEY_A, store.url, stale.logger),
    );
    assertEquals(p.status, "empty");
    await plant(
      join(root, "stale-home"),
      KEY_A,
      "claude/injection.json",
      "{}\n",
    );
    const out = await pushLearnings(
      pushOpts(root, "stale", p, stale.logger, staleStops.stop, {
        checkVisibility: publicCheck,
      }),
    );
    assertEquals(out.kind, "refused");
    if (out.kind === "refused") assertStringIncludes(out.reason, "is public");
    assertEquals(await commitCount(store.dir), 0);
    assertEquals(staleStops.stops, []);

    // Unverifiable: a gh failure, a missing key, and output that is not JSON.
    const failing = githubVisibilityCheck(() =>
      Promise.reject(new Error("HTTP 503 from api.github.com"))
    );
    const missingKey = githubVisibilityCheck(() =>
      Promise.resolve('{"private": true}')
    );
    const notJson = githubVisibilityCheck(() => Promise.resolve("<html>"));
    for (const check of [failing, missingKey, notJson]) {
      const verdict = await check(REPO);
      assertEquals(verdict.private, false);
      if (verdict.private === false) {
        assertStringIncludes(verdict.reason, "visibility unverifiable");
      }
    }
    assertEquals(
      await githubVisibilityCheck(() =>
        Promise.resolve('{"private": true, "visibility": "private"}')
      )(REPO),
      { private: true },
    );
    const publicJson = await githubVisibilityCheck(() =>
      Promise.resolve('{"private": false, "visibility": "public"}')
    )(REPO);
    assertEquals(publicJson.private, false);
    if (publicJson.private === false) {
      assertStringIncludes(publicJson.reason, "is public");
    }

    const unverified = capture();
    const unv = await pullLearnings(
      pullOpts(root, "unv", KEY_A, store.url, unverified.logger, {
        checkVisibility: missingKey,
      }),
    );
    assertEquals(unv.status, "refused");
    assertStringIncludes(unv.reason, "visibility unverifiable");
    assertEquals(await exists(join(root, "unv-scratch")), false);
  }));

// Needs the real gitleaks binary, which CI's unit shards may not have (only the
// container does), so it is guarded. The injected-report sibling below covers
// the same stop path in CI.
Deno.test({
  name:
    "stopped: a planted GitHub PAT, scanned by the real gitleaks, stops the trial and is never recorded",
  ignore: !hasGitleaks,
  fn: () =>
    withRoot(async (root) => {
      const store = await newStore(root, "store");
      const log = capture();
      const stops = recorder();
      const p = await pullLearnings(
        pullOpts(root, "secret", KEY_A, store.url, log.logger),
      );
      assertEquals(p.status, "empty");
      await plant(
        join(root, "secret-home"),
        KEY_A,
        "claude/injection.json",
        JSON.stringify({ facts: [`deploy with ${FAKE_PAT}`] }) + "\n",
      );

      const out = await pushLearnings(
        pushOpts(root, "secret", p, log.logger, stops.stop, {
          scanStaged: undefined,
        }),
      );
      assertEquals(out.kind, "stopped");
      if (out.kind === "stopped") {
        assertEquals(out.rule, "secret-in-learnings");
        assertStringIncludes(out.reason, "github-pat");
        assertEquals(out.reason.includes(FAKE_PAT), false);
      }

      assertEquals(stops.stops.length, 1);
      const [stop] = stops.stops;
      assert(stop !== undefined);
      assertEquals(stop.rule, "secret-in-learnings");
      assertStringIncludes(stop.reason, "github-pat");
      assertEquals(stop.reason.includes(FAKE_PAT), false);
      assertEquals(await commitCount(store.dir), 0);
      const logged = [...log.warnings, ...log.infos].join("\n");
      assertEquals(logged.includes(FAKE_PAT), false);
      assert(log.warnings.some((w) => w.includes("secret-in-learnings")));
    }),
});

Deno.test("stopped: an injected gitleaks report of the planted PAT stops the trial, is not committed and keeps the token out", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "injected", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    await plant(
      join(root, "injected-home"),
      KEY_A,
      "claude/injection.json",
      JSON.stringify({ facts: [`deploy with ${FAKE_PAT}`] }) + "\n",
    );

    const out = await pushLearnings(
      pushOpts(root, "injected", p, log.logger, stops.stop, {
        scanStaged: () => Promise.resolve(leakScan(KEY_A)),
      }),
    );
    assertEquals(out.kind, "stopped");
    if (out.kind === "stopped") {
      assertEquals(out.rule, "secret-in-learnings");
      assertEquals(
        out.reason,
        `gitleaks rule github-pat in token-economizer/${KEY_A}/claude/injection.json`,
      );
      assertEquals(out.reason.includes(FAKE_PAT), false);
    }
    assertEquals(stops.stops.map((s) => s.rule), ["secret-in-learnings"]);
    assertEquals(await commitCount(store.dir), 0);
    assertEquals(await exists(join(root, "injected-scratch")), false);
    const logged = [...log.warnings, ...log.infos].join("\n");
    assertEquals(logged.includes(FAKE_PAT), false);
    assert(log.warnings.some((w) => w.includes("secret-in-learnings")));
  }));

Deno.test("stopped: the real stop record latches, notifies issue 4959 and keeps the token out", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const p = await pullLearnings(
      pullOpts(root, "latch", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    await plant(
      join(root, "latch-home"),
      KEY_A,
      "claude/injection.json",
      JSON.stringify({ facts: [`deploy with ${FAKE_PAT}`] }) + "\n",
    );
    const workDir = join(root, "work");
    await Deno.mkdir(workDir);
    const notes: string[][] = [];
    const notify = (args: string[]) => {
      notes.push(args);
      return Promise.resolve("");
    };

    const out = await pushLearnings(
      pushOpts(
        root,
        "latch",
        p,
        log.logger,
        (finding) =>
          stopTokenEconomizerTrial(workDir, finding, notify, log.logger),
        { scanStaged: () => Promise.resolve(leakScan(KEY_A)) },
      ),
    );
    assertEquals(out.kind, "stopped");
    assertEquals(
      (await readTokenEconomizerStop(workDir))?.rule,
      "secret-in-learnings",
    );
    assertEquals(await tokenEconomizerMaySync(workDir), false);

    assertEquals(notes.length, 1);
    const [args] = notes;
    assert(args !== undefined);
    assertEquals(args.slice(0, 3), ["issue", "comment", "4959"]);
    const body = args.join("\n");
    assertStringIncludes(body, "secret-in-learnings");
    assertEquals(body.includes(FAKE_PAT), false);
    assertEquals(await commitCount(store.dir), 0);
  }));

Deno.test("stopped: state for another repository in the home stops the push before anything moves", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "iso", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    const home = join(root, "iso-home");
    await plant(home, KEY_A, "claude/injection.json", "{}\n");
    await plant(home, KEY_B, "claude/injection.json", '{"other":true}\n');

    const out = await pushLearnings(
      pushOpts(root, "iso", p, log.logger, stops.stop),
    );
    assertEquals(out.kind, "stopped");
    if (out.kind === "stopped") assertEquals(out.rule, "cross-repo-fact");
    assertEquals(stops.stops.map((s) => s.rule), ["cross-repo-fact"]);
    assertEquals(await commitCount(store.dir), 0);
  }));

Deno.test("unavailable: a missing store is a warning carrying the git cause, never an empty store", () =>
  withRoot(async (root) => {
    const missing = pathToFileURL(join(root, "missing.git")).href;
    const log = capture();
    const p = await pullLearnings(
      pullOpts(root, "gone", KEY_A, missing, log.logger),
    );
    assertEquals(p.status, "unavailable");
    assertEquals(p.storeDir, undefined);
    assert(
      log.warnings.some((w) =>
        w.includes("does not appear to be a git repository")
      ),
    );
    assertEquals(await exists(join(root, "gone-scratch")), false);
  }));

Deno.test("dropped: a push after the store vanished is logged, the scratch is removed and nothing throws", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "vanish", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    await plant(
      join(root, "vanish-home"),
      KEY_A,
      "claude/injection.json",
      "{}\n",
    );
    await Deno.remove(store.dir, { recursive: true });

    const out = await pushLearnings(
      pushOpts(root, "vanish", p, log.logger, stops.stop),
    );
    assertEquals(out.kind, "dropped");
    if (out.kind === "dropped") {
      assertStringIncludes(
        out.reason,
        "does not appear to be a git repository",
      );
    }
    assert(
      log.warnings.some((w) => w.includes("dropped")),
    );
    assertEquals(stops.stops, []);
    assertEquals(await exists(join(root, "vanish-scratch")), false);
  }));

Deno.test("replay: a rejected push is replayed on the new tip when the files differ", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: '{"a":1}\n',
      [`token-economizer/${KEY_A}/claude/removed.json`]: "{}\n",
    });
    const logX = capture();
    const logY = capture();
    const px = await pullLearnings(
      pullOpts(root, "x", KEY_A, store.url, logX.logger),
    );
    const py = await pullLearnings(
      pullOpts(root, "y", KEY_A, store.url, logY.logger),
    );
    assertEquals([px.status, py.status], ["restored", "restored"]);

    // Transcripts are local-only and must survive refreshing the replayed state.
    const transcript = join(
      root,
      "y-home",
      "repos",
      KEY_A,
      "sessions",
      "kept.json",
    );
    await Deno.mkdir(dirname(transcript), { recursive: true });
    await Deno.writeTextFile(transcript, "local transcript");

    // Run X changes a.json and pushes first.
    await plant(join(root, "x-home"), KEY_A, "claude/a.json", '{"x":2}\n');
    await Deno.remove(
      join(root, "x-home", "repos", KEY_A, "claude/removed.json"),
    );
    const outX = await pushLearnings(
      pushOpts(root, "x", px, logX.logger, recorder().stop),
    );
    assertEquals(outX.kind, "pushed");

    // Run Y adds a different file from the same tip, so its push is rejected and replayed.
    await plant(join(root, "y-home"), KEY_A, "claude/b.json", '{"b":1}\n');
    const outY = await pushLearnings(
      pushOpts(root, "y", py, logY.logger, recorder().stop),
    );
    assertEquals(outY.kind, "pushed");
    assertEquals(logY.warnings, []);
    assertEquals(await storeFiles(store.dir), [
      `token-economizer/${KEY_A}/claude/a.json`,
      `token-economizer/${KEY_A}/claude/b.json`,
    ]);
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/a.json`,
      ]),
      '{"x":2}\n',
    );
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/b.json`,
      ]),
      '{"b":1}\n',
    );
    assertEquals(await commitCount(store.dir), 3);

    assertEquals(await Deno.readTextFile(transcript), "local transcript");
    assertEquals(
      await exists(join(root, "y-home", "repos", KEY_A, "claude/removed.json")),
      false,
    );
    // Reusing Y must not restore its stale copy of X's learning.
    assertEquals(
      (await pushLearnings(
        pushOpts(root, "y", py, logY.logger, recorder().stop),
      )).kind,
      "unchanged",
    );
    assertEquals(await commitCount(store.dir), 3);
    await plant(join(root, "y-home"), KEY_A, "claude/c.json", '{"c":3}\n');
    assertEquals(
      (await pushLearnings(
        pushOpts(root, "y", py, logY.logger, recorder().stop),
      )).kind,
      "pushed",
    );
    for (
      const [name, expected] of [
        ["a", '{"x":2}\n'],
        ["b", '{"b":1}\n'],
        ["c", '{"c":3}\n'],
      ]
    ) {
      assertEquals(
        await git([
          "-C",
          store.dir,
          "show",
          `main:token-economizer/${KEY_A}/claude/${name}.json`,
        ]),
        expected,
      );
    }
  }));

Deno.test("replay: refreshing the home refuses symlink destinations and keeps outside files unchanged", () =>
  withRoot(async (root) => {
    for (const directory of [false, true]) {
      const prefix = directory ? "directory" : "file";
      const store = await newStore(root, `${prefix}-store`);
      await commitToStore(root, store.url, {
        [`token-economizer/${KEY_A}/claude/a.json`]: "{}\n",
      });
      const x = `${prefix}-x`;
      const y = `${prefix}-y`;
      const log = capture();
      const px = await pullLearnings(
        pullOpts(root, x, KEY_A, store.url, log.logger),
      );
      const py = await pullLearnings(
        pullOpts(root, y, KEY_A, store.url, log.logger),
      );
      const outside = join(root, `${prefix}-outside`);
      await Deno.mkdir(outside);
      const outsideFile = join(outside, "new.json");
      await Deno.writeTextFile(outsideFile, "unchanged outside");
      const relative = directory ? "remote/new.json" : "new.json";
      const destination = join(
        root,
        `${y}-home`,
        "repos",
        KEY_A,
        directory ? "remote" : "new.json",
      );
      await Deno.symlink(directory ? outside : outsideFile, destination);
      await plant(join(root, `${x}-home`), KEY_A, relative, '{"remote":1}\n');
      assertEquals(
        (await pushLearnings(
          pushOpts(root, x, px, log.logger, recorder().stop),
        )).kind,
        "pushed",
      );
      await plant(
        join(root, `${y}-home`),
        KEY_A,
        "claude/b.json",
        '{"local":1}\n',
      );
      const result = await pushLearnings(
        pushOpts(root, y, py, log.logger, recorder().stop),
      );
      assertEquals(result.kind, "skipped");
      assert(result.kind === "skipped");
      assertStringIncludes(
        result.reason,
        directory ? "not a plain directory" : "not a regular file",
      );
      assertEquals(await Deno.readTextFile(outsideFile), "unchanged outside");
      assertEquals(await exists(py.storeDir!), false);
    }
  }));

Deno.test("dropped: a replay that conflicts is logged, and the earlier run's content stays on the store", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: '{"a":1}\n',
    });
    const logX = capture();
    const logY = capture();
    const px = await pullLearnings(
      pullOpts(root, "x", KEY_A, store.url, logX.logger),
    );
    const py = await pullLearnings(
      pullOpts(root, "y", KEY_A, store.url, logY.logger),
    );
    assertEquals([px.status, py.status], ["restored", "restored"]);

    await plant(join(root, "x-home"), KEY_A, "claude/a.json", '{"x":2}\n');
    assertEquals(
      (await pushLearnings(
        pushOpts(root, "x", px, logX.logger, recorder().stop),
      ))
        .kind,
      "pushed",
    );

    // Run Y changed the same file differently from the same tip.
    await plant(join(root, "y-home"), KEY_A, "claude/a.json", '{"y":3}\n');
    const outY = await pushLearnings(
      pushOpts(root, "y", py, logY.logger, recorder().stop),
    );
    assertEquals(outY.kind, "dropped");
    if (outY.kind === "dropped") assertStringIncludes(outY.reason, "conflicts");
    assert(
      logY.warnings.some((w) => w.includes("later run's update dropped")),
    );
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/a.json`,
      ]),
      '{"x":2}\n',
    );
    assertEquals(await commitCount(store.dir), 2);
    assertEquals(await exists(join(root, "y-scratch")), false);
  }));

Deno.test("skipped: state over the key cap is never pushed", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const log = capture();
    const stops = recorder();
    const p = await pullLearnings(
      pullOpts(root, "cap", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "empty");
    await plant(
      join(root, "cap-home"),
      KEY_A,
      "claude/big.json",
      "x".repeat(LEARNINGS_KEY_CAP_BYTES + 1),
    );

    const out = await pushLearnings(
      pushOpts(root, "cap", p, log.logger, stops.stop),
    );
    assertEquals(out.kind, "skipped");
    if (out.kind === "skipped") assertStringIncludes(out.reason, "cap");
    assertEquals(await commitCount(store.dir), 0);
    assertEquals(stops.stops, []);
  }));

Deno.test("unavailable: a store key holding a symlink, a non-JSON file or too much state is not restored", () =>
  withRoot(async (root) => {
    const reasons: Record<string, string> = {
      symlink: "outside the allow-list: claude/link.json",
      "non-json": "outside the allow-list: errors.log",
      "over-cap": `exceeds the ${LEARNINGS_KEY_CAP_BYTES}-byte cap`,
      "config-over-cap": `config.json of ${
        LEARNINGS_CONFIG_CAP_BYTES + 1
      } bytes exceeds the ${LEARNINGS_CONFIG_CAP_BYTES}-byte cap`,
    };
    const cases: Record<string, Record<string, Content>> = {
      symlink: {
        [`token-economizer/${KEY_A}/claude/a.json`]: "{}\n",
        [`token-economizer/${KEY_A}/claude/link.json`]: { link: "a.json" },
      },
      "non-json": { [`token-economizer/${KEY_A}/errors.log`]: "boom\n" },
      "over-cap": {
        [`token-economizer/${KEY_A}/claude/big.json`]: "x".repeat(
          LEARNINGS_KEY_CAP_BYTES + 1,
        ),
      },
      // The key's own state is valid, so only the shared config can refuse it.
      "config-over-cap": {
        [`token-economizer/${KEY_A}/claude/a.json`]: "{}\n",
        "token-economizer/config.json": "x".repeat(
          LEARNINGS_CONFIG_CAP_BYTES + 1,
        ),
      },
    };
    for (const [name, files] of Object.entries(cases)) {
      const store = await newStore(root, name);
      await commitToStore(root, store.url, files);
      const log = capture();
      const p = await pullLearnings(
        pullOpts(root, name, KEY_A, store.url, log.logger),
      );
      assertEquals(p.status, "unavailable", name);
      assertEquals(p.storeDir, undefined, name);
      assertEquals(
        await exists(join(root, `${name}-home`, "repos")),
        false,
        name,
      );
      assertEquals(await exists(join(root, `${name}-scratch`)), false, name);
      assertEquals(
        await exists(join(root, `${name}-home`, "config.json")),
        false,
        name,
      );
      const expected = reasons[name];
      assert(expected !== undefined, name);
      assertStringIncludes(p.reason, expected, name);
      assert(log.warnings.some((w) => w.includes(expected)), name);
    }
  }));

Deno.test("restored: a config.json exactly at the cap is copied into the home", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const config = "x".repeat(LEARNINGS_CONFIG_CAP_BYTES);
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: "{}\n",
      "token-economizer/config.json": config,
    });
    const p = await pullLearnings(
      pullOpts(root, "edge", KEY_A, store.url, capture().logger),
    );
    assertEquals(p.status, "restored");
    assertEquals(
      await Deno.readTextFile(join(root, "edge-home", "config.json")),
      config,
    );
  }));

Deno.test("refused: a latched trial neither pulls nor pushes", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: '{"a":1}\n',
    });
    const log = capture();

    const latched = await pullLearnings(
      pullOpts(root, "latched", KEY_A, store.url, log.logger, {
        mayTransfer: NEVER,
      }),
    );
    assertEquals(latched.status, "refused");
    assertStringIncludes(latched.reason, "latched");
    assertEquals(latched.storeDir, undefined);
    assertEquals(await exists(join(root, "latched-scratch")), false);

    // A pull made before the latch: the push is skipped, and the store is untouched.
    const p = await pullLearnings(
      pullOpts(root, "later", KEY_A, store.url, log.logger),
    );
    assertEquals(p.status, "restored");
    await plant(join(root, "later-home"), KEY_A, "claude/a.json", '{"x":9}\n');
    const out = await pushLearnings(
      pushOpts(root, "later", p, log.logger, recorder().stop, {
        mayTransfer: NEVER,
      }),
    );
    assertEquals(out.kind, "skipped");
    assertEquals(await commitCount(store.dir), 1);
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/a.json`,
      ]),
      '{"a":1}\n',
    );

    // With no verified store from the pull, a push is skipped outright.
    const none = await pushLearnings(
      pushOpts(root, "latched", latched, log.logger, recorder().stop),
    );
    assertEquals(none.kind, "skipped");
  }));

Deno.test("refused: a store that turns public, or a stop that latches, between the first push and its replay uploads nothing", () =>
  withRoot(async (root) => {
    // "control" changes nothing: it proves the fixture reaches the replay and pushes.
    for (const change of ["control", "public", "latch"] as const) {
      const store = await newStore(root, `${change}-store`);
      await commitToStore(root, store.url, {
        [`token-economizer/${KEY_A}/claude/a.json`]: '{"a":1}\n',
      });
      const x = `${change}x`;
      const y = `${change}y`;
      const logX = capture();
      const logY = capture();
      const px = await pullLearnings(
        pullOpts(root, x, KEY_A, store.url, logX.logger),
      );

      // The change is driven by the world, not by how often Y checks: it takes
      // effect once X's commit has reached Y's clone, which only the replay's fetch does.
      let xTip = "";
      const yClone: { dir?: string } = {};
      let replayObserved = false;
      const changed = async () => {
        const present = xTip !== "" && yClone.dir !== undefined &&
          await hasObjectLocally(yClone.dir, `${xTip}^{commit}`);
        replayObserved ||= present;
        return present;
      };
      const yVisibility = async () =>
        await changed() && change === "public"
          ? {
            private: false,
            reason: `learnings repository ${REPO} is public`,
          } as VisibilityVerdict
          : { private: true } as VisibilityVerdict;
      const yMayTransfer = async () => !(await changed() && change === "latch");
      const py = await pullLearnings(
        pullOpts(root, y, KEY_A, store.url, logY.logger, {
          checkVisibility: yVisibility,
          mayTransfer: yMayTransfer,
        }),
      );
      yClone.dir = py.storeDir;
      assertEquals(py.status, "restored", change);

      await plant(join(root, `${x}-home`), KEY_A, "claude/a.json", '{"x":2}\n');
      const outX = await pushLearnings(
        pushOpts(root, x, px, logX.logger, recorder().stop),
      );
      assertEquals(outX.kind, "pushed", change);
      xTip = (await git(["-C", store.dir, "rev-parse", "main"])).trim();
      assertEquals(
        await changed(),
        false,
        "competing tip absent before first push",
      );
      const afterX = await commitCount(store.dir);
      assertEquals(afterX, 2, change);

      // Y adds a different file from the old tip: the first push is rejected, then replayed.
      await plant(join(root, `${y}-home`), KEY_A, "claude/b.json", '{"b":1}\n');
      const outY = await pushLearnings(
        pushOpts(root, y, py, logY.logger, recorder().stop, {
          checkVisibility: yVisibility,
          mayTransfer: yMayTransfer,
        }),
      );
      assertEquals(
        outY.kind,
        { control: "pushed", public: "refused", latch: "skipped" }[change],
        change,
      );
      assertEquals(replayObserved, true, "competing tip reached replay clone");
      if (outY.kind === "refused") {
        assertStringIncludes(outY.reason, "is public");
      }
      if (outY.kind === "skipped") assertStringIncludes(outY.reason, "latched");
      if (change === "control") {
        // Positive control: the replay ran and added Y's file on top of X's commit.
        assertEquals(await commitCount(store.dir), afterX + 1, change);
        assertEquals(await storeFiles(store.dir), [
          `token-economizer/${KEY_A}/claude/a.json`,
          `token-economizer/${KEY_A}/claude/b.json`,
        ], change);
      } else {
        assertEquals(await commitCount(store.dir), afterX, change);
        assertEquals(await storeFiles(store.dir), [
          `token-economizer/${KEY_A}/claude/a.json`,
        ], change);
        assertEquals(
          await git(["-C", store.dir, "rev-parse", "main"]),
          `${xTip}\n`,
          change,
        );
        assertEquals(await exists(join(root, `${y}-scratch`)), false, change);
      }
    }
  }));

Deno.test("default visibility check: the learnings repository is in the token scope while it reads, and is released afterwards", async () => {
  _setWriteRepoAllowlistSinks({ log: () => {} });
  try {
    // The run seeds its allowlist with the claim repo only, so the token is scoped to it.
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);

    // A small fake of GitHub's repository read: it resolves whichever repository the call
    // names and answers 404 unless that repository is in the current token scope.
    const store = "stSoftwareAU/LearningsStore";
    let scopeDuringRead: string[] | null = null;
    let writableDuringRead = true;
    const fakeRepoRead = (args: string[]): Promise<string> => {
      const scope = installationTokenRepoScope() ?? [];
      scopeDuringRead = installationTokenRepoScope();
      writableDuringRead = isWriteRepoAllowed(store);
      if (!scope.some((repo) => args.join(" ").includes(repo))) {
        return Promise.reject(new Error("HTTP 404: Not Found"));
      }
      return Promise.resolve('{"private": true, "visibility": "private"}');
    };
    const verdict = await githubVisibilityCheck(fakeRepoRead)(store);
    assertEquals(verdict, { private: true });
    assertEquals(scopeDuringRead, [store, "stSoftwareAU/VibeCoder"]);
    assertEquals(
      writableDuringRead,
      false,
      "a read grant must not permit writes",
    );
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);
    assertEquals(isWriteRepoAllowed(store), false);

    // Once the grant is released the same read is denied.
    let deniedAfterRelease = false;
    await fakeRepoRead(["api", `repos/${store}`]).catch(() => {
      deniedAfterRelease = true;
    });
    assertEquals(deniedAfterRelease, true);
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);

    // A failing read releases the grant too, and stays unverifiable.
    const failed = await githubVisibilityCheck(() =>
      Promise.reject(new Error("HTTP 404"))
    )(store);
    assertEquals(failed.private, false);
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);
  } finally {
    _resetWriteRepoAllowlistSinks();
    resetWriteRepoAllowlist();
    _resetWriteRepoPins();
  }
});

Deno.test("repo keys: the upstream goldens, and the origin of a checkout", () =>
  withRoot(async (root) => {
    const goldens: [string, string, string][] = [
      [
        "https://x-access-token:ghs_abc@github.com/stSoftwareAU/VibeCoder.git",
        "github.com/stsoftwareau/vibecoder",
        "vibecoder-9dcdf6cc4d",
      ],
      [
        "git@github.com:stSoftwareAU/VibeCoder.git",
        "github.com/stsoftwareau/vibecoder",
        "vibecoder-9dcdf6cc4d",
      ],
      [
        "https://github.com/stsoftwareau/vibecoder",
        "github.com/stsoftwareau/vibecoder",
        "vibecoder-9dcdf6cc4d",
      ],
      [
        "https://github.com/Owner/My.Repo_X.git/",
        "github.com/owner/my.repo_x",
        "my-repo-x-4949a686c3",
      ],
    ];
    for (const [url, canon, key] of goldens) {
      assertEquals(normaliseRemote(url), canon);
      assertEquals(await learningsRepoKey(url), key);
    }

    const checkout = join(root, "checkout");
    await git(["init", "--quiet", checkout]);
    await git([
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/stSoftwareAU/VibeCoder.git",
    ]);
    assertEquals(await repoKeyForCheckout(checkout), "vibecoder-9dcdf6cc4d");

    const plain = join(root, "plain");
    await git(["init", "--quiet", plain]);
    assertEquals(await repoKeyForCheckout(plain), null);
    assertEquals(await repoKeyForCheckout(join(root, "absent")), null);
  }));

/** The HEAD commit of a clone, or null when it has none. */
async function headOf(dir: string): Promise<string | null> {
  const run = await runGitCommand([
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "-q",
    "HEAD",
  ]);
  return run.ok && run.value.code === 0 ? run.value.stdout.trim() : null;
}

Deno.test("skipped: a scanner fault fails closed (timeout, unreadable report, unexpected exit, a throw), with nothing committed", () =>
  withRoot(async (root) => {
    const faults: [
      string,
      (cwd: string) => Promise<StagedScan>,
      string,
    ][] = [
      [
        "timeout",
        () =>
          Promise.resolve({
            exitCode: -1,
            stdout: "",
            stderr: "",
            timedOut: true,
          }),
        "exceeded its deadline",
      ],
      [
        "unreadable",
        () => Promise.resolve({ exitCode: 1, stdout: "not json", stderr: "" }),
        "without a readable report",
      ],
      [
        "exit-2",
        () =>
          Promise.resolve({
            exitCode: 2,
            stdout: "[]",
            stderr: "fatal: bad config",
          }),
        "gitleaks exited 2",
      ],
      [
        "throws",
        () => Promise.reject(new Error("spawn gitleaks ENOENT")),
        "ENOENT",
      ],
    ];
    for (const [name, fault, cause] of faults) {
      const store = await newStore(root, `fault-${name}`);
      const log = capture();
      const stops = recorder();
      const p = await pullLearnings(
        pullOpts(root, `fault-${name}`, KEY_A, store.url, log.logger),
      );
      assertEquals(p.status, "empty", name);
      await plant(
        join(root, `fault-${name}-home`),
        KEY_A,
        "claude/injection.json",
        "{}\n",
      );

      let headAtScan: string | null | undefined;
      const out = await pushLearnings(
        pushOpts(root, `fault-${name}`, p, log.logger, stops.stop, {
          scanStaged: async (cwd) => {
            headAtScan = await headOf(cwd);
            return await fault(cwd);
          },
        }),
      );
      assertEquals(out.kind, "skipped", name);
      if (out.kind === "skipped") {
        assertStringIncludes(out.reason, "scanner fault", name);
        assertStringIncludes(out.reason, cause, name);
      }
      // The scan runs before the commit: the clone had no commit at that point,
      // and the clone is removed, so nothing is committed or kept.
      assertEquals(headAtScan, null, name);
      assertEquals(await commitCount(store.dir), 0, name);
      assertEquals(
        await exists(join(root, `fault-${name}-scratch`)),
        false,
        name,
      );
      assertEquals(stops.stops, [], name);
      assert(log.warnings.some((w) => w.includes("scanner fault")), name);
    }
  }));

Deno.test("refused: an unsafe repository key is refused on pull and push, with nothing cloned or written", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    const unsafe = ["..", "a/b", "/abs"];
    for (const [index, key] of unsafe.entries()) {
      const log = capture();
      const stops = recorder();
      const name = `unsafe${index}`;
      const pulled = await pullLearnings(
        pullOpts(root, name, key, store.url, log.logger),
      );
      assertEquals(pulled.status, "unavailable", key);
      assertStringIncludes(pulled.reason, "invalid repository key", key);
      assert(
        log.warnings.some((w) => w.includes("invalid repository key")),
        key,
      );
      assertEquals(pulled.storeDir, undefined, key);
      assertEquals(await exists(join(root, `${name}-scratch`)), false, key);
      assertEquals(await exists(join(root, `${name}-home`)), false, key);

      // Push: a verified pull for a safe key, whose persistence names the unsafe key.
      const valid = `valid${index}`;
      const p = await pullLearnings(
        pullOpts(root, valid, KEY_A, store.url, log.logger),
      );
      assertEquals(p.status, "empty", key);
      const forged: LearningsPersistence = { ...p, repoKey: key };
      const out = await pushLearnings(
        pushOpts(root, valid, forged, log.logger, stops.stop),
      );
      assertEquals(out.kind, "skipped", key);
      if (out.kind === "skipped") {
        assertStringIncludes(out.reason, "invalid repository key", key);
      }
      assertEquals(await commitCount(store.dir), 0, key);
      assertEquals(
        await exists(join(root, `${valid}-home`, "repos")),
        false,
        key,
      );
      assertEquals(stops.stops, [], key);
    }

    // Control: a safe key proceeds.
    const control = await pullLearnings(
      pullOpts(root, "control", KEY_A, store.url, capture().logger),
    );
    assertEquals(control.status, "empty");
    assertEquals(await exists(join(root, "control-scratch")), true);
  }));

/** Prints the key the upstream plugin derives for each URL in argv[1] (a JSON array). */
const UPSTREAM_KEYS_SCRIPT = [
  "import json, sys",
  'sys.path.insert(0, "/opt/tokeneconomizer")',
  "from tokeneconomizer.plugin.paths import normalize_remote, _slug, digest",
  "keys = []",
  "for url in json.loads(sys.argv[1]):",
  "    canon = normalize_remote(url)",
  "    name = canon.rstrip('/').rsplit('/', 1)[-1]",
  "    keys.append(f'{_slug(name)}-{digest(canon)}')",
  "print(json.dumps(keys))",
].join("\n");

/** The vendored upstream plugin is needed for the parity test. */
const hasUpstream = (await exists(
  "/opt/tokeneconomizer/tokeneconomizer/plugin/paths.py",
)) && (await runs("python3", ["--version"]));

// Ignored when the vendored plugin at /opt/tokeneconomizer is absent: the key
// must match the upstream's, and there is no upstream to compare with.
Deno.test({
  name:
    "repo keys: learningsRepoKey matches the upstream plugin for seven URL shapes",
  ignore: !hasUpstream,
  fn: async () => {
    const urls = [
      "https://x-access-token:ghs_abc@github.com/stSoftwareAU/VibeCoder.git",
      "git@github.com:stSoftwareAU/VibeCoder.git",
      "https://github.com/stsoftwareau/vibecoder/",
      "https://github.com/Owner/My.Repo_X.git/",
      "https://github.com/Owner/My.Repo_X",
      "ssh://git@github.com/Owner/My.Repo_X.git",
      "https://github.com/stSoftwareAU/VibeCoder",
    ];
    // -I ignores PYTHONPATH and the current directory, so nothing local is imported.
    const run = await new Deno.Command("python3", {
      args: ["-I", "-c", UPSTREAM_KEYS_SCRIPT, JSON.stringify(urls)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    assert(run.success, decoder.decode(run.stderr));
    const upstream: string[] = JSON.parse(decoder.decode(run.stdout));
    assertEquals(upstream.length, urls.length);
    for (const [index, url] of urls.entries()) {
      assertEquals(await learningsRepoKey(url), upstream[index], url);
    }
    assertEquals(upstream[0], KEY_A);
    assertEquals(upstream[3], KEY_B);
  },
});

Deno.test("normal transfers refuse a repos symlink without reading or modifying outside state", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "ancestor-store");
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: '{"store":1}\n',
    });
    const log = capture();
    const outside = join(root, "outside");
    await Deno.mkdir(join(outside, KEY_A, "claude"), { recursive: true });
    const file = join(outside, KEY_A, "claude/a.json");
    await Deno.writeTextFile(file, '{"outside":1}\n');
    await Deno.mkdir(join(root, "pull-link-home"));
    await Deno.symlink(outside, join(root, "pull-link-home/repos"));
    const refused = await pullLearnings(
      pullOpts(root, "pull-link", KEY_A, store.url, log.logger),
    );
    assertEquals(refused.status, "unavailable");
    assertStringIncludes(refused.reason, "plain directory");
    assertEquals(await Deno.readTextFile(file), '{"outside":1}\n');
    const clean = await pullLearnings(
      pullOpts(root, "push-link", KEY_A, store.url, log.logger),
    );
    assertEquals(clean.status, "restored");
    await Deno.remove(join(root, "push-link-home/repos"), { recursive: true });
    await Deno.symlink(outside, join(root, "push-link-home/repos"));
    const out = await pushLearnings(
      pushOpts(root, "push-link", clean, log.logger, recorder().stop),
    );
    assertEquals(out.kind, "skipped");
    assertEquals(await commitCount(store.dir), 1);
    assertEquals(
      await git([
        "-C",
        store.dir,
        "show",
        `main:token-economizer/${KEY_A}/claude/a.json`,
      ]),
      '{"store":1}\n',
    );
    assertEquals(await Deno.readTextFile(file), '{"outside":1}\n');
  }));
