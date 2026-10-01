// Mints a GitHub App installation token for the reviewer, so reviews post as
// the App's bot rather than the signed-in gh user. Reads `pr_reviewer_app`
// from .config.json ({ app_id, private_key_path }) and prints
// `{ token, login }`; prints nothing when the key is not set, so the skill
// keeps using the gh user.
//
// Deliberately separate from the worker's own `github_app_*` keys: the
// reviewer must never be the account that authored the PR, or GitHub refuses
// the approval.
//
// Tokens last an hour, so run.sh mints a fresh one for every gate pass and
// review round. A failure exits non-zero and is never quietly replaced by the
// gh user's identity.
//
//   deno run --allow-read --allow-net=api.github.com --allow-env app_token.ts

import {
  type FetchFn,
  generateAppJWT,
  getInstallationToken,
} from "../../../worker/deno/lib/github_app_auth.ts";

const DEFAULT_CONFIG = new URL("../../../.config.json", import.meta.url);
const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;

export interface ReviewerApp {
  app_id: string;
  private_key_path: string;
}

export interface Installation {
  id: number;
  account: { login: string } | null;
  /** Installation settings page — where an owner accepts new permissions. */
  html_url?: string;
}

/**
 * Permissions the review-fleet-prs skill needs on the reviewer App's token.
 *
 * Issue #2892: a token minted without one of these fails some later API call
 * in a way that is easy to mistake for a flaky run rather than a missing
 * grant, so the permissions are checked — and reported together — right when
 * the token is minted.
 */
export const REQUIRED_PERMISSIONS = {
  pull_requests: "write",
  issues: "write",
  contents: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
} as const;

/** Permission levels ordered from least to most access. */
const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether a granted level satisfies a required level ("write" covers "read"). */
function satisfies(granted: string | undefined, required: string): boolean {
  if (granted === undefined) return false;
  const grantedRank = LEVEL_RANK[granted] ?? 0;
  const requiredRank = LEVEL_RANK[required] ?? 0;
  return grantedRank >= requiredRank;
}

/**
 * Names, in order, of required permissions that `granted` does not meet —
 * either absent, or scoped lower than required (e.g. "read" where "write" is
 * needed).
 */
export function missingPermissions(
  granted: Record<string, string> | undefined,
  required: Record<string, string> = REQUIRED_PERMISSIONS,
): string[] {
  const missing: string[] = [];
  for (const [name, level] of Object.entries(required)) {
    if (!satisfies(granted?.[name], level)) missing.push(name);
  }
  return missing;
}

/** Build the one message naming every missing permission and where to fix it. */
export function permissionError(opts: {
  missing: string[];
  appPermissions?: Record<string, string>;
  slug: string;
  ownerLogin?: string;
  ownerType?: string;
  installationUrl?: string;
}): string {
  const { missing, appPermissions, slug, ownerLogin, ownerType } = opts;
  const required: Record<string, string> = {};
  for (const name of missing) {
    required[name] =
      REQUIRED_PERMISSIONS[name as keyof typeof REQUIRED_PERMISSIONS] ??
        "read";
  }
  const levels = (names: string[]) =>
    names.map((name) => `${name}: ${required[name]}`).join(", ");
  const list = levels(missing);

  // Split the missing permissions: the App itself may lack the grant, or the
  // App may have it but this installation has not accepted it yet. Each needs
  // a different fix, so each gets its own clause.
  const appMissing = missingPermissions(appPermissions, required);
  const appMissingSet = new Set(appMissing);
  const installationMissing = missing.filter((name) =>
    !appMissingSet.has(name)
  );

  const parts: string[] = [
    `the reviewer App token lacks ${list}.`,
  ];

  if (appMissing.length > 0) {
    const settingsUrl = ownerType === "Organization"
      ? `https://github.com/organizations/${ownerLogin}/settings/apps/${slug}/permissions`
      : `https://github.com/settings/apps/${slug}/permissions`;
    parts.push(`Grant ${levels(appMissing)} at ${settingsUrl}.`);
  }

  if (installationMissing.length > 0) {
    parts.push(
      `The App has ${
        levels(installationMissing)
      } but the installation has not accepted them: accept the new permissions at ${
        opts.installationUrl ?? "the installation settings page"
      }.`,
    );
  }

  return parts.join(" ");
}

export function reviewerApp(
  config: Record<string, unknown>,
): ReviewerApp | null {
  const app = config.pr_reviewer_app;
  if (app === undefined || app === null) return null;
  const { app_id, private_key_path } = (app ?? {}) as Record<string, unknown>;
  const id = typeof app_id === "number" ? String(app_id) : app_id;
  if (
    typeof app !== "object" || typeof id !== "string" || id.trim() === "" ||
    typeof private_key_path !== "string" || private_key_path.trim() === ""
  ) {
    throw new Error(
      "pr_reviewer_app needs an app_id and a private_key_path",
    );
  }
  return { app_id: id, private_key_path };
}

// The App's installation on the owner of the monitored repos. An App that is
// installed on one account only needs no match.
export function pickInstallation(
  installations: Installation[],
  owners: string[],
): string {
  const wanted = new Set(owners.map((o) => o.toLowerCase()));
  const hit =
    installations.find((i) =>
      wanted.has(i.account?.login.toLowerCase() ?? "")
    ) ?? (installations.length === 1 ? installations[0] : undefined);
  if (!hit) {
    throw new Error(
      `the reviewer App is not installed on ${[...wanted].join(", ")}`,
    );
  }
  return String(hit.id);
}

function expandHome(path: string): string {
  return path.startsWith("~/")
    ? `${Deno.env.get("HOME")}${path.slice(1)}`
    : path;
}

export async function mintReviewerToken(
  app: ReviewerApp,
  owners: string[],
  fetchFn: FetchFn = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
): Promise<{ token: string; login: string }> {
  const pem = await Deno.readTextFile(expandHome(app.private_key_path));
  const jwt = await generateAppJWT(app.app_id, pem);
  const get = async (path: string) => {
    const res = await fetchFn(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${path}`);
    return await res.json();
  };
  const appInfo = await get("/app") as {
    slug: string;
    owner?: { login?: string; type?: string };
    permissions?: Record<string, string>;
  };
  const installations = await get("/app/installations") as Installation[];
  const installationId = pickInstallation(installations, owners);
  const installation = installations.find((i) =>
    String(i.id) === installationId
  );
  const token = await getInstallationToken(jwt, installationId, fetchFn);
  const missing = missingPermissions(token.permissions);
  if (missing.length > 0) {
    throw new Error(
      permissionError({
        missing,
        appPermissions: appInfo.permissions,
        slug: appInfo.slug,
        ownerLogin: appInfo.owner?.login,
        ownerType: appInfo.owner?.type,
        installationUrl: installation?.html_url,
      }),
    );
  }
  return { token: token.token, login: `${appInfo.slug}[bot]` };
}

async function main() {
  const configArg = Deno.args.find((a) => a.startsWith("--config="));
  const config = JSON.parse(
    await Deno.readTextFile(configArg?.slice(9) ?? DEFAULT_CONFIG),
  );
  const app = reviewerApp(config);
  if (!app) return;
  const owners = [
    ...new Set((config.repos ?? []).map((r: string) => r.split("/")[0])),
  ] as string[];
  console.log(JSON.stringify(await mintReviewerToken(app, owners)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`reviewer App token: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
