/**
 * Tests for the launch-time new-release notice (Issue #690, part of #674).
 *
 * A frozen host pinned behind the newest release gets exactly one line at
 * launch naming both versions and the command that installs the new one.
 * Everything else — a dynamic host, a host already on the newest release, a
 * commit-SHA pin, a repository with no releases at all — says nothing, and a
 * failed check is a fail-loud `Result` the launcher degrades to a warning
 * rather than an exception that would abort a launch.
 *
 * Every test runs against injected deps: no `gh`, no git, no network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { printReleaseNotice } from "../commands/release_notice.ts";
import { formatReleaseNotice, releaseNotice } from "../lib/release_notice.ts";
import type { ReleaseCheckDeps } from "../lib/release_check.ts";
import {
  UPGRADE_COMMAND_NAME,
  UPGRADE_INVOCATION,
} from "../lib/upgrade_command.ts";
import { createDefaultRegistry } from "../mod.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import type { Result } from "../types.ts";

/** One release entry as `gh release list --json` reports it. */
function release(tagName: string): Record<string, unknown> {
  return { tagName, isDraft: false, isPrerelease: false };
}

/** A successful `gh` invocation carrying `stdout`. */
function ghOk(stdout: string): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: true, code: 0, stdout, stderr: "", timedOut: false },
  };
}

/** Deps that answer `gh release list` with the tags given. */
function depsWithReleases(tags: readonly string[]): ReleaseCheckDeps {
  return {
    resolveRepo: () => Promise.resolve({ ok: true, value: "org/repo" }),
    runGh: () => Promise.resolve(ghOk(JSON.stringify(tags.map(release)))),
  };
}

/** Deps whose `gh` call fails the way an unreachable GitHub does. */
function depsThatFail(): ReleaseCheckDeps {
  return {
    resolveRepo: () => Promise.resolve({ ok: true, value: "org/repo" }),
    runGh: () =>
      Promise.resolve({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: "",
          stderr: "could not resolve host: api.github.com",
          timedOut: false,
        },
      }),
  };
}

/** Deps whose `gh` call the timeout helper killed. */
function depsThatTimeOut(): ReleaseCheckDeps {
  return {
    resolveRepo: () => Promise.resolve({ ok: true, value: "org/repo" }),
    runGh: () =>
      Promise.resolve({
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: "",
          stderr: "",
          timedOut: true,
        },
      }),
  };
}

