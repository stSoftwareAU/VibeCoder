/**
 * A credential channel through `sudo` (Issue #4705).
 *
 * A repository's declared `quality_credentials` have to reach the command the
 * worker drops to the `agent` account. `sudo`'s `env_reset` strips the child
 * environment it is handed, and the rule the operator granted carries no
 * `SETENV` tag, so `--preserve-env` is not available. Putting the values in
 * `argv` would expose them to `ps` and to the sudo logs. A file would need a
 * path that the `agent` account can read, which is a world-readable secret.
 *
 * So the values travel on the STDIN pipe of the dropped command. A fixed
 * `sh -c` wrapper, running as `agent` inside `sudo`, reads them from stdin,
 * exports them, and then `exec`s the real command with stdin from /dev/null.
 * Nothing secret is in argv, in the wrapper's script text, or in a log line.
 *
 * Values are base64 encoded so that multi-line values, trailing newlines and
 * shell metacharacters survive the line-oriented wire format unchanged.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

/** The prefix every wrapper fault line carries on stderr. */
export const CREDENTIAL_CHANNEL_MARKER = "[vibe-credential-channel]";

/** The exit code the wrapper uses for every fault it reports. */
export const CREDENTIAL_CHANNEL_FAULT_CODE = 78;

/** A command ready to spawn, with the stdin text it needs (if any). */
export interface ChannelledCommand {
  argv: string[];
  stdin?: string;
}

/** A name a shell can export: a plain identifier, not starting with a digit. */
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The POSIX `sh` program that reads the credential stream, exports each
 * entry, and execs the real command. It uses no `eval`. The first line's
 * marker is the constant above, so a fault line can be recognised.
 */
const WRAPPER_SCRIPT = [
  `fail() { printf '%s %s\\n' "${CREDENTIAL_CHANNEL_MARKER}" "$1" >&2; exit 78; }`,
  'IFS= read -r count || fail "no credential header on stdin"',
  "case $count in ''|*[!0-9]*) fail \"malformed credential header\";; esac",
  "i=0",
  'while [ "$i" -lt "$count" ]; do',
  '  IFS= read -r line || fail "credential stream ended early"',
  "  name=${line%%=*}",
  "  enc=${line#*=}",
  "  case $name in ''|[0-9]*|*[!A-Za-z0-9_]*) fail \"malformed credential name\";; esac",
  '  value=$(printf %s "$enc" | base64 -d 2>/dev/null && printf x) || fail "undecodable credential $name"',
  "  value=${value%x}",
  '  export "$name=$value"',
  "  i=$((i + 1))",
  "done",
  'exec "$@" </dev/null',
].join("\n");

/**
 * Base64 of the UTF-8 bytes of `text`, built without `btoa` on a long string
 * overflowing the argument limit of `String.fromCharCode`.
 */
function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Route the declared credentials to the command through its stdin.
 *
 * A spawn that is not under `sudo`, or that declares nothing, is returned
 * unchanged with no stdin: a worker-account spawn takes its environment from
 * `Deno.Command` directly. Under `sudo`, the wrapper is inserted straight
 * after the first `--`, so the original command follows it as `"$@"` and any
 * `env` prefix the caller already built is preserved.
 *
 * Every name and value is checked before anything is built. The error names
 * only the variable, never its value.
 *
 * @param spawnable - The finished argv, `sudo`-wrapped or not.
 * @param declared - The credentials this repository declared.
 * @returns The argv to spawn and, when credentials are carried, the stdin.
 * @throws When a name is not a plain identifier, a value contains a NUL byte,
 *   or a `sudo` argv has no `--` to insert the wrapper after.
 */
export function carryCredentialsThroughSudo(
  spawnable: readonly string[],
  declared: Record<string, string>,
): ChannelledCommand {
  const entries = Object.entries(declared);
  if (spawnable[0] !== "sudo" || entries.length === 0) {
    return { argv: [...spawnable] };
  }
  for (const [name, value] of entries) {
    if (!CREDENTIAL_NAME.test(name)) {
      throw new Error(
        `refusing to carry credential ${name} through sudo: a name must be a ` +
          `plain identifier (Issue #4705)`,
      );
    }
    if (value.includes("\0")) {
      throw new Error(
        `refusing to carry credential ${name} through sudo: the value holds ` +
          `a NUL byte (Issue #4705)`,
      );
    }
  }
  const separator = spawnable.indexOf("--");
  if (separator === -1) {
    throw new Error(
      "refusing to carry credentials through sudo: no -- separator precedes " +
        "the command (Issue #4705)",
    );
  }
  const at = separator + 1;
  const stdin = [
    `${entries.length}\n`,
    ...entries.map(([name, value]) => `${name}=${base64OfUtf8(value)}\n`),
  ].join("");
  return {
    argv: [
      ...spawnable.slice(0, at),
      "sh",
      "-c",
      WRAPPER_SCRIPT,
      "vibe-credential-channel",
      ...spawnable.slice(at),
    ],
    stdin,
  };
}

/**
 * The wrapper's fault line, when `result` is one of its faults.
 *
 * A fault is exit code 78 with the marker on stderr. Anything else returns
 * undefined, so a command's own failure is not mistaken for a channel fault.
 *
 * @returns The stderr line that carries the marker, or undefined.
 */
export function credentialChannelFault(result: {
  code: number;
  stderr: string;
}): string | undefined {
  if (result.code !== CREDENTIAL_CHANNEL_FAULT_CODE) return undefined;
  return result.stderr
    .split("\n")
    .find((line) => line.includes(CREDENTIAL_CHANNEL_MARKER));
}
