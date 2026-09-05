/**
 * The dedup-marker author check is capped, in both directions.
 *
 * **Why this test reads source text.** `CODING-STANDARDS.md` forbids tests
 * that grep source for a pattern, and the `test-audit` scan reports them as
 * smell (2). This is the exception that guidance allows, for three reasons
 * that have to hold together:
 *
 *   1. The invariant *is* a property of the source text — "every dedup lookup
 *      in the tree asks GitHub who wrote the match". There is no value to
 *      assert and no behaviour to observe; there is a set of call sites.
 *   2. There is no runtime seam that can see the set. Each lookup lives behind
 *      its own module's own injected `gh` runner, and a module nobody imported
 *      makes no call at all — the very module most likely to carry a
 *      copy-pasted defect.
 *   3. The failure it prevents is silent. An unverified marker match makes the
 *      worker conclude "already handled" and do nothing, which produces no
 *      error, no log line and no red test anywhere else.
 *
 * `parallel_safety_cap_test.ts` (Issues #880/#940) is the same shape and the
 * precedent this file follows: a classifier over the tree, a shrink-only
 * manifest of what has not been fixed, and a cap in **both** directions so
 * neither the manifest nor the tree can drift from the other.
 *
 * The defect it caps: a module decides whether to act by searching GitHub for
 * a marker in an issue title, body or comment, and never checks the author.
 * On a public repository those three are attacker-writable and the author is
 * not, so a planted marker steers the fleet — into silence. Eighteen
 * idle-task templates carried one copy each of the same five lines, which is
 * how the class travels: by copy-paste.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  AUTHOR_BEARING_JSON_FIELD_CONSTANTS,
  findMarkerDedupCallSites,
  MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS,
  MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES,
} from "../lib/marker_dedup_author_manifest.ts";
import { ALERT_DEDUP_JSON_FIELDS } from "../lib/alert_dedup_authors.ts";
import { TITLE_MARKER_DEDUP_JSON_FIELDS } from "../lib/idle_task_wrapper_dedup.ts";

const DENO_DIR = new URL("..", import.meta.url).pathname;

/** The two trees the worker's `gh` lookups live in. */
const SCANNED_ROOTS = ["lib", "setup"];

/**
 * The manifest module names the pattern in its own prose and constants, the
 * same way `parallel_safety_cap_test.ts` excuses itself from its own scan.
 */
const SELF = "lib/marker_dedup_author_manifest.ts";

async function* walk(dir: string, prefix: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(`${dir}/${prefix}`)) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory) yield* walk(dir, path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Every source file the cap covers, path relative to `worker/deno`. */
async function scannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    for await (const file of walk(DENO_DIR, root)) {
      if (file !== SELF) files.push(file);
    }
  }
  return files.sort();
}

/** Files that currently hold at least one unverified dedup lookup. */
async function currentlyUnverified(
  override?: Map<string, string>,
): Promise<string[]> {
  const offenders = new Set<string>();
  for (const file of await scannedFiles()) {
    const source = override?.get(file) ??
      await Deno.readTextFile(`${DENO_DIR}${file}`);
    for (const site of findMarkerDedupCallSites(source, file)) {
      if (!site.authorVerified) offenders.add(file);
    }
  }
  return [...offenders].sort();
}

// ---------------------------------------------------------------------------
// The cap — both directions
// ---------------------------------------------------------------------------

Deno.test("marker dedup - no new lookup trusts a marker without its author", async () => {
  const listed = new Set(MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES);
  const added = (await currentlyUnverified()).filter((f) => !listed.has(f));
  assertEquals(
    added,
    [],
    "these files decide whether to act on a marker in an issue title, body " +
      "or comment without checking who wrote it — on a public repository " +
      "that text is attacker-supplied and only the author is authenticated, " +
      "so a planted marker silences the module. Route the lookup through " +
      "`lib/idle_task_wrapper_dedup.ts` (title markers) or " +
      "`lib/alert_dedup_authors.ts` (body and comment markers):\n" +
      added.join("\n"),
  );
});

