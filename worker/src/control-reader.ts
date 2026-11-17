import { checkControlHeaders, ControlError } from "./control-headers.ts";

export { ControlError } from "./control-headers.ts";

export const CONTROL_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  milliseconds: 10_000,
});

function invalid(): never {
  throw new ControlError(400);
}

/** Geometric storage: network chunk count does not become retained bookkeeping. */
export async function readControl(
  request: Request,
  limits: { bytes: number; milliseconds: number } = CONTROL_LIMITS,
): Promise<Uint8Array> {
  checkControlHeaders(request, limits.bytes);
  if (!request.body) invalid();
  const reader = request.body.getReader();
  let storage = new Uint8Array(Math.min(limits.bytes, 1024));
  let used = 0;
  let complete = false;
  let interrupted: ControlError | undefined;
  const interrupt = (status: number) => {
    interrupted ??= new ControlError(status);
    // Native cancellation resolves pending read() calls before producer acknowledgement.
    void reader.cancel().catch(() => {});
  };
  const deadline = Date.now() + limits.milliseconds;
  const timer = setTimeout(() => interrupt(408), limits.milliseconds);
  const onAbort = () => interrupt(Date.now() >= deadline ? 408 : 400);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    for (;;) {
      if (interrupted) throw interrupted;
      if (Date.now() >= deadline) throw new ControlError(408);
      const { done, value } = await reader.read();
      if (interrupted) throw interrupted;
      if (Date.now() >= deadline) throw new ControlError(408);
      if (done) {
        complete = true;
        return used === storage.byteLength ? storage : storage.slice(0, used);
      }
      if (value.byteLength > limits.bytes - used) throw new ControlError(413);
      if (used + value.byteLength > storage.byteLength) {
        const grown = new Uint8Array(Math.min(limits.bytes, Math.max(storage.byteLength * 2, used + value.byteLength)));
        grown.set(storage.subarray(0, used));
        storage = grown;
      }
      storage.set(value, used);
      used += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if (interrupted) throw interrupted;
    if (Date.now() >= deadline) throw new ControlError(408);
    throw new ControlError(400);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    // Cancellation may never settle for a broken producer; do not await its acknowledgement.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
