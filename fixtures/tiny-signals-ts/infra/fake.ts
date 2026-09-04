import * as pulumi from "@pulumi/pulumi";

// A local class whose name looks like a Pulumi resource type. The class check is structural,
// so this is not a resource: `Bucket` is declared here and extends nothing from `@pulumi/*`.
class Bucket {
  readonly id = "local";
}

const b = new Bucket();

export const stack = `${pulumi.getStack()}:${b.id}`;
