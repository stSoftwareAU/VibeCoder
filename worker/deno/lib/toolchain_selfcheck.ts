/**
 * Does this image actually provide the toolchains `tools.json` promises?
 * (Issue #1956)
 *
 * ## What went wrong
 *
 * Two container tooling failures in one week cost whole runs: an `actionlint`
 * binary that would not execute on the host's CPU architecture, and a BATS
 * suite failing because PyYAML was not importable. Both toolchains are
 * installed unconditionally by `container/Containerfile`, each with a
 * post-install smoke check (`container/toolchains/actionlint.sh`,
 * `container/toolchains/pyyaml.sh`), so a correctly built current image cannot
 * carry either fault — the failing hosts were running an image that did not
 * match the checkout.
 *
 * Nothing verified that at start-up. The agent discovered the gap mid-run,
 * after the claim, and the run was charged as a failure.
 *
 * ## The rule
 *
 * Before the worker claims anything, every toolchain the checkout's
 * `container/tools.json` pins is probed against the running image, and the
 * reported version is compared with the pin:
 *
 * | manifest surface | probe | match |
 * |---|---|---|
 * | `versionCommand` | `<command> --version` | the pinned version appears in the output |
 * | `versionModule` | `python3 -c "import <m>; print(<m>.__version__)"` | the output equals the pin |
 *
 * The probe list is **derived from the manifest**, never written down twice,
 * so a toolchain added to `tools.json` is checked here without any edit —
 * which is what keeps it from drifting out of step with the install list.
 * Probes run concurrently and each is bounded, so a healthy image costs well
 * under a second and a wedged binary costs {@link TOOLCHAIN_PROBE_TIMEOUT_MS}
 * rather than the run.
 *
 * A failure exits {@link TOOLCHAIN_SELFCHECK_EXIT_STATUS} before the first
 * claim and prints {@link TOOLCHAIN_SELFCHECK_FAILURE_MARKER} naming the
 * toolchains, which is the signal `run.sh` / `run.ps1` act on: they remove the
 * image reference so the next launch rebuilds it rather than reusing the
 * cached tag.
 *
 * ## Why it only judges inside the image
 *
 * The question is what the *image* provides, so on a developer's own host
 * there is nothing to verify and the check reports itself skipped — the same
 * boundary, and the same in-image signal, that `prompt_immutability.ts` uses.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  type ContainerManifest,
  type ContainerToolchainPin,
  parseContainerManifest,
} from "./container_manifest.ts";
import { runningInContainerImage } from "./container_stamp.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/**
 * Exit status the worker reports when the image fails its own toolchain
 * self-check.
 *
 * Deliberately outside the runtime CLI's own 125/126/127 range and distinct
 * from the extension-start abort (76), the wedged-container status (87) and
 * the parked-host status (88), so the launchers and the escalation can both
 * name the reason rather than reporting a bare failure. Kept in step with
 * `run.sh` and `run.ps1` by the launcher tests.
 */
export const TOOLCHAIN_SELFCHECK_EXIT_STATUS = 89;

/**
 * The line a failing self-check prints, followed by the failing toolchain ids.
 *
 * The launchers read it out of the container's captured stderr, so the host
 * log names the toolchain rather than only a status. Kept in step with
 * `run.sh` and `run.ps1` by the launcher tests.
 */
export const TOOLCHAIN_SELFCHECK_FAILURE_MARKER =
  "[TOOLCHAIN-SELFCHECK-FAILED]";

/**
 * Bound on one probe.
 *
 * A version flag returns in milliseconds; this only exists so a binary that
 * hangs on this architecture costs seconds rather than the run's watchdog.
 */
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 15_000;

/** Which surface a toolchain is probed through. */
export type ToolchainProbeKind = "command" | "module";

/** One toolchain's probe, derived from its manifest entry. */
export interface ToolchainProbe {
  /** Toolchain id, e.g. `actionlint`. */
  id: string;
  /** The pinned version the probe's output is compared against. */
  version: string;
  /** Whether the image supplies a command or an importable module. */
  kind: ToolchainProbeKind;
  /** The argv to run — never a shell string, so nothing is interpolated. */
  argv: readonly string[];
}

/** What one probe reported. */
export interface ToolchainProbeResult {
  /** The probe that was run. */
  probe: ToolchainProbe;
  /** Whether the image supplied the pinned version. */
  ok: boolean;
  /** What the probe printed, trimmed and bounded. */
  reported: string;
  /** Why it failed, in one line. Absent when it passed. */
  detail?: string;
}

