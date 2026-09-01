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
# Issue #478: the launch-time trim below is refused outright by the Apple
# container runtime ("FITRIM ioctl failed: Operation not permitted", as
# root, on a device that advertises discard), so the freed blocks are never
# handed back and the volume image only grows. A refusal is therefore
# reported on stdout as
#
#   VOLUME_TRIM_REFUSED <target>
#
# — a fact the launcher's disk gate acts on (it recreates the volume when
# the host is below its floor), not a warning that dies in stderr. It is not
# a failure on its own: the exit status is unchanged, because a runtime that
# cannot discard must not block a launch.
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
    # Return the guest's freed blocks to the host (Issue #384). A named
    # volume is a thin-provisioned image: blocks are allocated to it when the
    # guest writes and are never returned when the guest deletes, so the
    # image only ever grows and every guest-side reclaim - the tier sweep,
    # the 90%-disk nuke - hands the host exactly zero bytes. fstrim discards
    # the filesystem's unused blocks, which punches them out of the image.
    # It runs on every launch, with the root privileges FITRIM needs and no
    # operator incantation. Never fatal - a virtual disk that cannot discard
    # must not block a launch. Where the runtime refuses the ioctl (Apple
    # container does, always), the refusal is named on stdout so the launcher
    # can recreate the volume instead of assuming a trim happened, and is
    # stated rather than warned about: docs/CONTAINER.md has called it "a
    # fact, not a warning" since Issue #478, and warning about a permanent
    # property of the runtime on every launch only buried the two messages
    # that do need a human - the recreate and [WORK_VOLUME_UNRECOVERED]
    # (Issue #723).
    if command -v fstrim >/dev/null 2>&1; then
      trim_out=""
      if trim_out="$(fstrim -v "${target}" 2>&1)"; then
        echo "volume-init: trimmed ${target} - ${trim_out} (Issue #384)" >&2
      elif [[ "${trim_out}" == *"Operation not permitted"* ||
              "${trim_out}" == *"not supported"* ]]; then
        # Expected, permanent, and not the operator's to fix: Apple's container
        # runtime refuses FITRIM on every launch, and always has. Saying WARNING
        # each time trains the reader to skip volume-init lines - which is
        # precisely where [WORK_VOLUME_UNRECOVERED], the one line that does need
        # a human, comes out (Issue #723). Nothing is lost by stating it
        # plainly: the refusal is still a fact on stdout below, and run.sh's
        # note_trim_refusals writes it to run_core.log either way.
        echo "volume-init: ${target} - this runtime does not support discard, so the volume image keeps every block it holds; the launcher recreates the volume when the host is below its claiming floor (Issues #384, #478)" >&2
        echo "VOLUME_TRIM_REFUSED ${target}"
      else
        # Not the refusal we expect from a runtime that cannot discard, so this
        # one is worth shouting about: it means the trim broke some other way.
        echo "volume-init: WARNING could not trim ${target} - the volume image keeps every block it was allocated, so guest reclaim cannot return host disk (Issues #384, #478): ${trim_out}" >&2
        echo "VOLUME_TRIM_REFUSED ${target}"
      fi
    else
      # An image of ours shipping without fstrim is a build defect rather than a
      # property of the host's runtime, and it is ours to fix - so it stays loud.
      echo "volume-init: WARNING fstrim is not available - blocks the guest frees stay allocated to the ${target} volume image (Issues #384, #478)" >&2
      echo "VOLUME_TRIM_REFUSED ${target}"
    fi
  fi
  chown "${owner}" "${target}"
done

if ((unrepairable)); then
  exit 3
fi
