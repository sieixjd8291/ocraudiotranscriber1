// We implement an MP3 encoding worker.
// It receives chunks of Float32Array data and encodes them block by block.
// To avoid loading the entire `lamejs` context here, we can actually just
// evaluate lamejs inside this worker since `audioUtils` has it.

// Wait, audioUtils uses `new Function('window', lameJSCode)` which we patched.
import lameJSCode from 'lamejs/lame.all.js?raw';

let lamejs: any;
try {
  const fn = new Function('window', lameJSCode + '\nreturn lamejs;');
  const globalObj = typeof self !== 'undefined' ? self : {};
  lamejs = fn(globalObj);
} catch (e) {
  console.error("Failed to initialize lamejs safely in worker:", e);
}

let mp3encoder: any = null;
let channels: number = 2;
let sampleRate: number = 44100;
let kbps: number = 320;

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    channels = payload.channels || 2;
    sampleRate = payload.sampleRate || 44100;
    kbps = payload.kbps || 320;
    mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
    self.postMessage({ type: 'INIT_DONE' });
  } 
  
  else if (type === 'ENCODE_CHUNK') {
    const { leftChunk, rightChunk } = payload;
    const mp3Data = [];
    
    // leftChunk and rightChunk are Float32Array
    const totalSamples = leftChunk.length;
    
    // Single buffer allocations for the whole chunk
    const leftInt16 = new Int16Array(totalSamples);
    const rightInt16 = rightChunk ? new Int16Array(totalSamples) : null;
    
    // Single highly JIT-optimized loop for conversion - branching moved outside
    if (rightChunk && rightInt16) {
      for (let i = 0; i < totalSamples; i++) {
        let l = leftChunk[i] * 32768.0;
        leftInt16[i] = l < -32768 ? -32768 : l > 32767 ? 32767 : (l ^ 0);
        let r = rightChunk[i] * 32768.0;
        rightInt16[i] = r < -32768 ? -32768 : r > 32767 ? 32767 : (r ^ 0);
      }
    } else {
      for (let i = 0; i < totalSamples; i++) {
        let l = leftChunk[i] * 32768.0;
        leftInt16[i] = l < -32768 ? -32768 : l > 32767 ? 32767 : (l ^ 0);
      }
    }
    
    // Encode the buffer in blocks of 1152 samples as lamejs prefers
    let blocksProcessed = 0;
    // Report progress every 5% approximately
    const totalBlocks = Math.ceil(totalSamples / 1152);
    const reportEvery = Math.max(1, Math.floor(totalBlocks / 20));
    let streamingMp3Data = [];

    for (let i = 0; i < totalSamples; i += 1152) {
      const remaining = Math.min(1152, totalSamples - i);
      const leftSub = leftInt16.subarray(i, i + remaining);
      const rightSub = rightInt16 ? rightInt16.subarray(i, i + remaining) : null;
      
      const mp3buf = rightSub ? mp3encoder.encodeBuffer(leftSub, rightSub) : mp3encoder.encodeBuffer(leftSub);
      if (mp3buf && mp3buf.length > 0) {
        streamingMp3Data.push(mp3buf);
      }

      blocksProcessed++;
      if (blocksProcessed % reportEvery === 0) {
        self.postMessage({ type: 'PROGRESS', payload: { progress: blocksProcessed / totalBlocks } });
      }
      
      if (streamingMp3Data.length >= 1000) { // Flush in large, low-overhead chunks
         self.postMessage({ type: 'CHUNK_DATA', payload: { mp3Data: streamingMp3Data } });
         streamingMp3Data = [];
      }
    }
    
    // Explicitly notify that this buffer cycle is completely drained, flushing whatever is left
    self.postMessage({ type: 'CHUNK_DONE', payload: { mp3Data: streamingMp3Data } });
  }
  
  else if (type === 'FINISH') {
    if (!mp3encoder) return;
    const mp3bufFlush = mp3encoder.flush();
    const mp3Data = [];
    if (mp3bufFlush.length > 0) {
      mp3Data.push(mp3bufFlush);
    }
    self.postMessage({ type: 'DONE', payload: { mp3Data } });
    
    mp3encoder = null;
  }
};
