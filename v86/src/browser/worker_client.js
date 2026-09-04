/* The page's half of the worker-hosted emulator (SPEC 2026-09-03).
 *
 * V86Worker looks like the V86 object the page used to hold, so `emulator.bus.send(...)`,
 * `emulator.add_listener(...)`, `emulator.restore_state(...)`, `emulator.v86.cpu.devices.vga.pv_cmd`
 * and friends keep working. What cannot cross a thread boundary unchanged is listed at the bottom
 * of this file and in SPEC.md.
 *
 * The speaker and the keyboard adapters stay on the page: there is no AudioContext in a worker,
 * and the keyboard adapter's whole job is DOM events. Both are bus-driven, so they work against
 * the proxy bus without knowing anything has moved.
 */
import { KeyboardAdapter } from "./keyboard.js";
import { MouseAdapter } from "./mouse.js";
import { SpeakerAdapter } from "./speaker.js";
import { CTL, CTL_BYTES, rect_lock, rect_unlock } from "./worker_proto.js";

/** Can guest pixels live in shared memory? Needs cross-origin isolation, which needs a secure
 *  context: the plain-http LAN dev server never gets it, hence the transferred-bitmap path. */
export function shared_pixels_available()
{
    return typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
}

/**
 * @constructor
 * @param {Object} options  the V86 options, plus:
 *   options.worker_url   URL of v86/src/browser/worker.js
 *   options.canvas       the canvas guest pixels are delivered into (the compositor's source)
 *   options.shared       force the shared path on/off (default: whatever the page can do)
 *   options.on_log       diagnostics sink
 */
