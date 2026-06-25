/// <reference types="vite/client" />
import type { DoctorReport } from '@healix/core';

export interface HealixBridge {
  doctor: (args?: { probe?: boolean }) => Promise<DoctorReport>;
  providers: () => Promise<Array<{ id: string; label: string; capabilities: string[] }>>;
}

declare global {
  interface Window {
    healix: HealixBridge;
  }
}
