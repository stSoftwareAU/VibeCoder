/**
 * The review-fleet-prs skill can review as a GitHub App instead of the
 * signed-in gh user (`pr_reviewer_app` in .config.json). GitHub spells a bot's
 * login `slug[bot]` over REST but `slug` in GraphQL review authors, so the
 * gate must treat both as the reviewer, or it would review every PR again on
 * every pass.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  mintReviewerToken,
  missingPermissions,
  permissionError,
  pickInstallation,
  REQUIRED_PERMISSIONS,
  reviewerApp,
} from "../../../.claude/skills/review-fleet-prs/app_token.ts";
import { dependabotAction } from "../../../.claude/skills/review-fleet-prs/dependabot.ts";
import {
  reviewedAtHead,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/gate.ts";
import { sameLogin } from "../../../.claude/skills/review-fleet-prs/review_log.ts";

const BOT = "stsoftware-pr-reviewer[bot]";

Deno.test("sameLogin treats a bot's REST and GraphQL spellings as one login", () => {
  assertEquals(sameLogin("stsoftware-pr-reviewer", BOT), true);
  assertEquals(sameLogin(BOT, BOT), true);
  assertEquals(sameLogin("nleck", "nleck"), true);
  assertEquals(sameLogin("nleck", BOT), false);
  assertEquals(sameLogin(undefined, BOT), false);
});

Deno.test("reviewedAtHead counts the App's own approval at the head commit", () => {
  const reviews = [{
    author: { login: "stsoftware-pr-reviewer" },
    state: "APPROVED",
    body: "",
    commit: { oid: "abc" },
  }];
  assertEquals(reviewedAtHead(reviews, BOT, "abc"), true);
  assertEquals(reviewedAtHead(reviews, BOT, "def"), false);
  assertEquals(reviewedAtHead(reviews, "nleck", "abc"), false);
});

Deno.test("dependabotAction arms auto-merge once the App has approved the head", () => {
  const pr = {
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    headRefOid: "abc",
    reviews: {
      nodes: [{
        author: { login: "stsoftware-pr-reviewer" },
        state: "APPROVED",
        body: "",
        commit: { oid: "abc" },
      }],
    },
    repository: { autoMergeAllowed: true, squashMergeAllowed: true },
  } as unknown as SearchPr;
  assertEquals(dependabotAction(pr, BOT, undefined).kind, "auto-merge");
});

Deno.test("reviewerApp reads pr_reviewer_app, and is null when it is not set", () => {
  assertEquals(reviewerApp({}), null);
  assertEquals(
    reviewerApp({
      pr_reviewer_app: { app_id: 5119297, private_key_path: "~/k.pem" },
    }),
    { app_id: "5119297", private_key_path: "~/k.pem" },
  );
  assertThrows(() => reviewerApp({ pr_reviewer_app: { app_id: 1 } }));
  assertThrows(() => reviewerApp({ pr_reviewer_app: "5119297" }));
});

Deno.test("pickInstallation takes the installation on the monitored repos' owner", () => {
  const list = [
    { id: 1, account: { login: "someone-else" } },
    { id: 2, account: { login: "stSoftwareAU" } },
  ];
  assertEquals(pickInstallation(list, ["stsoftwareau"]), "2");
  assertEquals(pickInstallation(list.slice(0, 1), ["stSoftwareAU"]), "1");
  assertThrows(() => pickInstallation(list, ["nobody"]));
  assertThrows(() => pickInstallation([], ["stSoftwareAU"]));
});

async function testKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

Deno.test("mintReviewerToken returns the installation token and the App's bot login", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/k.pem`, await testKeyPem());
  const calls: string[] = [];
  const fetchFn = (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.endsWith("/app")) {
      return json(200, { slug: "stsoftware-pr-reviewer" });
    }
    if (url.endsWith("/app/installations")) {
      return json(200, [{ id: 42, account: { login: "stSoftwareAU" } }]);
    }
    if (url.endsWith("/app/installations/42/access_tokens")) {
      return json(201, {
        token: "ghs_x",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: {
          pull_requests: "write",
          issues: "write",
          contents: "write",
          workflows: "write",
          checks: "read",
          statuses: "read",
        },
      });
    }
    return json(404, {});
  };
  const minted = await mintReviewerToken(
    { app_id: "5119297", private_key_path: `${dir}/k.pem` },
    ["stSoftwareAU"],
    fetchFn,
  );
  assertEquals(minted, { token: "ghs_x", login: BOT });
  assertEquals(
    calls.at(-1),
    "POST https://api.github.com/app/installations/42/access_tokens",
  );
});

Deno.test("mintReviewerToken fails rather than falling back when GitHub refuses the App", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/k.pem`, await testKeyPem());
  const fetchFn = () =>
    Promise.resolve(
      new Response('{"message":"Bad credentials"}', { status: 401 }),
    );
  await assertRejects(() =>
    mintReviewerToken(
      { app_id: "5119297", private_key_path: `${dir}/k.pem` },
      ["stSoftwareAU"],
      fetchFn,
    )
  );
});

Deno.test("missingPermissions reports absent and under-scoped permissions", () => {
  const required = { contents: "write", checks: "read" } as const;
  assertEquals(
    missingPermissions({ contents: "write", checks: "read" }, required),
    [],
  );
  assertEquals(
    missingPermissions({ contents: "read", checks: "read" }, required),
    ["contents"],
  );
  assertEquals(
    missingPermissions({ checks: "read" }, required),
    ["contents"],
  );
  assertEquals(
    missingPermissions({ contents: "admin", checks: "write" }, required),
    [],
  );
  assertEquals(missingPermissions(undefined, required), [
    "contents",
    "checks",
  ]);
});

Deno.test("permissionError names every missing permission in one message", () => {
  const msg = permissionError({
    missing: ["contents", "checks"],
    appPermissions: { contents: "write", checks: "read" },
    slug: "stsoftware-pr-reviewer",
  });
  assertStringIncludes(msg, "contents: write");
  assertStringIncludes(msg, "checks: read");
});

Deno.test("mintReviewerToken rejects naming a missing permission the installation has not accepted", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/k.pem`, await testKeyPem());
  const fetchFn = (input: string | URL) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.endsWith("/app")) {
      return json(200, {
        slug: "stsoftware-pr-reviewer",
        owner: { login: "stSoftwareAU", type: "Organization" },
        permissions: { ...REQUIRED_PERMISSIONS },
      });
    }
    if (url.endsWith("/app/installations")) {
      return json(200, [{
        id: 42,
        account: { login: "stSoftwareAU" },
        html_url:
          "https://github.com/organizations/stSoftwareAU/settings/installations/42",
      }]);
    }
    if (url.endsWith("/app/installations/42/access_tokens")) {
      return json(201, {
        token: "ghs_x",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: { ...REQUIRED_PERMISSIONS, contents: "read" },
      });
    }
    return json(404, {});
  };
  const err = await assertRejects(() =>
    mintReviewerToken(
      { app_id: "5119297", private_key_path: `${dir}/k.pem` },
      ["stSoftwareAU"],
      fetchFn,
    )
  );
  assertStringIncludes((err as Error).message, "contents");
  assertStringIncludes((err as Error).message, "accept the new permissions");
  assertStringIncludes(
    (err as Error).message,
    "https://github.com/organizations/stSoftwareAU/settings/installations/42",
  );
});

Deno.test("mintReviewerToken rejects naming a permission the App itself lacks, with the settings URL", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/k.pem`, await testKeyPem());
  const appPermissions = { ...REQUIRED_PERMISSIONS } as Record<string, string>;
  delete appPermissions.contents;
  const fetchFn = (input: string | URL) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.endsWith("/app")) {
      return json(200, {
        slug: "stsoftware-pr-reviewer",
        owner: { login: "stSoftwareAU", type: "Organization" },
        permissions: appPermissions,
      });
    }
    if (url.endsWith("/app/installations")) {
      return json(200, [{ id: 42, account: { login: "stSoftwareAU" } }]);
    }
    if (url.endsWith("/app/installations/42/access_tokens")) {
      const tokenPermissions = { ...appPermissions };
      return json(201, {
        token: "ghs_x",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: tokenPermissions,
      });
    }
    return json(404, {});
  };
  const err = await assertRejects(() =>
    mintReviewerToken(
      { app_id: "5119297", private_key_path: `${dir}/k.pem` },
      ["stSoftwareAU"],
      fetchFn,
    )
  );
  assertStringIncludes((err as Error).message, "contents");
  assertStringIncludes(
    (err as Error).message,
    "https://github.com/organizations/stSoftwareAU/settings/apps/stsoftware-pr-reviewer/permissions",
  );
  const msg = (err as Error).message;
  if (msg.includes("accept the new permissions")) {
    throw new Error(
      `expected no "accept the new permissions" clause when the App itself lacks the permission, got: ${msg}`,
    );
  }
});

Deno.test("permissionError lists several missing permissions in one message", () => {
  const msg = permissionError({
    missing: ["contents", "workflows", "checks"],
    appPermissions: {
      pull_requests: "write",
      issues: "write",
      contents: "read",
      workflows: "read",
      checks: "read",
      statuses: "read",
    },
    slug: "stsoftware-pr-reviewer",
  });
  // contents/workflows are under-scoped on the App itself; checks only awaits acceptance.
  assertStringIncludes(msg, "Grant contents: write, workflows: write");
  assertStringIncludes(msg, "The App has checks: read but the installation");
  assertStringIncludes(msg, "accept the new permissions");
});
