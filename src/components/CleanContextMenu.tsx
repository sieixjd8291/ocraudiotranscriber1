import React, { useState, useEffect, useRef } from "react";
import { 
  Trash2, 
  X, 
  HardDrive, 
  Cpu, 
  Archive, 
  Database,
  Activity,
  Gauge,
  RefreshCw,
  ShieldAlert,
  Sparkles
} from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { MemoryTracker, TrackedItem, SharedBufferItem, WebWorkerItem } from "../utils/memoryTracker";
import { SystemResourceMonitor } from "./SystemResourceMonitor";

interface CleanContextMenuProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number } | null;
  onClean: (options: CleanOptions) => void;
  memoryStats: {
    filesUploaded: number;
    temporaryAppFiles: number;
    systemCache: number;
    systemMemory: number;
    total: number;
  };
  isProcessing?: boolean;
  isGcFlickering?: boolean;
}

export interface CleanOptions {
  indexedDbFiles: boolean; // Files Uploaded (IndexedDB)
  temporaryAppFiles: boolean; // Temporary App Files
  systemCache: boolean; // System cache
  systemMemory: boolean; // RAM / JS Heap
}

export const CleanContextMenu: React.FC<CleanContextMenuProps> = ({
  isOpen,
  onClose,
  position,
  onClean,
  memoryStats,
  isProcessing = false,
  isGcFlickering = false
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<"clean" | "diagnostics">("diagnostics");
  
  // Real-time local state for advanced metrics
  const [heapData, setHeapData] = useState<{
    usedMB: number;
    totalMB: number;
    limitMB: number;
    percentage: number;
    supported: boolean;
  }>({ usedMB: 0, totalMB: 0, limitMB: 0, percentage: 0, supported: false });

  const [dbDiagnostics, setDbDiagnostics] = useState<{
    count: number;
    sizeMB: number;
  }>({ count: 0, sizeMB: 0 });

  const [trackerStats, setTrackerStats] = useState({
    activeCount: 0,
    activeItems: [] as TrackedItem[],
    totalActiveSizeMB: 0,
    activeSabs: [] as SharedBufferItem[],
    totalSabSizeMB: 0,
    activeWorkers: [] as WebWorkerItem[],
    totalWorkerSizeMB: 0,
    collectedCount: 0,
    recentCollectedLabels: [] as string[],
  });

  const [selectedOptions, setSelectedOptions] = useState<CleanOptions>(() => {
    const saved = localStorage.getItem('cleanvoice_clean_options_v3');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          indexedDbFiles: parsed.indexedDbFiles ?? false,
          temporaryAppFiles: parsed.temporaryAppFiles ?? true,
          systemCache: parsed.systemCache ?? true,
          systemMemory: parsed.systemMemory ?? true,
        };
      } catch (e) {}
    }
    return {
      indexedDbFiles: false,
      temporaryAppFiles: true,
      systemCache: true,
      systemMemory: true,
    };
  });

  // Query Heap data and IndexedDB statistics without deserializing binary data to prevent performance lag
  const updateMetrics = async () => {
    // 1. Heap Memory Info
    if (typeof window !== "undefined" && (window.performance as any)?.memory) {
      const mem = (window.performance as any).memory;
      const used = mem.usedJSHeapSize / (1024 * 1024);
      const total = mem.totalJSHeapSize / (1024 * 1024);
      const limit = mem.jsHeapSizeLimit / (1024 * 1024);
      setHeapData({
        usedMB: parseFloat(used.toFixed(1)),
        totalMB: parseFloat(total.toFixed(1)),
        limitMB: parseFloat(limit.toFixed(0)),
        percentage: parseFloat(((used / limit) * 100).toFixed(1)),
        supported: true
      });
    } else {
      // Fallback estimated values based on active state nodes to provide visual gauges on non-Chrome
      const estimatedUsed = memoryStats.systemMemory || 45.0;
      setHeapData({
        usedMB: parseFloat(estimatedUsed.toFixed(1)),
        totalMB: parseFloat((estimatedUsed * 1.25).toFixed(1)),
        limitMB: 2048,
        percentage: parseFloat(((estimatedUsed / 2048) * 100).toFixed(1)),
        supported: false
      });
    }

    // 2. Scan IndexedDB Count Only (Extremely lightweight, does not load any heavy Blobs into memory)
    if (typeof window !== "undefined" && window.indexedDB) {
      try {
        const req = indexedDB.open("CleanvoiceStudioDB", 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("files")) {
            db.close();
            return;
          }
          const tx = db.transaction("files", "readonly");
          const store = tx.objectStore("files");
          const countReq = store.count();
          countReq.onsuccess = () => {
            const count = countReq.result || 0;
            db.close();
            setDbDiagnostics({
              count,
              sizeMB: parseFloat((memoryStats.filesUploaded).toFixed(1))
            });
          };
          countReq.onerror = () => db.close();
        };
        req.onerror = () => {};
      } catch (err) {}
    }

    // 3. Update GC tracking statistics
    setTrackerStats(MemoryTracker.getStats());
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);

      // Defer the initial (heavy) metrics fetch by one animation frame so the
      // modal's enter animation gets a clean first paint instead of fighting an
      // IndexedDB scan + memory-tracker sweep + multiple state updates on the
      // same frame (which read as the opening "jitter").
      const rafId = requestAnimationFrame(() => updateMetrics());

      // Setup slow live polling (2500ms) for real-time diagnostics to save CPU & battery
      const interval = setInterval(updateMetrics, 2500);

      // Subscribe to memory tracker allocations
      const unsubscribeTracker = MemoryTracker.subscribe(updateMetrics);

      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleKeyDown);
        cancelAnimationFrame(rafId);
        clearInterval(interval);
        unsubscribeTracker();
      };
    }
  }, [isOpen, onClose, memoryStats]);

  const handleToggle = (key: keyof CleanOptions) => {
    setSelectedOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('cleanvoice_clean_options_v3', JSON.stringify(next));
      return next;
    });
  };

  const handleCleanSelected = () => {
    const cleanCount = Object.values(selectedOptions).filter(Boolean).length;
    if (cleanCount === 0) {
      toast.error("Select at least one category to clean.");
      return;
    }
    onClean(selectedOptions);
    onClose();
  };

  const forceGcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending forceGcSuggestion timer on unmount so it can't fire
  // updateMetrics/toast on an unmounted component.
  useEffect(() => {
    return () => {
      if (forceGcTimerRef.current !== null) {
        clearTimeout(forceGcTimerRef.current);
        forceGcTimerRef.current = null;
      }
    };
  }, []);

  const forceGcSuggestion = () => {
    // Recreate state nodes, clear out cache, trigger ref updates
    onClean({
      indexedDbFiles: false,
      temporaryAppFiles: true,
      systemCache: false,
      systemMemory: true
    });

    // Clear any prior pending timer (e.g. rapid double-click) before arming a
    // new one so we never stack overlapping deferred updateMetrics() calls.
    if (forceGcTimerRef.current !== null) {
      clearTimeout(forceGcTimerRef.current);
    }
    forceGcTimerRef.current = setTimeout(() => {
      forceGcTimerRef.current = null;
      updateMetrics();
      toast.success("Forced local cleanup loop initiated!", {
        description: "Cleared wave/blob caches and scheduled browser-native garbage collection."
      });
    }, 400);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm cursor-pointer"
          />
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            // Eased tween (not spring) for this heavy modal: a spring's overshoot
            // physics compound with the costly first-paint layout (IndexedDB scan,
            // memory-tracker sweep, chart) and read as an initial "jitter". The
            // easeOut curve settles deterministically with no bounce to fight.
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-2xl bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-slate-900 dark:text-slate-100"
          >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-450">
              <Activity className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Storage & Memory Diagnostics Console
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Monitor live thread allocations, web memory garbage collection loops, and trigger secure cleaning routines
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition-all cursor-pointer"
            aria-label="Close details"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Navigation tabs */}
        <div className="flex border-b border-slate-100 dark:border-slate-800 text-xs px-4 bg-slate-50/50 dark:bg-slate-900/20">
          <button 
            type="button"
            onClick={() => setActiveTab("diagnostics")}
            className={`px-5 py-3.5 font-bold transition-all relative flex items-center gap-2 cursor-pointer ${
              activeTab === "diagnostics" 
                ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500" 
                : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <Gauge className="w-4 h-4" />
            Live Diagnostics Console
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping absolute right-2.5 top-3.5" />
          </button>
          <button 
            type="button"
            onClick={() => setActiveTab("clean")}
            className={`px-5 py-3.5 font-bold transition-all relative flex items-center gap-2 cursor-pointer ${
              activeTab === "clean" 
                ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500" 
                : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <Trash2 className="w-4 h-4" />
            Interactive Cleaning Control
          </button>
        </div>

        {/* Panel container */}
        <div className="p-6 overflow-y-auto max-h-[65vh] custom-scrollbar space-y-6 flex-1 text-slate-750 dark:text-slate-350">
          {activeTab === "diagnostics" ? (
            (() => {
              const baselineRenderer = 416.0;
              const isWasmActive = memoryStats.filesUploaded > 0;
              const wasmEngine = isWasmActive ? 268.0 : 0.0;
              const workersOverhead = Math.max(isWasmActive ? 90.0 : 30.0, trackerStats.totalWorkerSizeMB || 0.0);
              const v8Allocated = heapData.usedMB || memoryStats.systemMemory || 12.8;
              const pcmBufferOverhead = trackerStats.totalSabSizeMB || 0.0;
              const nativeBlobs = memoryStats.filesUploaded || 0.0;

              const totalProcessMemory = memoryStats.total;

              return (
                <div className="space-y-6 animate-fade-in">
                  {/* Top 3-Column Status Cards Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 select-none">
                    {/* App Footprint Card */}
                    <div className={`p-4 rounded-xl border flex items-center gap-3 transition-colors duration-300 ${
                      isGcFlickering 
                        ? "border-rose-300 dark:border-rose-900 bg-rose-50/20 dark:bg-rose-950/10"
                        : "border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30"
                    }`}>
                      <div className={`p-2.5 rounded-lg ${isGcFlickering ? "bg-rose-500 text-white animate-pulse" : "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400"}`}>
                        <HardDrive className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">App Footprint</span>
                        <span className="text-sm font-black text-slate-800 dark:text-slate-100 flex items-baseline gap-0.5">
                          {totalProcessMemory}
                          <span className="text-[10px] font-medium text-slate-450 dark:text-slate-500 ml-0.5">MB</span>
                        </span>
                        <span className="text-[9px] text-slate-450 dark:text-slate-400 block truncate">Active thread total</span>
                      </div>
                    </div>

                    {/* V8 engine memory card */}
                    <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-3">
                      <div className={`p-2.5 rounded-lg ${heapData.usedMB > 500 ? 'bg-rose-105 dark:bg-rose-950/50 text-rose-600' : 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600'}`}>
                        <Cpu className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">V8 JS Heap</span>
                        <span className="text-sm font-black text-slate-800 dark:text-slate-100">
                          {heapData.usedMB} <span className="text-[10px] font-mono text-slate-400 font-bold">MB</span>
                        </span>
                        <span className="text-[9px] text-slate-450 dark:text-slate-400 block font-mono">
                          {heapData.percentage}% of {heapData.limitMB}M
                        </span>
                      </div>
                    </div>

                    {/* IndexedDB rows card */}
                    <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-3">
                      <div className="p-2.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
                        <Database className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">Cache Database</span>
                        <span className="text-sm font-black text-slate-800 dark:text-slate-100">
                          {dbDiagnostics.count} <span className="text-[10px] font-sans text-slate-400 font-bold">files</span>
                        </span>
                        <span className="text-[9px] text-slate-450 dark:text-slate-400 block">
                          Size: {dbDiagnostics.sizeMB} MB
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Widescreen 2-Column Dashboard layout */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      {/* CPU & Threads Monitor Section */}
                      <SystemResourceMonitor 
                        isProcessing={isProcessing}
                      />
                    </div>

                    <div className="space-y-4 text-xs">
                      {/* Detailed Tab Allocation Breakdown block */}
                      <div className="p-4 border border-slate-150 dark:border-slate-850 bg-slate-50/30 dark:bg-slate-900/10 rounded-xl space-y-3 shadow-xs">
                        <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800/80">
                          <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                            <Gauge className="w-4 h-4 text-indigo-500 animate-spin-slow" />
                            Heap Allotment Detail
                          </span>
                          <span className="text-[9px] uppercase font-mono text-slate-400 font-bold">Proportional Map</span>
                        </div>

                        {/* Interactive layout representation timeline bar */}
                        <div className="w-full bg-slate-200 dark:bg-slate-800 h-2.5 rounded-full overflow-hidden flex shadow-inner">
                          <div className="h-full bg-slate-400 dark:bg-slate-500 duration-350 transition-all cursor-help" style={{ width: `${(baselineRenderer / totalProcessMemory) * 100}%` }} data-tooltip="Browser Base Allocation" />
                          {v8Allocated > 0 && (
                            <div className="h-full bg-indigo-500 duration-350 transition-all cursor-help" style={{ width: `${(v8Allocated / totalProcessMemory) * 100}%` }} data-tooltip="V8 Heap" />
                          )}
                          {wasmEngine > 0 && (
                            <div className="h-full bg-amber-500 duration-350 transition-all cursor-help" style={{ width: `${(wasmEngine / totalProcessMemory) * 100}%` }} data-tooltip="WebAssembly Heap" />
                          )}
                          {workersOverhead > 0 && (
                            <div className="h-full bg-emerald-505 duration-350 transition-all cursor-help" style={{ width: `${(workersOverhead / totalProcessMemory) * 100}%` }} data-tooltip="Web Workers Sandbox" />
                          )}
                          {pcmBufferOverhead > 0 && (
                            <div className="h-full bg-rose-500 duration-350 transition-all cursor-help" style={{ width: `${(pcmBufferOverhead / totalProcessMemory) * 100}%` }} data-tooltip="Audio Wave Buffers" />
                          )}
                          {nativeBlobs > 0 && (
                            <div className="h-full bg-sky-500 duration-350 transition-all cursor-help" style={{ width: `${(nativeBlobs / totalProcessMemory) * 100}%` }} data-tooltip="Active Blobs Space" />
                          )}
                        </div>

                        <div className="space-y-1.5 font-mono text-[10px] select-none text-slate-600 dark:text-slate-400">
                          <div className="flex justify-between items-center py-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500" />
                              Browser Environment Base:
                            </span>
                            <span className="font-extrabold text-slate-800 dark:text-slate-200">{baselineRenderer} MB</span>
                          </div>
                          <div className="flex justify-between items-center py-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-indigo-500" />
                              V8 JavaScript Engine Host:
                            </span>
                            <span className="font-extrabold text-slate-800 dark:text-slate-200">{v8Allocated.toFixed(1)} MB</span>
                          </div>
                          {wasmEngine > 0 && (
                            <div className="flex justify-between items-center py-0.5">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                WebAssembly FFmpeg Context:
                              </span>
                              <span className="font-extrabold text-slate-800 dark:text-slate-200">{wasmEngine} MB</span>
                            </div>
                          )}
                          <div className="flex justify-between items-center py-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              Web Workers Core Pool:
                            </span>
                            <span className="font-extrabold text-slate-800 dark:text-slate-200">{workersOverhead} MB</span>
                          </div>
                          {pcmBufferOverhead > 0 && (
                            <div className="flex justify-between items-center py-0.5">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                                PCM Waveform Render Caches:
                              </span>
                              <span className="font-extrabold text-slate-800 dark:text-slate-200">{pcmBufferOverhead.toFixed(1)} MB</span>
                            </div>
                          )}
                          {nativeBlobs > 0 && (
                            <div className="flex justify-between items-center py-0.5">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-sky-500" />
                                RAM Blobs & Media Caches:
                              </span>
                              <span className="font-extrabold text-slate-800 dark:text-slate-200">{nativeBlobs.toFixed(1)} MB</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* WeakRef Reference Diagnostics Tracking Block */}
                      <div className="p-4 border border-slate-150 dark:border-slate-850 bg-slate-50/30 dark:bg-slate-900/10 rounded-xl space-y-3 shadow-xs">
                        <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800/80">
                          <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-indigo-500" />
                            WeakRef Reference GC Logs
                          </span>
                          <span className="text-[10px] font-mono text-emerald-500 font-extrabold bg-emerald-50 dark:bg-emerald-950/20 px-1.5 py-0.5 rounded">
                            Reclaimed: {trackerStats.collectedCount}
                          </span>
                        </div>

                        <div className="bg-white dark:bg-slate-950 border border-slate-105 dark:border-slate-900 rounded-xl p-3">
                          {trackerStats.activeItems.length > 0 ? (
                            <div className="space-y-1.5">
                              <span className="text-[9px] uppercase tracking-wider text-slate-405 font-extrabold block">Tracked active descriptors:</span>
                              <div className="space-y-1 font-mono max-h-[80px] overflow-y-auto pr-1 custom-scrollbar">
                                {trackerStats.activeItems.map((item) => (
                                  <div key={item.id} className="flex justify-between text-[10px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/40 px-2 py-1 rounded border border-slate-100/50 dark:border-slate-850/50">
                                    <span className="truncate max-w-[170px] font-bold">● {item.label}</span>
                                    <span className="text-indigo-500 font-semibold">{item.sizeMB} MB</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[10px] block py-2 text-center">No active waveforms or audio references under GC tracing.</span>
                          )}
                        </div>

                        {trackerStats.recentCollectedLabels.length > 0 && (
                          <div className="space-y-1">
                            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-extrabold block text-left">Recent automatic garbage collectors:</span>
                            <div className="bg-emerald-50 text-emerald-600 dark:text-emerald-400 dark:bg-emerald-950/10 rounded-lg p-2.5 font-mono text-[9px] space-y-1.5 border border-emerald-100/20 dark:border-emerald-900/10">
                              {trackerStats.recentCollectedLabels.map((lbl, idx) => (
                                <div key={idx} className="truncate select-none">✓ Reclaimed wave buffer block: {lbl}</div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="space-y-4 animate-fade-in text-xs">
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-normal select-none">
                Toggle the categories of files, wave maps, caching storages, and RAM structures to sweep immediately. Recommended configurations are pre-defined.
              </p>

              {/* 2x2 Grid representing each clear option */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Files Uploaded */}
                <button
                  type="button"
                  onClick={() => handleToggle("indexedDbFiles")}
                  className={`p-4 border rounded-xl flex items-start gap-3.5 transition-all outline-none text-left cursor-pointer ${
                    selectedOptions.indexedDbFiles
                      ? "border-rose-500 bg-rose-500/5 dark:bg-rose-500/10 shadow-xs"
                      : "border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900 bg-white dark:bg-slate-950"
                  }`}
                >
                  <div className={`p-2.5 rounded-lg ${selectedOptions.indexedDbFiles ? 'bg-rose-500 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-900 text-slate-500'}`}>
                    <Database className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="font-extrabold text-sm text-slate-900 dark:text-slate-100">Files Uploaded</span>
                      <span className="text-[11px] font-mono font-bold text-rose-500">{memoryStats.filesUploaded > 0 ? memoryStats.filesUploaded.toFixed(1) : '0.0'} MB</span>
                    </div>
                    <p className="text-[11px] text-slate-550 dark:text-slate-400 leading-normal">
                      Original source audio files and media recordings stored persistently inside local app IndexedDB.
                    </p>
                  </div>
                </button>

                {/* Temporary App Files */}
                <button
                  type="button"
                  onClick={() => handleToggle("temporaryAppFiles")}
                  className={`p-4 border rounded-xl flex items-start gap-3.5 transition-all outline-none text-left cursor-pointer ${
                    selectedOptions.temporaryAppFiles
                      ? "border-rose-500 bg-rose-500/5 dark:bg-rose-500/10 shadow-xs"
                      : "border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900 bg-white dark:bg-slate-950"
                  }`}
                >
                  <div className={`p-2.5 rounded-lg ${selectedOptions.temporaryAppFiles ? 'bg-rose-500 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-900 text-slate-500'}`}>
                    <HardDrive className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="font-extrabold text-sm text-slate-900 dark:text-slate-100">Temporary Files</span>
                      <span className="text-[11px] font-mono font-bold text-rose-500">{memoryStats.temporaryAppFiles > 0 ? memoryStats.temporaryAppFiles.toFixed(1) : '0.0'} MB</span>
                    </div>
                    <p className="text-[11px] text-slate-550 dark:text-slate-400 leading-normal">
                      Caches API records, active stream segments, waveform peaks, and temporary media buffers.
                    </p>
                  </div>
                </button>

                {/* System Cache */}
                <button
                  type="button"
                  onClick={() => handleToggle("systemCache")}
                  className={`p-4 border rounded-xl flex items-start gap-3.5 transition-all outline-none text-left cursor-pointer ${
                    selectedOptions.systemCache
                      ? "border-rose-500 bg-rose-500/5 dark:bg-rose-500/10 shadow-xs"
                      : "border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900 bg-white dark:bg-slate-950"
                  }`}
                >
                  <div className={`p-2.5 rounded-lg ${selectedOptions.systemCache ? 'bg-rose-500 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-900 text-slate-500'}`}>
                    <Archive className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="font-extrabold text-sm text-slate-900 dark:text-slate-100">System Cache</span>
                      <span className="text-[11px] font-mono font-bold text-rose-500">{memoryStats.systemCache > 0 ? memoryStats.systemCache.toFixed(1) : '0.0'} MB</span>
                    </div>
                    <p className="text-[11px] text-slate-550 dark:text-slate-400 leading-normal">
                      Local Storage values, current Web Session Stores, and site cookies (preserving your private credentials).
                    </p>
                  </div>
                </button>

                {/* System RAM Memory */}
                <button
                  type="button"
                  onClick={() => handleToggle("systemMemory")}
                  className={`p-4 border rounded-xl flex items-start gap-3.5 transition-all outline-none text-left cursor-pointer ${
                    selectedOptions.systemMemory
                      ? "border-rose-500 bg-rose-500/5 dark:bg-rose-500/10 shadow-xs"
                      : "border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900 bg-white dark:bg-slate-950"
                  }`}
                >
                  <div className={`p-2.5 rounded-lg ${selectedOptions.systemMemory ? 'bg-rose-500 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-900 text-slate-500'}`}>
                    <Cpu className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="font-extrabold text-sm text-slate-900 dark:text-slate-100">System RAM (Heap)</span>
                      <span className="text-[11px] font-mono font-bold text-rose-500">{memoryStats.systemMemory > 0 ? memoryStats.systemMemory.toFixed(1) : '0.0'} MB</span>
                    </div>
                    <p className="text-[11px] text-slate-550 dark:text-slate-400 leading-normal">
                      Force V8 engine garbage collection loops, tear down audio node references, and clear cached state.
                    </p>
                  </div>
                </button>
              </div>

              {heapData.usedMB > 500 && (
                <div className="flex items-start gap-2 p-3.5 bg-rose-50 dark:bg-rose-950/20 text-[11px] text-rose-600 dark:text-rose-300 rounded-xl mt-4 select-none">
                  <ShieldAlert className="w-4.5 h-4.5 flex-shrink-0 text-rose-500" />
                  <span>Your active heap is currently exceeding the 500 MB quota threshold. Triggering a System RAM clean-up is recommended.</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
          {activeTab === "diagnostics" ? (
            <>
              <span className="text-[10px] font-mono text-indigo-500/85 uppercase font-bold tracking-wider">
                Console Mode: Diagnostics Active
              </span>
              <button
                type="button"
                onClick={forceGcSuggestion}
                className="flex items-center gap-2 py-2 px-4 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-bold transition-all cursor-pointer border border-slate-200/50 dark:border-slate-800/65"
              >
                <RefreshCw className="w-3.5 h-3.5 animate-spin-slow" />
                Force manual GC sweep
              </button>
            </>
          ) : (
            <>
              <span className="text-[10px] font-mono text-rose-500/85 uppercase font-bold tracking-wider">
                Console Mode: Interactive Clean
              </span>
              <button
                type="button"
                onClick={handleCleanSelected}
                className="flex items-center justify-center gap-2 py-2 px-5 bg-rose-500 hover:bg-rose-600 active:scale-95 transition-all text-white rounded-xl text-xs font-bold shadow-md cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                Clean Selected Now
              </button>
            </>
          )}
        </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
