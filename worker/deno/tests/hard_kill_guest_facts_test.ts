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

import { assert, assertEquals, assertFalse } from "@std/assert";
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
  hardKillHostDisk,
  hardKillHostMemory,
  hardKillLastLivenessTick,
  hardKillMemoryGuards,
  hardKillSilentFor,
} from "../lib/hard_kill_guest_facts.ts";
import { guestMemoryFloorReason } from "../lib/guest_memory_floor.ts";
import { formatMemoryGuardKill } from "../lib/memory_guard.ts";
import { WorkerMemoryGuard } from "../lib/worker_memory_guard.ts";
import {
  collapseProcPressureText,
  formatLivenessPressureFields,
  type LivenessTickPressure,
  withRunPressureTicks,
} from "../lib/liveness_guard.ts";
import { createLogger } from "../lib/logger.ts";

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
    diskReading: () => Promise.resolve(null),
    memoryReading: () => Promise.resolve({ level: "unknown" }),
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
      hostState: {
        disk: "available=3435973837 total=493921239040",
        memory: "level=high available=858993459 total=17179869184",
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

/** A record whose host state fields are the given text. */
function withHostState(disk: string, memory: string): HardKillEvidence {
  const base = recordWith();
  return {
    ...base,
    evidence: { ...base.evidence, hostState: { disk, memory } },
  };
}

Deno.test("hardKillHostDisk words the free space in GiB and percent (Issue #5250)", () => {
  assertEquals(
    hardKillHostDisk(
      withHostState("available=3435973837 total=493921239040", ""),
    ),
    "3.2 GiB free of 460.0 GiB (0% free)",
  );
  assertEquals(
    hardKillHostDisk(
      withHostState("available=1073741824 total=2147483648", ""),
    ),
    "1.0 GiB free of 2.0 GiB (50% free)",
  );
});

Deno.test("hardKillHostDisk never echoes free text or a path (Issue #5250)", () => {
  assertEquals(
    hardKillHostDisk(
      withHostState(
        "unavailable: df could not read /Users/someone/private",
        "",
      ),
    ),
    "not available",
  );
  assertEquals(
    hardKillHostDisk(withHostState("available=" + "1".repeat(50000) + "x", "")),
    "not available",
  );
  assertEquals(
    hardKillHostDisk(withHostState("available=5 total=0", "")),
    "not available",
  );
  assertEquals(
    hardKillHostDisk(withHostState("available=9 total=5", "")),
    "not available",
  );
});

Deno.test("hardKillHostMemory words the pressure level and bytes (Issue #5250)", () => {
  assertEquals(
    hardKillHostMemory(
      withHostState("", "level=high available=858993459 total=17179869184"),
    ),
    "pressure high, 0.8 GiB available of 16.0 GiB",
  );
  assertEquals(
    hardKillHostMemory(withHostState("", "level=ok")),
    "pressure ok",
  );
});

Deno.test("hardKillHostMemory gives not available for unknown, inconsistent or hostile fields (Issue #5250)", () => {
  for (
    const memory of [
      "level=unknown",
      "level=ok available=9 total=5",
      "level=ok available=1 total=0",
      "level=" + "o".repeat(50000),
      "level=ok available=" + "1".repeat(50000) + "x",
      "unavailable: sysctl timed out at /Users/someone/private",
    ]
  ) {
    assertEquals(
      hardKillHostMemory(withHostState("", memory)),
      "not available",
      memory.slice(0, 40),
    );
  }
});

// ---------------------------------------------------------------------------
// The last liveness tick in the worker log tail (Issue #4815)
// ---------------------------------------------------------------------------

const TICK_PREFIX = "[2026-11-04 21:16:02Z] INFO: [GRQ-3 o/r#4972] [liveness]";
const TICK_HEAD =
  "tick=7 alerted=false live_epoch=1 last_idle_claimed=0 last_productive=5";

/** A record whose worker log tail is `lines`. */
function tailRecord(lines: string[] | string): HardKillEvidence {
  const ev = recordWith();
  ev.evidence.workerLogTail = Array.isArray(lines) ? lines.join("\n") : lines;
  return ev;
}

Deno.test("the newest liveness tick in the tail wins (Issue #4815)", () => {
  const ev = tailRecord([
    `${TICK_PREFIX} ${TICK_HEAD} mem_available_mib=3000`,
    `[2026-11-04 21:17:02Z] INFO: [GRQ-3 o/r#4972] [liveness] ${TICK_HEAD} mem_available_mib=120 pressure_memory=some,avg10=45.00,avg60=40.00,avg300=10.00,total=123,full,avg10=30.12,avg60=1.00,avg300=0.50,total=99 pressure_cpu=some,avg10=2.00,avg60=1.00,avg300=0.00,total=5`,
    "[2026-11-04 21:17:03Z] INFO: something else",
    "no timestamp here",
  ]);
  assertEquals(
    hardKillLastLivenessTick(ev),
    "MemAvailable 120 MiB, memory some avg10=45.00, memory full avg10=30.12, cpu some avg10=2.00 (logged 2026-11-04 21:17:02Z)",
  );
});

Deno.test("no tick in the tail reads not in the log tail (Issue #4815)", () => {
  assertEquals(
    hardKillLastLivenessTick(tailRecord("[2026-11-04 21:16:02Z] INFO: x")),
    "not in the log tail",
  );
  assertEquals(
    hardKillLastLivenessTick(tailRecord("unavailable: log file missing")),
    "not in the log tail",
  );
});

Deno.test("unavailable figures are fixed words (Issue #4815)", () => {
  assertEquals(
    hardKillLastLivenessTick(tailRecord(
      `${TICK_PREFIX} ${TICK_HEAD} mem_available_mib=unavailable pressure_memory=unavailable pressure_cpu=empty`,
    )),
    "MemAvailable unavailable (logged 2026-11-04 21:16:02Z)",
  );
});

Deno.test("tick text never leaks and malformed numbers are dropped (Issue #4815)", () => {
  const out = hardKillLastLivenessTick(tailRecord(
    `${TICK_PREFIX} ${TICK_HEAD} hook=/home/u/secret-repo ghp_abc123 mem_available_mib=77 pressure_memory=some,avg10=1234.5,avg60=1.00,avg300=1.00,total=1,full,avg10=9.999,avg60=1.00,avg300=1.00,total=1`,
  ));
  assertEquals(out, "MemAvailable 77 MiB (logged 2026-11-04 21:16:02Z)");
  assertFalse(out.includes("secret-repo"));
  assertFalse(out.includes("ghp_"));
  assertFalse(out.includes("1234"));
});

Deno.test("a tick with only garbage has no readable figures (Issue #4815)", () => {
  assertEquals(
    hardKillLastLivenessTick(tailRecord(`${TICK_PREFIX} tick=!!garbage`)),
    "no readable figures (logged 2026-11-04 21:16:02Z)",
  );
});

Deno.test("hostile tick lines return promptly with a fixed result (Issue #4815)", () => {
  assertEquals(
    hardKillLastLivenessTick(tailRecord(
      `${TICK_PREFIX} ${TICK_HEAD} ${"a".repeat(200_000)}`,
    )),
    "no readable figures (logged 2026-11-04 21:16:02Z)",
  );
  assertEquals(
    hardKillLastLivenessTick(tailRecord(
      `${TICK_PREFIX} ${TICK_HEAD} mem_available_mib=5 pressure_memory=${
        ",".repeat(200_000)
      }`,
    )),
    "MemAvailable 5 MiB (logged 2026-11-04 21:16:02Z)",
  );
});

Deno.test("the tick line the liveness guard writes is read back (Issue #4815)", () => {
  const fields = formatLivenessPressureFields({
    memAvailableMib: 512,
    pressureMemory: collapseProcPressureText(
      "some avg10=12.50 avg60=3.00 avg300=1.00 total=42\nfull avg10=4.25 avg60=1.00 avg300=0.00 total=7\n",
    ),
    pressureCpu: collapseProcPressureText(
      "some avg10=0.75 avg60=0.10 avg300=0.00 total=9\n",
    ),
  });
  const ev = tailRecord(`${TICK_PREFIX} ${TICK_HEAD} hook_state=ok ${fields}`);
  assertEquals(
    hardKillLastLivenessTick(ev),
    "MemAvailable 512 MiB, memory some avg10=12.50, memory full avg10=4.25, cpu some avg10=0.75 (logged 2026-11-04 21:16:02Z)",
  );
});

// ---------------------------------------------------------------------------
// The pressure line an in-flight run logs (Issue #4815)
// ---------------------------------------------------------------------------

/** A reading whose memory is `mib` and whose memory pressure is `avg10`. */
function readingOf(mib: number, avg10: string): LivenessTickPressure {
  return {
    memAvailableMib: mib,
    pressureMemory: collapseProcPressureText(
      `some avg10=${avg10} avg60=1.00 avg300=0.00 total=1\n`,
    ),
    pressureCpu: collapseProcPressureText(
      "some avg10=0.50 avg60=0.10 avg300=0.00 total=1\n",
    ),
  };
}

Deno.test("a reading taken during the run is what the fact reports (Issue #4815)", async () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (m) => lines.push(m), host: "GRQ-3" });
  // The end-of-cycle tick, logged before the claim with a healthy reading.
  logger.info(
    `[liveness] ${TICK_HEAD} hook_state=ok ${
      formatLivenessPressureFields(readingOf(4000, "0.00"))
    }`,
  );
  logger.info("Claimed o/r#4815");
  const readings = [readingOf(900, "10.00"), readingOf(120, "85.25")];
  let reads = 0;
  await withRunPressureTicks(
    async () => {
      // The run is in flight until both in-run readings have been logged.
      while (reads < readings.length) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.info("[pre-PR verifier] starting");
    },
    {
      log: (message) => logger.info(message),
      read: () => {
        const reading = readings[Math.min(reads, readings.length - 1)];
        reads += 1;
        return Promise.resolve(reading as LivenessTickPressure);
      },
      intervalMs: 10,
    },
  );
  const fact = hardKillLastLivenessTick(tailRecord(lines));
  assert(
    fact.startsWith(
      "MemAvailable 120 MiB, memory some avg10=85.25, cpu some avg10=0.50 (logged ",
    ),
    fact,
  );
  const claimAt = lines.findIndex((l) => l.includes("Claimed o/r#4815"));
  const runLines = lines.filter((l) => l.includes("[liveness] run-pressure"));
  assert(runLines.length >= 2, lines.join("\n"));
  assert(lines.indexOf(runLines[0] ?? "") > claimAt);
});

