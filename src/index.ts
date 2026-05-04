import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import selfsigned from 'selfsigned';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config';
import { MockStore } from './store';
import { VirtualMachine, VirtualMachineInstance } from './generator';
import { createK8sRouter, configMapStore, cmKey, cmUpdateEmitter } from './routes/k8s';
import { createControlRouter } from './routes/control';
import { createPrometheusRouter } from './routes/prometheus';

// ── CLI args ────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .option('config', { default: path.join(__dirname, '..', 'config.json'), describe: 'Path to config.json', type: 'string' })
  .option('ui', { describe: 'Enable the control panel UI', type: 'boolean' })
  .parseSync();

const config = loadConfig(argv.config, argv.ui);
const store = new MockStore(config);

// ── TLS certificate ─────────────────────────────────────────────────────────

function getTlsCert(): { cert: string; key: string } {
  const certPath = path.join(__dirname, '..', '.mock-cert.pem');
  const keyPath = path.join(__dirname, '..', '.mock-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath, 'utf-8'), key: fs.readFileSync(keyPath, 'utf-8') };
  }

  console.log('Generating self-signed TLS certificate...');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    extensions: [
      { altNames: [{ type: 2, value: 'localhost' }, { ip: '127.0.0.1', type: 7 }], name: 'subjectAltName' },
    ],
    keySize: 2048,
  });

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  return { cert: pems.cert, key: pems.private };
}

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();

// Parse JSON bodies (for PATCH, POST, PUT)
app.use(express.json({ limit: '10mb', type: ['application/json', 'application/json-patch+json', 'application/merge-patch+json', 'application/strategic-merge-patch+json'] }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging (errors only) ────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const origJson = res.json.bind(res);
  const origStatus = res.status.bind(res);
  let statusCode = 200;
  res.status = (code: number) => { statusCode = code; return origStatus(code); };
  res.json = (body: unknown) => {
    if (statusCode >= 400) console.log(`[${statusCode}] ${req.method} ${req.url}`);
    return origJson(body);
  };
  next();
});

// ── Auth bypass ──────────────────────────────────────────────────────────────
// The Console bridge sends bearer token auth. Accept any token.

app.get('/openid/v1/jwks', (_req: Request, res: Response) => {
  res.json({ keys: [] });
});

app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  res.json({ issuer: 'https://localhost:8443', token_endpoint: 'https://localhost:8443/oauth/token' });
});

app.post('/oauth/token', (_req: Request, res: Response) => {
  res.json({ access_token: 'mock-token', expires_in: 86400, token_type: 'Bearer' });
});

// Respond to token review — always authenticate
app.post('/apis/authentication.k8s.io/v1/tokenreviews', (_req: Request, res: Response) => {
  res.json({
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    status: { authenticated: true, user: { groups: ['system:masters'], uid: 'mock-admin', username: 'mock-admin' } },
  });
});

// SelfSubjectAccessReview — always allow. The Console user-settings system
// checks whether the current user may create/patch ConfigMaps in the
// openshift-console-user-settings namespace before enabling the setter.
app.post('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  res.json({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    metadata: {},
    spec: (body as { spec?: unknown }).spec ?? {},
    status: { allowed: true, reason: 'mock always allows' },
  });
});

// SelfSubjectRulesReview — return a wide-open rule set so SDK helpers
// that enumerate allowed verbs don't hide actions.
app.post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const ns = ((body as { spec?: { namespace?: string } }).spec?.namespace) ?? 'default';
  res.json({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectRulesReview',
    metadata: {},
    spec: { namespace: ns },
    status: {
      incomplete: false,
      nonResourceRules: [{ nonResourceURLs: ['*'], verbs: ['*'] }],
      resourceRules: [{ apiGroups: ['*'], resourceNames: [], resources: ['*'], verbs: ['*'] }],
    },
  });
});

// ── Alertmanager v2 API ──────────────────────────────────────────────────────
// Console bridges /api/alertmanager/* → BRIDGE_K8S_MODE_OFF_CLUSTER_ALERTMANAGER/*
// The plugin calls consoleFetch('/api/alertmanager/api/v2/silences') etc.
// Alertmanager v2 returns plain arrays (not Prometheus-style {status, data} wrappers).

