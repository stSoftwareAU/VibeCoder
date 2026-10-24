/**
 * Tests for the stateless facts anchor check (Issue #4125).
 *
 * The check is exercised through its real exports. `gitReadAtHead` is tested
 * against a real temporary git repository. Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  anchorKey,
  checkFactsAnchors,
  gitReadAtHead,
  MAX_ANCHOR_FILE_CHARS,
  type ReadAtHead,
} from "../lib/facts_anchor_check.ts";
import {
  MAX_FIELD_CHARS,
  parseSummaryFacts,
  type SummaryFacts,
} from "../lib/summary_facts.ts";
import type { Result } from "../types.ts";

const FACTS_PATH = "facts.json";
const LIB = "worker/deno/lib/foo.ts";

interface Cite {
  path: string;
  line: number;
  anchor?: string;
}

/** Build real, validated facts from citations via parseSummaryFacts. */
function factsFor(cites: Cite[]): SummaryFacts {
  const entries = cites.map((c) => ({
    path: c.path,
    line: c.line,
    ...(c.anchor === undefined ? {} : { anchor: c.anchor }),
    outcome: "does the thing",
    test: "worker/deno/tests/foo_test.ts",
    testName: "foo does the thing",
    flipWentRed: "failed before the fix",
  }));
  const raw = JSON.stringify({
    version: 1,
    branchOutcomes: { noneAdded: false, entries },
  });
  const result = parseSummaryFacts(raw);
  assert(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

/** A reader over an in-memory head; absent paths return null. */
function headOf(files: Record<string, string>): ReadAtHead {
  const map = new Map(Object.entries(files));
  return (path) => Promise.resolve(map.get(path) ?? null);
}

/** Run the check over an in-memory head. */
function check(cites: Cite[], files: Record<string, string>) {
  return checkFactsAnchors(factsFor(cites), headOf(files), FACTS_PATH);
}

Deno.test("anchorKey trims, then caps at MAX_FIELD_CHARS", () => {
  assertEquals(anchorKey("  const x = 1;\t"), "const x = 1;");
  assertEquals(anchorKey("b".repeat(1500)).length, MAX_FIELD_CHARS);
  assertEquals(anchorKey("   "), "");
});

Deno.test("an anchor that matches at the head passes", async () => {
  const result = await check(
    [{ path: LIB, line: 2, anchor: "const x = 1;" }],
    { [LIB]: "a\nconst x = 1;\nb\n" },
  );
  assertEquals(result.stale, []);
  assertEquals(result.notChecked, []);
  assertEquals(result.checked, 1);
});

Deno.test("a line inserted above the cited line is stale and names the new line", async () => {
  const result = await check(
    [{ path: LIB, line: 2, anchor: "const x = 1;" }],
    { [LIB]: "// inserted\nconst a = 0;\nconst x = 1;\n" },
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(result.stale[0]!, "line 2 no longer holds its anchor");
  assertStringIncludes(
    result.stale[0]!,
    "the anchor now appears at line(s) 3",
  );
  assertStringIncludes(result.stale[0]!, "set `line` (and `endLine`)");
  assertEquals(result.checked, 1);
});

Deno.test("a deleted anchor line is stale and says not found", async () => {
  const result = await check(
    [{ path: LIB, line: 2, anchor: "const x = 1;" }],
    { [LIB]: "a\nb\n" },
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(result.stale[0]!, "not found");
  assertStringIncludes(result.stale[0]!, "line 2 holds `b`");
  assertEquals(result.checked, 1);
});

Deno.test("an entry without an anchor is notChecked, not counted, never stale", async () => {
  const result = await check(
    [{ path: LIB, line: 2 }],
    { [LIB]: "a\nconst x = 1;\n" },
  );
  assertEquals(result.stale, []);
  assertEquals(result.checked, 0);
  assertEquals(result.notChecked.length, 1);
  assertStringIncludes(
    result.notChecked[0]!,
    `${FACTS_PATH}: entries[0] (${LIB}:2) has no anchor, so its line citation was not checked`,
  );
});

Deno.test("surrounding whitespace and CRLF do not stop a match", async () => {
  const result = await check(
    [{ path: LIB, line: 2, anchor: "   const x = 1;   " }],
    { [LIB]: "x\r\n  const x = 1;  \r\ny\r\n" },
  );
  assertEquals(result.stale, []);
  assertEquals(result.notChecked, []);
  assertEquals(result.checked, 1);
});

Deno.test("a file absent at the head is stale", async () => {
  const result = await check(
    [{ path: "worker/deno/lib/gone.ts", line: 1, anchor: "const x = 1;" }],
    {},
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(
    result.stale[0]!,
    "anchor not found because worker/deno/lib/gone.ts does not exist at the head",
  );
  assertEquals(result.notChecked, []);
  assertEquals(result.checked, 1);
});

Deno.test("a reader that throws is notChecked with the cause, never passed", async () => {
  const reader: ReadAtHead = () =>
    Promise.reject(new Error("disk on fire\nsecond line of detail"));
  const result = await checkFactsAnchors(
    factsFor([{ path: LIB, line: 2, anchor: "const x = 1;" }]),
    reader,
    FACTS_PATH,
  );
  assertEquals(result.stale, []);
  assertEquals(result.checked, 0);
  assertEquals(result.notChecked.length, 1);
  assertStringIncludes(result.notChecked[0]!, "disk on fire");
  assert(!result.notChecked[0]!.includes("second line of detail"));
});

Deno.test("two entries on one path read the file once", async () => {
  let calls = 0;
  const reader: ReadAtHead = (path) => {
    calls++;
    return Promise.resolve(path === LIB ? "a\nb\nc\n" : null);
  };
  const result = await checkFactsAnchors(
    factsFor([
      { path: LIB, line: 1, anchor: "a" },
      { path: LIB, line: 3, anchor: "c" },
    ]),
    reader,
    FACTS_PATH,
  );
  assertEquals(calls, 1);
  assertEquals(result.stale, []);
  assertEquals(result.checked, 2);
});

Deno.test("an anchor at the cited line and elsewhere passes", async () => {
  const text = "const x = 1;\nfoo\nconst x = 1;\n";
  const cited3 = await check(
    [{ path: LIB, line: 3, anchor: "const x = 1;" }],
    { [LIB]: text },
  );
  assertEquals(cited3.stale, []);
  assertEquals(cited3.checked, 1);
  const cited1 = await check(
    [{ path: LIB, line: 1, anchor: "const x = 1;" }],
    { [LIB]: text },
  );
  assertEquals(cited1.stale, []);
  assertEquals(cited1.checked, 1);
});

Deno.test("moved anchor names at most five line numbers", async () => {
  const head = Array.from({ length: 7 }, () => "const x = 1;").join("\n") +
    "\n";
  const result = await check(
    [{ path: LIB, line: 50, anchor: "const x = 1;" }],
    { [LIB]: head },
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(
    result.stale[0]!,
    "the anchor now appears at line(s) 1, 2, 3, 4, 5 ",
  );
  assert(!result.stale[0]!.includes("6"));
});

Deno.test("anchor past the end of a short file is stale and says so", async () => {
  const result = await check(
    [{ path: LIB, line: 5, anchor: "const x = 1;" }],
    { [LIB]: "a\n" },
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(result.stale[0]!, "not found");
  assertStringIncludes(result.stale[0]!, "the file has fewer than 5 lines");
});

Deno.test("hostile 200k-char line matches when both sides are capped the same way", async () => {
  const longLine = "   " + "y".repeat(200_000) + "   ";
  const anchor = anchorKey(longLine);
  assertEquals(anchor.length, MAX_FIELD_CHARS);
  const result = await check(
    [{ path: LIB, line: 2, anchor }],
    { [LIB]: `first\n${longLine}\n` },
  );
  assertEquals(result.stale, []);
  assertEquals(result.notChecked, []);
  assertEquals(result.checked, 1);
});

Deno.test("hostile source line in a message is capped and has no backticks", async () => {
  const hostile = "`ab`" + "c".repeat(300);
  const result = await check(
    [{ path: LIB, line: 1, anchor: "const x = 1;" }],
    { [LIB]: `${hostile}\n` },
  );
  assertEquals(result.stale.length, 1);
  const shown = result.stale[0]!.match(/holds `([^`]*)`$/);
  assert(shown !== null, "expected the held line in backticks");
  assertEquals(shown[1], "'ab'" + "c".repeat(116));
});

Deno.test("a file over MAX_ANCHOR_FILE_CHARS is notChecked, not passed", async () => {
  const huge = "a".repeat(MAX_ANCHOR_FILE_CHARS + 1);
  const result = await check(
    [{ path: LIB, line: 1, anchor: "a" }],
    { [LIB]: huge },
  );
  assertEquals(result.stale, []);
  assertEquals(result.checked, 0);
  assertEquals(result.notChecked.length, 1);
  assertStringIncludes(result.notChecked[0]!, "too large to check");
});

Deno.test("gitReadAtHead throws the first stderr line for a non-zero exit", async () => {
  const runGit = (): Promise<
    Result<{ code: number; stdout: string; stderr: string }>
  > =>
    Promise.resolve({
      ok: true,
      value: { code: 1, stdout: "", stderr: "fatal: bad object\nmore" },
    });
  const read = gitReadAtHead(runGit);
  let message = "";
  try {
    await read(LIB);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "fatal: bad object");
});

Deno.test("gitReadAtHead throws the error when runGit itself fails", async () => {
  const runGit = (): Promise<
    Result<{ code: number; stdout: string; stderr: string }>
  > => Promise.resolve({ ok: false, error: new Error("spawn failed") });
  let message = "";
  try {
    await gitReadAtHead(runGit)(LIB);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "spawn failed");
});

Deno.test("gitReadAtHead treats 'exists on disk, but not in HEAD' as absent", async () => {
  const runGit = (): Promise<
    Result<{ code: number; stdout: string; stderr: string }>
  > =>
    Promise.resolve({
      ok: true,
      value: {
        code: 128,
        stdout: "",
        stderr: `fatal: path '${LIB}' exists on disk, but not in 'HEAD'\n`,
      },
    });
  assertEquals(await gitReadAtHead(runGit)(LIB), null);
});

/** Run git with the given args in `cwd`, with stdin closed and no locale. */
async function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { LC_ALL: "C" },
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/** A runGit for `gitReadAtHead` that shells out to the real git in `cwd`. */
function runGitIn(cwd: string) {
  return async (
    args: string[],
  ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
    try {
      return { ok: true, value: await git(cwd, args) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };
}

/** A temp repo with `notes.txt` committed on HEAD. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir();
  const steps = [
    ["init", "-q"],
    ["add", "notes.txt"],
  ];
  await Deno.writeTextFile(`${dir}/notes.txt`, "first line\nsecond line\n");
  for (const args of steps) {
    const r = await git(dir, args);
    assertEquals(r.code, 0, r.stderr);
  }
  const commit = await git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  assertEquals(commit.code, 0, commit.stderr);
  return dir;
}

Deno.test("gitReadAtHead returns the committed text of a file", async () => {
  const dir = await makeRepo();
  try {
    const read = gitReadAtHead(runGitIn(dir));
    assertEquals(await read("notes.txt"), "first line\nsecond line\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitReadAtHead returns null for a path missing at HEAD", async () => {
  const dir = await makeRepo();
  try {
    const read = gitReadAtHead(runGitIn(dir));
    assertEquals(await read("nope.txt"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitReadAtHead reads HEAD, not uncommitted working-tree edits", async () => {
  const dir = await makeRepo();
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "edited but not committed\n");
    await Deno.writeTextFile(`${dir}/untracked.txt`, "never committed\n");
    const read = gitReadAtHead(runGitIn(dir));
    assertEquals(await read("notes.txt"), "first line\nsecond line\n");
    assertEquals(await read("untracked.txt"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitReadAtHead throws with the cause line outside a git repository", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let message = "";
    try {
      await gitReadAtHead(runGitIn(dir))("notes.txt");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "not a git repository");
    assert(!message.includes("\n"), "message must be one line");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("end to end: a real committed insertion above the anchor is caught", async () => {
  const dir = await makeRepo();
  try {
    const path = "notes.txt";
    const cites = factsFor([{ path, line: 2, anchor: "second line" }]);
    const read = gitReadAtHead(runGitIn(dir));
    const before = await checkFactsAnchors(cites, read, FACTS_PATH);
    assertEquals(before.stale, []);
    assertEquals(before.checked, 1);

    await Deno.writeTextFile(
      `${dir}/notes.txt`,
      "inserted\nfirst line\nsecond line\n",
    );
    const commit = await git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-am",
      "insert above",
    ]);
    assertEquals(commit.code, 0, commit.stderr);

    const after = await checkFactsAnchors(cites, read, FACTS_PATH);
    assertEquals(after.stale.length, 1);
    assertStringIncludes(
      after.stale[0]!,
      "the anchor now appears at line(s) 3",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