Deno.test("the run pressure line is logged at the start and stops when the run settles (Issue #4815)", async () => {
  const logged: string[] = [];
  let resolveLate: (r: LivenessTickPressure) => void = () => {};
  let reads = 0;
  const result = await withRunPressureTicks(
    () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("done"), 30)),
    {
      log: (m) => logged.push(m),
      read: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve(readingOf(512, "1.00"));
        // The second reading never settles while the run is in flight, so the
        // beats after it are skipped rather than stacking readers.
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      },
      intervalMs: 5,
    },
  );
  assertEquals(result, "done");
  assertEquals(reads, 2);
  resolveLate(readingOf(1, "99.00"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(logged, [
    `[liveness] run-pressure ${
      formatLivenessPressureFields(readingOf(512, "1.00"))
    }`,
  ]);
});

Deno.test("a failed run pressure reading does not fail the run (Issue #4815)", async () => {
  const logged: string[] = [];
  const result = await withRunPressureTicks(
    () => Promise.resolve(7),
    {
      log: (m) => logged.push(m),
      read: () => Promise.reject(new Error("cat hung")),
      intervalMs: 5,
    },
  );
  assertEquals(result, 7);
  assertEquals(logged, []);
});

// ---------------------------------------------------------------------------
// Memory guards in the worker log tail (Issue #5638)
// ---------------------------------------------------------------------------

