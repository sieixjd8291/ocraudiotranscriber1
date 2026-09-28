import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { FileItem } from '../types';

function useServerSynchronizedElapsedTimer(startedAt?: number, serverCreatedAt?: string, serverElapsedSeconds?: number, serverElapsedAt?: number) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const isBatterySaver = typeof window !== "undefined" && (window as any).isBatterySaverActive;

    const calc = () => {
      if (isBatterySaver && document.visibilityState === "hidden") return;
      const now = Date.now();
      // Prefer the official server-reported elapsed time, ticking forward from
      // the moment we last received it so the timer stays smooth between polls.
      if (serverElapsedSeconds !== undefined && serverElapsedAt) {
        const diffStr = serverElapsedSeconds + Math.floor((now - serverElapsedAt) / 1000);
        setElapsed(diffStr >= 0 ? diffStr : 0);
        return;
      }
      let start = startedAt;
      if (!start && serverCreatedAt) {
        const parsed = new Date(serverCreatedAt).getTime();
        if (!isNaN(parsed)) start = parsed;
      }
      if (start) {
        const diffStr = Math.floor((now - start) / 1000);
        setElapsed(diffStr >= 0 ? diffStr : 0);
      } else {
        setElapsed(0);
      }
    };
    calc();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        calc();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    const timer = setInterval(calc, isBatterySaver ? 3000 : 1000);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(timer);
    };
  }, [startedAt, serverCreatedAt, serverElapsedSeconds, serverElapsedAt]);

  return elapsed;
}

