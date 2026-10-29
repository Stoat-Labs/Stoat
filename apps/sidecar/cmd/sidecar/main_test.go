package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"git.irazz.lol/stoat/sidecar/internal/cluster"
	"git.irazz.lol/stoat/sidecar/internal/httpapi"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCommandDefaults(t *testing.T) {
	command := newCommand()
	assert.Equal(t, "127.0.0.1:80", command.Flag("listen").Value.String())
	assert.Equal(t, "", command.Flag("tls-listen").Value.String())
	assert.Equal(t, defaultConfigPath, command.Flag("uncloud-config").Value.String())
	assert.Equal(t, "http://localhost:3000,http://localhost:5173", command.Flag("cors-origins").Value.String())
	assert.Equal(t, "sidecar", command.Flag("host-service").Value.String())
	assert.Equal(t, httpapi.DefaultRequestTimeout.String(), command.Flag("request-timeout").Value.String())
	assert.Equal(t, httpapi.DefaultExecTimeout.String(), command.Flag("exec-timeout").Value.String())
}

func TestAuthTokenIsRequired(t *testing.T) {
	t.Setenv(authTokenEnv, "")
	_, err := authToken()
	require.Error(t, err)
	assert.Contains(t, err.Error(), authTokenEnv)

	t.Setenv(authTokenEnv, "too-short")
	_, err = authToken()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "at least")

	valid := strings.Repeat("a", minAuthTokenLength)
	t.Setenv(authTokenEnv, valid)
	token, err := authToken()
	require.NoError(t, err)
	assert.Equal(t, valid, token)
}

func TestTLSConfigNeedsAWholeKeyPair(t *testing.T) {
	cert, key := selfSignedPair(t)

	t.Setenv(tlsCertEnv, cert)
	t.Setenv(tlsKeyEnv, "")
	_, err := tlsConfig()
	require.Error(t, err)
	assert.Contains(t, err.Error(), tlsKeyEnv)

	t.Setenv(tlsKeyEnv, "not a key")
	_, err = tlsConfig()
	require.Error(t, err)

	t.Setenv(tlsKeyEnv, key)
	config, err := tlsConfig()
	require.NoError(t, err)
	require.Len(t, config.Certificates, 1)
	assert.Equal(t, uint16(tls.VersionTLS12), config.MinVersion)
}

// selfSignedPair returns a PEM certificate and PKCS#8 key like the ones Stoat generates.
func selfSignedPair(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("192.168.1.10")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	require.NoError(t, err)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return string(cert), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
}

func TestConnectionSpecsExpandsDefaultUnixSockets(t *testing.T) {
	specs, err := connectionSpecs(options{connect: "unix://" + cluster.LegacyUncloudSockPath})
	require.NoError(t, err)
	require.Len(t, specs, 2)
	assert.Equal(t, cluster.LegacyUncloudSockPath, specs[0].Unix)
	assert.Equal(t, cluster.DefaultUncloudSockPath, specs[1].Unix)

	specs, err = connectionSpecs(options{connect: "unix://" + cluster.DefaultUncloudSockPath})
	require.NoError(t, err)
	require.Len(t, specs, 2)
	assert.Equal(t, cluster.DefaultUncloudSockPath, specs[0].Unix)
	assert.Equal(t, cluster.LegacyUncloudSockPath, specs[1].Unix)
}

func TestConnectionSpecsKeepsCustomUnixSocket(t *testing.T) {
	specs, err := connectionSpecs(options{connect: "unix:///tmp/custom.sock"})
	require.NoError(t, err)
	require.Len(t, specs, 1)
	assert.Equal(t, "/tmp/custom.sock", specs[0].Unix)
}
