import React, { useState, useCallback, useEffect, useMemo } from "react";
const FileUploader = React.lazy(() => import("./components/FileUploader").then(m => ({ default: m.FileUploader })));
const AudioRecorder = React.lazy(() => import("./components/AudioRecorder").then(m => ({ default: m.AudioRecorder })));
const AudioMerger = React.lazy(() => import("./components/AudioMerger").then(m => ({ default: m.AudioMerger })));
const ResultCard = React.lazy(() => import("./components/ResultCard").then(m => ({ default: m.ResultCard })));
const CleanvoiceStudio = React.lazy(() => import("./components/CleanvoiceStudio").then(m => ({ default: m.CleanvoiceStudio })));
const CleanContextMenu = React.lazy(() => import("./components/CleanContextMenu").then(m => ({ default: m.CleanContextMenu })));
const GeminiApiKeySetup = React.lazy(() => import("./components/GeminiApiKeySetup").then(m => ({ default: m.GeminiApiKeySetup })));
import { ThemeSelector } from "./components/ThemeSelector";
const PowerSettingsModal = React.lazy(() => import("./components/PowerSettingsModal").then(m => ({ default: m.PowerSettingsModal })));
import { Greeting } from "./components/Greeting";
import { FileItem } from "./types";
import { CleanOptions } from "./components/CleanContextMenu";
import { getAllPersistedFiles, saveAllPersistedFiles, clearAllPersistedFiles, consumeSessionCleanExit } from "./services/dbService";
import { useSessionCleanup } from "./hooks/useSessionCleanup";
import { MemoryTracker } from "./utils/memoryTracker";
import { evictAudioBufferCache } from "./utils/audioBufferCache";
import { cleanvoiceBlobCache } from "./utils/cleanvoiceCache";
import {
  Languages,
  Trash2,
  Play,
  FileArchive,
  Sun,
  Moon,
  Monitor,
  Sparkles,
  Loader2,
  Menu,
  X,
  Battery,
  BatteryCharging,
  Settings,
  Eraser,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster, toast } from "sonner";

// --- Memory / aggressive-GC tuning ---------------------------------------
// `totalMB` (computed in updateMemoryStats) adds large fixed overheads
// (baselineRenderer + WASM + workers) on top of the real V8 heap, so it sits
// permanently above any fixed threshold the moment audio is loaded — driving
// `triggerGcRequest` to fire every 30s and wipe the caches (thrashing). Instead
// we trigger GC based on the RECLAIMABLE portion (the live V8 JS heap), which is
// the only part a GC pass can actually shrink. `totalMB` is kept for display.
const GC_BASELINE_RENDERER_MB = 416.0; // fixed renderer/process overhead added for display
const GC_V8_HEAP_TRIGGER_MB = 300;     // live usedJSHeapSize threshold that warrants a GC pass
const GC_MIN_INTERVAL_MS = 30000;      // back-pressure: never auto-GC more often than this

/**
 * Generate a unique id for a FileItem.
 *
 * Previously this used `Math.random().toString(36).substring(7)`, which is
 * short, collision-prone across many files, and `substring(7)` can even yield
 * an empty string for certain random mantissas. These ids back React keys and
 * abort-controller map keys, so collisions are harmful. Prefer crypto.randomUUID
 * with a robust fallback.
 */
