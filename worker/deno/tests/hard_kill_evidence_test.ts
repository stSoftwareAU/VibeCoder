/**
 * Tests for hard-kill evidence capture (Issue #4253).
 *
 * The watchdog kills a wedged container, and the kill destroys the evidence of
 * why it wedged. These tests pin what is captured before that kill: every
 * field of the record, the bounded failure of each step, the total cap, the
 * redaction of secrets, and that capture never throws.
 *
 * Every seam is injected: an in-memory directory, a runtime that answers from
 * a table, and timers that fire on the next macrotask. Nothing here reads a
 * real file, starts a process or waits for real time.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  bootLogsArgs,
  captureHardKillEvidence,
  DEFAULT_TOTAL_CAP_MS,
  type EvidenceInvocation,
  type EvidenceOptions,
  type EvidenceSeams,
  type HardKillEvidence,
  lastToolCall,
  MAX_FIELD_CHARS,
  MAX_LINE_CHARS,
  MAX_TOOL_CALL_CHARS,
  tailLines,
} from "../lib/hard_kill_evidence.ts";

const DIR = "/evidence";
const CONTAINER = "vibe-coder-4253";
const REASON = "watchdog deadline of 60s expired";
const NOW = Date.parse("2026-10-24T01:02:03.000Z");
const EPOCH = Math.floor(NOW / 1000);
const FILE = `${DIR}/hard-kill-${CONTAINER}-${EPOCH}.json`;
const RUN_ID = "vibe-m3k9x2-0a1b2c";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const BASE: EvidenceOptions = {
  containerName: CONTAINER,
  runtimeExecutable: "container",
  evidenceDir: DIR,
  reason: REASON,
  trigger: "watchdog",
  nowMs: NOW,
};

interface StoredFile {
  text: string;
  mtimeMs: number;
}

type RuntimeFn = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<EvidenceInvocation>;

interface Fixture {
  /** Files in the evidence directory, by name. */
  files?: Record<string, StoredFile>;
  /** Answers the runtime; defaults to a healthy VM. */
  runtime?: RuntimeFn;
  listLogFiles?: EvidenceSeams["listLogFiles"];
  readTail?: EvidenceSeams["readTail"];
  writeFile?: EvidenceSeams["writeFile"];
  hostname?: () => string;
  /** Which timers fire; the rest stay pending, as a hung step would. */
  firesFor?: (ms: number) => boolean;
}

interface Harness {
  seams: EvidenceSeams;
  writes: { path: string; text: string }[];
  runtimeCalls: string[][];
}

/** The guest's answers, keyed by the command run through `container exec`. */
const GUEST: Record<string, string> = {
  "true": "",
  "ps -eo pid,ppid,stat,pcpu,pmem,etime,args": "  PID PPID\n    1    0\n",
  "cat /proc/meminfo": "MemTotal: 16000000 kB\n",
  "cat /proc/pressure/cpu": "some avg10=0.00 avg60=0.01\n",
  "cat /proc/pressure/memory": "some avg10=1.50 avg60=0.90\n",
  "cat /proc/pressure/io": "some avg10=0.10 avg60=0.20\n",
};

const BOOT_LOG = "boot line 1\nboot line 2\n";

/** A runtime that answers every call as a healthy VM would. */
function healthyRuntime(args: readonly string[]): Promise<EvidenceInvocation> {
  if (args[0] === "logs") {
    return Promise.resolve({ code: 0, stdout: BOOT_LOG, stderr: "" });
  }
  const answer = GUEST[args.slice(2).join(" ")];
  return Promise.resolve(
    answer === undefined
      ? { code: 127, stdout: "", stderr: "no such command" }
      : { code: 0, stdout: answer, stderr: "" },
  );
}

/** A timer that fires on the next macrotask when `firesFor` says so. */
function timerSeam(
  firesFor: (ms: number) => boolean,
): EvidenceSeams["timeout"] {
  return (ms) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      if (firesFor(ms)) handle = setTimeout(resolve, 0);
    });
    return { promise, cancel: () => clearTimeout(handle) };
  };
}

