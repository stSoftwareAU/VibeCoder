/**
 * Tests for container root-filesystem fault detection (Issue #3179).
 *
 * On GRQ-23 the container's root went `emergency_ro` after guest I/O errors,
 * and the worker logged "Claude health check failed" every two minutes until a
 * human stopped the container. These pin the detector both ways — a writable
 * filesystem is no fault, a read-only or I/O-faulted one is — and the probe
 * set the cycle checks.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectRootFilesystemFault,
  findEmergencyReadOnlyMount,
  formatRootFilesystemFault,
  probeDirectoryWritable,
  ROOT_FS_FAULT_CODE,
  ROOT_FS_FAULT_EXIT_STATUS,
  type RootFilesystemProbeDeps,
  rootFilesystemProbeDirs,
} from "../lib/root_filesystem_fault.ts";

/** The `/proc/mounts` line the incident showed for the container root. */
const EMERGENCY_RO_ROOT = "/dev/vdb / ext4 rw,relatime,emergency_ro 0 0\n" +
  "tmpfs /run tmpfs rw,nosuid,nodev 0 0\n";

/** A Docker `--read-only` root with its scratch tmpfs: healthy by design. */
const DELIBERATELY_RO_ROOT = "overlay / overlay ro,relatime 0 0\n" +
  "tmpfs /tmp tmpfs rw,nosuid,nodev 0 0\n";

function deps(
  overrides: Partial<RootFilesystemProbeDeps> = {},
): RootFilesystemProbeDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    readMounts: () => Promise.resolve(""),
    writeProbe: () => Promise.resolve(),
    warn: (message) => warnings.push(message),
    ...overrides,
  };
}

Deno.test("ROOT_FS_FAULT_EXIT_STATUS - is EX_IOERR and collides with no other worker status", () => {
  assertEquals(ROOT_FS_FAULT_EXIT_STATUS, 74);
  // 0/1 run outcomes, 3/4 launcher commands, 75 quota pause, 76 extension
  // abort, 87 wedged container, 88 egress blocked, 89 toolchain self-check,
  // 124/137 supervisor deadline.
  for (const taken of [0, 1, 3, 4, 75, 76, 87, 88, 89, 124, 137]) {
    assert(ROOT_FS_FAULT_EXIT_STATUS !== taken, `collides with ${taken}`);
  }
});

Deno.test("findEmergencyReadOnlyMount - names an ext4 emergency remount", () => {
  assertEquals(findEmergencyReadOnlyMount(EMERGENCY_RO_ROOT), {
    device: "/dev/vdb",
    mountPoint: "/",
  });
});

Deno.test("findEmergencyReadOnlyMount - a deliberately read-only root is not a fault", () => {
  // Issue #516 mounts the root `--read-only` on Docker and Podman; only the
  // kernel's error remount is evidence of a fault.
  assertEquals(findEmergencyReadOnlyMount(DELIBERATELY_RO_ROOT), null);
  assertEquals(findEmergencyReadOnlyMount(""), null);
});

Deno.test("detectRootFilesystemFault - a writable filesystem is no fault", async () => {
  const probed: string[] = [];
  const d = deps({
    readMounts: () => Promise.resolve(DELIBERATELY_RO_ROOT),
    writeProbe: (dir) => {
      probed.push(dir);
      return Promise.resolve();
    },
  });
  assertEquals(await detectRootFilesystemFault(["/tmp", "/var/tmp"], d), null);
  assertEquals(probed, ["/tmp", "/var/tmp"]);
  assertEquals(d.warnings, []);
});

Deno.test("detectRootFilesystemFault - EROFS on a probe is a fault naming the path", async () => {
  const d = deps({
    writeProbe: (dir) =>
      dir === "/var/tmp"
        ? Promise.reject(
          new Error(
            "Read-only file system (os error 30): make temp file '/var/tmp/.x'",
          ),
        )
        : Promise.resolve(),
  });
  const fault = await detectRootFilesystemFault(["/tmp", "/var/tmp"], d);
  assertEquals(fault?.path, "/var/tmp");
  assertStringIncludes(fault?.detail ?? "", "Read-only file system");
});

