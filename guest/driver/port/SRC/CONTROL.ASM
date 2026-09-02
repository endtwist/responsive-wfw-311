	page	,132
;-----------------------------Module-Header-----------------------------;
; Module Name:	CONTROL.ASM
;
; This module contains the escape handler for the color display
; drivers.
;
; It also contains stubs for the SetAttribute function and the
; DeviceBitmap function, both of which this driver does not
; support.
;
; Created: 16-Feb-1987
; Author:  Walt Moore [waltm]
;
; Copyright (c) 1983-1987 Microsoft Corporation
;
; Exported Functions:	Control
;
; Public Functions:	none
;
; Public Data:		none
;
; General Description:
;
;   Control is the routine which is called when an Escape call
;   is made to GDI.  This driver only implements two of the
;   escape functions.  These functions set and get the color
;   table.  Since the color table is not setable for the display,
;   the current value is just returned.
;
;   Support for QUERYESCSUPPORT has now been added.  This escape
;   function is required of all drivers.  It informs the caller
;   which escape functions are supported (QUERYESCSUPPORT will
;   return TRUE for QUERYESCSUPPORT!).
;
; Restrictions:
;
;-----------------------------------------------------------------------;

incControl	=	1		;Include control for gdidefs.inc
	.xlist
	include cmacros.inc
	include gdidefs.inc
	include macros.mac
	.list

sBegin	Data
	EXTRN	adPalette:BYTE
; responsive-wfw311: state the live re-mode escape updates
	EXTRN	VScreen_Width:WORD
	EXTRN	VScreen_Height:WORD
	EXTRN	cursor_xdraw:WORD
	EXTRN	cursor_ydraw:WORD
sEnd    Data

	??_out	Control

EXTRN	setramdac:FAR

createSeg _BLUEMOON,BlueMoonSeg,word,public,CODE
sBegin	BlueMoonSeg
assumes cs,BlueMoonSeg

page
;--------------------------Exported-Routine-----------------------------;
; Control
;
;   Control is defined so that device specific commands can be issued
;   that are not supported by GDI.  Some of the Control functions have
;   been defined by GDI so that devices that can perform them (and need
;   to) can do so, such as clear device.
;
;   Clear device will not be allowed.  Nobody should do that to the
;   system console!
;
;   Set/Get color table will not be implented for windows 3.0.
;
; Entry:
;	None
; Returns:
;	AX = 1 if success
; Error Returns:
;	AX = 0 if error
; Registers Preserved:
;	SI,DI,DS,BP
; Registers Destroyed:
;	AX,BX,CX,DX,FLAGS
; Calls:
;	None
; History:
;	Sat 22-April-1989 -by- David Miller [o-davem]
;	Removed color table support for Windows 3.0
;
;	Sun 27-Sep-1987 21:35:42 -by-  Walt Moore [waltm]
;	Added QUERYESCSUPPORT, which is the one required
;	escape function all drivers must support.
;
;	When queried if we support SETCOLORTABLE, we'll
;	return false.  The code will continue to return
;	current color table index if we get the SETCOLORTABLE
;	call.
;
;	Wed 12-Aug-1987 17:29:30 -by-  Walt Moore [waltm]
;	made non-resident
;
;	Wed 18-Mar-1987 14:04:30 -by-  Walt Moore [waltm]
;	Added COLOR_TBL_SIZE so the code can be shared
;	between black/white and color drivers.
;
;	Mon 16-Feb-1987 18:09:09 -by-  Walt Moore [waltm]
;	Created.
;-----------------------------------------------------------------------;


;------------------------------Pseudo-Code------------------------------;
; {
; }
;-----------------------------------------------------------------------;


COLOR_TBL_SIZE	equ	100H

; responsive-wfw311 private escapes (SPEC 2.2). Numbers are private to this driver and
; must stay positive: Escape()'s nEscape is a signed int in Win16.
PV_QUERY_MODE	equ	4A00h		;out: cur w,h, host w,h, dpi, generation (6 words)
PV_REMODE	equ	4A01h		;re-mode the adapter to the host's request, live
PV_SETMODE	equ	4A02h		;in: two words, an explicit size the guest wants

PV_DISPI_INDEX	equ	01CEh
PV_DISPI_DATA	equ	01CFh
PV_R_XRES	equ	1
PV_R_YRES	equ	2
PV_R_BPP	equ	3
PV_R_ENABLE	equ	4
PV_R_VIRT_W	equ	6
PV_R_XOFF	equ	8
PV_R_YOFF	equ	9
PV_R_HOST_XRES	equ	010h
PV_R_HOST_YRES	equ	011h
PV_R_HOST_DPI	equ	012h
PV_R_DEBUG	equ	016h
PV_R_GEN	equ	017h
PV_PITCH	equ	4096		;must match MEMORY_WIDTH in cursor.inc
PV_ENABLE_KEEP	equ	00C1h		;enabled + LFB + bit7: keep video memory contents


