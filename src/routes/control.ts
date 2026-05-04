import { Router, Request, Response } from 'express';
import { MockStore } from '../store';
import { VirtualMachine } from '../generator';
import { MockConfig } from '../config';

export function createControlRouter(store: MockStore, config: MockConfig): Router {
  const router = Router();

  // ── State query ────────────────────────────────────────────────────────────

  router.get('/state', (_req: Request, res: Response) => {
    const result: Record<string, Record<string, number>> = {};
    for (const clusterName of store.allClusterNames()) {
      result[clusterName] = store.getStatusCounts(clusterName);
    }
    res.json(result);
  });

  // ── Random lifecycle actions ───────────────────────────────────────────────

  router.post('/vms/start-random', (req: Request, res: Response) => {
    const count = parseInt(String(req.query.count ?? '1'), 10);
    const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);
    const affected = applyToRandom(store, clusterName, ['Stopped', 'Paused'], count, (vm) => {
      store.simulateStart(clusterName, vm.metadata.namespace!, vm.metadata.name);
    });
    res.json({ affected, cluster: clusterName, operation: 'start-random' });
  });

  router.post('/vms/stop-random', (req: Request, res: Response) => {
    const count = parseInt(String(req.query.count ?? '1'), 10);
    const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);
    const affected = applyToRandom(store, clusterName, ['Running', 'Paused'], count, (vm) => {
      store.simulateStop(clusterName, vm.metadata.namespace!, vm.metadata.name);
    });
    res.json({ affected, cluster: clusterName, operation: 'stop-random' });
  });

  router.post('/vms/pause-random', (req: Request, res: Response) => {
    const count = parseInt(String(req.query.count ?? '1'), 10);
    const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);
    const affected = applyToRandom(store, clusterName, ['Running'], count, (vm) => {
      const updated = deepClone(vm);
      updated.status.printableStatus = 'Paused';
      updated.status.ready = false;
      store.setVM(clusterName, vm.metadata.namespace!, updated, 'MODIFIED');
    });
    res.json({ affected, cluster: clusterName, operation: 'pause-random' });
  });

  router.post('/vms/migrate-random', (req: Request, res: Response) => {
    const count = parseInt(String(req.query.count ?? '1'), 10);
    const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);
    const affected = applyToRandom(store, clusterName, ['Running'], count, (vm) => {
      store.simulateMigrate(clusterName, vm.metadata.namespace!, vm.metadata.name);
    });
    res.json({ affected, cluster: clusterName, operation: 'migrate-random' });
  });

  router.post('/vms/crash-random', (req: Request, res: Response) => {
    const count = parseInt(String(req.query.count ?? '1'), 10);
    const clusterName = String(req.query.cluster ?? store.allClusterNames()[0]);
    const affected = applyToRandom(store, clusterName, ['Running'], count, (vm) => {
      store.simulateCrash(clusterName, vm.metadata.namespace!, vm.metadata.name);
    });
    res.json({ affected, cluster: clusterName, operation: 'crash-random' });
  });

  // ── Scenarios ──────────────────────────────────────────────────────────────

  router.post('/scenario', (req: Request, res: Response) => {
    const scenario = req.body?.scenario as string;
    const clusterName = String(req.body?.cluster ?? store.allClusterNames()[0]);
    const allVMs = store.getAllVMsForCluster(clusterName);

    switch (scenario) {
      case 'rolling-restart': {
        const running = allVMs.filter((v) => v.status.printableStatus === 'Running');
        let delay = 0;
        for (const vm of running) {
          setTimeout(() => {
            store.simulateStop(clusterName, vm.metadata.namespace!, vm.metadata.name);
            setTimeout(() => {
              store.simulateStart(clusterName, vm.metadata.namespace!, vm.metadata.name);
            }, 2500);
          }, delay);
          delay += 200;
        }
        res.json({ affected: running.length, cluster: clusterName, scenario });
        break;
      }
      case 'mass-stop': {
        const running = allVMs.filter((v) => v.status.printableStatus === 'Running');
        for (const vm of running) {
          store.simulateStop(clusterName, vm.metadata.namespace!, vm.metadata.name);
        }
        res.json({ affected: running.length, cluster: clusterName, scenario });
        break;
      }
      case 'mass-start': {
        const stopped = allVMs.filter((v) => ['Stopped', 'Paused'].includes(v.status.printableStatus));
        for (const vm of stopped) {
          store.simulateStart(clusterName, vm.metadata.namespace!, vm.metadata.name);
        }
        res.json({ affected: stopped.length, cluster: clusterName, scenario });
        break;
      }
      case 'storm': {
        // Rapid-fire MODIFIED events to every VM
        for (const vm of allVMs) {
          const updated = deepClone(vm);
          store.setVM(clusterName, vm.metadata.namespace!, updated, 'MODIFIED');
        }
        res.json({ affected: allVMs.length, cluster: clusterName, scenario });
        break;
      }
      default:
        res.status(400).json({ error: `Unknown scenario: ${scenario}. Valid: rolling-restart, mass-stop, mass-start, storm` });
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────────

  router.post('/reset', (req: Request, res: Response) => {
    const clusterName = String(req.query.cluster ?? req.body?.cluster ?? store.allClusterNames()[0]);
    store.resetCluster(clusterName, config);
    res.json({ cluster: clusterName, status: 'reset' });
  });

  return router;
}

function applyToRandom(
  store: MockStore,
  clusterName: string,
  fromStatuses: string[],
  count: number,
  action: (vm: VirtualMachine) => void,
): number {
  const candidates = store
    .getAllVMsForCluster(clusterName)
    .filter((vm) => fromStatuses.includes(vm.status.printableStatus));

  // Fisher-Yates shuffle of indices, take first `count`
  const indices = candidates.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const selected = indices.slice(0, count).map((i) => candidates[i]);
  for (const vm of selected) {
    action(vm);
  }
  return selected.length;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}
