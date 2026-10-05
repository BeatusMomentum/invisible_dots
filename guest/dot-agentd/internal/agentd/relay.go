package agentd

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
)

// RelayOptions configures RunRelay, the client end of POST /v1/proc.
type RelayOptions struct {
	// Socket is dot-agentd's local socket.
	Socket string
	Argv   []string
	Cwd    string
	Env    map[string]string
	// TTY asks for a pseudo-terminal of the given size.
	TTY *ProcTTY
	// Resize, when set, delivers new terminal sizes while the process runs.
	Resize <-chan ProcTTY
	// Signals, when set, delivers signals to forward to the process group.
	Signals <-chan syscall.Signal
}

// RunRelay runs a program through dot-agentd as the Dot's user, copying
// stdin to it and its output to stdout and stderr, and returns its exit
// code (128 + the signal number when a signal ended it). The process dies
// when this returns or the connection breaks. The engine starts it, as
// `dot-agentd relay`, for every command of the model: it stands where a local
// shell would, so the engine's process handling (background sessions,
// terminals, timeouts) works unchanged.
func RunRelay(ctx context.Context, opts RelayOptions, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	body, err := json.Marshal(ProcRequest{
		Argv: opts.Argv,
		Cwd:  optionalString(opts.Cwd),
		Env:  opts.Env,
		TTY:  opts.TTY,
	})
	if err != nil {
		return 0, err
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", opts.Socket)
	if err != nil {
		return 0, fmt.Errorf("connect to %s: %w", opts.Socket, err)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	request := fmt.Sprintf("POST /v1/proc HTTP/1.1\r\nHost: agentd\r\nConnection: Upgrade\r\nUpgrade: %s\r\n"+
		"Content-Type: application/json\r\nContent-Length: %d\r\n\r\n", ProcUpgradeProtocol, len(body))
	if _, err := conn.Write(append([]byte(request), body...)); err != nil {
		return 0, err
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		return 0, fmt.Errorf("read the answer of %s: %w", opts.Socket, err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		defer resp.Body.Close()
		var answer ErrorAnswer
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		if json.Unmarshal(raw, &answer) == nil && answer.Message != "" {
			return 0, fmt.Errorf("dot-agentd refused the process (%d %s): %s", resp.StatusCode, answer.Error, answer.Message)
		}
		return 0, fmt.Errorf("dot-agentd refused the process: %s", resp.Status)
	}

	var writeMu sync.Mutex
	send := func(kind byte, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeFrame(conn, kind, payload)
	}
	if stdin != nil {
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, err := stdin.Read(buf)
				if n > 0 && send(frameStdin, buf[:n]) != nil {
					return
				}
				if err != nil {
					_ = send(frameStdinEOF, nil)
					return
				}
			}
		}()
	} else {
		_ = send(frameStdinEOF, nil)
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case size, ok := <-opts.Resize:
				if !ok {
					return
				}
				payload := make([]byte, 4)
				binary.BigEndian.PutUint16(payload[:2], size.Cols)
				binary.BigEndian.PutUint16(payload[2:], size.Rows)
				_ = send(frameResize, payload)
			case sig, ok := <-opts.Signals:
				if !ok {
					return
				}
				_ = send(frameSignal, []byte{byte(sig)})
			}
		}
	}()

	for {
		kind, payload, err := readFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return 0, errors.New("dot-agentd closed the process stream before the process ended")
			}
			return 0, err
		}
		switch kind {
		case frameStdout:
			if _, err := stdout.Write(payload); err != nil {
				return 0, err
			}
		case frameStderr:
			if _, err := stderr.Write(payload); err != nil {
				return 0, err
			}
		case frameExit:
			var exit ProcExit
			if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&exit); err != nil {
				return 0, err
			}
			if exit.Signal != "" {
				return 128 + signalNumber(exit.Signal), nil
			}
			return exit.ExitCode, nil
		}
	}
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// signalNumber maps a signal's name (as Go prints it) back to its number.
func signalNumber(name string) int {
	for n := 1; n < 65; n++ {
		if strings.EqualFold(syscall.Signal(n).String(), name) {
			return n
		}
	}
	return int(syscall.SIGKILL)
}

// RelaySocketDefault is the local socket RunRelay connects to unless told otherwise.
func RelaySocketDefault() string {
	if s := os.Getenv("INVISIBLE_DOTS_AGENTD_SOCKET"); s != "" {
		return s
	}
	return DefaultAgentdSocket
}
