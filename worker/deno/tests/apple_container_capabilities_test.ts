import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  APPLE_MIN_MACOS_MAJOR,
  type AppleCommandRunner,
  detectAppleNetworkCapabilities,
  helpAdvertisesFlag,
  parseContainerVersion,
  parseMacosVersion,
} from "../lib/apple_container_capabilities.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/** `container network create --help`, as the documented usage describes it. */
const NETWORK_CREATE_HELP =
  `USAGE: container network create [--help] [--internal] [--label <label> ...] [--subnet <subnet>] [--debug] <name>

ARGUMENTS:
  <name>                  Network name

OPTIONS:
  --internal              Restrict to host-only network
  --label <label>         Set metadata for the network (format: key=value)
  --subnet <subnet>       Set the IPv4 subnet for the network
  --debug                 Enable debug logging
  -h, --help              Show help information
`;

/** `container run --help`, with `--network` repeatable. */
const RUN_HELP =
  `USAGE: container run [--network <network> ...] [--volume <volume> ...] [--] [<image>] [<arguments> ...]

OPTIONS:
  --network <network>     Attach the container to a network (name[,mac=<mac>][,alias=<name>]); repeat to attach several
  --volume <volume>       Bind mount a volume into the container
  -h, --help              Show help information
`;

/** A reply the fake runner gives for one command. */
type Reply = { code: number; stdout?: string; stderr?: string } | Error;

/** The keys are `command args...` joined with single spaces. */
type Replies = Record<string, Reply>;

/** A fake runner: a missing key is a spawn failure, as a real CLI would be. */
function fakeRunner(replies: Replies): AppleCommandRunner {
  return (command, args) => {
    const key = [command, ...args].join(" ");
    const reply = replies[key];
    if (reply === undefined) {
      return Promise.reject(new Error(`spawn ${key} ENOENT`));
    }
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      code: reply.code,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
    });
  };
}

const SW_VERS = "sw_vers -productVersion";
const VERSION = "container --version";
const CREATE_HELP = "container network create --help";
const RUN_HELP_KEY = "container run --help";

/** A host that would be capable: macOS 26, both flags advertised. */
const CAPABLE: Replies = {
  [SW_VERS]: { code: 0, stdout: "26.0.1\n" },
  [VERSION]: {
    code: 0,
    stdout: "container CLI version 1.2.2 (build: release, commit: abc)\n",
  },
  [CREATE_HELP]: { code: 0, stdout: NETWORK_CREATE_HELP },
  [RUN_HELP_KEY]: { code: 0, stdout: RUN_HELP },
};

/** The capable host with some replies overridden. */
function withReplies(overrides: Replies): Replies {
  return { ...CAPABLE, ...overrides };
}

Deno.test("parseMacosVersion accepts sw_vers output with a trailing newline (Issue #4051)", () => {
  assertEquals(parseMacosVersion("26.0.1\n"), { version: "26.0.1", major: 26 });
});

Deno.test("parseMacosVersion accepts a two-part version (Issue #4051)", () => {
  assertEquals(parseMacosVersion("15.6"), { version: "15.6", major: 15 });
});

Deno.test("parseMacosVersion rejects anything that is not a dotted numeric version (Issue #4051)", () => {
  for (
    const text of [
      "",
      "26",
      "macOS 26.0",
      "26.0.1.2",
      "26.x",
      "26.0 beta",
      "-26.0",
      "26..0",
    ]
  ) {
    assertEquals(
      parseMacosVersion(text),
      null,
      `accepted ${JSON.stringify(text)}`,
    );
  }
});

Deno.test("parseContainerVersion reads the version from the CLI banner (Issue #4051)", () => {
  assertEquals(
    parseContainerVersion(
      "container CLI version 1.2.2 (build: release, commit: abc)",
    ),
    "1.2.2",
  );
});

Deno.test("parseContainerVersion keeps a pre-release suffix (Issue #4051)", () => {
  assertEquals(
    parseContainerVersion("container CLI version 0.9.0-beta.1 (build: debug)"),
    "0.9.0-beta.1",
  );
});

Deno.test("parseContainerVersion reads a JSON or table version field (Issue #4051)", () => {
  assertEquals(
    parseContainerVersion('{"version":"1.2.2","commit":"abc"}'),
    "1.2.2",
  );
  assertEquals(parseContainerVersion("VERSION\n1.2.2\n"), "1.2.2");
});

Deno.test("parseContainerVersion returns null when no x.y.z is present (Issue #4051)", () => {
  assertEquals(parseContainerVersion("container: command not found"), null);
  assertEquals(parseContainerVersion(""), null);
  assertEquals(parseContainerVersion("version 1.2"), null);
});

