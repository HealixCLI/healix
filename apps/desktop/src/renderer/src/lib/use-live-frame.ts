import { useEffect, useRef, useState } from 'react';
import type { RunChannelMessage } from './ipc-types';

/**
 * Tracks the latest computer-use browser frame (JPEG, base64) for the active run.
 * Subscribes to the multiplexed run channel and keeps only `run:frame` messages
 * whose runId matches `activeRunId`. Clears when the active run changes or when a
 * new run starts. Cleans up its subscription on unmount.
 */
export function useLiveFrame(activeRunId: string | null): {
  frame: string | null;
  frameCount: number;
} {
  const [frame, setFrame] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  // Read the active id inside the listener without re-subscribing each change.
  const activeRef = useRef<string | null>(activeRunId);

  useEffect(() => {
    activeRef.current = activeRunId;
    // A new (or cleared) active run resets the mirror.
    setFrame(null);
    setFrameCount(0);
  }, [activeRunId]);

  useEffect(() => {
    const unsubscribe = window.healix.onRunEvent((msg: RunChannelMessage) => {
      if (msg.channel !== 'run:frame') return;
      const active = activeRef.current;
      if (active && msg.payload.runId !== active) return;
      setFrame(msg.payload.frameBase64);
      setFrameCount((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  return { frame, frameCount };
}
