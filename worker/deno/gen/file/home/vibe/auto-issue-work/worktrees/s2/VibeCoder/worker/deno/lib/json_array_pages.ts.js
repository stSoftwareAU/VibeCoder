/**
 * Shared parser for `gh api --paginate` output (Issue #2895).
 *
 * `--paginate` prints one top-level JSON array per page, concatenated with no
 * guaranteed separator. Splitting that on a `][`-shaped regex breaks as soon
 * as a page body contains `[text][ref]` or an escaped `]\n[`, producing
 * "Unterminated string in JSON". This scans the raw text for top-level page
 * boundaries while tracking JSON string state instead. One shared parser
 * keeps every paginated read — with or without `--jq` — on the same path
 * (see `marker_comment_pages.ts` for the sibling parser that works
 * line-by-line instead of scanning raw concatenated pages).
 */ /** One page's scan outcome: where it ended and the elements it held. */ /** Scan one `[...]` page starting at `startIndex`, tracking string state. */ function scanPage(raw, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let index = startIndex;
  for(; index < raw.length; index++){
    const ch = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    }
    if (depth === 0) {
      index++;
      break;
    }
  }
  if (depth !== 0 || inString) {
    throw new Error(`gh output ends mid-page (unterminated) at offset ${startIndex}`);
  }
  const pageText = raw.slice(startIndex, index);
  let parsed;
  try {
    parsed = JSON.parse(pageText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh returned a malformed JSON array page: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh returned output that is not a JSON array page at offset ${startIndex}`);
  }
  return {
    endIndex: index,
    elements: parsed
  };
}
/**
 * Parse `gh api --paginate` output made of one or more concatenated
 * top-level JSON arrays into a single flat list, in page order.
 *
 * @param raw - Raw stdout from a paginated `gh api` call
 * @returns Every element from every page, in page order
 * @throws {Error} When a non-whitespace character outside a page is not `[`,
 * a page does not parse as JSON, a parsed page is not an array, or the input
 * ends mid-page
 */ export function parseJsonArrayPages(raw) {
  const elements = [];
  let index = 0;
  while(index < raw.length){
    const ch = raw[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index++;
      continue;
    }
    if (ch !== "[") {
      throw new Error(`gh returned output that is not a JSON array page at offset ${index}`);
    }
    const page = scanPage(raw, index);
    elements.push(...page.elements);
    index = page.endIndex;
  }
  return elements;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9qc29uX2FycmF5X3BhZ2VzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2hhcmVkIHBhcnNlciBmb3IgYGdoIGFwaSAtLXBhZ2luYXRlYCBvdXRwdXQgKElzc3VlICMyODk1KS5cbiAqXG4gKiBgLS1wYWdpbmF0ZWAgcHJpbnRzIG9uZSB0b3AtbGV2ZWwgSlNPTiBhcnJheSBwZXIgcGFnZSwgY29uY2F0ZW5hdGVkIHdpdGggbm9cbiAqIGd1YXJhbnRlZWQgc2VwYXJhdG9yLiBTcGxpdHRpbmcgdGhhdCBvbiBhIGBdW2Atc2hhcGVkIHJlZ2V4IGJyZWFrcyBhcyBzb29uXG4gKiBhcyBhIHBhZ2UgYm9keSBjb250YWlucyBgW3RleHRdW3JlZl1gIG9yIGFuIGVzY2FwZWQgYF1cXG5bYCwgcHJvZHVjaW5nXG4gKiBcIlVudGVybWluYXRlZCBzdHJpbmcgaW4gSlNPTlwiLiBUaGlzIHNjYW5zIHRoZSByYXcgdGV4dCBmb3IgdG9wLWxldmVsIHBhZ2VcbiAqIGJvdW5kYXJpZXMgd2hpbGUgdHJhY2tpbmcgSlNPTiBzdHJpbmcgc3RhdGUgaW5zdGVhZC4gT25lIHNoYXJlZCBwYXJzZXJcbiAqIGtlZXBzIGV2ZXJ5IHBhZ2luYXRlZCByZWFkIOKAlCB3aXRoIG9yIHdpdGhvdXQgYC0tanFgIOKAlCBvbiB0aGUgc2FtZSBwYXRoXG4gKiAoc2VlIGBtYXJrZXJfY29tbWVudF9wYWdlcy50c2AgZm9yIHRoZSBzaWJsaW5nIHBhcnNlciB0aGF0IHdvcmtzXG4gKiBsaW5lLWJ5LWxpbmUgaW5zdGVhZCBvZiBzY2FubmluZyByYXcgY29uY2F0ZW5hdGVkIHBhZ2VzKS5cbiAqL1xuXG4vKiogT25lIHBhZ2UncyBzY2FuIG91dGNvbWU6IHdoZXJlIGl0IGVuZGVkIGFuZCB0aGUgZWxlbWVudHMgaXQgaGVsZC4gKi9cbmludGVyZmFjZSBQYWdlU2NhbiB7XG4gIC8qKiBJbmRleCBqdXN0IHBhc3QgdGhlIHBhZ2UncyBjbG9zaW5nIGBdYC4gKi9cbiAgZW5kSW5kZXg6IG51bWJlcjtcbiAgLyoqIFRoZSBlbGVtZW50cyB0aGUgcGFnZSdzIHRvcC1sZXZlbCBhcnJheSBoZWxkLiAqL1xuICBlbGVtZW50czogdW5rbm93bltdO1xufVxuXG4vKiogU2NhbiBvbmUgYFsuLi5dYCBwYWdlIHN0YXJ0aW5nIGF0IGBzdGFydEluZGV4YCwgdHJhY2tpbmcgc3RyaW5nIHN0YXRlLiAqL1xuZnVuY3Rpb24gc2NhblBhZ2UocmF3OiBzdHJpbmcsIHN0YXJ0SW5kZXg6IG51bWJlcik6IFBhZ2VTY2FuIHtcbiAgbGV0IGRlcHRoID0gMDtcbiAgbGV0IGluU3RyaW5nID0gZmFsc2U7XG4gIGxldCBlc2NhcGVkID0gZmFsc2U7XG4gIGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cbiAgZm9yICg7IGluZGV4IDwgcmF3Lmxlbmd0aDsgaW5kZXgrKykge1xuICAgIGNvbnN0IGNoID0gcmF3W2luZGV4XTtcblxuICAgIGlmIChpblN0cmluZykge1xuICAgICAgaWYgKGVzY2FwZWQpIHtcbiAgICAgICAgZXNjYXBlZCA9IGZhbHNlO1xuICAgICAgfSBlbHNlIGlmIChjaCA9PT0gXCJcXFxcXCIpIHtcbiAgICAgICAgZXNjYXBlZCA9IHRydWU7XG4gICAgICB9IGVsc2UgaWYgKGNoID09PSAnXCInKSB7XG4gICAgICAgIGluU3RyaW5nID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoY2ggPT09ICdcIicpIHtcbiAgICAgIGluU3RyaW5nID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBcIltcIiB8fCBjaCA9PT0gXCJ7XCIpIHtcbiAgICAgIGRlcHRoKys7XG4gICAgfSBlbHNlIGlmIChjaCA9PT0gXCJdXCIgfHwgY2ggPT09IFwifVwiKSB7XG4gICAgICBkZXB0aC0tO1xuICAgIH1cblxuICAgIGlmIChkZXB0aCA9PT0gMCkge1xuICAgICAgaW5kZXgrKztcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmIChkZXB0aCAhPT0gMCB8fCBpblN0cmluZykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBnaCBvdXRwdXQgZW5kcyBtaWQtcGFnZSAodW50ZXJtaW5hdGVkKSBhdCBvZmZzZXQgJHtzdGFydEluZGV4fWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHBhZ2VUZXh0ID0gcmF3LnNsaWNlKHN0YXJ0SW5kZXgsIGluZGV4KTtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHBhZ2VUZXh0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGdoIHJldHVybmVkIGEgbWFsZm9ybWVkIEpTT04gYXJyYXkgcGFnZTogJHttZXNzYWdlfWApO1xuICB9XG5cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZ2ggcmV0dXJuZWQgb3V0cHV0IHRoYXQgaXMgbm90IGEgSlNPTiBhcnJheSBwYWdlIGF0IG9mZnNldCAke3N0YXJ0SW5kZXh9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsgZW5kSW5kZXg6IGluZGV4LCBlbGVtZW50czogcGFyc2VkIH07XG59XG5cbi8qKlxuICogUGFyc2UgYGdoIGFwaSAtLXBhZ2luYXRlYCBvdXRwdXQgbWFkZSBvZiBvbmUgb3IgbW9yZSBjb25jYXRlbmF0ZWRcbiAqIHRvcC1sZXZlbCBKU09OIGFycmF5cyBpbnRvIGEgc2luZ2xlIGZsYXQgbGlzdCwgaW4gcGFnZSBvcmRlci5cbiAqXG4gKiBAcGFyYW0gcmF3IC0gUmF3IHN0ZG91dCBmcm9tIGEgcGFnaW5hdGVkIGBnaCBhcGlgIGNhbGxcbiAqIEByZXR1cm5zIEV2ZXJ5IGVsZW1lbnQgZnJvbSBldmVyeSBwYWdlLCBpbiBwYWdlIG9yZGVyXG4gKiBAdGhyb3dzIHtFcnJvcn0gV2hlbiBhIG5vbi13aGl0ZXNwYWNlIGNoYXJhY3RlciBvdXRzaWRlIGEgcGFnZSBpcyBub3QgYFtgLFxuICogYSBwYWdlIGRvZXMgbm90IHBhcnNlIGFzIEpTT04sIGEgcGFyc2VkIHBhZ2UgaXMgbm90IGFuIGFycmF5LCBvciB0aGUgaW5wdXRcbiAqIGVuZHMgbWlkLXBhZ2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSnNvbkFycmF5UGFnZXMocmF3OiBzdHJpbmcpOiB1bmtub3duW10ge1xuICBjb25zdCBlbGVtZW50czogdW5rbm93bltdID0gW107XG4gIGxldCBpbmRleCA9IDA7XG5cbiAgd2hpbGUgKGluZGV4IDwgcmF3Lmxlbmd0aCkge1xuICAgIGNvbnN0IGNoID0gcmF3W2luZGV4XTtcbiAgICBpZiAoY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIlxcdFwiIHx8IGNoID09PSBcIlxcblwiIHx8IGNoID09PSBcIlxcclwiKSB7XG4gICAgICBpbmRleCsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCAhPT0gXCJbXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYGdoIHJldHVybmVkIG91dHB1dCB0aGF0IGlzIG5vdCBhIEpTT04gYXJyYXkgcGFnZSBhdCBvZmZzZXQgJHtpbmRleH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBwYWdlID0gc2NhblBhZ2UocmF3LCBpbmRleCk7XG4gICAgZWxlbWVudHMucHVzaCguLi5wYWdlLmVsZW1lbnRzKTtcbiAgICBpbmRleCA9IHBhZ2UuZW5kSW5kZXg7XG4gIH1cblxuICByZXR1cm4gZWxlbWVudHM7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7O0NBV0MsR0FFRCxzRUFBc0UsR0FRdEUsMkVBQTJFLEdBQzNFLFNBQVMsU0FBUyxHQUFXLEVBQUUsVUFBa0I7RUFDL0MsSUFBSSxRQUFRO0VBQ1osSUFBSSxXQUFXO0VBQ2YsSUFBSSxVQUFVO0VBQ2QsSUFBSSxRQUFRO0VBRVosTUFBTyxRQUFRLElBQUksTUFBTSxFQUFFLFFBQVM7SUFDbEMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxNQUFNO0lBRXJCLElBQUksVUFBVTtNQUNaLElBQUksU0FBUztRQUNYLFVBQVU7TUFDWixPQUFPLElBQUksT0FBTyxNQUFNO1FBQ3RCLFVBQVU7TUFDWixPQUFPLElBQUksT0FBTyxLQUFLO1FBQ3JCLFdBQVc7TUFDYjtNQUNBO0lBQ0Y7SUFFQSxJQUFJLE9BQU8sS0FBSztNQUNkLFdBQVc7SUFDYixPQUFPLElBQUksT0FBTyxPQUFPLE9BQU8sS0FBSztNQUNuQztJQUNGLE9BQU8sSUFBSSxPQUFPLE9BQU8sT0FBTyxLQUFLO01BQ25DO0lBQ0Y7SUFFQSxJQUFJLFVBQVUsR0FBRztNQUNmO01BQ0E7SUFDRjtFQUNGO0VBRUEsSUFBSSxVQUFVLEtBQUssVUFBVTtJQUMzQixNQUFNLElBQUksTUFDUixDQUFDLGlEQUFpRCxFQUFFLFlBQVk7RUFFcEU7RUFFQSxNQUFNLFdBQVcsSUFBSSxLQUFLLENBQUMsWUFBWTtFQUN2QyxJQUFJO0VBQ0osSUFBSTtJQUNGLFNBQVMsS0FBSyxLQUFLLENBQUM7RUFDdEIsRUFBRSxPQUFPLEtBQUs7SUFDWixNQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU87SUFDNUQsTUFBTSxJQUFJLE1BQU0sQ0FBQyx5Q0FBeUMsRUFBRSxTQUFTO0VBQ3ZFO0VBRUEsSUFBSSxDQUFDLE1BQU0sT0FBTyxDQUFDLFNBQVM7SUFDMUIsTUFBTSxJQUFJLE1BQ1IsQ0FBQywyREFBMkQsRUFBRSxZQUFZO0VBRTlFO0VBRUEsT0FBTztJQUFFLFVBQVU7SUFBTyxVQUFVO0VBQU87QUFDN0M7QUFFQTs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLFNBQVMsb0JBQW9CLEdBQVc7RUFDN0MsTUFBTSxXQUFzQixFQUFFO0VBQzlCLElBQUksUUFBUTtFQUVaLE1BQU8sUUFBUSxJQUFJLE1BQU0sQ0FBRTtJQUN6QixNQUFNLEtBQUssR0FBRyxDQUFDLE1BQU07SUFDckIsSUFBSSxPQUFPLE9BQU8sT0FBTyxRQUFRLE9BQU8sUUFBUSxPQUFPLE1BQU07TUFDM0Q7TUFDQTtJQUNGO0lBQ0EsSUFBSSxPQUFPLEtBQUs7TUFDZCxNQUFNLElBQUksTUFDUixDQUFDLDJEQUEyRCxFQUFFLE9BQU87SUFFekU7SUFFQSxNQUFNLE9BQU8sU0FBUyxLQUFLO0lBQzNCLFNBQVMsSUFBSSxJQUFJLEtBQUssUUFBUTtJQUM5QixRQUFRLEtBQUssUUFBUTtFQUN2QjtFQUVBLE9BQU87QUFDVCJ9
// denoCacheMetadata=3802441771905711656,13383345492408149828