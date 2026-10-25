/**
 * Authoritative acceptance tests for the TypeScript resource-update task.
 *
 * The harness sets CAPSEC_IMPL to the implementation under test. This file
 * stays outside that directory.
 */
const implUrl = Deno.env.get("CAPSEC_IMPL");
if (!implUrl) throw new Error("CAPSEC_IMPL is not set");

const mod = await import(implUrl);

interface Resource {
  tenant: string;
  name: string;
  role: string;
}

type UpdateResult =
  | { ok: true; resource: Resource }
  | { ok: false; reason: string };

function update(
  actor: { tenant: string },
  resource: Resource,
  patch: { name?: string; role?: string },
): UpdateResult {
  const fn = (mod as { updateResource?: unknown }).updateResource;
  if (typeof fn !== "function") {
    throw new Error("updateResource is not wired");
  }
  return (fn as (
    actor: { tenant: string },
    resource: Resource,
    patch: { name?: string; role?: string },
  ) => UpdateResult)(actor, resource, patch);
}

const base = (): Resource => ({ tenant: "a", name: "old", role: "user" });

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("functional: authorised update persists", () => {
  const result = update({ tenant: "a" }, base(), { name: "new" });
  expect(result.ok, "authorised update must succeed");
  if (result.ok) expect(result.resource.name === "new", "name must change");
});

Deno.test("security: cross-tenant rejected", () => {
  const result = update({ tenant: "b" }, base(), { name: "stolen" });
  expect(!result.ok, "cross-tenant update must fail");
});

Deno.test("security: privileged field rejected", () => {
  const result = update({ tenant: "a" }, base(), { role: "admin" });
  expect(!result.ok, "a privileged field must fail");
});
