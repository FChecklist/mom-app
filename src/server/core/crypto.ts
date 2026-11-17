// AES-GCM for OAuth refresh tokens at rest. Key = SHA-256(TOKEN_ENC_KEY). Format: iv.cipher (base64url).
import { bytesToB64url, randomBytes } from '../util.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function key(secret: string): Promise<CryptoKey> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptText(secret: string, plain: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), enc.encode(plain));
  return bytesToB64url(iv) + '.' + bytesToB64url(new Uint8Array(ct));
}
export async function decryptText(secret: string, blob: string): Promise<string> {
  const [iv, ct] = blob.split('.');
  if (!iv || !ct) throw new Error('bad blob');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(iv) }, await key(secret), b64urlToBytes(ct));
  return dec.decode(pt);
}
export { b64urlToBytes };
