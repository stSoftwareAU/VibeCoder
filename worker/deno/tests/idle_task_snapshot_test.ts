import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  diffNewlyFiled,
  fileFindingOnce,
  findOpenIssueByFindingId,
  listKnownOpenFindingIds,
  listOpenIssueNumbersByLabel,
  parseGhJsonArray,
} from "../lib/idle_task_snapshot.ts";

// --- parseGhJsonArray -------------------------------------------------------

Deno.test("parseGhJsonArray - returns the parsed array on valid JSON", () => {
  assertEquals(parseGhJsonArray('[{"number":1},{"number":2}]', "test"), [
    { number: 1 },
    { number: 2 },
  ]);
});

Deno.test("parseGhJsonArray - non-array payload returns empty array", () => {
  assertEquals(parseGhJsonArray('{"number":1}', "test"), []);
});

Deno.test("parseGhJsonArray - malformed JSON returns empty array and logs the label", () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = parseGhJsonArray("not json {", "list security numbers");
    assertEquals(result, []);
    assertEquals(lines.length, 1);
    const logged = lines[0] ?? "";
    assertStringIncludes(logged, "[idle-task-snapshot]");
    assertStringIncludes(logged, "list security numbers");
    assertStringIncludes(logged, "failed to parse gh JSON payload");
  } finally {
    console.error = original;
  }
});

Deno.test("parseGhJsonArray - valid JSON does not log", () => {
  const original = console.error;
  let logged = false;
  console.error = () => {
    logged = true;
  };
  try {
    parseGhJsonArray("[]", "test");
    assertEquals(logged, false);
  } finally {
    console.error = original;
  }
});

// --- listOpenIssueNumbersByLabel -------------------------------------------

Deno.test("listOpenIssueNumbersByLabel - parses issue numbers from gh JSON", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(JSON.stringify([{ number: 12 }, { number: 7 }]));
  const set = await listOpenIssueNumbersByLabel("o/r", "security", gh);
  assertEquals(set, new Set([12, 7]));
});

Deno.test("listOpenIssueNumbersByLabel - passes label through to gh", async () => {
  let captured: string[] = [];
  const gh = (args: string[]) => {
    captured = args;
    return Promise.resolve("[]");
  };
  await listOpenIssueNumbersByLabel("o/r", "best-practices", gh);
  const idx = captured.indexOf("--label");
  assertEquals(captured[idx + 1], "best-practices");
});

Deno.test("listOpenIssueNumbersByLabel - gh failure returns empty set", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("gh exploded"));
  const set = await listOpenIssueNumbersByLabel("o/r", "security", gh);
  assertEquals(set, new Set<number>());
});

Deno.test("listOpenIssueNumbersByLabel - malformed JSON returns empty set", async () => {
  const gh = (_args: string[]) => Promise.resolve("not json {");
  const set = await listOpenIssueNumbersByLabel("o/r", "security", gh);
  assertEquals(set, new Set<number>());
});

Deno.test("listOpenIssueNumbersByLabel - non-array payload returns empty set", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(JSON.stringify({ number: 1 }));
  const set = await listOpenIssueNumbersByLabel("o/r", "security", gh);
  assertEquals(set, new Set<number>());
});

Deno.test("listOpenIssueNumbersByLabel - skips entries without a finite number", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([{ number: 3 }, { number: "x" }, null, {}, { number: 5 }]),
    );
  const set = await listOpenIssueNumbersByLabel("o/r", "test-audit", gh);
  assertEquals(set, new Set([3, 5]));
});

// --- diffNewlyFiled ---------------------------------------------------------

Deno.test("diffNewlyFiled - returns numbers only in after, sorted ascending", () => {
  const before = new Set([1, 2, 3]);
  const after = new Set([3, 2, 9, 1, 5]);
  assertEquals(diffNewlyFiled(before, after), [5, 9]);
});

Deno.test("diffNewlyFiled - no new issues returns empty array", () => {
  assertEquals(diffNewlyFiled(new Set([1, 2]), new Set([1, 2])), []);
});

Deno.test("diffNewlyFiled - empty before returns all of after sorted", () => {
  assertEquals(diffNewlyFiled(new Set<number>(), new Set([8, 4, 6])), [
    4,
    6,
    8,
  ]);
});

// --- listKnownOpenFindingIds ------------------------------------------------

Deno.test("listKnownOpenFindingIds - extracts BP- ids from body markers", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 1, body: "intro\n<!-- finding-id: BP-abc123def456 -->\n" },
        { number: 2, body: "<!-- finding-id: BP-LINTER-rust -->" },
      ]),
    );
  const ids = await listKnownOpenFindingIds("o/r", "best-practices", gh);
  assertEquals(ids, ["BP-abc123def456", "BP-LINTER-rust"]);
});

