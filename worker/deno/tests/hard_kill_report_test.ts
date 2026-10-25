/**
 * Tests for reporting hard-killed runs on the next worker start (Issue #4254,
 * piece A). Every filing test asserts against a recorded fake-gh call log and
 * an in-memory filesystem, so no test touches GitHub or the host's log
 * directory.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import type { HardKillEvidence } from "../lib/hard_kill_evidence.ts";
import { HARD_KILL_EVIDENCE_VERSION } from "../lib/hard_kill_evidence.ts";
import {
  fileHardKillIssue,
  formatHardKillBody,
  formatHardKillTitle,
  HARD_KILL_FAILURE_CLASS,
  type HardKillSeams,
  hardKillSignature,
  hardKillSource,
  hardKillTerminalRun,
  parseHardKillEvidence,
  reportPendingHardKills,
} from "../lib/hard_kill_report.ts";
import {
  formatRunFailureMarker,
  parseRunFailureMarker,
  RUN_FAILURE_FAMILY_ID,
  RUN_FAILURE_TARGET_REPO,
} from "../lib/run_failure_issue.ts";
import {
  buildIssueRunCallbackContext,
  type CallbackContextSeams,
  type CallbackIdentity,
  callbackOutcomeFromRun,
} from "../lib/run_callback_context.ts";
import {
  buildCallbackContextDocument,
  CALLBACK_SCHEMA_VERSION,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import {
  getFleetTelemetry,
  recordOutcome,
  resetFleetTelemetry,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import type { SelfDiagnosticFiling } from "../lib/self_diagnostic_attestation.ts";

/** The fleet account the fixtures file as; every call states the fleet. */
const FLEET_LOGIN = "vibe-coder-bot";
const FLEET: readonly string[] = [FLEET_LOGIN];
const DIR = "/var/log/vibe";
/** 2026-10-25T01:30:00Z, the evidence's capture time, in epoch seconds. */
const NOW = Date.parse("2026-10-25T01:30:00.000Z") / 1000;
/** A secret-shaped GitHub token (`ghp_` + 36 base62); must never be filed. */
const TOKEN = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const LAST_LOG_LINE =
  "[2026-10-25 01:27:18Z] INFO: [s1 stSoftwareAU/VibeCoder#4254] [phase] execute (stSoftwareAU/VibeCoder#4254): still running · 1m0s elapsed host=s1";

/** A valid evidence file; `over` and `ev` override fields for one test. */
function makeEvidence(
  over: Partial<Omit<HardKillEvidence, "evidence">> = {},
  ev: Partial<HardKillEvidence["evidence"]> = {},
): HardKillEvidence {
  const base: HardKillEvidence = {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: "2026-10-25T01:30:00.000Z",
    host: "s1",
    container: "vibe-s1-4254",
    runId: "run-abc123",
    trigger: "watchdog",
    reason: "container wedged for 10m with no log progress",
    lastLogLine: LAST_LOG_LINE,
    lastLogTimestamp: "2026-10-25 01:27:18Z",
    lastToolCall: "Bash: deno task test:unit",
    evidence: {
      workerLogTail:
        `[2026-10-25 01:26:18Z] INFO: [s1 stSoftwareAU/VibeCoder#4254] [phase] setup (stSoftwareAU/VibeCoder#4254): ok\n${LAST_LOG_LINE}`,
      agentTranscriptTail: `tool call Bash, token ${TOKEN}`,
      bootLogs: "boot ok",
      guest: {
        ps: "PID CMD\n1 init",
        meminfo: "MemTotal: 1024 kB",
        pressureCpu: "some avg10=0.00",
        pressureMemory: "some avg10=99.00",
        pressureIo: "some avg10=0.00",
      },
    },
  };
  return { ...base, ...over, evidence: { ...base.evidence, ...ev } };
}

function json(evidence: unknown): string {
  return JSON.stringify(evidence);
}

