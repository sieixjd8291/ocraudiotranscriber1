import { FileItem } from "../types";

const DB_NAME = "CleanvoiceStudioDB";
const STORE_NAME = "files";
const DB_VERSION = 1;

function serializeFileItem(item: FileItem): any {
  if (!item) return item;

  // Rule 3: Ensure that audio binary data is never saved to IndexedDB caches automatically
  // Note: We strip the file parameter completely to prevent 400MB memory caching of audio BLOBS
  // preserving only the metadata, results, and transcription texts
  
  const serializedItem = {
    ...item,
    file: null, // Audio binary data NOT saved to cache.
    serializedOriginalFiles: undefined,
  };

  if (item.cleanvoiceResult) {
    serializedItem.cleanvoiceResult = {
      ...item.cleanvoiceResult,
      cleanedBlob: undefined, // Audio binary data NOT saved to cache.
    };
  }

  return serializedItem;
}

function deserializeFileItem(item: any): FileItem {
  if (!item) return item;

  // 1. Reconstruct main File from Blob.
  // serializeFileItem intentionally nulls out `file` (audio binary data is never
  // persisted), so restored items have file === null. The FileItem type treats
  // file as optional at runtime for restored state; guard every downstream
  // access rather than assuming a File is present.
  let file: File | Blob | null = item.file ?? null;
  if (item.file && !(item.file instanceof File)) {
    try {
      file = new File([item.file], item.name, { type: item.type });
    } catch {
      file = null;
    }
  }

  // 2. Reconstruct originalFiles if present
  if (item.serializedOriginalFiles && Array.isArray(item.serializedOriginalFiles)) {
    const originalFiles = item.serializedOriginalFiles
      .map((sof: any) => {
        try {
          return new File([sof.blob], sof.name, { type: sof.type });
        } catch {
          return null;
        }
      })
      .filter((f: any) => f !== null);
    if (file && originalFiles.length > 0) {
      (file as any).originalFiles = originalFiles;
    }
  }

  const deserializedItem: FileItem = {
    ...item,
    // `file` is null for restored items (audio binary is never persisted).
    // The FileItem type marks `file` as required, so cast to satisfy the type
    // while preserving the restored (null) value at runtime.
    file: file as File | Blob,
  };

  // 3. Reconstruct cleanvoiceResult and its cleanedBlob
  if (item.cleanvoiceResult) {
    deserializedItem.cleanvoiceResult = {
      ...item.cleanvoiceResult,
    };
    if (item.cleanvoiceResult.cleanedBlob) {
      deserializedItem.cleanvoiceResult.cleanedBlob = item.cleanvoiceResult.cleanedBlob;
    }
  }

  return deserializedItem;
}

// Singleton connection: opening a new IDBDatabase on every call leaks handles
// and can trigger onblocked/onversionchange churn. Cache one shared instance.
let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

export function initDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      dbPromise = null;
      reject(new Error("IndexedDB is not supported in this environment."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      // If the DB is upgraded elsewhere, drop our cached handle so the next
      // call reopens against the fresh version instead of going onblocked.
      dbInstance.onversionchange = () => {
        try { dbInstance?.close(); } catch {}
        dbInstance = null;
        dbPromise = null;
      };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      dbPromise = null;
      reject((event.target as IDBOpenDBRequest).error || new Error("Failed to open database"));
    };
  });

  return dbPromise;
}

export async function getAllPersistedFiles(): Promise<FileItem[]> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result as any[];
        const mapped = results.map(deserializeFileItem);
        resolve(mapped);
      };

      request.onerror = () => {
        reject(request.error || new Error("Failed to get all files"));
      };
    });
  } catch (error) {
    console.error("IndexedDB getAllPersistedFiles error:", error);
    return [];
  }
}

export async function saveAllPersistedFiles(files: FileItem[]): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    // Clear first, then queue all puts within the same transaction so the whole
    // operation is atomic: either everything commits or nothing does.
    store.clear();
    for (const fileItem of files) {
      store.put(serializeFileItem(fileItem));
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error || new Error("Failed to bulk-save file items"));
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error("Transaction aborted during bulk save"));
    };
  });
}

export async function clearAllPersistedFiles(): Promise<void> {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error || new Error("Failed to clear persisted files"));
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error("Transaction aborted while clearing persisted files"));
    };
  });
}

// ---------------------------------------------------------------------------
// SESSION CLEAN-EXIT FLAG (crash vs. intentional-leave discrimination)
// ---------------------------------------------------------------------------
// A localStorage flag that records whether the previous session ended with a
// NORMAL, user-confirmed page unload.
//
// Why this exists: IndexedDB survives crashes by design, so "are files still in
// storage?" cannot tell a crash apart from a clean leave. Instead we ask the
// inverse question at startup: "did the unload lifecycle actually run last
// time?"
//   - pagehide (persisted === false) fires ONLY when the page is being
//     discarded for good (close / reload / navigate-away), and it fires AFTER
//     any beforeunload confirmation. We set the flag there.
//   - A hard browser crash, OS restart, or forced tab termination NEVER reaches
//     pagehide, so the flag stays absent.
//
// At startup we read + clear the flag:
//   - present  → last session was a confirmed leave → CLEAR storage.
//   - absent   → first-ever load OR a crash            → RESTORE the queue.
//
// localStorage is used (not IndexedDB) because the write must be synchronous
// and reliable during teardown — an IDB transaction started in pagehide is not
// guaranteed to commit before the page is destroyed.
export const SESSION_CLEAN_EXIT_FLAG = "cv_session_clean_exit_pending";

/** Record (synchronously, during pagehide) that the session ended cleanly. */
export function markSessionCleanExit(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_CLEAN_EXIT_FLAG, "1");
  } catch (_) {
    // localStorage can be unavailable (private mode / quota). Failing safe here
    // means a confirmed-leave may look like a crash and the queue is restored
    // next session — the data-safe direction, which is the intended default.
  }
}

/**
 * Read + clear the clean-exit flag at startup. Returns true ONLY if the previous
 * session recorded a normal, user-confirmed unload. Returns false for a first-ever
 * load or after a crash (no unload fired).
 */
export function consumeSessionCleanExit(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const flagged = localStorage.getItem(SESSION_CLEAN_EXIT_FLAG) === "1";
    if (flagged) {
      localStorage.removeItem(SESSION_CLEAN_EXIT_FLAG);
    }
    return flagged;
  } catch (_) {
    return false;
  }
}
