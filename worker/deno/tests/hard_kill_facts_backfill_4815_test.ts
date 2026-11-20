/**
 * Tests for the hard-kill facts backfill (Issue #4815): archived evidence
 * whose public facts were never posted gets ONE fixed-shape comment on the
 * open issue for its signature, then is renamed so it is never posted again.
 * Real temp directories and a fake gh that answers by its input.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { HARD_KILL_EVIDENCE_VERSION } from "../lib/hard_kill_evidence.ts";
import type { HardKillEvidence } from "../lib/hard_kill_evidence.ts";
import {
  backfillArchivedHardKillFacts,
  hardKillFactsMarker,
} from "../lib/hard_kill_facts_backfill.ts";
import {
  factsPostedName,
  HARD_KILL_ARCHIVE_DIR,
  reportPendingHardKills,
} from "../lib/hard_kill_report.ts";
import {
  formatRunFailureMarker,
  RUN_FAILURE_TARGET_REPO,
} from "../lib/run_failure_issue.ts";

const FLEET_LOGIN = "vibe-coder-bot";
const FLEET: readonly string[] = [FLEET_LOGIN];
const OPEN_CLASS = "hard-kill-watchdog-completion";
const OPEN_ISSUE = 4815;
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const ARCHIVED = "hard-kill-vibe-coder-46887-1793830629.json";
const RUN_ID = "vibe-mw2hlf2s-1125d1";

function evidence(
  over: Partial<Omit<HardKillEvidence, "evidence">> = {},
  phase = "completion",
): HardKillEvidence {
  const last =
    `[2026-11-04 21:16:02Z] INFO: [GRQ-3 stSoftwareAU/GRQ-AutoTrader#4972] [phase] ${phase} (stSoftwareAU/GRQ-AutoTrader#4972): still running · 50m0s`;
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: "2026-11-04T22:06:02.000Z",
    host: "grq3",
    container: "vibe-coder-46887",
    runId: RUN_ID,
    trigger: "watchdog",
    reason: "the launcher's 8100s watchdog deadline expired",
    lastLogLine: last,
    lastLogTimestamp: "2026-11-04 21:16:02Z",
    lastToolCall: "Bash: deno task test:unit",
    evidence: {
      workerLogTail:
        `[2026-11-04 21:10:00Z] INFO: Quality gate passed attempt=1 ${TOKEN}\n${last}`,
      agentTranscriptTail: `tool call Bash, token ${TOKEN}`,
      bootLogs: "boot ok",
      guest: {
        ps: "PID CMD\n1 init",
        meminfo: "MemTotal: 1048576 kB\nMemAvailable: 524288 kB",
        pressureCpu: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
        pressureMemory: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
        pressureIo: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
      },
    },
    ...over,
  };
}

/** A fake gh: only the completion class has an open issue. */
function fakeGh(
  opts: {
    failComment?: { value: boolean };
    hideRows?: { value: boolean };
    failList?: { value: boolean };
  } = {},
) {
  const calls: string[][] = [];
  const comments: string[][] = [];
  const created: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      if (opts.failList?.value) {
        return Promise.reject(
          new Error("gh: API rate limit exceeded\nsecond line"),
        );
      }
      const search = args[args.indexOf("--search") + 1]!;
      const open = !opts.hideRows?.value && search.includes(`:${OPEN_CLASS}"`);
      const rows = open
        ? [{
          number: OPEN_ISSUE,
          body: formatRunFailureMarker(OPEN_CLASS),
          author: { login: FLEET_LOGIN },
        }]
        : [];
      return Promise.resolve(JSON.stringify(rows));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      if (opts.failComment?.value) {
        return Promise.reject(new Error("gh: HTTP 502\nsecond line"));
      }
      comments.push(args);
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "create") {
      created.push(args);
      return Promise.resolve(
        `https://github.com/${RUN_FAILURE_TARGET_REPO}/issues/9001\n`,
      );
    }
    return Promise.resolve("[]");
  };
  return { ghFn, calls, comments, created };
}

