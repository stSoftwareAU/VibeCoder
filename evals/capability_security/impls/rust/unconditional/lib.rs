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
    resource: Resource,
    _patch: Patch,
) -> Result<Resource, &'static str> {
    Ok(resource)
}
