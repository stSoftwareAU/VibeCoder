/**
 * Tests for the obsolete host work-directory step in setup.sh
 * (Issues #4186, #134).
 *
 * Container mode keeps the workspace on the `vibe-work` / `vibe-approval-state`
 * named volumes, so a leftover host `~/auto-issue-work` (or its approval-state
 * sibling) is never mounted again and only wastes disk. A directory holding
 * worker data gets a warning and a manual `rm -rf` hint — deleting operator
 * data is never setup's call — while one holding nothing beyond a stale
 * `.vibe-cache` (setup caches nothing on the host any more, Issue #132) is
 * setup's own leftover and is removed outright, with an informational line
 * saying so (Issue #134). The step stays quiet on a host
 * whose run mode cannot be resolved (container is the only mode, Issue #4).
 *
 * Behavioural: each test sources the real setup.sh and calls the real
 * `remind_obsolete_host_work_dirs` with a stubbed `deno` answering the
 * run-mode question, then asserts on what the operator would see — and on
 * what is (and is not) left on disk.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** Run `remind_obsolete_host_work_dirs` from the real setup.sh. */
async function remind(
  tmp: string,
  runMode: string,
): Promise<{ code: number; output: string }> {
  // The function resolves the run mode through the `run-mode` Deno command;
  // the stub answers it without needing a real config.
  const stubDir = `${tmp}/bin`;
  await Deno.mkdir(stubDir, { recursive: true });
  await Deno.writeTextFile(
    `${stubDir}/deno`,
    `#!/bin/bash\necho "${runMode}"\n`,
  );
  await Deno.chmod(`${stubDir}/deno`, 0o755);

  const script = `
    set -euo pipefail
    source "${setupPath}"
    remind_obsolete_host_work_dirs
  `;
  // Issue #378: `env` MERGES into the parent environment unless clearEnv is
  // set, so inside the worker container the real WORK_DIR was inherited and
  // `${WORK_DIR:-${HOME}/auto-issue-work}` probed the host's actual work dir
  // instead of the temp fixture — ten tests red on every in-container run.
  // The child gets exactly what is listed here and nothing else.
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: ["-c", script],
    clearEnv: true,
    env: {
      PATH: `${stubDir}:/usr/bin:/bin`,
      HOME: tmp,
      CONFIG_FILE: `${tmp}/.config.json`,
    },
    stdin: "null",
  }).output();
  return {
    code,
    output: new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr),
  };
}

