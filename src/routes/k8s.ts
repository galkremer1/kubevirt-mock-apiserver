import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Router, Request, Response } from 'express';
import { MockStore } from '../store';
import { VirtualMachine, VirtualMachineInstance } from '../generator';

/**
 * Emitted whenever a ConfigMap is created or updated in the store.
 * Listeners receive (cmKey: string, updatedCM: Record<string, unknown>).
 * The WS handler in index.ts subscribes to this to push MODIFIED events.
 */
export const cmUpdateEmitter = new EventEmitter();

// Console bridge prepends /api/kubernetes/ to all k8s calls.
// We mount this router at both / and /api/kubernetes/ to handle both.

// ── Persistent ConfigMap store ────────────────────────────────────────────────
// User settings (tour dismissed, column prefs, etc.) are stored in ConfigMaps.
// We persist the store to disk so settings survive mock server restarts.
const STORE_FILE = path.join(__dirname, '..', '..', '.configmap-store.json');

function loadConfigMapStore(): Map<string, Record<string, unknown>> {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveConfigMapStore(): void {
  try {
    const obj: Record<string, Record<string, unknown>> = {};
    configMapStore.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch {
    // best-effort — ignore write errors
  }
}

export const configMapStore: Map<string, Record<string, unknown>> = loadConfigMapStore();

export function cmKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export function createK8sRouter(store: MockStore): Router {
  const router = Router();

  // ── Cluster-info / health endpoints the bridge calls on startup ───────────

  router.get('/version', (_req: Request, res: Response) => {
    res.json({ gitVersion: 'v1.30.0-mock', major: '1', minor: '30', platform: 'linux/amd64' });
  });

  router.get('/api', (_req: Request, res: Response) => {
    res.json({ apiVersion: 'v1', kind: 'APIVersions', versions: ['v1'] });
  });

  // Full API group list — the Console iterates every group here for model discovery.
  // Missing groups cause "Model does not exist" errors in the plugin SDK.
  router.get('/apis', (_req: Request, res: Response) => {
    res.json({
      apiVersion: 'v1',
      groups: [
        apiGroup('admissionregistration.k8s.io', 'v1'),
        apiGroup('apiextensions.k8s.io', 'v1'),
        apiGroup('apps', 'v1'),
        apiGroup('autoscaling', 'v2'),
        apiGroup('batch', 'v1'),
        apiGroup('cdi.kubevirt.io', 'v1beta1'),
        apiGroup('config.openshift.io', 'v1'),
        apiGroup('console.openshift.io', 'v1'),
        apiGroup('coordination.k8s.io', 'v1'),
        apiGroup('events.k8s.io', 'v1'),
        apiGroup('hco.kubevirt.io', 'v1beta1'),
        apiGroup('kubevirt.io', 'v1'),
        apiGroup('subresources.kubevirt.io', 'v1'),
        apiGroup('monitoring.coreos.com', 'v1'),
        apiGroup('k8s.cni.cncf.io', 'v1'),
        apiGroup('networking.k8s.io', 'v1'),
        apiGroup('node.k8s.io', 'v1'),
        apiGroup('operators.coreos.com', 'v1alpha1'),
        apiGroup('operators.coreos.com', 'v1'),
        apiGroup('packages.operators.coreos.com', 'v1'),
        apiGroup('policy', 'v1'),
        apiGroup('rbac.authorization.k8s.io', 'v1'),
        apiGroup('scheduling.k8s.io', 'v1'),
        apiGroup('snapshot.storage.k8s.io', 'v1'),
        apiGroup('storage.k8s.io', 'v1'),
        apiGroup('authorization.k8s.io', 'v1'),
        apiGroup('cluster.open-cluster-management.io', 'v1'),
        apiGroup('clusterview.open-cluster-management.io', 'v1'),
        apiGroup('observability.open-cluster-management.io', 'v1beta2'),
        apiGroup('project.openshift.io', 'v1'),
        apiGroup('template.openshift.io', 'v1'),
        apiGroup('upload.cdi.kubevirt.io', 'v1beta1'),
        apiGroup('user.openshift.io', 'v1'),
      ],
      kind: 'APIGroupList',
    });
  });

  // ── KubeVirt API resource lists ───────────────────────────────────────────

  router.get('/apis/kubevirt.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('kubevirt.io/v1', [
      { kind: 'VirtualMachine', name: 'virtualmachines', namespaced: true, shortNames: ['vm', 'vms'], singularName: 'virtualmachine', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { kind: 'VirtualMachineInstance', name: 'virtualmachineinstances', namespaced: true, shortNames: ['vmi', 'vmis'], singularName: 'virtualmachineinstance', verbs: ['get', 'list', 'watch', 'delete'] },
      { kind: 'VirtualMachineInstanceMigration', name: 'virtualmachineinstancemigrations', namespaced: true, singularName: 'virtualmachineinstancemigration', verbs: ['get', 'list', 'watch', 'create', 'delete'] },
      { kind: 'VirtualMachineInstancePreset', name: 'virtualmachineinstancepresets', namespaced: true, singularName: 'virtualmachineinstancepreset', verbs: ['get', 'list', 'watch'] },
      { kind: 'VirtualMachineInstanceReplicaSet', name: 'virtualmachineinstancereplicasets', namespaced: true, singularName: 'virtualmachineinstancereplicaset', verbs: ['get', 'list', 'watch'] },
      { kind: 'KubeVirt', name: 'kubevirts', namespaced: true, singularName: 'kubevirt', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/cdi.kubevirt.io/v1beta1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('cdi.kubevirt.io/v1beta1', [
      { kind: 'DataVolume', name: 'datavolumes', namespaced: true, singularName: 'datavolume', verbs: ['get', 'list', 'watch', 'create', 'delete'] },
      { kind: 'CDI', name: 'cdis', namespaced: false, singularName: 'cdi', verbs: ['get', 'list', 'watch'] },
      { kind: 'DataSource', name: 'datasources', namespaced: true, singularName: 'datasource', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/hco.kubevirt.io/v1beta1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('hco.kubevirt.io/v1beta1', [
      { kind: 'HyperConverged', name: 'hyperconvergeds', namespaced: true, singularName: 'hyperconverged', verbs: ['get', 'list', 'watch', 'update', 'patch'] },
    ]));
  });

  // ── Core v1 resources ─────────────────────────────────────────────────────

  router.get('/api/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('v1', [
      { kind: 'ConfigMap', name: 'configmaps', namespaced: true, singularName: 'configmap', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { kind: 'Event', name: 'events', namespaced: true, singularName: 'event', verbs: ['get', 'list', 'watch'] },
      { kind: 'LimitRange', name: 'limitranges', namespaced: true, singularName: 'limitrange', verbs: ['get', 'list', 'watch'] },
      { kind: 'Namespace', name: 'namespaces', namespaced: false, singularName: 'namespace', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { kind: 'Node', name: 'nodes', namespaced: false, singularName: 'node', verbs: ['get', 'list', 'watch'] },
      { kind: 'PersistentVolume', name: 'persistentvolumes', namespaced: false, singularName: 'persistentvolume', verbs: ['get', 'list', 'watch'] },
      { kind: 'PersistentVolumeClaim', name: 'persistentvolumeclaims', namespaced: true, singularName: 'persistentvolumeclaim', verbs: ['get', 'list', 'watch', 'create', 'delete'] },
      { kind: 'Pod', name: 'pods', namespaced: true, singularName: 'pod', verbs: ['get', 'list', 'watch'] },
      { kind: 'ResourceQuota', name: 'resourcequotas', namespaced: true, singularName: 'resourcequota', verbs: ['get', 'list', 'watch'] },
      { kind: 'Secret', name: 'secrets', namespaced: true, singularName: 'secret', verbs: ['get', 'list', 'watch'] },
      { kind: 'Service', name: 'services', namespaced: true, singularName: 'service', verbs: ['get', 'list', 'watch'] },
      { kind: 'ServiceAccount', name: 'serviceaccounts', namespaced: true, singularName: 'serviceaccount', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  // ── OpenShift / operator API resource lists ───────────────────────────────

  router.get('/apis/console.openshift.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('console.openshift.io/v1', [
      { kind: 'ConsolePlugin', name: 'consoleplugins', namespaced: false, singularName: 'consoleplugin', verbs: ['get', 'list', 'watch'] },
      { kind: 'ConsoleLink', name: 'consolelinks', namespaced: false, singularName: 'consolelink', verbs: ['get', 'list', 'watch'] },
      { kind: 'ConsoleNotification', name: 'consolenotifications', namespaced: false, singularName: 'consolenotification', verbs: ['get', 'list', 'watch'] },
      { kind: 'ConsoleQuickStart', name: 'consolequickstarts', namespaced: false, singularName: 'consolequickstart', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  // ConsolePlugin CRD — the Console checks this to confirm the plugin is registered
  router.get('/apis/console.openshift.io/v1/consoleplugins', (_req: Request, res: Response) => {
    res.json(makeList('ConsolePluginList', 'console.openshift.io/v1', [mockConsolePlugin()], '1'));
  });

  router.get('/apis/console.openshift.io/v1/consoleplugins/kubevirt-plugin', (_req: Request, res: Response) => {
    res.json(mockConsolePlugin());
  });

  // ConsoleQuickStart — watched by the Console to populate the quick-start drawer.
  // An empty list is fine; the watcher just needs a valid response so the
  // `setQuickStarts` setter gets initialized.
  router.get('/apis/console.openshift.io/v1/consolequickstarts', (req: Request, res: Response) => {
    if (req.query.watch === 'true') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders();
      // Send a BOOKMARK so the watcher knows the list is complete and can finish initializing
      const bookmark = JSON.stringify({ type: 'BOOKMARK', object: { apiVersion: 'console.openshift.io/v1', kind: 'ConsoleQuickStart', metadata: { resourceVersion: '1' } } });
      res.write(bookmark + '\n');
      // Keep the connection open until the client disconnects
      req.on('close', () => res.end());
      return;
    }
    res.json(makeList('ConsoleQuickStartList', 'console.openshift.io/v1', [], '1'));
  });

  router.get('/apis/config.openshift.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('config.openshift.io/v1', [
      { kind: 'ClusterVersion', name: 'clusterversions', namespaced: false, singularName: 'clusterversion', verbs: ['get', 'list', 'watch'] },
      { kind: 'Infrastructure', name: 'infrastructures', namespaced: false, singularName: 'infrastructure', verbs: ['get', 'list', 'watch'] },
      { kind: 'Network', name: 'networks', namespaced: false, singularName: 'network', verbs: ['get', 'list', 'watch'] },
      { kind: 'FeatureGate', name: 'featuregates', namespaced: false, singularName: 'featuregate', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/config.openshift.io/v1/clusterversions/version', (_req: Request, res: Response) => {
    res.json({
      apiVersion: 'config.openshift.io/v1',
      kind: 'ClusterVersion',
      metadata: { name: 'version', resourceVersion: '1', uid: 'cv-mock-001' },
      spec: { channel: 'stable-4.16', clusterID: 'mock-cluster-id' },
      status: {
        conditions: [{ message: 'Done applying 4.16.0', reason: 'AsExpected', status: 'False', type: 'Progressing' }],
        desired: { image: 'mock', version: '4.16.0' },
        history: [{ completionTime: '2024-01-01T00:00:00Z', image: 'mock', startedTime: '2024-01-01T00:00:00Z', state: 'Completed', version: '4.16.0' }],
      },
    });
  });

  router.get('/apis/config.openshift.io/v1/infrastructures/cluster', (_req: Request, res: Response) => {
    res.json({
      apiVersion: 'config.openshift.io/v1',
      kind: 'Infrastructure',
      metadata: { name: 'cluster', resourceVersion: '1', uid: 'infra-mock-001' },
      spec: { platformSpec: { type: 'None' } },
      status: { apiServerURL: 'https://localhost:8443', controlPlaneTopology: 'HighlyAvailable', infrastructureTopology: 'HighlyAvailable', platform: 'None', platformStatus: { type: 'None' } },
    });
  });

  router.get('/apis/rbac.authorization.k8s.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('rbac.authorization.k8s.io/v1', [
      { kind: 'ClusterRole', name: 'clusterroles', namespaced: false, singularName: 'clusterrole', verbs: ['get', 'list', 'watch'] },
      { kind: 'ClusterRoleBinding', name: 'clusterrolebindings', namespaced: false, singularName: 'clusterrolebinding', verbs: ['get', 'list', 'watch'] },
      { kind: 'Role', name: 'roles', namespaced: true, singularName: 'role', verbs: ['get', 'list', 'watch'] },
      { kind: 'RoleBinding', name: 'rolebindings', namespaced: true, singularName: 'rolebinding', verbs: ['get', 'list', 'watch', 'create'] },
    ]));
  });

  router.get('/apis/apps/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('apps/v1', [
      { kind: 'Deployment', name: 'deployments', namespaced: true, singularName: 'deployment', verbs: ['get', 'list', 'watch'] },
      { kind: 'ReplicaSet', name: 'replicasets', namespaced: true, singularName: 'replicaset', verbs: ['get', 'list', 'watch'] },
      { kind: 'StatefulSet', name: 'statefulsets', namespaced: true, singularName: 'statefulset', verbs: ['get', 'list', 'watch'] },
      { kind: 'DaemonSet', name: 'daemonsets', namespaced: true, singularName: 'daemonset', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/storage.k8s.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('storage.k8s.io/v1', [
      { kind: 'StorageClass', name: 'storageclasses', namespaced: false, singularName: 'storageclass', verbs: ['get', 'list', 'watch'] },
      { kind: 'VolumeAttachment', name: 'volumeattachments', namespaced: false, singularName: 'volumeattachment', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/snapshot.storage.k8s.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('snapshot.storage.k8s.io/v1', [
      { kind: 'VolumeSnapshot', name: 'volumesnapshots', namespaced: true, singularName: 'volumesnapshot', verbs: ['get', 'list', 'watch', 'create', 'delete'] },
      { kind: 'VolumeSnapshotClass', name: 'volumesnapshotclasses', namespaced: false, singularName: 'volumesnapshotclass', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/template.openshift.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('template.openshift.io/v1', [
      { kind: 'Template', name: 'templates', namespaced: true, singularName: 'template', verbs: ['get', 'list', 'watch', 'create'] },
      { kind: 'TemplateInstance', name: 'templateinstances', namespaced: true, singularName: 'templateinstance', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/networking.k8s.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('networking.k8s.io/v1', [
      { kind: 'NetworkPolicy', name: 'networkpolicies', namespaced: true, singularName: 'networkpolicy', verbs: ['get', 'list', 'watch'] },
      { kind: 'Ingress', name: 'ingresses', namespaced: true, singularName: 'ingress', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  // ── NetworkAttachmentDefinition (Multus) ──────────────────────────────────
  // The NetworkAttachmentDefinitionModel (k8s.cni.cncf.io/v1) must be registered in
  // the Console SDK's model registry.  Without it, useFleetK8sWatchResources crashes
  // with "Cannot read properties of undefined (reading 'apiGroup')" when the namespace
  // changes on a spoke cluster, because stopWatch is called synchronously with an
  // undefined model (the multi-resource variant has no per-resource model guard).

  router.get('/apis/k8s.cni.cncf.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('k8s.cni.cncf.io/v1', [
      { kind: 'NetworkAttachmentDefinition', name: 'network-attachment-definitions', namespaced: true, singularName: 'network-attachment-definition', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    ]));
  });

  router.get('/apis/k8s.cni.cncf.io/v1/network-attachment-definitions', (_req: Request, res: Response) => {
    res.json(makeList('NetworkAttachmentDefinitionList', 'k8s.cni.cncf.io/v1', [], '1'));
  });

  router.get('/apis/k8s.cni.cncf.io/v1/namespaces/:namespace/network-attachment-definitions', (_req: Request, res: Response) => {
    res.json(makeList('NetworkAttachmentDefinitionList', 'k8s.cni.cncf.io/v1', [], '1'));
  });

  // ── Operator Lifecycle Manager (OLM) API resource lists ───────────────────
  // These must be registered so the Console's model registry has them, otherwise
  // useFleetK8sWatchResources crashes with "Cannot read properties of undefined (reading 'apiGroup')"
  // when watching OLM resources on a spoke cluster (model is undefined → startWatch blows up).

  router.get('/apis/operators.coreos.com/v1alpha1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('operators.coreos.com/v1alpha1', [
      { kind: 'ClusterServiceVersion', name: 'clusterserviceversions', namespaced: true, singularName: 'clusterserviceversion', verbs: ['get', 'list', 'watch', 'delete'] },
      { kind: 'Subscription', name: 'subscriptions', namespaced: true, singularName: 'subscription', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { kind: 'InstallPlan', name: 'installplans', namespaced: true, singularName: 'installplan', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/operators.coreos.com/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('operators.coreos.com/v1', [
      { kind: 'OperatorGroup', name: 'operatorgroups', namespaced: true, singularName: 'operatorgroup', verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { kind: 'Operator', name: 'operators', namespaced: false, singularName: 'operator', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  router.get('/apis/packages.operators.coreos.com/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('packages.operators.coreos.com/v1', [
      { kind: 'PackageManifest', name: 'packagemanifests', namespaced: true, singularName: 'packagemanifest', verbs: ['get', 'list', 'watch'] },
    ]));
  });

  // Return empty lists for OLM resources — these aren't needed functionally in the mock
  // but must return valid responses to prevent component errors.
  router.get('/apis/operators.coreos.com/v1alpha1/namespaces/:ns/clusterserviceversions', (_req: Request, res: Response) => {
    res.json(makeList('ClusterServiceVersionList', 'operators.coreos.com/v1alpha1', [], '1'));
  });
  router.get('/apis/operators.coreos.com/v1alpha1/namespaces/:ns/subscriptions', (_req: Request, res: Response) => {
    res.json(makeList('SubscriptionList', 'operators.coreos.com/v1alpha1', [], '1'));
  });
  router.get('/apis/operators.coreos.com/v1alpha1/namespaces/:ns/installplans', (_req: Request, res: Response) => {
    res.json(makeList('InstallPlanList', 'operators.coreos.com/v1alpha1', [], '1'));
  });
  router.get('/apis/operators.coreos.com/v1/namespaces/:ns/operatorgroups', (_req: Request, res: Response) => {
    res.json(makeList('OperatorGroupList', 'operators.coreos.com/v1', [], '1'));
  });
  router.get('/apis/packages.operators.coreos.com/v1/namespaces/:ns/packagemanifests', (_req: Request, res: Response) => {
    res.json(makeList('PackageManifestList', 'packages.operators.coreos.com/v1', [], '1'));
  });
  // Cluster-scoped list endpoints
  router.get('/apis/operators.coreos.com/v1alpha1/clusterserviceversions', (_req: Request, res: Response) => {
    res.json(makeList('ClusterServiceVersionList', 'operators.coreos.com/v1alpha1', [], '1'));
  });
  router.get('/apis/operators.coreos.com/v1alpha1/subscriptions', (_req: Request, res: Response) => {
    res.json(makeList('SubscriptionList', 'operators.coreos.com/v1alpha1', [], '1'));
  });
  router.get('/apis/operators.coreos.com/v1/operatorgroups', (_req: Request, res: Response) => {
    res.json(makeList('OperatorGroupList', 'operators.coreos.com/v1', [], '1'));
  });
  router.get('/apis/packages.operators.coreos.com/v1/packagemanifests', (_req: Request, res: Response) => {
    res.json(makeList('PackageManifestList', 'packages.operators.coreos.com/v1', [], '1'));
  });

  // ── User identity (Console keys user settings by username) ────────────────

  router.get('/apis/user.openshift.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('user.openshift.io/v1', [
      { kind: 'User', name: 'users', namespaced: false, singularName: 'user', verbs: ['get', 'list'] },
      { kind: 'Group', name: 'groups', namespaced: false, singularName: 'group', verbs: ['get', 'list'] },
    ]));
  });

  router.get('/apis/user.openshift.io/v1/users/~', (_req: Request, res: Response) => {
    res.json({
      apiVersion: 'user.openshift.io/v1',
      kind: 'User',
      metadata: { name: 'mock-admin', resourceVersion: '1', uid: 'user-mock-001' },
      fullName: 'Mock Admin',
      groups: ['system:masters'],
      identities: ['mock:mock-admin'],
    });
  });

  // ── ConfigMaps (persisted in-memory) ──────────────────────────────────────
  // The Console user-settings hook reads/writes a per-user ConfigMap. Without
  // persistence between GET/POST/PATCH calls the hook never reaches loaded=true
  // and its setter stays undefined → "setXxx is not a function" errors.

  router.get('/api/v1/namespaces/:namespace/configmaps', (req: Request, res: Response) => {
    const prefix = `${req.params.namespace}/`;
    const items = Array.from(configMapStore.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
    res.json(makeList('ConfigMapList', 'v1', items, '1'));
  });

  router.get('/api/v1/namespaces/:namespace/configmaps/:name', (req: Request, res: Response) => {
    const key = cmKey(req.params.namespace, req.params.name);
    let cm = configMapStore.get(key);
    if (!cm) {
      // Auto-create an empty ConfigMap for user-settings namespaces so that
      // Console SDK helpers that GET-then-PATCH (e.g. tour dismiss, quick-start
      // state) don't hit 404 after a mock server restart.
      // Auto-create empty ConfigMaps in any KubeVirt/Console operator namespace
      // so GET-then-PATCH flows (user settings, feature flags) don't 404 after
      // a mock server restart.
      const settingsNamespaces = new Set([
        'openshift-console-user-settings',
        'kubevirt-hyperconverged',
        'openshift-cnv',
        'kubevirt-os-images',
        'openshift-virtualization-os-images',
      ]);
      if (settingsNamespaces.has(req.params.namespace)) {
        cm = {
          apiVersion: 'v1',
          data: {},
          kind: 'ConfigMap',
          metadata: {
            name: req.params.name,
            namespace: req.params.namespace,
            resourceVersion: '1',
            uid: `cm-auto-${Buffer.from(key).toString('hex').slice(0, 12)}`,
          },
        };
        configMapStore.set(key, cm);
      } else {
        res.status(404).json(notFound('configmap'));
        return;
      }
    }
    res.json(cm);
  });

  router.post('/api/v1/namespaces/:namespace/configmaps', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const meta = (body.metadata ?? {}) as Record<string, unknown>;
    const name = String(meta.name ?? `cm-${Date.now()}`);
    const created: Record<string, unknown> = {
      ...body,
      metadata: { ...meta, name, namespace: req.params.namespace, resourceVersion: '1', uid: `cm-${Date.now()}` },
    };
    const createdKey = cmKey(req.params.namespace, name);
    configMapStore.set(createdKey, created);
    saveConfigMapStore();
    cmUpdateEmitter.emit('update', createdKey, created);
    res.status(201).json(created);
  });

  router.put('/api/v1/namespaces/:namespace/configmaps/:name', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const meta = (body.metadata ?? {}) as Record<string, unknown>;
    const updated = { ...body, metadata: { ...meta, resourceVersion: String(Date.now()) } };
    const putKey = cmKey(req.params.namespace, req.params.name);
    configMapStore.set(putKey, updated);
    saveConfigMapStore();
    cmUpdateEmitter.emit('update', putKey, updated);
    res.json(updated);
  });

  router.patch('/api/v1/namespaces/:namespace/configmaps/:name', (req: Request, res: Response) => {
    const key = cmKey(req.params.namespace, req.params.name);
    const existing = configMapStore.get(key) ?? {
      apiVersion: 'v1', data: {}, kind: 'ConfigMap',
      metadata: { name: req.params.name, namespace: req.params.namespace, resourceVersion: '1', uid: `cm-patch-${Date.now()}` },
    };

    let updated: Record<string, unknown>;
    // JSON Patch (RFC 6902) arrives as an array of {op, path, value} operations
    if (Array.isArray(req.body)) {
      updated = deepMerge({}, existing as Record<string, unknown>) as Record<string, unknown>;
      for (const op of req.body as Array<{ op: string; path: string; value?: unknown }>) {
        if ((op.op === 'add' || op.op === 'replace') && typeof op.path === 'string') {
          const segments = op.path.replace(/^\//, '').split('/');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let target: any = updated;
          for (let i = 0; i < segments.length - 1; i++) {
            if (target[segments[i]] === undefined) target[segments[i]] = {};
            target = target[segments[i]];
          }
          target[segments[segments.length - 1]] = op.value;
        }
      }
    } else {
      // JSON Merge Patch (RFC 7396) — plain object
      updated = deepMerge(existing as Record<string, unknown>, req.body as Record<string, unknown>) as Record<string, unknown>;
    }

    const meta = (updated.metadata ?? {}) as Record<string, unknown>;
    updated.metadata = { ...meta, resourceVersion: String(Date.now()) };
    configMapStore.set(key, updated);
    saveConfigMapStore();
    cmUpdateEmitter.emit('update', key, updated);
    res.json(updated);
  });

  router.delete('/api/v1/namespaces/:namespace/configmaps/:name', (req: Request, res: Response) => {
    configMapStore.delete(cmKey(req.params.namespace, req.params.name));
    saveConfigMapStore();
    res.json({ apiVersion: 'v1', kind: 'Status', status: 'Success' });
  });

  // ── Fallback PATCH for wrong-URL ConfigMap patches ────────────────────────
  // The Console SDK's useK8sWatchResource strips metadata.namespace from returned
  // resources. When plugin code calls k8sPatch({ resource: watchedConfigMap }), the
  // SDK builds a URL without namespace/name: PATCH /api/v1/configmaps (list endpoint).
  // This fallback intercepts those calls and routes them to the correct ConfigMap by
  // inspecting the JSON-patch body paths.
  const KNOWN_FEATURE_FLAG_KEYS = new Set([
    'advancedCDROMFeatures', 'automaticSubscriptionActivationKey', 'automaticSubscriptionCustomUrl',
    'automaticSubscriptionOrganizationId', 'automaticSubscriptionType', 'confirmVMActions',
    'disabledGuestSystemLogsAccess', 'hideCredentialsNonPrivileged', 'hideYamlTab',
    'instanceTypesEnabled', 'kubevirtApiserverProxy', 'loadBalancerEnabled', 'nodePortAddress',
    'nodePortEnabled', 'passtUDNNetwork', 'persistentReservation', 'persistentReservationHCO',
    'treeViewFolders', 'vmTemplates',
  ]);
  const OPERATOR_NAMESPACES = ['openshift-cnv', 'kubevirt-hyperconverged'];

  const handleMisroutedConfigMapPatch = (
    req: Request, res: Response, namespaceHint?: string,
  ) => {
    const patches = Array.isArray(req.body)
      ? (req.body as Array<{ op: string; path: string; value?: unknown }>)
      : [];

    // Collect /data/<key> paths from the patch
    const dataKeys = patches
      .map((p) => {
        const m = p.path?.match(/^\/data\/(.+)$/);
        return m ? m[1] : null;
      })
      .filter(Boolean) as string[];

    const isFeaturePatch = dataKeys.some((k) => KNOWN_FEATURE_FLAG_KEYS.has(k));
    const cmName = isFeaturePatch ? 'kubevirt-ui-features' : 'kubevirt-user-settings';

    const namespacesToTry = namespaceHint ? [namespaceHint] : OPERATOR_NAMESPACES;
    let found: Record<string, unknown> | undefined;
    let foundKey: string | undefined;

    for (const ns of namespacesToTry) {
      const k = cmKey(ns, cmName);
      const cm = configMapStore.get(k);
      if (cm) { found = cm; foundKey = k; break; }
    }

    if (!found || !foundKey) {
      // Auto-create in the first candidate namespace
      const ns = namespacesToTry[0] ?? 'openshift-cnv';
      foundKey = cmKey(ns, cmName);
      found = {
        apiVersion: 'v1', data: {}, kind: 'ConfigMap',
        metadata: { name: cmName, namespace: ns, resourceVersion: '1', uid: `cm-auto-${Date.now()}` },
      };
      configMapStore.set(foundKey, found);
    }

    // Apply patches to the found ConfigMap
    let updated: Record<string, unknown> = deepMerge({}, found) as Record<string, unknown>;
    if (patches.length > 0) {
      for (const op of patches) {
        if ((op.op === 'add' || op.op === 'replace') && typeof op.path === 'string') {
          const segments = op.path.replace(/^\//, '').split('/');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let target: any = updated;
          for (let i = 0; i < segments.length - 1; i++) {
            if (target[segments[i]] === undefined) target[segments[i]] = {};
            target = target[segments[i]];
          }
          target[segments[segments.length - 1]] = op.value;
        }
      }
    }

    const meta = (updated.metadata ?? {}) as Record<string, unknown>;
    updated.metadata = { ...meta, resourceVersion: String(Date.now()) };
    configMapStore.set(foundKey, updated);
    saveConfigMapStore();
    cmUpdateEmitter.emit('update', foundKey, updated);
    res.json(updated);
  };

  // PATCH /api/v1/configmaps — cluster-scoped URL, missing both namespace and name
  router.patch('/api/v1/configmaps', (req: Request, res: Response) => {
    handleMisroutedConfigMapPatch(req, res);
  });

  // PATCH /api/v1/namespaces/:namespace/configmaps — has namespace but missing name
  router.patch('/api/v1/namespaces/:namespace/configmaps', (req: Request, res: Response) => {
    handleMisroutedConfigMapPatch(req, res, req.params.namespace);
  });

  // ── kubevirt-ui-features ConfigMap ────────────────────────────────────────
  // useFeatures() watches this ConfigMap to determine which features are enabled.
  // Keys MUST use the exact camelCase names from FEATURES_CONFIG_MAP_INITIAL_DATA in the plugin
  // (e.g. 'kubevirtApiserverProxy', not 'KUBEVIRT_APISERVER_PROXY') so that
  // useFeatures() finds all flags on first load and never calls applyMissingFeatures(),
  // which would PATCH via the Console SDK with metadata.namespace stripped → wrong URL → 404.
  const makeKubevirtUIFeaturesConfigMap = (namespace: string) => ({
    apiVersion: 'v1',
    data: {
      advancedCDROMFeatures: 'true',
      automaticSubscriptionActivationKey: '',
      automaticSubscriptionCustomUrl: '',
      automaticSubscriptionOrganizationId: '',
      automaticSubscriptionType: '',
      confirmVMActions: 'false',
      disabledGuestSystemLogsAccess: 'false',
      hideCredentialsNonPrivileged: 'false',
      hideYamlTab: 'false',
      instanceTypesEnabled: 'true',
      kubevirtApiserverProxy: 'true',
      loadBalancerEnabled: 'false',
      nodePortAddress: '',
      nodePortEnabled: 'false',
      passtUDNNetwork: 'false',
      persistentReservation: 'false',
      persistentReservationHCO: 'false',
      treeViewFolders: 'false',
      vmTemplates: 'true',
    },
    kind: 'ConfigMap',
    metadata: {
      creationTimestamp: '2024-01-01T00:00:00Z',
      name: 'kubevirt-ui-features',
      namespace,
      resourceVersion: '1',
      uid: `cm-kubevirt-ui-features-${namespace}`,
    },
  });

  // Ensure all camelCase feature-flag keys are present and remove obsolete SCREAMING_CASE keys.
  // Runs once on startup, then saves to disk so the store stays clean across restarts.
  let featureMigrationDirty = false;
  ['kubevirt-hyperconverged', 'openshift-cnv'].forEach((ns) => {
    const key = cmKey(ns, 'kubevirt-ui-features');
    const existing = configMapStore.get(key) as Record<string, unknown> | undefined;
    const fresh = makeKubevirtUIFeaturesConfigMap(ns);
    if (!existing) {
      configMapStore.set(key, fresh);
      featureMigrationDirty = true;
    } else {
      // Keep only camelCase keys (drop legacy SCREAMING_CASE) while preserving user values.
      const existingData = (existing.data ?? {}) as Record<string, string>;
      const freshKeys = new Set(Object.keys(fresh.data as Record<string, string>));
      const filteredExisting: Record<string, string> = {};
      for (const [k, v] of Object.entries(existingData)) {
        if (freshKeys.has(k)) filteredExisting[k] = v;
      }
      const merged = { ...fresh.data, ...filteredExisting };
      const mergedStr = JSON.stringify(merged);
      if (mergedStr !== JSON.stringify(existingData)) {
        configMapStore.set(key, { ...existing, data: merged });
        featureMigrationDirty = true;
      }
    }
  });
  if (featureMigrationDirty) saveConfigMapStore();

  // ── RoleBindings — Console checks openshift-console-user-settings namespace

  router.get('/apis/rbac.authorization.k8s.io/v1/namespaces/:namespace/rolebindings', (_req: Request, res: Response) => {
    res.json(makeList('RoleBindingList', 'rbac.authorization.k8s.io/v1', [], '1'));
  });

  router.post('/apis/rbac.authorization.k8s.io/v1/namespaces/:namespace/rolebindings', (req: Request, res: Response) => {
    res.status(201).json(req.body);
  });

  // Auth check endpoint
  router.get('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', (_req: Request, res: Response) => {
    res.json({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', status: { allowed: true } });
  });

  router.post('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', (_req: Request, res: Response) => {
    res.json({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', status: { allowed: true } });
  });

  router.post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', (_req: Request, res: Response) => {
    res.json({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectRulesReview',
      status: {
        incomplete: false,
        nonResourceRules: [{ nonResourceURLs: ['*'], verbs: ['*'] }],
        resourceRules: [{ apiGroups: ['*'], resourceNames: [], resources: ['*'], verbs: ['*'] }],
      },
    });
  });

  // ── Namespaces ─────────────────────────────────────────────────────────────

  router.get('/api/v1/namespaces', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const s = store.getStore(clusterName);
    if (!s) { res.status(404).json(notFound('cluster')); return; }
    if (req.query.watch === 'true') {
      handleWatch(req, res, store, clusterName, 'Namespace');
      return;
    }
    const items = s.data.namespaces;
    res.json(makeList('NamespaceList', 'v1', items, String(s.version)));
  });

  // ── OpenShift Projects ────────────────────────────────────────────────────
  // useProjects() watches project.openshift.io/v1/projects. Until this returns
  // data, projectNamesLoaded stays false and the tree view never renders.
  // Projects mirror our generated Namespaces (same names/uids, different kind).

  router.get('/apis/project.openshift.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('project.openshift.io/v1', [
      { kind: 'Project', name: 'projects', namespaced: false, singularName: 'project', verbs: ['get', 'list', 'watch', 'create', 'delete'] },
    ]));
  });

  router.get('/apis/project.openshift.io/v1/projects', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const s = store.getStore(clusterName);
    if (!s) { res.json(makeList('ProjectList', 'project.openshift.io/v1', [], '1')); return; }
    // Convert Namespace objects to Project objects
    const projects = s.data.namespaces.map((ns) => ({
      ...ns,
      apiVersion: 'project.openshift.io/v1',
      kind: 'Project',
      status: { phase: 'Active' },
    }));
    res.json(makeList('ProjectList', 'project.openshift.io/v1', projects, String(s.version)));
  });

  // ── Nodes ─────────────────────────────────────────────────────────────────

  router.get('/api/v1/nodes', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const s = store.getStore(clusterName);
    if (!s) { res.status(404).json(notFound('cluster')); return; }
    if (req.query.watch === 'true') {
      handleWatch(req, res, store, clusterName, 'Node');
      return;
    }
    res.json(makeList('NodeList', 'v1', s.data.nodes, String(s.version)));
  });

  // ── StorageClasses ────────────────────────────────────────────────────────

  router.get('/apis/storage.k8s.io/v1/storageclasses', (_req: Request, res: Response) => {
    const sc = {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { creationTimestamp: '2024-01-01T00:00:00Z', name: 'standard', resourceVersion: '1', uid: 'sc-mock-001' },
      provisioner: 'kubernetes.io/no-provisioner',
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
    };
    res.json(makeList('StorageClassList', 'storage.k8s.io/v1', [sc], '1'));
  });

  // ── VirtualMachines ────────────────────────────────────────────────────────

  // Cluster-scoped list
  router.get('/apis/kubevirt.io/v1/virtualmachines', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    handleVMList(req, res, store, clusterName, undefined);
  });

  // Namespace-scoped list ('all-namespaces' = no filter)
  router.get('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const ns = req.params.namespace === 'all-namespaces' ? undefined : req.params.namespace;
    handleVMList(req, res, store, clusterName, ns);
  });

  // Single VM get (also handles ?watch=true for detail-page live updates)
  router.get('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    if (req.query.watch === 'true') {
      handleWatchSingle(req, res, store, clusterName, 'VirtualMachine', req.params.namespace, req.params.name);
      return;
    }
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (!vm) { res.status(404).json(notFound('virtualmachine')); return; }
    res.json(vm);
  });

  // Create VM
  router.post('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const body = req.body as VirtualMachine;
    if (!body?.metadata?.name) { res.status(400).json({ message: 'metadata.name required' }); return; }
    body.metadata.namespace = req.params.namespace;
    body.metadata.uid = `vm-created-${Date.now()}`;
    body.metadata.resourceVersion = '1';
    body.metadata.creationTimestamp = new Date().toISOString();
    store.simulateCreate(clusterName, req.params.namespace, body);
    res.status(201).json(body);
  });

  // Patch VM
  router.patch('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const existing = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (!existing) { res.status(404).json(notFound('virtualmachine')); return; }

    const patch = req.body as Partial<VirtualMachine>;
    const updated = deepMerge(
      existing as unknown as Record<string, unknown>,
      patch as unknown as Record<string, unknown>,
    ) as unknown as VirtualMachine;

    // Detect runStrategy changes and trigger lifecycle simulation
    const newStrategy = patch?.spec?.runStrategy;
    if (newStrategy === 'Always' && existing.status.printableStatus !== 'Running') {
      updated.spec.runStrategy = 'Always';
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
      store.simulateStart(clusterName, req.params.namespace, req.params.name);
    } else if (newStrategy === 'Halted' && existing.status.printableStatus !== 'Stopped') {
      updated.spec.runStrategy = 'Halted';
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
      store.simulateStop(clusterName, req.params.namespace, req.params.name);
    } else {
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    }
    res.json(updated);
  });

  // Update (PUT) VM
  router.put('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const body = req.body as VirtualMachine;
    if (!body?.metadata?.name) { res.status(400).json({ message: 'metadata.name required' }); return; }
    body.metadata.namespace = req.params.namespace;
    store.setVM(clusterName, req.params.namespace, body, 'MODIFIED');
    res.json(body);
  });

  // Delete VM
  router.delete('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const deleted = store.deleteVM(clusterName, req.params.namespace, req.params.name);
    if (!deleted) { res.status(404).json(notFound('virtualmachine')); return; }
    res.json({ apiVersion: 'v1', kind: 'Status', status: 'Success' });
  });

  // ── VirtualMachineInstances ────────────────────────────────────────────────

  router.get('/apis/kubevirt.io/v1/virtualmachineinstances', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    handleVMIList(req, res, store, clusterName, undefined);
  });

  router.get('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const ns = req.params.namespace === 'all-namespaces' ? undefined : req.params.namespace;
    handleVMIList(req, res, store, clusterName, ns);
  });

  router.get('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    if (req.query.watch === 'true') {
      handleWatchSingle(req, res, store, clusterName, 'VirtualMachineInstance', req.params.namespace, req.params.name);
      return;
    }
    const vmi = store.getVMI(clusterName, req.params.namespace, req.params.name);
    if (!vmi) { res.status(404).json(notFound('virtualmachineinstance')); return; }
    res.json(vmi);
  });

  // Delete VMI — triggers restart simulation
  router.delete('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    store.deleteVMI(clusterName, req.params.namespace, req.params.name);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm?.spec.runStrategy === 'Always') {
      store.simulateStart(clusterName, req.params.namespace, req.params.name);
    }
    res.json({ apiVersion: 'v1', kind: 'Status', status: 'Success' });
  });

  // VMI subresource: pause
  router.put('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name/pause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (!vm) { res.status(404).json(notFound('virtualmachineinstance')); return; }
    const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
    updated.status.printableStatus = 'Paused';
    updated.status.ready = false;
    store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    res.json({});
  });

  // VMI subresource: unpause
  router.put('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name/unpause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (!vm) { res.status(404).json(notFound('virtualmachineinstance')); return; }
    const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
    updated.status.printableStatus = 'Running';
    updated.status.ready = true;
    store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    res.json({});
  });

  // ── subresources.kubevirt.io — VM lifecycle actions ───────────────────────
  // The plugin calls:
  //   PUT /api/kubernetes/apis/subresources.kubevirt.io/v1/namespaces/:ns/virtualmachines/:name/{start|stop|restart|addvolume|removevolume}
  //   PUT /api/kubernetes/apis/subresources.kubevirt.io/v1/namespaces/:ns/virtualmachineinstances/:name/{pause|unpause}
  // (BASE_K8S_API_PATH = /api/kubernetes; Console bridge strips that prefix)

  router.get('/apis/subresources.kubevirt.io/v1', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('subresources.kubevirt.io/v1', [
      { kind: 'VirtualMachine', name: 'virtualmachines/start', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachine', name: 'virtualmachines/stop', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachine', name: 'virtualmachines/restart', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachine', name: 'virtualmachines/pause', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachine', name: 'virtualmachines/unpause', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachineInstance', name: 'virtualmachineinstances/pause', namespaced: true, singularName: '', verbs: ['update'] },
      { kind: 'VirtualMachineInstance', name: 'virtualmachineinstances/unpause', namespaced: true, singularName: '', verbs: ['update'] },
    ]));
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/start', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    store.simulateStart(clusterName, req.params.namespace, req.params.name);
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/stop', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    store.simulateStop(clusterName, req.params.namespace, req.params.name);
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/restart', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm) {
      store.simulateStop(clusterName, req.params.namespace, req.params.name);
      setTimeout(() => store.simulateStart(clusterName, req.params.namespace, req.params.name), 1500);
    }
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/pause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm) {
      const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
      updated.status.printableStatus = 'Paused';
      updated.status.ready = false;
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    }
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/unpause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm) {
      const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
      updated.status.printableStatus = 'Running';
      updated.status.ready = true;
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    }
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name/pause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm) {
      const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
      updated.status.printableStatus = 'Paused';
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    }
    res.json({});
  });

  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachineinstances/:name/unpause', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const vm = store.getVM(clusterName, req.params.namespace, req.params.name);
    if (vm) {
      const updated = JSON.parse(JSON.stringify(vm)) as VirtualMachine;
      updated.status.printableStatus = 'Running';
      store.setVM(clusterName, req.params.namespace, updated, 'MODIFIED');
    }
    res.json({});
  });

  // Ignore addvolume/removevolume for now — return success without side effects
  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/addvolume', (_req: Request, res: Response) => res.json({}));
  router.put('/apis/subresources.kubevirt.io/v1/namespaces/:namespace/virtualmachines/:name/removevolume', (_req: Request, res: Response) => res.json({}));

  // ── VirtualMachineInstanceMigrations ──────────────────────────────────────

  router.post('/apis/kubevirt.io/v1/namespaces/:namespace/virtualmachineinstancemigrations', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const body = req.body as { spec?: { vmiName?: string } };
    const vmiName = body?.spec?.vmiName ?? req.params.name;
    if (vmiName) {
      store.simulateMigrate(clusterName, req.params.namespace, vmiName);
    }
    res.status(201).json({ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachineInstanceMigration', metadata: { name: `migration-${Date.now()}`, namespace: req.params.namespace } });
  });

  // ── DataVolumes ────────────────────────────────────────────────────────────

  router.get('/apis/cdi.kubevirt.io/v1beta1/datavolumes', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const s = store.getStore(clusterName);
    if (!s) { res.status(404).json(notFound('cluster')); return; }
    const items = Array.from(s.data.datavolumes.values());
    res.json(makeList('DataVolumeList', 'cdi.kubevirt.io/v1beta1', items, String(s.version)));
  });

  router.get('/apis/cdi.kubevirt.io/v1beta1/namespaces/:namespace/datavolumes', (req: Request, res: Response) => {
    const clusterName = resolveCluster(req, store);
    const s = store.getStore(clusterName);
    if (!s) { res.status(404).json(notFound('cluster')); return; }
    const items = Array.from(s.data.datavolumes.values()).filter(
      (dv) => dv.metadata.namespace === req.params.namespace,
    );
    res.json(makeList('DataVolumeList', 'cdi.kubevirt.io/v1beta1', items, String(s.version)));
  });

  // ── PVCs (stub) ────────────────────────────────────────────────────────────

  router.get('/api/v1/persistentvolumeclaims', (_req: Request, res: Response) => {
    res.json(makeList('PersistentVolumeClaimList', 'v1', [], '1'));
  });

  router.get('/api/v1/namespaces/:namespace/persistentvolumeclaims', (_req: Request, res: Response) => {
    res.json(makeList('PersistentVolumeClaimList', 'v1', [], '1'));
  });

  // ── HCO / operator namespace (for health checks) ───────────────────────────

  router.get('/apis/hco.kubevirt.io/v1beta1/namespaces/:namespace/hyperconvergeds', (_req: Request, res: Response) => {
    res.json(makeList('HyperConvergedList', 'hco.kubevirt.io/v1beta1', [
      {
        apiVersion: 'hco.kubevirt.io/v1beta1',
        kind: 'HyperConverged',
        metadata: { creationTimestamp: '2024-01-01T00:00:00Z', name: 'kubevirt-hyperconverged', namespace: 'openshift-cnv', resourceVersion: '1', uid: 'hco-mock-001' },
        spec: {},
        status: { conditions: [{ message: 'Reconcile completed', reason: 'ReconcileCompleted', status: 'True', type: 'Available' }] },
      },
    ], '1'));
  });

  // ── ACM / Multicluster Engine: ManagedCluster resources ──────────────────
  // The Fleet Virtualization perspective uses the @stolostron/multicluster-sdk which
  // internally calls useK8sWatchResource with group 'clusterview.open-cluster-management.io'
  // (see node_modules/@stolostron/multicluster-sdk/lib/internal/models.js).
  // We serve both 'cluster.' and 'clusterview.' groups with the same data.

  const managedClusterResource = {
    kind: 'ManagedCluster',
    name: 'managedclusters',
    namespaced: false,
    singularName: 'managedcluster',
    verbs: ['get', 'list', 'watch'],
  };

  for (const group of ['cluster.open-cluster-management.io', 'clusterview.open-cluster-management.io']) {
    const apiVersion = `${group}/v1`;

    router.get(`/apis/${group}/v1`, (_req: Request, res: Response) => {
      res.json(makeAPIResourceList(apiVersion, [managedClusterResource]));
    });

    router.get(`/apis/${group}/v1/managedclusters`, (_req: Request, res: Response) => {
      const items = store.allClusterNames().map((name) => makeManagedCluster(name, group));
      const version = store.getStore(store.allClusterNames()[0])?.version ?? 1000;
      res.json(makeList('ManagedClusterList', apiVersion, items, String(version)));
    });

    router.get(`/apis/${group}/v1/managedclusters/:name`, (req: Request, res: Response) => {
      const { name } = req.params;
      if (!store.allClusterNames().includes(name)) {
        res.status(404).json(notFound('ManagedCluster'));
        return;
      }
      res.json(makeManagedCluster(name, group));
    });
  }

  // ── Multicluster Observability (MCO) ─────────────────────────────────────
  // useMCOInstalled() watches MultiClusterObservability resources to decide
  // whether to show the "observability not available" alert on the fleet page.
  // We mock one MCO instance so the check passes.

  router.get('/apis/observability.open-cluster-management.io/v1beta2', (_req: Request, res: Response) => {
    res.json(makeAPIResourceList('observability.open-cluster-management.io/v1beta2', [
      {
        kind: 'MultiClusterObservability',
        name: 'multiclusterobservabilities',
        namespaced: false,
        singularName: 'multiclusterobservability',
        verbs: ['get', 'list', 'watch'],
      },
    ]));
  });

  router.get('/apis/observability.open-cluster-management.io/v1beta2/multiclusterobservabilities', (_req: Request, res: Response) => {
    res.json(makeList('MultiClusterObservabilityList', 'observability.open-cluster-management.io/v1beta2', [
      {
        apiVersion: 'observability.open-cluster-management.io/v1beta2',
        kind: 'MultiClusterObservability',
        metadata: {
          creationTimestamp: '2024-01-01T00:00:00Z',
          name: 'observability',
          resourceVersion: '1',
          uid: 'mco-mock-001',
        },
        spec: { enableDownsampling: true, observabilityAddonSpec: { enableMetrics: true } },
        status: { conditions: [{ message: 'Observability installed', reason: 'Ready', status: 'True', type: 'Ready' }] },
      },
    ], '1'));
  });

  // ── Catch-all for unmapped GET endpoints ──────────────────────────────────
  // Always return 200 with an empty list rather than 404.
  // The Console iterates every discovered API group; a 404 on any group's
  // resource list can abort discovery and leave the model registry incomplete.

  router.get('*', (_req: Request, res: Response) => {
    res.json(makeList('List', 'v1', [], '1'));
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveCluster(req: Request, store: MockStore): string {
  const q = req.query.cluster;
  if (typeof q === 'string' && q) return q;
  return store.allClusterNames()[0] ?? 'local-cluster';
}

function handleVMList(
  req: Request,
  res: Response,
  store: MockStore,
  clusterName: string,
  namespace: string | undefined,
): void {
  const s = store.getStore(clusterName);
  if (!s) { res.status(404).json(notFound('cluster')); return; }

  if (req.query.watch === 'true') {
    handleWatch(req, res, store, clusterName, 'VirtualMachine', namespace);
    return;
  }

  let items = Array.from(s.data.vms.values());
  if (namespace) items = items.filter((vm) => vm.metadata.namespace === namespace);

  const { paged, continueToken } = paginate(items, req);
  const list = makeList('VirtualMachineList', 'kubevirt.io/v1', paged, String(s.version));
  if (continueToken) (list.metadata as Record<string, string>).continue = continueToken;
  res.json(list);
}

function handleVMIList(
  req: Request,
  res: Response,
  store: MockStore,
  clusterName: string,
  namespace: string | undefined,
): void {
  const s = store.getStore(clusterName);
  if (!s) { res.status(404).json(notFound('cluster')); return; }

  if (req.query.watch === 'true') {
    handleWatch(req, res, store, clusterName, 'VirtualMachineInstance', namespace);
    return;
  }

  let items = Array.from(s.data.vmis.values());
  if (namespace) items = items.filter((vmi) => vmi.metadata.namespace === namespace);

  const { paged, continueToken } = paginate(items, req);
  const list = makeList('VirtualMachineInstanceList', 'kubevirt.io/v1', paged, String(s.version));
  if (continueToken) (list.metadata as Record<string, string>).continue = continueToken;
  res.json(list);
}

function handleWatch(
  req: Request,
  res: Response,
  store: MockStore,
  clusterName: string,
  kind: string,
  namespace?: string,
): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const s = store.getStore(clusterName);
  if (!s) { res.end(); return; }

  // Send initial ADDED events for all current resources
  const sendInitial = () => {
    let items: (VirtualMachine | VirtualMachineInstance)[] = [];
    if (kind === 'VirtualMachine') {
      items = Array.from(s.data.vms.values());
    } else if (kind === 'VirtualMachineInstance') {
      items = Array.from(s.data.vmis.values());
    }
    if (namespace) {
      items = items.filter((item) => item.metadata.namespace === namespace);
    }
    for (const item of items) {
      writeWatchEvent(res, 'ADDED', item);
    }
  };

  sendInitial();

  // Subscribe to live events
  const unsubscribe = store.onWatchEvent(clusterName, kind, (event) => {
    if (res.writableEnded) return;
    const obj = event.object as unknown as { metadata: { namespace?: string } };
    if (namespace && obj.metadata.namespace !== namespace) return;
    writeWatchEvent(res, event.type, event.object);
  });

  req.on('close', () => {
    unsubscribe();
  });
}

function handleWatchSingle(
  req: Request,
  res: Response,
  store: MockStore,
  clusterName: string,
  kind: string,
  namespace: string,
  name: string,
): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const s = store.getStore(clusterName);
  if (!s) { res.end(); return; }

  // Send initial ADDED event for the specific resource
  const getItem = () => kind === 'VirtualMachine'
    ? store.getVM(clusterName, namespace, name) as unknown
    : store.getVMI(clusterName, namespace, name) as unknown;

  const item = getItem();
  if (item) writeWatchEvent(res, 'ADDED', item);

  // Subscribe to live events, filtering by name
  const unsubscribe = store.onWatchEvent(clusterName, kind, (event) => {
    if (res.writableEnded) return;
    const obj = event.object as unknown as { metadata: { name?: string; namespace?: string } };
    if (obj.metadata?.name !== name || obj.metadata?.namespace !== namespace) return;
    writeWatchEvent(res, event.type, event.object);
  });

  req.on('close', () => unsubscribe());
}