app.get('/api/v2/silences', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/v2/alerts', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/v2/alertgroups', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/v2/receivers', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/v2/status', (_req: Request, res: Response) => {
  res.json({
    cluster: { peers: [], status: 'ready' },
    config: { original: '' },
    uptime: new Date().toISOString(),
    versionInfo: { branch: 'mock', buildDate: '2024-01-01', buildUser: 'mock', goVersion: 'go1.21', revision: 'mock', version: '0.26.0' },
  });
});

// ── Prometheus (Thanos) routes ───────────────────────────────────────────────

const prometheusRouter = createPrometheusRouter(store);
app.use('/thanos', prometheusRouter);

// ── Control API ──────────────────────────────────────────────────────────────

const controlRouter = createControlRouter(store, config);
app.use('/control', controlRouter);

// SSE endpoint for the control UI event log
app.get('/control/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);

  const unsub = store.onWatchEvent(clusterName, 'VirtualMachine', (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => unsub());
});

// ── Kubevirt apiserver proxy path ────────────────────────────────────────────
// The console bridge proxies /api/proxy/plugin/kubevirt-plugin/kubevirt-apiserver-proxy/
// to this server. We strip the prefix and forward to the K8s router.

const k8sRouter = createK8sRouter(store);

app.use('/api/proxy/plugin/kubevirt-plugin/kubevirt-apiserver-proxy', (req: Request, res: Response, next: NextFunction) => {
  // Strip the proxy prefix so k8sRouter sees normal /apis/... paths
  req.url = req.url.replace(/^\/api\/proxy\/plugin\/kubevirt-plugin\/kubevirt-apiserver-proxy/, '') || '/';
  next();
}, k8sRouter);

// ── Fake MCE plugin manifest ──────────────────────────────────────────────────
// When registered in BRIDGE_PLUGINS the Console bridge validates that
// {endpoint}/plugin-manifest.json exists before accepting plugin proxy routes
// for that plugin.  We serve a minimal empty manifest so the mce entry in
// BRIDGE_PLUGINS passes validation without loading any JS.

app.get('/mock-mce-plugin/plugin-manifest.json', (_req: Request, res: Response) => {
  res.json({
    customProperties: { console: { displayName: 'MCE (mock)' } },
    dependencies: { '@console/pluginAPI': '>=4.17.0-0' },
    extensions: [],
    name: 'mce',
    version: '1.0.0',
  });
});

// ── ACM / MCE mock endpoints ──────────────────────────────────────────────────
// The Console bridge strips the BRIDGE_PLUGIN_PROXY consoleAPIPath prefix
// (/api/proxy/plugin/mce/console/multicloud/) before forwarding to this server.
// So a browser request to /api/proxy/plugin/mce/console/multicloud/hub
// arrives here as GET /hub.
//
// The @stolostron/multicluster-sdk fetches /hub to get the hub cluster name.

app.get('/hub', (_req: Request, res: Response) => {
  res.json({
    localHubName: store.allClusterNames()[0] ?? 'local-cluster',
    // isObservabilityInstalled is read by the SDK's useIsFleetObservabilityInstalled hook.
    // Setting it to true disables the "Multicluster observability is not available" banner.
    isObservabilityInstalled: true,
  });
});

// ── Managed cluster proxy ─────────────────────────────────────────────────────
// Non-hub cluster actions (start/stop/watch/CRUD) are sent by the multicluster SDK to:
//   /api/proxy/plugin/mce/console/multicloud/managedclusterproxy/:cluster/<k8s-path>
// After the Console bridge strips the prefix, this arrives as:
//   /managedclusterproxy/:cluster/<k8s-path>
// We strip the managedclusterproxy segment, inject ?cluster=<name>, and forward
// to k8sRouter so all existing handlers (subresources, VMs, VMIs, etc.) work.

app.use(
  '/managedclusterproxy/:cluster',
  (req: Request, _res: Response, next: NextFunction) => {
    const cluster = req.params.cluster;
    req.url = req.url.replace(new RegExp(`^/managedclusterproxy/${cluster}`), '') || '/';
    req.query = { ...req.query, cluster };
    next();
  },
  k8sRouter,
);

// ── ACM Search GraphQL API ────────────────────────────────────────────────────
// useMulticlusterNamespaces() (fleet tree view) calls useFleetSearchPoll() which
// sends GraphQL POST requests to /proxy/search.
// After the Console bridge strips the prefix, this arrives as POST /proxy/search.
// We mock the searchResultItems query to return namespace resources per cluster.