/** Seams over an in-memory evidence directory that record every write. */
function harness(fixture: Fixture = {}): Harness {
  const files = fixture.files ?? {};
  const writes: { path: string; text: string }[] = [];
  const runtimeCalls: string[][] = [];
  const runtime = fixture.runtime ?? healthyRuntime;

  const seams: EvidenceSeams = {
    runRuntime: (args, timeoutMs) => {
      runtimeCalls.push([...args]);
      return runtime(args, timeoutMs);
    },
    listLogFiles: fixture.listLogFiles ??
      (() =>
        Promise.resolve(
          Object.entries(files).map(([name, file]) => ({
            name,
            mtimeMs: file.mtimeMs,
          })),
        )),
    readTail: fixture.readTail ??
      ((path) =>
        Promise.resolve(files[path.slice(DIR.length + 1)]?.text ?? "")),
    writeFile: async (path, text) => {
      writes.push({ path, text });
      await fixture.writeFile?.(path, text);
    },
    hostname: fixture.hostname ?? (() => "test-host"),
    timeout: timerSeam(
      fixture.firesFor ?? ((ms) => ms !== DEFAULT_TOTAL_CAP_MS),
    ),
  };

  return { seams, writes, runtimeCalls };
}

/** Parse the one evidence file a capture wrote. */
function recordOf(h: Harness): HardKillEvidence {
  assertEquals(h.writes.length, 1, "exactly one evidence file is written");
  return JSON.parse(h.writes[0]!.text) as HardKillEvidence;
}

const WORKER_LINES = [
  ...Array.from(
    { length: 299 },
    (_, index) => `[2026-10-24T01:00:00.000Z] log line ${index + 1}`,
  ),
  `[2026-10-24T01:02:03.456Z] waiting for the VM to answer (run ${RUN_ID})`,
];
const WORKER_LOG = `${WORKER_LINES.join("\n")}\n`;
const LAST_LOG_LINE = WORKER_LINES[WORKER_LINES.length - 1]!;

const TRANSCRIPT_LINES = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t0","name":"Read","input":{"file_path":"/old"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"checking"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git status"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"clean"}]}}',
];
const TRANSCRIPT = `${TRANSCRIPT_LINES.join("\n")}\n`;

const HAPPY_FILES: Record<string, StoredFile> = {
  "worker.log": { text: WORKER_LOG, mtimeMs: 2_000 },
  "worker-1.log": {
    text: "[2026-10-23T00:00:00.000Z] a stale log from an earlier run\n",
    mtimeMs: 1_000,
  },
  "agent-vibe-m3k9x2-0a1b2c-2.jsonl": { text: TRANSCRIPT, mtimeMs: 2_000 },
};

const HAPPY_RECORD: HardKillEvidence = {
  version: 1,
  capturedAt: "2026-10-24T01:02:03.000Z",
  host: "test-host",
  container: CONTAINER,
  runId: RUN_ID,
  trigger: "watchdog",
  reason: REASON,
  lastLogLine: LAST_LOG_LINE,
  lastLogTimestamp: "2026-10-24T01:02:03.456Z",
  lastToolCall: 'Bash {"command":"git status"}',
  evidence: {
    workerLogTail: WORKER_LINES.slice(-200).join("\n"),
    agentTranscriptTail: TRANSCRIPT_LINES.join("\n"),
    bootLogs: "boot line 1\nboot line 2",
    guest: {
      ps: "PID PPID\n    1    0",
      meminfo: "MemTotal: 16000000 kB",
      pressureCpu: "some avg10=0.00 avg60=0.01",
      pressureMemory: "some avg10=1.50 avg60=0.90",
      pressureIo: "some avg10=0.10 avg60=0.20",
    },
  },
};

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - writes one file holding every field with its expected value", async () => {
  const h = harness({ files: HAPPY_FILES });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome, { ok: true, file: FILE });
  assertEquals(recordOf(h), HAPPY_RECORD);
  assert(h.writes[0]!.text.endsWith("\n"), "the file ends with a newline");
});

Deno.test("captureHardKillEvidence - keeps only the last 200 worker log lines", async () => {
  const h = harness({ files: HAPPY_FILES });

  await captureHardKillEvidence(h.seams, BASE);

  const lines = recordOf(h).evidence.workerLogTail.split("\n");
  assertEquals(lines.length, 200);
  assertEquals(lines[0], "[2026-10-24T01:00:00.000Z] log line 101");
  assertEquals(lines[199], LAST_LOG_LINE);
});

