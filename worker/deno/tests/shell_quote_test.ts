/**
 * Tests for lib/shell_quote.ts — POSIX shell quoting (Issue #3661,
 * SEC-a228ff008ed4 / SEC-bea501c3a7d7).
 *
 * The quoted value is fed back through a real `sh -c` so the assertions test
 * the actual shell's parse, not a regex that mirrors our own escaping.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildGitSshCommand, posixSingleQuote } from "../lib/shell_quote.ts";

/**
 * Ask a real `sh` to print the quoted value back as a single argument.
 *
 * @param quoted - Output of `posixSingleQuote`.
 * @returns The argv `sh` produced, one entry per word.
 */
async function shellWords(quoted: string): Promise<string[]> {
  const cmd = new Deno.Command("sh", {
    args: ["-c", `for a in ${quoted}; do printf '%s\\n' "$a"; done`],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const out = new TextDecoder().decode(stdout);
  return out.split("\n").slice(0, -1);
}

Deno.test("posixSingleQuote - a plain path is one shell word", async () => {
  assertEquals(
    await shellWords(posixSingleQuote("/home/bot/.ssh/id_ed25519")),
    [
      "/home/bot/.ssh/id_ed25519",
    ],
  );
});

Deno.test("posixSingleQuote - a path with spaces stays one word", async () => {
  assertEquals(await shellWords(posixSingleQuote("/Users/a b/My Keys/id")), [
    "/Users/a b/My Keys/id",
  ]);
});

Deno.test("posixSingleQuote - command substitution is inert", async () => {
  const evil = "/tmp/$(touch /tmp/pwned-3661)/id";
  assertEquals(await shellWords(posixSingleQuote(evil)), [evil]);
});

Deno.test("posixSingleQuote - a semicolon cannot start a new command", async () => {
  const evil = "/tmp/key; echo INJECTED";
  const words = await shellWords(posixSingleQuote(evil));
  assertEquals(words, [evil]);
});

Deno.test("posixSingleQuote - an embedded single quote round-trips", async () => {
  const tricky = "/Users/o'brien/.ssh/id_rsa";
  assertEquals(await shellWords(posixSingleQuote(tricky)), [tricky]);
});

Deno.test("posixSingleQuote - a quote-escape breakout attempt round-trips", async () => {
  // The classic escape: close the quote, run a command, reopen.
  const evil = "/tmp/a'; echo INJECTED; '/b";
  assertEquals(await shellWords(posixSingleQuote(evil)), [evil]);
});

Deno.test("posixSingleQuote - the empty string is still one word", () => {
  assertEquals(posixSingleQuote(""), "''");
});

Deno.test("buildGitSshCommand - quotes the key path and keeps the flags", () => {
  const cmd = buildGitSshCommand("/Users/a b/.ssh/id");
  assertEquals(cmd, `ssh -i '/Users/a b/.ssh/id' -o IdentitiesOnly=yes`);
});

Deno.test("buildGitSshCommand - a space no longer splits the -i argument", async () => {
  const cmd = buildGitSshCommand("/Users/a b/.ssh/id");
  const words = await shellWords(cmd);
  assertEquals(words, [
    "ssh",
    "-i",
    "/Users/a b/.ssh/id",
    "-o",
    "IdentitiesOnly=yes",
  ]);
});

Deno.test("buildGitSshCommand - metacharacters in the key path do not execute", async () => {
  const cmd = buildGitSshCommand("/tmp/$(id)/key;echo INJECTED");
  const words = await shellWords(cmd);
  assertEquals(words[2], "/tmp/$(id)/key;echo INJECTED");
  assertStringIncludes(cmd, "IdentitiesOnly=yes");
});
