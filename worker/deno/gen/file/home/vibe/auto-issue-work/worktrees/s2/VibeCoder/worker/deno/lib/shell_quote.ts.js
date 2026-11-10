/**
 * POSIX shell quoting for values that are interpolated into a shell string
 * (Issue #3661, SEC-a228ff008ed4 / SEC-bea501c3a7d7).
 *
 * A value that reaches a shell unquoted is not merely a formatting bug: a path
 * containing a space silently splits into two arguments, and one containing
 * `;`, `$(...)` or a backtick executes. Every place the worker builds a string
 * that a shell will later parse must route the interpolated value through
 * {@link posixSingleQuote} so "no unescaped interpolation into a shell context"
 * is an invariant rather than a per-call-site habit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /**
 * Wrap a value in single quotes, safe for any POSIX shell.
 *
 * Inside single quotes every character is literal, so the only character
 * needing treatment is `'` itself: close the quote, emit an escaped quote,
 * reopen (`'\''`). The result is always a single shell word.
 *
 * @param value - The raw value to quote.
 * @returns The value as one single-quoted shell word.
 */ export function posixSingleQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
/**
 * Build the `GIT_SSH_COMMAND` value for a service-account SSH key.
 *
 * Git hands `GIT_SSH_COMMAND` to `/bin/sh`, so the key path is shell input,
 * not an argv element. Quoting it keeps a path with a space authenticating
 * with the intended identity instead of silently falling back to the ambient
 * one, and stops a path containing shell metacharacters from executing at
 * every clone, fetch and push.
 *
 * @param keyPath - Absolute path to the private key (already `~`-expanded).
 * @returns The `GIT_SSH_COMMAND` string with the key path quoted.
 */ export function buildGitSshCommand(keyPath) {
  return `ssh -i ${posixSingleQuote(keyPath)} -o IdentitiesOnly=yes`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zaGVsbF9xdW90ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBPU0lYIHNoZWxsIHF1b3RpbmcgZm9yIHZhbHVlcyB0aGF0IGFyZSBpbnRlcnBvbGF0ZWQgaW50byBhIHNoZWxsIHN0cmluZ1xuICogKElzc3VlICMzNjYxLCBTRUMtYTIyOGZmMDA4ZWQ0IC8gU0VDLWJlYTUwMWMzYTdkNykuXG4gKlxuICogQSB2YWx1ZSB0aGF0IHJlYWNoZXMgYSBzaGVsbCB1bnF1b3RlZCBpcyBub3QgbWVyZWx5IGEgZm9ybWF0dGluZyBidWc6IGEgcGF0aFxuICogY29udGFpbmluZyBhIHNwYWNlIHNpbGVudGx5IHNwbGl0cyBpbnRvIHR3byBhcmd1bWVudHMsIGFuZCBvbmUgY29udGFpbmluZ1xuICogYDtgLCBgJCguLi4pYCBvciBhIGJhY2t0aWNrIGV4ZWN1dGVzLiBFdmVyeSBwbGFjZSB0aGUgd29ya2VyIGJ1aWxkcyBhIHN0cmluZ1xuICogdGhhdCBhIHNoZWxsIHdpbGwgbGF0ZXIgcGFyc2UgbXVzdCByb3V0ZSB0aGUgaW50ZXJwb2xhdGVkIHZhbHVlIHRocm91Z2hcbiAqIHtAbGluayBwb3NpeFNpbmdsZVF1b3RlfSBzbyBcIm5vIHVuZXNjYXBlZCBpbnRlcnBvbGF0aW9uIGludG8gYSBzaGVsbCBjb250ZXh0XCJcbiAqIGlzIGFuIGludmFyaWFudCByYXRoZXIgdGhhbiBhIHBlci1jYWxsLXNpdGUgaGFiaXQuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLyoqXG4gKiBXcmFwIGEgdmFsdWUgaW4gc2luZ2xlIHF1b3Rlcywgc2FmZSBmb3IgYW55IFBPU0lYIHNoZWxsLlxuICpcbiAqIEluc2lkZSBzaW5nbGUgcXVvdGVzIGV2ZXJ5IGNoYXJhY3RlciBpcyBsaXRlcmFsLCBzbyB0aGUgb25seSBjaGFyYWN0ZXJcbiAqIG5lZWRpbmcgdHJlYXRtZW50IGlzIGAnYCBpdHNlbGY6IGNsb3NlIHRoZSBxdW90ZSwgZW1pdCBhbiBlc2NhcGVkIHF1b3RlLFxuICogcmVvcGVuIChgJ1xcJydgKS4gVGhlIHJlc3VsdCBpcyBhbHdheXMgYSBzaW5nbGUgc2hlbGwgd29yZC5cbiAqXG4gKiBAcGFyYW0gdmFsdWUgLSBUaGUgcmF3IHZhbHVlIHRvIHF1b3RlLlxuICogQHJldHVybnMgVGhlIHZhbHVlIGFzIG9uZSBzaW5nbGUtcXVvdGVkIHNoZWxsIHdvcmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwb3NpeFNpbmdsZVF1b3RlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCcke3ZhbHVlLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGBHSVRfU1NIX0NPTU1BTkRgIHZhbHVlIGZvciBhIHNlcnZpY2UtYWNjb3VudCBTU0gga2V5LlxuICpcbiAqIEdpdCBoYW5kcyBgR0lUX1NTSF9DT01NQU5EYCB0byBgL2Jpbi9zaGAsIHNvIHRoZSBrZXkgcGF0aCBpcyBzaGVsbCBpbnB1dCxcbiAqIG5vdCBhbiBhcmd2IGVsZW1lbnQuIFF1b3RpbmcgaXQga2VlcHMgYSBwYXRoIHdpdGggYSBzcGFjZSBhdXRoZW50aWNhdGluZ1xuICogd2l0aCB0aGUgaW50ZW5kZWQgaWRlbnRpdHkgaW5zdGVhZCBvZiBzaWxlbnRseSBmYWxsaW5nIGJhY2sgdG8gdGhlIGFtYmllbnRcbiAqIG9uZSwgYW5kIHN0b3BzIGEgcGF0aCBjb250YWluaW5nIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIGZyb20gZXhlY3V0aW5nIGF0XG4gKiBldmVyeSBjbG9uZSwgZmV0Y2ggYW5kIHB1c2guXG4gKlxuICogQHBhcmFtIGtleVBhdGggLSBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcml2YXRlIGtleSAoYWxyZWFkeSBgfmAtZXhwYW5kZWQpLlxuICogQHJldHVybnMgVGhlIGBHSVRfU1NIX0NPTU1BTkRgIHN0cmluZyB3aXRoIHRoZSBrZXkgcGF0aCBxdW90ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdpdFNzaENvbW1hbmQoa2V5UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBzc2ggLWkgJHtwb3NpeFNpbmdsZVF1b3RlKGtleVBhdGgpfSAtbyBJZGVudGl0aWVzT25seT15ZXNgO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUVEOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxpQkFBaUIsS0FBYTtFQUM1QyxPQUFPLENBQUMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDOUM7QUFFQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsT0FBZTtFQUNoRCxPQUFPLENBQUMsT0FBTyxFQUFFLGlCQUFpQixTQUFTLHNCQUFzQixDQUFDO0FBQ3BFIn0=
// denoCacheMetadata=1146885513927811051,1072150121597814900