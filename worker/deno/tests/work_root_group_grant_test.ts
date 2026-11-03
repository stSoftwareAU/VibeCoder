/**
 * What the untrusted account is granted on the shared work volume
 * (Issue #1384).
 *
 * `container/entrypoint.sh` hands the `vibework` group — the group the
 * `agent` account runs repository-controlled code under (Issue #571) — a
 * grant over the work root at every launch. The grant used to be the same
 * for every top-level directory on the volume, so the worker's OWN state
 * directories were handed group write alongside the repository clones the
 * quality gate legitimately writes into: the hash-chained audit journal
 * (`audit/`), the self-heal log directory (`logs/`) and the lane worktree
 * root (`worktrees/`) another slot may be running out of.
 *
 * It also covers the HOME traverse grant (Issue #4733): the image creates HOME
 * 0700, so the `agent` account could not reach the clones under
 * `~/auto-issue-work`. The entrypoint gives the `vibework` group traverse-only
 * (g+x) on HOME, and the tests assert that HOME gains exactly that and nothing
 * more. Opening HOME is only safe once its other children are closed, so the
 * log mount root and the two state volume roots must carry no group or other
 * access, and HOME stays shut when one of them cannot be closed. The same
 * entrypoint bounds the clone roots (sticky bit; no group or other write on
 * `.git`), so the opened path does not reach trusted git metadata.
 *
 * Every case runs the real script with a stub PATH and asserts on the mode
 * bits the volume actually ends up with, so the grant is verified rather
 * than described.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { RESERVED_WORKDIR_NAMES } from "../lib/stale_workdir.ts";

const ENTRYPOINT = new URL("../../../container/entrypoint.sh", import.meta.url)
  .pathname;

/** Group write, group read+execute, and the setgid bit. */
const GROUP_WRITE = 0o020;
const GROUP_READ_EXECUTE = 0o050;
const SETGID = 0o2000;
const STICKY = 0o1000;
const OTHER_WRITE = 0o002;
/** Group and other read: what the untrusted account needs to read `.git`. */
const GROUP_OTHER_READ = 0o044;

/** Group traverse (x) only, the bit the HOME grant adds (Issue #4733). */
const GROUP_TRAVERSE = 0o010;
/** Group read+write and all other-user access: none may appear on HOME. */
const GROUP_RW_OTHER_ALL = 0o067;
/** Owner read, write and traverse. */
const OWNER_RWX = 0o700;

/**
 * A stub PATH the entrypoint's work-root block can actually run through.
 *
 * `getent` and `chgrp` are faked as successes — no test host owns a
 * `vibework` group, and without them the block short-circuits and there is
 * nothing to observe. `chmod` is the one that must be REAL: the assertions
 * read the mode bits off the volume afterwards, so the stub records the call
 * and then hands over to the system binary.
 */
async function stubBin(dir: string, chmodBody?: string): Promise<string> {
  const binDir = `${dir}/bin`;
  await Deno.mkdir(binDir, { recursive: true });
  const write = async (name: string, body: string) => {
    await Deno.writeTextFile(`${binDir}/${name}`, body);
    await Deno.chmod(`${binDir}/${name}`, 0o755);
  };
  await write("deno", "#!/bin/bash\nexit 0\n");
  await write("getent", "#!/bin/bash\nexit 0\n");
  await write("chgrp", "#!/bin/bash\nexit 0\n");
  await write(
    "chmod",
    chmodBody ?? '#!/bin/bash\nexec /bin/chmod "$@"\n',
  );
  return binDir;
}

/** Create the throwaway worker checkout the entrypoint points at. */
async function fakeRepo(dir: string): Promise<void> {
  await Deno.mkdir(`${dir}/repo/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${dir}/repo/worker/deno/mod.ts`, "// stub\n");
  await Deno.writeTextFile(`${dir}/repo/worker/deno/deno.lock`, "{}\n");
}

/** The HOME children that hold worker state (Issue #4733 review). */
const STATE_CHILDREN = [
  "logs",
  "auto-issue-work-agent-state",
  "auto-issue-work-approval-state",
] as const;

/**
 * Lay out a work root that mixes tenant clones with the worker's own state,
 * run the entrypoint over it, and return the work root path and its stderr.
 *
 * HOME starts 0700 with its state children at the 0755 a fresh mount root
 * has, so every assertion observes a real change. A repository clone carries a
 * world-writable git directory, so the `.git` hardening is observable too.
 */
