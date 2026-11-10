/**
 * Structure-preserving redaction for JSON payloads (Issue #1261).
 *
 * `issue_cache.ts` persists whole GitHub issue and PR objects, so a token
 * pasted into an issue body was written to the work volume verbatim and read
 * back into a later prompt. Running {@link redactSecrets} over the
 * *serialised* JSON is not an option: the `secret-assignment` rule matches
 * `"access_token":"…"` across the structural quotes and would leave the file
 * unparseable, turning every later read into a silent miss.
 *
 * Redacting each string **value** instead keeps the document valid by
 * construction: only the contents of a string change, never the syntax
 * around it. Object keys are left alone — they are GitHub's field names, and
 * masking one would break every consumer that looks the field up.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactSecrets } from "./secret_redaction.ts";
/**
 * Deepest nesting redacted. Real GitHub payloads are a handful of levels
 * deep; the cap bounds the recursion so a cyclic or pathologically nested
 * value cannot exhaust the stack.
 */ export const MAX_REDACTION_DEPTH = 64;
/**
 * Return a copy of `value` with every string redacted.
 *
 * @param value - Any JSON-serialisable value.
 * @param depth - Current nesting level; callers leave it at the default.
 * @returns The redacted copy. Anything nested deeper than
 *   {@link MAX_REDACTION_DEPTH} is dropped (replaced with `null`) rather
 *   than persisted unredacted.
 */ export function redactJsonStrings(value, depth = 0) {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= MAX_REDACTION_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item)=>redactJsonStrings(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out = {};
    for (const [key, item] of Object.entries(value)){
      out[key] = redactJsonStrings(item, depth + 1);
    }
    return out;
  }
  return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZWRhY3RfanNvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0cnVjdHVyZS1wcmVzZXJ2aW5nIHJlZGFjdGlvbiBmb3IgSlNPTiBwYXlsb2FkcyAoSXNzdWUgIzEyNjEpLlxuICpcbiAqIGBpc3N1ZV9jYWNoZS50c2AgcGVyc2lzdHMgd2hvbGUgR2l0SHViIGlzc3VlIGFuZCBQUiBvYmplY3RzLCBzbyBhIHRva2VuXG4gKiBwYXN0ZWQgaW50byBhbiBpc3N1ZSBib2R5IHdhcyB3cml0dGVuIHRvIHRoZSB3b3JrIHZvbHVtZSB2ZXJiYXRpbSBhbmQgcmVhZFxuICogYmFjayBpbnRvIGEgbGF0ZXIgcHJvbXB0LiBSdW5uaW5nIHtAbGluayByZWRhY3RTZWNyZXRzfSBvdmVyIHRoZVxuICogKnNlcmlhbGlzZWQqIEpTT04gaXMgbm90IGFuIG9wdGlvbjogdGhlIGBzZWNyZXQtYXNzaWdubWVudGAgcnVsZSBtYXRjaGVzXG4gKiBgXCJhY2Nlc3NfdG9rZW5cIjpcIuKAplwiYCBhY3Jvc3MgdGhlIHN0cnVjdHVyYWwgcXVvdGVzIGFuZCB3b3VsZCBsZWF2ZSB0aGUgZmlsZVxuICogdW5wYXJzZWFibGUsIHR1cm5pbmcgZXZlcnkgbGF0ZXIgcmVhZCBpbnRvIGEgc2lsZW50IG1pc3MuXG4gKlxuICogUmVkYWN0aW5nIGVhY2ggc3RyaW5nICoqdmFsdWUqKiBpbnN0ZWFkIGtlZXBzIHRoZSBkb2N1bWVudCB2YWxpZCBieVxuICogY29uc3RydWN0aW9uOiBvbmx5IHRoZSBjb250ZW50cyBvZiBhIHN0cmluZyBjaGFuZ2UsIG5ldmVyIHRoZSBzeW50YXhcbiAqIGFyb3VuZCBpdC4gT2JqZWN0IGtleXMgYXJlIGxlZnQgYWxvbmUg4oCUIHRoZXkgYXJlIEdpdEh1YidzIGZpZWxkIG5hbWVzLCBhbmRcbiAqIG1hc2tpbmcgb25lIHdvdWxkIGJyZWFrIGV2ZXJ5IGNvbnN1bWVyIHRoYXQgbG9va3MgdGhlIGZpZWxkIHVwLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IHJlZGFjdFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfcmVkYWN0aW9uLnRzXCI7XG5cbi8qKlxuICogRGVlcGVzdCBuZXN0aW5nIHJlZGFjdGVkLiBSZWFsIEdpdEh1YiBwYXlsb2FkcyBhcmUgYSBoYW5kZnVsIG9mIGxldmVsc1xuICogZGVlcDsgdGhlIGNhcCBib3VuZHMgdGhlIHJlY3Vyc2lvbiBzbyBhIGN5Y2xpYyBvciBwYXRob2xvZ2ljYWxseSBuZXN0ZWRcbiAqIHZhbHVlIGNhbm5vdCBleGhhdXN0IHRoZSBzdGFjay5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9SRURBQ1RJT05fREVQVEggPSA2NDtcblxuLyoqXG4gKiBSZXR1cm4gYSBjb3B5IG9mIGB2YWx1ZWAgd2l0aCBldmVyeSBzdHJpbmcgcmVkYWN0ZWQuXG4gKlxuICogQHBhcmFtIHZhbHVlIC0gQW55IEpTT04tc2VyaWFsaXNhYmxlIHZhbHVlLlxuICogQHBhcmFtIGRlcHRoIC0gQ3VycmVudCBuZXN0aW5nIGxldmVsOyBjYWxsZXJzIGxlYXZlIGl0IGF0IHRoZSBkZWZhdWx0LlxuICogQHJldHVybnMgVGhlIHJlZGFjdGVkIGNvcHkuIEFueXRoaW5nIG5lc3RlZCBkZWVwZXIgdGhhblxuICogICB7QGxpbmsgTUFYX1JFREFDVElPTl9ERVBUSH0gaXMgZHJvcHBlZCAocmVwbGFjZWQgd2l0aCBgbnVsbGApIHJhdGhlclxuICogICB0aGFuIHBlcnNpc3RlZCB1bnJlZGFjdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkYWN0SnNvblN0cmluZ3ModmFsdWU6IHVua25vd24sIGRlcHRoID0gMCk6IHVua25vd24ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSByZXR1cm4gcmVkYWN0U2VjcmV0cyh2YWx1ZSk7XG4gIGlmIChkZXB0aCA+PSBNQVhfUkVEQUNUSU9OX0RFUFRIKSByZXR1cm4gbnVsbDtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlLm1hcCgoaXRlbSkgPT4gcmVkYWN0SnNvblN0cmluZ3MoaXRlbSwgZGVwdGggKyAxKSk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGl0ZW1dIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkge1xuICAgICAgb3V0W2tleV0gPSByZWRhY3RKc29uU3RyaW5ncyhpdGVtLCBkZXB0aCArIDEpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUVELFNBQVMsYUFBYSxRQUFRLHdCQUF3QjtBQUV0RDs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLHNCQUFzQixHQUFHO0FBRXRDOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLGtCQUFrQixLQUFjLEVBQUUsUUFBUSxDQUFDO0VBQ3pELElBQUksT0FBTyxVQUFVLFVBQVUsT0FBTyxjQUFjO0VBQ3BELElBQUksU0FBUyxxQkFBcUIsT0FBTztFQUN6QyxJQUFJLE1BQU0sT0FBTyxDQUFDLFFBQVE7SUFDeEIsT0FBTyxNQUFNLEdBQUcsQ0FBQyxDQUFDLE9BQVMsa0JBQWtCLE1BQU0sUUFBUTtFQUM3RDtFQUNBLElBQUksT0FBTyxVQUFVLFlBQVksVUFBVSxNQUFNO0lBQy9DLE1BQU0sTUFBK0IsQ0FBQztJQUN0QyxLQUFLLE1BQU0sQ0FBQyxLQUFLLEtBQUssSUFBSSxPQUFPLE9BQU8sQ0FBQyxPQUFRO01BQy9DLEdBQUcsQ0FBQyxJQUFJLEdBQUcsa0JBQWtCLE1BQU0sUUFBUTtJQUM3QztJQUNBLE9BQU87RUFDVDtFQUNBLE9BQU87QUFDVCJ9
// denoCacheMetadata=8466816173293042921,7977219404434342552