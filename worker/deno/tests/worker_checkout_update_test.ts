/**
 * Tests for the host-side `worker-checkout-update` command (Issue #512).
 *
 * The worker checkout is updated from *inside* the container today, which is
 * the only reason `/workspace` is mounted read-write — and since the fleet
 * self-update rewrites `run.sh`, code the **host** executes, that mount is a
 * container→host escape path. This command moves the update to the host so
 * the checkout can later be mounted read-only.
 *
 * Every test runs the real command against a real temporary git repository:
 * a fresh clone, a dirty tree, a detached HEAD, a clone missing `origin/HEAD`,
 * an unreachable remote, a directory that is not a checkout at all, and a
 * checkout the operator has turned the update off for.
 *
 * Issue #624 adds the frozen host: a `.config.json` carrying
 * `update_mode: "frozen"` holds the checkout at `pinned_ref` — a tag or a
 * commit SHA — rather than resetting it to the tip, says so in `run_core.log`,
 * and fails loudly on a pin that does not resolve or a mode that cannot be
 * read.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  SKIP_CHECKOUT_UPDATE_ENV,
  updateWorkerCheckout,
} from "../commands/worker_checkout_update.ts";

/** A bare remote on `trunk` plus a clone of it, in a fresh temp directory. */
async function makeCheckout(): Promise<{
  tmp: string;
  remote: string;
  seed: string;
  clone: string;
  logDir: string;
}> {
  const tmp = await Deno.makeTempDir({ prefix: "checkout_update_test_" });
  const remote = `${tmp}/remote.git`;
  const seed = `${tmp}/seed`;
  const clone = `${tmp}/clone`;
  const logDir = `${tmp}/logs`;

  // A deliberately unusual default branch name: nothing may assume `main`.
  await runGitCommand(["init", "--bare", "--initial-branch=trunk", remote]);
  await runGitCommand(["init", "--initial-branch=trunk", seed]);
  await Deno.writeTextFile(`${seed}/file.txt`, "one\n");
  await runGitCommand(["add", "file.txt"], { cwd: seed });
  await runGitCommand(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"],
    { cwd: seed },
  );
  await runGitCommand(["push", remote, "trunk"], { cwd: seed });
  await runGitCommand(["clone", "--quiet", remote, clone]);

  return { tmp, remote, seed, clone, logDir };
}

/** Push a second commit to the remote, so the clone has something to fetch. */
async function pushSecondCommit(seed: string, remote: string): Promise<void> {
  await Deno.writeTextFile(`${seed}/file.txt`, "two\n");
  await runGitCommand(["add", "file.txt"], { cwd: seed });
  await runGitCommand(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "two"],
    { cwd: seed },
  );
  await runGitCommand(["push", remote, "trunk"], { cwd: seed });
}

/** The commit a checkout is sitting on. */
async function headSha(repoDir: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "HEAD"], { cwd: repoDir });
  assert(result.ok && result.value.code === 0, "cannot read HEAD");
  return result.value.stdout.trim();
}

/** The branch a checkout is on (`HEAD` when detached). */
async function currentBranch(repoDir: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoDir,
  });
  assert(result.ok && result.value.code === 0, "cannot read the branch");
  return result.value.stdout.trim();
}

