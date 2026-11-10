/**
 * Canonical form of a `gh api` argument vector (Issue #3568).
 *
 * The agent gh guard and the audit classifier decide from argv text, but `gh`
 * and GitHub accept many spellings of the same request. Each guard fix used to
 * recognise the one spelling its issue named, and review then found the next
 * (#3518, #3531, #3540, #3561, #3572, #3600). This module removes the spelling
 * question once, before anything classifies: it rewrites a `gh api` call into
 * the single form gh and GitHub would treat it as, so every downstream rule
 * sees one spelling of each request.
 *
 * What the canonical form fixes, and where each comes from:
 *
 * - **Flag placement.** cobra parses a subcommand's flags before the
 *   subcommand name as well as after it (`gh --method=DELETE api …`, #3572).
 *   Every flag is moved after `api`, keeping its relative order so pflag's
 *   last-occurrence rule still picks the same value.
 * - **Flag spelling.** `--flag=value` becomes `--flag value`; pflag shorthand
 *   groups are expanded by {@link normaliseGhArgs} first. Which flags take a
 *   value comes from the one shared table in `gh_argv.ts`, so a flag value
 *   (`-p squirrel-girl`, `--hostname h`) is never read as the endpoint
 *   (#3540, #3561).
 * - **Method.** The effective method is made explicit: the last
 *   `-X`/`--method`, else POST when a body is given (gh's default), else GET.
 *   GitHub routes POST on the pull and issue update routes to the same handler
 *   as PATCH (#3531), so there it is written as PATCH.
 * - **Endpoint.** Resolved the way GitHub resolves the path: the
 *   `https://api.github.com` origin is dropped (any other origin is left as
 *   written, so it stays unclassifiable and fails closed), the `?query` and
 *   `#fragment` are dropped (#3518), percent-escapes are decoded except `%2F`
 *   and `%25`, repeated slashes collapse, and the pull or issue number
 *   segment is cut to its leading digits (#3600).
 *
 * The canonical form is idempotent — canonicalising it again changes nothing
 * — because the guard canonicalises once and the classifier it calls does so
 * again. A vector whose root is not `api` is returned as
 * {@link normaliseGhArgs} leaves it: those subcommands take subcommand-specific
 * value flags this table does not list, so reordering them would misplace
 * values.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { GH_VALUE_TAKING_LONG_FLAGS, GH_VALUE_TAKING_SHORTHANDS, shorthandTakesNextToken } from "./gh_argv.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * The only host a `gh api` endpoint may name and still be classified from its
 * path (Issue #1420). See `endpointPath` in `audit_mutation_classifier.ts`,
 * which re-exports this constant.
 */ export const GITHUB_API_HOST = "api.github.com";
/** Flags that give `gh api` a request body, making POST its default method. */ const BODY_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input"
]);
/** Flags that set the request method. */ const METHOD_FLAGS = new Set([
  "-X",
  "--method"
]);
/**
 * The pull and issue update routes, where GitHub serves POST with the same
 * handler as PATCH (Issue #3531).
 */ const UPDATE_ROUTE = /^repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+$/;
