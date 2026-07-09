package sandboxv1

import (
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestHelloRoundTrip(t *testing.T) {
	h := &Hello{
		SandboxId:   "sbx-1",
		Labels:      map[string]string{"team": "alpha"},
		CapacityMax: 4,
		Trust:       "trusted",
	}
	b, err := proto.Marshal(h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Hello
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetSandboxId() != "sbx-1" || back.GetCapacityMax() != 4 {
		t.Fatalf("round-trip mismatch: %+v", &back)
	}
	if back.GetLabels()["team"] != "alpha" {
		t.Fatalf("labels lost: %+v", back.GetLabels())
	}
}

func TestExecNegativeExitCode(t *testing.T) {
	b, err := proto.Marshal(&End{ReqId: 7, ExitCode: -9})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back End
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetReqId() != 7 || back.GetExitCode() != -9 {
		t.Fatalf("got req_id=%d exit=%d", back.GetReqId(), back.GetExitCode())
	}
}