function evidenceName(container: string, epoch: number): string {
  return `hard-kill-${container}-${epoch}.json`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function argAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1]!;
}

interface SeedIssue {
  number: number;
  body: string;
  author?: string;
}

interface SeedComment {
  id: number;
  body: string;
  author?: string;
}

/**
 * A fake gh: open issues and their comments live in memory, answering the
 * calls the production code makes the way the real gh does. `failVerb` makes
 * one verb reject with `failMessage`.
 */
function fakeGh(
  opts: {
    issues?: SeedIssue[];
    comments?: SeedComment[];
    failVerb?: "list" | "create";
    failMessage?: string;
  } = {},
) {
  const calls: string[][] = [];
  const issues = (opts.issues ?? []).map((i) => ({
    ...i,
    author: i.author ?? FLEET_LOGIN,
  }));
  const comments = (opts.comments ?? []).map((c) => ({
    ...c,
    author: c.author ?? FLEET_LOGIN,
  }));
  const creates: string[][] = [];
  const commentCalls: string[][] = [];
  const patches: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const isList = args[0] === "issue" && args[1] === "list";
    const isCreate = args[0] === "issue" && args[1] === "create";
    const isComment = args[0] === "issue" && args[1] === "comment";
    const isPatch = args[0] === "api" && args.includes("PATCH");
    if (isList && opts.failVerb === "list") {
      return Promise.reject(new Error(opts.failMessage ?? "gh: HTTP 500"));
    }
    if (isCreate && opts.failVerb === "create") {
      return Promise.reject(new Error(opts.failMessage ?? "gh: HTTP 500"));
    }
    if (isList) {
      return Promise.resolve(
        JSON.stringify(
          issues.map((i) => ({
            number: i.number,
            body: i.body,
            author: { login: i.author },
          })),
        ),
      );
    }
    if (isCreate) {
      creates.push(args);
      const n = 9000 + creates.length;
      issues.push({
        number: n,
        body: argAfter(args, "--body"),
        author: FLEET_LOGIN,
      });
      return Promise.resolve(
        `https://github.com/${RUN_FAILURE_TARGET_REPO}/issues/${n}\n`,
      );
    }
    if (isComment) {
      commentCalls.push(args);
      comments.push({
        id: 500 + commentCalls.length,
        body: argAfter(args, "--body"),
        author: FLEET_LOGIN,
      });
      return Promise.resolve("");
    }
    if (isPatch) {
      patches.push(args);
      const id = parseInt(args[3]!.split("/").pop()!, 10);
      const target = comments.find((c) => c.id === id);
      if (target) target.body = args[5]!.slice("body=".length);
      return Promise.resolve("");
    }
    // The follow-up lookup: the comment list the production --jq renders.
    return Promise.resolve(
      JSON.stringify(
        comments.map((c) => ({ id: c.id, body: c.body, author: c.author })),
      ),
    );
  };
  return { ghFn, calls, creates, commentCalls, patches };
}

type FakeGh = ReturnType<typeof fakeGh>;

/** An in-memory evidence directory; `removeFails` names files that refuse removal. */
function fakeFs(
  files: Record<string, string>,
  opts: { removeFails?: string[]; listError?: unknown } = {},
) {
  const store = new Map<string, string>(Object.entries(files));
  const seams: HardKillSeams = {
    listEvidenceFiles: () =>
      opts.listError !== undefined
        ? Promise.reject(opts.listError)
        : Promise.resolve([...store.keys()]),
    readTextFile: (path) => {
      const text = store.get(baseName(path));
      return text === undefined
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(text);
    },
    removeFile: (path) => {
      const name = baseName(path);
      if (opts.removeFails?.includes(name)) {
        return Promise.reject(new Error("EBUSY: resource busy"));
      }
      store.delete(name);
      return Promise.resolve();
    },
  };
  return { seams, store };
}

type FakeFs = ReturnType<typeof fakeFs>;

