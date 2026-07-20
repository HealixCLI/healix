import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAppDataDir } from '../env/app-data.js';

/**
 * At-rest encryption for project secrets (test_username/test_password) stored
 * in the local SQLite DB — a plaintext DB file is trivially readable by
 * anything with filesystem access. Key lives alongside the DB (secret.key,
 * 0o600), generated on first use; this protects against casual disclosure
 * (accidental sharing of the DB file, backups, etc.), not a fully
 * compromised machine — the same threat model as most local-first tools.
 */
const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return join(ensureAppDataDir(), 'secret.key');
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const p = keyPath();
  if (existsSync(p)) {
    cachedKey = Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(p, cachedKey.toString('hex'), { mode: 0o600 });
  }
  return cachedKey;
}

/** Test-only seam: force a fresh key to be loaded/created from the current HEALIX_DATA_DIR. */
export function resetCryptoKeyForTests(): void {
  cachedKey = null;
}

/** Encrypt a secret for storage. Empty/null values pass through unchanged. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain ?? null;
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a value written by encryptSecret. Values without the version
 * prefix are legacy plaintext (written before this change) and are returned
 * as-is — they get encrypted on the next save of that project.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return stored ?? null;
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const key = loadOrCreateKey();
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Corrupt ciphertext or a key.txt from a different data dir — fail closed
    // (no credential) rather than throwing and breaking project reads.
    return null;
  }
}
