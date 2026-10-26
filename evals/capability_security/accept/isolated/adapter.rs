// Child-side adapter. Its entire output is untrusted protocol data.
use capsec_fixture::{update_resource, Actor, Patch, Resource};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 6);
    let actor = Actor {
        tenant: args[0].clone(),
    };
    let resource = Resource {
        tenant: args[1].clone(),
        name: args[2].clone(),
        role: args[3].clone(),
    };
    let patch = Patch {
        name: if args[4] == "-" {
            None
        } else {
            Some(args[4].clone())
        },
        role: if args[5] == "-" {
            None
        } else {
            Some(args[5].clone())
        },
    };
    match update_resource(&actor, resource, patch) {
        Ok(resource) => println!(
            "OK\t{}\t{}\t{}",
            resource.tenant, resource.name, resource.role
        ),
        Err(reason) => println!("ERR\t{}", reason),
    }
}