/** What one self-check concluded. */
export interface ToolchainSelfCheckVerdict {
  /** True when every pinned toolchain reported its pinned version. */
  ok: boolean;
  /** Why nothing was probed, when nothing was — e.g. a host run. */
  skipped?: string;
  /** One result per probe, in manifest order. */
  results: ToolchainProbeResult[];
  /** The failing toolchain ids, in manifest order. */
  failed: string[];
  /** Why the verdict is not `ok`, for the run log. */
  reason?: string;
  /** The marker line naming the failing toolchains, when there are any. */
  marker?: string;
  /** One line per toolchain, plus a summary — the run log's account. */
  lines: string[];
}

/** What a probe run reported back. */
export interface ToolchainProbeOutcome {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the probe was killed on the timeout. */
  timedOut?: boolean;
}

/** Seams for {@link checkContainerToolchains} — every one injectable. */
export interface ToolchainSelfCheckOptions {
  /** Repository root the manifest is read from. */
  repoRoot: string;
  /** Environment reader; the image stamp is read through it. */
  env?: EnvLookup;
  /** Reads the manifest text; defaults to the checkout's `tools.json`. */
  readManifest?: () => Promise<string>;
  /** Runs one probe; defaults to a bounded subprocess. */
  runProbe?: (probe: ToolchainProbe) => Promise<ToolchainProbeOutcome>;
  /** Environment entries the probes are run with (tests set PATH). */
  probeEnv?: Record<string, string>;
  /** Bound on one probe; defaults to {@link TOOLCHAIN_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A command name a probe may execute — no path, no shell metacharacters. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** A name `python3` can import. */
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How much of a probe's own output is quoted in the log. */
const REPORTED_LIMIT = 200;

/** One line of a probe's output, trimmed and bounded for the log. */
function summarise(text: string): string {
  const collapsed = text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  ).join(" | ");
  return collapsed.length > REPORTED_LIMIT
    ? `${collapsed.slice(0, REPORTED_LIMIT)}…`
    : collapsed;
}

/**
 * Derive the probe for one pinned toolchain.
 *
 * @param toolchain - The manifest entry
 * @returns The probe, or null when the entry declares no version surface
 */
function probeFor(toolchain: ContainerToolchainPin): ToolchainProbe | null {
  if (toolchain.versionCommand !== undefined) {
    return {
      id: toolchain.id,
      version: toolchain.version,
      kind: "command",
      argv: [toolchain.versionCommand, "--version"],
    };
  }
  if (toolchain.versionModule !== undefined) {
    const module = toolchain.versionModule;
    return {
      id: toolchain.id,
      version: toolchain.version,
      kind: "module",
      argv: [
        "python3",
        "-c",
        `import ${module}; print(${module}.__version__)`,
      ],
    };
  }
  return null;
}

/**
 * The probes a manifest implies, in manifest order.
 *
 * Every pinned toolchain yields exactly one probe: the manifest parser
 * guarantees a version surface, so an entry without one is a manifest this
 * function refuses rather than silently drops.
 *
 * @param manifest - The parsed container manifest
 * @returns One probe per pinned toolchain
 * @throws When a pinned toolchain declares no version surface
 */
export function toolchainProbes(
  manifest: ContainerManifest,
): ToolchainProbe[] {
  return manifest.toolchains.map((toolchain) => {
    const probe = probeFor(toolchain);
    if (probe === null) {
      throw new Error(
        `Toolchain "${toolchain.id}" declares neither versionCommand nor ` +
          "versionModule — it cannot be verified at start-up",
      );
    }
    return probe;
  });
}

/** Run one probe as a bounded subprocess. */
async function runProbeProcess(
  probe: ToolchainProbe,
  timeoutMs: number,
  probeEnv?: Record<string, string>,
): Promise<ToolchainProbeOutcome> {
  const [executable, ...args] = probe.argv;
  const result = await runWithTimeout(executable!, args, {
    timeoutMs,
    ...(probeEnv ? { env: probeEnv } : {}),
    captureOutputOnTimeout: true,
  });
  if (!result.ok) {
    // The command could not be spawned at all (not on PATH, not executable):
    // that is exactly the fault this check exists to catch, so it is reported
    // as a failed probe rather than thrown away.
    return {
      code: -1,
      stdout: "",
      stderr: result.error.message || "the probe could not be run",
    };
  }
  return {
    code: result.value.code,
    stdout: result.value.stdout,
    stderr: result.value.stderr,
    timedOut: result.value.timedOut,
  };
}

