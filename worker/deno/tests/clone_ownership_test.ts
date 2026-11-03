import { assert, assertEquals } from "@std/assert";
import {
  checkCloneOwnership,
  trustedLocalCloneExists,
} from "../lib/broken_clone.ts";
import { ensureRepoClone } from "../lib/ensure_repo_clone.ts";
import { setupRepo } from "../commands/git_operations.ts";

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
