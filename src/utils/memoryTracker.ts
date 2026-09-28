// Memory Tracking Utility using WeakRef and FinalizationRegistry to monitor and report memory state in real-time.

export interface TrackedItem {
  id: string;
  label: string;
  type: string;
  sizeMB: number;
  addedAt: number;
  weakRef: WeakRef<any>;
  status: "active" | "collected";
}

export interface SharedBufferItem {
  id: string;
  label: string;
  sizeMB: number;
  addedAt: number;
  status: "active" | "collected";
}

export interface WebWorkerItem {
  id: string;
  name: string;
  memoryMB: number;
  status: "active" | "terminated";
}

class MemoryTrackerService {
  private trackedItems = new Map<string, TrackedItem>();
  private sharedBuffers = new Map<string, SharedBufferItem>();
  private webWorkers = new Map<string, WebWorkerItem>();
  
  private collectedCount = 0;
  private collectedLabels: string[] = [];
  private listeners = new Set<() => void>();

  // Use standard FinalizationRegistry to trigger when objects are reclaimed
  private registry = typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry((info: { id: string; label: string; sizeMB: number; isSab?: boolean }) => {
        this.handleGarbageCollected(info);
      })
    : null;

  public register(obj: any, label: string, type: string, sizeBytes: number) {
    if (!obj || typeof obj !== "object") return;

    const id = `${label}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sizeMB = parseFloat((sizeBytes / (1024 * 1024)).toFixed(2));

    const item: TrackedItem = {
      id,
      label,
      type,
      sizeMB,
      addedAt: Date.now(),
      weakRef: new WeakRef(obj),
      status: "active"
    };

    this.trackedItems.set(id, item);

    if (this.registry) {
      try {
        // Register with the finalization registry to catch the GC event
        this.registry.register(obj, { id, label, sizeMB, isSab: false }, obj);
      } catch (err) {
        console.warn("[MemoryTracker] Failed to register object in FinalizationRegistry:", err);
      }
    }

    this.notify();
    console.log(`[MemoryTracker] Registered tracking for "${label}" (${sizeMB} MB, type: ${type})`);
  }

  // Register SharedArrayBuffer allocation
  public registerSharedArrayBuffer(sab: any, label: string, sizeBytes: number) {
    if (!sab) return;

    const id = `sab-${label}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sizeMB = parseFloat((sizeBytes / (1024 * 1024)).toFixed(2));

    const item: SharedBufferItem = {
      id,
      label,
      sizeMB,
      addedAt: Date.now(),
      status: "active"
    };

    this.sharedBuffers.set(id, item);

    if (this.registry) {
      try {
        this.registry.register(sab, { id, label, sizeMB, isSab: true }, sab);
      } catch (err) {
        console.warn("[MemoryTracker] Failed to register SharedArrayBuffer in FinalizationRegistry:", err);
      }
    }

    this.notify();
    console.log(`[MemoryTracker] Registered SharedArrayBuffer for "${label}" (${sizeMB} MB)`);
  }

  // Register an active Web Worker
  public registerWebWorker(id: string, name: string, baseMemoryMB: number = 22.5) {
    this.webWorkers.set(id, {
      id,
      name,
      memoryMB: baseMemoryMB,
      status: "active"
    });
    this.notify();
    console.log(`[MemoryTracker] Registered active Web Worker "${name}" (${baseMemoryMB} MB)`);
  }

  // Deschedule or terminate Web Worker
  public terminateWebWorker(id: string) {
    const w = this.webWorkers.get(id);
    if (w) {
      w.status = "terminated";
      this.notify();
      console.log(`[MemoryTracker] Terminated Web Worker "${w.name}"`);
    }
  }

  private handleGarbageCollected(info: { id: string; label: string; sizeMB: number; isSab?: boolean }) {
    this.collectedCount++;
    this.collectedLabels.push(`${info.label} (${info.sizeMB} MB)`);
    if (this.collectedLabels.length > 10) {
      this.collectedLabels.shift();
    }

    if (info.isSab) {
      const sab = this.sharedBuffers.get(info.id);
      if (sab) {
        sab.status = "collected";
      }
    } else {
      const item = this.trackedItems.get(info.id);
      if (item) {
        item.status = "collected";
      }
    }

    this.notify();
    console.log(`[MemoryTracker] GC Reclaimed: "${info.label}" (${info.sizeMB} MB, isSAB: ${info.isSab})`);
  }

