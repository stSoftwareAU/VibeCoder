/** A path is data; the runner owns the executable and all flags. */
export interface RegressionCheckPlan {
  testFile: string;
  cwd: string;
  argv: string[];
}

/** Parse `git ls-tree -rz --full-tree` output captured by the host at head. */
export function parseHeadTree(output: string): Set<string> {
  if (output.length > 8 * 1024 * 1024 || (output && !output.endsWith("\0"))) {
    throw new Error("Invalid or oversized head-tree output");
  }
  const records = output ? output.slice(0, -1).split("\0") : [];
  if (records.length > 20_000) throw new Error("Head tree has too many files");
  const files = new Set<string>();
  for (const record of records) {
    const match =
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t([^\0]+)$/
        .exec(record);
    if (!match || (match[1] === "160000") !== (match[2] === "commit")) {
      throw new Error("Malformed head-tree record");
    }
    if (match[1] === "120000" || match[1] === "160000") continue;
    if (files.has(match[4]!)) throw new Error("Duplicate head-tree path");
    files.add(match[4]!);
  }
  return files;
}

/** Plan only supported tests present in the verified head tree. */
export function planRegressionChecks(
  testFiles: readonly string[],
  headFiles: ReadonlySet<string>,
): RegressionCheckPlan[] {
  if (testFiles.length === 0 || testFiles.length > 8) {
    throw new Error("A review needs between one and eight supported tests");
  }
  return [...new Set(testFiles)].map((testFile) => {
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:_test|\.test)\.ts$/.test(testFile) ||
      testFile.split("/").some((part) =>
        !part || part === "." || part === ".."
      ) ||
      !headFiles.has(testFile)
    ) throw new Error(`Unsupported or untracked test path: ${testFile}`);
    const segments = testFile.split("/");
    segments.pop();
    let cwd = ".";
    for (let n = segments.length; n > 0; n--) {
      const dir = segments.slice(0, n).join("/");
      if (
        headFiles.has(`${dir}/deno.json`) || headFiles.has(`${dir}/deno.jsonc`)
      ) {
        cwd = dir;
        break;
      }
    }
    const relativeTest = cwd === "."
      ? testFile
      : testFile.slice(cwd.length + 1);
    return {
      testFile,
      cwd,
      argv: [
        "deno",
        "test",
        "--cached-only",
        "--no-prompt",
        "--allow-all",
        `./${relativeTest}`,
      ],
    };
  });
}
