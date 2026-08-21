#!/usr/bin/env bash
# Volume init for the worker's named volumes (Issues #4186, #229).
#
# Runs as root in a one-shot container before the worker, with the volumes
# mounted at their worker-side targets. For each target it:
#
#   1. checks the filesystem when the target is a block-device mount (Apple
#      container attaches a named volume as an ext4 image on virtio-blk);
#      Docker/Podman bind-mount a host directory and there is nothing to
#      check — the step is skipped;
#   2. chowns the mount root to the worker account (non-recursive; the root
#      is all the runtime creates).
#
# Issue #229: host GRQ-23 crashed out of disk and its work volume came back
# with EXT4-fs errors ("Structure needs cleaning") that the worker launched
# on top of unchecked. ext4 persists its error count in the superblock and
# exposes it at /sys/fs/ext4/<dev>/errors_count; with e2fsprogs present the
# volume is unmounted, repaired (`e2fsck -p`, forced when errors are
# recorded) and remounted. A filesystem e2fsck cannot repair — or one that
# carries errors on a host without e2fsck — is reported on stdout as
#
#   VOLUME_UNREPAIRABLE <target>
#
# and this script exits 3, so the launcher can recreate that volume (the
# clones are disposable; everything of value is pushed) and run the init
# again. Every other failure exits 1 as before.
#
# Usage: vibe-volume-init <uid:gid> <target>...
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: vibe-volume-init <uid:gid> <target>..." >&2
  exit 1
fi
owner="$1"
shift

unrepairable=0
for target in "$@"; do
  device=""
  if command -v findmnt >/dev/null 2>&1; then
    device="$(findmnt -n -o SOURCE --target "${target}" 2>/dev/null || true)"
  fi
  # Only a real block device mounted exactly at the target is ours to check.
  mounted_at="$(findmnt -n -o TARGET --target "${target}" 2>/dev/null || true)"
  if [[ "${device}" == /dev/* && "${mounted_at}" == "${target}" ]]; then
    base="$(basename "${device}")"
    sysfs_root="${VIBE_SYSFS_EXT4_ROOT:-/sys/fs/ext4}"
    errors="$(cat "${sysfs_root}/${base}/errors_count" 2>/dev/null || echo 0)"
    [[ "${errors}" =~ ^[0-9]+$ ]] || errors=0
    if command -v e2fsck >/dev/null 2>&1; then
      flags="-p"
      if ((errors > 0)); then
        flags="-fp"
        echo "volume-init: ${target} (${device}) has ${errors} recorded ext4 error(s) - forcing a full check" >&2
      fi
      if umount "${target}" 2>/dev/null; then
        rc=0
        e2fsck ${flags} "${device}" >&2 || rc=$?
        # e2fsck: 0 clean, 1 repaired, 2 repaired (reboot advised), >=4 not fixed.
        if ! mount "${device}" "${target}"; then
          echo "volume-init: could not remount ${device} at ${target}" >&2
          exit 1
        fi
        if ((rc >= 4)); then
          echo "volume-init: e2fsck could not repair ${device} (exit ${rc})" >&2
          echo "VOLUME_UNREPAIRABLE ${target}"
          unrepairable=1
          continue
        fi
        echo "volume-init: ${target} (${device}) fsck exit ${rc}" >&2
      else
        echo "volume-init: could not unmount ${target} for a check - skipping fsck" >&2
      fi
    elif ((errors > 0)); then
      echo "volume-init: ${target} (${device}) has ${errors} recorded ext4 error(s) and e2fsck is not available" >&2
      echo "VOLUME_UNREPAIRABLE ${target}"
      unrepairable=1
      continue
    fi
  fi
  chown "${owner}" "${target}"
done

if ((unrepairable)); then
  exit 3
fi
