/**
 * Shared ShellCheck test seams (Issue #4631): a stub binary for hermetic unit
 * tests, and the host's real binary for the few tests that need a genuine
 * diagnostic. Unit tests must not inherit the host's tools, so the real-binary
 * tests are skipped on a host without ShellCheck and read the version from the
 * binary they find, never from a typed-in literal.
 */
import {
  findShellcheckBinary,
  type ShellcheckVersionProbe,
} from "../../lib/pre_push_gate.ts";

/** The version a stub-driven fixture workflow declares and the stub reports. */
export const STUB_SHELLCHECK_VERSION = "1.2.3";

/** `findShellcheck` and `readShellcheckVersion` seams for a stub binary. */
export function stubShellcheck(version: string = STUB_SHELLCHECK_VERSION): {
  findShellcheck: () => Promise<string | null>;
  readShellcheckVersion: ShellcheckVersionProbe;
} {
  return {
    findShellcheck: () => Promise.resolve("/stub/shellcheck"),
    readShellcheckVersion: () =>
      Promise.resolve({
        code: 0,
        stdout:
          `ShellCheck - shell script analysis tool\nversion: ${version}\nlicense: GPL\n`,
      }),
  };
}

/** The host's ShellCheck and its version, or null when it has none. */
export async function probeRealShellcheck(): Promise<
  { binary: string; version: string } | null
> {
  const binary = await findShellcheckBinary(Deno.env.get("PATH") ?? "");
  if (!binary) return null;
  try {
    const out = await new Deno.Command(binary, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const version = /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(
      new TextDecoder().decode(out.stdout),
    )?.[1];
    return out.success && version ? { binary, version } : null;
  } catch {
    return null;
  }
}

/** Resolved once per test process. */
export const REAL_SHELLCHECK = await probeRealShellcheck();

/** Deno.test options that skip a real-binary test on a host without ShellCheck. */
export const REQUIRES_REAL_SHELLCHECK = { ignore: REAL_SHELLCHECK === null };
