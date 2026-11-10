/**
 * Randomised arm definitions and assignment for the fleet experiment
 * (Issue #3645, part of milestone #3644).
 *
 * assignExperimentArm draws one experiment arm for an issue. The draw is a
 * pure function of a seed, the repository and the issue number, so the same
 * seed/issue pair always lands in the same arm. The allocation runtime also
 * supplies a decision epoch and live eligible set; durable issue markers
 * preserve original cohort attribution across later retries and fallbacks.
 *
 * Fable models are excluded from every arm and from every fallback.
 *
 * Australian English spelling used throughout.
 */ /** A provider and model pair for one agent role. */ /** The id of the incumbent control arm. */ export const CONTROL_ARM_ID = "sonnet-haiku";
/**
 * The arms the fleet experiment runs by default.
 *
 * The control is Sonnet manager with Haiku executor, the incumbent. There are
 * no Opus-manager arms in this default set; operators may define other
 * supported candidates. The Astra and Sol candidates await a feasibility
 * check: subscription-only feasibility is tracked in #3647, and Astra and Sol
 * CLI availability is not assumed here.
 */ export const DEFAULT_EXPERIMENT_ARMS = [
  {
    id: CONTROL_ARM_ID,
    label: "Sonnet manager + Haiku executor",
    manager: {
      provider: "claude",
      model: "sonnet"
    },
    executor: {
      provider: "claude",
      model: "haiku"
    },
    control: true,
    weight: 1,
    status: "active"
  },
  {
    // Awaiting #3647: subscription-only feasibility is not yet established.
    id: "astra-sol",
    label: "Astra manager + Sol executor",
    manager: {
      provider: "codex",
      model: "gpt-6-astra"
    },
    executor: {
      provider: "codex",
      model: "gpt-6.1-sol"
    },
    control: false,
    weight: 1,
    status: "awaiting-feasibility"
  },
  {
    // Awaiting #3647: subscription-only feasibility is not yet established.
    id: "astra-haiku",
    label: "Astra manager + Haiku executor",
    manager: {
      provider: "codex",
      model: "gpt-6-astra"
    },
    executor: {
      provider: "claude",
      model: "haiku"
    },
    control: false,
    weight: 1,
    status: "awaiting-feasibility"
  }
];
/** Arm ids must match this pattern. */ const ARM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Any model whose name contains "fable", in any case. */ const EXCLUDED_MODEL_PATTERN = /fable/i;
/**
 * Raised when an arm configuration is refused.
 *
 * `rule` names the rule that refused the configuration.
 */ export class ExperimentArmError extends Error {
  rule;
  constructor(rule, detail){
    super(`Experiment arm rule ${rule} refused: ${detail}`);
    this.name = "ExperimentArmError";
    this.rule = rule;
  }
}
/**
 * Whether a model is excluded from every experiment arm and fallback.
 *
 * @param model - The model name, if known.
 * @returns True when the model is a Fable model.
 */ export function isExcludedModel(model) {
  return model !== undefined && EXCLUDED_MODEL_PATTERN.test(model);
}
/**
 * Check an arm configuration against every rule, refusing the first breach.
 *
 * @param arms - The configured arms.
 * @throws {ExperimentArmError} When a rule is broken.
 */ export function validateExperimentArms(arms) {
  if (arms.length === 0) {
    throw new ExperimentArmError("empty", "no arms are configured");
  }
  const ids = new Set();
  for (const arm of arms){
    if (ids.has(arm.id)) {
      throw new ExperimentArmError("duplicate-id", "an arm id appears more than once");
    }
    ids.add(arm.id);
  }
  for (const arm of arms){
    if (!ARM_ID_PATTERN.test(arm.id)) {
      throw new ExperimentArmError("invalid-id", "an arm id must match [a-z0-9._-] and be at most 64 characters");
    }
  }
  const controls = arms.filter((arm)=>arm.control);
  const control = controls[0];
  if (controls.length !== 1 || control === undefined) {
    throw new ExperimentArmError("control-count", "exactly one arm must be the control");
  }
  if (control.status !== "active") {
    throw new ExperimentArmError("control-inactive", "the control must be active");
  }
  for (const arm of arms){
    if (isExcludedModel(arm.manager.model) || isExcludedModel(arm.executor.model)) {
      throw new ExperimentArmError("excluded-model", "Fable models are excluded from every arm");
    }
  }
  for (const arm of arms){
    if (!(Number.isFinite(arm.weight) && arm.weight > 0)) {
      throw new ExperimentArmError("invalid-weight", "an arm weight must be a finite number above zero");
    }
  }
}
/**
 * Map the SHA-256 of `${seed}:${repo}#${issueNumber}` to [0, 1).
 *
 * The first six bytes form a 48-bit integer, divided by 2^48.
 *
 * @param seed - The experiment seed.
 * @param repo - The repository, `owner/name`.
 * @param issueNumber - The issue number.
 * @returns A value in [0, 1).
 */ async function unitInterval(seed, repo, issueNumber) {
  const data = new TextEncoder().encode(`${seed}:${repo}#${issueNumber}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let value = 0;
  for(let index = 0; index < 6; index++){
    value = value * 256 + (digest[index] ?? 0);
  }
  return value / 2 ** 48;
}
/**
 * Assign an issue to one active arm, deterministically.
 *
 * The same seed, repository and issue number always return the same arm.
 * Only arms with status "active" are chosen, in proportion to their weights.
 *
 * @param seed - The experiment seed.
 * @param repo - The repository, `owner/name`.
 * @param issueNumber - The issue number.
 * @param arms - The configured arms, validated before the draw.
 * @returns The chosen arm's id.
 * @throws {ExperimentArmError} When the arm configuration is refused.
 */ export async function assignExperimentArm(seed, repo, issueNumber, arms, eligible) {
  validateExperimentArms(arms);
  const active = arms.filter((arm)=>arm.status === "active" && (eligible === undefined || eligible.has(arm.id)));
  if (active.length === 0) {
    throw new ExperimentArmError("no-capacity", "no eligible arm has capacity");
  }
  const total = active.reduce((sum, arm)=>sum + arm.weight, 0);
  const target = await unitInterval(seed, repo, issueNumber) * total;
  let cumulative = 0;
  for (const arm of active){
    cumulative += arm.weight;
    if (target < cumulative) return arm.id;
  }
  // Floating-point slack can leave the target a whisker past the total, so the
  // last active arm takes it. Validation makes the control active, so the
  // fallback to the control id can only apply if the list were somehow empty.
  return active[active.length - 1]?.id ?? CONTROL_ARM_ID;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9mbGVldF9leHBlcmltZW50X2FybXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSYW5kb21pc2VkIGFybSBkZWZpbml0aW9ucyBhbmQgYXNzaWdubWVudCBmb3IgdGhlIGZsZWV0IGV4cGVyaW1lbnRcbiAqIChJc3N1ZSAjMzY0NSwgcGFydCBvZiBtaWxlc3RvbmUgIzM2NDQpLlxuICpcbiAqIGFzc2lnbkV4cGVyaW1lbnRBcm0gZHJhd3Mgb25lIGV4cGVyaW1lbnQgYXJtIGZvciBhbiBpc3N1ZS4gVGhlIGRyYXcgaXMgYVxuICogcHVyZSBmdW5jdGlvbiBvZiBhIHNlZWQsIHRoZSByZXBvc2l0b3J5IGFuZCB0aGUgaXNzdWUgbnVtYmVyLCBzbyB0aGUgc2FtZVxuICogc2VlZC9pc3N1ZSBwYWlyIGFsd2F5cyBsYW5kcyBpbiB0aGUgc2FtZSBhcm0uIFRoZSBhbGxvY2F0aW9uIHJ1bnRpbWUgYWxzb1xuICogc3VwcGxpZXMgYSBkZWNpc2lvbiBlcG9jaCBhbmQgbGl2ZSBlbGlnaWJsZSBzZXQ7IGR1cmFibGUgaXNzdWUgbWFya2Vyc1xuICogcHJlc2VydmUgb3JpZ2luYWwgY29ob3J0IGF0dHJpYnV0aW9uIGFjcm9zcyBsYXRlciByZXRyaWVzIGFuZCBmYWxsYmFja3MuXG4gKlxuICogRmFibGUgbW9kZWxzIGFyZSBleGNsdWRlZCBmcm9tIGV2ZXJ5IGFybSBhbmQgZnJvbSBldmVyeSBmYWxsYmFjay5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0LlxuICovXG5cbi8qKiBBIHByb3ZpZGVyIGFuZCBtb2RlbCBwYWlyIGZvciBvbmUgYWdlbnQgcm9sZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXJtUm9sZSB7XG4gIHByb3ZpZGVyOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG59XG5cbi8qKiBPbmUgZXhwZXJpbWVudCBhcm06IGEgbWFuYWdlciBhbmQgZXhlY3V0b3IgdHJlYXRtZW50IHdpdGggYW4gYWxsb2NhdGlvbiB3ZWlnaHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEV4cGVyaW1lbnRBcm0ge1xuICAvKiogQ29ob3J0IGxhYmVsLCBtYXRjaGluZyB0aGUgbGlmZWN5Y2xlIGxlZGdlciBsYWJlbCBwYXR0ZXJuLiAqL1xuICBpZDogc3RyaW5nO1xuICAvKiogSHVtYW4gdGV4dCwgZm9yIGV4YW1wbGUgXCJTb25uZXQgbWFuYWdlciArIEhhaWt1IGV4ZWN1dG9yXCIuICovXG4gIGxhYmVsOiBzdHJpbmc7XG4gIG1hbmFnZXI6IEFybVJvbGU7XG4gIGV4ZWN1dG9yOiBBcm1Sb2xlO1xuICAvKiogV2hldGhlciB0aGlzIGlzIHRoZSBpbmN1bWJlbnQgY29udHJvbCBhcm0uIEV4YWN0bHkgb25lIGFybSBpcyBjb250cm9sLiAqL1xuICBjb250cm9sOiBib29sZWFuO1xuICAvKiogUmVsYXRpdmUgYWxsb2NhdGlvbiB3ZWlnaHQuIE11c3QgYmUgZmluaXRlIGFuZCBhYm92ZSB6ZXJvLiAqL1xuICB3ZWlnaHQ6IG51bWJlcjtcbiAgLyoqIE9ubHkgYWN0aXZlIGFybXMgcmVjZWl2ZSBuZXcgYXNzaWdubWVudHMuICovXG4gIHN0YXR1czogXCJhY3RpdmVcIiB8IFwiYXdhaXRpbmctZmVhc2liaWxpdHlcIjtcbn1cblxuLyoqIFRoZSBpZCBvZiB0aGUgaW5jdW1iZW50IGNvbnRyb2wgYXJtLiAqL1xuZXhwb3J0IGNvbnN0IENPTlRST0xfQVJNX0lEID0gXCJzb25uZXQtaGFpa3VcIjtcblxuLyoqXG4gKiBUaGUgYXJtcyB0aGUgZmxlZXQgZXhwZXJpbWVudCBydW5zIGJ5IGRlZmF1bHQuXG4gKlxuICogVGhlIGNvbnRyb2wgaXMgU29ubmV0IG1hbmFnZXIgd2l0aCBIYWlrdSBleGVjdXRvciwgdGhlIGluY3VtYmVudC4gVGhlcmUgYXJlXG4gKiBubyBPcHVzLW1hbmFnZXIgYXJtcyBpbiB0aGlzIGRlZmF1bHQgc2V0OyBvcGVyYXRvcnMgbWF5IGRlZmluZSBvdGhlclxuICogc3VwcG9ydGVkIGNhbmRpZGF0ZXMuIFRoZSBBc3RyYSBhbmQgU29sIGNhbmRpZGF0ZXMgYXdhaXQgYSBmZWFzaWJpbGl0eVxuICogY2hlY2s6IHN1YnNjcmlwdGlvbi1vbmx5IGZlYXNpYmlsaXR5IGlzIHRyYWNrZWQgaW4gIzM2NDcsIGFuZCBBc3RyYSBhbmQgU29sXG4gKiBDTEkgYXZhaWxhYmlsaXR5IGlzIG5vdCBhc3N1bWVkIGhlcmUuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0VYUEVSSU1FTlRfQVJNUzogcmVhZG9ubHkgRXhwZXJpbWVudEFybVtdID0gW1xuICB7XG4gICAgaWQ6IENPTlRST0xfQVJNX0lELFxuICAgIGxhYmVsOiBcIlNvbm5ldCBtYW5hZ2VyICsgSGFpa3UgZXhlY3V0b3JcIixcbiAgICBtYW5hZ2VyOiB7IHByb3ZpZGVyOiBcImNsYXVkZVwiLCBtb2RlbDogXCJzb25uZXRcIiB9LFxuICAgIGV4ZWN1dG9yOiB7IHByb3ZpZGVyOiBcImNsYXVkZVwiLCBtb2RlbDogXCJoYWlrdVwiIH0sXG4gICAgY29udHJvbDogdHJ1ZSxcbiAgICB3ZWlnaHQ6IDEsXG4gICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICB9LFxuICB7XG4gICAgLy8gQXdhaXRpbmcgIzM2NDc6IHN1YnNjcmlwdGlvbi1vbmx5IGZlYXNpYmlsaXR5IGlzIG5vdCB5ZXQgZXN0YWJsaXNoZWQuXG4gICAgaWQ6IFwiYXN0cmEtc29sXCIsXG4gICAgbGFiZWw6IFwiQXN0cmEgbWFuYWdlciArIFNvbCBleGVjdXRvclwiLFxuICAgIG1hbmFnZXI6IHsgcHJvdmlkZXI6IFwiY29kZXhcIiwgbW9kZWw6IFwiZ3B0LTYtYXN0cmFcIiB9LFxuICAgIGV4ZWN1dG9yOiB7IHByb3ZpZGVyOiBcImNvZGV4XCIsIG1vZGVsOiBcImdwdC02LjEtc29sXCIgfSxcbiAgICBjb250cm9sOiBmYWxzZSxcbiAgICB3ZWlnaHQ6IDEsXG4gICAgc3RhdHVzOiBcImF3YWl0aW5nLWZlYXNpYmlsaXR5XCIsXG4gIH0sXG4gIHtcbiAgICAvLyBBd2FpdGluZyAjMzY0Nzogc3Vic2NyaXB0aW9uLW9ubHkgZmVhc2liaWxpdHkgaXMgbm90IHlldCBlc3RhYmxpc2hlZC5cbiAgICBpZDogXCJhc3RyYS1oYWlrdVwiLFxuICAgIGxhYmVsOiBcIkFzdHJhIG1hbmFnZXIgKyBIYWlrdSBleGVjdXRvclwiLFxuICAgIG1hbmFnZXI6IHsgcHJvdmlkZXI6IFwiY29kZXhcIiwgbW9kZWw6IFwiZ3B0LTYtYXN0cmFcIiB9LFxuICAgIGV4ZWN1dG9yOiB7IHByb3ZpZGVyOiBcImNsYXVkZVwiLCBtb2RlbDogXCJoYWlrdVwiIH0sXG4gICAgY29udHJvbDogZmFsc2UsXG4gICAgd2VpZ2h0OiAxLFxuICAgIHN0YXR1czogXCJhd2FpdGluZy1mZWFzaWJpbGl0eVwiLFxuICB9LFxuXTtcblxuLyoqIEFybSBpZHMgbXVzdCBtYXRjaCB0aGlzIHBhdHRlcm4uICovXG5jb25zdCBBUk1fSURfUEFUVEVSTiA9IC9eW2EtejAtOV1bYS16MC05Ll8tXXswLDYzfSQvO1xuXG4vKiogQW55IG1vZGVsIHdob3NlIG5hbWUgY29udGFpbnMgXCJmYWJsZVwiLCBpbiBhbnkgY2FzZS4gKi9cbmNvbnN0IEVYQ0xVREVEX01PREVMX1BBVFRFUk4gPSAvZmFibGUvaTtcblxuLyoqXG4gKiBSYWlzZWQgd2hlbiBhbiBhcm0gY29uZmlndXJhdGlvbiBpcyByZWZ1c2VkLlxuICpcbiAqIGBydWxlYCBuYW1lcyB0aGUgcnVsZSB0aGF0IHJlZnVzZWQgdGhlIGNvbmZpZ3VyYXRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBFeHBlcmltZW50QXJtRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IHJ1bGU6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihydWxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKSB7XG4gICAgc3VwZXIoYEV4cGVyaW1lbnQgYXJtIHJ1bGUgJHtydWxlfSByZWZ1c2VkOiAke2RldGFpbH1gKTtcbiAgICB0aGlzLm5hbWUgPSBcIkV4cGVyaW1lbnRBcm1FcnJvclwiO1xuICAgIHRoaXMucnVsZSA9IHJ1bGU7XG4gIH1cbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgbW9kZWwgaXMgZXhjbHVkZWQgZnJvbSBldmVyeSBleHBlcmltZW50IGFybSBhbmQgZmFsbGJhY2suXG4gKlxuICogQHBhcmFtIG1vZGVsIC0gVGhlIG1vZGVsIG5hbWUsIGlmIGtub3duLlxuICogQHJldHVybnMgVHJ1ZSB3aGVuIHRoZSBtb2RlbCBpcyBhIEZhYmxlIG1vZGVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNFeGNsdWRlZE1vZGVsKG1vZGVsOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuIG1vZGVsICE9PSB1bmRlZmluZWQgJiYgRVhDTFVERURfTU9ERUxfUEFUVEVSTi50ZXN0KG1vZGVsKTtcbn1cblxuLyoqXG4gKiBDaGVjayBhbiBhcm0gY29uZmlndXJhdGlvbiBhZ2FpbnN0IGV2ZXJ5IHJ1bGUsIHJlZnVzaW5nIHRoZSBmaXJzdCBicmVhY2guXG4gKlxuICogQHBhcmFtIGFybXMgLSBUaGUgY29uZmlndXJlZCBhcm1zLlxuICogQHRocm93cyB7RXhwZXJpbWVudEFybUVycm9yfSBXaGVuIGEgcnVsZSBpcyBicm9rZW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUV4cGVyaW1lbnRBcm1zKGFybXM6IHJlYWRvbmx5IEV4cGVyaW1lbnRBcm1bXSk6IHZvaWQge1xuICBpZiAoYXJtcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXhwZXJpbWVudEFybUVycm9yKFwiZW1wdHlcIiwgXCJubyBhcm1zIGFyZSBjb25maWd1cmVkXCIpO1xuICB9XG5cbiAgY29uc3QgaWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgYXJtIG9mIGFybXMpIHtcbiAgICBpZiAoaWRzLmhhcyhhcm0uaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXhwZXJpbWVudEFybUVycm9yKFxuICAgICAgICBcImR1cGxpY2F0ZS1pZFwiLFxuICAgICAgICBcImFuIGFybSBpZCBhcHBlYXJzIG1vcmUgdGhhbiBvbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZHMuYWRkKGFybS5pZCk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGFybSBvZiBhcm1zKSB7XG4gICAgaWYgKCFBUk1fSURfUEFUVEVSTi50ZXN0KGFybS5pZCkpIHtcbiAgICAgIHRocm93IG5ldyBFeHBlcmltZW50QXJtRXJyb3IoXG4gICAgICAgIFwiaW52YWxpZC1pZFwiLFxuICAgICAgICBcImFuIGFybSBpZCBtdXN0IG1hdGNoIFthLXowLTkuXy1dIGFuZCBiZSBhdCBtb3N0IDY0IGNoYXJhY3RlcnNcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY29udHJvbHMgPSBhcm1zLmZpbHRlcigoYXJtKSA9PiBhcm0uY29udHJvbCk7XG4gIGNvbnN0IGNvbnRyb2wgPSBjb250cm9sc1swXTtcbiAgaWYgKGNvbnRyb2xzLmxlbmd0aCAhPT0gMSB8fCBjb250cm9sID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXhwZXJpbWVudEFybUVycm9yKFxuICAgICAgXCJjb250cm9sLWNvdW50XCIsXG4gICAgICBcImV4YWN0bHkgb25lIGFybSBtdXN0IGJlIHRoZSBjb250cm9sXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoY29udHJvbC5zdGF0dXMgIT09IFwiYWN0aXZlXCIpIHtcbiAgICB0aHJvdyBuZXcgRXhwZXJpbWVudEFybUVycm9yKFxuICAgICAgXCJjb250cm9sLWluYWN0aXZlXCIsXG4gICAgICBcInRoZSBjb250cm9sIG11c3QgYmUgYWN0aXZlXCIsXG4gICAgKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgYXJtIG9mIGFybXMpIHtcbiAgICBpZiAoXG4gICAgICBpc0V4Y2x1ZGVkTW9kZWwoYXJtLm1hbmFnZXIubW9kZWwpIHx8IGlzRXhjbHVkZWRNb2RlbChhcm0uZXhlY3V0b3IubW9kZWwpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXhwZXJpbWVudEFybUVycm9yKFxuICAgICAgICBcImV4Y2x1ZGVkLW1vZGVsXCIsXG4gICAgICAgIFwiRmFibGUgbW9kZWxzIGFyZSBleGNsdWRlZCBmcm9tIGV2ZXJ5IGFybVwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IGFybSBvZiBhcm1zKSB7XG4gICAgaWYgKCEoTnVtYmVyLmlzRmluaXRlKGFybS53ZWlnaHQpICYmIGFybS53ZWlnaHQgPiAwKSkge1xuICAgICAgdGhyb3cgbmV3IEV4cGVyaW1lbnRBcm1FcnJvcihcbiAgICAgICAgXCJpbnZhbGlkLXdlaWdodFwiLFxuICAgICAgICBcImFuIGFybSB3ZWlnaHQgbXVzdCBiZSBhIGZpbml0ZSBudW1iZXIgYWJvdmUgemVyb1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBNYXAgdGhlIFNIQS0yNTYgb2YgYCR7c2VlZH06JHtyZXBvfSMke2lzc3VlTnVtYmVyfWAgdG8gWzAsIDEpLlxuICpcbiAqIFRoZSBmaXJzdCBzaXggYnl0ZXMgZm9ybSBhIDQ4LWJpdCBpbnRlZ2VyLCBkaXZpZGVkIGJ5IDJeNDguXG4gKlxuICogQHBhcmFtIHNlZWQgLSBUaGUgZXhwZXJpbWVudCBzZWVkLlxuICogQHBhcmFtIHJlcG8gLSBUaGUgcmVwb3NpdG9yeSwgYG93bmVyL25hbWVgLlxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gVGhlIGlzc3VlIG51bWJlci5cbiAqIEByZXR1cm5zIEEgdmFsdWUgaW4gWzAsIDEpLlxuICovXG5hc3luYyBmdW5jdGlvbiB1bml0SW50ZXJ2YWwoXG4gIHNlZWQ6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgZGF0YSA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShgJHtzZWVkfToke3JlcG99IyR7aXNzdWVOdW1iZXJ9YCk7XG4gIGNvbnN0IGRpZ2VzdCA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KFwiU0hBLTI1NlwiLCBkYXRhKSk7XG4gIGxldCB2YWx1ZSA9IDA7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCA2OyBpbmRleCsrKSB7XG4gICAgdmFsdWUgPSB2YWx1ZSAqIDI1NiArIChkaWdlc3RbaW5kZXhdID8/IDApO1xuICB9XG4gIHJldHVybiB2YWx1ZSAvIDIgKiogNDg7XG59XG5cbi8qKlxuICogQXNzaWduIGFuIGlzc3VlIHRvIG9uZSBhY3RpdmUgYXJtLCBkZXRlcm1pbmlzdGljYWxseS5cbiAqXG4gKiBUaGUgc2FtZSBzZWVkLCByZXBvc2l0b3J5IGFuZCBpc3N1ZSBudW1iZXIgYWx3YXlzIHJldHVybiB0aGUgc2FtZSBhcm0uXG4gKiBPbmx5IGFybXMgd2l0aCBzdGF0dXMgXCJhY3RpdmVcIiBhcmUgY2hvc2VuLCBpbiBwcm9wb3J0aW9uIHRvIHRoZWlyIHdlaWdodHMuXG4gKlxuICogQHBhcmFtIHNlZWQgLSBUaGUgZXhwZXJpbWVudCBzZWVkLlxuICogQHBhcmFtIHJlcG8gLSBUaGUgcmVwb3NpdG9yeSwgYG93bmVyL25hbWVgLlxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gVGhlIGlzc3VlIG51bWJlci5cbiAqIEBwYXJhbSBhcm1zIC0gVGhlIGNvbmZpZ3VyZWQgYXJtcywgdmFsaWRhdGVkIGJlZm9yZSB0aGUgZHJhdy5cbiAqIEByZXR1cm5zIFRoZSBjaG9zZW4gYXJtJ3MgaWQuXG4gKiBAdGhyb3dzIHtFeHBlcmltZW50QXJtRXJyb3J9IFdoZW4gdGhlIGFybSBjb25maWd1cmF0aW9uIGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NpZ25FeHBlcmltZW50QXJtKFxuICBzZWVkOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgYXJtczogcmVhZG9ubHkgRXhwZXJpbWVudEFybVtdLFxuICBlbGlnaWJsZT86IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICB2YWxpZGF0ZUV4cGVyaW1lbnRBcm1zKGFybXMpO1xuICBjb25zdCBhY3RpdmUgPSBhcm1zLmZpbHRlcigoYXJtKSA9PlxuICAgIGFybS5zdGF0dXMgPT09IFwiYWN0aXZlXCIgJiYgKGVsaWdpYmxlID09PSB1bmRlZmluZWQgfHwgZWxpZ2libGUuaGFzKGFybS5pZCkpXG4gICk7XG4gIGlmIChhY3RpdmUubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEV4cGVyaW1lbnRBcm1FcnJvcihcIm5vLWNhcGFjaXR5XCIsIFwibm8gZWxpZ2libGUgYXJtIGhhcyBjYXBhY2l0eVwiKTtcbiAgfVxuICBjb25zdCB0b3RhbCA9IGFjdGl2ZS5yZWR1Y2UoKHN1bSwgYXJtKSA9PiBzdW0gKyBhcm0ud2VpZ2h0LCAwKTtcbiAgY29uc3QgdGFyZ2V0ID0gKGF3YWl0IHVuaXRJbnRlcnZhbChzZWVkLCByZXBvLCBpc3N1ZU51bWJlcikpICogdG90YWw7XG5cbiAgbGV0IGN1bXVsYXRpdmUgPSAwO1xuICBmb3IgKGNvbnN0IGFybSBvZiBhY3RpdmUpIHtcbiAgICBjdW11bGF0aXZlICs9IGFybS53ZWlnaHQ7XG4gICAgaWYgKHRhcmdldCA8IGN1bXVsYXRpdmUpIHJldHVybiBhcm0uaWQ7XG4gIH1cbiAgLy8gRmxvYXRpbmctcG9pbnQgc2xhY2sgY2FuIGxlYXZlIHRoZSB0YXJnZXQgYSB3aGlza2VyIHBhc3QgdGhlIHRvdGFsLCBzbyB0aGVcbiAgLy8gbGFzdCBhY3RpdmUgYXJtIHRha2VzIGl0LiBWYWxpZGF0aW9uIG1ha2VzIHRoZSBjb250cm9sIGFjdGl2ZSwgc28gdGhlXG4gIC8vIGZhbGxiYWNrIHRvIHRoZSBjb250cm9sIGlkIGNhbiBvbmx5IGFwcGx5IGlmIHRoZSBsaXN0IHdlcmUgc29tZWhvdyBlbXB0eS5cbiAgcmV0dXJuIGFjdGl2ZVthY3RpdmUubGVuZ3RoIC0gMV0/LmlkID8/IENPTlRST0xfQVJNX0lEO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FFRCxrREFBa0QsR0FzQmxELHlDQUF5QyxHQUN6QyxPQUFPLE1BQU0saUJBQWlCLGVBQWU7QUFFN0M7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLE1BQU0sMEJBQW9EO0VBQy9EO0lBQ0UsSUFBSTtJQUNKLE9BQU87SUFDUCxTQUFTO01BQUUsVUFBVTtNQUFVLE9BQU87SUFBUztJQUMvQyxVQUFVO01BQUUsVUFBVTtNQUFVLE9BQU87SUFBUTtJQUMvQyxTQUFTO0lBQ1QsUUFBUTtJQUNSLFFBQVE7RUFDVjtFQUNBO0lBQ0Usd0VBQXdFO0lBQ3hFLElBQUk7SUFDSixPQUFPO0lBQ1AsU0FBUztNQUFFLFVBQVU7TUFBUyxPQUFPO0lBQWM7SUFDbkQsVUFBVTtNQUFFLFVBQVU7TUFBUyxPQUFPO0lBQWM7SUFDcEQsU0FBUztJQUNULFFBQVE7SUFDUixRQUFRO0VBQ1Y7RUFDQTtJQUNFLHdFQUF3RTtJQUN4RSxJQUFJO0lBQ0osT0FBTztJQUNQLFNBQVM7TUFBRSxVQUFVO01BQVMsT0FBTztJQUFjO0lBQ25ELFVBQVU7TUFBRSxVQUFVO01BQVUsT0FBTztJQUFRO0lBQy9DLFNBQVM7SUFDVCxRQUFRO0lBQ1IsUUFBUTtFQUNWO0NBQ0QsQ0FBQztBQUVGLHFDQUFxQyxHQUNyQyxNQUFNLGlCQUFpQjtBQUV2Qix3REFBd0QsR0FDeEQsTUFBTSx5QkFBeUI7QUFFL0I7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSwyQkFBMkI7RUFDN0IsS0FBYTtFQUV0QixZQUFZLElBQVksRUFBRSxNQUFjLENBQUU7SUFDeEMsS0FBSyxDQUFDLENBQUMsb0JBQW9CLEVBQUUsS0FBSyxVQUFVLEVBQUUsUUFBUTtJQUN0RCxJQUFJLENBQUMsSUFBSSxHQUFHO0lBQ1osSUFBSSxDQUFDLElBQUksR0FBRztFQUNkO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FB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
// denoCacheMetadata=5091801393609073006,9751058878197174778