assumes ds,Data
assumes es,nothing


cProc   Control,<FAR,PUBLIC,WIN,PASCAL>,<si,di,ds>

	parmD	lp_device
	parmW	function
	parmD	lp_in_data
	parmD	lp_out_data

cBegin
WriteAux <'Ctrl'>
	xor	ax,ax			;Assume error

; responsive-wfw311: private escapes first. SI/DI are saved by the cProc prologue.
	mov	si,function
	cmp	si,PV_QUERY_MODE
	je	pv_do_query
	cmp	si,PV_REMODE
	je	pv_do_remode
	cmp	si,PV_SETMODE
	je	pv_do_setmode
	jmp	short pv_not_ours

pv_do_query:
	les	di,lp_out_data
	mov	ax,VScreen_Width
	stosw
	mov	ax,VScreen_Height
	stosw
	mov	dx,PV_DISPI_INDEX
	mov	ax,PV_R_HOST_XRES
	out	dx,ax
	inc	dx
	in	ax,dx
	stosw
	dec	dx
	mov	ax,PV_R_HOST_YRES
	out	dx,ax
	inc	dx
	in	ax,dx
	stosw
	dec	dx
	mov	ax,PV_R_HOST_DPI
	out	dx,ax
	inc	dx
	in	ax,dx
	stosw
	dec	dx
	mov	ax,PV_R_GEN
	out	dx,ax
	inc	dx
	in	ax,dx
	stosw
	mov	ax,1
	jmp	pv_escape_done

pv_do_remode:
	call	pv_remode		;ax = 1 if the mode changed
	jmp	pv_escape_done

pv_do_setmode:
	les	di,lp_in_data
	mov	bx,es:[di]		;width the guest is asking for
	mov	cx,es:[di + 2]		;height
	and	bx,not 7
	and	cx,not 1
	call	pv_apply_mode
	jmp	pv_escape_done

pv_not_ours:
	xor	ax,ax
	assumes ds,nothing
	mov	bx,function

        les     bx,lp_in_data           ;Get pointer to the data

	cmp	bx,GETCOLORTABLE
	je	get_color_table

        cmp     bx,QUERYESCSUPPORT
	jne	exit_control		;Is not set, get, query

        mov     bx,wptr es:[bx]         ;Get queried escape function number
	cmp	bx,QUERYESCSUPPORT
	je	exit_control_inc_ax
        cmp     bx,GETCOLORTABLE
	je	exit_control_inc_ax

        jmp     short exit_control      ;We don't support it

get_color_table:
        mov     si, es:[bx]             ;color table index
        cmp     si, 255
        ja      exit_control
                                        ; *4 (size RGBQUAD)
        shl     si, 2
        add     si, DataOFFSET adPalette; DS:SI --> RGBQUAD
        les     di, lp_out_data

	cld
        movsw                           ; Copy Red + Green
        movsb                           ; Copy Blue
        stosb                           ; Set reserved to zero

        errn$   exit_control_inc_ax     ; all done

exit_control_inc_ax:
	inc	ax			;Return 1 to show OK

exit_control:
pv_escape_done:

cEnd

;-----------------------------------------------------------------------;
; pv_program_adapter
;
;	Programs the paravirtual adapter for VScreen_Width x VScreen_Height at
;	8bpp with the scanline pitch fixed at PV_PITCH, keeping the contents of
;	video memory (bit 7 of ENABLE). Lives in this segment rather than InitSeg
;	because InitSeg is discarded once Windows is up.
;
;	Preserves all registers. DS must address DGROUP.
;-----------------------------------------------------------------------;

assumes ds,Data

pv_program_adapter	PROC	NEAR
	push	ax
	push	dx
	mov	dx,PV_DISPI_INDEX
	mov	ax,PV_R_ENABLE		;off while we reprogram
	out	dx,ax
	inc	dx
	xor	ax,ax
	out	dx,ax
	dec	dx
	mov	ax,PV_R_XRES
	out	dx,ax
	inc	dx
	mov	ax,VScreen_Width
	out	dx,ax
	dec	dx
	mov	ax,PV_R_YRES
	out	dx,ax
	inc	dx
	mov	ax,VScreen_Height
	out	dx,ax
	dec	dx
	mov	ax,PV_R_BPP
	out	dx,ax
	inc	dx
	mov	ax,8
	out	dx,ax
	dec	dx
	mov	ax,PV_R_VIRT_W		;pitch stays fixed across modes
	out	dx,ax
	inc	dx
	mov	ax,PV_PITCH
	out	dx,ax
	dec	dx
	mov	ax,PV_R_XOFF
	out	dx,ax
	inc	dx
	xor	ax,ax
	out	dx,ax
	dec	dx
	mov	ax,PV_R_YOFF
	out	dx,ax
	inc	dx
	xor	ax,ax
	out	dx,ax
	dec	dx
	mov	ax,PV_R_ENABLE
	out	dx,ax
	inc	dx
	mov	ax,PV_ENABLE_KEEP
	out	dx,ax
	pop	dx
	pop	ax
	ret
