/* The emulator worker (SPEC 2026-09-03).
 *
 * Everything the guest costs -- the wasm CPU, the devices, the disk fetches, and the conversion of
 * guest pixels into RGBA -- happens here, so a busy guest cannot delay the page's composite or its
 * touch handling. The page keeps the compositor, the input translation, and the audio (there is no
 * AudioContext in a worker).
 *
 * Bridge to the page (see worker_client.js for the other half):
 *   - bus messages are forwarded both ways. The page subscribes by name ({t:"sub"}), which is how
 *     the speaker and keyboard adapters, running on the page against the proxy bus, keep working.
 *   - a small set of calls are RPC ({t:"call", fn, args, id} -> {t:"ret", id, value|error}).
 *   - guest scalars the page reads synchronously (pv_cmd, the instruction counter, ...) are
 *     mirrored into the shared control block, and posted with every state message when there is
 *     no SharedArrayBuffer.
 */
import { V86 } from "./starter.js";
import { WorkerScreenAdapter } from "./worker_screen.js";
import { CTL } from "./worker_proto.js";

let emulator = null;
let screen = null;
let shared = false;
let cmd_seq = 0;
let render_timer = 0;
let render_interval = 16;
const subscribed = new Set();

const post = (msg, transfer) => transfer ? self.postMessage(msg, transfer) : self.postMessage(msg);

function log(s) { post({ t: "log", s: String(s) }); }

/* ------------------------------------------------------------------- the guest's own scalars */
function ctl() { return screen && screen.ctl && screen.ctl(); }

function state_object()
{
    const st = { pv_cmd: 0, ic: 0, running: 0, bpp: 0, cmd_seq, idle: [0, 0] };
    try
    {
        const cpu = emulator && emulator.v86 && emulator.v86.cpu;
        if(!cpu) return st;
        st.ic = cpu.instruction_counter[0] >>> 0;
        st.running = emulator.v86.running ? 1 : 0;
        const vga = cpu.devices && cpu.devices.vga;
        if(vga)
        {
            st.pv_cmd = vga.pv_cmd | 0;
            st.pv_cmd_str_len = (vga.pv_cmd_str && vga.pv_cmd_str.length) | 0;
            st.svga_width = vga.svga_width | 0;
            st.svga_height = vga.svga_height | 0;
            st.bpp = vga.svga_bpp | 0;
        }
        try { st.idle = [cpu.wm.exports["pv_idle_stat"](0), cpu.wm.exports["pv_idle_stat"](1)]; } catch(e) {}
    }
    catch(e) {}
    return st;
}

function mirror_state()
{
    const st = state_object();
    const c = ctl();
    if(c)
    {
        Atomics.store(c, CTL.PV_CMD, st.pv_cmd | 0);
        Atomics.store(c, CTL.IC, st.ic | 0);
        Atomics.store(c, CTL.RUNNING, st.running | 0);
        Atomics.store(c, CTL.BPP, st.bpp | 0);
        Atomics.store(c, CTL.CMD_SEQ, cmd_seq | 0);
        Atomics.store(c, CTL.IDLE_HALTED, st.idle[0] | 0);
        Atomics.store(c, CTL.IDLE_PASSED, st.idle[1] | 0);
        return;
    }
    post({ t: "state", st });
}

/* The guest frame rate. v86's own adapter drives itself off requestAnimationFrame, which a worker
   does not have; converting more often than the display refreshes would be waste, so the pixel
   conversion runs on a timer at ~60 Hz and the page composites at whatever rate it likes (120 on
   a ProMotion phone) from the pixels it already has. */
let render_errors = 0;
function render()
{
    if(!(emulator && emulator.v86 && emulator.v86.cpu && emulator.screen_fill_buffer)) return;   // not booted yet
    try
    {
        emulator.screen_fill_buffer();
    }
    catch(e) { if(render_errors++ < 5) log("render: " + (e && e.stack || e)); }
    mirror_state();
}

function start_render_timer(ms)
{
    render_interval = ms || 16;
    if(render_timer) clearInterval(render_timer);
    render_timer = setInterval(render, render_interval);
}

/* --------------------------------------------------------------------------- CPU-state bundle */
function cpu_snapshot()
{
    try
    {
        const cpu = emulator.v86.cpu;
        const r = cpu.reg32, s = cpu.sreg;
        const hex = v => (v >>> 0).toString(16).padStart(8, "0");
        const idle = i => { try { return cpu.wm.exports["pv_idle_stat"](i); } catch(e) { return "?"; } };
        return { eax: hex(r[0]), ecx: hex(r[1]), edx: hex(r[2]), ebx: hex(r[3]), esp: hex(r[4]), ebp: hex(r[5]),
                 esi: hex(r[6]), edi: hex(r[7]), eip: hex(cpu.instruction_pointer[0]), prev_ip: hex(cpu.previous_ip[0]),
                 cs: s[1].toString(16), ds: s[3].toString(16), ss: s[2].toString(16),
                 flags: hex(cpu.flags[0]), IF: !!(cpu.flags[0] & 0x200), VM: !!(cpu.flags[0] & 0x20000),
                 in_hlt: cpu.in_hlt[0], cr0: cpu.cr ? hex(cpu.cr[0]) : "?",
                 idle_halted: idle(0), idle_passed: idle(1) };
    }
    catch(e) { return { error: String(e) }; }
}

