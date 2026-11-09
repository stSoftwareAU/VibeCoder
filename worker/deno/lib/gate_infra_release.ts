/**
 * A bound on how often a repair is released, uncharged, because the pre-push
 * gate failed as infrastructure (PR #4896 review).
 *
 * A passing host fault (the toolchain is being installed, the disk is briefly
 * full) clears by itself, so the first releases are free. A lasting one (a CI
 * cargo command the scanner cannot reproduce, a toolchain the host never gets)
 * gives the same fault on every cycle, and an uncharged release then re-runs a
 * full agent session each time without ever pushing, charging or dismissing.
 * Each release therefore leaves a visible PR comment carrying a marker, and a
 * repair already released {@link GATE_INFRA_RELEASE_CAP} times is charged like
 * any other failed attempt.
 *
 * The count is read from the PR's own comments, which every host sees; only a
 * marker authored by a trusted fleet login counts, so a stranger's comment
 * cannot spend the budget.
 *
 * Uses Australian English spelling (behaviour, normalise, recognise, etc.).
 */

/** How many uncharged gate-infrastructure releases one repair gets. */
export const GATE_INFRA_RELEASE_CAP = 2;

/** A key naming one repair: letters, digits and `_ . : -` only. */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const MARKER_NAME = "vibe-gate-infra-release";
const DETAIL_LENGTH = 300;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`gate infrastructure release key is not allowed: ${key}`);
  }
}

/** The marker one release carries, which {@link countGateInfraReleases} counts. */
export function gateInfraReleaseMarker(key: string): string {
  assertKey(key);
  return `<!-- ${MARKER_NAME} key=${key} -->`;
}

/** Gate output as one bounded line with no markup, for a PR comment. */
export function safeGateDetail(text: string): string {
  return text.replace(/[<>`\r\n]+/g, " ").trim().slice(0, DETAIL_LENGTH);
}

/**
 * How many releases the PR's trusted comments already record for `key`, or
 * `null` when they cannot be read (the caller then keeps releasing, since an
 * unreadable PR is no evidence of a lasting fault).
 */
export async function countGateInfraReleases(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  prNumber: number,
  key: string,
  trustedAuthors: readonly string[],
): Promise<number | null> {
  assertKey(key);
  if (trustedAuthors.length === 0) return null;
  const needle = `${MARKER_NAME} key=${key} -->`;
  let output: string;
  try {
    output = await gh([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
      "--jq",
      `.[] | [.user.login, (.body | contains("${needle}"))] | @tsv`,
    ]);
  } catch {
    return null;
  }
  const trusted = new Set(trustedAuthors.map((login) => login.toLowerCase()));
  let count = 0;
  for (const line of output.split("\n")) {
    const [login, marked] = line.split("\t");
    if (marked?.trim() === "true" && trusted.has((login ?? "").toLowerCase())) {
      count++;
    }
  }
  return count;
}
