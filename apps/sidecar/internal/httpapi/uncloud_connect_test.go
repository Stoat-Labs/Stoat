package httpapi

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const upgradeHeaders = "Connection: Upgrade\r\nUpgrade: uncloud\r\n"

// fakeUncloud stands in for the Uncloud API socket, signalling on the channel as each connection ends.
func fakeUncloud(t *testing.T, handle func(net.Conn)) (func(context.Context) (net.Conn, error), <-chan struct{}) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "uncloud.sock")
	listener, err := net.Listen("unix", path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = listener.Close() })

	closed := make(chan struct{}, maxUncloudConnections)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				handle(conn)
				_ = conn.Close()
				closed <- struct{}{}
			}()
		}
	}()

	return func(ctx context.Context) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "unix", path)
	}, closed
}

func echo(conn net.Conn) { _, _ = io.Copy(conn, conn) }

// serve runs the server on a loopback listener, since only a real connection can be hijacked.
func serve(t *testing.T, server *Server) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() { _ = server.App().Listener(listener, fiber.ListenConfig{DisableStartupMessage: true}) }()
	t.Cleanup(func() { _ = server.App().Shutdown() })
	return listener.Addr().String()
}

// connect sends a connect request with extra headers, then any bytes in after, in one write.
func connect(t *testing.T, address, token, headers, after string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	request := "GET /api/v1/cluster/connect HTTP/1.1\r\nHost: sidecar\r\n"
	if token != "" {
		request += "Authorization: Bearer " + token + "\r\n"
	}
	_, err = io.WriteString(conn, request+headers+"\r\n"+after)
	require.NoError(t, err)

	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)
	return conn, reader, response
}

func waitClosed(t *testing.T, closed <-chan struct{}) {
	t.Helper()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the Uncloud connection stayed open")
	}
}

func TestConnectUncloudRelaysBothWays(t *testing.T) {
	dial, closed := fakeUncloud(t, echo)
	server, _ := newTestServerWithConfig(t, Config{DialUncloud: dial})
	address := serve(t, server)

	// Bytes sent right behind the request, before the 101 arrives, must not be lost.
	conn, reader, response := connect(t, address, testAuthToken, upgradeHeaders, "early ")
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
	assert.Equal(t, "uncloud", response.Header.Get("Upgrade"))

	_, err := io.WriteString(conn, "ping")
	require.NoError(t, err)
	echoed := make([]byte, len("early ping"))
	_, err = io.ReadFull(reader, echoed)
	require.NoError(t, err)
	assert.Equal(t, "early ping", string(echoed))

	// The client hanging up closes the Uncloud connection and frees its slot.
	require.NoError(t, conn.Close())
	waitClosed(t, closed)
	assert.Eventually(t, func() bool { return len(server.uncloudConnections) == 0 }, 5*time.Second, 10*time.Millisecond)
}

func TestConnectUncloudEndsWhenUncloudCloses(t *testing.T) {
	dial, closed := fakeUncloud(t, func(conn net.Conn) { _, _ = io.WriteString(conn, "bye") })
	server, _ := newTestServerWithConfig(t, Config{DialUncloud: dial})

	// A client that also asks to close still gets the relay, and its slot back.
	_, reader, response := connect(t, serve(t, server), testAuthToken, "Connection: close, Upgrade\r\nUpgrade: uncloud\r\n", "")
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)

	rest, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, "bye", string(rest))
	waitClosed(t, closed)
	assert.Eventually(t, func() bool { return len(server.uncloudConnections) == 0 }, 5*time.Second, 10*time.Millisecond)
}

func TestConnectUncloudRefusals(t *testing.T) {
	var dials atomic.Int32
	counted := func(ctx context.Context) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("dial unix /run/uncloud/api/uncloud.sock: connect: no such file or directory")
	}

	for _, test := range []struct {
		name    string
		config  Config
		token   string
		headers string
		full    bool
		status  int
		message string
	}{
		{name: "missing token", config: Config{DialUncloud: counted}, headers: upgradeHeaders, status: http.StatusUnauthorized, message: "bearer token"},
		{name: "plain request", config: Config{DialUncloud: counted}, token: testAuthToken, status: http.StatusUpgradeRequired, message: "Upgrade: uncloud"},
		{name: "other protocol", config: Config{DialUncloud: counted}, token: testAuthToken, headers: "Connection: Upgrade\r\nUpgrade: websocket\r\n", status: http.StatusUpgradeRequired, message: "Upgrade: uncloud"},
		{name: "no direct connection", token: testAuthToken, headers: upgradeHeaders, status: http.StatusNotImplemented, message: "over SSH"},
		{name: "every slot taken", config: Config{DialUncloud: counted}, token: testAuthToken, headers: upgradeHeaders, full: true, status: http.StatusServiceUnavailable, message: "too many"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dials.Store(0)
			server, _ := newTestServerWithConfig(t, test.config)
			if test.full {
				for range maxUncloudConnections {
					server.uncloudConnections <- struct{}{}
				}
			}

			_, _, response := connect(t, serve(t, server), test.token, test.headers, "")
			assert.Equal(t, test.status, response.StatusCode)
			assert.Contains(t, decodeResponse[ErrorResponse](t, response).Message, test.message)
			assert.Zero(t, dials.Load(), "the Uncloud API must not be dialed")
			if test.status == http.StatusUpgradeRequired {
				assert.Equal(t, "uncloud", response.Header.Get("Upgrade"))
			}
		})
	}

	t.Run("failed dial", func(t *testing.T) {
		server, _ := newTestServerWithConfig(t, Config{DialUncloud: counted})

		_, _, response := connect(t, serve(t, server), testAuthToken, upgradeHeaders, "")
		assert.Equal(t, http.StatusBadGateway, response.StatusCode)
		assert.Contains(t, decodeResponse[ErrorResponse](t, response).Message, "no such file")
		assert.Empty(t, server.uncloudConnections, "a failed dial must free its slot")
	})
}