Deno.test("helpAdvertisesFlag matches --internal as a whole option token (Issue #4051)", () => {
  assertEquals(helpAdvertisesFlag(NETWORK_CREATE_HELP, "--internal"), true);
  assertEquals(helpAdvertisesFlag("  [--internal]", "--internal"), true);
  assertEquals(helpAdvertisesFlag("--internal, --debug", "--internal"), true);
});

Deno.test("helpAdvertisesFlag matches --network as a whole option token (Issue #4051)", () => {
  assertEquals(helpAdvertisesFlag(RUN_HELP, "--network"), true);
});

Deno.test("helpAdvertisesFlag does not match a longer option name (Issue #4051)", () => {
  assertEquals(
    helpAdvertisesFlag("  --internal-foo  Other", "--internal"),
    false,
  );
  assertEquals(
    helpAdvertisesFlag("  --network-backend <b>", "--network"),
    false,
  );
  assertEquals(helpAdvertisesFlag("x--internal", "--internal"), false);
  assertEquals(helpAdvertisesFlag("anything", ""), false);
});

Deno.test("helpAdvertisesFlag finds a later whole token after a longer one (Issue #4051)", () => {
  assertEquals(
    helpAdvertisesFlag("--internal-foo and then --internal", "--internal"),
    true,
  );
});

Deno.test("parseMacosVersion stays linear on a hostile digit run (Issue #4051)", () => {
  const output = assertLinearGrowth(
    "parseMacosVersion, hostile digit run",
    (chars) => "1".repeat(chars) + "x",
    (input) => parseMacosVersion(input),
    { baseChars: 20000 },
  );
  assertEquals(output, null);
});

Deno.test("parseContainerVersion stays linear on a hostile digit run (Issue #4051)", () => {
  const output = assertLinearGrowth(
    "parseContainerVersion, hostile digit run",
    (chars) => "1".repeat(chars) + ".2",
    (input) => parseContainerVersion(input),
    { baseChars: 20000 },
  );
  assertEquals(output, null);
});

Deno.test("parseContainerVersion stays linear on a hostile dotted run (Issue #4051)", () => {
  const output = assertLinearGrowth(
    "parseContainerVersion, hostile dotted run",
    (chars) => "1.a".repeat(chars),
    (input) => parseContainerVersion(input),
    { baseChars: 20000 },
  );
  assertEquals(output, null);
});

Deno.test("helpAdvertisesFlag stays linear on a hostile run of near matches (Issue #4051)", () => {
  const output = assertLinearGrowth(
    "helpAdvertisesFlag, hostile near matches",
    (chars) => "x--internal".repeat(chars),
    (input) => helpAdvertisesFlag(input, "--internal"),
    { baseChars: 5000 },
  );
  assertEquals(output, false);
});

Deno.test("detect: a capable host is capable with both flags and the version measured (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(CAPABLE),
    "container",
  );
  assertEquals(result.verdict, "capable");
  assertEquals(result.macos, { version: "26.0.1", major: 26 });
  assertEquals(result.containerVersion, "1.2.2");
  assertEquals(result.networkCreateInternal, true);
  assertEquals(result.runNetworkFlag, true);
  assertStringIncludes(
    result.reasons.join("\n"),
    "network create --help advertises --internal",
  );
  assertStringIncludes(
    result.reasons.join("\n"),
    "run --help advertises --network",
  );
});

Deno.test("detect: macOS older than 26 is unsupported even with both flags (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({ [SW_VERS]: { code: 0, stdout: "15.6\n" } })),
    "container",
  );
  assertEquals(result.verdict, "unsupported");
  assertEquals(result.macos.major, 15);
  assertStringIncludes(
    result.reasons.join("\n"),
    `below the required ${APPLE_MIN_MACOS_MAJOR}`,
  );
});

Deno.test("detect: an unreadable macOS version is indeterminate, never capable (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({ [SW_VERS]: new Error("spawn sw_vers ENOENT") })),
    "container",
  );
  assertEquals(result.verdict, "indeterminate");
  assertEquals(result.macos, { version: null, major: null });
  assertStringIncludes(
    result.reasons.join("\n"),
    "sw_vers -productVersion could not be run",
  );
});

Deno.test("detect: a definitive negative wins over an unreadable macOS version (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [SW_VERS]: new Error("spawn sw_vers ENOENT"),
      [CREATE_HELP]: {
        code: 0,
        stdout: "USAGE: container network create <name>\n",
      },
    })),
    "container",
  );
  assertEquals(result.verdict, "unsupported");
  assertEquals(result.networkCreateInternal, false);
});

