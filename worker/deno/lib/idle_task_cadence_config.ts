/**
 * `.config.json` surface for the idle-task cadence policy (Issue #4011).
 *
 * Which templates get a guaranteed scan, over which windows, and at which model
 * tier is a **spend** decision, so it is operator-only configuration in
 * `.config.json` — never an in-repo setting a repository could use to upgrade
 * itself onto a premium model (#2625/#2626). This module is the only place the
 * untrusted `idle_task_cadence` block is turned into a {@link CadencePolicy};
 * `lib/idle_task_cadence.ts` stays a pure policy module and knows nothing about
 * configuration.
 *
 * ## Validation posture — warn loudly, never crash
 *
 * A typo in `.config.json` must not stop the worker, so every fault is
 * **warned about and then defaulted**, never thrown:
 *
 *   - an absent or malformed block yields {@link DEFAULT_CADENCE_POLICY};
 *   - an unknown template name (not one of the registered idle-task templates)
 *     is warned about and that entry dropped;
 *   - a model value outside the known aliases (`fable`/`opus`/`sonnet`/`haiku`)
 *     is warned about and the window falls back to its default tier; and
 *   - windows that are not finite positive numbers, or where `monthly_days` does
 *     not exceed `weekly_days`, are warned about and both fall back to 7/30.
 *
 * This is not silent failure: nothing is reconciled as "valid", every fault is
 * on stderr at config load, and the worker keeps running on the documented
 * default policy rather than an operator's half-understood one.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  CADENCE_MODEL_TIERS,
  type CadenceModelTier,
  type CadencePolicy,
  type CadenceTemplatePolicy,
  DEFAULT_CADENCE_POLICY,
  MONTHLY_MODEL_TIER,
  MONTHLY_WINDOW_DAYS,
  WEEKLY_MODEL_TIER,
  WEEKLY_WINDOW_DAYS,
} from "./idle_task_cadence.ts";
import { IDLE_TASK_TEMPLATE_NAMES } from "./idle_task_template_names.ts";

/** Recognised keys inside the `idle_task_cadence` block. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "templates",
  "weekly_days",
  "monthly_days",
]);

/** Options for {@link parseIdleTaskCadence}. */
export interface ParseIdleTaskCadenceOptions {
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Template names an operator may configure. Defaults to
   * {@link IDLE_TASK_TEMPLATE_NAMES}, so a typo is caught rather than silently
   * governing a template that does not exist.
   */
  knownTemplates?: ReadonlySet<string>;
}

/** Deep copy of a policy, so callers can never mutate a shared default. */
export function cloneCadencePolicy(policy: CadencePolicy): CadencePolicy {
  return {
    enabled: policy.enabled,
    weeklyDays: policy.weeklyDays,
    monthlyDays: policy.monthlyDays,
    templates: Object.fromEntries(
      Object.entries(policy.templates).map(([name, entry]) => [name, {
        weeklyModel: entry.weeklyModel,
        monthlyModel: entry.monthlyModel,
      }]),
    ),
  };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is one of the known model aliases. */
function isModelTier(value: unknown): value is CadenceModelTier {
  return typeof value === "string" &&
    (CADENCE_MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * Resolve one window's model alias, warning and falling back to the window's
 * default tier when the operator's value is absent or unrecognised.
 */
function resolveTier(
  raw: unknown,
  field: string,
  template: string,
  fallback: CadenceModelTier,
  warn: (message: string) => void,
): CadenceModelTier {
  if (raw === undefined) return fallback;
  if (isModelTier(raw)) return raw;
  warn(
    `[config] idle_task_cadence.templates.${template}.${field}: ` +
      `unknown model "${String(raw)}" — must be one of ` +
      `${CADENCE_MODEL_TIERS.join(", ")}; using "${fallback}"`,
  );
  return fallback;
}

/** Parse the `templates` sub-block, dropping entries that do not validate. */
function parseTemplates(
  raw: unknown,
  knownTemplates: ReadonlySet<string>,
  warn: (message: string) => void,
): Record<string, CadenceTemplatePolicy> | null {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    warn(
      `[config] idle_task_cadence.templates must be an object keyed by ` +
        `template name — using the default templates`,
    );
    return null;
  }

  const templates: Record<string, CadenceTemplatePolicy> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!knownTemplates.has(name)) {
      warn(
        `[config] idle_task_cadence.templates."${name}": unknown idle-task ` +
          `template — entry ignored`,
      );
      continue;
    }
    if (!isPlainObject(entry)) {
      warn(
        `[config] idle_task_cadence.templates."${name}" must be an object ` +
          `with weekly_model / monthly_model — entry ignored`,
      );
      continue;
    }
    templates[name] = {
      weeklyModel: resolveTier(
        entry.weekly_model,
        "weekly_model",
        name,
        WEEKLY_MODEL_TIER,
        warn,
      ),
      monthlyModel: resolveTier(
        entry.monthly_model,
        "monthly_model",
        name,
        MONTHLY_MODEL_TIER,
        warn,
      ),
    };
  }
  return templates;
}

