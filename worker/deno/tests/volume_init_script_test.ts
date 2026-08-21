/**
 * Tests for container/volume-init.sh (Issue #229).
 *
 * The script is run with a fake PATH: findmnt, e2fsck, umount, mount and
 * chown are shell stubs that record what they were asked and answer as the
 * test dictates. The assertions are about the decisions — skip a bind
 * mount, repair a block device, report an unrepairable one with exit 3.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
const SCRIPT = decodeURIComponent(
  new URL("../../../container/volume-init.sh", import.meta.url).pathname,
);

interface Fixture {
  dir: string;
  bin: string;
  log: string;
  sysfs: string;
}

async function fixture(options: {
  device?: string; // what findmnt answers for SOURCE (empty = not a mount)
  e2fsckExit?: number | null; // null = no e2fsck on PATH
  errorsCount?: number;
}): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "volume_init_" });
  const bin = `${dir}/bin`;
  const log = `${dir}/calls.log`;
  const sysfs = `${dir}/sysfs`;
  await Deno.mkdir(bin, { recursive: true });
  const stub = async (name: string, body: string) => {
    const path = `${bin}/${name}`;
    await Deno.writeTextFile(
      path,
      `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`,
    );
    await Deno.chmod(path, 0o755);
  };
  const device = options.device ?? "";
  await stub(
    "findmnt",
    `for a in "$@"; do last="$a"; done\n` +
      `if [[ "$*" == *"-o SOURCE"* ]]; then echo "${device}"; else echo "$last"; fi`,
  );
  await stub("umount", "exit 0");
  await stub("mount", "exit 0");
  await stub("chown", "exit 0");
  if (options.e2fsckExit !== null && options.e2fsckExit !== undefined) {
    await stub("e2fsck", `exit ${options.e2fsckExit}`);
  }
  if (device.startsWith("/dev/")) {
    const base = device.slice("/dev/".length);
    await Deno.mkdir(`${sysfs}/${base}`, { recursive: true });
    await Deno.writeTextFile(
      `${sysfs}/${base}/errors_count`,
      `${options.errorsCount ?? 0}\n`,
    );
  }
  return { dir, bin, log, sysfs };
}

async function run(
  f: Fixture,
  targets: string[],
): Promise<{ code: number; stdout: string; stderr: string; calls: string }> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT, "1000:1000", ...targets],
    env: {
      PATH: `${f.bin}:/usr/bin:/bin`,
      VIBE_SYSFS_EXT4_ROOT: f.sysfs,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  let calls = "";
  try {
    calls = await Deno.readTextFile(f.log);
  } catch {
    calls = "";
  }
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    calls,
  };
}

Deno.test("volume-init - a bind-mounted target (no block device) is only chowned", async () => {
  const f = await fixture({ device: "", e2fsckExit: 0 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.calls, "chown 1000:1000 /work");
    assertEquals(r.calls.includes("e2fsck"), false);
    assertEquals(r.calls.includes("umount"), false);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a block device with recorded errors is unmounted, force-checked, remounted and chowned", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 1,
    errorsCount: 8,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.calls, "umount /work");
    assertStringIncludes(r.calls, "e2fsck -fp /dev/vdc");
    assertStringIncludes(r.calls, "mount /dev/vdc /work");
    assertStringIncludes(r.calls, "chown 1000:1000 /work");
    assertEquals(r.stdout.includes("VOLUME_UNREPAIRABLE"), false);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a clean block device gets a preen check only", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.calls, "e2fsck -p /dev/vdc");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - an unrepairable device is remounted, named on stdout and exits 3; other targets still chowned", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 8,
    errorsCount: 3,
  });
  try {
    const r = await run(f, ["/work", "/approval"]);
    assertEquals(r.code, 3, r.stderr);
    assertStringIncludes(r.stdout, "VOLUME_UNREPAIRABLE /work");
    assertStringIncludes(r.calls, "mount /dev/vdc /work");
    assertEquals(r.calls.includes("chown 1000:1000 /work"), false);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - without e2fsck, recorded errors alone make the volume unrepairable", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: null,
    errorsCount: 2,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 3, r.stderr);
    assertStringIncludes(r.stdout, "VOLUME_UNREPAIRABLE /work");
    assertEquals(r.calls.includes("umount"), false);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - without e2fsck and no recorded errors, the device is left alone and chowned", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: null,
    errorsCount: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.calls, "chown 1000:1000 /work");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});
