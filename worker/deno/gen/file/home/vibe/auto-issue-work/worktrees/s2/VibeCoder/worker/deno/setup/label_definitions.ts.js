/**
 * Canonical label definitions for all monitored repositories.
 *
 * Single source of truth for label names, colours, and descriptions.
 * Labels are organised into categories:
 *   - workflow: Core workflow labels used by the worker (apply to all repos)
 *   - ui: Labels related to UI/screenshot evidence (only for repos with UI)
 *   - content: Classification/finding labels the fleet applies but does
 *     not seed onto every repo (Issue #368). Defined in
 *     `content_label_definitions.ts` and joined here into
 *     {@link ALL_LABEL_DEFINITIONS}, which is the canonical colour table
 *     {@link getLabelColour} resolves against.
 *
 * Issue #864: Standardise labels across repos we monitor.
 * Issue #923: Migrate to Deno TypeScript.
 * Issue #1748: Add the discovery/watch labels (claude, help wanted) and the
 *   low-priority backlog label so their colours and descriptions are
 *   standardised by the same sync pass as the rest of the workflow labels.
 * Issue #2022: Retire the `claude` and `help wanted` discovery/watch labels.
 *   The hardwired priority order is now
 *   `top-priority` > `work-on` > `low-priority` > `idle-task`. `idle-task`
 *   is the only label the Vibe Coder may self-apply.
 * Issue #2029: Retire the `refined` completion label. The refinement
 *   workflow now signals handoff by adding `needs-human` (the existing
 *   worker-to-human escalation label).
 * Issue #368: Add the `content` category so every fleet-managed label —
 *   `severity:*`, `confidence:*`, `security`, `lang:*`, the per-scan
 *   category labels — has one canonical colour instead of nine call sites
 *   each hard-coding their own literal.
 */ import { CONTENT_LABEL_DEFINITIONS } from "./content_label_definitions.ts";
export { CONTENT_LABEL_DEFINITIONS };
/**
 * All canonical label definitions.
 * Order matches the original shell script for consistency.
 */ export const LABEL_DEFINITIONS = [
  // Workflow labels — apply to all repos
  {
    name: "failed",
    colour: "d73a4a",
    description: "Issue failed permanently after two attempts",
    category: "workflow"
  },
  {
    name: "failed-once",
    colour: "fbca04",
    description: "Issue failed once - will be retried",
    category: "workflow"
  },
  // Issue #2031: needs-clarification retired — see DEPRECATED_LABELS below.
  {
    name: "refine-issue",
    colour: "0366d6",
    description: "Issue being refined collaboratively before implementation",
    category: "workflow"
  },
  {
    name: "planning",
    colour: "1d76db",
    description: "Issue in planning mode - creating sub-issues and task breakdown",
    category: "workflow"
  },
  {
    name: "question",
    colour: "cc317c",
    description: "Issue has a question to be answered",
    category: "workflow"
  },
  // Issue #2030: `answered` retired — question workflow now signals handoff
  // with `needs-human`. See DEPRECATED_LABELS below.
  {
    name: "work-on",
    colour: "5319e7",
    description: "Signal to work on this issue",
    category: "workflow"
  },
  {
    name: "documentation",
    colour: "0075ca",
    description: "Documentation only change",
    category: "workflow"
  },
  {
    name: "needs-revision",
    colour: "e99695",
    description: "Issue needs revision based on review",
    category: "workflow"
  },
  {
    name: "needs-human",
    colour: "fbca04",
    description: "Worker has escalated this issue to a human",
    category: "workflow"
  },
  {
    name: "grill-me",
    colour: "fbca04",
    description: "Issue being grilled — interactive back-and-forth scoping before planning",
    category: "workflow"
  },
  // Issue #4112: quorum — a human applies it to run a three-agent plan-off
  // ahead of planning. Reserved: the worker never self-applies it.
  {
    name: "quorum",
    colour: "5319e7",
    description: "Apply by hand to run a Quorum plan-off — two agents draft a plan, a third judges, ahead of planning",
    category: "workflow"
  },
  {
    name: "top-priority",
    colour: "b60205",
    description: "Highest-priority issue — pick this up before other work",
    category: "workflow"
  },
  {
    name: "low-priority",
    colour: "c2e0c6",
    description: "Backlog work — picked up only when no other eligible work exists",
    category: "workflow"
  },
  // Idle-task label — worker-filed busywork. Lowest priority in the queue (Issue #1961).
  {
    name: "idle-task",
    colour: "cccccc",
    description: "Worker-filed task to run when no claimable work exists. Lowest priority.",
    category: "workflow"
  },
  // Issue #2077: `idle-task-pending` retired — `idle-task` is already
  // the lowest priority in the queue, so the separate approval gate
  // added no value. See DEPRECATED_LABELS below.
  // Issue #2650: degraded-model — worker-appliable (non-reserved) signal that a
  // planning run was served by a model other than the configured planning model.
  // `best-model` is reserved and cannot carry this signal — this is its
  // non-reserved replacement. Humans clear it after investigating.
  {
    name: "degraded-model",
    colour: "e99695",
    description: "Generated by a model other than the configured planning model",
    category: "workflow"
  },
  // Issue #59 (part of #54): needs-failure-detection-repair — the planning run
  // published a usable plan, but one or more sub-issues still lack a filled
  // `## Failure Detection` section after the self-repair. Reserved (the planner
  // may never self-apply it) and raised only by the worker.
  {
    name: "needs-failure-detection-repair",
    colour: "d4c5f9",
    description: "Published sub-issues still need their `## Failure Detection` criterion",
    category: "workflow"
  },
  // Issue #2904: orphan-deps — label carried by orphan-dependency idle-task
  // findings (the sixth idle-task template). Seeded on monitored repos so
  // onboarding / label-sync create it ahead of the first scan.
  {
    name: "orphan-deps",
    colour: "0e8a16",
    description: "Orphan / unmaintained dependency finding from the orphan-deps idle-task scan",
    category: "workflow"
  },
  // UI labels — only for repos with UI/screenshot capability
  {
    name: "needs-screenshot",
    colour: "d93f0b",
    description: "Previous attempt was blocked for missing screenshot evidence",
    category: "ui"
  }
];
/**
 * The canonical colour table for **every** label the fleet manages
 * (Issue #368).
 *
 * {@link LABEL_DEFINITIONS} carries the workflow/UI labels seeded onto
 * every monitored repo at onboarding; {@link CONTENT_LABEL_DEFINITIONS}
 * carries the classification/finding labels that appear only once a scan
 * files something. Both halves are colour-authoritative, so lookups —
 * `ensureLabelExists`, and the colour reconcile pass — resolve against
 * this union rather than against either half.
 */ export const ALL_LABEL_DEFINITIONS = [
  ...LABEL_DEFINITIONS,
  ...CONTENT_LABEL_DEFINITIONS
];
/**
 * Colour used for a label the canonical table does not name.
 *
 * GitHub's own "bug" red. A label that lands here is not fleet-managed —
 * the reconcile pass ignores it, and only a create-if-missing call ever
 * paints it.
 */ export const DEFAULT_LABEL_COLOUR = "d73a4a";
