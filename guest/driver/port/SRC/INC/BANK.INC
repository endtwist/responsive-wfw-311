; BANK.INC -- responsive-wfw311 paravirtual adapter bank selection.
;
; The V7 model this driver was written for has one shared 64K "page" (2 bits)
; plus separate 256K bank selects for reads (src) and writes (dst). We keep
; that model in three shadow bytes and program the adapter's READ_BANK (0x18)
; and WRITE_BANK (0x19) registers, both in 64K units:
;     read bank  = pv_src_bank*4 + pv_page
;     write bank = pv_dst_bank*4 + pv_page
.286
        public  bank_select
        public  set_bank
        public  set_bank_select
        public  far_set_bank_select
        public  pv_apply_banks
        public  pv_page, pv_src_bank, pv_dst_bank

PV_DISPI_INDEX  equ     01CEh
PV_DISPI_DATA   equ     01CFh
PV_REG_READ_BANK  equ   018h
PV_REG_WRITE_BANK equ   019h

sBegin  Data
	public bank_select_byte
bank_select_byte label byte
bank_select         db      0FFh        ;last 64K bank set through set_bank*
pv_page             db      0           ;shared 64K page within 256K (0..3)
pv_src_bank         db      0           ;256K bank for reads
pv_dst_bank         db      0           ;256K bank for writes
sEnd    Data

sBegin  Code
	assumes cs,Code

;--- pv_apply_banks: program the adapter from the shadows. Preserves everything.
pv_apply_banks proc near
        push    ds
        push    ax
        push    dx
        mov     ax,DGROUP
        mov     ds,ax
        mov     dx,PV_DISPI_INDEX
        mov     ax,PV_REG_READ_BANK
        out     dx,ax
        inc     dx
        mov     al,ds:[pv_src_bank]
        shl     al,2
        or      al,ds:[pv_page]
        xor     ah,ah
        out     dx,ax
        dec     dx
        mov     ax,PV_REG_WRITE_BANK
        out     dx,ax
        inc     dx
        mov     al,ds:[pv_dst_bank]
        shl     al,2
        or      al,ds:[pv_page]
        xor     ah,ah
        out     dx,ax
        pop     dx
        pop     ax
        pop     ds
        ret
pv_apply_banks endp

;--- set both read and write banks to the 64K bank in DL. Preserves everything.
far_set_bank_select proc far
        call    set_bank_select
        ret
far_set_bank_select endp

set_bank_select proc    near
        push    ds
	push	ax
	mov	ax,DGROUP
	mov	ds,ax
        mov     ds:[bank_select],dl
        mov     al,dl
        and     al,3
        mov     ds:[pv_page],al
        mov     al,dl
        shr     al,2
        mov     ds:[pv_src_bank],al
        mov     ds:[pv_dst_bank],al
        call    pv_apply_banks
	pop	ax
	pop	ds
        ret
set_bank_select endp

set_bank proc    near
        call    set_bank_select
        ret
set_bank endp
sEnd Code
