# TypeScript resource update

Implement `updateResource(actor, resource, patch)`.

An actor may change the `name` of a resource in the same tenant. A different
tenant is rejected. `role` is not a writable field and is rejected. Return
`{ ok: true, resource }` or `{ ok: false, reason }`.

The acceptance tests are `evals/capability_security/accept/ts_resource_update_test.ts`.
They are not part of the implementation directory.
