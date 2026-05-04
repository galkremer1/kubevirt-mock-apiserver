import { ClusterConfig } from './config';

// Minimal K8s types (no external kubevirt-api dependency needed in the mock server)
export interface K8sObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  cluster?: string;
}

export interface VMSpec {
  runStrategy: 'Always' | 'Halted' | 'Manual' | 'RerunOnFailure';
  template: {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
    spec: {
      domain: {
        cpu: { cores: number; sockets: number; threads: number };
        devices: {
          disks: Array<{ name: string; disk: { bus: string }; bootOrder?: number }>;
          interfaces: Array<{ name: string; masquerade: Record<string, unknown>; model: string }>;
        };
        firmware?: { bootloader?: Record<string, unknown> };
        resources: { requests: { memory: string } };
      };
      networks: Array<{ name: string; pod: Record<string, unknown> }>;
      volumes: Array<Record<string, unknown>>;
      terminationGracePeriodSeconds: number;
    };
  };
}

export interface VMStatus {
  printableStatus: string;
  ready?: boolean;
  conditions?: Array<{ type: string; status: string }>;
}

export interface VirtualMachine {
  apiVersion: 'kubevirt.io/v1';
  kind: 'VirtualMachine';
  metadata: K8sObjectMeta;
  spec: VMSpec;
  status: VMStatus;
}

export interface VirtualMachineInstance {
  apiVersion: 'kubevirt.io/v1';
  kind: 'VirtualMachineInstance';
  metadata: K8sObjectMeta;
  spec: { domain: VMSpec['template']['spec']['domain'] };
  status: {
    phase: 'Running' | 'Pending' | 'Scheduling' | 'Scheduled' | 'Failed' | 'Succeeded';
    nodeName?: string;
    interfaces?: Array<{ name: string; ipAddress?: string }>;
  };
}

export interface Namespace {
  apiVersion: 'v1';
  kind: 'Namespace';
  metadata: K8sObjectMeta;
  status: { phase: 'Active' };
}

export interface Node {
  apiVersion: 'v1';
  kind: 'Node';
  metadata: K8sObjectMeta;
  status: {
    capacity: { cpu: string; memory: string };
    allocatable: { cpu: string; memory: string };
    conditions: Array<{ type: string; status: string }>;
  };
}

export interface DataVolume {
  apiVersion: 'cdi.kubevirt.io/v1beta1';
  kind: 'DataVolume';
  metadata: K8sObjectMeta;
  spec: { source: { registry: { url: string } }; storage: { resources: { requests: { storage: string } } } };
  status: { phase: 'Succeeded' };
}

const OS_TYPES = ['rhel9', 'rhel8', 'fedora', 'centos-stream9', 'ubuntu', 'windows-server-2022'];
const MEMORY_SIZES = ['512Mi', '1Gi', '2Gi', '4Gi', '8Gi', '16Gi'];
const CPU_CORES = [1, 2, 4, 8];
const RUN_STRATEGIES: VMSpec['runStrategy'][] = ['Always', 'Halted', 'Manual', 'RerunOnFailure'];

/** Simple deterministic pseudo-random number generator (mulberry32). */
function makePrng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pickStatus(rand: () => number, dist: { Running?: number; Stopped?: number; Paused?: number }): string {
  const r = rand();
  const running = dist.Running ?? 0.6;
  const stopped = dist.Stopped ?? 0.3;
  if (r < running) return 'Running';
  if (r < running + stopped) return 'Stopped';
  return 'Paused';
}

function runStrategyForStatus(status: string): VMSpec['runStrategy'] {
  if (status === 'Running') return 'Always';
  if (status === 'Stopped') return 'Halted';
  return 'Manual';
}

