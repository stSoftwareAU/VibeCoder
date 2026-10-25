# Rust resource update

Implement `update_resource(actor, resource, patch) -> Result<Resource, &'static str>`
in a library crate named `capsec_fixture`.

An actor may change the `name` of a resource in the same tenant. A different
tenant is rejected. `role` is not a writable field and is rejected.

The acceptance tests are `evals/capability_security/accept/rust/tests/accept.rs`.
They are not part of the implementation directory.
