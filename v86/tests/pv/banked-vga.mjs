// responsive-wfw311: unit test of the paravirtual adapter's banked A000 window in vga.js.
// Exercises separate READ_BANK/WRITE_BANK (DISPI 0x18/0x19), the 256-colour planar
// ("unchained") path with the V7 fore-latch write mode, write-mode-1 latch copies across a
// bank boundary, and the chain-4 linear path. Run: node v86/tests/pv/banked-vga.mjs
import { VGAScreen } from "../../src/vga.js";

const LFB = 0xE0000000;
const VGA_MEM = 8 * 1024 * 1024;
const wasm_memory = new WebAssembly.Memory({ initial: (VGA_MEM >> 16) + 16 });
const cpu = {
    wasm_memory,
    io: { register_write() {}, register_read() {}, register_write_consecutive() {}, mmap_register() {} },
    devices: { pci: { register_device() {} } },
    flags: [0],
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

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
