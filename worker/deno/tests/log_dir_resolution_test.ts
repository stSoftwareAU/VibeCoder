/**
 * Issue #872: one resolution of the log directory, honoured everywhere.
 *
 * `LOG_DIR` was read by `loop.sh:56` and ignored by `run.sh` and
 * `container_launch.ts`, which both hardcoded `$HOME/logs`. Setting it
 * therefore **split** the logs: `launch-*.log` moved, `run_core.log` and
 * every `worker-*.log` did not, with nothing reporting that the setting had
 * been half-applied.
 *
 * The container mount made it worse than cosmetic. `logDir` is the fleet's
 * only writable host path — the checkout is mounted read-only and work and
 * approval state are named volumes — so the worker's own logs could not be
 * relocated at all, which is the one host path an operator may legitimately
 * need to move (a different volume, a log-shipping directory, somewhere the
 * platform already rotates).
 *
 * Precedence matches `loop.sh` exactly: `LAUNCH_LOG_DIR`, then `LOG_DIR`,
 * then `$HOME/logs`. The default is not a standard location; moving it is a
 * breaking change tracked separately (Issue #873).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { resolveLogDir } from "../lib/container_launch.ts";

const envFrom =
  (vars: Record<string, string>) => (name: string): string | undefined =>
    vars[name];

Deno.test("log dir - defaults to $HOME/logs when nothing is set (Issue #872)", () => {
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({}), "posix"),
    "/home/vibe/logs",
  );
});

Deno.test("log dir - LOG_DIR is honoured (Issue #872)", () => {
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({ LOG_DIR: "/var/log/vibe" }), "posix"),
    "/var/log/vibe",
  );
});

Deno.test("log dir - LAUNCH_LOG_DIR outranks LOG_DIR, as loop.sh has it (Issue #872)", () => {
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LAUNCH_LOG_DIR: "/var/log/launch", LOG_DIR: "/var/log/vibe" }),
      "posix",
    ),
    "/var/log/launch",
  );
});

Deno.test("log dir - a blank value is treated as unset (Issue #872)", () => {
  // An exported-but-empty variable meant the empty string, which would have
  // mounted the wrong host path into the container.
  const blankCases: Record<string, string>[] = [
    { LOG_DIR: "" },
    { LOG_DIR: "   " },
    { LAUNCH_LOG_DIR: "", LOG_DIR: "/var/log/vibe" },
  ];
  for (const vars of blankCases) {
    const resolved = resolveLogDir("/home/vibe", envFrom(vars), "posix");
    assertEquals(
      resolved === "" || resolved === "/home/vibe" ? "bad" : "ok",
      "ok",
      `blank must not resolve to an empty or bare-home path: ${
        JSON.stringify(vars)
      } -> ${resolved}`,
    );
  }
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({ LOG_DIR: "" }), "posix"),
    "/home/vibe/logs",
  );
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LAUNCH_LOG_DIR: "  ", LOG_DIR: "/var/log/vibe" }),
      "posix",
    ),
    "/var/log/vibe",
    "a blank LAUNCH_LOG_DIR falls through to LOG_DIR",
  );
});

Deno.test("log dir - a Windows host spells the default its own way (Issue #872)", () => {
  const resolved = resolveLogDir("C:\\Users\\vibe", envFrom({}), "windows");
  assertEquals(resolved.includes("logs"), true);
  assertEquals(resolved.startsWith("C:"), true);
});
