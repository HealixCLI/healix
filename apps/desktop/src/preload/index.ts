import { contextBridge, ipcRenderer } from 'electron';

const api = {
  doctor: (args?: { probe?: boolean }) => ipcRenderer.invoke('healix:doctor', args),
  providers: () => ipcRenderer.invoke('healix:providers'),
};

contextBridge.exposeInMainWorld('healix', api);

export type HealixApi = typeof api;
