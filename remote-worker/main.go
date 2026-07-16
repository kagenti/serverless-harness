// Command remote-worker is a minimal SandboxTransport worker: it dials the
// serverless-harness relay's SandboxWorker.Attach stream and, for every Exec it
// receives, streams back "HELLO WORLD" (plus an echo of the input) on stdout,
// then a terminal End{exit_code: 0}. It runs no shell and holds no secrets.
//
// See DESIGN.md for how it connects and how to run it from a laptop against ykt1.
package main

import (
	"context"
	"crypto/tls"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "github.com/kagenti/serverless-harness/gen/go/sandbox/v1"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	relayAddr := env("RELAY_ADDR", "localhost:8443")
	sandboxID := env("SANDBOX_ID", "sbx-laptop-1")
	token := env("SANDBOX_TOKEN", "dev-token")
	useTLS := env("RELAY_TLS", "0") == "1"

	// Plaintext h2c for the in-cluster ClusterIP or an `oc port-forward` tunnel;
	// TLS for a relay exposed via an OpenShift Route on :443.
	var creds credentials.TransportCredentials
	if useTLS {
		creds = credentials.NewTLS(&tls.Config{})
	} else {
		creds = insecure.NewCredentials()
	}

	conn, err := grpc.NewClient(relayAddr, grpc.WithTransportCredentials(creds))
	if err != nil {
		log.Fatalf("dial %s: %v", relayAddr, err)
	}
	defer conn.Close()
	client := pb.NewSandboxWorkerClient(conn)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Auth is fail-closed: the relay checks `authorization: Bearer <token>`.
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; log.Println("signal received, closing stream"); cancel() }()

	log.Printf("remote-worker: dialing relay=%s sandbox_id=%s tls=%v", relayAddr, sandboxID, useTLS)
	stream, err := client.Attach(ctx)
	if err != nil {
		log.Fatalf("attach: %v", err)
	}

	// Serialize all sends: the heartbeat goroutine and per-exec goroutines share
	// the one stream, and gRPC streams are not safe for concurrent Send.
	var sendMu sync.Mutex
	send := func(f *pb.WorkerFrame) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(f)
	}

	// 1) Hello MUST be the first frame.
	if err := send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Hello{Hello: &pb.Hello{
		SandboxId:    sandboxID,
		Capabilities: []string{"hello-world"},
		Image:        "remote-worker-hello:dev",
		Arch:         runtime.GOARCH,
		CapacityMax:  1,
		Trust:        "untrusted",
	}}}); err != nil {
		log.Fatalf("send hello: %v", err)
	}
	log.Printf("sent Hello; awaiting Exec frames (Ctrl+C to stop)")

	// 2) Heartbeats keep the stream (and any NAT/port-forward) alive.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Heartbeat{Heartbeat: &pb.Heartbeat{}}})
			}
		}
	}()

	// dedup / at-least-once: re-emit the cached terminal End on a redelivered req_id.
	var mu sync.Mutex
	done := map[uint64]*pb.End{}

	// 3) Loop on relay frames.
	for {
		sf, err := stream.Recv()
		if err == io.EOF {
			log.Println("relay closed the stream")
			return
		}
		if err != nil {
			log.Printf("recv: %v", err)
			return
		}
		switch m := sf.Msg.(type) {
		case *pb.ServerFrame_Exec:
			go handleExec(send, &mu, done, m.Exec)
		case *pb.ServerFrame_Abort:
			// Nothing long-running to kill in the stub; emit a signalled terminal.
			_ = send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_End{End: &pb.End{ReqId: m.Abort.ReqId, ExitCode: -1}}})
		}
	}
}

func handleExec(send func(*pb.WorkerFrame) error, mu *sync.Mutex, done map[uint64]*pb.End, e *pb.Exec) {
	// Redelivered req_id after a reconnect → re-emit the cached result, don't re-run.
	mu.Lock()
	if end, ok := done[e.ReqId]; ok {
		mu.Unlock()
		_ = send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_End{End: end}})
		return
	}
	mu.Unlock()

	log.Printf("exec req_id=%d command=%q streaming=%v", e.ReqId, e.Command, e.Streaming)

	// Simulate HELLO WORLD as a continuous stdout stream, then echo the input.
	chunks := []string{"HELLO ", "WORLD\n"}
	if e.Command != "" {
		chunks = append(chunks, "you asked: "+e.Command+"\n")
	}
	if len(e.Stdin) > 0 {
		chunks = append(chunks, "stdin: "+string(e.Stdin))
	}
	for _, c := range chunks {
		if err := send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Chunk{Chunk: &pb.Chunk{
			ReqId: e.ReqId, Data: []byte(c), Stream: pb.Stream_STREAM_STDOUT,
		}}}); err != nil {
			log.Printf("exec req_id=%d send chunk: %v", e.ReqId, err)
			return
		}
		time.Sleep(150 * time.Millisecond) // make the streaming visible
	}

	end := &pb.End{ReqId: e.ReqId, ExitCode: 0}
	mu.Lock()
	done[e.ReqId] = end
	mu.Unlock()
	_ = send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_End{End: end}})
	log.Printf("exec req_id=%d done (exit 0)", e.ReqId)
}