/**
 * Labels that have been deprecated and should be removed from repos.
 * Add entries here when retiring a label.
 *
 * Only labels the fleet itself created belong here. GitHub's stock labels
 * are listed in {@link PROTECTED_STOCK_LABELS} and are never deleted
 * (Issue #1295).
 */ export const DEPRECATED_LABELS = [
  "best-model",
  "skip-clarification",
  "needs-clarification",
  "answered",
  "claude",
  "refined",
  "idle-task-pending"
];
/**
 * GitHub's own stock labels, which ship with every new repository (Issue #1295).
 *
 * The worker never created them and human maintainers commonly use them for
 * their own triage, so the deprecated-label pass never deletes them —
 * deletion is irreversible and takes the label's attachment to every issue
 * with it. The worker stopped *reading* `help wanted` as a discovery label in
 * Issue #2022, which is a reason to ignore it, not a licence to delete a
 * maintainer's label.
 *
 * The guard is enforced in code (`removeDeprecatedLabels`), so re-adding one
 * of these names to {@link DEPRECATED_LABELS} by mistake still deletes
 * nothing.
 */ export const PROTECTED_STOCK_LABELS = [
  "good first issue",
  "help wanted",
  // `dependencies` is GitHub's stock dependency-PR label and the name
  // dependabot.yml's `labels:` references. Deleting it (or never having
  // it) makes every dependabot PR carry a "could not be found" nag, so it
  // joins the stock set the deprecated-label pass never touches.
  "dependencies"
];
/** True when `name` is one of GitHub's stock labels the fleet must not delete. */ export function isProtectedStockLabel(name) {
  const normalised = name.trim().toLowerCase();
  return PROTECTED_STOCK_LABELS.includes(normalised);
}
/**
 * UI languages used to detect repos with frontend components.
 */ const UI_LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "HTML",
  "CSS",
  "Vue",
  "Svelte"
];
/** Get all label definitions. */ export function getAllLabels() {
  return LABEL_DEFINITIONS;
}
/** Get labels for a specific category. */ export function getLabelsByCategory(category) {
  return LABEL_DEFINITIONS.filter((l)=>l.category === category);
}
/**
 * Get a label definition by name from the canonical table
 * (returns undefined if the fleet does not manage that label).
 *
 * Matching is case-insensitive because GitHub treats label names that way
 * — `SEVERITY:HIGH` and `severity:high` are the same label, and the
 * reconcile pass must recognise either spelling (Issue #368).
 */ export function getLabelByName(name) {
  const lower = name.toLowerCase();
  return ALL_LABEL_DEFINITIONS.find((l)=>l.name.toLowerCase() === lower);
}
/**
 * Canonical colour for a label name (Issue #368).
 *
 * Returns {@link DEFAULT_LABEL_COLOUR} for a label the table does not
 * name, so a create-if-missing call always has a colour to use.
 */ export function getLabelColour(name) {
  return getLabelByName(name)?.colour ?? DEFAULT_LABEL_COLOUR;
}
/**
 * Canonical description for a label name (Issue #368).
 *
 * Empty string when the table does not name the label — callers pass it
 * straight through to `gh label create`, which omits an empty description.
 */ export function getLabelDescription(name) {
  return getLabelByName(name)?.description ?? "";
}
/** Get the number of defined labels. */ export function getLabelCount() {
  return LABEL_DEFINITIONS.length;
}
/**
 * Check if a repository has UI components based on its languages.
 *
 * @param languages - Object mapping language names to byte counts (from GitHub API)
 * @returns true if the repo has any UI-related languages
 */ export function repoHasUi(languages) {
  return UI_LANGUAGES.some((lang)=>lang in languages);
}
/**
 * Get the labels applicable to a given repo.
 *
 * @param hasUi - Whether the repo has UI components
 * @returns Array of applicable label definitions
 */ export function getApplicableLabels(hasUi) {
  if (hasUi) {
    return [
      ...LABEL_DEFINITIONS
    ];
  }
  return LABEL_DEFINITIONS.filter((l)=>l.category !== "ui");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL3NldHVwL2xhYmVsX2RlZmluaXRpb25zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2Fub25pY2FsIGxhYmVsIGRlZmluaXRpb25zIGZvciBhbGwgbW9uaXRvcmVkIHJlcG9zaXRvcmllcy5cbiAqXG4gKiBTaW5nbGUgc291cmNlIG9mIHRydXRoIGZvciBsYWJlbCBuYW1lcywgY29sb3VycywgYW5kIGRlc2NyaXB0aW9ucy5cbiAqIExhYmVscyBhcmUgb3JnYW5pc2VkIGludG8gY2F0ZWdvcmllczpcbiAqICAgLSB3b3JrZmxvdzogQ29yZSB3b3JrZmxvdyBsYWJlbHMgdXNlZCBieSB0aGUgd29ya2VyIChhcHBseSB0byBhbGwgcmVwb3MpXG4gKiAgIC0gdWk6IExhYmVscyByZWxhdGVkIHRvIFVJL3NjcmVlbnNob3QgZXZpZGVuY2UgKG9ubHkgZm9yIHJlcG9zIHdpdGggVUkpXG4gKiAgIC0gY29udGVudDogQ2xhc3NpZmljYXRpb24vZmluZGluZyBsYWJlbHMgdGhlIGZsZWV0IGFwcGxpZXMgYnV0IGRvZXNcbiAqICAgICBub3Qgc2VlZCBvbnRvIGV2ZXJ5IHJlcG8gKElzc3VlICMzNjgpLiBEZWZpbmVkIGluXG4gKiAgICAgYGNvbnRlbnRfbGFiZWxfZGVmaW5pdGlvbnMudHNgIGFuZCBqb2luZWQgaGVyZSBpbnRvXG4gKiAgICAge0BsaW5rIEFMTF9MQUJFTF9ERUZJTklUSU9OU30sIHdoaWNoIGlzIHRoZSBjYW5vbmljYWwgY29sb3VyIHRhYmxlXG4gKiAgICAge0BsaW5rIGdldExhYmVsQ29sb3VyfSByZXNvbHZlcyBhZ2FpbnN0LlxuICpcbiAqIElzc3VlICM4NjQ6IFN0YW5kYXJkaXNlIGxhYmVscyBhY3Jvc3MgcmVwb3Mgd2UgbW9uaXRvci5cbiAqIElzc3VlICM5MjM6IE1pZ3JhdGUgdG8gRGVubyBUeXBlU2NyaXB0LlxuICogSXNzdWUgIzE3NDg6IEFkZCB0aGUgZGlzY292ZXJ5L3dhdGNoIGxhYmVscyAoY2xhdWRlLCBoZWxwIHdhbnRlZCkgYW5kIHRoZVxuICogICBsb3ctcHJpb3JpdHkgYmFja2xvZyBsYWJlbCBzbyB0aGVpciBjb2xvdXJzIGFuZCBkZXNjcmlwdGlvbnMgYXJlXG4gKiAgIHN0YW5kYXJkaXNlZCBieSB0aGUgc2FtZSBzeW5jIHBhc3MgYXMgdGhlIHJlc3Qgb2YgdGhlIHdvcmtmbG93IGxhYmVscy5cbiAqIElzc3VlICMyMDIyOiBSZXRpcmUgdGhlIGBjbGF1ZGVgIGFuZCBgaGVscCB3YW50ZWRgIGRpc2NvdmVyeS93YXRjaCBsYWJlbHMuXG4gKiAgIFRoZSBoYXJkd2lyZWQgcHJpb3JpdHkgb3JkZXIgaXMgbm93XG4gKiAgIGB0b3AtcHJpb3JpdHlgID4gYHdvcmstb25gID4gYGxvdy1wcmlvcml0eWAgPiBgaWRsZS10YXNrYC4gYGlkbGUtdGFza2BcbiAqICAgaXMgdGhlIG9ubHkgbGFiZWwgdGhlIFZpYmUgQ29kZXIgbWF5IHNlbGYtYXBwbHkuXG4gKiBJc3N1ZSAjMjAyOTogUmV0aXJlIHRoZSBgcmVmaW5lZGAgY29tcGxldGlvbiBsYWJlbC4gVGhlIHJlZmluZW1lbnRcbiAqICAgd29ya2Zsb3cgbm93IHNpZ25hbHMgaGFuZG9mZiBieSBhZGRpbmcgYG5lZWRzLWh1bWFuYCAodGhlIGV4aXN0aW5nXG4gKiAgIHdvcmtlci10by1odW1hbiBlc2NhbGF0aW9uIGxhYmVsKS5cbiAqIElzc3VlICMzNjg6IEFkZCB0aGUgYGNvbnRlbnRgIGNhdGVnb3J5IHNvIGV2ZXJ5IGZsZWV0LW1hbmFnZWQgbGFiZWwg4oCUXG4gKiAgIGBzZXZlcml0eToqYCwgYGNvbmZpZGVuY2U6KmAsIGBzZWN1cml0eWAsIGBsYW5nOipgLCB0aGUgcGVyLXNjYW5cbiAqICAgY2F0ZWdvcnkgbGFiZWxzIOKAlCBoYXMgb25lIGNhbm9uaWNhbCBjb2xvdXIgaW5zdGVhZCBvZiBuaW5lIGNhbGwgc2l0ZXNcbiAqICAgZWFjaCBoYXJkLWNvZGluZyB0aGVpciBvd24gbGl0ZXJhbC5cbiAqL1xuXG5pbXBvcnQgeyBDT05URU5UX0xBQkVMX0RFRklOSVRJT05TIH0gZnJvbSBcIi4vY29udGVudF9sYWJlbF9kZWZpbml0aW9ucy50c1wiO1xuXG5leHBvcnQgeyBDT05URU5UX0xBQkVMX0RFRklOSVRJT05TIH07XG5cbi8qKiBDYXRlZ29yeSBmb3IgYSBsYWJlbCBkZWZpbml0aW9uLiAqL1xuZXhwb3J0IHR5cGUgTGFiZWxDYXRlZ29yeSA9IFwid29ya2Zsb3dcIiB8IFwidWlcIiB8IFwiY29udGVudFwiO1xuXG4vKiogQSBzaW5nbGUgbGFiZWwgZGVmaW5pdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGFiZWxEZWZpbml0aW9uIHtcbiAgLyoqIExhYmVsIG5hbWUgYXMgc2hvd24gb24gR2l0SHViLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBIZXggY29sb3VyIGNvZGUgd2l0aG91dCAjIHByZWZpeC4gKi9cbiAgY29sb3VyOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBkZXNjcmlwdGlvbi4gKi9cbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgLyoqIENhdGVnb3J5IGRldGVybWluZXMgd2hpY2ggcmVwb3MgcmVjZWl2ZSB0aGlzIGxhYmVsLiAqL1xuICBjYXRlZ29yeTogTGFiZWxDYXRlZ29yeTtcbn1cblxuLyoqXG4gKiBBbGwgY2Fub25pY2FsIGxhYmVsIGRlZmluaXRpb25zLlxuICogT3JkZXIgbWF0Y2hlcyB0aGUgb3JpZ2luYWwgc2hlbGwgc2NyaXB0IGZvciBjb25zaXN0ZW5jeS5cbiAqL1xuZXhwb3J0IGNvbnN0IExBQkVMX0RFRklOSVRJT05TOiByZWFkb25seSBMYWJlbERlZmluaXRpb25bXSA9IFtcbiAgLy8gV29ya2Zsb3cgbGFiZWxzIOKAlCBhcHBseSB0byBhbGwgcmVwb3NcbiAge1xuICAgIG5hbWU6IFwiZmFpbGVkXCIsXG4gICAgY29sb3VyOiBcImQ3M2E0YVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIklzc3VlIGZhaWxlZCBwZXJtYW5lbnRseSBhZnRlciB0d28gYXR0ZW1wdHNcIixcbiAgICBjYXRlZ29yeTogXCJ3b3JrZmxvd1wiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmYWlsZWQtb25jZVwiLFxuICAgIGNvbG91cjogXCJmYmNhMDRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJJc3N1ZSBmYWlsZWQgb25jZSAtIHdpbGwgYmUgcmV0cmllZFwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIC8vIElzc3VlICMyMDMxOiBuZWVkcy1jbGFyaWZpY2F0aW9uIHJldGlyZWQg4oCUIHNlZSBERVBSRUNBVEVEX0xBQkVMUyBiZWxvdy5cbiAge1xuICAgIG5hbWU6IFwicmVmaW5lLWlzc3VlXCIsXG4gICAgY29sb3VyOiBcIjAzNjZkNlwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIklzc3VlIGJlaW5nIHJlZmluZWQgY29sbGFib3JhdGl2ZWx5IGJlZm9yZSBpbXBsZW1lbnRhdGlvblwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInBsYW5uaW5nXCIsXG4gICAgY29sb3VyOiBcIjFkNzZkYlwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJJc3N1ZSBpbiBwbGFubmluZyBtb2RlIC0gY3JlYXRpbmcgc3ViLWlzc3VlcyBhbmQgdGFzayBicmVha2Rvd25cIixcbiAgICBjYXRlZ29yeTogXCJ3b3JrZmxvd1wiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJxdWVzdGlvblwiLFxuICAgIGNvbG91cjogXCJjYzMxN2NcIixcbiAgICBkZXNjcmlwdGlvbjogXCJJc3N1ZSBoYXMgYSBxdWVzdGlvbiB0byBiZSBhbnN3ZXJlZFwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIC8vIElzc3VlICMyMDMwOiBgYW5zd2VyZWRgIHJldGlyZWQg4oCUIHF1ZXN0aW9uIHdvcmtmbG93IG5vdyBzaWduYWxzIGhhbmRvZmZcbiAgLy8gd2l0aCBgbmVlZHMtaHVtYW5gLiBTZWUgREVQUkVDQVRFRF9MQUJFTFMgYmVsb3cuXG4gIHtcbiAgICBuYW1lOiBcIndvcmstb25cIixcbiAgICBjb2xvdXI6IFwiNTMxOWU3XCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2lnbmFsIHRvIHdvcmsgb24gdGhpcyBpc3N1ZVwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3VtZW50YXRpb25cIixcbiAgICBjb2xvdXI6IFwiMDA3NWNhXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRG9jdW1lbnRhdGlvbiBvbmx5IGNoYW5nZVwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5lZWRzLXJldmlzaW9uXCIsXG4gICAgY29sb3VyOiBcImU5OTY5NVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIklzc3VlIG5lZWRzIHJldmlzaW9uIGJhc2VkIG9uIHJldmlld1wiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5lZWRzLWh1bWFuXCIsXG4gICAgY29sb3VyOiBcImZiY2EwNFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIldvcmtlciBoYXMgZXNjYWxhdGVkIHRoaXMgaXNzdWUgdG8gYSBodW1hblwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyaWxsLW1lXCIsXG4gICAgY29sb3VyOiBcImZiY2EwNFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJJc3N1ZSBiZWluZyBncmlsbGVkIOKAlCBpbnRlcmFjdGl2ZSBiYWNrLWFuZC1mb3J0aCBzY29waW5nIGJlZm9yZSBwbGFubmluZ1wiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIC8vIElzc3VlICM0MTEyOiBxdW9ydW0g4oCUIGEgaHVtYW4gYXBwbGllcyBpdCB0byBydW4gYSB0aHJlZS1hZ2VudCBwbGFuLW9mZlxuICAvLyBhaGVhZCBvZiBwbGFubmluZy4gUmVzZXJ2ZWQ6IHRoZSB3b3JrZXIgbmV2ZXIgc2VsZi1hcHBsaWVzIGl0LlxuICB7XG4gICAgbmFtZTogXCJxdW9ydW1cIixcbiAgICBjb2xvdXI6IFwiNTMxOWU3XCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIkFwcGx5IGJ5IGhhbmQgdG8gcnVuIGEgUXVvcnVtIHBsYW4tb2ZmIOKAlCB0d28gYWdlbnRzIGRyYWZ0IGEgcGxhbiwgYSB0aGlyZCBqdWRnZXMsIGFoZWFkIG9mIHBsYW5uaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwid29ya2Zsb3dcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidG9wLXByaW9yaXR5XCIsXG4gICAgY29sb3VyOiBcImI2MDIwNVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkhpZ2hlc3QtcHJpb3JpdHkgaXNzdWUg4oCUIHBpY2sgdGhpcyB1cCBiZWZvcmUgb3RoZXIgd29ya1wiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxvdy1wcmlvcml0eVwiLFxuICAgIGNvbG91cjogXCJjMmUwYzZcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiQmFja2xvZyB3b3JrIOKAlCBwaWNrZWQgdXAgb25seSB3aGVuIG5vIG90aGVyIGVsaWdpYmxlIHdvcmsgZXhpc3RzXCIsXG4gICAgY2F0ZWdvcnk6IFwid29ya2Zsb3dcIixcbiAgfSxcbiAgLy8gSWRsZS10YXNrIGxhYmVsIOKAlCB3b3JrZXItZmlsZWQgYnVzeXdvcmsuIExvd2VzdCBwcmlvcml0eSBpbiB0aGUgcXVldWUgKElzc3VlICMxOTYxKS5cbiAge1xuICAgIG5hbWU6IFwiaWRsZS10YXNrXCIsXG4gICAgY29sb3VyOiBcImNjY2NjY1wiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJXb3JrZXItZmlsZWQgdGFzayB0byBydW4gd2hlbiBubyBjbGFpbWFibGUgd29yayBleGlzdHMuIExvd2VzdCBwcmlvcml0eS5cIixcbiAgICBjYXRlZ29yeTogXCJ3b3JrZmxvd1wiLFxuICB9LFxuICAvLyBJc3N1ZSAjMjA3NzogYGlkbGUtdGFzay1wZW5kaW5nYCByZXRpcmVkIOKAlCBgaWRsZS10YXNrYCBpcyBhbHJlYWR5XG4gIC8vIHRoZSBsb3dlc3QgcHJpb3JpdHkgaW4gdGhlIHF1ZXVlLCBzbyB0aGUgc2VwYXJhdGUgYXBwcm92YWwgZ2F0ZVxuICAvLyBhZGRlZCBubyB2YWx1ZS4gU2VlIERFUFJFQ0FURURfTEFCRUxTIGJlbG93LlxuICAvLyBJc3N1ZSAjMjY1MDogZGVncmFkZWQtbW9kZWwg4oCUIHdvcmtlci1hcHBsaWFibGUgKG5vbi1yZXNlcnZlZCkgc2lnbmFsIHRoYXQgYVxuICAvLyBwbGFubmluZyBydW4gd2FzIHNlcnZlZCBieSBhIG1vZGVsIG90aGVyIHRoYW4gdGhlIGNvbmZpZ3VyZWQgcGxhbm5pbmcgbW9kZWwuXG4gIC8vIGBiZXN0LW1vZGVsYCBpcyByZXNlcnZlZCBhbmQgY2Fubm90IGNhcnJ5IHRoaXMgc2lnbmFsIOKAlCB0aGlzIGlzIGl0c1xuICAvLyBub24tcmVzZXJ2ZWQgcmVwbGFjZW1lbnQuIEh1bWFucyBjbGVhciBpdCBhZnRlciBpbnZlc3RpZ2F0aW5nLlxuICB7XG4gICAgbmFtZTogXCJkZWdyYWRlZC1tb2RlbFwiLFxuICAgIGNvbG91cjogXCJlOTk2OTVcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiR2VuZXJhdGVkIGJ5IGEgbW9kZWwgb3RoZXIgdGhhbiB0aGUgY29uZmlndXJlZCBwbGFubmluZyBtb2RlbFwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIC8vIElzc3VlICM1OSAocGFydCBvZiAjNTQpOiBuZWVkcy1mYWlsdXJlLWRldGVjdGlvbi1yZXBhaXIg4oCUIHRoZSBwbGFubmluZyBydW5cbiAgLy8gcHVibGlzaGVkIGEgdXNhYmxlIHBsYW4sIGJ1dCBvbmUgb3IgbW9yZSBzdWItaXNzdWVzIHN0aWxsIGxhY2sgYSBmaWxsZWRcbiAgLy8gYCMjIEZhaWx1cmUgRGV0ZWN0aW9uYCBzZWN0aW9uIGFmdGVyIHRoZSBzZWxmLXJlcGFpci4gUmVzZXJ2ZWQgKHRoZSBwbGFubmVyXG4gIC8vIG1heSBuZXZlciBzZWxmLWFwcGx5IGl0KSBhbmQgcmFpc2VkIG9ubHkgYnkgdGhlIHdvcmtlci5cbiAge1xuICAgIG5hbWU6IFwibmVlZHMtZmFpbHVyZS1kZXRlY3Rpb24tcmVwYWlyXCIsXG4gICAgY29sb3VyOiBcImQ0YzVmOVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJQdWJsaXNoZWQgc3ViLWlzc3VlcyBzdGlsbCBuZWVkIHRoZWlyIGAjIyBGYWlsdXJlIERldGVjdGlvbmAgY3JpdGVyaW9uXCIsXG4gICAgY2F0ZWdvcnk6IFwid29ya2Zsb3dcIixcbiAgfSxcbiAgLy8gSXNzdWUgIzI5MDQ6IG9ycGhhbi1kZXBzIOKAlCBsYWJlbCBjYXJyaWVkIGJ5IG9ycGhhbi1kZXBlbmRlbmN5IGlkbGUtdGFza1xuICAvLyBmaW5kaW5ncyAodGhlIHNpeHRoIGlkbGUtdGFzayB0ZW1wbGF0ZSkuIFNlZWRlZCBvbiBtb25pdG9yZWQgcmVwb3Mgc29cbiAgLy8gb25ib2FyZGluZyAvIGxhYmVsLXN5bmMgY3JlYXRlIGl0IGFoZWFkIG9mIHRoZSBmaXJzdCBzY2FuLlxuICB7XG4gICAgbmFtZTogXCJvcnBoYW4tZGVwc1wiLFxuICAgIGNvbG91cjogXCIwZThhMTZcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiT3JwaGFuIC8gdW5tYWludGFpbmVkIGRlcGVuZGVuY3kgZmluZGluZyBmcm9tIHRoZSBvcnBoYW4tZGVwcyBpZGxlLXRhc2sgc2NhblwiLFxuICAgIGNhdGVnb3J5OiBcIndvcmtmbG93XCIsXG4gIH0sXG4gIC8vIFVJIGxhYmVscyDigJQgb25seSBmb3IgcmVwb3Mgd2l0aCBVSS9zY3JlZW5zaG90IGNhcGFiaWxpdHlcbiAge1xuICAgIG5hbWU6IFwibmVlZHMtc2NyZWVuc2hvdFwiLFxuICAgIGNvbG91cjogXCJkOTNmMGJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJQcmV2aW91cyBhdHRlbXB0IHdhcyBibG9ja2VkIGZvciBtaXNzaW5nIHNjcmVlbnNob3QgZXZpZGVuY2VcIixcbiAgICBjYXRlZ29yeTogXCJ1aVwiLFxuICB9LFxuXSBhcyBjb25zdDtcblxuLyoqXG4gKiBUaGUgY2Fub25pY2FsIGNvbG91ciB0YWJsZSBmb3IgKipldmVyeSoqIGxhYmVsIHRoZSBmbGVldCBtYW5hZ2VzXG4gKiAoSXNzdWUgIzM2OCkuXG4gKlxuICoge0BsaW5rIExBQkVMX0RFRklOSVRJT05TfSBjYXJyaWVzIHRoZSB3b3JrZmxvdy9VSSBsYWJlbHMgc2VlZGVkIG9udG9cbiAqIGV2ZXJ5IG1vbml0b3JlZCByZXBvIGF0IG9uYm9hcmRpbmc7IHtAbGluayBDT05URU5UX0xBQkVMX0RFRklOSVRJT05TfVxuICogY2FycmllcyB0aGUgY2xhc3NpZmljYXRpb24vZmluZGluZyBsYWJlbHMgdGhhdCBhcHBlYXIgb25seSBvbmNlIGEgc2NhblxuICogZmlsZXMgc29tZXRoaW5nLiBCb3RoIGhhbHZlcyBhcmUgY29sb3VyLWF1dGhvcml0YXRpdmUsIHNvIGxvb2t1cHMg4oCUXG4gKiBgZW5zdXJlTGFiZWxFeGlzdHNgLCBhbmQgdGhlIGNvbG91ciByZWNvbmNpbGUgcGFzcyDigJQgcmVzb2x2ZSBhZ2FpbnN0XG4gKiB0aGlzIHVuaW9uIHJhdGhlciB0aGFuIGFnYWluc3QgZWl0aGVyIGhhbGYuXG4gKi9cbmV4cG9ydCBjb25zdCBBTExfTEFCRUxfREVGSU5JVElPTlM6IHJlYWRvbmx5IExhYmVsRGVmaW5pdGlvbltdID0gW1xuICAuLi5MQUJFTF9ERUZJTklUSU9OUyxcbiAgLi4uQ09OVEVOVF9MQUJFTF9ERUZJTklUSU9OUyxcbl07XG5cbi8qKlxuICogQ29sb3VyIHVzZWQgZm9yIGEgbGFiZWwgdGhlIGNhbm9uaWNhbCB0YWJsZSBkb2VzIG5vdCBuYW1lLlxuICpcbiAqIEdpdEh1YidzIG93biBcImJ1Z1wiIHJlZC4gQSBsYWJlbCB0aGF0IGxhbmRzIGhlcmUgaXMgbm90IGZsZWV0LW1hbmFnZWQg4oCUXG4gKiB0aGUgcmVjb25jaWxlIHBhc3MgaWdub3JlcyBpdCwgYW5kIG9ubHkgYSBjcmVhdGUtaWYtbWlzc2luZyBjYWxsIGV2ZXJcbiAqIHBhaW50cyBpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTEFCRUxfQ09MT1VSID0gXCJkNzNhNGFcIjtcblxuLyoqXG4gKiBMYWJlbHMgdGhhdCBoYXZlIGJlZW4gZGVwcmVjYXRlZCBhbmQgc2hvdWxkIGJlIHJlbW92ZWQgZnJvbSByZXBvcy5cbiAqIEFkZCBlbnRyaWVzIGhlcmUgd2hlbiByZXRpcmluZyBhIGxhYmVsLlxuICpcbiAqIE9ubHkgbGFiZWxzIHRoZSBmbGVldCBpdHNlbGYgY3JlYXRlZCBiZWxvbmcgaGVyZS4gR2l0SHViJ3Mgc3RvY2sgbGFiZWxzXG4gKiBhcmUgbGlzdGVkIGluIHtAbGluayBQUk9URUNURURfU1RPQ0tfTEFCRUxTfSBhbmQgYXJlIG5ldmVyIGRlbGV0ZWRcbiAqIChJc3N1ZSAjMTI5NSkuXG4gKi9cbmV4cG9ydCBjb25zdCBERVBSRUNBVEVEX0xBQkVMUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiYmVzdC1tb2RlbFwiLCAvLyBSZW1vdmVkOiBvcHVzIGlzIGFsd2F5cyB1c2VkLCBsYWJlbCBoYWQgbm8gZWZmZWN0XG4gIFwic2tpcC1jbGFyaWZpY2F0aW9uXCIsIC8vIFJlbW92ZWQ6IHJlZHVuZGFudCDigJQgZG9jdW1lbnRhdGlvbiBsYWJlbCBwcm92aWRlcyBpZGVudGljYWwgYnlwYXNzIChJc3N1ZSAjMTE1NSlcbiAgXCJuZWVkcy1jbGFyaWZpY2F0aW9uXCIsIC8vIFJlbW92ZWQ6IGhhbmRvZmYgc2lnbmFsIGNvbnNvbGlkYXRlZCBvbnRvIGBuZWVkcy1odW1hbmAgKElzc3VlICMyMDMxKVxuICBcImFuc3dlcmVkXCIsIC8vIFJlbW92ZWQ6IHF1ZXN0aW9uIHdvcmtmbG93IHNpZ25hbHMgaGFuZG9mZiB3aXRoIGBuZWVkcy1odW1hbmAgKElzc3VlICMyMDMwKVxuICBcImNsYXVkZVwiLCAvLyBSZW1vdmVkOiByZXBsYWNlZCBieSBoYXJkd2lyZWQgdG9wLXByaW9yaXR5L3dvcmstb24vbG93LXByaW9yaXR5L2lkbGUtdGFzayB0aWVycyAoSXNzdWUgIzIwMjIpXG4gIFwicmVmaW5lZFwiLCAvLyBSZW1vdmVkOiByZWZpbmVtZW50IHdvcmtmbG93IG5vdyBzaWduYWxzIGNvbXBsZXRpb24gdmlhIG5lZWRzLWh1bWFuIChJc3N1ZSAjMjAyOSlcbiAgXCJpZGxlLXRhc2stcGVuZGluZ1wiLCAvLyBSZW1vdmVkOiBhcHByb3ZhbCBnYXRlIHJldGlyZWQg4oCUIGBpZGxlLXRhc2tgIGlzIGFscmVhZHkgbG93ZXN0IHByaW9yaXR5IChJc3N1ZSAjMjA3Nylcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogR2l0SHViJ3Mgb3duIHN0b2NrIGxhYmVscywgd2hpY2ggc2hpcCB3aXRoIGV2ZXJ5IG5ldyByZXBvc2l0b3J5IChJc3N1ZSAjMTI5NSkuXG4gKlxuICogVGhlIHdvcmtlciBuZXZlciBjcmVhdGVkIHRoZW0gYW5kIGh1bWFuIG1haW50YWluZXJzIGNvbW1vbmx5IHVzZSB0aGVtIGZvclxuICogdGhlaXIgb3duIHRyaWFnZSwgc28gdGhlIGRlcHJlY2F0ZWQtbGFiZWwgcGFzcyBuZXZlciBkZWxldGVzIHRoZW0g4oCUXG4gKiBkZWxldGlvbiBpcyBpcnJldmVyc2libGUgYW5kIHRha2VzIHRoZSBsYWJlbCdzIGF0dGFjaG1lbnQgdG8gZXZlcnkgaXNzdWVcbiAqIHdpdGggaXQuIFRoZSB3b3JrZXIgc3RvcHBlZCAqcmVhZGluZyogYGhlbHAgd2FudGVkYCBhcyBhIGRpc2NvdmVyeSBsYWJlbCBpblxuICogSXNzdWUgIzIwMjIsIHdoaWNoIGlzIGEgcmVhc29uIHRvIGlnbm9yZSBpdCwgbm90IGEgbGljZW5jZSB0byBkZWxldGUgYVxuICogbWFpbnRhaW5lcidzIGxhYmVsLlxuICpcbiAqIFRoZSBndWFyZCBpcyBlbmZvcmNlZCBpbiBjb2RlIChgcmVtb3ZlRGVwcmVjYXRlZExhYmVsc2ApLCBzbyByZS1hZGRpbmcgb25lXG4gKiBvZiB0aGVzZSBuYW1lcyB0byB7QGxpbmsgREVQUkVDQVRFRF9MQUJFTFN9IGJ5IG1pc3Rha2Ugc3RpbGwgZGVsZXRlc1xuICogbm90aGluZy5cbiAqL1xuZXhwb3J0IGNvbnN0IFBST1RFQ1RFRF9TVE9DS19MQUJFTFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcImdvb2QgZmlyc3QgaXNzdWVcIixcbiAgXCJoZWxwIHdhbnRlZFwiLFxuICAvLyBgZGVwZW5kZW5jaWVzYCBpcyBHaXRIdWIncyBzdG9jayBkZXBlbmRlbmN5LVBSIGxhYmVsIGFuZCB0aGUgbmFtZVxuICAvLyBkZXBlbmRhYm90LnltbCdzIGBsYWJlbHM6YCByZWZlcmVuY2VzLiBEZWxldGluZyBpdCAob3IgbmV2ZXIgaGF2aW5nXG4gIC8vIGl0KSBtYWtlcyBldmVyeSBkZXBlbmRhYm90IFBSIGNhcnJ5IGEgXCJjb3VsZCBub3QgYmUgZm91bmRcIiBuYWcsIHNvIGl0XG4gIC8vIGpvaW5zIHRoZSBzdG9jayBzZXQgdGhlIGRlcHJlY2F0ZWQtbGFiZWwgcGFzcyBuZXZlciB0b3VjaGVzLlxuICBcImRlcGVuZGVuY2llc1wiLFxuXSBhcyBjb25zdDtcblxuLyoqIFRydWUgd2hlbiBgbmFtZWAgaXMgb25lIG9mIEdpdEh1YidzIHN0b2NrIGxhYmVscyB0aGUgZmxlZXQgbXVzdCBub3QgZGVsZXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUHJvdGVjdGVkU3RvY2tMYWJlbChuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXNlZCA9IG5hbWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBQUk9URUNURURfU1RPQ0tfTEFCRUxTLmluY2x1ZGVzKG5vcm1hbGlzZWQpO1xufVxuXG4vKipcbiAqIFVJIGxhbmd1YWdlcyB1c2VkIHRvIGRldGVjdCByZXBvcyB3aXRoIGZyb250ZW5kIGNvbXBvbmVudHMuXG4gKi9cbmNvbnN0IFVJX0xBTkdVQUdFUyA9IFtcbiAgXCJKYXZhU2NyaXB0XCIsXG4gIFwiVHlwZVNjcmlwdFwiLFxuICBcIkhUTUxcIixcbiAgXCJDU1NcIixcbiAgXCJWdWVcIixcbiAgXCJTdmVsdGVcIixcbl0gYXMgY29uc3Q7XG5cbi8qKiBHZXQgYWxsIGxhYmVsIGRlZmluaXRpb25zLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFsbExhYmVscygpOiByZWFkb25seSBMYWJlbERlZmluaXRpb25bXSB7XG4gIHJldHVybiBMQUJFTF9ERUZJTklUSU9OUztcbn1cblxuLyoqIEdldCBsYWJlbHMgZm9yIGEgc3BlY2lmaWMgY2F0ZWdvcnkuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGFiZWxzQnlDYXRlZ29yeShcbiAgY2F0ZWdvcnk6IExhYmVsQ2F0ZWdvcnksXG4pOiBMYWJlbERlZmluaXRpb25bXSB7XG4gIHJldHVybiBMQUJFTF9ERUZJTklUSU9OUy5maWx0ZXIoKGwpID0+IGwuY2F0ZWdvcnkgPT09IGNhdGVnb3J5KTtcbn1cblxuLyoqXG4gKiBHZXQgYSBsYWJlbCBkZWZpbml0aW9uIGJ5IG5hbWUgZnJvbSB0aGUgY2Fub25pY2FsIHRhYmxlXG4gKiAocmV0dXJucyB1bmRlZmluZWQgaWYgdGhlIGZsZWV0IGRvZXMgbm90IG1hbmFnZSB0aGF0IGxhYmVsKS5cbiAqXG4gKiBNYXRjaGluZyBpcyBjYXNlLWluc2Vuc2l0aXZlIGJlY2F1c2UgR2l0SHViIHRyZWF0cyBsYWJlbCBuYW1lcyB0aGF0IHdheVxuICog4oCUIGBTRVZFUklUWTpISUdIYCBhbmQgYHNldmVyaXR5OmhpZ2hgIGFyZSB0aGUgc2FtZSBsYWJlbCwgYW5kIHRoZVxuICogcmVjb25jaWxlIHBhc3MgbXVzdCByZWNvZ25pc2UgZWl0aGVyIHNwZWxsaW5nIChJc3N1ZSAjMzY4KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldExhYmVsQnlOYW1lKG5hbWU6IHN0cmluZyk6IExhYmVsRGVmaW5pdGlvbiB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gQUxMX0xBQkVMX0RFRklOSVRJT05TLmZpbmQoKGwpID0+IGwubmFtZS50b0xvd2VyQ2FzZSgpID09PSBsb3dlcik7XG59XG5cbi8qKlxuICogQ2Fub25pY2FsIGNvbG91ciBmb3IgYSBsYWJlbCBuYW1lIChJc3N1ZSAjMzY4KS5cbiAqXG4gKiBSZXR1cm5zIHtAbGluayBERUZBVUxUX0xBQkVMX0NPTE9VUn0gZm9yIGEgbGFiZWwgdGhlIHRhYmxlIGRvZXMgbm90XG4gKiBuYW1lLCBzbyBhIGNyZWF0ZS1pZi1taXNzaW5nIGNhbGwgYWx3YXlzIGhhcyBhIGNvbG91ciB0byB1c2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMYWJlbENvbG91cihuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZ2V0TGFiZWxCeU5hbWUobmFtZSk/LmNvbG91ciA/PyBERUZBVUxUX0xBQkVMX0NPTE9VUjtcbn1cblxuLyoqXG4gKiBDYW5vbmljYWwgZGVzY3JpcHRpb24gZm9yIGEgbGFiZWwgbmFtZSAoSXNzdWUgIzM2OCkuXG4gKlxuICogRW1wdHkgc3RyaW5nIHdoZW4gdGhlIHRhYmxlIGRvZXMgbm90IG5hbWUgdGhlIGxhYmVsIOKAlCBjYWxsZXJzIHBhc3MgaXRcbiAqIHN0cmFpZ2h0IHRocm91Z2ggdG8gYGdoIGxhYmVsIGNyZWF0ZWAsIHdoaWNoIG9taXRzIGFuIGVtcHR5IGRlc2NyaXB0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGFiZWxEZXNjcmlwdGlvbihuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZ2V0TGFiZWxCeU5hbWUobmFtZSk/LmRlc2NyaXB0aW9uID8/IFwiXCI7XG59XG5cbi8qKiBHZXQgdGhlIG51bWJlciBvZiBkZWZpbmVkIGxhYmVscy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMYWJlbENvdW50KCk6IG51bWJlciB7XG4gIHJldHVybiBMQUJFTF9ERUZJTklUSU9OUy5sZW5ndGg7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSByZXBvc2l0b3J5IGhhcyBVSSBjb21wb25lbnRzIGJhc2VkIG9uIGl0cyBsYW5ndWFnZXMuXG4gKlxuICogQHBhcmFtIGxhbmd1YWdlcyAtIE9iamVjdCBtYXBwaW5nIGxhbmd1YWdlIG5hbWVzIHRvIGJ5dGUgY291bnRzIChmcm9tIEdpdEh1YiBBUEkpXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSByZXBvIGhhcyBhbnkgVUktcmVsYXRlZCBsYW5ndWFnZXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9IYXNVaShsYW5ndWFnZXM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4pOiBib29sZWFuIHtcbiAgcmV0dXJuIFVJX0xBTkdVQUdFUy5zb21lKChsYW5nKSA9PiBsYW5nIGluIGxhbmd1YWdlcyk7XG59XG5cbi8qKlxuICogR2V0IHRoZSBsYWJlbHMgYXBwbGljYWJsZSB0byBhIGdpdmVuIHJlcG8uXG4gKlxuICogQHBhcmFtIGhhc1VpIC0gV2hldGhlciB0aGUgcmVwbyBoYXMgVUkgY29tcG9uZW50c1xuICogQHJldHVybnMgQXJyYXkgb2YgYXBwbGljYWJsZSBsYWJlbCBkZWZpbml0aW9uc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXBwbGljYWJsZUxhYmVscyhoYXNVaTogYm9vbGVhbik6IExhYmVsRGVmaW5pdGlvbltdIHtcbiAgaWYgKGhhc1VpKSB7XG4gICAgcmV0dXJuIFsuLi5MQUJFTF9ERUZJTklUSU9OU107XG4gIH1cbiAgcmV0dXJuIExBQkVMX0RFRklOSVRJT05TLmZpbHRlcigobCkgPT4gbC5jYXRlZ29yeSAhPT0gXCJ1aVwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2QkMsR0FFRCxTQUFTLHlCQUF5QixRQUFRLGlDQUFpQztBQUUzRSxTQUFTLHlCQUF5QixHQUFH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
// denoCacheMetadata=12530323125987070839,12540547271598380562