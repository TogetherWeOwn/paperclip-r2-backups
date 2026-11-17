import assert from "node:assert/strict";

export const origin = "https://console.example";
export const encode = (s) => Buffer.from(s).toString("base64");
export const env = {
  ACCESS_TEAM_NAME: "fixture-team", ACCESS_AUD: "fixture-audience",
  ASSETS: { fetch: async () => new Response("fixture asset") },
};
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "fixture-key" };
export function certsFetch() {
  return async (url) => {
    assert.equal(url, "https://fixture-team.cloudflareaccess.com/cdn-cgi/access/certs");
    return Response.json({ keys: [publicKey] });
  };
}
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
export async function jwt(claims = {}) {
  const header = base64url({ alg: "RS256", kid: "fixture-key" });
  const payload = base64url({ iss: "https://fixture-team.cloudflareaccess.com", aud: "fixture-audience", exp: Math.floor(Date.now() / 1000) + 300, ...claims });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}
export const token = await jwt();
export function request(path, { method = "POST", body, headers = {}, ...options } = {}) {
  return new Request(`${origin}${path}`, {
    method, headers: {
      "cf-access-jwt-assertion": token, origin, "content-type": "application/json; charset=utf-8", ...headers,
    }, ...(body === undefined ? {} : { body: typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body) }),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}), ...options,
  });
}
export const path = (route) => `/api/buckets/BACKUPS/${route}`;
