mod ext {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn mmap_read8(addr: u32) -> i32;
        pub fn mmap_read32(addr: u32) -> i32;

        pub fn mmap_write8(addr: u32, value: i32);
        pub fn mmap_write16(addr: u32, value: i32);
        pub fn mmap_write32(addr: u32, value: i32);
        pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
        pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
    }
}

use crate::cpu::apic;
use crate::cpu::cpu::{
    handle_irqs, reg128, APIC_MEM_ADDRESS, APIC_MEM_SIZE, FLAG_VM, IOAPIC_MEM_ADDRESS,
    IOAPIC_MEM_SIZE,
};
use crate::cpu::global_pointers::{cpl, cr, flags, memory_size, protected_mode};
use crate::cpu::ioapic;
use crate::cpu::vga;
use crate::jit;
use crate::page::Page;

use std::alloc;
use std::ptr;

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null());
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}

#[no_mangle]
pub unsafe fn zero_memory(addr: u32, size: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), 0, size as usize);
}

#[allow(non_upper_case_globals)]
pub static mut vga_mem8: *mut u8 = ptr::null_mut();
#[allow(non_upper_case_globals)]
pub static mut vga_memory_size: u32 = 0;

#[no_mangle]
pub fn svga_allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(vga_mem8.is_null());
    };
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) };
    dbg_assert!(
        size & (1 << 12 << 6) == 0,
        "size not aligned to dirty_bitmap"
    );
    unsafe {
        vga_mem8 = ptr;
        vga_memory_size = size;
        vga::set_dirty_bitmap_size(size >> 12 >> 6);
    };
    ptr as u32
}

#[no_mangle]
pub fn in_mapped_range(addr: u32) -> bool {
    return addr >= 0xA0000 && addr < 0xC0000 || addr >= unsafe { *memory_size };
}

pub const VGA_LFB_ADDRESS: u32 = 0xE0000000;
pub fn in_svga_lfb(addr: u32) -> bool {
    addr >= VGA_LFB_ADDRESS && addr <= unsafe { VGA_LFB_ADDRESS + (vga_memory_size - 1) }
}

#[no_mangle]
pub fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as i32 }
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32((addr - APIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32((addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else {
            unsafe { ext::mmap_read8(addr) }
        }
    }
    else {
        read8_no_mmap_check(addr)
    }
}
pub fn read8_no_mmap_check(addr: u32) -> i32 { unsafe { *mem8.offset(addr as isize) as i32 } }

#[no_mangle]
pub fn read16(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const u16)
                    as i32
            }
        }
        else {
            read8(addr) | read8(addr + 1) << 8
        }
    }
    else {
        read16_no_mmap_check(addr)
    }
}
pub fn read16_no_mmap_check(addr: u32) -> i32 {
    unsafe { ptr::read_unaligned(mem8.offset(addr as isize) as *const u16) as i32 }
}

#[no_mangle]
pub fn read32s(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i32)
            } // XXX
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32(addr - APIC_MEM_ADDRESS) as i32
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32(addr - IOAPIC_MEM_ADDRESS) as i32
        }
        else {
            unsafe { ext::mmap_read32(addr) }
        }
    }
    else {
        read32_no_mmap_check(addr)
    }
}
pub fn read32_no_mmap_check(addr: u32) -> i32 {
    unsafe { ptr::read_unaligned(mem8.offset(addr as isize) as *const i32) }
}

pub unsafe fn read64s(addr: u32) -> i64 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i64)
        }
        else {
            read32s(addr) as i64 | (read32s(addr + 4) as i64) << 32
        }
    }
    else {
        ptr::read_unaligned(mem8.offset(addr as isize) as *const i64)
    }
}

pub unsafe fn read128(addr: u32) -> reg128 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const reg128)
        }
        else {
            reg128 {
                i32: [
                    read32s(addr + 0),
                    read32s(addr + 4),
                    read32s(addr + 8),
                    read32s(addr + 12),
                ],
            }
        }
    }
    else {
        ptr::read_unaligned(mem8.offset(addr as isize) as *const reg128)
    }
}