function writeWatchEvent(res: Response, type: string, object: unknown): void {
  try {
    res.write(JSON.stringify({ object, type }) + '\n');
  } catch (_e) {
    // client disconnected
  }
}

interface PaginateResult<T> {
  paged: T[];
  continueToken?: string;
}

function paginate<T>(items: T[], req: Request): PaginateResult<T> {
  const limit = parseInt(String(req.query.limit ?? '0'), 10);
  const cont = req.query.continue as string | undefined;

  let start = 0;
  if (cont) {
    try {
      start = parseInt(Buffer.from(cont, 'base64').toString('utf-8'), 10);
    } catch (_e) {
      start = 0;
    }
  }

  if (!limit) return { paged: items.slice(start) };

  const paged = items.slice(start, start + limit);
  const nextStart = start + limit;
  const continueToken = nextStart < items.length
    ? Buffer.from(String(nextStart)).toString('base64')
    : undefined;

  return { continueToken, paged };
}

function makeList(kind: string, apiVersion: string, items: unknown[], resourceVersion: string) {
  return { apiVersion, items, kind, metadata: { resourceVersion } };
}

function makeAPIResourceList(
  groupVersion: string,
  resources: Array<{ kind: string; name: string; namespaced: boolean; shortNames?: string[]; singularName: string; verbs: string[] }>,
) {
  return { apiVersion: 'v1', groupVersion, kind: 'APIResourceList', resources };
}

