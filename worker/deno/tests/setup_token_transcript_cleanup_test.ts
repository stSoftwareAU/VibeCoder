/**
 * The `claude setup-token` transcript must not survive the run (Issue #1300).
 *
 * `script(1)` logs the whole pty session, so the transcript holds the
 * `sk-ant-oat01-…` OAuth token in full — the long-lived credential that bills
 * the operator's subscription. Removing it only on the success path leaves the
 * token at rest in `${TMPDIR:-/tmp}` whenever a signal ends the run, and the
 * browser sign-in is the longest interactive pause in the whole of setup.sh —
 * precisely where an operator presses Ctrl-C.
 *
 * Behavioural: each test sources the real setup.sh and calls the real
 * `capture_setup_token` with a stubbed `script` on PATH, then asserts on what
 * is left in the test's own TMPDIR.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** A fake token, shaped like the real one the transcript would hold. */
const FAKE_TOKEN = "sk-ant-oat01-FAKEtoken_123-abc";

/**
 * Write a stub `script(1)` that records the fake token into the transcript.
 *
 * `interrupt` makes the stub emulate Ctrl-C at the browser sign-in: the tty
 * sends SIGINT to the whole foreground process group, so the waiting shell
 * sees the signal AND sees its child die from it.
 */
async function writeScriptStub(
  binDir: string,
  interrupt: boolean,
): Promise<void> {
  await Deno.mkdir(binDir, { recursive: true });
  const body = [
    "#!/bin/bash",
    // The transcript is the last argument on both the macOS and Linux forms
    // of the invocation.
    'transcript="${!#}"',
    `printf 'Paste this token: ${FAKE_TOKEN}\\n' > "$transcript"`,
    ...(interrupt
      ? [
        'kill -INT "$PPID"',
        "trap - INT",
        "kill -INT $$",
        "sleep 5",
      ]
      : []),
  ].join("\n");
  await Deno.writeTextFile(`${binDir}/script`, `${body}\n`);
  await Deno.chmod(`${binDir}/script`, 0o755);
}

/** Run one snippet against the real setup.sh with `tmp` as its TMPDIR. */
async function runInSetup(
  tmp: string,
  snippet: string,
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    ${snippet}
  `;
  // clearEnv: the child gets exactly what is listed here, so the real host's
  // TMPDIR can never be swept by a test (Issue #378 for the same trap).
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: ["-c", script],
    clearEnv: true,
    env: {
      PATH: `${tmp}/bin:/usr/bin:/bin`,
      HOME: tmp,
      TMPDIR: `${tmp}/tmp`,
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

/** Every leftover transcript in the test's TMPDIR, with its contents. */
async function leftoverTranscripts(
  tmp: string,
): Promise<Array<{ name: string; contents: string }>> {
  const leftovers: Array<{ name: string; contents: string }> = [];
  for await (const entry of Deno.readDir(`${tmp}/tmp`)) {
    if (!entry.name.startsWith("vibe-setup-token.")) continue;
    leftovers.push({
      name: entry.name,
      contents: await Deno.readTextFile(`${tmp}/tmp/${entry.name}`),
    });
  }
  return leftovers;
}

/** A temp directory with the TMPDIR and bin subdirectories the tests need. */
async function makeFixture(): Promise<string> {
  const tmp = await Deno.makeTempDir();
  await Deno.mkdir(`${tmp}/tmp`, { recursive: true });
  await Deno.mkdir(`${tmp}/bin`, { recursive: true });
  return tmp;
}

Deno.test("capture_setup_token - Ctrl-C at the sign-in leaves no transcript holding the token", async () => {
  const tmp = await makeFixture();
  try {
    await writeScriptStub(`${tmp}/bin`, true);

    // The real call shape: the token is read out of a command substitution.
    const { output } = await runInSetup(
      tmp,
      'VIBE_MINTED_CREDENTIAL="$(capture_setup_token)"; printf "%s" "$VIBE_MINTED_CREDENTIAL"',
    );

    const leftovers = await leftoverTranscripts(tmp);
    assertEquals(
      leftovers,
      [],
      `the interrupted run left the OAuth token at rest: ${
        JSON.stringify(leftovers)
      } (${output})`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("capture_setup_token - returns the token and leaves no transcript on the success path", async () => {
  const tmp = await makeFixture();
  try {
    await writeScriptStub(`${tmp}/bin`, false);

    const { code, output } = await runInSetup(
      tmp,
      'VIBE_MINTED_CREDENTIAL="$(capture_setup_token)"; printf "%s" "$VIBE_MINTED_CREDENTIAL"',
    );

    assertEquals(code, 0, output);
    assertStringIncludes(output, FAKE_TOKEN);
    assertEquals(await leftoverTranscripts(tmp), []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remove_setup_token_transcripts - removes this run's transcripts and no other run's", async () => {
  const tmp = await makeFixture();
  try {
    // A concurrent setup.sh mid-capture: its transcript must survive, or the
    // sweep would break the run that is still reading its own token.
    const otherRun = `${tmp}/tmp/vibe-setup-token.999999.aBcDeF`;
    await Deno.writeTextFile(otherRun, FAKE_TOKEN);

    const { code, output } = await runInSetup(
      tmp,
      [
        // Two transcripts of this run, as a retried capture would leave.
        'mine_a="$(mktemp "${TMPDIR}/vibe-setup-token.$$.XXXXXX")"',
        'mine_b="$(mktemp "${TMPDIR}/vibe-setup-token.$$.XXXXXX")"',
        'printf "%s" "' + FAKE_TOKEN + '" > "$mine_a"',
        'printf "%s" "' + FAKE_TOKEN + '" > "$mine_b"',
        "remove_setup_token_transcripts",
        // Idempotent: the traps call it on more than one path.
        "remove_setup_token_transcripts",
        'printf "%s\\n%s\\n" "$mine_a" "$mine_b"',
      ].join("\n"),
    );

    assertEquals(code, 0, output);
    const leftovers = await leftoverTranscripts(tmp);
    assertEquals(leftovers.length, 1, JSON.stringify(leftovers));
    assertEquals(leftovers[0]?.name, "vibe-setup-token.999999.aBcDeF");
    assert(
      !output.includes("No such file"),
      `the sweep should be quiet, not noisy: ${output}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
