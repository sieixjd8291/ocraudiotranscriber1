import React, { useState, useRef, useEffect, useMemo } from 'react';
import { FileItem } from '../types';
import { GitMerge, Play, Pause, ArrowUp, ArrowDown, Music, AlertCircle, Loader2, Check, Settings } from 'lucide-react';
import { isAudioFile, preWarmWorkerPool, fastMergeAudioFiles, decodeAudioFile, bufferToMp3, getAudioContext, resampleAudioBuffer } from '../utils/audioUtils';

interface AudioMergerProps {
  files: FileItem[];
  onMergeComplete: (blob: Blob, name: string) => void;
}

export function AudioMerger({ files, onMergeComplete }: AudioMergerProps) {
  // Extract audio files
  const audioFiles = useMemo(() => files.filter(f => isAudioFile({ name: f.name, type: f.type })), [files]);

  // Audio durations tracking
  const [durations, setDurations] = useState<Record<string, number>>({});

  useEffect(() => {
    // Pre-initialize the MP3 encoder worker pool + FFmpeg engine (deferred to
    // first interaction, see audioUtils.preWarmWorkerPool) and a persistent
    // AudioContext to eliminate first-use latency.
    try {
      preWarmWorkerPool();
    } catch (e) {
      console.warn('Failed to pre-warm MP3 encoder worker pool:', e);
    }

    try {
      getAudioContext();
    } catch (e) {
      console.warn('Failed to pre-warm AudioContext:', e);
    }
  }, []);

  useEffect(() => {
    let active = true;

    const getAudioDuration = (file: File | Blob): Promise<number> => {
      if (file) {
        if ('metadataDuration' in file && typeof (file as any).metadataDuration === 'number' && (file as any).metadataDuration > 0) {
          return Promise.resolve((file as any).metadataDuration);
        }
        if ('duration' in file && typeof (file as any).duration === 'number' && (file as any).duration > 0) {
          return Promise.resolve((file as any).duration);
        }
      }
      return new Promise((resolve) => {
        const audio = new Audio();
        const url = URL.createObjectURL(file);
        audio.src = url;

        const timeoutId = setTimeout(() => {
          if (active) resolve(0);
          URL.revokeObjectURL(url);
        }, 5000);

        audio.addEventListener('loadedmetadata', () => {
          if (audio.duration === Infinity || isNaN(audio.duration)) {
            audio.currentTime = Number.MAX_SAFE_INTEGER;
            audio.addEventListener('timeupdate', () => {
              clearTimeout(timeoutId);
              const dur = audio.duration;
              if (active) resolve(dur === Infinity || isNaN(dur) ? 0 : dur);
              URL.revokeObjectURL(url);
            }, { once: true });
          } else {
            clearTimeout(timeoutId);
            if (active) resolve(audio.duration);
            URL.revokeObjectURL(url);
          }
        });

        audio.addEventListener('error', () => {
          clearTimeout(timeoutId);
          if (active) resolve(0);
          URL.revokeObjectURL(url);
        });
      });
    };

    const loadDurations = async () => {
      // Collect newly-computed durations in a local map, then merge them into
      // state with a single functional updater. This avoids reading `durations`
      // from the effect closure (which was stale because the dependency array
      // is `[audioFiles]`, not `durations`) and prevents concurrent effect runs
      // from clobbering each other's results.
      const computed: Record<string, number> = {};

      for (const item of audioFiles) {
        if (item.duration) {
          computed[item.id] = item.duration;
          continue;
        }
        try {
          const dur = await getAudioDuration(item.file);
          if (active) {
            computed[item.id] = dur;
          }
        } catch (e) {
          console.error("Error getting duration for file", item.name, e);
          if (active) {
            computed[item.id] = 0;
          }
        }
      }

      if (active && Object.keys(computed).length > 0) {
        setDurations((prev) => {
          let hasChanges = false;
          const next = { ...prev };
          // Only fill in entries that are still missing in state, so we never
          // overwrite a value computed by a concurrent/parallel effect run.
          for (const id of Object.keys(computed)) {
            if (next[id] === undefined) {
              next[id] = computed[id];
              hasChanges = true;
            }
          }
          return hasChanges ? next : prev;
        });
      }
    };

    loadDurations();

    return () => {
      active = false;
    };
  }, [audioFiles]);

  // Selection & ordering state
  const [isOnline, setIsOnline] = useState<boolean>(() => 
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState('');
  const [mergeError, setMergeError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [mergerQuality, setMergerQuality] = useState<"source" | "64" | "128" | "192" | "320">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("merger_output_bitrate");
      if (saved === "source" || saved === "64" || saved === "128" || saved === "192" || saved === "320") {
        return saved as "source" | "64" | "128" | "192" | "320";
      }
    }
    return "source";
  });
  
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem("merger_output_bitrate", mergerQuality);
  }, [mergerQuality]);

  const totalDuration = selectedIds.reduce((sum, id) => {
    return sum + (durations[id] || 0);
  }, 0);

  const formatDuration = (seconds: number): string => {
    if (seconds === 0 || isNaN(seconds) || seconds === Infinity || seconds === -Infinity) return 'Unknown';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 10);

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) {
      if (ms > 0 && h === 0 && m === 0) {
        parts.push(`${s}.${ms}s`);
      } else {
        parts.push(`${s}s`);
      }
    }
    return parts.join(' ');
  };

  // Local audio preview state
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track the currently-playing preview URL so we can revoke it when the user
  // pauses or switches files. Previously, object URLs created via
  // URL.createObjectURL were only revoked in the audio element's `onended`
  // handler — but pausing/switching never fires `ended`, so every preview of
  // an un-cleaned file leaked a blob URL.
  const activePreviewUrlRef = useRef<string | null>(null);
  const activePreviewIsObjectUrlRef = useRef<boolean>(false);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(item => item !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const moveItem = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === selectedIds.length - 1) return;

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    const newSelected = [...selectedIds];
    const temp = newSelected[index];
    newSelected[index] = newSelected[targetIndex];
    newSelected[targetIndex] = temp;
    setSelectedIds(newSelected);
  };

  const handlePlayPreview = (item: FileItem) => {
    // Helper: revoke the currently-active preview object URL (if any) and
    // reset tracking. Safe to call when nothing is active.
    const releaseActivePreviewUrl = () => {
      if (activePreviewIsObjectUrlRef.current && activePreviewUrlRef.current) {
        try { URL.revokeObjectURL(activePreviewUrlRef.current); } catch (_) {}
      }
      activePreviewUrlRef.current = null;
      activePreviewIsObjectUrlRef.current = false;
    };

    if (playingId === item.id) {
      // Toggling the SAME file off: pause and revoke the object URL we created.
      if (audioRef.current) {
        audioRef.current.pause();
      }
      releaseActivePreviewUrl();
      setPlayingId(null);
    } else {
      // Switching to a DIFFERENT file: pause the previous audio and revoke its
      // object URL before creating a new one (pause never fires `ended`).
      if (audioRef.current) {
        audioRef.current.pause();
      }
      releaseActivePreviewUrl();

      setPlayingId(item.id);
      let url = "";
      let isObjectUrl = false;
      if (item.useCleanedAudio && item.cleanvoiceResult?.cleanedUrl) {
        url = item.cleanvoiceResult.cleanedUrl;
      } else {
        url = URL.createObjectURL(item.file);
        isObjectUrl = true;
      }

      // Track this URL so any subsequent pause/switch/toggle can revoke it.
      activePreviewUrlRef.current = url;
      activePreviewIsObjectUrlRef.current = isObjectUrl;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play();
      audio.onended = () => {
        setPlayingId(null);
        // Natural end: revoke and clear tracking so we don't double-revoke later.
        releaseActivePreviewUrl();
      };
    }
  };

  const handleMerge = async (triggerDownload: boolean = false) => {
    if (selectedIds.length < 2) {
      setMergeError('Please select at least 2 audio files to merge.');
      return;
    }

    setIsMerging(true);
    setMergeError('');
    setMergeProgress('Initializing merge process...');

    try {
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      const selectedFilesItem = selectedIds
        .map(id => audioFiles.find(f => f.id === id))
        .filter((f): f is FileItem => f !== undefined);

      const filesToMerge: File[] = [];
      for (const item of selectedFilesItem) {
        if (signal.aborted) throw new Error('Merge cancelled by user.');
        if (item.useCleanedAudio && item.cleanvoiceResult?.cleanedUrl) {
          const urlToFetch = item.cleanvoiceResult.cleanedUrl;
          if (urlToFetch.startsWith('blob:') || isOnline) {
            setMergeProgress(`Fetching cleaned version for ${item.name}...`);
            let response;
            try {
              response = await fetch(urlToFetch, { signal });
              if (!response.ok) throw new Error("direct fetch fallback");
            } catch (err) {
              const proxyUrl = urlToFetch.startsWith("blob:") || urlToFetch.startsWith("/")
                ? urlToFetch
                : `/api/proxy-audio?url=${encodeURIComponent(urlToFetch)}`;
              response = await fetch(proxyUrl, { signal });
            }
            try {
              if (response.headers.get("content-type")?.includes("text/html")) {
                throw new Error("Proxy returned HTML");
              }
              if (response.ok) {
                const blob = await response.blob();
                let ext = 'mp3';
                try {
                  const urlObj = new URL(item.cleanvoiceResult.cleanedUrl, window.location.origin);
                  const urlFormat = urlObj.searchParams.get("format");
                  const urlFilename = urlObj.searchParams.get("filename");
                  if (urlFormat) {
                    ext = urlFormat;
                  } else if (urlFilename) {
                    ext = urlFilename.split('.').pop() || 'mp3';
                  } else {
                    ext = urlObj.pathname.split('.').pop() || 'mp3';
                  }
                } catch (e) {
                  ext = item.cleanvoiceResult.cleanedUrl.split('?')[0].split('#')[0].split('.').pop() || 'mp3';
                }
                ext = ext.split('&')[0].replace(/[^a-zA-Z0-9]/g, '');
                if (!ext) ext = 'mp3';

                filesToMerge.push(new File([blob], `${item.name.split('.')[0]}_cleaned.${ext}`, { type: blob.type || 'audio/mpeg' }));
                continue;
              }
            } catch (err) {
              console.warn(`Failed to fetch cleanvoice audio offline for ${item.name}, falling back to original`, err);
            }
          }
        }
        filesToMerge.push(item.file as File);
      }
      
      let finalBlob: Blob | null = null;
      let finalExt = 'mp3';

      // Dynamically calculate bitrates of input files from their sizes and loaded durations
      const detectedBitrates: number[] = [];
      filesToMerge.forEach((file, index) => {
        const item = selectedFilesItem[index];
        if (!item) return;
        const duration = durations[item.id] || item.duration || 0;
        if (file && duration > 0 && file.size > 0) {
          const rawKbps = (file.size * 8) / (duration * 1000);
          const standards = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
          const closest = standards.reduce((prev, curr) => 
            Math.abs(curr - rawKbps) < Math.abs(prev - rawKbps) ? curr : prev
          );
          detectedBitrates.push(closest);
        }
      });

      const allSameBitrate = detectedBitrates.length > 0 && detectedBitrates.every(b => b === detectedBitrates[0]);

      let kbps = 192; // default
      
      if (mergerQuality === "source") {
        if (allSameBitrate) {
          kbps = detectedBitrates[0];
        } else if (detectedBitrates.length > 0) {
          kbps = Math.max(...detectedBitrates);
        } else {
          kbps = 192;
        }
      } else {
        kbps = parseInt(mergerQuality, 10) || 192;
      }

      let nativeMergeFailed = false;
      if (isOnline) {
        // Online Path: utilize high-performance client-side native merging via WebAssembly FFmpeg.
        setMergeProgress('Initializing high-speed acoustic stitching...');
        
        try {
          const result = await fastMergeAudioFiles(
            filesToMerge, 
            (msg) => setMergeProgress(msg), 
            kbps,
            signal
          );
          finalBlob = result.blob;
          finalExt = result.ext;
          
          if (finalBlob) {
            (finalBlob as any).originalFiles = filesToMerge;
          }
        } catch (err: any) {
          const errStr = String(err?.message || err);
          if (signal?.aborted || err?.name === 'AbortError' || errStr.includes('AbortError') || errStr.includes('cancelled')) {
            throw err;
          }
          console.warn(`Failed to merge via high-speed native FFmpeg engine: ${errStr}. Falling back to Web Audio API merge engine.`);
          nativeMergeFailed = true;
        }
      }

      if (!isOnline || nativeMergeFailed) {
        // Offline/Fallback Path: gracefully fallback to high-performance client-side local merge using Web Audio API AudioContext & typed array memory copies.
        setMergeProgress('Initializing local on-device Web Audio merge...');
        
        const tempAudioCtx = getAudioContext();
        
        setMergeProgress('Decoding files in parallel...');
        const decodedBuffers = await Promise.all(
          filesToMerge.map(async (file) => {
            if (signal?.aborted) throw new Error('AbortError');
            return await decodeAudioFile(file, tempAudioCtx);
          })
        );
        
        if (decodedBuffers.length === 0) {
          throw new Error('No audio tracks could be decoded locally.');
        }
        
        const targetSampleRate = Math.max(...decodedBuffers.map(b => b.sampleRate));
        const targetChannels = Math.max(...decodedBuffers.map(b => b.numberOfChannels));
        
        setMergeProgress('Stitching audio segments natively...');
        
        const totalDurationCalculated = decodedBuffers.reduce((acc, b) => acc + b.duration, 0);
        const totalRenderSamples = Math.ceil(totalDurationCalculated * targetSampleRate);
        
        const OfflineCtxClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
        if (!OfflineCtxClass) {
          throw new Error('OfflineAudioContext is not supported in this browser.');
        }
        
        const offlineCtx = new OfflineCtxClass(
          targetChannels,
          totalRenderSamples || 1,
          targetSampleRate
        );
        
        let timelineCursor = 0;
        for (const buffer of decodedBuffers) {
          const source = offlineCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(offlineCtx.destination);
          source.start(timelineCursor);
          timelineCursor += buffer.duration;
        }
        
        setMergeProgress('Running native hardware render...');
        const renderedBuffer = await offlineCtx.startRendering();
        
        setMergeProgress(`Locally encoding audio to MP3 at ${kbps}kbps...`);
        const updateEncodingProgress = (p: number) => {
          if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => {
              setMergeProgress(`Encoding MP3: ${Math.round(p * 100)}%`);
            });
          } else {
            setMergeProgress(`Encoding MP3: ${Math.round(p * 100)}%`);
          }
        };
        
        const localMp3 = await bufferToMp3(renderedBuffer, kbps, updateEncodingProgress);
        
        finalBlob = localMp3;
        finalExt = 'mp3';
        
        if (finalBlob) {
          (finalBlob as any).originalFiles = filesToMerge;
        }
      }

      // 6. Complete and add back
      const cleanDate = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const mergedName = `merged_session_${cleanDate.replace(/:/g, '-')}.${finalExt}`;
      
      if (finalBlob && totalDuration > 0) {
        (finalBlob as any).metadataDuration = totalDuration;
      }
      onMergeComplete(finalBlob, mergedName);

      // 7. Direct File Download if requested
      if (triggerDownload) {
        setMergeProgress('Initiating computer file download...');
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = mergedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Clean up inside a timeout to ensure stream reads complete
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      
      setMergeProgress(triggerDownload ? 'Successfully exported & downloaded!' : 'Successfully merged!');
      setSelectedIds([]);
      setTimeout(() => {
        setMergeProgress('');
      }, 3050);
    } catch (err: any) {
      const errStr = String(err?.message || err);
      if (
        abortControllerRef.current?.signal.aborted || 
        err?.name === 'AbortError' || 
        errStr.includes('AbortError') || 
        errStr.includes('cancelled')
      ) {
        setMergeError('');
        setMergeProgress('');
      } else {
        console.error('Audio merging error:', err);
        setMergeError(err.message || 'An unexpected error occurred during audio stitching.');
      }
    } finally {
      setIsMerging(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelMerge = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
          <GitMerge className="w-5 h-5" />
          <h3 className="text-sm font-bold uppercase tracking-wider">Audio Merger</h3>
        </div>
        
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-500 hover:text-indigo-600 cursor-pointer ${showSettings ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400' : ''}`}
          aria-label="Configure Output Bitrate"
          data-tooltip="Configure Output Bitrate"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
        Processed <strong>instantly & privately</strong> right in your browser for maximum speed—your audio never leaves your device.
      </p>

      {showSettings && (
        <div className="bg-slate-50 dark:bg-slate-950/30 p-2.5 rounded-xl border border-slate-200/60 dark:border-slate-800/80 mb-2 mt-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Stitch Audio Output Quality</span>
            <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-1.5 py-0.5 rounded-md font-semibold">
              {mergerQuality === 'source' ? 'Source Match (Dynamic)' : `${mergerQuality} kbps`}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {(['source', '64', '128', '192', '320'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setMergerQuality(opt)}
                className={`py-1 px-0 flex items-center justify-center font-bold rounded-lg border transition cursor-pointer uppercase overflow-hidden ${
                  opt === 'source' ? 'text-[9px] tracking-tight' : 'text-[10px] tracking-wide'
                } ${
                  mergerQuality === opt
                    ? 'bg-indigo-600 text-white border-indigo-600 dark:border-indigo-500 shadow-xs'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200/70 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      {audioFiles.length === 0 ? (
        <div className="border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-4 text-center text-xs text-slate-500 dark:text-slate-300 bg-slate-50/50 dark:bg-slate-950/20">
          No audio files in the queue.
          <p className="text-[10px] mt-1 text-slate-500 dark:text-slate-300">
            Upload recordings or audio clips to merge them here.
          </p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {/* File Checklist */}
          <div className="max-h-60 overflow-y-auto border border-slate-100 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800/50 bg-white dark:bg-slate-950/40 shadow-inner">
            {audioFiles.map((item) => {
              const isSelected = selectedIds.includes(item.id);
              const orderIndex = selectedIds.indexOf(item.id);
              return (
                <div 
                  key={item.id} 
                  className={`flex items-center justify-between p-2.5 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                    isSelected ? 'bg-indigo-50/20 dark:bg-indigo-950/10' : ''
                  }`}
                >
                  <label className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0 pr-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(item.id)}
                      className="rounded border-slate-300 dark:border-slate-800 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer accent-indigo-600"
                    />
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <Music className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate flex items-center gap-1.5" data-tooltip={item.name}>
                        {item.name}
                        {item.useCleanedAudio && <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">✨ Cleanvoice</span>}
                      </span>
                      {durations[item.id] !== undefined ? (
                        <span className="text-[10px] font-mono font-medium text-slate-500 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded shrink-0">
                          {formatDuration(durations[item.id])}
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono text-slate-500 dark:text-slate-300 animate-pulse shrink-0">
                          ...
                        </span>
                      )}
                    </div>
                  </label>

                  <div className="flex items-center gap-1 shrink-0">
                    {/* Preview Button */}
                    <button
                      onClick={() => handlePlayPreview(item)}
                      className={`p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-indigo-600 cursor-pointer transition-colors text-slate-500`}
                      aria-label={playingId === item.id ? "Pause Preview" : "Play Preview"}
                      data-tooltip="Preview Audio clip"
                    >
                      {playingId === item.id ? (
                        <Pause className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Order Indicator & Shifting controls */}
                    {isSelected && (
                      <div className="flex items-center gap-1 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900 px-1.5 py-0.5 rounded-md">
                        <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap select-none mr-1 font-mono">
                          #{orderIndex + 1}
                        </span>
                        
                        <button
                          onClick={() => moveItem(orderIndex, 'up')}
                          disabled={orderIndex === 0}
                          className="p-0.5 text-slate-500 dark:text-slate-300 hover:text-indigo-600 disabled:opacity-30 cursor-pointer"
                          aria-label="Move up in merge sequence"
                          data-tooltip="Move up in merge sequence"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>

                        <button
                          onClick={() => moveItem(orderIndex, 'down')}
                          disabled={orderIndex === selectedIds.length - 1}
                          className="p-0.5 text-slate-500 dark:text-slate-300 hover:text-indigo-600 disabled:opacity-30 cursor-pointer"
                          aria-label="Move down in merge sequence"
                          data-tooltip="Move down in merge sequence"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Merge controls */}
          <div className="pt-1 select-none">
            {selectedIds.length > 0 && (
              <div className="mt-1 mb-3 bg-slate-50 dark:bg-slate-950/40 rounded-xl p-3 border border-slate-100 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-300 font-semibold select-none">Selected Items:</span>
                  <span className="font-bold text-slate-700 dark:text-slate-200">{selectedIds.length} tracks</span>
                </div>
                <div className="flex items-center justify-between text-xs border-t border-slate-100 dark:border-slate-800/40 pt-2">
                  <span className="text-indigo-600 dark:text-indigo-400 font-bold select-none">Merged Duration:</span>
                  <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-50/50 dark:bg-indigo-950/50 px-2 py-0.5 rounded-md border border-indigo-100/50 dark:border-indigo-900/30">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
              </div>
            )}

            {mergeError && (
              <div className="flex items-start gap-1.5 text-rose-600 dark:text-rose-400 text-xs bg-rose-50/50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-950/30 p-2.5 rounded-xl mb-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{mergeError}</span>
              </div>
            )}

            {mergeProgress && (
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 text-xs bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-950/30 p-2.5 rounded-xl mb-3">
                {isMerging ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                ) : (
                  <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                )}
                <span className="font-semibold">{mergeProgress}</span>
              </div>
            )}

            <div className="w-full">
              {isMerging ? (
                <button
                  onClick={handleCancelMerge}
                  className="w-full py-2.5 px-3 bg-rose-100 hover:bg-rose-200 dark:bg-rose-950 dark:hover:bg-rose-900 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer border border-transparent"
                  data-tooltip="Cancel ongoing merge process"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Cancel Merging...
                </button>
              ) : (
                <button
                  onClick={() => handleMerge(false)}
                  disabled={selectedIds.length < 2}
                  className="w-full py-2.5 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-100 dark:disabled:bg-slate-900 text-white disabled:text-slate-500 dark:disabled:text-slate-600 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed border dark:border-transparent dark:disabled:border-slate-800"
                  data-tooltip="Stitch selected audios and append back to file list"
                >
                  <GitMerge className="w-3.5 h-3.5 text-indigo-200" />
                  Merge to Queue
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
