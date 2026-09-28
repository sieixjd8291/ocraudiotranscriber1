import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Play, Pause, Square, ZoomIn, ZoomOut, Scissors, Crop, 
  VolumeX, Volume2, RotateCcw, Download, Save, 
  Loader2, Music, Copy, ClipboardPaste, Trash2, Activity, ChevronDown
} from 'lucide-react';
import { bufferToMp3, bufferToMp3Fast, bufferToWavAsync, sliceAudioBuffer, deleteAudioBufferRegion, decodeAudioFile, preWarmWorkerPool } from '../utils/audioUtils';
import { toast } from 'sonner';
import { MemoryTracker } from '../utils/memoryTracker';

import {
  audioBufferCache,
  audioBitrateCache,
  checkAndCleanCache,
  clearAudioBufferCache,
  evictAudioBufferCache,
} from "../utils/audioBufferCache";

const formatTime = (sec: number) => {
  if (isNaN(sec)) return '0:00.00';
  const totalRoundedSec = Math.round(sec * 100) / 100;
  const min = Math.floor(totalRoundedSec / 60);
  const remainder = totalRoundedSec % 60;
  const secondsRounded = remainder.toFixed(2);
  const prefix = remainder < 10 ? '0' : '';
  return `${min}:${prefix}${secondsRounded}`;
};

interface WaveformAudioEditorProps {
  file?: File | Blob | null;
  audioUrl?: string | null;
  fileName?: string;
  onUpdateFile?: (newFile: Blob | File) => void;
  audioSource?: 'original' | 'refined';
  onToggleAudioSource?: (source: 'original' | 'refined') => void;
  sourceBitrate?: string | number | null;
}