/** Run one pass of the reporter against the fakes, recording every effect. */
async function report(
  fs: FakeFs,
  gh: FakeGh,
  extra: Partial<Parameters<typeof reportPendingHardKills>[0]> = {},
) {
  const runs: TerminalIssueRun[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const recordings: SelfDiagnosticFiling[] = [];
  const counter = { failures: 0 };
  const summary = await reportPendingHardKills({
    evidenceDir: DIR,
    ghFn: gh.ghFn,
    seams: fs.seams,
    runFailureCallback: (run) => {
      runs.push(run);
      return Promise.resolve();
    },
    countFailure: () => {
      counter.failures++;
    },
    nowSeconds: NOW,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    fleetAuthors: FLEET,
    recordFiling: (f) => {
      recordings.push(f);
      return Promise.resolve(true);
    },
    ...extra,
  });
  return { summary, runs, logs, errors, recordings, counter };
}

// ---------------------------------------------------------------------------
// Acceptance criteria: filing, dedup, callback, count, retry, payload.
// ---------------------------------------------------------------------------

Deno.test("AC1: one evidence file files exactly one bug issue with the facts and no secret", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
  });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(r.summary, { found: 1, reported: 1, kept: 0 });
  assertEquals(gh.creates.length, 1);
  const args = gh.creates[0]!;
  assertEquals(args.filter((a) => a === "--label").length, 1);
  assertEquals(argAfter(args, "--label"), "bug");
  const body = argAfter(args, "--body");
  assertEquals(parseRunFailureMarker(body), "hard-kill-watchdog-execute");
  for (
    const needle of [
      "**Host:** `s1`",
      "**Container:** `vibe-s1-4254`",
      "**Run id:** `run-abc123`",
      "**Handler:** `watchdog`",
      "**Phase:** `execute`",
      `**Last log line:** \`${"[2026-10-25 01:27:18Z] INFO: [s1 stSoftwareAU/VibeCoder#4254] [phase] execute (stSoftwareAU/VibeCoder#4254): still running · 1m0s elapsed host=s1"}\``,
      "**Last log time:** 2026-10-25 01:27:18Z",
      "**Last tool call:** Bash: deno task test:unit",
      "**Source:** stSoftwareAU/VibeCoder#4254",
      "### Worker log tail",
    ]
  ) {
    assertStringIncludes(body, needle);
  }
  assertFalse(body.includes("ghp_"), "the token prefix must be redacted");
  assertFalse(body.includes("a1B2c3D4e5F6"), "the token body must be redacted");

  assertEquals(r.runs.length, 1);
  assertEquals(r.runs[0]!.runId, "run-abc123");
  assertEquals(
    callbackOutcomeFromRun(r.runs[0]!)?.failureClass,
    HARD_KILL_FAILURE_CLASS,
  );
  assertEquals(r.counter.failures, 1);
  assertEquals(fs.store.size, 0, "the reported file is removed");
  assertEquals(r.recordings.length, 1);
  assertEquals(r.recordings[0]!.familyId, RUN_FAILURE_FAMILY_ID);
});

Deno.test("AC2: a repeat signature comments on the open issue and never files a second", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
    [evidenceName("vibe-s1-4255", 1761355900)]: json(
      makeEvidence({ container: "vibe-s1-4255" }),
    ),
  });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(gh.creates.length, 1, "exactly one issue create");
  assertEquals(gh.commentCalls.length, 1, "the first repeat comments");
  assertEquals(gh.commentCalls[0]![2], "9001", "on the filed issue");
  assertEquals(r.summary, { found: 2, reported: 2, kept: 0 });
  assertEquals(r.runs.length, 2);
  assertEquals(r.counter.failures, 2);
});

