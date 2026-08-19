/**
 * Tests for the macOS Seatbelt containment profile (Issue #4300).
 *
 * The pure builder is tested everywhere; the live enforcement test runs
 * only on macOS, where `sandbox-exec` exists, and proves the property the
 * mode exists for: the allowed work dir is usable, and a canary outside it
 * — in the same HOME — is unreadable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildSeatbeltProfile,
  validateProfilePath,
} from "../lib/seatbelt_profile.ts";

const INPUTS = {
  baseDir: "/Users/op/src/VibeCoder",
  workDir: "/Users/op/auto-issue-work",
  logDir: "/Users/op/logs",
  configDir: "/Users/op/.vibe-coder/run-config",
  credentialsDir: "/Users/op/.vibe-coder/credentials",
  homeDir: "/Users/op",
  tmpDir: "/var/folders/ab/cd/T",
};

Deno.test("seatbelt profile - denies by default and allows exactly the mounted set", () => {
  const profile = buildSeatbeltProfile(INPUTS);
  assertStringIncludes(profile, "(deny default)");
  assertStringIncludes(profile, '(subpath "/Users/op/src/VibeCoder")');
  assertStringIncludes(profile, '(subpath "/Users/op/auto-issue-work")');
  assertStringIncludes(profile, '(subpath "/Users/op/logs")');
  assertStringIncludes(
    profile,
    '(subpath "/Users/op/.vibe-coder/credentials")',
  );
  assertStringIncludes(profile, "(allow network-outbound)");
  // HOME itself is never granted wholesale — only named cache subpaths.
  assert(!profile.includes('(subpath "/Users/op")'), profile);
  assertStringIncludes(profile, '(subpath "/Users/op/.cache")');
});

Deno.test("seatbelt profile - the checkout, config and credentials are read-only; work and logs read-write", () => {
  const profile = buildSeatbeltProfile(INPUTS);
  const readOnlyLine = profile.split("\n").find((l) =>
    l.startsWith("(allow file-read* (subpath")
  )!;
  const readWriteLine = profile.split("\n").find((l) =>
    l.startsWith("(allow file-read* file-write*")
  )!;
  assertStringIncludes(readOnlyLine, "/Users/op/src/VibeCoder");
  assertStringIncludes(readOnlyLine, "/Users/op/.vibe-coder/credentials");
  assert(!readWriteLine.includes("/Users/op/.vibe-coder/credentials"));
  assertStringIncludes(readWriteLine, "/Users/op/auto-issue-work");
  assertStringIncludes(readWriteLine, "/Users/op/logs");
});

Deno.test("seatbelt profile - refuses paths that could break out of the profile syntax", () => {
  assertThrows(
    () => validateProfilePath("relative/path", "x"),
    Error,
    "absolute",
  );
  assertThrows(
    () => validateProfilePath('/Users/op/a"b', "x"),
    Error,
    "cannot be spliced",
  );
  assertThrows(
    () => validateProfilePath("/Users/op/a\nb", "x"),
    Error,
    "cannot be spliced",
  );
  assertThrows(
    () => validateProfilePath("/Users/op/../root", "x"),
    Error,
    "'..'",
  );
  assertEquals(
    validateProfilePath("/nonexistent/op/logs/", "x"),
    "/nonexistent/op/logs",
  );
  assertEquals(validateProfilePath("/", "x"), "/");
});

Deno.test({
  name:
    "seatbelt profile - live: the work dir is usable and a HOME canary outside it is unreadable (macOS only)",
  ignore: Deno.build.os !== "darwin",
  permissions: { run: true, read: true, write: true, env: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "seatbelt_live_" });
    // A fake HOME with the mounted set inside it plus a canary beside them.
    const home = `${root}/home`;
    const inputs = {
      baseDir: `${home}/src/VibeCoder`,
      workDir: `${home}/auto-issue-work`,
      logDir: `${home}/logs`,
      configDir: `${home}/.vibe-coder/run-config`,
      credentialsDir: `${home}/.vibe-coder/credentials`,
      homeDir: home,
      tmpDir: `${root}/tmp`,
    };
    for (const dir of Object.values(inputs)) {
      await Deno.mkdir(dir, { recursive: true });
    }
    await Deno.writeTextFile(
      `${home}/Documents-canary.txt`,
      "must not be readable\n",
    );
    await Deno.writeTextFile(`${inputs.credentialsDir}/hosts.yml`, "user: x\n");
    const profilePath = `${root}/vibe.sb`;
    await Deno.writeTextFile(profilePath, buildSeatbeltProfile(inputs));

    const script = [
      // Allowed: write + read in the work dir.
      `echo ok > "${inputs.workDir}/probe.txt" && cat "${inputs.workDir}/probe.txt"`,
      // Allowed read-only: credentials readable, not writable.
      `cat "${inputs.credentialsDir}/hosts.yml" >/dev/null && echo cred-read-ok`,
      `( echo x > "${inputs.credentialsDir}/evil" ) 2>/dev/null && echo cred-write-BAD || echo cred-write-denied`,
      // Denied: the canary in the same HOME.
      `cat "${home}/Documents-canary.txt" 2>/dev/null && echo canary-BAD || echo canary-denied`,
      // Denied: the tester's real HOME (never in the profile).
      `ls "${
        Deno.env.get("HOME")
      }" >/dev/null 2>&1 && echo realhome-BAD || echo realhome-denied`,
    ].join("; ");
    const out = await new Deno.Command("sandbox-exec", {
      args: ["-f", profilePath, "/bin/sh", "-c", script],
      cwd: inputs.workDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    try {
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      assertStringIncludes(stdout, "ok\n");
      assertStringIncludes(stdout, "cred-read-ok");
      assertStringIncludes(stdout, "cred-write-denied");
      assertStringIncludes(stdout, "canary-denied");
      assertStringIncludes(stdout, "realhome-denied");
      assert(!stdout.includes("BAD"), stdout);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});
