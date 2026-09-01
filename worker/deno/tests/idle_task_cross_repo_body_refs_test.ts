/**
 * Guard: idle-task prompt bodies filed cross-repo must be self-contained
 * (Issue #3509).
 *
 * Every idle-task template files its prompt body verbatim as a GitHub issue
 * in the *target* repository (e.g. `stSoftwareAU/private-repo-14`). A bare `#NNN` or
 * `Issue #NNN` reference in that body is auto-linked by GitHub to the target
 * repo's own unrelated issue — a mislink. VibeCoder-internal file paths
 * (`worker/deno/…`) are equally meaningless once the body lands in another
 * repo. This guard loads the *latest* version of every cross-repo-filed
 * prompt body (plus every best-practices bucket guide, which is inlined into
 * the best-practices wrapper body) and fails loudly if either defect returns.
 *
 * The set of prompt names is enumerated here and cross-checked against the
 * `idle_task_templates/` directory: adding a template without listing its
 * prompt name here fails the completeness test, so coverage cannot silently
 * drift. Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const TEMPLATES_DIR = new URL(
  "../lib/idle_task_templates",
  import.meta.url,
).pathname;

/**
 * Every idle-task template that files its prompt body verbatim into a target
 * repository. Each name maps to a `prompts/<name>/vN.md` directory. Keep this
 * in sync with `worker/deno/lib/idle_task_templates/*_template.ts` — the
 * completeness test below enforces it.
 */
const CROSS_REPO_PROMPT_NAMES = [
  "alert_feed",
  "bash_script_refs",
  "bash_syntax_audit",
  "best_practices",
  "dead_code",
  "deprecated_api",
  "doc_coverage",
  "documentation_audit",
  "duplicated_knowledge",
  "format_drift",
  "github_actions_audit",
  "orphan_deps",
  "private_repo_reference_audit",
  "retro",
  "security_scan",
  "supply_chain_readiness",
  "test_audit",
  "workflow_annotation_scan",
] as const;

/**
 * A bare GitHub issue/PR/check reference: `#` + digits where the `#` is NOT
 * preceded by a word character. This flags `Issue #3239`, `#3234`,
 * `check #16`, `template #1`, and `(#5)` — all of which GitHub auto-links to
 * the *target* repo — while permitting a fully-qualified `owner/repo#NNN`
 * cross-repo reference (e.g. `stSoftwareAU/VibeCoder#2222`), which links
 * correctly no matter which repo renders it.
 */
const BARE_REF = /(?<!\w)#\d+/g;

/** VibeCoder-internal source path — meaningless in any other repo. */
const INTERNAL_PATH = /worker\/deno\//g;

/** Collect the line numbers and matched text for a pattern in a body. */
function findMatches(body: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(pattern)) {
      hits.push(`line ${i + 1}: …${m[0]}… (${lines[i]!.trim().slice(0, 70)})`);
    }
  }
  return hits;
}

async function bucketGuideNames(): Promise<string[]> {
  const names: string[] = [];
  for await (
    const entry of Deno.readDir(`${PROMPTS_DIR}/best_practices/buckets`)
  ) {
    if (entry.isFile && entry.name.endsWith(".md")) names.push(entry.name);
  }
  names.sort();
  return names;
}

Deno.test(
  "cross-repo prompt list matches the idle_task_templates directory",
  async () => {
    let templateCount = 0;
    for await (const entry of Deno.readDir(TEMPLATES_DIR)) {
      if (entry.isFile && entry.name.endsWith("_template.ts")) templateCount++;
    }
    assertEquals(
      templateCount,
      CROSS_REPO_PROMPT_NAMES.length,
      "A template was added or removed without updating " +
        "CROSS_REPO_PROMPT_NAMES — every cross-repo-filed prompt body must be " +
        "covered by this guard.",
    );
  },
);

Deno.test(
  "cross-repo prompt bodies carry no bare #NNN issue references",
  async () => {
    const offenders: string[] = [];
    for (const name of CROSS_REPO_PROMPT_NAMES) {
      const latest = await getLatestVersion(name, PROMPTS_DIR);
      assert(latest.ok, `no versions for ${name}`);
      if (!latest.ok) continue;
      const loaded = await loadPrompt(name, latest.value, PROMPTS_DIR);
      assert(loaded.ok, `failed to load ${name} ${latest.value}`);
      if (!loaded.ok) continue;
      for (const hit of findMatches(loaded.value, BARE_REF)) {
        offenders.push(`${name}/${latest.value}.md ${hit}`);
      }
    }
    assertEquals(
      offenders,
      [],
      "Cross-repo-filed prompt bodies must not contain bare `#NNN` references " +
        "(they mislink to the target repo). Embed the context inline and drop " +
        "the number, or use a fully-qualified `owner/repo#NNN` reference:\n" +
        offenders.join("\n"),
    );
  },
);

Deno.test(
  "best-practices bucket guides carry no bare #NNN issue references",
  async () => {
    const offenders: string[] = [];
    for (const bucket of await bucketGuideNames()) {
      const body = await Deno.readTextFile(
        `${PROMPTS_DIR}/best_practices/buckets/${bucket}`,
      );
      for (const hit of findMatches(body, BARE_REF)) {
        offenders.push(`buckets/${bucket} ${hit}`);
      }
    }
    assertEquals(
      offenders,
      [],
      "Best-practices bucket guides are inlined into the cross-repo wrapper " +
        "body and must not contain bare `#NNN` references:\n" +
        offenders.join("\n"),
    );
  },
);

Deno.test(
  "cross-repo prompt bodies carry no VibeCoder-internal source paths",
  async () => {
    const offenders: string[] = [];
    for (const name of CROSS_REPO_PROMPT_NAMES) {
      const latest = await getLatestVersion(name, PROMPTS_DIR);
      assert(latest.ok, `no versions for ${name}`);
      if (!latest.ok) continue;
      const loaded = await loadPrompt(name, latest.value, PROMPTS_DIR);
      assert(loaded.ok, `failed to load ${name} ${latest.value}`);
      if (!loaded.ok) continue;
      for (const hit of findMatches(loaded.value, INTERNAL_PATH)) {
        offenders.push(`${name}/${latest.value}.md ${hit}`);
      }
    }
    assertEquals(
      offenders,
      [],
      "Cross-repo-filed prompt bodies must not cite VibeCoder-internal " +
        "`worker/deno/…` paths — they read as noise in any other repo. Reword " +
        "to describe the mechanism generically:\n" + offenders.join("\n"),
    );
  },
);