/* --------------------------------------------------------------------------------- the calls */
const calls = {
    async run() { emulator.run(); },
    async stop() { await emulator.stop(); },
    async restart() { emulator.restart(); },
    async restore_state(state) { await emulator.restore_state(state); },
    async save_state() { const buf = await emulator.save_state(); return { value: buf, transfer: [buf] }; },
    /* ?keepalive=1: while the page is hidden its heartbeat worker drives the guest one tick at a
       time, because a hidden page throttles this worker's own timers too. The mirror is refreshed
       with it, so the instruction counter the page reads keeps moving. */
    async do_tick() { try { if(emulator.v86 && emulator.v86.running) { emulator.v86.do_tick(); mirror_state(); } } catch(e) {} },
    async is_running() { return !!(emulator && emulator.is_running && emulator.is_running()); },
    async get_instruction_counter() { return emulator.get_instruction_counter() >>> 0; },
    async cpu_snapshot() { return cpu_snapshot(); },
    async state() { return state_object(); },
    async update_screen() { render(); },
    async render_interval(ms) { start_render_timer(ms); },
    async read_memory(a) { return emulator.read_memory(a[0], a[1]); },
    async get_text_screen() { return screen.get_text_screen(); },
    async text_row(y) { return screen.get_text_row(y); },
};

/* ------------------------------------------------------------------------------------ set-up */
async function init(o)
{
    shared = !!o.shared;
    screen = new WorkerScreenAdapter({ shared, post });

    const options = {
        wasm_path: o.wasm_path,
        memory_size: o.memory_size,
        vga_memory_size: o.vga_memory_size,
        bios: o.bios,
        vga_bios: o.vga_bios,
        hda: o.hda,
        boot_order: o.boot_order,
        autostart: false,
        disable_keyboard: true,          // the page owns the DOM listeners
        disable_mouse: true,
        disable_speaker: true,           // no AudioContext in a worker
        screen: { adapter: screen },
    };
    emulator = new V86(options);

    /* The page's proxy bus subscribes by name; anything it asked for before the emulator existed
       is registered now. */
    for(const name of subscribed) register(name);

    /* v86's zstd helper spawns a nested worker and transfers the wasm module bytes into it.
       Nested workers are not universally available (and the transfer would cost us the module),
       so decompress in place here: this is already off the page's main thread. */
    emulator.zstd_decompress_worker = async (size, src) => emulator.zstd_decompress(size, src);

    start_render_timer(o.render_interval || 16);
    post({ t: "inited", shared });
}

function register(name)
{
    if(!emulator) return;
    emulator.bus.register(name, value =>
    {
        // Float32Array pairs from the DAC and typed arrays generally: transfer rather than clone.
        const transfer = [];
        if(Array.isArray(value)) for(const v of value) if(v && v.buffer instanceof ArrayBuffer) transfer.push(v.buffer);
        try { post({ t: "bus", name, value }, transfer.length ? transfer : undefined); }
        catch(e) { try { post({ t: "bus", name, value }); } catch(e2) { log("bus " + name + ": " + e2); } }
    }, null);
}

self.onmessage = async e =>
{
    const m = e.data;
    try
    {
        switch(m.t)
        {
            case "init": await init(m.options); break;
            case "sub":
                if(!subscribed.has(m.name)) { subscribed.add(m.name); register(m.name); }
                break;
            case "bus":
                if(m.name === "pv-command" || m.name === "pv-command-string") cmd_seq++;
                emulator.bus.send(m.name, m.value);
                if(m.name === "pv-command" || m.name === "pv-command-string") mirror_state();
                break;
            case "call":
            {
                const fn = calls[m.fn];
                if(!fn) { post({ t: "ret", id: m.id, error: "no such call: " + m.fn }); break; }
                const r = await fn(m.args);
                if(r && r.transfer) post({ t: "ret", id: m.id, value: r.value }, r.transfer);
                else post({ t: "ret", id: m.id, value: r === undefined ? null : r });
                break;
            }
            case "tick": render(); break;
        }
    }
    catch(err)
    {
        if(m.t === "call") post({ t: "ret", id: m.id, error: String(err && (err.stack || err.message || err)) });
        else log((m.t || "?") + ": " + String(err && (err.stack || err)));
    }
};

self.onerror = ev => { try { post({ t: "log", s: "worker error: " + (ev.message || ev) }); } catch(e) {} };
post({ t: "up" });