/** A checkout directory carrying the `.config.json` given. */
async function checkoutWithConfig(
  config: Record<string, unknown> | null,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "release_notice_test_" });
  if (config !== null) {
    await Deno.writeTextFile(
      `${dir}/.config.json`,
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  return dir;
}

Deno.test("release notice - a frozen host behind the newest release is told, in the documented wording", async () => {
  const outcome = await releaseNotice(
    { mode: "frozen", ref: "1.0.4" },
    depsWithReleases(["1.0.3", "1.0.5", "1.0.4"]),
  );

  assert(outcome.ok, "the check must succeed");
  assert(outcome.value.notify, `expected a notice: ${JSON.stringify(outcome)}`);
  assertEquals(
    outcome.value.line,
    "A new release of Vibe Coder is available: 1.0.4 → 1.0.5. " +
      "Run ./run.sh upgrade to install it.",
  );
  assertEquals(outcome.value.current, "1.0.4");
  assertEquals(outcome.value.latest, "1.0.5");
});

Deno.test("release notice - a frozen host already on the newest release says nothing", async () => {
  const outcome = await releaseNotice(
    { mode: "frozen", ref: "1.0.5" },
    depsWithReleases(["1.0.4", "1.0.5"]),
  );

  assert(outcome.ok, "the check must succeed");
  assertEquals(outcome.value.notify, false);
});

Deno.test("release notice - a dynamic host says nothing: it installs the latest at every launch", async () => {
  const outcome = await releaseNotice(
    { mode: "dynamic", ref: "" },
    // Answering `gh` at all would be a fault: a dynamic host must not even
    // look, so a call here fails the test loudly.
    {
      resolveRepo: () =>
        Promise.reject(new Error("a dynamic host must not check releases")),
      runGh: () =>
        Promise.reject(new Error("a dynamic host must not check releases")),
    },
  );

  assert(outcome.ok, "the check must succeed");
  assertEquals(outcome.value.notify, false);
  assert(
    !outcome.value.notify && outcome.value.reason.includes("dynamic"),
    `the reason must name the mode: ${JSON.stringify(outcome.value)}`,
  );
});

Deno.test("release notice - a commit-SHA pin says nothing: it cannot be ordered against a tag", async () => {
  const outcome = await releaseNotice(
    { mode: "frozen", ref: "3f7a1c9d2b4e5f6a7b8c9d0e1f2a3b4c5d6e7f80" },
    depsWithReleases(["1.0.5"]),
  );

  assert(outcome.ok, "the check must succeed");
  assertEquals(outcome.value.notify, false);
  assert(
    !outcome.value.notify && outcome.value.reason.includes("commit SHA"),
    `the reason must name the pin shape: ${JSON.stringify(outcome.value)}`,
  );
});

Deno.test("release notice - a repository with no releases says nothing", async () => {
  const outcome = await releaseNotice(
    { mode: "frozen", ref: "1.0.4" },
    depsWithReleases([]),
  );

  assert(outcome.ok, "an empty release series is a clean outcome");
  assertEquals(outcome.value.notify, false);
});

Deno.test("release notice - a pre-release newer than the pin is not a release to notify about", async () => {
  const outcome = await releaseNotice(
    { mode: "frozen", ref: "1.0.5" },
    depsWithReleases(["1.0.5", "1.0.6-rc1", "latest"]),
  );

  assert(outcome.ok, "the check must succeed");
  assertEquals(outcome.value.notify, false);
});

Deno.test("release notice - a failed release check is a fail-loud error, never a silent pass", async () => {
  const failed = await releaseNotice(
    { mode: "frozen", ref: "1.0.4" },
    depsThatFail(),
  );
  assertEquals(failed.ok, false);
  assert(!failed.ok);
  assertStringIncludes(failed.error.message, "gh release list");

  const timedOut = await releaseNotice(
    { mode: "frozen", ref: "1.0.4" },
    depsThatTimeOut(),
  );
  assertEquals(timedOut.ok, false);
  assert(!timedOut.ok);
  assertStringIncludes(timedOut.error.message, "timed out");
});

Deno.test("release notice - the notice names the upgrade command, and cannot drift from it", () => {
  // One source of truth for the command's name: the notice is built from it,
  // and the command Issue #691 registers is named from the same constant.
  assertEquals(UPGRADE_INVOCATION, `./run.sh ${UPGRADE_COMMAND_NAME}`);
  assertStringIncludes(
    formatReleaseNotice("1.0.4", "1.0.5"),
    `Run ${UPGRADE_INVOCATION} to install it.`,
  );

  // Any upgrade command in the registry must be the one the notice names —
  // a second spelling would leave the operator with a command that does not
  // exist.
  const registry = createDefaultRegistry();
  const upgradeCommands = registry.list().filter((name) =>
    name.includes("upgrade")
  );
  for (const name of upgradeCommands) {
    assertEquals(
      name,
      UPGRADE_COMMAND_NAME,
      `the notice names "${UPGRADE_COMMAND_NAME}" but the registry carries ` +
        `"${name}" — keep worker/deno/lib/upgrade_command.ts in step`,
    );
  }
});

Deno.test("release-notice command - prints the notice for a frozen host behind the newest release", async () => {
  const dir = await checkoutWithConfig({
    update_mode: "frozen",
    pinned_ref: "1.0.4",
    pinned_tool_versions: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  });
  try {
    const result = await printReleaseNotice(
      { "base-dir": dir },
      depsWithReleases(["1.0.5"]),
    );

    assertEquals(result.success, true, result.message);
    assertEquals(
      result.message,
      "A new release of Vibe Coder is available: 1.0.4 → 1.0.5. " +
        "Run ./run.sh upgrade to install it.",
    );
    assertEquals(result.data?.notify, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notice command - prints nothing at all when there is nothing to say", async () => {
  const dir = await checkoutWithConfig({
    update_mode: "frozen",
    pinned_ref: "1.0.5",
    pinned_tool_versions: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  });
  try {
    const result = await printReleaseNotice(
      { "base-dir": dir },
      depsWithReleases(["1.0.5"]),
    );

    assertEquals(result.success, true, result.message);
    // Empty stdout is what keeps the launcher silent: it prints and logs the
    // captured output only when there is some.
    assertEquals(result.message, "");
    assertEquals(result.data?.notify, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notice command - a checkout with no .config.json is a dynamic host: silent", async () => {
  const dir = await checkoutWithConfig(null);
  try {
    const result = await printReleaseNotice({ "base-dir": dir }, {
      resolveRepo: () =>
        Promise.reject(new Error("a dynamic host must not check releases")),
      runGh: () =>
        Promise.reject(new Error("a dynamic host must not check releases")),
    });

    assertEquals(result.success, true, result.message);
    assertEquals(result.message, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notice command - a failed check exits non-zero naming the reason", async () => {
  const dir = await checkoutWithConfig({
    update_mode: "frozen",
    pinned_ref: "1.0.4",
    pinned_tool_versions: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  });
  try {
    const result = await printReleaseNotice(
      { "base-dir": dir },
      depsThatFail(),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "gh release list");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notice command - a malformed .config.json fails loud rather than guessing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release_notice_test_" });
  try {
    await Deno.writeTextFile(`${dir}/.config.json`, "{ not json");
    const result = await printReleaseNotice(
      { "base-dir": dir },
      depsWithReleases(["1.0.5"]),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "invalid JSON");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notice command - requires --base-dir", async () => {
  const result = await printReleaseNotice({}, depsWithReleases(["1.0.5"]));

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--base-dir");
});