pv_program_adapter	ENDP

;-----------------------------------------------------------------------;
; pv_remode
;
;	Phase 3 step 3a: take the host's requested mode, program the adapter and
;	update the driver's own idea of the surface, including GDI's copy of the
;	screen BITMAP, which arrives as lp_device on every driver call.
;	GDI's cached device caps and USER's screen metrics are NOT touched here;
;	that is 3b/3c.
;
;	Returns AX = 1 if the mode changed, 0 otherwise.
;	Must be called with lp_device valid (it reads the caller's frame).
;-----------------------------------------------------------------------;

pv_remode	PROC	NEAR
	push	bx
	push	cx
	push	dx

	mov	dx,PV_DISPI_INDEX	;what does the host want?
	mov	ax,PV_R_HOST_XRES
	out	dx,ax
	inc	dx
	in	ax,dx
	and	ax,not 7		;widths are a multiple of 8
	mov	bx,ax
	dec	dx
	mov	ax,PV_R_HOST_YRES
	out	dx,ax
	inc	dx
	in	ax,dx
	and	ax,not 1
	mov	cx,ax
	call	pv_apply_mode
	pop	dx
	pop	cx
	pop	bx
	ret
pv_remode	ENDP

;-----------------------------------------------------------------------;
; pv_apply_mode
;
;	BX = width, CX = height. Programs the adapter and updates the driver's
;	state and GDI's copy of the screen BITMAP. Returns AX = 1 if it changed.
;
;	Split out from pv_remode so the guest can ask for a size of its own
;	through PV_SETMODE: the companion utility widens the screen while a
;	dialog too big for a phone-sized desktop is on screen, and puts it back
;	afterwards.
;-----------------------------------------------------------------------;

pv_apply_mode	PROC	NEAR
	push	bx
	push	cx
	push	dx
	push	es

	cmp	bx,320			;refuse anything the framebuffer cannot hold
	jb	pv_apply_no
	cmp	bx,PV_PITCH
	ja	pv_apply_no
	cmp	cx,200
	jb	pv_apply_no
	cmp	cx,1600
	ja	pv_apply_no
	cmp	bx,VScreen_Width	;already there?
	jne	pv_apply_go
	cmp	cx,VScreen_Height
	je	pv_apply_no

pv_apply_go:
	mov	VScreen_Width,bx
	mov	VScreen_Height,cx
	call	pv_program_adapter

;	GDI hands us its own copy of the screen BITMAP on every call, so the
;	pointer we were passed is the one the drawing code will keep using.
	les	di,lp_device
	mov	es:[di].bmWidth,bx
	mov	es:[di].bmHeight,cx
	mov	ax,es:[di].bmWidthBytes
	mul	cx			;dx:ax = bytes in the visible surface
	mov	word ptr es:[di].bmWidthPlanes,ax
	mov	word ptr es:[di + 2].bmWidthPlanes,dx

;	keep the cursor inside the new screen
	mov	ax,bx
	dec	ax
	cmp	cursor_xdraw,ax
	jbe	@F
	mov	cursor_xdraw,ax
@@:	mov	ax,cx
	dec	ax
	cmp	cursor_ydraw,ax
	jbe	@F
	mov	cursor_ydraw,ax
@@:
	mov	ax,1
	jmp	short pv_apply_done

pv_apply_no:
	xor	ax,ax
pv_apply_done:
	pop	es
	pop	dx
	pop	cx
	pop	bx
	ret
pv_apply_mode	ENDP

assumes ds,nothing

cProc DeviceBitmap,<FAR,PUBLIC,WIN,PASCAL> ; ,<si,di>

      parmD lpDevice
      parmW command
      parmD lpBitmap
      parmD lpBits

cBegin	<nogen>
WriteAux <'Ctrl:devbitmap'>
	xor	ax,ax
	ret	14

cEnd	<nogen>


cProc SetAttribute,<FAR,PUBLIC,WIN,PASCAL> ; ,<si,di>

      parmD  lpDevice
      parmW  stateNum
      parmW  index
      parmD  attribute

cBegin	<nogen>
WriteAux <'Ctrl:SetAttr'>
	xor	ax,ax
	ret	12

cEnd	<nogen>




sEnd	BlueMoonSeg

	ifdef	PUBDEFS
	public	exit_control
        endif

end
