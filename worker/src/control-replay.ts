export function replayControl(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    redirect: request.redirect,
    signal: request.signal,
  });
}
