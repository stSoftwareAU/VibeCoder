/**
 * Classifying a worker failure as a host/infrastructure fault (Issue #2890).
 *
 * A failure whose cause lives on the worker host itself — a corrupt shared
 * clone, a full disk, a container image that could not be built, a clone
 * that could not even be created — is not a fault of the issue it happened
 * to be attempted on. Once such a failure is marked with `failed-once` or
 * `failed`, the label sticks to the issue for as long as it takes a human to
 * notice the real cause lives elsewhere, even after the host is repaired.
 *
 * This module classifies a raw failure message into a small, narrow set of
 * host-fault kinds and, when one is found, appends a machine-readable marker
 * comment so a later sweep can find and release these labels once the host
 * is healthy again. Detection is deliberately conservative: an ambiguous
 * failure is left unclassified (`null`) rather than guessed at, because a
 * host fault silently swallows a label a human genuinely needed to see.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { brokenRefsIn } from "./broken_ref_repair.ts";
import { isObjectStoreCorruption } from "./object_store_repair.ts";

/** The narrow set of host/infrastructure fault kinds this module detects. */
export const HOST_FAULT_KINDS = [
  "clone-corrupt",
  "clone-failed",
  "disk-full",
  "container-build-failed",
] as const;

/** One of {@link HOST_FAULT_KINDS}. */
export type HostFaultKind = typeof HOST_FAULT_KINDS[number];

/** True when `value` is one of {@link HOST_FAULT_KINDS}. */
export function isHostFaultKind(value: string): value is HostFaultKind {
  return (HOST_FAULT_KINDS as readonly string[]).includes(value);
}

/** `No space left on device` (ENOSPC), however the caller happened to word it. */
const DISK_FULL_PATTERN = /No space left on device|\bENOSPC\b/i;

/**
 * `Failed to clone <repo>: <stderr>` from `setupRepo()` in
 * `commands/git_operations.ts` — a clone that never got off the ground.
 */
const CLONE_FAILED_PATTERN = /Failed to clone \S+: /;

/**
 * Wording that means the clone failure above is an authentication/permission
 * problem, or the repository does not exist — a fault of the repository's
 * configuration or the fleet's credentials, not of the host. These must
 * never classify as a host fault.
 */
const CLONE_AUTH_OR_MISSING_PATTERN =
  /Repository not found|Authentication failed|could not read Username|could not read Password|Permission denied|HTTP (?:401|403)|access denied|not have permission/i;

/**
 * `container image build failed` — the wording `describeFailurePhase()` in
 * `lib/container_restart_backoff.ts` produces for the `image_build` phase,
 * carried verbatim into the restart-backoff self-heal log line
 * (`` `${describeFailurePhase(decision.phase)} failed ` ``) and into the
 * escalation report's `Failure phase: image_build (container image build)`
 * line. A failed image build means the known-good environment could not be
 * reconstructed on this host at all — never a fault of the issue.
 */
const CONTAINER_BUILD_FAILED_PATTERN = /container image build failed/i;

/**
 * Classify a raw failure message; `null` when it is not a host fault.
 *
 * Checked in order, each narrow enough that an ambiguous git failure (an
 * invalid branch name, an unknown ref) returns `null` rather than being
 * guessed at.
 */
export function detectHostFault(message: string): HostFaultKind | null {
  if (brokenRefsIn(message).length > 0 || isObjectStoreCorruption(message)) {
    return "clone-corrupt";
  }
  if (DISK_FULL_PATTERN.test(message)) {
    return "disk-full";
  }
  if (CONTAINER_BUILD_FAILED_PATTERN.test(message)) {
    return "container-build-failed";
  }
  if (
    CLONE_FAILED_PATTERN.test(message) &&
    !CLONE_AUTH_OR_MISSING_PATTERN.test(message)
  ) {
    return "clone-failed";
  }
  return null;
}

/** Build the marker comment appended when a host fault is detected. */
export function buildHostFaultMarker(kind: HostFaultKind): string {
  return `<!-- vibe-host-fault kind="${kind}" -->`;
}

/** Anchors the marker to the whole of the trimmed final line, and no other. */
const HOST_FAULT_MARKER_PATTERN = /^<!-- vibe-host-fault kind="([a-z-]+)" -->$/;

/**
 * Parse the host-fault kind from a comment body's marker, or `null`.
 *
 * Considers **only** the trimmed final non-empty line of `body` — the raw
 * failure message (agent output) is embedded verbatim earlier in the same
 * comment, so a marker-shaped string appearing there must never count. Only
 * the marker the worker itself appends as the very last line is honoured.
 */
export function parseHostFaultMarker(body: string): HostFaultKind | null {
  const lines = body.split("\n");
  let lastNonEmpty: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length > 0) {
      lastNonEmpty = trimmed;
      break;
    }
  }
  if (lastNonEmpty === undefined) return null;
  const match = HOST_FAULT_MARKER_PATTERN.exec(lastNonEmpty);
  if (!match) return null;
  const kind = match[1]!;
  return isHostFaultKind(kind) ? kind : null;
}

/** Short human phrase describing a host-fault kind, for the comment body. */
export function describeHostFault(kind: HostFaultKind): string {
  switch (kind) {
    case "clone-corrupt":
      return "a corrupt git clone on the worker host (broken ref or unreadable object)";
    case "clone-failed":
      return "the worker host could not clone the repository";
    case "disk-full":
      return "the worker host ran out of disk space";
    case "container-build-failed":
      return "the worker host could not build the container image";
  }
}