#[no_mangle]
pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value & 0xFF);
    }
    else {
        jit::jit_dirty_range(addr, 1);
        write8_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *mem8.offset(addr as isize) = value as u8
}

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        jit::jit_dirty_range(addr, 2);
        write16_no_mmap_or_dirty_check(addr, value);
    };
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u16, value as u16)
}

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        jit::jit_dirty_range(addr, 4);
        write32_no_mmap_or_dirty_check(addr, value);
    }
}

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut i32, value)
}

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u32, value: u64) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u64, value)
}

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u32, value: reg128) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut reg128, value)
}

pub unsafe fn memset_no_mmap_or_dirty_check(addr: u32, value: u8, count: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize);
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(dst_addr < *memory_size);
    ptr::copy(
        mem8.offset(src_addr as isize),
        mem8.offset(dst_addr as isize),
        count as usize,
    )
}

pub unsafe fn memcpy_into_svga_lfb(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(in_svga_lfb(dst_addr));
    dbg_assert!(Page::page_of(dst_addr) == Page::page_of(dst_addr + count - 1));
    vga::mark_dirty(dst_addr);
    ptr::copy_nonoverlapping(
        mem8.offset(src_addr as isize),
        vga_mem8.offset((dst_addr - VGA_LFB_ADDRESS) as isize),
        count as usize,
    )
}

// responsive-wfw311: fast path for the paravirtual adapter's 256-colour planar ("unchained")
// A000 window, the mode the PVDISP.DRV display driver draws in. vga.js mirrors the relevant VGA
// state here (pv_planar_set) whenever it changes, and only for the common case: write mode 0, no
// rotate, ALU copy, set/reset off, bit mask 0xFF, with or without the V7 fore-latch fill. Then a
// CPU byte write to the window becomes four plane-byte stores done here instead of a call into
// JS (vga_memory_write -> planar_write_at), which cost a wasm->JS transition per pixel group.
// Everything else (other write modes, reads, the hypervisor's text-store accesses) still goes to
// JS, whose emulation stays the reference.
//
// pv_planar_enabled says which addressing the window is in:
//   0  nothing to do here, hand every write to JS
//   1  unchained (chain-4 off): CPU address A is plane address A in all four planes, so it covers
//      four pixels at 4*A within the 256K bank
//   2  chain-4 with the V7 foreground latches on: CPU address A is pixel A within the 64K bank,
//      the low two address bits pick which latch byte lands and which map-mask bit gates it, and
//      the CPU's own data is ignored
//   3  chain-4 with the latches off: CPU address A is pixel A within the 64K bank and the CPU byte
//      is the pixel, nothing else applies. This is what the driver's colour output routines
//      (ppsd_color, color_opaque_output_386, blt_dst_nibbles) write through, and it was every
//      remaining JS A000 write once the screen-to-screen copies moved to the adapter's blit.
#[allow(non_upper_case_globals)]
static mut pv_planar_enabled: u32 = 0;
#[allow(non_upper_case_globals)]
static mut pv_planar_bank: u32 = 0;
#[allow(non_upper_case_globals)]
static mut pv_planar_mask: u32 = 0xF;
#[allow(non_upper_case_globals)]
static mut pv_planar_fore: u32 = 0;
#[allow(non_upper_case_globals)]
static mut pv_planar_fore_dword: u32 = 0;
#[allow(non_upper_case_globals)]
static mut pv_planar_count: u32 = 0;

#[no_mangle]
pub fn pv_planar_set(enabled: u32, bank_offset: u32, mask: u32, fore: u32, fore_dword: u32) {
    unsafe {
        pv_planar_enabled = enabled;
        // unchained ignores the 64K page bits of the bank (as on the V7 chips the driver targets);
        // chain-4 addresses pixels straight through the 64K window, so it needs the whole offset
        pv_planar_bank =
            if enabled == 2 || enabled == 3 { bank_offset } else { bank_offset & !0x3FFFF };
        pv_planar_mask = mask & 0xF;
        pv_planar_fore = fore;
        pv_planar_fore_dword = fore_dword;
    }
}

/// number of A000 byte writes taken by the fast path (profiling)
#[no_mangle]
pub fn pv_planar_stat() -> u32 { unsafe { pv_planar_count } }