export function WaveformAudioEditor({ 
  file, 
  audioUrl, 
  fileName = 'audio.mp3', 
  onUpdateFile,
  audioSource = 'original',
  sourceBitrate
}: WaveformAudioEditorProps) {
  // Buffers
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [activeBuffer, setActiveBuffer] = useState<AudioBuffer | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Layout & Interaction
  const [zoomLevel, setZoomLevel] = useState<number>(1); // Range: 1 to 25
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [scrollLeft, setScrollLeft] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const playbackSpeedRef = useRef<number>(1.0);
  const [loop, setLoop] = useState<boolean>(false);
  const [playSelectionOnly, setPlaySelectionOnly] = useState<boolean>(false);

  // Selections
  const [selectionStart, setSelectionStart] = useState<number>(0);
  const [selectionEnd, setSelectionEnd] = useState<number>(0);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Clipboard
  const [clipboardBuffer, setClipboardBuffer] = useState<AudioBuffer | null>(null);

  // History stack for Undo
  const [history, setHistory] = useState<{ activeBuffer: AudioBuffer; selectionStart: number; selectionEnd: number; currentTime: number }[]>([]);

  // Encoding & Exporting State
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const selectedFormat = 'mp3';

  const initialBitrate = useMemo(() => {
    if (sourceBitrate) {
      const matched = String(sourceBitrate).match(/\d+/);
      if (matched) {
        return parseInt(matched[0], 10);
      }
    }
    return 192;
  }, [sourceBitrate]);

  const [mp3Bitrate, setMp3Bitrate] = useState<number>(initialBitrate);
  const [showBitrateDropdown, setShowBitrateDropdown] = useState<boolean>(false);
  const [nativeBitrate, setNativeBitrate] = useState<number>(initialBitrate);

  useEffect(() => {
    setNativeBitrate(initialBitrate);
    setMp3Bitrate(initialBitrate);
  }, [initialBitrate]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ─── Non-Destructive Gain / Volume Adjustment State ───
  const [gainDb, setGainDb] = useState<number>(0);               // Current gain in dB (-30 to +30)
  const [showGainPopover, setShowGainPopover] = useState<boolean>(false);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compressorNodeRef = useRef<DynamicsCompressorNode | null>(null);
  const gainPopoverRef = useRef<HTMLDivElement>(null);
  // Latest gain (dB) mirror so canvas redraws (scroll/resize/gain) always read
  // the current value without each caller needing gainDb in its dependency list.
  const gainDbRef = useRef<number>(0);

  const GAIN_MIN_DB = -30;
  const GAIN_MAX_DB = 30;

  // Position of 0 dB on the slider track as a percentage.
  // With a symmetric ±30 dB range, 0 dB lands exactly at the midpoint (50%).
  const GAIN_ZERO_DB_PCT = ((0 - GAIN_MIN_DB) / (GAIN_MAX_DB - GAIN_MIN_DB)) * 100; // 50%

  // Convert dB to linear gain: gain = 10^(dB/20)
  const dbToLinearGain = (dB: number): number => Math.pow(10, dB / 20);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowBitrateDropdown(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && showBitrateDropdown) {
        event.stopPropagation();
        setShowBitrateDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showBitrateDropdown]);

  // Click-outside handler for gain popover
  useEffect(() => {
    function handleClickOutsideGain(event: MouseEvent) {
      if (gainPopoverRef.current && !gainPopoverRef.current.contains(event.target as Node)) {
        setShowGainPopover(false);
      }
    }
    function handleEscapeGain(event: KeyboardEvent) {
      if (event.key === "Escape" && showGainPopover) {
        event.stopPropagation();
        setShowGainPopover(false);
      }
    }
    if (showGainPopover) {
      document.addEventListener("mousedown", handleClickOutsideGain);
      document.addEventListener("keydown", handleEscapeGain);
      return () => {
        document.removeEventListener("mousedown", handleClickOutsideGain);
        document.removeEventListener("keydown", handleEscapeGain);
      };
    }
  }, [showGainPopover]);

  // Live-update the GainNode and re-draw the waveform whenever gainDb changes.
  // The gain amplitude is now baked into the canvas bars, so a gain change must
  // trigger a redraw for the visual to track the slider in real time.
  useEffect(() => {
    gainDbRef.current = gainDb;
    if (gainNodeRef.current) {
      const ctx = gainNodeRef.current.context;
      const linear = dbToLinearGain(gainDb);
      gainNodeRef.current.gain.setValueAtTime(linear, ctx.currentTime);
    }
    drawWaveform();
  }, [gainDb]);

  // Pre-warm the lamejs worker pool + FFmpeg WASM engine on mount so the first
  // export is nearly instant instead of paying spin-up latency (~200-400ms).
  // The heavy WASM fetch is deferred to the first interaction (see
  // audioUtils.preWarmWorkerPool) so merely opening the editor doesn't pull the
  // ~9.7MB core into the page load.
  useEffect(() => {
    preWarmWorkerPool(1);
  }, []);

  // Page Visibility API handler to pause and suspend immediately when hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (isPlaying) {
          stopPlayback();
        } else if (audioCtxRef.current && audioCtxRef.current.state === 'running') {
          audioCtxRef.current.suspend().catch(console.error);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPlaying]);

  // Audio nodes and engine
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Close and dispose of the Web Audio Context completely when the editor is unmounted to prevent memory/resource leaks
  useEffect(() => {
    return () => {
      if (gainNodeRef.current) {
        try { gainNodeRef.current.disconnect(); } catch (e) {}
        gainNodeRef.current = null;
      }
      if (compressorNodeRef.current) {
        try { compressorNodeRef.current.disconnect(); } catch (e) {}
        compressorNodeRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(e => console.warn("Failed to close AudioContext during unmount:", e));
        audioCtxRef.current = null;
      }
    };
  }, []);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playStartTimeRef = useRef<number>(0);
  const playStartOffsetRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  const canvasInactiveRef = useRef<HTMLCanvasElement | null>(null);
  const canvasActiveRef = useRef<HTMLCanvasElement | null>(null);
  const miniCanvasInactiveRef = useRef<HTMLCanvasElement | null>(null);
  const miniCanvasActiveRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const miniContainerRef = useRef<HTMLDivElement | null>(null);

  // HTML Direct-Style-Manipulation Performance Refs for buttery 60fps tracking
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const activeWaveformContainerRef = useRef<HTMLDivElement | null>(null);
  const miniActiveWaveformContainerRef = useRef<HTMLDivElement | null>(null);
  const miniPlayheadRef = useRef<HTMLDivElement | null>(null);
  const miniCenterDividerRef = useRef<HTMLDivElement | null>(null);
  const currentTimeSpanRef = useRef<HTMLSpanElement | null>(null);

  const currentTimeRef = useRef<number>(0);
  const lastReactUpdateTimeRef = useRef<number>(0);

  // Synchronise playhead styling in real-time
  const updatePlayheadDOM = (targetTime: number) => {
    if (!activeBuffer) return;
    const dur = activeBuffer.duration;
    if (dur <= 0) return;
    const pct = `${(targetTime / dur) * 100}%`;

    if (playheadRef.current) {
      playheadRef.current.style.left = pct;
    }
    if (activeWaveformContainerRef.current) {
      activeWaveformContainerRef.current.style.width = pct;
    }
    if (miniActiveWaveformContainerRef.current) {
      miniActiveWaveformContainerRef.current.style.width = pct;
    }
    if (miniPlayheadRef.current) {
      miniPlayheadRef.current.style.left = pct;
    }
    if (miniCenterDividerRef.current) {
      miniCenterDividerRef.current.style.left = pct;
    }
    if (currentTimeSpanRef.current) {
      currentTimeSpanRef.current.textContent = `Current: ${formatTime(targetTime)}`;
    }
  };

  // Automated sync between React currentTime state and refs whenever it gets committed
  useEffect(() => {
    currentTimeRef.current = currentTime;
    updatePlayheadDOM(currentTime);
  }, [currentTime, activeBuffer]);

  // Pixels per second matching zoom level
  const pxPerSec = useMemo(() => {
    const rawPxPerSec = 15 * zoomLevel;
    if (!activeBuffer || activeBuffer.duration <= 0) return rawPxPerSec;

    const duration = activeBuffer.duration;
    const containerWidthVal = containerWidth > 0 ? containerWidth : 800;
    const minPxPerSec = containerWidthVal / duration;
    
    // Ensure the track spans at least the container layout width, and allow standard uninhibited zoom
    return Math.max(minPxPerSec, rawPxPerSec);
  }, [zoomLevel, activeBuffer, containerWidth]);

  // Decode the sound file on mount or file/url change
  useEffect(() => {
    let aborted = false;
    const decodeAudio = async () => {
      setIsDecoding(true);
      setErrorMsg(null);
      stopPlayback();
      
      let cacheKey = '';
      let blobInput: Blob | File | null = null;
      try {
        const audioCtx = initAudioCtx();
        
        if (audioUrl) {
          cacheKey = audioUrl;
        } else if (file) {
          cacheKey = `${(file as File).name || 'audio'}_${file.size}`;
          blobInput = file;
        }

        if (cacheKey) {
          const cachedPromiseOrValue = audioBufferCache.get(cacheKey);
          if (cachedPromiseOrValue) {
            console.log(`Cache hit for decoding: ${cacheKey}`);
            const cachedValue = await cachedPromiseOrValue;
            if (aborted) return;
            setOriginalBuffer(cachedValue);
            setActiveBuffer(cachedValue);
            setSelectionStart(0);
            setSelectionEnd(cachedValue.duration);
            setCurrentTime(0);
            setIsDecoding(false);
            
            // Restore the cached bitrate if available
            const cachedBitrate = audioBitrateCache.get(cacheKey);
            if (cachedBitrate) {
              setNativeBitrate(cachedBitrate);
              setMp3Bitrate(cachedBitrate);
            }
            return;
          }
        }

        if (audioUrl) {
          try {
            const res = await fetch(audioUrl);
            blobInput = await res.blob();
          } catch (fetchErr) {
            // Direct fetch failed (e.g. CORS on remote S3 URLs).
            // Try the server-side proxy-audio endpoint as a fallback.
            console.warn("Failed to fetch audio from URL directly, trying proxy fallback...", fetchErr);
            try {
              const proxyUrl = audioUrl.startsWith("blob:") || audioUrl.startsWith("/")
                ? audioUrl
                : `/api/proxy-audio?url=${encodeURIComponent(audioUrl)}`;
              const proxyRes = await fetch(proxyUrl);
              if (proxyRes.headers.get("content-type")?.includes("text/html")) {
                throw new Error("Proxy returned HTML");
              }
              blobInput = await proxyRes.blob();
            } catch (proxyErr) {
              console.warn("Proxy fetch also failed, trying file fallback...", proxyErr);
              if (file) {
                blobInput = file;
              } else {
                throw proxyErr;
              }
            }
          }
        } else if (file) {
          blobInput = file;
        } else {
          setIsDecoding(false);
          return;
        }

        if (aborted) return;
        
        // Put the promise into the cache so subsequent toggles in flight will await the same promise
        let decodePromise: Promise<AudioBuffer>;
        if (blobInput) {
          decodePromise = decodeAudioFile(blobInput, audioCtx);
          if (cacheKey) {
            checkAndCleanCache();
            audioBufferCache.set(cacheKey, decodePromise);
          }
        } else {
          throw new Error("No valid sound file input provided.");
        }

        const decoded = await decodePromise;
        if (aborted) return;
        
        // Save final decoded AudioBuffer to cache
        if (cacheKey) {
          audioBufferCache.set(cacheKey, decoded);
        }

        // Register with MemoryTracker (channels * length * 4 bytes per sample float32)
        try {
          const estimatedSize = decoded.numberOfChannels * decoded.length * 4;
          MemoryTracker.register(
            decoded, 
            `AudioBuffer: ${fileName || 'Decoded Track'} (${Math.round(decoded.duration)}s)`, 
            "AudioBuffer", 
            estimatedSize
          );
        } catch (trackerErr) {
          console.warn("[WaveformAudioEditor] MemoryTracker registration skipped:", trackerErr);
        }
        
        setOriginalBuffer(decoded);
        setActiveBuffer(decoded);
        setSelectionStart(0);
        setSelectionEnd(decoded.duration);
        setCurrentTime(0);
        
        // Smart dynamic bitrate detection from the loaded File/Blob info & decoded duration
        let parsedSourceBitrate: number | null = null;
        if (sourceBitrate) {
          const matched = String(sourceBitrate).match(/\d+/);
          if (matched) {
            parsedSourceBitrate = parseInt(matched[0], 10);
          }
        }

        if (parsedSourceBitrate && parsedSourceBitrate > 0) {
          setNativeBitrate(parsedSourceBitrate);
          setMp3Bitrate(parsedSourceBitrate);
          if (cacheKey) {
            audioBitrateCache.set(cacheKey, parsedSourceBitrate);
          }
          console.log(`Using prop sourceBitrate: ${parsedSourceBitrate}kbps.`);
        } else if (blobInput && blobInput.size && decoded.duration) {
          const estimatedBps = (blobInput.size * 8) / decoded.duration;
          const estimatedKbps = estimatedBps / 1000;
          
          const standards = [192, 128, 96, 64];
          let closest = 192;
          let minDiff = Math.abs(estimatedKbps - 192);
          for (const r of standards) {
            const diff = Math.abs(estimatedKbps - r);
            if (diff < minDiff) {
              minDiff = diff;
              closest = r;
            }
          }
          setNativeBitrate(closest);
          setMp3Bitrate(closest);
          if (cacheKey) {
            audioBitrateCache.set(cacheKey, closest);
          }
          console.log(`Smart bitrate detection: size=${blobInput.size} bytes, duration=${decoded.duration}s -> estimated kbps=${estimatedKbps.toFixed(2)}. Selected closest standard: ${closest}kbps.`);
        } else {
          setNativeBitrate(192);
          setMp3Bitrate(192);
          if (cacheKey) {
            audioBitrateCache.set(cacheKey, 192);
          }
        }
        
        toast.success("Audio loaded into Waveform Editor!");
      } catch (err: any) {
        // Structured logging to pinpoint structural/codec corruption vs.
        // codec support gaps without breaking the application wrapper.
        const inputDesc = blobInput
          ? `name="${(blobInput as File).name || '<blob>'}", type="${blobInput.type || '<empty>'}", size=${blobInput.size} bytes`
          : audioUrl
          ? `url="${audioUrl}"`
          : '<no input>';
        console.error(
          `[WaveformAudioEditor] Decoding audio failed for ${inputDesc} (source=${audioSource}, fileName="${fileName}"):`,
          err
        );
        setErrorMsg(err?.message || "Failed to decode audio. Make sure it is a valid format.");
      } finally {
        if (!aborted) {
          setIsDecoding(false);
        }
      }
    };

    decodeAudio();

    return () => {
      aborted = true;
      stopPlayback();
    };
  }, [file, audioUrl]);

  // Decimate audio data once upon loading. Computed asynchronously in chunks
  // (yields to the event loop between batches) so a long recording (3-5+ min)
  // never blocks the main thread — the previous synchronous useMemo froze the
  // whole card for seconds on large buffers (the "loading hang" symptom).
  const [peaksData, setPeaksData] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!activeBuffer || activeBuffer.numberOfChannels === 0) {
      setPeaksData(null);
      return;
    }
    let cancelled = false;
    const numChannels = activeBuffer.numberOfChannels;
    const peaksPerSecond = 1000;
    const numPeaks = Math.max(1000, Math.floor(activeBuffer.duration * peaksPerSecond));
    const peaks = new Float32Array(numPeaks);
    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(activeBuffer.getChannelData(c));
    }
    const totalSamples = channels[0].length;
    const step = Math.max(1, Math.floor(totalSamples / numPeaks));
    // Process at most ~50k peaks per tick, then yield via setTimeout(0).
    const CHUNK = 50000;

    const processChunk = (fromIdx: number) => {
      if (cancelled) return;
      const toIdx = Math.min(numPeaks, fromIdx + CHUNK);
      for (let i = fromIdx; i < toIdx; i++) {
        const start = i * step;
        const end = Math.min(totalSamples, start + step);
        let maxVal = 0;
        for (let c = 0; c < numChannels; c++) {
          const data = channels[c];
          for (let j = start; j < end; j++) {
            const val = Math.abs(data[j]);
            if (val > maxVal) maxVal = val;
          }
        }
        peaks[i] = maxVal;
      }
      if (toIdx < numPeaks) {
        setTimeout(() => processChunk(toIdx), 0);
      } else if (!cancelled) {
        setPeaksData(peaks);
      }
    };
    processChunk(0);

    return () => { cancelled = true; };
  }, [activeBuffer]);

  // Spaced-bar canvas drawer for high-quality symmetrical audio waveforms (Cleanvoice style)
  const drawWaveformOnCanvas = (canvas: HTMLCanvasElement, color: string, isMini: boolean, currentScrollLeft: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !activeBuffer || !peaksData) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.scale(dpr, dpr);

    const logicalWidth = width / dpr;
    const logicalHeight = height / dpr;
    const amp = logicalHeight / 2;
    // Visual gain: amplify the bars directly on the canvas so they stay razor-sharp
    // at any volume. We clamp peaks so heavy boosts clip against the canvas edge
    // (mirroring the limiter on the actual audio) instead of being upscaled via a
    // blurry CSS scaleY() transform.
    const visualGain = Math.max(0.01, dbToLinearGain(gainDbRef.current));

    if (isMini) {
      // Mini overview draws the entire audio file across its width
      const barWidth = 1.5;
      const barGap = 1.0;
      const barStep = barWidth + barGap;
      ctx.lineWidth = barWidth;
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      
      const numPeaks = peaksData.length;
      ctx.beginPath();
      for (let x = 0; x < logicalWidth; x += barStep) {
        const pct = x / logicalWidth;
        const peakIdx = Math.max(0, Math.min(numPeaks - 1, Math.floor(pct * numPeaks)));
        let h = (peaksData[peakIdx] || 0) * amp * 0.92 * visualGain;
        if (h < 1.0) h = 1.0;
        if (h > amp) h = amp;

        ctx.moveTo(x + barWidth / 2, amp - h);
        ctx.lineTo(x + barWidth / 2, amp + h);
      }
      ctx.stroke();
    } else {
      // Main timeline: Draw ONLY the visible section in the viewport
      const barWidth = 2.5;
      const barGap = 1.5;
      const barStep = barWidth + barGap;
      ctx.lineWidth = barWidth;
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;

      const totalWidth = Math.max(containerWidth, activeBuffer.duration * pxPerSec);
      const numPeaks = peaksData.length;

      // Ensure that as we scroll, the bars stay stationary relative to the timeline start
      const startOffset = currentScrollLeft % barStep;
      
      ctx.beginPath();
      for (let canvasX = -startOffset; canvasX < logicalWidth; canvasX += barStep) {
        if (canvasX < -barWidth) continue; // Skip if off-screen to the left
        const trackX = currentScrollLeft + canvasX;
        const pct = trackX / totalWidth;
        if (pct < 0 || pct > 1.01) continue;

        const peakIdx = Math.max(0, Math.min(numPeaks - 1, Math.floor(pct * numPeaks)));
        let h = (peaksData[peakIdx] || 0) * amp * 0.92 * visualGain;
        if (h < 2.0) h = 2.0;
        if (h > amp) h = amp;

        ctx.moveTo(canvasX + barWidth / 2, amp - h);
        ctx.lineTo(canvasX + barWidth / 2, amp + h);
      }
      ctx.stroke();
    }

    ctx.restore();
  };

  const drawWaveform = () => {
    if (!activeBuffer || !peaksData) return;

    // Direct, real-time scroll offset reading from the container DOM node for buttery, zero-lag rendering
    const currentScrollLeft = containerRef.current ? containerRef.current.scrollLeft : scrollLeft;

    // Keep the viewport-pinned main canvases perfectly aligned with the live scroll
    // position. Positioning them via the React scrollLeft state lags the draw by a frame
    // (and can hold a stale value after a buffer swap), which makes the waveform render
    // jittery ("improper") or pushed off-screen ("blank"). Driving both the canvas `left`
    // and the draw from the exact same currentScrollLeft value guarantees they stay in lockstep.
    const pinnedLeft = `${currentScrollLeft}px`;
    if (canvasActiveRef.current) {
      canvasActiveRef.current.style.left = pinnedLeft;
    }
    if (canvasInactiveRef.current) {
      canvasInactiveRef.current.style.left = pinnedLeft;
    }

    const activeColor = '#4f46e5';
    const inactiveColor = 'rgba(79, 70, 229, 0.15)';

    // Draw main zoomed active (played) canvas
    if (canvasActiveRef.current) {
      drawWaveformOnCanvas(canvasActiveRef.current, activeColor, false, currentScrollLeft);
    }
    // Draw main zoomed inactive (unplayed/future) canvas
    if (canvasInactiveRef.current) {
      drawWaveformOnCanvas(canvasInactiveRef.current, inactiveColor, false, currentScrollLeft);
    }

    // Draw mini overview active (played) canvas
    if (miniCanvasActiveRef.current) {
      drawWaveformOnCanvas(miniCanvasActiveRef.current, activeColor, true, currentScrollLeft);
    }
    // Draw mini overview inactive (unplayed) canvas
    if (miniCanvasInactiveRef.current) {
      drawWaveformOnCanvas(miniCanvasInactiveRef.current, inactiveColor, true, currentScrollLeft);
    }
  };

  // Unified effect for native scroll optimization with zero-lag requestAnimationFrame draws
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let drawingRafId: number | null = null;
    const handleScroll = () => {
      if (drawingRafId) return;
      drawingRafId = requestAnimationFrame(() => {
        drawingRafId = null;
        const currentScroll = container.scrollLeft;
        // Keep React state in sync asynchronously 
        setScrollLeft(currentScroll);
        // Redraw immediately for perfect synchrony with browser scroll thread
        drawWaveform();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (drawingRafId) cancelAnimationFrame(drawingRafId);
    };
  }, [activeBuffer, peaksData, zoomLevel, pxPerSec, containerWidth]);

  // Synchronise redrawing on resize / zoom / active buffer changes
  useEffect(() => {
    drawWaveform();
  }, [activeBuffer, peaksData, zoomLevel, pxPerSec, containerWidth]);

  // Synchronize container width on mount and resize using a local ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setContainerWidth(el.clientWidth);

    const observer = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      setContainerWidth(entries[0].contentRect.width);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [activeBuffer]);

  // Adjust canvas widths matching the observed container width
  useEffect(() => {
    if (activeBuffer && containerWidth > 0) {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const physicalWidth = containerWidth * dpr;
      
      // Resize main zoomable canvases to exactly the viewport width (no stretching, razor sharp!)
      if (canvasActiveRef.current) {
        canvasActiveRef.current.width = physicalWidth;
        canvasActiveRef.current.height = 140 * dpr;
      }
      if (canvasInactiveRef.current) {
        canvasInactiveRef.current.width = physicalWidth;
        canvasInactiveRef.current.height = 140 * dpr;
      }

      // Resize bottom mini overview canvases to exactly the viewport width
      if (miniCanvasActiveRef.current) {
        miniCanvasActiveRef.current.width = physicalWidth;
        miniCanvasActiveRef.current.height = 30 * dpr;
      }
      if (miniCanvasInactiveRef.current) {
        miniCanvasInactiveRef.current.width = physicalWidth;
        miniCanvasInactiveRef.current.height = 30 * dpr;
      }

      drawWaveform();
    }
  }, [activeBuffer, containerWidth]);

  // Keep the canvas CSS `left` (which follows the React scrollLeft state) perfectly
  // in sync with the live DOM scroll position whenever the track is swapped or resized.
  // Without this, a stale scrollLeft (e.g. left over from a longer original track when
  // switching to a shorter cleanvoice track) pushes the viewport-pinned canvases off-screen,
  // making the waveform render completely blank.
  const lastBufferRef = useRef<AudioBuffer | null>(null);
  useEffect(() => {
    if (!activeBuffer) {
      lastBufferRef.current = null;
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    // When the underlying buffer identity changes (original <-> cleanvoice toggle,
    // crop/delete/etc.), reset the scroll so we never carry over an out-of-range offset.
    if (lastBufferRef.current !== activeBuffer) {
      lastBufferRef.current = activeBuffer;
      container.scrollLeft = 0;
      setScrollLeft(0);
    }
  }, [activeBuffer]);

  // Unified zoom level and container width scaler for proportional scroll position
  const prevWaveformWidthRef = useRef<number>(0);

  useEffect(() => {
    if (!activeBuffer) return;
    const container = containerRef.current;
    if (container && prevWaveformWidthRef.current > 0) {
      const prevWidth = prevWaveformWidthRef.current;
      const currentWidth = Math.max(containerWidth, activeBuffer.duration * pxPerSec);
      
      if (prevWidth !== currentWidth) {
        // Calculate current scroll center ratio (percentage of visual width)
        const currentScrollLeft = container.scrollLeft;
        const viewportWidth = container.clientWidth;
        
        // Compute current scroll ratio for the center of the viewport
        const centerRatio = (currentScrollLeft + viewportWidth / 2) / prevWidth;
        
        // Calculate new scrollLeft to place the same ratio in the center
        const newScrollLeft = (centerRatio * currentWidth) - (viewportWidth / 2);
        
        container.scrollLeft = Math.max(0, newScrollLeft);
      }
    }
    prevWaveformWidthRef.current = Math.max(containerWidth, activeBuffer.duration * pxPerSec);
  }, [containerWidth, pxPerSec, activeBuffer]);

  const getTimeFromX = (clientX: number, customRect?: DOMRect) => {
    if (!activeBuffer || !containerRef.current) return 0;
    const container = containerRef.current;
    const rect = customRect || container.getBoundingClientRect();
    const x = clientX - rect.left + container.scrollLeft;
    const totalWidth = Math.max(rect.width, activeBuffer.duration * pxPerSec);
    const pct = Math.max(0, Math.min(1, x / totalWidth));
    return pct * activeBuffer.duration;
  };

  // Touch/Mouse dragging RAF-throttler for timeline
  let timelineRafId: number | null = null;
  const handleTimelineMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only left-click
    if ((e.target as HTMLElement).closest('.drag-handle')) return;
    if (!activeBuffer || !containerRef.current) return;

    e.stopPropagation();
    e.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    const startClientX = e.clientX;
    const startTimeVal = getTimeFromX(startClientX, rect);
    let hasDragged = false;
    const wasPlaying = isPlaying;

    if (wasPlaying) {
      stopPlayback();
    }

    const onMove = (clientX: number) => {
      if (timelineRafId) return;
      timelineRafId = requestAnimationFrame(() => {
        timelineRafId = null;
        const distance = Math.abs(clientX - startClientX);
        if (distance > 5) {
          hasDragged = true;
          setIsDragging(true);
        }
        
        const currentTimeVal = getTimeFromX(clientX, rect);
        const startSec = Math.min(startTimeVal, currentTimeVal);
        const endSec = Math.max(startTimeVal, currentTimeVal);

        setSelectionStart(startSec);
        setSelectionEnd(endSec);
        setCurrentTime(currentTimeVal);
      });
    };

    const handleMouseMove = (mv: MouseEvent) => {
      mv.stopPropagation();
      mv.preventDefault();
      onMove(mv.clientX);
    };

    const handleMouseUp = (mu: MouseEvent) => {
      mu.stopPropagation();
      if (timelineRafId) {
        cancelAnimationFrame(timelineRafId);
        timelineRafId = null;
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      setIsDragging(false);
      
      if (!hasDragged) {
        // Single Click - Seek playhead and optionally deselect
        const hasSelection = selectionStart !== selectionEnd;
        const isOutside = startTimeVal < selectionStart || startTimeVal > selectionEnd;
        
        if (hasSelection && isOutside) {
          setSelectionStart(0);
          setSelectionEnd(0);
          setCurrentTime(startTimeVal);
          if (wasPlaying) {
            playRange(startTimeVal);
          }
        } else {
          if (playSelectionOnly) {
            if (startTimeVal >= selectionStart && startTimeVal <= selectionEnd) {
              setCurrentTime(startTimeVal);
              if (wasPlaying) {
                playRange(startTimeVal);
              }
            }
          } else {
            setCurrentTime(startTimeVal);
            if (wasPlaying) {
              playRange(startTimeVal);
            }
          }
        }
      } else {
        // Done dragging selection
        if (wasPlaying) {
          playRange(startTimeVal);
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleTimelineTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.drag-handle')) return;
    if (!activeBuffer || !containerRef.current) return;

    e.stopPropagation();
    if (e.cancelable) {
      e.preventDefault();
    }

    const rect = containerRef.current.getBoundingClientRect();
    const startClientX = e.touches[0].clientX;
    const startTimeVal = getTimeFromX(startClientX, rect);
    let hasDragged = false;
    const wasPlaying = isPlaying;

    if (wasPlaying) {
      stopPlayback();
    }

    const onMove = (clientX: number) => {
      if (timelineRafId) return;
      timelineRafId = requestAnimationFrame(() => {
        timelineRafId = null;
        const distance = Math.abs(clientX - startClientX);
        if (distance > 5) {
          hasDragged = true;
          setIsDragging(true);
        }
        
        const currentTimeVal = getTimeFromX(clientX, rect);
        const startSec = Math.min(startTimeVal, currentTimeVal);
        const endSec = Math.max(startTimeVal, currentTimeVal);

        setSelectionStart(startSec);
        setSelectionEnd(endSec);
        setCurrentTime(currentTimeVal);
      });
    };

    const handleTouchMove = (tm: TouchEvent) => {
      tm.stopPropagation();
      if (tm.cancelable) {
        tm.preventDefault();
      }
      onMove(tm.touches[0].clientX);
    };

    const handleTouchEnd = (te: TouchEvent) => {
      te.stopPropagation();
      if (timelineRafId) {
        cancelAnimationFrame(timelineRafId);
        timelineRafId = null;
      }
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      setIsDragging(false);
      
      if (!hasDragged) {
        // Single Touch - Seek playhead and optionally deselect
        const hasSelection = selectionStart !== selectionEnd;
        const isOutside = startTimeVal < selectionStart || startTimeVal > selectionEnd;
        
        if (hasSelection && isOutside) {
          setSelectionStart(0);
          setSelectionEnd(0);
          setCurrentTime(startTimeVal);
          if (wasPlaying) {
            playRange(startTimeVal);
          }
        } else {
          if (playSelectionOnly) {
            if (startTimeVal >= selectionStart && startTimeVal <= selectionEnd) {
              setCurrentTime(startTimeVal);
              if (wasPlaying) {
                playRange(startTimeVal);
              }
            }
          } else {
            setCurrentTime(startTimeVal);
            if (wasPlaying) {
              playRange(startTimeVal);
            }
          }
        }
      } else {
        if (wasPlaying) {
          playRange(startTimeVal);
        }
      }
    };

    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
  };

  // Global wheel zoom throttling hook
  let zoomRafId: number | null = null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelNative = (e: WheelEvent) => {
      if (!activeBuffer) return;
      if (Math.abs(e.deltaY) > 2) {
        e.preventDefault();
        if (zoomRafId) return;
        
        zoomRafId = requestAnimationFrame(() => {
          zoomRafId = null;
          const rect = container.getBoundingClientRect();
          const mouseXInContainer = e.clientX - rect.left;
          const mouseXInContent = mouseXInContainer + container.scrollLeft;
          
          const totalWidthBefore = Math.max(rect.width, activeBuffer.duration * pxPerSec);
          const hoverPct = mouseXInContent / totalWidthBefore;
          
          const zoomDirection = e.deltaY < 0 ? 1 : -1;
          const zoomStep = 0.5;
          
          setZoomLevel(prev => {
            const nextZoom = Math.max(1, Math.min(25, prev + zoomDirection * zoomStep));
            if (nextZoom === prev) return prev;
            
            const pxPerSecNew = 15 * nextZoom;
            const totalWidthAfter = Math.max(rect.width, activeBuffer.duration * pxPerSecNew);
            const newScrollLeft = hoverPct * totalWidthAfter - mouseXInContainer;
            
            requestAnimationFrame(() => {
              if (containerRef.current) {
                containerRef.current.scrollLeft = newScrollLeft;
              }
            });
            
            return nextZoom;
          });
        });
      }
    };

    container.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheelNative);
    };
  }, [activeBuffer, pxPerSec]);

  const initAudioCtx = (): AudioContext => {
    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    return ctx;
  };

  const stopPlayback = () => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch (e) {}
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    // Disconnect gain node from chain (source is already disconnected)
    if (gainNodeRef.current) {
      try {
        gainNodeRef.current.disconnect();
      } catch (e) {}
    }
    // Disconnect compressor from chain
    if (compressorNodeRef.current) {
      try {
        compressorNodeRef.current.disconnect();
      } catch (e) {}
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsPlaying(false);
    
    // Commit the frame-perfect stopped/paused location back to React state
    setCurrentTime(currentTimeRef.current);
    
    // Suspend inactive audio context to conserve power
    if (audioCtxRef.current && audioCtxRef.current.state === 'running') {
      audioCtxRef.current.suspend().catch(console.error);
    }
  };

  const playRange = (startSec: number) => {
    stopPlayback();
    if (!activeBuffer) return;

    const ctx = initAudioCtx();
    const source = ctx.createBufferSource();
    source.buffer = activeBuffer;

    // Apply the customized speed factor
    source.playbackRate.setValueAtTime(playbackSpeedRef.current, ctx.currentTime);

    // ─── Non-Destructive Gain Chain ───
    // Create or reuse the GainNode (non-destructive volume adjustment)
    if (!gainNodeRef.current) {
      gainNodeRef.current = ctx.createGain();
    }
    const gainNode = gainNodeRef.current;
    gainNode.gain.setValueAtTime(dbToLinearGain(gainDb), ctx.currentTime);

    // Create or reuse the DynamicsCompressorNode (limiter to prevent clipping)
    if (!compressorNodeRef.current || compressorNodeRef.current.context !== ctx) {
      compressorNodeRef.current = ctx.createDynamicsCompressor();
      // Configure as a brick-wall limiter for safety
      compressorNodeRef.current.threshold.setValueAtTime(-1, ctx.currentTime);   // Start compressing at -1 dB
      compressorNodeRef.current.knee.setValueAtTime(0, ctx.currentTime);         // Hard knee (brick-wall)
      compressorNodeRef.current.ratio.setValueAtTime(20, ctx.currentTime);        // Heavy compression ratio
      compressorNodeRef.current.attack.setValueAtTime(0.003, ctx.currentTime);   // Fast attack (3ms)
      compressorNodeRef.current.release.setValueAtTime(0.01, ctx.currentTime);   // Fast release (10ms)
    }
    const compressor = compressorNodeRef.current;

    // Wire the chain: Source → GainNode → DynamicsCompressor (Limiter) → Destination
    source.connect(gainNode);
    gainNode.connect(compressor);
    compressor.connect(ctx.destination);

    sourceNodeRef.current = source;

    playStartOffsetRef.current = startSec;
    playStartTimeRef.current = ctx.currentTime;
    currentTimeRef.current = startSec;
    lastReactUpdateTimeRef.current = startSec;

    const duration = activeBuffer.duration;
    const startOffset = Math.max(0, Math.min(duration, startSec));

    source.start(0, startOffset);
    setIsPlaying(true);

    let lastFrameTime = 0;
    const updatePlayhead = (nowTime: number) => {
      if (!sourceNodeRef.current || !ctx) return;
      
      const isBatterySaver = typeof window !== "undefined" && 
        (!!(window as any).isBatterySaverActive || !!(window as any).batterySaver);
      
      if (isBatterySaver && lastFrameTime > 0) {
        // Throttle playhead visual DOM rendering loop to ~30 FPS (approx 33.3ms) instead of 60/120 FPS
        if (nowTime - lastFrameTime < 33.3) {
          animationFrameRef.current = requestAnimationFrame(updatePlayhead);
          return;
        }
      }
      lastFrameTime = nowTime;
      
      const currentSpeed = playbackSpeedRef.current;
      const elapsed = (ctx.currentTime - playStartTimeRef.current) * currentSpeed;
      const calculated = playStartOffsetRef.current + elapsed;

      const endLimit = playSelectionOnly ? selectionEnd : duration;

      if (calculated >= endLimit) {
        const resetTime = playSelectionOnly ? selectionStart : 0;
        currentTimeRef.current = resetTime;
        if (loop) {
          playRange(resetTime);
        } else {
          setCurrentTime(resetTime);
          setIsPlaying(false);
          stopPlayback();
        }
        return;
      }

      // Update core real-time tracking ref
      currentTimeRef.current = calculated;

      // Update playhead DOM elements at throttled/full frame rate
      updatePlayheadDOM(calculated);

      // Throttle React state committed updates (at most ~5 times per second, or ~1.6 times per second on battery saver)
      const reactUpdateThreshold = isBatterySaver ? 0.6 : 0.2;
      if (Math.abs(calculated - lastReactUpdateTimeRef.current) >= reactUpdateThreshold) {
        setCurrentTime(calculated);
        lastReactUpdateTimeRef.current = calculated;
      }

      animationFrameRef.current = requestAnimationFrame(updatePlayhead);
    };

    animationFrameRef.current = requestAnimationFrame(updatePlayhead);
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      const startFrom = playSelectionOnly 
        ? (currentTime < selectionStart || currentTime >= selectionEnd ? selectionStart : currentTime)
        : currentTime;
      playRange(startFrom);
    }
  };

  const handleStop = () => {
    stopPlayback();
    setCurrentTime(playSelectionOnly ? selectionStart : 0);
  };



  let sidebarDragRafId: number | null = null;
  const startDrag = (e: React.MouseEvent | React.TouchEvent, markerType: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    if (!activeBuffer) return;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const duration = activeBuffer.duration;
    setIsDragging(true);

    const onMove = (clientX: number) => {
      if (sidebarDragRafId) return;
      sidebarDragRafId = requestAnimationFrame(() => {
        sidebarDragRafId = null;
        const positionX = clientX - rect.left + container.scrollLeft;
        const totalWidth = Math.max(rect.width, duration * pxPerSec);
        const percentage = Math.max(0, Math.min(1, positionX / totalWidth));
        const targetSec = percentage * duration;

        if (markerType === 'start') {
          const bound = Math.min(selectionEnd - 0.1, targetSec);
          setSelectionStart(Math.max(0, bound));
          if (currentTime < bound) {
            setCurrentTime(Math.max(0, bound));
          }
        } else {
          const bound = Math.max(selectionStart + 0.1, targetSec);
          setSelectionEnd(Math.min(duration, bound));
          if (currentTime > bound) {
            setCurrentTime(bound);
          }
        }
      });
    };

    const handleMouseMove = (mv: MouseEvent) => {
      mv.stopPropagation();
      mv.preventDefault();
      onMove(mv.clientX);
    };
    const handleTouchMove = (tm: TouchEvent) => {
      tm.stopPropagation();
      if (tm.cancelable) {
        tm.preventDefault();
      }
      onMove(tm.touches[0].clientX);
    };

    const cleanUp = (ev: Event) => {
      ev.stopPropagation();
      if (sidebarDragRafId) {
        cancelAnimationFrame(sidebarDragRafId);
        sidebarDragRafId = null;
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', cleanUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', cleanUp);
      setIsDragging(false);
    };

    if (e.nativeEvent instanceof MouseEvent) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', cleanUp);
    } else {
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', cleanUp);
    }
  };

  const seekAndSyncTimeline = (targetSec: number) => {
    setCurrentTime(targetSec);
    if (isPlaying) {
      playRange(targetSec);
    }
    // Reallocate main timeline
    if (containerRef.current) {
      const mainContainer = containerRef.current;
      const mainRect = mainContainer.getBoundingClientRect();
      const targetX = targetSec * pxPerSec;
      mainContainer.scrollLeft = Math.max(0, targetX - mainRect.width / 2);
    }
  };

  let miniDragRafId: number | null = null;
  const startMiniDrag = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!activeBuffer) return;

    const miniContainer = miniContainerRef.current;
    if (!miniContainer) return;

    setIsDragging(true);

    const onMove = (clientX: number) => {
      if (miniDragRafId) return;
      miniDragRafId = requestAnimationFrame(() => {
        miniDragRafId = null;
        const rect = miniContainer.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const clickPct = clickX / rect.width;
        const targetSec = clickPct * duration;
        seekAndSyncTimeline(targetSec);
      });
    };

    const handleMouseMove = (mv: MouseEvent) => {
      mv.stopPropagation();
      mv.preventDefault();
      onMove(mv.clientX);
    };

    const handleTouchMove = (tm: TouchEvent) => {
      tm.stopPropagation();
      if (tm.cancelable) {
        tm.preventDefault();
      }
      onMove(tm.touches[0].clientX);
    };

    const cleanUp = (ev: Event) => {
      ev.stopPropagation();
      if (miniDragRafId) {
        cancelAnimationFrame(miniDragRafId);
        miniDragRafId = null;
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', cleanUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', cleanUp);
      setIsDragging(false);
    };

    if (e.nativeEvent instanceof MouseEvent) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', cleanUp);
    } else {
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', cleanUp);
    }
  };

  const pushToHistory = () => {
    if (!activeBuffer) return;
    setHistory(prev => [
      ...prev,
      {
        activeBuffer,
        selectionStart,
        selectionEnd,
        currentTime
      }
    ]);
  };

  const actionUndo = () => {
    if (history.length === 0) {
      toast.info("Nothing to undo.");
      return;
    }
    stopPlayback();
    const nextHistory = [...history];
    const prevState = nextHistory.pop()!;
    setHistory(nextHistory);
    setActiveBuffer(prevState.activeBuffer);
    setSelectionStart(prevState.selectionStart);
    setSelectionEnd(prevState.selectionEnd);
    setCurrentTime(prevState.currentTime);
    toast.success("Undo applied successfully! (Ctrl+Z)");
  };

  const actionCrop = async () => {
    if (!activeBuffer || !audioCtxRef.current) return;
    try {
      stopPlayback();
      pushToHistory();
      const sliced = await sliceAudioBuffer(activeBuffer, selectionStart, selectionEnd, audioCtxRef.current);
      setActiveBuffer(sliced);
      setSelectionStart(0);
      setSelectionEnd(sliced.duration);
      setCurrentTime(0);
      toast.success("Crop applied successfully!");
    } catch (e: any) {
      toast.error(`Crop failed: ${e.message}`);
    }
  };

  const actionCopy = () => {
    if (!activeBuffer || !audioCtxRef.current) return;
    const sampleRate = activeBuffer.sampleRate;
    const startIdx = Math.floor(selectionStart * sampleRate);
    const endIdx = Math.floor(selectionEnd * sampleRate);
    const len = endIdx - startIdx;
    if (len <= 0) {
      toast.error("Please select a region to copy.");
      return;
    }
    
    const copy = audioCtxRef.current.createBuffer(
      activeBuffer.numberOfChannels,
      len,
      sampleRate
    );
    for (let c = 0; c < activeBuffer.numberOfChannels; c++) {
      const src = activeBuffer.getChannelData(c);
      const dest = copy.getChannelData(c);
      dest.set(src.subarray(startIdx, endIdx));
    }
    setClipboardBuffer(copy);
    toast.success("Copied to clipboard!");
  };

  const actionDelete = async () => {
    if (!activeBuffer || !audioCtxRef.current) return;
    try {
      stopPlayback();
      pushToHistory();
      const trimmed = await deleteAudioBufferRegion(activeBuffer, selectionStart, selectionEnd, audioCtxRef.current);
      setActiveBuffer(trimmed);
      setSelectionEnd(selectionStart);
      setCurrentTime(selectionStart);
      toast.success("Deleted selection!");
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  const actionCut = async () => {
    actionCopy();
    await actionDelete();
  };

  const actionPaste = () => {
    if (!activeBuffer || !clipboardBuffer || !audioCtxRef.current) return;
    stopPlayback();
    pushToHistory();
    
    const sampleRate = activeBuffer.sampleRate;
    const insertIdx = Math.floor(currentTime * sampleRate);
    
    const newLength = activeBuffer.length + clipboardBuffer.length;
    const newBuf = audioCtxRef.current.createBuffer(
      activeBuffer.numberOfChannels,
      newLength,
      sampleRate
    );
    
    for (let c = 0; c < activeBuffer.numberOfChannels; c++) {
      const src = activeBuffer.getChannelData(c);
      const clip = clipboardBuffer.getChannelData(Math.min(c, clipboardBuffer.numberOfChannels - 1));
      const dest = newBuf.getChannelData(c);
      
      dest.set(src.subarray(0, insertIdx), 0);
      dest.set(clip, insertIdx);
      dest.set(src.subarray(insertIdx), insertIdx + clipboardBuffer.length);
    }
    
    setActiveBuffer(newBuf);
    setCurrentTime(currentTime + clipboardBuffer.duration);
    setSelectionStart(currentTime);
    setSelectionEnd(currentTime + clipboardBuffer.duration);
    toast.success("Pasted from clipboard!");
  };

  const actionSilence = () => {
    if (!activeBuffer || !audioCtxRef.current) return;
    stopPlayback();
    pushToHistory();
    
    const copy = audioCtxRef.current.createBuffer(
      activeBuffer.numberOfChannels,
      activeBuffer.length,
      activeBuffer.sampleRate
    );
    
    const sampleRate = activeBuffer.sampleRate;
    const startIndex = Math.floor(selectionStart * sampleRate);
    const endIndex = Math.min(activeBuffer.length, Math.floor(selectionEnd * sampleRate));

    for (let c = 0; c < activeBuffer.numberOfChannels; c++) {
      const sourceData = activeBuffer.getChannelData(c);
      const destData = copy.getChannelData(c);
      destData.set(sourceData);

      for (let i = startIndex; i < endIndex; i++) {
        destData[i] = 0;
      }
    }

    setActiveBuffer(copy);
    toast.success("Selected region silenced!");
  };

  const actionRemoveSilences = () => {
    if (!activeBuffer || !audioCtxRef.current) return;
    stopPlayback();
    pushToHistory();

    const sampleRate = activeBuffer.sampleRate;
    const channelData = activeBuffer.getChannelData(0);
    
    const frameDuration = 0.01; // 10ms
    const frameSize = Math.floor(sampleRate * frameDuration);
    const frames = Math.floor(channelData.length / frameSize);
    
    const thresholdRms = 0.02; // relatively quiet
    const minSilenceFrames = Math.floor(0.4 / frameDuration); // 400ms duration min
    const padFrames = Math.floor(0.1 / frameDuration); // keep 100ms padding
    
    const isSilentFrame = new Array(frames).fill(false);
    
    for (let i = 0; i < frames; i++) {
       let sum = 0;
       const start = i * frameSize;
       for (let j = 0; j < frameSize; j++) {
          const val = channelData[start + j];
          sum += val * val;
       }
       const rms = Math.sqrt(sum / frameSize);
       isSilentFrame[i] = rms < thresholdRms;
    }
    
    // Find silent regions
    let silentRegions: {start: number, end: number}[] = [];
    let startSilent = -1;
    for (let i = 0; i < frames; i++) {
        if (isSilentFrame[i]) {
            if (startSilent === -1) startSilent = i;
        } else {
            if (startSilent !== -1) {
                if (i - startSilent >= minSilenceFrames) {
                    silentRegions.push({ start: startSilent, end: i - 1 });
                }
                startSilent = -1;
            }
        }
    }
    if (startSilent !== -1 && (frames - startSilent) >= minSilenceFrames) {
        silentRegions.push({ start: startSilent, end: frames - 1 });
    }
    
    // Apply padding
    for (const r of silentRegions) {
        r.start += padFrames;
        r.end -= padFrames;
    }
    silentRegions = silentRegions.filter(r => r.end >= r.start);
    
    // Invert to get keep regions
    const keepRegions: {start: number, end: number}[] = [];
    let currentStart = 0;
    
    for (const r of silentRegions) {
        if (r.start > currentStart) {
            keepRegions.push({ start: currentStart, end: r.start - 1 });
        }
        currentStart = r.end + 1;
    }
    if (currentStart < frames) {
        keepRegions.push({ start: currentStart, end: frames - 1 });
    }
    
    if (keepRegions.length === 0) {
        toast.error("Audio appears entirely silent.");
        setHistory(prev => {
            const popped = [...prev];
            popped.pop();
            return popped;
        });
        return;
    }
    
    // convert back to samples
    let totalLength = 0;
    const keepSampleRegions: {start: number, end: number}[] = keepRegions.map(r => {
        const startSamp = r.start * frameSize;
        const endSamp = (r.end === frames - 1) ? channelData.length : (r.end + 1) * frameSize;
        totalLength += (endSamp - startSamp);
        return { start: startSamp, end: endSamp };
    });
    
    if (totalLength >= activeBuffer.length * 0.99) {
        toast.info("No significant silence found.");
        setHistory(prev => {
            const popped = [...prev];
            popped.pop();
            return popped;
        });
        return;
    }
    
    const newBuffer = audioCtxRef.current.createBuffer(
      activeBuffer.numberOfChannels,
      totalLength,
      sampleRate
    );
    
    for (let c = 0; c < activeBuffer.numberOfChannels; c++) {
       const sourceData = activeBuffer.getChannelData(c);
       const destData = newBuffer.getChannelData(c);
       let offset = 0;
       for (const seg of keepSampleRegions) {
          const len = seg.end - seg.start;
          destData.set(sourceData.subarray(seg.start, seg.end), offset);
          offset += len;
       }
    }
    
    setActiveBuffer(newBuffer);
    setSelectionStart(0);
    setSelectionEnd(newBuffer.duration);
    setCurrentTime(0);
    toast.success("Silences successfully removed!");
  };

  const actionReset = () => {
    if (!originalBuffer) return;
    stopPlayback();
    pushToHistory();
    setActiveBuffer(originalBuffer);
    setSelectionStart(0);
    setSelectionEnd(originalBuffer.duration);
    setCurrentTime(0);
    toast.success("Reset back to start!");
  };

  /**
   * Compiles the final edited AudioBuffer used for export / queue save.
   *
   * Destructive edits (crop, delete, silence, remove-silences, paste) are already
   * baked into `activeBuffer`. The volume gain, however, is applied *non-destructively*
   * via a live GainNode during playback and never written back to the buffer — so
   * without this step the exported file would be identical to the original.
   *
   * To bake the gain (and the same brick-wall limiter used during playback) into the
   * output, we render `activeBuffer` through an OfflineAudioContext — a purely
   * client-side, near-instant operation that mirrors the exact Source → Gain →
   * Limiter → Destination chain the user hears. At unity gain (0 dB) we skip the
   * render entirely and hand back the edited buffer directly.
   */
  const compileFinalBuffer = async (): Promise<AudioBuffer> => {
    if (!activeBuffer || !audioCtxRef.current) {
      throw new Error("No loaded audio buffer found to compile.");
    }

    // Unity gain: the edited buffer is already exactly what the user hears.
    if (gainDb === 0) {
      return activeBuffer;
    }

    const channels = activeBuffer.numberOfChannels;
    const sampleRate = activeBuffer.sampleRate;

    // OfflineAudioContext renders the gain chain off the main thread with zero
    // playback latency. Length/SR/channels are preserved bit-for-bit (no resampling).
    const OfflineAudioCtx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const offlineCtx = new OfflineAudioCtx(channels, activeBuffer.length, sampleRate);

    const source = offlineCtx.createBufferSource();
    source.buffer = activeBuffer;

    // Replicate the live playback chain so the export matches what the user heard.
    const gainNode = offlineCtx.createGain();
    gainNode.gain.setValueAtTime(dbToLinearGain(gainDb), 0);

    // Brick-wall limiter (identical config to playRange) — prevents hard clipping
    // distortion when boosting, matching the live monitoring behaviour.
    const limiter = offlineCtx.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-1, 0);
    limiter.knee.setValueAtTime(0, 0);
    limiter.ratio.setValueAtTime(20, 0);
    limiter.attack.setValueAtTime(0.003, 0);
    limiter.release.setValueAtTime(0.01, 0);

    source.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(offlineCtx.destination);

    source.start(0);

    return await offlineCtx.startRendering();
  };

  const downloadAudio = async (type: 'mp3' | 'wav' = selectedFormat) => {
    if (!activeBuffer) return;
    setIsExporting(true);
    setExportProgress(0);

    try {
      const compiledBuffer = await compileFinalBuffer();
      let blob: Blob;

      if (type === 'mp3') {
        // Try the ultra-fast FFmpeg WASM path first; fall back to lamejs if it fails.
        try {
          blob = await bufferToMp3Fast(compiledBuffer, mp3Bitrate, (rawPct) => {
            setExportProgress(Math.round(rawPct * 100));
          });
        } catch (fastErr: any) {
          console.warn("[WaveformEditor] Fast MP3 export failed, falling back to lamejs:", fastErr);
          setExportProgress(0);
          blob = await bufferToMp3(compiledBuffer, mp3Bitrate, (rawPct) => {
            setExportProgress(Math.round(rawPct * 100));
          });
        }
      } else {
        blob = await bufferToWavAsync(compiledBuffer, (rawPct) => {
          setExportProgress(Math.round(rawPct * 100));
        });
      }

      const baseNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      const finalFileName = `${baseNameWithoutExt}_edited.${type}`;
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = finalFileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success(`Successfully exported and downloaded ${type.toUpperCase()} file!`);
    } catch (e: any) {
      console.error(e);
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const applyToQueue = async () => {
    if (!activeBuffer || !onUpdateFile) return;
    setIsExporting(true);
    setExportProgress(0);

    try {
      const compiledBuffer = await compileFinalBuffer();
      toast.info("Compiling project sound data...");
      
      // Try the ultra-fast FFmpeg WASM path first; fall back to lamejs if it fails.
      let finalMp3Blob: Blob;
      try {
        finalMp3Blob = await bufferToMp3Fast(compiledBuffer, mp3Bitrate, (rawPct) => {
          setExportProgress(Math.round(rawPct * 100));
        });
      } catch (fastErr: any) {
        console.warn("[WaveformEditor] Fast MP3 save failed, falling back to lamejs:", fastErr);
        setExportProgress(0);
        finalMp3Blob = await bufferToMp3(compiledBuffer, mp3Bitrate, (rawPct) => {
          setExportProgress(Math.round(rawPct * 100));
        });
      }

      const baseNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      const updatedFileObj = new File([finalMp3Blob], `${baseNameWithoutExt}_edited.mp3`, { type: 'audio/mp3' });
      
      onUpdateFile(updatedFileObj);
      toast.success("Waveform edits successfully saved inside your queue!");
    } catch (e: any) {
      console.error(e);
      toast.error(`Failed to apply changes to queue: ${e.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const actionsRef = useRef({
    actionUndo,
    actionCopy,
    actionCut,
    actionPaste,
    actionDelete,
    handlePlayPause,
    clipboardBuffer
  });

  useEffect(() => {
    actionsRef.current = {
      actionUndo,
      actionCopy,
      actionCut,
      actionPaste,
      actionDelete,
      handlePlayPause,
      clipboardBuffer
    };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }
      const acts = actionsRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        acts.handlePlayPause();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        acts.actionUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        acts.actionCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        acts.actionCut();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (acts.clipboardBuffer) {
           acts.actionPaste();
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        acts.actionDelete();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (isDecoding) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950/20 text-slate-500">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mb-2" />
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 animate-pulse">Loading soundwave channels...</span>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="p-4 border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/10 rounded-xl text-red-600 dark:text-red-400 text-sm flex flex-col gap-2">
        <span className="font-bold">Waveform Load Error</span>
        <span>{errorMsg}</span>
      </div>
    );
  }

  if (!activeBuffer) return null;

  const duration = activeBuffer.duration;
  const waveformTotalWidth = Math.max(containerWidth, duration * pxPerSec);
  
  const hLeftPct = `${(selectionStart / duration) * 100}%`;
  const hWidthPct = `${((selectionEnd - selectionStart) / duration) * 100}%`;
  const playheadPct = `${(currentTime / duration) * 100}%`;

  return (
    <div 
      className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-visible shadow-xs flex flex-col"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Waveform Header banner */}
      <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2 text-xs rounded-t-xl">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-indigo-500" />
          <div>
            <span className="font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide block text-[11px]">Interactive Audio Editor</span>
            <span className="text-[10px] text-slate-400 block -mt-0.5">Slicing, cropping, Fades and volume amplification</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={actionUndo}
            disabled={history.length === 0}
            className={`px-2.5 py-1 text-[10px] font-bold border rounded-lg transition-colors flex items-center gap-1 cursor-pointer ${
              history.length === 0 
                ? 'opacity-40 cursor-not-allowed text-slate-400 bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800' 
                : 'text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-950 border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/20'
            }`}
            data-tooltip="Undo last edit (Ctrl+Z)"
          >
            Undo (Ctrl+Z)
          </button>

          <button
            onClick={actionReset}
            className="px-2.5 py-1 text-[10px] font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Revert Waveform
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Time and Zoom Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-3">
            <span 
              ref={currentTimeSpanRef}
              className="font-mono text-slate-800 dark:text-slate-200 font-extrabold bg-slate-100 dark:bg-slate-950 px-2 py-0.5 rounded"
            >
              Current: {formatTime(currentTime)}
            </span>
            <span className="text-slate-350">/</span>
            <span className="font-mono">Track: {formatTime(duration)}</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Zoom presets 1x, 2x, 3x (Cleanvoice Style) */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-950 p-0.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
              <button
                onClick={() => setZoomLevel(1)}
                className={`px-2 py-0.5 text-[11px] font-bold rounded-md transition-all cursor-pointer select-none ${
                  zoomLevel <= 2
                    ? 'bg-indigo-600 text-white shadow-xs' 
                    : 'text-slate-500 hover:bg-white/65 dark:hover:bg-slate-900'
                }`}
                data-tooltip="Zoom Level 1x (Fit entire track)"
                type="button"
              >
                1x
              </button>
              <button
                onClick={() => setZoomLevel(5)}
                className={`px-2 py-0.5 text-[11px] font-bold rounded-md transition-all cursor-pointer select-none ${
                  zoomLevel > 2 && zoomLevel <= 7
                    ? 'bg-indigo-600 text-white shadow-xs' 
                    : 'text-slate-500 hover:bg-white/65 dark:hover:bg-slate-900'
                }`}
                data-tooltip="Zoom Level 2x"
                type="button"
              >
                2x
              </button>
              <button
                onClick={() => setZoomLevel(15)}
                className={`px-2 py-0.5 text-[11px] font-bold rounded-md transition-all cursor-pointer select-none ${
                  zoomLevel > 7
                    ? 'bg-indigo-600 text-white shadow-xs' 
                    : 'text-slate-500 hover:bg-white/65 dark:hover:bg-slate-900'
                }`}
                data-tooltip="Zoom Level 3x"
                type="button"
              >
                3x
              </button>
            </div>

            {/* Standard Incremental Fine-Tuning Zoom Buttons */}
            <div className="flex items-center gap-0.5 shadow-inner bg-slate-50 dark:bg-slate-950 rounded-xl p-0.5 border border-slate-200/60 dark:border-slate-800">
              <button
                onClick={() => setZoomLevel(prev => Math.max(1, prev - 1))}
                disabled={zoomLevel <= 1}
                className="p-1 px-1.5 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 rounded-lg disabled:opacity-30 transition-colors cursor-pointer animate-none"
                data-tooltip="Zoom Out"
                type="button"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-mono font-bold text-slate-400 px-1 select-none">{Number(zoomLevel).toFixed(1)}x Zoom</span>
              <button
                onClick={() => setZoomLevel(prev => Math.min(25, prev + 1))}
                disabled={zoomLevel >= 25}
                className="p-1 px-1.5 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 rounded-lg disabled:opacity-30 transition-colors cursor-pointer animate-none"
                data-tooltip="Zoom In"
                type="button"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Dynamic Canvas track scroll container */}
        <div 
          ref={containerRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          className="AudioTimeline relative h-40 w-full overflow-x-auto overflow-y-hidden border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 rounded-lg scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 select-none cursor-crosshair touch-none"
          onMouseDown={handleTimelineMouseDown}
          onTouchStart={handleTimelineTouchStart}
        >
          <div
            className="relative h-full will-change-transform"
            style={{
              width: `${waveformTotalWidth}px`,
              willChange: "transform",
              transformOrigin: "center center",
              transform: `translate3d(0, 0, 0) scaleY(1)`
            }}
          >
            {/* Background Inactive Waveform (Lavender) */}
            <canvas 
              ref={canvasInactiveRef}
              className="absolute top-0 h-full block pointer-events-none opacity-100"
              style={{ left: `${scrollLeft}px`, width: `${containerWidth}px`, height: '100%' }}
            />

            {/* Foreground Active Waveform (Indigo/Violet) - Clipped dynamically by width */}
            <div 
              ref={activeWaveformContainerRef}
              className="absolute top-0 left-0 h-full overflow-hidden pointer-events-none"
              style={{ width: playheadPct }}
            >
              <canvas 
                ref={canvasActiveRef}
                className="absolute top-0 h-full block pointer-events-none"
                style={{ left: `${scrollLeft}px`, width: `${containerWidth}px`, height: '100%' }}
              />
            </div>

             {/* Graying out outer dims overlay - conditionally visible only when a selection exists */}
            {selectionStart !== selectionEnd && (
              <div className="absolute top-0 bottom-0 left-0 right-0 pointer-events-none flex">
                <div 
                  className="bg-slate-950/20 dark:bg-slate-950/45 border-r border-indigo-500/15"
                  style={{ width: hLeftPct }}
                />
                <div 
                  className="bg-transparent"
                  style={{ width: hWidthPct }}
                />
                <div 
                  className="bg-slate-950/20 dark:bg-slate-950/45 border-l border-indigo-500/15 flex-1"
                />
              </div>
            )}

            {/* Left millisecond tooltip */}
            {selectionStart !== selectionEnd && (
              <div 
                className={`absolute top-1 pointer-events-none text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shadow-xs z-30 transition-all border ${
                  isDragging 
                    ? 'scale-105 opacity-100 bg-indigo-600 border-indigo-500 text-white' 
                    : 'bg-indigo-50 text-indigo-900 border-indigo-100 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-800'
                }`}
                style={{ 
                  left: hLeftPct,
                  transform: `translateX(${(selectionStart / duration) < 0.12 ? '0%' : (selectionStart / duration) > 0.88 ? '-100%' : '-50%'})`
                }}
              >
                Start: {Math.round(selectionStart * 1000)}ms
              </div>
            )}

            {/* Right millisecond tooltip */}
            {selectionStart !== selectionEnd && (
              <div 
                className={`absolute top-1 pointer-events-none text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shadow-xs z-30 transition-all border ${
                  isDragging 
                    ? 'scale-105 opacity-100 bg-indigo-600 border-indigo-500 text-white' 
                    : 'bg-indigo-50 text-indigo-900 border-indigo-100 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-800'
                }`}
                style={{ 
                  left: `calc(${hLeftPct} + ${hWidthPct})`,
                  transform: `translateX(${(selectionEnd / duration) < 0.12 ? '0%' : (selectionEnd / duration) > 0.88 ? '-100%' : '-50%'})`
                }}
              >
                End: {Math.round(selectionEnd * 1000)}ms
              </div>
            )}

            {/* Left handle slider - conditionally visible only when a selection exists */}
            {selectionStart !== selectionEnd && (
              <div
                className="drag-handle absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize z-25 flex items-center justify-center group touch-none"
                style={{ left: hLeftPct }}
                onMouseDown={(e) => startDrag(e, 'start')}
                onTouchStart={(e) => startDrag(e, 'start')}
                onClick={(e) => e.stopPropagation()}
                data-tooltip="Drag to adjust selection start"
              >
                <div className="w-[2px] h-full bg-indigo-600 group-hover:bg-indigo-400 group-active:bg-indigo-300 transition-colors shadow-xs" />
              </div>
            )}

            {/* Right handle slider - conditionally visible only when a selection exists */}
            {selectionStart !== selectionEnd && (
              <div
                className="drag-handle absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize z-25 flex items-center justify-center group touch-none"
                style={{ left: `calc(${hLeftPct} + ${hWidthPct})` }}
                onMouseDown={(e) => startDrag(e, 'end')}
                onTouchStart={(e) => startDrag(e, 'end')}
                onClick={(e) => e.stopPropagation()}
                data-tooltip="Drag to adjust selection end"
              >
                <div className="w-[2px] h-full bg-indigo-600 group-hover:bg-indigo-100 group-active:bg-indigo-300 transition-colors shadow-xs" />
              </div>
            )}

            {/* Current Timeline Playhead */}
            <div 
              ref={playheadRef}
              className="absolute top-0 bottom-0 w-[2px] bg-indigo-600 hover:bg-indigo-750 shadow-md pointer-events-none z-10"
              style={{ left: playheadPct }}
            >
              <div className="absolute top-0 w-2.5 h-2.5 bg-indigo-600 rounded-full border border-white -translate-x-[40%]" />
            </div>
          </div>
        </div>

        {/* Cleanvoice AI Full-Length Overview Tracker Card */}
        <div 
          ref={miniContainerRef}
          className="relative h-11 w-full border border-slate-300 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/60 rounded-lg select-none cursor-pointer overflow-hidden shadow-inner flex items-center group"
          onClick={(e) => {
            if (!activeBuffer) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickPct = Math.max(0, Math.min(1, clickX / rect.width));
            const targetSec = clickPct * duration;
            seekAndSyncTimeline(targetSec);
          }}
          onMouseDown={(e) => {
            if (e.button !== 0 || !activeBuffer) return;
            e.stopPropagation();
            e.preventDefault();
            
            const rect = e.currentTarget.getBoundingClientRect();
            const handleMiniMove = (mv: MouseEvent) => {
              const clickX = Math.max(0, Math.min(rect.width, mv.clientX - rect.left));
              const clickPct = clickX / rect.width;
              const targetSec = clickPct * duration;
              seekAndSyncTimeline(targetSec);
            };
            
            const handleMiniUp = () => {
              window.removeEventListener('mousemove', handleMiniMove);
              window.removeEventListener('mouseup', handleMiniUp);
            };
            
            window.addEventListener('mousemove', handleMiniMove);
            window.addEventListener('mouseup', handleMiniUp);
          }}
          onTouchStart={(e) => {
            if (!activeBuffer) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const handleTouchMove = (tm: TouchEvent) => {
              const clickX = Math.max(0, Math.min(rect.width, tm.touches[0].clientX - rect.left));
              const clickPct = clickX / rect.width;
              const targetSec = clickPct * duration;
              seekAndSyncTimeline(targetSec);
            };
            const handleTouchEnd = () => {
              window.removeEventListener('touchmove', handleTouchMove);
              window.removeEventListener('touchend', handleTouchEnd);
            };
            window.addEventListener('touchmove', handleTouchMove, { passive: false });
            window.addEventListener('touchend', handleTouchEnd);

            const clickX = e.touches[0].clientX - rect.left;
            const clickPct = Math.max(0, Math.min(1, clickX / rect.width));
            const targetSec = clickPct * duration;
            seekAndSyncTimeline(targetSec);
          }}
          data-tooltip="Fitted Full-Length Overview Timeline (Click / hold & drag to seek)"
        >
          {/* Background Inactive mini Waveform */}
          <canvas 
            ref={miniCanvasInactiveRef}
            className="absolute top-1.5 left-0 h-[30px] block pointer-events-none opacity-85"
            style={{ width: `${containerWidth}px`, height: '30px' }}
          />

          {/* Foreground Active mini Waveform (Clipped/Played part) */}
          <div 
            ref={miniActiveWaveformContainerRef}
            className="absolute top-1.5 left-0 h-[30px] overflow-hidden pointer-events-none"
            style={{ width: playheadPct }}
          >
            <canvas 
              ref={miniCanvasActiveRef}
              className="absolute top-0 left-0 h-full block pointer-events-none"
              style={{ width: `${containerWidth}px`, height: '30px' }}
            />
          </div>

          {/* Scrubber Playhead Handle */}
          <div 
            ref={miniPlayheadRef}
            className="absolute top-0 bottom-0 w-1 bg-indigo-600 z-35 cursor-ew-resize flex items-center justify-center group/playhead"
            style={{ left: playheadPct }}
            onMouseDown={(e) => startMiniDrag(e)}
            onTouchStart={(e) => startMiniDrag(e)}
            onClick={(e) => e.stopPropagation()}
            data-tooltip="Drag to seek / scrub playhead"
          >
            {/* Round handle knob */}
            <div className="w-3.5 h-3.5 bg-indigo-600 border-2 border-white rounded-full shadow-md scale-100 group-hover/playhead:scale-125 transition-transform" />
          </div>

          {/* Interactive center divider marker */}
          <div 
            ref={miniCenterDividerRef}
            className="absolute top-0 bottom-0 w-[1.5px] bg-indigo-600 pointer-events-none z-10 opacity-70 group-hover:opacity-100 transition-opacity"
            style={{ left: playheadPct }}
          />
        </div>

        {/* Info stats */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs font-medium py-1">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="font-mono text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 rounded-lg border border-slate-200/50 dark:border-slate-800 select-none">
              Selection: <span className="font-bold text-slate-800 dark:text-white">{formatTime(selectionStart)}</span> to <span className="font-bold text-slate-800 dark:text-white">{formatTime(selectionEnd)}</span> ({formatTime(selectionEnd - selectionStart)}s)
            </span>

            <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-600 dark:text-slate-300">
              <input 
                type="checkbox"
                checked={playSelectionOnly}
                onChange={(e) => setPlaySelectionOnly(e.target.checked)}
                className="w-3.5 h-3.5 accent-indigo-600 rounded"
              />
              <span>Play Selection Region Only</span>
            </label>
          </div>

          <p className="text-[10px] text-slate-400">Click timeline to seek playhead • Drag L/R sliders to define Crop boundaries</p>
        </div>
        {/* Action Board Container */}
        <div className="pt-2 select-none w-full text-slate-700 dark:text-slate-300 border-t border-slate-100 dark:border-slate-800 mt-2">
          <div className="controls-row flex flex-col md:flex-row items-stretch justify-between gap-4 md:gap-6 pt-3">
            {/* Left Column: Soundboard Playback & Filters */}
            <div className="controls-column controls-left flex-1 min-w-0">
              <span className="controls-title text-[9.5px] sm:text-[10px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-wider block mb-2 whitespace-normal break-words leading-tight">Soundboard Playback & Filters</span>
              <div className="flex flex-col sm:flex-row sm:items-center items-start gap-2.5 sm:gap-1.5 md:gap-2 w-full">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handlePlayPause}
                    className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-lg shadow-sm transition-all cursor-pointer select-none border border-indigo-600 dark:border-indigo-500 shrink-0 tooltip-align-left"
                    data-tooltip="Play/Pause (Spacebar)"
                  >
                    {isPlaying ? <Pause className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-current" /> : <Play className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-current" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg border border-slate-200 dark:border-slate-850 transition-colors cursor-pointer select-none shrink-0 tooltip-align-left"
                    data-tooltip="Stop"
                  >
                    <Square className="w-3.5 h-3.5 sm:w-3.5 sm:h-3.5 fill-current" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setLoop(!loop)}
                    className={`w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg border transition-all cursor-pointer select-none shrink-0 tooltip-align-left ${
                      loop 
                        ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-900 dark:text-indigo-400 font-extrabold' 
                        : 'bg-slate-50 border-slate-200 dark:bg-slate-800/50 dark:border-slate-800 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
                    }`}
                    data-tooltip="Loop playback"
                  >
                    <RotateCcw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  </button>

                  {onUpdateFile && (
                    <button
                      type="button"
                      onClick={applyToQueue}
                      disabled={isExporting}
                      className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900/50 rounded-lg transition-all hover:scale-105 cursor-pointer shadow-sm tooltip-align-left shrink-0"
                      data-tooltip="Save in Queue (compiles edits directly into transcription queue)"
                    >
                      <Save className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                  )}
                </div>

                <div className="relative flex items-center h-7.5 sm:h-8 select-none shrink-0">
                  <button
                    type="button"
                    onClick={() => downloadAudio('mp3')}
                    disabled={isExporting}
                    className="h-full px-2 sm:px-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:bg-slate-800 disabled:opacity-50 text-slate-700 dark:text-slate-200 rounded-l-lg border border-slate-200 dark:border-slate-800 transition-all flex items-center justify-center gap-1 sm:gap-1 text-[8.5px] sm:text-[10.5px] font-bold cursor-pointer hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                    data-tooltip={`Export as MP3 (${mp3Bitrate}kbps, click to download)`}
                  >
                    <Download className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-500 dark:text-slate-400" />
                    <span className="text-[8.5px] sm:text-[10.5px] font-bold leading-none">
                      <span>Export </span>
                      <span>({mp3Bitrate === nativeBitrate ? 'Source' : `${mp3Bitrate}k`})</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowBitrateDropdown(!showBitrateDropdown);
                    }}
                    disabled={isExporting}
                    className="h-full px-1.5 sm:px-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:bg-slate-800 disabled:opacity-50 text-slate-700 dark:text-slate-200 rounded-r-lg border-y border-r border-slate-200 dark:border-slate-800 flex items-center justify-center cursor-pointer transition-colors active:scale-[0.98]"
                    aria-expanded={showBitrateDropdown}
                  >
                    <ChevronDown className={`w-2.5 h-2.5 sm:w-3 sm:h-3 transition-transform duration-200 ${showBitrateDropdown ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Dropdown Options List */}
                  {showBitrateDropdown && (
                    <div 
                      ref={dropdownRef}
                      className="absolute bottom-10 sm:bottom-9 left-0 z-45 w-56 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-1.5 text-slate-705 dark:text-slate-200 animate-fade-in"
                    >
                      <div className="px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        Export Quality (MP3)
                      </div>
                      {Array.from(new Set([nativeBitrate, 192, 128, 96, 64])).filter((r): r is number => typeof r === "number" && r > 0).sort((a, b) => b - a).map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          onClick={() => {
                            setMp3Bitrate(rate);
                            setShowBitrateDropdown(false);
                            toast.success(`Export quality set to ${rate}kbps`);
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                            mp3Bitrate === rate ? 'font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/20' : ''
                          }`}
                        >
                          <span className="flex items-center gap-1.5">
                            <Music className={`w-3 h-3 ${mp3Bitrate === rate ? 'text-indigo-500' : 'text-slate-400'}`} />
                            {rate} kbps
                          </span>
                          {rate === nativeBitrate ? (
                            <span className="text-[9px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-200/50 dark:border-emerald-800/40">
                              Source
                            </span>
                          ) : rate === 192 ? (
                            <span className="text-[9px] text-slate-400 font-bold">Original</span>
                          ) : rate === 128 ? (
                            <span className="text-[9px] text-slate-400 font-medium">Light</span>
                          ) : rate === 96 ? (
                            <span className="text-[9px] text-slate-400 font-medium">Radio</span>
                          ) : (
                            <span className="text-[9px] text-slate-400 font-medium">Low</span>
                          )}
                        </button>
                      ))}
                      <div className="border-t border-slate-100 dark:border-slate-800 my-1"></div>
                      <button
                        type="button"
                        onClick={() => {
                          downloadAudio('wav');
                          setShowBitrateDropdown(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-600 dark:text-slate-300 font-medium"
                      >
                        <Download className="w-3.5 h-3.5 text-slate-400" />
                        Export Lossless WAV
                      </button>
                    </div>
                  )}
                </div>

                {isExporting && (
                  <div className="flex items-center justify-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-fade-in shadow-xs h-10 w-10 select-none">
                    <div className="relative flex items-center justify-center w-6 h-6">
                      <svg className="w-6 h-6 transform -rotate-90">
                        <circle
                          cx="12"
                          cy="12"
                          r="8"
                          className="stroke-slate-100 dark:stroke-slate-800 fill-none"
                          strokeWidth="2.5"
                        />
                        <circle
                          cx="12"
                          cy="12"
                          r="8"
                          className="stroke-indigo-600 dark:stroke-indigo-400 fill-none transition-all duration-300 ease-out"
                          strokeWidth="2.5"
                          strokeDasharray={50.27}
                          strokeDashoffset={50.27 * (1 - exportProgress / 100)}
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="absolute text-[7.5px] font-bold text-indigo-600 dark:text-indigo-400">
                        {exportProgress}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="controls-divider hidden md:block"></div>

            {/* Right Column: Non-Destructive Actions */}
            <div className="controls-column controls-right flex-1 md:flex-initial">
              <span className="controls-title text-[9.5px] sm:text-[10px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-wider block mb-2 whitespace-normal break-words leading-tight">Non-Destructive Actions</span>
              <div className="controls-button-group flex flex-wrap items-center gap-1 sm:gap-1.5 md:gap-2">
                <button
                  type="button"
                  onClick={actionCrop}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-indigo-700 bg-indigo-50/60 hover:bg-indigo-100 hover:scale-105 border border-indigo-200/70 dark:bg-indigo-950/30 dark:border-indigo-900/40 dark:text-indigo-400 rounded-lg transition-all cursor-pointer shadow-xs tooltip-align-left shrink-0"
                  data-tooltip="Crop Outers (Keep only selected region)"
                >
                  <Crop className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionCut}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-slate-700 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 rounded-lg transition-all cursor-pointer tooltip-align-left shrink-0"
                  data-tooltip="Cut Selection (Remove region and copy, Ctrl+X)"
                >
                  <Scissors className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionCopy}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-slate-700 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 rounded-lg transition-all cursor-pointer tooltip-align-left shrink-0"
                  data-tooltip="Copy Selection to Clipboard (Ctrl+C)"
                >
                  <Copy className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionPaste}
                  disabled={!clipboardBuffer}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-slate-700 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 rounded-lg transition-all cursor-pointer disabled:opacity-50 tooltip-align-left shrink-0"
                  data-tooltip="Paste Selection from Clipboard (Ctrl+V)"
                >
                  <ClipboardPaste className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionDelete}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-red-600 dark:text-red-400 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 rounded-lg transition-all cursor-pointer tooltip-align-right shrink-0"
                  data-tooltip="Delete Selection (Del/Backspace)"
                >
                  <Trash2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionSilence}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-slate-700 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 rounded-lg transition-all cursor-pointer tooltip-align-right shrink-0"
                  data-tooltip="Mute Selection"
                >
                  <VolumeX className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={actionRemoveSilences}
                  className="w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center text-slate-700 bg-slate-50 hover:bg-slate-100 hover:scale-105 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 rounded-lg transition-all cursor-pointer tooltip-align-right shrink-0"
                  data-tooltip="Remove Silences (Auto-trim gaps)"
                >
                  <Activity className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-emerald-500" />
                </button>
                {/* ─── Non-Destructive Volume / Gain Adjustment ─── */}
                <div className="relative shrink-0" ref={gainPopoverRef}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowGainPopover(prev => !prev);
                    }}
                    className={`w-7.5 h-7.5 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer shrink-0 border border-slate-200 dark:border-slate-800 ${
                      showGainPopover || gainDb !== 0
                        ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400'
                        : 'text-slate-700 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-200 dark:bg-slate-800/40 dark:border-slate-800 dark:text-slate-300 dark:hover:border-indigo-800'
                    } hover:scale-105`}
                    data-tooltip={`Volume Gain (${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`}
                  >
                    <Volume2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  </button>

                  {/* Gain Slider Popover */}
                  {showGainPopover && (
                    <div
                      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-3 animate-fade-in"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {/* Popover Arrow */}
                      <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-white dark:bg-slate-950 border-r border-b border-slate-200 dark:border-slate-800" />

                      {/* Header */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Volume Gain</span>
                        <span
                          className={`text-xs font-mono font-bold tabular-nums px-1.5 py-0.5 rounded-md ${
                            gainDb === 0
                              ? 'text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-400'
                              : gainDb > 0
                                ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-400'
                                : 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400'
                          }`}
                        >
                          {gainDb >= 0 ? '+' : ''}{gainDb.toFixed(1)} dB
                        </span>
                      </div>

                      {/* Slider with center notch */}
                      <div className="relative flex items-center h-6">
                        <input
                          type="range"
                          min={GAIN_MIN_DB}
                          max={GAIN_MAX_DB}
                          step={0.5}
                          value={gainDb}
                          onChange={(e) => setGainDb(parseFloat(e.target.value))}
                          className="w-full h-2 appearance-none rounded-full cursor-pointer outline-none
                            [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full
                            [&::-webkit-slider-runnable-track]:bg-slate-200 dark:[&::-webkit-slider-runnable-track]:bg-slate-700
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-600 dark:[&::-webkit-slider-thumb]:bg-indigo-400
                            [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:-mt-1
                            [&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full
                            [&::-moz-range-track]:bg-slate-200 dark:[&::--moz-range-track]:bg-slate-700 [&::-moz-range-track]:border-none
                            [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full
                            [&::-moz-range-thumb]:bg-indigo-600 dark:[&::-moz-range-thumb]:bg-indigo-400
                            [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-none"
                          aria-label="Volume gain in decibels"
                        />
                        {/* 0 dB notch indicator at mathematically correct position */}
                        <div
                          className="absolute w-0.5 h-3 bg-indigo-400 dark:bg-indigo-500 rounded-full opacity-60 pointer-events-none z-10"
                          style={{ left: `${GAIN_ZERO_DB_PCT}%`, transform: 'translateX(-50%)' }}
                          title="0 dB (Unity Gain)"
                        />
                      </div>

                      {/* dB Scale Labels - positioned to align 0 dB with the tick */}
                      <div className="relative mt-1 text-[9px] font-mono text-slate-400 dark:text-slate-500 px-0.5 h-3.5">
                        <span className="absolute left-0.5">{GAIN_MIN_DB} dB</span>
                        <span
                          className="absolute text-indigo-500 font-bold"
                          style={{ left: `${GAIN_ZERO_DB_PCT}%`, transform: 'translateX(-50%)' }}
                        >0 dB</span>
                        <span className="absolute right-0.5">+{GAIN_MAX_DB} dB</span>
                      </div>

                      {/* Reset to 0 dB Button */}
                      {gainDb !== 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setGainDb(0);
                            toast.info("Volume gain reset to 0 dB (unity gain)");
                          }}
                          className="mt-2 w-full py-1 text-[10px] font-bold text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg transition-colors cursor-pointer"
                        >
                          Reset to 0 dB
                        </button>
                      )}

                      {/* Limiter status indicator */}
                      {gainDb > 0 && (
                        <div className="mt-2 flex items-center gap-1.5 text-[9px] text-emerald-600 dark:text-emerald-400">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Limiter active (prevents clipping)
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
