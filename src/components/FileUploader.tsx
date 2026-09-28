import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadCloud } from 'lucide-react';

interface FileUploaderProps {
  onFilesAdded: (files: File[]) => void;
  accept?: Record<string, string[]>;
  label?: string;
}

export function FileUploader({ onFilesAdded, accept, label }: FileUploaderProps) {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    onFilesAdded(acceptedFiles);
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDragEnter: () => {
      import('../services/cleanvoiceService').then(({ preloadCleanvoiceConnection }) => {
        preloadCleanvoiceConnection();
      }).catch((e) => {
        console.warn('Failed to lazy load cleanvoice connection preloader:', e);
      });
    },
    accept: accept || {
      'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aiff', '.aac', '.opus', '.webm'],
      'video/*': ['.mp4', '.mov', '.webm', '.avi', '.mkv'],
      'audio/webm': ['.webm'],
      'video/webm': ['.webm']
    }
  });

  return (
    <div
      {...getRootProps({
        onMouseEnter: () => {
          import('../services/cleanvoiceService').then(({ preloadCleanvoiceConnection }) => {
            preloadCleanvoiceConnection();
          }).catch((e) => {
            console.warn('Failed to lazy load cleanvoice connection preloader:', e);
          });
        }
      })}
      className={`border-2 border-dashed rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-colors duration-300 min-h-[160px] sm:min-h-[240px] flex flex-col items-center justify-center outline-none focus:outline-none select-none will-change-transform ${
        isDragActive
          ? 'border-indigo-500 bg-indigo-50 dark:bg-slate-800/60 animate-dropzone-pulse'
          : 'border-slate-300 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-slate-50 dark:hover:bg-slate-800/40 text-slate-700 dark:text-slate-300'
      }`}
    >
      <input {...getInputProps({ 'aria-label': label || 'Upload audio or video files' })} />
      <UploadCloud className="mx-auto h-8 w-8 sm:h-12 sm:w-12 text-slate-500 dark:text-slate-300 mb-2 sm:mb-4 flex-shrink-0" />
      <p className="text-base sm:text-lg font-medium text-slate-700 dark:text-slate-200 leading-snug">
        {isDragActive ? 'Drop the files here...' : (label || 'Drag & drop audio or video files here')}
      </p>
    </div>
  );
}
