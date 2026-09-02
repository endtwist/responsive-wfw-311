/* PVDPI.EXE - pick the SYSTEM.INI variant matching the host's DPI, before WIN runs.
 *
 * PVDISP.DRV reports the host's HOST_DPI register in GDIINFO, but the system font files
 * come from SYSTEM.INI. If those disagree, GDI measures text with one font and draws with
 * another and labels overlap. Windows 3.x has no mid-session DPI change, so the choice is
 * made here, once per Windows start: copy SYSTEM.96 or SYSTEM.120 over SYSTEM.INI.
 * AUTOEXEC.BAT runs this immediately before each WIN (see image/build-image.sh).
 *
 * Build: guest/pvdpi/build.sh
 */
#include <conio.h>
#include <stdio.h>
#include <string.h>

#define DISPI_INDEX 0x1CE
#define DISPI_DATA  0x1CF
#define R_HOST_DPI  0x12
#define R_DEBUG     0x16

static unsigned rd(unsigned idx) { outpw(DISPI_INDEX, idx); return inpw(DISPI_DATA); }

static int copy_file(const char *src, const char *dst)
{
    FILE *in, *out; size_t n;
    static char buf[4096];   /* off the stack: a 4 KB auto buffer overran the small-model stack and truncated the copied file tail */
    in = fopen(src, "rb");
    if (!in) return 0;
    out = fopen(dst, "wb");
    if (!out) { fclose(in); return 0; }
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0)
        if (fwrite(buf, 1, n, out) != n) { fclose(in); fclose(out); return 0; }
    fclose(in); fclose(out);
    return 1;
}

int main(void)
{
    unsigned dpi;
    const char *src;
    if (rd(R_DEBUG) != 0x5056) return 0;         /* not the paravirtual adapter: leave alone */
    dpi = rd(R_HOST_DPI);
    src = (dpi == 120) ? "C:\\WINDOWS\\SYSTEM.120" : "C:\\WINDOWS\\SYSTEM.96";
    if (copy_file(src, "C:\\WINDOWS\\SYSTEM.INI"))
        printf("PVDPI: %u dpi\n", dpi);
    else
        printf("PVDPI: %s missing, keeping SYSTEM.INI\n", src);
    return 0;
}