/** Judge one probe's outcome against its pin. */
function judge(
  probe: ToolchainProbe,
  outcome: ToolchainProbeOutcome,
): ToolchainProbeResult {
  const reported = summarise(`${outcome.stdout}\n${outcome.stderr}`);
  const rendered = probe.argv.join(" ");

  if (outcome.timedOut) {
    return {
      probe,
      ok: false,
      reported,
      detail: `\`${rendered}\` timed out — the image's ${probe.id} does not ` +
        "respond on this host",
    };
  }
  if (outcome.code !== 0) {
    return {
      probe,
      ok: false,
      reported,
      detail: `\`${rendered}\` exited ${outcome.code}: ${
        reported || "no output"
      }`,
    };
  }

  const matched = probe.kind === "command"
    ? `${outcome.stdout}\n${outcome.stderr}`.includes(probe.version)
    : outcome.stdout.trim() === probe.version;
  if (!matched) {
    return {
      probe,
      ok: false,
      reported,
      detail:
        `\`${rendered}\` reported "${reported}", expected ${probe.version}`,
    };
  }
  return { probe, ok: true, reported };
}

/** The probe result for an argv this check refuses to execute. */
function refuse(probe: ToolchainProbe, detail: string): ToolchainProbeResult {
  return { probe, ok: false, reported: "", detail };
}

/**
 * Probe every pinned toolchain against the running image.
 *
 * Fails loud on everything: an unreadable manifest, a manifest pinning no
 * toolchain, a name that is not a command or module name, a probe that will
 * not run, one that times out, and one that reports a version other than the
 * pin. The absence of a failure is never taken for a pass.
 *
 * @param options - Repository root and the injectable seams
 * @returns The verdict, including one log line per toolchain
 */
export async function checkContainerToolchains(
  options: ToolchainSelfCheckOptions,
): Promise<ToolchainSelfCheckVerdict> {
  const env = options.env ?? processEnvLookup;
  if (!runningInContainerImage(env)) {
    const skipped = "not running inside the container image — there is no " +
      "image to verify";
    return { ok: true, skipped, results: [], failed: [], lines: [] };
  }

  const manifestPath = `${options.repoRoot}/container/tools.json`;
  const read = options.readManifest ??
    (() => Deno.readTextFile(manifestPath));

  let manifest: ContainerManifest;
  let probes: ToolchainProbe[];
  try {
    manifest = parseContainerManifest(await read());
    probes = toolchainProbes(manifest);
  } catch (error) {
    const reason = `${manifestPath} could not be read as a toolchain ` +
      `manifest: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      results: [],
      failed: [],
      reason,
      marker: `${TOOLCHAIN_SELFCHECK_FAILURE_MARKER} manifest`,
      lines: [`toolchain-selfcheck: FAILED — ${reason}`],
    };
  }

  const timeoutMs = options.timeoutMs ?? TOOLCHAIN_PROBE_TIMEOUT_MS;
  const runProbe = options.runProbe ??
    ((probe: ToolchainProbe) =>
      runProbeProcess(probe, timeoutMs, options.probeEnv));

  // Concurrently: thirteen sequential version flags cost over a second, and
  // the same thirteen run together cost the slowest one.
  const results = await Promise.all(probes.map(async (probe) => {
    const [executable] = probe.argv;
    if (!COMMAND_NAME.test(executable!)) {
      return refuse(
        probe,
        `"${executable}" is not a command name this check will execute`,
      );
    }
    if (probe.kind === "module") {
      const module = probe.argv[2]?.match(/^import ([A-Za-z0-9_]+);/)?.[1];
      if (module === undefined || !MODULE_NAME.test(module)) {
        return refuse(
          probe,
          `"${module ?? ""}" is not a module name python3 can import`,
        );
      }
    }
    return judge(probe, await runProbe(probe));
  }));

  const failed = results.filter((result) => !result.ok);
  const lines = results.map((result) =>
    result.ok
      ? `toolchain-selfcheck: ok ${result.probe.id} ${result.probe.version}`
      : `toolchain-selfcheck: FAILED ${result.probe.id} ${result.probe.version} — ${result.detail}`
  );

  if (failed.length === 0) {
    lines.push(
      `toolchain-selfcheck: ${results.length} toolchains verified against ` +
        manifestPath,
    );
    return { ok: true, results, failed: [], lines };
  }

  const ids = failed.map((result) => result.probe.id);
  const marker = `${TOOLCHAIN_SELFCHECK_FAILURE_MARKER} ${ids.join(" ")}`;
  const reason =
    `the running image does not provide ${ids.join(", ")} as pinned in ` +
    manifestPath;
  lines.push(marker);
  return { ok: false, results, failed: ids, reason, marker, lines };
}
