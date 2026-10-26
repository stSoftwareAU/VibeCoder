/**
 * Measured capability check for Apple `container` egress containment
 * (Issue #4051).
 *
 * The egress containment design needs two things from the host's Apple CLI:
 * a macOS release that offers custom networks (macOS 26 or later), and a CLI
 * whose `network create` takes `--internal` and whose `run` takes `--network`.
 * The fleet version is not assumed; the CLI is asked. The check reads
 * `sw_vers -productVersion`, `<runtime> --version`, `<runtime> network create
 * --help` and `<runtime> run --help`, and returns a verdict:
 *
 * - `capable` ONLY when macOS is 26 or later AND both flags are advertised.
 * - `unsupported` ONLY on a definitive negative: macOS is known to be older
 *   than 26, or a help text was read and lacks the flag, or the CLI says the
 *   sub-command is unknown.
 * - `indeterminate` otherwise. The caller fails closed on it; this module
 *   never downgrades an unreadable fact to `capable`.
 *
 * The runner is injected so the check is testable without a real CLI.
 * Nothing here throws: a runner error is recorded in `reasons`.
 *
 * Australian English spelling used throughout (behaviour, normalised).
 */

/** The lowest macOS major version that offers custom networks. */
export const APPLE_MIN_MACOS_MAJOR = 26;

/** Runs one command and returns its exit code and output streams. */
export type AppleCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The longest cause line quoted into a reason. */
const CAUSE_LIMIT = 200;

/** `sw_vers -productVersion` output: dotted, two or three numeric parts. */
const MACOS_VERSION = /^\d+(\.\d+){1,2}$/;

/**
 * The first `x.y.z`, with an optional `-suffix`. The lookbehind stops a match
 * starting in the middle of a longer dotted or digit run, which keeps the scan
 * linear on hostile input.
 */
const CONTAINER_VERSION = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?/;

/** Text saying a sub-command or option is not known to the CLI. */
const UNKNOWN_SUBCOMMAND = /Unknown option|unknown command|Usage:/;

/** The characters that can sit inside an option name. */
const OPTION_NAME_CHARACTER = /[\w-]/;

/** Result of parsing the macOS release. */
export interface MacosVersion {
  version: string;
  major: number;
}

/** What the Apple CLI can do for egress containment, with the reasons. */
export interface AppleNetworkCapabilities {
  macos: { version: string | null; major: number | null };
  containerVersion: string | null;
  /** `network create --help` advertises `--internal`; null = unreadable. */
  networkCreateInternal: boolean | null;
  /** `run --help` advertises `--network`; null = unreadable. */
  runNetworkFlag: boolean | null;
  verdict: "capable" | "unsupported" | "indeterminate";
  /** One sentence per finding, each naming the command or fact it came from. */
  reasons: string[];
}

/**
 * Parse `sw_vers -productVersion` output.
 *
 * @param text - The command output, for example `"26.0.1\n"` or `"15.6"`
 * @returns The trimmed version and its major number, or null when the text is
 *   not a dotted version of two or three numeric parts
 */
export function parseMacosVersion(text: string): MacosVersion | null {
  const version = text.trim();
  if (!MACOS_VERSION.test(version)) return null;
  return { version, major: Number(version.split(".")[0]) };
}

/**
 * Find the Apple CLI version in `container --version` or
 * `container system version` output.
 *
 * @param text - The command output, plain text, a table or JSON
 * @returns The first `x.y.z` (with any `-suffix`), or null when absent
 */
export function parseContainerVersion(text: string): string | null {
  const match = CONTAINER_VERSION.exec(text);
  return match ? match[0] : null;
}

/**
 * Whether a help text advertises `flag` as a whole option token.
 *
 * `--internal` does not match `--internal-foo`, and `--network` does not match
 * `--network-backend`: the characters on either side must not extend the
 * option name. The scan is a plain `indexOf` loop, linear in the text length.
 *
 * @param helpText - The help output
 * @param flag - The option, spelled with its dashes, for example `--internal`
 * @returns True when the option appears as a whole token
 */
export function helpAdvertisesFlag(helpText: string, flag: string): boolean {
  if (flag === "") return false;
  for (
    let at = helpText.indexOf(flag);
    at !== -1;
    at = helpText.indexOf(flag, at + 1)
  ) {
    const before = helpText.charAt(at - 1);
    const after = helpText.charAt(at + flag.length);
    if (
      !OPTION_NAME_CHARACTER.test(before) && !OPTION_NAME_CHARACTER.test(after)
    ) {
      return true;
    }
  }
  return false;
}

/** A command read, classified for the verdict. */
type CommandRead =
  | { kind: "read"; output: string }
  | { kind: "unknown-subcommand" }
  | { kind: "unreadable" };

/** The first non-empty line of `text`, capped at {@link CAUSE_LIMIT}. */
function firstCauseLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) =>
    part !== ""
  ) ?? "no output";
  return line.length > CAUSE_LIMIT ? line.slice(0, CAUSE_LIMIT) : line;
}

