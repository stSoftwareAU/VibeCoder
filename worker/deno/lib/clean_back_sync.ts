/** Identify the exact conflict-free merge the AutoTrader workflows may skip. */
type Git = (args: string[]) => Promise<{
  code: number;
  stdout?: string;
}>;

export async function cleanBackSync(
  repo: string,
  milestone: string,
  source: string,
  git: Git,
): Promise<{ branch: string; head: string } | undefined> {
  if (
    repo.toLowerCase() !== "stsoftwareau/grq-autotrader" ||
    source !== "Develop" || !milestone.startsWith("milestone/")
  ) return;

  const baseRef = `refs/heads/${milestone}`;
  const sourceRef = `refs/heads/${source}`;
  const refs = await git(["ls-remote", "--refs", "origin", baseRef, sourceRef]);
  if (refs.code !== 0) return;
  const tips = new Map(
    (refs.stdout ?? "").trim().split("\n").map((line) => {
      const [sha, ref] = line.split("\t");
      return [ref, sha] as const;
    }),
  );
  const base = tips.get(baseRef);
  const develop = tips.get(sourceRef);
  const sha = /^[0-9a-f]{40}$/;
  if (!base || !develop || !sha.test(base) || !sha.test(develop)) return;

  const commit = await git(["show", "-s", "--format=%H %T %P", "HEAD"]);
  const [head, tree, ...parents] = (commit.stdout ?? "").trim().split(" ");
  if (commit.code !== 0 || !head || !sha.test(head)) return;
  // Git may fast-forward to Develop. A divergent milestone must have
  // exactly the published milestone and Develop tips as its ordered parents.
  if (head !== develop && parents.join(" ") !== `${base} ${develop}`) return;
  if (head === develop) {
    const ancestry = await git(["merge-base", "--is-ancestor", base, develop]);
    if (ancestry.code !== 0) return;
  }
  const merge = await git(["merge-tree", "--write-tree", base, develop]);
  if (merge.code !== 0 || merge.stdout?.trim() !== tree) return;
  return { head, branch: `sync/milestone-clean/${milestone}/${base}/${head}` };
}
