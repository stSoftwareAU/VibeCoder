/**
 * Escape a literal for use inside a `RegExp` source.
 *
 * One copy, so every caller escapes the backslash along with the other
 * metacharacters (CodeQL js/incomplete-sanitization): escaping only the
 * characters a literal happens to contain today breaks the pattern the day
 * the literal gains a backslash.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ /**
 * Escape every `RegExp` metacharacter in `literal`.
 *
 * @param literal - Text to match verbatim
 * @returns The text, safe to embed in a `RegExp` source
 */ export function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZWdleHBfZXNjYXBlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRXNjYXBlIGEgbGl0ZXJhbCBmb3IgdXNlIGluc2lkZSBhIGBSZWdFeHBgIHNvdXJjZS5cbiAqXG4gKiBPbmUgY29weSwgc28gZXZlcnkgY2FsbGVyIGVzY2FwZXMgdGhlIGJhY2tzbGFzaCBhbG9uZyB3aXRoIHRoZSBvdGhlclxuICogbWV0YWNoYXJhY3RlcnMgKENvZGVRTCBqcy9pbmNvbXBsZXRlLXNhbml0aXphdGlvbik6IGVzY2FwaW5nIG9ubHkgdGhlXG4gKiBjaGFyYWN0ZXJzIGEgbGl0ZXJhbCBoYXBwZW5zIHRvIGNvbnRhaW4gdG9kYXkgYnJlYWtzIHRoZSBwYXR0ZXJuIHRoZSBkYXlcbiAqIHRoZSBsaXRlcmFsIGdhaW5zIGEgYmFja3NsYXNoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbi8qKlxuICogRXNjYXBlIGV2ZXJ5IGBSZWdFeHBgIG1ldGFjaGFyYWN0ZXIgaW4gYGxpdGVyYWxgLlxuICpcbiAqIEBwYXJhbSBsaXRlcmFsIC0gVGV4dCB0byBtYXRjaCB2ZXJiYXRpbVxuICogQHJldHVybnMgVGhlIHRleHQsIHNhZmUgdG8gZW1iZWQgaW4gYSBgUmVnRXhwYCBzb3VyY2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVzY2FwZVJlZ0V4cChsaXRlcmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbGl0ZXJhbC5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7OztDQVNDLEdBRUQ7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsYUFBYSxPQUFlO0VBQzFDLE9BQU8sUUFBUSxPQUFPLENBQUMsdUJBQXVCO0FBQ2hEIn0=
// denoCacheMetadata=4196869596180387322,303695852729623597