/** Resolve one window in days, or null when the value does not validate. */
function parseWindow(
  raw: unknown,
  field: string,
  warn: (message: string) => void,
): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    warn(
      `[config] idle_task_cadence.${field} must be a finite positive number, ` +
        `got ${JSON.stringify(raw)} — using the default windows`,
    );
    return null;
  }
  return raw;
}

/**
 * Turn the raw `idle_task_cadence` block from `.config.json` into a validated
 * {@link CadencePolicy}.
 *
 * Never throws: every fault warns and falls back to the corresponding default,
 * so a malformed operator config degrades to the documented #4003 policy rather
 * than stopping the worker.
 */
export function parseIdleTaskCadence(
  raw: unknown,
  options: ParseIdleTaskCadenceOptions = {},
): CadencePolicy {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const knownTemplates = options.knownTemplates ?? IDLE_TASK_TEMPLATE_NAMES;
  const policy = cloneCadencePolicy(DEFAULT_CADENCE_POLICY);

  if (raw === undefined || raw === null) return policy;
  if (!isPlainObject(raw)) {
    warn(
      `[config] idle_task_cadence must be an object — using the default ` +
        `cadence policy`,
    );
    return policy;
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warn(
        `[config] idle_task_cadence."${key}": unknown key — ignored ` +
          `(expected ${[...KNOWN_KEYS].join(", ")})`,
      );
    }
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      policy.enabled = raw.enabled;
    } else {
      warn(
        `[config] idle_task_cadence.enabled must be a boolean, got ` +
          `${JSON.stringify(raw.enabled)} — cadence stays enabled`,
      );
    }
  }

  const templates = parseTemplates(raw.templates, knownTemplates, warn);
  if (templates !== null) policy.templates = templates;

  // Both windows fall back together: a pair where the month does not outlast
  // the week cannot express the intended cadence, so half-applying it would be
  // worse than using the documented default.
  const weeklyDays = parseWindow(raw.weekly_days, "weekly_days", warn);
  const monthlyDays = parseWindow(raw.monthly_days, "monthly_days", warn);
  const resolvedWeekly = weeklyDays ?? WEEKLY_WINDOW_DAYS;
  const resolvedMonthly = monthlyDays ?? MONTHLY_WINDOW_DAYS;
  if (resolvedMonthly <= resolvedWeekly) {
    warn(
      `[config] idle_task_cadence.monthly_days (${resolvedMonthly}) must ` +
        `exceed weekly_days (${resolvedWeekly}) — using the default ` +
        `${WEEKLY_WINDOW_DAYS}/${MONTHLY_WINDOW_DAYS} windows`,
    );
  } else {
    policy.weeklyDays = resolvedWeekly;
    policy.monthlyDays = resolvedMonthly;
  }

  return policy;
}