async function runEntrypoint(
  dir: string,
  chmodBody?: string,
  workerUid?: number,
  foreignGit = false,
  failMove = false,
): Promise<{ workRoot: string; stderr: string }> {
  const binDir = await stubBin(dir, chmodBody);
  if (workerUid !== undefined) {
    // Simulate a worker uid different from the fixture owner when needed.
    await Deno.writeTextFile(
      `${binDir}/id`,
      `#!/bin/bash\necho ${workerUid}\n`,
    );
    await Deno.chmod(`${binDir}/id`, 0o755);
  }
  if (foreignGit) {
    // Simulate foreign git metadata while retaining real root ownership checks.
    await Deno.writeTextFile(
      `${binDir}/find`,
      '#!/bin/bash\nif [[ "$1" == */.git && ( "$2" == "-maxdepth" || "$2" == "-prune" ) ]]; then if [[ "$*" != *"-user "* || "$*" == *"! -user "* ]]; then printf "%s\\n" "$1"; fi; else exec /usr/bin/find "$@"; fi\n',
    );
    await Deno.chmod(`${binDir}/find`, 0o755);
  }
  if (failMove) {
    await Deno.writeTextFile(`${binDir}/mv`, "#!/bin/bash\nexit 1\n");
    await Deno.chmod(`${binDir}/mv`, 0o755);
  }
  await fakeRepo(dir);
  const home = `${dir}/home`;
  const workRoot = `${home}/auto-issue-work`;
  // The image's HOME carries the grant (Issue #4733); the fixture starts at
  // the older 0700 so the entrypoint fallback is the thing under test.
  await Deno.mkdir(home, { recursive: true });
  await Deno.chmod(home, OWNER_RWX);
  for (const child of STATE_CHILDREN) {
    await Deno.mkdir(`${home}/${child}`, { recursive: true });
    await Deno.chmod(`${home}/${child}`, 0o755);
  }
  for (
    const name of [
      "NEAT-AI",
      "NEAT-AI-Discovery",
      ...RESERVED_WORKDIR_NAMES,
    ]
  ) {
    await Deno.mkdir(`${workRoot}/${name}`, { recursive: true });
    await Deno.chmod(`${workRoot}/${name}`, 0o755);
  }
  // A clone's git metadata at the group- and other-writable modes a careless
  // clone would leave it at, so the hardening has something to strip
  // (Issue #4737).
  await fakeGitDir(`${workRoot}/NEAT-AI/.git`);
  // A linked worktree: `.git` is a file holding a `gitdir:` pointer.
  await Deno.mkdir(`${workRoot}/LINKED`, { recursive: true });
  await Deno.chmod(`${workRoot}/LINKED`, 0o755);
  await Deno.writeTextFile(
    `${workRoot}/LINKED/.git`,
    "gitdir: /nonexistent/worktrees/LINKED\n",
  );
  await Deno.chmod(`${workRoot}/LINKED/.git`, 0o664);
  await Deno.mkdir(`${dir}/tmp`, { recursive: true });

  const { success, stderr } = await new Deno.Command("/bin/bash", {
    args: [ENTRYPOINT],
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: `${dir}/tmp`,
      VIBE_BASE_DIR: `${dir}/repo`,
    },
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stderr);
  await Deno.writeTextFile(`${dir}/stderr`, text);
  assert(success, text);
  return { workRoot, stderr: text };
}

async function runOverWorkRoot(
  dir: string,
  workerUid?: number,
  foreignGit = false,
  failMove = false,
): Promise<string> {
  return (await runEntrypoint(dir, undefined, workerUid, foreignGit, failMove))
    .workRoot;
}

/** The mode bits of one work-root entry after the entrypoint has run. */
async function modeOf(workRoot: string, name: string): Promise<number> {
  const stat = await Deno.stat(`${workRoot}/${name}`);
  const mode = stat.mode;
  assert(mode !== null, "no mode bits on this platform");
  return mode;
}

/** Create a git directory with the modes a careless clone would leave it at. */
async function fakeGitDir(gitDir: string): Promise<void> {
  await Deno.mkdir(`${gitDir}/hooks`, { recursive: true });
  await Deno.mkdir(`${gitDir}/objects`, { recursive: true });
  await Deno.writeTextFile(`${gitDir}/config`, "[core]\n\tbare = false\n");
  await Deno.writeTextFile(
    `${gitDir}/hooks/pre-commit`,
    "#!/bin/sh\nexit 0\n",
  );
  for (const path of [gitDir, `${gitDir}/hooks`, `${gitDir}/objects`]) {
    await Deno.chmod(path, 0o775);
  }
  await Deno.chmod(`${gitDir}/config`, 0o666);
  await Deno.chmod(`${gitDir}/hooks/pre-commit`, 0o666);
}

