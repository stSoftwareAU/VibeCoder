/**
 * Helpers for building safe git argument arrays used in conflict resolution
 * (Issue #3294).
 *
 * A conflicted filename reaching these calls is an untrusted positional: it is
 * derived from the raw stdout of `git diff --name-only --diff-filter=U`, split
 * on newlines. Git can track a working-tree path whose name begins with `-`
 * (e.g. `-rf`, `--pathspec-from-file=…`), so we always place the `--`
 * end-of-options separator before the filename. Without it `git checkout
 * --theirs -rf` / `git add --pathspec-from-file=…` is parsed by git as an
 * option, not a pathspec — an argument/option-injection foot-gun.
 *
 * This mirrors the `buildBranchDeleteArgs` hardening (Issue #2798). The calls
 * use `Deno.Command` argument arrays, so there is no shell exposure — the `--`
 * separator is defence-in-depth that keeps the practice consistent across every
 * conflict-resolution call site.
 */ /**
 * Build the argv for staging a (untrusted) conflicted path with the `--`
 * end-of-options separator before the filename.
 *
 * @param file - The conflicted path to stage (untrusted positional).
 * @returns The git argument array, e.g. `["add", "--", file]`.
 */ export function buildAddPathArgs(file) {
  return [
    "add",
    "--",
    file
  ];
}
/**
 * Build the argv for checking out one side of a conflicted path with the `--`
 * end-of-options separator before the (untrusted) filename.
 *
 * @param strategy - Which side to accept ("ours" for upstream, "theirs" for
 *   local).
 * @param file - The conflicted path to check out (untrusted positional).
 * @returns The git argument array, e.g. `["checkout", "--theirs", "--", file]`.
 */ export function buildCheckoutStrategyArgs(strategy, file) {
  return [
    "checkout",
    `--${strategy}`,
    "--",
    file
  ];
}
/**
 * Build the argv for removing a (untrusted) conflicted path, with the `--`
 * end-of-options separator before the filename.
 *
 * Used when the incoming branch deleted the file (Issue #1048): there is no
 * incoming side to check out, so accepting that side means removing it here.
 * `--force` because the path is conflicted, and `--ignore-unmatch` so a file
 * git has already dropped from the working tree is not a failure.
 *
 * @param file - The conflicted path to remove (untrusted positional).
 * @returns The git argument array, e.g. `["rm", "--force", "--", file]`.
 */ export function buildRemovePathArgs(file) {
  return [
    "rm",
    "--force",
    "--ignore-unmatch",
    "--",
    file
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfY29uZmxpY3RfYXJncy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEhlbHBlcnMgZm9yIGJ1aWxkaW5nIHNhZmUgZ2l0IGFyZ3VtZW50IGFycmF5cyB1c2VkIGluIGNvbmZsaWN0IHJlc29sdXRpb25cbiAqIChJc3N1ZSAjMzI5NCkuXG4gKlxuICogQSBjb25mbGljdGVkIGZpbGVuYW1lIHJlYWNoaW5nIHRoZXNlIGNhbGxzIGlzIGFuIHVudHJ1c3RlZCBwb3NpdGlvbmFsOiBpdCBpc1xuICogZGVyaXZlZCBmcm9tIHRoZSByYXcgc3Rkb3V0IG9mIGBnaXQgZGlmZiAtLW5hbWUtb25seSAtLWRpZmYtZmlsdGVyPVVgLCBzcGxpdFxuICogb24gbmV3bGluZXMuIEdpdCBjYW4gdHJhY2sgYSB3b3JraW5nLXRyZWUgcGF0aCB3aG9zZSBuYW1lIGJlZ2lucyB3aXRoIGAtYFxuICogKGUuZy4gYC1yZmAsIGAtLXBhdGhzcGVjLWZyb20tZmlsZT3igKZgKSwgc28gd2UgYWx3YXlzIHBsYWNlIHRoZSBgLS1gXG4gKiBlbmQtb2Ytb3B0aW9ucyBzZXBhcmF0b3IgYmVmb3JlIHRoZSBmaWxlbmFtZS4gV2l0aG91dCBpdCBgZ2l0IGNoZWNrb3V0XG4gKiAtLXRoZWlycyAtcmZgIC8gYGdpdCBhZGQgLS1wYXRoc3BlYy1mcm9tLWZpbGU94oCmYCBpcyBwYXJzZWQgYnkgZ2l0IGFzIGFuXG4gKiBvcHRpb24sIG5vdCBhIHBhdGhzcGVjIOKAlCBhbiBhcmd1bWVudC9vcHRpb24taW5qZWN0aW9uIGZvb3QtZ3VuLlxuICpcbiAqIFRoaXMgbWlycm9ycyB0aGUgYGJ1aWxkQnJhbmNoRGVsZXRlQXJnc2AgaGFyZGVuaW5nIChJc3N1ZSAjMjc5OCkuIFRoZSBjYWxsc1xuICogdXNlIGBEZW5vLkNvbW1hbmRgIGFyZ3VtZW50IGFycmF5cywgc28gdGhlcmUgaXMgbm8gc2hlbGwgZXhwb3N1cmUg4oCUIHRoZSBgLS1gXG4gKiBzZXBhcmF0b3IgaXMgZGVmZW5jZS1pbi1kZXB0aCB0aGF0IGtlZXBzIHRoZSBwcmFjdGljZSBjb25zaXN0ZW50IGFjcm9zcyBldmVyeVxuICogY29uZmxpY3QtcmVzb2x1dGlvbiBjYWxsIHNpdGUuXG4gKi9cblxuLyoqXG4gKiBCdWlsZCB0aGUgYXJndiBmb3Igc3RhZ2luZyBhICh1bnRydXN0ZWQpIGNvbmZsaWN0ZWQgcGF0aCB3aXRoIHRoZSBgLS1gXG4gKiBlbmQtb2Ytb3B0aW9ucyBzZXBhcmF0b3IgYmVmb3JlIHRoZSBmaWxlbmFtZS5cbiAqXG4gKiBAcGFyYW0gZmlsZSAtIFRoZSBjb25mbGljdGVkIHBhdGggdG8gc3RhZ2UgKHVudHJ1c3RlZCBwb3NpdGlvbmFsKS5cbiAqIEByZXR1cm5zIFRoZSBnaXQgYXJndW1lbnQgYXJyYXksIGUuZy4gYFtcImFkZFwiLCBcIi0tXCIsIGZpbGVdYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQWRkUGF0aEFyZ3MoZmlsZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1wiYWRkXCIsIFwiLS1cIiwgZmlsZV07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGFyZ3YgZm9yIGNoZWNraW5nIG91dCBvbmUgc2lkZSBvZiBhIGNvbmZsaWN0ZWQgcGF0aCB3aXRoIHRoZSBgLS1gXG4gKiBlbmQtb2Ytb3B0aW9ucyBzZXBhcmF0b3IgYmVmb3JlIHRoZSAodW50cnVzdGVkKSBmaWxlbmFtZS5cbiAqXG4gKiBAcGFyYW0gc3RyYXRlZ3kgLSBXaGljaCBzaWRlIHRvIGFjY2VwdCAoXCJvdXJzXCIgZm9yIHVwc3RyZWFtLCBcInRoZWlyc1wiIGZvclxuICogICBsb2NhbCkuXG4gKiBAcGFyYW0gZmlsZSAtIFRoZSBjb25mbGljdGVkIHBhdGggdG8gY2hlY2sgb3V0ICh1bnRydXN0ZWQgcG9zaXRpb25hbCkuXG4gKiBAcmV0dXJucyBUaGUgZ2l0IGFyZ3VtZW50IGFycmF5LCBlLmcuIGBbXCJjaGVja291dFwiLCBcIi0tdGhlaXJzXCIsIFwiLS1cIiwgZmlsZV1gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRDaGVja291dFN0cmF0ZWd5QXJncyhcbiAgc3RyYXRlZ3k6IFwib3Vyc1wiIHwgXCJ0aGVpcnNcIixcbiAgZmlsZTogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1wiY2hlY2tvdXRcIiwgYC0tJHtzdHJhdGVneX1gLCBcIi0tXCIsIGZpbGVdO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBhcmd2IGZvciByZW1vdmluZyBhICh1bnRydXN0ZWQpIGNvbmZsaWN0ZWQgcGF0aCwgd2l0aCB0aGUgYC0tYFxuICogZW5kLW9mLW9wdGlvbnMgc2VwYXJhdG9yIGJlZm9yZSB0aGUgZmlsZW5hbWUuXG4gKlxuICogVXNlZCB3aGVuIHRoZSBpbmNvbWluZyBicmFuY2ggZGVsZXRlZCB0aGUgZmlsZSAoSXNzdWUgIzEwNDgpOiB0aGVyZSBpcyBub1xuICogaW5jb21pbmcgc2lkZSB0byBjaGVjayBvdXQsIHNvIGFjY2VwdGluZyB0aGF0IHNpZGUgbWVhbnMgcmVtb3ZpbmcgaXQgaGVyZS5cbiAqIGAtLWZvcmNlYCBiZWNhdXNlIHRoZSBwYXRoIGlzIGNvbmZsaWN0ZWQsIGFuZCBgLS1pZ25vcmUtdW5tYXRjaGAgc28gYSBmaWxlXG4gKiBnaXQgaGFzIGFscmVhZHkgZHJvcHBlZCBmcm9tIHRoZSB3b3JraW5nIHRyZWUgaXMgbm90IGEgZmFpbHVyZS5cbiAqXG4gKiBAcGFyYW0gZmlsZSAtIFRoZSBjb25mbGljdGVkIHBhdGggdG8gcmVtb3ZlICh1bnRydXN0ZWQgcG9zaXRpb25hbCkuXG4gKiBAcmV0dXJucyBUaGUgZ2l0IGFyZ3VtZW50IGFycmF5LCBlLmcuIGBbXCJybVwiLCBcIi0tZm9yY2VcIiwgXCItLVwiLCBmaWxlXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFJlbW92ZVBhdGhBcmdzKGZpbGU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcInJtXCIsIFwiLS1mb3JjZVwiLCBcIi0taWdub3JlLXVubWF0Y2hcIiwgXCItLVwiLCBmaWxlXTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUVEOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxpQkFBaUIsSUFBWTtFQUMzQyxPQUFPO0lBQUM7SUFBTztJQUFNO0dBQUs7QUFDNUI7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUywwQkFDZCxRQUEyQixFQUMzQixJQUFZO0VBRVosT0FBTztJQUFDO0lBQVksQ0FBQyxFQUFFLEVBQUUsVUFBVTtJQUFFO0lBQU07R0FBSztBQUNsRDtBQUVBOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLG9CQUFvQixJQUFZO0VBQzlDLE9BQU87SUFBQztJQUFNO0lBQVc7SUFBb0I7SUFBTTtHQUFLO0FBQzFEIn0=
// denoCacheMetadata=9909299530215573031,4781709164243715491