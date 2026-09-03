/**
 * Issue #791: `security_scan` must create its labels defensively.
 *
 * The scan's exit check requires every filed issue to carry `security`,
 * exactly one `severity:*` and exactly one `confidence:*`. Monitored repos are
 * not pre-seeded with content labels (`content_label_definitions.ts`, Issue
 * #368) and `label_colour_reconcile.ts` only repaints labels that already
 * exist — so on a repo carrying none of them `gh issue create --label` fails
 * on an unknown label and the run files nothing.
 *
 * Twelve sibling scan templates carry a `### Defensive label creation`
 * section for exactly this case. `security_scan/v31`'s exclusive `gh`
 * allowlist omitted `gh label create` entirely, forbidding the one call that
 * would fix it. v32 adds the permission and the section.
 *
 * These tests read whatever version resolves, so a later version that drops
 * the permission or a label fails here rather than silently regressing to a
 * scan that cannot file on a fresh repo.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { CONTENT_LABEL_DEFINITIONS } from "../setup/content_label_definitions.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Every label `security_scan`'s filer may attach, per its required label set. */
const FILER_LABELS = [
  "security",
  "severity:critical",
  "severity:high",
  "severity:medium",
  "severity:low",
  "confidence:high",
  "confidence:medium",
  "confidence:low",
  "security-scan-overflow",
] as const;

async function latestSecurityScan(): Promise<string> {
  const result = await loadPrompt("security_scan", undefined, PROMPTS_DIR);
  assert(result.ok, "security_scan prompt failed to load");
  return result.value;
}

/** The prompt with wrapping collapsed, for matching sentences across lines. */
const flatten = (text: string) => text.replace(/\s+/g, " ");

Deno.test("security_scan - the gh allowlist permits defensive label creation (Issue #791)", async () => {
  const flat = flatten(await latestSecurityScan());
  const allowlist = flat.match(/The only permitted `gh` calls are[^.]*\./);
  assert(allowlist, "could not find the exclusive gh allowlist sentence");
  assert(
    allowlist[0].includes("`gh label create`"),
    "the allowlist is exclusive, so omitting `gh label create` forbids it:\n" +
      allowlist[0],
  );
});

Deno.test("security_scan - carries a defensive label creation section (Issue #791)", async () => {
  const text = await latestSecurityScan();
  assert(
    text.includes("### Defensive label creation"),
    "security_scan must carry the family's defensive-creation section",
  );
});

Deno.test("security_scan - defensively creates every label its filer may attach (Issue #791)", async () => {
  const flat = flatten(await latestSecurityScan());
  const missing = FILER_LABELS.filter(
    (label) => !flat.includes(`gh label create ${label} `),
  );
  assertEquals(
    missing,
    [],
    "these labels are attached by the filer but never created defensively, " +
      "so filing fails on a repo without them: " + missing.join(", "),
  );
});

Deno.test("security_scan - defensive creation uses the canonical colour and description (Issue #791)", async () => {
  const flat = flatten(await latestSecurityScan());
  const drift: string[] = [];
  for (const label of FILER_LABELS) {
    const canonical = CONTENT_LABEL_DEFINITIONS.find((d) => d.name === label);
    assert(canonical, `${label} is missing from CONTENT_LABEL_DEFINITIONS`);
    const line = flat.match(
      new RegExp(
        `gh label create ${label.replace(":", ":")}\\s[^|]*\\|\\| true`,
      ),
    );
    assert(line, `no defensive creation line for ${label}`);
    if (!line[0].includes(canonical.colour)) {
      drift.push(`${label}: colour should be ${canonical.colour}`);
    }
    if (!line[0].includes(canonical.description)) {
      drift.push(`${label}: description should be "${canonical.description}"`);
    }
  }
  assertEquals(
    drift,
    [],
    "a non-canonical colour or description leaves work for the colour " +
      "reconcile pass:\n" + drift.join("\n"),
  );
});

Deno.test("security_scan - every defensive creation tolerates an existing label (Issue #791)", async () => {
  const text = await latestSecurityScan();
  const lines = text.split("\n").filter((l) => l.includes("gh label create "));
  assert(lines.length >= FILER_LABELS.length, "expected one line per label");
  const unguarded = lines.filter((l) => !l.trimEnd().endsWith("|| true"));
  assertEquals(
    unguarded,
    [],
    "without `|| true` an already-existing label aborts the run:\n" +
      unguarded.join("\n"),
  );
});

Deno.test("security_scan - the resolved version declares its own number in the H1 (Issue #791)", async () => {
  const latest = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(latest.ok, "could not resolve the latest security_scan version");
  const h1 = (await latestSecurityScan()).split("\n")[0] ?? "";
  assert(
    h1.includes(`(${latest.value})`),
    `H1 must declare ${latest.value}, got: ${h1}`,
  );
});
