import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  X,
  Battery,
  BatteryCharging,
  Clock,
  Zap,
  TrendingUp,
  AlertTriangle,
  RotateCcw,
  Cpu
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from "recharts";

interface PowerSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  batteryLevel: number | null;
  isPluggedIn: boolean;
  batterySaver: boolean;
  setBatterySaver: (active: boolean) => void;
  batteryHistory: { time: string; level: number }[];
  clearBatteryHistory: () => void;
  powerSchedule: { enabled: boolean; start: string; end: string };
  setPowerSchedule: (schedule: { enabled: boolean; start: string; end: string }) => void;
  aggressiveAutoGc: boolean;
  setAggressiveAutoGc: (enabled: boolean) => void;
}

export function PowerSettingsModal({
  isOpen,
  onClose,
  batteryLevel,
  isPluggedIn,
  batterySaver,
  setBatterySaver,
  batteryHistory,
  clearBatteryHistory,
  powerSchedule,
  setPowerSchedule,
  aggressiveAutoGc,
  setAggressiveAutoGc
}: PowerSettingsModalProps) {
  // Close the modal when the Escape key is pressed
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // If focus is in an editable field (e.g. a <input type="time">), let
        // Escape clear/blur the field first instead of dismissing the modal.
        const active = document.activeElement;
        if (active && active.tagName === "INPUT") {
          return;
        }
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm cursor-pointer"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            // Eased tween (not spring) for this heavy modal: a spring's overshoot
            // physics compound with the costly first-paint layout (recharts AreaChart
            // render) and read as an initial "jitter". The easeOut curve settles
            // deterministically with no bounce to fight.
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-2xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
          >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Advanced Power Settings
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Configure efficiency parameters and inspect discharge logs
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition-all cursor-pointer"
            aria-label="Close settings"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
          {/* Real-time Status Card */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${isPluggedIn ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                {isPluggedIn ? <BatteryCharging className="w-5 h-5" /> : <Battery className="w-5 h-5" />}
              </div>
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">Charge Status</span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {batteryLevel !== null ? `${batteryLevel}%` : "Calculating..."}
                </span>
                <span className="text-[9px] text-slate-400 block">{isPluggedIn ? "Charging Active" : "On Battery"}</span>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${batterySaver ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-600' : 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600'}`}>
                <Zap className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">Operating Mode</span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {batterySaver ? "Power Saver" : "Performance"}
                </span>
                <button
                  onClick={() => setBatterySaver(!batterySaver)}
                  className="text-[9px] text-indigo-500 hover:text-indigo-600 font-semibold underline block transition-colors cursor-pointer"
                >
                  Force Toggle
                </button>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${powerSchedule.enabled ? 'bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-400'}`}>
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold block">Auto Schedule</span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {powerSchedule.enabled ? "Enabled" : "Disabled"}
                </span>
                <span className="text-[9px] text-slate-400 block">
                  {powerSchedule.enabled ? `${powerSchedule.start} - ${powerSchedule.end}` : "Manual override active"}
                </span>
              </div>
            </div>
          </div>

          {/* Power Schedule Settings */}
          <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-950 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4.5 h-4.5 text-indigo-500" />
                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  Energy Schedule Rule
                </h4>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={powerSchedule.enabled}
                  onChange={(e) => setPowerSchedule({ ...powerSchedule, enabled: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-200 dark:bg-slate-850 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 dark:border-slate-700 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Set starting and ending thresholds to automatically toggle into Power Saver mode (reducing CPU parsing limits to 1 thread instead of 4). Ideal for conserving standby energy overnight.
            </p>

            <div className="grid grid-cols-2 gap-4 pt-1">
              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider font-bold block mb-1.5">
                  Start Activation Time
                </label>
                <input
                  type="time"
                  disabled={!powerSchedule.enabled}
                  value={powerSchedule.start}
                  onChange={(e) => setPowerSchedule({ ...powerSchedule, start: e.target.value })}
                  className="w-full text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider font-bold block mb-1.5">
                  Restore Performance Time
                </label>
                <input
                  type="time"
                  disabled={!powerSchedule.enabled}
                  value={powerSchedule.end}
                  onChange={(e) => setPowerSchedule({ ...powerSchedule, end: e.target.value })}
                  className="w-full text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* Aggressive Auto-GC Setting */}
          <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-950 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4.5 h-4.5 text-indigo-500" />
                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  Aggressive Auto Garbage Collection
                </h4>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={aggressiveAutoGc}
                  onChange={(e) => setAggressiveAutoGc(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-200 dark:bg-slate-850 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 dark:border-slate-700 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Trigger the unified aggressive garbage collection routing whenever the application RAM usage exceeds 480MB limit. This runs independently of the global power saving mode constraint to prevent container memory exhaustion.
            </p>
          </div>

          {/* Battery level history chart */}
          <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-950 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4.5 h-4.5 text-emerald-500" />
                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  Discharge & Charging Profile (Time-series)
                </h4>
              </div>
              <button
                onClick={clearBatteryHistory}
                className="flex items-center gap-1.5 text-[10px] uppercase font-extrabold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                data-tooltip="Clear profile data history"
              >
                <RotateCcw className="w-3 h-3" />
                Reset Data
              </button>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Monitors the current device charge level fluctuations. The graph dynamically populates retrospectively as intervals run.
            </p>

            <div className="h-44 w-full">
              {batteryHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={batteryHistory}
                    margin={{ top: 10, right: 10, left: -25, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="colorLevel" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={batterySaver ? "#10b981" : "#4f46e5"} stopOpacity={0.25}/>
                        <stop offset="95%" stopColor={batterySaver ? "#10b981" : "#4f46e5"} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.12} />
                    <XAxis 
                      dataKey="time" 
                      stroke="#64748b" 
                      fontSize={9} 
                      tickLine={false} 
                      axisLine={false}
                    />
                    <YAxis 
                      domain={[0, 100]} 
                      stroke="#64748b" 
                      fontSize={9} 
                      tickLine={false} 
                      axisLine={false}
                      ticks={[0, 25, 50, 75, 100]}
                    />
                    <Tooltip 
                      contentStyle={{
                        backgroundColor: "#1e293b",
                        border: "none",
                        borderRadius: "8px",
                        fontSize: "11px",
                        color: "#f8fafc"
                      }}
                      itemStyle={{ color: "#22c55e", fontWeight: "bold" }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="level" 
                      name="Charge %"
                      stroke={batterySaver ? "#10b981" : "#4f46e5"} 
                      strokeWidth={2}
                      fillOpacity={1} 
                      fill="url(#colorLevel)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/20 dark:bg-slate-900/10">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mb-1.5" />
                  <span className="text-[11px] text-slate-500">Awaiting data acquisition...</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <span className="text-[10px] font-mono text-slate-400">
            Battery API Status: ACTIVE
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition-all cursor-pointer hover:shadow-sm"
          >
            Apply Configurations
          </button>
        </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
