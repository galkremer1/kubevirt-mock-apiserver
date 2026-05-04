import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { MockConfig } from './config';
import { GeneratedData, VirtualMachine, VirtualMachineInstance, generateClusterData } from './generator';

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface WatchEvent {
  type: WatchEventType;
  object: Record<string, unknown>;
}

export interface ResourceStore {
  data: GeneratedData;
  /** Increment on every mutation; used as resourceVersion. */
  version: number;
}

// ── Persistent VM mutations ────────────────────────────────────────────────────
// VM state changes (start/stop/pause/etc.) are kept here so they survive mock
// server restarts.  null means the VM was deleted.
type VMmutationMap = Record<string, VirtualMachine | null>;   // vmKey → VM | null
type MutationsFile = Record<string, VMmutationMap>;           // clusterName → vmKey → VM | null

const MUTATIONS_FILE = path.join(__dirname, '..', '..', '.vm-mutations.json');
let savePending: ReturnType<typeof setTimeout> | null = null;

function loadVMMutations(): MutationsFile {
  try {
    const raw = fs.readFileSync(MUTATIONS_FILE, 'utf-8');
    return JSON.parse(raw) as MutationsFile;
  } catch {
    return {};
  }
}

function saveVMMutations(mutations: MutationsFile): void {
  // Debounce: coalesce rapid mutations into a single write after 500ms.
  if (savePending) clearTimeout(savePending);
  savePending = setTimeout(() => {
    try {
      fs.writeFileSync(MUTATIONS_FILE, JSON.stringify(mutations, null, 2), 'utf-8');
    } catch {
      // best-effort
    }
    savePending = null;
  }, 500);
}

export class MockStore extends EventEmitter {
  private stores: Map<string, ResourceStore> = new Map();
  private mutations: MutationsFile;

  constructor(config: MockConfig) {
    super();
    this.setMaxListeners(500);
    this.mutations = loadVMMutations();
    for (const clusterCfg of config.clusters) {
      const data = generateClusterData(clusterCfg, config.seed);
      // Apply any persisted mutations on top of freshly-generated data
      const clusterMutations = this.mutations[clusterCfg.name] ?? {};
      for (const [key, vm] of Object.entries(clusterMutations)) {
        if (vm === null) {
          data.vms.delete(key);
          data.vmis.delete(key);
        } else {
          data.vms.set(key, vm);
        }
      }
      this.stores.set(clusterCfg.name, { data, version: 1000 });
    }
  }

  getStore(clusterName: string): ResourceStore | undefined {
    return this.stores.get(clusterName);
  }

  allClusterNames(): string[] {
    return Array.from(this.stores.keys());
  }

  /** Emit a watch event on `<clusterName>/<kind>` channel. */
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  private bumpVersion(clusterName: string): string {
    const store = this.stores.get(clusterName);
    if (!store) return '0';
    store.version += 1;
    return String(store.version);
  }

  private watchChannel(clusterName: string, kind: string): string {
    return `watch:${clusterName}:${kind}`;
  }

  private publish(clusterName: string, kind: string, event: WatchEvent): void {
    this.emit(this.watchChannel(clusterName, kind), event);
  }

  onWatchEvent(clusterName: string, kind: string, cb: (event: WatchEvent) => void): () => void {
    const channel = this.watchChannel(clusterName, kind);
    this.on(channel, cb);
    return () => this.off(channel, cb);
  }

  // ── VM mutations ──────────────────────────────────────────────────────────

  getVM(clusterName: string, namespace: string, name: string): VirtualMachine | undefined {
    return this.stores.get(clusterName)?.data.vms.get(`${namespace}/${name}`);
  }

  setVM(clusterName: string, namespace: string, vm: VirtualMachine, eventType: WatchEventType): void {
    const store = this.stores.get(clusterName);
    if (!store) return;
    const rv = this.bumpVersion(clusterName);
    vm.metadata.resourceVersion = rv;
    const key = `${vm.metadata.namespace}/${vm.metadata.name}`;
    store.data.vms.set(key, vm);
    // Persist mutation
    if (!this.mutations[clusterName]) this.mutations[clusterName] = {};
    this.mutations[clusterName][key] = vm;
    saveVMMutations(this.mutations);
    this.publish(clusterName, 'VirtualMachine', { object: vm as unknown as Record<string, unknown>, type: eventType });
  }

