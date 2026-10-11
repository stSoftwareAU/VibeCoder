/**
 * Table-driven conformance for the agent gh guard (Issue #3568).
 *
 * Every gh-guard bypass filed in the run-up to #3568 (#3518, #3531, #3540,
 * #3561, #3566, #3572, #3600) was the same defect: a fix recognised the one
 * spelling its issue named and missed the others `gh` parses the same way and
 * GitHub routes the same way. Those equivalent spellings are knowable up front
 * — they come from gh's flag parser (cobra/pflag), `gh api`'s request building
 * and GitHub's REST routing — so this helper generates them from one canonical
 * refused argv, and the conformance test asserts that every spelling gets the
 * same verdict. A new guard rule is registered once and every spelling is
 * checked with no extra effort.
 *
 * The spelling classes, each traceable to gh or GitHub behaviour:
 *
 * - a value flag as `--flag v`, `--flag=v`, `-s v`, `-sv` and `-s=v`;
 * - flags placed before the `api` root (cobra parses a subcommand's flags
 *   there too — #3572), in attached and separated form;
 * - the endpoint with a leading `/`, a trailing `/`, doubled slashes, a
 *   `?query`, a `#fragment`, or as an absolute `https://api.github.com/…` URL
 *   in any letter case (#3518);
 * - the REST number segment with trailing characters, a percent-encoded digit
 *   or an encoded `/` after the digits — GitHub takes the segment's leading
 *   digits and percent-decodes the path (#3600);
 * - the method in lower case, POST in place of PATCH on the pull and issue
 *   update routes, and gh's default POST when fields are given with no method
 *   flag (#3531);
 * - unrelated value flags (`-p/--preview`, `--jq`, `--hostname github.com`)
 *   before the endpoint, whose values must never be read as it (#3540, #3561);
 * - a GraphQL document under `-f`, `--raw-field`, `-F` and `--field`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One generated spelling of a canonical argv. */
export interface GhSpelling {
  /** Short description of the transformation, for assertion messages. */
  label: string;
  /** The equivalent argument vector. */
  argv: string[];
}

/** Long and short spellings of the `gh api` value flags that have both. */
const FLAG_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["--method", "-X"],
  ["--raw-field", "-f"],
  ["--field", "-F"],
  ["--header", "-H"],
  ["--preview", "-p"],
  ["--jq", "-q"],
  ["--template", "-t"],
];

const LONG_FOR_SHORT = new Map(FLAG_ALIASES.map(([l, s]) => [s, l]));
const SHORT_FOR_LONG = new Map(FLAG_ALIASES.map(([l, s]) => [l, s]));

/** A flag of the canonical argv, with its value. */
interface FlagPair {
  name: string;
  value: string;
}

/** Split a canonical `["api", endpoint, ...flagPairs]` argv into its parts. */
function parseCanonical(argv: readonly string[]): {
  endpoint: string;
  flags: FlagPair[];
} {
  if (argv[0] !== "api" || argv[1] === undefined || argv[1].startsWith("-")) {
    throw new Error(
      `conformance argv must be ["api", endpoint, ...flags]: ${argv.join(" ")}`,
    );
  }
  const flags: FlagPair[] = [];
  for (let i = 2; i < argv.length; i += 2) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (!name.startsWith("-") || value === undefined) {
      throw new Error(
        `conformance flags must be separated pairs: ${argv.join(" ")}`,
      );
    }
    flags.push({ name, value });
  }
  return { endpoint: argv[1], flags };
}

/** The spellings of one flag pair that gh's parser treats identically. */
function flagForms(pair: FlagPair): string[][] {
  const long = pair.name.startsWith("--")
    ? pair.name
    : LONG_FOR_SHORT.get(pair.name);
  const short = pair.name.startsWith("--")
    ? SHORT_FOR_LONG.get(pair.name)
    : pair.name;
  const forms: string[][] = [];
  if (long) forms.push([long, pair.value], [`${long}=${pair.value}`]);
  if (short) {
    forms.push([short, pair.value], [`${short}${pair.value}`], [
      `${short}=${pair.value}`,
    ]);
  }
  return forms;
}

/** Flatten flag pairs, rendering each in the given form index (clamped). */
function renderFlags(flags: readonly FlagPair[], form: number): string[] {
  return flags.flatMap((f) => {
    const forms = flagForms(f);
    return forms[Math.min(form, forms.length - 1)]!;
  });
}

/** Endpoint spellings GitHub routes to the same resource. */
function endpointForms(endpoint: string): Array<[string, string]> {
  if (endpoint === "graphql") {
    return [
      ["leading slash", "/graphql"],
      ["trailing slash", "graphql/"],
      ["query component", "graphql?x=1"],
      ["absolute URL", "https://api.github.com/graphql"],
    ];
  }
  const forms: Array<[string, string]> = [
    ["leading slash", `/${endpoint}`],
    ["trailing slash", `${endpoint}/`],
    ["doubled slashes", endpoint.replace("/", "//")],
    ["query component", `${endpoint}?per_page=1`],
    ["fragment", `${endpoint}#x`],
    ["query and fragment", `${endpoint}?a=b#c`],
    ["absolute URL", `https://api.github.com/${endpoint}`],
    ["absolute URL, upper-case host", `HTTPS://API.GITHUB.COM/${endpoint}`],
    ["absolute URL with query", `https://api.github.com/${endpoint}?x=1`],
  ];
  const number = endpoint.match(
    /^(repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/)(\d+)(.*)$/,
  );
  if (number) {
    const [, head, digits, rest] = number;
    const encoded = `%3${digits![0]}${digits!.slice(1)}`;
    forms.push(
      ["number segment with trailing characters", `${head}${digits}abc${rest}`],
      ["number segment percent-encoded", `${head}${encoded}${rest}`],
      [
        "number segment with an encoded slash after it",
        `${head}${digits}%2Fx${rest}`,
      ],
    );
  }
  return forms;
}

