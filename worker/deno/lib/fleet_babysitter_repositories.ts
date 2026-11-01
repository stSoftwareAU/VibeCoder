/** Discover the installation's accessible subset without changing fleet config. */
import type { FetchFn } from "./github_app_auth.ts";
import { fetchWithTimeout } from "./subprocess_timeout.ts";

interface Installation {
  id: number;
  account?: { login?: string };
}

/** Select one installation, even when the fleet monitors several owners. */
export function selectBabysitterInstallation(
  installations: Installation[],
  repositories: readonly string[],
  requestedId?: string,
): Installation {
  const owners = new Set(
    repositories.map((repo) => repo.split("/")[0]!.toLowerCase()),
  );
  const matching = installations.filter((item) =>
    Number.isSafeInteger(item.id) && item.id > 0 &&
    typeof item.account?.login === "string" &&
    owners.has(item.account.login.toLowerCase()) &&
    (requestedId === undefined || String(item.id) === requestedId)
  );
  if (matching.length !== 1) {
    throw new Error(
      "Could not find exactly one App installation for the monitored repository owners; install the App or specify --installation-id",
    );
  }
  return matching[0]!;
}

/** Read the complete installation list; API errors never mean missing access. */
export async function listBabysitterRepositories(
  token: string,
  fetchFn: FetchFn = fetchWithTimeout,
): Promise<Set<string>> {
  const accessible = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const response = await fetchFn(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "fleet-pr-babysitter",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `App repository access check failed: HTTP ${response.status}`,
      );
    }
    const body = await response.json();
    if (
      !body || !Array.isArray(body.repositories) ||
      !Number.isSafeInteger(body.total_count) || body.total_count < 0
    ) {
      throw new Error("App repository access response was malformed");
    }
    expectedTotal ??= body.total_count;
    if (expectedTotal !== body.total_count) {
      throw new Error("App repository access changed during pagination; retry");
    }
    for (const repo of body.repositories) {
      if (
        !repo || typeof repo.full_name !== "string" ||
        !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)
      ) {
        throw new Error(
          "App repository access response was malformed: expected full_name",
        );
      }
      accessible.add(repo.full_name.toLowerCase());
    }
    if (accessible.size === expectedTotal) return accessible;
    if (
      (expectedTotal !== undefined && accessible.size > expectedTotal) ||
      body.repositories.length === 0
    ) {
      break;
    }
  }
  throw new Error("App repository access list was incomplete or inconsistent");
}

/** Preserve configured names/order, but never scan or mint for inaccessible repos. */
export function selectBabysitterRepositories(
  configured: readonly string[],
  accessible: ReadonlySet<string>,
  requestedRepo?: string,
  log: (message: string) => void = console.log,
): string[] {
  if (requestedRepo && !configured.includes(requestedRepo)) {
    throw new Error(
      `Repository ${requestedRepo} is not monitored by this host`,
    );
  }
  const selected = configured.filter((repo) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`Invalid repository: ${repo}`);
    }
    if (accessible.has(repo.toLowerCase())) return true;
    log(`Skipping ${repo}: not accessible to the babysitter App installation.`);
    return false;
  });
  if (requestedRepo && !selected.includes(requestedRepo)) {
    throw new Error(
      `Requested repository ${requestedRepo} is not accessible to the babysitter App installation`,
    );
  }
  if (!selected.length) {
    throw new Error(
      "No configured repositories are accessible to the babysitter App installation",
    );
  }
  return requestedRepo ? [requestedRepo] : selected;
}