app.post('/proxy/search', (req: Request, res: Response) => {
  const body = req.body as { operationName?: string; query?: string; variables?: { input?: Array<{ filters?: Array<{ property: string; values: string[] }> }> } };
  const filters = body?.variables?.input?.[0]?.filters ?? [];

  const clusterFilter = filters.find((f) => f.property === 'cluster');
  const kindFilter = filters.find((f) => f.property === 'kind');
  const namespaceFilter = filters.find((f) => f.property === 'namespace');

  const requestedClusters = clusterFilter?.values ?? store.allClusterNames();
  const requestedKind = kindFilter?.values?.[0] ?? 'Namespace';

  const items: Record<string, unknown>[] = [];

  if (requestedKind === 'Namespace') {
    for (const clusterName of requestedClusters) {
      const clusterStore = store.getStore(clusterName);
      if (!clusterStore) continue;
      const namespaces = clusterStore.data.namespaces as Array<{ metadata: { name: string } }>;
      for (const ns of namespaces) {
        const nsName = ns.metadata?.name ?? (ns as unknown as { name?: string }).name;
        if (!nsName) continue;
        if (namespaceFilter && !namespaceFilter.values.includes(nsName)) continue;
        items.push({
          _uid: `${clusterName}/${nsName}/Namespace/${nsName}`,
          apigroup: '',
          apiversion: 'v1',
          cluster: clusterName,
          created: '2024-01-01T00:00:00Z',
          kind: 'Namespace',
          name: nsName,
          namespace: '',
          status: 'Active',
        });
      }
    }
  } else if (requestedKind === 'VirtualMachine') {
    for (const clusterName of requestedClusters) {
      const vms = store.getAllVMsForCluster(clusterName);
      for (const vm of vms) {
        const ns = vm.metadata.namespace ?? '';
        const name = vm.metadata.name;
        if (namespaceFilter && !namespaceFilter.values.includes(ns)) continue;
        const cpu = vm.spec?.template?.spec?.domain?.cpu?.cores ?? 1;
        const memory = vm.spec?.template?.spec?.domain?.resources?.requests?.memory ?? '2Gi';
        const status = vm.status?.printableStatus ?? 'Unknown';
        items.push({
          _uid: `${clusterName}/${ns}/VirtualMachine/${name}`,
          apigroup: 'kubevirt.io',
          apiversion: 'v1',
          cluster: clusterName,
          created: vm.metadata.creationTimestamp ?? '2024-01-01T00:00:00Z',
          kind: 'VirtualMachine',
          name,
          namespace: ns,
          status,
          cpu: String(cpu),
          memory,
          ready: status === 'Running' ? 'True' : 'False',
          runStrategy: vm.spec?.runStrategy,
        });
      }
    }
  } else if (requestedKind === 'VirtualMachineInstance') {
    for (const clusterName of requestedClusters) {
      const vmis = store.getAllVMIsForCluster(clusterName);
      for (const vmi of vmis) {
        const ns = vmi.metadata.namespace ?? '';
        const name = vmi.metadata.name;
        if (namespaceFilter && !namespaceFilter.values.includes(ns)) continue;
        items.push({
          _uid: `${clusterName}/${ns}/VirtualMachineInstance/${name}`,
          apigroup: 'kubevirt.io',
          apiversion: 'v1',
          cluster: clusterName,
          created: vmi.metadata.creationTimestamp ?? '2024-01-01T00:00:00Z',
          kind: 'VirtualMachineInstance',
          name,
          namespace: ns,
          phase: vmi.status?.phase ?? 'Running',
          node: vmi.status?.nodeName,
        });
      }
    }
  } else if (requestedKind === 'Node') {
    for (const clusterName of requestedClusters) {
      const clusterStore = store.getStore(clusterName);
      if (!clusterStore) continue;
      const nodes = clusterStore.data.nodes as Array<{ metadata: { name: string }; status?: { capacity?: { cpu?: string; memory?: string } } }>;
      for (const node of nodes) {
        const nodeName = node.metadata?.name;
        if (!nodeName) continue;
        items.push({
          _uid: `${clusterName}/Node/${nodeName}`,
          apigroup: '',
          apiversion: 'v1',
          cluster: clusterName,
          created: '2024-01-01T00:00:00Z',
          kind: 'Node',
          name: nodeName,
          namespace: '',
          cpu: node.status?.capacity?.cpu ?? '4',
          memory: node.status?.capacity?.memory ?? '8Gi',
        });
      }
    }
  }

  res.json({
    data: {
      searchResult: [{ items }],
    },
  });
});