Deno.test("detect: a macOS string that is not a version is indeterminate (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({ [SW_VERS]: { code: 0, stdout: "macOS 26\n" } })),
    "container",
  );
  assertEquals(result.verdict, "indeterminate");
  assertEquals(result.macos.major, null);
  assertStringIncludes(result.reasons.join("\n"), "is not a macOS version");
});

Deno.test("detect: a help text that was read and lacks --internal is unsupported (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: {
        code: 0,
        stdout:
          "USAGE: container network create [--debug] <name>\n  --debug  Enable debug logging\n",
      },
    })),
    "container",
  );
  assertEquals(result.verdict, "unsupported");
  assertEquals(result.networkCreateInternal, false);
  assertStringIncludes(
    result.reasons.join("\n"),
    "does not advertise --internal",
  );
});

Deno.test("detect: a failed help read is indeterminate, not a definitive negative (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: { code: 1, stderr: "error: boom\n" },
    })),
    "container",
  );
  assertEquals(result.networkCreateInternal, null);
  assertEquals(result.verdict, "indeterminate");
  assertStringIncludes(
    result.reasons.join("\n"),
    'container network create --help exited 1: "error: boom".',
  );
});

Deno.test("detect: an empty successful help read is indeterminate (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({ [RUN_HELP_KEY]: { code: 0, stdout: "  \n" } })),
    "container",
  );
  assertEquals(result.runNetworkFlag, null);
  assertEquals(result.verdict, "indeterminate");
});

Deno.test("detect: a help runner error is indeterminate and never thrown (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: new Error("timed out after 5000 ms\nsecond line"),
    })),
    "container",
  );
  assertEquals(result.networkCreateInternal, null);
  assertEquals(result.verdict, "indeterminate");
  assertStringIncludes(
    result.reasons.join("\n"),
    'container network create --help could not be run: "timed out after 5000 ms".',
  );
});

Deno.test("detect: a long cause line is capped at 200 characters in the reasons (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: new Error("x".repeat(500)),
    })),
    "container",
  );
  const joined = result.reasons.join("\n");
  assertStringIncludes(joined, "x".repeat(200));
  assertEquals(joined.includes("x".repeat(201)), false);
});

Deno.test("detect: a run help that lacks --network is unsupported (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [RUN_HELP_KEY]: {
        code: 0,
        stdout:
          "USAGE: container run [--volume <volume> ...] <image>\n  --network-backend <b>  Other\n",
      },
    })),
    "container",
  );
  assertEquals(result.runNetworkFlag, false);
  assertEquals(result.verdict, "unsupported");
});

Deno.test("detect: a CLI that says the sub-command is unknown is unsupported (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: {
        code: 64,
        stderr: 'Error: unknown command "network" for "container"\n',
      },
    })),
    "container",
  );
  assertEquals(result.networkCreateInternal, false);
  assertEquals(result.verdict, "unsupported");
  assertStringIncludes(
    result.reasons.join("\n"),
    "saying the sub-command is unknown",
  );
});

Deno.test("detect: a run help that says Unknown option is unsupported (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [RUN_HELP_KEY]: {
        code: 1,
        stderr: "Error: Unknown option '--help'\nUsage: container run\n",
      },
    })),
    "container",
  );
  assertEquals(result.runNetworkFlag, false);
  assertEquals(result.verdict, "unsupported");
});

Deno.test("detect: help printed on stderr with exit 0 is still read (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: { code: 0, stderr: NETWORK_CREATE_HELP },
      [RUN_HELP_KEY]: { code: 0, stderr: RUN_HELP },
    })),
    "container",
  );
  assertEquals(result.verdict, "capable");
});

Deno.test("detect: an unreadable --version does not on its own block capable (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(
      withReplies({ [VERSION]: { code: 0, stdout: "no version here\n" } }),
    ),
    "container",
  );
  assertEquals(result.containerVersion, null);
  assertEquals(result.verdict, "capable");
});

Deno.test("detect: every runner error is recorded and nothing throws (Issue #4051)", async () => {
  const runner: AppleCommandRunner = () => Promise.reject(new Error("no CLI"));
  const result = await detectAppleNetworkCapabilities(runner, "container");
  assertEquals(result.verdict, "indeterminate");
  assertEquals(result.macos, { version: null, major: null });
  assertEquals(result.containerVersion, null);
  assertEquals(result.networkCreateInternal, null);
  assertEquals(result.runNetworkFlag, null);
  assertEquals(result.reasons.length, 4);
});

Deno.test("detect handles a hostile single-token stderr without a false match (Issue #4051)", async () => {
  const result = await detectAppleNetworkCapabilities(
    fakeRunner(withReplies({
      [CREATE_HELP]: { code: 1, stderr: "a".repeat(100000) },
    })),
    "container",
  );
  assertEquals(result.networkCreateInternal, null);
  assertEquals(result.verdict, "indeterminate");
});