Deno.test("detectRootFilesystemFault - EIO on a state volume is a fault", async () => {
  const d = deps({
    writeProbe: (dir) =>
      dir.endsWith("-agent-state")
        ? Promise.reject(new Error("Input/output error (os error 5)"))
        : Promise.resolve(),
  });
  const fault = await detectRootFilesystemFault(
    ["/tmp", "/home/vibe/auto-issue-work-agent-state"],
    d,
  );
  assertEquals(fault?.path, "/home/vibe/auto-issue-work-agent-state");
});

Deno.test("detectRootFilesystemFault - an emergency_ro mount is a fault even before a write fails", async () => {
  const d = deps({ readMounts: () => Promise.resolve(EMERGENCY_RO_ROOT) });
  const fault = await detectRootFilesystemFault(["/tmp"], d);
  assertEquals(fault?.path, "/");
  assertStringIncludes(fault?.detail ?? "", "emergency_ro");
  assertStringIncludes(fault?.detail ?? "", "/dev/vdb");
});

Deno.test("detectRootFilesystemFault - an absent directory is skipped, not a fault", async () => {
  const d = deps({
    writeProbe: () =>
      Promise.reject(new Deno.errors.NotFound("No such file or directory")),
  });
  assertEquals(await detectRootFilesystemFault(["/nope"], d), null);
  assertEquals(d.warnings, []);
});

Deno.test("detectRootFilesystemFault - another write error is warned about, not a fault", async () => {
  const d = deps({
    writeProbe: () =>
      Promise.reject(new Deno.errors.PermissionDenied("Permission denied")),
  });
  assertEquals(await detectRootFilesystemFault(["/locked"], d), null);
  assertEquals(d.warnings.length, 1);
  assertStringIncludes(d.warnings[0]!, "/locked");
  assertStringIncludes(d.warnings[0]!, "Permission denied");
});

Deno.test("detectRootFilesystemFault - an unreadable /proc/mounts leaves the write probes to decide", async () => {
  const d = deps({ readMounts: () => Promise.resolve(null) });
  assertEquals(await detectRootFilesystemFault(["/tmp"], d), null);
});

Deno.test("probeDirectoryWritable - creates and removes a file in a writable directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe_rootfs_probe_" });
  try {
    await probeDirectoryWritable(dir);
    const left = [];
    for await (const entry of Deno.readDir(dir)) left.push(entry.name);
    assertEquals(left, [], "the probe must clean up after itself");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectRootFilesystemFault - a real writable directory passes end to end", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe_rootfs_probe_" });
  try {
    const fault = await detectRootFilesystemFault([dir], {
      readMounts: () => Promise.resolve(DELIBERATELY_RO_ROOT),
      writeProbe: probeDirectoryWritable,
      warn: () => {},
    });
    assertEquals(fault, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rootFilesystemProbeDirs - the scratch dirs, TMPDIR and both state volumes, once each", () => {
  assertEquals(
    rootFilesystemProbeDirs({
      workDir: "/home/vibe/auto-issue-work",
      tmpDir: "/tmp",
    }),
    [
      "/tmp",
      "/var/tmp",
      "/home/vibe/auto-issue-work-agent-state",
      "/home/vibe/auto-issue-work-approval-state",
    ],
  );
  assertEquals(
    rootFilesystemProbeDirs({ workDir: "", tmpDir: "/scratch/tmp" }),
    ["/tmp", "/var/tmp", "/scratch/tmp"],
  );
});

Deno.test("formatRootFilesystemFault - names the code, the path and that the run is ending", () => {
  const line = formatRootFilesystemFault({
    path: "/tmp",
    detail: "Read-only file system (os error 30)",
  });
  assert(line.startsWith(`[${ROOT_FS_FAULT_CODE}]`), line);
  assertStringIncludes(line, "/tmp");
  assertStringIncludes(line, "Read-only file system");
  assertStringIncludes(line, "ending this run");
  assertStringIncludes(line, String(ROOT_FS_FAULT_EXIT_STATUS));
});