/**
 * Generate the gh- and GitHub-equivalent spellings of a canonical `gh api`
 * argv: `["api", endpoint, ...flagPairs]` with every flag separated from its
 * value. The canonical argv itself is the first spelling.
 *
 * @param argv - The canonical refused argument vector.
 * @param options.updateRoute - The endpoint is a pull or issue update route,
 *   where GitHub routes POST to the same handler as PATCH (#3531).
 */
export function ghEquivalentSpellings(
  argv: readonly string[],
  options: { updateRoute?: boolean } = {},
): GhSpelling[] {
  const { endpoint, flags } = parseCanonical(argv);
  const out: GhSpelling[] = [{ label: "canonical", argv: [...argv] }];
  const add = (label: string, a: string[]) => out.push({ label, argv: a });
  const formCount = Math.max(1, ...flags.map((f) => flagForms(f).length));

  // Value-flag spellings, after the root and before it (#3572).
  for (let form = 0; form < formCount; form++) {
    const rendered = renderFlags(flags, form);
    add(`flag form ${form}`, ["api", endpoint, ...rendered]);
    add(`flag form ${form}, flags before api`, [...rendered, "api", endpoint]);
    add(`flag form ${form}, flags before the endpoint`, [
      "api",
      ...rendered,
      endpoint,
    ]);
  }
  // Only the first flag moved before the root, the rest after it.
  if (flags.length > 1) {
    for (let form = 0; form < formCount; form++) {
      add(`flag form ${form}, first flag before api`, [
        ...renderFlags(flags.slice(0, 1), form),
        "api",
        endpoint,
        ...renderFlags(flags.slice(1), form),
      ]);
    }
  }

  // Endpoint spellings (#3518, #3600).
  for (const [label, e] of endpointForms(endpoint)) {
    add(`endpoint: ${label}`, ["api", e, ...renderFlags(flags, 0)]);
  }

  // Unrelated value flags whose values must never be taken as the endpoint
  // (#3540, #3561), and GitHub's own host, which changes nothing.
  const noise: Array<[string, string[]]> = [
    ["-p before the endpoint", ["-p", "squirrel-girl"]],
    ["--preview before the endpoint", ["--preview", "squirrel-girl"]],
    ["--jq before the endpoint", ["--jq", ".id"]],
    ["--hostname github.com before the endpoint", ["--hostname", "github.com"]],
  ];
  for (const [label, extra] of noise) {
    add(label, ["api", ...extra, endpoint, ...renderFlags(flags, 0)]);
  }
  add("--hostname=github.com before api", [
    "--hostname=github.com",
    "api",
    endpoint,
    ...renderFlags(flags, 0),
  ]);

  // Method spellings (#3531).
  const method = flags.find((f) => f.name === "-X" || f.name === "--method");
  if (method) {
    const others = flags.filter((f) => f !== method);
    add("method in lower case", [
      "api",
      endpoint,
      "-X",
      method.value.toLowerCase(),
      ...renderFlags(others, 0),
    ]);
    // pflag: a repeated string flag resolves to its last occurrence.
    add("method repeated, last one wins", [
      "api",
      endpoint,
      "-X",
      "GET",
      ...renderFlags(flags, 0),
    ]);
    if (options.updateRoute && method.value.toUpperCase() === "PATCH") {
      add("POST in place of PATCH", [
        "api",
        endpoint,
        "-X",
        "POST",
        ...renderFlags(others, 0),
      ]);
      const hasFields = others.some((f) =>
        /^(-f|-F|--field|--raw-field)$/.test(f.name)
      );
      if (hasFields) {
        add("gh's default POST (fields, no method flag)", [
          "api",
          endpoint,
          ...renderFlags(others, 0),
        ]);
      }
    }
  }

  // GraphQL document under every field flag (#3566's control case).
  const query = flags.find((f) =>
    (f.name === "-f" || f.name === "--raw-field") &&
    f.value.startsWith("query=")
  );
  if (endpoint === "graphql" && query) {
    const others = flags.filter((f) => f !== query);
    for (const name of ["-f", "--raw-field", "-F", "--field"]) {
      add(`GraphQL document under ${name}`, [
        "api",
        "graphql",
        name,
        query.value,
        ...renderFlags(others, 0),
      ]);
      add(`GraphQL document under ${name}=, before api`, [
        `${name}=${query.value}`,
        "api",
        "graphql",
        ...renderFlags(others, 0),
      ]);
    }
  }

  return out;
}

/** The placements of a non-GitHub `--hostname` gh honours (#1420, #3540). */
export function foreignHostSpellings(
  argv: readonly string[],
  host = "evil.example",
): GhSpelling[] {
  const { endpoint, flags } = parseCanonical(argv);
  const rest = renderFlags(flags, 0);
  return [
    {
      label: "--hostname after api",
      argv: ["api", "--hostname", host, endpoint, ...rest],
    },
    {
      label: "--hostname= after api",
      argv: ["api", `--hostname=${host}`, endpoint, ...rest],
    },
    {
      label: "--hostname after the flags",
      argv: ["api", endpoint, ...rest, "--hostname", host],
    },
    {
      label: "--hostname= before api",
      argv: [`--hostname=${host}`, "api", endpoint, ...rest],
    },
    {
      label: "--hostname before api",
      argv: ["--hostname", host, "api", endpoint, ...rest],
    },
    {
      label: "GitHub host first, foreign host last",
      argv: [
        "--hostname=github.com",
        "api",
        endpoint,
        ...rest,
        "--hostname",
        host,
      ],
    },
  ];
}
