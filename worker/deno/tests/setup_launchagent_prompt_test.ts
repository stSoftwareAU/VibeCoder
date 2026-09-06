/**
 * The LaunchAgent / scheduled-task install prompt must default to NO.
 *
 * Installing starts a *second* worker on a host that may already have one,
 * and two workers on one host collide on the work volumes (Issue #26). The
 * prompt used to read `[Y/n]`, so a bare Enter — the thing an operator does
 * to move past a wall of setup output — installed it.
 *
 * That is what happened on GRQ-23: launchd ran the worker every five minutes
 * beside the operator's own `./loop.sh`, unnoticed until the two were found
 * fighting over the same work volume. "It didn't seem to ask me" is what a
 * default-yes prompt feels like from the other side.
 *
 * The safe answer is the one that changes nothing, so it is the one Enter
 * gives you. These tests drive the real `prompt_launchagent_setup` in a bash
 * subprocess with the install path stubbed, so they assert behaviour rather
 * than the text of the prompt.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const SETUP_SH = new URL("../../../setup.sh", import.meta.url).pathname;
const SETUP_PS1 = new URL("../../../setup.ps1", import.meta.url).pathname;

/**
 * Run `prompt_launchagent_setup` with `answer` on stdin.
 *
 * Everything the function reaches out to is stubbed: the macOS check, the
 * printers, and `run_setup_cli` — which prints a marker instead of installing
 * anything. `-t 0` is forced true so the non-interactive early return does
 * not skip the prompt under a piped stdin.
 *
 * @returns stdout, which contains `INSTALLED`/`UNINSTALLED` markers only when
 *   the corresponding branch actually ran.
 */
async function runPrompt(
  answer: string,
  options: { plistDir?: string; removalAnswer?: string } = {},
): Promise<{ code: number; stdout: string }> {
  const script = `
    set -uo pipefail
    source "${SETUP_SH}"
    is_macos() { return 0; }
    print_info() { :; }
    print_warning() { :; }
    print_error() { :; }
    # The interactive guard tests the real stdin; force it so a piped answer
    # still reaches the prompt.
    eval 'prompt_launchagent_setup() {
      '"$(declare -f prompt_launchagent_setup | sed -n '3,$p' | sed 's/if \\[\\[ ! -t 0 \\]\\]; then/if false; then/')"
    run_setup_cli() { echo "CALLED:$*"; }
    prompt_launchagent_setup
  `;
  const cmd = new Deno.Command("bash", {
    args: ["-c", script],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: options.plistDir ? { VIBE_LAUNCHAGENT_DIR: options.plistDir } : {},
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  const answers = options.removalAnswer === undefined
    ? `${answer}\n`
    : `${answer}\n${options.removalAnswer}\n`;
  await writer.write(new TextEncoder().encode(answers));
  await writer.close();
  const out = await child.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

Deno.test("setup.sh - a bare Enter does NOT install the LaunchAgent (Issue #26)", async () => {
  const { stdout } = await runPrompt("");
  assertEquals(
    stdout.includes("CALLED:launchagent\n") ||
      stdout.includes("CALLED:launchagent "),
    false,
    `Enter must not install a second worker; got: ${stdout}`,
  );
});

Deno.test("setup.sh - only an explicit yes installs the LaunchAgent (Issue #26)", async () => {
  for (const answer of ["y", "Y", "yes", "YES"]) {
    const { stdout } = await runPrompt(answer);
    assertStringIncludes(
      stdout,
      "CALLED:launchagent",
      `'${answer}' should install`,
    );
  }
  // Anything else declines — including a typo, which must fail safe.
  for (const answer of ["n", "N", "no", "maybe", "  ", "yep"]) {
    const { stdout } = await runPrompt(answer);
    assertEquals(
      stdout.split("\n").some((l) => l === "CALLED:launchagent"),
      false,
      `'${answer}' must not install; got: ${stdout}`,
    );
  }
});

// ── The removal prompt (Issue #1369) ─────────────────────────────────────
//
// Declining the install on a host that already has the agent offers to remove
// it — and that offer used to read `[Y/n]`, so the operator who walked the
// wizard with Enter to change a credential uninstalled the worker instead.
// That happened twice on GRQ-25; launchd's log recorded the removal and the
// host sat dead until someone noticed the next day. Enter must change nothing
// on both LaunchAgent prompts, not just the install one.

/** A temp LaunchAgents directory holding an installed-looking plist. */
async function withInstalledPlist(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/com.vibe.auto-issue-worker.plist`,
      "<plist/>",
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Did the removal branch actually run the uninstall?
 *
 * The prompt is written with `echo -n`, so the marker shares its line.
 */
function uninstalled(stdout: string): boolean {
  return stdout.includes("CALLED:launchagent --uninstall");
}

Deno.test("setup.sh - a bare Enter does NOT remove the installed LaunchAgent (Issue #1369)", async () => {
  await withInstalledPlist(async (dir) => {
    const { stdout } = await runPrompt("", {
      plistDir: dir,
      removalAnswer: "",
    });
    assertEquals(
      uninstalled(stdout),
      false,
      `Enter must leave the LaunchAgent as it is; got: ${stdout}`,
    );
  });
});

Deno.test("setup.sh - only an explicit yes removes the LaunchAgent (Issue #1369)", async () => {
  await withInstalledPlist(async (dir) => {
    for (const answer of ["y", "Y", "yes", "YES"]) {
      const { stdout } = await runPrompt("n", {
        plistDir: dir,
        removalAnswer: answer,
      });
      assertEquals(
        uninstalled(stdout),
        true,
        `'${answer}' should remove the agent; got: ${stdout}`,
      );
    }
    // Everything else keeps it — Enter, an explicit no, "-" for leave-as-is,
    // and a typo, which must fail safe.
    for (const answer of ["", "n", "N", "no", "NO", "-", "  ", "yep"]) {
      const { stdout } = await runPrompt("n", {
        plistDir: dir,
        removalAnswer: answer,
      });
      assertEquals(
        uninstalled(stdout),
        false,
        `'${answer}' must not remove the agent; got: ${stdout}`,
      );
    }
  });
});

Deno.test("setup.sh / setup.ps1 - both removal prompts are marked [y/N] (Issue #1369)", async () => {
  // Parity with the install prompts below: the marker shown to the operator
  // IS the contract, and it must match the branch behaviour tested above.
  const sh = await Deno.readTextFile(SETUP_SH);
  assertStringIncludes(sh, "Remove the installed LaunchAgent now? [y/N]");
  const ps1 = await Deno.readTextFile(SETUP_PS1);
  assertStringIncludes(ps1, "Unregister the scheduled task now? [y/N]");
});

Deno.test("setup.sh / setup.ps1 - both install prompts are marked [y/N] (Issue #26)", async () => {
  // Parity: the Windows scheduled task is the same hazard, so it defaults the
  // same way. Reading the prompt text is legitimate here — the marker shown
  // to the operator IS the contract being pinned, and it must match the
  // branch behaviour the tests above verify.
  const sh = await Deno.readTextFile(SETUP_SH);
  assertStringIncludes(sh, "Install the LaunchAgent now? [y/N]");
  const ps1 = await Deno.readTextFile(SETUP_PS1);
  assertStringIncludes(ps1, "Register the scheduled task now? [y/N]");
});
