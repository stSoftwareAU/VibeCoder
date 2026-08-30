/**
 * Shape-based super-linearity detector for tests (Issue #530).
 *
 * Catastrophic backtracking has no observable output difference, only a
 * runtime one, so the regressions guarded by
 * `secret_redaction_bounds_test.ts` and friends have to be detected by
 * measurement. An **absolute** wall-clock bound is the wrong measurement:
 * 2000 ms was chosen on one host, and a fleet host 8% slower failed the
 * suite with a correctness error for a rule that was still perfectly linear.
 *
 * This helper asserts on the **shape** of the growth instead. The same work
 * is run at size N and at size `sizeFactor × N`, and the larger run may take
 * up to `slack × sizeFactor` times the smaller one. A uniformly slower host
 * inflates both measurements, so the ratio is unchanged and the check stays
 * green; a genuinely quadratic rule costs `sizeFactor²` and fails loudly at
 * any host speed.
 *
 * `graceMs` is a floor, never a ceiling: on a fast host both measurements can
 * land in single-digit milliseconds where scheduler noise dominates the
 * ratio, so a scaled run under the grace is never reported as super-linear.
 * Raising it cannot mask a real blow-up — a super-linear rule at these sizes
 * costs seconds, not milliseconds.
 *
 * Australian English spelling used throughout.
 */

import { AssertionError } from "@std/assert";

/** How much slower than proportional a linear run may be. */
export const DEFAULT_SLACK = 2;

/** Measurements below this are noise, not a growth signal (milliseconds). */
export const DEFAULT_GRACE_MS = 50;

/** Default size multiple between the two measured runs. */
export const DEFAULT_SIZE_FACTOR = 4;

/** Default number of runs per size; the fastest one is kept. */
export const DEFAULT_REPEATS = 2;

/** Tolerances for {@link exceedsGrowthBound}. */
export interface GrowthLimits {
  /** Multiple of proportional growth a linear run may take. Default 2. */
  slack?: number;
  /** Absolute floor below which the ratio is not asserted. Default 50 ms. */
  graceMs?: number;
}

/**
 * The largest time the scaled run may take before it counts as super-linear.
 *
 * @param baseMs - Milliseconds the base-size run took
 * @param sizeFactor - How many times larger the scaled input is
 * @param limits - Slack and grace tolerances
 * @returns The allowance, in milliseconds
 */
export function growthAllowanceMs(
  baseMs: number,
  sizeFactor: number,
  limits: GrowthLimits = {},
): number {
  const { slack = DEFAULT_SLACK, graceMs = DEFAULT_GRACE_MS } = limits;
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError(`baseMs must be a non-negative number, got ${baseMs}`);
  }
  if (!Number.isFinite(sizeFactor) || sizeFactor <= 1) {
    throw new RangeError(`sizeFactor must exceed 1, got ${sizeFactor}`);
  }
  if (!Number.isFinite(slack) || slack < 1) {
    throw new RangeError(`slack must be at least 1, got ${slack}`);
  }
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new RangeError(`graceMs must be non-negative, got ${graceMs}`);
  }
  return Math.max(graceMs, baseMs * slack * sizeFactor);
}

/**
 * Did the scaled run grow faster than a linear rule can explain?
 *
 * @param baseMs - Milliseconds the base-size run took
 * @param scaledMs - Milliseconds the scaled run took
 * @param sizeFactor - How many times larger the scaled input is
 * @param limits - Slack and grace tolerances
 * @returns True when the growth is super-linear beyond the tolerances
 */
export function exceedsGrowthBound(
  baseMs: number,
  scaledMs: number,
  sizeFactor: number,
  limits: GrowthLimits = {},
): boolean {
  if (!Number.isFinite(scaledMs) || scaledMs < 0) {
    throw new RangeError(
      `scaledMs must be a non-negative number, got ${scaledMs}`,
    );
  }
  return scaledMs > growthAllowanceMs(baseMs, sizeFactor, limits);
}

