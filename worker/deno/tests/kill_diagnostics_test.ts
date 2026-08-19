/**
 * Tests for the kill-time diagnostics (Issue #4382).
 *
 * When the agent is SIGKILLed from outside, the log used to carry only
 * `raw_exit_code=137`. The operator's question is "who was eating the VM
 * at that moment?" — so the runner now captures a bounded process table
 * (top processes by RSS, with the killed agent's own tree marked) and any
 * kernel OOM lines it can read, and carries them into the failure
 * diagnostics.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  captureKillDiagnostics,
  formatMemoryPressureWarning,
  formatProcessTable,
  parseProcessTable,
} from "../lib/kill_diagnostics.ts";

const PS_OUTPUT = `  PID  PPID   RSS     ELAPSED COMMAND
    1     0  3228       27:00 /bin/bash /usr/local/bin/vibe-entrypoint
   20     1 125376      27:00 deno run --frozen worker
 6483     1  3032       01:28 /bin/bash -c source /home/vibe/auto-issue-work/.claude-config/shell-snapshots/snapshot-bash-1.sh
 6485  6483  1660       01:28 timeout 3000 ./quality.sh
 6487  6485 344488       01:28 deno run --frozen --lock=/home/vibe/auto-issue-work/VibeCoder/worker/deno/deno.lock quality
 6521  6487 236880       01:27 /usr/local/bin/deno test --allow-read --allow-env
 7860    20 332228       00:47 /usr/local/bin/claude --model opus --effort high
 7890  7860 97260       00:47 deno run --allow-read mcp
`;

Deno.test("parseProcessTable - reads pid/ppid/rss/elapsed/command from ps output (Issue #4382)", () => {
  const rows = parseProcessTable(PS_OUTPUT);
  assertEquals(rows.length, 8);
  assertEquals(rows[3], {
    pid: 6485,
    ppid: 6483,
    rssKb: 1660,
    elapsed: "01:28",
    command: "timeout 3000 ./quality.sh",
  });
});

Deno.test("formatProcessTable - top by RSS, bounded, with the agent's own tree marked (Issue #4382)", () => {
  const rows = parseProcessTable(PS_OUTPUT);
  const text = formatProcessTable(rows, {
    agentPid: 7860,
    knownDescendants: [6483, 6485, 6487, 6521],
    limit: 5,
    maxCommandChars: 40,
  });
  const lines = text.split("\n");
  assertEquals(lines.length, 5, text);
  // Sorted by RSS descending: the gate's deno run first.
  const first = lines[0] ?? "";
  assert(first.includes("6487"), first);
  assert(first.includes("336 MiB"), first);
  // The agent's own tree is marked so the reader can tell it from a
  // neighbour: the killed agent's orphaned gate and the agent itself.
  assert(first.includes("[agent-tree]"), first);
  const agentLine = lines.find((l) => l.includes("7860"));
  assert(agentLine?.includes("[agent]"), agentLine);
  // Commands are truncated to the budget.
  assert(lines.every((l) => l.length < 120), text);
});

Deno.test("captureKillDiagnostics - assembles ps + dmesg evidence, never throws (Issue #4382)", async () => {
  const text = await captureKillDiagnostics({
    agentPid: 7860,
    knownDescendants: [6483],
    runPs: () => Promise.resolve(PS_OUTPUT),
    readKernelLog: () =>
      Promise.resolve(
        "[12345.678] Out of memory: Killed process 7861 (claude) total-vm:9000000kB, anon-rss:8500000kB\n[1.0] unrelated line\n",
      ),
  });
  assert(text.includes("Top processes by RSS"), text);
  assert(text.includes("6487"), text);
  assert(text.includes("Kernel OOM lines"), text);
  assert(text.includes("Killed process 7861"), text);
  assert(!text.includes("unrelated line"), "only OOM lines are kept");
});

Deno.test("captureKillDiagnostics - a failing ps or dmesg still yields a bounded note (Issue #4382)", async () => {
  const text = await captureKillDiagnostics({
    agentPid: 1,
    knownDescendants: [],
    runPs: () => Promise.reject(new Error("no ps")),
    readKernelLog: () => Promise.reject(new Error("dmesg: permission denied")),
  });
  assert(text.includes("process table unavailable"), text);
  assert(text.length < 400, text);
});

// ---------------------------------------------------------------------------
// Issue #4384 — the cgroup's own memory accounting is the definitive OOM record
// ---------------------------------------------------------------------------

Deno.test("captureKillDiagnostics - names the cgroup memory limit, peak and oom_kill count when readable (Issue #4384)", async () => {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/memory.max": "17179869184\n",
    "/sys/fs/cgroup/memory.current": "1234567890\n",
    "/sys/fs/cgroup/memory.peak": "17100000000\n",
    "/sys/fs/cgroup/memory.events":
      "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\n",
  };
  const text = await captureKillDiagnostics({
    agentPid: 1,
    knownDescendants: [],
    runPs: () => Promise.resolve(PS_OUTPUT),
    readKernelLog: () => Promise.resolve(""),
    readFile: (path) =>
      path in files
        ? Promise.resolve(files[path]!)
        : Promise.reject(new Error("ENOENT")),
  });
  assert(text.includes("Cgroup memory"), text);
  assert(text.includes("max=16.0 GiB"), text);
  assert(text.includes("peak=15.9 GiB"), text);
  assert(text.includes("oom_kill=2"), text);
});

Deno.test("captureKillDiagnostics - no cgroup files (macOS) → one honest line, no failure (Issue #4384)", async () => {
  const text = await captureKillDiagnostics({
    agentPid: 1,
    knownDescendants: [],
    runPs: () => Promise.resolve(PS_OUTPUT),
    readKernelLog: () => Promise.reject(new Error("no dmesg")),
    readFile: () => Promise.reject(new Error("ENOENT")),
  });
  assert(text.includes("Cgroup memory: not readable here"), text);
});

Deno.test("formatMemoryPressureWarning - a bounded pre-kill snapshot names the pressure and the top processes (Issue #4384)", () => {
  const rows = parseProcessTable(PS_OUTPUT);
  const text = formatMemoryPressureWarning({
    reading: {
      level: "high",
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 900 * 1024 ** 2,
    },
    rows,
    agentPid: 7860,
    knownDescendants: [6483],
    limit: 4,
  });
  assert(text.startsWith("Memory pressure high during the agent run"), text);
  assert(text.includes("900 MiB of 16.0 GiB available"), text);
  assert(text.split("\n").length <= 6, text);
  assert(text.includes("[agent]"), text);
});