function apiGroup(name: string, version: string) {
  const groupVersion = `${name}/${version}`;
  return {
    name,
    preferredVersion: { groupVersion, version },
    versions: [{ groupVersion, version }],
  };
}

function mockConsolePlugin() {
  return {
    apiVersion: 'console.openshift.io/v1',
    kind: 'ConsolePlugin',
    metadata: { creationTimestamp: '2024-01-01T00:00:00Z', name: 'kubevirt-plugin', resourceVersion: '1', uid: 'cp-mock-001' },
    spec: {
      backend: { service: { basePath: '/', name: 'kubevirt-plugin', namespace: 'openshift-cnv', port: 9001 }, type: 'Service' },
      displayName: 'Virtualization Plugin',
    },
  };
}

function notFound(resource: string) {
  return { apiVersion: 'v1', code: 404, kind: 'Status', message: `${resource} not found`, reason: 'NotFound', status: 'Failure' };
}

function makeManagedCluster(name: string, group = 'cluster.open-cluster-management.io') {
  const isLocal = name === 'local-cluster';
  return {
    apiVersion: `${group}/v1`,
    kind: 'ManagedCluster',
    metadata: {
      creationTimestamp: '2024-01-01T00:00:00Z',
      labels: {
        'cloud': 'Amazon',
        'cluster.open-cluster-management.io/clusterset': 'default',
        // Required by useFleetClusterNames() to include this cluster in the fleet tree view
        'feature.open-cluster-management.io/addon-cluster-proxy': 'available',
        ...(isLocal ? { 'local-cluster': 'true' } : {}),
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
          value: isLocal ? 'https://localhost:9000' : `https://${name}.mock.example.com`,
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
  };
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])
      && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}
