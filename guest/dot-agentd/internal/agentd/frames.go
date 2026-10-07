package agentd

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// The process stream of POST /v1/proc (proc.go) after the protocol switch:
// frames of one type byte, a big-endian uint32 payload length and the payload.
const (
	// ProcUpgradeProtocol is the Upgrade token of POST /v1/proc.
	ProcUpgradeProtocol = "dots-proc/1"

	frameStdin    byte = 'i' // client: bytes for the process's input
	frameStdinEOF byte = 'e' // client: no more input
	frameResize   byte = 'r' // client: terminal size, uint16 cols then uint16 rows
	frameSignal   byte = 's' // client: one byte, the signal number to send the process group
	frameStdout   byte = 'o' // server: output (all of it with a terminal)
	frameStderr   byte = 'E' // server: error output (without a terminal)
	frameExit     byte = 'x' // server: JSON ProcExit, the last frame

	maxFramePayload = 1 << 20
)

// ProcExit ends the stream: the exit code, or -1 and the signal that ended
// the process.
type ProcExit struct {
	ExitCode int    `json:"exit_code"`
	Signal   string `json:"signal,omitempty"`
}

func writeFrame(w io.Writer, kind byte, payload []byte) error {
	if len(payload) > maxFramePayload {
		return fmt.Errorf("frame of %d bytes is larger than %d", len(payload), maxFramePayload)
	}
	header := [5]byte{kind}
	binary.BigEndian.PutUint32(header[1:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

func readFrame(r io.Reader) (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(header[1:])
	if n > maxFramePayload {
		return 0, nil, errors.New("frame larger than the limit")
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return header[0], payload, nil
}