Deno.test("captureHardKillEvidence - reads the newest worker log, not a stale one", async () => {
  const h = harness({ files: HAPPY_FILES });

  await captureHardKillEvidence(h.seams, BASE);

  assert(!recordOf(h).evidence.workerLogTail.includes("stale log"));
});

Deno.test("captureHardKillEvidence - takes the run id from the last one in the log", async () => {
  const h = harness({
    files: {
      "worker.log": {
        text: `[2026-10-24T01:00:00.000Z] first vibe-aaaaaa-111111\n` +
          `[2026-10-24T01:01:00.000Z] now vibe-bbbbbb-222222\n`,
        mtimeMs: 1,
      },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  assertEquals(recordOf(h).runId, "vibe-bbbbbb-222222");
});

Deno.test("captureHardKillEvidence - the run id falls back to the transcript name", async () => {
  const h = harness({
    files: {
      "worker.log": {
        text: "[2026-10-24T01:02:03.456Z] no run named here\n",
        mtimeMs: 1,
      },
      "agent-vibe-m3k9x2-0a1b2c-2.jsonl": { text: TRANSCRIPT, mtimeMs: 1 },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  assertEquals(recordOf(h).runId, RUN_ID);
});

Deno.test("captureHardKillEvidence - a last line without a timestamp falls back to the file's modified time", async () => {
  const h = harness({
    files: {
      "worker.log": {
        text: "[2026-10-24T01:00:00.000Z] fine\nno stamp on this line\n",
        mtimeMs: Date.parse("2026-10-24T00:00:00.000Z"),
      },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const record = recordOf(h);
  assertEquals(record.lastLogLine, "no stamp on this line");
  assertEquals(
    record.lastLogTimestamp,
    "2026-10-24T00:00:00.000Z " +
      "(log file modified time; the last line carries no timestamp)",
  );
});

Deno.test("captureHardKillEvidence - the boot logs use the Docker spelling off the Apple runtime", async () => {
  const h = harness({ files: HAPPY_FILES });

  await captureHardKillEvidence(h.seams, {
    ...BASE,
    runtimeExecutable: "/usr/bin/docker",
  });

  assertEquals(
    h.runtimeCalls.filter((call) => call[0] === "logs"),
    [["logs", "--tail", "200", CONTAINER]],
  );
});

// ---------------------------------------------------------------------------
// A hung runtime
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a hung container exec leaves the guest unavailable and still writes the file", async () => {
  const h = harness({
    files: HAPPY_FILES,
    runtime: (args) =>
      args[0] === "exec" && args[2] === "true"
        ? new Promise<EvidenceInvocation>(() => {})
        : healthyRuntime(args),
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome.ok, true);
  const guest = recordOf(h).evidence.guest;
  const cause =
    "unavailable: container exec did not answer: no answer within 10000ms";
  assertEquals(guest, {
    ps: cause,
    meminfo: cause,
    pressureCpu: cause,
    pressureMemory: cause,
    pressureIo: cause,
  });
});

Deno.test("captureHardKillEvidence - after a failed probe no guest command is exec'd", async () => {
  const h = harness({
    files: HAPPY_FILES,
    runtime: (args) =>
      args[0] === "exec" && args[2] === "true"
        ? new Promise<EvidenceInvocation>(() => {})
        : healthyRuntime(args),
  });

  await captureHardKillEvidence(h.seams, BASE);

  const execCalls = h.runtimeCalls.filter((call) => call[0] === "exec");
  assertEquals(execCalls, [["exec", CONTAINER, "true"]]);
});

Deno.test("captureHardKillEvidence - a probe that exits non-zero marks the guest unavailable", async () => {
  const h = harness({
    files: HAPPY_FILES,
    runtime: (args) =>
      args[0] === "exec"
        ? Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "container stopped\n",
        })
        : healthyRuntime(args),
  });

  await captureHardKillEvidence(h.seams, BASE);

  assertEquals(
    recordOf(h).evidence.guest.ps,
    "unavailable: container exec did not answer: exit 1: container stopped",
  );
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a token in the log tail is absent from the file and masked", async () => {
  const h = harness({
    files: {
      "worker.log": {
        text: `[2026-10-24T01:02:03.456Z] cloning with ${TOKEN}\n`,
        mtimeMs: 1,
      },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assertStringIncludes(text, "***REDACTED***");
});

Deno.test("captureHardKillEvidence - a token in the tool call input is absent from the file and masked", async () => {
  const h = harness({
    files: {
      "agent-vibe-m3k9x2-0a1b2c-2.jsonl": {
        text:
          `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo ${TOKEN}"}}]}}\n`,
        mtimeMs: 1,
      },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assertStringIncludes(recordOf(h).lastToolCall, "***REDACTED***");
});

// ---------------------------------------------------------------------------
// Failed steps
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a listing that rejects is recorded with its cause", async () => {
  const h = harness({
    listLogFiles: () => Promise.reject(new Error("permission denied")),
    runtime: healthyRuntime,
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome.ok, true);
  const record = recordOf(h);
  const cause = `unavailable: could not list ${DIR}: permission denied`;
  assertEquals(record.evidence.workerLogTail, cause);
  assertEquals(record.lastLogLine, cause);
  assertEquals(record.evidence.agentTranscriptTail, cause);
  assertEquals(record.lastToolCall, cause);
  assertEquals(record.runId, "unknown");
  // The other steps still ran and their evidence is still written.
  assertEquals(record.evidence.bootLogs, "boot line 1\nboot line 2");
});

Deno.test("captureHardKillEvidence - no worker log is recorded as unavailable", async () => {
  const h = harness({
    files: {
      "agent-vibe-m3k9x2-0a1b2c-2.jsonl": { text: TRANSCRIPT, mtimeMs: 1 },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const record = recordOf(h);
  assertEquals(
    record.evidence.workerLogTail,
    `unavailable: no worker log in ${DIR}`,
  );
  assertEquals(record.lastLogLine, `unavailable: no worker log in ${DIR}`);
  assertEquals(record.lastLogTimestamp, "unknown");
  // The transcript is still captured.
  assertEquals(record.lastToolCall, 'Bash {"command":"git status"}');
});

Deno.test("captureHardKillEvidence - a read that rejects is recorded with its cause", async () => {
  const h = harness({
    files: HAPPY_FILES,
    readTail: (path) =>
      path.endsWith("worker.log")
        ? Promise.reject(new Error("disk read failed"))
        : Promise.resolve(TRANSCRIPT),
  });

  await captureHardKillEvidence(h.seams, BASE);

  assertEquals(
    recordOf(h).evidence.workerLogTail,
    "unavailable: could not read worker.log: disk read failed",
  );
});

Deno.test("captureHardKillEvidence - boot logs that exit 1 are recorded with the first line of stderr", async () => {
  const h = harness({
    files: HAPPY_FILES,
    runtime: (args) =>
      args[0] === "logs"
        ? Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "Error: no such container\nsecond line\n",
        })
        : healthyRuntime(args),
  });

  await captureHardKillEvidence(h.seams, BASE);

  assertEquals(
    recordOf(h).evidence.bootLogs,
    "unavailable: exit 1: Error: no such container",
  );
});

Deno.test("captureHardKillEvidence - a failing hostname is recorded with its cause and the capture goes on", async () => {
  const h = harness({
    files: HAPPY_FILES,
    hostname: () => {
      throw new Error("no hostname");
    },
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome.ok, true);
  assertEquals(recordOf(h).host, "unavailable: no hostname");
  assertEquals(recordOf(h).runId, RUN_ID);
});

Deno.test("captureHardKillEvidence - a branch that throws names the failure in each field it had not filled", async () => {
  // The last line has no timestamp, so the worker branch falls back to the
  // file's modified time; an invalid time makes that throw after the log
  // fields are filled. The runtime never answers and no timer fires, so the
  // boot logs and guest fields are still waiting when the branch fails.
  const h = harness({
    files: {
      "worker.log": {
        text: "[2026-10-24T01:00:00.000Z] fine\nno stamp here\n",
        mtimeMs: Number.NaN,
      },
    },
    runtime: () => new Promise<EvidenceInvocation>(() => {}),
    firesFor: () => false,
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome, { ok: true, file: FILE });
  const record = recordOf(h);
  const failed = "unavailable: capture step failed: Invalid time value";
  assertEquals(record.evidence.bootLogs, failed);
  assertEquals(record.evidence.guest.ps, failed);
  assertEquals(record.evidence.guest.pressureIo, failed);
  // A field the branch had already filled keeps its value.
  assertEquals(record.lastLogLine, "no stamp here");
});

// ---------------------------------------------------------------------------
// The total cap
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a hung runtime at the total cap leaves its fields not collected but writes the rest", async () => {
  const h = harness({
    files: HAPPY_FILES,
    runtime: () => new Promise<EvidenceInvocation>(() => {}),
    // Only the total cap fires; every step timer stays pending.
    firesFor: (ms) => ms === DEFAULT_TOTAL_CAP_MS,
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome, { ok: true, file: FILE });
  const record = recordOf(h);
  const notCollected =
    `unavailable: not collected before the ${DEFAULT_TOTAL_CAP_MS}ms capture cap ended`;
  assertEquals(record.evidence.bootLogs, notCollected);
  assertEquals(record.evidence.guest.ps, notCollected);
  assertEquals(record.evidence.guest.pressureIo, notCollected);
  // The file-based evidence was read in the meantime, so it is kept.
  assertEquals(
    record.evidence.workerLogTail,
    HAPPY_RECORD.evidence.workerLogTail,
  );
  assertEquals(record.lastToolCall, 'Bash {"command":"git status"}');
  assertEquals(record.runId, RUN_ID);
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a write failure is returned, never thrown", async () => {
  const h = harness({
    files: HAPPY_FILES,
    writeFile: () => Promise.reject(new Error("disk full")),
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome, {
    ok: false,
    error: `could not write ${FILE}: disk full`,
  });
});

Deno.test("captureHardKillEvidence - a write that never answers is returned as a failure", async () => {
  const h = harness({
    files: HAPPY_FILES,
    writeFile: () => new Promise<void>(() => {}),
    // Only the step timer for the write fires; the total cap stays pending.
    firesFor: (ms) => ms === 15_000,
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome, {
    ok: false,
    error: `could not write ${FILE}: no answer within 15000ms`,
  });
});

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

Deno.test("tailLines - keeps the last lines and drops the trailing empty line", () => {
  assertEquals(tailLines("a\nb\nc\n", 2), "b\nc");
  assertEquals(tailLines("a\nb", 5), "a\nb");
  assertEquals(tailLines("", 5), "");
});

Deno.test("tailLines - caps each long line and marks the cut", () => {
  const capped = tailLines("y".repeat(MAX_LINE_CHARS + 500), 5);
  assertEquals(capped.length, MAX_LINE_CHARS + 1);
  assert(capped.endsWith("…"));
});

Deno.test("bootLogsArgs - Apple container gets --boot, Docker and Podman get the tail", () => {
  assertEquals(bootLogsArgs("container", "c1"), ["logs", "--boot", "c1"]);
  assertEquals(
    bootLogsArgs("/usr/local/bin/Container.exe", "c1"),
    ["logs", "--boot", "c1"],
  );
  assertEquals(bootLogsArgs("/usr/bin/docker", "c1"), [
    "logs",
    "--tail",
    "200",
    "c1",
  ]);
  assertEquals(bootLogsArgs("podman", "c1"), ["logs", "--tail", "200", "c1"]);
});

Deno.test("lastToolCall - skips a cut-off first line of a byte tail", () => {
  const cut = 'k"},"id":"x"}]}}\n' +
    '{"message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a"}}]}}';
  assertEquals(lastToolCall(cut), 'Read {"file_path":"/a"}');
});

Deno.test("lastToolCall - a line that only mentions tool_use in text is not a tool call", () => {
  assertEquals(
    lastToolCall(
      '{"message":{"content":[{"type":"text","text":"tool_use is a word"}]}}',
    ),
    null,
  );
});

Deno.test("lastToolCall - caps a long input and marks the cut", () => {
  const long = '{"message":{"content":[{"type":"tool_use","name":"Bash",' +
    '"input":{"command":"' + "x".repeat(1_000) + '"}}]}}';
  const result = lastToolCall(long);
  assert(result !== null);
  assertEquals(result.length, MAX_TOOL_CALL_CHARS + 1);
  assert(result.endsWith("…"));
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

Deno.test("captureHardKillEvidence - a long run of characters after vibe- returns promptly with no run id", async () => {
  const h = harness({
    files: {
      "worker.log": {
        text: `[2026-10-24T01:02:03.456Z] vibe-${"a".repeat(200_000)}\n`,
        mtimeMs: 1,
      },
    },
  });

  const outcome = await captureHardKillEvidence(h.seams, BASE);

  assertEquals(outcome.ok, true);
  assertEquals(recordOf(h).runId, "unknown");
});

// ---------------------------------------------------------------------------
// Redact before you truncate (SECURITY.md)
// ---------------------------------------------------------------------------

/**
 * Whether any run of `length` consecutive characters of `secret` is in `text`.
 * A cut can keep the head or the tail of a token, so every window is checked.
 */
function leaksFragment(text: string, secret: string, length: number): boolean {
  for (let start = 0; start + length <= secret.length; start++) {
    if (text.includes(secret.slice(start, start + length))) return true;
  }
  return false;
}

Deno.test("captureHardKillEvidence - a token straddling the line cap leaves no fragment in the file", async () => {
  // 1975 filler characters and a space put the token's first 24 characters
  // inside the 2000-character line cap: an un-redacted cut would keep them.
  const h = harness({
    files: {
      "worker.log": {
        text: `${"x".repeat(1975)} ${TOKEN}\n`,
        mtimeMs: 1,
      },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assert(
    !leaksFragment(text, TOKEN, 20),
    "no 20-character fragment of the token may reach the file",
  );
  assertStringIncludes(text, "***REDACTED***");
});

Deno.test("captureHardKillEvidence - a token straddling the field cap leaves no fragment in the file", async () => {
  // 200 lines of 400 characters: the joined tail is 80,199 characters, so the
  // 64 KiB field cap starts at 14,663. The token starts 16 characters before
  // that point, so 24 of its characters would survive an un-redacted cut.
  const lineCount = 200;
  const lineLength = 400;
  const joinedLength = lineCount * lineLength + (lineCount - 1);
  const tokenStart = joinedLength - MAX_FIELD_CHARS - 16;
  const tokenLine = Math.floor(tokenStart / (lineLength + 1));
  const offset = tokenStart - tokenLine * (lineLength + 1);
  const lines = Array.from(
    { length: lineCount },
    (_, index) =>
      index === tokenLine
        ? `${"x".repeat(offset)}${TOKEN}${
          "x".repeat(lineLength - offset - TOKEN.length)
        }`
        : "x".repeat(lineLength),
  );
  const h = harness({
    files: {
      "worker.log": { text: `${lines.join("\n")}\n`, mtimeMs: 1 },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assert(
    !leaksFragment(text, TOKEN, 20),
    "no 20-character fragment of the token may reach the file",
  );
  assertStringIncludes(text, "***REDACTED***");
});

Deno.test("captureHardKillEvidence - a token straddling the 500-character tool call cap leaves no fragment in the file", async () => {
  // `Bash {"command":"` is 17 characters, so the token starts at 476 and the
  // 500-character cap keeps 24 of its characters.
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use",' +
    '"id":"t1","name":"Bash","input":{"command":"' +
    `${"x".repeat(458)} ${TOKEN}"}}]}}`;
  const h = harness({
    files: {
      "agent-vibe-m3k9x2-0a1b2c-2.jsonl": { text: `${line}\n`, mtimeMs: 1 },
    },
  });

  await captureHardKillEvidence(h.seams, BASE);

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assert(
    !leaksFragment(text, TOKEN, 20),
    "no 20-character fragment of the token may reach the file",
  );
  assertStringIncludes(recordOf(h).lastToolCall, "***REDACTED***");
});

Deno.test("captureHardKillEvidence - a token in the reason is redacted by the final pass", async () => {
  // The reason is never read from a log, so no raw-text pass sees it; only the
  // final pass over the whole record keeps a secret in it out of the file.
  const h = harness({ files: HAPPY_FILES });

  await captureHardKillEvidence(h.seams, {
    ...BASE,
    reason: `reap requested for ${TOKEN}`,
  });

  const text = h.writes[0]!.text;
  assert(!text.includes(TOKEN), "the raw token must not reach the file");
  assertStringIncludes(text, "***REDACTED***");
});
