/**
 * Seed real Git histories without replaying a shell workflow for every test.
 * Fast-import only prepares the fixture: the tested merge, rebase, push and
 * recovery operations still run against real repositories and real Git.
 */

export interface GitFixtureCommit {
  branch: string;
  subject: string;
  /** One-based index of the parent commit in the fixture. */
  parent?: number;
  /** Files added or replaced relative to the parent. */
  files: Record<string, string>;
  remove?: readonly string[];
}

async function git(args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

/** Create a bare remote containing the supplied commit graph. */
export async function seedGitRemote(
  root: string,
  defaultBranch: string,
  commits: readonly GitFixtureCommit[],
): Promise<string> {
  const remote = `${root}/remote.git`;
  await git(["init", "--bare", `--initial-branch=${defaultBranch}`, remote]);
  const encoder = new TextEncoder();
  const data = (text: string) =>
    `data ${encoder.encode(text).length}\n${text}\n`;
  let input = "";
  for (const [index, commit] of commits.entries()) {
    input += `commit refs/heads/${commit.branch}\nmark :${index + 1}\n`;
    input += `committer Test <t@example.com> ${index + 1} +0000\n`;
    input += data(commit.subject);
    if (commit.parent !== undefined) input += `from :${commit.parent}\n`;
    for (const [path, content] of Object.entries(commit.files)) {
      input += `M 100644 inline ${JSON.stringify(path)}\n${data(content)}`;
    }
    for (const path of commit.remove ?? []) {
      input += `D ${JSON.stringify(path)}\n`;
    }
    input += "\n";
  }
  const child = new Deno.Command("git", {
    args: ["-C", remote, "fast-import", "--quiet"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const [, result] = await Promise.all([
    (async () => {
      try {
        await writer.write(encoder.encode(input + "done\n"));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    })(),
    child.output(),
  ]);
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return remote;
}

/** Clone with a local fixture identity, retaining the normal remote refspec. */
export async function cloneGitFixture(
  remote: string,
  destination: string,
  options: {
    name?: string;
    email?: string;
    singleBranch?: string;
    checkout?: string;
  } = {},
): Promise<void> {
  await git([
    "clone",
    "--config",
    `user.name=${options.name ?? "Test"}`,
    "--config",
    `user.email=${options.email ?? "t@example.com"}`,
    ...(options.singleBranch
      ? ["--single-branch", "--branch", options.singleBranch]
      : []),
    remote,
    destination,
  ]);
  if (options.checkout) {
    await git(["-C", destination, "checkout", options.checkout]);
  }
}
