import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { doctor, ProviderRouter } from '@healix/core';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---- IPC: typed bridge to @healix/core ----
ipcMain.handle('healix:doctor', (_e, args: { probe?: boolean } | undefined) =>
  doctor({ probe: args?.probe ?? true }),
);
ipcMain.handle('healix:providers', () =>
  new ProviderRouter().list().map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities })),
);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