Deno.test("AC2: a further repeat in the window updates the follow-up in place", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
    [evidenceName("vibe-s1-4255", 1761355900)]: json(
      makeEvidence({ container: "vibe-s1-4255" }),
    ),
    [evidenceName("vibe-s1-4256", 1761356000)]: json(
      makeEvidence({ container: "vibe-s1-4256" }),
    ),
  });
  const gh = fakeGh();
  await report(fs, gh);

  assertEquals(gh.creates.length, 1);
  assertEquals(gh.commentCalls.length, 1);
  assertEquals(gh.patches.length, 1, "the third kill updates the follow-up");
});

Deno.test("AC2: a stranger's marker does not absorb the kill (fleet-author filter)", async () => {
  const gh = fakeGh({
    issues: [{
      number: 42,
      body: formatRunFailureMarker("hard-kill-watchdog-execute") + "\n",
      author: "stranger",
    }],
  });
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
  });
  const r = await report(fs, gh);

  assertEquals(gh.creates.length, 1, "the kill is filed, not absorbed");
  assertEquals(gh.commentCalls.length, 0);
  assertEquals(r.summary.reported, 1);
});

Deno.test("AC2: a different signature files a new issue", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
    [evidenceName("vibe-s1-4255", 1761355900)]: json(
      makeEvidence({ container: "vibe-s1-4255", trigger: "pre_launch" }),
    ),
  });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(gh.creates.length, 2, "a second signature is a second issue");
  assertEquals(gh.commentCalls.length, 0);
  assertEquals(
    parseRunFailureMarker(argAfter(gh.creates[1]!, "--body")),
    "hard-kill-pre-launch-execute",
  );
  assertEquals(r.summary.reported, 2);
});

Deno.test("AC3: the callback fires once per file, with failureClass hard_kill, and the kill is counted once", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
  });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(r.runs.length, 1);
  assertEquals(
    callbackOutcomeFromRun(r.runs[0]!)?.failureClass,
    "hard_kill",
  );
  assertEquals(r.counter.failures, 1);
});

Deno.test("AC3: the real recordOutcome counts the hard kill as one failure", async () => {
  resetFleetTelemetry();
  startFleetTelemetry();
  try {
    const fs = fakeFs({
      [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
    });
    const gh = fakeGh();
    await reportPendingHardKills({
      evidenceDir: DIR,
      ghFn: gh.ghFn,
      seams: fs.seams,
      runFailureCallback: () => Promise.resolve(),
      countFailure: () => recordOutcome("failure", HARD_KILL_FAILURE_CLASS),
      nowSeconds: NOW,
      fleetAuthors: FLEET,
      recordFiling: () => Promise.resolve(true),
    });
    assertEquals(getFleetTelemetry().failures, 1);
  } finally {
    resetFleetTelemetry();
  }
});

Deno.test("AC4: a failing search keeps the file, fires nothing, counts nothing, and logs the gh cause", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const fs = fakeFs({ [name]: json(makeEvidence()) });
  const gh = fakeGh({
    failVerb: "list",
    failMessage: "gh: HTTP 502 Bad Gateway",
  });
  const r = await report(fs, gh);

  assertEquals(r.summary, { found: 1, reported: 0, kept: 1 });
  assert(fs.store.has(name), "the file is kept");
  assertEquals(r.runs.length, 0, "no callback");
  assertEquals(r.counter.failures, 0, "not counted");
  assert(
    r.errors.some((e) =>
      e.includes(name) && e.includes("HTTP 502 Bad Gateway")
    ),
    `logError names the file and the gh cause: ${r.errors.join(" | ")}`,
  );
});

Deno.test("AC4: a failing create keeps the file, fires nothing, and logs the gh cause", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const fs = fakeFs({ [name]: json(makeEvidence()) });
  const gh = fakeGh({
    failVerb: "create",
    failMessage: "gh: HTTP 502 Bad Gateway",
  });
  const r = await report(fs, gh);

  assertEquals(r.summary, { found: 1, reported: 0, kept: 1 });
  assert(fs.store.has(name));
  assertEquals(r.runs.length, 0);
  assertEquals(r.counter.failures, 0);
  assert(r.errors.some((e) => e.includes("HTTP 502 Bad Gateway")));
});

