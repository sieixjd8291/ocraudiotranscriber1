// Global thread-safe promise cache to prevent redundant decoding stutters
export const audioBufferCache = new Map<string, Promise<AudioBuffer> | AudioBuffer>();
export const audioBitrateCache = new Map<string, number>();

export const checkAndCleanCache = () => {
  if (audioBufferCache.size > 20) {
    const firstKey = audioBufferCache.keys().next().value;
    if (firstKey) {
      audioBufferCache.delete(firstKey);
      audioBitrateCache.delete(firstKey);
    }
  }
};

export const clearAudioBufferCache = () => {
  audioBufferCache.clear();
  audioBitrateCache.clear();
  console.log("[WaveformAudioEditor] Cleared global audioBufferCache Map");
};

/**
 * Partial eviction: drops the oldest entries, keeping the `keepFraction` most
 * recently inserted (Map iteration order = insertion order, so the tail is the
 * most recent). Used by auto-GC so the most-recently-used decoded buffers
 * survive a GC pass — preserving decode-hit-rate and avoiding the
 * re-decode -> heap-climb -> re-GC thrash loop. `keepFraction = 0` behaves
 * like a full clear.
 */
export const evictAudioBufferCache = (keepFraction = 0.5): number => {
  const size = audioBufferCache.size;
  if (size === 0) return 0;
  const keepCount = Math.max(0, Math.floor(size * keepFraction));
  const dropCount = size - keepCount;
  if (dropCount <= 0) return 0;
  let dropped = 0;
  for (const key of audioBufferCache.keys()) {
    if (dropped >= dropCount) break;
    audioBufferCache.delete(key);
    audioBitrateCache.delete(key);
    dropped++;
  }
  console.log(`[WaveformAudioEditor] Evicted ${dropped} oldest entries from audioBufferCache (${size} -> ${audioBufferCache.size})`);
  return dropped;
};

if (typeof window !== "undefined") {
  (window as any).clearAudioBufferCache = clearAudioBufferCache;
}