  deleteVM(clusterName: string, namespace: string, name: string): boolean {
    const store = this.stores.get(clusterName);
    if (!store) return false;
    const key = `${namespace}/${name}`;
    const vm = store.data.vms.get(key);
    if (!vm) return false;
    store.data.vms.delete(key);
    store.data.vmis.delete(key);
    // Persist deletion
    if (!this.mutations[clusterName]) this.mutations[clusterName] = {};
    this.mutations[clusterName][key] = null;
    saveVMMutations(this.mutations);
    this.publish(clusterName, 'VirtualMachine', { object: vm as unknown as Record<string, unknown>, type: 'DELETED' });
    return true;
  }

  getVMI(clusterName: string, namespace: string, name: string): VirtualMachineInstance | undefined {
    return this.stores.get(clusterName)?.data.vmis.get(`${namespace}/${name}`);
  }

  setVMI(
    clusterName: string,
    namespace: string,
    vmi: VirtualMachineInstance,
    eventType: WatchEventType,
  ): void {
    const store = this.stores.get(clusterName);
    if (!store) return;
    const rv = this.bumpVersion(clusterName);
    vmi.metadata.resourceVersion = rv;
    store.data.vmis.set(`${vmi.metadata.namespace}/${vmi.metadata.name}`, vmi);
    this.publish(clusterName, 'VirtualMachineInstance', {
      object: vmi as unknown as Record<string, unknown>,
      type: eventType,
    });
  }

  deleteVMI(clusterName: string, namespace: string, name: string): void {
    const store = this.stores.get(clusterName);
    if (!store) return;
    const key = `${namespace}/${name}`;
    const vmi = store.data.vmis.get(key);
    if (!vmi) return;
    store.data.vmis.delete(key);
    this.publish(clusterName, 'VirtualMachineInstance', {
      object: vmi as unknown as Record<string, unknown>,
      type: 'DELETED',
    });
  }

  // ── Simulated controller reactions ───────────────────────────────────────

  simulateStart(clusterName: string, namespace: string, name: string): void {
    const vm = this.getVM(clusterName, namespace, name);
    if (!vm) return;

    const updated = deepClone(vm);
    updated.spec.runStrategy = 'Always';
    updated.status.printableStatus = 'Starting';
    updated.status.ready = false;
    this.setVM(clusterName, namespace, updated, 'MODIFIED');

    setTimeout(() => {
      const latest = this.getVM(clusterName, namespace, name);
      if (!latest || latest.status.printableStatus !== 'Starting') return;
      const running = deepClone(latest);
      running.spec.runStrategy = 'Always';
      running.status.printableStatus = 'Running';
      running.status.ready = true;
      this.setVM(clusterName, namespace, running, 'MODIFIED');

      // Create VMI
      const store = this.stores.get(clusterName);
      if (!store) return;
      const nodes = store.data.nodes;
      const nodeIdx = Math.floor(Math.random() * nodes.length);
      const vmi: VirtualMachineInstance = {
        apiVersion: 'kubevirt.io/v1',
        kind: 'VirtualMachineInstance',
        metadata: {
          creationTimestamp: new Date().toISOString(),
          labels: { 'kubevirt.io/domain': name, 'vm.kubevirt.io/name': name },
          name,
          namespace,
          resourceVersion: '0',
          uid: `vmi-${name}-${Date.now()}`,
        },
        spec: { domain: running.spec.template.spec.domain },
        status: {
          interfaces: [{ ipAddress: `10.128.0.${Math.floor(Math.random() * 254) + 1}`, name: 'default' }],
          nodeName: nodes[nodeIdx]?.metadata.name,
          phase: 'Running',
        },
      };
      this.setVMI(clusterName, namespace, vmi, 'ADDED');
    }, 1500 + Math.random() * 1500);
  }

