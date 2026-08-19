/**
 * Tests for the obsolete host work-directory reminder in setup.sh
 * (Issue #4186).
 *
 * Container mode keeps the workspace on the `vibe-work` / `vibe-approval-state`
 * named volumes, so a leftover host `~/auto-issue-work` (or its approval-state
 * sibling) is never mounted again and only wastes disk. Setup must say so —
 * and must only say so: it never deletes, and it stays quiet on native-mode
 * hosts, where the directories are still in use.
 *
 * Behavioural: each test sources the real setup.sh and calls the real
 * `remind_obsolete_host_work_dirs` with a stubbed `deno` answering the
 * run-mode question, then asserts on what the operator would see.
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
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: ["-c", script],
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

Deno.test("remind_obsolete_host_work_dirs - stays quiet when nothing is left behind", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // An existing-but-empty directory wastes nothing worth a warning.
    await Deno.mkdir(`${tmp}/auto-issue-work`);

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertEquals(output.includes("4186"), false, output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remind_obsolete_host_work_dirs - stays quiet when only setup's own .vibe-cache is present", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Setup's host-side audits cache default-branch lookups under the work
    // dir; a warning about a directory setup itself just wrote is noise.
    await Deno.mkdir(`${tmp}/auto-issue-work/.vibe-cache`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${tmp}/auto-issue-work/.vibe-cache/default-branch-cache.json`,
      "{}",
    );

    const { code, output } = await remind(tmp, "container");
    assertEquals(code, 0, output);
    assertEquals(output.includes("4186"), false, output);
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

Deno.test("remind_obsolete_host_work_dirs - stays quiet in native mode, where the dirs are live", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/auto-issue-work/some-repo`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/auto-issue-work/some-repo/f`, "x");

    const { code, output } = await remind(tmp, "native");
    assertEquals(code, 0, output);
    assertEquals(
      output.includes("wasting disk"),
      false,
      `native mode still uses the host work dir: ${output}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
