/**
 * The one comment the CI-fix lane posts for a human-gate check (Issue #2727,
 * parent #2683).
 *
 * A check that prints `vibe-human-gate: <step>` waits on a person, not on a
 * code change. The lane announces the step once per pull request per gate
 * check and then stays silent; the marker the comment carries is what makes
 * every later pass, on any host, post nothing.
 *
 * The step comes from the check's log, which a pull-request author can
 * influence. The classifier has already flattened it, neutralised its
 * HTML-comment markers and bounded it; this module renders it inside a code
 * span whose fence is longer than any backtick run in the step, so it can
 * neither break out into Markdown structure nor `@`-mention anyone.
 *
 * Pure: builds a string, does no I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ /**
 * Render untrusted single-line text as an inert Markdown code span.
 *
 * CommonMark closes a code span only on a backtick run of the *same* length
 * as the opener, so a fence one longer than the longest run inside cannot be
 * closed early. The padding spaces keep a leading or trailing backtick in the
 * text from merging with the fence; CommonMark strips one from each side.
 *
 * @param text - Single-line text (the classifier already flattened it).
 * @returns The text wrapped in a code span.
 */ export function inertCodeSpan(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run)=>run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}
/**
 * Build the single gate comment for one check.
 *
 * @param input - Inert check name, the human step and the gate marker.
 * @returns The comment body.
 */ export function buildHumanGateComment(input) {
  return [
    "### CI check waiting on a human step",
    "",
    `The failing check **${input.safeCheckName}** declares a human gate. ` + "It clears only once a person takes this step:",
    "",
    inertCodeSpan(input.humanStep),
    "",
    "The fleet has not attempted a code fix for this check, has added no " + "label, and will not comment on it again. The check passes once the " + "step is done and it re-runs.",
    "",
    input.marker
  ].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jaV9odW1hbl9nYXRlX2NvbW1lbnQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgb25lIGNvbW1lbnQgdGhlIENJLWZpeCBsYW5lIHBvc3RzIGZvciBhIGh1bWFuLWdhdGUgY2hlY2sgKElzc3VlICMyNzI3LFxuICogcGFyZW50ICMyNjgzKS5cbiAqXG4gKiBBIGNoZWNrIHRoYXQgcHJpbnRzIGB2aWJlLWh1bWFuLWdhdGU6IDxzdGVwPmAgd2FpdHMgb24gYSBwZXJzb24sIG5vdCBvbiBhXG4gKiBjb2RlIGNoYW5nZS4gVGhlIGxhbmUgYW5ub3VuY2VzIHRoZSBzdGVwIG9uY2UgcGVyIHB1bGwgcmVxdWVzdCBwZXIgZ2F0ZVxuICogY2hlY2sgYW5kIHRoZW4gc3RheXMgc2lsZW50OyB0aGUgbWFya2VyIHRoZSBjb21tZW50IGNhcnJpZXMgaXMgd2hhdCBtYWtlc1xuICogZXZlcnkgbGF0ZXIgcGFzcywgb24gYW55IGhvc3QsIHBvc3Qgbm90aGluZy5cbiAqXG4gKiBUaGUgc3RlcCBjb21lcyBmcm9tIHRoZSBjaGVjaydzIGxvZywgd2hpY2ggYSBwdWxsLXJlcXVlc3QgYXV0aG9yIGNhblxuICogaW5mbHVlbmNlLiBUaGUgY2xhc3NpZmllciBoYXMgYWxyZWFkeSBmbGF0dGVuZWQgaXQsIG5ldXRyYWxpc2VkIGl0c1xuICogSFRNTC1jb21tZW50IG1hcmtlcnMgYW5kIGJvdW5kZWQgaXQ7IHRoaXMgbW9kdWxlIHJlbmRlcnMgaXQgaW5zaWRlIGEgY29kZVxuICogc3BhbiB3aG9zZSBmZW5jZSBpcyBsb25nZXIgdGhhbiBhbnkgYmFja3RpY2sgcnVuIGluIHRoZSBzdGVwLCBzbyBpdCBjYW5cbiAqIG5laXRoZXIgYnJlYWsgb3V0IGludG8gTWFya2Rvd24gc3RydWN0dXJlIG5vciBgQGAtbWVudGlvbiBhbnlvbmUuXG4gKlxuICogUHVyZTogYnVpbGRzIGEgc3RyaW5nLCBkb2VzIG5vIEkvTy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG4vKipcbiAqIFJlbmRlciB1bnRydXN0ZWQgc2luZ2xlLWxpbmUgdGV4dCBhcyBhbiBpbmVydCBNYXJrZG93biBjb2RlIHNwYW4uXG4gKlxuICogQ29tbW9uTWFyayBjbG9zZXMgYSBjb2RlIHNwYW4gb25seSBvbiBhIGJhY2t0aWNrIHJ1biBvZiB0aGUgKnNhbWUqIGxlbmd0aFxuICogYXMgdGhlIG9wZW5lciwgc28gYSBmZW5jZSBvbmUgbG9uZ2VyIHRoYW4gdGhlIGxvbmdlc3QgcnVuIGluc2lkZSBjYW5ub3QgYmVcbiAqIGNsb3NlZCBlYXJseS4gVGhlIHBhZGRpbmcgc3BhY2VzIGtlZXAgYSBsZWFkaW5nIG9yIHRyYWlsaW5nIGJhY2t0aWNrIGluIHRoZVxuICogdGV4dCBmcm9tIG1lcmdpbmcgd2l0aCB0aGUgZmVuY2U7IENvbW1vbk1hcmsgc3RyaXBzIG9uZSBmcm9tIGVhY2ggc2lkZS5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIFNpbmdsZS1saW5lIHRleHQgKHRoZSBjbGFzc2lmaWVyIGFscmVhZHkgZmxhdHRlbmVkIGl0KS5cbiAqIEByZXR1cm5zIFRoZSB0ZXh0IHdyYXBwZWQgaW4gYSBjb2RlIHNwYW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbmVydENvZGVTcGFuKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGxvbmdlc3RSdW4gPSBNYXRoLm1heChcbiAgICAwLFxuICAgIC4uLih0ZXh0Lm1hdGNoKC9gKy9nKSA/PyBbXSkubWFwKChydW4pID0+IHJ1bi5sZW5ndGgpLFxuICApO1xuICBjb25zdCBmZW5jZSA9IFwiYFwiLnJlcGVhdChsb25nZXN0UnVuICsgMSk7XG4gIHJldHVybiBgJHtmZW5jZX0gJHt0ZXh0fSAke2ZlbmNlfWA7XG59XG5cbi8qKiBJbnB1dHMgZm9yIHtAbGluayBidWlsZEh1bWFuR2F0ZUNvbW1lbnR9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBIdW1hbkdhdGVDb21tZW50SW5wdXQge1xuICAvKiogVGhlIGNoZWNrIG5hbWUsIGFscmVhZHkgbWFkZSBpbmVydCBmb3IgYSBmbGVldC1hdXRob3JlZCBib2R5LiAqL1xuICBzYWZlQ2hlY2tOYW1lOiBzdHJpbmc7XG4gIC8qKiBUaGUgaHVtYW4gc3RlcCB0aGUgY2xhc3NpZmllciBleHRyYWN0ZWQuICovXG4gIGh1bWFuU3RlcDogc3RyaW5nO1xuICAvKiogVGhlIGB2aWJlLWNpLWh1bWFuLWdhdGVgIG1hcmtlciBmb3IgdGhpcyBjaGVjay4gKi9cbiAgbWFya2VyOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHNpbmdsZSBnYXRlIGNvbW1lbnQgZm9yIG9uZSBjaGVjay5cbiAqXG4gKiBAcGFyYW0gaW5wdXQgLSBJbmVydCBjaGVjayBuYW1lLCB0aGUgaHVtYW4gc3RlcCBhbmQgdGhlIGdhdGUgbWFya2VyLlxuICogQHJldHVybnMgVGhlIGNvbW1lbnQgYm9keS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkSHVtYW5HYXRlQ29tbWVudChpbnB1dDogSHVtYW5HYXRlQ29tbWVudElucHV0KTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIiMjIyBDSSBjaGVjayB3YWl0aW5nIG9uIGEgaHVtYW4gc3RlcFwiLFxuICAgIFwiXCIsXG4gICAgYFRoZSBmYWlsaW5nIGNoZWNrICoqJHtpbnB1dC5zYWZlQ2hlY2tOYW1lfSoqIGRlY2xhcmVzIGEgaHVtYW4gZ2F0ZS4gYCArXG4gICAgXCJJdCBjbGVhcnMgb25seSBvbmNlIGEgcGVyc29uIHRha2VzIHRoaXMgc3RlcDpcIixcbiAgICBcIlwiLFxuICAgIGluZXJ0Q29kZVNwYW4oaW5wdXQuaHVtYW5TdGVwKSxcbiAgICBcIlwiLFxuICAgIFwiVGhlIGZsZWV0IGhhcyBub3QgYXR0ZW1wdGVkIGEgY29kZSBmaXggZm9yIHRoaXMgY2hlY2ssIGhhcyBhZGRlZCBubyBcIiArXG4gICAgXCJsYWJlbCwgYW5kIHdpbGwgbm90IGNvbW1lbnQgb24gaXQgYWdhaW4uIFRoZSBjaGVjayBwYXNzZXMgb25jZSB0aGUgXCIgK1xuICAgIFwic3RlcCBpcyBkb25lIGFuZCBpdCByZS1ydW5zLlwiLFxuICAgIFwiXCIsXG4gICAgaW5wdXQubWFya2VyLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtCQyxHQUVEOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsY0FBYyxJQUFZO0VBQ3hDLE1BQU0sYUFBYSxLQUFLLEdBQUcsQ0FDekIsTUFDRyxDQUFDLEtBQUssS0FBSyxDQUFDLFVBQVUsRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDLE1BQVEsSUFBSSxNQUFNO0VBRXRELE1BQU0sUUFBUSxJQUFJLE1BQU0sQ0FBQyxhQUFhO0VBQ3RDLE9BQU8sR0FBRyxNQUFNLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxPQUFPO0FBQ3BDO0FBWUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsc0JBQXNCLEtBQTRCO0VBQ2hFLE9BQU87SUFDTDtJQUNBO0lBQ0EsQ0FBQyxvQkFBb0IsRUFBRSxNQUFNLGFBQWEsQ0FBQywwQkFBMEIsQ0FBQyxHQUN0RTtJQUNBO0lBQ0EsY0FBYyxNQUFNLFNBQVM7SUFDN0I7SUFDQSx5RUFDQSx3RUFDQTtJQUNBO0lBQ0EsTUFBTSxNQUFNO0dBQ2IsQ0FBQyxJQUFJLENBQUM7QUFDVCJ9
// denoCacheMetadata=8562248590653392329,381071957466073036