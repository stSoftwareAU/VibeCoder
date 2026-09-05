/**
 * The built-in Actions provider claims only GitHub URLs, and never echoes a
 * caller's URL it has not verified.
 *
 * `parseActionsCheckUrl` used to read `new URL(url).pathname` and match on
 * the path alone, so `https://attacker.example/o/r/actions/runs/1/job/2`
 * parsed as a job. The provider then claimed the check and returned the
 * attacker's string as the log's `url`, which is rendered into the CI-fix
 * prompt. The excerpt itself was always fetched through `gh api` against real
 * GitHub, so nothing was ever read from the foreign host — what leaked was an
 * attacker-chosen string into a prompt, and a false account of the log's
 * origin.
 *
 * The input is untrusted by the codebase's own reckoning: `ci_failure_issue.ts`
 * opens with "The issue body is untrusted input", and the `Build URL` it
 * parses arrives here as `targetUrl`.
 *
 * Both directions are asserted. A provider that claims nothing is as broken
 * as one that claims everything, so the legitimate cases are pinned beside
 * the hostile ones.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  isGithubHost,
  parseActionsCheckUrl,
} from "../lib/github_actions_log_fetcher.ts";
import { actionsUrlForRepo } from "../lib/ci_provider_github_actions.ts";

const REPO = "owner/repo";

Deno.test("parseActionsCheckUrl - a foreign host with an Actions-shaped path is not claimed", () => {
  for (
    const hostile of [
      "https://attacker.example/owner/repo/actions/runs/1/job/2",
      "http://attacker.example/owner/repo/actions/runs/1",
      "https://github.com.attacker.example/owner/repo/actions/runs/1",
      "https://notgithub.com/owner/repo/actions/runs/1/jobs/2",
    ]
  ) {
    assertEquals(
      parseActionsCheckUrl(hostile).kind,
      "other",
      `must not claim ${hostile}`,
    );
  }
});

// An origin that cannot be established is not one that can be trusted, and
// GitHub's own `details_url` is always absolute.
Deno.test("parseActionsCheckUrl - a relative path carries no origin and is not claimed", () => {
  assertEquals(
    parseActionsCheckUrl("/owner/repo/actions/runs/1/job/2").kind,
    "other",
  );
  assertEquals(parseActionsCheckUrl("owner/repo/actions/runs/1").kind, "other");
});

Deno.test("parseActionsCheckUrl - genuine GitHub Actions URLs are still parsed", () => {
  assertEquals(
    parseActionsCheckUrl("https://github.com/owner/repo/actions/runs/7/job/9"),
    { kind: "job", runId: 7, jobId: 9 },
  );
  assertEquals(
    parseActionsCheckUrl("https://github.com/owner/repo/actions/runs/7/jobs/9"),
    { kind: "job", runId: 7, jobId: 9 },
  );
  assertEquals(
    parseActionsCheckUrl("https://github.com/owner/repo/actions/runs/7"),
    { kind: "run", runId: 7 },
  );
  assertEquals(
    parseActionsCheckUrl("https://WWW.GitHub.com/owner/repo/actions/runs/7"),
    { kind: "run", runId: 7 },
  );
});

Deno.test("isGithubHost - matches the GitHub hosts case-insensitively and nothing else", () => {
  for (const host of ["github.com", "GitHub.com", "www.github.com"]) {
    assertEquals(isGithubHost(host), true, host);
  }
  for (
    const host of [
      "attacker.example",
      "github.com.attacker.example",
      "ghe.internal",
      "",
    ]
  ) {
    assertEquals(isGithubHost(host), false, host);
  }
});

// The URL is rendered into the CI-fix prompt, so an unverified value must
// never reach it — the caller falls back to one it builds itself.
Deno.test("actionsUrlForRepo - refuses a URL it cannot verify", () => {
  for (
    const hostile of [
      "https://attacker.example/owner/repo/actions/runs/1/job/2",
      "/owner/repo/actions/runs/1",
      "not a url at all",
      "",
    ]
  ) {
    assertEquals(
      actionsUrlForRepo(hostile, REPO),
      undefined,
      `must refuse ${JSON.stringify(hostile)}`,
    );
  }
  assertEquals(actionsUrlForRepo(undefined, REPO), undefined);
});

// A valid github.com Actions URL for somebody else's repository must not be
// presented as the source of this repository's log.
Deno.test("actionsUrlForRepo - refuses a GitHub URL for a different repository", () => {
  assertEquals(
    actionsUrlForRepo(
      "https://github.com/someone/else/actions/runs/1/job/2",
      REPO,
    ),
    undefined,
  );
  // A path that merely starts with the same characters is not the same repo.
  assertEquals(
    actionsUrlForRepo(
      "https://github.com/owner/repo-other/actions/runs/1",
      REPO,
    ),
    undefined,
  );
});

Deno.test("actionsUrlForRepo - accepts this repository's own Actions URL", () => {
  const good = "https://github.com/owner/repo/actions/runs/7/job/9";
  assertEquals(actionsUrlForRepo(good, REPO), good);
});
