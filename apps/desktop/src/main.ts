import { app, BrowserWindow, dialog, ipcMain, Menu, session, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile } from './atomic';

const E2E = process.env.PIXEL_STUDIO_E2E === '1';
if (process.env.PIXEL_STUDIO_USER_DATA) app.setPath('userData', process.env.PIXEL_STUDIO_USER_DATA);
if (E2E) app.commandLine.appendSwitch('no-sandbox'); // Xvfb/container only; never set in normal runs

const RENDERER_DIR = path.join(__dirname, '..', '..', 'editor', 'dist');
const RENDERER_URL = pathToFileURL(path.join(RENDERER_DIR, 'index.html')).toString();
const MAX_OPEN_BYTES = 1024 * 1024 * 1024;   // 1 GiB read cap
const MAX_WRITE_BYTES = 2 * 1024 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Paths the user explicitly picked in a native dialog during this run (write capability list). */
const approved = new Set<string>();
let win: BrowserWindow | null = null;
let closeApproved = false;

// E2E-only: scripted dialog results (JSON array consumed in order; null = cancel).
const scripted: (string | null)[] = E2E && process.env.PIXEL_STUDIO_E2E_DIALOGS ? JSON.parse(process.env.PIXEL_STUDIO_E2E_DIALOGS) : [];
const nextScripted = () => (scripted.length ? scripted.shift()! : null);

function trusted(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith(RENDERER_URL.split('?')[0])) throw new Error('untrusted IPC sender');
}
function assertBytes(v: unknown, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error(`${what}: expected bytes`);
  if (v.byteLength > MAX_WRITE_BYTES) throw new Error(`${what}: too large`);
  return v;
}
const str = (v: unknown, max = 512) => {
  if (typeof v !== 'string' || v.length > max) throw new Error('invalid string argument');
  return v;
};
const recoveryDir = () => {
  const d = path.join(app.getPath('userData'), 'recovery');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const FILTERS: Record<'document' | 'image', Electron.FileFilter[]> = {
  document: [{ name: 'Pixel Studio Document', extensions: ['pstudio'] }, { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }, { name: 'All files', extensions: ['*'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
};

function registerIpc() {
  ipcMain.handle('ps:open', async (e, kind: unknown) => {
    trusted(e);
    if (kind !== 'document' && kind !== 'image') throw new Error('bad kind');
    let file: string | null;
    if (E2E) file = nextScripted();
    else {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: FILTERS[kind] });
      file = r.canceled ? null : r.filePaths[0];
    }
    if (!file) return null;
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Not a regular file.');
    if (st.size > MAX_OPEN_BYTES) throw new Error('File is too large for this preview build (limit 1 GiB).');
    approved.add(file);
    return { path: file, name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) };
  });

  ipcMain.handle('ps:save', async (e, arg: { bytes: unknown; path: unknown; suggestedName: unknown }) => {
    trusted(e);
    const bytes = assertBytes(arg.bytes, 'save');
    let target: string | null = null;
    if (typeof arg.path === 'string' && approved.has(arg.path)) target = arg.path;
    else if (E2E) target = nextScripted();
    else {
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: str(arg.suggestedName, 256), filters: [{ name: 'Pixel Studio Document', extensions: ['pstudio'] }],
      });
      target = r.canceled || !r.filePath ? null : r.filePath;
    }
    if (!target) return null;
    if (!target.toLowerCase().endsWith('.pstudio')) target += '.pstudio';
    atomicWriteFile(target, bytes);
    approved.add(target);
    return { path: target, name: path.basename(target) };
  });

  ipcMain.handle('ps:export', async (e, arg: { bytes: unknown; suggestedName: unknown; ext: unknown }) => {
    trusted(e);
    const bytes = assertBytes(arg.bytes, 'export');
    const ext = arg.ext;
    if (ext !== 'png' && ext !== 'jpg' && ext !== 'webp') throw new Error('bad extension');
    let target: string | null;
    if (E2E) target = nextScripted();
    else {
      const r = await dialog.showSaveDialog(win!, { defaultPath: str(arg.suggestedName, 256), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      target = r.canceled || !r.filePath ? null : r.filePath;
    }
    if (!target) return null;
    atomicWriteFile(target, bytes);
    return { path: target, name: path.basename(target) };
  });

  ipcMain.handle('ps:recovery-write', (e, arg: { id: unknown; name: unknown; bytes: unknown }) => {
    trusted(e);
    const id = str(arg.id, 64);
    if (!ID_RE.test(id)) throw new Error('bad id');
    const bytes = assertBytes(arg.bytes, 'recovery');
    atomicWriteFile(path.join(recoveryDir(), `${id}.pstudio`), bytes);
    fs.writeFileSync(path.join(recoveryDir(), `${id}.json`), JSON.stringify({ name: str(arg.name, 256), time: Date.now() }));
    return true;
  });
  ipcMain.handle('ps:recovery-list', (e) => {
    trusted(e);
    const d = recoveryDir();
    return fs.readdirSync(d).filter(f => f.endsWith('.pstudio') && !f.startsWith('.')).map(f => {
      const id = f.slice(0, -'.pstudio'.length);
      let meta: { name?: string; time?: number } = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, `${id}.json`), 'utf8')); } catch { /* optional */ }
      return { id, name: meta.name ?? id, time: meta.time ?? fs.statSync(path.join(d, f)).mtimeMs };
    }).filter(r => ID_RE.test(r.id));
  });
  ipcMain.handle('ps:recovery-read', (e, id: unknown) => {
    trusted(e);
    const s = str(id, 64);
    if (!ID_RE.test(s)) throw new Error('bad id');
    return new Uint8Array(fs.readFileSync(path.join(recoveryDir(), `${s}.pstudio`)));
  });
  ipcMain.handle('ps:recovery-discard', (e, id: unknown) => {
    trusted(e);
    const s = str(id, 64);
    if (!ID_RE.test(s)) throw new Error('bad id');
    for (const ext of ['pstudio', 'json']) { try { fs.unlinkSync(path.join(recoveryDir(), `${s}.${ext}`)); } catch { /* absent */ } }
    return true;
  });
  ipcMain.handle('ps:set-title', (e, title: unknown) => { trusted(e); win?.setTitle(str(title, 300)); return true; });
  ipcMain.handle('ps:close-approved', (e) => { trusted(e); closeApproved = true; win?.close(); return true; });
  ipcMain.handle('ps:quit-now', (e) => { trusted(e); closeApproved = true; app.quit(); return true; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#17181b', title: 'Pixel Studio', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      additionalArguments: E2E ? ['--ps-e2e'] : [],
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', (ev) => {
    if (closeApproved) return;
    ev.preventDefault();
    win?.webContents.send('ps:request-close');
  });
  win.on('closed', () => { win = null; });
  void win.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  createWindow();
});
// Programmatic quit (app.quit(), OS shutdown) must not be blocked by the unsaved-changes prompt;
// the window close button still goes through the prompt. Dirty documents are covered by autosave recovery.
app.on('before-quit', () => { closeApproved = true; });
app.on('window-all-closed', () => app.quit());
