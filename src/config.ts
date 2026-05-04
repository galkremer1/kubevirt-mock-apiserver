import * as fs from 'fs';
import * as path from 'path';

export interface ClusterConfig {
  name: string;
  namespaces: number;
  vmsPerNamespace: number;
  statusDistribution?: {
    Running?: number;
    Stopped?: number;
    Paused?: number;
  };
}

export interface ServerConfig {
  port: number;
  ui: boolean;
  uiPort: number;
}

export interface MockConfig {
  seed: number;
  clusters: ClusterConfig[];
  server: ServerConfig;
}

const DEFAULT_CONFIG: MockConfig = {
  seed: 42,
  clusters: [
    {
      name: 'local-cluster',
      namespaces: 3,
      vmsPerNamespace: 20,
      statusDistribution: { Running: 0.6, Stopped: 0.3, Paused: 0.1 },
    },
  ],
  server: {
    port: 8443,
    ui: false,
    uiPort: 8080,
  },
};

export function loadConfig(configPath?: string, uiOverride?: boolean): MockConfig {
  let config: MockConfig = { ...DEFAULT_CONFIG };

  if (configPath) {
    const resolved = path.resolve(configPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MockConfig>;
    config = {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...(parsed.server ?? {}) },
    };
  }

  if (uiOverride !== undefined) {
    config.server.ui = uiOverride;
  }

  // Fill in missing statusDistribution defaults
  for (const cluster of config.clusters) {
    if (!cluster.statusDistribution) {
      cluster.statusDistribution = { Paused: 0.1, Running: 0.6, Stopped: 0.3 };
    }
  }

  return config;
}
