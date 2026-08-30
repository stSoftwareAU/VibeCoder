/**
 * Tests for the dedicated secrets mount (Issue #570).
 *
 * Credentials belong on a memory-backed mount of their own, away from the
 * agents' scratch — the shape every runtime with a secrets primitive uses.
 * Issue #564 is what that prevents: the gh credential was staged in the
 * world-writable `/tmp` the coding agents also use, and something in their
 * churn deleted it mid-run.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  SCRATCH_TMPFS_MOUNTS,
  SECRETS_MOUNT_PATH,
  tmpfsArgument,
} from "../lib/container_launch.ts";

Deno.test("SCRATCH_TMPFS_MOUNTS - the secrets mount is private, noexec and separate from /tmp", () => {
  const secrets = SCRATCH_TMPFS_MOUNTS.find((mount) =>
    mount.startsWith(`${SECRETS_MOUNT_PATH}:`)
  );
  assert(secrets, `no mount for ${SECRETS_MOUNT_PATH}`);

  // Only the worker's own account reads a credential, and a credential is
  // data — the opposite of the agents' /tmp on both counts.
  assert(secrets.includes("mode=0700"), secrets);
  assert(secrets.includes("noexec"), secrets);
  assert(secrets.includes("nosuid"), secrets);
  assert(secrets.includes("nodev"), secrets);

  const agentScratch = SCRATCH_TMPFS_MOUNTS.find((mount) =>
    mount.startsWith("/tmp:")
  );
  assert(agentScratch);
  assert(agentScratch.includes("mode=1777"), "agents keep their shared /tmp");
  assertEquals(
    agentScratch.includes("mode=0700"),
    false,
    "the agents' scratch must not be confused with the secrets mount",
  );
});

Deno.test("SECRETS_MOUNT_PATH - lives under /run, the conventional home", () => {
  // /run is tmpfs by definition, which is why Docker, Podman, Kubernetes and
  // systemd all put credentials there.
  assert(SECRETS_MOUNT_PATH.startsWith("/run/"), SECRETS_MOUNT_PATH);
});

Deno.test("tmpfsArgument - a dialect that ignores options gets the bare path", () => {
  // Apple container 1.2.2 takes the WHOLE string as the mount path, so
  // passing options mounts a directory named for them and leaves the intended
  // path absent — a failure that looks like success.
  assertEquals(
    tmpfsArgument(
      { tmpfsHonoursOptions: false },
      "/run/vibe-secrets:rw,mode=0700",
    ),
    "/run/vibe-secrets",
  );
  // Nothing to strip.
  assertEquals(
    tmpfsArgument({ tmpfsHonoursOptions: false }, "/run/vibe-secrets"),
    "/run/vibe-secrets",
  );
});

Deno.test("tmpfsArgument - a dialect that parses options gets them intact", () => {
  const mount = "/run/vibe-secrets:rw,nosuid,nodev,noexec,mode=0700";
  assertEquals(tmpfsArgument({ tmpfsHonoursOptions: true }, mount), mount);
});

Deno.test("entrypoint - probes the secrets mount rather than trusting it", async () => {
  // A tmpfs the runtime silently failed to mount leaves an ordinary directory
  // on the read-only root, which is not writable. Trusting it would stage the
  // credential nowhere and fail later, at the first gh call.
  const entrypoint = await Deno.readTextFile(
    new URL("../../../container/entrypoint.sh", import.meta.url),
  );
  assert(
    entrypoint.includes("VIBE_SECRETS_DIR"),
    "the entrypoint must resolve the secrets mount",
  );
  assert(
    entrypoint.includes('touch "${VIBE_SECRETS_DIR}/.probe"'),
    "the mount must be probed for writability, not assumed",
  );
  // Best-effort only: Apple container mounts the tmpfs root-owned 1777 and
  // refuses an unprivileged chmod, so the mount's mode is not the protection
  // — the per-credential directory the worker creates inside it is.
  assert(
    entrypoint.includes('chmod 0700 "${VIBE_SECRETS_DIR}" 2>/dev/null || true'),
    "the mount chmod must be attempted but never fatal",
  );
  // The credential prefers the secrets mount over every other root.
  const secretsIndex = entrypoint.indexOf(
    'GH_RUNTIME_DIR="${VIBE_SECRETS_DIR:+',
  );
  const stateIndex = entrypoint.indexOf(
    'GH_RUNTIME_DIR="${GH_RUNTIME_DIR:-${STATE_ROOT',
  );
  assert(secretsIndex !== -1, "the gh copy must consider the secrets mount");
  assert(
    secretsIndex < stateIndex,
    "the secrets mount must be preferred over the shared state root",
  );
});