Deno.test("AC4: the failure cause is the gh first line, not a wrapper boilerplate", async () => {
  const gh = fakeGh({
    failVerb: "create",
    failMessage: "gh: HTTP 502 Bad Gateway\nsecond line of detail",
  });
  const result = await fileHardKillIssue({
    evidence: makeEvidence(),
    ghFn: gh.ghFn,
    nowSeconds: NOW,
    fleetAuthors: FLEET,
    recordFiling: () => Promise.resolve(true),
  });
  assertEquals(result, { action: "failed", cause: "gh: HTTP 502 Bad Gateway" });
});

Deno.test("AC4: a kept file is reported once a healthy gh follows (retry once)", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const fs = fakeFs({ [name]: json(makeEvidence()) });
  const broken = await report(
    fs,
    fakeGh({ failVerb: "list", failMessage: "gh: HTTP 502 Bad Gateway" }),
  );
  assertEquals(broken.summary.kept, 1);

  const healthy = fakeGh();
  const r = await report(fs, healthy);
  assertEquals(r.summary, { found: 1, reported: 1, kept: 0 });
  assertEquals(healthy.creates.length, 1, "filed once, on the retry");
  assertEquals(r.runs.length, 1);
  assertEquals(r.counter.failures, 1);
  assertEquals(fs.store.size, 0);
});

Deno.test("AC4: a malformed file is kept and logged with the failing field", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const fs = fakeFs({ [name]: "{not json" });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(r.summary, { found: 1, reported: 0, kept: 1 });
  assert(fs.store.has(name));
  assertEquals(gh.calls.length, 0, "a malformed file never reaches gh");
  assert(r.errors.some((e) => e.includes(name) && e.includes("not JSON")));
});

Deno.test("AC4: a file missing a field is kept and the log names the field", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const missing = JSON.parse(json(makeEvidence())) as Record<string, unknown>;
  delete missing.container;
  const fs = fakeFs({ [name]: json(missing) });
  const gh = fakeGh();
  const r = await report(fs, gh);

  assertEquals(r.summary, { found: 1, reported: 0, kept: 1 });
  assert(fs.store.has(name));
  assert(r.errors.some((e) => e.includes('"container"')), r.errors.join(" | "));
  assertEquals(gh.calls.length, 0);
});

Deno.test("AC4: a file with a wrongly typed field is kept and the log names the field", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const wrong = JSON.parse(json(makeEvidence())) as Record<string, unknown>;
  wrong.lastToolCall = 5;
  const fs = fakeFs({ [name]: json(wrong) });
  const r = await report(fs, fakeGh());

  assertEquals(r.summary.kept, 1);
  assert(r.errors.some((e) => e.includes('"lastToolCall"')));
});

Deno.test("AC4: a removal failure is logged loudly, the file stays, and the kill still counts", async () => {
  const name = evidenceName("vibe-s1-4254", 1761355800);
  const fs = fakeFs({ [name]: json(makeEvidence()) }, { removeFails: [name] });
  const r = await report(fs, fakeGh());

  assertEquals(r.summary, { found: 1, reported: 1, kept: 1 });
  assert(fs.store.has(name));
  assertEquals(r.counter.failures, 1);
  assert(
    r.errors.some((e) =>
      e.includes("could not be removed") && e.includes("may be reported again")
    ),
  );
});

Deno.test("AC4: a throwing callback is logged and the kill still counts", async () => {
  const fs = fakeFs({
    [evidenceName("vibe-s1-4254", 1761355800)]: json(makeEvidence()),
  });
  const r = await report(fs, fakeGh(), {
    runFailureCallback: () => Promise.reject(new Error("callback boom")),
  });
  assert(r.errors.some((e) => e.includes("callback boom")));
  assertEquals(r.counter.failures, 1);
  assertEquals(r.summary.reported, 1);
});