/** The mode bits of an absolute path after the entrypoint has run. */
async function modeAt(path: string): Promise<number> {
  const mode = (await Deno.stat(path)).mode;
  assert(mode !== null, "no mode bits on this platform");
  return mode;
}

/** Every path under `root`, `root` itself included. */
async function pathsUnder(root: string): Promise<string[]> {
  const found = [root];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...(await pathsUnder(path)));
    } else {
      found.push(path);
    }
  }
  return found;
}

Deno.test("entrypoint - a repository clone stays writable by the untrusted account", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const clone of ["NEAT-AI", "NEAT-AI-Discovery"]) {
      const mode = await modeOf(workRoot, clone);
      assertEquals(
        mode & GROUP_WRITE,
        GROUP_WRITE,
        `${clone} lost the group write the quality gate needs`,
      );
      assertEquals(
        mode & SETGID,
        SETGID,
        `${clone} lost setgid, so new directories stop inheriting the group`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the worker's own state directories are never handed group write (Issue #1384)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const reserved of RESERVED_WORKDIR_NAMES) {
      const mode = await modeOf(workRoot, reserved);
      assertEquals(
        mode & GROUP_WRITE,
        0,
        `${reserved} is worker state, not a place repository code writes`,
      );
      assertEquals(
        mode & GROUP_READ_EXECUTE,
        GROUP_READ_EXECUTE,
        `${reserved} must stay traversable by the untrusted account`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the work root carries the sticky bit (Issue #1442)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const stat = await Deno.stat(workRoot);
    const mode = stat.mode;
    assert(mode !== null, "no mode bits on this platform");

    // Write permission on a directory governs rename and unlink of the
    // entries inside it, whatever mode each entry carries. Without `+t` the
    // untrusted account could rename or delete every sibling clone, the audit
    // journal and the session store — measured as succeeding on a live volume.
    assertEquals(mode & STICKY, STICKY, "the work root must be sticky");

    // And the grant it bounds is still there: the gate creates its own tier-2
    // data sibling in this directory, which needs group write on the root.
    assertEquals(
      mode & GROUP_WRITE,
      GROUP_WRITE,
      "removing group write would break the tier-2 sibling clone the gate makes",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Clone roots are sticky as well as group-writable (Issue #4737).
 *
 * Write permission on a directory governs renaming and unlinking the entries
 * inside it. The kernel's documented behaviour for a sticky directory is that
 * only the owner of an entry, the owner of the directory, or root may rename
 * or unlink that entry. This test checks the mode bits that produce that
 * denial, `+t` on each clone root with group write and setgid kept. It does not
 * exercise the denial itself, which would need a second uid.
 */
Deno.test("entrypoint - clone roots are sticky as well as group-writable (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const clone of ["NEAT-AI", "NEAT-AI-Discovery", "LINKED"]) {
      const mode = await modeOf(workRoot, clone);
      assertEquals(
        mode & STICKY,
        STICKY,
        `${clone} must be sticky, so agent cannot rename its .git aside`,
      );
      assertEquals(
        mode & GROUP_WRITE,
        GROUP_WRITE,
        `${clone} lost the group write the quality gate needs`,
      );
      assertEquals(
        mode & SETGID,
        SETGID,
        `${clone} lost setgid, so new directories stop inheriting the group`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Git metadata takes no group or other write (Issue #4737).
 *
 * The sticky bit stops `agent` renaming `.git`, but not writing into it. So
 * every file and directory under a clone's `.git`, and a linked worktree's
 * `.git` file, must carry no group or other write bit, and must stay readable
 * by them. Like the sticky-bit test, this asserts the mode bits that produce
 * the protection, not the kernel's denial itself.
 */
Deno.test("entrypoint - git metadata has no group or other write bits (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const gitPaths = [
      ...(await pathsUnder(`${workRoot}/NEAT-AI/.git`)),
      `${workRoot}/LINKED/.git`,
    ];
    assert(
      gitPaths.length >= 6,
      `the .git fixture was not walked in full: ${gitPaths.join(", ")}`,
    );
    for (const path of gitPaths) {
      const mode = await modeAt(path);
      assertEquals(
        mode & (GROUP_WRITE | OTHER_WRITE),
        0,
        `${path} is writable by the untrusted account`,
      );
      assertEquals(
        mode & GROUP_OTHER_READ,
        GROUP_OTHER_READ,
        `${path} must stay readable by the untrusted account`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The reserved work-root names gain no sticky bit (Issue #4737). The sticky
 * requirement applies to clone roots only; the reserved-names branch is
 * unchanged from before it.
 */
Deno.test("entrypoint - reserved work-root names gain no sticky bit (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const reserved of RESERVED_WORKDIR_NAMES) {
      const mode = await modeOf(workRoot, reserved);
      assertEquals(
        mode & STICKY,
        0,
        `${reserved} is worker state, not a clone root, so it takes no sticky bit`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * A git directory the worker does not own is not trusted (Issue #4737).
 *
 * `chmod g-w,o-w` fails on files the untrusted account owns, so a clone whose
 * `.git` was swapped before the hardening would stay writable and trusted via
 * `safe.directory '*'`. The entrypoint must notice, warn, and take the clone
 * out of service rather than rely on the silent chmod.
 */
Deno.test("entrypoint - a clone whose git directory the worker does not own is quarantined (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const uid = (await Deno.stat(dir)).uid;
    assert(uid !== null && uid !== 0, "test requires a non-root uid");
    const workRoot = await runOverWorkRoot(dir, uid, true);
    for (const clone of ["NEAT-AI", "LINKED"]) {
      let stillThere = true;
      try {
        await Deno.stat(`${workRoot}/${clone}`);
      } catch {
        stillThere = false;
      }
      assert(!stillThere, `${clone} kept its trusted place in the work root`);
    }
    const quarantined = [];
    for await (const entry of Deno.readDir(workRoot)) {
      if (entry.name.startsWith(".untrusted-")) quarantined.push(entry.name);
    }
    assertEquals(quarantined.length, 2, quarantined.join(", "));
    for (const name of quarantined) {
      const mode = await modeAt(`${workRoot}/${name}`);
      assertEquals(
        mode & 0o077,
        0,
        `${name} must give the untrusted account no access`,
      );
    }
    // A clone with no git directory of its own is not touched.
    await Deno.stat(`${workRoot}/NEAT-AI-Discovery`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a failed quarantine warns and disables the clone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const uid = (await Deno.stat(dir)).uid;
    assert(uid !== null && uid !== 0);
    const workRoot = await runOverWorkRoot(dir, uid, true, true);
    assert(
      (await Deno.readTextFile(`${dir}/stderr`)).includes(
        "could not quarantine",
      ),
    );
    for (const clone of ["NEAT-AI", "LINKED"]) {
      assertEquals((await modeOf(workRoot, clone)) & 0o777, 0);
      await Deno.chmod(`${workRoot}/${clone}`, 0o700);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - leaves foreign-owned data siblings in place (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const uid = (await Deno.stat(dir)).uid;
    assert(uid !== null, "fixture has no uid");
    const workRoot = await runOverWorkRoot(dir, uid + 4242);
    for (const clone of ["NEAT-AI", "LINKED"]) {
      await Deno.stat(`${workRoot}/${clone}/.git`);
    }
    for await (const entry of Deno.readDir(workRoot)) {
      assert(!entry.name.startsWith(".untrusted-"), entry.name);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - withholds exactly the reserved work-root names", async () => {
  const source = await Deno.readTextFile(ENTRYPOINT);
  const match = source.match(/^[ \t]*([^)\n]+)\) # reserved work-root names$/m);
  assert(
    match,
    "the entrypoint no longer names the reserved work-root entries",
  );
  const named = match[1]!.split("|").map((p) => p.trim()).sort();
  assertEquals(
    named,
    [...RESERVED_WORKDIR_NAMES].sort(),
    "the entrypoint's reserved list drifted from RESERVED_WORKDIR_NAMES",
  );
});

Deno.test("entrypoint - the untrusted account can traverse HOME to reach the work root (Issue #4733)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const home = workRoot.replace(/\/auto-issue-work$/, "");
    const stat = await Deno.stat(home);
    const mode = stat.mode;
    assert(mode !== null, "no mode bits on this platform");

    // The image creates HOME 0700, so `agent` could not pass through it and
    // every gate probe refused the checkout. Group traverse is what lets the
    // account reach ~/auto-issue-work.
    assertEquals(
      mode & GROUP_TRAVERSE,
      GROUP_TRAVERSE,
      "HOME must carry group traverse (g+x) so the untrusted account can reach the work root",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the HOME grant is traversal only (Issue #4733)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const home = workRoot.replace(/\/auto-issue-work$/, "");
    const stat = await Deno.stat(home);
    const mode = stat.mode;
    assert(mode !== null, "no mode bits on this platform");

    // Group read or write would let `agent` list HOME and reach the
    // credential material beside the work root; other-user access is never
    // granted at all.
    assertEquals(
      mode & GROUP_RW_OTHER_ALL,
      0,
      "HOME must grant the group traverse only: no group read or write, and nothing for others",
    );

    // The owner keeps its full access; the grant adds nothing to it.
    assertEquals(
      mode & OWNER_RWX,
      OWNER_RWX,
      "HOME must keep its owner read, write and traverse bits",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Any group or other access bit. */
const GROUP_OTHER_ANY = 0o077;

Deno.test("entrypoint - HOME's worker-state children carry no group or other access (Issue #4733)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const home = workRoot.replace(/\/auto-issue-work$/, "");
    for (const child of STATE_CHILDREN) {
      const mode = (await Deno.stat(`${home}/${child}`)).mode;
      assert(mode !== null, "no mode bits on this platform");
      // Opening HOME lets the untrusted account open these by path, which
      // HOME's 0700 used to prevent.
      assertEquals(
        mode & GROUP_OTHER_ANY,
        0,
        `${child} must be closed to group and other before HOME is opened`,
      );
      assertEquals(
        mode & OWNER_RWX,
        OWNER_RWX,
        `${child} must stay fully usable by its owner`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - HOME stays shut, loudly, when a worker-state child cannot be closed (Issue #4733)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    // A `chmod` that refuses to narrow the log mount root, as a mount that
    // ignores the call would: every other chmod is the real one.
    const refuseLogs = `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == */logs && "$1" == go-rwx ]]; then exit 1; fi
done
exec /bin/chmod "$@"
`;
    const { workRoot, stderr } = await runEntrypoint(dir, refuseLogs);
    const home = workRoot.replace(/\/auto-issue-work$/, "");
    const mode = (await Deno.stat(home)).mode;
    assert(mode !== null, "no mode bits on this platform");
    assertEquals(
      mode & GROUP_TRAVERSE,
      0,
      "HOME must not be opened while the log mount root is still readable",
    );
    assert(
      stderr.includes(`${home}/logs is still open`),
      `the open child must be named on stderr, got: ${stderr}`,
    );
    assert(
      stderr.includes("could not give the untrusted account traverse"),
      `the withheld grant must be reported, got: ${stderr}`,
    );

    // Positive control: the sibling roots the stub does not refuse are
    // closed, so the refusal above comes from the log mount alone.
    for (const child of STATE_CHILDREN.filter((c) => c !== "logs")) {
      const childMode = (await Deno.stat(`${home}/${child}`)).mode;
      assert(childMode !== null, "no mode bits on this platform");
      assertEquals(childMode & GROUP_OTHER_ANY, 0, child);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a clone root is sticky and its git metadata takes no group or other write (Issue #4737)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    const clone = (await Deno.stat(`${workRoot}/NEAT-AI`)).mode;
    assert(clone !== null, "no mode bits on this platform");
    // Group write on the clone root alone lets the untrusted account rename
    // the worker-owned `.git` aside and substitute its own.
    assertEquals(clone & STICKY, STICKY, "the clone root must be sticky");
    assertEquals(
      clone & GROUP_WRITE,
      GROUP_WRITE,
      "the quality gate still writes build output into the clone root",
    );
    for (const path of ["NEAT-AI/.git", "NEAT-AI/.git/config"]) {
      const mode = (await Deno.stat(`${workRoot}/${path}`)).mode;
      assert(mode !== null, "no mode bits on this platform");
      assertEquals(
        mode & 0o022,
        0,
        `${path} must not be writable by group or other`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Containerfile - HOME is made group vibework 710 after the recursive chown (Issue #4733)", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../container/Containerfile", import.meta.url).pathname,
  );
  // The account-creating RUN instruction, comments dropped, continuations
  // joined, split into its commands.
  const run = text.split(/\n(?=[A-Z]+ )/).find((block) =>
    block.startsWith("RUN") && block.includes("useradd")
  );
  assert(run, "the account-creating RUN instruction was not found");
  const commands = run.split("\n").filter((l) => !l.trimStart().startsWith("#"))
    .join(" ").replace(/\\\s+/g, " ").split(";").map((c) => c.trim());
  const at = (command: string) => commands.indexOf(command);
  const chown = at("chown -R 1000:1000 /workspace /home/vibe");
  const chgrp = at("chgrp vibework /home/vibe");
  const chmod = at("chmod 710 /home/vibe");
  assert(chown >= 0, "the recursive chown of HOME is gone");
  // The recursive chown resets the group to vibe, so the grant must follow it.
  assert(chgrp > chown, "chgrp vibework HOME must run after the chown");
  assert(chmod > chgrp, "chmod 710 HOME must run after the chgrp");
});
