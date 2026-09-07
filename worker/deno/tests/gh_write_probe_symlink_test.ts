/**
 * Write-probe symlink-follow regression test (Issue #1238).
 *
 * `isGhConfigDirUsable` ends in a writability probe, and that probe used a
 * fixed `.vibe-write-probe` name written with `Deno.writeTextFileSync` —
 * O_CREAT|O_TRUNC, which follows a symlink. The staging candidates include the
 * agents' scratch space and `TMPDIR`, so a co-located account could plant a
 * link at the predictable name and have any file the worker can write
 * truncated. The probe then removed the *link*, so nothing was left to show
 * what had happened.
 *
 * The rest of Issue #1238's surface — the credential write itself, the
 * directory mode, and the loud per-candidate refusal — is covered by
 * `gh_credential_stage_test.ts` against the Issue #1282 staging rewrite. This
 * file keeps the one case that rewrite does not reach: the probe still ran
 * with a fixed name after it.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assertEquals } from "@std/assert";
import { isGhConfigDirUsable } from "../lib/gh_credential_stage.ts";
import { GH_HOSTS_FILE } from "../lib/credential_preflight.ts";

const TOKEN = "github.com:\n    user: VibeCoderST\n    oauth_token: s3cret\n";

Deno.test("isGhConfigDirUsable - the write probe does not truncate a planted target", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/gh-config`;
    await Deno.mkdir(dir);
    await Deno.writeTextFile(`${dir}/${GH_HOSTS_FILE}`, TOKEN);
    const victim = `${root}/victim.txt`;
    await Deno.writeTextFile(victim, "untouched\n");
    // The pre-#1238 probe name, which was fixed and therefore predictable.
    await Deno.symlink(victim, `${dir}/.vibe-write-probe`);

    assertEquals(isGhConfigDirUsable(dir), true);
    assertEquals(await Deno.readTextFile(victim), "untouched\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("isGhConfigDirUsable - the probe leaves nothing behind in the directory it probed", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/${GH_HOSTS_FILE}`, TOKEN);

    assertEquals(isGhConfigDirUsable(root), true);

    const left: string[] = [];
    for await (const entry of Deno.readDir(root)) left.push(entry.name);
    assertEquals(left, [GH_HOSTS_FILE]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