// Catch-all for other MCE proxy paths — return empty responses
app.get('/multicloud/*', (_req: Request, res: Response) => {
  res.json({});
});
app.post('/multicloud/*', (_req: Request, res: Response) => {
  res.json({});
});

// ── Kubernetes API routes ─────────────────────────────────────────────────────
// Console bridge prefixes all k8s calls with /api/kubernetes/

app.use('/api/kubernetes', k8sRouter);
app.use('/', k8sRouter);

// ── Control panel UI ─────────────────────────────────────────────────────────

function startControlUI(apiPort: number): void {
  const uiPort = config.server.uiPort;
  const uiApp = express();
  const uiHtmlPath = path.join(__dirname, 'ui', 'index.html');

  uiApp.get('/', (_req: Request, res: Response) => {
    let html = fs.readFileSync(uiHtmlPath, 'utf-8');
    // Inject the API base URL so the UI can call back to the mock server's control routes
    html = html.replace(
      "const API_BASE = document.currentScript?.dataset?.api || '/';",
      `const API_BASE = 'http://localhost:${apiPort}/';`,
    );
    res.send(html);
  });

  // Proxy /control/* calls from the UI to the mock server (CORS helper)
  uiApp.use('/control', (req: Request, res: Response) => {
    // Forward to the local HTTPS mock server without TLS verification
    const options = {
      hostname: 'localhost',
      method: req.method,
      path: `/control${req.url}`,
      port: apiPort,
      rejectUnauthorized: false,
    };
    const proxy = https.request(options, (upstream) => {
      res.writeHead(upstream.statusCode ?? 200, upstream.headers);
      upstream.pipe(res);
    });
    if (req.body) proxy.write(JSON.stringify(req.body));
    proxy.end();
  });

  uiApp.use(express.json());

  http.createServer(uiApp).listen(uiPort, () => {
    console.log(`Control panel UI: http://localhost:${uiPort}`);
  });
}

// ── WebSocket watch server ────────────────────────────────────────────────────
// The Console bridge proxies all ?watch=true requests as WebSocket connections.
// We intercept the HTTP upgrade event on the HTTPS server and handle each
// watch URL ourselves, sending newline-delimited JSON watch events over the WS.