/** Is there anything at this path? */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("worker-checkout-update - fast-forwards a clone to origin's default branch", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    await pushSecondCommit(seed, remote);
    const before = await headSha(clone);

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.branch, "trunk");
    assertEquals(result.data?.updated, true);
    assertEquals(await currentBranch(clone), "trunk");
    assert(
      (await headSha(clone)) !== before,
      "the checkout must have moved to the new origin commit",
    );
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "two\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - discards local modifications and untracked files", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await Deno.writeTextFile(`${clone}/file.txt`, "locally hacked\n");
    await Deno.writeTextFile(`${clone}/scratch.txt`, "left behind\n");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "one\n");
    assertEquals(
      await exists(`${clone}/scratch.txt`),
      false,
      "the untracked file must have been cleaned away",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - returns a detached HEAD to the default branch", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await runGitCommand(["checkout", "--detach", "HEAD"], { cwd: clone });
    assertEquals(await currentBranch(clone), "HEAD");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(await currentBranch(clone), "trunk");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - repairs a clone that has no origin/HEAD", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await runGitCommand(
      ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
      { cwd: clone },
    );

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.branch, "trunk");
    const head = await runGitCommand(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: clone },
    );
    assert(head.ok && head.value.code === 0, "origin/HEAD must be recorded");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - honours an explicit --default-branch override", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    await runGitCommand(["checkout", "-b", "side"], { cwd: seed });
    await Deno.writeTextFile(`${seed}/file.txt`, "side\n");
    await runGitCommand(["add", "file.txt"], { cwd: seed });
    await runGitCommand(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "side"],
      { cwd: seed },
    );
    await runGitCommand(["push", remote, "side"], { cwd: seed });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
      "default-branch": "side",
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.branch, "side");
    assertEquals(await currentBranch(clone), "side");
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "side\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - fails loud when the remote is unreachable", async () => {
  const { tmp, remote, clone, logDir } = await makeCheckout();
  try {
    // The remote goes away entirely: `git fetch` cannot succeed.
    await Deno.remove(remote, { recursive: true });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, clone);
    // The checkout is left exactly as it was — a failed update never
    // half-applies.
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "one\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - refuses a directory that is not a git checkout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "checkout_update_test_" });
  try {
    const result = await updateWorkerCheckout({
      "base-dir": tmp,
      "log-dir": `${tmp}/logs`,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "not a git checkout");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - requires --base-dir", async () => {
  const result = await updateWorkerCheckout({});
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--base-dir");
});

Deno.test(`worker-checkout-update - ${SKIP_CHECKOUT_UPDATE_ENV} leaves the checkout untouched`, async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  const previous = Deno.env.get(SKIP_CHECKOUT_UPDATE_ENV);
  try {
    await pushSecondCommit(seed, remote);
    await Deno.writeTextFile(`${clone}/uncommitted.txt`, "work in progress\n");
    const before = await headSha(clone);
    Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, "1");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    // A skip is a stated outcome, not a silent one.
    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.updated, false);
    assertStringIncludes(result.message, SKIP_CHECKOUT_UPDATE_ENV);
    assertEquals(await headSha(clone), before, "the checkout must not move");
    assertEquals(await exists(`${clone}/uncommitted.txt`), true);
  } finally {
    if (previous === undefined) {
      Deno.env.delete(SKIP_CHECKOUT_UPDATE_ENV);
    } else {
      Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, previous);
    }
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test(`worker-checkout-update - ${SKIP_CHECKOUT_UPDATE_ENV}=0 does not turn the update off`, async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  const previous = Deno.env.get(SKIP_CHECKOUT_UPDATE_ENV);
  try {
    await pushSecondCommit(seed, remote);
    Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, "0");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.updated, true);
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "two\n");
  } finally {
    if (previous === undefined) {
      Deno.env.delete(SKIP_CHECKOUT_UPDATE_ENV);
    } else {
      Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, previous);
    }
    await Deno.remove(tmp, { recursive: true });
  }
});

// ============================================================================
// Frozen mode — hold the checkout at the pinned ref (Issue #624, part of #583)
// ============================================================================

/** Write a `.config.json` holding the given update-mode keys. */
async function writeConfig(
  repoDir: string,
  config: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(
    `${repoDir}/.config.json`,
    JSON.stringify(config, null, 2),
  );
}

/** Tag the seed's current commit and push the tag to the remote. */
async function pushTag(
  seed: string,
  remote: string,
  tag: string,
): Promise<void> {
  await runGitCommand(["tag", tag], { cwd: seed });
  await runGitCommand(["push", remote, tag], { cwd: seed });
}

/** The `run_core.log` this run wrote, or "" when there is none. */
async function runCoreLog(logDir: string): Promise<string> {
  try {
    return await Deno.readTextFile(`${logDir}/run_core.log`);
  } catch {
    return "";
  }
}

