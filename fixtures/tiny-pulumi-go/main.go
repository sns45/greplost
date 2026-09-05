// Package main is the smallest Pulumi Go program that exercises every rule the
// `pulumi-go` signal pass has (spec 2026-09-04 section 3.6):
//
//   - a resource constructor reached through a Pulumi provider import, bound with
//     `:=`, which is the `resource.<varName>` node;
//   - a second resource whose `Args` literal reads the first one's `ID()` and whose
//     `pulumi.Parent` option names it outright, which are the two `resource-input`
//     reference forms;
//   - a decoy constructor of exactly the same shape from a package that is not a
//     Pulumi provider, which is neither.
package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"

	"example.com/tinypulumigo/internal/thing"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		bucket, err := s3.NewBucket(ctx, "site", &s3.BucketArgs{
			Tags: pulumi.StringMap{"env": pulumi.String("test")},
		})
		if err != nil {
			return err
		}

		policy, err := s3.NewBucketPolicy(ctx, "site-policy", &s3.BucketPolicyArgs{
			Bucket: bucket.ID(),
			Policy: pulumi.String(`{"Version":"2012-10-17","Statement":[]}`),
		}, pulumi.Parent(bucket))
		if err != nil {
			return err
		}

		// The decoy. Same shape, different provenance: not a resource.
		thing.NewThing(ctx, "x", &thing.ThingArgs{Name: "x"})

		ctx.Export("bucketName", bucket.Bucket)
		ctx.Export("policyID", policy.ID())
		return nil
	})
}
