/**
 * Which logins may never author a suppression (Issues #334, #338).
 *
 * #334 excluded `github_user ∪ fleet_pr_authors` and left the fourth
 * `resolveFleetAuthors` argument unset, so `service_accounts` were not
 * excluded. Issue #209 records siblings being configured under
 * `service_accounts` alone, and hosts in this fleet run under **different git
 * users** — so such a login was excluded on its own host and nowhere else,
 * while the `[fleet-config]` validator pushed it into `allowed_authors`, which
 * is what feeds the suppression allowlist.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveSuppressionExcludedLogins } from "../lib/fleet_authors.ts";

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort();

Deno.test("#338 - a sibling listed only under service_accounts is excluded", () => {
  // The regression: `vibe-worker-3` appears in neither github_user nor
  // fleet_pr_authors on this host, which is the whole point of the fix.
  const excluded = resolveSuppressionExcludedLogins({
    githubUser: "VibeCoderST",
    fleetPrAuthors: ["VibeCoderST"],
    serviceAccounts: ["stservice", "vibe-worker-3"],
  });
  assertEquals(
    lower(excluded),
    lower(["VibeCoderST", "stservice", "vibe-worker-3"]),
  );
});

Deno.test("#338 - a sibling running under a different git user is excluded here too", () => {
  // Host A's own login is VibeCoderST; host B runs as stservice. Host A must
  // still refuse a suppression authored by stservice.
  const onHostA = resolveSuppressionExcludedLogins({
    githubUser: "VibeCoderST",
    fleetPrAuthors: ["stservice"],
    serviceAccounts: [],
  });
  assert(lower(onHostA).includes("stservice"));
  assert(lower(onHostA).includes("vibecoderst"));
});

Deno.test("#334 - the host's own login is always excluded", () => {
  const excluded = resolveSuppressionExcludedLogins({
    githubUser: "VibeCoderST",
  });
  assertEquals(lower(excluded), ["vibecoderst"]);
});

Deno.test("#338 - allowed_authors is never folded in", () => {
  // The #3426 trap: humans in allowed_authors legitimately suppress, and
  // excluding them would silence real waivers. There is deliberately no
  // parameter for them.
  const excluded = resolveSuppressionExcludedLogins({
    githubUser: "VibeCoderST",
    fleetPrAuthors: ["stservice"],
    serviceAccounts: ["stservice"],
  });
  assert(
    !lower(excluded).includes("nleck"),
    `a human must not be excluded; got ${excluded.join(",")}`,
  );
});

Deno.test("#338 - duplicates across the two lists collapse", () => {
  const excluded = resolveSuppressionExcludedLogins({
    githubUser: "VibeCoderST",
    fleetPrAuthors: ["VibeCoderST", "stservice"],
    serviceAccounts: ["VibeCoderST", "stservice"],
  });
  assertEquals(excluded.length, 2, excluded.join(","));
});

Deno.test("#338 - absent lists are not an error", () => {
  assertEquals(
    lower(resolveSuppressionExcludedLogins({
      githubUser: "VibeCoderST",
      fleetPrAuthors: undefined,
      serviceAccounts: undefined,
    })),
    ["vibecoderst"],
  );
});
