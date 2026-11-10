/**
 * Wall-clock timings per stage of a merge-conflict attempt (Issue #2308).
 *
 * A conflict attempt routinely runs for twenty to thirty minutes, and until
 * now the only record of where that went was the wall-clock gap between two
 * log lines. This timer is the missing breakdown: each attempt records the
 * seconds it spent deepening the clone, in the deterministic rules, gathering
 * issue context, in the resolution agent, in the verification gate and in the
 * push — on the PR conclusion comment or the milestone sync report, and in the
 * worker log, on both paths.
 *
 * The clock is injected, so the timer is a pure function of the ticks it is
 * given and a test needs no wall clock at all.
 *
 * **A stage that never stopped is reported, never dropped.** It renders as
 * `unfinished` rather than as a plausible-looking duration: an attempt that
 * died inside the agent is exactly the case these timings exist to show, and a
 * stage that quietly vanished from the line would hide it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { getHostname } from "./worker_identity.ts";
/**
 * Create a stage timer over an injected clock.
 *
 * A stage started more than once accumulates: the milestone path runs its
 * gate again after a repair round, and two `gate` entries on one line would
 * say less than one total. Once a stage has gone unfinished it stays
 * unfinished, however much time a later run of it adds.
 *
 * @param nowMs - Monotonic-enough millisecond clock; defaults to `Date.now`
 * @returns A timer whose report is a pure function of the ticks it was given
 */ export function createConflictStageTimer(nowMs = ()=>Date.now()) {
  /** Accumulated milliseconds per stage. */ const totals = new Map();
  /** Stages that were started and never stopped. */ const unfinished = new Set();
  /** First-start order, so the line reads in the order the attempt ran. */ const order = [];
  let running = null;
  const close = (finished)=>{
    if (running === null) return;
    if (finished) {
      // A clock that went backwards contributes nothing rather than a
      // negative duration.
      const elapsed = Math.max(0, nowMs() - running.startedMs);
      totals.set(running.stage, (totals.get(running.stage) ?? 0) + elapsed);
    } else {
      unfinished.add(running.stage);
    }
    running = null;
  };
  return {
    start (stage) {
      close(false);
      if (!order.includes(stage)) order.push(stage);
      running = {
        stage,
        startedMs: nowMs()
      };
    },
    stop () {
      close(true);
    },
    report () {
      const stillRunning = running?.stage;
      return order.map((stage)=>({
          stage,
          seconds: unfinished.has(stage) || stage === stillRunning ? null : Math.round((totals.get(stage) ?? 0) / 1000)
        }));
    }
  };
}
/**
 * Render a stage report as the one Markdown line the comments carry.
 *
 * @param report - What {@link ConflictStageTimer.report} produced
 * @param host - The host the attempt ran on, from {@link currentHost}
 * @returns e.g. ``Timings (host `mel-01`): deepen 3s · rules 1s · agent 212s``
 */ export function formatStageTimings(report, host) {
  const stages = report.map((timing)=>`${timing.stage} ${timing.seconds === null ? "unfinished" : `${timing.seconds}s`}`);
  // An empty report says so rather than trailing off into nothing: "no stage
  // was timed" is a fact a reader can act on, a blank line is not.
  return `Timings (host \`${host}\`): ${stages.length > 0 ? stages.join(" · ") : "no stage was timed"}`;
}
/**
 * Read a rendered timings line back (Issue #2311).
 *
 * The inverse of {@link formatStageTimings}, and deliberately beside it so
 * the two cannot drift: the line is what a conclusion records, and the
 * `merge-fallback` flag reports each spent run's stages from it. Anything the
 * grammar does not fit is dropped rather than guessed — a stage nobody can
 * read is not a stage that took zero seconds.
 *
 * @param line - A line as {@link formatStageTimings} rendered it
 */ export function parseStageTimings(line) {
  const match = line.match(/^Timings \(host `([^`]*)`\): (.*)$/);
  if (!match) return {
    stages: []
  };
  const host = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const stages = body === "no stage was timed" ? [] : body.split(" · ").flatMap((part)=>{
    const stage = part.match(/^(\S+) (unfinished|\d+)s?$/);
    if (!stage) return [];
    return [
      {
        stage: stage[1],
        seconds: stage[2] === "unfinished" ? null : Number(stage[2])
      }
    ];
  });
  return {
    ...host ? {
      host
    } : {},
    stages
  };
}
/**
 * The host this attempt is running on — the one seam the callers use.
 *
 * Spelled here rather than at each call site so a test injects one function
 * and the two paths cannot report the host differently.
 *
 * @returns The worker's hostname, or `unknown-host` when it cannot be read
 */ export function currentHost() {
  return getHostname();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25mbGljdF9zdGFnZV90aW1lci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFdhbGwtY2xvY2sgdGltaW5ncyBwZXIgc3RhZ2Ugb2YgYSBtZXJnZS1jb25mbGljdCBhdHRlbXB0IChJc3N1ZSAjMjMwOCkuXG4gKlxuICogQSBjb25mbGljdCBhdHRlbXB0IHJvdXRpbmVseSBydW5zIGZvciB0d2VudHkgdG8gdGhpcnR5IG1pbnV0ZXMsIGFuZCB1bnRpbFxuICogbm93IHRoZSBvbmx5IHJlY29yZCBvZiB3aGVyZSB0aGF0IHdlbnQgd2FzIHRoZSB3YWxsLWNsb2NrIGdhcCBiZXR3ZWVuIHR3b1xuICogbG9nIGxpbmVzLiBUaGlzIHRpbWVyIGlzIHRoZSBtaXNzaW5nIGJyZWFrZG93bjogZWFjaCBhdHRlbXB0IHJlY29yZHMgdGhlXG4gKiBzZWNvbmRzIGl0IHNwZW50IGRlZXBlbmluZyB0aGUgY2xvbmUsIGluIHRoZSBkZXRlcm1pbmlzdGljIHJ1bGVzLCBnYXRoZXJpbmdcbiAqIGlzc3VlIGNvbnRleHQsIGluIHRoZSByZXNvbHV0aW9uIGFnZW50LCBpbiB0aGUgdmVyaWZpY2F0aW9uIGdhdGUgYW5kIGluIHRoZVxuICogcHVzaCDigJQgb24gdGhlIFBSIGNvbmNsdXNpb24gY29tbWVudCBvciB0aGUgbWlsZXN0b25lIHN5bmMgcmVwb3J0LCBhbmQgaW4gdGhlXG4gKiB3b3JrZXIgbG9nLCBvbiBib3RoIHBhdGhzLlxuICpcbiAqIFRoZSBjbG9jayBpcyBpbmplY3RlZCwgc28gdGhlIHRpbWVyIGlzIGEgcHVyZSBmdW5jdGlvbiBvZiB0aGUgdGlja3MgaXQgaXNcbiAqIGdpdmVuIGFuZCBhIHRlc3QgbmVlZHMgbm8gd2FsbCBjbG9jayBhdCBhbGwuXG4gKlxuICogKipBIHN0YWdlIHRoYXQgbmV2ZXIgc3RvcHBlZCBpcyByZXBvcnRlZCwgbmV2ZXIgZHJvcHBlZC4qKiBJdCByZW5kZXJzIGFzXG4gKiBgdW5maW5pc2hlZGAgcmF0aGVyIHRoYW4gYXMgYSBwbGF1c2libGUtbG9va2luZyBkdXJhdGlvbjogYW4gYXR0ZW1wdCB0aGF0XG4gKiBkaWVkIGluc2lkZSB0aGUgYWdlbnQgaXMgZXhhY3RseSB0aGUgY2FzZSB0aGVzZSB0aW1pbmdzIGV4aXN0IHRvIHNob3csIGFuZCBhXG4gKiBzdGFnZSB0aGF0IHF1aWV0bHkgdmFuaXNoZWQgZnJvbSB0aGUgbGluZSB3b3VsZCBoaWRlIGl0LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGdldEhvc3RuYW1lIH0gZnJvbSBcIi4vd29ya2VyX2lkZW50aXR5LnRzXCI7XG5cbi8qKiBUaGUgc3RhZ2VzIGEgbWVyZ2UtY29uZmxpY3QgYXR0ZW1wdCBpcyBicm9rZW4gaW50by4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0U3RhZ2UgPVxuICB8IFwiZGVlcGVuXCJcbiAgfCBcInJ1bGVzXCJcbiAgfCBcImlzc3VlLWNvbnRleHRcIlxuICB8IFwiYWdlbnRcIlxuICB8IFwiZ2F0ZVwiXG4gIHwgXCJwdXNoXCI7XG5cbi8qKiBPbmUgc3RhZ2UncyB3YWxsLWNsb2NrIGNvc3QuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YWdlVGltaW5nIHtcbiAgLyoqIFRoZSBzdGFnZSB0aGlzIGxpbmUgaXMgYWJvdXQuICovXG4gIHN0YWdlOiBDb25mbGljdFN0YWdlO1xuICAvKipcbiAgICogV2hvbGUgc2Vjb25kcyB0aGUgc3RhZ2UgdG9vaywgb3IgYG51bGxgIHdoZW4gaXQgd2FzIHN0YXJ0ZWQgYW5kIG5ldmVyXG4gICAqIHN0b3BwZWQg4oCUIHJlbmRlcmVkIGFzIGB1bmZpbmlzaGVkYCwgbmV2ZXIgYXMgYSBkdXJhdGlvbi5cbiAgICovXG4gIHNlY29uZHM6IG51bWJlciB8IG51bGw7XG59XG5cbi8qKiBSZWNvcmRzIGhvdyBsb25nIGVhY2ggc3RhZ2Ugb2Ygb25lIGNvbmZsaWN0IGF0dGVtcHQgdG9vay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RTdGFnZVRpbWVyIHtcbiAgLyoqXG4gICAqIEJlZ2luIHRpbWluZyBgc3RhZ2VgLlxuICAgKlxuICAgKiBBIHN0YWdlIHN0aWxsIHJ1bm5pbmcgd2hlbiB0aGUgbmV4dCBvbmUgc3RhcnRzIHdhcyBuZXZlciBzdG9wcGVkLCBzbyBpdFxuICAgKiBpcyByZWNvcmRlZCBhcyB1bmZpbmlzaGVkIHJhdGhlciB0aGFuIGdpdmVuIGFuIGludmVudGVkIGR1cmF0aW9uLlxuICAgKi9cbiAgc3RhcnQoc3RhZ2U6IENvbmZsaWN0U3RhZ2UpOiB2b2lkO1xuICAvKiogU3RvcCB0aGUgcnVubmluZyBzdGFnZSwgYWRkaW5nIGl0cyBlbGFwc2VkIHRpbWUgdG8gdGhhdCBzdGFnZSdzIHRvdGFsLiAqL1xuICBzdG9wKCk6IHZvaWQ7XG4gIC8qKiBXaGF0IGVhY2ggc3RhZ2UgY29zdCwgaW4gdGhlIG9yZGVyIHRoZSBzdGFnZXMgZmlyc3Qgc3RhcnRlZC4gKi9cbiAgcmVwb3J0KCk6IFN0YWdlVGltaW5nW107XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgc3RhZ2UgdGltZXIgb3ZlciBhbiBpbmplY3RlZCBjbG9jay5cbiAqXG4gKiBBIHN0YWdlIHN0YXJ0ZWQgbW9yZSB0aGFuIG9uY2UgYWNjdW11bGF0ZXM6IHRoZSBtaWxlc3RvbmUgcGF0aCBydW5zIGl0c1xuICogZ2F0ZSBhZ2FpbiBhZnRlciBhIHJlcGFpciByb3VuZCwgYW5kIHR3byBgZ2F0ZWAgZW50cmllcyBvbiBvbmUgbGluZSB3b3VsZFxuICogc2F5IGxlc3MgdGhhbiBvbmUgdG90YWwuIE9uY2UgYSBzdGFnZSBoYXMgZ29uZSB1bmZpbmlzaGVkIGl0IHN0YXlzXG4gKiB1bmZpbmlzaGVkLCBob3dldmVyIG11Y2ggdGltZSBhIGxhdGVyIHJ1biBvZiBpdCBhZGRzLlxuICpcbiAqIEBwYXJhbSBub3dNcyAtIE1vbm90b25pYy1lbm91Z2ggbWlsbGlzZWNvbmQgY2xvY2s7IGRlZmF1bHRzIHRvIGBEYXRlLm5vd2BcbiAqIEByZXR1cm5zIEEgdGltZXIgd2hvc2UgcmVwb3J0IGlzIGEgcHVyZSBmdW5jdGlvbiBvZiB0aGUgdGlja3MgaXQgd2FzIGdpdmVuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDb25mbGljdFN0YWdlVGltZXIoXG4gIG5vd01zOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBEYXRlLm5vdygpLFxuKTogQ29uZmxpY3RTdGFnZVRpbWVyIHtcbiAgLyoqIEFjY3VtdWxhdGVkIG1pbGxpc2Vjb25kcyBwZXIgc3RhZ2UuICovXG4gIGNvbnN0IHRvdGFscyA9IG5ldyBNYXA8Q29uZmxpY3RTdGFnZSwgbnVtYmVyPigpO1xuICAvKiogU3RhZ2VzIHRoYXQgd2VyZSBzdGFydGVkIGFuZCBuZXZlciBzdG9wcGVkLiAqL1xuICBjb25zdCB1bmZpbmlzaGVkID0gbmV3IFNldDxDb25mbGljdFN0YWdlPigpO1xuICAvKiogRmlyc3Qtc3RhcnQgb3JkZXIsIHNvIHRoZSBsaW5lIHJlYWRzIGluIHRoZSBvcmRlciB0aGUgYXR0ZW1wdCByYW4uICovXG4gIGNvbnN0IG9yZGVyOiBDb25mbGljdFN0YWdlW10gPSBbXTtcbiAgbGV0IHJ1bm5pbmc6IHsgc3RhZ2U6IENvbmZsaWN0U3RhZ2U7IHN0YXJ0ZWRNczogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcblxuICBjb25zdCBjbG9zZSA9IChmaW5pc2hlZDogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgIGlmIChydW5uaW5nID09PSBudWxsKSByZXR1cm47XG4gICAgaWYgKGZpbmlzaGVkKSB7XG4gICAgICAvLyBBIGNsb2NrIHRoYXQgd2VudCBiYWNrd2FyZHMgY29udHJpYnV0ZXMgbm90aGluZyByYXRoZXIgdGhhbiBhXG4gICAgICAvLyBuZWdhdGl2ZSBkdXJhdGlvbi5cbiAgICAgIGNvbnN0IGVsYXBzZWQgPSBNYXRoLm1heCgwLCBub3dNcygpIC0gcnVubmluZy5zdGFydGVkTXMpO1xuICAgICAgdG90YWxzLnNldChydW5uaW5nLnN0YWdlLCAodG90YWxzLmdldChydW5uaW5nLnN0YWdlKSA/PyAwKSArIGVsYXBzZWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmZpbmlzaGVkLmFkZChydW5uaW5nLnN0YWdlKTtcbiAgICB9XG4gICAgcnVubmluZyA9IG51bGw7XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBzdGFydChzdGFnZTogQ29uZmxpY3RTdGFnZSk6IHZvaWQge1xuICAgICAgY2xvc2UoZmFsc2UpO1xuICAgICAgaWYgKCFvcmRlci5pbmNsdWRlcyhzdGFnZSkpIG9yZGVyLnB1c2goc3RhZ2UpO1xuICAgICAgcnVubmluZyA9IHsgc3RhZ2UsIHN0YXJ0ZWRNczogbm93TXMoKSB9O1xuICAgIH0sXG4gICAgc3RvcCgpOiB2b2lkIHtcbiAgICAgIGNsb3NlKHRydWUpO1xuICAgIH0sXG4gICAgcmVwb3J0KCk6IFN0YWdlVGltaW5nW10ge1xuICAgICAgY29uc3Qgc3RpbGxSdW5uaW5nID0gcnVubmluZz8uc3RhZ2U7XG4gICAgICByZXR1cm4gb3JkZXIubWFwKChzdGFnZSkgPT4gKHtcbiAgICAgICAgc3RhZ2UsXG4gICAgICAgIHNlY29uZHM6IHVuZmluaXNoZWQuaGFzKHN0YWdlKSB8fCBzdGFnZSA9PT0gc3RpbGxSdW5uaW5nXG4gICAgICAgICAgPyBudWxsXG4gICAgICAgICAgOiBNYXRoLnJvdW5kKCh0b3RhbHMuZ2V0KHN0YWdlKSA/PyAwKSAvIDEwMDApLFxuICAgICAgfSkpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogUmVuZGVyIGEgc3RhZ2UgcmVwb3J0IGFzIHRoZSBvbmUgTWFya2Rvd24gbGluZSB0aGUgY29tbWVudHMgY2FycnkuXG4gKlxuICogQHBhcmFtIHJlcG9ydCAtIFdoYXQge0BsaW5rIENvbmZsaWN0U3RhZ2VUaW1lci5yZXBvcnR9IHByb2R1Y2VkXG4gKiBAcGFyYW0gaG9zdCAtIFRoZSBob3N0IHRoZSBhdHRlbXB0IHJhbiBvbiwgZnJvbSB7QGxpbmsgY3VycmVudEhvc3R9XG4gKiBAcmV0dXJucyBlLmcuIGBgVGltaW5ncyAoaG9zdCBgbWVsLTAxYCk6IGRlZXBlbiAzcyDCtyBydWxlcyAxcyDCtyBhZ2VudCAyMTJzYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFN0YWdlVGltaW5ncyhcbiAgcmVwb3J0OiByZWFkb25seSBTdGFnZVRpbWluZ1tdLFxuICBob3N0OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzdGFnZXMgPSByZXBvcnQubWFwKCh0aW1pbmcpID0+XG4gICAgYCR7dGltaW5nLnN0YWdlfSAke1xuICAgICAgdGltaW5nLnNlY29uZHMgPT09IG51bGwgPyBcInVuZmluaXNoZWRcIiA6IGAke3RpbWluZy5zZWNvbmRzfXNgXG4gICAgfWBcbiAgKTtcbiAgLy8gQW4gZW1wdHkgcmVwb3J0IHNheXMgc28gcmF0aGVyIHRoYW4gdHJhaWxpbmcgb2ZmIGludG8gbm90aGluZzogXCJubyBzdGFnZVxuICAvLyB3YXMgdGltZWRcIiBpcyBhIGZhY3QgYSByZWFkZXIgY2FuIGFjdCBvbiwgYSBibGFuayBsaW5lIGlzIG5vdC5cbiAgcmV0dXJuIGBUaW1pbmdzIChob3N0IFxcYCR7aG9zdH1cXGApOiAke1xuICAgIHN0YWdlcy5sZW5ndGggPiAwID8gc3RhZ2VzLmpvaW4oXCIgwrcgXCIpIDogXCJubyBzdGFnZSB3YXMgdGltZWRcIlxuICB9YDtcbn1cblxuLyoqIEEgcGFyc2VkIHRpbWluZ3MgbGluZTogdGhlIGhvc3QgaXQgbmFtZXMsIGFuZCBlYWNoIHN0YWdlIGl0IHJlcG9ydHMuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhcnNlZFN0YWdlVGltaW5ncyB7XG4gIC8qKiBUaGUgaG9zdCB0aGUgbGluZSBuYW1lcywgd2hlbiBpdCBuYW1lZCBvbmUuICovXG4gIGhvc3Q/OiBzdHJpbmc7XG4gIC8qKiBPbmUgZW50cnkgcGVyIHN0YWdlLCBgbnVsbGAgc2Vjb25kcyBmb3IgYW4gdW5maW5pc2hlZCBzdGFnZS4gKi9cbiAgc3RhZ2VzOiB7IHN0YWdlOiBzdHJpbmc7IHNlY29uZHM6IG51bWJlciB8IG51bGwgfVtdO1xufVxuXG4vKipcbiAqIFJlYWQgYSByZW5kZXJlZCB0aW1pbmdzIGxpbmUgYmFjayAoSXNzdWUgIzIzMTEpLlxuICpcbiAqIFRoZSBpbnZlcnNlIG9mIHtAbGluayBmb3JtYXRTdGFnZVRpbWluZ3N9LCBhbmQgZGVsaWJlcmF0ZWx5IGJlc2lkZSBpdCBzb1xuICogdGhlIHR3byBjYW5ub3QgZHJpZnQ6IHRoZSBsaW5lIGlzIHdoYXQgYSBjb25jbHVzaW9uIHJlY29yZHMsIGFuZCB0aGVcbiAqIGBtZXJnZS1mYWxsYmFja2AgZmxhZyByZXBvcnRzIGVhY2ggc3BlbnQgcnVuJ3Mgc3RhZ2VzIGZyb20gaXQuIEFueXRoaW5nIHRoZVxuICogZ3JhbW1hciBkb2VzIG5vdCBmaXQgaXMgZHJvcHBlZCByYXRoZXIgdGhhbiBndWVzc2VkIOKAlCBhIHN0YWdlIG5vYm9keSBjYW5cbiAqIHJlYWQgaXMgbm90IGEgc3RhZ2UgdGhhdCB0b29rIHplcm8gc2Vjb25kcy5cbiAqXG4gKiBAcGFyYW0gbGluZSAtIEEgbGluZSBhcyB7QGxpbmsgZm9ybWF0U3RhZ2VUaW1pbmdzfSByZW5kZXJlZCBpdFxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTdGFnZVRpbWluZ3MobGluZTogc3RyaW5nKTogUGFyc2VkU3RhZ2VUaW1pbmdzIHtcbiAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKC9eVGltaW5ncyBcXChob3N0IGAoW15gXSopYFxcKTogKC4qKSQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHsgc3RhZ2VzOiBbXSB9O1xuICBjb25zdCBob3N0ID0gbWF0Y2hbMV0gPz8gXCJcIjtcbiAgY29uc3QgYm9keSA9IChtYXRjaFsyXSA/PyBcIlwiKS50cmltKCk7XG4gIGNvbnN0IHN0YWdlcyA9IGJvZHkgPT09IFwibm8gc3RhZ2Ugd2FzIHRpbWVkXCIgPyBbXSA6IGJvZHkuc3BsaXQoXCIgwrcgXCIpLmZsYXRNYXAoXG4gICAgKHBhcnQpID0+IHtcbiAgICAgIGNvbnN0IHN0YWdlID0gcGFydC5tYXRjaCgvXihcXFMrKSAodW5maW5pc2hlZHxcXGQrKXM/JC8pO1xuICAgICAgaWYgKCFzdGFnZSkgcmV0dXJuIFtdO1xuICAgICAgcmV0dXJuIFt7XG4gICAgICAgIHN0YWdlOiBzdGFnZVsxXSEsXG4gICAgICAgIHNlY29uZHM6IHN0YWdlWzJdID09PSBcInVuZmluaXNoZWRcIiA/IG51bGwgOiBOdW1iZXIoc3RhZ2VbMl0pLFxuICAgICAgfV07XG4gICAgfSxcbiAgKTtcbiAgcmV0dXJuIHsgLi4uKGhvc3QgPyB7IGhvc3QgfSA6IHt9KSwgc3RhZ2VzIH07XG59XG5cbi8qKlxuICogVGhlIGhvc3QgdGhpcyBhdHRlbXB0IGlzIHJ1bm5pbmcgb24g4oCUIHRoZSBvbmUgc2VhbSB0aGUgY2FsbGVycyB1c2UuXG4gKlxuICogU3BlbGxlZCBoZXJlIHJhdGhlciB0aGFuIGF0IGVhY2ggY2FsbCBzaXRlIHNvIGEgdGVzdCBpbmplY3RzIG9uZSBmdW5jdGlvblxuICogYW5kIHRoZSB0d28gcGF0aHMgY2Fubm90IHJlcG9ydCB0aGUgaG9zdCBkaWZmZXJlbnRseS5cbiAqXG4gKiBAcmV0dXJucyBUaGUgd29ya2VyJ3MgaG9zdG5hbWUsIG9yIGB1bmtub3duLWhvc3RgIHdoZW4gaXQgY2Fubm90IGJlIHJlYWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGN1cnJlbnRIb3N0KCk6IHN0cmluZyB7XG4gIHJldHVybiBnZXRIb3N0bmFtZSgpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW9CQyxHQUVELFNBQVMsV0FBVyxRQUFRLHVCQUF1QjtBQXFDbkQ7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sU0FBUyx5QkFDZCxRQUFzQixJQUFNLEtBQUssR0FBRyxFQUFFO0VBRXRDLHdDQUF3QyxHQUN4QyxNQUFN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
// denoCacheMetadata=5907838048939800049,10492068233178886478