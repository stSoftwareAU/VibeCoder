/**
 * A refused trim must be machine-readable, not a warning (Issue #478).
 *
 * # The incident
 *
 * Issue #384 added an `fstrim` to every launch and described it as "the
 * supported compaction path ... no operator incantation". On the Apple
 * `container` runtime it has never worked:
 *
 * ```
 * $ container exec --user root vibe-coder-26896 fstrim -v /home/vibe/auto-issue-work
 * fstrim: /home/vibe/auto-issue-work: FITRIM ioctl failed: Operation not permitted
 * ```
 *
 * Not a privilege problem — `id` reports `uid=0(root)`, and the device
 * advertises discard (`discard_max_bytes` non-zero). The runtime simply
 * refuses the ioctl.
 *
 * The refusal was logged as a `WARNING` on stderr and nothing read it. So the
 * volume image ratcheted to 26 GB against 12.1 GB of live data, host GRQ-23
 * sat below its disk floor for three days claiming none of 43 available
 * issues, and the only remedy — `volume delete vibe-work` — was addressed to
 * a human. On an unattended host there is no human.
 *
 * # What these tests pin
 *
 * The refusal becomes a marker on stdout that the launcher can act on,
 * spelled like the `VOLUME_UNREPAIRABLE` marker #229 already established. It
 * stays non-fatal: a virtual disk that cannot discard must not block a
 * launch, and the decision about what to do belongs to the launcher, which is
 * the only party that knows whether the host is actually short of disk.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

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
  device?: string;
  e2fsckExit?: number | null;
  errorsCount?: number;
  fstrimExit?: number | null;
}): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "trim_refused_" });
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
        : `echo "fstrim: /work: FITRIM ioctl failed: Operation not permitted" >&2\n` +
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
    env: { PATH: `${f.bin}:/usr/bin:/bin`, VIBE_SYSFS_EXT4_ROOT: f.sysfs },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  let calls = "";
  try {
    calls = await Deno.readTextFile(f.log);
  } catch { /* no calls recorded */ }
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    calls,
  };
}

Deno.test("volume-init - a refused trim emits VOLUME_TRIM_REFUSED on stdout (Issue #478)", async () => {
  const f = await fixture({ device: "/dev/vdc", e2fsckExit: 0, fstrimExit: 1 });
  try {
    const r = await run(f, ["/work"]);
    assert(
      r.stdout.includes("VOLUME_TRIM_REFUSED /work"),
      `the launcher can only self-heal a ratcheted volume if the refusal is ` +
        `machine-readable; got stdout: ${JSON.stringify(r.stdout)}`,
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a refused trim is still not a launch failure (Issue #478)", async () => {
  const f = await fixture({ device: "/dev/vdc", e2fsckExit: 0, fstrimExit: 1 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(
      r.code,
      0,
      "a virtual disk that cannot discard must not block a launch (Issue #384)",
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a missing fstrim reports the same marker (Issue #478)", async () => {
  // No fstrim on PATH at all: the volume ratchets exactly as it does when the
  // ioctl is refused, so the launcher needs the same signal.
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 0,
    fstrimExit: null,
  });
  try {
    const r = await run(f, ["/work"]);
    assert(
      r.stdout.includes("VOLUME_TRIM_REFUSED /work"),
      `got stdout: ${JSON.stringify(r.stdout)}`,
    );
    assertEquals(r.code, 0);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a successful trim emits no marker (Issue #478)", async () => {
  const f = await fixture({ device: "/dev/vdc", e2fsckExit: 0, fstrimExit: 0 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(
      r.stdout.includes("VOLUME_TRIM_REFUSED"),
      false,
      `a working trim must never ask the launcher to recreate a volume; ` +
        `got stdout: ${JSON.stringify(r.stdout)}`,
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - a bind mount emits no marker (Issue #478)", async () => {
  // No volume image behind it, so there is nothing to recreate and the
  // launcher must not be told to try.
  const f = await fixture({ device: "", e2fsckExit: 0, fstrimExit: 1 });
  try {
    const r = await run(f, ["/work"]);
    assertEquals(
      r.stdout.includes("VOLUME_TRIM_REFUSED"),
      false,
      `got stdout: ${JSON.stringify(r.stdout)}`,
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test("volume-init - an unrepairable device reports only its own marker (Issue #478)", async () => {
  // #229's recreate already covers this device; adding a trim marker would
  // ask the launcher to recreate the same volume twice for two reasons.
  const f = await fixture({
    device: "/dev/vdc",
    e2fsckExit: 4,
    errorsCount: 2,
    fstrimExit: 1,
  });
  try {
    const r = await run(f, ["/work"]);
    assert(r.stdout.includes("VOLUME_UNREPAIRABLE /work"), r.stdout);
    assertEquals(
      r.stdout.includes("VOLUME_TRIM_REFUSED"),
      false,
      `got stdout: ${JSON.stringify(r.stdout)}`,
    );
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});
