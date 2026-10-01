/**
 * Tests for `discardBrokenClone` (Issue #2848).
 *
 * A clone directory that exists but holds no git repository — an interrupted
 * clone, or a `.git` left corrupt — wedged every run at setup: it passed the
 * "already cloned" check, and every git call in it then failed with
 * `not a git repository … Stopping at filesystem boundary`. The helper removes
 * such a directory so the caller clones afresh, and never touches a real one.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { discardBrokenClone, probeCorruptClone } from "../lib/broken_clone.ts";
import {
  cloneRecoveryStatePath,
  formatCloneCorruptRepeat,
  isCloneCorruption,
  parseCloneCorruptRepeat,
  recoverCorruptClone,
} from "../lib/corrupt_clone_recovery.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("discardBrokenClone - removes a directory that holds no repository", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    await Deno.writeTextFile(`${repoPath}/README.md`, "half a clone\n");

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - removes a directory whose .git is corrupt", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(`${repoPath}/.git`, { recursive: true });

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - leaves a real repository untouched", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: repoPath,
    }).output();
    assertEquals(init.code, 0);

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, false);
    assertEquals(await exists(`${repoPath}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - a directory nested in another repository is still broken", async () => {
  // The parent's repository must not vouch for a clone that has none.
  const workDir = await Deno.makeTempDir();
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: workDir,
    }).output();
    assertEquals(init.code, 0);
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
    assertEquals(await exists(`${workDir}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - a missing directory is nothing to discard", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const result = await discardBrokenClone(`${workDir}/widget`);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// --- probeCorruptClone (Issue #2957) ---

Deno.test("probeCorruptClone - a garbage .git/config line is reported", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: repoPath,
    }).output();
    assertEquals(init.code, 0);
    await Deno.writeTextFile(`${repoPath}/.git/config`, "garbage first line\n");

    const message = await probeCorruptClone(repoPath);

    assert(message !== null);
    assert(message.includes("bad config line"));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("probeCorruptClone - a healthy repository is not corrupt", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: repoPath,
    }).output();
    assertEquals(init.code, 0);

    assertEquals(await probeCorruptClone(repoPath), null);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("probeCorruptClone - a missing path is not corrupt", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    assertEquals(await probeCorruptClone(`${workDir}/widget`), null);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// --- isCloneCorruption (Issue #2957) ---

Deno.test("isCloneCorruption - classifies git failure messages", () => {
  assertEquals(
    isCloneCorruption("fatal: bad config line 1 in file .git/config"),
    true,
  );
  assertEquals(
    isCloneCorruption("fatal: bad object refs/heads/main"),
    true,
  );
  assertEquals(
    isCloneCorruption("fatal: Authentication failed"),
    false,
  );
});

// --- recoverCorruptClone (Issue #2957) ---

async function initRepo(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  const init = await new Deno.Command("git", {
    args: ["init", "-q"],
    cwd: path,
  }).output();
  assertEquals(init.code, 0);
}

Deno.test("recoverCorruptClone - moves a corrupt clone aside and records the recovery", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const start = new Date("2026-10-01T12:00:00.000Z");

    const result = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    const aside = `${repoPath}.corrupt-20261001T120000Z`;
    assertEquals(result.value, aside);
    assertEquals(await exists(`${aside}/.git`), true);
    assertEquals(await exists(repoPath), false);

    const statePath = cloneRecoveryStatePath(workDir, "test-host");
    const state = JSON.parse(await Deno.readTextFile(statePath));
    assertEquals(state["org/widget"], {
      at: start.toISOString(),
      gitMessage: "fatal: bad config line 1 in file .git/config",
      aside,
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - does not re-clone within 24 h", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const start = new Date("2026-10-01T12:00:00.000Z");

    const first = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );
    assert(first.ok, first.ok ? "" : first.error.message);

    await initRepo(repoPath);
    const laterSameDay = new Date(start.getTime() + 60 * 60 * 1000);
    const second = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => laterSameDay, hostname: "test-host" },
    );

    assertEquals(second.ok, false);
    assert(
      !second.ok &&
        second.error.message.includes(
          "fatal: bad config line 1 in file .git/config",
        ),
    );
    assertEquals(await exists(`${repoPath}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - re-clones again after 24 h and keeps only the latest sibling", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const start = new Date("2026-10-01T12:00:00.000Z");

    const first = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );
    assert(first.ok, first.ok ? "" : first.error.message);

    await initRepo(repoPath);
    const next = new Date(start.getTime() + 25 * 60 * 60 * 1000);
    const second = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => next, hostname: "test-host" },
    );
    assert(second.ok, second.ok ? "" : second.error.message);

    const siblings: string[] = [];
    for await (const entry of Deno.readDir(workDir)) {
      if (entry.name.startsWith("widget.corrupt-")) siblings.push(entry.name);
    }
    assertEquals(siblings.length, 1);
    assert(second.ok && siblings[0] === "widget.corrupt-20261002T130000Z");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - leaves an unrelated sibling untouched", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    await initRepo(`${workDir}/other.corrupt-20260101T000000Z`);
    await initRepo(`${workDir}/repo-two`);
    const start = new Date("2026-10-01T12:00:00.000Z");

    const result = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(
      await exists(`${workDir}/other.corrupt-20260101T000000Z/.git`),
      true,
    );
    assertEquals(await exists(`${workDir}/repo-two/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - a failed rename names the path", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    // repoPath never created — the rename must fail.
    const start = new Date("2026-10-01T12:00:00.000Z");

    const result = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );

    assertEquals(result.ok, false);
    assert(!result.ok && result.error.message.includes(repoPath));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - an unreadable state file fails loud without moving anything", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const statePath = cloneRecoveryStatePath(workDir, "h");
    // A directory where the state file should be: readTextFile fails with a
    // non-NotFound error, which must not be mistaken for "no state yet".
    await Deno.mkdir(statePath);

    const result = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => new Date("2026-10-01T12:00:00.000Z"), hostname: "h" },
    );

    assertEquals(result.ok, false);
    assert(!result.ok && result.error.message.includes(statePath));
    assertEquals(await exists(`${repoPath}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// --- clone-corrupt-repeat payload (Issue #2958) ---

Deno.test("formatCloneCorruptRepeat / parseCloneCorruptRepeat - round-trip", () => {
  const repeat = {
    repo: "org/widget",
    host: "test-host",
    previousAt: "2026-10-01T12:00:00.000Z",
    previousGitMessage: "fatal: bad config line 1 in file .git/config",
    aside: "/work/widget.corrupt-20261001T120000Z",
    currentAt: "2026-10-01T13:00:00.000Z",
    currentGitMessage: "fatal: bad object refs/heads/main",
  };

  const formatted = formatCloneCorruptRepeat(repeat);

  assert(formatted.startsWith("clone-corrupt-repeat: "));
  assertEquals(parseCloneCorruptRepeat(formatted), repeat);
  assertEquals(
    parseCloneCorruptRepeat(`some prose\n${formatted}\nmore prose`),
    repeat,
  );
});

Deno.test("parseCloneCorruptRepeat - null when the marker is absent", () => {
  assertEquals(parseCloneCorruptRepeat("no payload here"), null);
});

Deno.test("parseCloneCorruptRepeat - null for malformed JSON", () => {
  assertEquals(
    parseCloneCorruptRepeat("clone-corrupt-repeat: {not json"),
    null,
  );
});

Deno.test("parseCloneCorruptRepeat - null when a required field has the wrong type", () => {
  assertEquals(
    parseCloneCorruptRepeat(
      'clone-corrupt-repeat: {"repo":1,"host":"h","previousAt":"a","currentAt":"b","currentGitMessage":"c"}',
    ),
    null,
  );
});

Deno.test("parseCloneCorruptRepeat - null when an optional field has the wrong type", () => {
  assertEquals(
    parseCloneCorruptRepeat(
      'clone-corrupt-repeat: {"repo":"r","host":"h","previousAt":"a","currentAt":"b","currentGitMessage":"c","aside":42}',
    ),
    null,
  );
});

Deno.test("recoverCorruptClone - legacy string state still enforces the cap, with no previousGitMessage/aside", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const statePath = cloneRecoveryStatePath(workDir, "test-host");
    const start = new Date("2026-10-01T12:00:00.000Z");
    await Deno.writeTextFile(
      statePath,
      JSON.stringify({ "org/widget": start.toISOString() }),
    );

    const laterSameDay = new Date(start.getTime() + 60 * 60 * 1000);
    const result = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad object refs/heads/main",
      { now: () => laterSameDay, hostname: "test-host" },
    );

    assertEquals(result.ok, false);
    assert(!result.ok);
    const repeat = parseCloneCorruptRepeat(result.error.message);
    assert(repeat !== null);
    assertEquals(repeat.repo, "org/widget");
    assertEquals(repeat.host, "test-host");
    assertEquals(repeat.previousAt, start.toISOString());
    assertEquals(repeat.previousGitMessage, undefined);
    assertEquals(repeat.aside, undefined);
    assertEquals(repeat.currentAt, laterSameDay.toISOString());
    assertEquals(repeat.currentGitMessage, "fatal: bad object refs/heads/main");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverCorruptClone - a successful recovery's state yields previousAt/previousGitMessage/aside on the next cap refusal", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await initRepo(repoPath);
    const start = new Date("2026-10-01T12:00:00.000Z");

    const first = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad config line 1 in file .git/config",
      { now: () => start, hostname: "test-host" },
    );
    assert(first.ok, first.ok ? "" : first.error.message);
    const expectedAside = first.ok ? first.value : "";

    await initRepo(repoPath);
    const laterSameDay = new Date(start.getTime() + 60 * 60 * 1000);
    const second = await recoverCorruptClone(
      "org/widget",
      repoPath,
      workDir,
      "fatal: bad object refs/heads/main",
      { now: () => laterSameDay, hostname: "test-host" },
    );

    assertEquals(second.ok, false);
    assert(!second.ok);
    const repeat = parseCloneCorruptRepeat(second.error.message);
    assert(repeat !== null);
    assertEquals(repeat.previousAt, start.toISOString());
    assertEquals(
      repeat.previousGitMessage,
      "fatal: bad config line 1 in file .git/config",
    );
    assertEquals(repeat.aside, expectedAside);
    assertEquals(repeat.currentAt, laterSameDay.toISOString());
    assertEquals(repeat.currentGitMessage, "fatal: bad object refs/heads/main");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
