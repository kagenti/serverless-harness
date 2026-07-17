module github.com/kagenti/serverless-harness/remote-worker

go 1.25.0

require (
	github.com/kagenti/serverless-harness/gen/go v0.0.0
	google.golang.org/grpc v1.82.0
)

require (
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260414002931-afd174a4e478 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)

// Use the proto stubs vendored in this repo.
replace github.com/kagenti/serverless-harness/gen/go => ../gen/go
