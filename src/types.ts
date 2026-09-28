export interface FileItem {
  id: string;
  file: File | Blob;
  name: string;
  type: string;
  status: 'pending' | 'queued' | 'processing' | 'success' | 'error';
  result?: string;
  modelUsed?: string;
  preferredModel?: string;
  error?: string;
  retryMessage?: string;
  retryAttempts?: number;
  useCleanedAudio?: boolean;
  duration?: number;
  uploadProgress?: number;
  isUploading?: boolean;
  remoteUrl?: string;
  originalExtension?: string;
  sourceBitrate?: string;
  sourceSampleRate?: number;
  sourceChannels?: number;
  cleanvoiceResult?: {
    status: 'none' | 'pending' | 'uploading' | 'processing' | 'success' | 'error';
    cleanedUrl?: string;
    cleanedFileName?: string;
    error?: string;
    logs?: string[];
    progress?: number;
    configUsed?: any;
    editId?: string;
    edits?: Array<{ start: number, end: number, type: string }>;
    duration?: number; // total duration in seconds
    startedAt?: number;
    createdAt?: string;
    elapsedSeconds?: number;
    editRegionStartMs?: number;
    editRegionEndMs?: number;
    rawStatus?: string;
    stageTitle?: string;
    isQueued?: boolean;
    transcription?: string;
    summary?: string;
    social_content?: string;
    cleanedBlob?: Blob;
    preTranscodedBlob?: Blob;
    preTranscodedUrl?: string;
    serverElapsedSeconds?: number;
    serverElapsedAt?: number;
    uploadProgress?: number;
  };
}