/** Inputs for {@link measureGrowth} and {@link assertLinearGrowth}. */
export interface GrowthOptions extends GrowthLimits {
  /** Characters of input for the base-size run. */
  baseChars: number;
  /** Size multiple for the second run. Default 4. */
  sizeFactor?: number;
  /** Runs per size; the fastest is kept. Default 2. */
  repeats?: number;
  /** Clock, injectable for tests. Default `performance.now`. */
  now?: () => number;
}

/** What {@link measureGrowth} observed. */
export interface GrowthMeasurement<T> {
  baseChars: number;
  scaledChars: number;
  /** Actual size multiple, from the built inputs rather than the request. */
  sizeFactor: number;
  baseMs: number;
  scaledMs: number;
  allowedMs: number;
  superLinear: boolean;
  /** Result of the scaled run, so correctness can still be asserted. */
  output: T;
}

/** Fastest of `repeats` runs, keeping the last result. */
function fastestRun<T>(
  run: (input: string) => T,
  input: string,
  repeats: number,
  now: () => number,
): { ms: number; output: T } {
  let ms = Infinity;
  let output!: T;
  for (let i = 0; i < repeats; i++) {
    const started = now();
    output = run(input);
    ms = Math.min(ms, now() - started);
  }
  return { ms, output };
}

/**
 * Run `run` over a base-size and a scaled input and compare the growth.
 *
 * @param build - Builds an input of approximately the requested length
 * @param run - The work under measurement
 * @param options - Sizes, repeats, tolerances and clock
 * @returns Both measurements and the super-linearity verdict
 */
export function measureGrowth<T>(
  build: (chars: number) => string,
  run: (input: string) => T,
  options: GrowthOptions,
): GrowthMeasurement<T> {
  const {
    baseChars,
    sizeFactor = DEFAULT_SIZE_FACTOR,
    repeats = DEFAULT_REPEATS,
    now = () => performance.now(),
  } = options;
  if (!Number.isFinite(baseChars) || baseChars < 1) {
    throw new RangeError(`baseChars must be at least 1, got ${baseChars}`);
  }
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new RangeError(`repeats must be a positive integer, got ${repeats}`);
  }

  const baseInput = build(baseChars);
  const scaledInput = build(baseChars * sizeFactor);
  if (baseInput.length < 1) {
    throw new RangeError("build produced an empty base input");
  }
  const actualFactor = scaledInput.length / baseInput.length;

  const base = fastestRun(run, baseInput, repeats, now);
  const scaled = fastestRun(run, scaledInput, repeats, now);
  const allowedMs = growthAllowanceMs(base.ms, actualFactor, options);

  return {
    baseChars: baseInput.length,
    scaledChars: scaledInput.length,
    sizeFactor: actualFactor,
    baseMs: base.ms,
    scaledMs: scaled.ms,
    allowedMs,
    superLinear: scaled.ms > allowedMs,
    output: scaled.output,
  };
}

/**
 * Assert `run` scales linearly in its input size, and return the scaled run's
 * output so the caller can assert on correctness as well.
 *
 * @param label - Human name of the shape under test, used in the failure
 * @param build - Builds an input of approximately the requested length
 * @param run - The work under measurement
 * @param options - Sizes, repeats, tolerances and clock
 * @returns Whatever `run` returned for the scaled input
 * @throws AssertionError when the growth is super-linear
 */
export function assertLinearGrowth<T>(
  label: string,
  build: (chars: number) => string,
  run: (input: string) => T,
  options: GrowthOptions,
): T {
  const m = measureGrowth(build, run, options);
  if (m.superLinear) {
    throw new AssertionError(
      `${label}: ${m.baseChars} chars took ${m.baseMs.toFixed(0)} ms but ` +
        `${m.scaledChars} chars (${m.sizeFactor.toFixed(1)}x) took ` +
        `${m.scaledMs.toFixed(0)} ms, over the ${m.allowedMs.toFixed(0)} ms ` +
        "a linear rule allows — the rule is super-linear",
    );
  }
  return m.output;
}
