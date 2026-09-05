/**
 * container-egress-probe command (Issue #997).
 *
 * Called by `run.sh` / `run.ps1` before the image build. One short container
 * run answers the question the 135-second `curl` timeout inside a build used
 * to answer badly: can a container on this host reach the network at all?
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run --allow-net \
 *     --allow-write=<evidence> \
 *     mod.ts container-egress-probe --runtime container \
 *     --base-dir /path/to/checkout [--image vibe-coder:abc] \
 *     [--target 1.1.1.1:443] [--name vibe-egress] --out <evidence>
 *
 * Exit statuses, which are the launcher's instructions:
 *
 *   0  carry on — a container reaches the network, or the probe could not run
 *   3  this host cannot route out of a container — park it, tell a human once
 *   4  the network is down — wait, and do not escalate
 *
 * The evidence file is the hop table plus the host's reject routes and any
 * tunnel interface holding a default route, so the escalation the launcher
 * files is diagnosable in a minute rather than an hour.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  baseImageFromContainerfile,
  createEgressProbeDeps,
  describeEgressVerdict,
  EGRESS_PROBE_TARGET_DEFAULT,
  type EgressVerdict,
  parseEgressTarget,
  probeContainerEgress,
} from "../lib/container_egress_probe.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";

/**
 * Exit status meaning "a container on this host cannot reach the network,
 * while the host itself can".
 *
 * Kept in step with the launchers by the launcher tests: `run.sh` and
 * `run.ps1` read it to park the host instead of running a build that cannot
 * succeed.
 */
export const EGRESS_BLOCKED_EXIT = 3;

/** Exit status meaning "the network is down for the host as well". */
export const NETWORK_DOWN_EXIT = 4;

/** Environment override for the address every hop is measured against. */
export const EGRESS_TARGET_ENV = "VIBE_EGRESS_PROBE_TARGET";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** What the command reports back to the launcher. */
export interface ContainerEgressProbeResult {
  verdict: EgressVerdict;
  /** The image the probe container ran, when one was available. */
  image?: string;
  /** Where the evidence was written, when the caller asked for a file. */
  evidencePath?: string;
}

export const containerEgressProbeCommand: Command = {
  name: "container-egress-probe",
  description:
    "Check from inside a container whether this host can reach the network, " +
    "before the image build (Issue #997)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerEgressProbeResult>> {
    return probeEgress(args);
  },
};

/** The base image the checkout's Containerfile builds on, when it is readable. */
async function fallbackImage(
  baseDir: string | undefined,
): Promise<string | null> {
  if (!baseDir) return null;
  try {
    const text = await Deno.readTextFile(`${baseDir}/container/Containerfile`);
    return baseImageFromContainerfile(text);
  } catch {
    // A checkout without a Containerfile simply has no fallback: the probe
    // then runs on the derived image, or reports that it could not run.
    return null;
  }
}

/** Do the work. Separated so the tests can call it without the registry. */
export async function probeEgress(
  args: Record<string, unknown>,
): Promise<CommandResult<ContainerEgressProbeResult>> {
  const runtime = optionalString(args["runtime"]);
  if (!runtime) {
    return {
      success: false,
      message: "container-egress-probe requires --runtime <executable>",
    };
  }

  let dialect;
  try {
    dialect = dialectForExecutable(runtime);
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  let target;
  try {
    target = parseEgressTarget(
      optionalString(args["target"]) ??
        optionalString(Deno.env.get(EGRESS_TARGET_ENV)) ??
        EGRESS_PROBE_TARGET_DEFAULT,
    );
  } catch (error) {
    // A misconfigured target is a loud failure, never a probe aimed at a name.
    return { success: false, message: (error as Error).message };
  }

  const images = [
    optionalString(args["image"]),
    await fallbackImage(optionalString(args["base-dir"])),
  ].filter((image): image is string => typeof image === "string");

  const result = await probeContainerEgress(
    createEgressProbeDeps(
      runtime,
      (image) => [...dialect.imageInspectArgs, image],
    ),
    {
      target,
      images,
      containerName: optionalString(args["name"]) ?? "vibe-egress-probe",
    },
  );

  const evidencePath = optionalString(args["out"]);
  if (evidencePath) {
    // The network-down case rides the marker Issue #949 already classifies, so
    // a link outage re-probes at the base cadence instead of climbing the
    // failure ladder and escalating a fault nobody can act on.
    const body = result.verdict === "network_down"
      ? `${result.evidence}\n${NETWORK_UNAVAILABLE_MARKER}\n`
      : `${result.evidence}\n`;
    try {
      await Deno.writeTextFile(evidencePath, body);
    } catch (error) {
      // Fail loud: the evidence IS the escalation's content, and a launcher
      // told nothing would report the fault with no cause attached.
      return {
        success: false,
        message: `could not write the egress evidence to ${evidencePath}: ` +
          `${(error as Error).message}`,
        data: { verdict: result.verdict },
      };
    }
  }

  const data: ContainerEgressProbeResult = {
    verdict: result.verdict,
    ...(result.reading.image ? { image: result.reading.image } : {}),
    ...(evidencePath ? { evidencePath } : {}),
  };
  const message = `container egress: ${result.verdict} — ` +
    describeEgressVerdict(result.verdict);

  switch (result.verdict) {
    case "egress_blocked":
      return {
        success: true,
        exitCode: EGRESS_BLOCKED_EXIT,
        message,
        data,
      };
    case "network_down":
      return { success: true, exitCode: NETWORK_DOWN_EXIT, message, data };
    default:
      // `reachable` and `inconclusive` both carry on: a probe that could not
      // run must never be the reason a host stops working.
      return { success: true, message, data };
  }
}
