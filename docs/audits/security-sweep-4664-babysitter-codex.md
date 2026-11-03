# Security sweep — babysitter Codex installer

This record covers `worker/deno/lib/fleet_babysitter_codex.ts`, introduced for
[#4664](https://github.com/stSoftwareAU/VibeCoder/issues/4664). The review
also read its callers, `fleet_babysitter_sandbox.ts`, the manifest parser and
`fleet_babysitter_codex_test.ts`.

The installer runs on the babysitter host before the repair agent starts. It
uses a sufficiently recent `codex` on the host PATH, or downloads the CLI and
code-mode host from a fixed GitHub release URL. The manifest parser requires an
exact version and 64-character SHA-256 pins; both downloaded archives must
match their respective pins before `tar` extracts them. The extraction command
uses an argument vector and a 120-second timeout. The installer stages files in
a temporary directory under the user's Codex installation directory, checks
the staged CLI version, then renames the directory into place. A concurrent
install that already reports an acceptable version is reused.

The agent sandbox grants the host filesystem read access and grants write
access to the clone and scratch directory; the install directory is outside
those explicit write grants. The installer trusts the host PATH, the manifest,
the installation directory and the archive contents matching the pins. A
checksum does not protect against a compromised pin or release artefact. The
tests cover the PATH and install paths, checksum mismatch, an unsupported
platform and reuse; they do not test a compromised trusted archive.

Availability remains a risk: `fetch` has no timeout and `arrayBuffer()` reads
the whole response without a size limit before checking its digest. A stalled
or oversized response can delay the babysitter or exhaust host memory. Failed
temporary-directory cleanup is ignored, so failed installs may leave staging
files. No network fault or oversized response was exercised in this sweep.
