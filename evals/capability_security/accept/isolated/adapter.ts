/** Child-side adapter. Its entire output is untrusted protocol data. */
const [actor, tenant, name, role, newName, newRole] = Deno.args;
const mod = await import("./impl.ts");
if (typeof mod.updateResource !== "function") {
  throw new Error("updateResource is not wired");
}
const patch = {
  ...(newName !== "-" ? { name: newName } : {}),
  ...(newRole !== "-" ? { role: newRole } : {}),
};
const result = mod.updateResource(
  { tenant: actor },
  { tenant, name, role },
  patch,
);
if (
  result?.ok === true && typeof result.resource?.tenant === "string" &&
  typeof result.resource.name === "string" &&
  typeof result.resource.role === "string"
) {
  console.log(
    `OK\t${result.resource.tenant}\t${result.resource.name}\t${result.resource.role}`,
  );
} else if (result?.ok === false && typeof result.reason === "string") {
  console.log(`ERR\t${result.reason}`);
} else {
  throw new Error("invalid updateResource result");
}
