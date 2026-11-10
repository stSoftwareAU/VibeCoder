// Ported and adapted from js-yaml-js-types v1.0.0:
// https://github.com/nodeca/js-yaml-js-types/tree/ac537e7bbdd3c2cbbd9882ca3919c520c2dc022b
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2026 the Deno authors. MIT license.
const REGEXP = /^\/(?<regexp>[\s\S]+)\/(?<modifiers>[gismuy]*)$/;
export const regexp = {
  tag: "tag:yaml.org,2002:js/regexp",
  kind: "scalar",
  resolve (data) {
    if (data === null || !data.length) return false;
    if (data.charAt(0) === "/") {
      // Ensure regex is properly terminated
      const groups = data.match(REGEXP)?.groups;
      if (!groups) return false;
      // Check no duplicate modifiers
      const modifiers = groups.modifiers ?? "";
      if (new Set(modifiers).size < modifiers.length) return false;
    }
    return true;
  },
  construct (data) {
    const { regexp = data, modifiers = "" } = data.match(REGEXP)?.groups ?? {};
    return new RegExp(regexp, modifiers);
  },
  predicate: (object)=>object instanceof RegExp,
  represent: (object)=>object.toString()
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQveWFtbC8xLjAuMTIvX3R5cGUvcmVnZXhwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFBvcnRlZCBhbmQgYWRhcHRlZCBmcm9tIGpzLXlhbWwtanMtdHlwZXMgdjEuMC4wOlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL25vZGVjYS9qcy15YW1sLWpzLXR5cGVzL3RyZWUvYWM1MzdlN2JiZGQzYzJjYmJkOTg4MmNhMzkxOWM1MjBjMmRjMDIyYlxuLy8gQ29weXJpZ2h0IDIwMTEtMjAxNSBieSBWaXRhbHkgUHV6cmluLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG5cbmltcG9ydCB0eXBlIHsgVHlwZSB9IGZyb20gXCIuLi9fdHlwZS50c1wiO1xuXG5jb25zdCBSRUdFWFAgPSAvXlxcLyg/PHJlZ2V4cD5bXFxzXFxTXSspXFwvKD88bW9kaWZpZXJzPltnaXNtdXldKikkLztcblxuZXhwb3J0IGNvbnN0IHJlZ2V4cDogVHlwZTxcInNjYWxhclwiLCBSZWdFeHA+ID0ge1xuICB0YWc6IFwidGFnOnlhbWwub3JnLDIwMDI6anMvcmVnZXhwXCIsXG4gIGtpbmQ6IFwic2NhbGFyXCIsXG4gIHJlc29sdmUoZGF0YTogc3RyaW5nIHwgbnVsbCk6IGJvb2xlYW4ge1xuICAgIGlmIChkYXRhID09PSBudWxsIHx8ICFkYXRhLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgaWYgKGRhdGEuY2hhckF0KDApID09PSBcIi9cIikge1xuICAgICAgLy8gRW5zdXJlIHJlZ2V4IGlzIHByb3Blcmx5IHRlcm1pbmF0ZWRcbiAgICAgIGNvbnN0IGdyb3VwcyA9IGRhdGEubWF0Y2goUkVHRVhQKT8uZ3JvdXBzO1xuICAgICAgaWYgKCFncm91cHMpIHJldHVybiBmYWxzZTtcbiAgICAgIC8vIENoZWNrIG5vIGR1cGxpY2F0ZSBtb2RpZmllcnNcbiAgICAgIGNvbnN0IG1vZGlmaWVycyA9IGdyb3Vwcy5tb2RpZmllcnMgPz8gXCJcIjtcbiAgICAgIGlmIChuZXcgU2V0KG1vZGlmaWVycykuc2l6ZSA8IG1vZGlmaWVycy5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcbiAgY29uc3RydWN0KGRhdGE6IHN0cmluZyk6IFJlZ0V4cCB7XG4gICAgY29uc3QgeyByZWdleHAgPSBkYXRhLCBtb2RpZmllcnMgPSBcIlwiIH0gPSBkYXRhLm1hdGNoKFJFR0VYUCk/Lmdyb3VwcyA/PyB7fTtcbiAgICByZXR1cm4gbmV3IFJlZ0V4cChyZWdleHAsIG1vZGlmaWVycyk7XG4gIH0sXG4gIHByZWRpY2F0ZTogKG9iamVjdDogdW5rbm93bik6IG9iamVjdCBpcyBSZWdFeHAgPT4gb2JqZWN0IGluc3RhbmNlb2YgUmVnRXhwLFxuICByZXByZXNlbnQ6IChvYmplY3Q6IFJlZ0V4cCk6IHN0cmluZyA9PiBvYmplY3QudG9TdHJpbmcoKSxcbn07XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsbURBQW1EO0FBQ25ELDJGQUEyRjtBQUMzRiwwRUFBMEU7QUFDMUUscURBQXFEO0FBSXJELE1BQU0sU0FBUztBQUVmLE9BQU8sTUFBTSxTQUFpQztFQUM1QyxLQUFLO0VBQ0wsTUFBTTtFQUNOLFNBQVEsSUFBbUI7SUFDekIsSUFBSSxTQUFTLFFBQVEsQ0FBQyxLQUFLLE1BQU0sRUFBRSxPQUFPO0lBRTFDLElBQUksS0FBSyxNQUFNLENBQUMsT0FBTyxLQUFLO01BQzFCLHNDQUFzQztNQUN0QyxNQUFNLFNBQVMsS0FBSyxLQUFLLENBQUMsU0FBUztNQUNuQyxJQUFJLENBQUMsUUFBUSxPQUFPO01BQ3BCLCtCQUErQjtNQUMvQixNQUFNLFlBQVksT0FBTyxTQUFTLElBQUk7TUFDdEMsSUFBSSxJQUFJLElBQUksV0FBVyxJQUFJLEdBQUcsVUFBVSxNQUFNLEVBQUUsT0FBTztJQUN6RDtJQUVBLE9BQU87RUFDVDtFQUNBLFdBQVUsSUFBWTtJQUNwQixNQUFNLEVBQUUsU0FBUyxJQUFJLEVBQUUsWUFBWSxFQUFFLEVBQUUsR0FBRyxLQUFLLEtBQUssQ0FBQyxTQUFTLFVBQVUsQ0FBQztJQUN6RSxPQUFPLElBQUksT0FBTyxRQUFRO0VBQzVCO0VBQ0EsV0FBVyxDQUFDLFNBQXNDLGtCQUFrQjtFQUNwRSxXQUFXLENBQUMsU0FBMkIsT0FBTyxRQUFRO0FBQ3hELEVBQUUifQ==
// denoCacheMetadata=2758050148325371900,13027072820837673813