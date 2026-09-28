import React, { useState, useRef, useEffect, useMemo } from "react";
import { FileItem } from "../types";
import {
  FileText,
  Image,
  Music,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Trash2,
  Copy,
  Code,
  FileCode2,
  Eye,
  EyeOff,
  PlayCircle,
  Video,
  FileDown,
  RefreshCw,
  FilePenLine,
  Check,
  X,
  Minimize,
  Undo,
  Redo,
  Sparkles,
  ChevronDown,
} from "lucide-react";
const ResultMarkdownRenderer = React.lazy(() => import("./ResultMarkdownRenderer"));
import { motion, AnimatePresence } from "motion/react";
import {
  bufferToMp3,
  bufferToMp3Fast,
  isAudioFile,
  decodeAudioFile,
} from "../utils/audioUtils";
import { deleteCleanvoiceEdit } from "../services/cleanvoiceService";
const WaveformAudioEditor = React.lazy(() => import("./WaveformAudioEditor").then(m => ({ default: m.WaveformAudioEditor })));

export function truncateMiddle(
  filename: string,
  maxLength: number = 24,
): string {
  if (!filename || filename.length <= maxLength) return filename;

  // Find extension
  const dotIndex = filename.lastIndexOf(".");
  let ext = "";
  let baseName = filename;

  if (dotIndex !== -1 && dotIndex > filename.length - 8) {
    ext = filename.substring(dotIndex);
    baseName = filename.substring(0, dotIndex);
  }

  const extLen = ext.length;
  const availableLen = maxLength - extLen - 3; // 3 for "..."

  if (availableLen <= 4) {
    return filename.substring(0, maxLength - 3) + "...";
  }

  const frontLen = Math.ceil(availableLen / 2);
  const backLen = Math.floor(availableLen / 2);

  return (
    baseName.substring(0, frontLen) +
    "..." +
    baseName.substring(baseName.length - backLen) +
    ext
  );
}

interface ResultCardProps {
  item: FileItem;
  onDelete: (id: string) => void;
  onProcess?: (id: string) => void;
  onCancel?: (id: string) => void;
  onEditResult?: (id: string, newResult: string) => void;
  onUpdateFile?: (
    id: string,
    newFile: Blob | File,
    newBitrate?: number,
  ) => void;
  onUpdateCleanvoiceAudio?: (
    id: string,
    newUrl: string,
    customName?: string,
    newBitrate?: number,
  ) => void;
  onRenameFile?: (id: string, newName: string) => void;
  onToggleAudioSource?: (id: string, source: "original" | "refined") => void;
  queuePosition?: number;
  selectedQuality?: "source" | "320" | "192" | "128";
  onSelectModel?: (id: string, model: string) => void;
}

const COMPRESSION_OPTIONS = [
  { kbps: 32, label: "32 kbps", desc: "Smallest" },
  { kbps: 64, label: "64 kbps", desc: "Voice" },
  { kbps: 96, label: "96 kbps", desc: "Podcast" },
  { kbps: 128, label: "128 kbps", desc: "Balanced" },
  { kbps: 192, label: "192 kbps", desc: "High Quality" },
];

const AVAILABLE_MODELS = [
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
];

