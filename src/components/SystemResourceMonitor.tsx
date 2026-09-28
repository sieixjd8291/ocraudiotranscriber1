import React, { useState, useEffect } from "react";
import { Cpu, Wifi, Network } from "lucide-react";

interface SystemResourceMonitorProps {
  isProcessing?: boolean;
}

export const SystemResourceMonitor: React.FC<SystemResourceMonitorProps> = ({
  isProcessing = false,
}) => {
  // Estimated statistics states (CPU/ping/bandwidth are derived/simulated
  // values; only network type and online status come from real APIs)
  const [cpuUsage, setCpuUsage] = useState<number>(3.2);
  const [cpuHistory, setCpuHistory] = useState<number[]>(Array(15).fill(3.2));
  const [ping, setPing] = useState<number>(24);
  const [networkSpeed, setNetworkSpeed] = useState<number>(45.8);
  const [isOnline, setIsOnline] = useState<boolean>(true);

  // Poll for simulated / real network and processor statistics
  useEffect(() => {
    // Listen to network status
    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
    };
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    setIsOnline(navigator.onLine);

    // Retrieve network connection info if supported in the browser
    if (typeof navigator !== "undefined" && (navigator as any).connection) {
      const conn = (navigator as any).connection;
      if (conn.downlink) {
        // navigator.connection.downlink is already expressed in Mbps — do NOT multiply.
        setNetworkSpeed(conn.downlink);
      }
    }

    let tickCount = 0;
    const interval = setInterval(() => {
      // 0. Battery Saver Optimization: Skip ticks to save battery and suspend when tab is hidden
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return; // Suspend entirely when tab is hidden
      }
      
      const isBatterySaver = typeof window !== "undefined" && 
        (!!(window as any).isBatterySaverActive || !!(window as any).batterySaver);
      
      if (isBatterySaver) {
        tickCount++;
        if (tickCount % 4 !== 0) {
          return; // Skip 3 out of 4 ticks (updates every 4.8s)
        }
      }

      // 1. Calculate CPU Usage with high quality jitter.
      // Compute the value up front and update CPU usage + history independently,
      // instead of nesting setCpuHistory inside the setCpuUsage updater (which
      // double-fires under StrictMode/concurrent rendering).
      const base = isProcessing ? 65.0 : 2.5;
      const randomFactor = isProcessing ? Math.random() * 20 - 10 : Math.random() * 2.4 - 1.2;
      const finalVal = Math.max(1.0, Math.min(99.0, base + randomFactor));

      setCpuUsage(parseFloat(finalVal.toFixed(1)));
      setCpuHistory((history) => [...history.slice(1), finalVal]);

      // 2. Network Latency Simulation (fluctuating realistic times)
      if (!navigator.onLine) {
        setPing(0);
      } else {
        const baseline = isProcessing ? 42 : 24;
        const offset = Math.floor(Math.random() * 10) - 5;
        setPing(Math.max(8, baseline + offset));
      }

      // 3. Keep bandwidth fluctuates within a 10% envelope
      if (!navigator.onLine) {
        setNetworkSpeed(0);
      } else {
        const baseSpeed = typeof navigator !== "undefined" && (navigator as any).connection?.downlink
          ? (navigator as any).connection.downlink
          : 54.0;
        const drift = Math.random() * 4 - 2;
        setNetworkSpeed(parseFloat(Math.max(1.0, baseSpeed + drift).toFixed(1)));
      }
    }, 1200);

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
      clearInterval(interval);
    };
  }, [isProcessing]);

  // SVG Sparkline path construction helper
  const sparklineWidth = 240;
  const sparklineHeight = 24;
  const maxCpuValue = 100;
  const points = cpuHistory.map((val, idx) => {
    const x = (idx / (cpuHistory.length - 1)) * sparklineWidth;
    const y = sparklineHeight - (val / maxCpuValue) * (sparklineHeight - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  // Deduce active workers listed by system
  // There's a background pool, a ServiceWorker, and transient workers (such as Zip or cleanvoicePoll)
  const workerRegistry = [
    {
      name: "Service Worker (sw.js)",
      desc: "Local Caching & Offline Proxy",
      status: isOnline ? "Active" : "Idle",
      type: "ServiceWorker",
    },
    {
      name: "MP3 Encoder Pool (audioUtils.ts)",
      desc: "Audio Transcoder Threads",
      status: isProcessing ? "Active (Encoding)" : "Warmed (Idle)",
      type: "WebWorker",
    },
    {
      name: "Cleanvoice Poller Worker",
      desc: "Shared Task Queue Sync",
      status: isProcessing ? "Polled (Running)" : "Sleeping (Standby)",
      type: "WebWorker",
    },
    {
      name: "Zip Archive Core Worker",
      desc: "Compression / Export Thread",
      status: isProcessing ? "Active" : "Idle",
      type: "WebWorker",
    }
  ];

  return (
    <div className="p-3 border border-slate-150 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30 rounded-xl space-y-3.5 select-none animate-fade-in text-xs">
      {/* CPU Usage panel */}
      <div className="space-y-2">
        <div className="flex justify-between items-center bg-white/20 dark:bg-black/10 p-0.5 rounded-md">
          <span className="font-extrabold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            <Cpu className={`w-3.5 h-3.5 text-indigo-500 ${isProcessing ? "animate-spin-slow text-orange-500" : ""}`} />
            Processor Activity (Est.)
          </span>
          <span className={`text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded-md ${
            cpuUsage > 50 
              ? "bg-rose-50 dark:bg-rose-950/20 text-rose-600 dark:text-rose-400 animate-pulse" 
              : "bg-indigo-50 dark:bg-indigo-950/20 text-indigo-600 dark:text-indigo-400"
          }`}>
            {cpuUsage}% Load
          </span>
        </div>

        {/* Real-time Sparkline plot */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-extrabold">Activity Trend (Est.)</span>
            <span className="text-[8.5px] font-mono text-slate-400">15s Window</span>
          </div>
          <div className="w-full bg-slate-200/50 dark:bg-slate-950/50 border border-slate-100 dark:border-slate-900/60 h-8 rounded-lg flex items-center relative overflow-hidden px-1">
            <svg className="w-full h-6 overflow-visible" viewBox={`0 0 ${sparklineWidth} ${sparklineHeight}`} preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke={cpuUsage > 50 ? "#f43f5e" : "#6366f1"}
                strokeWidth="1.5"
                points={points}
                className="transition-all duration-300"
              />
            </svg>
            <div className={`absolute bottom-1 right-2 w-1.5 h-1.5 rounded-full ${
              cpuUsage > 50 ? "bg-rose-500 animate-ping" : "bg-indigo-500"
            }`} />
          </div>
        </div>
      </div>

      {/* Network Connection/Latency Panel */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center">
          <span className="font-extrabold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-indigo-500" />
            Network Pipeline Diagnostics
          </span>
          <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-1.5 py-0.5 rounded ${
            isOnline 
              ? "bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400" 
              : "bg-rose-50 dark:bg-rose-950/20 text-rose-600"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-red-500 animate-ping"}`} />
            {isOnline ? "ONLINE" : "OFFLINE"}
          </span>
        </div>

        {isOnline ? (
          <div className="grid grid-cols-2 gap-2 pt-0.5 font-mono text-[10px]">
            <div className="bg-white dark:bg-slate-950 border border-slate-100 dark:border-slate-900 p-2 rounded-lg flex flex-col justify-center">
              <span className="text-[8.5px] text-slate-400 uppercase tracking-wider">Latency (Est.)</span>
              <span className="font-extrabold text-slate-800 dark:text-slate-200 mt-0.5 flex items-center gap-1">
                {ping} ms
                <span className="w-2 h-2 rounded-full bg-emerald-500/80 animate-pulse inline-block" />
              </span>
            </div>
            <div className="bg-white dark:bg-slate-950 border border-slate-100 dark:border-slate-900 p-2 rounded-lg flex flex-col justify-center">
              <span className="text-[8.5px] text-slate-400 uppercase tracking-wider">Estimated Bandwidth</span>
              <span className="font-extrabold text-slate-800 dark:text-slate-200 mt-0.5">{networkSpeed} Mbps</span>
            </div>
          </div>
        ) : (
          <div className="p-2 border border-rose-100 dark:border-rose-950/20 bg-rose-50/30 dark:bg-rose-950/10 rounded-lg text-rose-500 text-[10px] font-semibold">
            Connection severed. Operations will use cached models and local sandboxed modules.
          </div>
        )}
      </div>

      {/* Web Workers Activity Registry */}
      <div className="space-y-2">
        <span className="font-extrabold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Network className="w-3.5 h-3.5 text-indigo-500" />
          Isolated Threads Core Pool
        </span>

        <div className="bg-white dark:bg-slate-950 border border-slate-100 dark:border-slate-900 rounded-xl p-2 divide-y divide-slate-100 dark:divide-slate-900">
          {workerRegistry.map((item, idx) => (
            <div key={idx} className="flex justify-between items-center py-1.5 text-[9.5px]">
              <div className="flex flex-col max-w-[190px]">
                <span className="font-extrabold text-slate-705 dark:text-slate-200">{item.name}</span>
                <span className="text-slate-400 leading-tight">{item.desc}</span>
              </div>
              <span className={`px-1.5 py-0.5 font-bold rounded-md font-mono text-[9px] ${
                item.status.includes("Active") || item.status.includes("Running")
                  ? "bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 animate-pulse"
                  : "bg-slate-105 dark:bg-slate-900 text-slate-400"
              }`}>
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
