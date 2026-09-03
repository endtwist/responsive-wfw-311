; PVBLT.INC -- responsive-wfw311 screen-to-screen blits done by the adapter.
;
; Windows moves, resizes, raises and above all *scrolls* by blitting a rectangle
; of the frame buffer onto another part of itself and then repainting only the
; strip that uncovered. Through the banked A000 window this driver does that with
; VGA write mode 1 (latch copy): one CPU read plus one CPU write per four pixels,
; three map-mask port writes per scanline, and a bank-register write whenever
; either rectangle crosses a 64K boundary. On the emulator every one of those
; A000 accesses is a call out of the JIT into JS: a three-line Notepad scroll was
; 2.1 million of them and about a second of work.
;
; The paravirtual adapter can do the copy itself. Six DISPI registers hold the
; rectangle in pixels and a seventh executes it:
;
;       20h  SRC_X   21h  SRC_Y
;       22h  DST_X   23h  DST_Y
;       24h  WIDTH   25h  HEIGHT
;       26h  CTRL    write bit 0: copy now.  read bit 0: supported
;
; Each is written with one 32-bit OUT to the index port (index in the low word,
; data in the high word), the atomic form described in BANK.INC, so nothing has
; to be protected against MoveCursor at interrupt time and the index register is
; left alone. Seven port writes replace the whole latch loop, and no bank is
; switched: the adapter addresses the frame buffer the same way the banked path
; does, pixel (x,y) at byte y*pitch + x.
;
; The capability is read from CTRL by pv_blt_probe (VGA.ASM) at set_board_flags
; and at every setmode, and kept as BOARD_FLAG_PV_BLT in Video_Board_Flags next
; to the other "what can this board do" bits -- which BitBlt already copies to
; its stack frame as local_board_flags, so the dispatch test costs nothing and
; does not need DS to be the data segment (by dispatch time it is not). Clearing
; the capability on the host side (vga.pv_blt_disabled) puts the driver back on
; the banked latch path for A/B measurement without rebuilding anything.
;
; Included for its equates by BBLT.ASM (which calls pv_blt_scr2scr) and with
; PVBLT_IMPL defined by VGASTATE.ASM, which carries pv_dispi_out.

PV_BLT_SRC_X    equ     020h
PV_BLT_SRC_Y    equ     021h
PV_BLT_DST_X    equ     022h
PV_BLT_DST_Y    equ     023h
PV_BLT_WIDTH    equ     024h
PV_BLT_HEIGHT   equ     025h
PV_BLT_CTRL     equ     026h

IFDEF PVBLT_IMPL

        public  pv_dispi_out

sBegin  Code
        assumes cs,Code

;--- pv_dispi_out: one atomic DISPI register write. CX = index, AX = data.
;    Preserves every register (including the high half of EAX, which the
;    32-bit OUT sequence borrows). Needs no data segment.
pv_dispi_out proc near
        push    dx
        db      66h
        push    ax                      ;push eax
        push    ax                      ;data: high word of the eax we build
        push    cx                      ;index: low word
        db      66h
        pop     ax                      ;pop eax  -> index | data << 16
        mov     dx,PV_DISPI_INDEX
        db      66h
        out     dx,ax                   ;out dx,eax
        db      66h
        pop     ax                      ;pop eax  -> the caller's eax
        pop     dx
        ret
pv_dispi_out endp
sEnd    Code

ENDIF
