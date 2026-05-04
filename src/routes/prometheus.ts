import { Router, Request, Response } from 'express';
import { MockStore } from '../store';
import { seededMetricValue, generateTimeSeries } from '../generator';

export function createPrometheusRouter(store: MockStore): Router {
  const router = Router();

  // ── Instant query ──────────────────────────────────────────────────────────

  router.get('/api/v1/query', (req: Request, res: Response) => {
    handleInstantQuery(req, res, store);
  });

  router.post('/api/v1/query', (req: Request, res: Response) => {
    handleInstantQuery(req, res, store);
  });

  // ── Range query ────────────────────────────────────────────────────────────

  router.get('/api/v1/query_range', (req: Request, res: Response) => {
    handleRangeQuery(req, res, store);
  });

  router.post('/api/v1/query_range', (req: Request, res: Response) => {
    handleRangeQuery(req, res, store);
  });

  // ── Rules (alerts) ─────────────────────────────────────────────────────────

  router.get('/api/v1/rules', (_req: Request, res: Response) => {
    res.json({ data: { groups: [] }, status: 'success' });
  });

  // ── Metadata ───────────────────────────────────────────────────────────────

  router.get('/api/v1/metadata', (_req: Request, res: Response) => {
    res.json({ data: {}, status: 'success' });
  });

  // ── Labels ────────────────────────────────────────────────────────────────

  router.get('/api/v1/labels', (_req: Request, res: Response) => {
    res.json({ data: ['__name__', 'cluster', 'name', 'namespace', 'node'], status: 'success' });
  });

  return router;
}

// ── Query handlers ─────────────────────────────────────────────────────────

function handleInstantQuery(req: Request, res: Response, store: MockStore): void {
  const query = String(req.query.query ?? req.body?.query ?? '');
  const t = parseFloat(String(req.query.time ?? Date.now() / 1000));

  const result = synthesizeInstant(query, t, store);
  res.json({ data: { result, resultType: 'vector' }, status: 'success' });
}

function handleRangeQuery(req: Request, res: Response, store: MockStore): void {
  const query = String(req.query.query ?? req.body?.query ?? '');
  const start = parseFloat(String(req.query.start ?? Date.now() / 1000 - 3600));
  const end = parseFloat(String(req.query.end ?? Date.now() / 1000));
  const step = parseFloat(String(req.query.step ?? '60'));

  const result = synthesizeRange(query, start, end, step, store);
  res.json({ data: { result, resultType: 'matrix' }, status: 'success' });
}

// ── Metric synthesis ───────────────────────────────────────────────────────

interface MetricSpec {
  metric: string;
  min: number;
  max: number;
  perVM: boolean;
}