Deno.test("listKnownOpenFindingIds - ignores bodies without a marker", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 1, body: "no marker here" },
        { number: 2 },
        { number: 3, body: "<!-- finding-id: BP-keepthis01 -->" },
      ]),
    );
  const ids = await listKnownOpenFindingIds("o/r", "test-audit", gh);
  assertEquals(ids, ["BP-keepthis01"]);
});

Deno.test("listKnownOpenFindingIds - honours a custom id prefix", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 1, body: "<!-- finding-id: SEC-aabbccddeeff -->" },
        { number: 2, body: "<!-- finding-id: BP-shouldskip01 -->" },
      ]),
    );
  const ids = await listKnownOpenFindingIds("o/r", "security", gh, "SEC-");
  assertEquals(ids, ["SEC-aabbccddeeff"]);
});

Deno.test("listKnownOpenFindingIds - gh failure returns empty array", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("network down"));
  assertEquals(await listKnownOpenFindingIds("o/r", "best-practices", gh), []);
});

Deno.test("listKnownOpenFindingIds - malformed JSON returns empty array", async () => {
  const gh = (_args: string[]) => Promise.resolve("}{ broken");
  assertEquals(await listKnownOpenFindingIds("o/r", "best-practices", gh), []);
});

// --- findOpenIssueByFindingId ----------------------------------------------

Deno.test("findOpenIssueByFindingId - returns the number of the matching open issue", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 10, body: "<!-- finding-id: BP-other000001 -->" },
        { number: 42, body: "lead\n<!-- finding-id: BP-LINTER-typescript -->" },
      ]),
    );
  const n = await findOpenIssueByFindingId(
    "o/r",
    "best-practices",
    "BP-LINTER-typescript",
    gh,
  );
  assertEquals(n, 42);
});

Deno.test("findOpenIssueByFindingId - queries only open issues", async () => {
  let captured: string[] = [];
  const gh = (args: string[]) => {
    captured = args;
    return Promise.resolve("[]");
  };
  await findOpenIssueByFindingId("o/r", "best-practices", "BP-x", gh);
  const idx = captured.indexOf("--state");
  assertEquals(captured[idx + 1], "open");
});

Deno.test("findOpenIssueByFindingId - no matching id returns null", async () => {
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 1, body: "<!-- finding-id: BP-different01 -->" },
      ]),
    );
  const n = await findOpenIssueByFindingId(
    "o/r",
    "best-practices",
    "BP-LINTER-typescript",
    gh,
  );
  assertEquals(n, null);
});

Deno.test("findOpenIssueByFindingId - gh failure returns null", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("gh exploded"));
  assertEquals(
    await findOpenIssueByFindingId("o/r", "best-practices", "BP-x", gh),
    null,
  );
});

// --- fileFindingOnce --------------------------------------------------------

Deno.test("fileFindingOnce - skips filing when an open issue with the id exists", async () => {
  let fileCalls = 0;
  const gh = (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([
        { number: 99, body: "<!-- finding-id: BP-LINTER-typescript -->" },
      ]),
    );
  const result = await fileFindingOnce({
    repo: "o/r",
    label: "best-practices",
    findingId: "BP-LINTER-typescript",
    ghCommandFn: gh,
    fileFn: () => {
      fileCalls++;
      return Promise.resolve({
        number: 123,
        findingId: "BP-LINTER-typescript",
      });
    },
  });
  assertEquals(fileCalls, 0);
  assertEquals(result, {
    number: 99,
    findingId: "BP-LINTER-typescript",
    skipped: true,
  });
});

Deno.test("fileFindingOnce - files when only a closed issue carries the id", async () => {
  // gh `--state open` returns no match (the prior issue was closed), so the
  // file path runs.
  let fileCalls = 0;
  const gh = (_args: string[]) => Promise.resolve("[]");
  const result = await fileFindingOnce({
    repo: "o/r",
    label: "best-practices",
    findingId: "BP-LINTER-typescript",
    ghCommandFn: gh,
    fileFn: () => {
      fileCalls++;
      return Promise.resolve({
        number: 200,
        findingId: "BP-LINTER-typescript",
      });
    },
  });
  assertEquals(fileCalls, 1);
  assertEquals(result, {
    number: 200,
    findingId: "BP-LINTER-typescript",
    skipped: false,
  });
});

Deno.test("fileFindingOnce - returns null when no duplicate exists and fileFn fails", async () => {
  const gh = (_args: string[]) => Promise.resolve("[]");
  const result = await fileFindingOnce({
    repo: "o/r",
    label: "best-practices",
    findingId: "BP-LINTER-rust",
    ghCommandFn: gh,
    fileFn: () => Promise.resolve(null),
  });
  assertEquals(result, null);
});