/** Does the path exist at all (file, directory or dangling symlink)? */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("remind_obsolete_host_work_dirs - names a leftover work dir and how to reclaim it", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work/some-repo`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/auto-issue-work/some-repo/f`, "x");

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertStringIncludes(output, `${tmp}/auto-issue-work`);
    assertStringIncludes(output, "4186");
    assertStringIncludes(output, "never mounted again");
    // The remedy is offered, never performed.
    assertStringIncludes(output, "rm -rf");
    assertEquals(
      await Deno.stat(`${tmp}/auto-issue-work/some-repo/f`).then(() => true),
      true,
      "the reminder must never delete anything",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - covers the approval-state sibling too", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work-approval-state`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${tmp}/auto-issue-work-approval-state/.content_approval_state.json`,
      "{}",
    );

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertStringIncludes(output, `${tmp}/auto-issue-work-approval-state`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - removes an empty leftover work dir and says so (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // An existing-but-empty directory is setup's own leftover: reclaim it.
    await Deno.mkdir(`${tmp}/auto-issue-work`);

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertStringIncludes(output, `Removed ${tmp}/auto-issue-work`);
    assertStringIncludes(output, "134");
    assertEquals(output.includes("4186"), false, output);
    assertEquals(
      await exists(`${tmp}/auto-issue-work`),
      false,
      "an empty host work dir must be removed",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - removes a work dir holding only setup's own .vibe-cache (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Setup no longer caches on the host (Issue #132), so a .vibe-cache is
    // a leftover an earlier setup version wrote — setup's to reclaim.
    await Deno.mkdir(`${tmp}/auto-issue-work/.vibe-cache`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${tmp}/auto-issue-work/.vibe-cache/default-branch-cache.json`,
      "{}",
    );

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    // Removal is reported, never silent — and it is not the #4186 warning.
    assertStringIncludes(output, `Removed ${tmp}/auto-issue-work`);
    assertStringIncludes(output, "134");
    assertEquals(output.includes("4186"), false, output);
    assertEquals(output.includes("rm -rf"), false, output);
    assertEquals(
      await exists(`${tmp}/auto-issue-work`),
      false,
      "a cache-only host work dir must be removed",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - removes an empty approval-state sibling too (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work/.vibe-cache`, {
      recursive: true,
    });
    await Deno.mkdir(`${tmp}/auto-issue-work-approval-state`);

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertStringIncludes(
      output,
      `Removed ${tmp}/auto-issue-work-approval-state`,
    );
    assertEquals(
      await exists(`${tmp}/auto-issue-work-approval-state`),
      false,
      "an empty approval-state sibling must be removed",
    );
    assertEquals(await exists(`${tmp}/auto-issue-work`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - honours an explicit WORK_DIR override and touches nothing else (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // The default-location directory holds data; the override is cache-only.
    await Deno.mkdir(`${tmp}/auto-issue-work/some-repo`, { recursive: true });
    await Deno.mkdir(`${tmp}/elsewhere/.vibe-cache`, { recursive: true });

    const stubDir = `${tmp}/bin`;
    await Deno.mkdir(stubDir, { recursive: true });
    await Deno.writeTextFile(
      `${stubDir}/deno`,
      "#!/bin/bash\necho container\n",
    );
    await Deno.chmod(`${stubDir}/deno`, 0o755);
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: [
        "-c",
        `set -euo pipefail; source "${setupPath}"; remind_obsolete_host_work_dirs`,
      ],
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        HOME: tmp,
        WORK_DIR: `${tmp}/elsewhere`,
        CONFIG_FILE: `${tmp}/.config.json`,
      },
      stdin: "null",
    }).output();
    const output = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);

    assertEquals(code, 0, output);
    assertStringIncludes(output, `Removed ${tmp}/elsewhere`);
    assertEquals(
      await exists(`${tmp}/elsewhere`),
      false,
      "the overridden cache-only work dir must be removed",
    );
    assertEquals(
      await exists(`${tmp}/auto-issue-work/some-repo`),
      true,
      "only the resolved work dir and its sibling may be touched",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - an absent work dir produces no output and no probe path", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertEquals(output.trim(), "", "an absent work dir must stay silent");
    assertEquals(
      await exists(`${tmp}/auto-issue-work`),
      false,
      "the check itself must not create a probe path",
    );
    assertEquals(await exists(`${tmp}/auto-issue-work-approval-state`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - a non-container run mode removes nothing (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work/.vibe-cache`, {
      recursive: true,
    });

    const { code, output } = await remind(tmp, "host");
    assertEquals(code, 0, output);
    assertEquals(output.trim(), "", output);
    assertEquals(
      await exists(`${tmp}/auto-issue-work/.vibe-cache`),
      true,
      "a non-container run mode must not remove anything",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - a checkout beside the cache is still reported", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work/.vibe-cache`, {
      recursive: true,
    });
    await Deno.mkdir(`${tmp}/auto-issue-work/some-repo`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/auto-issue-work/some-repo/f`, "x");

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertStringIncludes(output, "4186");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - stays quiet when the run mode cannot be resolved (a removed mode, Issue #4)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // One directory holding worker data, one cache-only: an unresolvable
    // configuration must neither warn about the first nor remove the second.
    await Deno.mkdir(`${tmp}/auto-issue-work/some-repo`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/auto-issue-work/some-repo/f`, "x");
    await Deno.mkdir(`${tmp}/auto-issue-work-approval-state`);

    // The stub answers what the real run-mode command prints on a removed
    // mode: nothing on stdout (it exits non-zero). Setup's reminder must
    // skip rather than fail setup.
    const { code, output } = await remind(tmp, "");
    assertEquals(code, 0, output);
    assertEquals(output.includes("4186"), false, output);
    assertEquals(output.includes("Removed"), false, output);
    assertEquals(
      await exists(`${tmp}/auto-issue-work-approval-state`),
      true,
      "an unresolvable run mode must not remove anything",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remove_cache_only_host_work_dir - refuses an empty path, /, and HOME itself (Issue #134)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // A canary in HOME proves the refusal is real, not just polite output.
    await Deno.writeTextFile(`${tmp}/canary`, "x");

    for (const dir of ["", "/", tmp]) {
      const { code, stdout, stderr } = await new Deno.Command("bash", {
        args: [
          "-c",
          `set -euo pipefail
           source "${setupPath}"
           remove_cache_only_host_work_dir '${dir}'`,
        ],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
        },
        stdin: "null",
      }).output();
      const output = new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr);

      assertEquals(code, 0, output);
      assertStringIncludes(
        output,
        "Refusing to remove",
        `the guard must refuse '${dir}'`,
      );
      assertEquals(
        await exists(`${tmp}/canary`),
        true,
        `refusing '${dir}' must leave HOME untouched`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
