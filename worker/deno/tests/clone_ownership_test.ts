import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkCloneOwnership,
  trustedLocalCloneExists,
} from "../lib/broken_clone.ts";
import { ensureRepoClone } from "../lib/ensure_repo_clone.ts";
import { setupRepo } from "../commands/git_operations.ts";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";

Deno.test("fresh clone refuses and quarantines a foreign root before git", async () => {
  const dir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const path = `${dir}/repo`;
    const bin = `${dir}/bin`;
    const gitCalled = `${dir}/git-called`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\n/usr/bin/touch '${gitCalled}'\nexit 1\n`,
    );
    await Deno.chmod(`${bin}/git`, 0o755);
    Deno.env.set("PATH", `${bin}:${originalPath ?? ""}`);
    let checks = 0;
    _setGhSpawnRunner(async () => {
      await Deno.mkdir(`${path}/.git`, { recursive: true });
      return { code: 0, success: true, stdout: "", stderr: "" };
    });
    const result = await setupRepo("owner/repo", dir, async (p) => {
      checks++;
      const uid = (await Deno.stat(dir)).uid;
      assert(uid !== null);
      return await checkCloneOwnership(p, () => Promise.resolve(uid + 1));
    });
    assertEquals(checks, 2);
    assertEquals(result.success, false);
    assert(result.message.includes("root is not owned"));
    await assertRejects(() => Deno.stat(gitCalled), Deno.errors.NotFound);
    const entries = Array.from(Deno.readDirSync(dir)).filter((e) =>
      e.name !== "bin"
    );
    assertEquals(entries.length, 1);
    assert(entries[0]);
    assert(entries[0].name.startsWith(".untrusted-repo-"));
    assert(
      (await Deno.stat(`${dir}/${entries[0].name}/repo/.git`)).isDirectory,
    );
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    _resetGhSpawnRunner();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clone reuse refuses a foreign-owned root before invoking git", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/repo`;
    await Deno.mkdir(`${path}/.git`, { recursive: true });
    const uid = (await Deno.stat(path)).uid;
    assert(uid !== null);
    const foreign = (p: string) =>
      checkCloneOwnership(p, () => Promise.resolve(uid + 1));
    assert((await foreign(path))?.includes("root is not owned"));
    const ensured = await ensureRepoClone("owner/repo", dir, {
      ownershipCheckFn: foreign,
    });
    assertEquals(ensured.ok, false);
    assert(ensured.message?.includes("root is not owned"));
    const setup = await setupRepo("owner/repo", dir, foreign);
    assertEquals(setup.success, false);
    assert(setup.message.includes("root is not owned"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clone ownership refuses foreign and symlinked git metadata", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/repo`;
    await Deno.mkdir(`${path}/.git`, { recursive: true });
    const uid = (await Deno.lstat(path)).uid;
    assert(uid !== null);
    const logs: string[] = [];
    assertEquals(
      await trustedLocalCloneExists(path, (msg) => logs.push(msg)),
      true,
    );
    const foreignGit = async (p: string): Promise<Deno.FileInfo> => {
      const info = await Deno.lstat(p);
      return p.endsWith("/.git") ? { ...info, uid: uid + 1 } : info;
    };
    assert(
      (await checkCloneOwnership(path, () => Promise.resolve(uid), foreignGit))
        ?.includes(".git is not owned"),
    );
    await Deno.remove(`${path}/.git`);
    await Deno.symlink(dir, `${path}/.git`);
    assert(
      (await checkCloneOwnership(path, () => Promise.resolve(uid)))?.includes(
        "symlink",
      ),
    );
    assertEquals(
      await trustedLocalCloneExists(path, (msg) => logs.push(msg)),
      false,
    );
    assert(logs.some((msg) => msg.includes("Refusing untrusted clone")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
