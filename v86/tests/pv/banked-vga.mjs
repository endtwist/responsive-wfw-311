// responsive-wfw311: unit test of the paravirtual adapter's banked A000 window in vga.js.
// Exercises separate READ_BANK/WRITE_BANK (DISPI 0x18/0x19), the 256-colour planar
// ("unchained") path with the V7 fore-latch write mode, write-mode-1 latch copies across a
// bank boundary, the chain-4 linear path, the PV 2D blit engine (DISPI 0x20-0x26, including that
// it draws what the latch copy drew) and which states the rust write fast path is claimed for.
// Run: node v86/tests/pv/banked-vga.mjs
import { VGAScreen } from "../../src/vga.js";

const LFB = 0xE0000000;
const VGA_MEM = 8 * 1024 * 1024;
const wasm_memory = new WebAssembly.Memory({ initial: (VGA_MEM >> 16) + 16 });
const cpu = {
    wasm_memory,
    io: { register_write() {}, register_read() {}, register_write_consecutive() {}, mmap_register() {} },
    devices: { pci: { register_device() {} } },
    flags: [0],
    protected_mode: [0], cr: new Int32Array(8), cpl: new Uint8Array(1),
    svga_allocate_memory: () => 0,
    svga_mark_dirty() {},
    svga_dirty_bitmap_min_offset: [0], svga_dirty_bitmap_max_offset: [0],
    // vga.js passes the LFB address as a signed int32, as the real CPU does
    read8(a) { return new Uint8Array(wasm_memory.buffer)[(a >>> 0) - LFB]; },
    write8(a, v) { new Uint8Array(wasm_memory.buffer)[(a >>> 0) - LFB] = v; },
    device_raise_irq() {}, device_lower_irq() {},
};
const bus = { register() {}, send() {} };
const screen = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}) });
const vga = new VGAScreen(cpu, bus, screen, VGA_MEM);
const svga = vga.svga_memory;

let failures = 0, checks = 0;
const hex = n => typeof n === "number" ? "0x" + (n >>> 0).toString(16) : String(n);
function eq(actual, expected, what) {
    checks++;
    if(actual !== expected) { failures++; console.log(`FAIL ${what}: got ${hex(actual)} expected ${hex(expected)}`); }
}
const dispi = (idx, val) => { vga.port1CE_write(idx); vga.port1CF_write(val); };
const seq = (idx, val) => { vga.port3C4_write(idx); vga.port3C5_write(val); };
const gr = (idx, val) => { vga.port3CE_write(idx); vga.port3CF_write(val); };
const rd = off => vga.vga_memory_read(0xA0000 + off);
const wr = (off, v) => vga.vga_memory_write(0xA0000 + off, v);

// mode: 8 bpp SVGA, 2560x970 at pitch 4096
vga.svga_enabled = true; vga.svga_bpp = 8; vga.svga_width = 2560; vga.svga_height = 970; vga.svga_pitch = 4096;
seq(2, 0x0F);          // map mask
gr(0, 0); gr(1, 0);    // set/reset off
gr(3, 0);              // rotate 0, function COPY
gr(5, 0x00);           // write mode 0, read mode 0
gr(8, 0xFF);           // bitmask
seq(0xFE, 0);          // fore-latch mode off
svga.fill(0x11);

// --- 1. DISPI bank registers: separate read and write banks, index register readable
dispi(0x18, 9); dispi(0x19, 5);
vga.port1CE_write(0x18); eq(vga.port1CF_read(), 9, "READ_BANK reads back");
vga.port1CE_write(0x19); eq(vga.port1CF_read(), 5, "WRITE_BANK reads back");
eq(vga.port1CE_read(), 0x19, "DISPI index register reads back");
eq(vga.svga_read_bank_offset, 9 << 16, "read bank offset"); eq(vga.svga_bank_offset, 5 << 16, "write bank offset");

