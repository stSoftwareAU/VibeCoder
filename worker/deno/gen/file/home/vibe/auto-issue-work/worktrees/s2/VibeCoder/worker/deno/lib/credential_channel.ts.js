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
 */ /** The prefix every wrapper fault line carries on stderr. */ export const CREDENTIAL_CHANNEL_MARKER = "[vibe-credential-channel]";
/** The exit code the wrapper uses for every fault it reports. */ export const CREDENTIAL_CHANNEL_FAULT_CODE = 78;
/**
 * The sentence that opens every report of a credential delivery fault. It is
 * how the quality gate tells infrastructure from a code fault by output alone.
 */ export const CREDENTIAL_DELIVERY_FAILURE = "the declared quality_credentials could not be delivered to the isolated " + "account (Issue #4705)";
/** True when `output` reports a credential delivery fault. */ export function isCredentialDeliveryFailure(output) {
  return output.startsWith(CREDENTIAL_DELIVERY_FAILURE);
}
/** A name a shell can export: a plain identifier, not starting with a digit. */ const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Names the wrapper keeps for itself: its own variables all start with
 * `_vibe_cc_`, and `IFS` would change how it reads the stream. A declared
 * credential with one of these would silently corrupt the delivery.
 */ const RESERVED_NAME = /^(_vibe_cc_|IFS$)/;
