/** Shared implementation admission; PR maintenance keeps its existing leases (#4942). */ export const COMPLETION_PENDING_MARKER = "<!-- COMPLETION_ADMISSION_PENDING_V1 -->";
export function parseCompletionPolicy(value) {
  const p = value;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((key)=>key !== "high" && key !== "low") || !Number.isSafeInteger(p.high) || !Number.isSafeInteger(p.low) || p.high < 1 || p.low < 0 || p.low >= p.high) throw new Error("completion_admission requires integer high > low >= 0");
  return {
    high: p.high,
    low: p.low
  };
}
/**
 * No priority-label bypass. One dependency repair may exceed the high watermark
 * by one additional change even when an inherited backlog already exceeds it;
 * it stays identified after becoming a PR. Draft resumption uses its slot.
 * Child milestone streams retain the existing one-change limit.
 */ export function admitCompletionWork(store, policy, request, reserve = true) {
  parseCompletionPolicy(policy);
  return store.transaction(async (previous, snapshot)=>{
    const state = previous ?? {
      version: 1,
      policy,
      modes: snapshot.rebuilding ? Object.fromEntries([
        ...snapshot.prs.map((pr)=>[
            pr.base,
            true
          ]),
        ...(snapshot.existingReservations ?? []).map((r)=>[
            r.base,
            true
          ])
      ]) : {},
      reservations: snapshot.existingReservations ?? []
    };
    const mismatch = state.policy.high !== policy.high || state.policy.low !== policy.low;
    // Keep a live claim even after it opens a PR: if the draft is closed while
    // its worker is still running, that worker still consumes capacity.
    state.reservations = state.reservations.filter((r)=>snapshot.liveClaims.has(r.claimId) || r.recovery && snapshot.prs.some((pr)=>pr.base === r.base && pr.issues.includes(r.issue)));
    const bases = new Set([
      ...Object.keys(state.modes),
      ...snapshot.prs.map((pr)=>pr.base),
      ...state.reservations.map((r)=>r.base),
      ...request ? [
        request.base
      ] : []
    ]);
    const pressure = (base)=>snapshot.prs.filter((pr)=>pr.base === base).length + state.reservations.filter((r)=>r.base === base && !snapshot.prs.some((pr)=>pr.base === base && pr.issues.includes(r.issue))).length;
    const limits = (base)=>base.startsWith("milestone/") ? {
        high: 1,
        low: 0
      } : state.policy;
    const updateModes = ()=>{
      for (const base of bases){
        const count = pressure(base);
        const { high, low } = limits(base);
        state.modes = {
          ...state.modes,
          [base]: count >= high || state.modes[base] === true && count > low
        };
      }
    };
    updateModes();
    let allowed = !mismatch;
    let reason = mismatch ? "shared policy differs; synchronise host configuration" : "capacity available";
    if (request && !mismatch) {
      const prs = snapshot.prs.filter((pr)=>pr.base === request.base);
      const ownPrs = prs.filter((pr)=>pr.issues.includes(request.issue));
      const own = state.reservations.find((r)=>r.issue === request.issue);
      if (ownPrs.some((pr)=>!pr.draft)) {
        allowed = false;
        reason = "existing ready PR must be completed";
      } else if (own && own.workerId !== request.workerId) {
        allowed = false;
        reason = "implementation already reserved by another worker";
      } else if (ownPrs.length > 0 || own) {
        reason = "resuming counted work";
        if (!own && reserve) state.reservations.push(request);
      } else {
        const recovery = prs.some((pr)=>pr.recoveryIssues.includes(request.issue)) && !state.reservations.some((r)=>r.base === request.base && r.recovery);
        allowed = !state.modes[request.base] || recovery;
        reason = allowed ? recovery ? "bounded blocking dependency repair" : "implementation reserved" : "completion mode: finish existing PRs";
        if (allowed && reserve) {
          state.reservations.push({
            ...request,
            recovery
          });
        }
      }
      updateModes();
    }
    const completingBases = [
      ...bases
    ].filter((base)=>state.modes[base]);
    return {
      state,
      value: {
        allowed,
        mode: request ? state.modes[request.base] ? "complete" : "implement" : completingBases.length ? "complete" : "implement",
        pressure: request ? pressure(request.base) : [
          ...bases
        ].reduce((total, base)=>total + pressure(base), 0),
        reason,
        completingBases
      }
    };
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb21wbGV0aW9uX2FkbWlzc2lvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKiogU2hhcmVkIGltcGxlbWVudGF0aW9uIGFkbWlzc2lvbjsgUFIgbWFpbnRlbmFuY2Uga2VlcHMgaXRzIGV4aXN0aW5nIGxlYXNlcyAoIzQ5NDIpLiAqL1xuZXhwb3J0IGNvbnN0IENPTVBMRVRJT05fUEVORElOR19NQVJLRVIgPVxuICBcIjwhLS0gQ09NUExFVElPTl9BRE1JU1NJT05fUEVORElOR19WMSAtLT5cIjtcbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGxldGlvblBvbGljeSB7XG4gIGhpZ2g6IG51bWJlcjtcbiAgbG93OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGxldGlvblJlc2VydmF0aW9uIHtcbiAgaXNzdWU6IG51bWJlcjtcbiAgYmFzZTogc3RyaW5nO1xuICBjbGFpbUlkOiBudW1iZXI7XG4gIHdvcmtlcklkOiBzdHJpbmc7XG4gIHJlY292ZXJ5PzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uU3RhdGUge1xuICB2ZXJzaW9uOiAxO1xuICBwb2xpY3k6IENvbXBsZXRpb25Qb2xpY3k7XG4gIG1vZGVzOiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPjtcbiAgcmVzZXJ2YXRpb25zOiBDb21wbGV0aW9uUmVzZXJ2YXRpb25bXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uUHIge1xuICBudW1iZXI6IG51bWJlcjtcbiAgYmFzZTogc3RyaW5nO1xuICBpc3N1ZXM6IG51bWJlcltdO1xuICBkcmFmdDogYm9vbGVhbjtcbiAgLyoqIE9ubHkgZmxlZXQtYXV0aG9yZWQgUFJzIG1heSBub21pbmF0ZSBhIGJsb2NraW5nIGRlcGVuZGVuY3kuICovXG4gIHJlY292ZXJ5SXNzdWVzOiBudW1iZXJbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uU25hcHNob3Qge1xuICBwcnM6IENvbXBsZXRpb25QcltdO1xuICAvKiogRXhpc3RpbmcgY2xhaW0gY29tbWVudHMgd2l0aCBhIGxpdmUsIHZlcmlmaWVkIGhlYXJ0YmVhdC4gKi9cbiAgbGl2ZUNsYWltczogU2V0PG51bWJlcj47XG4gIC8qKiBCb290c3RyYXAgY2xhaW1zIGFscmVhZHkgcnVubmluZyB3aGVuIHRoaXMgcmVwb3NpdG9yeSBvcHRzIGluLiAqL1xuICBleGlzdGluZ1Jlc2VydmF0aW9ucz86IENvbXBsZXRpb25SZXNlcnZhdGlvbltdO1xuICByZWJ1aWxkaW5nPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uVmVyZGljdCB7XG4gIGFsbG93ZWQ6IGJvb2xlYW47XG4gIG1vZGU6IFwiaW1wbGVtZW50XCIgfCBcImNvbXBsZXRlXCI7XG4gIHByZXNzdXJlOiBudW1iZXI7XG4gIHJlYXNvbjogc3RyaW5nO1xuICAvKiogQmFzZXMgY3VycmVudGx5IGJlaW5nIGRyYWluZWQsIGZvciB0aGUgZXhpc3RpbmcgbWFpbnRlbmFuY2UgZGlzcGF0Y2hlci4gKi9cbiAgY29tcGxldGluZ0Jhc2VzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uU3RvcmUge1xuICAvKiogU2VyaWFsaXNlIHRoZSBsaXZlIHJlYWQsIHJlY29uY2lsaWF0aW9uIGFuZCByZXNlcnZhdGlvbiBhY3Jvc3MgaG9zdHMuICovXG4gIHRyYW5zYWN0aW9uPFQ+KFxuICAgIGZuOiAoXG4gICAgICBzdGF0ZTogQ29tcGxldGlvblN0YXRlIHwgdW5kZWZpbmVkLFxuICAgICAgc25hcHNob3Q6IENvbXBsZXRpb25TbmFwc2hvdCxcbiAgICApID0+IFByb21pc2U8eyBzdGF0ZTogQ29tcGxldGlvblN0YXRlOyB2YWx1ZTogVCB9PixcbiAgKTogUHJvbWlzZTxUPjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29tcGxldGlvblBvbGljeSh2YWx1ZTogdW5rbm93bik6IENvbXBsZXRpb25Qb2xpY3kge1xuICBjb25zdCBwID0gdmFsdWUgYXMgQ29tcGxldGlvblBvbGljeSB8IG51bGw7XG4gIGlmIChcbiAgICAhcCB8fCB0eXBlb2YgcCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHApIHx8XG4gICAgT2JqZWN0LmtleXMocCkuc29tZSgoa2V5KSA9PiBrZXkgIT09IFwiaGlnaFwiICYmIGtleSAhPT0gXCJsb3dcIikgfHxcbiAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIocC5oaWdoKSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIocC5sb3cpIHx8XG4gICAgcC5oaWdoIDwgMSB8fCBwLmxvdyA8IDAgfHwgcC5sb3cgPj0gcC5oaWdoXG4gICkgdGhyb3cgbmV3IEVycm9yKFwiY29tcGxldGlvbl9hZG1pc3Npb24gcmVxdWlyZXMgaW50ZWdlciBoaWdoID4gbG93ID49IDBcIik7XG4gIHJldHVybiB7IGhpZ2g6IHAuaGlnaCwgbG93OiBwLmxvdyB9O1xufVxuXG4vKipcbiAqIE5vIHByaW9yaXR5LWxhYmVsIGJ5cGFzcy4gT25lIGRlcGVuZGVuY3kgcmVwYWlyIG1heSBleGNlZWQgdGhlIGhpZ2ggd2F0ZXJtYXJrXG4gKiBieSBvbmUgYWRkaXRpb25hbCBjaGFuZ2UgZXZlbiB3aGVuIGFuIGluaGVyaXRlZCBiYWNrbG9nIGFscmVhZHkgZXhjZWVkcyBpdDtcbiAqIGl0IHN0YXlzIGlkZW50aWZpZWQgYWZ0ZXIgYmVjb21pbmcgYSBQUi4gRHJhZnQgcmVzdW1wdGlvbiB1c2VzIGl0cyBzbG90LlxuICogQ2hpbGQgbWlsZXN0b25lIHN0cmVhbXMgcmV0YWluIHRoZSBleGlzdGluZyBvbmUtY2hhbmdlIGxpbWl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWRtaXRDb21wbGV0aW9uV29yayhcbiAgc3RvcmU6IENvbXBsZXRpb25TdG9yZSxcbiAgcG9saWN5OiBDb21wbGV0aW9uUG9saWN5LFxuICByZXF1ZXN0PzogQ29tcGxldGlvblJlc2VydmF0aW9uLFxuICByZXNlcnZlID0gdHJ1ZSxcbik6IFByb21pc2U8Q29tcGxldGlvblZlcmRpY3Q+IHtcbiAgcGFyc2VDb21wbGV0aW9uUG9saWN5KHBvbGljeSk7XG4gIHJldHVybiBzdG9yZS50cmFuc2FjdGlvbihhc3luYyAocHJldmlvdXMsIHNuYXBzaG90KSA9PiB7XG4gICAgY29uc3Qgc3RhdGU6IENvbXBsZXRpb25TdGF0ZSA9IHByZXZpb3VzID8/IHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBwb2xpY3ksXG4gICAgICBtb2Rlczogc25hcHNob3QucmVidWlsZGluZ1xuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhbXG4gICAgICAgICAgLi4uc25hcHNob3QucHJzLm1hcCgocHIpID0+IFtwci5iYXNlLCB0cnVlXSksXG4gICAgICAgICAgLi4uKHNuYXBzaG90LmV4aXN0aW5nUmVzZXJ2YXRpb25zID8/IFtdKS5tYXAoKHIpID0+IFtyLmJhc2UsIHRydWVdKSxcbiAgICAgICAgXSlcbiAgICAgICAgOiB7fSxcbiAgICAgIHJlc2VydmF0aW9uczogc25hcHNob3QuZXhpc3RpbmdSZXNlcnZhdGlvbnMgPz8gW10sXG4gICAgfTtcbiAgICBjb25zdCBtaXNtYXRjaCA9IHN0YXRlLnBvbGljeS5oaWdoICE9PSBwb2xpY3kuaGlnaCB8fFxuICAgICAgc3RhdGUucG9saWN5LmxvdyAhPT0gcG9saWN5LmxvdztcbiAgICAvLyBLZWVwIGEgbGl2ZSBjbGFpbSBldmVuIGFmdGVyIGl0IG9wZW5zIGEgUFI6IGlmIHRoZSBkcmFmdCBpcyBjbG9zZWQgd2hpbGVcbiAgICAvLyBpdHMgd29ya2VyIGlzIHN0aWxsIHJ1bm5pbmcsIHRoYXQgd29ya2VyIHN0aWxsIGNvbnN1bWVzIGNhcGFjaXR5LlxuICAgIHN0YXRlLnJlc2VydmF0aW9ucyA9IHN0YXRlLnJlc2VydmF0aW9ucy5maWx0ZXIoKHIpID0+XG4gICAgICBzbmFwc2hvdC5saXZlQ2xhaW1zLmhhcyhyLmNsYWltSWQpIHx8XG4gICAgICAoci5yZWNvdmVyeSAmJlxuICAgICAgICBzbmFwc2hvdC5wcnMuc29tZSgocHIpID0+XG4gICAgICAgICAgcHIuYmFzZSA9PT0gci5iYXNlICYmIHByLmlzc3Vlcy5pbmNsdWRlcyhyLmlzc3VlKVxuICAgICAgICApKVxuICAgICk7XG4gICAgY29uc3QgYmFzZXMgPSBuZXcgU2V0KFtcbiAgICAgIC4uLk9iamVjdC5rZXlzKHN0YXRlLm1vZGVzKSxcbiAgICAgIC4uLnNuYXBzaG90LnBycy5tYXAoKHByKSA9PiBwci5iYXNlKSxcbiAgICAgIC4uLnN0YXRlLnJlc2VydmF0aW9ucy5tYXAoKHIpID0+IHIuYmFzZSksXG4gICAgICAuLi4ocmVxdWVzdCA/IFtyZXF1ZXN0LmJhc2VdIDogW10pLFxuICAgIF0pO1xuICAgIGNvbnN0IHByZXNzdXJlID0gKGJhc2U6IHN0cmluZykgPT5cbiAgICAgIHNuYXBzaG90LnBycy5maWx0ZXIoKHByKSA9PiBwci5iYXNlID09PSBiYXNlKS5sZW5ndGggK1xuICAgICAgc3RhdGUucmVzZXJ2YXRpb25zLmZpbHRlcigocikgPT5cbiAgICAgICAgci5iYXNlID09PSBiYXNlICYmXG4gICAgICAgICFzbmFwc2hvdC5wcnMuc29tZSgocHIpID0+XG4gICAgICAgICAgcHIuYmFzZSA9PT0gYmFzZSAmJiBwci5pc3N1ZXMuaW5jbHVkZXMoci5pc3N1ZSlcbiAgICAgICAgKVxuICAgICAgKS5sZW5ndGg7XG4gICAgY29uc3QgbGltaXRzID0gKGJhc2U6IHN0cmluZykgPT5cbiAgICAgIGJhc2Uuc3RhcnRzV2l0aChcIm1pbGVzdG9uZS9cIikgPyB7IGhpZ2g6IDEsIGxvdzogMCB9IDogc3RhdGUucG9saWN5O1xuICAgIGNvbnN0IHVwZGF0ZU1vZGVzID0gKCkgPT4ge1xuICAgICAgZm9yIChjb25zdCBiYXNlIG9mIGJhc2VzKSB7XG4gICAgICAgIGNvbnN0IGNvdW50ID0gcHJlc3N1cmUoYmFzZSk7XG4gICAgICAgIGNvbnN0IHsgaGlnaCwgbG93IH0gPSBsaW1pdHMoYmFzZSk7XG4gICAgICAgIHN0YXRlLm1vZGVzID0ge1xuICAgICAgICAgIC4uLnN0YXRlLm1vZGVzLFxuICAgICAgICAgIFtiYXNlXTogY291bnQgPj0gaGlnaCB8fCAoc3RhdGUubW9kZXNbYmFzZV0gPT09IHRydWUgJiYgY291bnQgPiBsb3cpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH07XG4gICAgdXBkYXRlTW9kZXMoKTtcbiAgICBsZXQgYWxsb3dlZCA9ICFtaXNtYXRjaDtcbiAgICBsZXQgcmVhc29uID0gbWlzbWF0Y2hcbiAgICAgID8gXCJzaGFyZWQgcG9saWN5IGRpZmZlcnM7IHN5bmNocm9uaXNlIGhvc3QgY29uZmlndXJhdGlvblwiXG4gICAgICA6IFwiY2FwYWNpdHkgYXZhaWxhYmxlXCI7XG4gICAgaWYgKHJlcXVlc3QgJiYgIW1pc21hdGNoKSB7XG4gICAgICBjb25zdCBwcnMgPSBzbmFwc2hvdC5wcnMuZmlsdGVyKChwcikgPT4gcHIuYmFzZSA9PT0gcmVxdWVzdC5iYXNlKTtcbiAgICAgIGNvbnN0IG93blBycyA9IHBycy5maWx0ZXIoKHByKSA9PiBwci5pc3N1ZXMuaW5jbHVkZXMocmVxdWVzdC5pc3N1ZSkpO1xuICAgICAgY29uc3Qgb3duID0gc3RhdGUucmVzZXJ2YXRpb25zLmZpbmQoKHIpID0+IHIuaXNzdWUgPT09IHJlcXVlc3QuaXNzdWUpO1xuICAgICAgaWYgKG93blBycy5zb21lKChwcikgPT4gIXByLmRyYWZ0KSkge1xuICAgICAgICBhbGxvd2VkID0gZmFsc2U7XG4gICAgICAgIHJlYXNvbiA9IFwiZXhpc3RpbmcgcmVhZHkgUFIgbXVzdCBiZSBjb21wbGV0ZWRcIjtcbiAgICAgIH0gZWxzZSBpZiAob3duICYmIG93bi53b3JrZXJJZCAhPT0gcmVxdWVzdC53b3JrZXJJZCkge1xuICAgICAgICBhbGxvd2VkID0gZmFsc2U7XG4gICAgICAgIHJlYXNvbiA9IFwiaW1wbGVtZW50YXRpb24gYWxyZWFkeSByZXNlcnZlZCBieSBhbm90aGVyIHdvcmtlclwiO1xuICAgICAgfSBlbHNlIGlmIChvd25QcnMubGVuZ3RoID4gMCB8fCBvd24pIHtcbiAgICAgICAgcmVhc29uID0gXCJyZXN1bWluZyBjb3VudGVkIHdvcmtcIjtcbiAgICAgICAgaWYgKCFvd24gJiYgcmVzZXJ2ZSkgc3RhdGUucmVzZXJ2YXRpb25zLnB1c2gocmVxdWVzdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCByZWNvdmVyeSA9IHBycy5zb21lKChwcikgPT5cbiAgICAgICAgICBwci5yZWNvdmVyeUlzc3Vlcy5pbmNsdWRlcyhyZXF1ZXN0Lmlzc3VlKVxuICAgICAgICApICYmXG4gICAgICAgICAgIXN0YXRlLnJlc2VydmF0aW9ucy5zb21lKChyKSA9PlxuICAgICAgICAgICAgci5iYXNlID09PSByZXF1ZXN0LmJhc2UgJiYgci5yZWNvdmVyeVxuICAgICAgICAgICk7XG4gICAgICAgIGFsbG93ZWQgPSAhc3RhdGUubW9kZXNbcmVxdWVzdC5iYXNlXSB8fCByZWNvdmVyeTtcbiAgICAgICAgcmVhc29uID0gYWxsb3dlZFxuICAgICAgICAgID8gKHJlY292ZXJ5XG4gICAgICAgICAgICA/IFwiYm91bmRlZCBibG9ja2luZyBkZXBlbmRlbmN5IHJlcGFpclwiXG4gICAgICAgICAgICA6IFwiaW1wbGVtZW50YXRpb24gcmVzZXJ2ZWRcIilcbiAgICAgICAgICA6IFwiY29tcGxldGlvbiBtb2RlOiBmaW5pc2ggZXhpc3RpbmcgUFJzXCI7XG4gICAgICAgIGlmIChhbGxvd2VkICYmIHJlc2VydmUpIHtcbiAgICAgICAgICBzdGF0ZS5yZXNlcnZhdGlvbnMucHVzaCh7IC4uLnJlcXVlc3QsIHJlY292ZXJ5IH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB1cGRhdGVNb2RlcygpO1xuICAgIH1cbiAgICBjb25zdCBjb21wbGV0aW5nQmFzZXMgPSBbLi4uYmFzZXNdLmZpbHRlcigoYmFzZSkgPT4gc3RhdGUubW9kZXNbYmFzZV0pO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGFsbG93ZWQsXG4gICAgICAgIG1vZGU6IHJlcXVlc3RcbiAgICAgICAgICA/IChzdGF0ZS5tb2Rlc1tyZXF1ZXN0LmJhc2VdID8gXCJjb21wbGV0ZVwiIDogXCJpbXBsZW1lbnRcIilcbiAgICAgICAgICA6IChjb21wbGV0aW5nQmFzZXMubGVuZ3RoID8gXCJjb21wbGV0ZVwiIDogXCJpbXBsZW1lbnRcIiksXG4gICAgICAgIHByZXNzdXJlOiByZXF1ZXN0XG4gICAgICAgICAgPyBwcmVzc3VyZShyZXF1ZXN0LmJhc2UpXG4gICAgICAgICAgOiBbLi4uYmFzZXNdLnJlZHVjZSgodG90YWwsIGJhc2UpID0+IHRvdGFsICsgcHJlc3N1cmUoYmFzZSksIDApLFxuICAgICAgICByZWFzb24sXG4gICAgICAgIGNvbXBsZXRpbmdCYXNlcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsdUZBQXVGLEdBQ3ZGLE9BQU8sTUFBTSw0QkFDWCwyQ0FBMkM7QUEwRDdDLE9BQU8sU0FBUyxzQkFBc0IsS0FBYztFQUNsRCxNQUFNLElBQUk7RUFDVixJQUNFLENBQUMsS0FBSyxPQUFPLE1BQU0sWUFBWSxNQUFNLE9BQU8sQ0FBQyxNQUM3QyxPQUFPLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLE1BQVEsUUFBUSxVQUFVLFFBQVEsVUFDdkQsQ0FBQyxPQUFPLGFBQWEsQ0FBQyxFQUFFLElBQUksS0FBSyxDQUFDLE9BQU8sYUFBYSxDQUFDLEVBQUUsR0FBRyxLQUM1RCxFQUFFLElBQUksR0FBRyxLQUFLLEVBQUUsR0FBRyxHQUFHLEtBQUssRUFBRSxHQUFHLElBQUksRUFBRSxJQUFJLEVBQzFDLE1BQU0sSUFBSSxNQUFNO0VBQ2xCLE9BQU87SUFBRSxNQUFNLEVBQUUsSUFBSTtJQUFFLEtBQUssRUFBRSxHQUFHO0VBQUM7QUFDcEM7QUFFQTs7Ozs7Q0FL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
// denoCacheMetadata=13795643787227907388,9756820867398317924