#[inline]
unsafe fn pv_planar_fast(addr: u32) -> bool {
    pv_planar_enabled != 0
        && addr >= 0xA0000
        && addr < 0xC0000
        // the same test as vga.js pv_hypervisor_access: ring 0 or V86 mode with paging on is
        // WIN386's VDD or a DOS VM, whose accesses go to the text store in JS
        && !(*protected_mode
            && (*cr & 0x80000000u32 as i32) != 0
            && (*cpl == 0 || (*flags & FLAG_VM) != 0))
}

#[inline]
unsafe fn pv_planar_write(off: u32, value: i32) {
    if pv_planar_enabled >= 2 {
        // chain-4: one pixel per CPU byte in the 64K bank. With the V7 fore latches on the pixel
        // comes from the latch byte for this address's plane, gated by that plane's map-mask bit;
        // with them off the CPU byte is the pixel and nothing gates it.
        let base = pv_planar_bank | off;
        if base >= vga_memory_size {
            return;
        }
        let byte = if pv_planar_enabled == 2 {
            let plane = off & 3;
            if pv_planar_mask & 1 << plane == 0 {
                return;
            }
            (pv_planar_fore_dword >> plane * 8) as u8
        }
        else {
            value as u8
        };
        pv_planar_count += 1;
        *vga_mem8.offset(base as isize) = byte;
        vga::mark_dirty(VGA_LFB_ADDRESS + base);
        return;
    }
    let base = pv_planar_bank + off * 4;
    if base + 3 >= vga_memory_size {
        return;
    }
    pv_planar_count += 1;
    let dword = if pv_planar_fore != 0 {
        pv_planar_fore_dword
    }
    else {
        let v = (value & 0xFF) as u32;
        v | v << 8 | v << 16 | v << 24
    };
    let p = vga_mem8.offset(base as isize);
    let mask = pv_planar_mask;
    if mask & 1 != 0 {
        *p = dword as u8;
    }
    if mask & 2 != 0 {
        *p.offset(1) = (dword >> 8) as u8;
    }
    if mask & 4 != 0 {
        *p.offset(2) = (dword >> 16) as u8;
    }
    if mask & 8 != 0 {
        *p.offset(3) = (dword >> 24) as u8;
    }
    vga::mark_dirty(VGA_LFB_ADDRESS + base);
}

pub unsafe fn mmap_write8(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) = value as u8
    }
    else if pv_planar_fast(addr) {
        pv_planar_write(addr - 0xA0000, value)
    }
    else {
        ext::mmap_write8(addr, value)
    }
}
pub unsafe fn mmap_write16(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u16,
            value as u16,
        )
    }
    else if pv_planar_fast(addr) {
        // the window is byte-addressed pixel groups; a word write is two byte writes (cpu.js
        // mmap_write16 splits the same way)
        pv_planar_write(addr - 0xA0000, value & 0xFF);
        pv_planar_write(addr + 1 - 0xA0000, value >> 8 & 0xFF)
    }
    else {
        ext::mmap_write16(addr, value)
    }
}
pub unsafe fn mmap_write32(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut i32,
            value,
        )
    }
    else if pv_planar_fast(addr) {
        for i in 0..4 {
            pv_planar_write(addr + i - 0xA0000, value >> (8 * i) & 0xFF);
        }
    }
    else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
        apic::write32(addr - APIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
        ioapic::write32(addr - IOAPIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else {
        ext::mmap_write32(addr, value)
    }
}
pub unsafe fn mmap_write64(addr: u32, value: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            value,
        )
    }
    else {
        ext::mmap_write64(addr, value as i32, (value >> 32) as i32)
    }
}
pub unsafe fn mmap_write128(addr: u32, v0: u64, v1: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            v0,
        );
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS + 8) as isize) as *mut u64,
            v1,
        )
    }
    else {
        ext::mmap_write128(
            addr,
            v0 as i32,
            (v0 >> 32) as i32,
            v1 as i32,
            (v1 >> 32) as i32,
        )
    }
}

#[no_mangle]
pub unsafe fn is_memory_zeroed(addr: u32, length: u32) -> bool {
    dbg_assert!(addr % 8 == 0);
    dbg_assert!(length % 8 == 0);
    for i in (addr..addr + length).step_by(8) {
        if *(mem8.offset(i as isize) as *const i64) != 0 {
            return false;
        }
    }
    return true;
}
