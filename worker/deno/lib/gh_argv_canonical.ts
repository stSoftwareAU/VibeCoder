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
 */

import {
  GH_VALUE_TAKING_LONG_FLAGS,
  GH_VALUE_TAKING_SHORTHANDS,
  shorthandTakesNextToken,
} from "./gh_argv.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * The only host a `gh api` endpoint may name and still be classified from its
 * path (Issue #1420). See `endpointPath` in `audit_mutation_classifier.ts`,
 * which re-exports this constant.
 */
export const GITHUB_API_HOST = "api.github.com";

/** Flags that give `gh api` a request body, making POST its default method. */
const BODY_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
]);

/** Flags that set the request method. */
const METHOD_FLAGS: ReadonlySet<string> = new Set(["-X", "--method"]);

/**
 * The pull and issue update routes, where GitHub serves POST with the same
 * handler as PATCH (Issue #3531).
 */
const UPDATE_ROUTE = /^repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+$/;

/** A flag of the argv: its name, its value when it takes one, its tokens. */
interface ParsedFlag {
  name: string;
  value?: string;
  /** The flag rendered in separated form. */
  tokens: string[];
}

/** Split a normalised argv into its flags and its positionals. */
function parseArgv(args: readonly string[]): {
  flags: ParsedFlag[];
  positionals: string[];
} {
  const flags: ParsedFlag[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
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
          ...(value !== undefined ? { value } : {}),
          tokens: value !== undefined ? [name, value] : [name],
        });
      } else {
        flags.push({ name: token, tokens: [token] });
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (token.length === 2 && GH_VALUE_TAKING_SHORTHANDS.has(token[1]!)) {
        const value = args[++i];
        flags.push({
          name: token,
          ...(value !== undefined ? { value } : {}),
          tokens: value !== undefined ? [token, value] : [token],
        });
      } else if (shorthandTakesNextToken(token)) {
        // A boolean shorthand group ending in a value letter whose value is
        // the next token (`-iq .id`): kept whole, value and all.
        const value = args[++i];
        flags.push({
          name: token,
          tokens: value !== undefined ? [token, value] : [token],
        });
      } else {
        flags.push({ name: token, tokens: [token] });
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

/**
 * Decode percent-escapes the way GitHub's router does, except `%2F` (an
 * encoded `/`, which must not create a new path segment) and `%25` (an
 * encoded `%`, which must not create a new escape), so decoding is idempotent.
 */
function decodePath(path: string): string {
  return path.split(/(%2[fF]|%25)/).map((part, i) => {
    if (i % 2 === 1) return part.toUpperCase();
    try {
      return decodeURIComponent(part);
    } catch {
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
 */
export function canonicaliseGhEndpoint(endpoint: string): string {
  let path = endpoint;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return endpoint;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return endpoint;
    if (url.hostname.toLowerCase() !== GITHUB_API_HOST) return endpoint;
    // The path from the original text, not `URL.pathname`, which would
    // percent-encode the braces of the `{owner}/{repo}` placeholder form.
    const afterScheme = path.slice(path.indexOf("://") + 3);
    const slash = afterScheme.search(/[/?#]/);
    path = slash < 0 || afterScheme[slash] !== "/"
      ? ""
      : afterScheme.slice(slash + 1);
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  path = decodePath(path).replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (path.toLowerCase() === "graphql") return "graphql";
  // GitHub reads the pull or issue number from the segment's leading digits.
  return path.replace(
    /^(repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/)(\d+)[^/\d][^/]*/,
    "$1$2",
  );
}

/**
 * Rewrite a `gh` argument vector into its canonical form (Issue #3568).
 *
 * A `gh api` call becomes `["api", <endpoint>, "-X", <METHOD>, ...flags]`;
 * every other vector is returned as {@link normaliseGhArgs} leaves it.
 *
 * @param rawArgs - Arguments as they would be passed to the `gh` binary.
 * @returns The canonical, equivalent argument vector.
 */
export function canonicaliseGhArgs(rawArgs: readonly string[]): string[] {
  const args = normaliseGhArgs(rawArgs);
  const { flags, positionals } = parseArgv(args);
  if (positionals[0] !== "api") return args;

  let method: string | undefined;
  let hasBody = false;
  const kept: string[] = [];
  for (const flag of flags) {
    if (METHOD_FLAGS.has(flag.name)) {
      // pflag: a repeated string flag resolves to its last occurrence; a
      // method flag with no value leaves gh with nothing to send.
      method = flag.value ?? "";
      continue;
    }
    if (BODY_FLAGS.has(flag.name)) hasBody = true;
    kept.push(...flag.tokens);
  }

  const endpoint = positionals[1] === undefined
    ? undefined
    : canonicaliseGhEndpoint(positionals[1]);
  let effective = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if (
    effective === "POST" && endpoint !== undefined &&
    UPDATE_ROUTE.test(endpoint)
  ) {
    effective = "PATCH";
  }

  return [
    "api",
    ...(endpoint !== undefined ? [endpoint] : []),
    ...positionals.slice(2),
    "-X",
    effective,
    ...kept,
  ];
}