// --- 2. planar (chain-4 off): 4 pixels per address, 256K bank granularity, 64K page bits ignored
seq(4, 0x04);          // memory mode: chain-4 off
wr(100, 0xAB);         // write mode 0, map mask F: all four planes of pixel group 100
for(let p = 0; p < 4; p++) eq(svga[(4 << 16) + 400 + p], 0xAB, `planar write lands in 256K bank 1 plane ${p} (page bits ignored)`);
eq(svga[(5 << 16) + 400], 0x11, "planar write did not use 64K granularity");
svga[(8 << 16) + 400] = 0x77; svga[(8 << 16) + 401] = 0x66;
gr(4, 1);              // read map select plane 1
eq(rd(100), 0x66, "planar read comes from the READ bank (256K bank 2), selected plane");
gr(4, 0); eq(rd(100), 0x77, "planar read plane 0");
eq(vga.latch_dword >>> 0, (0x66 << 8 | 0x77 | 0x11 << 16 | 0x11 << 24) >>> 0, "planar read loads all four latches");

// --- 3. write mode 1 latch copy across a 256K bank boundary with different read/write banks
//     (bltstos_srccopy: nibble-aligned screen-to-screen SRCCOPY; 64 scanlines per bank at pitch 4096)
gr(5, 0x01);
for(let i = 0; i < 0x50000; i++) svga[i] = (i * 7 + 3) & 0xFF;      // source in bank 0 and start of bank 1
dispi(0x18, 0); dispi(0x19, 8);                                       // read 256K bank 0, write 256K bank 2
for(let off = 0xFFF0; off < 0x10000; off++) { rd(off); wr(off, 0); }  // last 16 groups of bank 0
dispi(0x18, 4); dispi(0x19, 12);                                      // driver bumps both banks on the wrap
for(let off = 0; off < 0x10; off++) { rd(off); wr(off, 0); }
let ok = true;
for(let i = 0x3FFC0; i < 0x40040; i++) if(svga[i] !== svga[i + 0x80000]) ok = false;
eq(ok, true, "write-mode-1 copy across bank boundary reproduces source in the write bank");
eq(svga[0x3FFC0], (0x3FFC0 * 7 + 3) & 0xFF, "source untouched");

// --- 4. V7 fore-latch fill (blt_pat_dst / blt_dst_nibbles): CPU data ignored, latches EC-EF written through map mask
gr(5, 0x00); gr(3, 0x00);
seq(0xEC, 0xFA); seq(0xED, 0xFA); seq(0xEE, 0xFA); seq(0xEF, 0xFA);   // solid green
seq(0xFE, 0x08);
dispi(0x19, 4);
svga.fill(0x22, 0x40000, 0x40010);
seq(2, 0x07);                                                          // right edge mask 0111 -> pixels 0..2 of the group
wr(2, 0x07);                                                           // the driver stores the mask byte itself as data
eq(svga[0x40008], 0xFA, "fore latch fill plane 0"); eq(svga[0x40009], 0xFA, "plane 1"); eq(svga[0x4000A], 0xFA, "plane 2");
eq(svga[0x4000B], 0x22, "masked plane 3 untouched");
seq(2, 0x0F); wr(1, 0x0F);
for(let p = 0; p < 4; p++) eq(svga[0x40004 + p], 0xFA, `fore latch fill full group plane ${p}`);
// with the ALU set to XOR the latches (loaded by a read of the destination) are combined
gr(3, 0x18); dispi(0x18, 4);
svga.fill(0x0F, 0x40000, 0x40004);
rd(0); wr(0, 0);
for(let p = 0; p < 4; p++) eq(svga[0x40000 + p], 0xFA ^ 0x0F, `fore latch XOR with destination plane ${p}`);
gr(3, 0); seq(0xFE, 0);
// fore-latch registers read back
vga.port3C4_write(0xEC); eq(vga.port3C5_read(), 0xFA, "fore latch EC reads back");
vga.port3C4_write(0xFE); eq(vga.port3C5_read(), 0x00, "FE reads back");
// back latches A0-A3 read and write the latch register (cursor_save_state saves them)
vga.latch_dword = 0x44332211 | 0;
vga.port3C4_write(0xA2); eq(vga.port3C5_read(), 0x33, "back latch 2 reads latch byte 2");
seq(0xA1, 0x99); eq(vga.latch_dword >>> 0, 0x44339911, "back latch write updates latch byte 1");

