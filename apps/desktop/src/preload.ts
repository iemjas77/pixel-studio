import { contextBridge, ipcRenderer } from 'electron';

const inv = (ch: string, arg?: unknown) => ipcRenderer.invoke(ch, arg);
const api = {
  e2e: process.argv.includes('--ps-e2e'),
  openFile: (kind: 'document' | 'image') => inv('ps:open', kind) as Promise<{ path: string; name: string; bytes: Uint8Array } | null>,
  saveFile: (a: { bytes: Uint8Array; path: string | null; suggestedName: string }) => inv('ps:save', a) as Promise<{ path: string; name: string } | null>,
  exportFile: (a: { bytes: Uint8Array; suggestedName: string; ext: 'png' | 'jpg' | 'webp' }) => inv('ps:export', a) as Promise<{ path: string; name: string } | null>,
  recovery: {
    write: (a: { id: string; name: string; bytes: Uint8Array }) => inv('ps:recovery-write', a) as Promise<boolean>,
    list: () => inv('ps:recovery-list') as Promise<{ id: string; name: string; time: number }[]>,
    read: (id: string) => inv('ps:recovery-read', id) as Promise<Uint8Array>,
    discard: (id: string) => inv('ps:recovery-discard', id) as Promise<boolean>,
  },
  setTitle: (t: string) => inv('ps:set-title', t) as Promise<boolean>,
  closeApproved: () => inv('ps:close-approved') as Promise<boolean>,
  onRequestClose: (fn: () => void) => {
    const h = () => fn();
    ipcRenderer.on('ps:request-close', h);
    return () => ipcRenderer.removeListener('ps:request-close', h);
  },
};
contextBridge.exposeInMainWorld('pixelStudio', api);
export type PixelStudioApi = typeof api;
