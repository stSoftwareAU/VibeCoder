import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  listBabysitterRepositories,
  selectBabysitterInstallation,
  selectBabysitterRepositories,
} from "../lib/fleet_babysitter_repositories.ts";

Deno.test("babysitter keeps a mixed-owner config and skips inaccessible full names", () => {
  const configured = [
    "TitlePage/private",
    "stSoftwareAU/private",
    "stSoftwareAU/other",
  ];
  const messages: string[] = [];
  assertEquals(
    selectBabysitterRepositories(
      configured,
      new Set(["stsoftwareau/private"]),
      undefined,
      (message) => messages.push(message),
    ),
    ["stSoftwareAU/private"],
  );
  assertEquals(configured, [
    "TitlePage/private",
    "stSoftwareAU/private",
    "stSoftwareAU/other",
  ]);
  assertEquals(messages.length, 2);
  assertEquals(
    messages[0],
    "Skipping TitlePage/private: not accessible to the babysitter App installation.",
  );
  assertThrows(
    () =>
      selectBabysitterRepositories(configured, new Set(), undefined, () => {}),
    Error,
    "No configured repositories",
  );
  assertThrows(
    () =>
      selectBabysitterRepositories(
        configured,
        new Set(["stsoftwareau/private"]),
        "TitlePage/private",
        () => {},
      ),
    Error,
    "Requested repository TitlePage/private is not accessible",
  );
});

Deno.test("setup selects the only installed monitored owner and refuses ambiguity", () => {
  const installations = [{ id: 12, account: { login: "stSoftwareAU" } }];
  const repos = ["TitlePage/private", "STSOFTWAREAU/repo"];
  assertEquals(selectBabysitterInstallation(installations, repos).id, 12);
  const both = [...installations, { id: 13, account: { login: "TitlePage" } }];
  assertThrows(
    () => selectBabysitterInstallation(both, repos),
    Error,
    "--installation-id",
  );
  assertEquals(selectBabysitterInstallation(both, repos, "12").id, 12);
  assertThrows(
    () => selectBabysitterInstallation(installations, repos, "99"),
    Error,
    "--installation-id",
  );
});

Deno.test("installation repository discovery reads all pages and normalises full names", async () => {
  const urls: string[] = [];
  const result = await listBabysitterRepositories(
    "test-token",
    async (url, init) => {
      urls.push(String(url));
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-token",
      );
      return Response.json({
        total_count: 2,
        repositories: [{
          full_name: urls.length === 1 ? "Owner/One" : "Owner/Two",
        }],
      });
    },
  );
  assertEquals([...result], ["owner/one", "owner/two"]);
  assertEquals(urls.length, 2);
  assertEquals(
    urls[1],
    "https://api.github.com/installation/repositories?per_page=100&page=2",
  );
});

Deno.test("installation discovery surfaces API, malformed and incomplete responses", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assertRejects(
      () =>
        listBabysitterRepositories(
          "token",
          () => Promise.resolve(new Response(null, { status })),
        ),
      Error,
      `HTTP ${status}`,
    );
  }
  for (
    const body of [null, {}, { total_count: 1, repositories: [null] }, {
      total_count: 1,
      repositories: [{}],
    }]
  ) {
    await assertRejects(
      () =>
        listBabysitterRepositories(
          "token",
          () => Promise.resolve(Response.json(body)),
        ),
      Error,
      "malformed",
    );
  }
  await assertRejects(
    () =>
      listBabysitterRepositories(
        "token",
        () =>
          Promise.resolve(Response.json({ total_count: 1, repositories: [] })),
      ),
    Error,
    "incomplete",
  );
  let page = 0;
  await assertRejects(
    () =>
      listBabysitterRepositories("token", () =>
        Promise.resolve(
          Response.json({
            total_count: ++page === 1 ? 2 : 3,
            repositories: [{ full_name: `owner/repo${page}` }],
          }),
        )),
    Error,
    "changed during pagination",
  );
});