Deno.test("AC4: a missing evidence directory reports nothing and logs nothing", async () => {
  const fs = fakeFs({}, { listError: new Deno.errors.NotFound(DIR) });
  const r = await report(fs, fakeGh());
  assertEquals(r.summary, { found: 0, reported: 0, kept: 0 });
  assertEquals(r.errors, []);
});

Deno.test("AC4: an unreadable evidence directory is logged, not thrown", async () => {
  const fs = fakeFs({}, { listError: new Error("EACCES: permission denied") });
  const r = await report(fs, fakeGh());
  assertEquals(r.summary, { found: 0, reported: 0, kept: 0 });
  assert(r.errors.some((e) => e.includes("EACCES")));
});

// ---------------------------------------------------------------------------
// AC5: the callback document is the ordinary one plus the hard-kill fields.
// ---------------------------------------------------------------------------

Deno.test("AC5: a hard-kill callback document keeps every ordinary key with an identical value", () => {
  const ev = makeEvidence();
  const hard = hardKillTerminalRun(ev, hardKillSignature(ev));
  const ordinary: TerminalIssueRun = {
    repo: hard.repo,
    issueNumber: hard.issueNumber,
    result: "failure",
    startedAtEpochMs: hard.startedAtEpochMs,
    finishedAtEpochMs: hard.finishedAtEpochMs,
    outcome: {
      kind: "no_pr",
      category: "unknown",
      phase: "execute",
      elapsedSeconds: 0,
      message: "the agent stopped",
      classification: {
        fixability: "not_code_fixable",
        failureClass: "agent-refused",
        rationale: "the agent refused the task",
      },
    },
    phase: "execute",
  };
  const identity: CallbackIdentity = {
    runId: ev.runId,
    host: ev.host,
    provider: "claude",
    sessionId: "sess-1",
  };
  const seams: CallbackContextSeams = {
    exists: () => false,
    transcriptEnabled: () => false,
    buildFacts: () => ({ version: "1.0.0", commit: "abc123" }),
  };
  const hardDoc = buildCallbackContextDocument(
    buildIssueRunCallbackContext(hard, identity, seams),
    "always",
  );
  const ordDoc = buildCallbackContextDocument(
    buildIssueRunCallbackContext(ordinary, identity, seams),
    "always",
  );

  // Only these outcome keys may differ from the ordinary document.
  const mayDiffer = new Set(["failureClass", "phase", "category"]);
  for (const [key, value] of Object.entries(ordDoc)) {
    if (key === "outcome") {
      const ord = value as Record<string, unknown>;
      const hd = hardDoc.outcome as Record<string, unknown>;
      for (const [k, v] of Object.entries(ord)) {
        if (mayDiffer.has(k)) continue;
        assertEquals(hd[k], v, `outcome.${k}`);
      }
      continue;
    }
    assertEquals(hardDoc[key], value, key);
  }
  assertEquals(hardDoc.schemaVersion, CALLBACK_SCHEMA_VERSION);
  assertEquals(hardDoc.runId, ev.runId);
  assertEquals(
    (hardDoc.outcome as { failureClass?: string }).failureClass,
    "hard_kill",
  );
});

// ---------------------------------------------------------------------------
// Parsing, signature, source, body and run-record unit tests.
// ---------------------------------------------------------------------------

Deno.test("parseHardKillEvidence round-trips a valid file", () => {
  const ev = makeEvidence();
  assertEquals(parseHardKillEvidence(json(ev)), ev);
});

Deno.test("parseHardKillEvidence rejects a wrong version, naming it", () => {
  const wrong = JSON.parse(json(makeEvidence())) as Record<string, unknown>;
  wrong.version = 2;
  assertThrowsWith(() => parseHardKillEvidence(json(wrong)), "version 2");
});

