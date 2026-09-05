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
 * then the default. Issue #873 moved that default off `$HOME/logs` and onto
 * the platform's own standard location — the defaults themselves are covered
 * by `log_dir_default_test.ts`; what this suite pins is the precedence.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { resolveLogDir } from "../lib/container_launch.ts";
import { defaultLogDir } from "../lib/log_dir.ts";

const envFrom =
  (vars: Record<string, string>) => (name: string): string | undefined =>
    vars[name];

Deno.test("log dir - falls back to the platform default when nothing is set (Issues #872, #873)", () => {
  // Was `$HOME/logs` until Issue #873 moved the default onto the platform's
  // own location; the fallback step in the chain is what this asserts.
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({}), "posix", "linux"),
    defaultLogDir("/home/vibe", envFrom({}), "posix", "linux"),
  );
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({}), "posix", "linux"),
    "/home/vibe/.local/state/vibe-coder",
  );
});

Deno.test("log dir - LOG_DIR is honoured (Issue #872)", () => {
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LOG_DIR: "/var/log/vibe" }),
      "posix",
      "linux",
    ),
    "/var/log/vibe",
  );
});

Deno.test("log dir - LAUNCH_LOG_DIR outranks LOG_DIR, as loop.sh has it (Issue #872)", () => {
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LAUNCH_LOG_DIR: "/var/log/launch", LOG_DIR: "/var/log/vibe" }),
      "posix",
      "linux",
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
    const resolved = resolveLogDir(
      "/home/vibe",
      envFrom(vars),
      "posix",
      "linux",
    );
    assertEquals(
      resolved === "" || resolved === "/home/vibe" ? "bad" : "ok",
      "ok",
      `blank must not resolve to an empty or bare-home path: ${
        JSON.stringify(vars)
      } -> ${resolved}`,
    );
  }
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({ LOG_DIR: "" }), "posix", "linux"),
    "/home/vibe/.local/state/vibe-coder",
  );
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LAUNCH_LOG_DIR: "  ", LOG_DIR: "/var/log/vibe" }),
      "posix",
      "linux",
    ),
    "/var/log/vibe",
    "a blank LAUNCH_LOG_DIR falls through to LOG_DIR",
  );
});

Deno.test("log dir - a Windows host spells the default its own way (Issue #872)", () => {
  const resolved = resolveLogDir(
    "C:\\Users\\vibe",
    envFrom({}),
    "windows",
    "windows",
  );
  assertEquals(resolved.includes("logs"), true);
  assertEquals(resolved.startsWith("C:"), true);
  assertEquals(resolved.includes("/"), false, "no POSIX separators leak in");
});
