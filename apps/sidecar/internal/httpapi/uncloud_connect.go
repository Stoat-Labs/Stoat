package httpapi

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humafiber"
)

const (
	// uncloudProtocol is the Upgrade token of a raw connection to the Uncloud API.
	uncloudProtocol = "uncloud"
	// maxUncloudConnections caps open connections; a uc command needs one or two.
	maxUncloudConnections = 16
)

// switchingProtocols is written by hand: with HijackSetNoResponse fasthttp sends no response.
const switchingProtocols = "HTTP/1.1 101 Switching Protocols\r\n" +
	"Connection: Upgrade\r\n" +
	"Upgrade: " + uncloudProtocol + "\r\n\r\n"

type connectUncloudInput struct {
	Connection string `header:"Connection" doc:"Must list Upgrade."`
	Upgrade    string `header:"Upgrade" doc:"Must be uncloud."`
}

// connectUncloud relays the connection to the Uncloud API, which the token's root access already covers.
func (s *Server) connectUncloud(ctx context.Context, input *connectUncloudInput) (*huma.StreamResponse, error) {
	if s.dialUncloud == nil {
		return nil, huma.Error501NotImplemented("this sidecar reaches Uncloud over SSH, which it cannot relay")
	}
	// uc would add a machine to the cluster mid-removal.
	if s.removing.Load() {
		return nil, errRemovingMachine()
	}
	if !listsToken(input.Connection, "upgrade") || !strings.EqualFold(strings.TrimSpace(input.Upgrade), uncloudProtocol) {
		return nil, huma.ErrorWithHeaders(
			huma.NewError(http.StatusUpgradeRequired, "send Connection: Upgrade and Upgrade: "+uncloudProtocol),
			http.Header{"Upgrade": {uncloudProtocol}},
		)
	}

	select {
	case s.uncloudConnections <- struct{}{}:
	default:
		return nil, huma.Error503ServiceUnavailable("too many open Uncloud connections")
	}
	upstream, err := s.dialUncloud(ctx)
	if err != nil {
		<-s.uncloudConnections
		return nil, huma.Error502BadGateway("connect to the Uncloud API: " + err.Error())
	}

	return &huma.StreamResponse{Body: func(ctx huma.Context) {
		request := humafiber.Unwrap(ctx).RequestCtx()
		// Without a fasthttp response the handler always runs, so the slot and upstream are always released.
		request.HijackSetNoResponse(true)
		request.Hijack(func(conn net.Conn) {
			defer func() { <-s.uncloudConnections }()
			defer func() { _ = upstream.Close() }()

			if _, err := io.WriteString(conn, switchingProtocols); err != nil {
				return
			}
			relay(conn, upstream)
		})
	}}, nil
}

// relay copies bytes both ways until either side stops, then stops the other direction too.
func relay(client, upstream net.Conn) {
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		// A hijacked connection ignores Close until the handler returns, so a deadline unblocks it.
		_ = client.SetDeadline(time.Now())
		_ = upstream.SetDeadline(time.Now())
		done <- struct{}{}
	}

	go pipe(upstream, client)
	go pipe(client, upstream)
	<-done
	<-done
}

// listsToken reports whether a comma-separated header value contains token, ignoring case.
func listsToken(header, token string) bool {
	for part := range strings.SplitSeq(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}
