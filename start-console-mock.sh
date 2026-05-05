#!/bin/sh
# Start the OpenShift Console container pointed at the local mock API server.
# The mock server must already be running.
# Start it from the standalone repo: https://github.com/galkremer1/kubevirt-mock-apiserver
#   cd ../kubevirt-mock-apiserver && npm start
#
# Usage:
#   ./start-console-mock.sh
#
# Optional env vars:
#   MOCK_PORT       Port the mock server listens on (default: 8443)
#   CONSOLE_IMAGE   Console image to use (default: quay.io/openshift/origin-console:latest)
#   CONSOLE_PORT    Local port to expose the console on (default: 9000)
set -eu

MOCK_PORT=${MOCK_PORT:-8443}
CONSOLE_IMAGE=${CONSOLE_IMAGE:-"quay.io/openshift/origin-console:latest"}
CONSOLE_PORT=${CONSOLE_PORT:-9000}

# ── Plugin URLs per container runtime ─────────────────────────────────────────
if command -v podman >/dev/null; then
  if [ "$(uname -s)" = "Linux" ]; then
    MOCK_HOST="localhost"
    PLUGIN_HOST="localhost"
    RUNTIME="podman-linux"
  else
    MOCK_HOST="host.containers.internal"
    PLUGIN_HOST="host.containers.internal"
    RUNTIME="podman-mac"
  fi
else
  MOCK_HOST="host.docker.internal"
  PLUGIN_HOST="host.docker.internal"
  RUNTIME="docker"
fi

echo ""
echo "  Starting OpenShift Console (mock mode)"
echo "  ─────────────────────────────────────────────"
echo "  Console URL:   http://localhost:${CONSOLE_PORT}"
echo "  Mock API:      https://localhost:${MOCK_PORT}"
echo "  Plugin bundle: http://localhost:9001"
echo "  Runtime:       ${RUNTIME}"
echo ""

# ── Write env vars to a temp file ─────────────────────────────────────────────
# Using --env-file avoids shell quoting issues with JSON values in BRIDGE_PLUGIN_PROXY.
ENVFILE=$(mktemp /tmp/console-mock-env.XXXXXX)
trap 'rm -f "$ENVFILE"' EXIT

cat > "$ENVFILE" << ENVEOF
BRIDGE_USER_AUTH=disabled
BRIDGE_K8S_MODE=off-cluster
BRIDGE_K8S_AUTH=bearer-token
BRIDGE_K8S_AUTH_BEARER_TOKEN=mock-token
BRIDGE_K8S_MODE_OFF_CLUSTER_SKIP_VERIFY_TLS=true
BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT=https://${MOCK_HOST}:${MOCK_PORT}
BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS=https://${MOCK_HOST}:${MOCK_PORT}/thanos
BRIDGE_K8S_MODE_OFF_CLUSTER_ALERTMANAGER=https://${MOCK_HOST}:${MOCK_PORT}
BRIDGE_BRANDING=openshift
BRIDGE_USER_SETTINGS_LOCATION=localstorage
BRIDGE_I18N_NAMESPACES=plugin__kubevirt-plugin
BRIDGE_PLUGINS=kubevirt-plugin=http://${PLUGIN_HOST}:9001
BRIDGE_PLUGIN_PROXY={"services":[{"consoleAPIPath":"/api/proxy/plugin/kubevirt-plugin/kubevirt-apiserver-proxy/","endpoint":"https://${MOCK_HOST}:${MOCK_PORT}","authorize":false},{"consoleAPIPath":"/api/proxy/plugin/mce/console/multicloud/","endpoint":"https://${MOCK_HOST}:${MOCK_PORT}","authorize":false}]}
ENVEOF

# ── Run the console container ─────────────────────────────────────────────────
if command -v podman >/dev/null; then
  if [ "$(uname -s)" = "Linux" ]; then
    podman run --pull=always --rm --network=host \
      --env-file "$ENVFILE" \
      "$CONSOLE_IMAGE"
  else
    podman run --platform=linux/x86_64 --pull=always --rm \
      -p "${CONSOLE_PORT}":9000 \
      --env-file "$ENVFILE" \
      "$CONSOLE_IMAGE"
  fi
else
  if [ "$(uname)" = "Darwin" ]; then
    docker run --platform=linux/x86_64 --pull=always --rm \
      -p "${CONSOLE_PORT}":9000 \
      --env-file "$ENVFILE" \
      "$CONSOLE_IMAGE"
  else
    docker run --pull=always --rm \
      -p "${CONSOLE_PORT}":9000 \
      --env-file "$ENVFILE" \
      "$CONSOLE_IMAGE"
  fi
fi