export function V86Worker(options)
{
    const self_ = this;
    const on_log = options.on_log || (() => {});
    this.shared = options.shared === undefined ? shared_pixels_available() : !!options.shared;

    const worker = this.worker = new Worker(options.worker_url, { type: "module" });

    /* ------------------------------------------------------------------------------- the bus */
    const listeners = {};                       // name -> [{fn, this_value}]
    const subscribed = new Set();
    const bus = this.bus = {
        register(name, fn, this_value)
        {
            (listeners[name] || (listeners[name] = [])).push({ fn, this_value });
            if(!subscribed.has(name)) { subscribed.add(name); worker.postMessage({ t: "sub", name }); }
        },
        unregister(name, fn)
        {
            if(listeners[name]) listeners[name] = listeners[name].filter(l => l.fn !== fn);
        },
        send(name, value, transfer)
        {
            if(name === "pv-command" || name === "pv-command-string") cmd_sent++;
            const t = [];
            if(Array.isArray(value)) for(const v of value) if(v && v.buffer instanceof ArrayBuffer) t.push(v.buffer);
            worker.postMessage({ t: "bus", name, value }, t.length ? t : undefined);
        },
        send_async(name, value) { setTimeout(() => bus.send(name, value), 0); },
    };
    function deliver(name, value)
    {
        const l = listeners[name];
        if(!l) return;
        for(const e of l) { try { e.fn.call(e.this_value, value); } catch(err) { on_log("listener " + name + ": " + (err && err.stack || err)); } }
    }

    /* ------------------------------------------------------------------------------- the RPC */
    let next_id = 1;
    const pending = new Map();
    function call(fn, args, transfer)
    {
        const id = next_id++;
        return new Promise((resolve, reject) =>
        {
            pending.set(id, { resolve, reject });
            worker.postMessage({ t: "call", fn, args, id }, transfer);
        });
    }
    this.call = call;

    /* --------------------------------------------------------------------- the guest's state
     * A mirror of the few CPU and VGA fields the page reads. On the shared path the hot ones are
     * read straight out of the control block, so they are always current; otherwise they come
     * with the worker's state message (every rendered frame, and after every guest command). */
    let ctl = null;
    let cmd_sent = 0;                           // commands the page has sent
    const st = { pv_cmd: 0, ic: 0, running: 0, cmd_seq: 0, pv_cmd_str_len: 0,
                 svga_width: 0, svga_height: 0, bpp: 0, idle: [0, 0] };
    const ic_view = new Uint32Array(1);

    const live = i => ctl ? Atomics.load(ctl, i) : 0;
    const vga_mirror = {
        get pv_cmd()
        {
            // A command the page has sent but the worker has not confirmed delivering yet counts
            // as busy: the command register must not be overwritten before PVMON has taken it.
            const seq = ctl ? live(CTL.CMD_SEQ) : st.cmd_seq;
            if(seq < cmd_sent) return 1;
            return ctl ? live(CTL.PV_CMD) : st.pv_cmd;
        },
        get pv_cmd_str() { return { length: st.pv_cmd_str_len }; },
        get svga_width() { return st.svga_width; },
        get svga_height() { return st.svga_height; },
        get svga_bpp() { return ctl ? live(CTL.BPP) : st.bpp; },
    };
    /* The CPU registers themselves are not mirrored (they change every instruction and nothing on
       the page reads them per frame): the watchdog bundle asks the worker for a formatted snapshot
       instead, with emulator.cpu_snapshot(). What is mirrored is what the page polls. */
    const cpu_mirror = {
        devices: { vga: vga_mirror },
        wm: { exports: {
            pv_idle_stat: i => (ctl ? live(i === 0 ? CTL.IDLE_HALTED : CTL.IDLE_PASSED) : st.idle[i] || 0),
        } },
        get instruction_counter() { ic_view[0] = ctl ? live(CTL.IC) : st.ic; return ic_view; },
    };

    this.v86 = {
        cpu: cpu_mirror,
        get running() { return !!(ctl ? live(CTL.RUNNING) : st.running); },
        // Fire and forget: used by the ?keepalive=1 heartbeat while the page is hidden, where a
        // round trip would be pointless.
        do_tick() { worker.postMessage({ t: "call", fn: "do_tick", id: 0 }); },
    };

    /* ---------------------------------------------------------------------------- the pixels */
    const canvas = options.canvas;
    const pix = this.pixels = {
        path: this.shared ? "shared" : "bitmap",
        w: 0, h: 0, gen: 0,
        changes: 0,                             // dirty regions delivered: "the guest is painting"
        dirty: null,                            // last sync()'s rectangle, in guest pixels
        frames: 0,
        cost: 0,                                // ms spent in sync() since the last read
    };
    let ctx = null;
    let scratch = null;                         // full-size ImageData, the shared path's staging
    let shared_pixels = null;
    let queue = [];                             // bitmap path: regions waiting for the next composite
    let last_seq = 0;

    function resize(w, h)
    {
        if(!canvas) return;
        if(canvas.width !== w || canvas.height !== h)
        {
            canvas.width = w; canvas.height = h;
        }
        canvas.style.display = "block";
        ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
        ctx.imageSmoothingEnabled = false;
        pix.w = w; pix.h = h;
        scratch = null;
    }

    /** Bring the canvas up to date with the guest. Called once per composite, before the frame is
     *  drawn, so every pixel cost on the page happens in one place. Returns the dirty rectangle
     *  in guest pixels, or null. */
    pix.sync = function()
    {
        const t0 = performance.now();
        let r = null;
        try { r = apply_pending(); } catch(e) { on_log("sync: " + (e && e.stack || e)); }
        pix.cost += performance.now() - t0;
        pix.dirty = r;
        if(r) pix.frames++;
        return r;
    };

    function union(a, b)
    {
        if(!a) return b;
        if(!b) return a;
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                 w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
                 h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) };
    }

    function apply_pending()
    {
        // Bitmap path: draw whatever arrived since the last composite.
        if(!ctl)
        {
            if(!queue.length || !ctx) return null;
            const items = queue; queue = [];
            let r = null;
            for(const it of items)
            {
                if(it.gen !== pix.gen) { if(it.bmp) it.bmp.close(); continue; }
                if(it.bmp)
                {
                    ctx.drawImage(it.bmp, 0, 0, it.w, it.h, it.x, it.y, it.w, it.h);
                    it.bmp.close();
                }
                else
                {
                    ctx.putImageData(new ImageData(new Uint8ClampedArray(it.buf), it.w, it.h), it.x, it.y);
                }
                r = union(r, { x: it.x, y: it.y, w: it.w, h: it.h });
            }
            return r;
        }
        // Shared path: one memcpy of the changed rows, then one putImageData.
        const seq = Atomics.load(ctl, CTL.SEQ);
        if(seq === last_seq || !ctx || !shared_pixels) return null;
        last_seq = seq;
        rect_lock(ctl);
        const x0 = ctl[CTL.X0], y0 = ctl[CTL.Y0], x1 = ctl[CTL.X1], y1 = ctl[CTL.Y1];
        ctl[CTL.X0] = 0; ctl[CTL.Y0] = 0; ctl[CTL.X1] = 0; ctl[CTL.Y1] = 0;
        rect_unlock(ctl);
        if(x0 >= x1 || y0 >= y1) return null;
        const w = pix.w, h = pix.h;
        if(!scratch) scratch = new ImageData(w, h);
        const dw = Math.min(x1, w) - x0, dh = Math.min(y1, h) - y0;
        if(dw <= 0 || dh <= 0) return null;
        const dst = scratch.data;
        if(x0 === 0 && dw === w)
        {
            const from = y0 * w * 4, to = (y0 + dh) * w * 4;
            dst.set(shared_pixels.subarray(from, to), from);
        }
        else
        {
            for(let y = y0; y < y0 + dh; y++)
            {
                const o = (y * w + x0) * 4;
                dst.set(shared_pixels.subarray(o, o + dw * 4), o);
            }
        }
        ctx.putImageData(scratch, 0, 0, x0, y0, dw, dh);
        return { x: x0, y: y0, w: dw, h: dh };
    }

    /* ------------------------------------------------------------------------- worker traffic */
    worker.onmessage = e =>
    {
        const m = e.data;
        switch(m.t)
        {
            case "up":
                worker.postMessage({ t: "init", options: {
                    wasm_path: options.wasm_path, memory_size: options.memory_size,
                    vga_memory_size: options.vga_memory_size, bios: options.bios, vga_bios: options.vga_bios,
                    hda: options.hda, boot_order: options.boot_order,
                    shared: self_.shared, render_interval: options.render_interval || 16,
                    /* COM2, when the page wants it: Trumpet Winsock opens 0x2F8 by default and
                       the guest's internet arrives down that line (web/net.js). */
                    uart1: options.uart1,
                } });
                break;
            case "inited":
                self_.shared = m.shared;
                pix.path = m.shared ? "shared" : "bitmap";
                break;
            case "screen":
                pix.gen = m.gen;
                if(m.sab)
                {
                    ctl = new Int32Array(m.sab, 0, CTL.LEN);
                    shared_pixels = new Uint8Array(m.sab, CTL_BYTES);
                    last_seq = 0;
                }
                for(const it of queue) if(it.bmp) it.bmp.close();
                queue = [];
                resize(m.w, m.h);
                pix.path = m.path;
                break;
            case "frame":
                pix.changes = m.changes;
                queue.push(m);
                if(queue.length > 240)   // the page has stopped compositing: keep memory bounded
                {
                    const drop = queue.shift();
                    if(drop.bmp) drop.bmp.close();
                    on_log("pixels: dropped a region, " + queue.length + " queued");
                }
                break;
            case "state":
                Object.assign(st, m.st);
                break;
            case "bus":
                deliver(m.name, m.value);
                break;
            case "ret":
            {
                const p = pending.get(m.id);
                if(!p) break;
                pending.delete(m.id);
                if(m.error) p.reject(new Error(m.error)); else p.resolve(m.value);
                break;
            }
            case "log":
                on_log(m.s);
                break;
        }
    };
    worker.onerror = ev => on_log("worker: " + (ev.message || ev));

    /* On the shared path CHANGES lives in the control block; expose it the same way. */
    Object.defineProperty(pix, "change_count", { get: () => ctl ? Atomics.load(ctl, CTL.CHANGES) : pix.changes });

    /* --------------------------------------------------------------- page-side v86 adapters */
    if(!options.disable_keyboard) this.keyboard_adapter = new KeyboardAdapter(bus);
    if(!options.disable_mouse) this.mouse_adapter = new MouseAdapter(bus, options.screen_container);   // DOM listeners, page side
    if(!options.disable_speaker)
    {
        try { this.speaker_adapter = new SpeakerAdapter(bus); }
        catch(e) { on_log("speaker: " + (e && e.message)); }
    }

    /* --------------------------------------------------------------------- the V86 API proper */
    this.add_listener = (event, fn) => bus.register(event, fn, this);
    this.remove_listener = (event, fn) => bus.unregister(event, fn);
    this.run = () => call("run");
    this.stop = () => call("stop");
    this.restart = () => call("restart");
    this.restore_state = state => call("restore_state", state, [state instanceof ArrayBuffer ? state : state.buffer]);
    this.save_state = () => call("save_state");
    this.is_running = () => this.v86.running;
    this.get_instruction_counter = () => (ctl ? Atomics.load(ctl, CTL.IC) : st.ic) >>> 0;
    this.read_memory = (offset, length) => call("read_memory", [offset, length]);
    this.cpu_snapshot = () => call("cpu_snapshot");
    this.screen_set_scale = () => {};
    this.screen_make_screenshot = () => null;
    this.keyboard_send_text = async function(string)
    {
        for(const ch of string) this.keyboard_adapter.simulate_char(ch);
    };
    this.keyboard_send_scancodes = async function(codes)
    {
        for(const c of codes) bus.send("keyboard-code", c);
    };
    this.keyboard_set_enabled = enabled => { if(this.keyboard_adapter) this.keyboard_adapter.emu_enabled = enabled; };
    this.mouse_set_enabled = enabled =>
    {
        if(this.mouse_adapter) { this.mouse_adapter.emu_enabled = enabled; this.mouse_adapter.update_cursor(); }
    };
    this.mouse_set_status = this.mouse_set_enabled;
    this.keyboard_set_status = this.keyboard_set_enabled;
    /* Kept because the page and the harnesses call them; both are asynchronous now. */
    this.screen_adapter = {
        update_screen: () => call("update_screen"),
        get_text_screen: () => call("get_text_screen"),
        get_text_row: y => call("text_row", y),
        set_scale: () => {},
    };
    this.destroy = async () =>
    {
        await call("stop").catch(() => {});
        worker.terminate();
    };
}