function ResultCardImpl({
  item,
  onDelete,
  onProcess,
  onCancel,
  onEditResult,
  onUpdateFile,
  onRenameFile,
  onToggleAudioSource,
  onUpdateCleanvoiceAudio,
  queuePosition,
  selectedQuality: globalSelectedQuality = "source",
  onSelectModel,
}: ResultCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const compressCancelledRef = useRef<boolean>(false);
  const activeAudioCtxRef = useRef<AudioContext | null>(null);
  const [copied, setCopied] = useState(false);
  const [caseMode, setCaseMode] = useState<"original" | "lower" | "upper">(
    "original",
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editHistory, setEditHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Tracks the last result text we initialized the edit history from, so that
  // re-propagation of the SAME result (e.g. after a Save round-trip) doesn't
  // wipe the user's undo history.
  const lastSyncedResultRef = useRef<string | null>(null);
  // Container ref used to scope MathJax typesetting to THIS card's content
  // instead of the whole document (avoids O(n²) re-typesets across all cards).
  const resultContentRef = useRef<HTMLDivElement | null>(null);
  const [audioSource, setAudioSource] = useState<"original" | "refined">(
    item.useCleanedAudio ? "refined" : "original",
  );

  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowModelDropdown(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setShowModelDropdown(false);
      }
    }
    if (showModelDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showModelDropdown]);

  // Audio Compression State
  const [audioDuration, setAudioDuration] = useState<number>(0);
  // Map the global output-quality selector onto the per-card compress default.
  // `globalSelectedQuality` ("source"|"320"|"192"|"128") previously had NO
  // effect because this local state shadowed the prop with a different type.
  // Now the global setting pre-selects the compress kbps; the per-card buttons
  // still let the user override it.
  const [selectedQuality, setSelectedQuality] = useState<number | "original">(
    () => {
      if (globalSelectedQuality === "source") return "original";
      const kbps = parseInt(globalSelectedQuality, 10);
      if (!isNaN(kbps)) {
        // The compress control only exposes up to 192 kbps, so clamp higher
        // values (e.g. "320") down to the nearest supported option.
        return Math.min(kbps, 192);
      }
      return 128;
    },
  );
  const [isCompressing, setIsCompressing] = useState<boolean>(false);
  const [compressProgress, setCompressProgress] = useState<number>(0);
  const [compressSuccess, setCompressSuccess] = useState<boolean>(false);
  const [compressStatus, setCompressStatus] =
    useState<string>("Initializing...");

  // Local downloading state
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadStatus, setDownloadStatus] = useState<string>("");

  // Local renaming state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const [isStarting, setIsStarting] = useState(false);
  const [cleanvoiceFileSize, setCleanvoiceFileSize] = useState<number | null>(
    null,
  );

  const [windowWidth, setWindowWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1024,
  );

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const maxNameLength = windowWidth < 480 ? 18 : windowWidth < 640 ? 24 : 45;
  const displayName = truncateMiddle(item.name, maxNameLength);

  useEffect(() => {
    const cvResult = item.cleanvoiceResult;
    if (!cvResult) {
      setCleanvoiceFileSize(null);
      return;
    }

    // 1. If a cleaned/pre-transcoded blob is already cached on the result,
    //    read its size directly — zero network cost and instantaneous.
    const cachedBlob = cvResult.preTranscodedBlob || cvResult.cleanedBlob;
    if (cachedBlob) {
      setCleanvoiceFileSize(cachedBlob.size);
      return;
    }

    const urlToFetch = cvResult.preTranscodedUrl || cvResult.cleanedUrl;
    if (!urlToFetch) return;

    let aborted = false;

    // Remote Cleanvoice (R2) URLs are CORS-blocked on static hosting; use the
    // same-origin proxy as a fallback so the size probe doesn't silently fail.
    const proxyUrl =
      urlToFetch.startsWith("blob:") || urlToFetch.startsWith("/")
        ? urlToFetch
        : `/api/proxy-audio?url=${encodeURIComponent(urlToFetch)}`;

    const fetchSize = async () => {
      try {
        if (urlToFetch.startsWith("blob:")) {
          // Blob URLs don't support HEAD requests in some browsers
          // and we can't easily get their size via fetch without downloading
          // completely. Since we can't do HEAD, just do GET to blob.
          const resGet = await fetch(urlToFetch);
          if (aborted) return;
          const blob = await resGet.blob();
          if (aborted) return;
          setCleanvoiceFileSize(blob.size);
          return;
        }

        // 2. Try a direct HEAD to the remote URL first. Many R2/S3 configs
        //    permit CORS on HEAD, which sizes the file WITHOUT invoking the
        //    /api/proxy-audio serverless Function. Only if that is blocked do
        //    we fall back to the same-origin proxy.
        let length: string | null = null;
        try {
          const directRes = await fetch(urlToFetch, { method: "HEAD" });
          if (aborted) return;
          if (directRes.ok) {
            length = directRes.headers.get("content-length");
          }
        } catch {
          // CORS or network error — fall through to the proxy HEAD.
        }

        // 3. Fallback: proxy HEAD (one serverless Function invocation).
        if (!length) {
          const res = await fetch(proxyUrl, { method: "HEAD" });
          if (aborted) return;
          if (res.ok) {
            length = res.headers.get("content-length");
          }
        }

        if (length) {
          setCleanvoiceFileSize(parseInt(length, 10));
        }
      } catch (e) {
        // Suppress error to avoid terminal log output warnings
      }
    };

    fetchSize();
    return () => {
      aborted = true;
    };
  }, [
    item.cleanvoiceResult?.cleanedUrl,
    item.cleanvoiceResult?.preTranscodedUrl,
    item.cleanvoiceResult?.preTranscodedBlob,
    item.cleanvoiceResult?.cleanedBlob,
  ]);

  useEffect(() => {
    setRenameValue(item.name);
  }, [item.name]);

  useEffect(() => {
    setAudioSource(item.useCleanedAudio ? "refined" : "original");
  }, [item.useCleanedAudio]);

  const handleSaveRename = () => {
    if (renameValue.trim() && renameValue.trim() !== item.name) {
      if (onRenameFile) {
        onRenameFile(item.id, renameValue.trim());
      }
    }
    setIsRenaming(false);
  };

  useEffect(() => {
    const text = item.result || "";
    // Only (re)initialize the edit buffer + undo history when the result text
    // actually changes. After a Save, the parent echoes the same text back via
    // this prop; resetting here would destroy the user's undo history.
    if (lastSyncedResultRef.current === text) return;
    lastSyncedResultRef.current = text;
    setEditText(text);
    setEditHistory([text]);
    setHistoryIndex(0);
  }, [item.result]);

  const handleEditTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setEditText(newText);
    const newHistory = editHistory.slice(0, historyIndex + 1);
    newHistory.push(newText);
    setEditHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const handleUndoEdit = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      setHistoryIndex(prevIndex);
      setEditText(editHistory[prevIndex]);
    }
  };

  const handleRedoEdit = () => {
    if (historyIndex < editHistory.length - 1) {
      const nextIndex = historyIndex + 1;
      setHistoryIndex(nextIndex);
      setEditText(editHistory[nextIndex]);
    }
  };

  const getCasedText = (text: string): string => {
    if (!text) return "";
    if (caseMode === "lower") return text.toLowerCase();
    if (caseMode === "upper") return text.toUpperCase();
    return text;
  };

  const getWordCount = (text: string): number => {
    if (!text) return 0;
    const cleanText = text.trim();
    if (!cleanText) return 0;
    return cleanText.split(/\s+/).length;
  };

  useEffect(() => {
    if (item.file) {
      const url = URL.createObjectURL(item.file);
      setPreviewUrl(url);

      if (isAudioFile({ name: item.name, type: item.type })) {
        const audio = new Audio(url);
        audio.onloadedmetadata = () => {
          if (audio.duration === Infinity) {
            // FIX (long-recording hang): clamp seek to 24h + 1.5s hard timeout
            // so a long WebM recording never blocks the card on metadata seek.
            let settled = false;
            const fallbackId = setTimeout(() => {
              if (settled) return;
              settled = true;
              audio.ondurationchange = null;
              try { audio.currentTime = 0; } catch (_) {}
            }, 1500);
            audio.ondurationchange = () => {
              if (settled) return;
              settled = true;
              clearTimeout(fallbackId);
              audio.currentTime = 0;
              if (Number.isFinite(audio.duration)) {
                setAudioDuration(audio.duration);
              }
            };
            audio.currentTime = 86400; // 24h clamp; browser snaps to real end
          } else {
            setAudioDuration(audio.duration);
          }
        };
        audioRef.current = audio;
      }

      if (
        item.type.startsWith("text/") ||
        item.type === "application/json" ||
        item.name.endsWith(".md") ||
        item.name.endsWith(".csv")
      ) {
        const reader = new FileReader();
        reader.onload = (e) => {
          setTextContent(e.target?.result as string);
        };
        reader.readAsText(item.file);
      }

      return () => {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        URL.revokeObjectURL(url);
      };
    }
  }, [item.file]);

  // Trigger MathJax typesetting when result changes or raw view is toggled or case mode changes.
  // Scope to THIS card's content container instead of the whole document, so N
  // cards on screen each only re-typeset their own math (was O(n²) globally).
  useEffect(() => {
    if (item.status === "success" && !showRaw && (window as any).MathJax) {
      // Small timeout to ensure DOM is updated before typesetting
      setTimeout(() => {
        const mathjax = (window as any).MathJax;
        if (mathjax.typesetPromise) {
          // typesetPromise accepts an element (or array); fall back to no-arg
          // if the installed version doesn't support scoping.
          const target = resultContentRef.current;
          if (target) {
            mathjax.typesetPromise(target).catch(() => {});
          } else {
            mathjax.typesetPromise().catch(() => {});
          }
        }
      }, 50);
    }
  }, [item.result, item.status, showRaw, caseMode]);

  const handleCopy = () => {
    const textToCopy = getCasedText(item.result || "");
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadResult = () => {
    const textToDownload = getCasedText(item.result || "");
    if (textToDownload) {
      const blob = new Blob([textToDownload], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      // Create a sensible filename based on the original file
      const originalName = item.name;
      const nameWithoutExt =
        originalName.substring(0, originalName.lastIndexOf(".")) ||
        originalName;
      a.download = `${nameWithoutExt}_result_${caseMode}.md`;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const getIcon = () => {
    if (item.type.startsWith("image/"))
      return <Image className="w-5 h-5 text-blue-500" />;
    if (isAudioFile({ name: item.name, type: item.type }))
      return <Music className="w-5 h-5 text-purple-500" />;
    if (item.type.startsWith("video/"))
      return <Video className="w-5 h-5 text-pink-500" />;
    if (item.type === "application/pdf")
      return <FileText className="w-5 h-5 text-red-500" />;
    return <FileText className="w-5 h-5 text-slate-500" />;
  };

  const handleDownload = async () => {
    if (
      isAudioFile({ name: item.name, type: item.type }) &&
      audioSource === "refined" &&
      item.cleanvoiceResult?.cleanedUrl
    ) {
      if (isDownloading) return;

      const dotIndex = item.name.lastIndexOf(".");
      const baseName =
        dotIndex !== -1 ? item.name.substring(0, dotIndex) : item.name;

      const urlToFetch = item.cleanvoiceResult.cleanedUrl;

      // If cleanedUrl is a local blob: URL, the audio was already compressed
      // locally (e.g., via the Compress button). Download it directly — no
      // re-fetch or re-transcoding needed. This must be checked BEFORE the
      // preTranscodedBlob check, because compression clears that stale cache
      // and points cleanedUrl at the freshly-compressed blob.
      if (urlToFetch.startsWith("blob:")) {
        const downloadName =
          item.cleanvoiceResult?.cleanedFileName || `${baseName}_cleaned.mp3`;
        const a = document.createElement("a");
        a.href = urlToFetch;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }

      // Deliver pre-transcoded file instantly with 0 delay if available.
      // NOTE: we also enter when only `preTranscodedUrl` survives. The
      // aggressive auto-GC (triggerGcRequest in App.tsx) clears the
      // `preTranscodedBlob` JS reference to drop memory, but a blob: URL
      // keeps the underlying Blob alive in the browser's blob store until
      // revoked — so `preTranscodedUrl` is still a valid, downloadable URL.
      // Without this check the download would fall through to a slow
      // re-fetch + re-transcode even though transcoding already finished.
      if (
        item.cleanvoiceResult?.preTranscodedBlob ||
        item.cleanvoiceResult?.preTranscodedUrl
      ) {
        try {
          const isTempUrl = !item.cleanvoiceResult.preTranscodedUrl;
          const transUrl =
            item.cleanvoiceResult.preTranscodedUrl ||
            URL.createObjectURL(item.cleanvoiceResult.preTranscodedBlob!);
          const downloadBitrateLabel = item.sourceBitrate
            ? `${String(item.sourceBitrate).match(/\d+/)?.[0] || "128"}kbps`
            : "128kbps";
          const downloadName = `${baseName}_cleaned_${downloadBitrateLabel}.mp3`;

          const a = document.createElement("a");
          a.href = transUrl;
          a.download = downloadName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // Defer revoking the blob URL: some browsers initiate the download
          // fetch asynchronously after click(), and revoking synchronously can
          // abort the download with a network error.
          if (isTempUrl) {
            setTimeout(() => URL.revokeObjectURL(transUrl), 4000);
          }

          // Delete from cloud immediately in background
          if (item.cleanvoiceResult.editId) {
            const apiKey = localStorage.getItem("cleanvoice_api_key");
            // Use the shared deleteCleanvoiceEdit() which sends the correct
            // X-API-Key auth header (Cleanvoice v2 rejects Authorization: Bearer)
            // and targets the proper /v2/edits/<id> endpoint.
            if (apiKey) {
              deleteCleanvoiceEdit(item.cleanvoiceResult.editId, apiKey).catch(
                (err) => {
                  console.warn(
                    "ResultCard: failed to delete cloud task background:",
                    err,
                  );
                },
              );
            }
          }
          return;
        } catch (err) {
          console.error(
            "Direct download of preTranscodedBlob failed, falling back",
            err,
          );
        }
      }

      // Fallback: fetch + transcode on-the-fly via the fast server-side native
      // ffmpeg path (/api/transcode-audio), falling back to FFmpeg WASM.
      // Replaces the old inline-lamejs-worker path which depended on
      // /api/wasm-audio-encoder.js (nonexistent on Netlify) and a CDN fallback.
      setIsDownloading(true);
      setDownloadStatus("Fetching audio...");
      setDownloadProgress(5);
      try {
        // Prefer cached blobs before hitting the network.
        let rawBlob: Blob | null =
          item.cleanvoiceResult?.preTranscodedBlob ||
          item.cleanvoiceResult?.cleanedBlob ||
          null;

        // The auto-GC may have cleared the Blob references above while
        // leaving `preTranscodedUrl` (a blob: URL) intact. The blob: URL
        // still resolves to the transcoded bytes, so recover them from
        // there instead of re-fetching the (often expired) remote URL.
        if (
          !rawBlob &&
          item.cleanvoiceResult?.preTranscodedUrl?.startsWith("blob:")
        ) {
          try {
            const res = await fetch(item.cleanvoiceResult.preTranscodedUrl);
            rawBlob = await res.blob();
          } catch {
            // blob: URL no longer valid — fall through to network fetch
          }
        }

        const downloadBitrate = (() => {
          const sb = item.sourceBitrate
            ? String(item.sourceBitrate).match(/\d+/)?.[0]
            : null;
          return sb ? parseInt(sb, 10) : 128;
        })();

        // Primary: server-side native ffmpeg transcode (fast). Fetches +
        // transcodes the source URL in one round-trip.
        let finalBlob: Blob | null = null;
        try {
          const { transcodeViaServer } = await import("../utils/audioUtils");
          finalBlob = await transcodeViaServer(
            urlToFetch,
            downloadBitrate,
            "mp3",
            `${baseName}_cleaned.mp3`,
          );
        } catch (serverErr) {
          console.warn("[Download] Server transcode failed, falling back to WASM:", serverErr);
        }

        // Fallback: fetch raw blob + client-side FFmpeg WASM transcode.
        if (!finalBlob) {
          if (!rawBlob) {
            let response;
            try {
              response = await fetch(urlToFetch);
              if (!response.ok) throw new Error("direct fetch fallback");
            } catch (err) {
              const proxyUrl =
                urlToFetch.startsWith("blob:") || urlToFetch.startsWith("/")
                  ? urlToFetch
                  : `/api/proxy-audio?url=${encodeURIComponent(urlToFetch)}`;
              response = await fetch(proxyUrl);
            }
            if (response.headers.get("content-type")?.includes("text/html")) {
              throw new Error("Proxy returned HTML");
            }
            rawBlob = await response.blob();
          }

          setDownloadStatus("Transcoding to MP3...");
          setDownloadProgress(50);
          const { transcodeBlobFast } = await import("../utils/audioUtils");
          finalBlob = await transcodeBlobFast(
            rawBlob,
            downloadBitrate,
            "mp3",
            (p) => {
              setDownloadProgress(Math.round(50 + p * 50));
            },
          );
        }

        setDownloadStatus("Download ready");
        setDownloadProgress(100);

        if (!finalBlob) throw new Error("Transcode produced no output");
        const localUrl = URL.createObjectURL(finalBlob);
        const downloadBitrateLabel = `${downloadBitrate}kbps`;
        const downloadName = `${baseName}_cleaned_${downloadBitrateLabel}.mp3`;

        const a = document.createElement("a");
        a.href = localUrl;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(localUrl), 4000);

        if (item.cleanvoiceResult?.editId) {
          const apiKey = localStorage.getItem("cleanvoice_api_key");
          if (apiKey) {
            deleteCleanvoiceEdit(item.cleanvoiceResult.editId, apiKey).catch(
              (err) => {
                console.warn(
                  "ResultCard: failed to delete cloud task background:",
                  err,
                );
              },
            );
          }
        }
      } catch (err) {
        console.error("[Download] Transcoding failed:", err);
      } finally {
        setIsDownloading(false);
        setTimeout(() => {
          setDownloadStatus("");
          setDownloadProgress(0);
        }, 800);
      }

      return;
    }

    if (previewUrl) {
      const isAudio = isAudioFile({ name: item.name, type: item.type });

      const requiresTranscoding =
        isAudio &&
        ((item.name.toLowerCase().endsWith(".mp3") &&
          !item.file?.type?.includes("mpeg") &&
          !item.file?.type?.includes("mp3")) ||
          (item.name.toLowerCase().endsWith(".wav") &&
            !item.file?.type?.includes("wav")) ||
          (item.name.toLowerCase().endsWith(".m4a") &&
            !item.file?.type?.includes("mp4") &&
            !item.file?.type?.includes("m4a")) ||
          (item.name.toLowerCase().endsWith(".ogg") &&
            !item.file?.type?.includes("ogg")));

      if (requiresTranscoding && item.file) {
        setIsDownloading(true);
        setDownloadStatus("Transcoding to MP3...");
        setDownloadProgress(20);
        try {
          const { transcodeBlobFast } = await import("../utils/audioUtils");
          const downloadBitrate = (() => {
            const sb = item.sourceBitrate
              ? String(item.sourceBitrate).match(/\d+/)?.[0]
              : null;
            return sb ? parseInt(sb, 10) : 128;
          })();

          let inExt = item.originalExtension || "webm";
          if (item.file.type?.includes("mp4")) inExt = "m4a";
          else if (item.file.type?.includes("ogg")) inExt = "ogg";
          else if (item.file.type?.includes("wav")) inExt = "wav";
          else if (item.name.toLowerCase().endsWith(".m4a")) inExt = "m4a";
          else if (item.name.toLowerCase().endsWith(".ogg")) inExt = "ogg";
          else if (item.name.toLowerCase().endsWith(".wav")) inExt = "wav";

          const finalBlob = await transcodeBlobFast(
            item.file,
            downloadBitrate,
            inExt,
            (p) => {
              setDownloadProgress(Math.round(20 + p * 80));
            },
          );

          const localUrl = URL.createObjectURL(finalBlob);
          let downloadName = item.name;
          if (!downloadName.toLowerCase().endsWith(".mp3")) {
            const dotIndex = downloadName.lastIndexOf(".");
            const baseName =
              dotIndex !== -1
                ? downloadName.substring(0, dotIndex)
                : downloadName;
            downloadName = `${baseName}.mp3`;
          }

          setDownloadStatus("Download ready");
          setDownloadProgress(100);

          const a = document.createElement("a");
          a.href = localUrl;
          a.download = downloadName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(localUrl), 4000);
        } catch (err) {
          console.error(
            "[Download Original] Transcoding failed, falling back:",
            err,
          );
          const a = document.createElement("a");
          a.href = previewUrl;
          a.download = item.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } finally {
          setIsDownloading(false);
          setTimeout(() => {
            setDownloadStatus("");
            setDownloadProgress(0);
          }, 800);
        }
        return;
      }

      const a = document.createElement("a");
      a.href = previewUrl;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const formatDuration = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    if (seconds === Infinity || seconds === -Infinity) return "Unknown";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (audioSource === "refined" && item.cleanvoiceResult?.duration) {
      setAudioDuration(item.cleanvoiceResult.duration / 1000);
    }
  }, [audioSource, item.cleanvoiceResult?.duration]);

  const handleAudioMetadata = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    const audioEl = e.currentTarget;
    if (audioEl.duration === Infinity) {
      // FIX (long-recording hang): seeking to 1e101 on a long WebM blob makes
      // the browser demux the whole container before firing durationchange,
      // freezing the card. Clamp the seek to 24h and add a 1.5s hard timeout so
      // we never block; on timeout we leave the duration as-is (UI keeps
      // working) instead of hanging forever.
      let settled = false;
      const fallbackId = setTimeout(() => {
        if (settled) return;
        settled = true;
        audioEl.removeEventListener("durationchange", onDurationChange);
        try { audioEl.currentTime = 0; } catch (_) {}
      }, 1500);
      const onDurationChange = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackId);
        audioEl.removeEventListener("durationchange", onDurationChange);
        try { audioEl.currentTime = 0; } catch (_) {}
        if (Number.isFinite(audioEl.duration)) {
          setAudioDuration(audioEl.duration);
        }
      };
      audioEl.addEventListener("durationchange", onDurationChange);
      audioEl.currentTime = 86400; // 24h clamp; browser snaps to real end
    } else {
      setAudioDuration(audioEl.duration);
    }
  };

  const estimateOutputSize = (duration: number, kbps: number | "original") => {
    // When estimating the "original/source" quality, use the file's actual
    // source bitrate instead of assuming 320 kbps (which over-estimates for
    // any source below that). Fall back to 192 kbps if the source is unknown.
    let rate: number;
    if (kbps === "original") {
      const matched = item.sourceBitrate
        ? String(item.sourceBitrate).match(/\d+/)
        : null;
      rate = matched ? parseInt(matched[0], 10) : 192;
    } else {
      rate = kbps;
    }
    return (duration * rate * 1000) / 8; // returns bytes
  };

  /**
   * Computes the savings (or growth) of the estimated compressed output size
   * relative to the original file size, returning the absolute percentage and
   * a UI case so the badge can switch copy + color when the compressed output
   * would actually be larger than the original (e.g. a 3 MB original upscaled
   * to 7.4 MB at 320 kbps).
   *
   * Formula: Savings % = ((Original - Estimated) / Original) * 100
   *  - Estimated < Original => 'smaller' (green)
   *  - Estimated > Original => 'larger' (amber warning)
   *  - Equal                => 'equal'  (neutral slate)
   */
  const computeSavings = (
    originalBytes: number,
    estimatedBytes: number,
  ): { pct: number; case: "smaller" | "larger" | "equal" } => {
    if (
      !originalBytes ||
      originalBytes <= 0 ||
      !Number.isFinite(originalBytes)
    ) {
      return { pct: 0, case: "equal" };
    }
    if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) {
      return { pct: 0, case: "equal" };
    }
    if (estimatedBytes === originalBytes) {
      return { pct: 0, case: "equal" };
    }
    const signedPct = ((originalBytes - estimatedBytes) / originalBytes) * 100;
    if (estimatedBytes > originalBytes) {
      return { pct: Math.abs(signedPct), case: "larger" };
    }
    return { pct: signedPct, case: "smaller" };
  };

  const handleCompressAudio = async () => {
    // Re-entrancy guard: a double-click before setIsCompressing(true) flushes
    // could otherwise spawn two concurrent compressions racing on the same
    // AudioContext, progress callback, and single compressCancelledRef.
    if (isCompressing) return;
    if (!onUpdateFile) return;
    setIsCompressing(true);
    setCompressProgress(0);
    setCompressSuccess(false);
    setCompressStatus("Initializing...");
    compressCancelledRef.current = false;
    let audioCtx: AudioContext | null = null;
    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
      if (compressCancelledRef.current) {
        clearInterval(progressInterval);
        return;
      }
      if (fakeProgress < 35) {
        fakeProgress += Math.random() * 2 + 0.5;
        if (fakeProgress > 35) {
          fakeProgress = 35;
        }
        setCompressProgress(Math.round(fakeProgress));
      }
    }, 120);

    try {
      audioCtx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      activeAudioCtxRef.current = audioCtx;

      let blobInput: Blob | File;
      const isRefined =
        audioSource === "refined" && item.cleanvoiceResult?.cleanedUrl;

      if (isRefined) {
        if (compressCancelledRef.current) return;
        setCompressStatus("Fetching audio...");

        // Prefer already-cached blobs. Cleanvoice's R2 download URLs are
        // ephemeral (deleted after processing), so re-fetching them usually
        // 404s. The background transcode caches a local copy we can reuse.
        const cachedBlob =
          item.cleanvoiceResult?.preTranscodedBlob ||
          item.cleanvoiceResult?.cleanedBlob ||
          null;

        if (cachedBlob) {
          blobInput = cachedBlob;
        } else {
          const urlToFetch = item.cleanvoiceResult!.cleanedUrl!;
          const isRemote =
            !urlToFetch.startsWith("blob:") && !urlToFetch.startsWith("/");
          if (
            isRemote &&
            typeof navigator !== "undefined" &&
            !navigator.onLine
          ) {
            throw new Error(
              "You are offline. Unable to compress remote Cleanvoice files while offline.",
            );
          }
          // No cached blob: try direct, then same-origin proxy (bypasses CORS).
          let blobInputRes: Response;
          try {
            const res = await fetch(urlToFetch);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            blobInputRes = res;
          } catch (directErr) {
            const proxyUrl = `/api/proxy-audio?url=${encodeURIComponent(urlToFetch)}`;
            const res = await fetch(proxyUrl);
            if (!res.ok)
              throw new Error("Failed to fetch refined audio for compression");
            blobInputRes = res;
          }
          blobInput = await blobInputRes.blob();
        }
      } else {
        blobInput = item.file;
      }

      if (compressCancelledRef.current) return;
      setCompressStatus("Decoding audio...");
      // Use set timeout to let UI flush
      await new Promise((r) => setTimeout(r, 50));
      if (compressCancelledRef.current) return;
      const audioBuffer = await decodeAudioFile(blobInput, audioCtx);

      if (compressCancelledRef.current) return;
      setCompressStatus("Resampling...");
      const onEncodeProgress = (p: number) => {
        if (compressCancelledRef.current) return;
        clearInterval(progressInterval);
        const unifiedProgress = Math.round(35 + p * 65);
        setCompressProgress(unifiedProgress);
        if (p === 0) {
          setCompressStatus("Resampling...");
        } else {
          setCompressStatus("Encoding...");
        }
      };

      const targetKbps = (() => {
        if (selectedQuality === "original") {
          const matched = item.sourceBitrate
            ? String(item.sourceBitrate).match(/\d+/)
            : null;
          return matched ? parseInt(matched[0], 10) : 128;
        }
        return selectedQuality;
      })();

      // Try the ultra-fast FFmpeg WASM path first; fall back to lamejs if it fails.
      // Both use the same LAME algorithm, so quality is identical — only speed differs.
      let mp3Blob: Blob;
      try {
        mp3Blob = await bufferToMp3Fast(
          audioBuffer,
          targetKbps,
          onEncodeProgress,
        );
      } catch (fastErr: any) {
        console.warn(
          "[Compress] Fast FFmpeg encode failed, falling back to lamejs:",
          fastErr,
        );
        mp3Blob = await bufferToMp3(audioBuffer, targetKbps, onEncodeProgress);
      }

      if (compressCancelledRef.current) return;
      clearInterval(progressInterval);
      setCompressProgress(100);
      setCompressStatus("Success!");
      setCompressSuccess(true);

      const originalName = item.name;
      const dotIndex = originalName.lastIndexOf(".");
      const baseName =
        dotIndex !== -1 ? originalName.substring(0, dotIndex) : originalName;
      // Do not append _cleaned, just use _compressed_XXk as requested by user
      const displayQuality =
        selectedQuality === "original" ? "original" : `${selectedQuality}k`;
      const newName = `${baseName}_compressed_${displayQuality}.mp3`;

      const newFile = new File([mp3Blob], newName, { type: "audio/mp3" });

      if (isRefined && onUpdateCleanvoiceAudio) {
        const objUrl = URL.createObjectURL(newFile);
        onUpdateCleanvoiceAudio(item.id, objUrl, newName, targetKbps);
      } else if (onUpdateFile && !isRefined) {
        onUpdateFile(item.id, newFile, targetKbps);
      }

      // Automatically clear success state after a delay
      setTimeout(() => {
        if (!compressCancelledRef.current) {
          setCompressSuccess(false);
        }
      }, 2500);
    } catch (err) {
      clearInterval(progressInterval);
      if (!compressCancelledRef.current) {
        console.error("Compression failed:", err);
        setCompressStatus("Failed!");
        setCompressSuccess(false);
      }
    } finally {
      clearInterval(progressInterval);
      if (audioCtx && audioCtx.state !== "closed") {
        try {
          await audioCtx.close();
        } catch (closeErr) {
          console.error("Error closing AudioContext:", closeErr);
        }
      }
      activeAudioCtxRef.current = null;
      if (!compressCancelledRef.current) {
        setIsCompressing(false);
      }
    }
  };

  const handleCancelCompression = () => {
    compressCancelledRef.current = true;
    setIsCompressing(false);
    setCompressProgress(0);
    setCompressSuccess(false);
    setCompressStatus("Cancelled");
    if (
      activeAudioCtxRef.current &&
      activeAudioCtxRef.current.state !== "closed"
    ) {
      try {
        activeAudioCtxRef.current.close();
      } catch (e) {
        console.error("Error closing AudioContext on cancel:", e);
      }
    }
    activeAudioCtxRef.current = null;
  };

  const formatSize = (bytes: number) => {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.max(
      0,
      Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))),
    );
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const isTextFile =
    item.type.startsWith("text/") ||
    item.type === "application/json" ||
    item.name.endsWith(".md") ||
    item.name.endsWith(".csv");

  const currentFileSize =
    audioSource === "refined"
      ? (item.cleanvoiceResult?.preTranscodedBlob?.size ||
         item.cleanvoiceResult?.cleanedBlob?.size ||
         cleanvoiceFileSize ||
         item.file?.size ||
         0)
      : item.file?.size || 0;

  return (
    <div
      className="relative overflow-visible w-full rounded-xl"
      id={`swipe-container-${item.id}`}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -150 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="theme-card-bg theme-border theme-shadow overflow-visible rounded-xl relative z-10"
      >
        <div className="bg-slate-50/70 dark:bg-slate-950/30 border-b border-slate-200/80 dark:border-slate-850 px-3 sm:px-4 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 overflow-visible rounded-t-xl">
          {/* Left Section: File Name & Controls.
            `overflow-hidden` is required for the resting filename's `truncate`
            path, but would crop the trailing Cancel (X) button during rename on
            desktop. Conditionally switch to `overflow-visible` only while the
            rename input is active so both Check + X stay fully visible. */}
          <div
            className={`flex items-center gap-2 w-full sm:flex-1 min-w-0 ${isRenaming ? "overflow-visible" : "overflow-hidden"}`}
          >
            <div className="shrink-0">{getIcon()}</div>
            {/* Rename-mode row. The parent left section toggles to
              `overflow-visible` during rename (see above) so the Check + X
              buttons are never cropped on desktop, where the header shares one
              flex row with the action toolbar. The input keeps a comfortable
              responsive min-width so the field stays clearly usable, while
              `max-w-[240px]` bounds its growth on very wide screens. */}
            {isRenaming ? (
              <div className="flex items-center gap-1.5 py-0.5 flex-1 min-w-0 overflow-visible">
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  aria-label="Rename file"
                  // On focus, auto-select only the filename (excluding the final
                  // extension) so the user retypes the name but preserves the ext.
                  // e.g. "1_cleaned.mp3" highlights "1_cleaned", leaving ".mp3".
                  onFocus={(e) => {
                    const name = item.name;
                    const dot = name.lastIndexOf(".");
                    // Treat as an extension only if the dot is non-leading and the
                    // suffix is short (<= 6 chars) — avoids treating ".gitignore"
                    // style names as having no name portion.
                    const extLen =
                      dot > 0 && name.length - dot - 1 <= 6
                        ? name.length - dot
                        : 0;
                    const end = Math.max(0, name.length - extLen);
                    const input = e.currentTarget;
                    // Defer so the selection sticks across browsers.
                    requestAnimationFrame(() => {
                      try {
                        input.setSelectionRange(0, end);
                      } catch {
                        /* no-op: some input types reject setSelectionRange */
                      }
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveRename();
                    if (e.key === "Escape") {
                      setRenameValue(item.name);
                      setIsRenaming(false);
                    }
                  }}
                  className="px-2.5 py-2.5 md:py-1 h-11 md:h-auto text-sm md:text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-850 rounded-lg text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:focus-within:ring-indigo-500/20 flex-1 min-w-[120px] sm:min-w-[160px] max-w-[240px]"
                  autoFocus
                />
                <button
                  onClick={handleSaveRename}
                  className="p-3 md:p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 rounded-md transition-colors cursor-pointer shrink-0 md:min-w-0 md:min-h-0"
                  data-tooltip="Save Name"
                  aria-label="Save new filename"
                >
                  <Check className="w-5 h-5 md:w-4 md:h-4" />
                </button>
                <button
                  onClick={() => {
                    setRenameValue(item.name);
                    setIsRenaming(false);
                  }}
                  className="p-3 md:p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md transition-colors cursor-pointer shrink-0 md:min-w-0 md:min-h-0"
                  data-tooltip="Cancel"
                  aria-label="Cancel renaming"
                >
                  <X className="w-5 h-5 md:w-4 md:h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group select-none overflow-hidden min-w-0 flex-1">
                <span
                  className="font-semibold text-slate-700 dark:text-slate-200 truncate block text-sm sm:text-sm md:text-base animate-pulse-once cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors py-2 md:py-0 w-full min-h-[44px] md:min-h-[unset] flex items-center"
                  data-tooltip={`${item.name} - Long-press/hover to rename`}
                  onClick={() => {
                    setRenameValue(item.name);
                    setIsRenaming(true);
                  }}
                >
                  {displayName}
                </span>
              </div>
            )}
            {!isRenaming && (
              <span className="text-[10px] sm:text-[11.5px] text-slate-500 dark:text-slate-400 font-sans font-medium shrink-0 ml-auto sm:ml-2 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800/80 rounded border border-slate-200/50 dark:border-slate-700/50 shadow-xs">
                {formatSize(currentFileSize)}
              </span>
            )}
          </div>

          {/* Right Section: Status Indicator & Action Buttons */}
          <div className="flex flex-col sm:flex-row items-center sm:justify-end gap-2.5 sm:gap-2.5 w-full sm:w-auto shrink-0 border-t sm:border-t-0 pt-2.5 sm:pt-0 border-slate-200/50 dark:border-slate-800/50">
            {/* Status Badge */}
            <div className="flex items-center gap-1.5 shrink-0 font-sans">
              {item.status === "pending" && (
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-350 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full border border-slate-200/50 dark:border-slate-700/50">
                  Pending
                </span>
              )}
              {item.status === "queued" && (
                <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full flex items-center gap-1.5 border border-amber-200/50 dark:border-amber-900/30">
                  Queued
                  {queuePosition !== undefined && (
                    <span className="text-[10px] bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded-full ml-0.5">
                      #{queuePosition}
                    </span>
                  )}
                </span>
              )}
              {item.status === "processing" && (
                <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full flex items-center gap-1.5 shadow-[0_0_8px_rgba(99,102,241,0.25)] border border-indigo-200 dark:border-indigo-850">
                  <Loader2 className="w-3 h-3 animate-spin text-indigo-550" />{" "}
                  <span className="animate-pulse">Processing...</span>
                </span>
              )}
              {item.status === "success" && (
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full flex items-center gap-1.5 border border-emerald-200/50 dark:border-emerald-900/30">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Success
                </span>
              )}
              {item.status === "error" && (
                <span className="text-xs font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full flex items-center gap-1.5 border border-red-200/50 dark:border-red-900/30">
                  <AlertCircle className="w-3.5 h-3.5" /> Error
                </span>
              )}
            </div>

            {/* Action Buttons Toolbar
              MOBILE: forced single-line (flex-nowrap) so all utility icons
              (View / Refresh / Case / Code / Copy / Download / Delete) stay on
              one horizontal row instead of wrapping the last icons to a 2nd line.
              Icon + gap sizes scale down on <640px so the row never forces
              horizontal page overflow. DESKTOP (sm:+) is unchanged. */}
            <div className="rc-action-toolbar flex items-center justify-center gap-1 sm:gap-1.5 border-t sm:border-t-0 sm:border-l border-slate-200/60 dark:border-slate-800/85 pt-2.5 sm:pt-0 pl-0 sm:pl-2.5 w-full sm:w-auto flex-nowrap overflow-visible">
              {item.status === "pending" && onProcess && (
                <button
                  onClick={async () => {
                    setIsStarting(true);
                    try {
                      await onProcess(item.id);
                    } finally {
                      setIsStarting(false);
                    }
                  }}
                  disabled={isStarting}
                  className="p-1 sm:p-1.5 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 active:bg-indigo-100 dark:active:bg-indigo-950/50 hover:scale-105 active:scale-90 rounded-lg transition-all flex items-center justify-center cursor-pointer border border-transparent w-[34px] h-[34px] shrink-0"
                  aria-label="Start Processing"
                  data-tooltip="Start Processing"
                >
                  {isStarting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <PlayCircle className="w-4 h-4 sm:w-5 sm:h-5 animate-pulse" />
                  )}
                </button>
              )}
              {(item.status === "queued" || item.status === "processing") &&
                onCancel && (
                  <button
                    onClick={() => onCancel(item.id)}
                    className="p-1 sm:p-1.5 text-rose-600 dark:text-rose-450 hover:bg-rose-50 dark:hover:bg-rose-950/30 active:bg-rose-100 dark:active:bg-rose-950/50 hover:scale-105 active:scale-90 rounded-lg transition-all flex items-center justify-center cursor-pointer border border-transparent w-[34px] h-[34px] shrink-0"
                    aria-label="Cancel Processing"
                    data-tooltip="Cancel Processing"
                  >
                    <X className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                  </button>
                )}
              {item.status === "error" && onProcess && (
                <button
                  onClick={async () => {
                    setIsStarting(true);
                    try {
                      await onProcess(item.id);
                    } finally {
                      setIsStarting(false);
                    }
                  }}
                  disabled={isStarting}
                  className="p-1 sm:p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 active:bg-indigo-100 animate-pulse border border-transparent w-[34px] h-[34px] rounded-lg hover:scale-105 active:scale-90 transition-all flex items-center justify-center cursor-pointer shrink-0"
                  aria-label="Retry Processing"
                  data-tooltip="Retry Processing"
                >
                  {isStarting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  )}
                </button>
              )}
              <button
                onClick={() => setShowPreview(!showPreview)}
                className={`p-1 sm:p-1.5 rounded-lg transition-all hover:scale-105 active:scale-95 border border-transparent w-[34px] h-[34px] flex items-center justify-center shrink-0 ${showPreview ? "bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200" : "text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800"}`}
                aria-label={showPreview ? "Hide Preview" : "Show Preview"}
                data-tooltip={showPreview ? "Hide Preview" : "Show Preview"}
              >
                {showPreview ? (
                  <EyeOff className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                ) : (
                  <Eye className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                )}
              </button>
              {item.status === "success" && item.result && (
                <>
                  <button
                    onClick={async () => {
                      setIsStarting(true);
                      try {
                        await onProcess(item.id);
                      } finally {
                        setIsStarting(false);
                      }
                    }}
                    disabled={isStarting}
                    className="p-1 sm:p-1.5 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800 active:bg-indigo-100 dark:active:bg-slate-750 hover:scale-105 active:scale-95 rounded-lg transition-all border border-transparent w-[34px] h-[34px] flex items-center justify-center shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Retry"
                    data-tooltip="Retry"
                  >
                    {isStarting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                    )}
                  </button>
                  <div className="flex bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg border border-slate-200/50 dark:border-slate-800/80 h-[34px] items-center shrink-0">
                    <button
                      onClick={() => setCaseMode("original")}
                      aria-label="Original Case"
                      data-tooltip="Original Case"
                      className={`w-[28px] h-full flex items-center justify-center rounded transition-all shrink-0 text-[11px] font-bold font-sans leading-none ${caseMode === "original" ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-xs" : "text-slate-500 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-200"}`}
                    >
                      Aa
                    </button>
                    <button
                      onClick={() => setCaseMode("lower")}
                      aria-label="lowercase"
                      data-tooltip="lowercase"
                      className={`w-[28px] h-full flex items-center justify-center rounded transition-all shrink-0 text-[11px] font-bold font-sans leading-none ${caseMode === "lower" ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-xs" : "text-slate-500 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-200"}`}
                    >
                      aa
                    </button>
                    <button
                      onClick={() => setCaseMode("upper")}
                      aria-label="Uppercase"
                      data-tooltip="Uppercase"
                      className={`w-[28px] h-full flex items-center justify-center rounded transition-all shrink-0 text-[11px] font-bold font-sans leading-none ${caseMode === "upper" ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-xs" : "text-slate-500 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-200"}`}
                    >
                      AA
                    </button>
                  </div>
                  <button
                    onClick={() => setShowRaw(!showRaw)}
                    className={`p-1 sm:p-1.5 rounded-lg transition-all hover:scale-105 active:scale-95 border border-transparent w-[34px] h-[34px] flex items-center justify-center shrink-0 ${showRaw ? "bg-slate-200 dark:bg-slate-800 text-slate-705 dark:text-slate-200" : "text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800"}`}
                    aria-label={
                      showRaw ? "Show Rendered Math" : "Show Raw Text"
                    }
                    data-tooltip={
                      showRaw ? "Show Rendered Math" : "Show Raw Text"
                    }
                  >
                    {showRaw ? (
                      <FileCode2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                    ) : (
                      <Code className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                    )}
                  </button>
                  <button
                    onClick={handleCopy}
                    className="p-1 sm:p-1.5 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800 active:bg-indigo-100 dark:active:bg-slate-750 hover:scale-105 active:scale-95 rounded-lg transition-all border border-transparent w-[34px] h-[34px] flex items-center justify-center relative shrink-0 tooltip-align-right"
                    aria-label="Copy Text"
                    data-tooltip="Copy Text"
                  >
                    <Copy className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                    {copied && (
                      <span
                        className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 text-xs px-2 py-1 rounded-md border whitespace-nowrap pointer-events-none"
                        style={{
                          backgroundColor: "var(--tooltip-bg)",
                          color: "var(--tooltip-text)",
                          borderColor: "var(--tooltip-border)",
                          boxShadow: "var(--tooltip-shadow)",
                          zIndex: 100001,
                        }}
                      >
                        Copied!
                      </span>
                    )}
                  </button>
                  <button
                    onClick={handleDownloadResult}
                    className="p-1 sm:p-1.5 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:scale-105 active:scale-95 rounded-lg transition-all border border-transparent w-[34px] h-[34px] flex items-center justify-center shrink-0 tooltip-align-right"
                    aria-label="Download Result"
                    data-tooltip="Download Result"
                  >
                    <FileDown className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                  </button>
                </>
              )}
              <button
                onClick={handleDownload}
                disabled={isDownloading}
                className={`p-1 sm:p-1.5 rounded-lg transition-all border border-transparent w-[34px] h-[34px] flex items-center justify-center shrink-0 tooltip-align-right relative
                ${isDownloading ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-500 cursor-wait" : "text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800 hover:scale-105 active:scale-95 cursor-pointer"}`}
                aria-label={
                  isDownloading
                    ? downloadStatus
                    : audioSource === "refined" &&
                        item.cleanvoiceResult?.cleanedUrl
                      ? "Download cleaned file"
                      : "Download original file"
                }
                data-tooltip={
                  isDownloading
                    ? `${downloadStatus} ${downloadProgress}%`
                    : audioSource === "refined" &&
                        item.cleanvoiceResult?.cleanedUrl
                      ? "Download Cleaned"
                      : "Download Original"
                }
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="w-4 h-4 sm:w-4.5 sm:h-4.5 animate-spin" />
                    <div
                      className="absolute bottom-0 left-0 h-1 bg-indigo-500/80 rounded-b-lg transition-all"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </>
                ) : (
                  <Download className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                )}
              </button>
              <button
                onClick={() => {
                  // onDelete removes the file from state immediately and triggers
                  // the cloud delete in the background, so there is no perceived
                  // delay (no spinner/await here).
                  onDelete(item.id);
                }}
                className="p-1 sm:p-1.5 text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 hover:scale-105 active:scale-90 rounded-lg transition-all flex items-center justify-center disabled:opacity-50 cursor-pointer border border-transparent w-[34px] h-[34px] shrink-0 tooltip-align-right"
                aria-label="Delete file"
                data-tooltip="Delete File"
              >
                <Trash2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
              </button>
            </div>
          </div>
        </div>

        <div
          className={`${showPreview || (item.status === "success" && item.result) ? "p-4" : "px-3 py-2 sm:px-4 sm:py-2.5"} bg-white dark:bg-slate-900 transition-all rounded-b-xl`}
        >
          {showPreview && previewUrl && (
            <div className="mb-4 p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg flex flex-col gap-4">
              <div className="flex justify-center w-full">
                {item.type.startsWith("image/") && (
                  <img
                    src={previewUrl}
                    alt="Preview"
                    className="max-h-96 object-contain rounded border border-slate-200 dark:border-slate-800 shadow-sm"
                  />
                )}
                {isAudioFile({ name: item.name, type: item.type }) && (
                  <>
                    <audio
                      hidden
                      controls
                      preload="none"
                      className="w-full hidden"
                      onLoadedMetadata={handleAudioMetadata}
                      onCanPlay={() => {
                        // Native session cleanup hook handles proper garbage collection
                      }}
                      onDurationChange={(e) => {
                        if (
                          e.currentTarget.duration &&
                          Number.isFinite(e.currentTarget.duration)
                        ) {
                          setAudioDuration(e.currentTarget.duration);
                        }
                      }}
                      src={
                        audioSource === "refined" &&
                        item.cleanvoiceResult?.cleanedUrl
                          ? item.cleanvoiceResult.cleanedUrl
                          : previewUrl || ""
                      }
                    />
                    <div className="w-full flex flex-col gap-2.5">
                      {/* Selector for Original vs. Cleanvoice Audio */}
                      {item.cleanvoiceResult?.cleanedUrl && (
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-1.5 py-1.5 px-3 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-200/50 dark:border-slate-800/80 mb-1">
                          <div className="flex items-center gap-1.5 self-start sm:self-center">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-500 animate-pulse fill-indigo-100 dark:fill-indigo-950/40" />
                            <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                              Active Version:
                            </span>
                          </div>
                          <div className="flex bg-slate-100 dark:bg-slate-900 p-0.5 rounded-md border border-slate-200/50 dark:border-slate-800/60 items-center w-full sm:w-auto">
                            <button
                              onClick={() => {
                                setAudioSource("original");
                                if (onToggleAudioSource) {
                                  onToggleAudioSource(item.id, "original");
                                }
                              }}
                              className={`flex-1 sm:flex-none px-2.5 py-1 text-[11px] font-bold rounded-sm transition-all cursor-pointer text-center ${
                                audioSource === "original"
                                  ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-150 shadow-xs"
                                  : "text-slate-500 hover:text-slate-850 dark:hover:text-slate-200"
                              }`}
                            >
                              Original
                            </button>
                            <button
                              onClick={() => {
                                setAudioSource("refined");
                                if (onToggleAudioSource) {
                                  onToggleAudioSource(item.id, "refined");
                                }
                              }}
                              className={`flex-1 sm:flex-none px-2.5 py-1 text-[11px] font-bold rounded-sm transition-all cursor-pointer text-center ${
                                audioSource === "refined"
                                  ? "bg-indigo-600 text-white shadow-xs"
                                  : "text-slate-500 hover:text-slate-850 dark:hover:text-slate-200"
                              }`}
                            >
                              Cleanvoice
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Web Audio Editor Component */}
                      {item.file && (
                        <div className="w-full min-h-[290px] md:min-h-[310px] flex flex-col justify-start flex-shrink-0 overflow-visible">
                          <React.Suspense fallback={
                            <div className="flex flex-col items-center justify-center p-12 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                              <p className="text-slate-500 dark:text-slate-400 font-mono text-xs">Loading waveform visualizer & editor...</p>
                            </div>
                          }>
                            <WaveformAudioEditor
                              file={audioSource === "original" ? item.file : null}
                              audioUrl={
                                audioSource === "refined" && item.cleanvoiceResult
                                  ? // Prefer the locally-transcoded blob URL (avoids CORS issues
                                    // with remote S3 download URLs). Fall back to the raw
                                    // cleanedUrl if no local blob is available yet.
                                    item.cleanvoiceResult.preTranscodedUrl ||
                                    (item.cleanvoiceResult.preTranscodedBlob
                                      ? URL.createObjectURL(
                                          item.cleanvoiceResult.preTranscodedBlob,
                                        )
                                      : item.cleanvoiceResult.cleanedUrl || null)
                                  : audioSource === "original" && previewUrl
                                    ? previewUrl
                                    : null
                              }
                              fileName={item.name}
                              onUpdateFile={(newFile) =>
                                onUpdateFile?.(item.id, newFile)
                              }
                              audioSource={audioSource}
                              onToggleAudioSource={(src) => {
                                setAudioSource(src);
                                if (onToggleAudioSource) {
                                  onToggleAudioSource(item.id, src);
                                }
                              }}
                              sourceBitrate={item.sourceBitrate}
                            />
                          </React.Suspense>
                        </div>
                      )}{" "}
                      {/* Compress Audio Tool Panel */}
                      <div className="w-full bg-slate-100/60 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-inner overflow-visible">
                        <div className="px-3 sm:px-4 py-1.5 sm:py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-wrap gap-1.5">
                          <div className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
                            <Minimize className="w-4 h-4 text-indigo-500" />
                            <span className="text-xs font-bold uppercase tracking-wider">
                              Compression
                            </span>
                          </div>
                        </div>
                        <div className="p-2.5 sm:p-3.5 lg:p-4 space-y-3 sm:space-y-4">
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-xs bg-slate-50 dark:bg-slate-950/60 p-2 sm:p-3 rounded-lg border border-slate-200/50 dark:border-slate-800/50">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-extrabold text-[9.5px] sm:text-[10px]">
                                Format
                              </span>
                              <span className="font-mono text-slate-800 dark:text-slate-200 font-bold">
                                {item.name.split(".").pop()?.toUpperCase() ||
                                  "UNKNOWN"}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-extrabold text-[9.5px] sm:text-[10px]">
                                Original Size
                              </span>
                              <span className="font-mono text-slate-800 dark:text-slate-200 font-bold">
                                {formatSize(currentFileSize)}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-extrabold text-[9.5px] sm:text-[10px]">
                                Duration
                              </span>
                              <span className="font-mono text-slate-800 dark:text-slate-200 font-bold">
                                {formatDuration(audioDuration)}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-extrabold text-[9.5px] sm:text-[10px]">
                                Est. Output Size
                              </span>
                              <span className="font-mono text-indigo-600 dark:text-indigo-400 font-bold">
                                {formatSize(
                                  estimateOutputSize(
                                    audioDuration,
                                    selectedQuality,
                                  ),
                                )}
                              </span>
                            </div>
                          </div>

                          <div className="border-t border-slate-250 dark:border-slate-800/50 pt-2 sm:pt-3 space-y-2 sm:space-y-3">
                            {/* Quality choice header */}
                            <span className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 uppercase font-bold tracking-wider block">
                              Choose Output Quality
                            </span>

                            {/* Quality options and Compress button aligned on the same horizontal row */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-slate-50/50 dark:bg-slate-950/20 p-1.5 sm:p-2.5 rounded-xl border border-slate-200/40 dark:border-slate-800/40 overflow-visible">
                              {/* Quality Options Grid / Flex layout */}
                              <div className="grid grid-cols-3 sm:flex gap-1.5 sm:gap-1.5 sm:flex-row sm:items-center w-full sm:w-auto">
                                {COMPRESSION_OPTIONS.map((opt) => (
                                  <button
                                    key={opt.kbps}
                                    type="button"
                                    onClick={() => setSelectedQuality(opt.kbps)}
                                    className={`flex flex-col items-center justify-center py-2 px-1 sm:py-1.5 sm:px-1 rounded-lg border transition-all cursor-pointer select-none sm:w-[78px] sm:flex-initial ${
                                      selectedQuality === opt.kbps
                                        ? "bg-slate-900 text-white border-slate-900 dark:bg-indigo-600 dark:border-indigo-500 shadow-sm"
                                        : "bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900"
                                    }`}
                                  >
                                    <span className="font-sans font-extrabold text-[9px] xs:text-[10px] sm:text-[10px] tracking-tight leading-tight whitespace-nowrap">
                                      {opt.label}
                                    </span>
                                    <span
                                      className={`text-[8px] xs:text-[8.5px] sm:text-[8px] opacity-80 mt-0.5 tracking-tight leading-none whitespace-nowrap ${
                                        selectedQuality === opt.kbps
                                          ? "text-indigo-100 font-semibold"
                                          : "text-slate-500 font-medium"
                                      }`}
                                    >
                                      {opt.desc}
                                    </span>
                                  </button>
                                ))}
                              </div>

                              {/* Mobile Action Controls (simultaneous progress + cancel button) */}
                              <div className="flex sm:hidden items-center justify-between gap-2 w-full mt-1.5 border-t border-slate-200/50 dark:border-slate-800/40 pt-2 shrink-0">
                                {/* Left: Progress status if active/success, otherwise status description */}
                                {isCompressing || compressSuccess ? (
                                  <div className="flex items-center gap-1.5 bg-white/60 dark:bg-slate-900/60 pl-1.5 pr-2.5 py-1 rounded-lg border border-slate-200/40 dark:border-slate-800/40 shadow-sm shrink-0 animate-pulse-subtle">
                                    <div className="relative flex items-center justify-center w-5.5 h-5.5">
                                      <svg className="w-5.5 h-5.5 transform -rotate-90">
                                        <circle
                                          cx="11"
                                          cy="11"
                                          r="8.5"
                                          className="stroke-slate-250 dark:stroke-slate-850"
                                          strokeWidth="2"
                                          fill="transparent"
                                        />
                                        <circle
                                          cx="11"
                                          cy="11"
                                          r="8.5"
                                          className={`${
                                            compressSuccess
                                              ? "stroke-emerald-500"
                                              : "stroke-indigo-600 dark:stroke-indigo-400"
                                          } transition-all duration-300`}
                                          strokeWidth="2"
                                          fill="transparent"
                                          strokeDasharray={2 * Math.PI * 8.5}
                                          strokeDashoffset={
                                            2 * Math.PI * 8.5 -
                                            ((compressSuccess
                                              ? 100
                                              : compressProgress) /
                                              100) *
                                              (2 * Math.PI * 8.5)
                                          }
                                          strokeLinecap="round"
                                        />
                                      </svg>
                                      <span className="absolute text-[7px] font-bold font-mono text-slate-700 dark:text-slate-200 flex items-center justify-center">
                                        {compressSuccess ? (
                                          <Check className="w-2.5 h-2.5 text-emerald-500 font-bold" />
                                        ) : (
                                          `${compressProgress}%`
                                        )}
                                      </span>
                                    </div>
                                    <div className="flex flex-col text-left">
                                      <span
                                        className={`text-[8.5px] font-bold tracking-tight uppercase leading-none ${
                                          compressSuccess
                                            ? "text-emerald-600 dark:text-emerald-400"
                                            : "text-indigo-600 dark:text-indigo-400"
                                        }`}
                                      >
                                        {compressSuccess ? "DONE" : "PROCESS"}
                                      </span>
                                      <span className="text-[7.5px] text-slate-500 font-semibold truncate max-w-[85px] mt-0.5 leading-none">
                                        {compressStatus}
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex flex-col text-left">
                                    <span className="text-[8.5px] font-extrabold text-slate-400 uppercase tracking-wider leading-none">
                                      Compression Ready
                                    </span>
                                    <span className="text-[7px] text-slate-500 font-medium leading-none mt-1">
                                      Select file quality & press Compress
                                    </span>
                                  </div>
                                )}

                                {/* Right: The actual Compress button or Cancel action button */}
                                {onUpdateFile && (
                                  <button
                                    type="button"
                                    onClick={
                                      isCompressing
                                        ? handleCancelCompression
                                        : handleCompressAudio
                                    }
                                    disabled={
                                      (!isCompressing && compressSuccess) ||
                                      !audioDuration
                                    }
                                    className={`text-[11px] font-bold px-3 py-1.5 rounded-lg transition-all flex items-center gap-1 cursor-pointer shadow-xs duration-150 relative group ${
                                      compressSuccess
                                        ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                                        : isCompressing
                                          ? "bg-rose-500 hover:bg-rose-600 text-white border border-rose-400"
                                          : "bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400"
                                    }`}
                                  >
                                    {compressSuccess ? (
                                      <>
                                        <Check className="w-3.5 h-3.5 text-white" />
                                        <span>Done</span>
                                      </>
                                    ) : isCompressing ? (
                                      <>
                                        <X className="w-3.5 h-3.5 text-white animate-pulse" />
                                        <span>Cancel</span>
                                      </>
                                    ) : (
                                      <>
                                        <Minimize className="w-3.5 h-3.5 text-white" />
                                        <span>Compress</span>
                                      </>
                                    )}
                                  </button>
                                )}
                              </div>

                              {/* Desktop (Round/Compact) Side Toolbar for Quality choices */}
                              <div className="hidden sm:flex items-center gap-2 shrink-0 pl-1">
                                {/* Inline Circular Progress Loader */}
                                {(isCompressing || compressSuccess) && (
                                  <div className="flex items-center gap-2 bg-white/60 dark:bg-slate-900/60 pl-2 pr-3 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800/50 shadow-sm animate-fade-in shrink-0 animate-pulse-subtle">
                                    <div className="relative flex items-center justify-center w-6 h-6">
                                      <svg className="w-6 h-6 transform -rotate-90">
                                        <circle
                                          cx="12"
                                          cy="12"
                                          r="9.5"
                                          className="stroke-slate-250 dark:stroke-slate-800"
                                          strokeWidth="2"
                                          fill="transparent"
                                        />
                                        <circle
                                          cx="12"
                                          cy="12"
                                          r="9.5"
                                          className={`${
                                            compressSuccess
                                              ? "stroke-emerald-500"
                                              : "stroke-indigo-600 dark:stroke-indigo-400"
                                          } transition-all duration-300`}
                                          strokeWidth="2"
                                          fill="transparent"
                                          strokeDasharray={2 * Math.PI * 9.5}
                                          strokeDashoffset={
                                            2 * Math.PI * 9.5 -
                                            ((compressSuccess
                                              ? 100
                                              : compressProgress) /
                                              100) *
                                              (2 * Math.PI * 9.5)
                                          }
                                          strokeLinecap="round"
                                        />
                                      </svg>
                                      <span className="absolute text-[7px] font-bold font-mono text-slate-700 dark:text-slate-200 flex items-center justify-center">
                                        {compressSuccess ? (
                                          <Check className="w-2.5 h-2.5 text-emerald-500 font-bold" />
                                        ) : (
                                          `${compressProgress}%`
                                        )}
                                      </span>
                                    </div>
                                    <div className="flex flex-col text-left">
                                      <span
                                        className={`text-[8.5px] font-bold tracking-tight uppercase leading-none ${
                                          compressSuccess
                                            ? "text-emerald-600 dark:text-emerald-400"
                                            : "text-indigo-600 dark:text-indigo-400"
                                        }`}
                                      >
                                        {compressSuccess ? "DONE" : "PROCESS"}
                                      </span>
                                      <span className="text-[7.5px] text-slate-500 font-medium truncate max-w-[65px] mt-0.5 leading-none">
                                        {compressStatus}
                                      </span>
                                    </div>
                                  </div>
                                )}

                                {onUpdateFile && (
                                  <button
                                    type="button"
                                    onClick={
                                      isCompressing
                                        ? handleCancelCompression
                                        : handleCompressAudio
                                    }
                                    disabled={
                                      (!isCompressing && compressSuccess) ||
                                      !audioDuration
                                    }
                                    className={`h-[34px] w-[34px] shrink-0 rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-sm hover:scale-105 active:scale-95 duration-150 tooltip-align-right relative ${
                                      compressSuccess
                                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                        : isCompressing
                                          ? "bg-rose-500 hover:bg-rose-600 text-white border border-rose-400 shadow-rose-100 dark:shadow-none"
                                          : "bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-slate-200 dark:disabled:bg-slate-800/80 disabled:text-slate-400"
                                    }`}
                                    data-tooltip={
                                      compressSuccess
                                        ? "Compression Done!"
                                        : isCompressing
                                          ? "Cancel compression"
                                          : "Apply audio compression"
                                    }
                                  >
                                    {compressSuccess ? (
                                      <Check className="w-4 h-4 text-white" />
                                    ) : isCompressing ? (
                                      <X className="w-4 h-4 text-white hover:rotate-90 transition-transform duration-200" />
                                    ) : (
                                      <Minimize className="w-4 h-4 text-white" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Quality options list */}
                            <div className="space-y-2.5">
                              <div className="text-[11px] text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-1.5">
                                <span className="text-slate-500 dark:text-slate-400">
                                  Estimated savings:
                                </span>
                                <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                                  {formatSize(currentFileSize)} &rarr;{" "}
                                  {formatSize(
                                    estimateOutputSize(
                                      audioDuration,
                                      selectedQuality,
                                    ),
                                  )}
                                </span>
                                {(() => {
                                  const estimatedBytes = estimateOutputSize(
                                    audioDuration,
                                    selectedQuality,
                                  );
                                  const { pct, case: savingsCase } =
                                    computeSavings(
                                      currentFileSize,
                                      estimatedBytes,
                                    );
                                  const rounded = Math.round(pct);
                                  const badgeClass =
                                    savingsCase === "smaller"
                                      ? "text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/45 px-1.5 py-0.5 rounded text-[10px] border border-emerald-100 dark:border-emerald-900/30"
                                      : savingsCase === "larger"
                                        ? "text-amber-600 dark:text-amber-400 font-bold bg-amber-50 dark:bg-amber-950/45 px-1.5 py-0.5 rounded text-[10px] border border-amber-100 dark:border-amber-900/40"
                                        : "text-slate-500 dark:text-slate-400 font-bold bg-slate-100 dark:bg-slate-800/60 px-1.5 py-0.5 rounded text-[10px] border border-slate-200 dark:border-slate-700/50";
                                  const label =
                                    savingsCase === "smaller"
                                      ? `(${rounded}% smaller)`
                                      : savingsCase === "larger"
                                        ? `(${rounded}% larger)`
                                        : "(0% size change)";
                                  return (
                                    <span className={badgeClass}>{label}</span>
                                  );
                                })()}
                              </div>

                              {selectedQuality === 128 && (
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                                  128 kbps is the recommended balance of quality
                                  and file size.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
                {!isAudioFile({ name: item.name, type: item.type }) && (
                  <>
                    {item.type.startsWith("image/") && (
                      <img
                        src={previewUrl}
                        alt="Preview"
                        className="max-h-96 object-contain rounded border border-slate-200 dark:border-slate-800 shadow-sm"
                      />
                    )}
                    {item.type.startsWith("video/") && (
                      <video
                        controls
                        src={previewUrl}
                        className="max-h-96 w-full rounded border border-slate-200 dark:border-slate-800 shadow-sm"
                      />
                    )}
                    {item.type === "application/pdf" && (
                      <iframe
                        src={previewUrl}
                        className="w-full h-96 rounded border border-slate-300 dark:border-slate-800 shadow-sm"
                        title="PDF Preview"
                      />
                    )}
                    {isTextFile && textContent !== null && (
                      <pre className="w-full max-h-96 overflow-auto bg-white dark:bg-slate-900 p-4 rounded border border-slate-200 dark:border-slate-800 shadow-sm text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                        {textContent}
                      </pre>
                    )}
                  </>
                )}
                {!item.type.startsWith("image/") &&
                  !isAudioFile({ name: item.name, type: item.type }) &&
                  !item.type.startsWith("video/") &&
                  item.type !== "application/pdf" &&
                  !isTextFile && (
                    <div className="text-slate-500 dark:text-slate-300 text-sm py-8">
                      Preview not available for this file type.
                    </div>
                  )}
              </div>
            </div>
          )}

          {item.status === "pending" && (
            <div className="text-slate-500 dark:text-slate-350 text-xs sm:text-sm font-medium italic">
              Waiting to be processed...
            </div>
          )}
          {item.status === "queued" && (
            <div className="text-amber-600 dark:text-amber-400 text-xs sm:text-sm font-medium italic">
              In queue (waiting for active requests to finish)...
            </div>
          )}
          {item.status === "processing" && (
            <div className="text-slate-500 dark:text-slate-300 text-xs sm:text-sm flex flex-col gap-1 sm:gap-1.5">
              <div className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin text-indigo-500" />
                <span className="animate-pulse">Extracting text...</span>
              </div>
              {item.retryMessage && (
                <span className="text-[11px] sm:text-xs text-amber-600 dark:text-amber-400 font-medium ml-5 sm:ml-6 animate-pulse">
                  {item.retryMessage}
                </span>
              )}
            </div>
          )}

          {item.status === "error" && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-red-50/50 dark:bg-red-950/10 border border-red-100 dark:border-red-900/30 p-3 rounded-lg text-red-500 dark:text-red-400 text-sm">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{item.error}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                <div ref={dropdownRef} className="relative inline-block">
                  <button
                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                    className="inline-flex items-center gap-1 sm:gap-1.5 px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-red-100/50 dark:bg-red-950/20 text-red-700 dark:text-red-400 text-[11px] sm:text-xs font-bold border border-red-200/50 dark:border-red-900/40 shadow-xs transition-colors hover:bg-red-200/50 dark:hover:bg-red-900/40 cursor-pointer h-full"
                    data-tooltip="Click to switch model"
                  >
                    <span>Model:</span>{" "}
                    <span className="font-extrabold uppercase tracking-wider">
                      {item.preferredModel || item.modelUsed || "Unknown"}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform duration-250 ${showModelDropdown ? "rotate-180" : ""}`}
                    />
                  </button>

                  <AnimatePresence>
                    {showModelDropdown && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 8 }}
                        transition={{ duration: 0.15 }}
                        className="absolute right-0 sm:left-auto mt-1.5 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg py-1 z-50 text-left outline-none font-sans"
                      >
                        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500">
                          Switch Gemini Model
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {AVAILABLE_MODELS.map((model) => {
                            const currentModelStr =
                              item.preferredModel || item.modelUsed || "";
                            const isCurrent =
                              currentModelStr.toLowerCase() ===
                                model.id.toLowerCase() ||
                              (currentModelStr.toLowerCase().includes("lite") &&
                                model.id.includes("lite")) ||
                              (currentModelStr.toLowerCase().includes("pro") &&
                                model.id.includes("pro") &&
                                model.id.includes("3.1-pro-preview"));
                            return (
                              <button
                                key={model.id}
                                onClick={() => {
                                  setShowModelDropdown(false);
                                  if (onSelectModel) {
                                    onSelectModel(item.id, model.id);
                                  }
                                }}
                                className={`w-full px-3.5 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer text-left ${
                                  isCurrent
                                    ? "bg-red-50/70 dark:bg-red-950/20 text-red-700 dark:text-red-400 font-bold"
                                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                                }`}
                              >
                                <span>{model.name}</span>
                                {isCurrent && (
                                  <Check className="w-3.5 h-3.5 text-red-600 dark:text-red-400 flex-shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {onProcess && (
                  <button
                    onClick={() => onProcess(item.id)}
                    className="flex-shrink-0 bg-red-100 hover:bg-red-200 dark:bg-red-950/40 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 border border-red-200 dark:border-red-900/50 h-full"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                  </button>
                )}
              </div>
            </div>
          )}
          <AnimatePresence>
            {item.status === "success" && item.result && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="space-y-4"
              >
                {/* Word Count Badge & Direct Manual Edit Toggle */}
                <div className="flex flex-col gap-3 p-3 sm:p-4 bg-slate-50/60 dark:bg-slate-950/40 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <span className="text-[10px] sm:text-xs font-bold text-slate-500 dark:text-slate-300 uppercase tracking-wider">
                        Document Stats
                      </span>
                      <div className="inline-flex items-center gap-1 sm:gap-1.5 px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/20 text-indigo-700 dark:text-indigo-400 text-[11px] sm:text-xs font-bold border border-indigo-200/50 dark:border-indigo-900/40 shadow-xs select-none">
                        Word Count:{" "}
                        <span className="font-extrabold ml-0.5">
                          {getWordCount(item.result)}
                        </span>
                      </div>
                      {item.modelUsed && (
                        <div
                          ref={dropdownRef}
                          className="relative inline-block"
                        >
                          <button
                            onClick={() =>
                              setShowModelDropdown(!showModelDropdown)
                            }
                            className="inline-flex items-center gap-1 sm:gap-1.5 px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-teal-50 dark:bg-teal-950/20 text-teal-700 dark:text-teal-400 text-[11px] sm:text-xs font-bold border border-teal-200/50 dark:border-teal-900/40 shadow-xs transition-colors hover:bg-teal-100/50 dark:hover:bg-teal-900/30 cursor-pointer"
                            data-tooltip="Click to switch model and re-process"
                          >
                            <span>Model:</span>{" "}
                            <span className="font-extrabold uppercase tracking-wider">
                              {item.modelUsed}
                            </span>
                            <ChevronDown
                              className={`w-3.5 h-3.5 transition-transform duration-250 ${showModelDropdown ? "rotate-180" : ""}`}
                            />
                          </button>

                          <AnimatePresence>
                            {showModelDropdown && (
                              <motion.div
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 8 }}
                                transition={{ duration: 0.15 }}
                                className="absolute left-0 mt-1.5 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg py-1 z-50 text-left outline-none font-sans"
                              >
                                <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500">
                                  Switch Gemini Model
                                </div>
                                <div className="max-h-60 overflow-y-auto">
                                  {AVAILABLE_MODELS.map((model) => {
                                    const usedLower = item.modelUsed?.toLowerCase().trim() || "";
                                    const isCurrent =
                                      usedLower === model.id.toLowerCase() ||
                                      usedLower === model.name.toLowerCase() ||
                                      (usedLower.includes("3.5-flash-lite") && model.id === "gemini-3.5-flash-lite") ||
                                      (usedLower.includes("3.1-flash-lite") && model.id === "gemini-3.1-flash-lite") ||
                                      (usedLower.includes("3.6-flash") && model.id === "gemini-3.6-flash") ||
                                      (usedLower.includes("3.5-flash") && !usedLower.includes("lite") && model.id === "gemini-3.5-flash") ||
                                      (usedLower.includes("3.1-pro") && model.id === "gemini-3.1-pro");
                                    return (
                                      <button
                                        key={model.id}
                                        onClick={() => {
                                          setShowModelDropdown(false);
                                          if (onSelectModel) {
                                            onSelectModel(item.id, model.id);
                                          }
                                        }}
                                        className={`w-full px-3.5 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer text-left ${
                                          isCurrent
                                            ? "bg-teal-50/70 dark:bg-teal-950/20 text-teal-700 dark:text-teal-400 font-bold"
                                            : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                                        }`}
                                      >
                                        <span>{model.name}</span>
                                        {isCurrent && (
                                          <Check className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 flex-shrink-0" />
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => setIsEditing(!isEditing)}
                      className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all duration-250 cursor-pointer w-full sm:w-auto ${
                        isEditing
                          ? "bg-amber-50 hover:bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:hover:bg-amber-900/40 dark:text-amber-300 border border-amber-200/50 dark:border-amber-900/55"
                          : "bg-white hover:bg-slate-50 text-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800"
                      }`}
                    >
                      <FilePenLine className="w-3.5 h-3.5" />
                      <span>{isEditing ? "Cancel Edit" : "Edit Text"}</span>
                    </button>
                  </div>

                  {isEditing && (
                    <div className="mt-1 space-y-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">
                          Manual Corrections Editor
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={handleUndoEdit}
                            disabled={historyIndex <= 0}
                            className="p-1.5 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            data-tooltip="Undo"
                          >
                            <Undo className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={handleRedoEdit}
                            disabled={historyIndex >= editHistory.length - 1}
                            className="p-1.5 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            data-tooltip="Redo"
                          >
                            <Redo className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={editText}
                        onChange={handleEditTextChange}
                        placeholder="Correct any transcription or processing mistakes here..."
                        className="w-full h-48 p-3 text-sm font-sans bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-inner text-slate-800 dark:text-slate-100 leading-relaxed"
                      />
                      <div className="flex items-center justify-end gap-2 self-end">
                        <button
                          onClick={() => {
                            const originalText = item.result || "";
                            setEditText(originalText);
                            setEditHistory([originalText]);
                            setHistoryIndex(0);
                            setIsEditing(false);
                          }}
                          className="px-3 py-1.5 text-xs font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                        >
                          Discard
                        </button>
                        <button
                          onClick={() => {
                            if (onEditResult) {
                              onEditResult(item.id, editText);
                            }
                            setIsEditing(false);
                          }}
                          className="flex items-center gap-1 px-3.5 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 rounded-lg shadow-sm transition-colors cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Save Edits
                        </button>
                      </div>
                    </div>
                  )}
                </div>{" "}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  <h4 className="text-xs font-bold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-3">
                    Extracted Content
                  </h4>
                </div>
                {/* Simple high-performance scroll container keeping the DOM tree shallow */}
                <div className="max-h-[450px] overflow-y-auto border border-slate-200/60 dark:border-slate-800 rounded-xl bg-slate-50/20 dark:bg-slate-950/20 p-4 font-sans text-sm scroll-behavior-smooth text-slate-700 dark:text-slate-300">
                  <div
                    ref={resultContentRef}
                    className="prose prose-sm max-w-none text-slate-700 dark:text-slate-300"
                  >
                    {showRaw ? (
                      <pre className="whitespace-pre-wrap bg-transparent m-0 p-0 border-0 text-sm font-mono text-slate-800 dark:text-slate-200 overflow-x-auto">
                        {getCasedText(item.result)}
                      </pre>
                    ) : (
                      <div className="markdown-body">
                        <React.Suspense fallback={
                          <div className="flex items-center gap-2 text-slate-500 py-4 font-mono text-xs">
                            <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
                            <span>Loading formatted transcription...</span>
                          </div>
                        }>
                          <ResultMarkdownRenderer text={getCasedText(item.result)} />
                        </React.Suspense>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Memoized ResultCard. Re-renders only when its props change by shallow equality.
 * Callers MUST pass stable callbacks (useCallback) for the memoization to take effect.
 */
export const ResultCard = React.memo(ResultCardImpl);
