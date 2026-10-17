/**
 * Tests for the fleet experiment arm definitions and assignment (Issue #3645).
 *
 * Every test calls the real functions in lib/fleet_experiment_arms.ts. Each
 * refusal rule is asserted by name, and each refused configuration is paired
 * with the same configuration made legal, which must be accepted.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assignExperimentArm,
  CONTROL_ARM_ID,
  DEFAULT_EXPERIMENT_ARMS,
  type ExperimentArm,
  ExperimentArmError,
  isExcludedModel,
  validateExperimentArms,
} from "../lib/fleet_experiment_arms.ts";

/** A valid two-arm configuration: an active control and an active candidate. */
function baseArms(): ExperimentArm[] {
  return [
    {
      id: "sonnet-haiku",
      label: "Sonnet manager + Haiku executor",
      manager: { provider: "claude", model: "sonnet" },
      executor: { provider: "claude", model: "haiku" },
      control: true,
      weight: 1,
      status: "active",
    },
    {
      id: "codex-test",
      label: "Codex test candidate",
      manager: { provider: "codex", model: "astra" },
      executor: { provider: "codex", model: "sol" },
      control: false,
      weight: 1,
      status: "active",
    },
  ];
}

/** Return the rule that refuses the arms, failing if they are accepted. */
function refusedRule(arms: readonly ExperimentArm[]): string {
  try {
    validateExperimentArms(arms);
  } catch (error) {
    if (error instanceof ExperimentArmError) return error.rule;
    throw error;
  }
  throw new Error("expected the arm configuration to be refused");
}

/** Replace one arm of a configuration, returning a fresh list. */
function withArm(
  arms: ExperimentArm[],
  index: number,
  change: Partial<ExperimentArm>,
): ExperimentArm[] {
  return arms.map((arm, position) =>
    position === index ? { ...arm, ...change } : arm
  );
}

Deno.test("fleet experiment arms - default arms validate", () => {
  validateExperimentArms(DEFAULT_EXPERIMENT_ARMS);
});

Deno.test("fleet experiment arms - the control is sonnet-haiku", () => {
  const controls = DEFAULT_EXPERIMENT_ARMS.filter((arm) => arm.control);
  assertEquals(controls.length, 1);
  const control = controls[0];
  assertEquals(CONTROL_ARM_ID, "sonnet-haiku");
  assertEquals(control?.id, CONTROL_ARM_ID);
  assertEquals(control?.status, "active");
  assertEquals(control?.weight, 1);
  assertEquals(control?.manager, { provider: "claude", model: "sonnet" });
  assertEquals(control?.executor, { provider: "claude", model: "haiku" });
});

Deno.test("fleet experiment arms - no default arm uses Fable", () => {
  for (const arm of DEFAULT_EXPERIMENT_ARMS) {
    assertEquals(isExcludedModel(arm.manager.model), false);
    assertEquals(isExcludedModel(arm.executor.model), false);
  }
  assertEquals(/fable/i.test(JSON.stringify(DEFAULT_EXPERIMENT_ARMS)), false);
});

Deno.test("fleet experiment arms - Astra and Sol candidates await feasibility", () => {
  const astraSol = DEFAULT_EXPERIMENT_ARMS.find((arm) => arm.id === "astra-sol");
  const astraHaiku = DEFAULT_EXPERIMENT_ARMS.find((arm) =>
    arm.id === "astra-haiku"
  );
  assertEquals(astraSol?.status, "awaiting-feasibility");
  assertEquals(astraHaiku?.status, "awaiting-feasibility");
  assertEquals(astraSol?.manager.provider, "codex");
  assertEquals(astraSol?.executor.provider, "codex");
  for (const arm of DEFAULT_EXPERIMENT_ARMS) {
    assert(!arm.manager.model.includes("opus"));
  }
});

Deno.test("fleet experiment arms - isExcludedModel matches Fable in any case", () => {
  assertEquals(isExcludedModel("fable-4"), true);
  assertEquals(isExcludedModel("Claude-FABLE"), true);
  assertEquals(isExcludedModel("sonnet"), false);
  assertEquals(isExcludedModel(undefined), false);
});

Deno.test("fleet experiment arms - a valid configuration is accepted", () => {
  validateExperimentArms(baseArms());
});

Deno.test("fleet experiment arms - an empty list is refused as empty", () => {
  assertEquals(refusedRule([]), "empty");
  validateExperimentArms(baseArms());
});

Deno.test("fleet experiment arms - a repeated id is refused as duplicate-id", () => {
  const duplicated = withArm(baseArms(), 1, { id: "sonnet-haiku" });
  assertEquals(refusedRule(duplicated), "duplicate-id");
  validateExperimentArms(baseArms());
});

