/**
 * Opt-in idle-task templates (Issue #5096).
 *
 * Some registered idle-task templates are capabilities, not enabled automatic
 * work. The test-discovery scan `test-audit` walks the whole repo looking for
 * coverage gaps, so it only runs when the owner asked for it: either by
 * naming it in `.config.json` (`idle_task_template_weights` or
 * `idle_task_cadence.templates`), or by filing the wrapper, or by an operator
 * explicitly requesting it through `raise-single-idle-task`.
 *
 * A wrapper the fleet filed on its own, with no such request, is closed
 * without running. Every function here is pure and never throws.
 *
 * Australian English spelling used throughout (behaviour, authorise).
 */

import type { CadencePolicy } from "./idle_task_cadence.ts";

/** Registered templates that never run as automatic idle work unless the owner asked for them. */
export const OPT_IN_IDLE_TASK_TEMPLATES: ReadonlySet<string> = new Set([
  "test-audit",
]);

/** The slice of `WorkerConfig` that can authorise an opt-in template. */
export interface IdleTaskOptInConfig {
  idleTaskTemplateWeights?: Record<string, number>;
  idleTaskCadence?: Pick<CadencePolicy, "templates">;
}

/**
 * Opt-in templates the owner's `.config.json` names: a finite positive
 * `idle_task_template_weights` entry, or an entry in
 * `idle_task_cadence.templates` (Object.hasOwn). Anything else (absent, 0,
 * negative, NaN, non-number) does not authorise.
 */
export function authorisedOptInTemplates(
  config: IdleTaskOptInConfig,
): ReadonlySet<string> {
  const authorised = new Set<string>();
  const weights = config?.idleTaskTemplateWeights;
  const cadenceTemplates = config?.idleTaskCadence?.templates;
  for (const name of OPT_IN_IDLE_TASK_TEMPLATES) {
    if (
      weights !== null && typeof weights === "object" &&
      Object.hasOwn(weights, name)
    ) {
      const weight = weights[name];
      if (typeof weight === "number" && Number.isFinite(weight) && weight > 0) {
        authorised.add(name);
        continue;
      }
    }
    if (
      cadenceTemplates !== null && typeof cadenceTemplates === "object" &&
      Object.hasOwn(cadenceTemplates, name)
    ) {
      authorised.add(name);
    }
  }
  return authorised;
}

/** True when the template is not opt-in, or the owner config authorises it. */
export function isAutoEnabledIdleTaskTemplate(
  name: string,
  authorised: ReadonlySet<string>,
): boolean {
  if (!OPT_IN_IDLE_TASK_TEMPLATES.has(name)) return true;
  return authorised.has(name);
}

/**
 * Marker the wrapper sweep writes as the body's final line when an operator
 * explicitly named an opt-in template.
 */
export const IDLE_TASK_REQUESTED_MARKER = "<!-- vibe-idle-task-requested -->";

/**
 * True only when the LAST non-blank line of the body, trimmed, equals the
 * marker exactly. A marker quoted anywhere else (middle of the body, inside a
 * code span, with trailing text) does not count.
 *
 * Works line by line from the end, so a hostile body cannot force a regex
 * backtrack.
 */
export function hasIdleTaskRequestedMarker(body: string): boolean {
  if (typeof body !== "string") return false;
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    return line === IDLE_TASK_REQUESTED_MARKER;
  }
  return false;
}

/** Outcome of {@link decideOptInClaim}. */
export type OptInClaimDecision =
  | {
    allowed: true;
    basis: "not_opt_in" | "configured" | "owner_filed" | "requested";
  }
  | { allowed: false; reason: string };

/** Build the human-readable refusal for a wrapper that may not run. */
function refuse(template: string, detail: string): OptInClaimDecision {
  return {
    allowed: false,
    reason:
      `\`${template}\` is a registered idle-task capability, not enabled ` +
      `automatic work (Issue #5096): ${detail}, so it was closed without ` +
      `running. To run it, file the issue yourself, run ` +
      `\`raise-single-idle-task\` naming the template, or name it in ` +
      `\`.config.json\` (\`idle_task_template_weights\` or ` +
      `\`idle_task_cadence.templates\`).`,
  };
}

/**
 * Decide whether an opt-in template wrapper may run.
 *
 * Order:
 *   1. not opt-in → allowed (`not_opt_in`);
 *   2. the owner config authorises it → allowed (`configured`);
 *   3. the author is unknown (empty after trimming) → refused; an unknown
 *      author is not a request (fail closed);
 *   4. the author is not a fleet author (case-insensitive) → allowed
 *      (`owner_filed`: a human filed or requested it);
 *   5. a fleet author with the requested marker as the final body line →
 *      allowed (`requested`);
 *   6. otherwise refused.
 */
export function decideOptInClaim(input: {
  template: string;
  issueAuthor: string;
  issueBody: string;
  fleetAuthors: readonly string[];
  authorised: ReadonlySet<string>;
}): OptInClaimDecision {
  const { template } = input;
  if (!OPT_IN_IDLE_TASK_TEMPLATES.has(template)) {
    return { allowed: true, basis: "not_opt_in" };
  }
  if (input.authorised?.has(template) === true) {
    return { allowed: true, basis: "configured" };
  }

  const author = typeof input.issueAuthor === "string"
    ? input.issueAuthor.trim()
    : "";
  if (author === "") {
    return refuse(
      template,
      "the wrapper's author could not be identified, and an unknown author " +
        "is not a request",
    );
  }

  const authorKey = author.toLowerCase();
  const fleet = Array.isArray(input.fleetAuthors) ? input.fleetAuthors : [];
  const isFleetAuthor = fleet.some((a) =>
    typeof a === "string" && a.trim().toLowerCase() === authorKey
  );
  if (!isFleetAuthor) {
    return { allowed: true, basis: "owner_filed" };
  }

  if (hasIdleTaskRequestedMarker(input.issueBody)) {
    return { allowed: true, basis: "requested" };
  }

  return refuse(
    template,
    "this wrapper was filed by the fleet without an owner request",
  );
}