export const CleanvoiceProgressView: React.FC<{ file: FileItem }> = ({ file }) => {
  const res = file.cleanvoiceResult;

  const isActiveStatus = !!res && (res.status === 'uploading' || res.status === 'processing' || res.status === 'pending');

  // Hooks MUST run unconditionally and in the same order on every render.
  // Pass safe no-op values when there is no active result so the hooks are
  // cheap and the early-return-to-null happens AFTER all hooks have been called.
  const elapsed = useServerSynchronizedElapsedTimer(
    res?.startedAt,
    res?.createdAt,
    res?.serverElapsedSeconds,
    res?.serverElapsedAt,
  );

  const rawStatusLower = res?.rawStatus?.toLowerCase() || "";
  const isQueued = !!res?.isQueued || rawStatusLower === 'queued' || rawStatusLower === 'waiting' || rawStatusLower === 'pending' || (res?.progress !== undefined && res.progress <= 5);

  // The progress is strictly based on the real-time stage progress calculated and broadcasted by the server.
  const rawProgress = res?.progress !== undefined ? res.progress : (isQueued ? 5 : 12);
  const progress = res?.status === 'success'
    ? 100
    : Math.max(isQueued ? 0 : 12, Math.min(99, Math.round(rawProgress)));

  // Smooth client-side upload progress interpolator state
  const isUploading = !!res && res.status === 'uploading';
  const rawUploadProgress = res?.uploadProgress !== undefined ? res.uploadProgress : 0;
  const [displayUploadProgress, setDisplayUploadProgress] = React.useState(0);

  // Handle smooth staged upload progress
  React.useEffect(() => {
    if (!isUploading) {
      setDisplayUploadProgress(0);
    }
  }, [isUploading, file.id]);

  React.useEffect(() => {
    if (!isUploading) return;

    const interval = setInterval(() => {
      setDisplayUploadProgress((prev) => {
        // Determine the current stage ceiling target
        let targetLimit = 30;
        if (rawUploadProgress <= 30) {
          targetLimit = 30;
        } else if (rawUploadProgress <= 60) {
          targetLimit = 60;
        } else {
          targetLimit = 100;
        }

        // If display progress is behind the uploader reported raw progress, catch up smoothly and rapidly
        if (prev < rawUploadProgress) {
          return Math.min(rawUploadProgress, prev + 1.5);
        }

        // Creep forward slowly toward the target ceiling
        if (prev < targetLimit) {
          const remaining = targetLimit - prev;
          const step = Math.max(0.1, remaining * 0.05);
          return Math.min(targetLimit, prev + step);
        }

        return prev;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isUploading, rawUploadProgress]);

  const activeProgress = isUploading
    ? Math.max(2, Math.min(100, Math.round(displayUploadProgress)))
    : progress;

  // Early-exit AFTER all hooks have run, so the rules of hooks hold across
  // every render regardless of whether a result is currently present.
  if (!res || !isActiveStatus) return null;

  const editId = res.editId;

  let phaseTitle = (res as any).stageTitle || "Preprocessing audio file...";
  if (isUploading || res.status === 'uploading') {
    if (activeProgress <= 30) {
      phaseTitle = "Registering file metadata (Step 1/3)...";
    } else if (activeProgress <= 60) {
      phaseTitle = "Uploading audio binary (Step 2/3)...";
    } else {
      phaseTitle = "Requesting job edit compilation (Step 3/3)...";
    }
  } else if (isQueued) {
    phaseTitle = "Waiting in queue. We will start soon...";
  } else if ((res as any).stageTitle) {
    phaseTitle = (res as any).stageTitle;
  } else if (activeProgress >= 84) {
    phaseTitle = "Finishing touches...";
  } else if (activeProgress >= 50) {
    phaseTitle = "Editing your audio file...";
  } else if (activeProgress >= 30) {
    phaseTitle = "Searching fillers, background noise...";
  } else {
    phaseTitle = "Preprocessing audio file...";
  }

  const formatElapsed = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm mt-4 animate-in fade-in zoom-in-95 duration-300 relative">



      {/* Main Progress Section */}
      <div className="p-8 bg-slate-50 dark:bg-slate-900/50">

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-4">
           <div>
             <h2 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 tracking-tight leading-tight">
               {phaseTitle}
             </h2>
             <div className="flex items-center gap-4 mt-2">
               <span className="text-sm font-bold text-slate-600 dark:text-slate-300">
                 {activeProgress}% complete
               </span>
               <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest bg-slate-200/50 dark:bg-slate-800/50 px-2 py-1 rounded">
                  Elapsed: {formatElapsed(elapsed)}
               </span>
             </div>
           </div>

           <a
             href={editId ? `https://app.cleanvoice.ai/progress?task_id=${editId}` : undefined}
             target="_blank"
             rel="noopener noreferrer"
             data-tooltip={editId ? "View job in Cleanvoice History" : "Waiting for Job ID to be created..."}
             onClick={(e) => {
               if (!editId) {
                 e.preventDefault();
               }
             }}
             className={`inline-flex items-center justify-center w-10 h-10 rounded-xl transition-all shadow-sm shrink-0 self-start sm:self-auto ${
               editId
                 ? "text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100/80 dark:border-indigo-900/40 hover:bg-indigo-100/85 dark:hover:bg-indigo-950/70 cursor-pointer"
                 : "text-slate-400 dark:text-slate-500 bg-slate-100/50 dark:bg-slate-800/30 border border-slate-200/50 dark:border-slate-800/50 opacity-40 cursor-not-allowed"
             }`}
           >
             <History className="w-5 h-5" />
           </a>
        </div>

        <div className="w-full h-3 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner mb-6 relative">
           {isUploading && activeProgress < 10 ? (
             <div className="absolute inset-0 bg-indigo-500/10 dark:bg-indigo-500/20 w-full h-full animate-pulse z-0" />
           ) : null}
           <div
             className="h-full transition-all duration-705 ease-out relative z-10 bg-emerald-500"
             style={{ width: `${activeProgress}%` }}
           >
             <div className="absolute inset-0 w-full h-full bg-white/20 animate-[shimmer_2s_infinite]" />
           </div>
        </div>

        <div className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed max-w-xl">
           <p className="font-medium text-slate-700 dark:text-slate-300">This Process takes a while. It will take about 10-15 minutes for every hour of audio.</p>

        </div>

      </div>
    </div>
  );
};