// --- 5. chain-4 linear path: 64K window, separate read/write banks in 64K units
seq(4, 0x0C); seq(2, 0x0F);
svga.fill(0x33);
dispi(0x18, 3); dispi(0x19, 7);
wr(0x1234, 0x5A);
eq(svga[(7 << 16) + 0x1234], 0x5A, "chain-4 write lands in WRITE_BANK (64K units)");
eq(svga[(3 << 16) + 0x1234], 0x33, "chain-4 write does not touch READ_BANK");
svga[(3 << 16) + 0x1234] = 0xC3;
eq(rd(0x1234), 0xC3, "chain-4 read comes from READ_BANK");
// 16 scanlines per bank at pitch 4096: row 16 col 100 is offset 100 of the window
wr(16 * 4096 + 100 & 0xFFFF, 0x77); eq(svga[(7 << 16) + 100], 0x77, "row 16 wraps to offset 100 of the window");

// --- 6. chain-4 with fore-latch mode on: emulation writes the latch byte for plane (addr & 3), honouring the map mask
seq(0xFE, 0x08); seq(0xEC, 0xA0); seq(0xED, 0xA1); seq(0xEE, 0xA2); seq(0xEF, 0xA3);
seq(2, 0x0F);
for(let i = 0; i < 4; i++) wr(0x2000 + i, 0x55);
for(let i = 0; i < 4; i++) eq(svga[(7 << 16) + 0x2000 + i], 0xA0 + i, `chain-4 fore latch pixel ${i}`);
seq(2, 0x0E); wr(0x2004, 0x55); eq(svga[(7 << 16) + 0x2004], 0x33, "chain-4 fore latch respects map mask (plane 0 masked)");
seq(0xFE, 0); seq(2, 0x0F);
wr(0x2004, 0x55); eq(svga[(7 << 16) + 0x2004], 0x55, "chain-4 plain write after fore latch off");

// --- 7. DISPI bank register 5 (VBE BANK) sets both banks
dispi(5, 2);
eq(vga.svga_read_bank_offset, 2 << 16, "BANK sets read bank"); eq(vga.svga_bank_offset, 2 << 16, "BANK sets write bank");

// --- 8. the hypervisor's view: ring-0 / V86-mode accesses with paging on (WIN386's VDD lending
//     "spare" window pages to a DOS box as text and font memory) go to pv_text_mem, never to
//     the frame buffer; ring 3 (the display driver) and real mode (DOS programs) are unchanged
const FLAG_VM = 1 << 17;
const ctx = (pe, pg, cpl, vm) => { cpu.protected_mode[0] = pe; cpu.cr[0] = (pe ? 1 : 0) | (pg ? 0x80000000 : 0); cpu.cpl[0] = cpl; cpu.flags[0] = vm ? FLAG_VM : 0; };
svga.fill(0x22); vga.pv_text_mem.fill(0);
seq(4, 0x04); seq(2, 0x0F); gr(5, 0x00); gr(8, 0xFF); gr(3, 0);          // planar, write mode 0, all planes
dispi(0x18, 0); dispi(0x19, 0);
ctx(1, 1, 3, 0); wr(0xF000, 0x33);                                        // display driver: row 60 of bank group 0
for(let p = 0; p < 4; p++) eq(svga[0x3C000 + p], 0x33, `ring 3 planar write reaches the frame buffer, plane ${p}`);
eq(vga.pv_text_mem[0x3C000], 0, "ring 3 write does not touch the text store");
ctx(1, 1, 0, 0); wr(0xF001, 0x20);                                        // the VDD clearing a text page it lent out
for(let p = 0; p < 4; p++) eq(vga.pv_text_mem[0x3C004 + p], 0x20, `ring 0 planar write lands in the text store, plane ${p}`);
eq(svga[0x3C004], 0x22, "ring 0 write leaves the frame buffer alone");
ctx(1, 1, 3, 1); seq(2, 0x04); wr(0xF002, 0x55);                          // a DOS VM's font load (plane 2 only)
eq(vga.pv_text_mem[0x3C008 + 2], 0x55, "V86 write lands in the text store, plane 2"); eq(vga.pv_text_mem[0x3C008], 0, "map mask honoured in the text store");
eq(svga[0x3C008 + 2], 0x22, "V86 write leaves the frame buffer alone");
seq(2, 0x0F);
gr(4, 2); eq(rd(0xF002), 0x55, "V86 planar read comes from the text store (read map select)");
gr(4, 0); eq(rd(0xF001), 0x20, "ring-0/V86 read of a text-store pixel group");
eq(vga.latch_dword >>> 0, 0x20202020, "text store read loads the latches");
ctx(1, 1, 3, 0); eq(rd(0xF000), 0x33, "ring 3 read comes from the frame buffer");
ctx(0, 0, 0, 0); wr(0xF003, 0x44);                                        // real mode (a DOS program on the bare adapter)
eq(svga[0x3C00C], 0x44, "real-mode write reaches the frame buffer"); eq(vga.pv_text_mem[0x3C00C], 0, "real-mode write does not touch the text store");
ctx(1, 0, 0, 0); wr(0xF003, 0x45);                                        // protected mode without paging (no hypervisor)
eq(svga[0x3C00C], 0x45, "ring 0 without paging reaches the frame buffer");
seq(4, 0x0C); ctx(1, 1, 3, 1); wr(0x1234, 0x66);                          // chained addressing in V86 mode
eq(vga.pv_text_mem[0x1234], 0x66, "V86 chain-4 write lands in the text store"); eq(svga[0x1234], 0x22, "frame buffer untouched");
eq(rd(0x1234), 0x66, "V86 chain-4 read comes from the text store");
ctx(1, 1, 3, 0); eq(rd(0x1234), 0x22, "ring 3 chain-4 read comes from the frame buffer");
ctx(0, 0, 0, 0);