/** Split a normalised argv into its flags and its positionals. */ function parseArgv(args) {
  const flags = [];
  const positionals = [];
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token : token.slice(0, eq);
      if (GH_VALUE_TAKING_LONG_FLAGS.has(name)) {
        const value = eq < 0 ? args[++i] : token.slice(eq + 1);
        flags.push({
          name,
          ...value !== undefined ? {
            value
          } : {},
          tokens: value !== undefined ? [
            name,
            value
          ] : [
            name
          ]
        });
      } else {
        flags.push({
          name: token,
          tokens: [
            token
          ]
        });
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (token.length === 2 && GH_VALUE_TAKING_SHORTHANDS.has(token[1])) {
        const value = args[++i];
        flags.push({
          name: token,
          ...value !== undefined ? {
            value
          } : {},
          tokens: value !== undefined ? [
            token,
            value
          ] : [
            token
          ]
        });
      } else if (shorthandTakesNextToken(token)) {
        // A boolean shorthand group ending in a value letter whose value is
        // the next token (`-iq .id`): kept whole, value and all.
        const value = args[++i];
        flags.push({
          name: token,
          tokens: value !== undefined ? [
            token,
            value
          ] : [
            token
          ]
        });
      } else {
        flags.push({
          name: token,
          tokens: [
            token
          ]
        });
      }
      continue;
    }
    positionals.push(token);
  }
  return {
    flags,
    positionals
  };
}
/**
 * Decode percent-escapes the way GitHub's router does, except `%2F` (an
 * encoded `/`, which must not create a new path segment) and `%25` (an
 * encoded `%`, which must not create a new escape), so decoding is idempotent.
 */ function decodePath(path) {
  return path.split(/(%2[fF]|%25)/).map((part, i)=>{
    if (i % 2 === 1) return part.toUpperCase();
    try {
      return decodeURIComponent(part);
    } catch  {
      // A malformed escape is left as written; GitHub rejects it, so it
      // reaches no resource either.
      return part;
    }
  }).join("");
}
/**
 * The canonical spelling of a `gh api` endpoint (Issue #3568).
 *
 * @param endpoint - The endpoint argument as written.
 * @returns The path GitHub would route, without origin, query, fragment or
 *   surrounding slashes; an absolute URL on any host other than
 *   {@link GITHUB_API_HOST} is returned unchanged so it stays unclassifiable.
 */ export function canonicaliseGhEndpoint(endpoint) {
  let path = endpoint;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    let url;
    try {
      url = new URL(path);
    } catch  {
      return endpoint;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return endpoint;
    if (url.hostname.toLowerCase() !== GITHUB_API_HOST) return endpoint;
    // The path from the original text, not `URL.pathname`, which would
    // percent-encode the braces of the `{owner}/{repo}` placeholder form.
    const afterScheme = path.slice(path.indexOf("://") + 3);
    const slash = afterScheme.search(/[/?#]/);
    path = slash < 0 || afterScheme[slash] !== "/" ? "" : afterScheme.slice(slash + 1);
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  path = decodePath(path).replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (path.toLowerCase() === "graphql") return "graphql";
  // GitHub reads the pull or issue number from the segment's leading digits.
  return path.replace(/^(repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/)(\d+)[^/\d][^/]*/, "$1$2");
}
/**
 * Rewrite a `gh` argument vector into its canonical form (Issue #3568).
 *
 * A `gh api` call becomes `["api", <endpoint>, "-X", <METHOD>, ...flags]`;
 * every other vector is returned as {@link normaliseGhArgs} leaves it.
 *
 * @param rawArgs - Arguments as they would be passed to the `gh` binary.
 * @returns The canonical, equivalent argument vector.
 */ export function canonicaliseGhArgs(rawArgs) {
  const args = normaliseGhArgs(rawArgs);
  const { flags, positionals } = parseArgv(args);
  if (positionals[0] !== "api") return args;
  let method;
  let hasBody = false;
  const kept = [];
  for (const flag of flags){
    if (METHOD_FLAGS.has(flag.name)) {
      // pflag: a repeated string flag resolves to its last occurrence; a
      // method flag with no value leaves gh with nothing to send.
      method = flag.value ?? "";
      continue;
    }
    if (BODY_FLAGS.has(flag.name)) hasBody = true;
    kept.push(...flag.tokens);
  }
  const endpoint = positionals[1] === undefined ? undefined : canonicaliseGhEndpoint(positionals[1]);
  let effective = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if (effective === "POST" && endpoint !== undefined && UPDATE_ROUTE.test(endpoint)) {
    effective = "PATCH";
  }
  return [
    "api",
    ...endpoint !== undefined ? [
      endpoint
    ] : [],
    ...positionals.slice(2),
    "-X",
    effective,
    ...kept
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9hcmd2X2Nhbm9uaWNhbC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENhbm9uaWNhbCBmb3JtIG9mIGEgYGdoIGFwaWAgYXJndW1lbnQgdmVjdG9yIChJc3N1ZSAjMzU2OCkuXG4gKlxuICogVGhlIGFnZW50IGdoIGd1YXJkIGFuZCB0aGUgYXVkaXQgY2xhc3NpZmllciBkZWNpZGUgZnJvbSBhcmd2IHRleHQsIGJ1dCBgZ2hgXG4gKiBhbmQgR2l0SHViIGFjY2VwdCBtYW55IHNwZWxsaW5ncyBvZiB0aGUgc2FtZSByZXF1ZXN0LiBFYWNoIGd1YXJkIGZpeCB1c2VkIHRvXG4gKiByZWNvZ25pc2UgdGhlIG9uZSBzcGVsbGluZyBpdHMgaXNzdWUgbmFtZWQsIGFuZCByZXZpZXcgdGhlbiBmb3VuZCB0aGUgbmV4dFxuICogKCMzNTE4LCAjMzUzMSwgIzM1NDAsICMzNTYxLCAjMzU3MiwgIzM2MDApLiBUaGlzIG1vZHVsZSByZW1vdmVzIHRoZSBzcGVsbGluZ1xuICogcXVlc3Rpb24gb25jZSwgYmVmb3JlIGFueXRoaW5nIGNsYXNzaWZpZXM6IGl0IHJld3JpdGVzIGEgYGdoIGFwaWAgY2FsbCBpbnRvXG4gKiB0aGUgc2luZ2xlIGZvcm0gZ2ggYW5kIEdpdEh1YiB3b3VsZCB0cmVhdCBpdCBhcywgc28gZXZlcnkgZG93bnN0cmVhbSBydWxlXG4gKiBzZWVzIG9uZSBzcGVsbGluZyBvZiBlYWNoIHJlcXVlc3QuXG4gKlxuICogV2hhdCB0aGUgY2Fub25pY2FsIGZvcm0gZml4ZXMsIGFuZCB3aGVyZSBlYWNoIGNvbWVzIGZyb206XG4gKlxuICogLSAqKkZsYWcgcGxhY2VtZW50LioqIGNvYnJhIHBhcnNlcyBhIHN1YmNvbW1hbmQncyBmbGFncyBiZWZvcmUgdGhlXG4gKiAgIHN1YmNvbW1hbmQgbmFtZSBhcyB3ZWxsIGFzIGFmdGVyIGl0IChgZ2ggLS1tZXRob2Q9REVMRVRFIGFwaSDigKZgLCAjMzU3MikuXG4gKiAgIEV2ZXJ5IGZsYWcgaXMgbW92ZWQgYWZ0ZXIgYGFwaWAsIGtlZXBpbmcgaXRzIHJlbGF0aXZlIG9yZGVyIHNvIHBmbGFnJ3NcbiAqICAgbGFzdC1vY2N1cnJlbmNlIHJ1bGUgc3RpbGwgcGlja3MgdGhlIHNhbWUgdmFsdWUuXG4gKiAtICoqRmxhZyBzcGVsbGluZy4qKiBgLS1mbGFnPXZhbHVlYCBiZWNvbWVzIGAtLWZsYWcgdmFsdWVgOyBwZmxhZyBzaG9ydGhhbmRcbiAqICAgZ3JvdXBzIGFyZSBleHBhbmRlZCBieSB7QGxpbmsgbm9ybWFsaXNlR2hBcmdzfSBmaXJzdC4gV2hpY2ggZmxhZ3MgdGFrZSBhXG4gKiAgIHZhbHVlIGNvbWVzIGZyb20gdGhlIG9uZSBzaGFyZWQgdGFibGUgaW4gYGdoX2FyZ3YudHNgLCBzbyBhIGZsYWcgdmFsdWVcbiAqICAgKGAtcCBzcXVpcnJlbC1naXJsYCwgYC0taG9zdG5hbWUgaGApIGlzIG5ldmVyIHJlYWQgYXMgdGhlIGVuZHBvaW50XG4gKiAgICgjMzU0MCwgIzM1NjEpLlxuICogLSAqKk1ldGhvZC4qKiBUaGUgZWZmZWN0aXZlIG1ldGhvZCBpcyBtYWRlIGV4cGxpY2l0OiB0aGUgbGFzdFxuICogICBgLVhgL2AtLW1ldGhvZGAsIGVsc2UgUE9TVCB3aGVuIGEgYm9keSBpcyBnaXZlbiAoZ2gncyBkZWZhdWx0KSwgZWxzZSBHRVQuXG4gKiAgIEdpdEh1YiByb3V0ZXMgUE9TVCBvbiB0aGUgcHVsbCBhbmQgaXNzdWUgdXBkYXRlIHJvdXRlcyB0byB0aGUgc2FtZSBoYW5kbGVyXG4gKiAgIGFzIFBBVENIICgjMzUzMSksIHNvIHRoZXJlIGl0IGlzIHdyaXR0ZW4gYXMgUEFUQ0guXG4gKiAtICoqRW5kcG9pbnQuKiogUmVzb2x2ZWQgdGhlIHdheSBHaXRIdWIgcmVzb2x2ZXMgdGhlIHBhdGg6IHRoZVxuICogICBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbWAgb3JpZ2luIGlzIGRyb3BwZWQgKGFueSBvdGhlciBvcmlnaW4gaXMgbGVmdCBhc1xuICogICB3cml0dGVuLCBzbyBpdCBzdGF5cyB1bmNsYXNzaWZpYWJsZSBhbmQgZmFpbHMgY2xvc2VkKSwgdGhlIGA/cXVlcnlgIGFuZFxuICogICBgI2ZyYWdtZW50YCBhcmUgZHJvcHBlZCAoIzM1MTgpLCBwZXJjZW50LWVzY2FwZXMgYXJlIGRlY29kZWQgZXhjZXB0IGAlMkZgXG4gKiAgIGFuZCBgJTI1YCwgcmVwZWF0ZWQgc2xhc2hlcyBjb2xsYXBzZSwgYW5kIHRoZSBwdWxsIG9yIGlzc3VlIG51bWJlclxuICogICBzZWdtZW50IGlzIGN1dCB0byBpdHMgbGVhZGluZyBkaWdpdHMgKCMzNjAwKS5cbiAqXG4gKiBUaGUgY2Fub25pY2FsIGZvcm0gaXMgaWRlbXBvdGVudCDigJQgY2Fub25pY2FsaXNpbmcgaXQgYWdhaW4gY2hhbmdlcyBub3RoaW5nXG4gKiDigJQgYmVjYXVzZSB0aGUgZ3VhcmQgY2Fub25pY2FsaXNlcyBvbmNlIGFuZCB0aGUgY2xhc3NpZmllciBpdCBjYWxscyBkb2VzIHNvXG4gKiBhZ2Fpbi4gQSB2ZWN0b3Igd2hvc2Ugcm9vdCBpcyBub3QgYGFwaWAgaXMgcmV0dXJuZWQgYXNcbiAqIHtAbGluayBub3JtYWxpc2VHaEFyZ3N9IGxlYXZlcyBpdDogdGhvc2Ugc3ViY29tbWFuZHMgdGFrZSBzdWJjb21tYW5kLXNwZWNpZmljXG4gKiB2YWx1ZSBmbGFncyB0aGlzIHRhYmxlIGRvZXMgbm90IGxpc3QsIHNvIHJlb3JkZXJpbmcgdGhlbSB3b3VsZCBtaXNwbGFjZVxuICogdmFsdWVzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIEdIX1ZBTFVFX1RBS0lOR19MT05HX0ZMQUdTLFxuICBHSF9WQUxVRV9UQUtJTkdfU0hPUlRIQU5EUyxcbiAgc2hvcnRoYW5kVGFrZXNOZXh0VG9rZW4sXG59IGZyb20gXCIuL2doX2FyZ3YudHNcIjtcbmltcG9ydCB7IG5vcm1hbGlzZUdoQXJncyB9IGZyb20gXCIuL2doX2ZsYWdfcGFyc2VyLnRzXCI7XG5cbi8qKlxuICogVGhlIG9ubHkgaG9zdCBhIGBnaCBhcGlgIGVuZHBvaW50IG1heSBuYW1lIGFuZCBzdGlsbCBiZSBjbGFzc2lmaWVkIGZyb20gaXRzXG4gKiBwYXRoIChJc3N1ZSAjMTQyMCkuIFNlZSBgZW5kcG9pbnRQYXRoYCBpbiBgYXVkaXRfbXV0YXRpb25fY2xhc3NpZmllci50c2AsXG4gKiB3aGljaCByZS1leHBvcnRzIHRoaXMgY29uc3RhbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBHSVRIVUJfQVBJX0hPU1QgPSBcImFwaS5naXRodWIuY29tXCI7XG5cbi8qKiBGbGFncyB0aGF0IGdpdmUgYGdoIGFwaWAgYSByZXF1ZXN0IGJvZHksIG1ha2luZyBQT1NUIGl0cyBkZWZhdWx0IG1ldGhvZC4gKi9cbmNvbnN0IEJPRFlfRkxBR1M6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCItZlwiLFxuICBcIi1GXCIsXG4gIFwiLS1maWVsZFwiLFxuICBcIi0tcmF3LWZpZWxkXCIsXG4gIFwiLS1pbnB1dFwiLFxuXSk7XG5cbi8qKiBGbGFncyB0aGF0IHNldCB0aGUgcmVxdWVzdCBtZXRob2QuICovXG5jb25zdCBNRVRIT0RfRkxBR1M6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcIi1YXCIsIFwiLS1tZXRob2RcIl0pO1xuXG4vKipcbiAqIFRoZSBwdWxsIGFuZCBpc3N1ZSB1cGRhdGUgcm91dGVzLCB3aGVyZSBHaXRIdWIgc2VydmVzIFBPU1Qgd2l0aCB0aGUgc2FtZVxuICogaGFuZGxlciBhcyBQQVRDSCAoSXNzdWUgIzM1MzEpLlxuICovXG5jb25zdCBVUERBVEVfUk9VVEUgPSAvXnJlcG9zXFwvW14vXStcXC9bXi9dK1xcLyg/OnB1bGxzfGlzc3VlcylcXC9cXGQrJC87XG5cbi8qKiBBIGZsYWcgb2YgdGhlIGFyZ3Y6IGl0cyBuYW1lLCBpdHMgdmFsdWUgd2hlbiBpdCB0YWtlcyBvbmUsIGl0cyB0b2tlbnMuICovXG5pbnRlcmZhY2UgUGFyc2VkRmxhZyB7XG4gIG5hbWU6IHN0cmluZztcbiAgdmFsdWU/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZmxhZyByZW5kZXJlZCBpbiBzZXBhcmF0ZWQgZm9ybS4gKi9cbiAgdG9rZW5zOiBzdHJpbmdbXTtcbn1cblxuLyoqIFNwbGl0IGEgbm9ybWFsaXNlZCBhcmd2IGludG8gaXRzIGZsYWdzIGFuZCBpdHMgcG9zaXRpb25hbHMuICovXG5mdW5jdGlvbiBwYXJzZUFyZ3YoYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiB7XG4gIGZsYWdzOiBQYXJzZWRGbGFnW107XG4gIHBvc2l0aW9uYWxzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBmbGFnczogUGFyc2VkRmxhZ1tdID0gW107XG4gIGNvbnN0IHBvc2l0aW9uYWxzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IGFyZ3NbaV0hO1xuICAgIGlmICh0b2tlbiA9PT0gXCItLVwiKSB7XG4gICAgICBwb3NpdGlvbmFscy5wdXNoKC4uLmFyZ3Muc2xpY2UoaSArIDEpKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBjb25zdCBlcSA9IHRva2VuLmluZGV4T2YoXCI9XCIpO1xuICAgICAgY29uc3QgbmFtZSA9IGVxIDwgMCA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgZXEpO1xuICAgICAgaWYgKEdIX1ZBTFVFX1RBS0lOR19MT05HX0ZMQUdTLmhhcyhuYW1lKSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGVxIDwgMCA/IGFyZ3NbKytpXSA6IHRva2VuLnNsaWNlKGVxICsgMSk7XG4gICAgICAgIGZsYWdzLnB1c2goe1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgLi4uKHZhbHVlICE9PSB1bmRlZmluZWQgPyB7IHZhbHVlIH0gOiB7fSksXG4gICAgICAgICAgdG9rZW5zOiB2YWx1ZSAhPT0gdW5kZWZpbmVkID8gW25hbWUsIHZhbHVlXSA6IFtuYW1lXSxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmbGFncy5wdXNoKHsgbmFtZTogdG9rZW4sIHRva2VuczogW3Rva2VuXSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi1cIikgJiYgdG9rZW4gIT09IFwiLVwiKSB7XG4gICAgICBpZiAodG9rZW4ubGVuZ3RoID09PSAyICYmIEdIX1ZBTFVFX1RBS0lOR19TSE9SVEhBTkRTLmhhcyh0b2tlblsxXSEpKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gYXJnc1srK2ldO1xuICAgICAgICBmbGFncy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiB0b2tlbixcbiAgICAgICAgICAuLi4odmFsdWUgIT09IHVuZGVmaW5lZCA/IHsgdmFsdWUgfSA6IHt9KSxcbiAgICAgICAgICB0b2tlbnM6IHZhbHVlICE9PSB1bmRlZmluZWQgPyBbdG9rZW4sIHZhbHVlXSA6IFt0b2tlbl0sXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChzaG9ydGhhbmRUYWtlc05leHRUb2tlbih0b2tlbikpIHtcbiAgICAgICAgLy8gQSBib29sZWFuIHNob3J0aGFuZCBncm91cCBlbmRpbmcgaW4gYSB2YWx1ZSBsZXR0ZXIgd2hvc2UgdmFsdWUgaXNcbiAgICAgICAgLy8gdGhlIG5leHQgdG9rZW4gKGAtaXEgLmlkYCk6IGtlcHQgd2hvbGUsIHZhbHVlIGFuZCBhbGwuXG4gICAgICAgIGNvbnN0IHZhbHVlID0gYXJnc1srK2ldO1xuICAgICAgICBmbGFncy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiB0b2tlbixcbiAgICAgICAgICB0b2tlbnM6IHZhbHVlICE9PSB1bmRlZmluZWQgPyBbdG9rZW4sIHZhbHVlXSA6IFt0b2tlbl0sXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZmxhZ3MucHVzaCh7IG5hbWU6IHRva2VuLCB0b2tlbnM6IFt0b2tlbl0gfSk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcG9zaXRpb25hbHMucHVzaCh0b2tlbik7XG4gIH1cbiAgcmV0dXJuIHsgZmxhZ3MsIHBvc2l0aW9uYWxzIH07XG59XG5cbi8qKlxuICogRGVjb2RlIHBlcmNlbnQtZXNjYXBlcyB0aGUgd2F5IEdpdEh1YidzIHJvdXRlciBkb2VzLCBleGNlcHQgYCUyRmAgKGFuXG4gKiBlbmNvZGVkIGAvYCwgd2hpY2ggbXVzdCBub3QgY3JlYXRlIGEgbmV3IHBhdGggc2VnbWVudCkgYW5kIGAlMjVgIChhblxuICogZW5jb2RlZCBgJWAsIHdoaWNoIG11c3Qgbm90IGNyZWF0ZSBhIG5ldyBlc2NhcGUpLCBzbyBkZWNvZGluZyBpcyBpZGVtcG90ZW50LlxuICovXG5mdW5jdGlvbiBkZWNvZGVQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLnNwbGl0KC8oJTJbZkZdfCUyNSkvKS5tYXAoKHBhcnQsIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBwYXJ0LnRvVXBwZXJDYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQocGFydCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBIG1hbGZvcm1lZCBlc2NhcGUgaXMgbGVmdCBhcyB3cml0dGVuOyBHaXRIdWIgcmVqZWN0cyBpdCwgc28gaXRcbiAgICAgIC8vIHJlYWNoZXMgbm8gcmVzb3VyY2UgZWl0aGVyLlxuICAgICAgcmV0dXJuIHBhcnQ7XG4gICAgfVxuICB9KS5qb2luKFwiXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjYW5vbmljYWwgc3BlbGxpbmcgb2YgYSBgZ2ggYXBpYCBlbmRwb2ludCAoSXNzdWUgIzM1NjgpLlxuICpcbiAqIEBwYXJhbSBlbmRwb2ludCAtIFRoZSBlbmRwb2ludCBhcmd1bWVudCBhcyB3cml0dGVuLlxuICogQHJldHVybnMgVGhlIHBhdGggR2l0SHViIHdvdWxkIHJvdXRlLCB3aXRob3V0IG9yaWdpbiwgcXVlcnksIGZyYWdtZW50IG9yXG4gKiAgIHN1cnJvdW5kaW5nIHNsYXNoZXM7IGFuIGFic29sdXRlIFVSTCBvbiBhbnkgaG9zdCBvdGhlciB0aGFuXG4gKiAgIHtAbGluayBHSVRIVUJfQVBJX0hPU1R9IGlzIHJldHVybmVkIHVuY2hhbmdlZCBzbyBpdCBzdGF5cyB1bmNsYXNzaWZpYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbm9uaWNhbGlzZUdoRW5kcG9pbnQoZW5kcG9pbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBwYXRoID0gZW5kcG9pbnQ7XG4gIGlmICgvXlthLXpdW2EtejAtOSsuLV0qOlxcL1xcLy9pLnRlc3QocGF0aCkpIHtcbiAgICBsZXQgdXJsOiBVUkw7XG4gICAgdHJ5IHtcbiAgICAgIHVybCA9IG5ldyBVUkwocGF0aCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfVxuICAgIGlmICh1cmwucHJvdG9jb2wgIT09IFwiaHR0cHM6XCIgJiYgdXJsLnByb3RvY29sICE9PSBcImh0dHA6XCIpIHJldHVybiBlbmRwb2ludDtcbiAgICBpZiAodXJsLmhvc3RuYW1lLnRvTG93ZXJDYXNlKCkgIT09IEdJVEhVQl9BUElfSE9TVCkgcmV0dXJuIGVuZHBvaW50O1xuICAgIC8vIFRoZSBwYXRoIGZyb20gdGhlIG9yaWdpbmFsIHRleHQsIG5vdCBgVVJMLnBhdGhuYW1lYCwgd2hpY2ggd291bGRcbiAgICAvLyBwZXJjZW50LWVuY29kZSB0aGUgYnJhY2VzIG9mIHRoZSBge293bmVyfS97cmVwb31gIHBsYWNlaG9sZGVyIGZvcm0uXG4gICAgY29uc3QgYWZ0ZXJTY2hlbWUgPSBwYXRoLnNsaWNlKHBhdGguaW5kZXhPZihcIjovL1wiKSArIDMpO1xuICAgIGNvbnN0IHNsYXNoID0gYWZ0ZXJTY2hlbWUuc2VhcmNoKC9bLz8jXS8pO1xuICAgIHBhdGggPSBzbGFzaCA8IDAgfHwgYWZ0ZXJTY2hlbWVbc2xhc2hdICE9PSBcIi9cIlxuICAgICAgPyBcIlwiXG4gICAgICA6IGFmdGVyU2NoZW1lLnNsaWNlKHNsYXNoICsgMSk7XG4gIH1cbiAgY29uc3QgY3V0ID0gcGF0aC5zZWFyY2goL1s/I10vKTtcbiAgaWYgKGN1dCA+PSAwKSBwYXRoID0gcGF0aC5zbGljZSgwLCBjdXQpO1xuICBwYXRoID0gZGVjb2RlUGF0aChwYXRoKS5yZXBsYWNlKC9cXC97Mix9L2csIFwiL1wiKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCBcIlwiKTtcbiAgaWYgKHBhdGgudG9Mb3dlckNhc2UoKSA9PT0gXCJncmFwaHFsXCIpIHJldHVybiBcImdyYXBocWxcIjtcbiAgLy8gR2l0SHViIHJlYWRzIHRoZSBwdWxsIG9yIGlzc3VlIG51bWJlciBmcm9tIHRoZSBzZWdtZW50J3MgbGVhZGluZyBkaWdpdHMuXG4gIHJldHVybiBwYXRoLnJlcGxhY2UoXG4gICAgL14ocmVwb3NcXC9bXi9dK1xcL1teL10rXFwvKD86cHVsbHN8aXNzdWVzKVxcLykoXFxkKylbXi9cXGRdW14vXSovLFxuICAgIFwiJDEkMlwiLFxuICApO1xufVxuXG4vKipcbiAqIFJld3JpdGUgYSBgZ2hgIGFyZ3VtZW50IHZlY3RvciBpbnRvIGl0cyBjYW5vbmljYWwgZm9ybSAoSXNzdWUgIzM1NjgpLlxuICpcbiAqIEEgYGdoIGFwaWAgY2FsbCBiZWNvbWVzIGBbXCJhcGlcIiwgPGVuZHBvaW50PiwgXCItWFwiLCA8TUVUSE9EPiwgLi4uZmxhZ3NdYDtcbiAqIGV2ZXJ5IG90aGVyIHZlY3RvciBpcyByZXR1cm5lZCBhcyB7QGxpbmsgbm9ybWFsaXNlR2hBcmdzfSBsZWF2ZXMgaXQuXG4gKlxuICogQHBhcmFtIHJhd0FyZ3MgLSBBcmd1bWVudHMgYXMgdGhleSB3b3VsZCBiZSBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIGNhbm9uaWNhbCwgZXF1aXZhbGVudCBhcmd1bWVudCB2ZWN0b3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5vbmljYWxpc2VHaEFyZ3MocmF3QXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFyZ3MgPSBub3JtYWxpc2VHaEFyZ3MocmF3QXJncyk7XG4gIGNvbnN0IHsgZmxhZ3MsIHBvc2l0aW9uYWxzIH0gPSBwYXJzZUFyZ3YoYXJncyk7XG4gIGlmIChwb3NpdGlvbmFsc1swXSAhPT0gXCJhcGlcIikgcmV0dXJuIGFyZ3M7XG5cbiAgbGV0IG1ldGhvZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgaGFzQm9keSA9IGZhbHNlO1xuICBjb25zdCBrZXB0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZsYWcgb2YgZmxhZ3MpIHtcbiAgICBpZiAoTUVUSE9EX0ZMQUdTLmhhcyhmbGFnLm5hbWUpKSB7XG4gICAgICAvLyBwZmxhZzogYSByZXBlYXRlZCBzdHJpbmcgZmxhZyByZXNvbHZlcyB0byBpdHMgbGFzdCBvY2N1cnJlbmNlOyBhXG4gICAgICAvLyBtZXRob2QgZmxhZyB3aXRoIG5vIHZhbHVlIGxlYXZlcyBnaCB3aXRoIG5vdGhpbmcgdG8gc2VuZC5cbiAgICAgIG1ldGhvZCA9IGZsYWcudmFsdWUgPz8gXCJcIjtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoQk9EWV9GTEFHUy5oYXMoZmxhZy5uYW1lKSkgaGFzQm9keSA9IHRydWU7XG4gICAga2VwdC5wdXNoKC4uLmZsYWcudG9rZW5zKTtcbiAgfVxuXG4gIGNvbnN0IGVuZHBvaW50ID0gcG9zaXRpb25hbHNbMV0gPT09IHVuZGVmaW5lZFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBjYW5vbmljYWxpc2VHaEVuZHBvaW50KHBvc2l0aW9uYWxzWzFdKTtcbiAgbGV0IGVmZmVjdGl2ZSA9IChtZXRob2QgPz8gKGhhc0JvZHkgPyBcIlBPU1RcIiA6IFwiR0VUXCIpKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAoXG4gICAgZWZmZWN0aXZlID09PSBcIlBPU1RcIiAmJiBlbmRwb2ludCAhPT0gdW5kZWZpbmVkICYmXG4gICAgVVBEQVRFX1JPVVRFLnRlc3QoZW5kcG9pbnQpXG4gICkge1xuICAgIGVmZmVjdGl2ZSA9IFwiUEFUQ0hcIjtcbiAgfVxuXG4gIHJldHVybiBbXG4gICAgXCJhcGlcIixcbiAgICAuLi4oZW5kcG9pbnQgIT09IHVuZGVmaW5lZCA/IFtlbmRwb2ludF0gOiBbXSksXG4gICAgLi4ucG9zaXRpb25hbHMuc2xpY2UoMiksXG4gICAgXCItWFwiLFxuICAgIGVmZmVjdGl2ZSxcbiAgICAuLi5rZXB0LFxuICBdO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXlDQyxHQUVELFNBQ0UsMEJBQTBCLEVBQzFCLDBCQUEwQixFQUMxQix1QkFBdUIsUUFDbEIsZUFBZTtBQUN0QixTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFFdEQ7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSxrQkFBa0IsaUJBQWlCO0FBRWhELDZFQUE2RSxHQUM3RSxNQUFNLGFBQWtDLElBQUksSUFBSTtFQUM5QztFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRCx1Q0FBdUMsR0FDdkMsTUFBTSxlQUFvQyxJQUFJLElBQUk7RUFBQztFQUFNO0NBQVc7QUFFcEU7OztDQUdDLEdBQ0QsTUFBTSxlQUFlO0FBVXJCLGdFQUFnRSxHQUNoRSxTQUFTLFVBQVUsSUFBdUI7RUFJeEMsTUFBTSxRQUFzQixFQUFFO0VBQzlCLE1BQU0sY0FBd0IsRUFBRTtFQUNoQyxJQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSztJQUNwQyxNQUFNLFFBQVEsSUFBSSxDQUFDLEVBQUU7SUFDckIsSUFBSSxVQUFVLE1BQU07TUFDbEIsWUFBWSxJQUFJLElB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
// denoCacheMetadata=1588021660788611630,9434979866256629484