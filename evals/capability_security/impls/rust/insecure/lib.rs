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
    _actor: &Actor,
    mut resource: Resource,
    patch: Patch,
) -> Result<Resource, &'static str> {
    if let Some(name) = patch.name {
        resource.name = name;
    }
    if let Some(role) = patch.role {
        resource.role = role;
    }
    Ok(resource)
}