/**
 * The POSIX `sh` program that reads the credential stream, exports each
 * entry, and execs the real command. It uses no `eval`. The first line's
 * marker is the constant above, so a fault line can be recognised.
 */ const WRAPPER_SCRIPT = [
  `fail() { printf '%s %s\\n' "${CREDENTIAL_CHANNEL_MARKER}" "$1" >&2; exit 78; }`,
  'IFS= read -r _vibe_cc_count || fail "no credential header on stdin"',
  "case $_vibe_cc_count in ''|*[!0-9]*) fail \"malformed credential header\";; esac",
  "_vibe_cc_i=0",
  'while [ "$_vibe_cc_i" -lt "$_vibe_cc_count" ]; do',
  '  IFS= read -r _vibe_cc_line || fail "credential stream ended early"',
  "  _vibe_cc_name=${_vibe_cc_line%%=*}",
  "  _vibe_cc_enc=${_vibe_cc_line#*=}",
  "  case $_vibe_cc_name in ''|[0-9]*|*[!A-Za-z0-9_]*) fail \"malformed credential name\";; esac",
  '  _vibe_cc_value=$(printf %s "$_vibe_cc_enc" | base64 -d 2>/dev/null && printf x) || fail "undecodable credential $_vibe_cc_name"',
  "  _vibe_cc_value=${_vibe_cc_value%x}",
  '  export "$_vibe_cc_name=$_vibe_cc_value"',
  "  _vibe_cc_i=$((_vibe_cc_i + 1))",
  "done",
  'exec "$@" </dev/null'
].join("\n");
/**
 * Base64 of the UTF-8 bytes of `text`, built without `btoa` on a long string
 * overflowing the argument limit of `String.fromCharCode`.
 */ function base64OfUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for(let offset = 0; offset < bytes.length; offset += chunk){
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
 */ export function carryCredentialsThroughSudo(spawnable, declared) {
  const entries = Object.entries(declared);
  if (spawnable[0] !== "sudo" || entries.length === 0) {
    return {
      argv: [
        ...spawnable
      ]
    };
  }
  for (const [name, value] of entries){
    if (!CREDENTIAL_NAME.test(name) || RESERVED_NAME.test(name)) {
      throw new Error(`refusing to carry credential ${name} through sudo: a name must be a ` + `plain identifier the wrapper does not reserve (Issue #4705)`);
    }
    if (value.includes("\0")) {
      throw new Error(`refusing to carry credential ${name} through sudo: the value holds ` + `a NUL byte (Issue #4705)`);
    }
  }
  const separator = spawnable.indexOf("--");
  if (separator === -1) {
    throw new Error("refusing to carry credentials through sudo: no -- separator precedes " + "the command (Issue #4705)");
  }
  const at = separator + 1;
  const stdin = [
    `${entries.length}\n`,
    ...entries.map(([name, value])=>`${name}=${base64OfUtf8(value)}\n`)
  ].join("");
  return {
    argv: [
      ...spawnable.slice(0, at),
      "sh",
      "-c",
      WRAPPER_SCRIPT,
      "vibe-credential-channel",
      ...spawnable.slice(at)
    ],
    stdin
  };
}
/**
 * The wrapper's fault line, when `result` is one of its faults.
 *
 * A fault is exit code 78 with the marker on stderr. Anything else returns
 * undefined, so a command's own failure is not mistaken for a channel fault.
 *
 * @returns The stderr line that carries the marker, or undefined.
 */ export function credentialChannelFault(result) {
  if (result.code !== CREDENTIAL_CHANNEL_FAULT_CODE) return undefined;
  return result.stderr.split("\n").find((line)=>line.includes(CREDENTIAL_CHANNEL_MARKER));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jcmVkZW50aWFsX2NoYW5uZWwudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBIGNyZWRlbnRpYWwgY2hhbm5lbCB0aHJvdWdoIGBzdWRvYCAoSXNzdWUgIzQ3MDUpLlxuICpcbiAqIEEgcmVwb3NpdG9yeSdzIGRlY2xhcmVkIGBxdWFsaXR5X2NyZWRlbnRpYWxzYCBoYXZlIHRvIHJlYWNoIHRoZSBjb21tYW5kIHRoZVxuICogd29ya2VyIGRyb3BzIHRvIHRoZSBgYWdlbnRgIGFjY291bnQuIGBzdWRvYCdzIGBlbnZfcmVzZXRgIHN0cmlwcyB0aGUgY2hpbGRcbiAqIGVudmlyb25tZW50IGl0IGlzIGhhbmRlZCwgYW5kIHRoZSBydWxlIHRoZSBvcGVyYXRvciBncmFudGVkIGNhcnJpZXMgbm9cbiAqIGBTRVRFTlZgIHRhZywgc28gYC0tcHJlc2VydmUtZW52YCBpcyBub3QgYXZhaWxhYmxlLiBQdXR0aW5nIHRoZSB2YWx1ZXMgaW5cbiAqIGBhcmd2YCB3b3VsZCBleHBvc2UgdGhlbSB0byBgcHNgIGFuZCB0byB0aGUgc3VkbyBsb2dzLiBBIGZpbGUgd291bGQgbmVlZCBhXG4gKiBwYXRoIHRoYXQgdGhlIGBhZ2VudGAgYWNjb3VudCBjYW4gcmVhZCwgd2hpY2ggaXMgYSB3b3JsZC1yZWFkYWJsZSBzZWNyZXQuXG4gKlxuICogU28gdGhlIHZhbHVlcyB0cmF2ZWwgb24gdGhlIFNURElOIHBpcGUgb2YgdGhlIGRyb3BwZWQgY29tbWFuZC4gQSBmaXhlZFxuICogYHNoIC1jYCB3cmFwcGVyLCBydW5uaW5nIGFzIGBhZ2VudGAgaW5zaWRlIGBzdWRvYCwgcmVhZHMgdGhlbSBmcm9tIHN0ZGluLFxuICogZXhwb3J0cyB0aGVtLCBhbmQgdGhlbiBgZXhlY2BzIHRoZSByZWFsIGNvbW1hbmQgd2l0aCBzdGRpbiBmcm9tIC9kZXYvbnVsbC5cbiAqIE5vdGhpbmcgc2VjcmV0IGlzIGluIGFyZ3YsIGluIHRoZSB3cmFwcGVyJ3Mgc2NyaXB0IHRleHQsIG9yIGluIGEgbG9nIGxpbmUuXG4gKlxuICogVmFsdWVzIGFyZSBiYXNlNjQgZW5jb2RlZCBzbyB0aGF0IG11bHRpLWxpbmUgdmFsdWVzLCB0cmFpbGluZyBuZXdsaW5lcyBhbmRcbiAqIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIHN1cnZpdmUgdGhlIGxpbmUtb3JpZW50ZWQgd2lyZSBmb3JtYXQgdW5jaGFuZ2VkLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKiogVGhlIHByZWZpeCBldmVyeSB3cmFwcGVyIGZhdWx0IGxpbmUgY2FycmllcyBvbiBzdGRlcnIuICovXG5leHBvcnQgY29uc3QgQ1JFREVOVElBTF9DSEFOTkVMX01BUktFUiA9IFwiW3ZpYmUtY3JlZGVudGlhbC1jaGFubmVsXVwiO1xuXG4vKiogVGhlIGV4aXQgY29kZSB0aGUgd3JhcHBlciB1c2VzIGZvciBldmVyeSBmYXVsdCBpdCByZXBvcnRzLiAqL1xuZXhwb3J0IGNvbnN0IENSRURFTlRJQUxfQ0hBTk5FTF9GQVVMVF9DT0RFID0gNzg7XG5cbi8qKlxuICogVGhlIHNlbnRlbmNlIHRoYXQgb3BlbnMgZXZlcnkgcmVwb3J0IG9mIGEgY3JlZGVudGlhbCBkZWxpdmVyeSBmYXVsdC4gSXQgaXNcbiAqIGhvdyB0aGUgcXVhbGl0eSBnYXRlIHRlbGxzIGluZnJhc3RydWN0dXJlIGZyb20gYSBjb2RlIGZhdWx0IGJ5IG91dHB1dCBhbG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IENSRURFTlRJQUxfREVMSVZFUllfRkFJTFVSRSA9XG4gIFwidGhlIGRlY2xhcmVkIHF1YWxpdHlfY3JlZGVudGlhbHMgY291bGQgbm90IGJlIGRlbGl2ZXJlZCB0byB0aGUgaXNvbGF0ZWQgXCIgK1xuICBcImFjY291bnQgKElzc3VlICM0NzA1KVwiO1xuXG4vKiogVHJ1ZSB3aGVuIGBvdXRwdXRgIHJlcG9ydHMgYSBjcmVkZW50aWFsIGRlbGl2ZXJ5IGZhdWx0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ3JlZGVudGlhbERlbGl2ZXJ5RmFpbHVyZShvdXRwdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gb3V0cHV0LnN0YXJ0c1dpdGgoQ1JFREVOVElBTF9ERUxJVkVSWV9GQUlMVVJFKTtcbn1cblxuLyoqIEEgY29tbWFuZCByZWFkeSB0byBzcGF3biwgd2l0aCB0aGUgc3RkaW4gdGV4dCBpdCBuZWVkcyAoaWYgYW55KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2hhbm5lbGxlZENvbW1hbmQge1xuICBhcmd2OiBzdHJpbmdbXTtcbiAgc3RkaW4/OiBzdHJpbmc7XG59XG5cbi8qKiBBIG5hbWUgYSBzaGVsbCBjYW4gZXhwb3J0OiBhIHBsYWluIGlkZW50aWZpZXIsIG5vdCBzdGFydGluZyB3aXRoIGEgZGlnaXQuICovXG5jb25zdCBDUkVERU5USUFMX05BTUUgPSAvXltBLVphLXpfXVtBLVphLXowLTlfXSokLztcblxuLyoqXG4gKiBOYW1lcyB0aGUgd3JhcHBlciBrZWVwcyBmb3IgaXRzZWxmOiBpdHMgb3duIHZhcmlhYmxlcyBhbGwgc3RhcnQgd2l0aFxuICogYF92aWJlX2NjX2AsIGFuZCBgSUZTYCB3b3VsZCBjaGFuZ2UgaG93IGl0IHJlYWRzIHRoZSBzdHJlYW0uIEEgZGVjbGFyZWRcbiAqIGNyZWRlbnRpYWwgd2l0aCBvbmUgb2YgdGhlc2Ugd291bGQgc2lsZW50bHkgY29ycnVwdCB0aGUgZGVsaXZlcnkuXG4gKi9cbmNvbnN0IFJFU0VSVkVEX05BTUUgPSAvXihfdmliZV9jY198SUZTJCkvO1xuXG4vKipcbiAqIFRoZSBQT1NJWCBgc2hgIHByb2dyYW0gdGhhdCByZWFkcyB0aGUgY3JlZGVudGlhbCBzdHJlYW0sIGV4cG9ydHMgZWFjaFxuICogZW50cnksIGFuZCBleGVjcyB0aGUgcmVhbCBjb21tYW5kLiBJdCB1c2VzIG5vIGBldmFsYC4gVGhlIGZpcnN0IGxpbmUnc1xuICogbWFya2VyIGlzIHRoZSBjb25zdGFudCBhYm92ZSwgc28gYSBmYXVsdCBsaW5lIGNhbiBiZSByZWNvZ25pc2VkLlxuICovXG5jb25zdCBXUkFQUEVSX1NDUklQVCA9IFtcbiAgYGZhaWwoKSB7IHByaW50ZiAnJXMgJXNcXFxcbicgXCIke0NSRURFTlRJQUxfQ0hBTk5FTF9NQVJLRVJ9XCIgXCIkMVwiID4mMjsgZXhpdCA3ODsgfWAsXG4gICdJRlM9IHJlYWQgLXIgX3ZpYmVfY2NfY291bnQgfHwgZmFpbCBcIm5vIGNyZWRlbnRpYWwgaGVhZGVyIG9uIHN0ZGluXCInLFxuICBcImNhc2UgJF92aWJlX2NjX2NvdW50IGluICcnfCpbITAtOV0qKSBmYWlsIFxcXCJtYWxmb3JtZWQgY3JlZGVudGlhbCBoZWFkZXJcXFwiOzsgZXNhY1wiLFxuICBcIl92aWJlX2NjX2k9MFwiLFxuICAnd2hpbGUgWyBcIiRfdmliZV9jY19pXCIgLWx0IFwiJF92aWJlX2NjX2NvdW50XCIgXTsgZG8nLFxuICAnICBJRlM9IHJlYWQgLXIgX3ZpYmVfY2NfbGluZSB8fCBmYWlsIFwiY3JlZGVudGlhbCBzdHJlYW0gZW5kZWQgZWFybHlcIicsXG4gIFwiICBfdmliZV9jY19uYW1lPSR7X3ZpYmVfY2NfbGluZSUlPSp9XCIsXG4gIFwiICBfdmliZV9jY19lbmM9JHtfdmliZV9jY19saW5lIyo9fVwiLFxuICBcIiAgY2FzZSAkX3ZpYmVfY2NfbmFtZSBpbiAnJ3xbMC05XSp8KlshQS1aYS16MC05X10qKSBmYWlsIFxcXCJtYWxmb3JtZWQgY3JlZGVudGlhbCBuYW1lXFxcIjs7IGVzYWNcIixcbiAgJyAgX3ZpYmVfY2NfdmFsdWU9JChwcmludGYgJXMgXCIkX3ZpYmVfY2NfZW5jXCIgfCBiYXNlNjQgLWQgMj4vZGV2L251bGwgJiYgcHJpbnRmIHgpIHx8IGZhaWwgXCJ1bmRlY29kYWJsZSBjcmVkZW50aWFsICRfdmliZV9jY19uYW1lXCInLFxuICBcIiAgX3ZpYmVfY2NfdmFsdWU9JHtfdmliZV9jY192YWx1ZSV4fVwiLFxuICAnICBleHBvcnQgXCIkX3ZpYmVfY2NfbmFtZT0kX3ZpYmVfY2NfdmFsdWVcIicsXG4gIFwiICBfdmliZV9jY19pPSQoKF92aWJlX2NjX2kgKyAxKSlcIixcbiAgXCJkb25lXCIsXG4gICdleGVjIFwiJEBcIiA8L2Rldi9udWxsJyxcbl0uam9pbihcIlxcblwiKTtcblxuLyoqXG4gKiBCYXNlNjQgb2YgdGhlIFVURi04IGJ5dGVzIG9mIGB0ZXh0YCwgYnVpbHQgd2l0aG91dCBgYnRvYWAgb24gYSBsb25nIHN0cmluZ1xuICogb3ZlcmZsb3dpbmcgdGhlIGFyZ3VtZW50IGxpbWl0IG9mIGBTdHJpbmcuZnJvbUNoYXJDb2RlYC5cbiAqL1xuZnVuY3Rpb24gYmFzZTY0T2ZVdGY4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpO1xuICBsZXQgYmluYXJ5ID0gXCJcIjtcbiAgY29uc3QgY2h1bmsgPSAweDgwMDA7XG4gIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGJ5dGVzLmxlbmd0aDsgb2Zmc2V0ICs9IGNodW5rKSB7XG4gICAgYmluYXJ5ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoLi4uYnl0ZXMuc3ViYXJyYXkob2Zmc2V0LCBvZmZzZXQgKyBjaHVuaykpO1xuICB9XG4gIHJldHVybiBidG9hKGJpbmFyeSk7XG59XG5cbi8qKlxuICogUm91dGUgdGhlIGRlY2xhcmVkIGNyZWRlbnRpYWxzIHRvIHRoZSBjb21tYW5kIHRocm91Z2ggaXRzIHN0ZGluLlxuICpcbiAqIEEgc3Bhd24gdGhhdCBpcyBub3QgdW5kZXIgYHN1ZG9gLCBvciB0aGF0IGRlY2xhcmVzIG5vdGhpbmcsIGlzIHJldHVybmVkXG4gKiB1bmNoYW5nZWQgd2l0aCBubyBzdGRpbjogYSB3b3JrZXItYWNjb3VudCBzcGF3biB0YWtlcyBpdHMgZW52aXJvbm1lbnQgZnJvbVxuICogYERlbm8uQ29tbWFuZGAgZGlyZWN0bHkuIFVuZGVyIGBzdWRvYCwgdGhlIHdyYXBwZXIgaXMgaW5zZXJ0ZWQgc3RyYWlnaHRcbiAqIGFmdGVyIHRoZSBmaXJzdCBgLS1gLCBzbyB0aGUgb3JpZ2luYWwgY29tbWFuZCBmb2xsb3dzIGl0IGFzIGBcIiRAXCJgIGFuZCBhbnlcbiAqIGBlbnZgIHByZWZpeCB0aGUgY2FsbGVyIGFscmVhZHkgYnVpbHQgaXMgcHJlc2VydmVkLlxuICpcbiAqIEV2ZXJ5IG5hbWUgYW5kIHZhbHVlIGlzIGNoZWNrZWQgYmVmb3JlIGFueXRoaW5nIGlzIGJ1aWx0LiBUaGUgZXJyb3IgbmFtZXNcbiAqIG9ubHkgdGhlIHZhcmlhYmxlLCBuZXZlciBpdHMgdmFsdWUuXG4gKlxuICogQHBhcmFtIHNwYXduYWJsZSAtIFRoZSBmaW5pc2hlZCBhcmd2LCBgc3Vkb2Atd3JhcHBlZCBvciBub3QuXG4gKiBAcGFyYW0gZGVjbGFyZWQgLSBUaGUgY3JlZGVudGlhbHMgdGhpcyByZXBvc2l0b3J5IGRlY2xhcmVkLlxuICogQHJldHVybnMgVGhlIGFyZ3YgdG8gc3Bhd24gYW5kLCB3aGVuIGNyZWRlbnRpYWxzIGFyZSBjYXJyaWVkLCB0aGUgc3RkaW4uXG4gKiBAdGhyb3dzIFdoZW4gYSBuYW1lIGlzIG5vdCBhIHBsYWluIGlkZW50aWZpZXIsIGEgdmFsdWUgY29udGFpbnMgYSBOVUwgYnl0ZSxcbiAqICAgb3IgYSBgc3Vkb2AgYXJndiBoYXMgbm8gYC0tYCB0byBpbnNlcnQgdGhlIHdyYXBwZXIgYWZ0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYXJyeUNyZWRlbnRpYWxzVGhyb3VnaFN1ZG8oXG4gIHNwYXduYWJsZTogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGRlY2xhcmVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogQ2hhbm5lbGxlZENvbW1hbmQge1xuICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMoZGVjbGFyZWQpO1xuICBpZiAoc3Bhd25hYmxlWzBdICE9PSBcInN1ZG9cIiB8fCBlbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IGFyZ3Y6IFsuLi5zcGF3bmFibGVdIH07XG4gIH1cbiAgZm9yIChjb25zdCBbbmFtZSwgdmFsdWVdIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoIUNSRURFTlRJQUxfTkFNRS50ZXN0KG5hbWUpIHx8IFJFU0VSVkVEX05BTUUudGVzdChuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gY2FycnkgY3JlZGVudGlhbCAke25hbWV9IHRocm91Z2ggc3VkbzogYSBuYW1lIG11c3QgYmUgYSBgICtcbiAgICAgICAgICBgcGxhaW4gaWRlbnRpZmllciB0aGUgd3JhcHBlciBkb2VzIG5vdCByZXNlcnZlIChJc3N1ZSAjNDcwNSlgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHZhbHVlLmluY2x1ZGVzKFwiXFwwXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBjYXJyeSBjcmVkZW50aWFsICR7bmFtZX0gdGhyb3VnaCBzdWRvOiB0aGUgdmFsdWUgaG9sZHMgYCArXG4gICAgICAgICAgYGEgTlVMIGJ5dGUgKElzc3VlICM0NzA1KWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBzZXBhcmF0b3IgPSBzcGF3bmFibGUuaW5kZXhPZihcIi0tXCIpO1xuICBpZiAoc2VwYXJhdG9yID09PSAtMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwicmVmdXNpbmcgdG8gY2FycnkgY3JlZGVudGlhbHMgdGhyb3VnaCBzdWRvOiBubyAtLSBzZXBhcmF0b3IgcHJlY2VkZXMgXCIgK1xuICAgICAgICBcInRoZSBjb21tYW5kIChJc3N1ZSAjNDcwNSlcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGF0ID0gc2VwYXJhdG9yICsgMTtcbiAgY29uc3Qgc3RkaW4gPSBbXG4gICAgYCR7ZW50cmllcy5sZW5ndGh9XFxuYCxcbiAgICAuLi5lbnRyaWVzLm1hcCgoW25hbWUsIHZhbHVlXSkgPT4gYCR7bmFtZX09JHtiYXNlNjRPZlV0ZjgodmFsdWUpfVxcbmApLFxuICBdLmpvaW4oXCJcIik7XG4gIHJldHVybiB7XG4gICAgYXJndjogW1xuICAgICAgLi4uc3Bhd25hYmxlLnNsaWNlKDAsIGF0KSxcbiAgICAgIFwic2hcIixcbiAgICAgIFwiLWNcIixcbiAgICAgIFdSQVBQRVJfU0NSSVBULFxuICAgICAgXCJ2aWJlLWNyZWRlbnRpYWwtY2hhbm5lbFwiLFxuICAgICAgLi4uc3Bhd25hYmxlLnNsaWNlKGF0KSxcbiAgICBdLFxuICAgIHN0ZGluLFxuICB9O1xufVxuXG4vKipcbiAqIFRoZSB3cmFwcGVyJ3MgZmF1bHQgbGluZSwgd2hlbiBgcmVzdWx0YCBpcyBvbmUgb2YgaXRzIGZhdWx0cy5cbiAqXG4gKiBBIGZhdWx0IGlzIGV4aXQgY29kZSA3OCB3aXRoIHRoZSBtYXJrZXIgb24gc3RkZXJyLiBBbnl0aGluZyBlbHNlIHJldHVybnNcbiAqIHVuZGVmaW5lZCwgc28gYSBjb21tYW5kJ3Mgb3duIGZhaWx1cmUgaXMgbm90IG1pc3Rha2VuIGZvciBhIGNoYW5uZWwgZmF1bHQuXG4gKlxuICogQHJldHVybnMgVGhlIHN0ZGVyciBsaW5lIHRoYXQgY2FycmllcyB0aGUgbWFya2VyLCBvciB1bmRlZmluZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVkZW50aWFsQ2hhbm5lbEZhdWx0KHJlc3VsdDoge1xuICBjb2RlOiBudW1iZXI7XG4gIHN0ZGVycjogc3RyaW5nO1xufSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmIChyZXN1bHQuY29kZSAhPT0gQ1JFREVOVElBTF9DSEFOTkVMX0ZBVUxUX0NPREUpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiByZXN1bHQuc3RkZXJyXG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLmZpbmQoKGxpbmUpID0+IGxpbmUuaW5jbHVkZXMoQ1JFREVOVElBTF9DSEFOTkVMX01BUktFUikpO1xufVxuIl0s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
// denoCacheMetadata=13786081114034137030,6927287865387323943