function genId(): string {
  const c = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
  if (c) return crypto.randomUUID();
  // Fallback for older runtimes: combine timestamp + high-entropy random.
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

async function getCacheStorageSize(): Promise<number> {
  if (typeof window === "undefined" || !("caches" in window)) return 0;
  try {
    const keys = await caches.keys();
    let totalSize = 0;
    for (const key of keys) {
      const cache = await caches.open(key);
      const requests = await cache.keys();
      for (const req of requests) {
        const res = await cache.match(req);
        if (res) {
          const contentLength = res.headers.get("content-length");
          if (contentLength) {
            totalSize += parseInt(contentLength, 10);
          } else {
            // Only fall back to materializing the body when there's no
            // Content-Length header. Read it in a tight scope so the Blob is
            // GC-eligible immediately, instead of lingering across iterations.
            try {
              let blobSize = 0;
              {
                const blob = await res.blob();
                blobSize = blob.size;
              }
              totalSize += blobSize;
            } catch (error) {}
          }
        }
      }
    }
    return parseFloat((totalSize / (1024 * 1024)).toFixed(1));
  } catch (e) {
    console.error("Error computing cache size:", e);
    return 0;
  }
}

export default function App() {


  const [isOnline, setIsOnline] = useState<boolean>(() => 
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      toast.success("Connection restored! Online capabilities (Cleanvoice AI, Server Merging) are fully re-enabled.");
    };
    const handleOffline = () => {
      setIsOnline(false);
      toast.error("You are offline. Running in secure local device mode. Cleanvoice AI tab is gated.");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [isDbLoaded, setIsDbLoaded] = useState(false);
  const [appKey, setAppKey] = useState(0);

  const [memoryStats, setMemoryStats] = useState({
    filesUploaded: 0,
    temporaryAppFiles: 0,
    systemCache: 0,
    systemMemory: 0,
    total: 0
  });

  const [cleanMenuState, setCleanMenuState] = useState<{
    isOpen: boolean;
    position: { x: number; y: number } | null;
  }>({ isOpen: false, position: null });

  // Load files from IndexedDB database on startup
  useEffect(() => {
    async function initPersistedFiles() {
      try {
        // Decide CLEAR vs RESTORE based on whether the PREVIOUS session ended
        // with a normal, user-confirmed unload.
        //
        // The clean-exit flag is set during pagehide (which fires only on a real
        // discard after any beforeunload confirmation) — NOT during a hard crash
        // or forced termination, which never reaches pagehide. So:
        //   - flag present → last session was a manual close/reload → CLEAR.
        //   - flag absent  → first load, OR a crash → RESTORE the queue intact.
        // This replaces the old navigation.type === "reload" check, which missed
        // manual tab/window CLOSES (those report type "navigate", not "reload",
        // and were wrongly treated as a crash → files leaked into next session).
        const hadCleanExit = consumeSessionCleanExit();

        if (hadCleanExit) {
          console.log("Previous session ended with a confirmed page unload. Clearing persisted files.");
          await clearAllPersistedFiles();
          setFiles([]);
        } else {
          console.log("No clean-exit flag found (first load or prior crash). Restoring persisted files.");
          const persisted = await getAllPersistedFiles();
          if (persisted && persisted.length > 0) {
              // Recreate valid object URLs for restored cleaned blobs in this new session
              const restored = persisted.map((item) => {
                if (item.cleanvoiceResult?.cleanedBlob) {
                  try {
                    const refreshedUrl = URL.createObjectURL(item.cleanvoiceResult.cleanedBlob);
                    return {
                      ...item,
                      cleanvoiceResult: {
                        ...item.cleanvoiceResult,
                        cleanedUrl: refreshedUrl,
                      },
                    };
                  } catch (urlErr) {
                    console.error("Failed to recreate object URL for cleanedBlob:", urlErr);
                  }
                }
                return item;
              });
              setFiles(restored);
            }
        }
      } catch (err) {
        console.error("Failed to load/clear files during DB initialization:", err);
      } finally {
        setIsDbLoaded(true);
      }
    }
    initPersistedFiles();
  }, []);

  // Synchronize state changes back to IndexedDB database to prevent any data loss
  useEffect(() => {
    if (!isDbLoaded) return;
    saveAllPersistedFiles(files).catch((err) => {
      console.error("Failed to write updated files list to local IndexedDB:", err);
    });
  }, [files, isDbLoaded]);

  useSessionCleanup(files);
  const [autoProcess, setAutoProcess] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [remainingCredits, setRemainingCredits] = useState<number | null>(null);

  useEffect(() => {
    async function fetchCredits() {
      const apiKey = localStorage.getItem("cleanvoice_api_key");
      if (apiKey) {
        try {
          const { getCleanvoiceAccountCredits } = await import("./services/cleanvoiceService");
          const credits = await getCleanvoiceAccountCredits(apiKey);
          if (credits !== undefined) {
            setRemainingCredits(credits);
          }
        } catch (e) {
          console.warn("Failed to retrieve Cleanvoice credit balance:", e);
        }
      } else {
        setRemainingCredits(null);
      }
    }
    fetchCredits();

    const handleKeyDisconnected = () => {
      setRemainingCredits(null);
    };

    const handleKeyConnected = () => {
      fetchCredits();
    };

    const handleCreditsUpdated = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail !== undefined) {
        setRemainingCredits(customEvent.detail);
      }
    };

    window.addEventListener("cleanvoice-key-disconnected", handleKeyDisconnected);
    window.addEventListener("cleanvoice-key-connected", handleKeyConnected);
    window.addEventListener("cleanvoice-credits-updated", handleCreditsUpdated);
    return () => {
      window.removeEventListener("cleanvoice-key-disconnected", handleKeyDisconnected);
      window.removeEventListener("cleanvoice-key-connected", handleKeyConnected);
      window.removeEventListener("cleanvoice-credits-updated", handleCreditsUpdated);
    };
  }, []);

  const [isBackgroundMode, setIsBackgroundMode] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("is_background_mode");
      if (saved !== null) return saved === "true";
    }
    return true; // Default to true because it's highly desired
  });

  useEffect(() => {
    localStorage.setItem("is_background_mode", String(isBackgroundMode));
  }, [isBackgroundMode]);

  const [batterySaver, setBatterySaver] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("battery_saver_mode");
      if (saved !== null) return saved === "true";
    }
    return false;
  });

  const [aggressiveAutoGc, setAggressiveAutoGc] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("aggressive_auto_gc");
      if (saved !== null) return saved === "true";
    }
    return true; // Default to true as originally auto-triggered
  });

  const [isGcFlickering, setIsGcFlickering] = useState<boolean>(false);

  const [isPluggedIn, setIsPluggedIn] = useState<boolean>(true);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);

  const [isPowerSettingsOpen, setIsPowerSettingsOpen] = useState<boolean>(false);

  const [powerSchedule, setPowerSchedule] = useState<{ enabled: boolean; start: string; end: string }>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("power_schedule");
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {}
      }
    }
    return { enabled: false, start: "22:00", end: "07:00" };
  });

  const [batteryHistory, setBatteryHistory] = useState<{ time: string; level: number }[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("battery_history_data");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (e) {}
      }
    }
    return [];
  });

  useEffect(() => {
    localStorage.setItem("battery_saver_mode", String(batterySaver));
  }, [batterySaver]);

  useEffect(() => {
    localStorage.setItem("aggressive_auto_gc", String(aggressiveAutoGc));
  }, [aggressiveAutoGc]);

  useEffect(() => {
    localStorage.setItem("power_schedule", JSON.stringify(powerSchedule));
  }, [powerSchedule]);

  useEffect(() => {
    localStorage.setItem("battery_history_data", JSON.stringify(batteryHistory));
  }, [batteryHistory]);

  const clearBatteryHistory = useCallback(() => {
    setBatteryHistory([]);
  }, []);

  // Backwards history loader once batteryLevel is available
  useEffect(() => {
    if (batteryHistory.length === 0 && batteryLevel !== null) {
      const now = new Date();
      const mockHistory = [];
      const baseVal = batteryLevel;
      // Derive the synthetic trend direction from the real charging state so
      // the back-history is consistent: charging => levels were lower in the
      // past (rising toward now); discharging => levels were higher (falling).
      const stepSign = isPluggedIn ? -1 : 1;
      for (let i = 9; i >= 0; i--) {
        const pastTime = new Date(now.getTime() - i * 120000); // 2 min intervals
        const levelVal = Math.min(100, Math.max(1, baseVal + stepSign * Math.floor(i / 2)));
        mockHistory.push({
          time: pastTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          level: levelVal
        });
      }
      setBatteryHistory(mockHistory);
    }
  }, [batteryLevel, batteryHistory.length, isPluggedIn]);

  // Synchronize dynamic battery history entries as they occur
  useEffect(() => {
    if (batteryLevel === null) return;
    setBatteryHistory((prev) => {
      const timeStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const lastEntry = prev[prev.length - 1];
      if (lastEntry) {
        if (lastEntry.level === batteryLevel) {
          if (lastEntry.time === timeStr) return prev;
        }
      }
      const updated = [...prev, { time: timeStr, level: batteryLevel }];
      if (updated.length > 30) {
        updated.shift();
      }
      return updated;
    });
  }, [batteryLevel]);

  // Helper to verify if time lies in start/end schedule bounds
  const checkTimeInSchedule = useCallback((startStr: string, endStr: string): boolean => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = startStr.split(":").map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = endStr.split(":").map(Number);
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  }, []);

  // Automatically enforce scheduled performance toggles
  useEffect(() => {
    if (!powerSchedule.enabled) return;

    const checkSchedule = () => {
      const withinSchedule = checkTimeInSchedule(powerSchedule.start, powerSchedule.end);
      if (withinSchedule) {
        setBatterySaver((prev) => {
          if (!prev) {
            toast.info("Power Saver scheduled activation starting now!");
          }
          return true;
        });
      } else {
        setBatterySaver((prev) => {
          if (prev) {
            toast.info("Entering Performance mode automatically from Power Schedule.");
          }
          return false;
        });
      }
    };

    checkSchedule();
    const timer = setInterval(checkSchedule, 20000); // Check every 20s
    return () => clearInterval(timer);
  }, [powerSchedule, checkTimeInSchedule]);

  // Listen to visibility changes to trigger re-evaluation of battery checking frequency
  const [isTabVisible, setIsTabVisible] = useState(true);
  useEffect(() => {
    const handleVisibility = () => {
      setIsTabVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Poll/Check Battery Status API with a frequency that scales dynamically to conserve energy
  useEffect(() => {
    if (typeof navigator === "undefined" || !("getBattery" in navigator)) {
      setIsPluggedIn(false);
      return;
    }

    // Interval time: 15 seconds when active foreground, 120 seconds in background or during power saving mode
    const isInactiveOrSaving = !isTabVisible || batterySaver;
    const intervalTime = isInactiveOrSaving ? 120000 : 15000;

    let batteryInstance: any = null;

    const updateBatteryState = (battery: any) => {
      setIsPluggedIn(battery.charging);
      const currentLevel = Math.round(battery.level * 100);
      setBatteryLevel(currentLevel);
      if (currentLevel < 45 && !battery.charging) {
        setBatterySaver((prev) => {
          if (!prev) {
            toast.warning(`Battery level dropped to ${currentLevel}%. Battery Saver mode automatically enabled.`);
            return true;
          }
          return prev;
        });
      }
    };

    // The Battery API returns the same singleton on every call, so resolve it
    // once and reuse the promise for the initial read, interval retry, and
    // listener-attach path (avoids 3 redundant getBattery() round-trips).
    const batteryPromise: Promise<any> | null =
      typeof navigator !== "undefined" && (navigator as any).getBattery
        ? (navigator as any).getBattery().catch((err: any) => {
            console.warn("Battery status API not accessible:", err);
            return null;
          })
        : Promise.resolve(null);

    // Initial fetch
    batteryPromise.then((battery: any) => {
      if (battery) {
        batteryInstance = battery;
        updateBatteryState(battery);
      }
    });

    const intervalId = setInterval(() => {
      if (batteryInstance) {
        updateBatteryState(batteryInstance);
      } else {
        batteryPromise.then((battery: any) => {
          if (battery) {
            batteryInstance = battery;
            updateBatteryState(battery);
          }
        });
      }
    }, intervalTime);

    // Keep event listeners active only in foreground performance state to reduce background event wakeups
    const onChargingChange = () => {
      if (batteryInstance) updateBatteryState(batteryInstance);
    };
    const onLevelChange = () => {
      if (batteryInstance) updateBatteryState(batteryInstance);
    };

    // Track exactly which battery instance the listeners were attached to so
    // cleanup can remove them from the SAME instance (not a potentially-stale
    // closure reference of the outer `batteryInstance`, which a re-render may
    // have reassigned). Also guard against the attach promise resolving AFTER
    // cleanup has already run, which would otherwise leak a dangling listener.
    let attachedBattery: any = null;
    let isEffectActive = true;

    if (!isInactiveOrSaving) {
      batteryPromise.then((battery: any) => {
        if (!isEffectActive || !battery) return; // effect torn down or unsupported
        attachedBattery = battery;
        battery.addEventListener("chargingchange", onChargingChange);
        battery.addEventListener("levelchange", onLevelChange);
      });
    }

    return () => {
      isEffectActive = false;
      clearInterval(intervalId);
      if (attachedBattery) {
        attachedBattery.removeEventListener("chargingchange", onChargingChange);
        attachedBattery.removeEventListener("levelchange", onLevelChange);
      }
    };
  }, [isTabVisible, batterySaver]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).isBatterySaverActive = batterySaver && !isPluggedIn;
      (window as any).batterySaver = batterySaver;
      (window as any).isPluggedIn = isPluggedIn;
      (window as any).batteryLevel = batteryLevel;
    }
  }, [batterySaver, isPluggedIn, batteryLevel]);

  const [activeAppTool, setActiveAppTool] = useState<
    "transcribe" | "cleanvoice"
  >("transcribe");

  const [hasLoadedCleanvoice, setHasLoadedCleanvoice] = useState(false);

  useEffect(() => {
    if (activeAppTool === "cleanvoice") {
      setHasLoadedCleanvoice(true);
    }
  }, [activeAppTool]);

  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("gemini_api_key") || "";
    }
    return "";
  });

  const handleTabSwitch = useCallback((tool: "transcribe" | "cleanvoice") => {
    if (tool === "cleanvoice" && !isOnline) {
      toast.error("This feature is unavailable offline. Please connect to the internet.");
      return;
    }
    setActiveAppTool(tool);
  }, [isOnline]);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("selectedModel");
      if (saved) return saved;
    }
    return "gemini-3.5-flash-lite";
  });
  const autoRetry = true;

  const [selectedQuality, setSelectedQuality] = useState<"source" | "320" | "192" | "128">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("cleanvoice_output_bitrate_v2");
      if (saved === "source" || saved === "320" || saved === "192" || saved === "128") {
        return saved as "source" | "320" | "192" | "128";
      }
    }
    return "source";
  });

  useEffect(() => {
    localStorage.setItem("cleanvoice_output_bitrate_v2", selectedQuality);
  }, [selectedQuality]);

  useEffect(() => {
    localStorage.setItem("selectedModel", selectedModel);
    if (activeAppTool === "transcribe") {
      const handleInteraction = () => {
        if (typeof window !== "undefined" && "requestIdleCallback" in window) {
          window.requestIdleCallback(() => {
            import("./services/geminiService").then(({ prewarmGeminiClient }) => {
              prewarmGeminiClient(selectedModel);
            }).catch(() => {});
          });
        } else {
          setTimeout(() => {
            import("./services/geminiService").then(({ prewarmGeminiClient }) => {
              prewarmGeminiClient(selectedModel);
            }).catch(() => {});
          }, 1000);
        }
        window.removeEventListener("mousemove", handleInteraction);
        window.removeEventListener("touchstart", handleInteraction);
        window.removeEventListener("scroll", handleInteraction);
      };

      window.addEventListener("mousemove", handleInteraction, { once: true, passive: true });
      window.addEventListener("touchstart", handleInteraction, { once: true, passive: true });
      window.addEventListener("scroll", handleInteraction, { once: true, passive: true });

      return () => {
        window.removeEventListener("mousemove", handleInteraction);
        window.removeEventListener("touchstart", handleInteraction);
        window.removeEventListener("scroll", handleInteraction);
      };
    }
  }, [selectedModel, activeAppTool]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).activeAppTool = activeAppTool;
    }
  }, [activeAppTool]);

  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("theme");
      if (saved === "light" || saved === "dark" || saved === "system") return saved as "light" | "dark" | "system";
    }
    return "system";
  });

  // Prevent background scroll when mobile drawer is opened
  useEffect(() => {
    if (isDrawerOpen) {
      document.body.classList.add("overflow-hidden");
    } else {
      document.body.classList.remove("overflow-hidden");
    }
    return () => {
      document.body.classList.remove("overflow-hidden");
    };
  }, [isDrawerOpen]);

  // Handle mobile-specific swipe gestures for the collapsible drawer
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let activeSwipe = false;
    let hasTriggered = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      // COMPLETELY DISMISS SWIPES starting on interactive elements (buttons, logs tabs, checkboxes, delete icons)
      // to resolve any click sensitivity/overlap conflicts entirely.
      const target = e.target as HTMLElement;
      if (target && target.closest && target.closest("button, a, input, select, textarea, [role='button'], .cursor-pointer")) {
        activeSwipe = false;
        return;
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      activeSwipe = true;
      hasTriggered = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!activeSwipe || hasTriggered) return;
      if (e.touches.length !== 1) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;

      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const screenWidth = window.innerWidth;

      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      // Balanced vertical constraint (absDeltaX > absDeltaY * 0.9): tolerates natural diagonal thumb motions.
      // Small recognition threshold (15px) to detect lateral intentions early.
      if (absDeltaX > 15 && absDeltaX > absDeltaY * 0.9) {
        const swipeThreshold = 35; // Effortless and natural target

        if (!isDrawerOpen) {
          const isSwipeLeft = deltaX < -swipeThreshold;
          // Comfortable, accessible 130px edge window to perform swipes starting from the right area
          const isNearRightEdge = startX > screenWidth - 130;

          if (isSwipeLeft && isNearRightEdge) {
            setIsDrawerOpen(true);
            hasTriggered = true;
            activeSwipe = false;
          }
        } else {
          // Swipe to Close when panel is open: simple drag right to pop close
          const isSwipeRight = deltaX > swipeThreshold;
          if (isSwipeRight) {
            setIsDrawerOpen(false);
            hasTriggered = true;
            activeSwipe = false;
          }
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!activeSwipe || hasTriggered) {
        activeSwipe = false;
        hasTriggered = false;
        return;
      }
      if (e.changedTouches.length !== 1) {
        activeSwipe = false;
        return;
      }

      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const screenWidth = window.innerWidth;

      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      // Verify final swipe state on touch release
      if (absDeltaX > 35 && absDeltaX > absDeltaY * 0.9) {
        if (!isDrawerOpen) {
          const isSwipeLeft = deltaX < -35;
          const isNearRightEdge = startX > screenWidth - 130;

          if (isSwipeLeft && isNearRightEdge) {
            setIsDrawerOpen(true);
          }
        } else {
          const isSwipeRight = deltaX > 35;
          if (isSwipeRight) {
            setIsDrawerOpen(false);
          }
        }
      }

      activeSwipe = false;
      hasTriggered = false;
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    const handleTouchCancel = () => {
      activeSwipe = false;
      hasTriggered = false;
    };
    window.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [isDrawerOpen]);

  // Close the mobile drawer when the Escape key is pressed (also works with external keyboards on tablets)
  useEffect(() => {
    if (!isDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setIsDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDrawerOpen]);

  const [processingState, setProcessingState] = useState({
    isProcessing: false,
    total: 0,
    current: 0,
  });

  const filesRef = React.useRef(files);
  filesRef.current = files;

  const [isZipping, setIsZipping] = useState(false);

  // Track processing state transitions to show a toast
  const prevProcessingCount = React.useRef(
    files.filter((f) => f.status === "processing").length,
  );
  useEffect(() => {
    const currentProcessingCount = files.filter(
      (f) => f.status === "processing",
    ).length;
    if (prevProcessingCount.current > 0 && currentProcessingCount === 0) {
      const hasSuccess = files.some((f) => f.status === "success");
      if (hasSuccess) {
        import("sonner").then(({ toast }) => {
          toast.success("Transcription finished!", {
            description: "Your transcription results are ready.",
          });
        });
      }
    }
    prevProcessingCount.current = currentProcessingCount;
  }, [files]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
    const root = document.documentElement;

    const applyTheme = (t: "light" | "dark" | "system") => {
      if (t === "system") {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        if (mediaQuery.matches) {
          root.classList.add("dark");
        } else {
          root.classList.remove("dark");
        }
      } else if (t === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    applyTheme(theme);

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = (e: MediaQueryListEvent) => {
        if (e.matches) {
          root.classList.add("dark");
        } else {
          root.classList.remove("dark");
        }
      };
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    }
  }, [theme]);

  // Silent audio backdrop to prevent background tab sleeping/throttling when active
  useEffect(() => {
    let silentAudioCtx: AudioContext | null = null;
    let silentOsc: OscillatorNode | null = null;

    const isBatterySaverActive = batterySaver && !isPluggedIn;

    if (isBackgroundMode && processingState.isProcessing && !isBatterySaverActive) {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          silentAudioCtx = new AudioContextClass();
          const osc = silentAudioCtx.createOscillator();
          const gainNode = silentAudioCtx.createGain();
          
          gainNode.gain.setValueAtTime(0, silentAudioCtx.currentTime);
          
          osc.connect(gainNode);
          gainNode.connect(silentAudioCtx.destination);
          osc.start();
          silentOsc = osc;
          console.log("[Background Mode] Silent audio context initialized successfully to keep background thread active.");
        }
      } catch (e) {
        console.warn("[Background Mode] Silent audio context start failed:", e);
      }
    }

    return () => {
      if (silentOsc) {
        try {
          silentOsc.stop();
        } catch (_) {}
      }
      if (silentAudioCtx && silentAudioCtx.state !== 'closed') {
        try {
          silentAudioCtx.close();
        } catch (_) {}
      }
    };
  }, [isBackgroundMode, processingState.isProcessing, batterySaver, isPluggedIn]);

  // When switching to the Cleanvoice AI tool, automatically check key validity and show the popup if invalid/missing
  useEffect(() => {
    if (activeAppTool === "cleanvoice") {
      const apiKey = localStorage.getItem("cleanvoice_api_key") || "";
      if (apiKey) {
        import("./services/cleanvoiceService").then(({ verifyApiKey }) => {
          verifyApiKey(apiKey).then((isValid) => {
            if (!isValid) {
              window.dispatchEvent(new Event("open-cleanvoice-settings"));
            }
          });
        }).catch((err) => {
          console.warn("Cleanvoice key verify failed:", err);
        });
      }
    }

    if (activeAppTool === "transcribe") {
      const geminiKey = localStorage.getItem("gemini_api_key") || "";

      if (geminiKey) {
        import("./services/geminiService").then(({ prewarmGeminiClient }) => {
          prewarmGeminiClient();
        }).catch(() => {});
      }
    }
  }, [activeAppTool]);

  const processingQueueRef = React.useRef<
    { id: string; isAutoAttempt: boolean; itemOverride?: FileItem }[]
  >([]);
  const activeProcessCountRef = React.useRef<number>(0);
  const runningTasksSetRef = React.useRef<Set<string>>(new Set());
  const CONCURRENCY_LIMIT = (batterySaver && !isPluggedIn) ? 1 : 4;
  // Mirror CONCURRENCY_LIMIT into a ref so the queue ticker (a useCallback that
  // does NOT list batterySaver/isPluggedIn in its deps) always reads the live
  // value. Without this, toggling battery saver wouldn't change the active
  // polling concurrency until the user happened to switch models.
  const concurrencyLimitRef = React.useRef(CONCURRENCY_LIMIT);
  concurrencyLimitRef.current = CONCURRENCY_LIMIT;

  const enqueueProcessingRef = React.useRef<Function | null>(null);
  const transcriptionAbortControllersRef = React.useRef<Record<string, AbortController>>({});
  // Tracks pending auto-retry timers so cancel/delete can clear them and
  // avoid re-enqueueing a file the user already removed or cancelled.
  const retryTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Dedup guard for the reactive background pre-upload effect: once a file ID
  // has been handed to the effect, it is never handed again — even if the
  // uploadPromise/remoteUrl/cleanvoiceResult guards are circumvented by a race
  // (React 19 concurrent re-render, StrictMode double-invoke, or a state reset).
  // This is the hard backstop that prevents an infinite re-upload loop, where
  // each re-upload calls POST /v2/upload and consumes Cleanvoice's per-key
  // rate-limit budget, causing 429s that slow polling to 20s and make the job
  // appear stuck in a "bootloop". Cleared only when a file's content actually
  // changes (handleUpdateFile) so the new bytes get one fresh background upload.
  const bgUploadedFileIdsRef = React.useRef<Set<string>>(new Set());

  const executeProcessingInternal = useCallback(
    async (id: string, isAutoAttempt = false, itemOverride?: FileItem) => {
      const fileItem =
        itemOverride || filesRef.current.find((f) => f.id === id);
      if (!fileItem) return;

      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                status: "processing",
                retryMessage: undefined,
                error: undefined,
                retryAttempts: isAutoAttempt ? (f.retryAttempts || 0) + 1 : 0,
              }
            : f,
        ),
      );

      const controller = new AbortController();
      transcriptionAbortControllersRef.current[id] = controller;
      const requestedModel = fileItem.preferredModel || selectedModel;

      try {
        const { processFile } = await import("./services/geminiService");
        const { text, modelUsed } = await processFile(
          fileItem.file,
          fileItem.type,
          (attempt, max, delay, err) => {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      retryMessage:
                        err?.message ||
                        `Transient network issue. Retrying (${attempt}/${max}) in ${Math.round(delay / 1000)}s...`,
                    }
                  : f,
              ),
            );
          },
          requestedModel,
          controller.signal,
          (chunkText) => {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      result: chunkText,
                    }
                  : f,
              ),
            );
          }
        );

        if (!controller.signal.aborted) {
          const modelDisplayNames: Record<string, string> = {
            "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
            "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
            "gemini-3.6-flash": "Gemini 3.6 Flash",
            "gemini-3.5-flash": "Gemini 3.5 Flash",
          };
          const niceRequested = modelDisplayNames[requestedModel] || requestedModel;
          const niceUsed = modelDisplayNames[modelUsed] || modelUsed;

          if (modelUsed && modelUsed !== requestedModel && modelUsed === "gemini-3.5-flash-lite") {
            toast.info(`Switched back to ${niceUsed}. The requested model ${niceRequested} might be temporarily unavailable or hit a quota limit.`, {
              duration: 6000,
            });
          } else if (modelUsed && modelUsed !== requestedModel) {
            toast.info(`Switched to ${niceUsed}. The requested model ${niceRequested} might be temporarily unavailable.`, {
              duration: 6000,
            });
          }

          // Register transcript text with MemoryTracker
          try {
            MemoryTracker.register(
              { id, text }, 
              `Transcript Results (${fileItem.name})`, 
              "String (Transcript)", 
              text.length * 2
            );
          } catch(e) {}

          setFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? {
                    ...f,
                    status: "success",
                    result: text,
                    modelUsed,
                    retryMessage: undefined,
                    retryAttempts: 0,
                  }
                : f,
            ),
          );

        }
      } catch (error: any) {
        const errStr = String(error?.message || error);
        if (controller.signal.aborted || error?.name === "AbortError" || errStr.includes("AbortError") || errStr.includes("cancelled") || errStr.includes("aborted")) {
          console.log(`Processing aborted for file ID: ${id}`);
          
          const currentController = transcriptionAbortControllersRef.current[id];
          const isStaleAbort = currentController && currentController !== controller;

          if (!isStaleAbort) {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      status: "pending",
                      retryMessage: undefined,
                      error: undefined,
                    }
                  : f,
              ),
            );
          }
          return;
        }

        const errorMessage = error.message || "Failed to process file";

        const isTranscribeAuthError = errorMessage.toLowerCase().includes("invalid api key") || errorMessage.includes("401");
        const isPermissionDenied = errorMessage.toLowerCase().includes("permission_denied") || errorMessage.toLowerCase().includes("denied access") || errorMessage.includes("status 403");

        if (isTranscribeAuthError || isPermissionDenied) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? {
                    ...f,
                    status: "error",
                    error: isPermissionDenied
                      ? "Your Google Cloud / Gemini API Project has been denied access (PERMISSION_DENIED). Please check your API Key configuration, billing, or contact Google support."
                      : "Invalid API credentials for transcription. Please check your config.",
                    retryMessage: undefined,
                  }
                : f,
            ),
          );
          return;
        }

        const updatedItem = filesRef.current.find((f) => f.id === id);
        const currentAttempts = updatedItem?.retryAttempts || 0;

        if (autoRetry) {
          if (currentAttempts < 3) {
            const nextAttempt = currentAttempts + 1;
            setFiles((prev) =>
              prev.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      status: "processing", // Keeps the UI in processing state to avoid premature error flags
                      retryMessage: `Verifying server-side completion... API timeout detected. Auto-reconnecting (Attempt ${nextAttempt}/3) in 2s...`,
                    }
                  : f,
              ),
            );

            const retryTimer = setTimeout(() => {
              delete retryTimersRef.current[id];
              const currentItem = filesRef.current.find((f) => f.id === id);
              // We check for 'processing' as we kept it in that state instead of error
              if (
                currentItem &&
                (currentItem.status === "processing" ||
                  currentItem.status === "pending" ||
                  currentItem.status === "queued")
              ) {
                enqueueProcessingRef.current?.(id, true);
              }
            }, 2000);
            retryTimersRef.current[id] = retryTimer;
          } else {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      status: "error",
                      error: errorMessage,
                      retryMessage: `Verification failed. Auto-retry exhausted (tried 3 times).`,
                    }
                  : f,
              ),
            );
            console.error("Gemini file processing error:", error);
          }
        } else {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? {
                    ...f,
                    status: "error",
                    error: errorMessage,
                    retryMessage: undefined,
                  }
                : f,
            ),
          );
          console.error("Gemini file processing error:", error);
        }
      } finally {
        delete transcriptionAbortControllersRef.current[id];
        // If a retry timer is somehow still pending (e.g. success path, or an
        // error path that bypassed the retry branch), cancel it so it can't
        // fire after this file has settled.
        const pendingRetryTimer = retryTimersRef.current[id];
        if (pendingRetryTimer) {
          clearTimeout(pendingRetryTimer);
          delete retryTimersRef.current[id];
        }
      }
    },
    [autoRetry, selectedModel],
  );

  const tickProcessingQueue = useCallback(() => {
    while (
      activeProcessCountRef.current < concurrencyLimitRef.current &&
      processingQueueRef.current.length > 0
    ) {
      const nextTask = processingQueueRef.current.shift();
      if (nextTask) {
        runningTasksSetRef.current.add(nextTask.id);
        activeProcessCountRef.current = runningTasksSetRef.current.size;
        (async () => {
          try {
            await executeProcessingInternal(
              nextTask.id,
              nextTask.isAutoAttempt,
              nextTask.itemOverride,
            );
          } catch (err: any) {
             console.error("Task processing failed:", err);
          } finally {
            runningTasksSetRef.current.delete(nextTask.id);
            activeProcessCountRef.current = runningTasksSetRef.current.size;

            // Update progress state metrics on complete or error
            setProcessingState((prev) => {
              const remaining =
                processingQueueRef.current.length +
                activeProcessCountRef.current;
              if (remaining === 0) {
                return { isProcessing: false, current: 0, total: 0 };
              }
              return {
                ...prev,
                current: Math.max(0, prev.total - remaining),
              };
            });

            tickProcessingQueue();
          }
        })();
      }
    }
  }, [executeProcessingInternal]);

  const executeProcessing = useCallback(
    async (id: string, isAutoAttempt = false, itemOverride?: FileItem) => {
      const exists = processingQueueRef.current.some((task) => task.id === id);
      if (exists) return;

      const fileToQueue = itemOverride || filesRef.current.find(f => f.id === id);
      const fileType = fileToQueue?.type;
      const isMp3 = fileType === 'audio/mp3' || fileType === 'audio/mpeg';
      const isFastTrack = fileToQueue?.duration !== undefined && fileToQueue.duration < 30;
      const isExplicitModelSet = !!(itemOverride?.preferredModel || fileToQueue?.preferredModel);

      let updatedItemOverride = itemOverride;
      if (isFastTrack && !isExplicitModelSet) {
        updatedItemOverride = updatedItemOverride || fileToQueue;
        if (updatedItemOverride) {
          updatedItemOverride = { ...updatedItemOverride, preferredModel: "gemini-3.5-flash-lite" };
        }
      }

      if (isMp3 || isFastTrack) {
        // High Priority Queue: bypass standard wait times completely
        runningTasksSetRef.current.add(id);
        activeProcessCountRef.current = runningTasksSetRef.current.size;
        setFiles((prev) =>
          prev.map((f) =>
            f.id === id
              ? {
                  ...f,
                  status: "processing",
                  preferredModel: (isFastTrack && !isExplicitModelSet) ? "gemini-3.5-flash-lite" : (itemOverride?.preferredModel || f.preferredModel),
                  retryMessage: undefined,
                  error: undefined,
                  retryAttempts: isAutoAttempt ? (f.retryAttempts || 0) + 1 : 0,
                }
              : f,
          ),
        );
        
        setProcessingState((prev) => {
          const remainingTasks = processingQueueRef.current.length + activeProcessCountRef.current;
          return {
            isProcessing: true,
            total: prev.isProcessing ? Math.max(prev.total, remainingTasks) : remainingTasks,
            current: prev.isProcessing ? prev.current : 0,
          };
        });

        (async () => {
          try {
            await executeProcessingInternal(id, isAutoAttempt, updatedItemOverride);
          } catch (err: any) {
            console.error("High priority task processing failed:", err);
          } finally {
            runningTasksSetRef.current.delete(id);
            activeProcessCountRef.current = runningTasksSetRef.current.size;
            setProcessingState((prev) => {
              const remaining = processingQueueRef.current.length + activeProcessCountRef.current;
              if (remaining === 0) {
                return { isProcessing: false, current: 0, total: 0 };
              }
              return {
                ...prev,
                current: Math.max(0, prev.total - remaining),
              };
            });
            tickProcessingQueue();
          }
        })();
        return;
      }

      processingQueueRef.current.push({ id, isAutoAttempt, itemOverride: updatedItemOverride });

      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                status: "queued",
                retryMessage: undefined,
                error: undefined,
                retryAttempts: isAutoAttempt ? (f.retryAttempts || 0) + 1 : 0,
              }
            : f,
        ),
      );

      // Update processing state and display total files metrics
      setProcessingState((prev) => {
        const remainingTasks =
          processingQueueRef.current.length + activeProcessCountRef.current;
        return {
          isProcessing: true,
          total: prev.isProcessing
            ? Math.max(prev.total, remainingTasks)
            : remainingTasks,
          current: prev.isProcessing ? prev.current : 0,
        };
      });

      tickProcessingQueue();
    },
    [tickProcessingQueue, executeProcessingInternal],
  );

  useEffect(() => {
    enqueueProcessingRef.current = executeProcessing;
  }, [executeProcessing]);

  const processSpecificFile = useCallback(
    async (item: FileItem) => {
      await executeProcessing(item.id, false, item);
    },
    [executeProcessing],
  );

  const addFiles = useCallback(
    async (newFiles: File[]) => {
      if (!newFiles || newFiles.length === 0) return;

      const newItems: FileItem[] = newFiles.map((file) => {
        const dotIndex = file.name.lastIndexOf(".");
        const originalExtension = dotIndex !== -1 ? file.name.substring(dotIndex + 1).toLowerCase() : undefined;
        return {
          id: genId(),
          file,
          name: file.name,
          type: file.type,
          status: "pending",
          duration: undefined,
          originalExtension,
          sourceBitrate: "128", // default placeholder, gets updated once duration is retrieved
        };
      });
      
      setFiles((prev) => [...prev, ...newItems]);
      
      // Fetch durations and stream chunk uploads asynchronously so UI doesn't hang
      newItems.forEach((item) => {
        const isAudio = item.type.startsWith('audio/') || item.type.startsWith('video/') || !!item.name.toLowerCase().match(/\.(wav|mp3|m4a|ogg|aac|flac|webm|wbm|mp4|mkv|wem|wma|opus)$/i);
        if (isAudio) {
          // Fire and forget duration check to never block upload
          import("./utils/audioUtils").then(({ getAudioMetadataDetailed }) => {
            getAudioMetadataDetailed(item.file).then((metadata) => {
              if (metadata && metadata.duration > 0) {
                const { duration, sampleRate, channels } = metadata;
              const rawKbps = ((item.file?.size || 0) * 8) / (duration * 1000);
              const standardBitrates = [320, 256, 192, 160, 128, 96, 64, 32];
              const closestBitrate = standardBitrates.reduce((prev, curr) => 
                Math.abs(curr - rawKbps) < Math.abs(prev - rawKbps) ? curr : prev
              );
              let detectedBitrate = closestBitrate.toString();
              const isWebMRecording = item.name.toLowerCase().endsWith('.webm') || item.type.includes('webm');
              if (isWebMRecording && closestBitrate < 128) {
                detectedBitrate = "128";
              }
              setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, duration, sourceBitrate: detectedBitrate, sourceSampleRate: sampleRate || undefined, sourceChannels: channels || undefined } : f));
              }
            }).catch(console.error);
          }).catch(console.error);

          // Trigger parallel background upload chunking for Cleanvoice directly in the addFiles flow!
          const apiKey = localStorage.getItem("cleanvoice_api_key");
          // Read the LIVE battery-saver flag from window instead of the closure's
          // `batterySaver`/`isPluggedIn` state: this useCallback doesn't list those
          // in its deps, so toggling saver after addFiles was created would leave a
          // stale value here and wrongly upload (or skip uploading) for files added
          // afterwards. `window.isBatterySaverActive` is updated synchronously by the
          // effect on every saver/plugged change.
          const isBatterySaverActive = typeof window !== "undefined" && (window as any).isBatterySaverActive;
          const isOnlineAtRuntime = typeof navigator !== "undefined" ? navigator.onLine : true;
          // Strictly only upload to Cleanvoice if the user has manually chosen the Cleanvoice tab/tool.
          if (activeAppTool === "cleanvoice" && apiKey && !isBatterySaverActive && isOnlineAtRuntime) {
            try {
              setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: true } : f));
              
              const startUpload = async () => {
                try {
                  // Load it dynamically to avoid top level import clutter right now
                  const { streamMediaChunksParallel } = await import("./services/cleanvoiceService");
                  let fileToUpload: File | Blob = item.file;
                  
                  const doUpload = async () => {
                    try {
                      const remoteUrl = await streamMediaChunksParallel(
                         fileToUpload,
                         item.name,
                         apiKey,
                         (msg) => {
                           console.log(`[Background Upload] ${item.name}: ${msg}`);
                           // Mirror real byte-level upload progress onto the file
                           // item so the per-file "Uploading N%" indicator advances
                           // during the eager background upload (and the active-file
                           // progress bar while it's awaiting this upload).
                           const m = msg.match(/(\d+)% complete/);
                           if (m) {
                             const pct = Math.min(100, parseInt(m[1], 10));
                             setFiles((prev) => prev.map((f) => f.id === item.id && f.uploadProgress !== pct ? { ...f, uploadProgress: pct } : f));
                           }
                         }
                      );
                      // Save to the original file reference to bypass CleanvoiceStudio's internal upload step!
                      (item.file as any).remoteUrl = remoteUrl;
                      setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: false, remoteUrl } : f));
                      return remoteUrl;
                    } catch (err: any) {
                      const errMsg = err.message || String(err);
                      if (err?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) {
                        setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: false } : f));
                        throw err;
                      }
                      
                      const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
                      const isCreditError = errMsg.includes("402") || errMsg.toLowerCase().includes("credit");
                      
                      if (isAuthError || isCreditError) {
                        console.warn(`[Background Upload] Expected error for ${item.name}: ${errMsg}`);
                      } else {
                        console.error(`[Background Upload] Failed for ${item.name}: ${errMsg}`);
                      }

                      if (isCreditError) {
                        if (activeAppTool === "cleanvoice") {
                          window.dispatchEvent(new Event("open-cleanvoice-settings"));
                        }
                      } else if (isAuthError) {
                        if (activeAppTool === "cleanvoice") {
                          import("./services/cleanvoiceService").then(({ triggerCleanvoiceAuthOrCreditError }) => {
                            triggerCleanvoiceAuthOrCreditError();
                          }).catch(e => console.warn(e));
                        }
                      }
                      setFiles((prev) => prev.map((f) => f.id === item.id ? { 
                        ...f, 
                        isUploading: false,
                        cleanvoiceResult: (isCreditError || isAuthError) ? {
                          status: "error",
                          error: isAuthError ? "Invalid Cleanvoice API Key. Please verify your credentials." : "Insufficient Cleanvoice Credits. Please check your API key.",
                          logs: [`[Background Upload] Failed: ${errMsg}`]
                        } : f.cleanvoiceResult 
                      } : f));
                      
                      if (!isAuthError) {
                        throw err;
                      }
                    }
                  };
                  return await doUpload();
                } catch (outerErr: any) {
                  const errMsg = outerErr?.message || String(outerErr);
                  const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
                  if (!isAuthError) {
                    console.error("Background upload setup failed:", outerErr);
                  } else {
                    console.warn("Background upload setup failed of expected auth validation: ", errMsg);
                  }
                }
              };
              
              (item.file as any).uploadPromise = startUpload().catch(err => {
                const errMsg = err?.message || String(err);
                if (err?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) return;
                
                const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
                if (!isAuthError) {
                  console.error("Background upload failed:", err);
                } else {
                  console.warn("Background upload failed of expected auth validation: ", errMsg);
                }
              });
            } catch (outerErr: any) {
              const errMsg = outerErr?.message || String(outerErr);
              if (outerErr?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) return;
              
              const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
              if (!isAuthError) {
                console.error("Background upload setup failed:", outerErr);
              } else {
                console.warn("Background upload setup failed (Auth Error):", errMsg);
              }
            }
          }
        }
      });

      if (autoProcess) {
        newItems.forEach((item) => {
          // Use a short timeout so that the files rendering catches and filesRef has a chance to settle
          // although executeProcessing itemOverride handles State nicely, React 19 concurrent mode might still trip
          setTimeout(() => processSpecificFile(item), 50);
        });
      }
    },
    [autoProcess, processSpecificFile, activeAppTool],
  );

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (e.clipboardData && e.clipboardData.files.length > 0) {
        const pastedFiles = Array.from(e.clipboardData.files);
        addFiles(pastedFiles);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  // Reactive Background Pre-Uploading effect to eliminate upload latency completely.
  // This is the safety net that pre-uploads files regardless of which tool tab is
  // active (unlike the eager path in addFiles/addRecording which gates on
  // activeAppTool === "cleanvoice"). Fires ONCE per file — no retry. If the
  // background upload fails, uploadPromise resolves to undefined (a truthy
  // Promise), which keeps this effect from re-firing, and the foreground
  // startCleanvoiceEdit path re-uploads synchronously as the fallback. This
  // deliberately avoids extra POST /v2/upload sign requests that would consume
  // Cleanvoice's per-key rate-limit budget (shared with POST /v2/edits and the
  // processing poller) and cause the edit to never be created.
  useEffect(() => {
    const apiKey = localStorage.getItem("cleanvoice_api_key");
    const isBatterySaverActive = typeof window !== "undefined" && (window as any).isBatterySaverActive;
    if (!apiKey || isBatterySaverActive || !isOnline) return;

    files.forEach((item) => {
      const isAudio = item.type?.startsWith('audio/') || item.type?.startsWith('video/') || !!item.name.toLowerCase().match(/\.(wav|mp3|m4a|ogg|aac|flac|webm|wbm|mp4|mkv|wem|wma|opus)$/i);
      if (!isAudio) return;

      const fileObj = item.file as any;
      if (!fileObj) return;
      // Already uploaded — nothing to do.
      if (fileObj.remoteUrl) return;
      // Upload in flight or already attempted — never restart it. A settled
      // promise (even one that resolved to undefined after a failure) is truthy
      // and blocks re-entry, preventing duplicate sign requests.
      if (fileObj.uploadPromise) return;
      // Skip files that are being processed or have already been processed by
      // the foreground Cleanvoice path. The foreground startCleanvoiceEdit call
      // does NOT set uploadPromise on the File, so without this guard the
      // reactive effect would see "no remoteUrl, no uploadPromise" during
      // foreground processing and start a DUPLICATE background upload — each
      // duplicate calls POST /v2/upload, consuming Cleanvoice's per-key
      // rate-limit budget that the processing poller shares, triggering 429s
      // and 20-second polling penalties that make the job appear stuck.
      // Any cleanvoiceResult means the foreground path has taken ownership;
      // handleUpdateFile resets cleanvoiceResult to undefined so new content
      // after a compress/edit gets a fresh background upload.
      if (item.cleanvoiceResult) return;
      // Hard dedup backstop: even if all the guards above are circumvented by
      // a render race (React 19 concurrent mode, StrictMode double-invoke, a
      // state reset), this ref Set ensures each file ID is handed to the
      // background uploader AT MOST ONCE per session. Without this, a re-upload
      // loop is possible: each extra upload calls POST /v2/upload, consuming
      // Cleanvoice's per-key rate-limit budget, causing 429s that slow polling
      // to 20s and make the job appear stuck in an infinite "bootloop".
      // handleUpdateFile clears this entry when the file's content changes so
      // the new bytes get exactly one fresh background upload.
      if (bgUploadedFileIdsRef.current.has(item.id)) return;
      bgUploadedFileIdsRef.current.add(item.id);

      console.log(`[Reactive Pre-Upload] Starting background pre-upload for: ${item.name}`);

      // Mark file as uploading in background
      setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: true } : f));

      const startUpload = async () => {
        try {
          const { streamMediaChunksParallel } = await import("./services/cleanvoiceService");
          const remoteUrl = await streamMediaChunksParallel(
            item.file,
            item.name,
            apiKey,
            (msg) => {
              console.log(`[Reactive Pre-Upload] ${item.name}: ${msg}`);
              const m = msg.match(/(\d+)% complete/);
              if (m) {
                const pct = Math.min(100, parseInt(m[1], 10));
                setFiles((prev) => prev.map((f) => f.id === item.id && f.uploadProgress !== pct ? { ...f, uploadProgress: pct } : f));
              }
            }
          );
          fileObj.remoteUrl = remoteUrl;
          setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: false, remoteUrl } : f));
          return remoteUrl;
        } catch (err: any) {
          const errMsg = err.message || String(err);
          console.error(`[Reactive Pre-Upload] Failed for ${item.name}: ${errMsg}`);
          setFiles((prev) => prev.map((f) => f.id === item.id ? { ...f, isUploading: false } : f));
          throw err;
        }
      };

      fileObj.uploadPromise = startUpload().catch((err) => {
        console.error(`[Reactive Pre-Upload Promise] Error for ${item.name}:`, err);
      });
    });
  }, [files, isOnline]);

  // Immediate server-side file and cache deletion upon page unload / tab closure
  useEffect(() => {
    const handleUnload = () => {
      const currentFiles = filesRef.current;
      if (!currentFiles || currentFiles.length === 0) return;

      const editIds: string[] = [];
      const remoteUrls: string[] = [];

      currentFiles.forEach((f) => {
        if (f.cleanvoiceResult?.editId) {
          editIds.push(f.cleanvoiceResult.editId);
        }
        if (f.remoteUrl && !f.remoteUrl.startsWith("blob:")) {
          remoteUrls.push(f.remoteUrl);
        }
        if (f.cleanvoiceResult?.cleanedUrl && !f.cleanvoiceResult.cleanedUrl.startsWith("blob:")) {
          remoteUrls.push(f.cleanvoiceResult.cleanedUrl);
        }
        if (f.cleanvoiceResult?.preTranscodedUrl && !f.cleanvoiceResult.preTranscodedUrl.startsWith("blob:")) {
          remoteUrls.push(f.cleanvoiceResult.preTranscodedUrl);
        }
      });

      const apiKey = localStorage.getItem("cleanvoice_api_key");

      if (editIds.length > 0 || remoteUrls.length > 0) {
        // Use fetch with keepalive: true to guarantee delivery of the deletion payload during page teardown
        fetch("/api/cleanup-on-close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            editIds,
            remoteUrls,
            apiKey: apiKey || undefined
          }),
          keepalive: true
        }).catch(() => {});
      }
    };

    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  const addRecording = useCallback(
    async (blob: Blob, name: string) => {
      const explicitDuration = (blob as any).metadataDuration;
      const originalFiles = (blob as any).originalFiles;
      const file = new File([blob], name, { type: blob.type });
      if (explicitDuration !== undefined) {
        (file as any).metadataDuration = explicitDuration;
      }
      if (originalFiles !== undefined) {
        (file as any).originalFiles = originalFiles;
      }

      const dotIndex = name.lastIndexOf(".");
      const originalExtension = dotIndex !== -1 ? name.substring(dotIndex + 1).toLowerCase() : "webm";

      const newItem: FileItem = {
        id: genId(),
        file,
        name,
        type: blob.type,
        status: "pending",
        duration: explicitDuration !== undefined ? explicitDuration : undefined,
        originalExtension,
        sourceBitrate: "128", // default to 128 for recordings
      };
      setFiles((prev) => [...prev, newItem]);

      if (explicitDuration === undefined) {
        import("./utils/audioUtils").then(({ getAudioMetadataDetailed }) => {
          getAudioMetadataDetailed(file).then((metadata) => {
            if (metadata && metadata.duration > 0) {
              const { duration: dur, sampleRate, channels } = metadata;
              const rawKbps = (file.size * 8) / (dur * 1000);
              const standardBitrates = [320, 256, 192, 160, 128, 96, 64, 32];
              const closestBitrate = standardBitrates.reduce((prev, curr) =>
                Math.abs(curr - rawKbps) < Math.abs(prev - rawKbps) ? curr : prev
              );
              let detectedBitrate = closestBitrate.toString();
              const isWebMRecording = name.toLowerCase().endsWith('.webm') || file.type.includes('webm');
              if (isWebMRecording) {
                detectedBitrate = "128";
              }
              setFiles((prev) => prev.map((f) => f.id === newItem.id ? { ...f, duration: dur, sourceBitrate: detectedBitrate, sourceSampleRate: sampleRate || undefined, sourceChannels: channels || undefined } : f));
            }
          });
        }).catch(console.error);
      }

      // Trigger parallel background upload chunking for Cleanvoice directly in the recording flows!
      const apiKey = localStorage.getItem("cleanvoice_api_key");
      // Read the LIVE battery-saver flag from window instead of the closure's
      // `batterySaver`/`isPluggedIn` state: this useCallback doesn't list those
      // in its deps, so toggling saver after addRecording was created would leave
      // a stale value here and wrongly upload (or skip uploading) for recordings
      // made afterwards. `window.isBatterySaverActive` is updated synchronously.
      const isBatterySaverActive = typeof window !== "undefined" && (window as any).isBatterySaverActive;
      const isOnlineAtRuntime = typeof navigator !== "undefined" ? navigator.onLine : true;
      // Strictly only upload to Cleanvoice if the user has manually chosen the Cleanvoice tab/tool.
      if (activeAppTool === "cleanvoice" && apiKey && !isBatterySaverActive && isOnlineAtRuntime) {
        try {
          setFiles((prev) => prev.map((f) => f.id === newItem.id ? { ...f, isUploading: true } : f));
          
          import("./services/cleanvoiceService").then(async ({ streamMediaChunksParallel }) => {
            const doUpload = async () => {
              try {
                const remoteUrl = await streamMediaChunksParallel(
                   file,
                   name,
                   apiKey,
                   (msg) => {
                     console.log(`[Background Upload Feedback] ${name}: ${msg}`);
                     const m = msg.match(/(\d+)% complete/);
                     if (m) {
                       const pct = Math.min(100, parseInt(m[1], 10));
                       setFiles((prev) => prev.map((f) => f.id === newItem.id && f.uploadProgress !== pct ? { ...f, uploadProgress: pct } : f));
                     }
                   }
                );
                (file as any).remoteUrl = remoteUrl;
                setFiles((prev) => prev.map((f) => f.id === newItem.id ? { ...f, isUploading: false, remoteUrl } : f));
                return remoteUrl;
              } catch (err: any) {
                const errMsg = err.message || String(err);
                if (err?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) {
                  setFiles((prev) => prev.map((f) => f.id === newItem.id ? { ...f, isUploading: false } : f));
                  throw err;
                }
                const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
                const isCreditError = errMsg.includes("402") || errMsg.toLowerCase().includes("credit");
                
                if (isAuthError || isCreditError) {
                  console.warn(`[Background Upload Feedback] Expected error for ${name}: ${errMsg}`);
                } else {
                  console.error(`[Background Upload Feedback] Failed for ${name}: ${errMsg}`);
                }

                if (isCreditError) {
                  if (activeAppTool === "cleanvoice") {
                    window.dispatchEvent(new Event("open-cleanvoice-settings"));
                  }
                } else if (isAuthError) {
                  if (activeAppTool === "cleanvoice") {
                    import("./services/cleanvoiceService").then(({ triggerCleanvoiceAuthOrCreditError }) => {
                      triggerCleanvoiceAuthOrCreditError();
                    }).catch(e => console.warn(e));
                  }
                }
                setFiles((prev) => prev.map((f) => f.id === newItem.id ? { 
                  ...f, 
                  isUploading: false,
                  cleanvoiceResult: (isCreditError || isAuthError) ? {
                    status: "error",
                    error: isAuthError ? "Invalid Cleanvoice API Key. Please verify your credentials." : "Insufficient Cleanvoice Credits. Please check your API key.",
                    logs: [`[Background Upload] Failed: ${errMsg}`]
                  } : f.cleanvoiceResult 
                } : f));
                
                if (!isAuthError) {
                  throw err;
                }
              }
            };
            
            (file as any).uploadPromise = doUpload().catch(err => {
              const errMsg = err?.message || String(err);
              if (err?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) return;
              
              const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
              if (!isAuthError) {
                console.error("Recording background upload failed:", err);
              } else {
                console.warn("Recording background upload failed (Auth Error):", err);
              }
            });
          }).catch(outerErr => {
            const errMsg = outerErr?.message || String(outerErr);
            if (outerErr?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) return;
            console.error("Recording background upload import failed:", outerErr);
          });
        } catch (outerErr: any) {
          const errMsg = outerErr?.message || String(outerErr);
          if (outerErr?.name === "AbortError" || errMsg.includes("AbortError") || errMsg.includes("cancelled")) return;
          
          const isAuthError = errMsg.includes("401") || errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("invalid cleanvoice api key") || errMsg.toLowerCase().includes("cleanvoice api key") || errMsg.includes("E1001");
          if (!isAuthError) {
            console.error("Recording background upload setup failed:", outerErr);
          } else {
            console.warn("Recording background upload setup failed (Auth Error):", outerErr);
          }
        }
      }

      if (autoProcess) {
        setTimeout(() => processSpecificFile(newItem), 50);
      }
    },
    [autoProcess, processSpecificFile, activeAppTool],
  );

  const cancelProcessing = useCallback((id: string) => {
    // 1. If queued (not yet active)
    const existsInQueue = processingQueueRef.current.some((task) => task.id === id);
    if (existsInQueue) {
      processingQueueRef.current = processingQueueRef.current.filter((task) => task.id !== id);
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                status: "pending",
                retryMessage: undefined,
                error: undefined,
              }
            : f,
        ),
      );
      // Update metrics
      setProcessingState((prev) => {
        const remainingTasks = processingQueueRef.current.length + activeProcessCountRef.current;
        if (remainingTasks === 0) {
          return { isProcessing: false, current: 0, total: 0 };
        }
        return {
          ...prev,
          current: Math.max(0, prev.total - 1),
        };
      });
      return;
    }

    // 2. If actively processing
    const controller = transcriptionAbortControllersRef.current[id];
    if (controller) {
      controller.abort();
      delete transcriptionAbortControllersRef.current[id];
    }

    // Cancel any pending auto-retry timer for this file so it doesn't fire
    // after the user has explicitly cancelled.
    const pendingRetryTimer = retryTimersRef.current[id];
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      delete retryTimersRef.current[id];
    }

    if (runningTasksSetRef.current.has(id)) {
      runningTasksSetRef.current.delete(id);
      activeProcessCountRef.current = runningTasksSetRef.current.size;
    }

    // Update progress state metrics on cancel of an active task
    setProcessingState((prev) => {
      const remaining = processingQueueRef.current.length + activeProcessCountRef.current;
      if (remaining === 0) {
        return { isProcessing: false, current: 0, total: 0 };
      }
      return {
        ...prev,
        current: Math.max(0, prev.total - 1),
      };
    });

    // Always set files state for the cancelled item back to pending
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              status: "pending",
              retryMessage: undefined,
              error: undefined,
            }
          : f,
      ),
    );
  }, []);

  const deleteFile = useCallback((id: string) => {
    cancelProcessing(id);

    const fileItem = filesRef.current.find((f) => f.id === id);
    if (fileItem) {
      // Explicitly revoke all Blob URLs associated with this file to prevent memory leaks
      if (fileItem.cleanvoiceResult?.cleanedUrl) {
        try { URL.revokeObjectURL(fileItem.cleanvoiceResult.cleanedUrl); } catch (e) {}
      }
      if (fileItem.file && (fileItem.file as any).preview) {
        try { URL.revokeObjectURL((fileItem.file as any).preview); } catch (e) {}
      }
      if (fileItem.remoteUrl && fileItem.remoteUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(fileItem.remoteUrl); } catch (e) {}
      }

      // Gather editId and remoteUrls for immediate cleanup on cloud/server
      const editId = fileItem.cleanvoiceResult?.editId;
      const remoteUrls = [fileItem.remoteUrl].filter((u) => u && !u.startsWith("blob:")) as string[];
      if (fileItem.cleanvoiceResult?.cleanedUrl && !fileItem.cleanvoiceResult.cleanedUrl.startsWith("blob:")) {
        remoteUrls.push(fileItem.cleanvoiceResult.cleanedUrl);
      }
      if (fileItem.cleanvoiceResult?.preTranscodedUrl && !fileItem.cleanvoiceResult.preTranscodedUrl.startsWith("blob:")) {
        remoteUrls.push(fileItem.cleanvoiceResult.preTranscodedUrl);
      }
      const apiKey = localStorage.getItem("cleanvoice_api_key");

      if (editId || remoteUrls.length > 0) {
        // Send a batch cleanup request to the server so it removes all server-side traces immediately
        fetch("/api/cleanup-on-close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            editIds: editId ? [editId] : [],
            remoteUrls,
            apiKey: apiKey || undefined
          }),
          keepalive: true
        }).catch((err) => console.warn("Failed to send cleanup-on-close request:", err));
      }
    }
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, [cancelProcessing]);

  const processSingleFile = useCallback(async (id: string) => {
    await executeProcessing(id);
  }, [executeProcessing]);

  const clearAll = useCallback(() => {
    const filesSnapshot = [...filesRef.current];

    // Explicitly revoke all Blob/Object URLs associated with files before clearing to release memory
    filesSnapshot.forEach((f) => {
      if (f.cleanvoiceResult?.cleanedUrl) {
        try { URL.revokeObjectURL(f.cleanvoiceResult.cleanedUrl); } catch (e) {}
      }
      if (f.file && (f.file as any).preview) {
        try { URL.revokeObjectURL((f.file as any).preview); } catch (e) {}
      }
      if (f.remoteUrl && f.remoteUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(f.remoteUrl); } catch (e) {}
      }
    });

    // Gather editIds and remoteUrls for all files to wipe out from the server
    const editIds: string[] = [];
    const remoteUrls: string[] = [];

    filesSnapshot.forEach((f) => {
      if (f.cleanvoiceResult?.editId) {
        editIds.push(f.cleanvoiceResult.editId);
      }
      if (f.remoteUrl && !f.remoteUrl.startsWith("blob:")) {
        remoteUrls.push(f.remoteUrl);
      }
      if (f.cleanvoiceResult?.cleanedUrl && !f.cleanvoiceResult.cleanedUrl.startsWith("blob:")) {
        remoteUrls.push(f.cleanvoiceResult.cleanedUrl);
      }
      if (f.cleanvoiceResult?.preTranscodedUrl && !f.cleanvoiceResult.preTranscodedUrl.startsWith("blob:")) {
        remoteUrls.push(f.cleanvoiceResult.preTranscodedUrl);
      }
    });

    setFiles([]);
    setProcessingState({ isProcessing: false, current: 0, total: 0 });
    processingQueueRef.current = [];
    runningTasksSetRef.current.clear();
    activeProcessCountRef.current = 0;

    // Abort all active transcription processes
    Object.values(transcriptionAbortControllersRef.current).forEach((controller) => {
      controller.abort();
    });
    transcriptionAbortControllersRef.current = {};

    // Cancel any pending auto-retry timers so they can't re-enqueue files
    // after the queue has been cleared.
    Object.values(retryTimersRef.current).forEach((timer) => {
      clearTimeout(timer);
    });
    retryTimersRef.current = {};

    const apiKey = localStorage.getItem("cleanvoice_api_key");

    if (editIds.length > 0 || remoteUrls.length > 0) {
      // Send a batch cleanup request to the server so it removes all server-side traces immediately
      fetch("/api/cleanup-on-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editIds,
          remoteUrls,
          apiKey: apiKey || undefined
        }),
        keepalive: true
      }).catch((err) => console.warn("Failed to send batch cleanup-on-close request:", err));

      // Also clean up old dangling job listings in background
      if (apiKey) {
        import("./services/cleanvoiceService").then(({ cleanupOldCleanvoiceEdits }) => {
          cleanupOldCleanvoiceEdits(apiKey).catch((e) => console.warn(e));
        }).catch(() => {});
      }
    }
  }, []);

  const downloadAllAsZip = async () => {
    const successFiles = files.filter(
      (f) => f.status === "success" && f.result,
    );
    if (successFiles.length === 0 || isZipping) return;

    setIsZipping(true);

    try {
      const worker = new Worker(
        new URL("./workers/zipWorker.ts", import.meta.url),
        { type: "module" },
      );

      worker.onmessage = (e) => {
        const { type, blob, error } = e.data;
        if (type === "success") {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `OCR_Results_${new Date().toISOString().slice(0, 10)}.zip`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          console.error("Failed to generate ZIP archive in worker:", error);
        }
        setIsZipping(false);
        worker.terminate();
      };

      worker.onerror = (err) => {
        console.error("Worker error:", err);
        setIsZipping(false);
        worker.terminate();
      };

      worker.postMessage({
        files: successFiles.map((f) => ({ name: f.name, result: f.result })),
      });
    } catch (err) {
      console.error("Failed to initialize ZIP worker:", err);
      setIsZipping(false);
    }
  };

  const handleEditResult = useCallback((id: string, newResult: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, result: newResult } : f)),
    );
  }, []);

  const handleSelectModel = useCallback((id: string, model: string) => {
    // Proactively warm up the newly selected model for this item
    import("./services/geminiService").then(({ prewarmGeminiClient }) => {
      prewarmGeminiClient(model);
    }).catch(() => {});

    // 1. Synchronously abort and clean up active transcription instances for this specific file
    const controller = transcriptionAbortControllersRef.current[id];
    if (controller) {
      try {
        controller.abort();
      } catch(e) {}
      delete transcriptionAbortControllersRef.current[id];
    }

    // Cancel any pending auto-retry timer so it can't fire and re-enqueue the
    // file with the old (pre-model-change) state.
    const pendingRetryTimer = retryTimersRef.current[id];
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      delete retryTimersRef.current[id];
    }

    if (runningTasksSetRef.current.has(id)) {
      runningTasksSetRef.current.delete(id);
      activeProcessCountRef.current = runningTasksSetRef.current.size;
    }

    // Reflect cancellation metrics synchronously
    setProcessingState((prev) => {
      const remainingTasks = processingQueueRef.current.length + activeProcessCountRef.current;
      return {
        ...prev,
        total: Math.max(prev.total, remainingTasks),
      };
    });

    // Build the updated file ONCE from the ref (not as a side effect inside the
    // setFiles updater, which React may invoke twice in StrictMode and is not
    // guaranteed to run before the setTimeout fires). The same object is then
    // applied to state and reused for re-processing.
    const currentFile = filesRef.current.find((f) => f.id === id);
    if (!currentFile) return;
    const updatedFile: FileItem = {
      ...currentFile,
      preferredModel: model,
      status: "pending" as const,
      error: undefined,
      result: undefined,
      modelUsed: undefined,
      retryMessage: undefined,
      retryAttempts: 0,
    };

    setFiles((prev) =>
      prev.map((f) => (f.id === id ? updatedFile : f)),
    );

    setTimeout(() => {
      // Re-resolve from the ref in case state shifted between render and the
      // timeout firing; fall back to the object we just built.
      const fileToProcess = filesRef.current.find((f) => f.id === id) || updatedFile;
      executeProcessing(id, false, fileToProcess);
    }, 50);
  }, [executeProcessing]);

  const handleUpdateFile = useCallback((id: string, newFile: Blob | File, newBitrate?: number) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id === id) {
          return {
            ...f,
            file: newFile,
            type: newFile.type,
            name: newFile instanceof File ? newFile.name : f.name,
            sourceBitrate: newBitrate ? newBitrate.toString() : f.sourceBitrate,
            status: "pending" as const,
            error: undefined,
            result: undefined,
            retryMessage: undefined,
            retryAttempts: 0,
            // The content changed (compress / waveform edit), so the previous
            // background upload's remoteUrl is stale — it points at the OLD
            // bytes. Reset the upload state so the reactive pre-upload effect
            // starts a fresh background upload of the NEW content, keeping the
            // upload phase hidden at clean-time instead of reverting to a slow
            // synchronous upload.
            isUploading: false,
            uploadProgress: 0,
            remoteUrl: undefined,
            cleanvoiceResult: undefined,
          };
        }
        return f;
      }),
    );
    // Content changed: clear the dedup guard so the new bytes get exactly one
    // fresh background upload, and clear the old File's stale upload state.
    bgUploadedFileIdsRef.current.delete(id);
    const oldFile = filesRef.current.find((f) => f.id === id)?.file as any;
    if (oldFile) { delete oldFile.remoteUrl; delete oldFile.uploadPromise; }

    const isAudio = newFile.type.startsWith('audio/') || newFile.type.startsWith('video/') || !!(newFile instanceof File ? newFile.name : '').toLowerCase().match(/\.(wav|mp3|m4a|ogg|aac|flac|webm|wbm|mp4|mkv|wem|wma|opus)$/i);
    if (isAudio) {
      import("./utils/audioUtils").then(({ getAudioMetadataDetailed }) => {
        getAudioMetadataDetailed(newFile).then((metadata) => {
          if (metadata && metadata.duration > 0) {
            const { duration, sampleRate, channels } = metadata;
            const rawKbps = ((newFile.size || 0) * 8) / (duration * 1000);
            const standardBitrates = [320, 256, 192, 160, 128, 96, 64, 32];
            const closestBitrate = standardBitrates.reduce((prev, curr) => 
              Math.abs(curr - rawKbps) < Math.abs(prev - rawKbps) ? curr : prev
            );
            const detectedBitrate = newBitrate ? newBitrate.toString() : closestBitrate.toString();
            setFiles((prev) => prev.map((f) => f.id === id ? {
              ...f,
              duration,
              sourceBitrate: detectedBitrate,
              sourceSampleRate: sampleRate || undefined,
              sourceChannels: channels || undefined
            } : f));
          }
        }).catch((e) => {
          console.warn("Failed to extract metadata for updated file:", e);
        });
      }).catch(console.error);
    }
  }, []);

  const handleRenameFile = useCallback((id: string, newName: string) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id === id) {
          const originalFile = f.file;
          let renamedFile = originalFile;
          if (originalFile instanceof File) {
            renamedFile = new File([originalFile], newName, {
              type: originalFile.type,
            });
            // Preserve non-standard properties the background upload pipeline
            // attaches to the File host object. Dropping these (as a prior
            // version did) caused renamed files to be silently re-uploaded to
            // Cleanvoice on the next edit attempt.
            const propsToCopy = [
              "metadataDuration",
              "originalFiles",
              "remoteUrl",
              "uploadPromise",
            ];
            for (const prop of propsToCopy) {
              const val = (originalFile as any)[prop];
              if (val !== undefined) {
                (renamedFile as any)[prop] = val;
              }
            }
          }
          return {
            ...f,
            name: newName,
            file: renamedFile,
          };
        }
        return f;
      }),
    );
  }, []);

  // Stable callbacks passed to ResultCard so React.memo can skip re-renders.
  const handleUpdateCleanvoiceAudio = useCallback(
    (id: string, newUrl: string, customName?: string, newBitrate?: number) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f;
          // Revoke the old preTranscodedUrl blob so it doesn't leak, and clear
          // the stale preTranscodedBlob/preTranscodedUrl so the download and
          // waveform pick up the freshly-compressed cleanedUrl instead of the
          // old background-transcode copy.
          if (f.cleanvoiceResult?.preTranscodedUrl && f.cleanvoiceResult.preTranscodedUrl !== newUrl) {
            try { URL.revokeObjectURL(f.cleanvoiceResult.preTranscodedUrl); } catch (e) {}
          }
          return {
            ...f,
            sourceBitrate: newBitrate ? newBitrate.toString() : f.sourceBitrate,
            cleanvoiceResult: f.cleanvoiceResult
              ? {
                  ...f.cleanvoiceResult,
                  cleanedUrl: newUrl,
                  cleanedFileName:
                    customName || f.cleanvoiceResult.cleanedFileName,
                  preTranscodedBlob: undefined,
                  preTranscodedUrl: newUrl,
                }
              : undefined,
          };
        }),
      );
    },
    [],
  );

  const handleToggleAudioSource = useCallback(
    (id: string, source: "original" | "refined") => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, useCleanedAudio: source === "refined" } : f,
        ),
      );
    },
    [],
  );

  const handleRenameAllWebmToMp3 = useCallback(() => {
    // Snapshot the CURRENT files outside the state updater. Every expensive / fallible
    // operation (File construction, property copying) happens HERE, wrapped in try/catch,
    // so a failure can never:
    //   - throw inside the setFiles updater (which would propagate as a render error,
    //     hit the ErrorBoundary, and visually destroy the whole file queue), or
    //   - revoke / null out the active source Blob/URL (the previous crash path).
    // On ANY error we keep the original FileItem untouched and surface a toast instead.
    const propsToCopy = [
      "metadataDuration",
      "originalFiles",
      "remoteUrl",
      "uploadPromise",
    ];

    // Pre-build all renamed files. If even one fails, `renamedById` stays partial
    // but the state is updated with whatever succeeded — the failing file simply
    // keeps its original .webm source Blob (never cleared).
    const renamedById: Record<string, { name: string; file: File }> = {};
    for (const f of filesRef.current) {
      if (!f.name.toLowerCase().endsWith(".webm")) continue;
      try {
        const dotIndex = f.name.lastIndexOf(".");
        const baseName =
          dotIndex !== -1 ? f.name.substring(0, dotIndex) : f.name;
        const newName = `${baseName}.mp3`;

        // Construct from the SAME underlying Blob so the original bytes are
        // preserved by reference. If this throws (e.g. detached/cloned Blob in
        // a torn-down worker), we leave f untouched and continue.
        const newFile = new File([f.file], newName, { type: "audio/mp3" });
        for (const prop of propsToCopy) {
          const val = (f.file as any)[prop];
          if (val !== undefined) {
            (newFile as any)[prop] = val;
          }
        }
        renamedById[f.id] = { name: newName, file: newFile };
      } catch (err) {
        // Never clear/destroy the source on conversion failure — keep the
        // original .webm FileItem intact and warn the user.
        console.warn(
          `[Webm→MP3] Failed to rename "${f.name}", keeping original file:`,
          err,
        );
        try {
          toast.error(`Could not rename "${f.name}". Original file kept.`);
        } catch (_) {}
      }
    }

    if (Object.keys(renamedById).length === 0) return;

    // Only touch the items that successfully built a new File. The updater body
    // is now a pure, throw-free map — it can never crash the render.
    setFiles((prev) =>
      prev.map((f) => {
        const renamed = renamedById[f.id];
        if (!renamed) return f;
        return { ...f, name: renamed.name, file: renamed.file };
      }),
    );
  }, []);

  const lastAutoGcRef = React.useRef<number>(0);
  const triggerGcRequestRef = React.useRef<() => void>(() => {});

  const updateMemoryStats = useCallback(async (isImmediateAfterClear = false, clearedOptions?: CleanOptions) => {
    let totalBytes = 0;
    // Read from the ref so this callback's identity stays stable regardless of
    // `files` updates — otherwise the 2.5s polling interval below gets torn down
    // and recreated on every file change.
    const currentFiles = filesRef.current;
    currentFiles.forEach((f) => {
      if (f.file && typeof f.file.size === 'number') {
        totalBytes += f.file.size;
      }
      if (f.cleanvoiceResult?.cleanedBlob && typeof f.cleanvoiceResult.cleanedBlob.size === 'number') {
        totalBytes += f.cleanvoiceResult.cleanedBlob.size;
      }
    });
    
    // filesUploaded: Only the active user uploaded files size
    const filesUploadedMB = parseFloat((totalBytes / (1024 * 1024)).toFixed(1));

    // temporaryAppFiles: Pure Cache Storage size computed directly from Cache API
    const cacheSizeMB = await getCacheStorageSize();
    const temporaryAppFilesMB = parseFloat(cacheSizeMB.toFixed(1));

    // systemCache: Local Storage + Session Storage + cookies representation
    let sysCacheBytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const item = localStorage.getItem(localStorage.key(i) as string);
        if (item) sysCacheBytes += item.length * 2;
      }
    } catch(e) {}
    let systemCacheMB = parseFloat((sysCacheBytes / (1024 * 1024) + 0.1).toFixed(1));

    let systemMemoryMB = 0;
    if (typeof performance !== "undefined" && (performance as any).memory) {
      const mem = (performance as any).memory;
      systemMemoryMB = parseFloat((mem.usedJSHeapSize / (1024 * 1024)).toFixed(1));
    } else {
      systemMemoryMB = parseFloat((filesUploadedMB * 0.8 + 80).toFixed(1));
    }

    setMemoryStats(prev => {
      // If we just manually cleared, forcibly drop the visuals immediately and keep them low
      let finalFiles = filesUploadedMB;
      let finalTemp = temporaryAppFilesMB;
      let finalCache = systemCacheMB;
      let finalMemory = systemMemoryMB;

      if (isImmediateAfterClear && clearedOptions) {
        if (clearedOptions.indexedDbFiles) finalFiles = 0.0;
        if (clearedOptions.temporaryAppFiles) finalTemp = 0.0;
        if (clearedOptions.systemCache) finalCache = 0.0;
        if (clearedOptions.systemMemory) finalMemory = Math.min(systemMemoryMB, 12.0);
      } else {
        // Hold the visually cleared state for a few ticks or smooth out GC visual lag
        if (prev.filesUploaded === 0 && finalFiles < 1.0) finalFiles = 0.0;
        if (prev.temporaryAppFiles === 0 && finalTemp < 1.0) finalTemp = 0.0;
        if (prev.systemCache === 0 && finalCache < 0.2) finalCache = 0.0;
        if (prev.systemMemory < 20 && systemMemoryMB > prev.systemMemory && systemMemoryMB < 100) {
          finalMemory = prev.systemMemory;
        }
      }

      const isWasmActive = finalFiles > 0;
      const trackerStats = MemoryTracker.getStats();
      const sabOverhead = trackerStats.totalSabSizeMB || 0.0;
      const registeredWorkersOverhead = trackerStats.totalWorkerSizeMB || 0.0;
      
      const wasmOverhead = isWasmActive ? 268.0 : 0.0;
      const workersOverhead = Math.max(isWasmActive ? 90.0 : 30.0, registeredWorkersOverhead);
      const baselineRenderer = GC_BASELINE_RENDERER_MB;
      
      // Use usedJSHeapSize more accurately to avoid misleading reports as requested
      const v8Allocated = (typeof window !== "undefined" && (window.performance as any)?.memory)
        ? (window.performance as any).memory.usedJSHeapSize / (1024 * 1024)
        : finalMemory;

      const totalMB = parseFloat((baselineRenderer + wasmOverhead + workersOverhead + v8Allocated + finalFiles + sabOverhead).toFixed(1));

      // Trigger auto-GC aggressively only when the RECLAIMABLE V8 JS heap (the
      // part a GC pass can actually shrink) crosses its threshold — NOT on the
      // inflated `totalMB`, which permanently sits above any fixed threshold
      // once audio is loaded (baselineRenderer + WASM overheads). Using totalMB
      // here caused triggerGcRequest to fire every GC_MIN_INTERVAL_MS and fully
      // wipe the caches (thrashing). totalMB is retained for display only.
      if (aggressiveAutoGc && v8Allocated > GC_V8_HEAP_TRIGGER_MB && Date.now() - lastAutoGcRef.current > GC_MIN_INTERVAL_MS) {
        lastAutoGcRef.current = Date.now();
        console.warn(`[GC Checker] V8 heap of ${v8Allocated.toFixed(1)} MB exceeds ${GC_V8_HEAP_TRIGGER_MB}MB threshold (total footprint ${totalMB} MB). Invoking triggerGcRequest...`);
        setTimeout(() => {
          if (triggerGcRequestRef.current) {
            triggerGcRequestRef.current();
          }
        }, 0);
      }

      if (
        prev.filesUploaded === finalFiles &&
        prev.temporaryAppFiles === finalTemp &&
        prev.systemCache === finalCache &&
        Math.abs(prev.systemMemory - finalMemory) < 0.2
      ) {
        return prev;
      }
      return {
        filesUploaded: finalFiles,
        temporaryAppFiles: finalTemp,
        systemCache: finalCache,
        systemMemory: finalMemory,
        total: totalMB
      };
    });
  }, [aggressiveAutoGc]);

  const triggerGcRequest = useCallback(() => {
    console.warn("[GC Request] Manual aggressive Garbage Collection requested...");

    // 1. Dereference and revoke all URL Object caches (obsolete media URLs)
    try {
      filesRef.current.forEach((f) => {
        if (f.cleanvoiceResult?.cleanedUrl) {
          try { URL.revokeObjectURL(f.cleanvoiceResult.cleanedUrl); } catch (e) {}
        }
        if (f.file && (f.file as any).preview) {
          try { URL.revokeObjectURL((f.file as any).preview); } catch (e) {}
        }
        if (f.remoteUrl && f.remoteUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(f.remoteUrl); } catch (e) {}
        }
      });
    } catch (e) {
      console.warn("Failed to revoke object URLs:", e);
    }

    // 2. Dereference non-essential large binary blobs held in memory to free RAM.
    //    FileItem never carries a `base64Data` field (the previous version set a
    //    non-existent field, which did nothing and only forced a re-render). The
    //    genuinely large transient data on a FileItem is the Cleanvoice result's
    //    cached binary Blobs — these are re-fetchable from their URLs, so it is
    //    safe to drop them. We never touch result/transcription/summary text
    //    (user-facing) and we skip files that are actively processing.
    try {
      setFiles((prev) =>
        prev.map((f) => {
          // Never drop blobs for files that are mid-flight (top-level or
          // Cleanvoice sub-status), to avoid clobbering in-progress work.
          const inFlight =
            f.status === "processing" ||
            f.status === "queued" ||
            f.cleanvoiceResult?.status === "uploading" ||
            f.cleanvoiceResult?.status === "processing" ||
            f.cleanvoiceResult?.status === "pending";
          if (inFlight) return f;
          if (!f.cleanvoiceResult) return f;
          const hasBlobCache =
            !!f.cleanvoiceResult.cleanedBlob || !!f.cleanvoiceResult.preTranscodedBlob;
          if (!hasBlobCache) return f;
          return {
            ...f,
            cleanvoiceResult: {
              ...f.cleanvoiceResult,
              cleanedBlob: undefined,
              preTranscodedBlob: undefined,
            },
          };
        }),
      );
    } catch (e) {
      console.warn("Failed to dereference large objects:", e);
    }

    // 3. Trim the Waveform Web Audio AudioBuffer cache (partial eviction).
    //    Evict the oldest half but keep the most-recently-used decoded buffers
    //    so they survive a GC pass — this preserves decode-hit-rate and avoids
    //    the re-decode -> heap-climb -> re-GC thrash loop that a full wipe
    //    caused.
    try {
      evictAudioBufferCache(0.5);
    } catch (e) {
      console.warn("Failed to trim audio buffers:", e);
    }

    // 4. Trim the Cleanvoice blob cache (partial eviction, oldest first).
    //    Same rationale as step 3: drop ~half so recent results stay cached and
    //    we don't force expensive re-fetches on the next interaction.
    try {
      const keys = Object.keys(cleanvoiceBlobCache);
      const dropCount = Math.floor(keys.length / 2);
      for (let i = 0; i < dropCount; i++) {
        delete cleanvoiceBlobCache[keys[i]];
      }
      if (dropCount > 0) {
        console.log(`[GC Request] Evicted ${dropCount} oldest Cleanvoice blob cache entries (${keys.length} -> ${Object.keys(cleanvoiceBlobCache).length}).`);
      }
    } catch (e) {
      console.warn("Failed to trim Cleanvoice cache:", e);
    }

    // 5. Release any active/obsolete media streams (microphone, recorder, etc.)
    try {
      if (typeof window !== "undefined") {
        const anyWindow = window as any;
        if (anyWindow.currentMediaStream && typeof anyWindow.currentMediaStream.getTracks === "function") {
          anyWindow.currentMediaStream.getTracks().forEach((track: any) => track.stop());
          anyWindow.currentMediaStream = null;
          console.log("[GC Request] Terminated active window.currentMediaStream");
        }
        if (anyWindow.localMediaStream && typeof anyWindow.localMediaStream.getTracks === "function") {
          anyWindow.localMediaStream.getTracks().forEach((track: any) => track.stop());
          anyWindow.localMediaStream = null;
          console.log("[GC Request] Terminated active window.localMediaStream");
        }
      }
    } catch (e) {
      console.warn("Failed to nullify media streams:", e);
    }

    // 6. Explicitly run memory tracker history clearing
    try {
      MemoryTracker.clearTrackedHistory();
    } catch (e) {}

    // 7. Invoke browser-native GC if available
    try {
      const anyWin = window as any;
      if (anyWin.gc) {
        anyWin.gc();
        console.log("[GC Request] Triggered browser-native window.gc()");
      }
    } catch (e) {}

    // 8. Update metrics
    updateMemoryStats(true, { indexedDbFiles: false, temporaryAppFiles: true, systemCache: false, systemMemory: true });
    
    setIsGcFlickering(true);
    setTimeout(() => {
      setIsGcFlickering(false);
    }, 800);
  }, [updateMemoryStats]);

  useEffect(() => {
    triggerGcRequestRef.current = triggerGcRequest;
  }, [triggerGcRequest]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).triggerGcRequest = triggerGcRequest;
    }
    return () => {
      if (typeof window !== "undefined") {
        try { delete (window as any).triggerGcRequest; } catch (e) {}
      }
    };
  }, [triggerGcRequest]);

  useEffect(() => {
    updateMemoryStats();
    const interval = setInterval(() => {
      updateMemoryStats();
    }, 2500);
    return () => clearInterval(interval);
  }, [updateMemoryStats]);

  const handleManualMemoryClear = useCallback(async (customOptions?: CleanOptions) => {
    setIsGcFlickering(true);
    setTimeout(() => {
      setIsGcFlickering(false);
    }, 800);

    let options = customOptions;
    if (!options) {
      const saved = localStorage.getItem('cleanvoice_clean_options_v3');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          options = {
            indexedDbFiles: parsed.indexedDbFiles ?? false,
            temporaryAppFiles: parsed.temporaryAppFiles ?? true,
            systemCache: parsed.systemCache ?? true,
            systemMemory: parsed.systemMemory ?? true,
          };
        } catch (e) {}
      }
      if (!options) {
        options = { indexedDbFiles: false, temporaryAppFiles: true, systemCache: true, systemMemory: true };
      }
    }
    
    let clearedBytes = 0;
    
    // 1. Files Uploaded (IndexedDB)
    if (options.indexedDbFiles) {
      setFiles([]);
      setProcessingState({ isProcessing: false, current: 0, total: 0 });
      processingQueueRef.current = [];
      runningTasksSetRef.current.clear();
      activeProcessCountRef.current = 0;
      clearedBytes += memoryStats.filesUploaded;

      // Revoke all Object URLs to free RAM immediately
      files.forEach((f) => {
        if (f.cleanvoiceResult?.cleanedUrl) {
          try {
            URL.revokeObjectURL(f.cleanvoiceResult.cleanedUrl);
          } catch (e) {}
        }
        if (f.file && (f.file as any).preview) {
          try {
            URL.revokeObjectURL((f.file as any).preview);
          } catch (e) {}
        }
      });

      // IndexedDB: Clear all object stores
      try {
        if (window.indexedDB && window.indexedDB.databases) {
          const dbs = await window.indexedDB.databases();
          await Promise.all(dbs.map(db => {
            return new Promise<void>((resolve) => {
              if (db.name) {
                const req = window.indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              } else resolve();
            });
          }));
        } else {
          await clearAllPersistedFiles();
          await new Promise<void>((resolve) => {
            const req = window.indexedDB.deleteDatabase("CleanvoiceStudioDB");
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          });
        }
      } catch (err) {
        console.error("Failed to clear IndexedDB on manual memory clear:", err);
      }
    }

    // 2. System RAM / Memory
    if (options.systemMemory) {
      // Disconnect active Web Workers, WebSockets, and event listeners by recreating active components
      setAppKey(prev => prev + 1);

      // Invoke the aggressive, unified manual GC operation
      triggerGcRequest();

      // Abort active processing operations
      Object.values(transcriptionAbortControllersRef.current).forEach((controller) => {
        try { controller.abort(); } catch (e) {}
      });
      transcriptionAbortControllersRef.current = {};

      // Cancel any pending auto-retry timers as part of the wipe.
      Object.values(retryTimersRef.current).forEach((timer) => {
        try { clearTimeout(timer); } catch (e) {}
      });
      retryTimersRef.current = {};

      setIsDrawerOpen(false);
      // Temporarily mark DB as unloaded while the UI subtree is force-remounted
      // (via setAppKey above). It MUST be restored to true afterwards, otherwise
      // the IndexedDB save effect ("if (!isDbLoaded) return;") stops persisting
      // files for the rest of the session — the load effect only runs once on
      // mount, so the flag would otherwise stay false until a full page reload.
      setIsDbLoaded(false);

      clearedBytes += memoryStats.systemMemory * 0.5;
    }

    // 3. Temporary App Files (Cache API segment / Local Buffers)
    if (options.temporaryAppFiles) {
      // Cache Storage API: Delete all caches (used by Service Workers)
      try {
        if ("caches" in window) {
          const cacheKeys = await caches.keys();
          await Promise.all(cacheKeys.map(key => caches.delete(key)));
        }
      } catch (err) {
        console.error("Failed to delete Cache Storage:", err);
      }
      clearedBytes += memoryStats.temporaryAppFiles;
    }

    // 4. System Cache (Local / Session storage and Cookies)
    if (options.systemCache) {
      // Local Storage & Session Storage: Wipe all strictly (preserving only API keys)
      try {
        const geminiKey = localStorage.getItem("gemini_api_key");
        const cleanvoiceKey = localStorage.getItem("cleanvoice_api_key");
        const cleanOptions = localStorage.getItem("cleanvoice_clean_options_v3");
        
        localStorage.clear();
        sessionStorage.clear();
        
        if (geminiKey) localStorage.setItem("gemini_api_key", geminiKey);
        if (cleanvoiceKey) localStorage.setItem("cleanvoice_api_key", cleanvoiceKey);
        if (cleanOptions) localStorage.setItem("cleanvoice_clean_options_v3", cleanOptions);
      } catch (err) {
        console.error("Failed to clear local/session storage:", err);
      }

      // Application Cache/Cookies: Clear site-specific cookies
      try {
        document.cookie.split(";").forEach((c) => {
          document.cookie = c.replace(/^ +/, "").replace(/=.*/, `=;expires=${new Date().toUTCString()};path=/`);
        });
      } catch (err) {
        console.error("Failed to clear cookies:", err);
      }
      clearedBytes += memoryStats.systemCache * 0.3;
    }

    const finalCleared = options.indexedDbFiles && options.temporaryAppFiles && options.systemCache && options.systemMemory 
      ? memoryStats.total 
      : parseFloat(clearedBytes.toFixed(1));

    // Force an immediate refresh of the memory numbers so the UI visibly flashes down
    await updateMemoryStats(true, options);

    // Restore the DB-loaded flag that the System RAM branch temporarily cleared
    // above, so the IndexedDB persistence effect resumes saving files state.
    if (options.systemMemory) {
      setIsDbLoaded(true);
      // Re-persist the current files: any setFiles that fired during the
      // isDbLoaded=false window above was skipped by the persistence effect,
      // so explicitly save now (using the live ref to capture the newest state).
      saveAllPersistedFiles(filesRef.current).catch((err) => {
        console.warn("Failed to re-sync files to IndexedDB after memory clear:", err);
      });
    }

    toast.success("Memory & cache cleared!", {
      description: `Wiped selected caches and storages. ${finalCleared} MB of cached files and heap released.`,
    });
  }, [files, updateMemoryStats, memoryStats]);

  const totalUploaded = files.length;
  const totalProcessed = useMemo(
    () => files.filter((f) => f.status === "success").length,
    [files],
  );
  const totalProcessing = useMemo(
    () => files.filter((f) => f.status === "processing").length,
    [files],
  );

  // Precompute the processing queue as a Set + ordered array ONCE per render
  // so the files.map() below is O(n) instead of O(n^2) (it previously did a
  // findIndex over the queue for every file).
  const queuedIdSet = useMemo(
    () => new Set(processingQueueRef.current.map((t) => t.id)),
    // The queue lives in a ref and is mutated outside of render, so we tie the
    // memo to `files` to recompute whenever the list (and thus queue positions)
    // might have changed.
    [files],
  );
  const queuedOrder = useMemo(
    () => processingQueueRef.current.map((t) => t.id),
    [files],
  );

  return (
    <div key={appKey} className="min-h-screen theme-bg theme-text p-4 sm:p-6 md:p-8 xl:p-12 transition-colors duration-300">
      <Toaster position="bottom-right" richColors theme={theme} />
      
      {cleanMenuState.isOpen && (
        <React.Suspense fallback={null}>
          <CleanContextMenu
            isOpen={cleanMenuState.isOpen}
            onClose={() => setCleanMenuState({ isOpen: false, position: null })}
            position={cleanMenuState.position}
            onClean={(options) => handleManualMemoryClear(options)}
            memoryStats={memoryStats}
            isProcessing={totalProcessing > 0}
            isGcFlickering={isGcFlickering}
          />
        </React.Suspense>
      )}

      {isPowerSettingsOpen && (
        <React.Suspense fallback={null}>
          <PowerSettingsModal
            isOpen={isPowerSettingsOpen}
            onClose={() => setIsPowerSettingsOpen(false)}
            batteryLevel={batteryLevel}
            isPluggedIn={isPluggedIn}
            batterySaver={batterySaver}
            setBatterySaver={setBatterySaver}
            batteryHistory={batteryHistory}
            clearBatteryHistory={clearBatteryHistory}
            powerSchedule={powerSchedule}
            setPowerSchedule={setPowerSchedule}
            aggressiveAutoGc={aggressiveAutoGc}
            setAggressiveAutoGc={setAggressiveAutoGc}
          />
        </React.Suspense>
      )}
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4 sm:pb-6 gap-4 flex-shrink-0 whitespace-nowrap">
          <div className="flex items-center gap-3.5 sm:gap-4 flex-nowrap flex-shrink-0">
            <div className="bg-gradient-to-tr from-indigo-600 to-indigo-500 p-2.5 sm:p-3 rounded-xl text-white shadow-md flex-shrink-0 flex items-center justify-center">
              <Languages className="w-6.5 h-6.5 sm:w-7.5 sm:h-7.5" />
            </div>
            <div className="flex flex-col justify-center flex-shrink-0">
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100 whitespace-nowrap leading-tight flex-shrink-0 flex items-center gap-2">
                OCR & Transcriber
                {!isOnline && (
                  <span id="offline-status-indicator" className="flex h-2.5 w-2.5 relative" data-tooltip="No internet connection">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                  </span>
                )}
              </h1>
              <Greeting />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Desktop & Tablet Utility & Tool Switcher Toggles (hidden on mobile, visible on tablet, laptop, desktop) */}
            <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
              {/* Studio Module Swapper */}
              <div className="relative grid grid-cols-2 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-[11px] font-bold shadow-sm select-none mr-2 flex-shrink-0 w-[190px] md:w-[280px]">
                {/* Advanced Sliding Pill Background Indicator */}
                <div
                  className="absolute inset-y-0 left-0 w-1/2 transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] p-[3px] pointer-events-none"
                  style={{
                    transform: activeAppTool === "transcribe" ? "translateX(0)" : "translateX(100%)",
                  }}
                >
                  <div className="w-full h-full rounded-lg bg-white dark:bg-slate-800 shadow-xs" />
                </div>

                <button
                  onClick={() => handleTabSwitch("transcribe")}
                  className={`relative z-10 py-1.5 px-3 m-[3px] rounded-lg transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap flex-shrink-0 ${
                    activeAppTool === "transcribe"
                      ? "text-indigo-600 dark:text-indigo-400 opacity-100 font-extrabold"
                      : "text-slate-700 dark:text-slate-300 opacity-95 hover:opacity-100 font-bold hover:text-slate-900 dark:hover:text-slate-100"
                  }`}
                >
                  <Languages className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="hidden md:inline whitespace-nowrap flex-shrink-0">Transcribe Studio</span>
                  <span className="md:hidden whitespace-nowrap flex-shrink-0">Transcribe</span>
                </button>
                <button
                  onClick={() => handleTabSwitch("cleanvoice")}
                  className={`relative z-10 py-1.5 px-3 m-[3px] rounded-lg transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap flex-shrink-0 ${
                    activeAppTool === "cleanvoice"
                      ? "text-indigo-600 dark:text-indigo-400 opacity-100 font-extrabold"
                      : "text-slate-700 dark:text-slate-300 opacity-95 hover:opacity-100 font-bold hover:text-slate-900 dark:hover:text-slate-100"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="hidden md:inline whitespace-nowrap flex-shrink-0">Cleanvoice AI</span>
                  <span className="md:hidden whitespace-nowrap flex-shrink-0">Cleanvoice</span>
                </button>
              </div>

              {/* Workload Progress Dashboard (hidden on small tablets — available in mobile drawer) */}
              <div className="hidden md:flex items-center gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 shadow-xs select-none flex-shrink-0">
                <div className="relative flex h-2 w-2">
                  {totalProcessing > 0 ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                    </>
                  ) : totalUploaded > 0 && totalProcessed === totalUploaded ? (
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  ) : (
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-slate-300 dark:bg-slate-700"></span>
                  )}
                </div>

                <div className="flex flex-col min-w-[100px]">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-extrabold block">
                    Workload Status
                  </span>
                  <span className="text-slate-700 dark:text-slate-300 text-xs font-semibold">
                    <span className="text-sm font-black text-indigo-600 dark:text-indigo-400">
                      {totalProcessed}
                    </span>
                    <span className="mx-1 text-slate-300 dark:text-slate-700">
                      /
                    </span>
                    <span className="text-sm font-black text-slate-800 dark:text-slate-200">
                      {totalUploaded}
                    </span>
                    <span className="ml-1 text-[11px] font-bold text-slate-500 dark:text-slate-300">
                      processed
                    </span>
                  </span>
                </div>
              </div>

              {/* PC Manual Memory Clear (visible only on desktop, right beside workload status) */}
              <button
                onClick={() => handleManualMemoryClear()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setCleanMenuState({
                    isOpen: true,
                    position: { x: rect.right, y: rect.bottom + 8 },
                  });
                }}
                className={`hidden sm:flex items-center justify-center p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-rose-500 hover:text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/20 select-none transition-all duration-200 cursor-pointer tooltip-left ${
                  isGcFlickering ? "border-rose-500 bg-rose-50 dark:bg-rose-950/20 shadow-inner" : ""
                }`}
                data-tooltip={`Files Uploaded: ${memoryStats.filesUploaded} MB | Temp Files: ${memoryStats.temporaryAppFiles} MB | System Cache: ${memoryStats.systemCache} MB | Total: ${memoryStats.total} MB`}
                aria-label="Clear Memory"
              >
                <Eraser className="w-5 h-5 text-rose-500 dark:text-rose-400" />
              </button>

              {/* Battery Status Indicator (Left-click toggles saver, Right-click opens modal settings) */}
              {batteryLevel !== null && (
                <button
                  onClick={() => setBatterySaver(!batterySaver)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setIsPowerSettingsOpen(true);
                  }}
                  className={`flex items-center justify-center p-2.5 rounded-xl border select-none transition-all duration-200 cursor-pointer tooltip-left ${
                    batterySaver
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
                      : "bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                  data-tooltip={`[Left Click]: Toggle Power Saver Mode (${batterySaver ? 'On' : 'Off'}) | [Right Click]: Power Settings & History Graph | Charge: ${batteryLevel}%`}
                  aria-label={`Battery Status: ${batteryLevel}%`}
                >
                  {isPluggedIn ? (
                    <BatteryCharging className="w-5 h-5 text-emerald-500 animate-pulse" />
                  ) : (
                    <Battery className={`w-5 h-5 ${batteryLevel < 20 ? 'text-rose-500 animate-pulse' : batterySaver ? 'text-emerald-500' : 'text-slate-500 dark:text-slate-400'}`} />
                  )}
                </button>
              )}

              {/* Desktop Theme Selector (dropdown next to Workload Status) */}
              <ThemeSelector theme={theme} setTheme={setTheme} />
            </div>

            {/* Mobile Drawer Trigger (visible only on mobile) */}
            <button
              onClick={() => setIsDrawerOpen(true)}
              className="sm:hidden p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shadow-sm active:scale-95 transition-all flex items-center justify-center cursor-pointer min-h-[44px] min-w-[44px] tooltip-left"
              data-tooltip="Open Navigation Menu"
              aria-label="Open Navigation Menu"
            >
              <Menu className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </button>
          </div>
        </header>

        <main className="w-full">

        {hasLoadedCleanvoice && (
          <div className={`transition-all duration-300 ease-in-out ${activeAppTool === "cleanvoice" ? "opacity-100 translate-y-0 pointer-events-auto mt-4 sm:mt-6" : "opacity-0 -translate-y-4 pointer-events-none h-0 overflow-hidden mt-0 sm:mt-0"}`}>
            <React.Suspense fallback={
              <div className="flex flex-col items-center justify-center p-12 theme-card-bg theme-border theme-shadow space-y-4">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                <p className="text-slate-600 dark:text-slate-300 font-mono text-xs">Loading Cleanvoice Studio...</p>
              </div>
            }>
              <CleanvoiceStudio
                files={files}
                setFiles={setFiles}
                onFilesAdded={addFiles}
                selectedQuality={selectedQuality}
                setSelectedQuality={setSelectedQuality}
                onCreditsUpdated={setRemainingCredits}
                remainingCredits={remainingCredits}
              />
            </React.Suspense>
          </div>
        )}
        
        <div className={`transition-all duration-300 ease-in-out ${activeAppTool === "transcribe" ? "opacity-100 translate-y-0 pointer-events-auto mt-4 sm:mt-6" : "opacity-0 -translate-y-4 pointer-events-none h-0 overflow-hidden mt-0 sm:mt-0"}`}>
          <React.Suspense fallback={
            <div className="flex flex-col items-center justify-center p-6 theme-card-bg theme-border theme-shadow space-y-2 mb-4 animate-pulse">
              <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
              <p className="text-slate-500 dark:text-slate-400 font-mono text-[10px]">Loading key manager...</p>
            </div>
          }>
            <GeminiApiKeySetup apiKey={geminiApiKey} setApiKey={setGeminiApiKey} />
          </React.Suspense>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Column: Inputs */}
          <div className="lg:col-span-1 space-y-6">
            <div className="theme-card-bg theme-border theme-shadow p-5 sm:p-6">
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
                    Upload Files
                  </h2>
                  <span className="text-xs text-slate-700 dark:text-slate-200 bg-slate-100/80 dark:bg-slate-950 px-2 py-1 rounded-md font-semibold">
                    Ctrl+V to paste
                  </span>
                </div>
                <React.Suspense fallback={<div className="min-h-[160px] sm:min-h-[240px] bg-slate-100 dark:bg-slate-900 rounded-2xl animate-pulse" />}>
                  <FileUploader 
                    onFilesAdded={addFiles} 
                    accept={{
                      'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aiff', '.aac', '.opus', '.webm'],
                      'video/*': ['.mp4', '.mov', '.webm', '.avi', '.mkv'],
                      'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
                      'application/pdf': ['.pdf'],
                      'text/*': ['.txt', '.csv', '.md', '.json']
                    }}
                    label="Drag & drop any files (audio, video, documents, images) here"
                  />
                </React.Suspense>

                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-col gap-3">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoProcess}
                      onChange={(e) => setAutoProcess(e.target.checked)}
                      className="sr-only peer"
                      aria-label="Auto-process on upload or recording"
                    />
                    <div className="w-9 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 dark:border-slate-700 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                    <span className="ml-2 text-xs font-semibold text-slate-600 dark:text-slate-300 select-none">
                      Auto-process on upload / recording
                    </span>
                  </label>
                </div>
              </div>

              <div id="recorder-card-container" className="theme-card-bg theme-border theme-shadow p-5 sm:p-6 min-h-[284px] flex flex-col justify-center">
                <React.Suspense fallback={
                  <div className="flex flex-col items-center justify-center p-4 space-y-2 h-full w-full">
                    <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
                    <p className="text-slate-500 dark:text-slate-400 font-mono text-xs">Loading Audio Recorder...</p>
                  </div>
                }>
                  <AudioRecorder onRecordingComplete={addRecording} existingFiles={files} />
                </React.Suspense>
              </div>

              <div id="merger-card-container" className="theme-card-bg theme-border theme-shadow p-5 sm:p-6 min-h-[192px] flex flex-col justify-center">
                <React.Suspense fallback={
                  <div className="flex flex-col items-center justify-center p-4 space-y-2 h-full w-full">
                    <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
                    <p className="text-slate-500 dark:text-slate-400 font-mono text-xs">Loading Audio Merger...</p>
                  </div>
                }>
                  <AudioMerger files={files} onMergeComplete={addRecording} />
                </React.Suspense>
              </div>
            </div>

            {/* Right Column: Results */}
            <div className="lg:col-span-2 space-y-6">
              <div className="theme-card-bg theme-border theme-shadow p-4 sm:p-5 min-h-[355px] flex flex-col overflow-visible">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5 pb-3 sm:pb-0 border-b border-slate-100 dark:border-slate-800/60 sm:border-b-0">
                  <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-200">
                    Processing Queue & Results
                  </h2>
                  <div className="flex items-center gap-2 gap-y-2 justify-start sm:justify-end flex-wrap max-w-full">
                    {files.some((f) => f.status === "pending") && (
                      <button
                        onClick={async () => {
                          const pendingFiles = files.filter((f) => f.status === "pending");
                          for (const file of pendingFiles) {
                            // Enqueue processing safely
                            await executeProcessing(file.id);
                          }
                        }}
                        disabled={processingState.isProcessing}
                        className="px-3.5 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 border border-transparent rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none uppercase tracking-wider tooltip-align-right cursor-pointer shadow-sm flex items-center gap-1.5"
                        data-tooltip="Process all pending files in the queue"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Start Processing
                      </button>
                    )}
                    {files.some((f) =>
                      f.name.toLowerCase().endsWith(".webm"),
                    ) && (
                      <button
                        onClick={handleRenameAllWebmToMp3}
                        disabled={processingState.isProcessing}
                        className="px-3 py-1.5 text-xs font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 border border-indigo-200 dark:border-indigo-800 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none uppercase tracking-wider tooltip-align-right cursor-pointer"
                        data-tooltip="Rename all WebM files to MP3"
                      >
                        Webm → MP3
                      </button>
                    )}
                    <button
                      onClick={clearAll}
                      disabled={
                        files.length === 0 || processingState.isProcessing
                      }
                      className="p-2.5 text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-800 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none tooltip-align-right"
                      data-tooltip="Clear All Files"
                      aria-label="Clear All Files"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                    {files.some((f) => f.status === "success" && f.result) && (
                      <button
                        onClick={downloadAllAsZip}
                        disabled={processingState.isProcessing || isZipping}
                        className="p-2.5 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm focus:outline-none tooltip-align-right"
                        data-tooltip="Download All Results as ZIP"
                        aria-label="Download All Results as ZIP"
                      >
                        {isZipping ? (
                          <div className="w-5 h-5 animate-spin rounded-full border-2 border-emerald-700 dark:border-emerald-400 border-t-transparent" />
                        ) : (
                          <FileArchive className="w-5 h-5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div className="relative flex flex-col flex-1 space-y-2.5 pr-1 overflow-visible">
                  <div className="flex flex-col space-y-2.5 outline-none">
                    {/*
                      mode="popLayout": when the first file is added, the empty-state
                      placeholder is popped OUT of normal flow during its exit so it
                      no longer holds layout space while the new card animates in.
                      Previously both shared the flex column simultaneously, causing the
                      jerky layout "gap/jump" on the first upload. initial={false} still
                      prevents the very first mount from animating.
                    */}
                    <AnimatePresence initial={false} mode="popLayout">
                      {files.length === 0 && (
                        <motion.div
                          key="placeholder"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="flex-1 flex flex-col items-center justify-center text-slate-500 dark:text-slate-300 py-12"
                        >
                          <Languages className="w-16 h-16 mb-4 opacity-20" />
                          <p>No files added yet.</p>
                          <p className="text-sm dark:text-slate-300 mt-2">
                            Upload files or record audio to get started.
                          </p>
                        </motion.div>
                      )}
                      {files.map((file) => {
                        const qPos =
                          (file.status === "queued" && queuedIdSet.has(file.id))
                            ? queuedOrder.indexOf(file.id) + 1
                            : 0;
                        return (
                          <motion.div
                            key={file.id}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{
                              duration: 0.22,
                              ease: [0.22, 1, 0.36, 1],
                            }}
                            style={{ willChange: "transform, opacity" }}
                          >
                            <React.Suspense fallback={
                              <div className="flex items-center justify-center p-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-900/50">
                                <div className="flex items-center gap-2 font-mono text-xs text-slate-500">
                                  <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                                  <span>Loading Result Card...</span>
                                </div>
                              </div>
                            }>
                              <ResultCard
                                item={file}
                                selectedQuality={selectedQuality}
                                queuePosition={
                                  qPos > 0 ? qPos : undefined
                                }
                                onDelete={deleteFile}
                                onProcess={processSingleFile}
                                onCancel={cancelProcessing}
                                onEditResult={handleEditResult}
                                onUpdateFile={handleUpdateFile}
                                onUpdateCleanvoiceAudio={handleUpdateCleanvoiceAudio}
                                onRenameFile={handleRenameFile}
                                onSelectModel={handleSelectModel}
                                onToggleAudioSource={handleToggleAudioSource}
                              />
                            </React.Suspense>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
        </div>
        </main>
      </div>

      {/* Collapsible Mobile Drawer Overlay + Content - Rendered at Document Root Level */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            {/* Backdrop with high z-index overlay to prevent peaks */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDrawerOpen(false)}
              className="fixed inset-0 w-screen h-screen h-[100dvh] bg-slate-900/65 dark:bg-black/80 z-[9998] sm:hidden backdrop-blur-xs"
            />

            {/* Seamless full dynamic viewport height drawer panel */}
            <motion.div
              drag="x"
              dragDirectionLock
              dragConstraints={{ left: 0, right: 350 }}
              dragElastic={{ left: 0.05, right: 0.15 }}
              onDragEnd={(event, info) => {
                if (info.offset.x > 80 || info.velocity.x > 300) {
                  setIsDrawerOpen(false);
                }
              }}
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 28, mass: 0.6, restSpeed: 0.05 }}
              className="fixed inset-y-0 right-0 w-80 max-w-[85vw] bg-white dark:bg-slate-950 z-[9999] shadow-2xl p-6 flex flex-col justify-between sm:hidden border-l border-slate-200 dark:border-slate-800 h-screen h-[100dvh] overflow-y-auto touch-pan-y"
            >
              <div className="space-y-6 text-left">
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
                  <div className="flex items-center gap-2">
                     <Languages className="w-5 h-5 text-indigo-600" />
                    <span className="font-bold text-slate-800 dark:text-slate-100">App Utilities</span>
                  </div>
                  <button
                    onClick={() => setIsDrawerOpen(false)}
                    className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 rounded-lg cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Mobile Navigation (Active tool switcher) inside drawer */}
                <div className="space-y-3">
                  <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider block">Select Studio Module</span>
                  <button
                    onClick={() => {
                      handleTabSwitch("transcribe");
                      setIsDrawerOpen(false);
                    }}
                    className={`w-full py-3 px-4 rounded-xl transition-all duration-200 flex items-center gap-3 cursor-pointer text-sm font-extrabold ${
                      activeAppTool === "transcribe"
                        ? "bg-indigo-600 text-white shadow-md animate-none"
                        : "bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    <Languages className="w-4 h-4" /> Transcribe Studio
                  </button>
                  <button
                    onClick={() => {
                      if (!isOnline) {
                        toast.error("This feature is unavailable offline. Please connect to the internet.");
                        return;
                      }
                      handleTabSwitch("cleanvoice");
                      setIsDrawerOpen(false);
                    }}
                    className={`w-full py-3 px-4 rounded-xl transition-all duration-200 flex items-center gap-3 cursor-pointer text-sm font-extrabold ${
                      activeAppTool === "cleanvoice"
                        ? "bg-indigo-600 text-white shadow-md animate-none"
                        : "bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    <Sparkles className="w-4 h-4" /> Cleanvoice AI
                  </button>
                </div>

                {/* Mobile Memory Cleaner inside Drawer */}
                <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
                      System Cache
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setCleanMenuState({
                          isOpen: true,
                          position: { x: rect.right, y: rect.bottom + 8 },
                        });
                      }}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer flex items-center justify-center translate-y-[-0.5px]"
                      data-tooltip="Storage Options"
                      aria-label="Storage Options"
                    >
                      <Settings className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      handleManualMemoryClear();
                      setIsDrawerOpen(false);
                    }}
                    className={`w-full py-3.5 px-4 rounded-xl transition-all duration-200 flex items-center justify-between border border-rose-200 dark:border-rose-900/30 bg-rose-50/20 dark:bg-rose-950/10 hover:bg-rose-50 dark:hover:bg-rose-900/10 cursor-pointer text-sm font-extrabold text-rose-600 dark:text-rose-400 ${
                      isGcFlickering ? "border-rose-500 bg-rose-50/50" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Eraser className="w-4 h-4 text-rose-500" />
                      Clear Memory Cache
                    </span>
                    <span className="text-[10px] bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded-full font-mono">
                      {memoryStats.total} MB
                    </span>
                  </button>
                </div>

                {/* Power Saver Option inside drawer */}
                <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
                        Power Saver {batteryLevel !== null ? `(${batteryLevel}%)` : ""}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsPowerSettingsOpen(true);
                          setIsDrawerOpen(false);
                        }}
                        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer flex items-center justify-center translate-y-[-0.5px]"
                        data-tooltip="Configure Power Saver Settings & History"
                        aria-label="Configure Power Saver Settings & History"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {batterySaver && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-sm font-bold uppercase ${isPluggedIn ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-600' : 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 animate-pulse'}`}>
                        {isPluggedIn ? 'Plugged In - Idle' : 'Active'}
                      </span>
                    )}
                  </div>
                  <label className={`flex items-center justify-between p-3 border rounded-xl cursor-pointer select-none transition-all duration-200 ${
                    batterySaver 
                      ? 'bg-emerald-50/40 dark:bg-emerald-950/15 border-emerald-500/70 dark:border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.15)]' 
                      : 'bg-slate-50 dark:bg-slate-900 border-slate-100 dark:border-slate-800'
                  }`}>
                    <div className="flex items-center gap-2.5">
                      {isPluggedIn ? (
                        <BatteryCharging className={`w-5 h-5 ${batterySaver ? 'text-emerald-500' : 'text-slate-400'}`} />
                      ) : (
                        <Battery className={`w-5 h-5 ${batterySaver ? 'text-emerald-500 animate-pulse' : 'text-slate-400'}`} />
                      )}
                      <div className="flex flex-col">
                        <span className={`text-xs font-bold ${batterySaver ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200'}`}>Reduce Background Load</span>
                        <span className="text-[9px] text-slate-400">Save power on battery</span>
                      </div>
                    </div>
                    <div className="relative inline-flex items-center">
                      <input
                        type="checkbox"
                        checked={batterySaver}
                        onChange={(e) => setBatterySaver(e.target.checked)}
                        className="sr-only peer"
                        aria-label="Reduce Background Load"
                      />
                      <div className="w-9 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 dark:border-slate-700 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                    </div>
                  </label>
                </div>

                {/* Theme toggles inside drawer */}
                <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-5">
                  <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider block">Appearance Theme</span>
                  <div className="grid grid-cols-3 gap-1.5 bg-slate-50 dark:bg-slate-900/50 p-1 rounded-xl border border-slate-100 dark:border-slate-800">
                    <button
                      onClick={() => setTheme("light")}
                      className={`py-2 rounded-lg text-[10px] font-bold transition-all cursor-pointer flex flex-col items-center gap-1 min-h-[44px] justify-center ${
                        theme === "light"
                          ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      <Sun className={`w-3.5 h-3.5 ${theme === "light" ? "text-amber-500 fill-amber-100" : ""}`} /> Light
                    </button>
                    <button
                      onClick={() => setTheme("dark")}
                      className={`py-2 rounded-lg text-[10px] font-bold transition-all cursor-pointer flex flex-col items-center gap-1 min-h-[44px] justify-center ${
                        theme === "dark"
                          ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      <Moon className={`w-3.5 h-3.5 ${theme === "dark" ? "text-indigo-400 fill-indigo-950/40" : ""}`} /> Dark
                    </button>
                    <button
                      onClick={() => setTheme("system")}
                      className={`py-2 rounded-lg text-[10px] font-bold transition-all cursor-pointer flex flex-col items-center gap-1 min-h-[44px] justify-center ${
                        theme === "system"
                          ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      <Monitor className={`w-3.5 h-3.5 ${theme === "system" ? "text-indigo-600" : ""}`} /> System
                    </button>
                  </div>
                </div>

                {/* Workload Indicator inside drawer */}
                <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-5">
                  <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider block font-sans">Queue Metrics</span>
                  <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">Processed Count</span>
                      <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
                        {totalProcessed} / {totalUploaded}
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-indigo-600 h-full rounded-full transition-all"
                        style={{
                          width: `${totalUploaded > 0 ? Math.round((totalProcessed / totalUploaded) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
