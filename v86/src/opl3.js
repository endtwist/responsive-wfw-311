// OPL3 (Yamaha YMF262) / OPL2 (YM3812) FM synthesiser.
// =====================================================
//
// responsive-wfw311, 2026-09-03. Written from the public register/behaviour documentation; no
// third-party emulator source was copied, and the two ROM tables are computed at load time from
// their defining formulas rather than transcribed:
//
//   Yamaha YMF262 application manual  http://map.grauw.nl/resources/sound/yamaha_ymf262.pdf
//   OPL3 programming guide            http://www.fit.vutbr.cz/~arnost/opl/opl3.html
//
// v86's SB16 accepted the FM register writes at 0x220/0x228/0x388 and threw them away, so
// anything driven by Ad Lib FM (Windows' MSADLIB.DRV MIDI output, most DOS games) was silent.
// This is the synthesiser those writes now reach; sb16.js owns the port decode, the wall-clock
// pacing and the bus messages that carry the samples to the page.
//
// Numbers, so the arithmetic below is readable:
//   * sample rate 49716 Hz = 14.318 MHz / 288 (one output sample per 36-slot chip cycle).
//   * 36 operators ("slots") in two banks of 18; 18 two-operator channels, or fewer when
//     four-operator channels are enabled (OPL3 register 0x104).
//   * an operator's phase accumulator counts 2^19 steps per cycle; the top 10 bits index the
//     sine table, so the sine has 1024 points.
//   * attenuations are in 1/32 of 6 dB = 0.1875 dB units. The envelope is 9 bits (0..511, i.e.
//     0..96 dB); total level is 6 bits of 0.75 dB (so << 2 into envelope units); the log-sine
//     and exp tables work in eighths of an envelope unit (level = env << 3).

/** @const */
export var OPL_RATE = 49716;

// -log2(sin(x)) over the first quarter of a cycle, in 1/2048 of 6 dB (i.e. env units << 3).
const LOGSIN = new Uint16Array(256);
// 2^x over one octave, 1024..2047, read with the fractional part of the level and shifted down by
// the whole part: exp_out(0) = 4084, and every 256 levels (= 6 dB) halves it.
const EXP = new Uint16Array(256);
for(let i = 0; i < 256; i++)
{
    LOGSIN[i] = Math.round(-Math.log2(Math.sin((i + 0.5) * Math.PI / 512)) * 256);
    EXP[i] = Math.round(Math.pow(2, (255 - i) / 256) * 1024);
}

// Envelope step per sample, in envelope units, for the 6-bit effective rate (4 * the register's
// rate + the key-scale value). Derived from the hardware's rate doubling every four steps and
// calibrated against the YM3812 data sheet: rate 60 (DR=15, no key scaling) walks the full 96 dB
// in 511/8 = 64 samples = 1.28 ms (data sheet: 1.27 ms), rate 4 (DR=1) in 21.1 s (data sheet: 21 s).
const RATE_STEP = new Float64Array(64);
for(let r = 0; r < 64; r++) RATE_STEP[r] = Math.pow(2, (r - 48) / 4);

