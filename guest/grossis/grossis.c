/* GROSSIS.EXE - the way out, as a native Win16 program.
 *
 * Program Manager's own Exit Windows item puts up a dialog and, if you say yes, ends the session.
 * This is the same gesture pointed somewhere else: the machine this is running inside is a page on
 * a website, and leaving it means leaving for the site it belongs to. So the box says the thing
 * Windows would say, and OK takes the browser to gross.is.
 *
 * There is no window: a message box with no owner is the whole program, which is what a Windows
 * 3.1 confirmation is. OK sends one line on the adapter's debug channel and exits; the host reads
 * it with the rest of the protocol and navigates. The URL is not in the line -- the host knows
 * where its own front door is, and a guest that could name any address would be a guest that could
 * take a visitor anywhere.
 *
 * Build: guest/grossis/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <conio.h>

#define R_INDEX 0x1CE
#define R_DATA  0x1CF
#define R_DEBUG 0x16

static void dbg(const char *s)
{
    while (*s) { outpw(R_INDEX, R_DEBUG); outpw(R_DATA, (unsigned char)*s++); }
    outpw(R_INDEX, R_DEBUG);
    outpw(R_DATA, 10);
}

int PASCAL WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    /* No icon and no beep: Program Manager's Exit Windows box has neither. MB_TASKMODAL because
       this program has no window of its own to own the box. */
    if (MessageBox(NULL, "You will now exit Windows.", "Exit Windows",
                   MB_OKCANCEL | MB_TASKMODAL) == IDOK)
        dbg("PVEXIT");
    return 0;
}