Deno.test("worker-checkout-update - frozen holds the checkout at a pinned tag (Issue #624)", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    const pinnedSha = await headSha(seed);
    await pushTag(seed, remote, "v1.0.0");
    // The default branch moves on: dynamic mode would drag the checkout here.
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: "v1.0.0",
    });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.mode, "frozen");
    assertEquals(result.data?.ref, "v1.0.0");
    assertEquals(await headSha(clone), pinnedSha, "the pin, not the tip");
    assertEquals(await currentBranch(clone), "HEAD", "detached on the pin");
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "one\n");
    assertStringIncludes(
      await runCoreLog(logDir),
      "Checkout update skipped: update_mode=frozen, pinned to v1.0.0",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - frozen holds the checkout at a pinned commit SHA (Issue #624)", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    const pinnedSha = await headSha(seed);
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: pinnedSha,
    });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.ref, pinnedSha);
    assertEquals(await headSha(clone), pinnedSha);
    assertStringIncludes(
      await runCoreLog(logDir),
      `Checkout update skipped: update_mode=frozen, pinned to ${pinnedSha}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - frozen leaves a checkout already on the pin untouched (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    const pinnedSha = await headSha(clone);
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: pinnedSha,
    });
    // A tree that is *not* reset: a churn-free launch leaves this in place.
    await Deno.writeTextFile(`${clone}/scratch.txt`, "left alone\n");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(await headSha(clone), pinnedSha);
    assertEquals(
      await exists(`${clone}/scratch.txt`),
      true,
      "a checkout already on the pin must not be written to at all",
    );
    assertStringIncludes(
      await runCoreLog(logDir),
      "Checkout update skipped: update_mode=frozen",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - frozen fails loud on a pinned ref that does not resolve (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    const before = await headSha(clone);
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: "v9.9.9-does-not-exist",
    });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "v9.9.9-does-not-exist");
    assertStringIncludes(result.message, "pinned_ref");
    // run.sh warns on the non-zero exit and launches on this checkout.
    assertEquals(
      await headSha(clone),
      before,
      "the checkout is left as it was",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - dynamic mode in .config.json is the update it always was (Issue #624)", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, { update_mode: "dynamic" });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.mode, "dynamic");
    assertEquals(result.data?.branch, "trunk");
    assertEquals(await currentBranch(clone), "trunk");
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "two\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - a .config.json without update_mode is dynamic (Issue #624)", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, { repos: ["stSoftwareAU/VibeCoder"] });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.mode, "dynamic");
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "two\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - an unreadable update mode fails loud rather than resetting a pinned host (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    const before = await headSha(clone);
    await Deno.writeTextFile(`${clone}/.config.json`, "{ not json");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "invalid JSON");
    assertEquals(await headSha(clone), before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - an unrecognised update_mode names the accepted values (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await writeConfig(clone, { update_mode: "glacial" });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "glacial");
    assertStringIncludes(result.message, "dynamic");
    assertStringIncludes(result.message, "frozen");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - frozen without a pinned_ref fails loud naming the field (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await writeConfig(clone, { update_mode: "frozen" });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "pinned_ref");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - a pinned_ref carrying shell metacharacters is refused (Issue #624)", async () => {
  const { tmp, clone, logDir } = await makeCheckout();
  try {
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: "v1.0.0; rm -rf /",
    });

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "pinned_ref");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test(`worker-checkout-update - ${SKIP_CHECKOUT_UPDATE_ENV} wins over frozen mode (Issue #624)`, async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  const previous = Deno.env.get(SKIP_CHECKOUT_UPDATE_ENV);
  try {
    await pushTag(seed, remote, "v1.0.0");
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, {
      update_mode: "frozen",
      pinned_ref: "v1.0.0",
    });
    const before = await headSha(clone);
    Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, "1");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.data?.updated, false);
    assertStringIncludes(result.message, SKIP_CHECKOUT_UPDATE_ENV);
    assertEquals(await headSha(clone), before, "the checkout must not move");
    assertEquals(
      await exists(`${clone}/.config.json`),
      true,
      "the skip does not touch the checkout at all",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete(SKIP_CHECKOUT_UPDATE_ENV);
    } else {
      Deno.env.set(SKIP_CHECKOUT_UPDATE_ENV, previous);
    }
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-checkout-update - frozen moves a dirty checkout that has drifted off the pin (Issue #624)", async () => {
  const { tmp, remote, seed, clone, logDir } = await makeCheckout();
  try {
    const pinnedSha = await headSha(seed);
    await pushSecondCommit(seed, remote);
    await writeConfig(clone, { update_mode: "frozen", pinned_ref: pinnedSha });
    // The checkout has drifted to the tip and someone left work behind.
    await runGitCommand(["fetch", "origin"], { cwd: clone });
    await runGitCommand(["reset", "--hard", "origin/trunk"], { cwd: clone });
    await Deno.writeTextFile(`${clone}/file.txt`, "locally hacked\n");

    const result = await updateWorkerCheckout({
      "base-dir": clone,
      "log-dir": logDir,
    });

    assertEquals(result.success, true, result.message);
    assertEquals(await headSha(clone), pinnedSha);
    assertEquals(await Deno.readTextFile(`${clone}/file.txt`), "one\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
