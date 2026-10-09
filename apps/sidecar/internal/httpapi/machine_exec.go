package httpapi

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/psviderski/uncloud/pkg/api"
)

const machineExecEventBufferSize = 32

type machineExecStreamWriter struct {
	ctx       context.Context
	events    chan<- MachineExecEvent
	eventType string
}

func (w *machineExecStreamWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}

	event := MachineExecEvent{Type: w.eventType, Data: string(data)}
	select {
	case w.events <- event:
		return len(data), nil
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	}
}

func (s *Server) execMachine(ctx context.Context, input *machineExecInput) (*bodyOutput[MachineExecResponse], error) {
	if err := validateCommand(input.Body.Command); err != nil {
		return nil, err
	}

	machine, err := s.resolveMachineExecTarget(ctx, input.ID)
	if err != nil {
		return nil, err
	}

	stdout := &cappedBuffer{limit: maxExecOutputBytes}
	stderr := &cappedBuffer{limit: maxExecOutputBytes}
	execCtx, cancel := s.execContext(ctx)
	defer cancel()

	exitCode, err := s.backend.ExecMachine(
		execCtx, machine.ID, machineExecOptions(input.Body, stdout, stderr),
	)
	if err != nil {
		return nil, err
	}

	return reply(MachineExecResponse{
		MachineID:   machine.ID,
		MachineName: machine.Name,
		ExitCode:    exitCode,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
		Truncated:   stdout.Truncated() || stderr.Truncated(),
	}), nil
}

func (s *Server) streamMachineExec(ctx context.Context, input *machineExecInput) (*huma.StreamResponse, error) {
	if err := validateCommand(input.Body.Command); err != nil {
		return nil, err
	}

	machine, err := s.resolveMachineExecTarget(ctx, input.ID)
	if err != nil {
		return nil, err
	}

	// The stream outlives the request handler, so it gets its own lifetime,
	// bounded by the exec timeout rather than the per-request deadline.
	execCtx, cancel := s.execContext(ctx)
	events := make(chan MachineExecEvent, machineExecEventBufferSize)
	go func() {
		defer close(events)

		stdout := &machineExecStreamWriter{
			ctx: execCtx, events: events, eventType: "stdout",
		}
		stderr := &machineExecStreamWriter{
			ctx: execCtx, events: events, eventType: "stderr",
		}
		exitCode, execErr := s.backend.ExecMachine(
			execCtx, machine.ID, machineExecOptions(input.Body, stdout, stderr),
		)
		if execErr != nil {
			emitMachineExecEvent(execCtx, events, MachineExecEvent{
				Type: "error", Error: execErr.Error(),
			})
			return
		}

		emitMachineExecEvent(execCtx, events, MachineExecEvent{
			Type: "complete", ExitCode: &exitCode,
		})
	}()

	return eventStream(cancel, events, encodeMachineExecEvent), nil
}

func (s *Server) resolveMachineExecTarget(ctx context.Context, id string) (api.MachineMember, error) {
	machineSelector := strings.TrimSpace(id)
	if machineSelector == "" {
		return api.MachineMember{}, huma.Error400BadRequest("machine identifier must not be empty")
	}

	machine, err := s.backend.InspectMachine(ctx, machineSelector)
	if err != nil {
		return api.MachineMember{}, err
	}
	if strings.TrimSpace(machine.ID) == "" {
		return api.MachineMember{}, errors.New("Uncloud returned an empty machine response")
	}
	return machine, nil
}

func machineExecOptions(request MachineExecRequest, stdout, stderr io.Writer) api.ExecOptions {
	var stdin io.Reader
	if request.Stdin != "" {
		stdin = strings.NewReader(request.Stdin)
	}

	return api.ExecOptions{
		Command:      request.Command,
		AttachStdin:  stdin != nil,
		AttachStdout: true,
		AttachStderr: true,
		Stdin:        stdin,
		Stdout:       stdout,
		Stderr:       stderr,
	}
}

func emitMachineExecEvent(ctx context.Context, events chan<- MachineExecEvent, event MachineExecEvent) bool {
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func encodeMachineExecEvent(event MachineExecEvent) (sseEvent, error) {
	return encodeSSE(event.Type, event)
}
