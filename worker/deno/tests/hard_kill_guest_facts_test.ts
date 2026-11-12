/**
 * Tests for the guest figures a hard-kill issue carries (Issue #5062): the
 * silent time, the probe state, the guest memory and the guest pressure.
 *
 * Fixtures: the meminfo lines are real output of `cat /proc/meminfo` in the
 * container this suite was written in (the first lines, shape unchanged). That
 * container has no `/proc/pressure/*` (PSI is not enabled there), so the
 * pressure lines follow the kernel's documented shape,
 * `some|full avg10=N avg60=N avg300=N total=N`.
 *
 * The probe states are driven through the real `captureHardKillEvidence`, with
 * the exec seam failing, hanging, or outlasting the capture cap. Every seam is
 * injected: nothing here starts a process, reads a real file or waits for real
 * time.
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertFalse } from "@std/assert";
import {
  captureHardKillEvidence,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_TOTAL_CAP_MS,
  type EvidenceInvocation,
  type EvidenceOptions,
  type EvidenceSeams,
  type GuestEvidence,
  HARD_KILL_EVIDENCE_VERSION,
  type HardKillEvidence,
} from "../lib/hard_kill_evidence.ts";
import {
  hardKillGuestMemory,
  hardKillGuestPressure,
  hardKillGuestProbe,
  hardKillSilentFor,
} from "../lib/hard_kill_guest_facts.ts";

const CONTAINER = "vibe-coder-5062";
const NOW = Date.parse("2026-11-11T17:42:07.603Z");
// Synthetic PAT and private title: assembled at run time, never a literal token.
const TOKEN = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const PRIVATE = "private-repo-title-XYZ";

/** `cat /proc/meminfo` from the container, first lines only. */
const REAL_MEMINFO = [
  "MemTotal:       57634632 kB",
  "MemFree:        26749932 kB",
  "MemAvailable:   53198520 kB",
  "Buffers:         1832616 kB",
  "Cached:         23536900 kB",
  "SwapCached:            0 kB",
].join("\n");

/** Kernel PSI shape; see the module comment for why this is not captured. */
const PSI_CPU = "some avg10=0.00 avg60=0.00 avg300=0.00 total=1234567";
const PSI_MEMORY = [
  "some avg10=99.00 avg60=97.50 avg300=80.25 total=9876543",
  "full avg10=88.00 avg60=60.00 avg300=40.00 total=4567890",
].join("\n");
const PSI_IO = "some avg10=0.10 avg60=0.20 avg300=0.30 total=111";

const BASE: EvidenceOptions = {
  containerName: CONTAINER,
  runtimeExecutable: "container",
  evidenceDir: "/evidence",
  reason: "watchdog deadline of 60s expired",
  trigger: "watchdog",
  nowMs: NOW,
};

type Runtime = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<EvidenceInvocation>;

/** An answer from the fake guest: an invocation, or a call that never returns. */
type Answer = EvidenceInvocation | "hang";

/** A call that never completes, as a hung `container exec` would. */
const NEVER: Promise<EvidenceInvocation> = new Promise(() => {});

/** A healthy guest's answers, keyed by the command run through `exec`. */
const HEALTHY: Record<string, Answer> = {
  "true": { code: 0, stdout: "", stderr: "" },
  "ps -eo pid,ppid,stat,pcpu,pmem,etime,args": {
    code: 0,
    stdout:
      "  PID  PPID STAT %CPU %MEM ELAPSED COMMAND\n    1     0 Ss    0.0  0.1   01:02 init",
    stderr: "",
  },
  "cat /proc/meminfo": { code: 0, stdout: REAL_MEMINFO, stderr: "" },
  "cat /proc/pressure/cpu": { code: 0, stdout: PSI_CPU, stderr: "" },
  "cat /proc/pressure/memory": { code: 0, stdout: PSI_MEMORY, stderr: "" },
  "cat /proc/pressure/io": { code: 0, stdout: PSI_IO, stderr: "" },
};