function makeUid(clusterName: string, namespace: string, name: string): string {
  // Deterministic UID-like string
  const raw = `${clusterName}/${namespace}/${name}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = Math.imul(31, hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  const h = Math.abs(hash).toString(16).padStart(8, '0');
  return `${h.slice(0, 8)}-${h.slice(0, 4)}-4${h.slice(1, 4)}-8${h.slice(2, 5)}-${h.padEnd(12, '0').slice(0, 12)}`;
}

export interface GeneratedData {
  vms: Map<string, VirtualMachine>; // key: `${namespace}/${name}`
  vmis: Map<string, VirtualMachineInstance>;
  namespaces: Namespace[];
  nodes: Node[];
  datavolumes: Map<string, DataVolume>;
  clusterName: string;
}

export function generateClusterData(cluster: ClusterConfig, globalSeed: number): GeneratedData {
  const rand = makePrng(globalSeed + hashString(cluster.name));
  const vms = new Map<string, VirtualMachine>();
  const vmis = new Map<string, VirtualMachineInstance>();
  const namespaces: Namespace[] = [];
  const datavolumes = new Map<string, DataVolume>();
  const dist = cluster.statusDistribution ?? { Paused: 0.1, Running: 0.6, Stopped: 0.3 };

  // Generate nodes (one per ~50 VMs, minimum 3)
  const totalVMs = cluster.namespaces * cluster.vmsPerNamespace;
  const nodeCount = Math.max(3, Math.ceil(totalVMs / 50));
  const nodes: Node[] = Array.from({ length: nodeCount }, (_, i) => {
    const nodeName = `node-${String(i + 1).padStart(3, '0')}`;
    return {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        creationTimestamp: '2024-01-01T00:00:00Z',
        name: nodeName,
        resourceVersion: '1',
        uid: makeUid(cluster.name, 'nodes', nodeName),
      },
      status: {
        allocatable: { cpu: '31', memory: '125829120Ki' },
        capacity: { cpu: '32', memory: '131072000Ki' },
        conditions: [{ status: 'True', type: 'Ready' }],
      },
    };
  });

  // System namespaces required by the plugin.
  // resolveOperatorNamespace() inspects the project list for these names to
  // determine which namespace hosts the kubevirt-user-settings ConfigMap.
  // Including 'kubevirt-os-images' makes it resolve to 'kubevirt-hyperconverged'.
  const SYSTEM_NAMESPACES = [
    'kubevirt-hyperconverged',
    'kubevirt-os-images',
    'openshift-cnv',
    'openshift-virtualization-os-images',
  ];

  for (const sysNs of SYSTEM_NAMESPACES) {
    namespaces.push({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        creationTimestamp: '2024-01-01T00:00:00Z',
        labels: { 'kubernetes.io/metadata.name': sysNs },
        name: sysNs,
        resourceVersion: '1',
        uid: makeUid(cluster.name, 'namespaces', sysNs),
      },
      status: { phase: 'Active' },
    });
  }

  for (let nsIdx = 0; nsIdx < cluster.namespaces; nsIdx++) {
    const nsName = `namespace-${String(nsIdx + 1).padStart(3, '0')}`;

    namespaces.push({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        creationTimestamp: '2024-01-01T00:00:00Z',
        name: nsName,
        resourceVersion: '1',
        uid: makeUid(cluster.name, 'namespaces', nsName),
      },
      status: { phase: 'Active' },
    });

    for (let vmIdx = 0; vmIdx < cluster.vmsPerNamespace; vmIdx++) {
      const vmName = `vm-${String(vmIdx + 1).padStart(4, '0')}`;
      const osType = pickRandom(OS_TYPES, rand);
      const memSize = pickRandom(MEMORY_SIZES, rand);
      const cpuCores = pickRandom(CPU_CORES, rand);
      const status = pickStatus(rand, dist);
      const runStrategy = runStrategyForStatus(status);
      const uid = makeUid(cluster.name, nsName, vmName);
      const key = `${nsName}/${vmName}`;

      const vm: VirtualMachine = {
        apiVersion: 'kubevirt.io/v1',
        kind: 'VirtualMachine',
        metadata: {
          annotations: {
            'vm.kubevirt.io/os': osType,
          },
          creationTimestamp: '2024-01-15T10:00:00Z',
          labels: {
            app: vmName,
            [`os.template.kubevirt.io/${osType}`]: 'true',
            'workload.template.kubevirt.io/server': 'true',
          },
          name: vmName,
          namespace: nsName,
          resourceVersion: '100',
          uid,
        },
        spec: {
          runStrategy,
          template: {
            metadata: {
              labels: {
                [`kubevirt.io/domain`]: vmName,
                [`vm.kubevirt.io/name`]: vmName,
              },
            },
            spec: {
              domain: {
                cpu: { cores: cpuCores, sockets: 1, threads: 1 },
                devices: {
                  disks: [
                    { bootOrder: 1, disk: { bus: 'virtio' }, name: 'rootdisk' },
                    { disk: { bus: 'virtio' }, name: 'cloudinitdisk' },
                  ],
                  interfaces: [{ masquerade: {}, model: 'virtio', name: 'default' }],
                },
                // firmware must be present (even if empty) — getVMIBootLoader
                // accesses firmware.bootloader without optional chaining
                firmware: {},
                resources: { requests: { memory: memSize } },
              },
              networks: [{ name: 'default', pod: {} }],
              terminationGracePeriodSeconds: 180,
              volumes: [
                { dataVolume: { name: `${vmName}-rootdisk` }, name: 'rootdisk' },
                { cloudInitNoCloud: { userData: '#cloud-config\nuser: cloud-user\n' }, name: 'cloudinitdisk' },
              ],
            },
          },
        },
        status: {
          conditions: [],   // required — restartRequired() calls .some() on this
          printableStatus: status,
          ready: status === 'Running',
        },
      };

      vms.set(key, vm);

      // Create a VMI for running VMs
      if (status === 'Running' || status === 'Paused') {
        const nodeIdx = Math.floor(rand() * nodes.length);
        const vmi: VirtualMachineInstance = {
          apiVersion: 'kubevirt.io/v1',
          kind: 'VirtualMachineInstance',
          metadata: {
            creationTimestamp: '2024-01-15T10:01:00Z',
            labels: { [`kubevirt.io/domain`]: vmName, [`vm.kubevirt.io/name`]: vmName },
            name: vmName,
            namespace: nsName,
            resourceVersion: '200',
            uid: makeUid(cluster.name, `${nsName}/vmis`, vmName),
          },
          spec: { domain: vm.spec.template.spec.domain },
          status: {
            interfaces: [{ ipAddress: `10.128.${nsIdx}.${vmIdx + 1}`, name: 'default' }],
            nodeName: nodes[nodeIdx].metadata.name,
            phase: status === 'Running' ? 'Running' : 'Scheduled',
          },
        };
        vmis.set(key, vmi);
      }

      // DataVolume
      const dvKey = `${nsName}/${vmName}-rootdisk`;
      const dv: DataVolume = {
        apiVersion: 'cdi.kubevirt.io/v1beta1',
        kind: 'DataVolume',
        metadata: {
          creationTimestamp: '2024-01-15T09:55:00Z',
          name: `${vmName}-rootdisk`,
          namespace: nsName,
          resourceVersion: '50',
          uid: makeUid(cluster.name, `${nsName}/dvs`, `${vmName}-rootdisk`),
        },
        spec: {
          source: { registry: { url: `docker://registry.redhat.io/${osType}/rhel-guest-image` } },
          storage: { resources: { requests: { storage: '20Gi' } } },
        },
        status: { phase: 'Succeeded' },
      };
      datavolumes.set(dvKey, dv);
    }
  }

  return { clusterName: cluster.name, datavolumes, namespaces, nodes, vmis, vms };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Produce a deterministic per-VM float in [min, max] using a seed derived from vmName. */
export function seededMetricValue(vmName: string, metricSuffix: string, min: number, max: number): number {
  const h = hashString(`${vmName}:${metricSuffix}`);
  return min + (h % 10000) / 10000 * (max - min);
}

/** Generate a Prometheus range time series for a single VM. */
export function generateTimeSeries(
  vmName: string,
  metricKey: string,
  start: number,
  end: number,
  step: number,
  min: number,
  max: number,
): [number, string][] {
  const base = seededMetricValue(vmName, metricKey, min, max);
  // Amplitude is 10% of the base value for natural variance
  const amplitude = (max - min) * 0.1;
  // Period ~10 minutes
  const period = 600;
  const result: [number, string][] = [];
  for (let t = start; t <= end; t += step) {
    const noise = amplitude * Math.sin((2 * Math.PI * t) / period + hashString(vmName) % 100);
    const value = Math.max(min, base + noise);
    result.push([t, value.toFixed(4)]);
  }
  return result;
}
