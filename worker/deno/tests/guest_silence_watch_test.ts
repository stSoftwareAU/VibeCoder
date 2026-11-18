/**
 * Tests for the guest silence watch (Issue #5161).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type {
  EvidenceInvocation,
  EvidenceSeams,
} from "../lib/hard_kill_evidence.ts";
import {
  checkGuestSilence,
  DEFAULT_GUEST_SILENCE_SECONDS,
  GUEST_SILENCE_SECONDS_ENV,
  guestSilenceReason,
  resolveGuestSilenceSeconds,
} from "../lib/guest_silence_watch.ts";

const NOW = 1_800_000_000_000;

function fakeSeams(options: {
  files?: { name: string; mtimeMs: number }[];
  probes?: (call: number) => EvidenceInvocation | Promise<EvidenceInvocation>;
  listThrows?: boolean;
}): { seams: EvidenceSeams; runs: string[][]; lists: string[] } {
  const runs: string[][] = [];
  const lists: string[] = [];
  const seams: EvidenceSeams = {
    runRuntime: (args) => {
      runs.push([...args]);
      return Promise.resolve(
        options.probes?.(runs.length) ??
          { code: 0, stdout: "", stderr: "" },
      );
    },
    listLogFiles: (dir) => {
      lists.push(dir);
      if (options.listThrows) return Promise.reject(new Error("no such dir"));
      return Promise.resolve(options.files ?? []);
    },
    readTail: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
    hostname: () => "test-host",
    timeout: () => ({
      promise: new Promise<void>(() => {}),
      cancel: () => {},
    }),
  };
  return { seams, runs, lists };
}

const SILENT_LOG = [{ name: "worker.log", mtimeMs: NOW - 1200_000 }];
const base = {
  containerName: "vibe-coder-1",
  evidenceDir: "/logs",
  silenceSeconds: 900,
  nowMs: NOW,
};

Deno.test("checkGuestSilence - silent log and both probes failing is wedged", async () => {
  const { seams, runs } = fakeSeams({
    files: SILENT_LOG,
    probes: (call) => ({ code: 1, stdout: "", stderr: `down ${call}` }),
  });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, true);
  assertEquals(verdict.silentSeconds, 1200);
  assertStringIncludes(verdict.detail, "exit 1");
  assertEquals(runs, [
    ["exec", "vibe-coder-1", "true"],
    ["exec", "vibe-coder-1", "true"],
  ]);
  assertEquals(
    guestSilenceReason(verdict.silentSeconds!),
    "the launcher's watchdog found the guest silent for 1200s and not answering",
  );
});

Deno.test("checkGuestSilence - a probe that throws counts as failed", async () => {
  const { seams } = fakeSeams({
    files: SILENT_LOG,
    probes: () => {
      throw new Error("exec hung up");
    },
  });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, true);
  assertStringIncludes(verdict.detail, "exec hung up");
});

Deno.test("checkGuestSilence - the second probe answering is not wedged", async () => {
  const { seams, runs } = fakeSeams({
    files: SILENT_LOG,
    probes: (call) => ({ code: call === 1 ? 1 : 0, stdout: "", stderr: "" }),
  });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, false);
  assertStringIncludes(verdict.detail, "answered");
  assertEquals(runs.length, 2);
});

Deno.test("checkGuestSilence - a log younger than the threshold runs no probe", async () => {
  const { seams, runs } = fakeSeams({
    files: [{ name: "worker.log", mtimeMs: NOW - 60_000 }],
  });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, false);
  assertEquals(verdict.silentSeconds, 60);
  assertEquals(runs.length, 0);
});

Deno.test("checkGuestSilence - no worker log is not wedged", async () => {
  const { seams, runs } = fakeSeams({
    files: [{ name: "other.log", mtimeMs: 0 }],
  });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, false);
  assertEquals(runs.length, 0);
});

Deno.test("checkGuestSilence - a listing failure is not wedged and names the cause", async () => {
  const { seams, runs } = fakeSeams({ listThrows: true });
  const verdict = await checkGuestSilence(seams, base);
  assertEquals(verdict.wedged, false);
  assertStringIncludes(verdict.detail, "no such dir");
  assertEquals(runs.length, 0);
});

Deno.test("checkGuestSilence - a threshold of 0 disables the check without listing", async () => {
  const { seams, runs, lists } = fakeSeams({ files: SILENT_LOG });
  const verdict = await checkGuestSilence(seams, {
    ...base,
    silenceSeconds: 0,
  });
  assertEquals(verdict.wedged, false);
  assertStringIncludes(verdict.detail, "disabled");
  assertEquals(lists.length, 0);
  assertEquals(runs.length, 0);
});

Deno.test("resolveGuestSilenceSeconds - default, disabled, set and invalid values", () => {
  const env = (value: string | undefined) => (name: string) =>
    name === GUEST_SILENCE_SECONDS_ENV ? value : undefined;
  assertEquals(
    resolveGuestSilenceSeconds(env(undefined)),
    DEFAULT_GUEST_SILENCE_SECONDS,
  );
  assertEquals(
    resolveGuestSilenceSeconds(env("")),
    DEFAULT_GUEST_SILENCE_SECONDS,
  );
  assertEquals(resolveGuestSilenceSeconds(env("0")), 0);
  assertEquals(resolveGuestSilenceSeconds(env("1200")), 1200);
  assertEquals(
    resolveGuestSilenceSeconds(env("abc")),
    DEFAULT_GUEST_SILENCE_SECONDS,
  );
  assertEquals(
    resolveGuestSilenceSeconds(env("-5")),
    DEFAULT_GUEST_SILENCE_SECONDS,
  );
});
