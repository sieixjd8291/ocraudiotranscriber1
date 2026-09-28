import JSZip from 'jszip';

self.onmessage = async (e: MessageEvent) => {
  try {
    const { files } = e.data;
    const zip = new JSZip();
    const nameCounts: Record<string, number> = {};

    files.forEach((file: { name: string; result: string }) => {
      const originalName = file.name;
      const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
      let baseName = `${nameWithoutExt}_result`;
      let filename = `${baseName}.md`;

      if (nameCounts[filename]) {
        nameCounts[filename]++;
        filename = `${baseName}_(${nameCounts[filename]}).md`;
      } else {
        nameCounts[filename] = 1;
      }

      zip.file(filename, file.result || '');
    });

    const content = await zip.generateAsync({ type: 'blob' });
    self.postMessage({ type: 'success', blob: content });
  } catch (error: any) {
    self.postMessage({ type: 'error', error: error.message });
  }
};
