pub struct Actor {
    pub tenant: String,
}
pub struct Resource {
    pub tenant: String,
    pub name: String,
    pub role: String,
}
pub struct Patch {
    pub name: Option<String>,
    pub role: Option<String>,
}

pub fn update_resource(
    actor: &Actor,
    mut resource: Resource,
    patch: Patch,
) -> Result<Resource, &'static str> {
    if actor.tenant != resource.tenant {
        return Err("unauthorised");
    }
    if patch.role.is_some() {
        return Err("forbidden-field");
    }
    if let Some(name) = patch.name {
        resource.name = name;
    }
    Ok(resource)
}