Deno.test("marker dedup - the manifest holds no file that was fixed", async () => {
  // An exemption that outlives what it exempts is how a manifest rots into a
  // permission slip. Shrinking this list is the goal, so a stale entry must
  // be noticed — and noticing it is what forces a fix to delete its entry.
  const current = new Set(await currentlyUnverified());
  const stale = MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES.filter((f) =>
    !current.has(f)
  ).sort();
  assertEquals(
    stale,
    [],
    "these files no longer hold an unverified dedup lookup — remove them " +
      "from MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES so the manifest stays an " +
      "exact record of the remaining debt:\n" + stale.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// The cap's own moving parts
// ---------------------------------------------------------------------------

Deno.test("marker dedup - an unlisted violation fails the cap (injected)", async () => {
  // The forward direction, proved rather than asserted: feed the scanner a
  // file that is not on the manifest and whose dedup search omits `author`,
  // and the cap must name it. Without this, a classifier that silently
  // stopped matching would leave both cap tests green and useless.
  const planted = new Map<string, string>([[
    "lib/alert_dedup_authors.ts",
    `await gh([
      "issue", "list", "--repo", repo, "--state", "open",
      "--search", \`"\${MARKER}" in:body\`,
      "--json", "number,body", "--limit", "10",
    ]);`,
  ]]);
  const offenders = await currentlyUnverified(planted);
  assert(
    offenders.includes("lib/alert_dedup_authors.ts"),
    "the scanner did not flag an unverified `in:body` dedup search",
  );
  assert(
    !new Set(MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES).has(
      "lib/alert_dedup_authors.ts",
    ),
    "fixture precondition: the planted file must not be on the manifest",
  );
});

Deno.test("marker dedup - requesting the author clears the cap", async () => {
  // The reverse of the previous test on the same fixture: adding `author` to
  // the `--json` list is the whole fix, and the scanner must see it.
  const fixed = new Map<string, string>([[
    "lib/alert_dedup_authors.ts",
    `await gh([
      "issue", "list", "--repo", repo, "--state", "open",
      "--search", \`"\${MARKER}" in:body\`,
      "--json", "number,body,author", "--limit", "10",
    ]);`,
  ]]);
  assertEquals(
    (await currentlyUnverified(fixed)).includes("lib/alert_dedup_authors.ts"),
    false,
  );
});

Deno.test("marker dedup - a --jq that projects the author away does not clear the cap", async () => {
  // `gh --json number,body,author --jq '.[].body'` requests the author and
  // then throws it away, which is indistinguishable from never asking.
  const projected = new Map<string, string>([[
    "lib/alert_dedup_authors.ts",
    `await gh([
      "issue", "list", "--repo", repo, "--state", "open",
      "--search", \`"\${MARKER}" in:body\`,
      "--json", "number,body,author", "--jq", "[.[] | .body]",
    ]);`,
  ]]);
  assert(
    (await currentlyUnverified(projected)).includes(
      "lib/alert_dedup_authors.ts",
    ),
    "a `--jq` that drops the author must still count as unverified",
  );
});

Deno.test("marker dedup - a comment read that keeps the body needs the commenter", async () => {
  const source = `await gh([
    "api", \`repos/\${repo}/issues/\${n}/comments\`,
    "--jq", '[.[] | select(.body | test("LOCK:")) | {id: .id, body: .body}]',
  ]);`;
  const sites = findMarkerDedupCallSites(source, "lib/example.ts");
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.kind, "comment");
  assertEquals(sites[0]?.authorVerified, false);

  const withUser = source.replace(
    "{id: .id, body: .body}",
    "{id: .id, body: .body, user: .user.login}",
  );
  assertEquals(
    findMarkerDedupCallSites(withUser, "lib/example.ts")[0]?.authorVerified,
    true,
  );
});

Deno.test("marker dedup - a comment read that takes only GitHub metadata is not a site", async () => {
  // `idle_task_activity.ts` reads `.created_at` off claim comments and
  // `claim_issue.ts` reads `.id` to delete its own — neither trusts the
  // marker's payload, so neither is this class of defect.
  const metadataOnly = `await gh([
    "api", \`repos/\${repo}/issues/\${n}/comments\`,
    "--jq", '[.[] | select(.body | test("CLAIM_LOCK:")) | .created_at]',
  ]);`;
  assertEquals(findMarkerDedupCallSites(metadataOnly, "lib/example.ts"), []);
});

Deno.test("marker dedup - a label-scoped listing is not a site", async () => {
  // `security_tree_sweep.ts`'s shape: applying a label needs triage
  // permission, so the candidate set is not attacker-supplied.
  const labelScoped = `await gh([
    "issue", "list", "--repo", repo, "--state", "open",
    "--label", SWEEP_LABEL, "--json", "number,title,body,labels",
  ]);`;
  assertEquals(findMarkerDedupCallSites(labelScoped, "lib/example.ts"), []);
});

Deno.test("marker dedup - the author-bearing constants really carry the author", () => {
  // The scanner treats these names as proof, so a rename into the list must
  // not become a way round the cap.
  const values: Record<string, string> = {
    ALERT_DEDUP_JSON_FIELDS,
    TITLE_MARKER_DEDUP_JSON_FIELDS,
  };
  assertEquals(
    [...AUTHOR_BEARING_JSON_FIELD_CONSTANTS].sort(),
    Object.keys(values).sort(),
  );
  for (const [name, value] of Object.entries(values)) {
    assert(
      value.split(",").includes("author"),
      `${name} is treated as author-bearing but is "${value}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Manifest hygiene
// ---------------------------------------------------------------------------

Deno.test("marker dedup - every manifest entry names a file that exists", async () => {
  const present = new Set(await scannedFiles());
  const missing = [
    ...MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES,
    ...MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS,
  ].filter((f) => !present.has(f));
  assertEquals(missing, [], `manifest names files that are not in the tree`);
});

Deno.test("marker dedup - the manifest is sorted and free of duplicates", () => {
  for (
    const [name, list] of [
      [
        "MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES",
        MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES,
      ],
      [
        "MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS",
        MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS,
      ],
    ] as const
  ) {
    assertEquals([...list], [...list].sort(), `${name} is not sorted`);
    assertEquals(new Set(list).size, list.length, `${name} has duplicates`);
  }
});