// Frequency multiplier, doubled so that MULT[0] = 1 stands for x0.5.
const MULT = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
// Key scale level: attenuation per octave, indexed by the top four bits of F-Number.
const KSL = new Uint8Array([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);
const KSL_SHIFT = new Uint8Array([8, 4, 2, 0]);   // register KSL 0 = none (>> 8 kills it), 3 = full

// Register offset (0x00..0x15, with the two three-slot gaps) -> slot index 0..17 within a bank.
const SLOT_OF_OFFSET = new Int8Array(0x20).fill(-1);
for(let g = 0; g < 3; g++) for(let i = 0; i < 6; i++) SLOT_OF_OFFSET[g * 8 + i] = g * 6 + i;
// First (modulator) slot of each two-operator channel; the second is that + 3.
const CH_SLOT = new Uint8Array([0, 1, 2, 6, 7, 8, 12, 13, 14]);

// Vibrato: an eight-step triangle, in units of F-Number >> 7 (deep) or >> 8 (shallow).
const VIB_PATTERN = new Int8Array([0, 1, 2, 1, 0, -1, -2, -1]);

// Envelope generator states.
const EG_OFF = 0, EG_ATTACK = 1, EG_DECAY = 2, EG_SUSTAIN = 3, EG_RELEASE = 4;

/**
 * @constructor
 */
export function OPL3()
{
    // Per-slot registers.
    this.s_am = new Uint8Array(36);
    this.s_vib = new Uint8Array(36);
    this.s_egt = new Uint8Array(36);        // 1 = sustaining, 0 = percussive
    this.s_ksr = new Uint8Array(36);
    this.s_mult = new Uint8Array(36);
    this.s_ksl = new Uint8Array(36);
    this.s_tl = new Uint8Array(36);
    this.s_ar = new Uint8Array(36);
    this.s_dr = new Uint8Array(36);
    this.s_sl = new Uint8Array(36);
    this.s_rr = new Uint8Array(36);
    this.s_ws = new Uint8Array(36);

    // Per-slot state.
    this.s_phase = new Float64Array(36);    // 0 .. 2^19, one cycle
    this.s_eg = new Float64Array(36);       // envelope attenuation, 0 (loud) .. 511 (silent)
    this.s_state = new Uint8Array(36);
    this.s_out = new Float64Array(36);      // last output, for feedback and modulation
    this.s_prout = new Float64Array(36);    // the one before that
    this.s_keyed = new Uint8Array(36);

    // Per-channel registers.
    this.c_fnum = new Uint16Array(18);
    this.c_block = new Uint8Array(18);
    this.c_kon = new Uint8Array(18);
    this.c_fb = new Uint8Array(18);
    this.c_cnt = new Uint8Array(18);
    this.c_left = new Uint8Array(18).fill(1);
    this.c_right = new Uint8Array(18).fill(1);
    this.c_alg = new Uint8Array(18);        // 0 = two-operator, 1 = head of a four-operator pair,
                                            // 2 = tail of one (generated by its head)
    this.c_fbmod = new Float64Array(18);

    // Chip-wide registers.
    this.reg = new Uint8Array(512);
    this.wse = 0;                           // 0x01 bit 5: OPL2 waveform select enable
    this.opl3 = 0;                          // 0x105 bit 0: OPL3 mode
    this.fourop = 0;                        // 0x104 bits 0..5
    this.rhythm = 0;                        // 0xBD bit 5
    this.dam = 0;                           // 0xBD bit 7: tremolo depth
    this.dvb = 0;                           // 0xBD bit 6: vibrato depth

    // Low frequency oscillators and the percussion noise source.
    this.trem_pos = 0;                      // 0..104, a triangle; halves give 0..52 -> 0..9.75 dB
    this.trem_sub = 0;
    this.vib_pos = 0;                       // 0..7
    this.vib_sub = 0;
    this.noise = 1;                         // 23-bit LFSR

    // Timers, so that the classic Ad Lib detection (write 0x04, read the status port) works.
    this.t1_load = 0; this.t2_load = 0;
    this.t1_count = 0; this.t2_count = 0;
    this.t1_run = 0; this.t2_run = 0;
    this.t1_mask = 0; this.t2_mask = 0;
    this.t1_over = 0; this.t2_over = 0;
    this.timer_last = 0;

    // Set by every register write; sb16.js uses it to know that the guest is talking to the chip
    // at all (and prints it in the sb16 trace).
    this.writes = 0;
    // With the sb16 trace on, the first few hundred register writes are printed: that is how a
    // driver's detection sequence and its first note become visible in a release build.
    this.trace = false;
    this.traced = 0;

    // Scratch: the channels worth rendering in the current block.
    this.live_channels = new Uint8Array(18);

    this.reset();
}

OPL3.prototype.reset = function()
{
    this.reg.fill(0);
    for(let s = 0; s < 36; s++)
    {
        this.s_am[s] = this.s_vib[s] = this.s_egt[s] = this.s_ksr[s] = 0;
        this.s_mult[s] = 0; this.s_ksl[s] = 0; this.s_tl[s] = 0;
        this.s_ar[s] = this.s_dr[s] = this.s_sl[s] = this.s_rr[s] = this.s_ws[s] = 0;
        this.s_phase[s] = 0; this.s_eg[s] = 511; this.s_state[s] = EG_OFF;
        this.s_out[s] = this.s_prout[s] = 0; this.s_keyed[s] = 0;
    }
    for(let c = 0; c < 18; c++)
    {
        this.c_fnum[c] = 0; this.c_block[c] = 0; this.c_kon[c] = 0;
        this.c_fb[c] = 0; this.c_cnt[c] = 0; this.c_alg[c] = 0; this.c_fbmod[c] = 0;
        this.c_left[c] = this.c_right[c] = 1;
    }
    this.wse = this.opl3 = this.fourop = this.rhythm = this.dam = this.dvb = 0;
    this.trem_pos = this.trem_sub = this.vib_pos = this.vib_sub = 0;
    this.noise = 1;
    this.t1_run = this.t2_run = this.t1_over = this.t2_over = 0;
};

//
// Register writes. `address` is 0x000..0x0FF for the first bank and 0x100..0x1FF for the second.
//

OPL3.prototype.write = function(address, value)
{
    address &= 0x1FF;
    value &= 0xFF;
    this.reg[address] = value;
    this.writes++;
    if(this.trace && this.traced < 400)
    {
        this.traced++;
        console.log("[opl] reg " + address.toString(16) + " = " + value.toString(16));
    }

    const bank = address >> 8, reg = address & 0xFF;
    const group = reg & 0xF0;

    if(bank === 0 && reg === 0x01) { this.wse = (value >> 5) & 1; return; }
    if(bank === 1 && reg === 0x05) { this.opl3 = value & 1; return; }
    if(bank === 1 && reg === 0x04) { this.fourop = value & 0x3F; this.update_algorithms(); return; }
    if(bank === 0 && reg === 0x02) { this.t1_load = value; return; }
    if(bank === 0 && reg === 0x03) { this.t2_load = value; return; }
    if(bank === 0 && reg === 0x04)
    {
        if(value & 0x80) { this.t1_over = this.t2_over = 0; return; }
        this.t1_mask = (value >> 6) & 1; this.t2_mask = (value >> 5) & 1;
        const t1 = value & 1, t2 = (value >> 1) & 1;
        if(t1 && !this.t1_run) this.t1_count = 256 - this.t1_load;
        if(t2 && !this.t2_run) this.t2_count = 256 - this.t2_load;
        this.t1_run = t1; this.t2_run = t2;
        this.timer_last = 0;                         // restart the clock at the next advance
        return;
    }
    if(reg === 0xBD && bank === 0)
    {
        this.dam = (value >> 7) & 1;
        this.dvb = (value >> 6) & 1;
        const on = (value >> 5) & 1;
        if(on !== this.rhythm)
        {
            this.rhythm = on;
            if(!on) for(const s of [12, 15, 13, 16, 14, 17]) this.key_off(s);
        }
        if(on)
        {
            // Bass drum keys both operators of channel 6; the other four are one-operator voices.
            this.rhythm_key(12, (value >> 4) & 1); this.rhythm_key(15, (value >> 4) & 1);
            this.rhythm_key(13, value & 1);              // hi-hat
            this.rhythm_key(16, (value >> 3) & 1);       // snare drum
            this.rhythm_key(14, (value >> 2) & 1);       // tom-tom
            this.rhythm_key(17, (value >> 1) & 1);       // top cymbal
        }
        return;
    }

    if(group === 0x20 || group === 0x40 || group === 0x60 || group === 0x80 || group === 0xE0)
    {
        const off = reg & 0x1F;
        const local = off < 0x20 ? SLOT_OF_OFFSET[off] : -1;
        if(local < 0) return;
        const s = bank * 18 + local;
        switch(group)
        {
            case 0x20:
                this.s_am[s] = (value >> 7) & 1;
                this.s_vib[s] = (value >> 6) & 1;
                this.s_egt[s] = (value >> 5) & 1;
                this.s_ksr[s] = (value >> 4) & 1;
                this.s_mult[s] = value & 0x0F;
                break;
            case 0x40:
                this.s_ksl[s] = (value >> 6) & 3;
                this.s_tl[s] = value & 0x3F;
                break;
            case 0x60:
                this.s_ar[s] = (value >> 4) & 0x0F;
                this.s_dr[s] = value & 0x0F;
                break;
            case 0x80:
                this.s_sl[s] = (value >> 4) & 0x0F;
                this.s_rr[s] = value & 0x0F;
                break;
            case 0xE0:
                // Kept raw; how many of the three bits count is decided at play time by the
                // OPL3 flag and by the OPL2 waveform-select enable in register 0x01.
                this.s_ws[s] = value & 7;
                break;
        }
        return;
    }

    if(group === 0xA0 || group === 0xB0 || group === 0xC0)
    {
        const local = reg & 0x0F;
        if(local > 8) return;
        const c = bank * 9 + local;
        if(group === 0xA0)
        {
            this.c_fnum[c] = (this.c_fnum[c] & 0x300) | value;
        }
        else if(group === 0xB0)
        {
            this.c_fnum[c] = (this.c_fnum[c] & 0xFF) | ((value & 3) << 8);
            this.c_block[c] = (value >> 2) & 7;
            const kon = (value >> 5) & 1;
            if(kon !== this.c_kon[c])
            {
                this.c_kon[c] = kon;
                // In rhythm mode channels 6..8 are keyed by 0xBD alone.
                if(!(this.rhythm && local >= 6 && bank === 0)) this.channel_key(c, kon);
            }
        }
        else
        {
            this.c_fb[c] = (value >> 1) & 7;
            this.c_cnt[c] = value & 1;
            if(this.opl3)
            {
                this.c_left[c] = (value >> 4) & 1;
                this.c_right[c] = (value >> 5) & 1;
            }
            else
            {
                this.c_left[c] = this.c_right[c] = 1;
            }
            this.update_algorithms();
        }
        return;
    }
};

OPL3.prototype.read_status = function()
{
    const irq = (this.t1_over && !this.t1_mask) || (this.t2_over && !this.t2_mask);
    return (irq ? 0x80 : 0) | (this.t1_over ? 0x40 : 0) | (this.t2_over ? 0x20 : 0);
};

// Which channels are four-operator heads/tails. The pairs are fixed: 0+3, 1+4, 2+5 in the first
// bank and 9+12, 10+13, 11+14 in the second, enabled by the six bits of register 0x104.
OPL3.prototype.update_algorithms = function()
{
    for(let c = 0; c < 18; c++) this.c_alg[c] = 0;
    if(!this.opl3) return;
    for(let i = 0; i < 6; i++)
    {
        if(!((this.fourop >> i) & 1)) continue;
        const head = i < 3 ? i : 6 + i;         // 0,1,2, 9,10,11
        this.c_alg[head] = 1;
        this.c_alg[head + 3] = 2;
    }
};

OPL3.prototype.channel_key = function(c, on)
{
    const s = (c >= 9 ? 18 : 0) + CH_SLOT[c % 9];
    const four = this.c_alg[c] === 1;
    if(on)
    {
        this.key_on(s); this.key_on(s + 3);
        if(four) { const t = (c >= 9 ? 18 : 0) + CH_SLOT[(c % 9) + 3]; this.key_on(t); this.key_on(t + 3); }
    }
    else
    {
        this.key_off(s); this.key_off(s + 3);
        if(four) { const t = (c >= 9 ? 18 : 0) + CH_SLOT[(c % 9) + 3]; this.key_off(t); this.key_off(t + 3); }
    }
};

OPL3.prototype.rhythm_key = function(s, on)
{
    if(on && !this.s_keyed[s]) this.key_on(s);
    else if(!on && this.s_keyed[s]) this.key_off(s);
};

OPL3.prototype.key_on = function(s)
{
    this.s_keyed[s] = 1;
    this.s_phase[s] = 0;
    this.s_state[s] = EG_ATTACK;
    // AR 0 means "no attack": the envelope stays where it is, which for a released voice is
    // silence. Anything else starts from the current attenuation, as the hardware does.
    if(this.s_ar[s] === 15) { this.s_eg[s] = 0; this.s_state[s] = EG_DECAY; }
};

OPL3.prototype.key_off = function(s)
{
    this.s_keyed[s] = 0;
    if(this.s_state[s] !== EG_OFF) this.s_state[s] = EG_RELEASE;
};

// Nothing to render when every envelope is off; sb16.js uses this to stay idle.
OPL3.prototype.any_active = function()
{
    for(let s = 0; s < 36; s++) if(this.s_state[s] !== EG_OFF) return true;
    return false;
};

//
// Sample generation.
//

// Key-scale value: the channel's octave and the top bit of its F-Number, quartered when the
// operator does not ask for key-scaled rates.
OPL3.prototype.ksv = function(c, s)
{
    const v = (this.c_block[c] << 1) | ((this.c_fnum[c] >> 9) & 1);
    return this.s_ksr[s] ? v : v >> 2;
};

OPL3.prototype.envelope_step = function(s, c)
{
    const st = this.s_state[s];
    if(st === EG_OFF) return;
    const ksv = this.ksv(c, s);
    if(st === EG_ATTACK)
    {
        const ar = this.s_ar[s];
        if(ar === 0) return;                       // held at its current level
        let rate = (ar << 2) + ksv; if(rate > 63) rate = 63;
        const f = RATE_STEP[rate] / 8;             // fraction of the remaining gap per sample
        this.s_eg[s] -= this.s_eg[s] * (f > 1 ? 1 : f);
        if(this.s_eg[s] < 0.1) { this.s_eg[s] = 0; this.s_state[s] = EG_DECAY; }
        return;
    }
    if(st === EG_DECAY)
    {
        const dr = this.s_dr[s];
        // Sustain level: 3 dB per step, and 15 means "as good as silent" (93 dB).
        const sl = (this.s_sl[s] === 15 ? 31 : this.s_sl[s]) << 4;
        if(this.s_eg[s] >= sl) { this.s_state[s] = this.s_egt[s] ? EG_SUSTAIN : EG_RELEASE; return; }
        if(dr === 0) return;
        let rate = (dr << 2) + ksv; if(rate > 63) rate = 63;
        this.s_eg[s] += RATE_STEP[rate];
        if(this.s_eg[s] >= sl)
        {
            this.s_eg[s] = sl;
            this.s_state[s] = this.s_egt[s] ? EG_SUSTAIN : EG_RELEASE;
        }
        return;
    }
    if(st === EG_SUSTAIN) return;
    // Release. A percussive operator (EGT 0) uses this path while still keyed, which is what
    // makes a piano or a drum die away without a note-off.
    const rr = this.s_rr[s];
    if(rr === 0) return;
    let rate = (rr << 2) + ksv; if(rate > 63) rate = 63;
    this.s_eg[s] += RATE_STEP[rate];
    if(this.s_eg[s] >= 511) { this.s_eg[s] = 511; this.s_state[s] = EG_OFF; }
};

// The exp/log-sine pair: one operator's signed 13-bit output for a 10-bit phase and a 9-bit
// attenuation. `ws` selects one of the eight waveforms (only the first four exist on OPL2).
function slot_output(ws, phase, env)
{
    let neg = false, log;
    phase &= 0x3FF;
    const level = env << 3;
    switch(ws)
    {
        case 0:
            if(phase & 0x200) neg = true;
            log = phase & 0x100 ? LOGSIN[(phase & 0xFF) ^ 0xFF] : LOGSIN[phase & 0xFF];
            break;
        case 1:                                     // half sine: the negative half is flat
            if(phase & 0x200) return 0;
            log = phase & 0x100 ? LOGSIN[(phase & 0xFF) ^ 0xFF] : LOGSIN[phase & 0xFF];
            break;
        case 2:                                     // absolute sine
            log = phase & 0x100 ? LOGSIN[(phase & 0xFF) ^ 0xFF] : LOGSIN[phase & 0xFF];
            break;
        case 3:                                     // quarter sine pulses
            if(phase & 0x100) return 0;
            log = LOGSIN[phase & 0xFF];
            break;
        case 4:                                     // sine at double speed, second half flat
        {
            if(phase & 0x200) return 0;
            const p = (phase << 1) & 0x3FF;
            if(p & 0x200) neg = true;
            log = p & 0x100 ? LOGSIN[(p & 0xFF) ^ 0xFF] : LOGSIN[p & 0xFF];
            break;
        }
        case 5:                                     // absolute sine at double speed
        {
            if(phase & 0x200) return 0;
            const p = (phase << 1) & 0x3FF;
            log = p & 0x100 ? LOGSIN[(p & 0xFF) ^ 0xFF] : LOGSIN[p & 0xFF];
            break;
        }
        case 6:                                     // square
            if(phase & 0x200) neg = true;
            log = 0;
            break;
        default:                                    // exponential saw
            if(phase & 0x200) { neg = true; log = ((0x200 - (phase & 0x1FF)) & 0x1FF) << 3; }
            else log = (phase & 0x1FF) << 3;
            if(log > 0xFFF) log = 0xFFF;
            break;
    }
    let total = log + level;
    if(total > 0x1FFF) total = 0x1FFF;
    const out = (EXP[total & 0xFF] << 1) >> (total >> 8);
    return neg ? -out : out;
}

// One operator: advance its phase, step its envelope, and return its output for the given phase
// modulation (in units of 1/1024 of a cycle, which is what another operator's output is).
// `phase_override` replaces the operator's own phase, which only the percussion voices use.
/**
 * @param {number} s
 * @param {number} c
 * @param {number} mod
 * @param {number=} phase_override
 */
OPL3.prototype.slot_generate = function(s, c, mod, phase_override)
{
    this.envelope_step(s, c);

    let fnum = this.c_fnum[c];
    if(this.s_vib[s])
    {
        // Vibrato: an eight-step 6.1 Hz cycle, +/- 7 or 14 cents deep.
        const d = fnum >> (this.dvb ? 7 : 8);
        fnum += d * VIB_PATTERN[this.vib_pos];
        if(fnum < 0) fnum = 0;
    }
    const inc = (((fnum << this.c_block[c]) >> 1) * MULT[this.s_mult[s]]) >> 1;
    this.s_phase[s] = (this.s_phase[s] + inc) % 524288;

    let env = this.s_eg[s] + (this.s_tl[s] << 2);
    let ksl = (KSL[this.c_fnum[c] >> 6] << 2) - ((8 - this.c_block[c]) << 5);
    if(ksl > 0) env += ksl >> KSL_SHIFT[this.s_ksl[s]];
    if(this.s_am[s]) env += this.dam ? this.trem_pos >> 1 : this.trem_pos >> 3;
    if(env >= 511) { this.s_prout[s] = this.s_out[s]; this.s_out[s] = 0; return 0; }
    if(env < 0) env = 0;

    const phase = phase_override === undefined ? (this.s_phase[s] / 512) | 0 : phase_override;
    const ws = this.s_ws[s] & (this.opl3 ? 7 : this.wse ? 3 : 0);
    const out = slot_output(ws, phase + mod, env | 0);
    this.s_prout[s] = this.s_out[s];
    this.s_out[s] = out;
    return out;
};

// The four operators of a four-operator channel, wired by the two CNT bits of the pair.
OPL3.prototype.four_op_generate = function(c)
{
    const base = c >= 9 ? 18 : 0, n = c % 9;
    const s0 = base + CH_SLOT[n], s1 = s0 + 3;
    const s2 = base + CH_SLOT[n + 3], s3 = s2 + 3;
    const c2 = c + 3;
    const alg = (this.c_cnt[c] << 1) | this.c_cnt[c2];
    const fb = this.c_fb[c];
    const fbmod = fb ? (this.s_prout[s0] + this.s_out[s0]) / (1 << (9 - fb)) | 0 : 0;
    const o0 = this.slot_generate(s0, c, fbmod);
    switch(alg)
    {
        case 0:                                     // 1 -> 2 -> 3 -> 4
        {
            const o1 = this.slot_generate(s1, c, o0);
            const o2 = this.slot_generate(s2, c2, o1);
            return this.slot_generate(s3, c2, o2);
        }
        case 1:                                     // (1 -> 2) + (3 -> 4)
        {
            const o1 = this.slot_generate(s1, c, o0);
            const o2 = this.slot_generate(s2, c2, 0);
            return o1 + this.slot_generate(s3, c2, o2);
        }
        case 2:                                     // 1 + (2 -> 3 -> 4)
        {
            const o1 = this.slot_generate(s1, c, 0);
            const o2 = this.slot_generate(s2, c2, o1);
            return o0 + this.slot_generate(s3, c2, o2);
        }
        default:                                    // 1 + (2 -> 3) + 4
        {
            const o1 = this.slot_generate(s1, c, o0);
            const o2 = this.slot_generate(s2, c2, 0);
            const o3 = this.slot_generate(s3, c2, o2);
            return o1 + o3;
        }
    }
};

OPL3.prototype.two_op_generate = function(c)
{
    const base = c >= 9 ? 18 : 0, n = c % 9;
    const s0 = base + CH_SLOT[n], s1 = s0 + 3;
    const fb = this.c_fb[c];
    const fbmod = fb ? (this.s_prout[s0] + this.s_out[s0]) / (1 << (9 - fb)) | 0 : 0;
    const o0 = this.slot_generate(s0, c, fbmod);
    if(this.c_cnt[c])
    {
        return o0 + this.slot_generate(s1, c, 0);   // the two operators sound in parallel
    }
    return this.slot_generate(s1, c, o0);           // the first modulates the second
};

// Channels 6..8 in rhythm mode. Bass drum is an ordinary two-operator voice; the other four are
// single operators whose phase is partly taken from the noise source and from the hi-hat's and
// cymbal's own phase bits (YMF262 manual; the bit arithmetic is the chip's).
OPL3.prototype.rhythm_generate = function()
{
    const p13 = (this.s_phase[13] / 512) | 0, p17 = (this.s_phase[17] / 512) | 0;
    const hh2 = (p13 >> 2) & 1, hh3 = (p13 >> 3) & 1, hh7 = (p13 >> 7) & 1, hh8 = (p13 >> 8) & 1;
    const tc3 = (p17 >> 3) & 1, tc5 = (p17 >> 5) & 1;
    const bit = ((hh2 ^ hh7) | hh3 | (tc3 ^ tc5)) & 1;
    const nz = this.noise & 1;

    let out = 0;
    // Bass drum, channel 6, both operators.
    const fb = this.c_fb[6];
    const fbmod = fb ? (this.s_prout[12] + this.s_out[12]) / (1 << (9 - fb)) | 0 : 0;
    const o0 = this.slot_generate(12, 6, fbmod);
    out += 2 * (this.c_cnt[6] ? o0 + this.slot_generate(15, 6, 0) : this.slot_generate(15, 6, o0));
    // Hi-hat and snare take channel 7's frequency, tom-tom and cymbal channel 8's; each is a
    // single operator, and every rhythm voice is summed twice, as the chip does.
    out += 2 * this.slot_generate(13, 7, 0, (bit << 9) | (0x34 << ((bit ^ nz) << 1)));
    out += 2 * this.slot_generate(16, 7, 0, (hh8 << 9) | (((hh8 ^ nz) ^ 1) << 8));
    out += 2 * this.slot_generate(14, 8, 0);
    out += 2 * this.slot_generate(17, 8, 0, (bit << 9) | 0x80);
    return out;
};

OPL3.prototype.lfo_step = function()
{
    // Tremolo: a 105-step triangle at about 3.7 Hz, 1.0 dB (DAM 0) or 4.8 dB (DAM 1) deep.
    if(++this.trem_sub >= 128)
    {
        this.trem_sub = 0;
        this.trem_pos = this.trem_pos >= 104 ? 0 : this.trem_pos + 1;
    }
    // Vibrato: eight steps at about 6.1 Hz.
    if(++this.vib_sub >= 1024) { this.vib_sub = 0; this.vib_pos = (this.vib_pos + 1) & 7; }
    // 23-bit noise LFSR for the percussion voices.
    this.noise = (this.noise >>> 1) | ((((this.noise ^ (this.noise >>> 14)) & 1) << 22) >>> 0);
};

// Timer 1 counts in 80 us steps, timer 2 in 320 us. Only the overflow flags matter to us: they
// are what an Ad Lib detection routine reads back from the status port (write 0x60/0x80 to
// register 4, read 0, arm with 0xFF/0x21, wait, read 0xC0). The chip's timer interrupt line is
// not wired anywhere. Advanced on the wall clock, and advanced from the status read itself so
// that a driver's delay loop cannot outrun it however fast the emulator is going.
OPL3.prototype.timers_advance = function(now)
{
    if(!this.t1_run && !this.t2_run) { this.timer_last = now; return; }
    if(!this.timer_last) { this.timer_last = now; return; }
    // 80 us steps: 12.5 per millisecond.
    let steps = (now - this.timer_last) * 12.5;
    if(steps <= 0) return;
    if(steps > 100000) steps = 100000;               // after a stall, do not spin
    this.timer_last = now;
    this.timers_step(steps);
};

// One 80 us step charged to each read of the status port. The wall clock alone is not enough: a
// driver arms timer 1 for 80 us and then waits by spinning, and this emulator runs that spin in
// far less than 80 us of real time, so the flag would never be up when it looked. Since the only
// thing that ever reads this port is such a wait, charging the wait itself keeps the count
// honest - with the usual load of 0xFF (one step) the flag is up on the first read, exactly as
// the hardware would have it by the time a real 386 got there.
OPL3.prototype.timers_read_tick = function()
{
    if(this.t1_run || this.t2_run) this.timers_step(1);
};

OPL3.prototype.timers_step = function(steps)
{
    if(this.t1_run)
    {
        this.t1_count -= steps;
        while(this.t1_count <= 0) { this.t1_count += 256 - this.t1_load; this.t1_over = 1; }
    }
    if(this.t2_run)
    {
        this.t2_count -= steps / 4;
        while(this.t2_count <= 0) { this.t2_count += 256 - this.t2_load; this.t2_over = 1; }
    }
};

/**
 * Render `count` stereo samples at 49716 Hz into two float arrays, scaled to roughly +/- 1.
 * @param {!Float32Array} left
 * @param {!Float32Array} right
 * @param {number} count
 */
OPL3.prototype.generate = function(left, right, count)
{
    // Which channels have anything to say, decided once per block: a silent channel's operators
    // are skipped entirely, so an idle chip with one voice sounding costs one voice.
    const live = this.live_channels;
    let n_live = 0;
    for(let c = 0; c < 18; c++)
    {
        if(this.rhythm && c >= 6 && c <= 8) continue;      // handled by rhythm_generate
        const alg = this.c_alg[c];
        if(alg === 2) continue;                            // rendered with its four-operator head
        const base = c >= 9 ? 18 : 0, n = c % 9;
        const s0 = base + CH_SLOT[n];
        let on = this.s_state[s0] !== EG_OFF || this.s_state[s0 + 3] !== EG_OFF;
        if(alg === 1)
        {
            const t = base + CH_SLOT[n + 3];
            on = on || this.s_state[t] !== EG_OFF || this.s_state[t + 3] !== EG_OFF;
        }
        if(on) live[n_live++] = c;
    }
    for(let i = 0; i < count; i++)
    {
        this.lfo_step();
        let l = 0, r = 0;
        for(let j = 0; j < n_live; j++)
        {
            const c = live[j];
            const out = this.c_alg[c] === 1 ? this.four_op_generate(c) : this.two_op_generate(c);
            if(this.c_left[c]) l += out;
            if(this.c_right[c]) r += out;
        }
        if(this.rhythm)
        {
            const out = this.rhythm_generate();
            l += out; r += out;
        }
        left[i] = l < -32768 ? -1 : l > 32767 ? 1 : l / 32768;
        right[i] = r < -32768 ? -1 : r > 32767 ? 1 : r / 32768;
    }
};
