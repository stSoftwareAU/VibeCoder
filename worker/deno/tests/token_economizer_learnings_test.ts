/**
 * Tests for token_economizer_learnings.ts (Issue #4957).
 *
 * Every transfer runs against a real local bare repository in a temp directory,
 * with real git, and the secret case runs the real gitleaks. Visibility and the
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
  type VisibilityVerdict,
} from "../lib/token_economizer_learnings.ts";
import type { TokenEconomizerFinding } from "../lib/token_economizer_control.ts";
import {
  stopTokenEconomizerTrial,
  tokenEconomizerMaySync,
} from "../lib/token_economizer_control.ts";
import { readTokenEconomizerStop } from "../lib/token_economizer_plugin.ts";

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
    ...extra,
  };
}

Deno.test("acceptance: a run pushes its state, a later run restores it, and another key stays isolated", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
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
    assertEquals(pB.status, "restored");
    assertEquals(
      await exists(join(root, "runB-home", "repos", KEY_A)),
      false,
    );
    assertEquals(
      await exists(join(root, "runB-scratch", "token-economizer", KEY_A)),
      false,
    );
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

Deno.test("stopped: a planted GitHub PAT stops the trial, is not committed and is never recorded", () =>
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
      pushOpts(root, "secret", p, log.logger, stops.stop),
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

    // Run X changes a.json and pushes first.
    await plant(join(root, "x-home"), KEY_A, "claude/a.json", '{"x":2}\n');
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
      assert(log.warnings.length > 0, name);
    }
  }));

Deno.test("refused: a latched trial neither pulls nor pushes", () =>
  withRoot(async (root) => {
    const store = await newStore(root, "store");
    await commitToStore(root, store.url, {
      [`token-economizer/${KEY_A}/claude/a.json`]: '{"a":1}\n',
    });
    let checks = 0;
    const countingCheck = () => {
      checks++;
      return Promise.resolve<VisibilityVerdict>({ private: true });
    };
    const log = capture();

    const latched = await pullLearnings(
      pullOpts(root, "latched", KEY_A, store.url, log.logger, {
        mayTransfer: NEVER,
        checkVisibility: countingCheck,
      }),
    );
    assertEquals(latched.status, "refused");
    assertStringIncludes(latched.reason, "latched");
    assertEquals(checks, 0);
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
