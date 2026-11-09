/** Shared implementation admission; PR maintenance keeps its existing leases (#4942). */
export const COMPLETION_PENDING_MARKER =
  "<!-- COMPLETION_ADMISSION_PENDING_V1 -->";
export interface CompletionPolicy {
  high: number;
  low: number;
}

export interface CompletionReservation {
  issue: number;
  base: string;
  claimId: number;
  workerId: string;
  recovery?: boolean;
}

export interface CompletionState {
  version: 1;
  policy: CompletionPolicy;
  modes: Record<string, boolean>;
  reservations: CompletionReservation[];
}

export interface CompletionPr {
  number: number;
  base: string;
  issues: number[];
  draft: boolean;
  /** Only fleet-authored PRs may nominate a blocking dependency. */
  recoveryIssues: number[];
}

export interface CompletionSnapshot {
  prs: CompletionPr[];
  /** Existing claim comments with a live, verified heartbeat. */
  liveClaims: Set<number>;
  /** Bootstrap claims already running when this repository opts in. */
  existingReservations?: CompletionReservation[];
  rebuilding?: boolean;
}

export interface CompletionVerdict {
  allowed: boolean;
  mode: "implement" | "complete";
  pressure: number;
  reason: string;
  /** Bases currently being drained, for the existing maintenance dispatcher. */
  completingBases: string[];
}

export interface CompletionStore {
  /** Serialise the live read, reconciliation and reservation across hosts. */
  transaction<T>(
    fn: (
      state: CompletionState | undefined,
      snapshot: CompletionSnapshot,
    ) => Promise<{ state: CompletionState; value: T }>,
  ): Promise<T>;
}

export function parseCompletionPolicy(value: unknown): CompletionPolicy {
  const p = value as CompletionPolicy | null;
  if (
    !p || typeof p !== "object" || Array.isArray(p) ||
    Object.keys(p).some((key) => key !== "high" && key !== "low") ||
    !Number.isSafeInteger(p.high) || !Number.isSafeInteger(p.low) ||
    p.high < 1 || p.low < 0 || p.low >= p.high
  ) throw new Error("completion_admission requires integer high > low >= 0");
  return { high: p.high, low: p.low };
}

/**
 * No priority-label bypass. One dependency repair may exceed the high watermark
 * by one additional change even when an inherited backlog already exceeds it;
 * it stays identified after becoming a PR. Draft resumption uses its slot.
 * Child milestone streams retain the existing one-change limit.
 */
export function admitCompletionWork(
  store: CompletionStore,
  policy: CompletionPolicy,
  request?: CompletionReservation,
  reserve = true,
): Promise<CompletionVerdict> {
  parseCompletionPolicy(policy);
  return store.transaction(async (previous, snapshot) => {
    const state: CompletionState = previous ?? {
      version: 1,
      policy,
      modes: snapshot.rebuilding
        ? Object.fromEntries([
          ...snapshot.prs.map((pr) => [pr.base, true]),
          ...(snapshot.existingReservations ?? []).map((r) => [r.base, true]),
        ])
        : {},
      reservations: snapshot.existingReservations ?? [],
    };
    const mismatch = state.policy.high !== policy.high ||
      state.policy.low !== policy.low;
    // Keep a live claim even after it opens a PR: if the draft is closed while
    // its worker is still running, that worker still consumes capacity.
    state.reservations = state.reservations.filter((r) =>
      snapshot.liveClaims.has(r.claimId) ||
      (r.recovery &&
        snapshot.prs.some((pr) =>
          pr.base === r.base && pr.issues.includes(r.issue)
        ))
    );
    const bases = new Set([
      ...Object.keys(state.modes),
      ...snapshot.prs.map((pr) => pr.base),
      ...state.reservations.map((r) => r.base),
      ...(request ? [request.base] : []),
    ]);
    const pressure = (base: string) =>
      snapshot.prs.filter((pr) => pr.base === base).length +
      state.reservations.filter((r) =>
        r.base === base &&
        !snapshot.prs.some((pr) =>
          pr.base === base && pr.issues.includes(r.issue)
        )
      ).length;
    const limits = (base: string) =>
      base.startsWith("milestone/") ? { high: 1, low: 0 } : state.policy;
    const updateModes = () => {
      for (const base of bases) {
        const count = pressure(base);
        const { high, low } = limits(base);
        state.modes = {
          ...state.modes,
          [base]: count >= high || (state.modes[base] === true && count > low),
        };
      }
    };
    updateModes();
    let allowed = !mismatch;
    let reason = mismatch
      ? "shared policy differs; synchronise host configuration"
      : "capacity available";
    if (request && !mismatch) {
      const prs = snapshot.prs.filter((pr) => pr.base === request.base);
      const ownPrs = prs.filter((pr) => pr.issues.includes(request.issue));
      const own = state.reservations.find((r) => r.issue === request.issue);
      if (ownPrs.some((pr) => !pr.draft)) {
        allowed = false;
        reason = "existing ready PR must be completed";
      } else if (own && own.workerId !== request.workerId) {
        allowed = false;
        reason = "implementation already reserved by another worker";
      } else if (ownPrs.length > 0 || own) {
        reason = "resuming counted work";
        if (!own && reserve) state.reservations.push(request);
      } else {
        const recovery = prs.some((pr) =>
          pr.recoveryIssues.includes(request.issue)
        ) &&
          !state.reservations.some((r) =>
            r.base === request.base && r.recovery
          );
        allowed = !state.modes[request.base] || recovery;
        reason = allowed
          ? (recovery
            ? "bounded blocking dependency repair"
            : "implementation reserved")
          : "completion mode: finish existing PRs";
        if (allowed && reserve) {
          state.reservations.push({ ...request, recovery });
        }
      }
      updateModes();
    }
    const completingBases = [...bases].filter((base) => state.modes[base]);
    return {
      state,
      value: {
        allowed,
        mode: request
          ? (state.modes[request.base] ? "complete" : "implement")
          : (completingBases.length ? "complete" : "implement"),
        pressure: request
          ? pressure(request.base)
          : [...bases].reduce((total, base) => total + pressure(base), 0),
        reason,
        completingBases,
      },
    };
  });
}