/** Map incoming PromQL to a metric spec by substring matching. */
function classifyQuery(query: string): MetricSpec {
  if (query.includes('kubevirt_vmi_cpu_usage')) {
    return { max: 4, metric: 'cpu', min: 0.01, perVM: true };
  }
  if (query.includes('kubevirt_vmi_memory_used')) {
    return { max: 8 * 1024 * 1024 * 1024, metric: 'mem', min: 256 * 1024 * 1024, perVM: true };
  }
  if (query.includes('kubevirt_vmi_network_receive')) {
    return { max: 100 * 1024 * 1024, metric: 'net_rx', min: 100, perVM: true };
  }
  if (query.includes('kubevirt_vmi_network_transmit')) {
    return { max: 50 * 1024 * 1024, metric: 'net_tx', min: 100, perVM: true };
  }
  if (query.includes('kubevirt_vmi_network')) {
    return { max: 150 * 1024 * 1024, metric: 'net', min: 200, perVM: true };
  }
  if (query.includes('kubevirt_vmi_storage_iops_read')) {
    return { max: 500, metric: 'iops_r', min: 1, perVM: true };
  }
  if (query.includes('kubevirt_vmi_storage_iops_write')) {
    return { max: 300, metric: 'iops_w', min: 1, perVM: true };
  }
  if (query.includes('kubevirt_vmi_storage_iops')) {
    return { max: 800, metric: 'iops', min: 2, perVM: true };
  }
  if (query.includes('kubevirt_vmi_storage_read_traffic') || query.includes('kubevirt_vmi_storage_write_traffic')) {
    return { max: 200 * 1024 * 1024, metric: 'disk_tput', min: 1024, perVM: true };
  }
  if (query.includes('kubevirt_vmi_storage')) {
    return { max: 50 * 1024 * 1024, metric: 'disk', min: 1024, perVM: true };
  }
  if (query.includes('kubevirt_vmi_filesystem_capacity')) {
    return { max: 50 * 1024 * 1024 * 1024, metric: 'fs_cap', min: 20 * 1024 * 1024 * 1024, perVM: true };
  }
  if (query.includes('kubevirt_vmi_filesystem_used')) {
    return { max: 30 * 1024 * 1024 * 1024, metric: 'fs_used', min: 2 * 1024 * 1024 * 1024, perVM: true };
  }
  if (query.includes('kubevirt_vmi_migration')) {
    return { max: 512 * 1024 * 1024, metric: 'migration', min: 0, perVM: true };
  }
  if (query.includes('kubevirt_vmi_vcpu_wait')) {
    return { max: 0.1, metric: 'vcpu_wait', min: 0, perVM: true };
  }
  if (query.includes('kubevirt_hco_system_health_status') || query.includes('kubevirt_hyperconverged_operator_health_status')) {
    return { max: 0, metric: 'health', min: 0, perVM: false };
  }
  if (query.includes('ALERTS')) {
    return { max: 0, metric: 'alerts', min: 0, perVM: false };
  }
  if (query.includes('node_cpu') || query.includes('instance:node_cpu')) {
    return { max: 0.9, metric: 'node_cpu', min: 0.1, perVM: false };
  }
  if (query.includes('node_memory')) {
    return { max: 0.85, metric: 'node_mem', min: 0.2, perVM: false };
  }
  if (query.includes('node_filesystem')) {
    return { max: 0.7, metric: 'node_fs', min: 0.1, perVM: false };
  }
  if (query.includes('kubevirt_vm') && query.includes('status')) {
    return { max: 1, metric: 'vm_status', min: 0, perVM: false };
  }
  // Default generic
  return { max: 100, metric: 'generic', min: 0, perVM: false };
}

/** Extract label matchers from a PromQL query string (regex-based, not a full parser). */
function extractLabels(query: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const matcher = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(query)) !== null) {
    labels[m[1]] = m[2];
  }
  return labels;
}

