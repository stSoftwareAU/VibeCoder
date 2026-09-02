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
  // Issue #384: null (the default) leaves fstrim off PATH, which is also
  // what the real host gives these tests — /usr/sbin is not on the fixture
  // PATH, so no test can ever trim the machine running the suite.
  fstrimExit?: number | null;
  // Issue #723: which refusal fstrim reports decides whether volume-init treats
  // it as a property of the runtime or as an unexpected failure.
  fstrimStderr?: string;
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
  if (options.fstrimExit !== null && options.fstrimExit !== undefined) {
    await stub(
      "fstrim",
      options.fstrimExit === 0
        ? `echo "/work: 23.5 GiB (25232932864 bytes) trimmed"; exit 0`
        : `echo "${
          options.fstrimStderr ??
            "fstrim: /work: the discard operation is not supported"
        }" >&2\n` +
          `exit ${options.fstrimExit}`,
    );
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

// --- Returning freed blocks to the host (Issue #384) ------------------------

Deno.test("volume-init - a block-device volume is trimmed so freed blocks go back to the host", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.calls, "fstrim -v /work");
    assertStringIncludes(r.stderr, "trimmed /work");
    assertStringIncludes(r.stderr, "Issue #384");
    // The trim runs on a mounted filesystem, after the check remounted it.
    const trimAt = r.calls.indexOf("fstrim -v /work");
    const mountAt = r.calls.indexOf("mount /dev/vdc /work");
    assertEquals(mountAt < trimAt, true, r.calls);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a bind-mounted target is not trimmed (no volume image to punch holes in)", async () => {
  const f = await fixture({ device: "", e2fsckExit: 0, fstrimExit: 0 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.calls.includes("fstrim"), false, r.calls);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a runtime that cannot discard is stated, not warned about", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 1,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(
      r.code,
      0,
      "a volume that cannot be trimmed must not block a launch",
    );
    assertStringIncludes(r.stderr, "does not support discard");
    assertStringIncludes(r.stderr, "Issues #384, #478");
    assertStringIncludes(r.calls, "chown 1000:1000 /work");
    // Issue #723: permanent on this runtime and not the operator's to fix, so
    // it must not carry WARNING. Warning every launch is what buried
    // [WORK_VOLUME_UNRECOVERED], the line that does need a human.
    assertEquals(
      r.stderr.includes("WARNING"),
      false,
      `a permanent runtime property must not warn: ${r.stderr}`,
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - the Apple container FITRIM refusal is the quiet path", async () => {
  // The exact refusal docs/CONTAINER.md records, which is what every launch on
  // that runtime produces (Issue #723).
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 1,
    fstrimStderr: "fstrim: /work: FITRIM ioctl failed: Operation not permitted",
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes("WARNING"), false, r.stderr);
    // The machine contract run.sh acts on is untouched by the wording change.
    assertStringIncludes(r.stdout, "VOLUME_TRIM_REFUSED /work");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a trim that fails some other way is still a warning", async () => {
  // Not the refusal a runtime without discard gives, so it is unexpected and
  // stays loud: quieting the expected case must not quieten a real fault
  // (Issue #723).
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 1,
    fstrimStderr: "fstrim: /work: unexpected I/O error reading the device",
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, "an unexpected trim failure still must not block");
    assertStringIncludes(r.stderr, "WARNING could not trim /work");
    assertStringIncludes(r.stderr, "unexpected I/O error");
    assertStringIncludes(r.stdout, "VOLUME_TRIM_REFUSED /work");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - an image without fstrim says so rather than failing silently", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.stderr, "fstrim is not available");
    assertStringIncludes(r.stderr, "Issues #384, #478");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

// --- Reporting a refused trim to the launcher (Issue #478) -----------------

Deno.test("volume-init - a refused FITRIM is named on stdout so the launcher can act on it", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 1,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    // The refusal is a machine-readable fact, not a warning that dies in
    // stderr: the launcher's disk gate recreates the volume off this line.
    assertStringIncludes(r.stdout, "VOLUME_TRIM_REFUSED /work");
    assertStringIncludes(r.calls, "chown 1000:1000 /work");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a trim that succeeded reports no refusal", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stdout.includes("VOLUME_TRIM_REFUSED"), false, r.stdout);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a missing fstrim is a refusal too: the blocks stay in the image", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.stdout, "VOLUME_TRIM_REFUSED /work");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a bind-mounted target reports no refusal (there is no image to trim)", async () => {
  const f = await fixture({ device: "", e2fsckExit: 0 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stdout.includes("VOLUME_TRIM_REFUSED"), false, r.stdout);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - an unrepairable device is never trimmed", async () => {
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 8,
    errorsCount: 3,
    fstrimExit: 0,
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 3, r.stderr);
    assertEquals(r.calls.includes("fstrim"), false, r.calls);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - the Podman FITRIM refusal completes the init and names the volume (Issue #734)", async () => {
  // Report item 9 of #722: Podman refuses FITRIM on a named volume, exactly
  // as Apple `container` does. The init must still finish — a virtual disk
  // that cannot discard is not a reason to block a launch — and must name the
  // refusal on stdout, which is the only thing `run.sh` acts on.
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    errorsCount: 0,
    fstrimExit: 1,
    fstrimStderr: "fstrim: /work: FITRIM ioctl failed: Operation not permitted",
  });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(r.code, 0, `the init must complete: ${r.stderr}`);
    assertStringIncludes(r.stdout, "VOLUME_TRIM_REFUSED /work");
    // The chown still happened, so the volume is usable by the worker.
    assertStringIncludes(await Deno.readTextFile(f.log), "chown");
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});
