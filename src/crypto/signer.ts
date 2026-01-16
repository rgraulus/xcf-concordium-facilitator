// src/crypto/signer.ts
import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  KeyObject,
} from "crypto";

const PRIV_B64 = process.env.JWS_PRIVATE_KEY_BASE64 || "";
const KID = process.env.JWS_KEY_ID || process.env.JWS_KID || "kid-dev-1";

if (!PRIV_B64) {
  throw new Error("Missing JWS_PRIVATE_KEY_BASE64");
}

const priv = createPrivateKey({
  key: Buffer.from(PRIV_B64, "base64"),
  format: "der",
  type: "pkcs8",
});
const pub = createPublicKey(priv);

// ---- helpers ----
function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToBuf(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// Prefer native JWK export if available (Node 16+ supports Ed25519 jwk export)
function publicJwkFromKey(key: KeyObject) {
  try {
    const jwk = key.export({ format: "jwk" }) as any;
    jwk.kid = KID;
    jwk.alg = "EdDSA";
    jwk.use = "sig";
    return jwk;
  } catch {
    const spki = key.export({ format: "der", type: "spki" }) as Buffer;
    const x = b64url(spki.slice(-32));
    return { kty: "OKP", crv: "Ed25519", x, kid: KID, alg: "EdDSA", use: "sig" };
  }
}

// ---- public API ----
export function jwks() {
  return { keys: [publicJwkFromKey(pub)] };
}

export function getPublicJwk() {
  return jwks().keys[0];
}

export function getKeyId() {
  return KID;
}

export function signJws(payload: unknown): string {
  const header = { alg: "EdDSA", kid: KID, typ: "JWT" };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const m = Buffer.from(`${h}.${p}`);
  const sig = nodeSign(null, m, priv); // Ed25519
  return `${h}.${p}.${b64url(sig)}`;
}

export function verifyJws(jws: string): {
  valid: boolean;
  header?: any;
  payload?: any;
  error?: string;
} {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) return { valid: false, error: "invalid_format" };

    const [h64, p64, s64] = parts;
    const header = JSON.parse(b64urlToBuf(h64).toString("utf8"));
    if (header.alg !== "EdDSA") return { valid: false, error: "alg_mismatch" };

    const message = Buffer.from(`${h64}.${p64}`);
    const sig = b64urlToBuf(s64);

    const ok = nodeVerify(null, message, pub, sig);
    if (!ok) return { valid: false, error: "bad_signature" };

    const payload = JSON.parse(b64urlToBuf(p64).toString("utf8"));
    return { valid: true, header, payload };
  } catch (e: any) {
    return { valid: false, error: e?.message ?? "verify_error" };
  }
}