// --- 9. atomic 32-bit DISPI write on the index port: index in the low word, data in the high word,
//     the index register itself untouched (the driver's bank switches and MoveCursor use this so
//     that no cli/sti is needed around index/data pairs)
ctx(1, 1, 3, 0);
vga.port1CE_write(0x1A);                                                   // someone is mid-way through an index/data pair
vga.port1CE_write32(0x18 | 7 << 16);
eq(vga.svga_read_bank_offset, 7 << 16, "write32 to 0x1CE programs READ_BANK");
vga.port1CE_write32(0x19 | 11 << 16);
eq(vga.svga_bank_offset, 11 << 16, "write32 to 0x1CE programs WRITE_BANK");
eq(vga.port1CE_read(), 0x1A, "write32 leaves the DISPI index register as it was");
vga.port1CE_write32(0x14 | 1234 << 16); vga.port1CE_write32(0x15 | 567 << 16);
vga.port1CE_write(0x14); eq(vga.port1CF_read(), 1234, "write32 cursor x"); vga.port1CE_write(0x15); eq(vga.port1CF_read(), 567, "write32 cursor y");
eq(vga.svga_read_bank_offset, 7 << 16, "cursor writes do not disturb the banks");

// --- 10. the unchained path writes the frame buffer through a plain view that follows wasm memory
//     growth (the Proxy view() costs ~1 us per access; a stale plain view would write into a
//     detached buffer)
seq(4, 0x04); seq(2, 0x0F); gr(5, 0x00); seq(0xFE, 0); gr(3, 0); gr(8, 0xFF);
dispi(0x18, 0); dispi(0x19, 0);
wr(0x100, 0x5C);
eq(vga.svga_memory[0x400], 0x5C, "unchained write before growth");
wasm_memory.grow(1);
wr(0x101, 0x5D);
eq(vga.svga_memory[0x404], 0x5D, "unchained write after wasm memory growth lands in the frame buffer");
eq(rd(0x101), 0x5D, "unchained read after growth");
eq(vga.svga_mem().buffer, wasm_memory.buffer, "plain view follows the new buffer");

// --- 11. the PV 2D blit engine (DISPI 0x20-0x26): the adapter copies a rectangle inside the frame
//     buffer, addressed as the banked path addresses it (pixel (x,y) at y*pitch + x), so a
//     scroll, a move or raising a window is seven port writes instead of a latch loop
const pitch = vga.svga_pitch_px();
const px = (x, y) => vga.svga_mem()[y * pitch + x];
const setpx = (x, y, v) => { vga.svga_mem()[y * pitch + x] = v; };
const blt = (sx, sy, dx, dy, w, h) => {
    // the driver programs each register with one atomic 32-bit write to the index port
    vga.port1CE_write32(0x20 | sx << 16); vga.port1CE_write32(0x21 | sy << 16);
    vga.port1CE_write32(0x22 | dx << 16); vga.port1CE_write32(0x23 | dy << 16);
    vga.port1CE_write32(0x24 | w << 16);  vga.port1CE_write32(0x25 | h << 16);
    vga.port1CE_write32(0x26 | 1 << 16);
};
eq(vga.svga_register_read(0x26) & 1, 1, "CTRL reports the blit capability in 8 bpp");
vga.port1CE_write(0x20); eq(vga.port1CF_read(), 0, "blit registers read back");