  simulateStop(clusterName: string, namespace: string, name: string): void {
    const vm = this.getVM(clusterName, namespace, name);
    if (!vm) return;

    const stopping = deepClone(vm);
    stopping.status.printableStatus = 'Stopping';
    stopping.status.ready = false;
    this.setVM(clusterName, namespace, stopping, 'MODIFIED');

    setTimeout(() => {
      const latest = this.getVM(clusterName, namespace, name);
      if (!latest || latest.status.printableStatus !== 'Stopping') return;
      const stopped = deepClone(latest);
      stopped.status.printableStatus = 'Stopped';
      stopped.spec.runStrategy = 'Halted';
      this.setVM(clusterName, namespace, stopped, 'MODIFIED');
      this.deleteVMI(clusterName, namespace, name);
    }, 1000 + Math.random() * 1000);
  }

  simulateMigrate(clusterName: string, namespace: string, name: string): void {
    const vm = this.getVM(clusterName, namespace, name);
    if (!vm) return;

    const migrating = deepClone(vm);
    migrating.status.printableStatus = 'Migrating';
    this.setVM(clusterName, namespace, migrating, 'MODIFIED');

    setTimeout(() => {
      const latest = this.getVM(clusterName, namespace, name);
      if (!latest || latest.status.printableStatus !== 'Migrating') return;
      const running = deepClone(latest);
      running.status.printableStatus = 'Running';
      this.setVM(clusterName, namespace, running, 'MODIFIED');
    }, 3000 + Math.random() * 2000);
  }

  simulateCrash(clusterName: string, namespace: string, name: string): void {
    const vm = this.getVM(clusterName, namespace, name);
    if (!vm) return;
    const crashed = deepClone(vm);
    crashed.status.printableStatus = 'CrashLoopBackOff';
    crashed.status.ready = false;
    this.setVM(clusterName, namespace, crashed, 'MODIFIED');
  }

  simulateCreate(clusterName: string, namespace: string, vm: VirtualMachine): void {
    const provisioning = deepClone(vm);
    provisioning.spec.runStrategy = 'Halted';
    provisioning.status = { conditions: [], printableStatus: 'Provisioning', ready: false };
    this.setVM(clusterName, namespace, provisioning, 'ADDED');

    setTimeout(() => {
      const latest = this.getVM(clusterName, namespace, vm.metadata.name);
      if (!latest || latest.status.printableStatus !== 'Provisioning') return;
      const stopped = deepClone(latest);
      stopped.spec.runStrategy = 'Halted';
      stopped.status.printableStatus = 'Stopped';
      stopped.status.ready = false;
      this.setVM(clusterName, namespace, stopped, 'MODIFIED');
    }, 2000);
  }

  // ── Snapshot for /control/state ──────────────────────────────────────────

  getStatusCounts(clusterName: string): Record<string, number> {
    const store = this.stores.get(clusterName);
    if (!store) return {};
    const counts: Record<string, number> = {};
    for (const vm of store.data.vms.values()) {
      const s = vm.status.printableStatus;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }

  getAllVMsForCluster(clusterName: string): VirtualMachine[] {
    return Array.from(this.stores.get(clusterName)?.data.vms.values() ?? []);
  }

  getAllVMIsForCluster(clusterName: string): VirtualMachineInstance[] {
    return Array.from(this.stores.get(clusterName)?.data.vmis.values() ?? []);
  }

  resetCluster(clusterName: string, config: MockConfig): void {
    const clusterCfg = config.clusters.find((c) => c.name === clusterName);
    if (!clusterCfg) return;
    const data = generateClusterData(clusterCfg, config.seed);
    const store = this.stores.get(clusterName);
    if (!store) return;

    // Emit DELETED for all current VMs
    for (const vm of store.data.vms.values()) {
      this.publish(clusterName, 'VirtualMachine', {
        object: vm as unknown as Record<string, unknown>,
        type: 'DELETED',
      });
    }

    store.data = data;
    store.version = 1000;

    // Clear persisted mutations for this cluster
    delete this.mutations[clusterName];
    saveVMMutations(this.mutations);

    // Emit ADDED for all new VMs
    for (const vm of data.vms.values()) {
      this.publish(clusterName, 'VirtualMachine', {
        object: vm as unknown as Record<string, unknown>,
        type: 'ADDED',
      });
    }
  }
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}