function attachWatchWebSocketServer(server: https.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url ?? '/';

    // Strip the Console bridge's /api/kubernetes prefix if present
    let cleanUrl = rawUrl.replace(/^\/api\/kubernetes/, '');

    // Handle spoke-cluster watch URLs routed via the managedclusterproxy.
    // The Console bridge strips its consoleAPIPath prefix before forwarding, so
    // the WebSocket URL arrives without the /api/proxy/plugin/mce/console/multicloud/ prefix.
    // Two possible forms:
    //   1. After bridge stripping: /managedclusterproxy/:cluster/<k8s-path>
    //   2. Full path (direct connections): /api/proxy/plugin/mce/console/multicloud/managedclusterproxy/:cluster/<k8s-path>
    const mcpMatch = cleanUrl.match(
      /^(?:\/api\/proxy\/plugin\/mce\/console\/multicloud)?\/managedclusterproxy\/([^/?]+)(\/[^?]*)?(\?.*)?$/,
    );
    if (mcpMatch) {
      const clusterFromPath = mcpMatch[1];
      const k8sPath = mcpMatch[2] ?? '/';
      const qs = mcpMatch[3] ?? '';
      const sep = qs ? '&' : '?';
      cleanUrl = `${k8sPath}${qs}${sep}cluster=${encodeURIComponent(clusterFromPath)}`;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleWatchSocket(ws, cleanUrl);
    });
  });

  function sendEvent(ws: WebSocket, type: string, object: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ object, type }) + '\n');
    }
  }

  function resolveClusterFromQuery(query: URLSearchParams): string {
    return query.get('cluster') ?? store.allClusterNames()[0] ?? 'local-cluster';
  }

  function handleWatchSocket(ws: WebSocket, rawUrl: string): void {
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const query = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '');
    const clusterName = resolveClusterFromQuery(query);
    const s = store.getStore(clusterName);

    if (!s) { ws.close(); return; }

    // ── ConfigMap watches ─────────────────────────────────────────────────────
    // Console's useUserSettings watches specific ConfigMaps by name using fieldSelector.
    // Without delivering the current ConfigMap state, the hook always starts empty and
    // restores defaults on every page reload (tour re-appears, settings lost).
    const cmWatchMatch = pathname.match(/^\/api\/v1\/namespaces\/([^/]+)\/configmaps$/);
    if (cmWatchMatch) {
      const cmNs = cmWatchMatch[1];
      const fieldSel = query.get('fieldSelector') ?? '';
      const nameMatch = fieldSel.match(/metadata\.name=([^&,]+)/);
      const cmName = nameMatch ? decodeURIComponent(nameMatch[1]) : null;

      if (cmName) {
        const key = cmKey(cmNs, cmName);
        let existing = configMapStore.get(key);
        if (!existing) {
          // Auto-create so that useKubevirtUserSettings always receives a real object.
          // Without this, the hook's setter stays undefined and dismiss/save calls silently fail.
          existing = {
            apiVersion: 'v1',
            data: {},
            kind: 'ConfigMap',
            metadata: {
              name: cmName,
              namespace: cmNs,
              resourceVersion: '1',
              uid: `cm-auto-${Buffer.from(key).toString('hex').slice(0, 12)}`,
            },
          };
          configMapStore.set(key, existing);
        }
        sendEvent(ws, 'ADDED', existing);

        // Push MODIFIED events whenever this ConfigMap is mutated (PATCH/PUT/POST).
        // This keeps the Console SDK's Redux store in sync without a page reload,
        // which stops applyMissingFeatures from being called on every render and
        // ensures user-settings (tour dismiss, etc.) persist in the current session.
        const onCmUpdate = (updatedKey: string, updatedCm: Record<string, unknown>) => {
          if (updatedKey === key && ws.readyState === WebSocket.OPEN) {
            sendEvent(ws, 'MODIFIED', updatedCm);
          }
        };
        cmUpdateEmitter.on('update', onCmUpdate);
        ws.on('close', () => cmUpdateEmitter.removeListener('update', onCmUpdate));
      } else {
        // Watch all ConfigMaps in namespace
        configMapStore.forEach((cm, k) => {
          if (k.startsWith(`${cmNs}/`)) sendEvent(ws, 'ADDED', cm);
        });
      }
      sendEvent(ws, 'BOOKMARK', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { resourceVersion: String(s.version) } });
      ws.on('close', () => { /* nothing */ });
      return;
    }

    // ── Determine what kind/namespace we're watching ──────────────────────────
    // 'all-namespaces' is an OpenShift UI convention meaning "no namespace filter".
    // name is set for single-object watches (detail page, useVMI, etc.) —
    // either from the named-resource URL path OR from fieldSelector=metadata.name=<n>.
    type WatchTarget = { kind: string; name?: string; namespace?: string };

    // Extract name from fieldSelector query param (used by Console SDK for single-object watches)
    const fieldSel = query.get('fieldSelector') ?? '';
    const fieldSelNameMatch = fieldSel.match(/metadata\.name=([^&,]+)/);
    const fieldSelName = fieldSelNameMatch ? decodeURIComponent(fieldSelNameMatch[1]) : undefined;

    function nsFilter(raw: string): string | undefined {
      return raw === 'all-namespaces' ? undefined : raw;
    }

    function target(): WatchTarget | null {
      // cluster-scoped VMs
      if (pathname === '/apis/kubevirt.io/v1/virtualmachines') return { kind: 'VirtualMachine', name: fieldSelName };
      // namespace-scoped VMs (including 'all-namespaces')
      const nsVm = pathname.match(/^\/apis\/kubevirt\.io\/v1\/namespaces\/([^/]+)\/virtualmachines$/);
      if (nsVm) return { kind: 'VirtualMachine', name: fieldSelName, namespace: nsFilter(nsVm[1]) };
      // single named VM from URL path — detail page when SDK uses named-resource path
      const nsVmSingle = pathname.match(/^\/apis\/kubevirt\.io\/v1\/namespaces\/([^/]+)\/virtualmachines\/([^/]+)$/);
      if (nsVmSingle) return { kind: 'VirtualMachine', name: nsVmSingle[2], namespace: nsFilter(nsVmSingle[1]) };
      // cluster-scoped VMIs
      if (pathname === '/apis/kubevirt.io/v1/virtualmachineinstances') return { kind: 'VirtualMachineInstance', name: fieldSelName };
      // namespace-scoped VMIs (including 'all-namespaces')
      const nsVmi = pathname.match(/^\/apis\/kubevirt\.io\/v1\/namespaces\/([^/]+)\/virtualmachineinstances$/);
      if (nsVmi) return { kind: 'VirtualMachineInstance', name: fieldSelName, namespace: nsFilter(nsVmi[1]) };
      // single named VMI from URL path
      const nsVmiSingle = pathname.match(/^\/apis\/kubevirt\.io\/v1\/namespaces\/([^/]+)\/virtualmachineinstances\/([^/]+)$/);
      if (nsVmiSingle) return { kind: 'VirtualMachineInstance', name: nsVmiSingle[2], namespace: nsFilter(nsVmiSingle[1]) };
      // Namespaces
      if (pathname === '/api/v1/namespaces') return { kind: 'Namespace' };
      // OpenShift Projects (useProjects hook — same shape as Namespace, different kind)
      if (pathname === '/apis/project.openshift.io/v1/projects') return { kind: 'Project' };
      // Nodes
      if (pathname === '/api/v1/nodes') return { kind: 'Node' };
      // ACM ManagedClusters — both 'cluster.' (standard) and 'clusterview.' (RBAC-view) API groups
      // The @stolostron/multicluster-sdk uses 'clusterview.open-cluster-management.io' internally
      if (pathname === '/apis/cluster.open-cluster-management.io/v1/managedclusters') return { kind: 'ManagedCluster' };
      if (pathname === '/apis/clusterview.open-cluster-management.io/v1/managedclusters') return { kind: 'ManagedCluster' };
      // Everything else: send a BOOKMARK then keep the connection open silently
      return null;
    }

    const t = target();

    if (!t) {
      // Unknown watch target — send a BOOKMARK so the SDK considers it resolved
      const bookmark = { type: 'BOOKMARK', object: { apiVersion: 'v1', kind: 'Status', metadata: { resourceVersion: String(s.version) } } };
      sendEvent(ws, bookmark.type, bookmark.object);
      ws.on('close', () => { /* nothing */ });
      return;
    }

    // ── Send initial ADDED burst ──────────────────────────────────────────────
    let initItems: (VirtualMachine | VirtualMachineInstance | Record<string, unknown>)[] = [];
    if (t.kind === 'VirtualMachine') {
      if (t.name && t.namespace) {
        // Single-object watch: send only that VM
        const vm = store.getVM(clusterName, t.namespace, t.name);
        if (vm) initItems = [vm];
      } else {
        initItems = Array.from(s.data.vms.values());
      }
    } else if (t.kind === 'VirtualMachineInstance') {
      if (t.name && t.namespace) {
        const vmi = store.getVMI(clusterName, t.namespace, t.name);
        if (vmi) initItems = [vmi];
      } else {
        initItems = Array.from(s.data.vmis.values());
      }
    } else if (t.kind === 'Namespace') {
      initItems = s.data.namespaces as unknown as Record<string, unknown>[];
    } else if (t.kind === 'Project') {
      // OpenShift Projects mirror Namespaces
      initItems = s.data.namespaces.map((ns) => ({
        ...ns,
        apiVersion: 'project.openshift.io/v1',
        kind: 'Project',
      })) as unknown as Record<string, unknown>[];
    } else if (t.kind === 'Node') {
      initItems = s.data.nodes as unknown as Record<string, unknown>[];
    } else if (t.kind === 'ManagedCluster') {
      // ManagedCluster is cluster-scoped — serve all configured clusters.
      // The addon-cluster-proxy label is required by useFleetClusterNames() to show
      // clusters in the fleet tree view.
      // Use the apiGroup matching the watch URL (cluster. vs clusterview.) so the
      // Console SDK's model registry matches correctly.
      const mcGroup = pathname.includes('clusterview.') ? 'clusterview.open-cluster-management.io' : 'cluster.open-cluster-management.io';
      initItems = store.allClusterNames().map((name) => ({
        apiVersion: `${mcGroup}/v1`,
        kind: 'ManagedCluster',
        metadata: {
          creationTimestamp: '2024-01-01T00:00:00Z',
          labels: {
            'cloud': 'Amazon',
            'cluster.open-cluster-management.io/clusterset': 'default',
            'feature.open-cluster-management.io/addon-cluster-proxy': 'available',
            ...(name === (store.allClusterNames()[0] ?? 'local-cluster') ? { 'local-cluster': 'true' } : {}),
            'vendor': 'OpenShift',
          },
          name,
          resourceVersion: '1',
          uid: `mc-${name}-mock-uid`,
        },
        spec: { hubAcceptsClient: true, leaseDurationSeconds: 60 },
        status: {
          allocatable: { cpu: '64', memory: '256Gi' },
          capacity: { cpu: '64', memory: '256Gi' },
          clusterClaims: [
            {
              name: 'consoleurl.cluster.open-cluster-management.io',
              value: name === 'local-cluster' ? 'https://localhost:9000' : `https://${name}.mock.example.com`,
            },
            { name: 'id.k8s.io', value: `${name}-id` },
            { name: 'platform.open-cluster-management.io', value: 'AWS' },
            { name: 'product.open-cluster-management.io', value: 'OpenShift' },
          ],
          conditions: [
            { lastTransitionTime: '2024-01-01T00:00:00Z', message: 'Managed cluster joined hub', reason: 'ManagedClusterJoined', status: 'True', type: 'ManagedClusterJoined' },
            { lastTransitionTime: '2024-01-01T00:00:00Z', message: 'Managed cluster is available', reason: 'ManagedClusterAvailable', status: 'True', type: 'ManagedClusterConditionAvailable' },
          ],
          version: { kubernetes: 'v1.30.0' },
        },
      }));
    }

    // For list watches, apply namespace filter (single-object watches already scoped above)
    if (!t.name && t.namespace) {
      initItems = (initItems as Array<{ metadata: { namespace?: string } }>)
        .filter((item) => item.metadata.namespace === t.namespace) as typeof initItems;
    }

    for (const item of initItems) {
      sendEvent(ws, 'ADDED', item);
    }

    // Send BOOKMARK so the SDK knows the initial list is complete
    sendEvent(ws, 'BOOKMARK', {
      apiVersion: 'v1',
      kind: t.kind,
      metadata: { resourceVersion: String(s.version) },
    });

    // ── Subscribe to live events ──────────────────────────────────────────────
    const unsubscribe = store.onWatchEvent(clusterName, t.kind, (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const obj = event.object as { metadata?: { name?: string; namespace?: string } };
      // For single-object watches, filter to only the named resource
      if (t.name && obj.metadata?.name !== t.name) return;
      if (t.namespace && obj.metadata?.namespace !== t.namespace) return;
      sendEvent(ws, event.type, event.object);
    });

    ws.on('close', () => unsubscribe());
    ws.on('error', () => unsubscribe());
  }
}

