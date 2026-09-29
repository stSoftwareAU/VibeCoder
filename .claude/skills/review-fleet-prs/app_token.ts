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
  const { slug } = await get("/app");
  const installation = pickInstallation(
    await get("/app/installations"),
    owners,
  );
  const { token } = await getInstallationToken(jwt, installation, fetchFn);
  return { token, login: `${slug}[bot]` };
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
