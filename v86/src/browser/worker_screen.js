/* The screen adapter used when the emulator runs in a worker (SPEC 2026-09-03).
 *
 * v86's own ScreenAdapter needs the DOM: it owns a canvas and calls putImageData on it. In a
 * worker there is no DOM and, more to the point, the page must not be handed a canvas it has to
 * read back. This adapter converts the guest frame buffer into whatever the page can consume
 * fastest (a SharedArrayBuffer, else transferred ImageBitmaps -- see worker_proto.js) and does it
 * on the worker thread, so the compositor's only per-frame cost is a putImageData of the rows
 * that changed.
 *
 * Text mode is kept as data only (get_text_row / get_text_screen for the harnesses). The page
 * has never shown v86's DOM text rendering -- it composites guest pixels -- so nothing is lost.
 */
import { get_charmap } from "../lib.js";
import { CTL, CTL_BYTES, rect_lock, rect_unlock } from "./worker_proto.js";

/**
 * @constructor
 * @param {Object} options
 *   options.shared      use a SharedArrayBuffer for the pixels
 *   options.post        (msg, transfer) -> void, to the page
 */
export function WorkerScreenAdapter(options)
{
    const post = options.post;
    const use_shared = !!options.shared;

    let charmap = get_charmap(options && options.encoding);
    let text_mode_data = new Uint8Array(80 * 25);
    let text_mode_width = 80, text_mode_height = 25;
    let cursor_row = 0, cursor_col = 0;
    let is_graphical = false;

    let width = 0, height = 0;              // graphical mode size (the pixel buffer size)
    let generation = 0;
    let paused = false;

    /** @type {SharedArrayBuffer|ArrayBuffer} */
    let sab = null;
    /** @type {Int32Array} */
    let ctl = null;
    /** @type {Uint8Array} */
    let pixels = null;                      // RGBA, pitch === width, only on the shared path

    // "bitmap" path scratch: one OffscreenCanvas the size of the largest region so far.
    let scratch = null, scratch_ctx = null, scratch_w = 0, scratch_h = 0;
    let scratch_data = null;                // Uint8ClampedArray for the compacted region

    let changes = 0;
    let dirty_x0 = 0, dirty_y0 = 0, dirty_x1 = 0, dirty_y1 = 0;   // bitmap path accumulator

    this.ctl = () => ctl;

    function allocate()
    {
        generation++;
        if(use_shared)
        {
            const bytes = CTL_BYTES + width * height * 4;
            sab = new SharedArrayBuffer(bytes);
            ctl = new Int32Array(sab, 0, CTL.LEN);
            pixels = new Uint8Array(sab, CTL_BYTES);
            Atomics.store(ctl, CTL.W, width);
            Atomics.store(ctl, CTL.H, height);
            Atomics.store(ctl, CTL.GEN, generation);
            Atomics.store(ctl, CTL.X0, 0); Atomics.store(ctl, CTL.Y0, 0);
            Atomics.store(ctl, CTL.X1, 0); Atomics.store(ctl, CTL.Y1, 0);
            post({ t: "screen", path: "shared", sab, w: width, h: height, gen: generation });
        }
        else
        {
            post({ t: "screen", path: "bitmap", w: width, h: height, gen: generation });
        }
    }

    /** Copy one layer's rectangle out of the guest's RGBA buffer.
     *  A layer is {image_data (pitch image_data.width), screen_x/y, buffer_x/y/width/height};
     *  the destination rectangle is (screen_x, screen_y, buffer_width, buffer_height). */
    function region(layer)
    {
        let sx = layer.buffer_x | 0, sy = layer.buffer_y | 0;
        let w = layer.buffer_width | 0, h = layer.buffer_height | 0;
        let dx = layer.screen_x | 0, dy = layer.screen_y | 0;
        // clip to the destination
        if(dx < 0) { sx -= dx; w += dx; dx = 0; }
        if(dy < 0) { sy -= dy; h += dy; dy = 0; }
        if(dx + w > width) w = width - dx;
        if(dy + h > height) h = height - dy;
        const src_pitch = layer.image_data.width;
        const src_h = layer.image_data.height;
        if(sx + w > src_pitch) w = src_pitch - sx;
        if(sy + h > src_h) h = src_h - sy;
        if(w <= 0 || h <= 0) return null;
        return { sx, sy, w, h, dx, dy, src: layer.image_data.data, src_pitch };
    }

    function copy_into_shared(r)
    {
        const { sx, sy, w, h, dx, dy, src, src_pitch } = r;
        const bytes = w * 4;
        for(let y = 0; y < h; y++)
        {
            const so = ((sy + y) * src_pitch + sx) * 4;
            const dof = ((dy + y) * width + dx) * 4;
            pixels.set(src.subarray(so, so + bytes), dof);
        }
    }

    function ensure_scratch(w, h)
    {
        if(!scratch || w > scratch_w || h > scratch_h)
        {
            scratch_w = Math.max(w, scratch_w, 64);
            scratch_h = Math.max(h, scratch_h, 8);
            scratch = new OffscreenCanvas(scratch_w, scratch_h);
            scratch_ctx = scratch.getContext("2d", { alpha: false, willReadFrequently: false });
        }
        const need = w * h * 4;
        if(!scratch_data || scratch_data.length < need) scratch_data = new Uint8ClampedArray(Math.max(need, 4096));
    }

    /* An ImageBitmap is drawn by the page with drawImage (a texture upload, no CPU pixel work on
       the main thread). Where OffscreenCanvas is missing, the same rows go over as a transferred
       ArrayBuffer and the page does the putImageData itself. */
    const can_bitmap = typeof OffscreenCanvas === "function" &&
        typeof OffscreenCanvas.prototype.transferToImageBitmap === "function";

    function post_bitmap(r)
    {
        const { sx, sy, w, h, dx, dy, src, src_pitch } = r;
        const bytes = w * 4;
        if(!can_bitmap)
        {
            const buf = new Uint8ClampedArray(w * h * 4);
            for(let y = 0; y < h; y++)
            {
                const so = ((sy + y) * src_pitch + sx) * 4;
                buf.set(src.subarray(so, so + bytes), y * bytes);
            }
            post({ t: "frame", path: "buffer", gen: generation, x: dx, y: dy, w, h, buf: buf.buffer, changes: ++changes }, [buf.buffer]);
            return;
        }
        ensure_scratch(w, h);
        for(let y = 0; y < h; y++)
        {
            const so = ((sy + y) * src_pitch + sx) * 4;
            scratch_data.set(src.subarray(so, so + bytes), y * bytes);
        }
        // The canvas is at least as large as the region; the bitmap carries the whole canvas, so
        // the page crops it to w x h when it draws.
        const img = new ImageData(scratch_data.subarray(0, w * h * 4), w, h);
        scratch_ctx.putImageData(img, 0, 0);
        const bmp = scratch.transferToImageBitmap();
        post({ t: "frame", path: "bitmap", gen: generation, x: dx, y: dy, w, h, bmp, changes: ++changes }, [bmp]);
    }

    this.update_buffer = function(layers)
    {
        if(!width || !height || paused) return;
        if(use_shared && !pixels) return;

        let any = false;
        let x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
        for(const layer of layers)
        {
            const r = region(layer);
            if(!r) continue;
            any = true;
            if(use_shared)
            {
                copy_into_shared(r);
                if(r.dx < x0) x0 = r.dx;
                if(r.dy < y0) y0 = r.dy;
                if(r.dx + r.w > x1) x1 = r.dx + r.w;
                if(r.dy + r.h > y1) y1 = r.dy + r.h;
            }
            else
            {
                post_bitmap(r);
            }
        }
        if(!any) return;
        if(use_shared)
        {
            changes++;
            rect_lock(ctl);
            const cx0 = ctl[CTL.X0], cy0 = ctl[CTL.Y0], cx1 = ctl[CTL.X1], cy1 = ctl[CTL.Y1];
            if(cx0 < cx1)                    // union with what the page has not consumed yet
            {
                ctl[CTL.X0] = Math.min(cx0, x0); ctl[CTL.Y0] = Math.min(cy0, y0);
                ctl[CTL.X1] = Math.max(cx1, x1); ctl[CTL.Y1] = Math.max(cy1, y1);
            }
            else
            {
                ctl[CTL.X0] = x0; ctl[CTL.Y0] = y0; ctl[CTL.X1] = x1; ctl[CTL.Y1] = y1;
            }
            ctl[CTL.CHANGES] = changes;
            rect_unlock(ctl);
            Atomics.add(ctl, CTL.SEQ, 1);    // release: the pixels above are visible to the page
        }
    };

    this.set_size_graphical = function(w, h)
    {
        if(w === width && h === height) return;
        width = w; height = h;
        if(!(width > 0 && height > 0)) return;
        allocate();
    };

    this.set_mode = function(graphical) { is_graphical = graphical; };
    this.set_scale = function() {};
    this.set_font_bitmap = function() {};
    this.set_font_page = function() {};
    this.clear_screen = function() {};
    this.update_cursor_scanline = function() {};
    this.update_cursor = function(row, col) { cursor_row = row; cursor_col = col; };
    this.destroy = function() {};
    this.pause = function() { paused = true; };
    this.continue = function() { paused = false; };
    this.make_screenshot = function() { return null; };

    this.clear_text_state = function() { text_mode_width = null; text_mode_height = null; };

    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height) return;
        text_mode_data = new Uint8Array(cols * rows);
        text_mode_width = cols; text_mode_height = rows;
    };

    this.put_char = function(row, col, chr, blinking, bg_color, fg_color)
    {
        if(row >= 0 && row < text_mode_height && col >= 0 && col < text_mode_width)
        {
            text_mode_data[row * text_mode_width + col] = chr;
        }
    };

    this.get_text_row = function(y)
    {
        const begin = y * text_mode_width;
        return Array.from(text_mode_data.subarray(begin, begin + text_mode_width), chr => charmap[chr]).join("");
    };
    this.get_text_screen = function()
    {
        const screen = [];
        for(let i = 0; i < text_mode_height; i++) screen.push(this.get_text_row(i));
        return screen;
    };
}