const NONE_LOGGED = "none logged in the log tail";
const MIB = 1024 * 1024;
const REAL_FLOOR_LINE =
  "[2026-11-26 00:34:34Z] WARNING: [s1 stSoftwareAU/GRQ-AutoTrader#5644] [GUEST_MEMORY_FLOOR] guest memory stayed below its floor (1.7 GiB available, floor 2.7 GiB) for 2 readings in a row: the agent run was stopped so the guest keeps answering (Issue #4815) host=vibe-coder-62543:205";

Deno.test("the real floor-stop line is read (Issue #5638)", () => {
  assertEquals(
    hardKillMemoryGuards(tailRecord(REAL_FLOOR_LINE)),
    "guest memory floor stopped the agent (logged 2026-11-26 00:34:34Z)",
  );
});

Deno.test("producer-built floor and kill lines are read, newest of each (Issue #5638)", () => {
  const floor = guestMemoryFloorReason(1800 * MIB, 2700 * MIB, 2);
  const kill = formatMemoryGuardKill({
    reading: {
      level: "high",
      totalBytes: 4096 * MIB,
      availableBytes: 200 * MIB,
    },
    victim: { pid: 9, ppid: 1, rssKb: 204800, elapsed: "01:00", command: "x" },
    floorBytes: 300 * MIB,
  });
  const ev = tailRecord([
    `[2026-11-26 00:10:00Z] WARNING: [s1 o/r#1] ${floor} host=h:1`,
    `[2026-11-26 00:20:00Z] WARNING: [s1 o/r#1] ${kill} host=h:1`,
    `[2026-11-26 00:30:00Z] WARNING: [s1 o/r#1] ${floor} host=h:1`,
  ]);
  assertEquals(
    hardKillMemoryGuards(ev),
    "guest memory floor stopped the agent (logged 2026-11-26 00:30:00Z); " +
      "early-OOM guard killed a process (logged 2026-11-26 00:20:00Z)",
  );
});