async function setup(): Promise<{ dir: string; archive: string }> {
  const dir = await Deno.makeTempDir({ prefix: "hk4815-" });
  const archive = `${dir}/${HARD_KILL_ARCHIVE_DIR}`;
  await Deno.mkdir(archive);
  return { dir, archive };
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

function assertNoSecret(calls: string[][]) {
  for (const call of calls) {
    for (const arg of call) assertFalse(arg.includes(TOKEN));
  }
}

Deno.test("backfill posts one facts comment for an archived pre-change file, then never again", async () => {
  const { dir, archive } = await setup();
  try {
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    const gh = fakeGh();
    const warns: string[] = [];
    const run = () =>
      backfillArchivedHardKillFacts({
        evidenceDir: dir,
        ghFn: gh.ghFn,
        fleetAuthors: FLEET,
        logWarn: (m) => warns.push(m),
      });
    assertEquals(await run(), { posted: 1, marked: 0, kept: 0 });
    assertEquals(gh.comments.length, 1);
    const call = gh.comments[0]!;
    assertEquals(call.slice(0, 5), [
      "issue",
      "comment",
      String(OPEN_ISSUE),
      "--repo",
      RUN_FAILURE_TARGET_REPO,
    ]);
    const body = call[call.indexOf("--body") + 1]!;
    assertStringIncludes(body, hardKillFactsMarker(RUN_ID));
    assertStringIncludes(body, "**Phase:** `completion`");
    assertStringIncludes(body, "**Last step logged:** `quality gate`");
    assertStringIncludes(body, "**Guest probe:**");
    assertNoSecret(gh.calls);
    assertEquals(await names(archive), [factsPostedName(ARCHIVED)]);

    assertEquals(await run(), { posted: 0, marked: 0, kept: 0 });
    assertEquals(gh.comments.length, 1);
    assertEquals(warns, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill retries empty and unverifiable searches until the issue is visible", async () => {
  const { dir, archive } = await setup();
  try {
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    const hideRows = { value: true };
    const gh = fakeGh({ hideRows });
    const run = (fleetAuthors: readonly string[]) =>
      backfillArchivedHardKillFacts({
        evidenceDir: dir,
        ghFn: gh.ghFn,
        fleetAuthors,
      });
    assertEquals((await run(FLEET)).kept, 1);
    hideRows.value = false;
    assertEquals((await run([])).kept, 1);
    assertEquals(gh.comments, []);
    assertEquals(await names(archive), [ARCHIVED]);
    assertEquals((await run(FLEET)).posted, 1);
    assertEquals(gh.comments[0]?.[2], String(OPEN_ISSUE));
    assertEquals(await names(archive), [factsPostedName(ARCHIVED)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill keeps the file when the comment fails and posts it next pass", async () => {
  const { dir, archive } = await setup();
  try {
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    const failing = { value: true };
    const gh = fakeGh({ failComment: failing });
    const warns: string[] = [];
    const run = () =>
      backfillArchivedHardKillFacts({
        evidenceDir: dir,
        ghFn: gh.ghFn,
        fleetAuthors: FLEET,
        logWarn: (m) => warns.push(m),
      });
    assertEquals(await run(), { posted: 0, marked: 0, kept: 1 });
    assertEquals(await names(archive), [ARCHIVED]);
    assertEquals(warns.length, 1);
    assertStringIncludes(warns[0]!, "gh: HTTP 502");
    assertFalse(warns[0]!.includes("second line"));

    failing.value = false;
    assertEquals(await run(), { posted: 1, marked: 0, kept: 0 });
    assertEquals(gh.comments.length, 1);
    assertEquals(await names(archive), [factsPostedName(ARCHIVED)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill keeps the file when the issue lookup fails and posts it next pass", async () => {
  const { dir, archive } = await setup();
  try {
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    const failing = { value: true };
    const gh = fakeGh({ failList: failing });
    const warns: string[] = [];
    const run = () =>
      backfillArchivedHardKillFacts({
        evidenceDir: dir,
        ghFn: gh.ghFn,
        fleetAuthors: FLEET,
        logWarn: (m) => warns.push(m),
      });
    assertEquals(await run(), { posted: 0, marked: 0, kept: 1 });
    assertEquals(await names(archive), [ARCHIVED]);
    assertEquals(gh.comments, []);
    assertEquals(warns.length, 1);
    assertStringIncludes(warns[0]!, ARCHIVED);
    assertStringIncludes(warns[0]!, "issue lookup failed");
    assertStringIncludes(warns[0]!, "gh: API rate limit exceeded");
    assertFalse(warns[0]!.includes("second line"));

    failing.value = false;
    assertEquals(await run(), { posted: 1, marked: 0, kept: 0 });
    assertEquals(gh.comments.length, 1);
    assertStringIncludes(
      gh.comments[0]![gh.comments[0]!.indexOf("--body") + 1]!,
      hardKillFactsMarker(RUN_ID),
    );
    assertEquals(await names(archive), [factsPostedName(ARCHIVED)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill keeps a malformed archived file untouched and warns", async () => {
  const { dir, archive } = await setup();
  try {
    const name = "hard-kill-vibe-coder-2-2.json";
    await Deno.writeTextFile(`${archive}/${name}`, "{ not json");
    const gh = fakeGh();
    const warns: string[] = [];
    const result = await backfillArchivedHardKillFacts({
      evidenceDir: dir,
      ghFn: gh.ghFn,
      fleetAuthors: FLEET,
      logWarn: (m) => warns.push(m),
    });
    assertEquals(result, { posted: 0, marked: 0, kept: 1 });
    assertEquals(await names(archive), [name]);
    assertEquals(await Deno.readTextFile(`${archive}/${name}`), "{ not json");
    assertEquals(warns.length, 1);
    assertStringIncludes(warns[0]!, name);
    assertStringIncludes(warns[0]!, "not JSON");
    assertEquals(gh.comments, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a newly reported file is archived as facts-posted and never backfilled", async () => {
  const { dir, archive } = await setup();
  try {
    const name = "hard-kill-vibe-coder-46887-1793830700.json";
    await Deno.writeTextFile(
      `${dir}/${name}`,
      JSON.stringify(evidence({}, "execute")),
    );
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence({}, "execute")),
    );
    const gh = fakeGh({ hideRows: { value: true } });
    const pass = () =>
      reportPendingHardKills({
        evidenceDir: dir,
        ghFn: gh.ghFn,
        runFailureCallback: () => Promise.resolve(),
        countFailure: () => {},
        fleetAuthors: FLEET,
        recordFiling: () => Promise.resolve(true),
        nowSeconds: Date.parse("2026-11-04T22:10:00Z") / 1000,
      });
    assertEquals(await pass(), { found: 1, reported: 1, kept: 0 });
    assertEquals(gh.created.length, 1);
    assertEquals(
      await names(archive),
      [
        factsPostedName(ARCHIVED),
        "hard-kill-vibe-coder-46887-1793830700.facts.json",
      ].sort(),
    );
    assertEquals(await names(dir), [HARD_KILL_ARCHIVE_DIR]);
    assertEquals(gh.comments.map((call) => call[2]), ["9001"]);

    assertEquals(await pass(), { found: 0, reported: 0, kept: 0 });
    assertEquals(gh.comments.map((call) => call[2]), ["9001"]);
    assertEquals(gh.created.length, 1);
    assertNoSecret(gh.calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill through reportPendingHardKills posts an archived file's facts", async () => {
  const { dir, archive } = await setup();
  try {
    await Deno.writeTextFile(
      `${archive}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    const gh = fakeGh();
    const logs: string[] = [];
    await reportPendingHardKills({
      evidenceDir: dir,
      ghFn: gh.ghFn,
      runFailureCallback: () => Promise.resolve(),
      countFailure: () => {},
      fleetAuthors: FLEET,
      log: (m) => logs.push(m),
    });
    assertEquals(gh.comments.length, 1);
    assert(
      logs.includes(
        "hard-kill facts backfill: posted 1, marked 0, kept 0 (Issue #4815)",
      ),
    );
    assertEquals(await names(archive), [factsPostedName(ARCHIVED)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill refuses a symlinked archive directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hk4815-" });
  const elsewhere = await Deno.makeTempDir({ prefix: "hk4815-other-" });
  try {
    await Deno.writeTextFile(
      `${elsewhere}/${ARCHIVED}`,
      JSON.stringify(evidence()),
    );
    await Deno.symlink(elsewhere, `${dir}/${HARD_KILL_ARCHIVE_DIR}`);
    const gh = fakeGh();
    const warns: string[] = [];
    const result = await backfillArchivedHardKillFacts({
      evidenceDir: dir,
      ghFn: gh.ghFn,
      fleetAuthors: FLEET,
      logWarn: (m) => warns.push(m),
    });
    assertEquals(result, { posted: 0, marked: 0, kept: 0 });
    assertEquals(gh.calls, []);
    assertEquals(warns.length, 1);
    assertStringIncludes(warns[0]!, "not a plain directory");
    assertEquals(await names(elsewhere), [ARCHIVED]);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
  }
});