/**
 * Run one command and classify the outcome. Records a reason for every
 * failure. Never throws.
 *
 * @param run - The injected command runner
 * @param command - The executable
 * @param args - Its arguments
 * @param label - The command as a reader would type it, for the reasons
 * @param reasons - The reasons list to append to
 * @param subcommandMayBeUnknown - Whether a non-zero exit saying the
 *   sub-command is unknown is a definitive negative (help reads only)
 * @returns The classified outcome
 */
async function readCommand(
  run: AppleCommandRunner,
  command: string,
  args: readonly string[],
  label: string,
  reasons: string[],
  subcommandMayBeUnknown: boolean,
): Promise<CommandRead> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`${label} could not be run: "${firstCauseLine(message)}".`);
    return { kind: "unreadable" };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) {
    if (output.trim() === "") {
      reasons.push(`${label} exited 0 with no output.`);
      return { kind: "unreadable" };
    }
    return { kind: "read", output };
  }

  const cause = firstCauseLine(output);
  if (subcommandMayBeUnknown && UNKNOWN_SUBCOMMAND.test(output)) {
    reasons.push(
      `${label} exited ${result.code} saying the sub-command is unknown: "${cause}".`,
    );
    return { kind: "unknown-subcommand" };
  }
  reasons.push(`${label} exited ${result.code}: "${cause}".`);
  return { kind: "unreadable" };
}

/**
 * Turn one help read into a flag finding.
 *
 * @param read - The classified help read
 * @param flag - The option the help must advertise
 * @param label - The command, for the reason
 * @param reasons - The reasons list to append to
 * @returns True or false when the help was read, false for an unknown
 *   sub-command, null when it could not be read
 */
function judgeFlag(
  read: CommandRead,
  flag: string,
  label: string,
  reasons: string[],
): boolean | null {
  if (read.kind === "read") {
    const advertised = helpAdvertisesFlag(read.output, flag);
    reasons.push(
      advertised
        ? `${label} advertises ${flag}.`
        : `${label} does not advertise ${flag}.`,
    );
    return advertised;
  }
  return read.kind === "unknown-subcommand" ? false : null;
}

/**
 * Measure whether the host's Apple CLI can run egress containment.
 *
 * @param run - The injected command runner
 * @param runtime - The Apple CLI executable, normally `container`
 * @returns The measured facts, the verdict and the reasons for each finding
 */
export async function detectAppleNetworkCapabilities(
  run: AppleCommandRunner,
  runtime: string,
): Promise<AppleNetworkCapabilities> {
  const reasons: string[] = [];

  const macosRead = await readCommand(
    run,
    "sw_vers",
    ["-productVersion"],
    "sw_vers -productVersion",
    reasons,
    false,
  );
  let macos: { version: string | null; major: number | null } = {
    version: null,
    major: null,
  };
  if (macosRead.kind === "read") {
    const parsed = parseMacosVersion(macosRead.output);
    if (parsed) {
      macos = { version: parsed.version, major: parsed.major };
      reasons.push(`sw_vers -productVersion reports macOS ${parsed.version}.`);
      if (parsed.major < APPLE_MIN_MACOS_MAJOR) {
        reasons.push(
          `macOS ${parsed.version} is below the required ${APPLE_MIN_MACOS_MAJOR}, which custom networks need.`,
        );
      }
    } else {
      reasons.push(
        `sw_vers -productVersion output "${
          firstCauseLine(macosRead.output)
        }" is not a macOS version.`,
      );
    }
  }

  const versionRead = await readCommand(
    run,
    runtime,
    ["--version"],
    `${runtime} --version`,
    reasons,
    false,
  );
  let containerVersion: string | null = null;
  if (versionRead.kind === "read") {
    containerVersion = parseContainerVersion(versionRead.output);
    reasons.push(
      containerVersion
        ? `${runtime} --version reports ${containerVersion}.`
        : `${runtime} --version output has no x.y.z version.`,
    );
  }

  const createLabel = `${runtime} network create --help`;
  const createRead = await readCommand(
    run,
    runtime,
    ["network", "create", "--help"],
    createLabel,
    reasons,
    true,
  );
  const networkCreateInternal = judgeFlag(
    createRead,
    "--internal",
    createLabel,
    reasons,
  );

  const runLabel = `${runtime} run --help`;
  const runRead = await readCommand(
    run,
    runtime,
    ["run", "--help"],
    runLabel,
    reasons,
    true,
  );
  const runNetworkFlag = judgeFlag(runRead, "--network", runLabel, reasons);

  const macosOld = macos.major !== null && macos.major < APPLE_MIN_MACOS_MAJOR;
  const macosNew = macos.major !== null && macos.major >= APPLE_MIN_MACOS_MAJOR;
  let verdict: AppleNetworkCapabilities["verdict"] = "indeterminate";
  if (macosOld || networkCreateInternal === false || runNetworkFlag === false) {
    verdict = "unsupported";
  } else if (
    macosNew && networkCreateInternal === true && runNetworkFlag === true
  ) {
    verdict = "capable";
  }

  return {
    macos,
    containerVersion,
    networkCreateInternal,
    runNetworkFlag,
    verdict,
    reasons,
  };
}
