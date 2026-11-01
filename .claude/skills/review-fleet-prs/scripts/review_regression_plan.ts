/** A path is data; the runner owns the executable and all flags. */
export interface RegressionCheckPlan {
  testFile: string;
  cwd: string;
  argv: string[];
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
