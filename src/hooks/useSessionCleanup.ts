import { useEffect, useRef } from "react";
import { FileItem } from "../types";
import { markSessionCleanExit } from "../services/dbService";

// Global registry of all active Created Object URLs to revoke them during unmount/beforeunload.
const activeObjectURLs = new Set<string>();

// Safely intercept native URL.createObjectURL and URL.revokeObjectURL.
// Guarded against double-patching: HMR, StrictMode double-invocation of some
// setups, or any re-import of this module must NOT wrap an already-wrapped
// function (which would corrupt the activeObjectURLs set and double-revoke).
if (typeof window !== "undefined" && !(URL.createObjectURL as any).__sessionCleanupPatched) {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  const patchedCreate = function (obj: any): string {
    const url = originalCreateObjectURL.call(URL, obj);
    activeObjectURLs.add(url);
    return url;
  };
  (patchedCreate as any).__sessionCleanupPatched = true;

  const patchedRevoke = function (url: string): void {
    activeObjectURLs.delete(url);
    originalRevokeObjectURL.call(URL, url);
  };
  (patchedRevoke as any).__sessionCleanupPatched = true;

  URL.createObjectURL = patchedCreate;
  URL.revokeObjectURL = patchedRevoke;
}

export function useSessionCleanup(files: FileItem[]) {
  const filesRef = useRef<FileItem[]>(files);
  // Keep the ref in lock-step with the latest `files` state. Assigning during
  // render covers the common path; this effect guarantees the ref is also
  // committed synchronously right after every state change (e.g. the moment
  // the last file is deleted via an individual trash button), so the
  // `beforeunload` handler below never reads a stale non-empty queue.
  filesRef.current = files;
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Diagnostic Endpoint Check for Optimal Server Status.
  // Gated by sessionStorage so it runs at most ONCE per browser tab (not on
  // every mount / StrictMode double-invoke / route remount). Resets when the
  // tab closes, which is the intended cadence for a "is the server up" probe.
  useEffect(() => {
    const SESSION_FLAG = "cv_diag_server_checked";
    if (typeof window === "undefined" || sessionStorage.getItem(SESSION_FLAG)) return;
    sessionStorage.setItem(SESSION_FLAG, "1");

    const checkServerStatus = async () => {
      const apiKey = localStorage.getItem("cleanvoice_api_key");
      if (!apiKey) return;
      try {
        const { getBaseUrl } = await import("../services/cleanvoiceService");
        const start = performance.now();
        const baseUrl = getBaseUrl();
        const url = `${baseUrl}/v2/configurations`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            // Cleanvoice v2 authenticates exclusively via X-API-Key.
            // Sending a redundant Authorization: Bearer header is incorrect.
            "X-API-Key": apiKey,
          },
        });
        const elapsed = performance.now() - start;
        if (elapsed > 4000 || !res.ok) {
          console.warn(`[Diagnostic] Cleanvoice server lag detected (${Math.round(elapsed)}ms) or sub-optimal status (${res.status}). Long uploads may be affected.`);
        } else {
          console.log(`[Diagnostic] Cleanvoice server status optimal (${Math.round(elapsed)}ms latency).`);
        }
      } catch (err) {
        console.warn("[Diagnostic] Failed to reach Cleanvoice server:", err);
      }
    };
    checkServerStatus();
  }, []);

  // Automatically trigger API deletion of all existing and previous session Cleanvoice files immediately on application reload
  useEffect(() => {
    const apiKey = localStorage.getItem("cleanvoice_api_key");
    if (apiKey) {
      console.log("[useSessionCleanup] Application reload detected. Running automatic API cleanup of Cleanvoice edits...");
      import("../services/cleanvoiceService").then(({ cleanupOldCleanvoiceEdits }) => {
        cleanupOldCleanvoiceEdits(apiKey, false).catch((err) => {
          console.warn("[useSessionCleanup] Failed to clean up old Cleanvoice edits on app reload:", err);
        });
      });
    }
  }, []);

  useEffect(() => {
    const handleCleanup = (event?: BeforeUnloadEvent) => {
      const apiKey = localStorage.getItem("cleanvoice_api_key");

      // Only trigger the browser's "Leave site?" confirmation when the user
      // actually has files loaded in the queue — i.e. when there's something
      // to lose. With an empty queue, closing/refreshing the tab should be
      // silent. The cleanup below (cloud edit deletion + Object URL revocation)
      // still runs unconditionally so no resources leak in either case.
      const hasFiles = filesRef.current.length > 0;
      if (event && hasFiles) {
        event.preventDefault();
        event.returnValue = "";
      }

      // 1. Clean up Cleanvoice Cloud Jobs (active files in current session).
      // During beforeunload the page may tear down at any moment, so we must
      // NOT rely on an async dynamic import() — it may never resolve. Instead
      // resolve the base URL synchronously and fire keepalive DELETE fetches
      // directly, which the browser will complete even after the page is gone.
      if (apiKey) {
        const hostname = typeof window !== "undefined" ? window.location.hostname : "";
        const isStaticOnly =
          hostname.includes("github.io") ||
          hostname.includes("netlify");
        const baseUrl = isStaticOnly ? "https://api.cleanvoice.ai" : "/api/cleanvoice";

        // Delete each active session edit + old dangling jobs from localStorage
        // history. All fire as keepalive fetches so they survive page teardown.
        filesRef.current.forEach((f) => {
          if (f.cleanvoiceResult?.editId) {
            try {
              fetch(`${baseUrl}/v2/edits/${f.cleanvoiceResult.editId}`, {
                method: "DELETE",
                headers: { "X-API-Key": apiKey },
                keepalive: true,
              }).catch(() => {});
            } catch (_) {}
          }
        });

        // Also clean up dangling jobs from previous crashed sessions.
        try {
          const historyJson = localStorage.getItem("cleanvoice_job_history");
          if (historyJson) {
            const history = JSON.parse(historyJson) as string[];
            history.forEach((editId) => {
              try {
                fetch(`${baseUrl}/v2/edits/${editId}`, {
                  method: "DELETE",
                  headers: { "X-API-Key": apiKey },
                  keepalive: true,
                }).catch(() => {});
              } catch (_) {}
            });
            localStorage.removeItem("cleanvoice_job_history");
          }
        } catch (_) {}
      }

      // 2. Clean up server-side local cache file chunks - Disabled for client-only build

      // 3. Properly dispose of all local Object URLs (blobs) across components (e.g. results, recordings, waveforms, zip content)
      activeObjectURLs.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      });
      activeObjectURLs.clear();
    };

    window.addEventListener("beforeunload", handleCleanup);

    // pagehide is the authoritative "this page is being discarded for good"
    // lifecycle event. Unlike beforeunload (which is cancellable — the user may
    // click "Stay"), pagehide with persisted === false ONLY fires once the page
    // is truly going away, AFTER any beforeunload confirmation.
    //
    // We use it to record the clean-exit flag. Crucially, pagehide does NOT fire
    // during a hard browser crash, an OS restart, or a forced tab termination —
    // so after such an event the flag is absent and the next session RESTORES
    // the queue instead of clearing it. localStorage.setItem is synchronous, so
    // the write completes reliably during teardown (an IDB transaction here
    // would not be guaranteed to commit before destruction).
    const handlePageHide = (event: PageTransitionEvent) => {
      // persisted === true means the page is going to the back/forward cache
      // (bfcache), not actually being destroyed — in that case do nothing.
      if (event.persisted) return;
      markSessionCleanExit();
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("beforeunload", handleCleanup);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);
}
