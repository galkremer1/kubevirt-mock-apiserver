# KubeVirt Mock API Server

A local mock Kubernetes + Prometheus (Thanos) API server for load-testing the `kubevirt-plugin` UI at scale — without a real OpenShift cluster.

## How It Works

The OpenShift Console bridge supports `BRIDGE_K8S_MODE=off-cluster`, which points it at any HTTPS endpoint. This server impersonates that endpoint:

- Serves realistic Kubernetes list/watch/write responses for VMs, VMIs, Namespaces, Nodes, DataVolumes, etc.
- Handles all write operations (`k8sPatch`, `k8sCreate`, `k8sDelete`) and simulates controller behaviour (start → Starting → Running, stop → Stopping → Stopped) with realistic delays.
- Serves Prometheus instant and range queries via `/thanos/api/v1/query[_range]` with per-VM synthetic time-series seeded deterministically.
- Optionally exposes a control panel UI for triggering VM lifecycle events interactively.

All data paths in the plugin work unchanged — no mocks at the SDK level.

## Quick Start

```bash
# 1. Install dependencies (first time only)
cd kubevirt-mock-apiserver && npm install

# 2. Start the mock server (uses config.json)
npm start           # headless
npm run start:ui    # with control panel at http://localhost:8080

# 3. Start the plugin webpack dev server (in another terminal)
cd kubevirt-plugin && npm run dev

# 4. Start the Console container pointed at the mock server (in another terminal)
cd kubevirt-plugin && npm run start-console-mock
```

Open `http://localhost:9000` — the full kubevirt-plugin UI backed entirely by mock data.

## Configuration

Edit `config.json`:

```json
{
  "seed": 42,
  "clusters": [
    {
      "name": "local-cluster",
      "namespaces": 10,
      "vmsPerNamespace": 100,
      "statusDistribution": { "Running": 0.6, "Stopped": 0.3, "Paused": 0.1 }
    }
  ],
  "server": {
    "port": 8443,
    "ui": false,
    "uiPort": 8080
  }
}
```

| Field                           | Description                                                     |
| ------------------------------- | --------------------------------------------------------------- |
| `seed`                          | Deterministic seed — same config always generates identical VMs |
| `clusters[].namespaces`         | Number of namespaces to create                                  |
| `clusters[].vmsPerNamespace`    | VMs per namespace                                               |
| `clusters[].statusDistribution` | Initial Running/Stopped/Paused ratios (must sum to ≤ 1)         |
| `server.ui`                     | Enable the control panel UI on `uiPort`                         |

Pass `--ui` on the CLI to override `server.ui` without editing the config:

```bash
node src/index.ts --config config.json --ui
```

## Control Panel UI

When enabled (`--ui` or `"ui": true`), a control panel is served at `http://localhost:8080`:

- **Status bar** — live count of VMs per status (Running / Stopped / Paused / Migrating / …)
- **Random actions** — start/stop/pause/migrate/crash N random VMs at a time
- **Scenarios** — one-click chaos patterns: Rolling Restart, Mass Stop, Mass Start, Event Storm
- **Auto mode** — fire random events continuously at a configurable rate (events/sec)
- **Event log** — live stream of the last 200 watch events emitted

## Control REST API

The control endpoints are also available directly (useful for scripting):

| Method | Path                                                                                 | Effect                                     |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `GET`  | `/control/state`                                                                     | VM status counts per cluster               |
| `POST` | `/control/vms/start-random?count=5`                                                  | Start N random stopped VMs                 |
| `POST` | `/control/vms/stop-random?count=5`                                                   | Stop N random running VMs                  |
| `POST` | `/control/vms/pause-random?count=5`                                                  | Pause N random running VMs                 |
| `POST` | `/control/vms/migrate-random?count=2`                                                | Migrate N random running VMs               |
| `POST` | `/control/vms/crash-random?count=2`                                                  | Crash N random running VMs                 |
| `POST` | `/control/scenario` body: `{"scenario":"rolling-restart","cluster":"local-cluster"}` | Apply a named scenario                     |
| `POST` | `/control/reset?cluster=local-cluster`                                               | Restore cluster to initial generated state |

Scenarios: `rolling-restart`, `mass-stop`, `mass-start`, `storm`

## VM Lifecycle Simulation

All write operations trigger realistic controller reactions:

| Operation                      | Immediate       | After delay                    |
| ------------------------------ | --------------- | ------------------------------ |
| Start VM (runStrategy: Always) | `Starting`      | → `Running` (1.5–3s)           |
| Stop VM (runStrategy: Halted)  | `Stopping`      | → `Stopped` (1–2s)             |
| Create VM                      | `Provisioning`  | → `Stopped` (2s)               |
| Delete VM                      | `DELETED` event | —                              |
| Migrate VM                     | `Migrating`     | → `Running` (3–5s)             |
| Delete VMI (Restart)           | VMI deleted     | → new VMI + `Running` (1.5–3s) |

## Prometheus Mock

All Prometheus queries go through `BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS` → `/thanos/api/v1/query[_range]`. The mock server:

- Classifies the incoming PromQL by substring matching on metric names
- Extracts `name=` and `namespace=` label matchers to scope the response to specific VMs
- Generates synthetic values seeded deterministically per VM name (same seed = same sparklines)
- For range queries, produces a sine-wave time series over the requested `[start, end]` at `step` intervals
- Returns healthy values for HCO health status and empty alert sets by default

## Environment Variables

`start-console-mock.sh` accepts:

| Variable        | Default                                   | Description                     |
| --------------- | ----------------------------------------- | ------------------------------- |
| `MOCK_PORT`     | `8443`                                    | Port the mock server listens on |
| `CONSOLE_IMAGE` | `quay.io/openshift/origin-console:latest` | Console image                   |
| `CONSOLE_PORT`  | `9000`                                    | Local port for the Console UI   |

## Fleet / Multicluster View

The Fleet Virtualization perspective (spoke-cluster view) is normally only activated when the MCE/ACM Console plugin is running, because that plugin sets the `MULTICLUSTER_SDK_PROVIDER_1` feature flag. To reach this view with just the mock server you need a one-line change in `kubevirt-plugin`:

**`src/utils/flags/enableKubevirtDynamicFlag.ts`** — add the flag alongside `FLAG_KUBEVIRT_DYNAMIC`:

```ts
export const enableKubevirtDynamicFlag = (setFeatureFlag: SetFeatureFlag) => {
  setFeatureFlag(FLAG_KUBEVIRT_DYNAMIC, true);
  setFeatureFlag("MULTICLUSTER_SDK_PROVIDER_1", true); // enables fleet view without ACM
};
```
