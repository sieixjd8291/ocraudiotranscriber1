export const cleanvoiceBlobCache: Record<string, Blob> = {};
export const cleanvoiceActivePrefetches: Record<string, Promise<Blob>> = {};
export const cleanvoiceFailedPrefetches = new Set<string>();

const CLEANVOICE_BLOB_CACHE_MAX = 24;

export const enforceCleanvoiceBlobCacheCap = (): void => {
  const keys = Object.keys(cleanvoiceBlobCache);
  const overflow = keys.length - CLEANVOICE_BLOB_CACHE_MAX;
  if (overflow <= 0) return;
  for (let i = 0; i < overflow; i++) {
    delete cleanvoiceBlobCache[keys[i]];
  }
  console.log(`[Cleanvoice] Blob cache capped at ${CLEANVOICE_BLOB_CACHE_MAX}; evicted ${overflow} oldest entries (${keys.length} -> ${Object.keys(cleanvoiceBlobCache).length}).`);
};

export const setCleanvoiceBlobCache = (key: string, blob: Blob): void => {
  cleanvoiceBlobCache[key] = blob;
  enforceCleanvoiceBlobCacheCap();
};
