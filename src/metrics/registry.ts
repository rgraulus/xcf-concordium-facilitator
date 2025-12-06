// src/metrics/registry.ts
//
// Very small in-memory metrics registry for XCF.
//
// Intentionally simple: this is not Prometheus or any external backend.
// It just keeps counters in memory so we can:
//   - read them via /metrics
//   - have a central place to increment them from various modules.

export interface ReadyzMetrics {
  totalChecks: number;
  success: number;
  dbFailures: number;
  walletProxyFailures: number;
}

export interface MetricsRegistry {
  readyz: ReadyzMetrics;
}

// Global in-memory metrics object.
export const metrics: MetricsRegistry = {
  readyz: {
    totalChecks: 0,
    success: 0,
    dbFailures: 0,
    walletProxyFailures: 0,
  },
};

// Helper functions for /readyz to record outcomes.

export function incrementReadyzTotalChecks(): void {
  metrics.readyz.totalChecks += 1;
}

export function incrementReadyzSuccess(): void {
  metrics.readyz.success += 1;
}

export function incrementReadyzDbFailures(): void {
  metrics.readyz.dbFailures += 1;
}

export function incrementReadyzWalletProxyFailures(): void {
  metrics.readyz.walletProxyFailures += 1;
}

// Shallow snapshot helper so /metrics doesn't hand out a live reference.
export function getMetricsSnapshot(): MetricsRegistry {
  // Simple deep-ish clone for this small structure.
  return JSON.parse(JSON.stringify(metrics)) as MetricsRegistry;
}