Deno.test("parseHardKillEvidence rejects non-JSON and non-object input", () => {
  assertThrowsWith(() => parseHardKillEvidence("{nope"), "not JSON");
  assertThrowsWith(() => parseHardKillEvidence("[1,2]"), "not a JSON object");
  assertThrowsWith(() => parseHardKillEvidence("null"), "not a JSON object");
});

Deno.test("parseHardKillEvidence names a missing nested field and a bad timestamp", () => {
  const noGuest = JSON.parse(json(makeEvidence())) as {
    evidence: Record<string, unknown>;
  };
  delete noGuest.evidence.guest;
  assertThrowsWith(() => parseHardKillEvidence(json(noGuest)), '"guest"');

  const badTime = JSON.parse(json(makeEvidence())) as Record<string, unknown>;
  badTime.capturedAt = "not a time";
  assertThrowsWith(() => parseHardKillEvidence(json(badTime)), "capturedAt");
});

Deno.test("phase comes from [phase], phase=, and [agent-progress] in turn", () => {
  const cases: [string, string][] = [
    [
      "INFO: [s1 x/y#1] [phase] execute (x/y#1): still running",
      "execute",
    ],
    [
      "INFO: [s1 x/y#1] still running phase=merge_conflict host=s1",
      "merge-conflict",
    ],
    ["[agent-progress] merge_conflict: 5m2s elapsed", "merge-conflict"],
  ];
  for (const [line, phase] of cases) {
    const sig = hardKillSignature(
      makeEvidence({ lastLogLine: line }, { workerLogTail: "" }),
    );
    assertEquals(sig.phase, phase, line);
  }
});

Deno.test("phase is taken from the log tail, last line first, and the last match wins", () => {
  const ev = makeEvidence({ lastLogLine: "no phase here" }, {
    workerLogTail: "[phase] setup (a)\n[phase] completion (b)\nno phase",
  });
  assertEquals(hardKillSignature(ev).phase, "completion");

  const lastLineWins = makeEvidence({ lastLogLine: "[phase] execute (x)" }, {
    workerLogTail: "[phase] merge_conflict (y)",
  });
  assertEquals(hardKillSignature(lastLineWins).phase, "execute");
});

Deno.test("phase is unknown when no log line names one", () => {
  const ev = makeEvidence({ lastLogLine: "nothing" }, {
    workerLogTail: "also nothing",
  });
  const sig = hardKillSignature(ev);
  assertEquals(sig.phase, "unknown");
  assertEquals(sig.failureClass, "hard-kill-watchdog-unknown");
});

Deno.test("signature parts normalise to a slug, capped at 40, and empty becomes unknown", () => {
  const sig = hardKillSignature(
    makeEvidence({
      trigger: "pre_launch",
      lastLogLine: "[phase] Set_Up-Stage (x)",
    }),
  );
  assertEquals(sig.handler, "pre-launch");
  assertEquals(sig.phase, "set-up-stage");
  assertEquals(sig.failureClass, "hard-kill-pre-launch-set-up-stage");

  const long = hardKillSignature(makeEvidence({
    lastLogLine: `[phase] ${"q".repeat(60)} (x)`,
  }));
  assertEquals(long.phase.length, 40);

  const blank = hardKillSignature(makeEvidence({ trigger: "" }));
  assertEquals(blank.handler, "unknown");
});

Deno.test("the failure class is a valid run-failure marker class", () => {
  const sig = hardKillSignature(makeEvidence());
  assert(/^[a-z0-9-]+$/.test(sig.failureClass));
  assertEquals(
    parseRunFailureMarker(formatRunFailureMarker(sig.failureClass)),
    sig.failureClass,
  );
  assertEquals(
    formatHardKillTitle(sig),
    "Hard kill: container wedged in execute (watchdog)",
  );
});

