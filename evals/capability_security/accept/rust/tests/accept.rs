use capsec_fixture::{update_resource, Actor, Patch, Resource};

fn actor(tenant: &str) -> Actor {
    Actor { tenant: tenant.to_string() }
}

fn resource() -> Resource {
    Resource {
        tenant: "a".into(),
        name: "old".into(),
        role: "user".into(),
    }
}

#[test]
fn functional_authorised_update_persists() {
    let updated = update_resource(
        &actor("a"),
        resource(),
        Patch {
            name: Some("new".into()),
            role: None,
        },
    )
    .expect("authorised update must succeed");
    assert_eq!(updated.name, "new");
}

fn must_fail(result: Result<Resource, &'static str>, message: &str) {
    if result.is_ok() {
        panic!("{message}");
    }
}

#[test]
fn security_cross_tenant_rejected() {
    must_fail(
        update_resource(
            &actor("b"),
            resource(),
            Patch {
                name: Some("stolen".into()),
                role: None,
            },
        ),
        "cross-tenant update must fail",
    );
}

#[test]
fn security_privileged_field_rejected() {
    must_fail(
        update_resource(
            &actor("a"),
            resource(),
            Patch {
                name: None,
                role: Some("admin".into()),
            },
        ),
        "a privileged field must fail",
    );
}