/** A runtime answering from `table`; a command not in it fails with 127. */
function answering(table: Record<string, Answer>): Runtime {
  return (args) => {
    if (args[0] === "logs") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    const answer = table[args.slice(2).join(" ")];
    if (answer === "hang") return NEVER;
    return Promise.resolve(
      answer ?? { code: 127, stdout: "", stderr: "no such command" },
    );
  };
}

/**
 * Seams for one capture. Only the timers `firesFor` names fire; a timer that
 * does not fire leaves its step waiting, as a hung step would.
 */
function seamsFor(
  runtime: Runtime,
  firesFor: (ms: number) => boolean,
  written: { path: string; text: string }[],
): EvidenceSeams {
  return {
    runRuntime: runtime,
    listLogFiles: () => Promise.resolve([]),
    readTail: () => Promise.resolve(""),
    writeFile: (path, text) => {
      written.push({ path, text });
      return Promise.resolve();
    },
    hostname: () => "test-host",
    timeout: (ms) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        if (firesFor(ms)) handle = setTimeout(resolve, 0);
      });
      return { promise, cancel: () => clearTimeout(handle) };
    },
  };
}

/** Run a real capture and return the record it wrote. */
async function capturedRecord(
  runtime: Runtime,
  firesFor: (ms: number) => boolean,
): Promise<HardKillEvidence> {
  const written: { path: string; text: string }[] = [];
  const outcome = await captureHardKillEvidence(
    seamsFor(runtime, firesFor, written),
    BASE,
  );
  assertEquals(outcome.ok, true, "the capture wrote its file");
  assertEquals(written.length, 1, "exactly one evidence file is written");
  return JSON.parse(written[0]!.text) as HardKillEvidence;
}

/** A timer rule: every timer fires except the exec probe's. */
const EXEC_TIMERS_HANG = (ms: number) => ms !== DEFAULT_EXEC_TIMEOUT_MS;
/** A timer rule: every timer fires except the capture cap's. */
const CAP_NEVER_ENDS = (ms: number) => ms !== DEFAULT_TOTAL_CAP_MS;

/** A record built by hand; `fields` and `guest` override the defaults. */
function recordWith(
  fields: Partial<Omit<HardKillEvidence, "evidence">> = {},
  guest: Partial<GuestEvidence> = {},
): HardKillEvidence {
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: "2026-11-11T17:42:07.603Z",
    host: "s1",
    container: CONTAINER,
    runId: "unknown",
    trigger: "watchdog",
    reason: "watchdog deadline of 60s expired",
    lastLogLine: "",
    lastLogTimestamp: "2026-11-11 16:53:16Z",
    lastToolCall: "",
    ...fields,
    evidence: {
      workerLogTail: "",
      agentTranscriptTail: "",
      bootLogs: "",
      guest: {
        ps: "PID CMD\n1 init",
        meminfo: REAL_MEMINFO,
        pressureCpu: PSI_CPU,
        pressureMemory: PSI_MEMORY,
        pressureIo: PSI_IO,
        ...guest,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// hardKillSilentFor
// ---------------------------------------------------------------------------

Deno.test("hardKillSilentFor gives the real incident's silent time (Issue #5062)", () => {
  assertEquals(hardKillSilentFor(recordWith()), "48m 51s");
});

Deno.test("hardKillSilentFor words hours and keeps a zero middle unit", () => {
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "2026-11-11T10:00:00Z",
      capturedAt: "2026-11-11T11:02:03.000Z",
    })),
    "1h 2m 3s",
  );
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "2026-11-11T10:00:00Z",
      capturedAt: "2026-11-11T11:00:03.999Z",
    })),
    "1h 0m 3s",
  );
});

Deno.test("hardKillSilentFor drops leading zero units and floors to whole seconds", () => {
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "2026-11-11T17:41:22.000Z",
      capturedAt: "2026-11-11T17:42:07.000Z",
    })),
    "45s",
  );
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "2026-11-11T17:42:07Z",
      capturedAt: "2026-11-11T17:42:07.000Z",
    })),
    "0s",
  );
});