  // Manually poll weak refs to see if they're dead (deref() returns undefined).
  // Also prunes collected entries so the Maps do not grow unbounded over a long
  // session. Returns true if any state changed.
  public updateStatus() {
    let changed = false;
    for (const [id, item] of this.trackedItems.entries()) {
      if (item.status === "active") {
        const value = item.weakRef.deref();
        if (value === undefined) {
          item.status = "collected";
          this.collectedCount++;
          this.collectedLabels.push(`${item.label} (${item.sizeMB} MB)`);
          if (this.collectedLabels.length > 10) {
            this.collectedLabels.shift();
          }
          changed = true;
          console.log(`[MemoryTracker] WeakRef detected reclaim: "${item.label}"`);
        }
      }
    }
    if (changed) {
      this.pruneCollected();
      this.notify();
    }
    return changed;
  }

  // Remove entries already marked collected so the Maps stop growing forever.
  private pruneCollected() {
    for (const [id, item] of this.trackedItems.entries()) {
      if (item.status === "collected") {
        this.trackedItems.delete(id);
      }
    }
    for (const [id, sab] of this.sharedBuffers.entries()) {
      if (sab.status === "collected") {
        this.sharedBuffers.delete(id);
      }
    }
    for (const [id, w] of this.webWorkers.entries()) {
      if (w.status === "terminated") {
        this.webWorkers.delete(id);
      }
    }
  }

  // Throttled stats cache: the UI polls every 2.5s, so avoid recomputing the
  // full sweep (and the second deref pass) more often than necessary.
  private cachedStats: ReturnType<MemoryTrackerService["computeStats"]> | null = null;
  private lastStatsAt = 0;
  private static readonly STATS_TTL_MS = 1000;

  private computeStats() {
    const active: TrackedItem[] = [];
    let totalActiveSizeMB = 0;

    // Single pass: deref each active WeakRef once (no second sweep), and prune
    // entries whose referent is gone.
    const deadIds: string[] = [];
    for (const [id, item] of this.trackedItems.entries()) {
      if (item.status === "active") {
        if (item.weakRef.deref() !== undefined) {
          active.push(item);
          totalActiveSizeMB += item.sizeMB;
        } else {
          item.status = "collected";
          deadIds.push(id);
        }
      }
    }
    if (deadIds.length) {
      for (const id of deadIds) this.trackedItems.delete(id);
    }

    let totalSabSizeMB = 0;
    const activeSabs: SharedBufferItem[] = [];
    for (const sab of this.sharedBuffers.values()) {
      if (sab.status === "active") {
        totalSabSizeMB += sab.sizeMB;
        activeSabs.push(sab);
      }
    }

    let totalWorkerSizeMB = 0;
    const activeWorkers: WebWorkerItem[] = [];
    for (const w of this.webWorkers.values()) {
      if (w.status === "active") {
        totalWorkerSizeMB += w.memoryMB;
        activeWorkers.push(w);
      }
    }

    return {
      activeCount: active.length,
      activeItems: active,
      totalActiveSizeMB: parseFloat(totalActiveSizeMB.toFixed(2)),

      activeSabs,
      totalSabSizeMB: parseFloat(totalSabSizeMB.toFixed(2)),

      activeWorkers,
      totalWorkerSizeMB: parseFloat(totalWorkerSizeMB.toFixed(2)),

      collectedCount: this.collectedCount,
      recentCollectedLabels: [...this.collectedLabels].reverse(),
    };
  }

  public getStats(): ReturnType<MemoryTrackerService["computeStats"]> {
    const now = Date.now();
    if (this.cachedStats && now - this.lastStatsAt < MemoryTrackerService.STATS_TTL_MS) {
      return this.cachedStats;
    }
    const stats = this.computeStats();
    this.cachedStats = stats;
    this.lastStatsAt = now;
    return stats;
  }

  public clearTrackedHistory() {
    this.trackedItems.clear();
    this.sharedBuffers.clear();
    this.webWorkers.clear();
    this.collectedCount = 0;
    this.collectedLabels = [];
    this.cachedStats = null;
    this.lastStatsAt = 0;
    this.notify();
  }

  // Subscribe to updates
  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    // Invalidate the cached stats snapshot so the next getStats() recomputes.
    this.cachedStats = null;
    this.lastStatsAt = 0;
    this.listeners.forEach(l => {
      try { l(); } catch(e) {}
    });
  }
}

export const MemoryTracker = new MemoryTrackerService();
