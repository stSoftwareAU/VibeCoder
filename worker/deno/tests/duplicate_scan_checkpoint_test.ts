import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openDuplicateScanJournal } from "../lib/duplicate_scan_checkpoint.ts";
import {
  parseReviewVerdicts,
  reviewDuplicateCandidates,
} from "../lib/duplicate_scan_review.ts";

function github() {
  const comments: { author: string; body: string }[] = [];
  const edits: string[][] = [];
  async function gh(args: string[]) {
    if (args.includes("--slurp")) return JSON.stringify(comments);
    if (args.includes("POST")) {
      comments.push({ author: "fleet", body: args.at(-1)!.slice(5) });
      return "";
    }
    if (args.includes("view")) {
      return JSON.stringify({
        labels: [{ name: "top-priority" }, { name: "bug" }],
      });
    }
    edits.push(args);
    return "";
  }
  return {
    open: () => openDuplicateScanJournal("acme/widget", 17, ["fleet"], gh),
    comments,
    edits,
  };
}

Deno.test("one retry across hosts, then park only the discovery label", async () => {
  const db = github();
  const stage = "checkout and heartbeat";
  const first = await db.open();
  await first.begin(stage);
  db.comments.push({ ...db.comments[0]!, author: "outsider" });
  await (await db.open()).begin(stage);
  await assertRejects(
    async () => (await db.open()).begin(stage),
    Error,
    "Inspect the worker logs",
  );
  assertEquals(db.edits, [[
    "issue",
    "edit",
    "17",
    "--repo",
    "acme/widget",
    "--add-label",
    "needs-human",
    "--remove-label",
    "top-priority",
  ]]);
});

Deno.test("retry resumes after the completed batch and invalidates verdicts on a different commit", async () => {
  const db = github();
  const blocks = Array.from(
    { length: 6 },
    (_, i) => ({ lineCount: i + 5, sites: [] }),
  );
  const calls: string[] = [];
  const run = (output: string) => (options: { prompt: string }) => {
    calls.push(options.prompt);
    return Promise.resolve({
      ok: true as const,
      value: { output, timedOut: false, exitCode: 0 },
    });
  };
  const first = await db.open();
  await assertRejects(
    () =>
      reviewDuplicateCandidates(
        blocks,
        "rev1",
        "/repo",
        first,
        run("[true,false,false,true,false]"),
      ),
    Error,
    "incomplete",
  );
  assertEquals(calls.length, 2);
  const resumed = await reviewDuplicateCandidates(
    blocks,
    "rev1",
    "/repo",
    await db.open(),
    run("[true]"),
  );
  assertEquals(resumed, [blocks[0]!, blocks[3]!, blocks[5]!]);
  assertEquals(calls.length, 3);
  const next = await db.open();
  assertEquals(next.completed("rev2/review 1-5"), undefined);
  assertThrows(() => parseReviewVerdicts("[0]", 1), Error, "incomplete");
});

Deno.test("the detector and reviewer receive the checkout even with duplicate code in a sibling", async () => {
  const { createDuplicatedKnowledgeTemplate } = await import(
    "../lib/idle_task_templates/duplicated_knowledge_template.ts"
  );
  const { findDuplicateBlocks } = await import(
    "../lib/duplicate_block_scanner.ts"
  );
  const parent = await Deno.makeTempDir();
  try {
    for (const dir of ["widget", "sibling"]) {
      await Deno.mkdir(parent + "/" + dir);
      await Deno.writeTextFile(
        parent + "/" + dir + "/calc.ts",
        Array.from({ length: 8 }, (_, i) => `const n${i} = ${i};`).join("\n"),
      );
    }
    assertEquals((await findDuplicateBlocks({ workDir: parent })).length, 1);
    let cwd = "";
    const template = createDuplicatedKnowledgeTemplate({
      ghCommandFn: async () => "[]",
      ensureLabelFn: async () => ({ ok: true, value: undefined }),
      dedupAuthors: { fleetAuthors: ["fleet"] },
      runScanFn: async (opts) => {
        cwd = opts.workDir;
        assertEquals(await findDuplicateBlocks({ workDir: cwd }), []);
        return { ok: true, value: true };
      },
    });
    const result = await template.runTask({
      repo: "acme/widget",
      workDir: parent,
      idleTaskIssueNumber: 17,
    });
    assertEquals(result.ok, true);
    assertEquals(cwd, parent + "/widget");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("two recovery observers of one assignment count once, and a new checkpoint clears the streak", async () => {
  const db = github();
  await (await db.open()).recover(41);
  await (await db.open()).recover(41);
  assertEquals(db.edits.length, 0);
  await (await db.open()).begin("checkout and heartbeat");
  await (await db.open()).recover(42);
  assertEquals(db.edits.length, 0);
  await (await db.open()).recover(43);
  assertEquals(db.edits.length, 1);
});
