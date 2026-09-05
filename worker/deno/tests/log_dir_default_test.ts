/**
 * Issue #873: the default log directory follows the platform's own standard.
 *
 * `$HOME/logs` follows no convention: it is not a location XDG, macOS or any
 * system-service layout nominates, and it drops fleet state — rotated
 * `worker-*.log(.gz)`, `launch-*.log`, PID and failure-streak files — straight
 * into the operator's home directory beside their own files.
 *
 * The default is now the platform's:
 *
 * | Platform | Default                                                     |
 * | -------- | ----------------------------------------------------------- |
 * | Linux    | `$XDG_STATE_HOME/vibe-coder`, else `~/.local/state/vibe-coder` |
 * | macOS    | `~/Library/Logs/vibe-coder`                                   |
 * | Windows  | `%LOCALAPPDATA%\vibe-coder\logs`                              |
 *
 * The overrides Issue #872 unified — `LAUNCH_LOG_DIR`, then `LOG_DIR` — still
 * outrank the default, so a system service keeps its logs in
 * `/var/log/vibe-coder` by naming it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultLogDir,
  legacyLogDir,
  legacyLogDirNotice,
  normaliseLogDirPlatform,
  resolveLogDir,
} from "../lib/log_dir.ts";
import { resolveLogDirForCommand } from "../commands/log_dir.ts";

const envFrom =
  (vars: Record<string, string>) => (name: string): string | undefined =>
    vars[name];

Deno.test("log dir - Linux defaults to ~/.local/state/vibe-coder (Issue #873)", () => {
  assertEquals(
    defaultLogDir("/home/vibe", envFrom({}), "posix", "linux"),
    "/home/vibe/.local/state/vibe-coder",
  );
});

Deno.test("log dir - Linux honours XDG_STATE_HOME (Issue #873)", () => {
  assertEquals(
    defaultLogDir(
      "/home/vibe",
      envFrom({ XDG_STATE_HOME: "/srv/state" }),
      "posix",
      "linux",
    ),
    "/srv/state/vibe-coder",
  );
});

Deno.test("log dir - a blank or relative XDG_STATE_HOME is ignored (Issue #873)", () => {
  // The XDG specification says a relative value "must be ignored"; a blank
  // exported variable means unset, exactly as the overrides treat it.
  for (const value of ["", "   ", "state", "./state"]) {
    assertEquals(
      defaultLogDir(
        "/home/vibe",
        envFrom({ XDG_STATE_HOME: value }),
        "posix",
        "linux",
      ),
      "/home/vibe/.local/state/vibe-coder",
      `XDG_STATE_HOME=${JSON.stringify(value)} must not be used`,
    );
  }
});

Deno.test("log dir - macOS defaults to ~/Library/Logs/vibe-coder (Issue #873)", () => {
  assertEquals(
    defaultLogDir("/Users/vibe", envFrom({}), "posix", "darwin"),
    "/Users/vibe/Library/Logs/vibe-coder",
  );
  // Console.app reads that directory; XDG is not a macOS convention, so a
  // value inherited from a shell profile must not move the logs there.
  assertEquals(
    defaultLogDir(
      "/Users/vibe",
      envFrom({ XDG_STATE_HOME: "/srv/state" }),
      "posix",
      "darwin",
    ),
    "/Users/vibe/Library/Logs/vibe-coder",
  );
});

Deno.test("log dir - Windows defaults under LOCALAPPDATA (Issue #873)", () => {
  assertEquals(
    defaultLogDir(
      "C:\\Users\\vibe",
      envFrom({ LOCALAPPDATA: "C:\\Users\\vibe\\AppData\\Local" }),
      "windows",
      "windows",
    ),
    "C:\\Users\\vibe\\AppData\\Local\\vibe-coder\\logs",
  );
  assertEquals(
    defaultLogDir("C:\\Users\\vibe", envFrom({}), "windows", "windows"),
    "C:\\Users\\vibe\\AppData\\Local\\vibe-coder\\logs",
  );
});

Deno.test("log dir - the overrides still outrank the platform default (Issue #873)", () => {
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LOG_DIR: "/var/log/vibe-coder" }),
      "posix",
      "linux",
    ),
    "/var/log/vibe-coder",
    "a system service names its own directory",
  );
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LAUNCH_LOG_DIR: "/var/log/launch", LOG_DIR: "/var/log/vibe" }),
      "posix",
      "linux",
    ),
    "/var/log/launch",
  );
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({ LOG_DIR: "  " }), "posix", "linux"),
    "/home/vibe/.local/state/vibe-coder",
    "a blank override falls through to the default",
  );
});

Deno.test("log dir - the platform name is normalised the way Deno spells it (Issue #873)", () => {
  assertEquals(normaliseLogDirPlatform("linux"), "linux");
  assertEquals(normaliseLogDirPlatform("darwin"), "darwin");
  assertEquals(normaliseLogDirPlatform("windows"), "windows");
  // Anything else is treated as a generic POSIX host rather than guessed at.
  assertEquals(normaliseLogDirPlatform("freebsd"), "linux");
});

Deno.test("log dir - the legacy location is named, never migrated (Issue #873)", () => {
  const notice = legacyLogDirNotice({
    home: "/home/vibe",
    env: envFrom({}),
    style: "posix",
    platform: "linux",
    exists: (path) => path === "/home/vibe/logs",
  });
  assertEquals(typeof notice, "string");
  const message = notice as string;
  assertStringIncludes(message, "/home/vibe/logs");
  assertStringIncludes(message, "/home/vibe/.local/state/vibe-coder");
  // The old directory is left alone: the notice offers the move, it does not
  // make it, and it says nothing was deleted.
  assertStringIncludes(message, "mv /home/vibe/logs");
  assertStringIncludes(message, "left untouched");
  assertEquals(legacyLogDir("/home/vibe", "posix"), "/home/vibe/logs");
});

Deno.test("log dir - no notice once the new location exists (Issue #873)", () => {
  assertEquals(
    legacyLogDirNotice({
      home: "/home/vibe",
      env: envFrom({}),
      style: "posix",
      platform: "linux",
      exists: () => true,
    }),
    undefined,
    "a host that already has the new directory has nothing to be told",
  );
});

Deno.test("log dir - no notice without a legacy directory (Issue #873)", () => {
  assertEquals(
    legacyLogDirNotice({
      home: "/home/vibe",
      env: envFrom({}),
      style: "posix",
      platform: "linux",
      exists: () => false,
    }),
    undefined,
    "a fresh host never had $HOME/logs",
  );
});

Deno.test("log dir - no notice when the operator set the location (Issue #873)", () => {
  const overrides: Record<string, string>[] = [
    { LOG_DIR: "/var/log/vibe-coder" },
    { LAUNCH_LOG_DIR: "/var/log/vibe-coder" },
  ];
  for (const vars of overrides) {
    assertEquals(
      legacyLogDirNotice({
        home: "/home/vibe",
        env: envFrom(vars),
        style: "posix",
        platform: "linux",
        exists: (path) => path === "/home/vibe/logs",
      }),
      undefined,
      `${JSON.stringify(vars)} is the operator's choice, not a default move`,
    );
  }
});

Deno.test("log dir - an operator who keeps $HOME/logs is not nagged (Issue #873)", () => {
  // LOG_DIR=$HOME/logs is the documented way to stay on the old location:
  // the resolved directory IS the legacy one, so there is nothing to move.
  assertEquals(
    legacyLogDirNotice({
      home: "/home/vibe",
      env: envFrom({ LOG_DIR: "/home/vibe/logs" }),
      style: "posix",
      platform: "linux",
      exists: (path) => path === "/home/vibe/logs",
    }),
    undefined,
  );
});

Deno.test("log dir - the Windows notice offers a Windows move (Issue #873)", () => {
  const notice = legacyLogDirNotice({
    home: "C:\\Users\\vibe",
    env: envFrom({ LOCALAPPDATA: "C:\\Users\\vibe\\AppData\\Local" }),
    style: "windows",
    platform: "windows",
    exists: (path) => path === "C:\\Users\\vibe\\logs",
  });
  assertStringIncludes(notice as string, "move ");
  assertStringIncludes(notice as string, "C:\\Users\\vibe\\logs");
});

// The `log-dir` command is how run.sh, loop.sh and run.ps1 reach the
// resolution above: they capture its stdout rather than spelling the default
// in shell, so there is one default and not four (Issues #872, #873).

Deno.test("log-dir command - answers with the platform default (Issue #873)", () => {
  const result = resolveLogDirForCommand({
    env: envFrom({ HOME: "/home/vibe" }),
    platform: "linux",
    exists: () => false,
  });
  assertEquals(result.logDir, "/home/vibe/.local/state/vibe-coder");
  assertEquals(result.notice, undefined);
});

Deno.test("log-dir command - carries the legacy notice for the launcher to print (Issue #873)", () => {
  const result = resolveLogDirForCommand({
    env: envFrom({ HOME: "/home/vibe" }),
    platform: "linux",
    exists: (path) => path === "/home/vibe/logs",
  });
  assertEquals(result.logDir, "/home/vibe/.local/state/vibe-coder");
  assertStringIncludes(result.notice ?? "", "/home/vibe/logs");
});

Deno.test("log-dir command - a Windows host is answered in its own spelling (Issue #873)", () => {
  const result = resolveLogDirForCommand({
    env: envFrom({
      USERPROFILE: "C:\\Users\\vibe",
      LOCALAPPDATA: "C:\\Users\\vibe\\AppData\\Local",
    }),
    platform: "windows",
    exists: () => false,
  });
  assertEquals(
    result.logDir,
    "C:\\Users\\vibe\\AppData\\Local\\vibe-coder\\logs",
  );
});

Deno.test("log-dir command - fails loud with no home directory (Issue #873)", () => {
  // A launcher handed a path relative to nothing would write its logs into
  // whatever directory it happened to be started from.
  let message = "";
  try {
    resolveLogDirForCommand({ env: envFrom({}), platform: "linux" });
  } catch (error) {
    message = (error as Error).message;
  }
  assertStringIncludes(message, "HOME");
});
