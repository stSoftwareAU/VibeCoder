/**
 * Tests for `formatPrFailureActionsExcerpt` (Issues #1893, #3579).
 *
 * Verifies the Markdown excerpt formatter renders the build header
 * (number, URL, status) plus the log tail, and truncates oversized
 * excerpts at the configured byte cap while preserving the tail.
 */

import { assert, assertEquals } from "@std/assert";
import {
  formatPrFailureActionsExcerpt,
  MAX_PR_FAILURE_ACTION_EXCERPT_BYTES,
  type PrFailureActionResult,
} from "../lib/pr_failure_actions.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import type { CiLogExcerpt } from "../lib/ci_log_provider.ts";

function makeExcerpt(overrides: Partial<CiLogExcerpt> = {}): CiLogExcerpt {
  return {
    providerId: "example-ci",
    buildId: "123",
    url: "https://ci.example.com/job/foo/job/Develop/123/",
    status: "FAILURE",
    logText: "log body",
    ...overrides,
  };
}

Deno.test("formatPrFailureActionsExcerpt - empty input returns empty string", () => {
  assertEquals(formatPrFailureActionsExcerpt([]), "");
});

Deno.test("formatPrFailureActionsExcerpt - all-failure input returns empty string", () => {
  const results: PrFailureActionResult[] = [
    { providerId: "example-ci", ok: false, error: "no matching check" },
    { providerId: "example-ci", ok: false, error: "404 Not Found" },
  ];
  assertEquals(formatPrFailureActionsExcerpt(results), "");
});

Deno.test("formatPrFailureActionsExcerpt - renders build header and log tail", () => {
  const results: PrFailureActionResult[] = [
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({
        logText: "Started by user\nBuilding\nERROR: oh no\n",
      }),
    },
  ];
  const out = formatPrFailureActionsExcerpt(results);
  assert(out.startsWith("## PR Failure Action Output"), out.slice(0, 80));
  assert(out.includes("### example-ci build #123"));
  assert(
    out.includes(
      "**Build URL:** https://ci.example.com/job/foo/job/Develop/123/",
    ),
  );
  assert(out.includes("**Status:** FAILURE"));
  assert(out.includes("ERROR: oh no"));
  assert(out.includes("```"));
});

Deno.test("formatPrFailureActionsExcerpt - drops failed entries among successes", () => {
  const results: PrFailureActionResult[] = [
    { providerId: "example-ci", ok: false, error: "skip me" },
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ buildId: "7", logText: "build 7 log" }),
    },
  ];
  const out = formatPrFailureActionsExcerpt(results);
  assert(out.includes("example-ci build #7"));
  assert(!out.includes("skip me"));
});

Deno.test("formatPrFailureActionsExcerpt - truncates log tail at byte cap", () => {
  // Build a log just over the cap with a unique tail so we can confirm
  // the **end** of the string is preserved, not the start.
  const cap = 1024;
  const filler = "x".repeat(cap + 500);
  const tailMarker = "==TAIL_MARKER==";
  const log = filler + tailMarker;

  const results: PrFailureActionResult[] = [
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ logText: log }),
    },
  ];
  const out = formatPrFailureActionsExcerpt(results, cap);

  assert(out.includes(tailMarker), "tail must be preserved");
  assert(out.includes("[...truncated"), "truncation marker must be present");

  // Sanity check the default cap is wired through: 16 KiB log fits under
  // the default cap and is rendered verbatim with no truncation marker.
  const small = "x".repeat(MAX_PR_FAILURE_ACTION_EXCERPT_BYTES - 1024);
  const smallOut = formatPrFailureActionsExcerpt([
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ logText: small }),
    },
  ]);
  assert(!smallOut.includes("[...truncated"));
});

Deno.test("formatPrFailureActionsExcerpt - redacts secrets echoed by the build log", () => {
  // Issue #3871: the PR-failure path rendered the fetched console log with
  // truncation only, so a credential echoed by a build step reached the prompt
  // verbatim and was quotable back into a public PR comment.
  const token = `ghp_${"A".repeat(36)}`;
  const log = [
    "+ git clone https://vibe-coder:s3cr3t-token-value@github.com/acme/app.git",
    `+ curl -H 'Authorization: Bearer ${token}' https://api.example.com`,
    "+ export FOO_TOKEN=super-secret-value-1234",
    "ERROR: build failed",
  ].join("\n");

  const out = formatPrFailureActionsExcerpt([
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ logText: log }),
    },
  ]);

  assert(!out.includes(token), "bare GitHub token must not survive");
  assert(
    !out.includes("s3cr3t-token-value"),
    "URL credential must not survive",
  );
  assert(
    !out.includes("super-secret-value-1234"),
    "assigned secret must not survive",
  );
  assert(out.includes(REDACTION_PLACEHOLDER), "redaction must be visible");
  // Non-secret diagnostic content still reaches the prompt.
  assert(out.includes("ERROR: build failed"));
  assert(out.includes("github.com/acme/app.git"));
});

Deno.test("formatPrFailureActionsExcerpt - redaction runs after the byte cap", () => {
  // Truncation must apply to the raw log so the cap stays honest, and the
  // secret in the surviving tail must still be masked.
  const cap = 256;
  const log = "x".repeat(cap * 2) +
    "\n+ export FOO_TOKEN=super-secret-value-1234\nERROR: done";

  const out = formatPrFailureActionsExcerpt(
    [{
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ logText: log }),
    }],
    cap,
  );

  assert(out.includes("[...truncated"), "truncation marker must be present");
  assert(!out.includes("super-secret-value-1234"), "secret must not survive");
});

Deno.test("formatPrFailureActionsExcerpt - fence cannot be closed by backticks in the log", () => {
  // A log line of its own triple backticks must not close the fence early and
  // let the remainder render as markdown structure.
  const log = "start\n```\n## Injected heading\nERROR: end";

  const out = formatPrFailureActionsExcerpt([
    {
      providerId: "example-ci",
      ok: true,
      excerpt: makeExcerpt({ logText: log }),
    },
  ]);

  const fenceMatch = out.match(/\nConsole log tail:\n\n(`{3,})\n/);
  assert(fenceMatch, `expected an opening fence, got: ${out}`);
  const fence = fenceMatch[1] ?? "";
  assert(
    fence.length > 3,
    `fence must be longer than the log's own backtick run, got ${fence.length}`,
  );
  assert(out.endsWith(`\n${fence}`), "excerpt must close with the same fence");
  assert(out.includes("## Injected heading"), "log content is preserved");
});
