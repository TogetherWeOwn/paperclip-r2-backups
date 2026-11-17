export class ControlError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Control request rejected");
    this.status = status;
  }
}

/** Reject unsupported headers before acquiring or reading the body. */
export function checkControlHeaders(request: Request, maxBytes: number): void {
  const reject = (status: number): never => {
    // A producer may never acknowledge cancellation; do not wait for it.
    void request.body?.cancel().catch(() => {});
    throw new ControlError(status);
  };
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") reject(415);
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) reject(400);
  if (length !== null && Number(length) > maxBytes) reject(413);
  if (!request.body) reject(400);
}