Deno.test("fleet experiment arms - a malformed id is refused as invalid-id", () => {
  const malformed = withArm(baseArms(), 1, { id: "Codex Test" });
  assertEquals(refusedRule(malformed), "invalid-id");
  validateExperimentArms(withArm(baseArms(), 1, { id: "codex-test" }));
});

Deno.test("fleet experiment arms - an over-long id is refused as invalid-id", () => {
  const tooLong = withArm(baseArms(), 1, { id: "a".repeat(65) });
  assertEquals(refusedRule(tooLong), "invalid-id");
  validateExperimentArms(withArm(baseArms(), 1, { id: "a".repeat(64) }));
});

Deno.test("fleet experiment arms - no control or two controls is refused as control-count", () => {
  const noControl = withArm(baseArms(), 0, { control: false });
  assertEquals(refusedRule(noControl), "control-count");

  const twoControls = withArm(baseArms(), 1, { control: true });
  assertEquals(refusedRule(twoControls), "control-count");

  validateExperimentArms(baseArms());
});

Deno.test("fleet experiment arms - an inactive control is refused as control-inactive", () => {
  const parkedControl = withArm(baseArms(), 0, {
    status: "awaiting-feasibility",
  });
  assertEquals(refusedRule(parkedControl), "control-inactive");
  validateExperimentArms(baseArms());
});

Deno.test("fleet experiment arms - a Fable model is refused as excluded-model", () => {
  const fable = withArm(baseArms(), 1, {
    executor: { provider: "codex", model: "fable-4" },
  });
  assertEquals(refusedRule(fable), "excluded-model");
  validateExperimentArms(
    withArm(baseArms(), 1, { executor: { provider: "codex", model: "sol" } }),
  );
});

Deno.test("fleet experiment arms - a non-positive or non-finite weight is refused as invalid-weight", () => {
  for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad = withArm(baseArms(), 1, { weight });
    assertEquals(refusedRule(bad), "invalid-weight");
  }
  validateExperimentArms(withArm(baseArms(), 1, { weight: 2 }));
});

Deno.test("fleet experiment arms - the same issue always gets the same arm", async () => {
  const arms = baseArms();
  const first = await assignExperimentArm("seed-a", "acme/alpha", 42, arms);
  for (let run = 0; run < 3; run++) {
    assertEquals(
      await assignExperimentArm("seed-a", "acme/alpha", 42, arms),
      first,
    );
  }
});

Deno.test("fleet experiment arms - only active arms are chosen", async () => {
  const arms: ExperimentArm[] = [
    ...baseArms(),
    {
      id: "parked",
      label: "Parked candidate",
      manager: { provider: "codex", model: "astra" },
      executor: { provider: "codex", model: "sol" },
      control: false,
      weight: 1000,
      status: "awaiting-feasibility",
    },
  ];
  for (let issue = 1; issue <= 500; issue++) {
    const chosen = await assignExperimentArm("seed-b", "acme/beta", issue, arms);
    assert(chosen === "sonnet-haiku" || chosen === "codex-test");
  }
});

Deno.test("fleet experiment arms - equal weights split 2000 issues about evenly", async () => {
  const arms = baseArms();
  const counts = new Map<string, number>();
  for (let issue = 1; issue <= 2000; issue++) {
    const chosen = await assignExperimentArm("seed-c", "acme/alpha", issue, arms);
    counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
  }
  const controlShare = (counts.get("sonnet-haiku") ?? 0) / 2000;
  const candidateShare = (counts.get("codex-test") ?? 0) / 2000;
  assert(controlShare > 0.45 && controlShare < 0.55, `control ${controlShare}`);
  assert(
    candidateShare > 0.45 && candidateShare < 0.55,
    `candidate ${candidateShare}`,
  );
});

Deno.test("fleet experiment arms - weights are respected", async () => {
  const arms = withArm(baseArms(), 0, { weight: 3 });
  let controlCount = 0;
  for (let issue = 1; issue <= 2000; issue++) {
    const chosen = await assignExperimentArm("seed-d", "acme/alpha", issue, arms);
    if (chosen === "sonnet-haiku") controlCount++;
  }
  const controlShare = controlCount / 2000;
  assert(controlShare > 0.7 && controlShare < 0.8, `control ${controlShare}`);
});

Deno.test("fleet experiment arms - assignment validates the arms first", async () => {
  const error = await assertRejects(
    () => assignExperimentArm("seed-e", "acme/alpha", 1, []),
    ExperimentArmError,
  );
  assertEquals(error.rule, "empty");
});
