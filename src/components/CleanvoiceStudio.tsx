import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { FileItem } from "../types";
import {
  startCleanvoiceEdit,
  getCleanvoiceEditStatus,
  deleteCleanvoiceEdit,
  CleanvoiceConfig,
  triggerCleanvoiceAuthOrCreditError,
  getBaseUrl,
  hasServerBackend,
} from "../services/cleanvoiceService";
import { isAudioFile } from "../utils/audioUtils";
import {
  Play,
  Pause,
  Check,
  Music,
  Sliders,
  ChevronDown,
  Trash2,
  Sparkles,
  CheckCircle2,
  Loader2,
  Download,
  X,
  Upload,
  Mic,
  MicOff,
  PlayCircle,
  PauseCircle,
} from "lucide-react";
import { FileUploader } from "./FileUploader";
import { CleanvoiceProgressView } from "./CleanvoiceProgressView";
import { CleanvoiceApiKeySetup } from "./CleanvoiceApiKeySetup";
import {
  cleanvoiceBlobCache,
  cleanvoiceActivePrefetches,
  cleanvoiceFailedPrefetches,
  setCleanvoiceBlobCache,
} from "../utils/cleanvoiceCache";

// Presets available in the Features card dropdown (order = display order).
const PRESET_OPTIONS: string[] = [
  "Custom Preset",
  "Podcast Optimized",
  "Audiobook Ready",
  "Webinar Clean",
  "Remove Fillers & Stutters Only",
  "Mastering Only",
  "Clean Slate",
];

export function generateMockWavUrl(): string {
  if (typeof window === "undefined") return "";
  const sampleRate = 44100;
  const duration = 1.0;
  const numSamples = sampleRate * duration;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + numSamples * 2, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, numSamples * 2, true);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.5;
    const intSample = Math.floor(sample * 32767);
    view.setInt16(44 + i * 2, intSample, true);
  }
  
  const blob = new Blob([buffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

/**
 * Inline-editable file name for a "Completed Output" list item.
 *
 * Mirrors the rename UX used by the processing-queue cards in `ResultCard`:
 * the name renders as static text until clicked, then swaps to an `<input>`
 * that inherits the same typography (font-weight, size, color) so there are no
 * layout shifts. Enter or blur commits; Escape cancels.
 *
 * State is localized per item (`isEditing` / `editedName`) so editing one
 * completed file never disturbs its siblings, and the save fires `onRename`
 * to update the parent store.
 */
interface CompletedFileNameProps {
  fileId: string;
  name: string;
  onRename: (fileId: string, newName: string) => void;
}

function CompletedFileName({ fileId, name, onRename }: CompletedFileNameProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latched when the edit session is resolved (commit or cancel) so the blur
  // fired by unmounting the input doesn't double-fire the action.
  const settledRef = useRef(false);

  // Keep the edit buffer in sync when the underlying name changes externally.
  useEffect(() => {
    setEditedName(name);
  }, [name]);

  const doCommit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = editedName.trim();
    if (trimmed && trimmed !== name) {
      onRename(fileId, trimmed);
    } else {
      setEditedName(name);
    }
    setIsEditing(false);
  };

  const doCancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditedName(name);
    setIsEditing(false);
  };

  // Click outside (blur) commits. The action buttons preventDefault on mousedown
  // so pressing them doesn't blur the input first; Enter/Check call doCommit,
  // Escape/X call doCancel, and every path latches settledRef to mute the
  // trailing unmount blur.
  const handleBlur = () => {
    if (settledRef.current) return;
    doCommit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      doCancel();
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1.5 w-full">
        <input
          ref={inputRef}
          type="text"
          value={editedName}
          autoFocus
          onFocus={(e) => {
            const name = editedName;
            const dot = name.lastIndexOf(".");
            const extLen =
              dot > 0 && name.length - dot - 1 <= 6
                ? name.length - dot
                : 0;
            const end = Math.max(0, name.length - extLen);
            const input = e.currentTarget;
            requestAnimationFrame(() => {
              try {
                input.setSelectionRange(0, end);
              } catch {
                /* no-op */
              }
            });
          }}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="text-xs font-extrabold text-emerald-800 dark:text-emerald-400 bg-white dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 sm:px-2.5 sm:py-1 h-8 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 flex-1 min-w-0 md:min-w-[120px]"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={doCommit}
          className="p-1 min-w-[36px] sm:min-w-[28px] min-h-[36px] sm:min-h-[28px] h-9 w-9 sm:h-8 sm:w-8 flex items-center justify-center text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-100/50 dark:hover:bg-emerald-950/40 rounded-lg transition-colors cursor-pointer shrink-0"
          aria-label="Save name"
          data-tooltip="Save Name"
        >
          <Check className="w-5 h-5 sm:w-4 sm:h-4" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={doCancel}
          className="p-1 min-w-[36px] sm:min-w-[28px] min-h-[36px] sm:min-h-[28px] h-9 w-9 sm:h-8 sm:w-8 flex items-center justify-center text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-100/50 dark:hover:bg-red-950/40 rounded-lg transition-colors cursor-pointer shrink-0"
          aria-label="Cancel rename"
          data-tooltip="Cancel"
        >
          <X className="w-5 h-5 sm:w-4 sm:h-4" />
        </button>
      </div>
    );
  }

  return (
    <span
      className="text-xs font-extrabold text-emerald-800 dark:text-emerald-400 truncate max-w-[140px] sm:max-w-xs block cursor-pointer hover:text-emerald-950 dark:hover:text-emerald-300 transition-colors py-0.5 w-full flex items-center"
      data-tooltip={`${name} — click to rename`}
      onClick={() => {
        settledRef.current = false;
        setEditedName(name);
        setIsEditing(true);
      }}
    >
      {name}
    </span>
  );
}


interface CleanvoiceStudioProps {
  files: FileItem[];
  setFiles: React.Dispatch<React.SetStateAction<FileItem[]>>;
  onFilesAdded: (files: File[]) => void;
  selectedQuality?: "source" | "320" | "192" | "128";
  setSelectedQuality?: (q: "source" | "320" | "192" | "128") => void;
  onCreditsUpdated?: (credits: number) => void;
  remainingCredits?: number | null;
}