/** Return a topk-N count from a query, or 0 if not topk. */
function extractTopK(query: string): number {
  const m = /topk\((\d+)/i.exec(query);
  return m ? parseInt(m[1], 10) : 0;
}

function synthesizeInstant(query: string, t: number, store: MockStore): unknown[] {
  if (query.includes('ALERTS') || query === '') return [];

  const spec = classifyQuery(query);
  const labels = extractLabels(query);
  const clusterName = labels.cluster ?? store.allClusterNames()[0];
  const topK = extractTopK(query);

  if (!spec.perVM) {
    return synthesizeNodeOrGlobalInstant(spec, clusterName, store, t, labels);
  }

  return synthesizeVMInstant(spec, clusterName, store, t, labels, topK);
}

function synthesizeRange(query: string, start: number, end: number, step: number, store: MockStore): unknown[] {
  if (query.includes('ALERTS') || query === '') return [];

  const spec = classifyQuery(query);
  const labels = extractLabels(query);
  const clusterName = labels.cluster ?? store.allClusterNames()[0];
  const topK = extractTopK(query);

  if (!spec.perVM) {
    return synthesizeNodeOrGlobalRange(spec, clusterName, store, start, end, step, labels);
  }

  return synthesizeVMRange(spec, clusterName, store, start, end, step, labels, topK);
}

// ── Per-VM synthesis ─────────────────────────────────────────────────────

function getTargetVMs(store: MockStore, clusterName: string, labels: Record<string, string>) {
  const s = store.getStore(clusterName);
  if (!s) return [];

  let vms = Array.from(s.data.vms.values());
  // Only return metrics for Running / Paused VMs
  vms = vms.filter((vm) => ['Running', 'Paused'].includes(vm.status.printableStatus));

  if (labels.namespace) vms = vms.filter((vm) => vm.metadata.namespace === labels.namespace);
  if (labels.name) vms = vms.filter((vm) => vm.metadata.name === labels.name);
  return vms;
}

function synthesizeVMInstant(
  spec: MetricSpec,
  clusterName: string,
  store: MockStore,
  t: number,
  labels: Record<string, string>,
  topK: number,
): unknown[] {
  const vms = getTargetVMs(store, clusterName, labels);

  let results = vms.map((vm) => {
    const value = seededMetricValue(vm.metadata.name, spec.metric, spec.min, spec.max);
    return {
      metric: { cluster: clusterName, name: vm.metadata.name, namespace: vm.metadata.namespace },
      value: [t, value.toFixed(4)],
    };
  });

  if (topK > 0) {
    results = results.sort((a, b) => parseFloat(String(b.value[1])) - parseFloat(String(a.value[1]))).slice(0, topK);
  }

  return results;
}

function synthesizeVMRange(
  spec: MetricSpec,
  clusterName: string,
  store: MockStore,
  start: number,
  end: number,
  step: number,
  labels: Record<string, string>,
  topK: number,
): unknown[] {
  const vms = getTargetVMs(store, clusterName, labels);

  let results = vms.map((vm) => ({
    metric: { cluster: clusterName, name: vm.metadata.name, namespace: vm.metadata.namespace },
    values: generateTimeSeries(vm.metadata.name, spec.metric, start, end, step, spec.min, spec.max),
  }));

  if (topK > 0) {
    results = results
      .map((r) => ({ ...r, _avg: r.values.reduce((s, [, v]) => s + parseFloat(v), 0) / r.values.length }))
      .sort((a, b) => (b as { _avg: number })._avg - (a as { _avg: number })._avg)
      .slice(0, topK)
      .map(({ _avg: _omit, ...rest }) => rest as typeof results[0]);
  }

  return results;
}

// ── Node / global synthesis ───────────────────────────────────────────────

function synthesizeNodeOrGlobalInstant(
  spec: MetricSpec,
  clusterName: string,
  store: MockStore,
  t: number,
  labels: Record<string, string>,
): unknown[] {
  const s = store.getStore(clusterName);
  if (!s) return [];

  if (spec.metric === 'health' || spec.metric === 'alerts' || spec.metric === 'vm_status') {
    return [{ metric: { cluster: clusterName, ...labels }, value: [t, '0'] }];
  }

  const nodes = s.data.nodes;
  const targetNode = labels.instance ?? labels.node;
  const targetNodes = targetNode ? nodes.filter((n) => n.metadata.name === targetNode) : nodes;

  return targetNodes.map((node) => {
    const value = seededMetricValue(node.metadata.name, spec.metric, spec.min, spec.max);
    return {
      metric: { cluster: clusterName, instance: `${node.metadata.name}:9100`, node: node.metadata.name },
      value: [t, value.toFixed(4)],
    };
  });
}

function synthesizeNodeOrGlobalRange(
  spec: MetricSpec,
  clusterName: string,
  store: MockStore,
  start: number,
  end: number,
  step: number,
  labels: Record<string, string>,
): unknown[] {
  const s = store.getStore(clusterName);
  if (!s) return [];

  if (spec.metric === 'health' || spec.metric === 'alerts') {
    return [{ metric: { cluster: clusterName }, values: [[start, '0'], [end, '0']] }];
  }

  if (spec.metric === 'vm_status') {
    const running = Array.from(s.data.vms.values()).filter((v) => v.status.printableStatus === 'Running').length;
    return [{ metric: { cluster: clusterName, status: 'Running' }, values: generateTimeSeries('cluster', 'running', start, end, step, running * 0.8, running) }];
  }

  const nodes = s.data.nodes;
  const targetNode = labels.instance ?? labels.node;
  const targetNodes = targetNode ? nodes.filter((n) => n.metadata.name === targetNode) : nodes;

  return targetNodes.map((node) => ({
    metric: { cluster: clusterName, instance: `${node.metadata.name}:9100`, node: node.metadata.name },
    values: generateTimeSeries(node.metadata.name, spec.metric, start, end, step, spec.min, spec.max),
  }));
}
