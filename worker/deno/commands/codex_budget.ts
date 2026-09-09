/**
 * `codex-budget` — the opt-in live budget diagnostic (Issue #1697).
 *
 * Nothing in the worker runs this: an operator does, against a real
 * `CODEX_HOME`, to see what the budget adapter makes of that credential's
 * actual telemetry. It is the live half of the verification —
 * `lib/codex_budget_source.ts` records what the pinned CLI's sources *should*
 * look like, and this prints what one really contains.
 *
 * It is read-only and free: it reads rollout session files the CLI already
 * wrote and `auth.json`'s *shape*, and it never runs a Codex turn, so it
 * cannot consume the quota it is reporting on.
 *
 * Everything it prints is metadata — percentages, window durations, reset
 * instants, reason codes and the credential *kind*. No token, key, account id,
 * email or credit balance is read or rendered, and the whole message is passed
 * through {@link redactSecrets} before it is returned, so an unexpected value
 * cannot escape through it either.
 *
 * ```
 * deno run --allow-read --allow-env mod.ts codex-budget --codex-home ~/.codex
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import {
  CodexBudgetAdapter,
  type CodexBudgetSnapshot,
} from "../lib/codex_budget.ts";
import type { CodexBudgetWindow } from "../lib/codex_budget_source.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";
import type { Command, CommandResult, WorkerConfig } from "../types.ts";

/** Default `CODEX_HOME`, matching the Codex CLI's own default. */
export function defaultCodexHome(
  env: EnvLookup = processEnvLookup,
): string {
  const explicit = (env("CODEX_HOME") ?? "").trim();
  if (explicit.length > 0) return explicit;
  const home = (env("HOME") ?? "").trim();
  return home.length > 0 ? `${home}/.codex` : ".codex";
}

/** Render one window as a single metadata line. */
function describeWindow(window: CodexBudgetWindow): string {
  const parts = [
    `  ${window.window}: ${
      (window.remainingFraction * 100).toFixed(1)
    }% remaining (used ${window.usedPercent}%)`,
  ];
  if (window.windowMinutes !== undefined) {
    parts.push(`window=${window.windowMinutes}m`);
  }
  parts.push(
    window.resetAt !== undefined
      ? `resets=${new Date(window.resetAt).toISOString()}`
      : "resets=unknown",
  );
  return parts.join(" ");
}

/**
 * Render a snapshot as redacted, operator-facing metadata.
 *
 * @param snapshot - The snapshot to describe.
 * @param codexHome - The directory it was read from.
 * @returns Multi-line text carrying no credential value.
 */
export function describeCodexBudgetSnapshot(
  snapshot: CodexBudgetSnapshot,
  codexHome: string,
): string {
  const lines = [
    `Codex budget snapshot for CODEX_HOME=${codexHome}`,
    `  auth mode: ${snapshot.authMode}`,
    `  source: ${snapshot.source}`,
    `  read at: ${new Date(snapshot.readAt).toISOString()}`,
  ];
  if (snapshot.capturedAt !== undefined) {
    lines.push(`  captured at: ${new Date(snapshot.capturedAt).toISOString()}`);
  }

  if (snapshot.budget.known) {
    const budget = snapshot.budget;
    lines.push(
      `  remaining: ${(budget.remainingFraction * 100).toFixed(1)}%` +
        (budget.window !== undefined ? ` (${budget.window} window)` : ""),
    );
    if (budget.limitId) lines.push(`  limit id: ${budget.limitId}`);
    if (budget.limitName) lines.push(`  limit name: ${budget.limitName}`);
    if (budget.planType) lines.push(`  plan: ${budget.planType}`);
    if (budget.rateLimitReachedType) {
      lines.push(`  backend reported: ${budget.rateLimitReachedType}`);
    }
    if (budget.spendControlReached !== undefined) {
      lines.push(`  spend control reached: ${budget.spendControlReached}`);
    }
    if (budget.credits) {
      lines.push(
        `  credits: has=${budget.credits.hasCredits} ` +
          `unlimited=${budget.credits.unlimited}`,
      );
    }
    for (const window of budget.windows) lines.push(describeWindow(window));
    if (budget.windows.length === 0) {
      lines.push("  windows: none (exhaustion evidence only)");
    }
  } else {
    lines.push(`  remaining: UNKNOWN (${snapshot.budget.reason})`);
    if (snapshot.budget.detail) {
      lines.push(`  detail: ${snapshot.budget.detail}`);
    }
  }

  if (snapshot.exhaustion) {
    lines.push(`  exhausted: ${snapshot.exhaustion.kind}`);
    lines.push(
      "  reset: unknown — the CLI renders it in host-local time with no offset",
    );
  }

  return redactSecrets(lines.join("\n"));
}

/** The opt-in Codex budget diagnostic. */
export const codexBudgetCommand: Command = {
  name: "codex-budget",
  description:
    "Print redacted Codex budget metadata read from CODEX_HOME (read-only; " +
    "consumes no quota)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<CodexBudgetSnapshot>> {
    const requested = typeof args["codex-home"] === "string"
      ? (args["codex-home"] as string).trim()
      : "";
    const codexHome = requested.length > 0 ? requested : defaultCodexHome();

    const adapter = new CodexBudgetAdapter({ codexHome });
    const snapshot = await adapter.refresh();

    return {
      // A budget the adapter could not determine is still a successful
      // diagnostic run: it reported an honest unknown with its reason.
      success: true,
      message: describeCodexBudgetSnapshot(snapshot, codexHome),
      data: snapshot,
    };
  },
};