// ── Start HTTPS server ───────────────────────────────────────────────────────

const { cert, key } = getTlsCert();
const port = config.server.port;

const server = https.createServer({ cert, key, rejectUnauthorized: false }, app);

// Increase header timeout for long-running watch streams
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

attachWatchWebSocketServer(server);

server.listen(port, () => {
  console.log('');
  console.log('  KubeVirt Mock API Server');
  console.log('  ─────────────────────────────────────────');
  console.log(`  K8s + Prometheus API:  https://localhost:${port}`);
  console.log(`  Clusters loaded:       ${store.allClusterNames().join(', ')}`);

  let totalVMs = 0;
  for (const name of store.allClusterNames()) {
    const s = store.getStore(name);
    if (s) totalVMs += s.data.vms.size;
  }
  console.log(`  Total VMs generated:   ${totalVMs}`);
  console.log('');
  console.log('  BRIDGE env vars for start-console-mock.sh:');
  console.log(`    BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT=https://localhost:${port}`);
  console.log(`    BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS=https://localhost:${port}/thanos`);
  console.log(`    BRIDGE_K8S_MODE_OFF_CLUSTER_ALERTMANAGER=https://localhost:${port}`);
  console.log('');

  if (config.server.ui) {
    startControlUI(port);
  } else {
    console.log('  Control panel UI: disabled (pass --ui to enable)');
    console.log('');
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  ERROR: Port ${port} is already in use. Change server.port in config.json.`);
  } else {
    console.error('  Server error:', err);
  }
  process.exit(1);
});
