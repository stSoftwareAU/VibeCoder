/**
 * Tests for the CODEOWNERS parser and the committed `.github/CODEOWNERS`
 * coverage (Issue #2606): the ruleset's `require_code_owner_review` is a
 * no-op unless the privileged paths name a human owner.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ownersForPath, parseCodeowners } from "../lib/codeowners.ts";

const CODEOWNERS_PATH = new URL("../../../.github/CODEOWNERS", import.meta.url)
  .pathname;

/** Worker bot identities that must never satisfy code-owner review. */
const BOT_OWNERS = ["@stservice", "@vibecoderst"];

Deno.test("parseCodeowners - skips comments and blank lines", () => {
  const rules = parseCodeowners(
    "# header\n\n/.github/ @alice  # trailing note\n   \n",
  );
  assertEquals(rules, [{ pattern: "/.github/", owners: ["@alice"], line: 3 }]);
});

Deno.test("parseCodeowners - accepts users, teams and emails", () => {
  const rules = parseCodeowners("*.ts @alice @org/team-a dev@example.com\n");
  assertEquals(rules[0]?.owners, ["@alice", "@org/team-a", "dev@example.com"]);
});

Deno.test("parseCodeowners - rejects a malformed owner loudly", () => {
  assertThrows(
    () => parseCodeowners("/infra/ @alice not-an-owner\n"),
    Error,
    "line 1",
  );
});

Deno.test("parseCodeowners - empty input yields no rules", () => {
  assertEquals(parseCodeowners(""), []);
});

Deno.test("ownersForPath - anchored directory matches nested files only", () => {
  const rules = parseCodeowners("/.github/workflows/ @alice\n");
  assertEquals(ownersForPath(rules, ".github/workflows/ci.yml"), ["@alice"]);
  assertEquals(ownersForPath(rules, ".github/workflows/sub/a.yml"), ["@alice"]);
  assertEquals(ownersForPath(rules, "src/.github/workflows/ci.yml"), []);
});

Deno.test("ownersForPath - unanchored glob matches at any depth", () => {
  const rules = parseCodeowners("*.md @docs\n");
  assertEquals(ownersForPath(rules, "README.md"), ["@docs"]);
  assertEquals(ownersForPath(rules, "docs/a/b.md"), ["@docs"]);
  assertEquals(ownersForPath(rules, "docs/a/b.mdx"), []);
});

Deno.test("ownersForPath - last matching rule wins", () => {
  const rules = parseCodeowners("* @everyone\n/infra/ @ops\n");
  assertEquals(ownersForPath(rules, "infra/rulesets/main.json"), ["@ops"]);
  assertEquals(ownersForPath(rules, "src/a.ts"), ["@everyone"]);
});

Deno.test("ownersForPath - an owner-less rule clears ownership", () => {
  const rules = parseCodeowners("/docs/ @docs\n/docs/archive/\n");
  assertEquals(ownersForPath(rules, "docs/archive/x.md"), []);
});

Deno.test("committed CODEOWNERS - privileged paths have human owners, no bots", async () => {
  const rules = parseCodeowners(await Deno.readTextFile(CODEOWNERS_PATH));
  const privileged = [
    ".github/workflows/gate.yml",
    ".github/actions/setup/action.yml",
    ".github/scripts/gate.sh",
    ".github/CODEOWNERS",
    "infra/rulesets/main.json",
  ];
  for (const path of privileged) {
    const owners = ownersForPath(rules, path);
    assertEquals(owners.length > 0, true, `${path} has no code owner`);
    const bots = owners.filter((o) => BOT_OWNERS.includes(o.toLowerCase()));
    assertEquals(bots, [], `${path} is owned by a bot identity`);
  }
});