Deno.test("each could-not-act prefix is read on its own (Issue #5638)", () => {
  const cases: [string, string][] = [
    [
      "2026-11-26 01:00:00",
      "[2026-11-26 01:00:00Z] ERROR: [s2 o/r#2] Guest-memory kill failed for PID 42: boom host=h:1",
    ],
    [
      "2026-11-26 01:05:00",
      "[2026-11-26 01:05:00Z] WARNING: Memory guard left pid=7 alone: x host=h:1",
    ],
    [
      "2026-11-26 01:10:00",
      "[2026-11-26 01:10:00Z] WARNING: [s1 o/r#1] Memory guard could not kill pid=7: EPERM (Issue #5529) host=h:1",
    ],
  ];
  for (const [time, line] of cases) {
    assertEquals(
      hardKillMemoryGuards(tailRecord(line)),
      `a memory guard could not act (logged ${time}Z)`,
    );
  }
});

const WORKER_TIME = "2026-11-27 03:32:56";
const WORKER_LOW = {
  level: "high" as const,
  totalBytes: 16 * 1024 * MIB,
  availableBytes: 208 * MIB,
};

Deno.test("a worker guard no-victim line is could-not-act, not a kill (Issue #5634)", async () => {
  const logs: string[] = [];
  const guard = new WorkerMemoryGuard({
    workerPid: 500,
    probe: () => Promise.resolve(WORKER_LOW),
    runPs: () =>
      Promise.resolve(
        "  PID  PPID       RSS     ELAPSED COMMAND\n" +
          "  500     1    204800       10:00 deno run worker\n" +
          "  900     1   3145728       04:59 stray outside the tree",
      ),
    kill: () => {},
    log: (m) => logs.push(m),
    activeAgentPids: () => [],
    readStartTime: () => Promise.resolve("t"),
  });
  await guard.tick();
  assertEquals(logs.length, 1, JSON.stringify(logs));
  assertEquals(
    hardKillMemoryGuards(
      tailRecord(`[${WORKER_TIME}Z] WARNING: ${logs[0]} host=h:1`),
    ),
    "a memory guard could not act (logged 2026-11-27 03:32:56Z)",
  );
});

Deno.test("each worker guard could-not prefix is read on its own (Issue #5634)", () => {
  for (
    const message of [
      "Worker memory guard could not read the process table: boom (Issue #5634)",
      "Worker memory guard could not kill pid=7: EPERM (Issue #5634)",
      "Worker memory guard left pid=7 alone: identity changed (Issue #5634)",
      "Worker memory guard failed: boom (Issue #5634)",
    ]
  ) {
    assertEquals(
      hardKillMemoryGuards(
        tailRecord(`[${WORKER_TIME}Z] WARNING: ${message} host=h:1`),
      ),
      "a memory guard could not act (logged 2026-11-27 03:32:56Z)",
    );
  }
});

Deno.test("a worker-scope kill line is still a kill (Issue #5634)", () => {
  const kill = formatMemoryGuardKill({
    reading: WORKER_LOW,
    victim: {
      pid: 511,
      ppid: 510,
      rssKb: 3145728,
      elapsed: "04:59",
      command: "cargo test --release",
    },
    floorBytes: 300 * MIB,
    scope: "worker",
  });
  assertEquals(
    hardKillMemoryGuards(
      tailRecord(`[${WORKER_TIME}Z] WARNING: ${kill} host=h:1`),
    ),
    "early-OOM guard killed a process (logged 2026-11-27 03:32:56Z)",
  );
});

Deno.test("look-alikes do not count (Issue #5638)", () => {
  for (
    const line of [
      "[2026-11-26 02:00:00Z] INFO: [s1 o/r#1] [agent-progress] Bash: echo [GUEST_MEMORY_FLOOR] Guest memory critically low (",
      "[2026-11-26 02:00:00Z] WARNING: [s1 o/r#1] quoted [GUEST_MEMORY_FLOOR] here",
      "[GUEST_MEMORY_FLOOR] guest memory stayed below its floor",
    ]
  ) {
    assertEquals(hardKillMemoryGuards(tailRecord(line)), NONE_LOGGED);
  }
});

Deno.test("an empty tail reads none logged (Issue #5638)", () => {
  assertEquals(hardKillMemoryGuards(tailRecord("")), NONE_LOGGED);
});

Deno.test("a hostile long line returns (Issue #5638)", () => {
  const line = "[2026-11-26 23:50:01Z] WARNING: [s1 " + "a".repeat(50_000);
  assertEquals(hardKillMemoryGuards(tailRecord(line)), NONE_LOGGED);
});