export function CleanvoiceStudio({
  files,
  setFiles,
  onFilesAdded,
  selectedQuality: propsSelectedQuality,
  setSelectedQuality: propsSetSelectedQuality,
  onCreditsUpdated,
  remainingCredits,
}: CleanvoiceStudioProps) {
  // Quality selection state
  const [localSelectedQuality, setLocalSelectedQuality] = useState<"source" | "320" | "192" | "128">("source");
  const selectedQuality = propsSelectedQuality || localSelectedQuality;
  const setSelectedQuality = propsSetSelectedQuality || setLocalSelectedQuality;

  // File transcoding/compression loading states

  // Config state representing choices
  const [cvConfig, setCvConfig] = useState<Required<CleanvoiceConfig>>({
    fillers: false,
    stutters: false,
    silences: false,
    hesitations: false,
    mouth_sounds: false,
    mute: false,
    noise: "v2",
    reverb: false,
    normalize: true,
    eq: false,
    format: "mp3",
    transcribe: false,
    summarize: false,
    social_content: false,
    keep_music: false,
    remove_breath: "disabled",
    studio_sound: "javelin",
    targetBitrate: "source",
    start_time: undefined,
    end_time: undefined,
  });

  // Modal selector state
  const [activeModal, setActiveModal] = useState<
    "breath" | "noise" | "studio_sound" | "mastering" | null
  >(null);

  // Close any active options modal when the Escape key is pressed
  useEffect(() => {
    if (activeModal === null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setActiveModal(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeModal]);

  // Custom Preset dropdown open state + outside-click / Escape handling
  const [isPresetOpen, setIsPresetOpen] = useState(false);
  const presetDropdownRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isPresetOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        presetDropdownRef.current &&
        !presetDropdownRef.current.contains(e.target as Node)
      ) {
        setIsPresetOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setIsPresetOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPresetOpen]);

  // UI tabs and controls
  const [activeTab, setActiveTab] = useState<"edit" | "enhance" | "export">(
    "edit",
  );
  const [selectedPreset, setSelectedPreset] = useState<string>("Custom Preset");
  // Processing history state
  const [historyJobs, setHistoryJobs] = useState<any[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("cleanvoice_studio_jobs_history");
        return saved ? JSON.parse(saved) : [];
      } catch (e) {
        console.warn("Failed to load cleanvoice_studio_jobs_history", e);
      }
    }
    return [];
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("cleanvoice_studio_jobs_history", JSON.stringify(historyJobs));
    }
  }, [historyJobs]);

  // Sync files cleanvoiceResult changes into history list automatically
  useEffect(() => {
    if (!files || files.length === 0) return;
    
    setHistoryJobs((prev) => {
      let changed = false;
      const updatedList = [...prev];
      
      files.forEach((f) => {
        if (f.cleanvoiceResult) {
          const res = f.cleanvoiceResult;
          // Look for an existing history item with the same editId or file ID + name
          const matchId = res.editId || f.id;
          const idx = updatedList.findIndex((item) => item.id === matchId || (item.fileName === f.name && Math.abs(item.startedAt - (res.startedAt || 0)) < 15000));
          
          if (idx !== -1) {
            // Update item if state is different or newer
            const current = updatedList[idx];
            if (current.status !== res.status || current.progress !== res.progress || current.cleanedUrl !== res.cleanedUrl) {
              updatedList[idx] = {
                ...current,
                status: res.status as any,
                progress: res.progress ?? current.progress,
                cleanedUrl: res.cleanedUrl || current.cleanedUrl,
                logs: res.logs || current.logs,
                editId: res.editId || current.editId,
              };
              changed = true;
            }
          } else {
            // Add as new item at the top!
            updatedList.unshift({
              id: matchId,
              fileName: f.name,
              fileSize: f.file?.size || 0,
              duration: f.duration,
              startedAt: res.startedAt || Date.now(),
              status: res.status as any,
              progress: res.progress ?? 0,
              logs: res.logs || [],
              cleanedUrl: res.cleanedUrl,
              editId: res.editId,
            });
            changed = true;
          }
        }
      });
      
      return changed ? updatedList : prev;
    });
  }, [files]);

  // API key state
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem("cleanvoice_api_key") || "";
  });

  // Terminal logs for running jobs fallback (if file doesn't have it yet)
  const [, setLocalLogs] = useState<string[]>([]);
  const [localIsProcessing, setLocalIsProcessing] = useState(false);
  const [localBatchIndex, setLocalBatchIndex] = useState<number>(0);

  const cancelProcessingRef = React.useRef<Set<string>>(new Set());
  const abortControllersRef = React.useRef<Record<string, AbortController>>({});
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const filesRef = React.useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const selectedQualityRef = React.useRef(selectedQuality);
  useEffect(() => {
    selectedQualityRef.current = selectedQuality;
  }, [selectedQuality]);

  const cvConfigRef = React.useRef(cvConfig);
  useEffect(() => {
    cvConfigRef.current = cvConfig;
  }, [cvConfig]);

  const handleUploadIconClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesAdded(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  useEffect(() => {
    Object.keys(abortControllersRef.current).forEach((id) => {
      if (!files.find((f) => f.id === id)) {
        abortControllersRef.current[id].abort();
        delete abortControllersRef.current[id];
      }
    });
  }, [files]);

  useEffect(() => {
    const handleDisconnect = () => {
      setApiKey("");
    };
    window.addEventListener("cleanvoice-key-disconnected", handleDisconnect);
    return () => {
      window.removeEventListener("cleanvoice-key-disconnected", handleDisconnect);
    };
  }, []);

  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [isDraggingOverButton, setIsDraggingOverButton] = useState(false);
  const [isDraggingAnywhere, setIsDraggingAnywhere] = useState(false);

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const handleDragEnter = (e: DragEvent) => {
      if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
        setIsDraggingAnywhere(true);
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      if (e.clientX === 0 && e.clientY === 0) {
        setIsDraggingAnywhere(false);
      }
    };
    const handleDrop = () => {
      setIsDraggingAnywhere(false);
      setIsDraggingOverButton(false);
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  // Recording States for the Pill component beside "Source Audio Tracks"
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const [activeMimeType, setActiveMimeType] = useState<string>("");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [isPlayingPlayback, setIsPlayingPlayback] = useState(false);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const playbackAudioRef = React.useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!isPaused) {
      if (playbackUrl) {
        URL.revokeObjectURL(playbackUrl);
        setPlaybackUrl(null);
      }
      setIsPlayingPlayback(false);
      setPlaybackCurrentTime(0);
      setPlaybackDuration(0);
    }
  }, [isPaused]);

  useEffect(() => {
    return () => {
      if (playbackUrl) {
        URL.revokeObjectURL(playbackUrl);
      }
    };
  }, [playbackUrl]);

  useEffect(() => {
    if (playbackAudioRef.current) {
      if (isPlayingPlayback) {
        playbackAudioRef.current.play().catch(err => {
          console.warn("Failed to play preview audio:", err);
        });
      } else {
        playbackAudioRef.current.pause();
      }
    }
  }, [isPlayingPlayback]);

  const togglePlaybackPlay = () => {
    setIsPlayingPlayback((prev) => !prev);
  };

  const formatPlaybackTime = (seconds: number) => {
    const safe = isNaN(seconds) || !isFinite(seconds) || seconds < 0 ? 0 : Math.floor(seconds);
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };


  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const durationRef = React.useRef<number>(0);
  const startTimestampRef = React.useRef<number>(0);
  const intervalRef = React.useRef<number | null>(null);
  const syntheticCtxRef = React.useRef<any>(null);
  const syntheticOscRef = React.useRef<any>(null);

  // Clean elements on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const startRecording = async () => {
    let stream: MediaStream;

    try {
      // Capture completely raw, unfiltered, unprocessed, and full audio input (no automatic gain control, noise suppression, echo cancellation, highpass filter, or automatic leveling)
      stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          googAudioSourceLevelControl: false,
          googNoiseSuppression2: false,
          googEchoCancellation2: false,
          googTypingNoiseDetection: false
        } as any
      });
    } catch (err: any) {
      console.warn("Microphone stream access bypassed. Falling back to synthetic stream illustration.", err);
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass();
      syntheticCtxRef.current = ctx;
      
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      syntheticOscRef.current = osc;
      const gainNode = ctx.createGain();
      
      osc.type = "triangle";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gainNode.gain.setValueAtTime(0.08, ctx.currentTime);
      
      let baseTime = ctx.currentTime;
      for (let i = 0; i < 300; i++) {
        gainNode.gain.setValueAtTime(0.08, baseTime);
        gainNode.gain.setValueAtTime(0.01, baseTime + 0.3);
        gainNode.gain.setValueAtTime(0.12, baseTime + 0.6);
        gainNode.gain.setValueAtTime(0.0, baseTime + 1.0);
        baseTime += 1.4;
      }
      
      osc.connect(gainNode);
      gainNode.connect(dest);
      osc.start();
      
      stream = dest.stream;
    }

    try {
      let options: MediaRecorderOptions = {
        audioBitsPerSecond: 128000
      };
      const mimeTypesToTry = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      let selectedMimeType = "";
      if (typeof MediaRecorder !== "undefined") {
        for (const type of mimeTypesToTry) {
          if (MediaRecorder.isTypeSupported(type)) {
            options.mimeType = type;
            selectedMimeType = type;
            break;
          }
        }
      }
      
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      const recordedType = selectedMimeType || mediaRecorder.mimeType || "audio/webm;codecs=opus";
      setActiveMimeType(recordedType);
      
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
            const tempBlob = new Blob(chunksRef.current, { type: recordedType });
            const url = URL.createObjectURL(tempBlob);
            setPlaybackUrl((oldUrl) => {
              if (oldUrl) URL.revokeObjectURL(oldUrl);
              return url;
            });
          }
        }
      };

      mediaRecorder.onstop = async () => {
        const rawBlob = new Blob(chunksRef.current, { type: recordedType });
        let extension = "webm";
        if (recordedType.includes("mp4")) {
          extension = "m4a";
        } else if (recordedType.includes("ogg")) {
          extension = "ogg";
        }
        
        const numberedFiles = filesRef.current.filter(f => {
          const baseName = f.name.split('.')[0];
          return /^\d+$/.test(baseName);
        });
        let nextIndex = 1;
        if (numberedFiles.length > 0) {
          const numbers = numberedFiles.map(f => {
            const num = parseInt(f.name.split('.')[0], 10);
            return isNaN(num) ? 0 : num;
          });
          nextIndex = Math.max(...numbers) + 1;
        }
        const name = `${nextIndex}.${extension}`;
        
        const fileAddedCallback = (blob: Blob) => {
          const fileObj = new File([blob], name, { type: recordedType, lastModified: Date.now() });
          onFilesAdded([fileObj]);
        };

        if (extension === "webm" && durationRef.current > 0) {
          try {
            const { default: fixWebmDuration } = await import("fix-webm-duration");
            fixWebmDuration(rawBlob, durationRef.current, (fixedBlob) => {
              fileAddedCallback(fixedBlob);
            });
          } catch (e) {
            fileAddedCallback(rawBlob);
          }
        } else {
          fileAddedCallback(rawBlob);
        }
        
        stream.getTracks().forEach(track => track.stop());
        
        if (syntheticOscRef.current) {
          try { syntheticOscRef.current.stop(); } catch (e) {}
          syntheticOscRef.current = null;
        }
        if (syntheticCtxRef.current) {
          try { syntheticCtxRef.current.close(); } catch (e) {}
          syntheticCtxRef.current = null;
        }
      };

      const isBatterySaverActive = typeof window !== "undefined" && (window as any).isBatterySaverActive;
      if (isBatterySaverActive) {
        mediaRecorder.start(2000);
      } else {
        mediaRecorder.start(500);
      }
      setIsRecording(true);
      setIsPaused(false);
      setRecordingTime(0);
      durationRef.current = 0;
      startTimestampRef.current = performance.now();

      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = window.setInterval(() => {
        // Use performance.now() for accurate elapsed time instead of
        // incrementing by 1, so the displayed duration stays perfectly
        // synchronised with the real wall-clock time (no drift from
        // setInterval jitter, pause/resume boundaries, or tab throttling).
        const elapsed = startTimestampRef.current > 0
          ? (performance.now() - startTimestampRef.current + durationRef.current) / 1000
          : 0;
        setRecordingTime(Math.floor(elapsed));
      }, 250);

    } catch (mediaError) {
      console.error("Failed to start MediaRecorder:", mediaError);
    }
  };

  const togglePauseRecording = () => {
    if (mediaRecorderRef.current) {
      if (isPaused) {
        mediaRecorderRef.current.resume();
        startTimestampRef.current = performance.now();
        setIsPaused(false);
        if (intervalRef.current) window.clearInterval(intervalRef.current);
        intervalRef.current = window.setInterval(() => {
          // Use performance.now() for accurate elapsed time instead of
          // incrementing by 1, so the displayed duration stays perfectly
          // synchronised with the real wall-clock time (no drift from
          // setInterval jitter, pause/resume boundaries, or tab throttling).
          const elapsed = startTimestampRef.current > 0
            ? (performance.now() - startTimestampRef.current + durationRef.current) / 1000
            : 0;
          setRecordingTime(Math.floor(elapsed));
        }, 250);
      } else {
        if (mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.requestData();
        }
        mediaRecorderRef.current.pause();
        durationRef.current += performance.now() - startTimestampRef.current;
        setIsPaused(true);
        if (intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        // Calculate the precise elapsed duration (seconds) at pause time
        // so the preview segment always shows the correct total length.
        const pauseElapsedSec = durationRef.current / 1000;
        setTimeout(() => {
          if (chunksRef.current.length > 0) {
            const tempBlob = new Blob(chunksRef.current, { type: activeMimeType });
            const url = URL.createObjectURL(tempBlob);
            setPlaybackUrl((oldUrl) => {
              if (oldUrl) URL.revokeObjectURL(oldUrl);
              return url;
            });
            // Use the precise performance.now()-based elapsed duration as the
            // authoritative preview length. This avoids any drift from the 1s
            // interval counter and stays correct regardless of webm metadata.
            setPlaybackDuration(pauseElapsedSec > 0 ? pauseElapsedSec : 1);
          }
        }, 150);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      if (!isPaused) {
        durationRef.current += performance.now() - startTimestampRef.current;
      }
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsPaused(false);
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(
    new Set(),
  );

  const [selectedCompletedFileIds, setSelectedCompletedFileIds] = useState<
    Set<string>
  >(new Set());
  const [isZipping, setIsZipping] = useState(false);
  // Tracks per-file in-flight downloads to prevent duplicate clicks spawning
  // multiple parallel downloads of the same cleaned file.
  const [downloadingFileIds, setDownloadingFileIds] = useState<Set<string>>(
    new Set(),
  );

  const audioFilesInQueue = React.useMemo(
    () => files.filter((f) => isAudioFile({ name: f.name, type: f.type })),
    [files],
  );
  const targetFiles = React.useMemo(() => {
    return selectedFileIds.size > 0
      ? audioFilesInQueue.filter((f) => selectedFileIds.has(f.id))
      : audioFilesInQueue;
  }, [audioFilesInQueue, selectedFileIds]);

  const isProcessingStatus = targetFiles.some(
    (f) =>
      f.cleanvoiceResult?.status === "pending" ||
      f.cleanvoiceResult?.status === "uploading" ||
      f.cleanvoiceResult?.status === "processing",
  );
  const isProcessing = localIsProcessing || isProcessingStatus;
  const activeFile = React.useMemo(() => {
    if (activeFileId) {
      const found = targetFiles.find((f) => f.id === activeFileId);
      if (found) return found;
    }
    if (
      (localIsProcessing || isProcessingStatus) &&
      targetFiles[localBatchIndex]
    ) {
      return targetFiles[localBatchIndex];
    }
    const processing = targetFiles.find(
      (f) =>
        f.cleanvoiceResult?.status === "pending" ||
        f.cleanvoiceResult?.status === "uploading" ||
        f.cleanvoiceResult?.status === "processing",
    );
    if (processing) return processing;
    for (let i = targetFiles.length - 1; i >= 0; i--) {
      if (targetFiles[i].cleanvoiceResult?.logs?.length) return targetFiles[i];
    }
    return undefined;
  }, [
    localIsProcessing,
    isProcessingStatus,
    targetFiles,
    localBatchIndex,
    activeFileId,
  ]);
  
  const [lastResultUrl, setLastResultUrl] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Batch actions
  const handleToggleSelectAll = () => {
    if (
      selectedFileIds.size === audioFilesInQueue.length &&
      audioFilesInQueue.length > 0
    ) {
      setSelectedFileIds(new Set());
    } else {
      setSelectedFileIds(new Set(audioFilesInQueue.map((f) => f.id)));
    }
  };

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedFileIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedFileIds(newSelected);
  };

  const getFreshUrlForFile = async (f: FileItem): Promise<string | null> => {
    let currentUrl = f.cleanvoiceResult?.cleanedUrl;
    if (!currentUrl) return null;

    if (currentUrl.startsWith("blob:")) {
      return currentUrl;
    }

    const editId = f.cleanvoiceResult?.editId;
    if (!editId) {
      return currentUrl;
    }

    const apiKey = localStorage.getItem("cleanvoice_api_key") || "";
    if (!apiKey) {
      return currentUrl;
    }

    try {
      console.log(`[Fresh URL] Refreshing S3 URL for editId: ${editId}`);
      const status = await getCleanvoiceEditStatus(editId, apiKey);
      if (status.remainingCredits !== undefined && onCreditsUpdated) {
        onCreditsUpdated(status.remainingCredits);
      }
      const freshS3Url = status.download_url;

      if (!freshS3Url) {
        throw new Error("No download_url returned from Cleanvoice status API");
      }

      return freshS3Url;
    } catch (err) {
      const errStr = ((err as any)?.message || String(err)).toLowerCase();
      // "Task not found" / E4001 means Cleanvoice has purged the job — its
      // result audio is gone for good. Record this fileId+editId pair so the
      // eager-cache effect stops retrying the pre-fetch forever (otherwise it
      // loops every few seconds on every re-render). Keyed on editId so a
      // re-processed job with a fresh id gets another attempt.
      if (errStr.includes("task not found") || errStr.includes("e4001") || errStr.includes("not found")) {
        const eid = f.cleanvoiceResult?.editId || "";
        if (f.id && eid) cleanvoiceFailedPrefetches.add(`${f.id}:${eid}`);
      }
      console.warn("Failed to retrieve fresh download URL from cleanvoice API, using fallback url", err);
      return currentUrl;
    }
  };

  // Background pre-fetching (Eager Caching) for Cleanvoice outputs
  useEffect(() => {
    // Pre-fetching the R2 result audio requires the same-origin /api/proxy-audio
    // endpoint (R2 has no CORS headers for a direct browser fetch). That
    // endpoint only exists on the full server.ts backend; on static-only hosts
    // the fetch is guaranteed to fail (CORS / 404) and only spams the console.
    // Playback still works via a direct <audio src> element (no CORS for media).
    if (!hasServerBackend()) return;

    const completedFiles = files.filter(
      (f) =>
        f.cleanvoiceResult?.status === "success" &&
        f.cleanvoiceResult?.cleanedUrl
    );

    completedFiles.forEach((f) => {
      const fileId = f.id;
      const url = f.cleanvoiceResult!.cleanedUrl!;

      // Skip files that are already cached, currently in flight, or whose job
      // was permanently purged (Task not found / E4001) so we don't loop forever.
      const editId = f.cleanvoiceResult?.editId || "";
      if (
        cleanvoiceBlobCache[fileId] ||
        cleanvoiceActivePrefetches[fileId] ||
        (editId && cleanvoiceFailedPrefetches.has(`${fileId}:${editId}`))
      ) {
        return;
      }

      console.log(`[Eager Cache] Pre-fetching audio for file: ${fileId} from URL: ${url}`);

      const startFetch = (fetchUrl: string): Promise<Blob> => {
        const transcodeBitrate = selectedQualityRef.current === "source"
          ? (parseInt(f.sourceBitrate || "128") || 128)
          : (parseInt(selectedQualityRef.current) || 128);

        // Primary path: server-side native ffmpeg (/api/transcode-audio). The
        // native binary fetches + transcodes the source in one round-trip at
        // full CPU speed — dramatically faster than client-side WASM — and
        // caches the result server-side by SHA-256 key.
        return (async () => {
          try {
            const { transcodeViaServer } = await import("../utils/audioUtils");
            const mp3Blob = await transcodeViaServer(
              fetchUrl,
              transcodeBitrate,
              "mp3",
              `${f.name || "audio"}_cleaned.mp3`,
            );
            setCleanvoiceBlobCache(fileId, mp3Blob);
            return mp3Blob;
          } catch (serverErr) {
            console.warn("[Eager Cache] Server-side transcode failed, falling back to WASM:", serverErr);
          }

          // Fallback: proxy-fetch raw blob + client-side FFmpeg WASM transcode.
          // Direct fetch of remote Cleanvoice (R2) URLs is blocked by CORS on
          // static hosting. Use the same-origin proxy endpoint for remote URLs;
          // pass blob:/relative URLs through untouched.
          const proxyUrl = fetchUrl.startsWith("blob:") || fetchUrl.startsWith("/")
            ? fetchUrl
            : fetchUrl;

          const res = await fetch(proxyUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();

          if (blob.size < 12 * 1024) {
            const text = await blob.text();
            const isError = text.startsWith("<") || text.includes("AccessDenied") || text.includes("NoSuchKey") || text.includes("Error") || text.includes('{"error"');
            if (isError) {
              throw new Error("Blob is a small S3 error XML or JSON document");
            }
          }
          try {
            const { transcodeBlobFast } = await import("../utils/audioUtils");
            const mp3Blob = await transcodeBlobFast(blob, transcodeBitrate, 'mp3');
            setCleanvoiceBlobCache(fileId, mp3Blob);
            return mp3Blob;
          } catch (err) {
            console.warn("[Eager Cache] WASM transcoding failed, using raw blob:", err);
            setCleanvoiceBlobCache(fileId, blob);
            return blob;
          }
        })();
      };

      const fetchPromise = startFetch(url)
        .catch((err) => {
          console.warn(`[Eager Cache] Initial pre-fetch failed for ${fileId}, trying fresh URL refresh:`, err);
          return getFreshUrlForFile(f)
            .then((freshUrl) => {
              if (freshUrl && freshUrl !== url) {
                console.log(`[Eager Cache] Retrying pre-fetch for ${fileId} with fresh URL resolved from S3/API: ${freshUrl}`);
                return startFetch(freshUrl);
              }
              throw new Error("Fresh URL identical or none returned");
            });
        })
        .then((blob) => {
          setCleanvoiceBlobCache(fileId, blob);
          console.log(`[Eager Cache] Successfully cached audio blob of length: ${blob.size} bytes for file: ${fileId}`);
          return blob;
        })
        .catch((finalErr) => {
          console.warn(`[Eager Cache] Optional pre-fetch skipped or failed for ${fileId}:`, finalErr);
          delete cleanvoiceActivePrefetches[fileId];
          return null;
        });

      cleanvoiceActivePrefetches[fileId] = fetchPromise;
    });
  }, [files]);

  // While the active file is in the "uploading" state but its bytes are still
  // being transferred by the eager background upload (App.tsx), the
  // startCleanvoiceEdit path only logs "Awaiting..." with no percentage. Mirror
  // the real byte progress (FileItem.uploadProgress, fed by the same XHR
  // onProgress) into cleanvoiceResult.uploadProgress so the main progress bar
  // reflects the true upload instead of freezing. Guarded by a value-equality
  // check so it never loops (once equal, the effect is a no-op).
  useEffect(() => {
    if (!activeFileId) return;
    const f = files.find((x) => x.id === activeFileId);
    if (!f) return;
    if (
      f.isUploading &&
      f.uploadProgress != null &&
      f.cleanvoiceResult?.status === "uploading" &&
      f.cleanvoiceResult.uploadProgress !== f.uploadProgress
    ) {
      setFiles((prev) =>
        prev.map((x) =>
          x.id === f.id
            ? {
                ...x,
                cleanvoiceResult: { ...x.cleanvoiceResult!, uploadProgress: f.uploadProgress! },
              }
            : x
        )
      );
    }
  }, [activeFileId, files]);

  const runSilentBackgroundTranscode = async (f: FileItem, downloadUrl: string) => {
    // The direct R2 fetch is CORS-blocked and /api/proxy-audio is absent on
    // static-only hosts, so the pre-warm can never succeed there — skip it and
    // avoid the CORS + 403 console noise. Playback uses the raw URL directly.
    if (!hasServerBackend()) return;

    const fetchAndTranscodePromise = (async () => {
      const transcodeBitrate = selectedQualityRef.current === "source"
        ? (parseInt(f.sourceBitrate || "128") || 128)
        : (parseInt(selectedQualityRef.current) || 128);

      let finalBlob: Blob | null = null;

      // Primary path: server-side native ffmpeg (/api/transcode-audio). The
      // native binary runs at full CPU speed and fetches+transcodes the source
      // in one round-trip, which is dramatically faster than client-side WASM.
      // Results are also cached server-side by SHA-256 key.
      try {
        const { transcodeViaServer } = await import("../utils/audioUtils");
        finalBlob = await transcodeViaServer(
          downloadUrl,
          transcodeBitrate,
          "mp3",
          `${f.name || "audio"}_cleaned.mp3`,
        );
      } catch (err) {
        console.warn("[Silent Background Transcode] Server-side transcode failed, falling back to WASM:", err);
      }

      // Fallback: fetch raw blob + client-side FFmpeg WASM transcode.
      if (!finalBlob) {
        let response;
        try {
          response = await fetch(downloadUrl);
          if (!response.ok) throw new Error("direct fetch fallback");
        } catch (err) {
          const proxyUrl = downloadUrl.startsWith("blob:") || downloadUrl.startsWith("/")
            ? downloadUrl
            : downloadUrl;
          response = await fetch(proxyUrl);
        }

        if (response.headers.get("content-type")?.includes("text/html")) {
          throw new Error("Proxy returned HTML");
        }

        const rawBlob = await response.blob();
        finalBlob = rawBlob;

        try {
          const { transcodeBlobFast } = await import("../utils/audioUtils");
          finalBlob = await transcodeBlobFast(rawBlob, transcodeBitrate, 'mp3');
        } catch (err) {
          console.warn("[Silent Background Transcode] WASM transcode failed, using raw blob:", err);
        }
      }

      if (!finalBlob) throw new Error("Transcode produced no output");

      const localUrl = URL.createObjectURL(finalBlob);

      setFiles((prev) =>
        prev.map((item) =>
          item.id === f.id && item.cleanvoiceResult
            ? {
                ...item,
                cleanvoiceResult: {
                  ...item.cleanvoiceResult,
                  preTranscodedBlob: finalBlob,
                  preTranscodedUrl: localUrl
                },
              }
            : item
        )
      );

      setCleanvoiceBlobCache(f.id, finalBlob);
      return finalBlob;
    })();
    
    cleanvoiceActivePrefetches[f.id] = fetchAndTranscodePromise;
    try {
      await fetchAndTranscodePromise;
    } catch (err) {
      console.warn("[Silent Background Transcode] Fast caching optional pre-warm failed:", err);
    }
  };

  // Real-Time WebSocket state synchronization
  useEffect(() => {
    let ws: globalThis.WebSocket | null = null;
    let reconnectTimeout: any = null;
    let isMounted = true;

    const connectWS = () => {
      if (!isMounted) return;
      
      if (
        (getBaseUrl && getBaseUrl() === "https://api.cleanvoice.ai") ||
        window.location.hostname.includes("netlify") ||
        window.location.hostname.includes("vercel.app")
      ) {
        console.log("[WS Client] Bypassing WebSocket engine on direct client-only static hosting (Netlify / GitHub Pages / Vercel).");
        return;
      }
      
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/api/cleanvoice/ws-status`;
      
      console.log(`[WS Client] Connecting to ${wsUrl}`);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log("[WS Client] Connected successfully.");
        // Resubscribe to any active files that are currently processing
        const processingFiles = filesRef.current.filter(
          (f) => f.cleanvoiceResult && (
            f.cleanvoiceResult.status === "processing" || 
            f.cleanvoiceResult.status === "uploading" || 
            f.cleanvoiceResult.status === "pending"
          )
        );
        for (const file of processingFiles) {
          const editId = file.cleanvoiceResult?.editId;
          if (editId) {
            console.log(`[WS Client] Re-subscribing to active editId: ${editId}`);
            ws.send(JSON.stringify({ type: "subscribe", editId }));
          }
        }
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "status_update" && payload.editId) {
            const { editId, status, data, serverElapsedSeconds, progressPercentage } = payload;
            
            // Find the file that matches this editId
            const matchingFile = filesRef.current.find((f) => f.cleanvoiceResult?.editId === editId);
            if (!matchingFile || !matchingFile.cleanvoiceResult) return;
            
            // Check if status changed or has progress update
            const currentStatus = matchingFile.cleanvoiceResult.status;
            
            if (status === "success") {
              if (currentStatus !== "success") {
                console.log(`[WS Client] Real-time success received for ${editId}`);
                const download_url = data?.download_url || (data?.results || data?.result)?.download_url;
                if (download_url) {
                  // Trigger silent background pre-fetch and 128kbps transcoding
                  runSilentBackgroundTranscode(matchingFile, download_url).catch((err) => {
                    console.warn("Silent background transcode invocation error:", err);
                  });

                  setFiles((prev) =>
                    prev.map((f) =>
                      f.id === matchingFile.id && f.cleanvoiceResult
                        ? {
                            ...f,
                            cleanvoiceResult: {
                              ...f.cleanvoiceResult,
                              status: "success",
                              cleanedUrl: download_url,
                              edits: data?.edits || (data?.results || data?.result)?.edits,
                              duration: data?.duration || (data?.results || data?.result)?.duration,
                              transcription: data?.transcription || (data?.results || data?.result)?.transcription,
                              summary: data?.summary || (data?.results || data?.result)?.summary,
                              social_content: data?.social_content || (data?.results || data?.result)?.social_content,
                              elapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.elapsedSeconds,
                              serverElapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                              serverElapsedAt: serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                              logs: [
                                ...(f.cleanvoiceResult.logs || []),
                                `[${new Date().toLocaleTimeString()}] ✨ [Real-time Channel] Audio cleaned successfully! URL: ${download_url}`
                              ]
                            },
                          }
                        : f,
                    ),
                  );
                  setLastResultUrl(download_url);
                }
              }
            } else if (status === "error") {
              if (currentStatus !== "error") {
                console.log(`[WS Client] Real-time error received for ${editId}`);
                const errorText = data?.error || data?.detail || "Unknown API error";
                setFiles((prev) =>
                  prev.map((f) =>
                    f.id === matchingFile.id && f.cleanvoiceResult
                      ? {
                          ...f,
                          cleanvoiceResult: {
                            ...f.cleanvoiceResult,
                            status: "error",
                            error: errorText,
                            elapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.elapsedSeconds,
                            serverElapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                            serverElapsedAt: serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                            logs: [
                              ...(f.cleanvoiceResult.logs || []),
                              `[${new Date().toLocaleTimeString()}] ❌ [Real-time Channel] Error: ${errorText}`
                            ]
                          },
                        }
                      : f,
                  ),
                );
              }
            } else {
              // Intermediate update (progress percentage, status)
              setFiles((prev) =>
                prev.map((f) => {
                  if (f.id === matchingFile.id && f.cleanvoiceResult) {
                    const statusObj = data?.results || data?.result || data || {};
                    let rawStatusText = (data?.status || "").toString().toLowerCase();
                    if (statusObj && typeof statusObj === "object") {
                      if ("state" in statusObj && typeof statusObj.state === "string") {
                        rawStatusText = statusObj.state.toLowerCase();
                      } else if ("task" in statusObj && typeof statusObj.task === "string") {
                        rawStatusText = statusObj.task.toLowerCase();
                      }
                    }

                    let nextRawStatus = rawStatusText.toUpperCase();
                    if (nextRawStatus === "PROCESSING" || nextRawStatus === "") {
                      if (data?.info && typeof data.info === "string") nextRawStatus = data.info.toUpperCase();
                      else if (data?.message && typeof data.message === "string") nextRawStatus = data.message.toUpperCase();
                      else if (data?.step && typeof data.step === "string") nextRawStatus = data.step.toUpperCase();
                      else if (data?.state && typeof data.state === "string") nextRawStatus = data.state.toUpperCase();
                    }
                    if (!nextRawStatus) nextRawStatus = "PROCESSING";

                    const nextProgress = progressPercentage !== undefined
                      ? progressPercentage
                      : (data?.results || data?.result)?.done !== undefined
                        ? (parseFloat((data?.results || data?.result)?.done) <= 1 ? parseFloat((data?.results || data?.result)?.done) * 100 : parseFloat((data?.results || data?.result)?.done))
                        : f.cleanvoiceResult.progress;

                    const isQueued = !!data?.isQueued || rawStatusText === "queued" || rawStatusText === "waiting" || rawStatusText === "pending" || (nextProgress !== undefined && nextProgress <= 5);

                    const nextStageTitle = payload.stageTitle || data?.stageTitle || (data?.results || data?.result)?.stageTitle;

                    return {
                      ...f,
                      cleanvoiceResult: {
                        ...f.cleanvoiceResult,
                        status: "processing",
                        rawStatus: isQueued ? "QUEUED" : nextRawStatus,
                        isQueued: isQueued,
                        progress: nextProgress,
                        stageTitle: nextStageTitle || (f.cleanvoiceResult as any).stageTitle,
                        elapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.elapsedSeconds,
                        serverElapsedSeconds: serverElapsedSeconds !== undefined ? serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                        serverElapsedAt: serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                      }
                    };
                  }
                  return f;
                })
              );
            }
          }
        } catch (e) {
          console.error("[WS Client] Message parse error:", e);
        }
      };

      ws.onclose = () => {
        if (isMounted) {
          console.log("[WS Client] Closed. Reconnecting in 3s...");
          reconnectTimeout = setTimeout(connectWS, 3000);
        }
      };

      ws.onerror = (err) => {
        console.warn("[WS Client] Error:", err);
        ws?.close();
      };
    };

    connectWS();

    // Listen to custom event when a new job starts to subscribe to it immediately
    const handleNewJob = (e: any) => {
      const customEvent = e as CustomEvent<{ editId: string }>;
      if (ws && ws.readyState === 1 && customEvent.detail?.editId) {
        console.log(`[WS Client] New job registered. Subscribing to: ${customEvent.detail.editId}`);
        ws.send(JSON.stringify({ type: "subscribe", editId: customEvent.detail.editId }));
      }
    };

    window.addEventListener("ws-subscribe-job", handleNewJob);

    return () => {
      isMounted = false;
      window.removeEventListener("ws-subscribe-job", handleNewJob);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; // disable auto reconnect
        ws.close();
      }
    };
  }, []);

  const robustSingleDownload = async (f: FileItem, targetName: string, showGlobalSpinner = false) => {
    // Re-entrancy guard: if this file is already being downloaded, ignore the
    // extra click instead of spawning a duplicate parallel download.
    if (downloadingFileIds.has(f.id)) return;
    setDownloadingFileIds((prev) => new Set(prev).add(f.id));
    if (showGlobalSpinner) setIsZipping(true);
    const urlToFetch = f.cleanvoiceResult?.cleanedUrl;
    if (!urlToFetch) {
      if (showGlobalSpinner) setIsZipping(false);
      setDownloadingFileIds((prev) => {
        const next = new Set(prev);
        next.delete(f.id);
        return next;
      });
      return;
    }

    try {
      let finalBlob: Blob | null = cleanvoiceBlobCache[f.id] || f.cleanvoiceResult?.preTranscodedBlob || null;
      let localUrl = f.cleanvoiceResult?.preTranscodedUrl || null;
      // Tracks whether finalBlob came from an already-transcoded cache. The
      // raw network fetch below yields Cleanvoice's server output, which is
      // always 320kbps — that must be transcoded down to the selected quality
      // (or the source bitrate) so "source" + 128kbps input → 128kbps output.
      let fromCache = !!finalBlob;

      if (!finalBlob && cleanvoiceActivePrefetches[f.id]) {
        try {
          finalBlob = await cleanvoiceActivePrefetches[f.id];
          fromCache = !!finalBlob;
        } catch (e) {
          console.warn("[Robust Single Download] Awaiting in-flight prefetch failed:", e);
        }
      }

      if (!finalBlob) {
        let response;
        try {
          response = await fetch(urlToFetch);
          if (!response.ok) throw new Error("direct fetch fallback");
        } catch (err) {
          const proxyUrl = urlToFetch.startsWith("blob:") || urlToFetch.startsWith("/")
            ? urlToFetch
            : urlToFetch;
          response = await fetch(proxyUrl);
        }

        if (response.headers.get("content-type")?.includes("text/html")) {
          throw new Error("Proxy returned HTML");
        }
        finalBlob = await response.blob();
        fromCache = false;
      }

      // Raw Cleanvoice output is 320kbps. Transcode to the selected quality
      // (or match the source bitrate when "source" is selected) so the export
      // honors the user's bitrate choice. Cached/pre-transcoded blobs already
      // went through this and are skipped.
      //
      // This path uses transcodeBlobFast (WASM) directly on the already-fetched
      // blob rather than transcodeViaServer, because by the time the user clicks
      // download the Cleanvoice R2 cleanedUrl may have expired — the server-side
      // re-fetch would fail. We already have the bytes locally, so transcode
      // them in place. (The eager-cache and background-transcode paths still use
      // transcodeViaServer since they run while the URL is fresh.)
      if (!fromCache && finalBlob) {
        try {
          const { transcodeBlobFast } = await import("../utils/audioUtils");
          const transcodeBitrate = selectedQualityRef.current === "source"
            ? (parseInt(f.sourceBitrate || "128") || 128)
            : (parseInt(selectedQualityRef.current) || 128);
          finalBlob = await transcodeBlobFast(finalBlob, transcodeBitrate, "mp3");
        } catch (wasmErr) {
          console.warn("[Robust Single Download] WASM transcode failed, downloading raw:", wasmErr);
        }
      }

      if (!localUrl && finalBlob) {
        localUrl = URL.createObjectURL(finalBlob);
      }

      let downloadName = targetName;
      if (!downloadName.endsWith(".mp3") && !downloadName.endsWith(".wav")) {
        downloadName = `${downloadName}.mp3`;
      }

      const a = document.createElement("a");
      a.href = localUrl!;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // We explicitly leave `finalBlob` in memory or let `preTranscodedUrl` stay
      // but revoke logic is handled centrally to avoid breaking multiple downloads.
      
      if (f.cleanvoiceResult?.editId && apiKey) {
        // Use the shared deleteCleanvoiceEdit() which sends the correct
        // X-API-Key auth header (Cleanvoice v2 rejects Authorization: Bearer)
        // and targets the proper /v2/edits/<id> endpoint.
        deleteCleanvoiceEdit(f.cleanvoiceResult.editId, apiKey).catch((err) => {
          console.warn("Background deletion request failed:", err);
        });
      }
    } catch (err) {
      console.error("[Robust Single Download] Error during download:", err);
      try {
        const response = await fetch(urlToFetch);
        let finalPreCompressedBlob = await response.blob();
        // Last-resort fallback: transcode the fetched blob with WASM directly
        // (the cleanedUrl may be expired, so a server-side re-fetch would fail).
        try {
          const { transcodeBlobFast } = await import("../utils/audioUtils");
          const transcodeBitrate = selectedQualityRef.current === "source"
            ? (parseInt(f.sourceBitrate || "128") || 128)
            : (parseInt(selectedQualityRef.current) || 128);
          finalPreCompressedBlob = await transcodeBlobFast(finalPreCompressedBlob, transcodeBitrate, "mp3");
        } catch (transcodeErr) {
          console.warn("[Robust Single Download] Fallback transcode failed, using raw blob:", transcodeErr);
        }
        const fallbackUrl = URL.createObjectURL(finalPreCompressedBlob);

        const a = document.createElement("a");
        a.href = fallbackUrl;
        a.download = targetName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Defer revoke so async download fetches don't get aborted.
        setTimeout(() => URL.revokeObjectURL(fallbackUrl), 4000);
      } catch (fallbackErr) {
        console.error("CleanvoiceStudio robustSingleDownload fallback failed:", fallbackErr);
      }
  } finally {
    if (showGlobalSpinner) setIsZipping(false);
    setDownloadingFileIds((prev) => {
      const next = new Set(prev);
      next.delete(f.id);
      return next;
    });
  }
  };

  // Inline rename for "Completed Output" items. Updates the cleaned-output
  // name (cleanedFileName) so both the displayed label and the downloaded file
  // reflect the user's edit. Scoped to completed files only; queue renaming is
  // handled separately via ResultCard's onRenameFile.
  const handleRenameCompletedFile = (fileId: string, newName: string) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId || !f.cleanvoiceResult) return f;
        return {
          ...f,
          cleanvoiceResult: {
            ...f.cleanvoiceResult,
            cleanedFileName: newName,
          },
        };
      }),
    );
  };

  const handleClearAll = async () => {
    if (selectedFileIds.size === 0) return;

    const itemsToDelete = audioFilesInQueue.filter((f) =>
      selectedFileIds.has(f.id),
    );

    const originalFiles = [...files];
    const originalSelectedFileIds = new Set(selectedFileIds);
    const originalActiveFileId = activeFileId;

    // 1. Optimistic UI Updates
    setFiles((prev) => prev.filter((f) => !selectedFileIds.has(f.id)));
    setSelectedFileIds(new Set());
    if (activeFileId && selectedFileIds.has(activeFileId)) {
      setActiveFileId(null);
    }

    // Capture cache references to restore on rollback
    const cacheBackups: Record<string, { blob: any; prefetch: any }> = {};
    itemsToDelete.forEach((item) => {
      cacheBackups[item.id] = {
        blob: cleanvoiceBlobCache[item.id],
        prefetch: cleanvoiceActivePrefetches[item.id],
      };

      // Free cached cleaned-audio blobs + object URLs for the cleared files
      if (item.cleanvoiceResult?.preTranscodedUrl) {
        try { URL.revokeObjectURL(item.cleanvoiceResult.preTranscodedUrl); } catch (e) {}
      }
      delete cleanvoiceBlobCache[item.id];
      delete cleanvoiceActivePrefetches[item.id];
    });

    // Abort controller actions
    itemsToDelete.forEach((item) => {
      cancelProcessingRef.current.add(item.id);
      if (abortControllersRef.current[item.id]) {
        abortControllersRef.current[item.id].abort();
        delete abortControllersRef.current[item.id];
      }
    });

    // 2. Background Processing
    if (apiKey) {
      const deletePromises = itemsToDelete
        .filter((item) => !!item.cleanvoiceResult?.editId)
        .map((item) =>
          deleteCleanvoiceEdit(item.cleanvoiceResult!.editId!, apiKey, true).catch((err) => {
            throw err;
          })
        );

      if (deletePromises.length > 0) {
        Promise.all(deletePromises)
          .then(() => {
            import("sonner").then(({ toast }) => {
              toast.success(`Successfully cleared ${deletePromises.length} selected ${deletePromises.length === 1 ? 'file' : 'files'} from cloud.`);
            });
          })
          .catch((err) => {
            console.error("Failed to delete selected queue files from Cleanvoice API:", err);

            // 3. Rollback UI state on failure
            setFiles(originalFiles);
            setSelectedFileIds(originalSelectedFileIds);
            setActiveFileId(originalActiveFileId);

            // Restore cache
            Object.entries(cacheBackups).forEach(([id, backup]) => {
              if (backup.blob) cleanvoiceBlobCache[id] = backup.blob;
              if (backup.prefetch) cleanvoiceActivePrefetches[id] = backup.prefetch;
            });

            import("sonner").then(({ toast }) => {
              toast.error("Failed to delete selected queue items from cloud. Restoring...");
            });
          });
      }
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    cancelProcessingRef.current.add(fileId);
    if (abortControllersRef.current[fileId]) {
      abortControllersRef.current[fileId].abort();
      delete abortControllersRef.current[fileId];
    }

    const fileItem = files.find((f) => f.id === fileId);
    const originalFiles = [...files];
    const originalSelectedFileIds = new Set(selectedFileIds);
    const originalActiveFileId = activeFileId;

    // 1. Optimistic UI Updates
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    if (activeFileId === fileId) {
      setActiveFileId(null);
    }

    // Capture cache references to restore on rollback
    const cachedBlob = cleanvoiceBlobCache[fileId];
    const cachedPrefetch = cleanvoiceActivePrefetches[fileId];

    // Free the cached cleaned-audio blob + object URL so memory isn't held
    if (fileItem?.cleanvoiceResult?.preTranscodedUrl) {
      try { URL.revokeObjectURL(fileItem.cleanvoiceResult.preTranscodedUrl); } catch (e) {}
    }
    delete cleanvoiceBlobCache[fileId];
    delete cleanvoiceActivePrefetches[fileId];

    // 2. Background Processing
    if (apiKey && fileItem?.cleanvoiceResult?.editId) {
      deleteCleanvoiceEdit(fileItem.cleanvoiceResult.editId, apiKey, true)
        .then(() => {
          // Success
        })
        .catch((err) => {
          console.error("Failed to delete edit from Cleanvoice API:", err);

          // 3. Rollback UI state on failure
          setFiles(originalFiles);
          setSelectedFileIds(originalSelectedFileIds);
          setActiveFileId(originalActiveFileId);

          if (cachedBlob) cleanvoiceBlobCache[fileId] = cachedBlob;
          if (cachedPrefetch) cleanvoiceActivePrefetches[fileId] = cachedPrefetch;

          import("sonner").then(({ toast }) => {
            toast.error(`Failed to delete "${fileItem?.name}" from Cleanvoice. Item restored.`, {
              id: `delete-fail-${fileId}`,
            });
          });
        });
    }
  };

  const handleClearAllQueue = async () => {
    const originalFiles = [...files];
    const originalSelectedFileIds = new Set(selectedFileIds);
    const originalActiveFileId = activeFileId;

    const queueIds = new Set(audioFilesInQueue.map((f) => f.id));

    // 1. Optimistic UI Updates
    setFiles((prev) => prev.filter((f) => !queueIds.has(f.id)));
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      queueIds.forEach((id) => next.delete(id));
      return next;
    });
    if (activeFileId && queueIds.has(activeFileId)) {
      setActiveFileId(null);
    }

    // Capture cache references to restore on rollback
    const cacheBackups: Record<string, { blob: any; prefetch: any }> = {};
    audioFilesInQueue.forEach((item) => {
      cacheBackups[item.id] = {
        blob: cleanvoiceBlobCache[item.id],
        prefetch: cleanvoiceActivePrefetches[item.id],
      };

      // Free cached cleaned-audio blobs + object URLs for the cleared files
      if (item.cleanvoiceResult?.preTranscodedUrl) {
        try { URL.revokeObjectURL(item.cleanvoiceResult.preTranscodedUrl); } catch (e) {}
      }
      delete cleanvoiceBlobCache[item.id];
      delete cleanvoiceActivePrefetches[item.id];
    });

    // Abort controller actions
    audioFilesInQueue.forEach((item) => {
      cancelProcessingRef.current.add(item.id);
      if (abortControllersRef.current[item.id]) {
        abortControllersRef.current[item.id].abort();
        delete abortControllersRef.current[item.id];
      }
    });

    // 2. Background Processing
    if (apiKey) {
      const deletePromises = audioFilesInQueue
        .filter((item) => !!item.cleanvoiceResult?.editId)
        .map((item) =>
          deleteCleanvoiceEdit(item.cleanvoiceResult!.editId!, apiKey, true).catch((err) => {
            throw err;
          })
        );

      if (deletePromises.length > 0) {
        Promise.all(deletePromises)
          .then(() => {
            import("sonner").then(({ toast }) => {
              toast.success(`Successfully cleared entire queue from cloud.`);
            });
          })
          .catch((err) => {
            console.error("Failed to delete all queue files from Cleanvoice API:", err);

            // 3. Rollback UI state on failure
            setFiles(originalFiles);
            setSelectedFileIds(originalSelectedFileIds);
            setActiveFileId(originalActiveFileId);

            // Restore cache
            Object.entries(cacheBackups).forEach(([id, backup]) => {
              if (backup.blob) cleanvoiceBlobCache[id] = backup.blob;
              if (backup.prefetch) cleanvoiceActivePrefetches[id] = backup.prefetch;
            });

            import("sonner").then(({ toast }) => {
              toast.error("Failed to delete queue items from cloud. Restoring queue...");
            });
          });
      }
    }
  };

  // Sample Audio state
  const [sampleIsPlaying, setSampleIsPlaying] = useState(false);
  const [sampleAudio, setSampleAudio] = useState<HTMLAudioElement | null>(null);

  // --- Session-recovery for stale Cleanvoice jobs ----------------------------
  // A previous session that crashed / was closed mid-processing can leave a
  // file persisted (IndexedDB) with cleanvoiceResult.status === "processing"
  // (or uploading/queued/pending). On static hosting (Netlify / GitHub Pages)
  // the WebSocket status channel is bypassed, so without this there is NO path
  // that ever re-checks such a job — it stays "processing" forever, which keeps
  // `isProcessingStatus` (and thus `isProcessing`) true and locks the Start
  // button in a disabled "Processing..." state. Once files have been restored
  // from IDB we resume-poll each stale job's editId so finished jobs are
  // recovered and genuinely-stuck ones eventually error out.
  const recoveryTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryStartedRef = React.useRef(false);

  const isNonTerminalStatus = (s: string | undefined): boolean =>
    s === "processing" || s === "uploading" || s === "pending";

  useEffect(() => {
    if (recoveryStartedRef.current) return;
    const staleJobs = filesRef.current.filter(
      (f) => !!f.cleanvoiceResult?.editId && isNonTerminalStatus(f.cleanvoiceResult?.status),
    );
    if (staleJobs.length === 0) return;
    recoveryStartedRef.current = true;

    // Only ever resume-poll the jobs that were stale at mount — never freshly
    // started ones (those are owned by the active batch poller).
    const staleJobIds = new Set(staleJobs.map((f) => f.id));

    const apiKey = localStorage.getItem("cleanvoice_api_key");
    if (!apiKey) {
      // Can't verify without a key — mark stale jobs as error so the UI
      // unblocks; the user can re-run after providing a valid key.
      setFiles((prev) =>
        prev.map((f) =>
          !!f.cleanvoiceResult?.editId && isNonTerminalStatus(f.cleanvoiceResult?.status)
            ? {
                ...f,
                cleanvoiceResult: {
                  ...f.cleanvoiceResult,
                  status: "error",
                  error: "Session was interrupted and no API key is available. Please retry.",
                  logs: [
                    ...(f.cleanvoiceResult.logs || []),
                    `[${new Date().toLocaleTimeString()}] ❌ [Session Recovery] Interrupted — API key unavailable.`,
                  ],
                },
              }
            : f,
        ),
      );
      return;
    }

    const RESUME_MAX_MS = 10 * 60 * 1000; // hard cap so a stuck job can't lock the UI forever
    // Poll recovered jobs every 10s. These are stale jobs left over from a
    // previous session, not active work the user is watching, so a longer
    // cadence is fine and halves the post-load GET /v2/edits/{id} requests
    // versus the previous 5s interval.
    const RESUME_INTERVAL_MS = 10000;
    const resumeStart = Date.now();
    let isTicking = false;

    const recoveryTick = async () => {
      if (isTicking) return;
      isTicking = true;
      try {
        const remaining = filesRef.current.filter(
          (f) =>
            staleJobIds.has(f.id) &&
            !!f.cleanvoiceResult?.editId &&
            isNonTerminalStatus(f.cleanvoiceResult?.status),
        );
        if (remaining.length === 0) {
          if (recoveryTimerRef.current) {
            clearInterval(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
          }
          return;
        }
        if (Date.now() - resumeStart > RESUME_MAX_MS) {
          setFiles((prev) =>
            prev.map((f) =>
              !!f.cleanvoiceResult?.editId && isNonTerminalStatus(f.cleanvoiceResult?.status)
                ? {
                    ...f,
                    cleanvoiceResult: {
                      ...f.cleanvoiceResult,
                      status: "error",
                      error: "Job did not finish within the recovery window. Please retry.",
                      logs: [
                        ...(f.cleanvoiceResult.logs || []),
                        `[${new Date().toLocaleTimeString()}] ❌ [Session Recovery] Timed out.`,
                      ],
                    },
                  }
                : f,
            ),
          );
          if (recoveryTimerRef.current) {
            clearInterval(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
          }
          return;
        }

        for (const job of remaining) {
          try {
            const check = await getCleanvoiceEditStatus(job.cleanvoiceResult!.editId!, apiKey);
            if (check.remainingCredits !== undefined && onCreditsUpdated) {
              onCreditsUpdated(check.remainingCredits);
            }
            if (check.status === "success" && check.download_url) {
              runSilentBackgroundTranscode(job, check.download_url).catch(() => {});
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === job.id && f.cleanvoiceResult
                    ? {
                        ...f,
                        cleanvoiceResult: {
                          ...f.cleanvoiceResult,
                          status: "success",
                          cleanedUrl: check.download_url,
                          edits: check.edits,
                          duration: check.duration,
                          transcription: check.transcription,
                          summary: check.summary,
                          social_content: check.social_content,
                          elapsedSeconds:
                            check.serverElapsedSeconds !== undefined
                              ? check.serverElapsedSeconds
                              : f.cleanvoiceResult.elapsedSeconds,
                          serverElapsedSeconds: check.serverElapsedSeconds !== undefined ? check.serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                          serverElapsedAt: check.serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                          logs: [
                            ...(f.cleanvoiceResult.logs || []),
                            `[${new Date().toLocaleTimeString()}] ✨ [Session Recovery] Audio cleaned successfully!`,
                          ],
                        },
                      }
                    : f,
                ),
              );
              setLastResultUrl(check.download_url);
            } else if (check.status === "error") {
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === job.id && f.cleanvoiceResult
                    ? {
                        ...f,
                        cleanvoiceResult: {
                          ...f.cleanvoiceResult,
                          status: "error",
                          error: check.error || "Unknown API error",
                          serverElapsedSeconds: check.serverElapsedSeconds !== undefined ? check.serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                          serverElapsedAt: check.serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                          logs: [
                            ...(f.cleanvoiceResult.logs || []),
                            `[${new Date().toLocaleTimeString()}] ❌ [Session Recovery] Error: ${check.error || "Unknown API error"}`,
                          ],
                        },
                      }
                    : f,
                ),
              );
            }
            // else: still processing — leave as-is; re-checked next tick.
          } catch {
            // Transient status fetch error — leave as-is; re-checked next tick.
          }
        }
      } finally {
        isTicking = false;
      }
    };

    // Immediate check, then poll on an interval.
    recoveryTick();
    recoveryTimerRef.current = setInterval(recoveryTick, RESUME_INTERVAL_MS);
  }, [files]);

  // Clear the recovery poller on unmount only.
  useEffect(() => {
    return () => {
      if (recoveryTimerRef.current) {
        clearInterval(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, []);

  // Adjust preset selections
  const handlePresetChange = (preset: string) => {
    setSelectedPreset(preset);
    if (preset === "Custom Preset") {
      // Revert to the Custom Preset standard defaults:
      // ENABLED -> Remove Noise, Normalize, Studio Sound (javelin)
      // DISABLED -> Keep Music, Remove Breath, AutoEQ (and all other edit features off)
      setCvConfig((prev) => ({
        ...prev,
        fillers: false,
        stutters: false,
        silences: false,
        hesitations: false,
        mouth_sounds: false,
        mute: false,
        noise: "v2",
        reverb: false,
        normalize: true,
        eq: false,
        keep_music: false,
        remove_breath: "disabled",
        studio_sound: "javelin",
      }));
    } else if (preset === "Podcast Optimized") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: true,
        stutters: true,
        silences: true,
        hesitations: false,
        mouth_sounds: true,
        mute: false,
        noise: "v2",
        normalize: true,
        eq: false,
        keep_music: false,
        remove_breath: "mute",
        studio_sound: "javelin",
      }));
    } else if (preset === "Audiobook Ready") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: true,
        stutters: true,
        silences: true,
        hesitations: true,
        mouth_sounds: true,
        mute: false,
        noise: "v2",
        normalize: true,
        eq: false,
        keep_music: false,
        remove_breath: "natural",
        studio_sound: "javelin",
      }));
    } else if (preset === "Webinar Clean") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: true,
        stutters: false,
        silences: true,
        hesitations: false,
        mouth_sounds: false,
        mute: true,
        noise: "v2",
        normalize: true,
        eq: false,
        keep_music: false,
        remove_breath: "mute",
        studio_sound: "javelin",
      }));
    } else if (preset === "Remove Fillers & Stutters Only") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: true,
        stutters: true,
        silences: false,
        hesitations: false,
        mouth_sounds: false,
        mute: false,
        noise: false,
        normalize: false,
        eq: false,
        keep_music: false,
        remove_breath: "disabled",
        studio_sound: "javelin",
      }));
    } else if (preset === "Mastering Only") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: false,
        stutters: false,
        silences: false,
        hesitations: false,
        mouth_sounds: false,
        mute: false,
        noise: "v2",
        reverb: true,
        normalize: true,
        eq: true,
        keep_music: true,
        remove_breath: "disabled",
        studio_sound: "javelin",
      }));
    } else if (preset === "Clean Slate") {
      setCvConfig((prev) => ({
        ...prev,
        fillers: false,
        stutters: false,
        silences: false,
        hesitations: false,
        mouth_sounds: false,
        mute: false,
        noise: false,
        reverb: false,
        normalize: false,
        eq: false,
        keep_music: false,
        remove_breath: "disabled",
        studio_sound: "javelin",
      }));
    }
  };

  const handleToggleOption = (key: keyof Required<CleanvoiceConfig>) => {
    setSelectedPreset("Custom Preset");
    if (key === "remove_breath") {
      setActiveModal("breath");
      return;
    }
    if (key === "noise") {
      setActiveModal("noise");
      return;
    }
    if (key === "studio_sound") {
      setActiveModal("studio_sound");
      return;
    }
    if (key === "normalize") {
      setActiveModal("mastering");
      return;
    }
    setCvConfig((prev) => ({
      ...prev,
      [key]: !prev[key] as any,
    }));
  };

  useEffect(() => {
    return () => {
      if (sampleAudio) {
        sampleAudio.pause();
      }
    };
  }, [sampleAudio]);

  // Run action
  const handleRunCleanvoice = async (specificFiles?: FileItem[]) => {
    const isSpecific = Array.isArray(specificFiles) && specificFiles.length > 0;
    const filesToRun = isSpecific ? specificFiles : targetFiles;
    const isBatchRun = filesToRun.length > 1;

    if (isProcessing && !isSpecific) return;

    if (filesToRun.length === 0) {
      setLocalLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ❌ Error: Please select an audio file to process!`,
      ]);
      return;
    }

    if (!isSpecific) {
      setLocalIsProcessing(true);
      setLocalBatchIndex(0);
      setLocalLogs([]);
      setLastResultUrl(null);
    }

    // Immediately select the first file to run so that its progress panel is shown active
    if (filesToRun[0]) {
      setActiveFileId(filesToRun[0].id);
    }

    const log = (msg: string, currentTargetId: string) => {
      const logLine = `[${new Date().toLocaleTimeString()}] ${msg}`;
      console.log(logLine);
      setLocalLogs((prev) => [...prev, logLine]);
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id === currentTargetId) {
            return {
              ...f,
              cleanvoiceResult: f.cleanvoiceResult
                ? {
                    ...f.cleanvoiceResult,
                    logs: [...(f.cleanvoiceResult.logs || []), logLine],
                  }
                : {
                    status: "pending",
                    logs: [logLine],
                  },
            };
          }
          return f;
        }),
      );
    };

    // Create a single shared worker instance for all jobs in the batch
    const isBatterySaverActive = typeof window !== "undefined" && (window as any).isBatterySaverActive;
    // The worker tick only drives the elapsed-seconds UI (displayed in whole
    // seconds) and the cancel/timeout checks — the actual API poll cadence is
    // gated separately by `nextPollTargetMs` below. A 250ms tick re-rendered
    // the file list 4x/second even though the displayed value changes at most
    // once per second, so 3 of every 4 ticks were redundant work. 1000ms
    // matches the display resolution exactly; cancel feedback is still within
    // 1s, which is imperceptible for a multi-minute audio job.
    const pollInterval = isBatterySaverActive ? 3000 : 1000;

    const workerCode = `
      let intervalId = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (!intervalId) intervalId = setInterval(() => self.postMessage('tick'), ${pollInterval});
        } else if (e.data === 'stop') {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      };
    `;
    const workerBlob = new Blob([workerCode], {
      type: "application/javascript",
    });
    const workerUrl = URL.createObjectURL(workerBlob);
    const sharedPollWorker = new Worker(workerUrl);

    // Start the shared ticker for the whole batch
    sharedPollWorker.postMessage("start");

    cancelProcessingRef.current.delete("ALL");
    const startPromises = filesToRun.map((currentTarget, index) => {
      cancelProcessingRef.current.delete(currentTarget.id);
      return (async (currentTarget, index) => {
        const isBatch = filesToRun.length > 1;
        const batchPrefix = isBatch
          ? `[Batch ${index + 1}/${filesToRun.length}] `
          : "";

        if (cancelProcessingRef.current.has("ALL")) {
          return; // Global Cancel
        }

        const runSimulator = async () => {
          // Run immersive developer simulator in parallel
          log(
            `${batchPrefix}⚠️ Operating in Tutorial Educational Sandbox...`,
            currentTarget.id,
          );
          log(
            `${batchPrefix}Selected audio file: ${currentTarget.name}`,
            currentTarget.id,
          );
          log(
            `${batchPrefix}This simulation executes the real endpoint protocol step-by-step.`,
            currentTarget.id,
          );

          // Initialize state for tracking time and status in the simulator
          setFiles((prev) =>
            prev.map((f) =>
              f.id === currentTarget.id
                ? {
                    ...f,
                    cleanvoiceResult: {
                      status: "pending",
                      logs: [
                        ...(f.cleanvoiceResult?.logs || []),
                        `[${new Date().toLocaleTimeString()}] ${batchPrefix}Initializing simulated process...`,
                      ],
                      configUsed: { ...cvConfig },
                      startedAt: Date.now(),
                      elapsedSeconds: 0,
                    } as any,
                  }
                : f,
            ),
          );

          const setSimStatus = (
            status: "uploading" | "processing" | "success",
            rawStatus?: string,
            uploadProgress?: number,
          ) => {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === currentTarget.id
                  ? {
                      ...f,
                      cleanvoiceResult: {
                        ...(f.cleanvoiceResult || {}),
                        status,
                        rawStatus,
                        uploadProgress,
                        logs: f.cleanvoiceResult?.logs || [],
                        elapsedSeconds: f.cleanvoiceResult?.startedAt
                          ? Math.floor(
                              (Date.now() - f.cleanvoiceResult.startedAt) / 1000,
                            )
                          : 0,
                      } as any,
                    }
                  : f,
              ),
            );
          };

          await new Promise((r) => setTimeout(r, 600));
          setSimStatus("uploading", undefined, 30);
          log(
            `${batchPrefix}📡 POSTing to https://api.cleanvoice.ai/v2/upload registered file metadata... [30% complete]`,
            currentTarget.id,
          );
          log(
            `${batchPrefix}Received upload credentials: { signed_url: 'https://gcs-signed.cleanvoice.ai/...', url: 'https://gcs-public-readable-url...' }`,
            currentTarget.id,
          );

          await new Promise((r) => setTimeout(r, 800));
          setSimStatus("uploading", undefined, 60);
          const sizeStr = `${Math.round(currentTarget.file.size / 1024)} KB`;
          log(
            `${batchPrefix}📤 Encrypting and uploading binary data (${sizeStr}) to secure GCS bucket... [60% complete]`,
            currentTarget.id,
          );

          await new Promise((r) => setTimeout(r, 800));
          setSimStatus("uploading", undefined, 100);
          log(`${batchPrefix}Upload complete (HTTP 200 OK). [100% complete]`, currentTarget.id);

          const editRegionStartSec = currentTarget.cleanvoiceResult
            ?.editRegionStartMs
            ? currentTarget.cleanvoiceResult.editRegionStartMs / 1000
            : undefined;
          const editRegionEndSec = currentTarget.cleanvoiceResult?.editRegionEndMs
            ? currentTarget.cleanvoiceResult.editRegionEndMs / 1000
            : undefined;

          await new Promise((r) => setTimeout(r, 200));
          setSimStatus("processing", "STARTED");
          log(
            `${batchPrefix}⚙️ Requesting job edit compilation: POST to v2/edits with standard configs...`,
            currentTarget.id,
          );
          const rangeText =
            editRegionStartSec !== undefined && editRegionEndSec !== undefined
              ? `, start_time=${editRegionStartSec.toFixed(1)}s, end_time=${editRegionEndSec.toFixed(1)}s (Restricted Window)`
              : "";
          const qualityParam = selectedQuality === "source" 
            ? `${currentTarget.sourceBitrate || "192"}kbps (Source Match)` 
            : `${selectedQuality}kbps`;
          log(
            `${batchPrefix}Config submitted: fillers=${cvConfig.fillers}, stutters=${cvConfig.stutters}, silences=${cvConfig.silences}, hesitations=${cvConfig.hesitations}, mouth_sounds=${cvConfig.mouth_sounds}, normalization=${cvConfig.normalize}, format=${cvConfig.format}, target_bitrate=${qualityParam}${rangeText}.`,
            currentTarget.id,
          );
          log(
            `${batchPrefix}Job initialized. Edit ID: cv_job_9f27xa0e_${index}`,
            currentTarget.id,
          );

          await new Promise((r) => setTimeout(r, 200));
          setSimStatus("processing", "PREPROCESSING");
          log(
            `${batchPrefix}🔍 Polling job status cv_job_9f27xa0e_${index}...`,
            currentTarget.id,
          );

          await new Promise((r) => setTimeout(r, 200));
          setSimStatus("processing", "EDITING");

          await new Promise((r) => setTimeout(r, 200));
          setSimStatus("processing", "EXPORT");

          await new Promise((r) => setTimeout(r, 200));
          setSimStatus("success");
          log(
            `${batchPrefix}Status = 'success' [Audio successfully processed!]`,
            currentTarget.id,
          );

          const resultUrl = generateMockWavUrl(); // Official high-quality cleaned sample
          let resultUrlLocal = resultUrl; // Serve directly to avoid CORS blob decode issues on some networks

          log(
            `${batchPrefix}🔗 Success! Final polished audio URL compiled:`,
            currentTarget.id,
          );
          log(`${batchPrefix}👉 ${resultUrlLocal}`, currentTarget.id);

          setLastResultUrl(resultUrlLocal);

          setFiles((prev) =>
            prev.map((f) =>
              f.id === currentTarget.id
                ? {
                    ...f,
                    cleanvoiceResult: {
                      status: "success",
                      cleanedUrl: resultUrlLocal,
                      logs: f.cleanvoiceResult?.logs || [
                        `${batchPrefix}Cleaned via simulated Cleanvoice Studio`,
                      ],
                      configUsed: { ...cvConfig },
                      startedAt: f.cleanvoiceResult?.startedAt,
                      elapsedSeconds: f.cleanvoiceResult?.startedAt
                        ? Math.floor(
                            (Date.now() - f.cleanvoiceResult.startedAt) / 1000,
                          )
                        : 8,
                    },
                  }
                : f,
            ),
          );

          if (!isSpecific) {
            setLocalBatchIndex((prev) =>
              Math.min(prev + 1, filesToRun.length - 1),
            );
          }
        };

        if (!apiKey) {
          if (currentTarget.cleanvoiceResult?.status === "error") {
            log(`${batchPrefix}❌ Cannot retry: No API Key provided.`, currentTarget.id);
            return;
          }
          if (localStorage.getItem("cleanvoice_api_key_disconnected") === "true") {
            log(`${batchPrefix}❌ Cannot run: API Key was disconnected due to invalid credentials or insufficient credits. Please update your API Key.`, currentTarget.id);
            setFiles((prev) =>
              prev.map((f) =>
                f.id === currentTarget.id
                  ? {
                      ...f,
                      cleanvoiceResult: {
                        ...(f.cleanvoiceResult || {}),
                        status: "error",
                        error: "API Key exhausted or invalid. Please update your API Key.",
                      } as any,
                    }
                  : f
              )
            );
            window.dispatchEvent(new Event("open-cleanvoice-settings"));
            return;
          }
          await runSimulator();
          return;
        }

        // Real API implementation
        log(
          `${batchPrefix}🚀 Starting live Cleanvoice session on ${currentTarget.name}`,
          currentTarget.id,
        );

        const taskStartedAt = Date.now();

        try {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === currentTarget.id
                ? {
                    ...f,
                    cleanvoiceResult: {
                      status: "pending",
                      startedAt: taskStartedAt,
                      logs: [
                        `[${new Date().toLocaleTimeString()}] ${batchPrefix}Initializing live Cleanvoice process...`,
                      ],
                      configUsed: { ...cvConfig },
                      elapsedSeconds: 0,
                    },
                  }
                : f,
            ),
          );

          const editRegionStartSec = currentTarget.cleanvoiceResult
            ?.editRegionStartMs
            ? currentTarget.cleanvoiceResult.editRegionStartMs / 1000
            : undefined;
          const editRegionEndSec = currentTarget.cleanvoiceResult?.editRegionEndMs
            ? currentTarget.cleanvoiceResult.editRegionEndMs / 1000
            : undefined;

          if (
            editRegionStartSec !== undefined &&
            editRegionEndSec !== undefined
          ) {
            log(
              `${batchPrefix}🎯 Window constraints configured: ${editRegionStartSec.toFixed(1)}s to ${editRegionEndSec.toFixed(1)}s (Restricted Analysis Window)`,
              currentTarget.id,
            );
          }

          const controller = new AbortController();
          abortControllersRef.current[currentTarget.id] = controller;

          // 1. Upload & Create Edit
          const doStart = async () => startCleanvoiceEdit(
            currentTarget.file,
            {
              ...cvConfig,
              start_time: editRegionStartSec,
              end_time: editRegionEndSec,
              targetBitrate: selectedQualityRef.current || "source"
            },
            apiKey,
            (message) => {
              let p = 0;
              let uploadProgress: number | undefined = undefined;
              // Map the upload-phase log stream to a MONOTONIC progress value.
              // Real byte-level progress arrives as "[Upload] N% complete" from
              // the XHR upload.onprogress in streamMediaChunksParallel; the Step
              // labels are just phase markers. The bar moves 5 → 10 → (10..95
              // during the actual PUT) → 100, instead of freezing at 60.
              if (message.includes("Step 1/3")) {
                p = 2;
                uploadProgress = 5;
              } else if (message.includes("Step 2/3")) {
                p = 4;
                uploadProgress = 10;
              } else if (message.includes("[Upload]")) {
                const match = message.match(/(\d+)% complete/);
                if (match) {
                  const uploadPct = parseInt(match[1], 10);
                  p = 4 + uploadPct * 0.05; // overall stage counter (up to ~9)
                  // Scale the real byte percentage (0-100) across the upload
                  // range so the bar advances smoothly to ~95% before edits.
                  uploadProgress = 10 + Math.round(uploadPct * 0.85);
                }
              } else if (message.includes("Step 3/3")) {
                p = 10;
                uploadProgress = 100;
              }

              const logLine = `[${new Date().toLocaleTimeString()}] ${batchPrefix}${message}`;
              setLocalLogs((prev) => [...prev, logLine]);

              setFiles((prev) =>
                prev.map((f) => {
                  if (f.id === currentTarget.id) {
                    const currentResult = f.cleanvoiceResult || {
                      status: "pending",
                      logs: [],
                      configUsed: { ...cvConfig },
                      elapsedSeconds: 0,
                    };
                    return {
                      ...f,
                      cleanvoiceResult: {
                        ...currentResult,
                        status: "uploading",
                        logs: [...(currentResult.logs || []), logLine],
                        progress: p > 0 ? p : currentResult.progress,
                        uploadProgress: uploadProgress !== undefined ? uploadProgress : currentResult.uploadProgress,
                        elapsedSeconds: taskStartedAt
                          ? Math.floor((Date.now() - taskStartedAt) / 1000)
                          : undefined,
                      },
                    };
                  }
                  return f;
                }),
              );
            },
            controller.signal
          );

          let startResult;
          try {
            startResult = await doStart();
          } catch (initialErr: any) {
            const errStr = initialErr.message || String(initialErr);
            if ((errStr.includes("File(s) don't exists") || errStr.includes("404")) && ((currentTarget.file as any).remoteUrl || (currentTarget.file as any).uploadPromise)) {
              log(`${batchPrefix}⚠️ File record expired or changed tenants. Resetting upload stream cache and retrying...`, currentTarget.id);
              delete (currentTarget.file as any).remoteUrl;
              delete (currentTarget.file as any).uploadPromise;
              startResult = await doStart();
            } else {
              throw initialErr;
            }
          }
          
          const { editId, publicUrl } = startResult;

          // Dispatch event to automatically sync remaining credits instantly
          window.dispatchEvent(new Event("cleanvoice-refresh-credits"));

          // Dispatch event to subscribe this job to the real-time WebSocket channel
          window.dispatchEvent(
            new CustomEvent("ws-subscribe-job", { detail: { editId } })
          );

          const successMsg = `[${new Date().toLocaleTimeString()}] ${batchPrefix}Job created successfully with ID ${editId}. Waiting for cloud cluster to process...`;
          setLocalLogs(prev => [...prev, successMsg]);

          setFiles((prev) =>
            prev.map((f) => {
              if (f.id === currentTarget.id) {
                const currentResult = f.cleanvoiceResult || {
                  status: "pending",
                  logs: [],
                  configUsed: { ...cvConfig },
                  elapsedSeconds: 0,
                };
                return {
                  ...f,
                  cleanvoiceResult: {
                    ...currentResult,
                    status: "processing",
                    editId,
                    publicUrl,
                    logs: [
                      ...(currentResult.logs || []),
                      successMsg,
                    ],
                    elapsedSeconds: 0,
                  },
                };
              }
              return f;
            }),
          );

          return {
            currentTarget,
            editId,
            publicUrl,
            editRegionStartSec,
            editRegionEndSec,
            startedLocalAt: taskStartedAt,
          };
        } catch (startErr: any) {
          const errStr = String(startErr?.message || startErr);

          if (startErr?.name === 'AbortError' || errStr.includes('AbortError') || errStr.includes('cancelled')) {
            log(`${batchPrefix}🛑 Processing cancelled by user.`, currentTarget.id);
            setFiles((prev) =>
              prev.map((f) =>
                f.id === currentTarget.id && f.cleanvoiceResult
                  ? {
                      ...f,
                      cleanvoiceResult: {
                        ...f.cleanvoiceResult,
                        status: "none",
                        logs: [...(f.cleanvoiceResult.logs || []), "Processing cancelled by user."],
                      },
                    }
                  : f,
              ),
            );
            return { currentTarget, error: startErr, startedLocalAt: taskStartedAt };
          }

          log(
            `${batchPrefix}❌ Failed to start Cleanvoice job: ${startErr.message || startErr}`,
            currentTarget.id,
          );
          // Removed fallback to simulator on error to keep the proper error state and allow retrying
          
          const isAuthError = errStr.includes("401") || errStr.toLowerCase().includes("invalid api key") || errStr.includes("E1001");
          const isCreditError = errStr.includes("402") || errStr.toLowerCase().includes("credit") || errStr.toLowerCase().includes("balance") || errStr.toLowerCase().includes("insufficient") || errStr.includes("E3003");
          
          if (isAuthError || isCreditError) {
            triggerCleanvoiceAuthOrCreditError();
          }

          if (errStr.includes("File(s) don't exists") || errStr.includes("404")) {
             if ((currentTarget.file as any).remoteUrl) {
                 log(`${batchPrefix}⚠️ File record expired or changed tenants. Resetting upload stream cache for next retry...`, currentTarget.id);
                 delete (currentTarget.file as any).remoteUrl;
                 delete (currentTarget.file as any).uploadPromise;
             }
          }

          setFiles((prev) =>
            prev.map((f) => {
              if (f.id === currentTarget.id) {
                const currentResult = f.cleanvoiceResult || {
                  status: "pending",
                  logs: [],
                  configUsed: { ...cvConfig },
                  elapsedSeconds: 0,
                };
                return {
                  ...f,
                  cleanvoiceResult: {
                    ...currentResult,
                    status: "error",
                    error: startErr.message || "API rejected process",
                    logs: [...(currentResult.logs || []), `[Error] ${startErr.message || "API rejected process"}`],
                    elapsedSeconds: taskStartedAt
                      ? Math.floor((Date.now() - taskStartedAt) / 1000)
                      : undefined,
                  },
                };
              }
              return f;
            }),
          );
          return { currentTarget, error: startErr, startedLocalAt: taskStartedAt };
        }
      })(currentTarget, index);
    });

    const submittedJobs = await Promise.all(startPromises);

    // We only proceed to batch polling if it's the real API (no Simulator items will have been added if simulator ran, unless we mixed them but we don't)
    const validJobs = submittedJobs.filter((j) => j && j.editId);

    if (validJobs.length > 0) {
      // Batch polling phase with dynamic, smart initial intervals based on file size to speed up smaller clips
      let pending = [...validJobs];

      let maxFileSize = 0;
      validJobs.forEach((job) => {
        if (job.currentTarget?.file && job.currentTarget.file.size) {
          maxFileSize = Math.max(maxFileSize, job.currentTarget.file.size);
        }
      });

      // Instant initial check on job submission (100ms) to capture fast cluster jobs immediately
      const initialWaitMs = 100;
      // Log centralized batch waiting dynamically based on file size
      const waitMsg = `[${new Date().toISOString()}] 🚀 ${isBatchRun ? "[Batch] All jobs submitted" : "Job submitted"} successfully. Initiating instant status tracking...`;
      console.log(waitMsg);
      if (isBatchRun) {
        setLocalLogs((prev) => [...prev, waitMsg]);
      }

      let isStopped = false;
      let isBatchPolling = false;

      // Start polling loop inside a self-invoking async function to not block the UI thread completely,
      // but we await it so the final wrap-up code waits.
      await new Promise<void>((resolveBatch) => {
        const pollLoopStartTime = Date.now();
        let currentPollIntervalMs = initialWaitMs;
        let nextPollTargetMs = pollLoopStartTime + currentPollIntervalMs;

        let rateLimitPenaltyUntil = 0;

        const messageHandler = async () => {
          if (isStopped) return;

          // Smoothly tick the elapsed seconds on the UI across all currently pending/processing active files in our batch
          setFiles((prev) =>
            prev.map((f) => {
              const isActiveJob = pending.some((job) => job.currentTarget.id === f.id);
              if (isActiveJob && f.cleanvoiceResult && (f.cleanvoiceResult.status === "processing" || f.cleanvoiceResult.status === "uploading" || f.cleanvoiceResult.status === "pending")) {
                const res = f.cleanvoiceResult;
                if (res.status === "uploading") {
                  return f; // Keep uploading status unchanged, do not let ticker interfere!
                }
                if (!res.editId) {
                  return {
                    ...f,
                    cleanvoiceResult: {
                      ...res,
                      elapsedSeconds: 0,
                    },
                  };
                }

                const start = res.startedAt;
                if (start) {
                  return {
                    ...f,
                    cleanvoiceResult: {
                      ...res,
                      status: "processing",
                      elapsedSeconds: Math.floor((Date.now() - start) / 1000),
                    },
                  };
                }
              }
              return f;
            })
          );

          if (cancelProcessingRef.current.has("ALL")) {
            isStopped = true;
            const msg = `[${new Date().toISOString()}] ⛔ ${isBatchRun ? "[Batch] Job" : "Job"} cancelled by user. Terminating...`;
            console.log(msg);
            if (isBatchRun) {
              setLocalLogs((prev) => [...prev, msg]);
            }
            // Delete all pending edits in parallel background without blocking
            pending.forEach((job) => {
              if (job.editId && apiKey) {
                deleteCleanvoiceEdit(job.editId, apiKey).catch(() => {});
              }
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === job.currentTarget.id && f.cleanvoiceResult
                    ? {
                        ...f,
                        cleanvoiceResult: {
                          ...f.cleanvoiceResult,
                          status: "error",
                          error: `Aborted by user.`,
                          elapsedSeconds: job.startedLocalAt
                            ? Math.floor((Date.now() - job.startedLocalAt) / 1000)
                            : undefined,
                        },
                      }
                    : f,
                ),
              );
            });
            sharedPollWorker.removeEventListener("message", messageHandler);
            resolveBatch();
            return;
          }

          // Time keeping
          const now = Date.now();
          const elapsedSecondsTotal = (now - pollLoopStartTime) / 1000;

          // Max 1 hour
          if (elapsedSecondsTotal > 3600) {
            isStopped = true;
            sharedPollWorker.removeEventListener("message", messageHandler);
            if (isBatchRun) {
              setLocalLogs((prev) => [
                ...prev,
                `[${new Date().toLocaleTimeString()}] ❌ ${isBatchRun ? "[Batch] Timeout" : "Timeout"} limit reached. Terminating remaining jobs.`,
              ]);
            }
            // Mark every still-pending job as errored so `isProcessingStatus`
            // (derived from file status) clears — otherwise the UI stays locked
            // in "Processing..." even after the batch promise resolves.
            for (const job of pending) {
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === job.currentTarget.id && f.cleanvoiceResult
                    ? {
                        ...f,
                        cleanvoiceResult: {
                          ...f.cleanvoiceResult,
                          status: "error",
                          error: "Timed out (1h limit reached). Please retry.",
                          elapsedSeconds: job.startedLocalAt
                            ? Math.floor((Date.now() - job.startedLocalAt) / 1000)
                            : undefined,
                        },
                      }
                    : f,
                ),
              );
            }
            resolveBatch();
            return;
          }

          if (now < nextPollTargetMs) return; // not time to poll yet

          if (isBatchPolling) return;
          isBatchPolling = true;

          // High-performance delay optimization to capture finishing jobs immediately
          if (Date.now() < rateLimitPenaltyUntil) {
             currentPollIntervalMs = 5000; // Back off briefly if the proxy returned a 429
          } else {
            // The /api/cleanvoice proxy now serves every edit-status GET from the
            // server-side background poller's cache and never forwards to upstream,
            // so these polls are free (no per-key rate-limit pressure). Polling at
            // 1000ms keeps the UI in lockstep with the poller's 1s refresh cadence
            // and the WebSocket broadcasts, so a finished job is surfaced within
            // ~1s. Direct (no-proxy) hosts still hit api.cleanvoice.ai directly and
            // must keep 8000ms to avoid per-IP rate limits.
            const isProxy = getBaseUrl() === "/api/cleanvoice";
            currentPollIntervalMs = isProxy ? 500 : 4000;
          }
          nextPollTargetMs = now + currentPollIntervalMs; // Plan next poll

          try {
            const stillPending = [];
            for (const job of pending) {
              // Check individual cancel
              if (cancelProcessingRef.current.has(job.currentTarget.id)) {
                setFiles((prev) =>
                  prev.map((f) =>
                    f.id === job.currentTarget.id && f.cleanvoiceResult
                      ? {
                          ...f,
                          cleanvoiceResult: {
                            ...f.cleanvoiceResult,
                            status: "error",
                            error: `Aborted by user.`,
                            elapsedSeconds: job.startedLocalAt
                              ? Math.floor((Date.now() - job.startedLocalAt) / 1000)
                              : undefined,
                          },
                        }
                      : f,
                  ),
                );
                continue;
              }

              // Check if already completed/success/error via real-time WebSocket channel
              const wsCheckMatch = filesRef.current.find((f) => f.id === job.currentTarget.id);
              if (wsCheckMatch?.cleanvoiceResult?.status === "success" || wsCheckMatch?.cleanvoiceResult?.status === "error") {
                console.log(`[Poller] Job ${job.currentTarget.id} / editId: ${job.editId} already completed via WebSocket, skipping API call.`);
                continue;
              }

              // Hit API sequentially within the single batch poll (avoids rate limits)
              let check;
              try {
                check = await getCleanvoiceEditStatus(job.editId!, apiKey);
                if (check.remainingCredits !== undefined && onCreditsUpdated) {
                  onCreditsUpdated(check.remainingCredits);
                }
                // Reset poll failure count on successful poll
                const jobAny = job as any;
                jobAny.pollFailCount = 0;
              } catch (err: any) {
                const errMsg = err?.message || String(err);
                const isAuthError =
                  errMsg.includes("401") ||
                  errMsg.toLowerCase().includes("invalid api key") ||
                  errMsg.includes("E1001");
                const isCreditError =
                  errMsg.includes("402") ||
                  errMsg.toLowerCase().includes("credit") ||
                  errMsg.toLowerCase().includes("balance") ||
                  errMsg.toLowerCase().includes("insufficient") ||
                  errMsg.includes("E3003") ||
                  errMsg.includes("Credit") ||
                  errMsg.includes("enough credit");

                const friendlyMsg = isAuthError
                  ? "Invalid Cleanvoice API Key. Please verify your credentials inside the app settings."
                  : isCreditError
                    ? `Insufficient Cleanvoice Credits: ${errMsg}`
                    : `Status retrieval failed: ${errMsg}`;

                const jobAny = job as any;
                if (jobAny.pollFailCount === undefined) {
                  jobAny.pollFailCount = 0;
                }
                jobAny.pollFailCount += 1;

                if (
                  isAuthError ||
                  isCreditError ||
                  jobAny.pollFailCount >= 30
                ) {
                  if (isAuthError || isCreditError) {
                    triggerCleanvoiceAuthOrCreditError();
                  }
                  
                  if (isBatchRun) {
                    setLocalLogs((prev) => [
                      ...prev,
                      `[${new Date().toLocaleTimeString()}] ❌ ${friendlyMsg}`,
                    ]);
                  }
                  setFiles((prev) =>
                    prev.map((f) =>
                      f.id === job.currentTarget.id && f.cleanvoiceResult
                        ? {
                            ...f,
                            cleanvoiceResult: {
                              ...f.cleanvoiceResult,
                              status: "error",
                              error: friendlyMsg,
                              logs: [
                                ...(f.cleanvoiceResult.logs || []),
                                `[${new Date().toLocaleTimeString()}] ❌ ${friendlyMsg}`,
                              ],
                              elapsedSeconds: job.startedLocalAt
                                ? Math.floor((Date.now() - job.startedLocalAt) / 1000)
                                : undefined,
                            },
                          }
                        : f,
                    ),
                  );
                  if (!isSpecific) {
                    setLocalBatchIndex((prev) =>
                      Math.min(prev + 1, filesToRun.length - 1),
                    );
                  }
                } else {
                  // Keep polling despite transient fetch error
                  const warningMsg = `⚠️ Status retrieval issue (attempt ${jobAny.pollFailCount}/30): ${errMsg}. Retrying...`;
                  if (isBatchRun) {
                    setLocalLogs((prev) => [
                      ...prev,
                      `[${new Date().toLocaleTimeString()}] ${warningMsg}`,
                    ]);
                  }
                  stillPending.push(job);
                }
                continue;
              }

              if (check.isRateLimited) {
                // The proxy almost never 429s anymore (it serves from the poller
                // cache), but if it does, a short 5s backoff recovers fast instead
                // of stalling a finished job for 20s.
                rateLimitPenaltyUntil = Date.now() + 5000;
                currentPollIntervalMs = 5000;
                nextPollTargetMs = Date.now() + 5000;
                const warningMsg = `⏱️ Rate limit hit. Slowing down polling to ${currentPollIntervalMs/1000}s...`;
                console.warn(warningMsg);
                if (isBatchRun && (job as any).pollFailCount % 3 === 0) {
                  setLocalLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${warningMsg}`]);
                }
              }

              if (check.status === "success") {
                if (check.download_url) {
                  const isBatch = filesToRun.length > 1;
                  const pre = isBatch
                    ? `[Batch ${filesToRun.findIndex((t) => t.id === job.currentTarget.id) + 1}/${filesToRun.length}] `
                    : "";
                  const msg = `[${new Date().toLocaleTimeString()}] ${pre}✨ Audio cleaned successfully! URL: ${check.download_url}`;
                  console.log(msg);

                  // Helper to dynamically push logs globally and to the specific file in real-time
                  const pushLog = (logLine: string) => {
                    setLocalLogs((prev) => [...prev, logLine]);
                    setFiles((prev) =>
                      prev.map((f) =>
                        f.id === job.currentTarget.id && f.cleanvoiceResult
                          ? {
                              ...f,
                              cleanvoiceResult: {
                                ...f.cleanvoiceResult,
                                logs: [...(f.cleanvoiceResult.logs || []), logLine],
                              },
                            }
                          : f,
                      ),
                    );
                  };

                  pushLog(msg);

                  // <PHASE 2> Real-Time Encoding and Dual Performance Disintegration
                  
                  const latestFileItem = filesRef.current.find((f) => f.id === job.currentTarget.id) || job.currentTarget;

                  // Trigger silent background pre-fetch and 128kbps transcoding
                  if (check.download_url) {
                    runSilentBackgroundTranscode(latestFileItem, check.download_url).catch((err) => {
                      console.warn("Silent background transcode invocation error:", err);
                    });
                  }

                  // Switch the UI state of the file item to "Completed"
                  setFiles((prev) =>
                    prev.map((f) =>
                      f.id === job.currentTarget.id && f.cleanvoiceResult
                        ? {
                            ...f,
                            cleanvoiceResult: {
                              ...f.cleanvoiceResult,
                              status: "success",
                              cleanedUrl: check.download_url,
                              edits: check.edits,
                              duration: check.duration,
                              transcription: check.transcription,
                              summary: check.summary,
                              social_content: check.social_content,
                              elapsedSeconds: check.serverElapsedSeconds !== undefined
                                ? check.serverElapsedSeconds
                                : (f.cleanvoiceResult.startedAt
                                    ? Math.floor((Date.now() - f.cleanvoiceResult.startedAt) / 1000)
                                    : undefined),
                              serverElapsedSeconds: check.serverElapsedSeconds !== undefined ? check.serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                              serverElapsedAt: check.serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                            },
                          }
                        : f,
                    ),
                  );
                  setLastResultUrl(check.download_url!);
                  if (!isSpecific) {
                    setLocalBatchIndex((prev) =>
                      Math.min(prev + 1, filesToRun.length - 1),
                    );
                  }
                  

                } else {
                  // SUCCESS but missing url, log as warning and keep polling/retrying
                  const warningMsg = `⚠️ Job reported SUCCESS but download URL is not ready yet. Retrying status check...`;
                  if (isBatchRun) {
                    setLocalLogs((prev) => [
                      ...prev,
                      `[${new Date().toLocaleTimeString()}] ${warningMsg}`,
                    ]);
                  }
                  stillPending.push(job);
                }
              } else if (check.status === "error") {
                const msg = `[${new Date().toISOString()}] ❌ Error for ${job.currentTarget.name}: ${check.error}`;
                console.error(msg);
                if (isBatchRun) {
                  setLocalLogs((prev) => [...prev, msg]);
                }
                setFiles((prev) =>
                  prev.map((f) =>
                    f.id === job.currentTarget.id && f.cleanvoiceResult
                      ? {
                          ...f,
                          cleanvoiceResult: {
                            ...f.cleanvoiceResult,
                            status: "error",
                            error: check.error || "Unknown API error",
                            logs: [
                              ...(f.cleanvoiceResult.logs || []),
                              `[${new Date().toLocaleTimeString()}] ❌ Error: ${check.error || "Unknown API error"}`,
                            ],
                            elapsedSeconds: check.serverElapsedSeconds !== undefined
                              ? check.serverElapsedSeconds
                              : (f.cleanvoiceResult.startedAt
                                  ? Math.floor((Date.now() - f.cleanvoiceResult.startedAt) / 1000)
                                  : undefined),
                            serverElapsedSeconds: check.serverElapsedSeconds !== undefined ? check.serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                            serverElapsedAt: check.serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                          },
                        }
                      : f,
                  ),
                );
                if (!isSpecific) {
                  setLocalBatchIndex((prev) =>
                    Math.min(prev + 1, filesToRun.length - 1),
                  );
                }
              } else {
                stillPending.push(job);
                // 429 rate-limit responses carry no rawStatus. Reclassifying from
                // the stale stored rawStatus could mislabel a now-processing job.
                // Preserve current state and keep polling.
                if (check.isRateLimited) {
                  continue;
                }

                setFiles((prev) =>
                  prev.map((f) => {
                    if (f.id === job.currentTarget.id && f.cleanvoiceResult) {
                      // Never fall back to the stale stored rawStatus — a poll that
                      // omits rawStatus means "processing".
                      const nextRawStatus = check.rawStatus || "PROCESSING";
                      const isQueued = !!check.isQueued || nextRawStatus === "QUEUED" || nextRawStatus === "queued" || (check.progressPercentage !== undefined && check.progressPercentage <= 5);
                      return {
                        ...f,
                        cleanvoiceResult: {
                          ...f.cleanvoiceResult,
                          status: "processing",
                          rawStatus: isQueued ? "QUEUED" : nextRawStatus,
                          isQueued: isQueued,
                          progress:
                            check.progressPercentage !== undefined
                              ? check.progressPercentage
                              : f.cleanvoiceResult.progress,
                          createdAt:
                            check.createdAt || f.cleanvoiceResult.createdAt,
                          elapsedSeconds: check.serverElapsedSeconds !== undefined
                            ? check.serverElapsedSeconds
                            : (f.cleanvoiceResult.startedAt
                                ? Math.floor((Date.now() - f.cleanvoiceResult.startedAt) / 1000)
                                : undefined),
                          serverElapsedSeconds: check.serverElapsedSeconds !== undefined ? check.serverElapsedSeconds : f.cleanvoiceResult.serverElapsedSeconds,
                          serverElapsedAt: check.serverElapsedSeconds !== undefined ? Date.now() : f.cleanvoiceResult.serverElapsedAt,
                        },
                      };
                    }
                    return f;
                  }),
                );
              }
            }

            pending = stillPending;
            if (pending.length === 0) {
              isStopped = true;
              sharedPollWorker.removeEventListener("message", messageHandler);
              const msg = `[${new Date().toISOString()}] ✅ ${isBatchRun ? "[Batch] All jobs completed." : "Job completed."}`;
              console.log(msg);
              if (isBatchRun) {
                setLocalLogs((prev) => [...prev, msg]);
              }
              resolveBatch();
            }
          } catch (err) {
            console.error("Batch polling err", err);
          } finally {
            isBatchPolling = false;
          }
        };

        sharedPollWorker.addEventListener("message", messageHandler);
      });
    }

    sharedPollWorker.postMessage("stop");
    sharedPollWorker.terminate();
    URL.revokeObjectURL(workerUrl);

    setLocalIsProcessing(false);

    import("sonner").then(({ toast }) => {
      if (isBatchRun) {
        toast.success("Audio processing finished!", {
          description: "Your audio files are ready for download or review.",
        });
      } else {
        toast.success("Audio processing finished!", {
          description: "Your audio file is ready for download or review.",
        });
      }
    });
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Top Banner API Config Manager */}
      <CleanvoiceApiKeySetup apiKey={apiKey} setApiKey={setApiKey} remainingCredits={remainingCredits} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Interactive Features Selection Card */}
        <div className="lg:col-span-7 theme-card-bg theme-border theme-shadow p-5 sm:p-6 flex flex-col justify-between min-w-0 self-start w-full">
          <div>
            <div className="flex items-start justify-between flex-wrap gap-4 border-b border-slate-100 dark:border-slate-800 pb-4 mb-6">
              <div>
                <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <Sliders className="w-5 h-5 text-indigo-500" /> Features
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-300 mt-1">
                  Choose what Cleanvoice should edit, enhance, or export.
                </p>
              </div>

              {/* Presets dropdown selector — pill-shaped custom dropdown */}
              <div className="relative" ref={presetDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsPresetOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={isPresetOpen}
                  className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-full px-4 py-2 text-xs font-bold text-slate-700 dark:text-slate-300 outline-none cursor-pointer shadow-inner transition-colors duration-200 focus:ring-2 focus:ring-indigo-500/20"
                >
                  <span className="truncate max-w-[150px]">{selectedPreset}</span>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-500 transition-transform duration-200 ${isPresetOpen ? "rotate-180" : ""}`}
                  />
                </button>

                <AnimatePresence>
                  {isPresetOpen && (
                    <motion.ul
                      role="listbox"
                      initial={{ opacity: 0, scale: 0.95, y: -10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -10 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      className="absolute left-0 md:left-auto md:right-0 top-full mt-2 w-60 max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl overflow-hidden z-50 origin-top"
                    >
                      {PRESET_OPTIONS.map((preset, idx) => {
                        const isActive = selectedPreset === preset;
                        const isCustom = preset === "Custom Preset";
                        return (
                          <React.Fragment key={preset}>
                            {isCustom && idx > 0 && (
                              <li
                                className="border-t border-slate-100 dark:border-slate-800"
                                aria-hidden="true"
                              />
                            )}
                            <li
                              role="option"
                              aria-selected={isActive}
                              onClick={() => {
                                handlePresetChange(preset);
                                setIsPresetOpen(false);
                              }}
                              className={`px-4 py-2.5 text-xs font-bold cursor-pointer transition-colors duration-150 flex items-center justify-between ${isActive ? "bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" : "text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"}`}
                            >
                              <span className="truncate">{preset}</span>
                              {isActive && (
                                <Check className="w-3.5 h-3.5 shrink-0 ml-2" />
                              )}
                            </li>
                          </React.Fragment>
                        );
                      })}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Feature Subtabs Row */}
            <div className="flex bg-slate-100 dark:bg-slate-950 p-1 rounded-xl text-xs font-bold mb-6 border border-slate-200/50 dark:border-slate-800 max-w-[210px]">
              <button
                onClick={() => setActiveTab("edit")}
                className={`flex-1 py-2 text-center rounded-lg transition-all duration-200 cursor-pointer ${activeTab === "edit" ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm" : "text-slate-500 dark:text-slate-300 hover:text-slate-700"}`}
              >
                Edit
              </button>
              <button
                onClick={() => setActiveTab("enhance")}
                className={`flex-1 py-2 text-center rounded-lg transition-all duration-200 cursor-pointer ${activeTab === "enhance" ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm" : "text-slate-500 dark:text-slate-300 hover:text-slate-700"}`}
              >
                Enhance
              </button>
              <button
                onClick={() => setActiveTab("export")}
                className={`flex-1 py-2 text-center rounded-lg transition-all duration-200 cursor-pointer ${activeTab === "export" ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm" : "text-slate-500 dark:text-slate-300 hover:text-slate-700"}`}
              >
                Export
              </button>
            </div>

            {/* Bento Grid Features */}
            <AnimatePresence mode="wait">
              {activeTab === "edit" && (
                <motion.div
                  key="edit"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-4"
                >
                  {/* 1. Mute */}
                  <motion.div
                    onClick={() => handleToggleOption("mute")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.mute ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Mute
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.mute ? 1.05 : 1,
                          backgroundColor: cvConfig.mute
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.mute
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.mute && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Replace cut segments with silence instead of removing
                      them.
                    </p>
                  </motion.div>

                  {/* 2. Hesitations */}
                  <motion.div
                    onClick={() => handleToggleOption("hesitations")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.hesitations ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Hesitations
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.hesitations ? 1.05 : 1,
                          backgroundColor: cvConfig.hesitations
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.hesitations
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.hesitations && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Remove short pauses that break the flow of speech.
                    </p>
                  </motion.div>

                  {/* 3. Long Silences */}
                  <motion.div
                    onClick={() => handleToggleOption("silences")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.silences ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Long Silences
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.silences ? 1.05 : 1,
                          backgroundColor: cvConfig.silences
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.silences
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.silences && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Removes extended periods of silence from the audio.
                    </p>
                  </motion.div>

                  {/* 4. Stutters */}
                  <motion.div
                    onClick={() => handleToggleOption("stutters")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.stutters ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Stutters
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.stutters ? 1.05 : 1,
                          backgroundColor: cvConfig.stutters
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.stutters
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.stutters && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Edit simple stuttering in speech.
                    </p>
                  </motion.div>

                  {/* 5. Mouth Sounds */}
                  <motion.div
                    onClick={() => handleToggleOption("mouth_sounds")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.mouth_sounds ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Mouth Sounds
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.mouth_sounds ? 1.05 : 1,
                          backgroundColor: cvConfig.mouth_sounds
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.mouth_sounds
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.mouth_sounds && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Reduces or removes mouth sounds.
                    </p>
                  </motion.div>

                  {/* 6. Filler Words */}
                  <motion.div
                    onClick={() => handleToggleOption("fillers")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.fillers ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Filler Words
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.fillers ? 1.05 : 1,
                          backgroundColor: cvConfig.fillers
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.fillers
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.fillers && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Eliminates filler sounds such as "um," "uh," etc.
                    </p>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {activeTab === "enhance" && (
                <motion.div
                  key="enhance"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-4"
                >
                  {/* 1. Keep Music */}
                  <motion.div
                    onClick={() => handleToggleOption("keep_music")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.keep_music ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Keep Music
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.keep_music ? 1.05 : 1,
                          backgroundColor: cvConfig.keep_music
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.keep_music
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.keep_music && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Preserve background music while editing speech.
                    </p>
                  </motion.div>

                  {/* 2. Breath Control */}
                  <motion.div
                    onClick={() => handleToggleOption("remove_breath")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.remove_breath !== "disabled" ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                          Breath Control
                        </span>
                        {cvConfig.remove_breath !== "disabled" && (
                          <motion.span
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 25,
                            }}
                            className="bg-indigo-600 dark:bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full capitalize"
                          >
                            {cvConfig.remove_breath === "mute"
                              ? "Mute"
                              : cvConfig.remove_breath === "natural"
                                ? "Natural"
                                : cvConfig.remove_breath === "legacy"
                                  ? "Legacy"
                                  : cvConfig.remove_breath}
                          </motion.span>
                        )}
                      </div>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale:
                            cvConfig.remove_breath !== "disabled" ? 1.05 : 1,
                          backgroundColor:
                            cvConfig.remove_breath !== "disabled"
                              ? "rgba(79, 70, 229, 1)"
                              : "rgba(79, 70, 229, 0.01)",
                          borderColor:
                            cvConfig.remove_breath !== "disabled"
                              ? "rgba(79, 70, 229, 1)"
                              : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.remove_breath !== "disabled" && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Reduce loud breath sounds.
                    </p>
                  </motion.div>

                  {/* 3. Remove Noise */}
                  <motion.div
                    onClick={() => handleToggleOption("noise")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.noise ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                          Remove Noise
                        </span>
                        {cvConfig.noise && (
                          <motion.span
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 25,
                            }}
                            className="bg-indigo-600 dark:bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full"
                          >
                            {cvConfig.noise === "legacy" ? "Legacy" : "v2"}
                          </motion.span>
                        )}
                      </div>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.noise ? 1.05 : 1,
                          backgroundColor: cvConfig.noise
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.noise
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.noise && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Reduce background noise in the audio.
                    </p>
                  </motion.div>

                  {/* 4. Mastering */}
                  <motion.div
                    onClick={() => handleToggleOption("normalize")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.normalize && cvConfig.normalize !== "disabled" ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                          Mastering
                        </span>
                        {cvConfig.normalize && cvConfig.normalize !== "disabled" && (
                          <motion.span
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 25,
                            }}
                            className="bg-indigo-600 dark:bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full capitalize"
                          >
                            {cvConfig.normalize === "-14"
                              ? "Loud (-14 LUFS)"
                              : cvConfig.normalize === "-20"
                                ? "Audiobook (-20 LUFS)"
                                : cvConfig.normalize === "-23"
                                  ? "Broadcast (-23 LUFS)"
                                  : "Podcast (-16 LUFS)"}
                          </motion.span>
                        )}
                      </div>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.normalize && cvConfig.normalize !== "disabled" ? 1.05 : 1,
                          backgroundColor: cvConfig.normalize && cvConfig.normalize !== "disabled"
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.normalize && cvConfig.normalize !== "disabled"
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.normalize && cvConfig.normalize !== "disabled" && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      This will apply mastering to the audio.
                    </p>
                  </motion.div>

                  {/* 5. AutoEQ */}
                  <motion.div
                    onClick={() => handleToggleOption("eq")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.eq ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        AutoEQ
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.eq ? 1.05 : 1,
                          backgroundColor: cvConfig.eq
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.eq
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.eq && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Apply automatic equalization to improve audio quality
                      (Will be replaced by Studio Sound).
                    </p>
                  </motion.div>

                  {/* 6. Studio Sound */}
                  <motion.div
                    onClick={() => handleToggleOption("studio_sound")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.studio_sound !== "disabled" ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                          Studio Sound
                        </span>
                        {cvConfig.studio_sound !== "disabled" && (
                          <motion.span
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 25,
                            }}
                            className="bg-indigo-600 dark:bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full capitalize"
                          >
                            {cvConfig.studio_sound === "standard"
                              ? "Enabled"
                              : cvConfig.studio_sound === "studio_repair"
                                ? "Studio Repair"
                                : cvConfig.studio_sound === "javelin"
                                  ? "Javelin"
                                  : cvConfig.studio_sound === "nightly"
                                    ? "Nightly"
                                    : cvConfig.studio_sound}
                          </motion.span>
                        )}
                      </div>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale:
                            cvConfig.studio_sound !== "disabled" ? 1.05 : 1,
                          backgroundColor:
                            cvConfig.studio_sound !== "disabled"
                              ? "rgba(79, 70, 229, 1)"
                              : "rgba(79, 70, 229, 0.01)",
                          borderColor:
                            cvConfig.studio_sound !== "disabled"
                              ? "rgba(79, 70, 229, 1)"
                              : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.studio_sound !== "disabled" && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Enhance audio to achieve professional studio-quality
                      sound.
                    </p>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {activeTab === "export" && (
                <motion.div
                  key="export"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-4"
                >
                  {/* Transcribe */}
                  <motion.div
                    onClick={() => handleToggleOption("transcribe")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.transcribe ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Generate Transcript
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.transcribe ? 1.05 : 1,
                          backgroundColor: cvConfig.transcribe
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.transcribe
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.transcribe && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 20,
                              }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Generates a timestamped JSON/TXT transcript of the spoken
                      words alongside audio.
                    </p>
                  </motion.div>

                  {/* Summarize */}
                  <motion.div
                    onClick={() => handleToggleOption("summarize")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.summarize ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Summarize
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.summarize ? 1.05 : 1,
                          backgroundColor: cvConfig.summarize
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.summarize
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.summarize && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Generates chapters and key learnings (auto-enables
                      transcription).
                    </p>
                  </motion.div>

                  {/* Social Content */}
                  <motion.div
                    onClick={() => handleToggleOption("social_content")}
                    whileHover={{ scale: 1.015, y: -1 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none ${cvConfig.social_content ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 shadow-sm" : "border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-slate-900/40 dark:hover:bg-slate-800"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100">
                        Social Content
                      </span>
                      <motion.div
                        initial={{ backgroundColor: "rgba(79, 70, 229, 0.01)" }}
                        animate={{
                          scale: cvConfig.social_content ? 1.05 : 1,
                          backgroundColor: cvConfig.social_content
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(79, 70, 229, 0.01)",
                          borderColor: cvConfig.social_content
                            ? "rgba(79, 70, 229, 1)"
                            : "rgba(203, 213, 225, 1)",
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 25,
                        }}
                        className={`w-4 h-4 rounded-full border flex items-center justify-center`}
                      >
                        <AnimatePresence initial={false}>
                          {cvConfig.social_content && (
                            <motion.div
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                            >
                              <Check className="w-3 h-3 text-white" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 leading-relaxed">
                      Generates social media posts (auto-enables summarize).
                    </p>
                  </motion.div>

                  {/* Output selection format */}
                  <motion.div
                    whileHover={{ scale: 1.015, y: -1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900/40 space-y-3"
                  >
                    <div className="space-y-1">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100 block">
                        Format Export
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(["mp3", "wav", "m4a"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          onClick={() =>
                            setCvConfig((prev) => ({ ...prev, format: fmt }))
                          }
                          className={`flex-1 py-1.5 font-bold uppercase rounded-lg border transition ${cvConfig.format === fmt ? "bg-indigo-600 text-white border-indigo-600 shadow-xs" : "bg-slate-50 dark:bg-slate-950 text-slate-600 border-slate-200 dark:border-slate-800 hover:bg-slate-100"}`}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                      Select final audio codec format.
                    </p>

                    <div className="h-px bg-slate-100 dark:bg-slate-800/80 my-1" />

                    <div className="space-y-1">
                      <span className="font-bold text-sm text-slate-800 dark:text-slate-100 block">
                        Bitrate Quality
                      </span>
                    </div>
                    <div className="flex gap-2 text-xs">
                      {([
                        { value: "source", label: "Source" },
                        { value: "320", label: "320 kbps" },
                        { value: "192", label: "192 kbps" },
                        { value: "128", label: "128 kbps" }
                      ] as const).map((qOption) => (
                        <button
                          key={qOption.value}
                          onClick={() => setSelectedQuality(qOption.value)}
                          className={`flex-1 py-1.5 font-bold rounded-lg border transition ${selectedQuality === qOption.value ? "bg-indigo-600 text-white border-indigo-600 shadow-xs" : "bg-slate-50 dark:bg-slate-950 text-slate-600 border-slate-200 dark:border-slate-800 hover:bg-slate-100"}`}
                        >
                          {qOption.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                      Preserves the exact uploaded sample's bitrate (e.g. 128 kbps or 192 kbps), or limits output to custom fixed bitrates.
                    </p>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right Column: Audio Queue & Processing Dashboard */}
        <div className="lg:col-span-5 theme-card-bg theme-border theme-shadow p-5 sm:p-6 flex flex-col justify-start min-h-[550px] min-w-0 self-start w-full">
          <div className="space-y-4">
            <div className="flex items-start justify-between flex-wrap gap-4 pb-1">
              <div>
                <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-indigo-500" /> Audio Queue
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-350 mt-1">
                  Upload audio/video tracks to process them using Cleanvoice AI.
                </p>
              </div>
            </div>
          </div>

          {/* Action Runway & Target Queue Audio File */}
          <div className="mt-3 space-y-3">
            {/* Target queue audio selector */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-y-2.5 gap-x-4 w-full">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-300">
                      Source Audio Tracks
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                    
                    <button
                      id="upload-button-beside-tracks"
                      onClick={handleUploadIconClick}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setIsDraggingOverButton(true);
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setIsDraggingOverButton(false);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setIsDraggingOverButton(false);
                        setIsDraggingAnywhere(false);
                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                          onFilesAdded(Array.from(e.dataTransfer.files));
                        }
                      }}
                      className={`p-1.5 rounded-lg transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer flex items-center justify-center border group ${
                        isDraggingOverButton
                          ? "bg-indigo-600 border-indigo-600 text-white shadow-[0_0_15px_rgba(79,70,229,0.7)] scale-115 ring-2 ring-indigo-500 ring-offset-2 ring-offset-slate-900"
                          : isDraggingAnywhere
                          ? "bg-indigo-500/20 border-indigo-500 text-indigo-500 dark:text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.5)] scale-110 animate-pulse"
                          : "bg-transparent border-slate-200 hover:bg-slate-100 dark:border-slate-850 dark:hover:bg-slate-900/50 text-slate-600 dark:text-slate-350 hover:scale-[1.05] active:scale-[0.95]"
                      }`}
                      aria-label="Upload more audio/video tracks"
                      data-tooltip={isDraggingOverButton ? "Drop here!" : isDraggingAnywhere ? "Drop files to upload" : "Upload source audio"}
                    >
                      <Upload className={`w-3 h-3 upload-icon-interactive ${isDraggingOverButton ? "text-white scale-110" : isDraggingAnywhere ? "text-indigo-500" : ""}`} />
                    </button>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileInputChange}
                      multiple
                      accept="audio/*,video/*"
                      className="hidden"
                    />

                    {/* Pill with rounded square corners for recording / pause */}
                    <motion.div
                      animate={{
                        width: isRecording ? "82px" : "50px",
                        backgroundColor: isRecording 
                          ? "rgba(239, 68, 68, 0.15)" 
                          : "rgba(148, 163, 184, 0.1)",
                      }}
                      transition={{ type: "spring", stiffness: 350, damping: 26 }}
                      className="flex items-center border border-slate-200 dark:border-slate-800 rounded-lg p-0.5 shadow-xs gap-0.5"
                    >
                      {/* Record/Stop Button (Screenshot 2 Icon) */}
                      <button
                        onClick={isRecording ? stopRecording : startRecording}
                        className={`w-[22px] h-[22px] rounded transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] flex items-center justify-center tooltip-bottom hover:scale-[1.05] active:scale-[0.95] ${
                          isRecording 
                            ? "text-red-500 hover:text-red-600 bg-red-100/60 dark:bg-red-950/30 cursor-pointer animate-pulse" 
                            : "text-slate-550 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        }`}
                        data-tooltip={isRecording ? "Stop" : "Record"}
                        aria-label={isRecording ? "Stop recording" : "Record audio"}
                      >
                        {isRecording ? (
                          <MicOff className="w-3 h-3" />
                        ) : (
                          <Mic className="w-3 h-3" />
                        )}
                      </button>

                      {/* Monospace elapsed time */}
                      {isRecording && (
                        <span className="w-[30px] flex items-center justify-center text-[9px] font-mono font-bold text-red-500 dark:text-red-400 select-none shrink-0 text-center">
                          {new Date(recordingTime * 1000).toISOString().substr(14, 5)}
                        </span>
                      )}

                      {/* Pause/Play Button (Screenshot 3 & 4 Icons) */}
                      <button
                        onClick={togglePauseRecording}
                        disabled={!isRecording}
                        className={`w-[22px] h-[22px] rounded transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] flex items-center justify-center ${
                          isRecording ? "tooltip-bottom hover:scale-[1.05] active:scale-[0.95]" : ""
                        } ${
                          !isRecording 
                            ? "opacity-35 cursor-not-allowed text-slate-350" 
                            : isPaused 
                              ? "text-green-500 hover:text-green-600 bg-green-50 dark:bg-green-950/20 cursor-pointer animate-pulse" 
                              : "text-amber-500 hover:text-amber-600 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        }`}
                        data-tooltip={!isRecording ? "" : isPaused ? "Resume" : "Pause"}
                        aria-label={!isRecording ? "Pause recording disabled" : isPaused ? "Resume recording" : "Pause recording"}
                      >
                        {isPaused ? (
                          <PlayCircle className="w-3 h-3" />
                        ) : (
                          <PauseCircle className="w-3 h-3" />
                        )}
                      </button>
                    </motion.div>

                    {isPaused && playbackUrl && (
                      <div className="flex items-center gap-1 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-lg p-0.5 shadow-xs shrink-0 w-[245px] ml-0 h-[28px]">
                        <audio
                          ref={playbackAudioRef}
                          src={playbackUrl || undefined}
                          preload="none"
                          onTimeUpdate={() => {
                            if (playbackAudioRef.current) {
                              setPlaybackCurrentTime(playbackAudioRef.current.currentTime);
                            }
                          }}
                          onDurationChange={() => {
                            if (playbackAudioRef.current) {
                              const dur = playbackAudioRef.current.duration;
                              // Only trust the audio element's reported duration if our
                              // timer-based duration hasn't been set yet (still 0).
                              // Raw webm blobs from MediaRecorder often have incorrect or
                              // missing duration metadata, so the performance.now()-based
                              // value set in togglePauseRecording is authoritative.
                              if (isFinite(dur) && !isNaN(dur) && dur > 0 && playbackDuration === 0) {
                                setPlaybackDuration(dur);
                              }
                            }
                          }}
                          onCanPlay={() => {
                            if (playbackAudioRef.current) {
                              const dur = playbackAudioRef.current.duration;
                              // Same guard as onDurationChange — don't overwrite the
                              // correct timer-based value with a potentially wrong one.
                              if (isFinite(dur) && !isNaN(dur) && dur > 0 && playbackDuration === 0) {
                                setPlaybackDuration(dur);
                              }
                            }
                          }}
                          onLoadedMetadata={() => {
                            if (playbackAudioRef.current) {
                              const dur = playbackAudioRef.current.duration;
                              if (isFinite(dur) && !isNaN(dur) && dur > 0 && playbackDuration === 0) {
                                setPlaybackDuration(dur);
                              } else if (playbackDuration === 0) {
                                // Last-resort fallback when no duration source is available.
                                const elapsed = durationRef.current / 1000;
                                setPlaybackDuration(elapsed > 0 ? elapsed : (recordingTime > 0 ? recordingTime : 1));
                              }
                            }
                          }}
                          onEnded={() => {
                            setIsPlayingPlayback(false);
                            setPlaybackCurrentTime(0);
                          }}
                        />
                        <button
                          type="button"
                          onClick={togglePlaybackPlay}
                          className="w-[20px] h-[20px] rounded hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center text-indigo-600 dark:text-indigo-400 focus:outline-none cursor-pointer shrink-0"
                        >
                          {isPlayingPlayback ? (
                            <Pause className="w-2.5 h-2.5 fill-current" />
                          ) : (
                            <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
                          )}
                        </button>
                        <div className="flex-1 flex items-center pr-1.5 min-w-0">
                           <input
                              type="range"
                              min={0}
                              max={playbackDuration || 100}
                              step={0.05}
                              value={playbackCurrentTime}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                setPlaybackCurrentTime(val);
                                if (playbackAudioRef.current) {
                                  playbackAudioRef.current.currentTime = val;
                                }
                              }}
                              className="w-full h-1 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-indigo-600 dark:accent-indigo-400 focus:outline-none"
                            />
                        </div>
                        <span className="text-[9px] font-mono font-bold text-slate-550 dark:text-slate-350 select-none shrink-0 pr-1.5 whitespace-nowrap">
                          {formatPlaybackTime(playbackCurrentTime)} / {formatPlaybackTime(playbackDuration || recordingTime)}
                        </span>
                      </div>
                    )}
                    </div>
                  </div>
                {audioFilesInQueue.length > 0 && (
                  <div className="flex items-center gap-2 ml-auto sm:ml-0">
                    <label className="flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={
                          selectedFileIds.size > 0 &&
                          selectedFileIds.size === audioFilesInQueue.length
                        }
                        onChange={handleToggleSelectAll}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      Select All
                    </label>
                    <span className="text-slate-300 dark:text-slate-700 text-[10px] select-none">|</span>
                    <button
                      onClick={handleClearAllQueue}
                      className="text-[10px] font-extrabold text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer flex items-center gap-1"
                      data-tooltip="Clear all tracks from queue"
                    >
                      Clear All
                    </button>
                    {selectedFileIds.size > 0 && (
                      <>
                        <span className="text-slate-300 dark:text-slate-700 text-[10px] select-none">|</span>
                        <button
                          onClick={handleClearAll}
                          className="text-[10px] font-extrabold text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 cursor-pointer flex items-center gap-1"
                          data-tooltip="Delete selected files from queue"
                        >
                          Delete Selected ({selectedFileIds.size})
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {audioFilesInQueue.length > 0 ? (
                <div className="relative max-h-48 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-1.5 space-y-0.5">
                  {audioFilesInQueue.map((f) => {
                    const isFileChecked = selectedFileIds.has(f.id);
                    const isFileActive = activeFileId === f.id;
                    const isSelected = isFileChecked || (selectedFileIds.size === 0 && isFileActive);
                    const res = f.cleanvoiceResult;
                    const isProcessingFile = res && (res.status === "uploading" || res.status === "processing" || res.status === "pending");

                    return (
                      <div
                        key={f.id}
                        onClick={() => {
                          setActiveFileId(f.id);
                        }}
                        className={`flex flex-col sm:flex-row sm:items-center justify-between p-2.5 sm:py-1.5 sm:px-2 rounded-lg transition-all border gap-2.5 sm:gap-3 cursor-pointer ${
                          isSelected
                            ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/25 sm:shadow-none shadow-sm"
                            : "border-slate-100 dark:border-slate-800 sm:border-transparent hover:bg-slate-100/70 dark:hover:bg-slate-900/60 sm:hover:bg-slate-100 sm:dark:hover:bg-slate-900"
                        }`}
                      >
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <div className="flex items-center gap-2 overflow-hidden select-none">
                            <input
                              type="checkbox"
                              checked={selectedFileIds.has(f.id)}
                              onChange={(e) => {
                                e.stopPropagation();
                                handleToggleSelect(f.id);
                                setActiveFileId(f.id);
                              }}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer shrink-0"
                            />
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">
                              📻 {f.name}
                            </span>
                          </div>
                          {(f.duration || f.sourceBitrate || res?.elapsedSeconds !== undefined || res?.status === "success" || res?.status === "error") && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3 mt-1 sm:mt-0.5 ml-6 text-[10px] text-slate-500 dark:text-slate-400 font-mono leading-normal">
                              {f.duration && Number.isFinite(f.duration) ? (
                                <span className="shrink-0">
                                  <span className="opacity-75">Duration:</span>{" "}
                                  {f.duration > 60
                                    ? `${Math.floor(f.duration / 60)}m ${Math.floor(f.duration % 60)}s`
                                    : `${Math.floor(f.duration)}s`}
                                </span>
                              ) : f.duration ? (
                                <span className="shrink-0"><span className="opacity-75">Duration:</span> Unknown</span>
                              ) : null}
                              
                              <span className="shrink-0"><span className="opacity-75">Bitrate:</span> {f.sourceBitrate || "192"} kbps</span>
                              {/* We omit any sub-card uploading/processing info as requested */}
                              {(res?.status === "success" ||
                                res?.status === "error") &&
                                res?.elapsedSeconds !== undefined && (
                                  <>
                                    <span className="shrink-0">
                                      <span className="opacity-75">Process Time:</span>{" "}
                                      {res.elapsedSeconds > 60
                                        ? `${Math.floor(res.elapsedSeconds / 60)}m ${res.elapsedSeconds % 60}s`
                                        : `${res.elapsedSeconds}s`}
                                    </span>
                                  </>
                                )}
                            </div>
                          )}
                        </div>

                        {/* Status badges */}
                        <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 ml-6 sm:ml-2 shrink-0 justify-start sm:justify-end">
                          {isProcessingFile && (
                            <span className="px-2 h-[20px] flex items-center justify-center gap-1 text-[8.5px] bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded font-bold leading-none select-none text-center shrink-0 border border-indigo-100 dark:border-indigo-900/30">
                              <Loader2 className="w-2.5 h-2.5 animate-spin text-indigo-500" />
                              {res.status === "uploading"
                                ? "Uploading"
                                : (res.isQueued || res.rawStatus?.toLowerCase() === "queued" || res.rawStatus?.toLowerCase() === "waiting" || res.rawStatus?.toLowerCase() === "pending" || (res.progress !== undefined && res.progress <= 5))
                                  ? "Queued"
                                  : "Processing"}
                            </span>
                          )}
                          {f.isUploading && !isProcessingFile && (
                            <span className="px-2 h-[20px] flex items-center justify-center gap-1 text-[8.5px] bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 rounded font-bold leading-none select-none text-center shrink-0 border border-sky-100 dark:border-sky-900/30">
                              <Loader2 className="w-2.5 h-2.5 animate-spin text-sky-500" />
                              Uploading{f.uploadProgress != null ? ` ${f.uploadProgress}%` : ""}
                            </span>
                          )}
                          {!f.isUploading && (!res || (res.status !== "uploading" && res.status !== "processing" && res.status !== "pending" && res.status !== "success" && res.status !== "error")) && (
                            <>
                              <span className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded font-bold leading-none select-none text-center shrink-0">
                                Ready
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRunCleanvoice([f]);
                                }}
                                className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] rounded font-bold transition cursor-pointer bg-indigo-100 hover:bg-indigo-200 dark:bg-indigo-500/20 dark:hover:bg-indigo-500/30 text-indigo-700 dark:text-indigo-400 leading-none select-none text-center shrink-0 border border-transparent"
                              >
                                Process
                              </button>
                            </>
                          )}
                          {res?.status === "success" && (
                            <span className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 rounded font-bold leading-none select-none text-center shrink-0">
                              <Check className="w-2.5 h-2.5 stroke-[3] mr-0.5 shrink-0" />{" "}
                              Success
                            </span>
                          )}
                          {res?.status === "error" && (
                            <div className="flex items-center gap-1.5">
                              <span className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] bg-rose-50 dark:bg-rose-950/20 text-rose-600 rounded font-bold leading-none select-none text-center shrink-0 border border-transparent">
                                Failed
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRunCleanvoice([f]);
                                }}
                                className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] rounded font-bold transition cursor-pointer bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 leading-none select-none text-center shrink-0"
                              >
                                Process
                              </button>
                            </div>
                          )}
                          {isProcessingFile && (res.status === "uploading" || res.status === "processing") && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cancelProcessingRef.current.add(f.id);
                                if (abortControllersRef.current[f.id]) {
                                  abortControllersRef.current[f.id].abort();
                                  delete abortControllersRef.current[f.id];
                                }
                              }}
                              className="w-[50px] h-[20px] flex items-center justify-center text-[8.5px] rounded font-medium transition cursor-pointer bg-rose-100 hover:bg-rose-200 dark:bg-rose-950 dark:hover:bg-rose-900 text-rose-600 dark:text-rose-400 leading-none select-none text-center shrink-0 border border-transparent"
                            >
                              Cancel
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFile(f.id);
                            }}
                            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-md transition-colors cursor-pointer flex items-center justify-center tooltip-align-right"
                            data-tooltip="Remove file from queue"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-800 flex flex-col gap-3">
                <div className="flex items-center gap-2.5 text-slate-500 mb-2">
                  <Music className="w-5 h-5 opacity-40 shrink-0" />
                  <div>
                    <p className="font-semibold text-slate-600 dark:text-slate-300">
                      No Audio loaded
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Upload an audio file below to clean it.
                    </p>
                  </div>
                </div>
                <FileUploader 
                  onFilesAdded={onFilesAdded}
                  accept={{
                    'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aiff', '.aac', '.opus', '.webm'],
                    'video/*': ['.mp4', '.mov', '.webm', '.avi', '.mkv'],
                    'audio/webm': ['.webm'],
                    'video/webm': ['.webm']
                  }}
                  label="Drag & drop audio or video files here"
                />
              </div>
            )}
          </div>

            {/* Run button & Logs terminal */}
            <div className="space-y-3">
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium px-2 py-1 mb-2 bg-slate-50 dark:bg-slate-800/50 rounded-lg flex items-center justify-between border border-slate-100 dark:border-slate-800">
                <span>
                  Output Format:{" "}
                  <strong className="uppercase text-slate-700 dark:text-slate-200">
                    {cvConfig.format}
                  </strong>
                </span>
                <span className="flex items-center gap-1 font-semibold text-slate-600 dark:text-slate-300">
                  Quality:{" "}
                  <strong className="text-slate-800 dark:text-slate-100 font-extrabold uppercase bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-md border border-slate-200/40 dark:border-slate-700/40">
                    {selectedQuality === "source" 
                      ? "Source" 
                      : `${selectedQuality} kbps`}
                  </strong>
                </span>
              </div>

              {(() => {
                const nonRunningFiles = targetFiles.filter(
                  (f) =>
                    !f.cleanvoiceResult ||
                    (f.cleanvoiceResult.status !== "uploading" &&
                      f.cleanvoiceResult.status !== "processing" &&
                      f.cleanvoiceResult.status !== "pending")
                );

                const canProcessNew = nonRunningFiles.length > 0;
                const showProcessingState = isProcessing && !canProcessNew;
                const buttonDisabled = showProcessingState || targetFiles.length === 0;

                return (
                  <button
                    onClick={() => {
                      if (canProcessNew) {
                        handleRunCleanvoice(nonRunningFiles);
                      }
                    }}
                    disabled={buttonDisabled}
                    className={`w-full py-3 rounded-xl text-xs font-bold text-white shadow-md cursor-pointer transition flex items-center justify-center gap-2 ${showProcessingState ? "bg-indigo-500/80 cursor-wait animate-pulse" : buttonDisabled ? "bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-50" : "bg-slate-900 hover:bg-black dark:bg-indigo-600 dark:hover:bg-indigo-700 duration-200"}`}
                  >
                    {showProcessingState ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />{" "}
                        <span className="text-yellow-400">Processing...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 fill-white" />
                        {apiKey
                          ? isProcessing && canProcessNew
                            ? `Process ${nonRunningFiles.length} New Queue Item(s)`
                            : "Run Cleanvoice API Request"
                          : "Run Cleanvoice Simulation"}
                      </>
                    )}
                  </button>
                );
              })()}

              {audioFilesInQueue.length > 0 && (
                <div className="text-[11px] text-center text-slate-500 dark:text-slate-400 font-medium mt-1.5 flex items-center justify-center gap-1.5 py-1.5 px-3 bg-slate-50 dark:bg-slate-900/40 rounded-lg border border-slate-100/50 dark:border-slate-800/80">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></span>
                  <span>
                    {selectedFileIds.size > 0 
                      ? `${selectedFileIds.size} of ${audioFilesInQueue.length} file(s) selected` 
                      : `All ${audioFilesInQueue.length} queue file(s) selected`
                    }
                  </span>
                </div>
              )}

              {(() => {
                const activeProcessingFile =
                  activeFile?.cleanvoiceResult &&
                  (activeFile.cleanvoiceResult.status === "uploading" ||
                    activeFile.cleanvoiceResult.status === "processing" ||
                    activeFile.cleanvoiceResult.status === "pending")
                    ? activeFile
                    : null;
                return activeProcessingFile ? (
                  <CleanvoiceProgressView file={activeProcessingFile} />
                ) : null;
              })()}

              {/* Completed Cleaned Audio items map */}
              {(() => {
                const completedFiles = targetFiles.filter(
                  (f) =>
                    f.cleanvoiceResult?.status === "success" &&
                    f.cleanvoiceResult?.cleanedUrl,
                );
                if (completedFiles.length === 0) return null;

                const hasSelection = selectedCompletedFileIds.size > 0;
                const itemsToActOn = hasSelection
                  ? completedFiles.filter((f) =>
                      selectedCompletedFileIds.has(f.id),
                    )
                  : completedFiles;

                const handleDownloadAction = async () => {
                  if (itemsToActOn.length === 0) return;

                  setIsZipping(true);
                  try {
                    // if there is only 1 file, download it directly
                    if (itemsToActOn.length === 1) {
                      const f = itemsToActOn[0];
                      const originalName = f.name;
                      const dotIdx = originalName.lastIndexOf(".");
                      const baseName = dotIdx !== -1 ? originalName.substring(0, dotIdx) : originalName;
                      const name = f.cleanvoiceResult?.cleanedFileName || `${baseName}_cleaned.${cvConfig.format || "mp3"}`;
                      await robustSingleDownload(f, name, true);
                      return;
                    }

                    const JSZipModule = await import("jszip");
                    const JSZip = JSZipModule.default;
                    const zip = new JSZip();
                    let hasFiles = false;

                    for (const item of itemsToActOn) {
                      if (item.cleanvoiceResult?.cleanedUrl) {
                        try {
                          let finalBlob: Blob | null = cleanvoiceBlobCache[item.id] || null;
                          if (!finalBlob && cleanvoiceActivePrefetches[item.id]) {
                            try {
                              finalBlob = await cleanvoiceActivePrefetches[item.id];
                            } catch (e) {
                              console.warn("[ZIP Action] Awaiting in-flight prefetch failed:", e);
                            }
                          }
                          // Caches hold already-transcoded blobs; raw network
                          // fetches below yield Cleanvoice's 320kbps server output
                          // and must be transcoded to the selected quality.
                          let zipFromCache = !!finalBlob;
                          const originalUrl = item.cleanvoiceResult.cleanedUrl;

                          // Try direct proxy fetch first to prevent any delay
                          if (!finalBlob) {
                            try {
                              let response;
                              try {
                                response = await fetch(originalUrl);
                                if (!response.ok) throw new Error("direct fetch fallback");
                              } catch (err) {
                                const proxyUrl = originalUrl.startsWith("blob:") || originalUrl.startsWith("/") 
                                  ? originalUrl 
                                  : originalUrl;
                                response = await fetch(proxyUrl);
                              }
                              
                              const contentType = response.headers.get("content-type");
                              if (contentType && contentType.includes("text/html")) {
                                throw new Error("Proxy returned HTML instead of audio");
                              }
                              
                              if (response.ok) {
                                const reader = response.body?.getReader();
                                if (reader) {
                                  let loadedBytes = 0;
                                  const chunks: Uint8Array[] = [];
                                  while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    if (value) {
                                      chunks.push(value);
                                      loadedBytes += value.length;
                                    }
                                  }
                                  const completeBuffer = new Uint8Array(loadedBytes);
                                  let offset = 0;
                                  for (const chunk of chunks) {
                                    completeBuffer.set(chunk, offset);
                                    offset += chunk.length;
                                  }
                                  finalBlob = new Blob([completeBuffer], { type: response.headers.get("content-type") || "audio/mpeg" });
                                  zipFromCache = false;
                                }
                              }
                            } catch (directErr) {
                              console.warn("Direct completed item zip fetch failed, falling back to API fresh url", directErr);
                            }
                          }

                          // Fallback: only retrieve fresh URL from Cleanvoice API if direct fetch failed
                          if (!finalBlob) {
                            const freshUrl = await getFreshUrlForFile(item);
                            if (freshUrl) {
                              try {
                                let response;
                                try {
                                  response = await fetch(freshUrl);
                                  if (!response.ok) throw new Error("direct fetch fallback");
                                } catch (err) {
                                  const proxyUrl = freshUrl.startsWith("blob:") || freshUrl.startsWith("/") 
                                    ? freshUrl 
                                    : freshUrl;
                                  response = await fetch(proxyUrl);
                                }
                                
                                const contentType = response.headers.get("content-type");
                                if (contentType && contentType.includes("text/html")) {
                                  throw new Error("Proxy returned HTML instead of audio");
                                }

                                if (!response.ok) throw new Error("Fallback fetch failed");
                                
                                const reader = response.body?.getReader();
                                if (!reader) throw new Error("Stream not available");

                                let loadedBytes = 0;
                                const chunks: Uint8Array[] = [];

                                while (true) {
                                  const { done, value } = await reader.read();
                                  if (done) break;
                                  if (value) {
                                    chunks.push(value);
                                    loadedBytes += value.length;
                                  }
                                }

                                const completeBuffer = new Uint8Array(loadedBytes);
                                let offset = 0;
                                for (const chunk of chunks) {
                                  completeBuffer.set(chunk, offset);
                                  offset += chunk.length;
                                }

                                finalBlob = new Blob([completeBuffer], { type: response.headers.get("content-type") || "audio/mpeg" });
                                zipFromCache = false;
                              } catch (fallbackErr) {
                                console.error("Fallback completed item zip fetch failed:", fallbackErr);
                              }
                            }
                          }

                          if (finalBlob) {
                            // Transcode raw 320kbps server output down to the
                            // selected quality (or source bitrate) via the fast
                            // server-side native ffmpeg path, falling back to
                            // WASM. Cached blobs already went through this.
                            if (!zipFromCache) {
                              try {
                                const { transcodeViaServer } = await import("../utils/audioUtils");
                                const transcodeBitrate = selectedQualityRef.current === "source"
                                  ? (parseInt(item.sourceBitrate || "128") || 128)
                                  : (parseInt(selectedQualityRef.current) || 128);
                                finalBlob = await transcodeViaServer(
                                  originalUrl,
                                  transcodeBitrate,
                                  "mp3",
                                  `${item.name || "audio"}_cleaned.mp3`,
                                );
                              } catch (serverErr) {
                                console.warn("[ZIP Action] Server transcode failed, falling back to WASM:", serverErr);
                                try {
                                  const { transcodeBlobFast } = await import("../utils/audioUtils");
                                  const transcodeBitrate = selectedQualityRef.current === "source"
                                    ? (parseInt(item.sourceBitrate || "128") || 128)
                                    : (parseInt(selectedQualityRef.current) || 128);
                                  finalBlob = await transcodeBlobFast(finalBlob, transcodeBitrate, "mp3");
                                } catch (err) {
                                  console.warn("[ZIP Action] Transcode failed, using raw blob:", err);
                                }
                              }
                            }
                            const originalName = item.name;
                            const dotIdx = originalName.lastIndexOf(".");
                            const baseName = dotIdx !== -1 ? originalName.substring(0, dotIdx) : originalName;
                            const name = item.cleanvoiceResult?.cleanedFileName || `${baseName}_cleaned.${cvConfig.format || "mp3"}`;
                            zip.file(name, finalBlob);
                            hasFiles = true;
                          }
                        } catch (err) {
                          console.error(`Failed to download ${item.name}`, err);
                        }
                      }
                    }

                    if (hasFiles) {
                      const content = await zip.generateAsync({ type: "blob" });
                      const url = URL.createObjectURL(content);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "Cleaned_Audio_Files.zip";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }
                  } catch (err) {
                    console.error("Failed to zip batch files:", err);
                  } finally {
                    setIsZipping(false);
                  }
                };

                const handleClearAction = async () => {
                  const originalFiles = [...files];
                  const originalSelectedCompleted = new Set(selectedCompletedFileIds);
                  const originalLastResultUrl = lastResultUrl;

                  // 1. Optimistic UI Updates
                  setFiles((prev) =>
                    prev.filter((f) => !itemsToActOn.some((cf) => cf.id === f.id)),
                  );
                  setSelectedCompletedFileIds(new Set());
                  if (
                    itemsToActOn.some(
                      (f) => f.cleanvoiceResult?.cleanedUrl === lastResultUrl,
                    )
                  ) {
                    setLastResultUrl(null);
                  }

                  // 2. Background Processing
                  const apiKey = localStorage.getItem("cleanvoice_api_key");
                  if (apiKey) {
                    const deletePromises = itemsToActOn
                      .filter((f) => !!f.cleanvoiceResult?.editId)
                      .map((f) =>
                        deleteCleanvoiceEdit(
                          f.cleanvoiceResult!.editId!,
                          apiKey,
                          true
                        ).catch((err) => {
                          throw err;
                        })
                      );

                    if (deletePromises.length > 0) {
                      Promise.all(deletePromises)
                        .then(() => {
                          import("sonner").then(({ toast }) => {
                            toast.success(`Successfully cleared ${deletePromises.length} completed ${deletePromises.length === 1 ? 'file' : 'files'} from cloud.`);
                          });
                        })
                        .catch((err) => {
                          console.error("Failed to delete completed edits from Cleanvoice API:", err);

                          // 3. Rollback UI state on failure
                          setFiles(originalFiles);
                          setSelectedCompletedFileIds(originalSelectedCompleted);
                          setLastResultUrl(originalLastResultUrl);

                          import("sonner").then(({ toast }) => {
                            toast.error("Failed to delete items from cloud. Restored files in UI.");
                          });
                        });
                    }
                  }
                };

                const handleToggleSelectAllCompleted = () => {
                  if (selectedCompletedFileIds.size === completedFiles.length) {
                    setSelectedCompletedFileIds(new Set());
                  } else {
                    setSelectedCompletedFileIds(
                      new Set(completedFiles.map((f) => f.id)),
                    );
                  }
                };

                const handleToggleSelectCompleted = (id: string) => {
                  const newSet = new Set(selectedCompletedFileIds);
                  if (newSet.has(id)) newSet.delete(id);
                  else newSet.add(id);
                  setSelectedCompletedFileIds(newSet);
                };

                return (
                  <div className="space-y-4 pt-2">
                    {/* Beautiful, prominent heading matching the theme */}
                    <div className="border-t border-slate-200 dark:border-slate-800/80 pt-4 px-1">
                      <h4 className="text-sm sm:text-base font-extrabold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-2 font-sans">
                        <CheckCircle2 className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        Completed Output
                      </h4>
                    </div>

                    {/* Toolbar with options located elegantly below the heading */}
                    {completedFiles.length > 0 && (
                      <div className="flex items-center justify-between gap-3 bg-slate-100/50 dark:bg-slate-900/60 border border-slate-200/50 dark:border-slate-800/60 rounded-xl p-2.5 sm:p-3 mx-1">
                        {/* Select All */}
                        <div className="flex items-center min-w-0 flex-1">
                          <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 dark:text-slate-300 select-none min-w-0" data-tooltip="Select All Completed Files">
                            <input
                              type="checkbox"
                              checked={
                                selectedCompletedFileIds.size > 0 &&
                                selectedCompletedFileIds.size ===
                                  completedFiles.length
                              }
                              onChange={handleToggleSelectAllCompleted}
                              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer flex-shrink-0"
                            />
                            {/* On both PC and mobile, show the text "Select All" so it is clearly labeled */}
                            <span className="text-xs transition-colors duration-150 truncate">Select All</span>
                          </label>
                        </div>

                        {/* Download & Clear Actions */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={handleDownloadAction}
                            disabled={isZipping}
                            className="text-xs p-2 sm:px-3 sm:py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold tracking-wide flex items-center gap-1.5 cursor-pointer shadow-sm transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:scale-100 disabled:opacity-50"
                            data-tooltip={isZipping ? "Zipping..." : hasSelection ? "Download Selected" : "Download All"}
                          >
                            {isZipping ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            <span className="hidden sm:inline">
                              {isZipping
                                ? "Zipping..."
                                : hasSelection
                                  ? "Download Selected"
                                  : "Download All"}
                            </span>
                          </button>
                          <button
                            onClick={handleClearAction}
                            disabled={isDeleting}
                            className="text-xs p-2 sm:px-3 sm:py-1.5 bg-red-100 hover:bg-red-200 text-red-600 dark:bg-red-950/30 dark:hover:bg-red-900/40 dark:text-red-400 rounded-lg font-bold tracking-wide flex items-center gap-1.5 cursor-pointer transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:scale-100 disabled:opacity-50 border border-red-200/50 dark:border-red-900/30"
                            data-tooltip={hasSelection ? "Clear Selected" : "Clear All"}
                          >
                            {isDeleting ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                            <span className="hidden sm:inline">
                              {hasSelection ? "Clear Selected" : "Clear All"}
                            </span>
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2 mx-1">
                      {completedFiles.map((f) => {
                        const url = f.cleanvoiceResult?.cleanedUrl;
                        const originalName = f.name;
                        const dotIdx = originalName.lastIndexOf(".");
                        const baseName = dotIdx !== -1 ? originalName.substring(0, dotIdx) : originalName;
                        const name = f.cleanvoiceResult?.cleanedFileName || `${baseName}_cleaned.${cvConfig.format || "mp3"}`;
                        if (!url) return null;

                        return (
                          <div
                            key={f.id}
                            className="relative overflow-hidden p-3 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 rounded-xl flex flex-col justify-between animate-fade-in-up gap-2"
                          >
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={selectedCompletedFileIds.has(f.id)}
                                  onChange={() =>
                                    handleToggleSelectCompleted(f.id)
                                  }
                                  className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 ml-1"
                                />
                                <div className="p-2 bg-emerald-100 dark:bg-emerald-950 text-emerald-600 rounded-lg">
                                  <CheckCircle2 className="w-4 h-4" />
                                </div>
                                <div className="overflow-visible min-w-0 flex-1">
                                  <CompletedFileName
                                    fileId={f.id}
                                    name={name}
                                    onRename={handleRenameCompletedFile}
                                  />
                                  <span className="text-[10px] text-emerald-600 dark:text-emerald-500 font-mono">
                                    Clean voice output complete
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 flex-shrink-0 justify-end md:justify-start">
                                <button
                                  onClick={async (e) => {
                                    e.preventDefault();
                                    await robustSingleDownload(f, name);
                                  }}
                                  disabled={downloadingFileIds.has(f.id) || isZipping}
                                  className="p-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition shadow-xs cursor-pointer flex items-center justify-center tooltip-align-right flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                  data-tooltip={downloadingFileIds.has(f.id) ? "Downloading..." : `Download ${name}`}
                                >
                                  {downloadingFileIds.has(f.id) ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Download className="w-4 h-4" />
                                  )}
                                </button>

                                <button
                                  onClick={() => {
                                    const apiKey =
                                      localStorage.getItem(
                                        "cleanvoice_api_key",
                                      );
                                    const originalFiles = [...files];
                                    const originalSelectedCompleted = new Set(selectedCompletedFileIds);
                                    const originalLastResultUrl = lastResultUrl;

                                    // 1. Optimistic UI Updates
                                    setFiles((prev) =>
                                      prev.filter((item) => item.id !== f.id),
                                    );
                                    if (
                                      f.cleanvoiceResult?.cleanedUrl ===
                                      lastResultUrl
                                    ) {
                                      setLastResultUrl(null);
                                    }
                                    setSelectedCompletedFileIds((prev) => {
                                      const n = new Set(prev);
                                      n.delete(f.id);
                                      return n;
                                    });

                                    // 2. Background Processing with rollback
                                    if (f.cleanvoiceResult?.editId && apiKey) {
                                      deleteCleanvoiceEdit(
                                        f.cleanvoiceResult.editId,
                                        apiKey,
                                        true
                                      ).catch((e) => {
                                        console.error("Failed to delete completed edit from Cleanvoice API:", e);

                                        // 3. Rollback UI state on failure
                                        setFiles(originalFiles);
                                        setSelectedCompletedFileIds(originalSelectedCompleted);
                                        setLastResultUrl(originalLastResultUrl);

                                        import("sonner").then(({ toast }) => {
                                          toast.error(`Failed to delete "${name}" from Cleanvoice. Item restored.`, {
                                            id: `delete-fail-completed-${f.id}`,
                                          });
                                        });
                                      });
                                    }
                                  }}
                                  className="p-2 text-red-500 bg-red-50 hover:bg-red-100 dark:text-red-400 dark:bg-red-950/30 dark:hover:bg-red-900/40 rounded-lg transition-colors flex items-center justify-center cursor-pointer disabled:opacity-50 tooltip-align-right"
                                  data-tooltip="Delete file"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Remove Breath Options Modal */}
      {createPortal(
        <AnimatePresence>
        {activeModal === "breath" && (
        <div key="breath" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setActiveModal(null)}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[90vh] overflow-hidden relative z-20"
          >
            {/* Header (Static) */}
            <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
              <div className="text-left pr-8">
                <h3 className="text-lg font-black text-slate-800 dark:text-slate-50 tracking-tight">
                  Breath Control Options
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Control how breath sounds are processed in the audio.
                </p>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all cursor-pointer shrink-0 ml-4"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body Container */}
            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar text-left">
              <div className="space-y-3">
                {[
                  {
                    id: "natural",
                    label: "Natural",
                    desc: "Reduce volume of loud breaths instead of removing them",
                  },
                  {
                    id: "mute",
                    label: "Mute",
                    desc: "Completely remove breath sounds",
                  },
                  {
                    id: "legacy",
                    label: "Legacy",
                    desc: "Use the legacy breath removal algorithm",
                  },
                  {
                    id: "disabled",
                    label: "Disabled",
                    desc: "Keep all breath sounds.",
                  },
                ].map((opt) => {
                  const isSelected = cvConfig.remove_breath === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => {
                        setCvConfig((prev) => ({
                          ...prev,
                          remove_breath: opt.id as any,
                        }));
                        setSelectedPreset("Custom Preset");
                      }}
                      className={`p-4 border rounded-2xl cursor-pointer transition-all duration-200 select-none text-left flex items-start gap-4 min-h-[68px] ${
                        isSelected
                          ? "border-transparent bg-indigo-50 dark:bg-indigo-950/30 shadow-xs"
                          : "border-transparent bg-slate-50/50 hover:bg-slate-100/50 dark:bg-slate-900/40 dark:hover:bg-slate-800/40"
                      }`}
                    >
                      {/* Radio-like Selector Dot on the Left */}
                      <div className="mt-0.5 shrink-0 flex items-center justify-center">
                        <div
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                            isSelected
                              ? "border-indigo-600 dark:border-indigo-500"
                              : "border-slate-300 dark:border-slate-700"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-scale-in" />
                          )}
                        </div>
                      </div>

                      <div className="flex-1">
                        <span
                          className={`block font-bold text-sm ${
                            isSelected ? "text-indigo-900 dark:text-indigo-200" : "text-slate-800 dark:text-slate-100"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.desc && (
                          <p className={`text-xs mt-1 leading-relaxed ${
                            isSelected ? "text-indigo-700/85 dark:text-indigo-300/80" : "text-slate-500 dark:text-slate-400"
                          }`}>
                            {opt.desc}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer (Static) */}
            <div className="p-5 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-800/80 flex justify-end shrink-0 rounded-b-3xl">
              <button
                onClick={() => setActiveModal(null)}
                className="px-6 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-xl text-xs font-bold cursor-pointer duration-200 transition-all shadow-xs"
              >
                Close
              </button>
            </div>
          </motion.div>
        </div>
        )}
        </AnimatePresence>,
        document.body
      )}

      {/* 2b. Remove Noise Model Options Modal */}
      {createPortal(
        <AnimatePresence>
        {activeModal === "noise" && (
        <div key="noise" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setActiveModal(null)}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[90vh] overflow-hidden relative z-20"
          >
            {/* Header (Static) */}
            <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
              <div className="text-left pr-8">
                <h3 className="text-lg font-black text-slate-800 dark:text-slate-50 tracking-tight">
                  Remove Noise Model
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Choose the noise removal model for the audio.
                </p>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all cursor-pointer shrink-0 ml-4"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body Container */}
            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar text-left">
              <div className="space-y-3">
                {[
                  {
                    id: "v2",
                    label: "v2 (Recommended)",
                    desc: "Strongest noise removal. Silences background between speech.",
                  },
                  {
                    id: "legacy",
                    label: "Legacy",
                    desc: "Use the previous noise removal model.",
                  },
                  {
                    id: "disabled",
                    label: "Disabled",
                    desc: "Do not remove background noise.",
                  },
                ].map((opt) => {
                  const isSelected =
                    opt.id === "disabled"
                      ? !cvConfig.noise
                      : cvConfig.noise === opt.id ||
                        (opt.id === "v2" && cvConfig.noise === true);
                  return (
                    <div
                      key={opt.id}
                      onClick={() => {
                        setCvConfig((prev) => ({
                          ...prev,
                          noise: opt.id === "disabled" ? false : (opt.id as any),
                        }));
                        setSelectedPreset("Custom Preset");
                      }}
                      className={`p-4 border rounded-2xl cursor-pointer transition-all duration-200 select-none text-left flex items-start gap-4 min-h-[68px] ${
                        isSelected
                          ? "border-transparent bg-indigo-50 dark:bg-indigo-950/30 shadow-xs"
                          : "border-transparent bg-slate-50/50 hover:bg-slate-100/50 dark:bg-slate-900/40 dark:hover:bg-slate-800/40"
                      }`}
                    >
                      {/* Radio-like Selector Dot on the Left */}
                      <div className="mt-0.5 shrink-0 flex items-center justify-center">
                        <div
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                            isSelected
                              ? "border-indigo-600 dark:border-indigo-500"
                              : "border-slate-300 dark:border-slate-700"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-scale-in" />
                          )}
                        </div>
                      </div>

                      <div className="flex-1">
                        <span
                          className={`block font-bold text-sm ${
                            isSelected ? "text-indigo-900 dark:text-indigo-200" : "text-slate-800 dark:text-slate-100"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.desc && (
                          <p className={`text-xs mt-1 leading-relaxed ${
                            isSelected ? "text-indigo-700/85 dark:text-indigo-300/80" : "text-slate-500 dark:text-slate-400"
                          }`}>
                            {opt.desc}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer (Static) */}
            <div className="p-5 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-800/80 flex justify-end shrink-0 rounded-b-3xl">
              <button
                onClick={() => setActiveModal(null)}
                className="px-6 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-xl text-xs font-bold cursor-pointer duration-200 transition-all shadow-xs"
              >
                Close
              </button>
            </div>
          </motion.div>
        </div>
        )}
        </AnimatePresence>,
        document.body
      )}

      {/* 3. Studio Sound Options Modal */}
      {createPortal(
        <AnimatePresence>
        {activeModal === "studio_sound" && (
        <div key="studio_sound" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setActiveModal(null)}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[90vh] overflow-hidden relative z-20"
          >
            {/* Header (Static) */}
            <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
              <div className="text-left pr-8">
                <h3 className="text-lg font-black text-slate-800 dark:text-slate-50 tracking-tight">
                  Studio Sound Options
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Enhance audio to achieve professional studio-quality sound.
                </p>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all cursor-pointer shrink-0 ml-4"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body Container */}
            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar text-left">
              <div className="space-y-3">
                {[
                  {
                    id: "nightly",
                    label: "Nightly (Recommended)",
                    desc: "Use the bleeding edge of Studio Sound. Subject to change.",
                  },
                  {
                    id: "javelin",
                    label: "Javelin",
                    desc: "Flagship voice model. Ultra-clear professional high-fidelity studio enhancement.",
                  },
                  {
                    id: "standard",
                    label: "Standard",
                    desc: "Apply the standard Studio Sound enhancement.",
                  },
                  {
                    id: "repair",
                    label: "Repair",
                    desc: "Denoise the audio, then run Repair. Temporary experiment and may be removed soon.",
                  },
                  {
                    id: "studio_repair",
                    label: "Studio Repair",
                    desc: "Apply Studio Sound, then run Repair. Temporary experiment and may be removed soon.",
                  },
                  {
                    id: "disabled",
                    label: "Disabled",
                    desc: "Do not apply Studio Sound enhancement.",
                  },
                ].map((opt) => {
                  const isSelected = cvConfig.studio_sound === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => {
                        setCvConfig((prev) => ({
                          ...prev,
                          studio_sound: opt.id as any,
                        }));
                        setSelectedPreset("Custom Preset");
                      }}
                      className={`p-4 border rounded-xl cursor-pointer transition-all duration-200 select-none text-left flex items-start justify-between gap-4 min-h-[64px] ${
                        isSelected
                          ? "border-indigo-500 bg-indigo-50/15 dark:border-indigo-500 dark:bg-indigo-500/10 shadow-sm"
                          : "border-slate-200 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/40"
                      }`}
                    >
                      <div className="flex-1 pr-2">
                        <span
                          className={`block font-bold text-sm ${
                            isSelected ? "text-indigo-600 dark:text-indigo-400" : "text-slate-800 dark:text-slate-100"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.desc && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                            {opt.desc}
                          </p>
                        )}
                      </div>
                      {isSelected && (
                        <div className="text-indigo-600 dark:text-indigo-400 mt-0.5 shrink-0 ml-1">
                          <Check className="w-5 h-5" strokeWidth={2.5} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer (Static) */}
            <div className="p-5 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-800/80 flex justify-end gap-3 shrink-0 rounded-b-3xl">
              <button
                onClick={() => setActiveModal(null)}
                className="px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-semibold cursor-pointer duration-200 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => setActiveModal(null)}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold cursor-pointer duration-200 transition-all shadow-sm"
              >
                Apply
              </button>
            </div>
          </motion.div>
        </div>
        )}
        </AnimatePresence>,
        document.body
      )}

      {/* 4. Mastering Options Modal */}
      {createPortal(
        <AnimatePresence>
        {activeModal === "mastering" && (
        <div key="mastering" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setActiveModal(null)}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[90vh] overflow-hidden relative z-20"
          >
            {/* Header (Static) */}
            <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
              <div className="text-left pr-8">
                <h3 className="text-lg font-black text-slate-800 dark:text-slate-50 tracking-tight">
                  Mastering Options
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  This will apply mastering to the audio.
                </p>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all cursor-pointer shrink-0 ml-4"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body Container */}
            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar text-left">
              <div className="space-y-3">
                {[
                  {
                    id: "-14",
                    label: "Loud (-14 LUFS)",
                    desc: "Spotify, YouTube & Alexa loudness",
                  },
                  {
                    id: "-16",
                    label: "Podcast (-16 LUFS)",
                    desc: "Podcast standard — Apple & Google",
                  },
                  {
                    id: "-20",
                    label: "Audiobook (-20 LUFS)",
                    desc: "Audiobook / ACX loudness",
                  },
                  {
                    id: "-23",
                    label: "Broadcast (-23 LUFS)",
                    desc: "TV & radio broadcast (EBU R128)",
                  },
                  {
                    id: "disabled",
                    label: "Disabled",
                    desc: "Do not apply mastering to the audio.",
                  },
                ].map((opt) => {
                  const isSelected =
                    opt.id === "disabled"
                      ? !cvConfig.normalize || cvConfig.normalize === "disabled"
                      : cvConfig.normalize === opt.id || (opt.id === "-16" && cvConfig.normalize === true);
                  return (
                    <div
                      key={opt.id}
                      onClick={() => {
                        setCvConfig((prev) => ({
                          ...prev,
                          normalize: opt.id === "disabled" ? false : opt.id,
                        }));
                        setSelectedPreset("Custom Preset");
                      }}
                      className={`p-4 border rounded-2xl cursor-pointer transition-all duration-200 select-none text-left flex items-start gap-4 min-h-[68px] ${
                        isSelected
                          ? "border-indigo-600 bg-indigo-50/10 dark:border-indigo-500 dark:bg-indigo-500/10 shadow-sm"
                          : "border-slate-200 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/40"
                      }`}
                    >
                      {/* Left circular Radio button */}
                      <div className="mt-0.5 shrink-0">
                        {isSelected ? (
                          <div className="w-5 h-5 rounded-full border-2 border-indigo-600 dark:border-indigo-500 flex items-center justify-center bg-white dark:bg-slate-900 shadow-sm">
                            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 dark:bg-indigo-500" />
                          </div>
                        ) : (
                          <div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-700 bg-transparent" />
                        )}
                      </div>

                      {/* Right text panel */}
                      <div className="flex-1 pr-2">
                        <span
                          className={`block font-bold text-sm ${
                            isSelected
                              ? "text-indigo-600 dark:text-indigo-400"
                              : "text-slate-800 dark:text-slate-100"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.desc && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                            {opt.desc}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer (Static) */}
            <div className="p-5 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-800/80 flex justify-end gap-3 shrink-0 rounded-b-3xl">
              <button
                onClick={() => setActiveModal(null)}
                className="px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-semibold cursor-pointer duration-200 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => setActiveModal(null)}
                className="px-6 py-2 bg-slate-950 hover:bg-slate-900 text-white dark:bg-slate-50 dark:hover:bg-slate-100 dark:text-slate-950 rounded-xl text-xs font-bold cursor-pointer duration-200 shadow-sm transition-colors"
              >
                Apply
              </button>
            </div>
          </motion.div>
        </div>
        )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