Deno.test("hardKillSilentFor says when the time comes from the log file's modified time", () => {
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp:
        "2026-11-11T16:53:16.000Z (log file modified time; the last line carries no timestamp)",
    })),
    "48m 51s (from the log file's modified time)",
  );
});

Deno.test("hardKillSilentFor is unknown for a timestamp with no trailing Z", () => {
  assertEquals(
    hardKillSilentFor(recordWith({ lastLogTimestamp: "2026-11-11 16:53:16" })),
    "unknown",
  );
});

Deno.test("hardKillSilentFor is unknown when no log was read", () => {
  assertEquals(
    hardKillSilentFor(recordWith({ lastLogTimestamp: "unknown" })),
    "unknown",
  );
});

Deno.test("hardKillSilentFor is unknown when the last log line is after the capture", () => {
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "2026-11-11T17:43:00Z",
    })),
    "unknown",
  );
});

Deno.test("hardKillSilentFor is unknown for a timestamp that does not parse", () => {
  assertEquals(
    hardKillSilentFor(recordWith({ lastLogTimestamp: "2026-13-45 99:99:99Z" })),
    "unknown",
  );
});

Deno.test("hardKillSilentFor is unknown when the capture time does not parse (Issue #5062)", () => {
  for (const capturedAt of ["not a time", "", "2026-13-45T99:99:99.000Z"]) {
    assertEquals(
      hardKillSilentFor(recordWith({ capturedAt })),
      "unknown",
      `capturedAt ${JSON.stringify(capturedAt)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// hardKillGuestProbe, from records the real capture wrote
// ---------------------------------------------------------------------------

Deno.test("hardKillGuestProbe is answered when the guest's exec answers", async () => {
  const record = await capturedRecord(answering(HEALTHY), CAP_NEVER_ENDS);
  assertEquals(record.evidence.guest.ps.startsWith("unavailable:"), false);
  assertEquals(hardKillGuestProbe(record), "answered");
});

Deno.test("hardKillGuestProbe is did not answer when the exec fails", async () => {
  const record = await capturedRecord(
    answering({
      ...HEALTHY,
      "true": { code: 1, stdout: "", stderr: "OCI runtime exec failed" },
    }),
    CAP_NEVER_ENDS,
  );
  assertEquals(
    record.evidence.guest.ps,
    "unavailable: container exec did not answer: exit 1: OCI runtime exec failed",
  );
  assertEquals(hardKillGuestProbe(record), "did not answer");
});

Deno.test("hardKillGuestProbe is did not answer when the exec hangs past its bound", async () => {
  const record = await capturedRecord(
    answering({ ...HEALTHY, "true": "hang" }),
    CAP_NEVER_ENDS,
  );
  assertEquals(
    record.evidence.guest.ps,
    "unavailable: container exec did not answer: no answer within 10000ms",
  );
  assertEquals(hardKillGuestProbe(record), "did not answer");
});

Deno.test("hardKillGuestProbe is not collected when the capture cap ends first", async () => {
  const record = await capturedRecord(
    answering({ ...HEALTHY, "true": "hang" }),
    EXEC_TIMERS_HANG,
  );
  assertEquals(
    record.evidence.guest.ps,
    "unavailable: not collected before the 60000ms capture cap ended",
  );
  assertEquals(hardKillGuestProbe(record), "not collected");
});

Deno.test("hardKillGuestProbe is unavailable when the probe answers but a later exec fails", async () => {
  const record = await capturedRecord(
    answering({
      ...HEALTHY,
      "ps -eo pid,ppid,stat,pcpu,pmem,etime,args": {
        code: 1,
        stdout: "",
        stderr: "ps: not found",
      },
    }),
    CAP_NEVER_ENDS,
  );
  assertEquals(record.evidence.guest.ps, "unavailable: exit 1: ps: not found");
  assertEquals(hardKillGuestProbe(record), "unavailable");
});

// ---------------------------------------------------------------------------
// hardKillGuestMemory
// ---------------------------------------------------------------------------

Deno.test("hardKillGuestMemory rounds real meminfo kB down to MB", () => {
  assertEquals(
    hardKillGuestMemory(recordWith()),
    "MemTotal 56283 MB, MemAvailable 51951 MB",
  );
});

Deno.test("hardKillGuestMemory keeps a single figure that is present", () => {
  assertEquals(
    hardKillGuestMemory(recordWith({}, {
      meminfo: "MemAvailable: 122880 kB",
    })),
    "MemAvailable 120 MB",
  );
  assertEquals(
    hardKillGuestMemory(recordWith({}, { meminfo: "MemTotal: 4194304 kB" })),
    "MemTotal 4096 MB",
  );
});

Deno.test("hardKillGuestMemory rounds down a figure under one MB", () => {
  assertEquals(
    hardKillGuestMemory(recordWith({}, { meminfo: "MemTotal: 1535 kB" })),
    "MemTotal 1 MB",
  );
});

Deno.test("hardKillGuestMemory is not available when neither figure parses", () => {
  assertEquals(
    hardKillGuestMemory(recordWith({}, { meminfo: "MemFree: 1 kB" })),
    "not available",
  );
  assertEquals(
    hardKillGuestMemory(recordWith({}, {
      meminfo: "note MemTotal: 4194304 kB",
    })),
    "not available",
    "a figure mid-line is not a meminfo line",
  );
  assertEquals(
    hardKillGuestMemory(recordWith({}, {
      meminfo: "MemTotal: 9999999999999 kB",
    })),
    "not available",
    "a digit run longer than twelve is not a figure",
  );
  assertEquals(
    hardKillGuestMemory(recordWith({}, {
      meminfo: "unavailable: container exec did not answer: exit 1",
    })),
    "not available",
  );
});

// ---------------------------------------------------------------------------
// hardKillGuestPressure
// ---------------------------------------------------------------------------

Deno.test("hardKillGuestPressure reads a partial line that carries only avg10", () => {
  assertEquals(
    hardKillGuestPressure(recordWith({}, {
      pressureCpu: "some avg10=0.00",
      pressureMemory: "some avg10=99.00",
      pressureIo: "some avg10=0.00",
    })),
    "cpu some avg10=0.00; memory some avg10=99.00; io some avg10=0.00",
  );
});

Deno.test("hardKillGuestPressure keeps some and full, skips total=", () => {
  assertEquals(
    hardKillGuestPressure(recordWith()),
    "cpu some avg10=0.00 avg60=0.00 avg300=0.00; " +
      "memory some avg10=99.00 avg60=97.50 avg300=80.25; " +
      "memory full avg10=88.00 avg60=60.00 avg300=40.00; " +
      "io some avg10=0.10 avg60=0.20 avg300=0.30",
  );
});

Deno.test("hardKillGuestPressure drops a number that is not well formed", () => {
  assertEquals(
    hardKillGuestPressure(recordWith({}, {
      pressureCpu: "",
      pressureMemory: "some avg10=1000.00 avg60=1.234 avg300=5.5 total=7",
      pressureIo: "",
    })),
    "memory some avg300=5.5",
  );
});

Deno.test("hardKillGuestPressure is not available when no line parses", () => {
  assertEquals(
    hardKillGuestPressure(recordWith({}, {
      pressureCpu: "some total=12",
      pressureMemory: "",
      pressureIo: "",
    })),
    "not available",
  );
  assertEquals(
    hardKillGuestPressure(recordWith({}, {
      pressureCpu: "unavailable: container exec did not answer: exit 1",
      pressureMemory: "unavailable: container exec did not answer: exit 1",
      pressureIo: "unavailable: container exec did not answer: exit 1",
    })),
    "not available",
  );
});

// ---------------------------------------------------------------------------
// Privacy: no free text from the guest reaches any returned string
// ---------------------------------------------------------------------------

Deno.test("no guest figure carries a private title or a token from ps or meminfo", () => {
  const leaky = recordWith({}, {
    ps: `PID CMD\n1 ${PRIVATE} ${TOKEN}`,
    meminfo:
      `MemTotal: 4194304 kB ${PRIVATE} ${TOKEN}\nMemAvailable: 122880 kB ${TOKEN}`,
    pressureCpu: `some avg10=1.00 ${PRIVATE}`,
    pressureMemory: `some avg10=2.00 ${TOKEN}`,
    pressureIo: `full avg10=3.00 ${PRIVATE}`,
  });
  const outputs = [
    hardKillSilentFor(leaky),
    hardKillGuestProbe(leaky),
    hardKillGuestMemory(leaky),
    hardKillGuestPressure(leaky),
  ];
  for (const output of outputs) {
    assertFalse(output.includes(PRIVATE), `"${output}" carries the title`);
    assertFalse(output.includes("ghp_"), `"${output}" carries a token`);
  }
  assertEquals(hardKillGuestProbe(leaky), "answered");
  assertEquals(
    hardKillGuestMemory(leaky),
    "MemTotal 4096 MB, MemAvailable 120 MB",
  );
  assertEquals(
    hardKillGuestPressure(leaky),
    "cpu some avg10=1.00; memory some avg10=2.00; io full avg10=3.00",
  );

  const failed = recordWith({}, {
    ps: `unavailable: container exec did not answer: ${PRIVATE} ${TOKEN}`,
  });
  assertEquals(hardKillGuestProbe(failed), "did not answer");
});

// ---------------------------------------------------------------------------
// Hostile input: each finishes and gives a safe result
// ---------------------------------------------------------------------------

Deno.test("a 64 KiB single-line meminfo gives not available", () => {
  const long = recordWith({}, {
    meminfo: "MemTotal: " + "9".repeat(64 * 1024),
  });
  assertEquals(hardKillGuestMemory(long), "not available");
});

Deno.test("a 64 KiB meminfo line with a valid figure first still reads the figure", () => {
  const padded = recordWith({}, {
    meminfo: "MemTotal: 4194304 kB" + " x".repeat(32 * 1024),
  });
  assertEquals(hardKillGuestMemory(padded), "MemTotal 4096 MB");
});

Deno.test("a 64 KiB single-line pressure field gives not available", () => {
  const digits = recordWith({}, {
    pressureCpu: "some " + "9".repeat(64 * 1024),
    pressureMemory: "some avg10=" + "9".repeat(64 * 1024),
    pressureIo: "full " + "avg10=1.00 ".repeat(6000),
  });
  assertEquals(
    hardKillGuestPressure(digits),
    "io full avg10=1.00",
    "only the capped prefix is read, and the first avg10 wins",
  );

  const none = recordWith({}, {
    pressureCpu: "some " + "9".repeat(64 * 1024),
    pressureMemory: "some avg10=" + "9".repeat(64 * 1024),
    pressureIo: "",
  });
  assertEquals(hardKillGuestPressure(none), "not available");
});

Deno.test("a 64 KiB single-line ps field still yields a probe state", () => {
  assertEquals(
    hardKillGuestProbe(recordWith({}, { ps: "x".repeat(64 * 1024) })),
    "answered",
  );
  assertEquals(
    hardKillGuestProbe(recordWith({}, {
      ps: "unavailable: container exec did not answer: " +
        "x".repeat(64 * 1024),
    })),
    "did not answer",
  );
});

Deno.test("a long digit run in the log timestamp gives unknown", () => {
  assertEquals(
    hardKillSilentFor(recordWith({
      lastLogTimestamp: "9".repeat(64 * 1024),
    })),
    "unknown",
  );
});
