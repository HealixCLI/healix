/** Marker for foundation stubs filled in during M1 implementation. */
export function notImplemented(what: string): never {
  throw new Error(`[healix] ${what} is not implemented yet (M1 stub).`);
}
