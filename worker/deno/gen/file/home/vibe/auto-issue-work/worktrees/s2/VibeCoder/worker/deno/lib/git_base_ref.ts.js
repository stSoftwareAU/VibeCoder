/**
 * Resolve a base branch to a ref this clone can actually compare against
 * (Issue #106).
 *
 * A worker clone is made for the issue's own branch. When the base is a
 * milestone branch, the clone frequently holds it only as the remote-tracking
 * ref `origin/<base>`, never as a local branch. A bare `git log <base>..HEAD`
 * then fails with "unknown revision" (exit 128) — and because the change
 * detector only inspected whether the command *ran*, not its exit code, the
 * failure was silently read as "no commits". A run that had in fact produced a
 * merged PR was then misclassified as analysis-only and escalated to a human.
 *
 * This resolves the base the safe way: prefer the remote-tracking ref
 * `origin/<base>` when it exists, fall back to the local branch, then to a
 * fetch of the base, and surface an error when none can be produced — never a
 * silent empty result that reads as "no changes".
 *
 * Issue #2147: the remote-tracking ref comes first because a run never
 * updates the clone's *local* base — the bring-forward fetches and merges
 * `origin/<base>`, and every `git fetch` refreshes it — so the local branch
 * can lag origin by weeks. Diffing against that stale ref made a 12-file Rust
 * change read as 62 files including `web/*.tsx` (GRQ-AutoTrader#463), and the
 * screenshot gate failed the run.
 *
 * Factored out of `execute_phase.ts` so the completion phase's ahead-of-base
 * guard (#68) can reuse the same resolution.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { assertSafeGitRef } from "./git_ref_args.ts";
/**
 * Resolve `baseBranch` to a ref usable in `git log <ref>..HEAD` on this clone.
 *
 * @returns `origin/<base>` when the remote-tracking ref resolves; otherwise
 *   the local branch; otherwise `origin/<base>` after a fetch. `ok: false`
 *   when the base cannot be produced at all — the caller must surface that,
 *   not treat it as "no changes".
 */ export async function resolveComparableBaseRef(runGit, baseBranch, options = {}) {
  // baseBranch is an internal, trusted ref, but keep the guard so a malformed
  // value can never be parsed by git as an option (mirrors git_ref_args.ts).
  assertSafeGitRef(baseBranch, "resolveComparableBaseRef base branch");
  const cwd = options.cwd;
  const remote = options.remote ?? "origin";
  const resolves = async (ref)=>{
    // `git rev-parse --verify --quiet <ref>^{commit}` exits 0 iff the ref
    // resolves to a commit and non-zero (printing nothing) when it does not,
    // so the exit code alone is the signal — never the presence of stdout.
    const r = await runGit([
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`
    ], {
      cwd
    });
    return r.ok && r.value.code === 0;
  };
  // 1. Remote-tracking ref present — the base as the repository has it
  //    (Issue #2147); the local branch is what the clone was made with and
  //    nothing in a run moves it.
  const remoteRef = `${remote}/${baseBranch}`;
  if (await resolves(remoteRef)) return {
    ok: true,
    value: remoteRef
  };
  // 2. Local branch present — a base the remote does not carry (a local-only
  //    clone, or an offline run).
  if (await resolves(baseBranch)) return {
    ok: true,
    value: baseBranch
  };
  // 3. Fetch the base from the remote, then retry the remote-tracking ref.
  const fetched = await runGit([
    "fetch",
    remote,
    baseBranch
  ], {
    cwd
  });
  if (fetched.ok && fetched.value.code === 0 && await resolves(remoteRef)) {
    return {
      ok: true,
      value: remoteRef
    };
  }
  const detail = fetched.ok ? `fetch exited ${fetched.value.code}` : `fetch failed: ${fetched.error.message}`;
  return {
    ok: false,
    error: new Error(`base ref '${baseBranch}' is not resolvable in this clone — tried ` + `'${baseBranch}', '${remoteRef}', and a fetch of ${remote} ` + `(${detail})`)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfYmFzZV9yZWYudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZXNvbHZlIGEgYmFzZSBicmFuY2ggdG8gYSByZWYgdGhpcyBjbG9uZSBjYW4gYWN0dWFsbHkgY29tcGFyZSBhZ2FpbnN0XG4gKiAoSXNzdWUgIzEwNikuXG4gKlxuICogQSB3b3JrZXIgY2xvbmUgaXMgbWFkZSBmb3IgdGhlIGlzc3VlJ3Mgb3duIGJyYW5jaC4gV2hlbiB0aGUgYmFzZSBpcyBhXG4gKiBtaWxlc3RvbmUgYnJhbmNoLCB0aGUgY2xvbmUgZnJlcXVlbnRseSBob2xkcyBpdCBvbmx5IGFzIHRoZSByZW1vdGUtdHJhY2tpbmdcbiAqIHJlZiBgb3JpZ2luLzxiYXNlPmAsIG5ldmVyIGFzIGEgbG9jYWwgYnJhbmNoLiBBIGJhcmUgYGdpdCBsb2cgPGJhc2U+Li5IRUFEYFxuICogdGhlbiBmYWlscyB3aXRoIFwidW5rbm93biByZXZpc2lvblwiIChleGl0IDEyOCkg4oCUIGFuZCBiZWNhdXNlIHRoZSBjaGFuZ2VcbiAqIGRldGVjdG9yIG9ubHkgaW5zcGVjdGVkIHdoZXRoZXIgdGhlIGNvbW1hbmQgKnJhbiosIG5vdCBpdHMgZXhpdCBjb2RlLCB0aGVcbiAqIGZhaWx1cmUgd2FzIHNpbGVudGx5IHJlYWQgYXMgXCJubyBjb21taXRzXCIuIEEgcnVuIHRoYXQgaGFkIGluIGZhY3QgcHJvZHVjZWQgYVxuICogbWVyZ2VkIFBSIHdhcyB0aGVuIG1pc2NsYXNzaWZpZWQgYXMgYW5hbHlzaXMtb25seSBhbmQgZXNjYWxhdGVkIHRvIGEgaHVtYW4uXG4gKlxuICogVGhpcyByZXNvbHZlcyB0aGUgYmFzZSB0aGUgc2FmZSB3YXk6IHByZWZlciB0aGUgcmVtb3RlLXRyYWNraW5nIHJlZlxuICogYG9yaWdpbi88YmFzZT5gIHdoZW4gaXQgZXhpc3RzLCBmYWxsIGJhY2sgdG8gdGhlIGxvY2FsIGJyYW5jaCwgdGhlbiB0byBhXG4gKiBmZXRjaCBvZiB0aGUgYmFzZSwgYW5kIHN1cmZhY2UgYW4gZXJyb3Igd2hlbiBub25lIGNhbiBiZSBwcm9kdWNlZCDigJQgbmV2ZXIgYVxuICogc2lsZW50IGVtcHR5IHJlc3VsdCB0aGF0IHJlYWRzIGFzIFwibm8gY2hhbmdlc1wiLlxuICpcbiAqIElzc3VlICMyMTQ3OiB0aGUgcmVtb3RlLXRyYWNraW5nIHJlZiBjb21lcyBmaXJzdCBiZWNhdXNlIGEgcnVuIG5ldmVyXG4gKiB1cGRhdGVzIHRoZSBjbG9uZSdzICpsb2NhbCogYmFzZSDigJQgdGhlIGJyaW5nLWZvcndhcmQgZmV0Y2hlcyBhbmQgbWVyZ2VzXG4gKiBgb3JpZ2luLzxiYXNlPmAsIGFuZCBldmVyeSBgZ2l0IGZldGNoYCByZWZyZXNoZXMgaXQg4oCUIHNvIHRoZSBsb2NhbCBicmFuY2hcbiAqIGNhbiBsYWcgb3JpZ2luIGJ5IHdlZWtzLiBEaWZmaW5nIGFnYWluc3QgdGhhdCBzdGFsZSByZWYgbWFkZSBhIDEyLWZpbGUgUnVzdFxuICogY2hhbmdlIHJlYWQgYXMgNjIgZmlsZXMgaW5jbHVkaW5nIGB3ZWIvKi50c3hgIChHUlEtQXV0b1RyYWRlciM0NjMpLCBhbmQgdGhlXG4gKiBzY3JlZW5zaG90IGdhdGUgZmFpbGVkIHRoZSBydW4uXG4gKlxuICogRmFjdG9yZWQgb3V0IG9mIGBleGVjdXRlX3BoYXNlLnRzYCBzbyB0aGUgY29tcGxldGlvbiBwaGFzZSdzIGFoZWFkLW9mLWJhc2VcbiAqIGd1YXJkICgjNjgpIGNhbiByZXVzZSB0aGUgc2FtZSByZXNvbHV0aW9uLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRTYWZlR2l0UmVmIH0gZnJvbSBcIi4vZ2l0X3JlZl9hcmdzLnRzXCI7XG5cbi8qKiBPdXRwdXQgc2hhcGUgb2YgYSBnaXQgY29tbWFuZCBydW4gKG1hdGNoZXMgYHJ1bkdpdENvbW1hbmRgKS4gKi9cbmludGVyZmFjZSBHaXRSdW5PdXRwdXQge1xuICBjb2RlOiBudW1iZXI7XG4gIHN0ZG91dDogc3RyaW5nO1xuICBzdGRlcnI6IHN0cmluZztcbn1cblxuLyoqIEEgZ2l0IHJ1bm5lciBtYXRjaGluZyBgZGVwcy5naXQucnVuR2l0Q29tbWFuZGAuICovXG5leHBvcnQgdHlwZSBHaXRSdW5uZXIgPSAoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zPzogeyBjd2Q/OiBzdHJpbmcgfSxcbikgPT4gUHJvbWlzZTxSZXN1bHQ8R2l0UnVuT3V0cHV0Pj47XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgcmVzb2x2ZUNvbXBhcmFibGVCYXNlUmVmfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZUJhc2VSZWZPcHRpb25zIHtcbiAgLyoqIFdvcmtpbmcgZGlyZWN0b3J5IG9mIHRoZSBjbG9uZS4gKi9cbiAgY3dkPzogc3RyaW5nO1xuICAvKiogUmVtb3RlIG5hbWUgKGRlZmF1bHQgYG9yaWdpbmApLiAqL1xuICByZW1vdGU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBgYmFzZUJyYW5jaGAgdG8gYSByZWYgdXNhYmxlIGluIGBnaXQgbG9nIDxyZWY+Li5IRUFEYCBvbiB0aGlzIGNsb25lLlxuICpcbiAqIEByZXR1cm5zIGBvcmlnaW4vPGJhc2U+YCB3aGVuIHRoZSByZW1vdGUtdHJhY2tpbmcgcmVmIHJlc29sdmVzOyBvdGhlcndpc2VcbiAqICAgdGhlIGxvY2FsIGJyYW5jaDsgb3RoZXJ3aXNlIGBvcmlnaW4vPGJhc2U+YCBhZnRlciBhIGZldGNoLiBgb2s6IGZhbHNlYFxuICogICB3aGVuIHRoZSBiYXNlIGNhbm5vdCBiZSBwcm9kdWNlZCBhdCBhbGwg4oCUIHRoZSBjYWxsZXIgbXVzdCBzdXJmYWNlIHRoYXQsXG4gKiAgIG5vdCB0cmVhdCBpdCBhcyBcIm5vIGNoYW5nZXNcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDb21wYXJhYmxlQmFzZVJlZihcbiAgcnVuR2l0OiBHaXRSdW5uZXIsXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogUmVzb2x2ZUJhc2VSZWZPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmcsIEVycm9yPj4ge1xuICAvLyBiYXNlQnJhbmNoIGlzIGFuIGludGVybmFsLCB0cnVzdGVkIHJlZiwgYnV0IGtlZXAgdGhlIGd1YXJkIHNvIGEgbWFsZm9ybWVkXG4gIC8vIHZhbHVlIGNhbiBuZXZlciBiZSBwYXJzZWQgYnkgZ2l0IGFzIGFuIG9wdGlvbiAobWlycm9ycyBnaXRfcmVmX2FyZ3MudHMpLlxuICBhc3NlcnRTYWZlR2l0UmVmKGJhc2VCcmFuY2gsIFwicmVzb2x2ZUNvbXBhcmFibGVCYXNlUmVmIGJhc2UgYnJhbmNoXCIpO1xuXG4gIGNvbnN0IGN3ZCA9IG9wdGlvbnMuY3dkO1xuICBjb25zdCByZW1vdGUgPSBvcHRpb25zLnJlbW90ZSA/PyBcIm9yaWdpblwiO1xuXG4gIGNvbnN0IHJlc29sdmVzID0gYXN5bmMgKHJlZjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiA9PiB7XG4gICAgLy8gYGdpdCByZXYtcGFyc2UgLS12ZXJpZnkgLS1xdWlldCA8cmVmPl57Y29tbWl0fWAgZXhpdHMgMCBpZmYgdGhlIHJlZlxuICAgIC8vIHJlc29sdmVzIHRvIGEgY29tbWl0IGFuZCBub24temVybyAocHJpbnRpbmcgbm90aGluZykgd2hlbiBpdCBkb2VzIG5vdCxcbiAgICAvLyBzbyB0aGUgZXhpdCBjb2RlIGFsb25lIGlzIHRoZSBzaWduYWwg4oCUIG5ldmVyIHRoZSBwcmVzZW5jZSBvZiBzdGRvdXQuXG4gICAgY29uc3QgciA9IGF3YWl0IHJ1bkdpdChcbiAgICAgIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwiLS1xdWlldFwiLCBgJHtyZWZ9Xntjb21taXR9YF0sXG4gICAgICB7IGN3ZCB9LFxuICAgICk7XG4gICAgcmV0dXJuIHIub2sgJiYgci52YWx1ZS5jb2RlID09PSAwO1xuICB9O1xuXG4gIC8vIDEuIFJlbW90ZS10cmFja2luZyByZWYgcHJlc2VudCDigJQgdGhlIGJhc2UgYXMgdGhlIHJlcG9zaXRvcnkgaGFzIGl0XG4gIC8vICAgIChJc3N1ZSAjMjE0Nyk7IHRoZSBsb2NhbCBicmFuY2ggaXMgd2hhdCB0aGUgY2xvbmUgd2FzIG1hZGUgd2l0aCBhbmRcbiAgLy8gICAgbm90aGluZyBpbiBhIHJ1biBtb3ZlcyBpdC5cbiAgY29uc3QgcmVtb3RlUmVmID0gYCR7cmVtb3RlfS8ke2Jhc2VCcmFuY2h9YDtcbiAgaWYgKGF3YWl0IHJlc29sdmVzKHJlbW90ZVJlZikpIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmVtb3RlUmVmIH07XG5cbiAgLy8gMi4gTG9jYWwgYnJhbmNoIHByZXNlbnQg4oCUIGEgYmFzZSB0aGUgcmVtb3RlIGRvZXMgbm90IGNhcnJ5IChhIGxvY2FsLW9ubHlcbiAgLy8gICAgY2xvbmUsIG9yIGFuIG9mZmxpbmUgcnVuKS5cbiAgaWYgKGF3YWl0IHJlc29sdmVzKGJhc2VCcmFuY2gpKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGJhc2VCcmFuY2ggfTtcblxuICAvLyAzLiBGZXRjaCB0aGUgYmFzZSBmcm9tIHRoZSByZW1vdGUsIHRoZW4gcmV0cnkgdGhlIHJlbW90ZS10cmFja2luZyByZWYuXG4gIGNvbnN0IGZldGNoZWQgPSBhd2FpdCBydW5HaXQoW1wiZmV0Y2hcIiwgcmVtb3RlLCBiYXNlQnJhbmNoXSwgeyBjd2QgfSk7XG4gIGlmIChmZXRjaGVkLm9rICYmIGZldGNoZWQudmFsdWUuY29kZSA9PT0gMCAmJiBhd2FpdCByZXNvbHZlcyhyZW1vdGVSZWYpKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiByZW1vdGVSZWYgfTtcbiAgfVxuXG4gIGNvbnN0IGRldGFpbCA9IGZldGNoZWQub2tcbiAgICA/IGBmZXRjaCBleGl0ZWQgJHtmZXRjaGVkLnZhbHVlLmNvZGV9YFxuICAgIDogYGZldGNoIGZhaWxlZDogJHtmZXRjaGVkLmVycm9yLm1lc3NhZ2V9YDtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGBiYXNlIHJlZiAnJHtiYXNlQnJhbmNofScgaXMgbm90IHJlc29sdmFibGUgaW4gdGhpcyBjbG9uZSDigJQgdHJpZWQgYCArXG4gICAgICAgIGAnJHtiYXNlQnJhbmNofScsICcke3JlbW90ZVJlZn0nLCBhbmQgYSBmZXRjaCBvZiAke3JlbW90ZX0gYCArXG4gICAgICAgIGAoJHtkZXRhaWx9KWAsXG4gICAgKSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTRCQyxHQUdELFNBQVMsZ0JBQWdCLFFBQVEsb0JBQW9CO0FBdUJyRDs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLHlCQUNwQixNQUFpQixFQUNqQixVQUFrQixFQUNsQixVQUFpQyxDQUFDLENBQUM7RUFFbkMsNEVBQTRFO0VBQzVFLDJFQUEyRTtFQUMzRSxpQkFBaUIsWUFBWTtFQUU3QixNQUFNLE1BQU0sUUFBUSxHQUFHO0VBQ3ZCLE1BQU0sU0FBUyxRQUFRLE1BQU0sSUFBSTtFQUVqQyxNQUFNLFdBQVcsT0FBTztJQUN0QixzRUFBc0U7SUFDdEUseUVBQXlFO0lBQ3pFLHVFQUF1RTtJQUN2RSxNQUFNLElBQUksTUFBTSxPQUNkO01BQUM7TUFBYTtNQUFZO01BQVcsR0FBRyxJQUFJLFNBQVMsQ0FBQztLQUFDLEVBQ3ZEO01BQUU7SUFBSTtJQUVSLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxLQUFLO0VBQ2xDO0VBRUEscUVBQXFFO0VBQ3JFLHlFQUF5RTtFQUN6RSxnQ0FBZ0M7RUFDaEMsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEVBQUUsWUFBWTtFQUMzQyxJQUFJLE1BQU0sU0FBUyxZQUFZLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFVO0VBRW5FLDJFQUEyRTtFQUMzRSxnQ0FBZ0M7RUFDaEMsSUFBSSxNQUFNLFNBQVMsYUFBYSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87RUFBVztFQUVyRSx5RUFBeUU7RUFDekUsTUFBTSxVQUFVLE1BQU0sT0FBTztJQUFDO0lBQVM7SUFBUTtHQUFXLEVBQUU7SUFBRTtFQUFJO0VBQ2xFLElBQUksUUFBUSxFQUFFLElBQUksUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLEtBQUssTUFBTSxTQUFTLFlBQVk7SUFDdkUsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEM7RUFFQSxNQUFNLFNBQVMsUUFBUSxFQUFFLEdBQ3JCLENBQUMsYUFBYSxFQUFFLFFBQVEsS0FBSyxDQUFDLElBQUksRUFBRSxHQUNwQyxDQUFDLGNBQWMsRUFBRSxRQUFRLEtBQUssQ0FBQyxPQUFPLEVBQUU7RUFDNUMsT0FBTztJQUNMLElBQUk7SUFDSixPQUFPLElBQUksTUFDVCxDQUFDLFVBQVUsRUFBRSxXQUFXLDBDQUEwQyxDQUFDLEdBQ2pFLENBQUMsQ0FBQyxFQUFFLFdBQVcsSUFBSSxFQUFFLFVBQVUsa0JBQWtCLEVBQUUsT0FBTyxDQUFDLENBQUMsR0FDNUQsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7RUFFbkI7QUFDRiJ9
// denoCacheMetadata=15701799832926260279,16426852882587127547