/**
 * Which built-in phase a `custom_label_prompts` entry overrides (Issue #849,
 * part of #843).
 *
 * Issue #848 gave a **new** label the generic implementation phase. This module
 * is the other half: an entry whose label matches a **built-in** label replaces
 * that phase's own template, so an operator can run a non-public `planning`,
 * `grill-me`, `question`, `quorum` or `work-on` prompt.
 *
 * ## Two things this module refuses to guess
 *
 * 1. **The label names are operator-configurable.** `planning` may be
 *    `plan-it` on a fleet that renamed it, so the mapping is resolved against
 *    the configured names on `WorkerConfig` — never against hard-coded
 *    literals.
 * 2. **A two-turn phase is two templates.** Overriding `planning` does not
 *    touch `planning_critique`, and overriding `quorum` does not touch
 *    `quorum_judge`: each is a separate template with its own required
 *    placeholders, so each needs its own entry naming its phase explicitly.
 *    Inferring the second turn from the first would hand an agent a prompt the
 *    operator never wrote.
 *
 * `refine-issue` has no template file at all — `lib/refinement_processor.ts`
 * builds its prompt inline — so a mapping naming it is rejected by name with
 * that reason rather than failing later with a confusing "prompt not found".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { getRequiredPlaceholders } from "./prompt_manager.ts";
/** The stock label names, used when a caller supplies none. */ export const DEFAULT_BUILTIN_LABEL_NAMES = {
  workOnLabel: LABEL_DEFAULTS.workOnLabel,
  planningLabel: LABEL_DEFAULTS.planningLabel,
  questionLabel: LABEL_DEFAULTS.questionLabel,
  grillMeLabel: LABEL_DEFAULTS.grillMeLabel,
  quorumLabel: LABEL_DEFAULTS.quorumLabel,
  refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel
};
/**
 * The phases each built-in label owns, first entry first.
 *
 * The first phase is what an entry overrides when it names no `phase`; the
 * rest are the later turns, which must be named explicitly. `refineIssueLabel`
 * owns nothing — see {@link REFINE_ISSUE_REASON}.
 */ const LABEL_PHASES = {
  workOnLabel: [
    "issue"
  ],
  planningLabel: [
    "planning",
    "planning_critique"
  ],
  questionLabel: [
    "question"
  ],
  grillMeLabel: [
    "grill-me"
  ],
  quorumLabel: [
    "quorum",
    "quorum_judge"
  ],
  refineIssueLabel: []
};
/** Why a `refine-issue` mapping is refused. */ export const REFINE_ISSUE_REASON = "the refinement phase builds its prompt inline in " + "lib/refinement_processor.ts and has no template file to override";
/** The label name each built-in field carries, in match order. */ function labelFields(names) {
  return Object.keys(LABEL_PHASES).map((field)=>[
      field,
      names[field]
    ]);
}
/**
 * Every phase that can be overridden, given the configured label names.
 *
 * Named in the rejection message an operator sees when they set `phase` on a
 * label that overrides nothing, so the message lists what *is* overridable
 * rather than leaving them to guess.
 */ export function overridablePhases(names = DEFAULT_BUILTIN_LABEL_NAMES) {
  return labelFields(names).flatMap(([field])=>[
      ...LABEL_PHASES[field]
    ]);
}
/**
 * Resolve which built-in phase a mapping overrides.
 *
 * @param label - The mapping's GitHub label
 * @param requestedPhase - The mapping's explicit `phase`, when it named one
 * @param names - The configured built-in label names
 * @returns `ok` with the phase, or `ok` with `undefined` when the label is not
 *   a built-in one (a new custom label — Issue #848 behaviour); `error` with a
 *   message naming the label and why it cannot be overridden
 */ export function resolveOverridePhase(label, requestedPhase, names = DEFAULT_BUILTIN_LABEL_NAMES) {
  const target = label.toLowerCase();
  const match = labelFields(names).find(([, name])=>name.toLowerCase() === target);
  if (!match) {
    if (requestedPhase !== undefined) {
      return {
        ok: false,
        error: `"phase" may only be set on a mapping that overrides a built-in ` + `label; "${label}" is not one, and a new custom label always runs ` + `the implementation phase. Overridable phases: ${overridablePhases(names).join(", ")}`
      };
    }
    return {
      ok: true,
      value: undefined
    };
  }
  const [field] = match;
  const phases = LABEL_PHASES[field];
  if (phases.length === 0) {
    return {
      ok: false,
      error: `"${label}" cannot be overridden: ${REFINE_ISSUE_REASON}`
    };
  }
  if (requestedPhase === undefined) return {
    ok: true,
    value: phases[0]
  };
  if (!phases.includes(requestedPhase)) {
    return {
      ok: false,
      error: `"${label}" overrides ${phases.join(" or ")}, not ` + `"${requestedPhase}"`
    };
  }
  return {
    ok: true,
    value: requestedPhase
  };
}
/**
 * Validate an override template against the placeholders **its own phase**
 * requires.
 *
 * This is the contract that separates an override from a new custom label: a
 * new label runs the implementation phase and so validates against `issue`,
 * whereas an override must satisfy whatever its target phase needs — `planning`
 * wants `{{PLANNING_LABEL}}`, `quorum` additionally wants
 * `{{BOUNDARY_INTEGRITY_INSTRUCTION}}`. Getting that wrong renders a prompt
 * with unfilled markers, or silently drops the fencing instruction from a
 * Quorum template.
 *
 * @param phase - The phase the template replaces
 * @param content - The operator's template text
 * @returns `ok`, or `error` naming the phase and the missing placeholders
 */ export function validateOverrideTemplate(phase, content) {
  if (content.trim().length === 0) {
    return {
      ok: false,
      error: `overrides phase "${phase}" but is empty`
    };
  }
  const required = getRequiredPlaceholders(phase);
  if (!required.ok) {
    return {
      ok: false,
      error: `overrides phase "${phase}", which has no registered ` + `placeholder contract: ${required.error.message}`
    };
  }
  const missing = required.value.filter((placeholder)=>!content.includes(`{{${placeholder}}}`));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `overrides phase "${phase}" but is missing the placeholders ` + `that phase requires: ${missing.map((name)=>`{{${name}}}`).join(", ")}`
    };
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9idWlsdGluX3Byb21wdF9vdmVycmlkZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaGljaCBidWlsdC1pbiBwaGFzZSBhIGBjdXN0b21fbGFiZWxfcHJvbXB0c2AgZW50cnkgb3ZlcnJpZGVzIChJc3N1ZSAjODQ5LFxuICogcGFydCBvZiAjODQzKS5cbiAqXG4gKiBJc3N1ZSAjODQ4IGdhdmUgYSAqKm5ldyoqIGxhYmVsIHRoZSBnZW5lcmljIGltcGxlbWVudGF0aW9uIHBoYXNlLiBUaGlzIG1vZHVsZVxuICogaXMgdGhlIG90aGVyIGhhbGY6IGFuIGVudHJ5IHdob3NlIGxhYmVsIG1hdGNoZXMgYSAqKmJ1aWx0LWluKiogbGFiZWwgcmVwbGFjZXNcbiAqIHRoYXQgcGhhc2UncyBvd24gdGVtcGxhdGUsIHNvIGFuIG9wZXJhdG9yIGNhbiBydW4gYSBub24tcHVibGljIGBwbGFubmluZ2AsXG4gKiBgZ3JpbGwtbWVgLCBgcXVlc3Rpb25gLCBgcXVvcnVtYCBvciBgd29yay1vbmAgcHJvbXB0LlxuICpcbiAqICMjIFR3byB0aGluZ3MgdGhpcyBtb2R1bGUgcmVmdXNlcyB0byBndWVzc1xuICpcbiAqIDEuICoqVGhlIGxhYmVsIG5hbWVzIGFyZSBvcGVyYXRvci1jb25maWd1cmFibGUuKiogYHBsYW5uaW5nYCBtYXkgYmVcbiAqICAgIGBwbGFuLWl0YCBvbiBhIGZsZWV0IHRoYXQgcmVuYW1lZCBpdCwgc28gdGhlIG1hcHBpbmcgaXMgcmVzb2x2ZWQgYWdhaW5zdFxuICogICAgdGhlIGNvbmZpZ3VyZWQgbmFtZXMgb24gYFdvcmtlckNvbmZpZ2Ag4oCUIG5ldmVyIGFnYWluc3QgaGFyZC1jb2RlZFxuICogICAgbGl0ZXJhbHMuXG4gKiAyLiAqKkEgdHdvLXR1cm4gcGhhc2UgaXMgdHdvIHRlbXBsYXRlcy4qKiBPdmVycmlkaW5nIGBwbGFubmluZ2AgZG9lcyBub3RcbiAqICAgIHRvdWNoIGBwbGFubmluZ19jcml0aXF1ZWAsIGFuZCBvdmVycmlkaW5nIGBxdW9ydW1gIGRvZXMgbm90IHRvdWNoXG4gKiAgICBgcXVvcnVtX2p1ZGdlYDogZWFjaCBpcyBhIHNlcGFyYXRlIHRlbXBsYXRlIHdpdGggaXRzIG93biByZXF1aXJlZFxuICogICAgcGxhY2Vob2xkZXJzLCBzbyBlYWNoIG5lZWRzIGl0cyBvd24gZW50cnkgbmFtaW5nIGl0cyBwaGFzZSBleHBsaWNpdGx5LlxuICogICAgSW5mZXJyaW5nIHRoZSBzZWNvbmQgdHVybiBmcm9tIHRoZSBmaXJzdCB3b3VsZCBoYW5kIGFuIGFnZW50IGEgcHJvbXB0IHRoZVxuICogICAgb3BlcmF0b3IgbmV2ZXIgd3JvdGUuXG4gKlxuICogYHJlZmluZS1pc3N1ZWAgaGFzIG5vIHRlbXBsYXRlIGZpbGUgYXQgYWxsIOKAlCBgbGliL3JlZmluZW1lbnRfcHJvY2Vzc29yLnRzYFxuICogYnVpbGRzIGl0cyBwcm9tcHQgaW5saW5lIOKAlCBzbyBhIG1hcHBpbmcgbmFtaW5nIGl0IGlzIHJlamVjdGVkIGJ5IG5hbWUgd2l0aFxuICogdGhhdCByZWFzb24gcmF0aGVyIHRoYW4gZmFpbGluZyBsYXRlciB3aXRoIGEgY29uZnVzaW5nIFwicHJvbXB0IG5vdCBmb3VuZFwiLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgTEFCRUxfREVGQVVMVFMgfSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7IGdldFJlcXVpcmVkUGxhY2Vob2xkZXJzIH0gZnJvbSBcIi4vcHJvbXB0X21hbmFnZXIudHNcIjtcblxuLyoqXG4gKiBUaGUgb3BlcmF0b3ItY29uZmlndXJhYmxlIGxhYmVsIG5hbWVzIGFuIG92ZXJyaWRlIG1heSBuYW1lLlxuICpcbiAqIEEgc3RydWN0dXJhbCBzdWJzZXQgb2YgYFdvcmtlckNvbmZpZ2AsIHNvIGNvbmZpZyBsb2FkIGNhbiBwYXNzIHRoZSByZXNvbHZlZFxuICogY29uZmlnIGFuZCB0ZXN0cyBjYW4gcGFzcyBhIGxpdGVyYWwuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQnVpbHRJbkxhYmVsTmFtZXMge1xuICB3b3JrT25MYWJlbDogc3RyaW5nO1xuICBwbGFubmluZ0xhYmVsOiBzdHJpbmc7XG4gIHF1ZXN0aW9uTGFiZWw6IHN0cmluZztcbiAgZ3JpbGxNZUxhYmVsOiBzdHJpbmc7XG4gIHF1b3J1bUxhYmVsOiBzdHJpbmc7XG4gIHJlZmluZUlzc3VlTGFiZWw6IHN0cmluZztcbn1cblxuLyoqIFRoZSBzdG9jayBsYWJlbCBuYW1lcywgdXNlZCB3aGVuIGEgY2FsbGVyIHN1cHBsaWVzIG5vbmUuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9CVUlMVElOX0xBQkVMX05BTUVTOiBCdWlsdEluTGFiZWxOYW1lcyA9IHtcbiAgd29ya09uTGFiZWw6IExBQkVMX0RFRkFVTFRTLndvcmtPbkxhYmVsLFxuICBwbGFubmluZ0xhYmVsOiBMQUJFTF9ERUZBVUxUUy5wbGFubmluZ0xhYmVsLFxuICBxdWVzdGlvbkxhYmVsOiBMQUJFTF9ERUZBVUxUUy5xdWVzdGlvbkxhYmVsLFxuICBncmlsbE1lTGFiZWw6IExBQkVMX0RFRkFVTFRTLmdyaWxsTWVMYWJlbCxcbiAgcXVvcnVtTGFiZWw6IExBQkVMX0RFRkFVTFRTLnF1b3J1bUxhYmVsLFxuICByZWZpbmVJc3N1ZUxhYmVsOiBMQUJFTF9ERUZBVUxUUy5yZWZpbmVJc3N1ZUxhYmVsLFxufTtcblxuLyoqXG4gKiBUaGUgcGhhc2VzIGVhY2ggYnVpbHQtaW4gbGFiZWwgb3ducywgZmlyc3QgZW50cnkgZmlyc3QuXG4gKlxuICogVGhlIGZpcnN0IHBoYXNlIGlzIHdoYXQgYW4gZW50cnkgb3ZlcnJpZGVzIHdoZW4gaXQgbmFtZXMgbm8gYHBoYXNlYDsgdGhlXG4gKiByZXN0IGFyZSB0aGUgbGF0ZXIgdHVybnMsIHdoaWNoIG11c3QgYmUgbmFtZWQgZXhwbGljaXRseS4gYHJlZmluZUlzc3VlTGFiZWxgXG4gKiBvd25zIG5vdGhpbmcg4oCUIHNlZSB7QGxpbmsgUkVGSU5FX0lTU1VFX1JFQVNPTn0uXG4gKi9cbmNvbnN0IExBQkVMX1BIQVNFUzogUmVjb3JkPGtleW9mIEJ1aWx0SW5MYWJlbE5hbWVzLCByZWFkb25seSBzdHJpbmdbXT4gPSB7XG4gIHdvcmtPbkxhYmVsOiBbXCJpc3N1ZVwiXSxcbiAgcGxhbm5pbmdMYWJlbDogW1wicGxhbm5pbmdcIiwgXCJwbGFubmluZ19jcml0aXF1ZVwiXSxcbiAgcXVlc3Rpb25MYWJlbDogW1wicXVlc3Rpb25cIl0sXG4gIGdyaWxsTWVMYWJlbDogW1wiZ3JpbGwtbWVcIl0sXG4gIHF1b3J1bUxhYmVsOiBbXCJxdW9ydW1cIiwgXCJxdW9ydW1fanVkZ2VcIl0sXG4gIHJlZmluZUlzc3VlTGFiZWw6IFtdLFxufTtcblxuLyoqIFdoeSBhIGByZWZpbmUtaXNzdWVgIG1hcHBpbmcgaXMgcmVmdXNlZC4gKi9cbmV4cG9ydCBjb25zdCBSRUZJTkVfSVNTVUVfUkVBU09OID1cbiAgXCJ0aGUgcmVmaW5lbWVudCBwaGFzZSBidWlsZHMgaXRzIHByb21wdCBpbmxpbmUgaW4gXCIgK1xuICBcImxpYi9yZWZpbmVtZW50X3Byb2Nlc3Nvci50cyBhbmQgaGFzIG5vIHRlbXBsYXRlIGZpbGUgdG8gb3ZlcnJpZGVcIjtcblxuLyoqIFRoZSBsYWJlbCBuYW1lIGVhY2ggYnVpbHQtaW4gZmllbGQgY2FycmllcywgaW4gbWF0Y2ggb3JkZXIuICovXG5mdW5jdGlvbiBsYWJlbEZpZWxkcyhcbiAgbmFtZXM6IEJ1aWx0SW5MYWJlbE5hbWVzLFxuKTogW2tleW9mIEJ1aWx0SW5MYWJlbE5hbWVzLCBzdHJpbmddW10ge1xuICByZXR1cm4gKE9iamVjdC5rZXlzKExBQkVMX1BIQVNFUykgYXMgKGtleW9mIEJ1aWx0SW5MYWJlbE5hbWVzKVtdKVxuICAgIC5tYXAoKGZpZWxkKSA9PiBbZmllbGQsIG5hbWVzW2ZpZWxkXV0pO1xufVxuXG4vKipcbiAqIEV2ZXJ5IHBoYXNlIHRoYXQgY2FuIGJlIG92ZXJyaWRkZW4sIGdpdmVuIHRoZSBjb25maWd1cmVkIGxhYmVsIG5hbWVzLlxuICpcbiAqIE5hbWVkIGluIHRoZSByZWplY3Rpb24gbWVzc2FnZSBhbiBvcGVyYXRvciBzZWVzIHdoZW4gdGhleSBzZXQgYHBoYXNlYCBvbiBhXG4gKiBsYWJlbCB0aGF0IG92ZXJyaWRlcyBub3RoaW5nLCBzbyB0aGUgbWVzc2FnZSBsaXN0cyB3aGF0ICppcyogb3ZlcnJpZGFibGVcbiAqIHJhdGhlciB0aGFuIGxlYXZpbmcgdGhlbSB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG92ZXJyaWRhYmxlUGhhc2VzKFxuICBuYW1lczogQnVpbHRJbkxhYmVsTmFtZXMgPSBERUZBVUxUX0JVSUxUSU5fTEFCRUxfTkFNRVMsXG4pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBsYWJlbEZpZWxkcyhuYW1lcykuZmxhdE1hcCgoW2ZpZWxkXSkgPT4gWy4uLkxBQkVMX1BIQVNFU1tmaWVsZF1dKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHdoaWNoIGJ1aWx0LWluIHBoYXNlIGEgbWFwcGluZyBvdmVycmlkZXMuXG4gKlxuICogQHBhcmFtIGxhYmVsIC0gVGhlIG1hcHBpbmcncyBHaXRIdWIgbGFiZWxcbiAqIEBwYXJhbSByZXF1ZXN0ZWRQaGFzZSAtIFRoZSBtYXBwaW5nJ3MgZXhwbGljaXQgYHBoYXNlYCwgd2hlbiBpdCBuYW1lZCBvbmVcbiAqIEBwYXJhbSBuYW1lcyAtIFRoZSBjb25maWd1cmVkIGJ1aWx0LWluIGxhYmVsIG5hbWVzXG4gKiBAcmV0dXJucyBgb2tgIHdpdGggdGhlIHBoYXNlLCBvciBgb2tgIHdpdGggYHVuZGVmaW5lZGAgd2hlbiB0aGUgbGFiZWwgaXMgbm90XG4gKiAgIGEgYnVpbHQtaW4gb25lIChhIG5ldyBjdXN0b20gbGFiZWwg4oCUIElzc3VlICM4NDggYmVoYXZpb3VyKTsgYGVycm9yYCB3aXRoIGFcbiAqICAgbWVzc2FnZSBuYW1pbmcgdGhlIGxhYmVsIGFuZCB3aHkgaXQgY2Fubm90IGJlIG92ZXJyaWRkZW5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVPdmVycmlkZVBoYXNlKFxuICBsYWJlbDogc3RyaW5nLFxuICByZXF1ZXN0ZWRQaGFzZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBuYW1lczogQnVpbHRJbkxhYmVsTmFtZXMgPSBERUZBVUxUX0JVSUxUSU5fTEFCRUxfTkFNRVMsXG4pOiBSZXN1bHQ8c3RyaW5nIHwgdW5kZWZpbmVkLCBzdHJpbmc+IHtcbiAgY29uc3QgdGFyZ2V0ID0gbGFiZWwudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgbWF0Y2ggPSBsYWJlbEZpZWxkcyhuYW1lcykuZmluZChcbiAgICAoWywgbmFtZV0pID0+IG5hbWUudG9Mb3dlckNhc2UoKSA9PT0gdGFyZ2V0LFxuICApO1xuXG4gIGlmICghbWF0Y2gpIHtcbiAgICBpZiAocmVxdWVzdGVkUGhhc2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjpcbiAgICAgICAgICBgXCJwaGFzZVwiIG1heSBvbmx5IGJlIHNldCBvbiBhIG1hcHBpbmcgdGhhdCBvdmVycmlkZXMgYSBidWlsdC1pbiBgICtcbiAgICAgICAgICBgbGFiZWw7IFwiJHtsYWJlbH1cIiBpcyBub3Qgb25lLCBhbmQgYSBuZXcgY3VzdG9tIGxhYmVsIGFsd2F5cyBydW5zIGAgK1xuICAgICAgICAgIGB0aGUgaW1wbGVtZW50YXRpb24gcGhhc2UuIE92ZXJyaWRhYmxlIHBoYXNlczogJHtcbiAgICAgICAgICAgIG92ZXJyaWRhYmxlUGhhc2VzKG5hbWVzKS5qb2luKFwiLCBcIilcbiAgICAgICAgICB9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cblxuICBjb25zdCBbZmllbGRdID0gbWF0Y2g7XG4gIGNvbnN0IHBoYXNlcyA9IExBQkVMX1BIQVNFU1tmaWVsZF07XG4gIGlmIChwaGFzZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgXCIke2xhYmVsfVwiIGNhbm5vdCBiZSBvdmVycmlkZGVuOiAke1JFRklORV9JU1NVRV9SRUFTT059YCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHJlcXVlc3RlZFBoYXNlID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGhhc2VzWzBdISB9O1xuICBpZiAoIXBoYXNlcy5pbmNsdWRlcyhyZXF1ZXN0ZWRQaGFzZSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBcIiR7bGFiZWx9XCIgb3ZlcnJpZGVzICR7cGhhc2VzLmpvaW4oXCIgb3IgXCIpfSwgbm90IGAgK1xuICAgICAgICBgXCIke3JlcXVlc3RlZFBoYXNlfVwiYCxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmVxdWVzdGVkUGhhc2UgfTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhbiBvdmVycmlkZSB0ZW1wbGF0ZSBhZ2FpbnN0IHRoZSBwbGFjZWhvbGRlcnMgKippdHMgb3duIHBoYXNlKipcbiAqIHJlcXVpcmVzLlxuICpcbiAqIFRoaXMgaXMgdGhlIGNvbnRyYWN0IHRoYXQgc2VwYXJhdGVzIGFuIG92ZXJyaWRlIGZyb20gYSBuZXcgY3VzdG9tIGxhYmVsOiBhXG4gKiBuZXcgbGFiZWwgcnVucyB0aGUgaW1wbGVtZW50YXRpb24gcGhhc2UgYW5kIHNvIHZhbGlkYXRlcyBhZ2FpbnN0IGBpc3N1ZWAsXG4gKiB3aGVyZWFzIGFuIG92ZXJyaWRlIG11c3Qgc2F0aXNmeSB3aGF0ZXZlciBpdHMgdGFyZ2V0IHBoYXNlIG5lZWRzIOKAlCBgcGxhbm5pbmdgXG4gKiB3YW50cyBge3tQTEFOTklOR19MQUJFTH19YCwgYHF1b3J1bWAgYWRkaXRpb25hbGx5IHdhbnRzXG4gKiBge3tCT1VOREFSWV9JTlRFR1JJVFlfSU5TVFJVQ1RJT059fWAuIEdldHRpbmcgdGhhdCB3cm9uZyByZW5kZXJzIGEgcHJvbXB0XG4gKiB3aXRoIHVuZmlsbGVkIG1hcmtlcnMsIG9yIHNpbGVudGx5IGRyb3BzIHRoZSBmZW5jaW5nIGluc3RydWN0aW9uIGZyb20gYVxuICogUXVvcnVtIHRlbXBsYXRlLlxuICpcbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSB0aGUgdGVtcGxhdGUgcmVwbGFjZXNcbiAqIEBwYXJhbSBjb250ZW50IC0gVGhlIG9wZXJhdG9yJ3MgdGVtcGxhdGUgdGV4dFxuICogQHJldHVybnMgYG9rYCwgb3IgYGVycm9yYCBuYW1pbmcgdGhlIHBoYXNlIGFuZCB0aGUgbWlzc2luZyBwbGFjZWhvbGRlcnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlT3ZlcnJpZGVUZW1wbGF0ZShcbiAgcGhhc2U6IHN0cmluZyxcbiAgY29udGVudDogc3RyaW5nLFxuKTogUmVzdWx0PHZvaWQsIHN0cmluZz4ge1xuICBpZiAoY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYG92ZXJyaWRlcyBwaGFzZSBcIiR7cGhhc2V9XCIgYnV0IGlzIGVtcHR5YCB9O1xuICB9XG4gIGNvbnN0IHJlcXVpcmVkID0gZ2V0UmVxdWlyZWRQbGFjZWhvbGRlcnMocGhhc2UpO1xuICBpZiAoIXJlcXVpcmVkLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgb3ZlcnJpZGVzIHBoYXNlIFwiJHtwaGFzZX1cIiwgd2hpY2ggaGFzIG5vIHJlZ2lzdGVyZWQgYCArXG4gICAgICAgIGBwbGFjZWhvbGRlciBjb250cmFjdDogJHtyZXF1aXJlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgfTtcbiAgfVxuICBjb25zdCBtaXNzaW5nID0gcmVxdWlyZWQudmFsdWUuZmlsdGVyKFxuICAgIChwbGFjZWhvbGRlcikgPT4gIWNvbnRlbnQuaW5jbHVkZXMoYHt7JHtwbGFjZWhvbGRlcn19fWApLFxuICApO1xuICBpZiAobWlzc2luZy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgb3ZlcnJpZGVzIHBoYXNlIFwiJHtwaGFzZX1cIiBidXQgaXMgbWlzc2luZyB0aGUgcGxhY2Vob2xkZXJzIGAgK1xuICAgICAgICBgdGhhdCBwaGFzZSByZXF1aXJlczogJHtcbiAgICAgICAgICBtaXNzaW5nLm1hcCgobmFtZSkgPT4gYHt7JHtuYW1lfX19YCkuam9pbihcIiwgXCIpXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMkJDLEdBR0QsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBQ3RELFNBQVMsdUJBQXVCLFFBQVEsc0JBQXNCO0FBaUI5RCw2REFBNkQsR0FDN0QsT0FBTyxNQUFNLDhCQUFpRDtFQUM1RCxhQUFhLGVBQWUsV0FBVztFQUN2QyxlQUFlLGVBQWUsYUFBYTtFQUMzQyxlQUFlLGVBQWUsYUFBYTtFQUMzQyxjQUFjLGVBQWUsWUFBWTtFQUN6QyxhQUFhLGVBQWUsV0FBVztFQUN2QyxrQkFBa0IsZUFBZSxnQkFBZ0I7QUFDbkQsRUFBRTtBQUVGOzs7Ozs7Q0FNQyxHQUNELE1BQU0sZUFBbUU7RUFDdkUsYUFBYTtJQUFDO0dBQVE7RUFDdEIsZUFBZTtJQUFDO0lBQVk7R0FBb0I7RUFDaEQsZUFBZTtJQUFDO0dBQVc7RUFDM0IsY0FBYztJQUFDO0dBQVc7RUFDMUIsYUFBYTtJQUFDO0lBQVU7R0FBZTtFQUN2QyxrQkFBa0IsRUFBRTtB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
// denoCacheMetadata=1497273088033311216,13643125149841249243