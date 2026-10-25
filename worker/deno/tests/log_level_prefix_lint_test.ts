/**
 * The level is not part of the message text (Issue #4176).
 *
 * A template or double-quoted string in `worker/deno/lib` (outside tests)
 * must not start a log line with a level word. The logger method is the
 * level. This fails while those prefixes are still in the source.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";

/** Literals that put a level into the message text. */
const FORBIDDEN = [
  "`WARNING:",
  "`ERROR:",
  "`WARN:",
  '"WARNING: ',
  '"ERROR: ',
] as const;

const LIB = new URL("../lib/", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "tests") continue;
      found.push(...await sourceFiles(path));
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    found.push(path);
  }
  return found;
}

Deno.test("worker lib does not put WARNING or ERROR inside a log string (Issue #4176)", async () => {
  const hits: string[] = [];
  for (const path of await sourceFiles(LIB)) {
    const text = await Deno.readTextFile(path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const literal of FORBIDDEN) {
        if (line.includes(literal)) {
          hits.push(`${path}:${i + 1}: ${literal}`);
        }
      }
    }
  }
  assertEquals(
    hits,
    [],
    `level prefixes belong on the logger, not in the message:\n${
      hits.join("\n")
    }`,
  );
});