Deno.test("source is the last owner/repo#N in the last line, then the tail, else unknown", () => {
  assertEquals(
    hardKillSource(makeEvidence()),
    { repo: "stSoftwareAU/VibeCoder", issueNumber: 4254 },
  );
  const fromTail = makeEvidence({ lastLogLine: "no reference" }, {
    workerLogTail: "a owner/alpha#1 b other/beta#22 c",
  });
  assertEquals(hardKillSource(fromTail), {
    repo: "other/beta",
    issueNumber: 22,
  });
  const none = makeEvidence({ lastLogLine: "nothing" }, {
    workerLogTail: "nothing",
  });
  assertEquals(hardKillSource(none), { repo: "unknown", issueNumber: 0 });
});

Deno.test("source regex returns promptly on hostile input (long run then a rejected character)", () => {
  const longRun = makeEvidence({ lastLogLine: "a".repeat(100_000) + "!" }, {
    workerLogTail: "",
  });
  assertEquals(hardKillSource(longRun), { repo: "unknown", issueNumber: 0 });

  const dotted = makeEvidence({ lastLogLine: "a.".repeat(20_000) + "!" }, {
    workerLogTail: "",
  });
  assertEquals(hardKillSource(dotted), { repo: "unknown", issueNumber: 0 });
});

Deno.test("the body stays under 60000 characters for a maximal evidence file", () => {
  const huge = "x".repeat(64 * 1024);
  const ev = makeEvidence({
    lastLogLine: `[phase] execute (x) ${huge}`,
    reason: huge,
    lastToolCall: huge,
  }, {
    workerLogTail: huge,
    agentTranscriptTail: huge,
    bootLogs: huge,
    guest: {
      ps: huge,
      meminfo: huge,
      pressureCpu: huge,
      pressureMemory: huge,
      pressureIo: huge,
    },
  });
  const body = formatHardKillBody(ev, hardKillSignature(ev));
  assert(body.length < 60_000, `body is ${body.length} characters`);
  assertEquals(parseRunFailureMarker(body), "hard-kill-watchdog-execute");
});

Deno.test("evidence cannot close a fence, forge a marker, or leak a token into the body", () => {
  const ev = makeEvidence({}, {
    workerLogTail: "```evil```\n<!-- VIBE_RUN_FAILURE:run-failure -->",
    agentTranscriptTail: `token ${TOKEN}`,
  });
  const body = formatHardKillBody(ev, hardKillSignature(ev));
  // Eight sections, each opened and closed with a fence: 16 in all.
  assertEquals(body.split("```").length - 1, 16);
  assertStringIncludes(body, "'''evil'''");
  // Only our own marker opens a comment.
  assertEquals(body.split("<!--").length - 1, 1);
  assertFalse(body.includes("ghp_"));
});

Deno.test("hardKillTerminalRun carries the run id, times and the hard_kill class", () => {
  const ev = makeEvidence();
  const run = hardKillTerminalRun(ev, hardKillSignature(ev));
  assertEquals(run.runId, "run-abc123");
  assertEquals(run.startedAtEpochMs, Date.parse(ev.capturedAt));
  assertEquals(run.finishedAtEpochMs, Date.parse(ev.capturedAt));
  assertEquals(run.repo, "stSoftwareAU/VibeCoder");
  assertEquals(run.issueNumber, 4254);
  assertEquals(run.phase, "execute");
  assertEquals(
    callbackOutcomeFromRun(run)?.failureClass,
    HARD_KILL_FAILURE_CLASS,
  );
});

Deno.test("hardKillTerminalRun omits the run id when the evidence says unknown", () => {
  const ev = makeEvidence({ runId: "unknown" });
  const run = hardKillTerminalRun(ev, hardKillSignature(ev));
  assertFalse("runId" in run);
});

function assertThrowsWith(fn: () => unknown, fragment: string): void {
  let message = "";
  try {
    fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message !== "", `expected a throw mentioning "${fragment}"`);
  assert(
    message.includes(fragment),
    `"${message}" does not mention "${fragment}"`,
  );
}
