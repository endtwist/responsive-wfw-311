/* Protocol between the emulator worker (v86/src/browser/worker.js) and the page
 * (v86/src/browser/worker_client.js). Shared so the two sides cannot drift.
 *
 * Two pixel paths, chosen at run time:
 *
 *   "shared"  cross-origin isolated page: guest pixels live in a SharedArrayBuffer the
 *             compositor reads directly. The worker converts into it, records the dirty
 *             rectangle and bumps SEQ; the page copies only the dirty rows into its scratch
 *             ImageData and putImageData's them. No message per frame, no full-frame copy.
 *
 *   "bitmap"  no SharedArrayBuffer (the LAN dev server is plain http, so not a secure context
 *             and never cross-origin isolated): the worker puts the dirty rectangle into a
 *             scratch OffscreenCanvas, takes an ImageBitmap of it (synchronous,
 *             transferToImageBitmap) and transfers it. The page drawImage()s it at the right
 *             offset. One small transfer per changed region, still no full-frame copy.
 *
 * Both paths deliver the same thing to the page: "these rows of the guest screen changed".
 */

/* Int32 control block, in the same SharedArrayBuffer as the pixels (at offset 0). Only used on
   the "shared" path; on the "bitmap" path the same fields travel in the frame message. */
export const CTL = {
    SEQ: 0,          // bumped after pixels for a frame have been written (release)
    LOCK: 1,         // spin lock guarding the dirty rectangle
    X0: 2, Y0: 3, X1: 4, Y1: 5,   // pending dirty rectangle, x1/y1 exclusive; empty when x0 >= x1
    W: 6, H: 7,      // pixel buffer size in pixels (pitch === W)
    GEN: 8,          // buffer generation; a new buffer is posted when the mode changes
    CHANGES: 9,      // total dirty regions published: the compositor's "has the guest painted"
    // mirrored guest scalars, so the page can read them synchronously (see worker_client.js)
    PV_CMD: 10,
    IC: 11,          // instruction counter
    RUNNING: 12,
    BPP: 13,
    CMD_SEQ: 14,     // host->guest commands the worker has delivered
    IDLE_HALTED: 15,
    IDLE_PASSED: 16,
    LEN: 32,
};
export const CTL_BYTES = CTL.LEN * 4;

/** Spin lock for the dirty rectangle. The critical section is four stores, and the only
 *  contender is one other thread, so a CAS spin is cheaper than any alternative (and
 *  Atomics.wait is forbidden on the page's main thread anyway). */
export function rect_lock(ctl)
{
    for(let i = 0; ; i++)
    {
        if(Atomics.compareExchange(ctl, CTL.LOCK, 0, 1) === 0) return;
        if(i > 100000) return;              // never wedge the compositor on a lock
    }
}
export function rect_unlock(ctl)
{
    Atomics.store(ctl, CTL.LOCK, 0);
}
