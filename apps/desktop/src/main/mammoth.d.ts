/** Minimal ambient types for mammoth — no official/@types package ships raw-text extraction typings. */
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }

  export function extractRawText(input: { path: string } | { buffer: Buffer }): Promise<ExtractRawTextResult>;
}
