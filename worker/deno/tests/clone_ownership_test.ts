import { assert, assertEquals } from "@std/assert";
import { checkCloneOwnership } from "../lib/broken_clone.ts";
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