vga.svga_mem().fill(0, 0, 40 * pitch);
for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++) setpx(100 + x, 10 + y, 0x40 + y * 8 + x);
blt(100, 10, 300, 20, 8, 8);
ok = true;
for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++) if(px(300 + x, 20 + y) !== 0x40 + y * 8 + x) ok = false;
eq(ok, true, "blit copies a disjoint rectangle");
eq(px(100, 10), 0x40, "blit leaves the source alone");
eq(px(299, 20), 0, "blit does not write left of the destination");
eq(px(308, 27), 0, "blit does not write right of the destination");
eq(px(300, 19), 0, "blit does not write above the destination");
eq(px(300, 28), 0, "blit does not write below the destination");

// the blit marks the dirty range the compositor reads
vga.js_dirty_min = 0x7FFFFFFF; vga.js_dirty_max = -1;
blt(100, 10, 300, 20, 8, 8);
eq(vga.js_dirty_min, 20 * pitch + 300, "blit marks the first dirty byte");
eq(vga.js_dirty_max, 27 * pitch + 307, "blit marks the last dirty byte");

// overlapping rectangles: a scroll up, then a scroll down, are memmoves in both directions
for(let y = 0; y < 16; y++) for(let x = 0; x < 4; x++) setpx(500 + x, y, 0x80 + y);
blt(500, 4, 500, 0, 4, 12);                       // scroll the client up by four lines
ok = true; for(let y = 0; y < 12; y++) if(px(500, y) !== 0x80 + y + 4) ok = false;
eq(ok, true, "overlapping blit upwards (dst above src) copies front to back");
for(let y = 0; y < 16; y++) for(let x = 0; x < 4; x++) setpx(500 + x, y, 0x80 + y);
blt(500, 0, 500, 4, 4, 12);                       // scroll the client down by four lines
ok = true; for(let y = 4; y < 16; y++) if(px(500, y) !== 0x80 + y - 4) ok = false;
eq(ok, true, "overlapping blit downwards (dst below src) copies back to front");

// a blit is pixel-for-pixel what the driver's write-mode-1 latch loop through the window draws
seq(4, 0x04); seq(2, 0x0F); gr(5, 0x00); seq(0xFE, 0); gr(3, 0); gr(8, 0xFF);
dispi(0x18, 0); dispi(0x19, 0);
for(let i = 0; i < 64; i++) vga.svga_mem()[0x2000 + i] = 0x90 + i;
vga.svga_mem().fill(0, 0x3000, 0x3040);
gr(5, 0x01);                                       // write mode 1: the latches carry the data
for(let i = 0; i < 16; i++) { rd(0x800 + i); wr(0xC00 + i, 0); }   // read loads them, write stores them
gr(5, 0x00);
const latched = Array.from(vga.svga_mem().subarray(0x3000, 0x3040));
vga.svga_mem().fill(0, 0x3000, 0x3040);
blt(0x2000 % pitch, (0x2000 / pitch) | 0, 0x3000 % pitch, (0x3000 / pitch) | 0, 64, 1);
eq(Array.from(vga.svga_mem().subarray(0x3000, 0x3040)).join(), latched.join(),
   "the blit draws the same pixels as the write-mode-1 latch copy");

/* A dialog's exposed region. When "Program Item Properties" over Program Manager's Games group is
   closed, the uncovered part of the client is copied back as a rectangle that is as wide as the
   whole client, whose rows overlap the source, and which at pitch 4096 covers several of the 64K
   banks the latch path used to switch between mid-copy. The 2026-09-03 phone bug looked exactly
   like a blit that got this wrong -- tall vertical black/white streaks through the icons, the
   signature of one source row replicated down the destination -- and it was not one: the guest's
   frame buffer was byte-identical with --noblt, and the fault was the host's fill of the masked
   copy (SPEC 2026-09-03). These lock that answer in: the wide overlapping copy, in both
   directions, and the same-row horizontal overlap a dialog moving sideways makes. */
const v = (x, y) => (x * 7 + y * 13) & 0xFF;
const band = (y0, rows) => { for(let y = y0; y < y0 + rows; y++) for(let x = 0; x < pitch; x++) setpx(x, y, v(x, y)); };
band(100, 80);
blt(0, 116, 0, 100, pitch, 60);                    // the strip the dialog uncovered, scrolled up
ok = true;
for(let i = 0; i < 60; i++) for(let x = 0; x < pitch; x++) if(px(x, 100 + i) !== v(x, 116 + i)) ok = false;
eq(ok, true, "full-width overlapping blit across the 64K banks (dst above src)");
let same = true;
for(let x = 0; x < pitch; x++) if(px(x, 100) !== px(x, 101)) same = false;
eq(same, false, "the blit does not replicate one source row down the destination");

band(100, 80);
blt(0, 100, 0, 116, pitch, 60);                    // and the same strip pushed down
ok = true;
for(let i = 0; i < 60; i++) for(let x = 0; x < pitch; x++) if(px(x, 116 + i) !== v(x, 100 + i)) ok = false;
eq(ok, true, "full-width overlapping blit across the 64K banks (dst below src)");

band(300, 8);                                      // rows shared: the copy is a memmove inside each row
blt(200, 300, 260, 300, 400, 8);
ok = true;
for(let r = 0; r < 8; r++) for(let j = 0; j < 400; j++) if(px(260 + j, 300 + r) !== v(200 + j, 300 + r)) ok = false;
eq(ok, true, "same-row overlapping blit to the right is a memmove");
band(300, 8);
blt(260, 300, 200, 300, 400, 8);
ok = true;
for(let r = 0; r < 8; r++) for(let j = 0; j < 400; j++) if(px(200 + j, 300 + r) !== v(260 + j, 300 + r)) ok = false;
eq(ok, true, "same-row overlapping blit to the left is a memmove");

// the host can refuse the capability, and then the driver keeps to the banked path
vga.pv_blt_disabled = true;
eq(vga.svga_register_read(0x26) & 1, 0, "pv_blt_disabled withdraws the capability");
vga.pv_blt_disabled = false;

// nonsense rectangles clip instead of running off the end of the frame buffer
blt(0, 0, 0, 0, 0, 0);
blt(pitch - 4, 0, pitch - 2, 0, 64, 4);
blt(0, vga.svga_height, 0, ((VGA_MEM / pitch) | 0) - 1, 8, 64);
eq(true, true, "out-of-range blits are clipped, not fatal");

// --- 12. the rust A000 write fast path is only claimed for states memory.rs actually mirrors:
//     1 unchained, 2 chain-4 with the V7 fore latches, 3 chain-4 without them, 0 anything else
const modes = [];
cpu.pv_planar_set = (mode) => modes.push(mode);
const mode_now = () => { modes.length = 0; vga.pv_planar_sync(); return modes[modes.length - 1]; };
seq(4, 0x04); seq(0xFE, 0); gr(5, 0x00); gr(3, 0); gr(1, 0); gr(8, 0xFF);
eq(mode_now(), 1, "chain-4 off with a plain pipeline is the unchained fast path");
seq(4, 0x0C); eq(mode_now(), 3, "chain-4 without the fore latches is the linear fast path");
seq(0xFE, 0x08); eq(mode_now(), 2, "chain-4 with the fore latches is the latch-fill fast path");
gr(8, 0x0F); eq(mode_now(), 0, "a partial bit mask gives the write back to JS");
gr(8, 0xFF); gr(5, 0x01); eq(mode_now(), 0, "write mode 1 gives the write back to JS");
gr(5, 0x00); seq(0xFE, 0); eq(mode_now(), 3, "back to the linear fast path");
gr(8, 0x0F); eq(mode_now(), 3, "the bit mask does not matter without the fore latches");
gr(8, 0xFF);
vga.pv_planar_chain4_disabled = true; eq(mode_now(), 0, "--nochain4 sends chain-4 writes to JS");
vga.pv_planar_chain4_disabled = false;
vga.pv_planar_disabled = true; eq(mode_now(), 0, "--nofast sends every write to JS");
vga.pv_planar_disabled = false;
seq(4, 0x04); eq(mode_now(), 1, "chain-4 off again");
delete cpu.pv_planar_set;

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
