import {
    LOG_SB16,
    MIXER_CHANNEL_BOTH, MIXER_CHANNEL_LEFT, MIXER_CHANNEL_RIGHT,
    MIXER_SRC_PCSPEAKER, MIXER_SRC_DAC, MIXER_SRC_MASTER,
} from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import { SyncBuffer } from "./buffer.js";
import { OPL3, OPL_RATE } from "./opl3.js";
import { v86 } from "./main.js";

// For Types Only
import { CPU } from "./cpu.js";
import { DMA } from "./dma.js";
import { IO } from "./io.js";
import { BusConnector } from "./bus.js";
import { ByteQueue, FloatQueue } from "./lib.js";

// Useful documentation, articles, and source codes for reference:
// ===============================================================
//
// Official Hardware Programming Guide
// -> https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf
//
// Official Yamaha YMF262 Manual
// -> http://map.grauw.nl/resources/sound/yamaha_ymf262.pdf
//
// OPL3 Programming Guide
// -> http://www.fit.vutbr.cz/~arnost/opl/opl3.html
//
// DOSBox
// -> https://sourceforge.net/p/dosbox/code-0/HEAD/tree/dosbox/branches/mamesound/src/hardware/sblaster.cpp
// -> https://github.com/duganchen/dosbox/blob/master/src/hardware/sblaster.cpp
// -> https://github.com/joncampbell123/dosbox-x/blob/master/src/hardware/sblaster.cpp
//
// QEMU
// -> https://github.com/qemu/qemu/blob/master/hw/audio/sb16.c
// -> https://github.com/hackndev/qemu/blob/master/hw/sb16.c
//
// VirtualBox
// -> https://www.virtualbox.org/svn/vbox/trunk/src/VBox/Devices/Audio/DevSB16.cpp
// -> https://github.com/mdaniel/virtualbox-org-svn-vbox-trunk/blob/master/src/VBox/Devices/Audio/DevSB16.cpp

const
    // Used for drivers to identify device (DSP command 0xE3).
    DSP_COPYRIGHT = "COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.",

    // Value of the current DSP command that indicates that the
    // next command/data write in port 2xC should be interpreted
    // as a command number.
    DSP_NO_COMMAND = 0,

    // Size (bytes) of the DSP write/read buffers
    DSP_BUFSIZE = 64,

    // Size (bytes) of the buffers containing floating point linear PCM audio.
    DSP_DACSIZE = 65536,

    // Size (bytes) of the buffer in which DMA transfers are temporarily
    // stored before being processed.
    SB_DMA_BUFSIZE = 65536,

    // Number of samples to attempt to retrieve per transfer.
    SB_DMA_BLOCK_SAMPLES = 1024,
    // Host-side capture ring, in host samples (about 1.3 s at 48 kHz).
    SB_REC_RING_SIZE = 65536,
    // Recording latency bound: when the host is further ahead than this many host samples, the
    // read position jumps forward rather than letting the lag grow (about 250 ms at 48 kHz).
    SB_REC_MAX_LAG = 12000,

    // Usable DMA channels.
    SB_DMA0 = 0,
    SB_DMA1 = 1,
    SB_DMA3 = 3,
    SB_DMA5 = 5,
    SB_DMA6 = 6,
    SB_DMA7 = 7,

    // Default DMA channels.
    SB_DMA_CHANNEL_8BIT = SB_DMA1,
    SB_DMA_CHANNEL_16BIT = SB_DMA5,

    // Usable IRQ channels.
    SB_IRQ2 = 2,
    SB_IRQ5 = 5,
    SB_IRQ7 = 7,
    SB_IRQ10 = 10,

    // Default IRQ channel.
    SB_IRQ = SB_IRQ5,

    // OPL rendering: at least this many samples before a block is worth sending (2.6 ms), at most
    // this many in one (41 ms), and never more than this owed after a stall (82 ms of catch-up).
    OPL_MIN_BLOCK = 128,
    OPL_MAX_BLOCK = 2048,
    OPL_MAX_OWED = 4096,

    // Indices to the irq_triggered register.
    SB_IRQ_8BIT = 0x1,
    SB_IRQ_16BIT = 0x2,
    SB_IRQ_MIDI = 0x1,
    SB_IRQ_MPU = 0x4;


// Probably less efficient, but it's more maintainable, instead
// of having a single large unorganised and decoupled table.
var DSP_COMMAND_SIZES = new Uint8Array(256);
var DSP_COMMAND_HANDLERS = [];
var MIXER_READ_HANDLERS = [];
var MIXER_WRITE_HANDLERS = [];
var MIXER_REGISTER_IS_LEGACY = new Uint8Array(256);


/**
 * Sound Blaster 16 Emulator, or so it seems.
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function SB16(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {BusConnector} */
    this.bus = bus;

    // I/O Buffers.
    this.write_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer_lastvalue = 0;

    // Current DSP command info.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    // Mixer.
    this.mixer_current_address = 0;
    this.mixer_registers = new Uint8Array(256);
    this.mixer_reset();

    // Dummy status and test registers.
    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    // DSP state.
    this.dsp_highspeed = false;
    this.dsp_stereo = false;
    this.dsp_16bit = false;
    this.dsp_signed = false;

    // DAC buffer.
    // The final destination for audio data before being sent off
    // to Web Audio APIs.
    // Format:
    // Floating precision linear PCM, nominal between -1 and 1.
    this.dac_buffers = [
      new FloatQueue(DSP_DACSIZE),
      new FloatQueue(DSP_DACSIZE),
    ];

    // Direct Memory Access transfer info.
    this.dma = cpu.devices.dma;
    this.dma_sample_count = 0;
    this.dma_bytes_count = 0;
    this.dma_bytes_left = 0;
    this.dma_bytes_block = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_channel_8bit = SB_DMA_CHANNEL_8BIT;
    this.dma_channel_16bit = SB_DMA_CHANNEL_16BIT;
    this.dma_autoinit = false;
    this.dma_buffer = new ArrayBuffer(SB_DMA_BUFSIZE);
    this.dma_buffer_int8 = new Int8Array(this.dma_buffer);
    this.dma_buffer_uint8 = new Uint8Array(this.dma_buffer);
    this.dma_buffer_int16 = new Int16Array(this.dma_buffer);
    this.dma_buffer_uint16 = new Uint16Array(this.dma_buffer);
    this.dma_syncbuffer = new SyncBuffer(this.dma_buffer);
    this.dma_waiting_transfer = false;
    this.dma_paused = false;
    this.sampling_rate = 22050;
    bus.send("dac-tell-sampling-rate", this.sampling_rate);
    bus.send("opl-tell-sampling-rate", OPL_RATE);
    this.bytes_per_sample = 1;

    // DMA identification data.
    this.e2_value = 0xAA;
    this.e2_count = 0;

    // ASP data: not understood by me.
    this.asp_registers = new Uint8Array(256);

    // MPU.
    this.mpu_read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.mpu_read_buffer_lastvalue = 0;

    // FM Synthesizer.
    // responsive-wfw311: the register writes used to be discarded (see opl3.js). They now reach a
    // real OPL3, rendered at its own 49716 Hz on the wall clock in opl_timer() and handed to the
    // page as "opl-send-data" blocks - a separate channel from the wave DAC, so FM and a .WAV can
    // sound at once and neither has to agree with the other about a sampling rate.
    this.opl = new OPL3();
    this.fm_current_address0 = 0;
    this.fm_current_address1 = 0x100;
    this.opl_playing = false;
    this.opl_last_time = 0;
    this.opl_owed = 0;                      // fractional samples owed since the last tick
    this.opl_blocks = 0;
    this.opl_samples = 0;
    this.opl_traced = 0;

    // Interrupts.
    this.irq = SB_IRQ;
    this.irq_triggered = new Uint8Array(0x10);
    this.dsp_version_major = undefined;
    this.dsp_version_minor = undefined;
    bus.register("sb16-dsp-version", function(v) { this.dsp_version_major = v[0]; this.dsp_version_minor = v[1]; }, this);
    // responsive-wfw311: guest-visible DSP/IRQ trace on the console (bus "sb16-trace" true/false),
    // for watching a driver's detection sequence in a release build where dbg_log is compiled out.
    this.trace = false;
    bus.register("sb16-trace", function(v) { this.trace = !!v; if(this.opl) this.opl.trace = !!v; }, this);

    // IO Ports.
    // http://homepages.cae.wisc.edu/~brodskye/sb16doc/sb16doc.html#DSPPorts
    // https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf

    cpu.io.register_read_consecutive(0x220, this,
        this.port2x0_read, this.port2x1_read, this.port2x2_read, this.port2x3_read);
    cpu.io.register_read_consecutive(0x388, this,
        this.port2x0_read, this.port2x1_read);

    cpu.io.register_read_consecutive(0x224, this,
        this.port2x4_read, this.port2x5_read);

    cpu.io.register_read(0x226, this, this.port2x6_read);
    cpu.io.register_read(0x227, this, this.port2x7_read);
    cpu.io.register_read(0x228, this, this.port2x8_read);
    cpu.io.register_read(0x229, this, this.port2x9_read);

    cpu.io.register_read(0x22A, this, this.port2xA_read);
    cpu.io.register_read(0x22B, this, this.port2xB_read);
    cpu.io.register_read(0x22C, this, this.port2xC_read);
    cpu.io.register_read(0x22D, this, this.port2xD_read);

    cpu.io.register_read_consecutive(0x22E, this,
        this.port2xE_read, this.port2xF_read);

    cpu.io.register_write_consecutive(0x220, this,
        this.port2x0_write, this.port2x1_write, this.port2x2_write, this.port2x3_write);
    cpu.io.register_write_consecutive(0x388, this,
        this.port2x0_write, this.port2x1_write);

    cpu.io.register_write_consecutive(0x224, this,
        this.port2x4_write, this.port2x5_write);

    cpu.io.register_write(0x226, this, this.port2x6_write);
    cpu.io.register_write(0x227, this, this.port2x7_write);

    cpu.io.register_write_consecutive(0x228, this,
        this.port2x8_write, this.port2x9_write);

    cpu.io.register_write(0x22A, this, this.port2xA_write);
    cpu.io.register_write(0x22B, this, this.port2xB_write);
    cpu.io.register_write(0x22C, this, this.port2xC_write);
    cpu.io.register_write(0x22D, this, this.port2xD_write);
    cpu.io.register_write(0x22E, this, this.port2xE_write);
    cpu.io.register_write(0x22F, this, this.port2xF_write);

    cpu.io.register_read_consecutive(0x330, this, this.port3x0_read, this.port3x1_read);
    cpu.io.register_write_consecutive(0x330, this, this.port3x0_write, this.port3x1_write);

    this.dma.on_unmask(this.dma_on_unmask, this);

    // responsive-wfw311: ADC / recording path (DSP 0x24, 0x2C, 0x91, 0x98, 0x99, 0xC8..0xCF).
    // Samples come from the host over the bus ("sb16-record-data": [Float32Array, rate]) into a
    // ring; the DSP pulls them at its own programmed rate, paced by the emulator clock in
    // timer(), so a block of DMA input and its IRQ arrive on time whether or not the host has a
    // microphone to offer (silence is written when the ring is empty).
    this.rec_active = false;
    this.rec_autoinit = false;
    this.rec_paused = false;
    this.rec_channel = 0;
    this.rec_bytes_count = 0;
    this.rec_bytes_left = 0;
    this.rec_last_time = 0;
    this.rec_owed = 0;                      // fractional samples owed since the last tick
    this.rec_buffer = new Uint8Array(SB_DMA_BUFSIZE);
    this.rec_ring = new Float32Array(SB_REC_RING_SIZE);
    this.rec_ring_w = 0;                    // host samples written (monotonic)
    this.rec_ring_r = 0;                    // device read position (fractional, monotonic)
    this.rec_host_rate = 48000;
    this.rec_host_seen = false;
    bus.register("sb16-record-data", function(msg)
    {
        this.rec_push(msg[0], msg[1]);
    }, this);

    bus.register("dac-request-data", function()
    {
        this.dac_handle_request();
    }, this);
    bus.register("speaker-has-initialized", function()
    {
        this.mixer_reset();
    }, this);
    bus.send("speaker-confirm-initialized");

    this.dsp_reset();
}

//
// General
//

SB16.prototype.dsp_reset = function()
{
    this.write_buffer.clear();
    this.read_buffer.clear();

    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    this.dsp_highspeed = false;
    this.dsp_stereo = false;
    this.dsp_16bit = false;
    this.dsp_signed = false;

    this.dac_buffers[0].clear();
    this.dac_buffers[1].clear();

    this.dma_sample_count = 0;
    this.dma_bytes_count = 0;
    this.dma_bytes_left = 0;
    this.dma_bytes_block = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_autoinit = false;
    this.dma_buffer_uint8.fill(0);
    this.dma_waiting_transfer = false;
    this.dma_paused = false;

    this.e2_value = 0xAA;
    this.e2_count = 0;

    this.sampling_rate = 22050;
    this.bytes_per_sample = 1;

    this.rec_stop();

    this.lower_irq(SB_IRQ_8BIT);
    this.irq_triggered.fill(0);

    this.asp_registers.fill(0);
    this.asp_registers[5] = 0x01;
    this.asp_registers[9] = 0xF8;
};

SB16.prototype.get_state = function()
{
    var state = [];

    // state[0] = this.write_buffer;
    // state[1] = this.read_buffer;
    state[2] = this.read_buffer_lastvalue;

    state[3] = this.command;
    state[4] = this.command_size;

    state[5] = this.mixer_current_address;
    state[6] = this.mixer_registers;

    state[7] = this.dummy_speaker_enabled;
    state[8] = this.test_register;

    state[9] = this.dsp_highspeed;
    state[10] = this.dsp_stereo;
    state[11] = this.dsp_16bit;
    state[12] = this.dsp_signed;

    // state[13] = this.dac_buffers;
    //state[14]

    state[15] = this.dma_sample_count;
    state[16] = this.dma_bytes_count;
    state[17] = this.dma_bytes_left;
    state[18] = this.dma_bytes_block;
    state[19] = this.dma_irq;
    state[20] = this.dma_channel;
    state[21] = this.dma_channel_8bit;
    state[22] = this.dma_channel_16bit;
    state[23] = this.dma_autoinit;
    state[24] = this.dma_buffer_uint8;
    state[25] = this.dma_waiting_transfer;
    state[26] = this.dma_paused;
    state[27] = this.sampling_rate;
    state[28] = this.bytes_per_sample;

    state[29] = this.e2_value;
    state[30] = this.e2_count;

    state[31] = this.asp_registers;

    // state[32] = this.mpu_read_buffer;
    state[33] = this.mpu_read_buffer_last_value;

    state[34] = this.irq;
    state[35] = this.irq_triggered;
    //state[36]

    return state;
};

SB16.prototype.set_state = function(state)
{
    // this.write_buffer = state[0];
    // this.read_buffer = state[1];
    this.read_buffer_lastvalue = state[2];

    this.command = state[3];
    this.command_size = state[4];

    this.mixer_current_address = state[5];
    this.mixer_registers = state[6];
    this.mixer_full_update();

    this.dummy_speaker_enabled = state[7];
    this.test_register = state[8];

    this.dsp_highspeed = state[9];
    this.dsp_stereo = state[10];
    this.dsp_16bit = state[11];
    this.dsp_signed = state[12];

    // this.dac_buffers = state[13];
    //state[14]

    this.dma_sample_count = state[15];
    this.dma_bytes_count = state[16];
    this.dma_bytes_left = state[17];
    this.dma_bytes_block = state[18];
    this.dma_irq = state[19];
    this.dma_channel = state[20];
    this.dma_channel_8bit = state[21];
    this.dma_channel_16bit = state[22];
    this.dma_autoinit = state[23];
    this.dma_buffer_uint8 = state[24];
    this.dma_waiting_transfer = state[25];
    this.dma_paused = state[26];
    this.sampling_rate = state[27];
    // The FM chip is not snapshotted; a restore comes back with it silent rather than with
    // whatever note was sounding when the state was saved.
    this.opl.reset();
    this.opl_playing = false;
    this.opl_owed = 0;
    this.bytes_per_sample = state[28];

    this.e2_value = state[29];
    this.e2_count = state[30];

    this.asp_registers = state[31];

    // this.mpu_read_buffer = state[32];
    this.mpu_read_buffer_last_value = state[33];

    this.irq = state[34];
    this.irq_triggered = state[35];
    //state[36];

    this.dma_buffer = this.dma_buffer_uint8.buffer;
    this.dma_buffer_int8 = new Int8Array(this.dma_buffer);
    this.dma_buffer_int16 = new Int16Array(this.dma_buffer);
    this.dma_buffer_uint16 = new Uint16Array(this.dma_buffer);
    this.dma_syncbuffer = new SyncBuffer(this.dma_buffer);

    // A recording in progress does not survive a snapshot: the host capture it fed is gone.
    this.rec_stop();

    if(this.dma_paused)
    {
        this.bus.send("dac-disable");
    }
    else
    {
        this.bus.send("dac-enable");
    }
};

//
// I/O handlers
//

// FM status: the timer overflow flags. An Ad Lib detection routine writes registers 4/2/4 and
// reads this back expecting 0x00 then 0xC0, which opl3.js's timers satisfy.
SB16.prototype.port2x0_read = function()
{
    this.opl.timers_advance(v86.microtick());
    this.opl.timers_read_tick();
    return this.opl.read_status();
};

SB16.prototype.port2x1_read = function()
{
    dbg_log("221 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x2_read = function()
{
    this.opl.timers_advance(v86.microtick());
    this.opl.timers_read_tick();
    return this.opl.read_status();
};

SB16.prototype.port2x3_read = function()
{
    dbg_log("223 read: advanced music data port (write only)", LOG_SB16);
    return 0xFF;
};

// Mixer Address Port.
SB16.prototype.port2x4_read = function()
{
    dbg_log("224 read: mixer address port", LOG_SB16);
    return this.mixer_current_address;
};

// Mixer Data Port.
SB16.prototype.port2x5_read = function()
{
    dbg_log("225 read: mixer data port", LOG_SB16);
    return this.mixer_read(this.mixer_current_address);
};

SB16.prototype.port2x6_read = function()
{
    dbg_log("226 read: (write only)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x7_read = function()
{
    dbg_log("227 read: undocumented", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x8_read = function()
{
    this.opl.timers_advance(v86.microtick());
    this.opl.timers_read_tick();
    return this.opl.read_status();
};

SB16.prototype.port2x9_read = function()
{
    dbg_log("229 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
};

// Read Data.
// Used to access in-bound DSP data.
SB16.prototype.port2xA_read = function()
{
    dbg_log("22A read: read data", LOG_SB16);
    if(this.read_buffer.length)
    {
        this.read_buffer_lastvalue = this.read_buffer.shift();
    }
    if(this.trace) console.log("[sb16] 2xA read -> " + h(this.read_buffer_lastvalue));
    dbg_log(" <- " + this.read_buffer_lastvalue + " " + h(this.read_buffer_lastvalue) + " '" + String.fromCharCode(this.read_buffer_lastvalue) + "'", LOG_SB16);
    return this.read_buffer_lastvalue;
};

SB16.prototype.port2xB_read = function()
{
    dbg_log("22B read: undocumented", LOG_SB16);
    return 0xFF;
};

// Write-Buffer Status.
// Indicates whether the DSP is ready to accept commands or data.
SB16.prototype.port2xC_read = function()
{
    dbg_log("22C read: write-buffer status", LOG_SB16);
    // Always return ready (bit-7 set to low)
    return 0x7F;
};

SB16.prototype.port2xD_read = function()
{
    dbg_log("22D read: undocumented", LOG_SB16);
    return 0xFF;
};

// Read-Buffer Status.
// Indicates whether there is any in-bound data available for reading.
// Also used to acknowledge DSP 8-bit interrupt.
SB16.prototype.port2xE_read = function()
{
    dbg_log("22E read: read-buffer status / irq 8bit ack.", LOG_SB16);
    if(this.irq_triggered[SB_IRQ_8BIT])
    {
        if(this.trace) console.log("[sb16] 2xE read: 8-bit irq acknowledged");
        this.lower_irq(SB_IRQ_8BIT);
    }
    var ready = this.read_buffer.length && !this.dsp_highspeed;
    return (ready << 7) | 0x7F;
};

// DSP 16-bit interrupt acknowledgement.
SB16.prototype.port2xF_read = function()
{
    dbg_log("22F read: irq 16bit ack", LOG_SB16);
    this.lower_irq(SB_IRQ_16BIT);
    return 0;
};


// FM Address Port - primary register bank (0x220/0x228/0x388: Ad Lib compatible).
SB16.prototype.port2x0_write = function(value)
{
    this.fm_current_address0 = value & 0xFF;
};

// FM Data Port - primary register bank.
SB16.prototype.port2x1_write = function(value)
{
    this.opl.write(this.fm_current_address0, value);
};

// FM Address Port - secondary register bank (OPL3 only; 0x222/0x38A).
SB16.prototype.port2x2_write = function(value)
{
    this.fm_current_address1 = 0x100 | (value & 0xFF);
};

// FM Data Port - secondary register bank.
SB16.prototype.port2x3_write = function(value)
{
    this.opl.write(this.fm_current_address1, value);
};

// Mixer Address Port.
SB16.prototype.port2x4_write = function(value)
{
    dbg_log("224 write: mixer address = " + h(value), LOG_SB16);
    this.mixer_current_address = value;
};

// Mixer Data Port.
SB16.prototype.port2x5_write = function(value)
{
    dbg_log("225 write: mixer data = " + h(value), LOG_SB16);
    this.mixer_write(this.mixer_current_address, value);
};

// Reset.
// Used to reset the DSP to its default state and to exit highspeed mode.
SB16.prototype.port2x6_write = function(yesplease)
{
    dbg_log("226 write: reset = " + h(yesplease), LOG_SB16);
    if(this.trace) console.log("[sb16] 2x6 write (reset) = " + h(yesplease));

    if(this.dsp_highspeed)
    {
        dbg_log(" -> exit highspeed", LOG_SB16);
        this.dsp_highspeed = false;
    }
    else if(yesplease)
    {
        dbg_log(" -> reset", LOG_SB16);
        this.dsp_reset();
    }

    // Signal completion.
    this.read_buffer.clear();
    this.read_buffer.push(0xAA);
};

SB16.prototype.port2x7_write = function(value)
{
    dbg_log("227 write: undocumented", LOG_SB16);
};

SB16.prototype.port2x8_write = function(value)
{
    this.fm_current_address0 = value & 0xFF;
};

SB16.prototype.port2x9_write = function(value)
{
    this.opl.write(this.fm_current_address0, value);
};

SB16.prototype.port2xA_write = function(value)
{
    dbg_log("22A write: dsp read data port (read only)", LOG_SB16);
};

SB16.prototype.port2xB_write = function(value)
{
    dbg_log("22B write: undocumented", LOG_SB16);
};

// Write Command/Data.
// Used to send commands or data to the DSP.
SB16.prototype.port2xC_write = function(value)
{
    dbg_log("22C write: write command/data", LOG_SB16);

    if(this.command === DSP_NO_COMMAND)
    {
        // New command.
        dbg_log("22C write: command = " + h(value), LOG_SB16);
        if(this.trace) console.log("[sb16] 2xC command " + h(value));
        this.command = value;
        this.write_buffer.clear();
        this.command_size = DSP_COMMAND_SIZES[value];
    }
    else
    {
        // More data for current command.
        dbg_log("22C write: data: " + h(value), LOG_SB16);
        if(this.trace) console.log("[sb16] 2xC data " + h(value) + " (cmd " + h(this.command) + ")");
        this.write_buffer.push(value);
    }

    // Perform command when we have all the needed data.
    if(this.write_buffer.length >= this.command_size)
    {
        this.command_do();
    }
};

SB16.prototype.port2xD_write = function(value)
{
    dbg_log("22D write: undocumented", LOG_SB16);
};

SB16.prototype.port2xE_write = function(value)
{
    dbg_log("22E write: dsp read buffer status (read only)", LOG_SB16);
};

SB16.prototype.port2xF_write = function(value)
{
    dbg_log("22F write: undocumented", LOG_SB16);
};


// MPU UART Mode - Data Port
SB16.prototype.port3x0_read = function()
{
    dbg_log("330 read: mpu data", LOG_SB16);

    if(this.mpu_read_buffer.length)
    {
        this.mpu_read_buffer_lastvalue = this.mpu_read_buffer.shift();
    }
    dbg_log(" <- " + h(this.mpu_read_buffer_lastvalue), LOG_SB16);

    return this.mpu_read_buffer_lastvalue;
};
SB16.prototype.port3x0_write = function(value)
{
    dbg_log("330 write: mpu data (unimplemented) : " + h(value), LOG_SB16);
};

// MPU UART Mode - Status Port
SB16.prototype.port3x1_read = function()
{
    dbg_log("331 read: mpu status", LOG_SB16);

    var status = 0;
    status |= 0x40 * 0; // Output Ready
    status |= 0x80 * !this.mpu_read_buffer.length; // Input Ready

    return status;
};

// MPU UART Mode - Command Port
SB16.prototype.port3x1_write = function(value)
{
    dbg_log("331 write: mpu command: " + h(value), LOG_SB16);
    if(value === 0xFF)
    {
        // Command acknowledge.
        this.mpu_read_buffer.clear();
        this.mpu_read_buffer.push(0xFE);
    }
};

//
// DSP command handlers
//

SB16.prototype.command_do = function()
{
    var handler = DSP_COMMAND_HANDLERS[this.command];
    if(!handler)
    {
        handler = this.dsp_default_handler;
    }
    handler.call(this);

    // Reset Inputs.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;
    this.write_buffer.clear();
};

SB16.prototype.dsp_default_handler = function()
{
    dbg_log("Unhandled command: " + h(this.command), LOG_SB16);
};

/**
 * @param {Array} commands
 * @param {number} size
 * @param {function()=} handler
 */
function register_dsp_command(commands, size, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.dsp_default_handler;
    }
    for(var i = 0; i < commands.length; i++)
    {
        DSP_COMMAND_SIZES[commands[i]] = size;
        DSP_COMMAND_HANDLERS[commands[i]] = handler;
    }
}

function any_first_digit(base)
{
    var commands = [];
    for(var i = 0; i < 16; i++)
    {
        commands.push(base + i);
    }
    return commands;
}

// ASP set register
register_dsp_command([0x0E], 2, function()
{
    this.asp_registers[this.write_buffer.shift()] = this.write_buffer.shift();
});

// ASP get register
register_dsp_command([0x0F], 1, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.asp_registers[this.write_buffer.shift()]);
});

// 8-bit direct mode single byte digitized sound output.
register_dsp_command([0x10], 1, function()
{
    var value = audio_normalize(this.write_buffer.shift(), 127.5, -1);

    this.dac_buffers[0].push(value);
    this.dac_buffers[1].push(value);
    this.bus.send("dac-enable");
});

// 8-bit single-cycle DMA mode digitized sound output.
register_dsp_command([0x14, 0x15], 2, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x16], 2);

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitzed sound output
// with reference byte.
register_dsp_command([0x17], 2);

// 8-bit auto-init DMA mode digitized sound output.
register_dsp_command([0x1C], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x1F], 0);

// 8-bit direct mode single byte digitized sound input.
register_dsp_command([0x20], 0, function()
{
    // One sample from the host ring (silence, 0x80, when there is none). Not paced: a guest that
    // polls this faster than the sampling rate simply drains the ring faster.
    this.read_buffer.clear();
    this.read_buffer.push(this.rec_pull_byte(false));
});

// 8-bit single-cycle DMA mode digitized sound input.
register_dsp_command([0x24], 2, function()
{
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_size_set();
    this.rec_start(false);
});

// 8-bit auto-init DMA mode digitized sound input.
// (What WfW 3.11's SNDBLST2.DRV issues for Sound Recorder: 0x48 block 0x7FF, then 0x2C, over a
// 4 KB autoinit DMA buffer; it stops with 0xD0 and then masks the DMA channel.)
register_dsp_command([0x2C], 0, function()
{
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.rec_start(true);
});

// Polling mode MIDI input.
register_dsp_command([0x30], 0);

// Interrupt mode MIDI input.
register_dsp_command([0x31], 0);

// UART polling mode MIDI I/O.
register_dsp_command([0x34], 0);

// UART interrupt mode MIDI I/O.
register_dsp_command([0x35], 0);

// UART polling mode MIDI I/O with time stamping.
register_dsp_command([0x36], 0);

// UART interrupt mode MIDI I/O with time stamping.
register_dsp_command([0x37], 0);

// MIDI output.
register_dsp_command([0x38], 0);

// Set digitized sound transfer Time Constant.
register_dsp_command([0x40], 1, function()
{
    // Note: bTimeConstant = 256 * time constant
    this.sampling_rate_change(
        1000000 / (256 - this.write_buffer.shift()) / this.get_channel_count()
    );
});

// Set digitized sound output sampling rate.
// Set digitized sound input sampling rate.
register_dsp_command([0x41, 0x42], 2, function()
{
    this.sampling_rate_change((this.write_buffer.shift() << 8) | this.write_buffer.shift());
});

// Set DSP block transfer size.
register_dsp_command([0x48], 2, function()
{
    // TODO: should be in bytes, but if this is only used
    // for 8 bit transfers, then this number is the same
    // as number of samples?
    // Wrong: e.g. stereo requires two bytes per sample.
    this.dma_transfer_size_set();
});

// Creative 8-bit to 4-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x74], 2);

// Creative 8-bit to 4-bit ADPCM single-cycle DMA mode digitized sound output
// with referene byte.
register_dsp_command([0x75], 2);

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x76], 2);

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output
// with referene byte.
register_dsp_command([0x77], 2);

// Creative 8-bit to 4-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7D], 0);

// Creative 8-bit to 3-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7F], 0);

// Pause DAC for a duration.
register_dsp_command([0x80], 2);

// 8-bit high-speed auto-init DMA mode digitized sound output.
register_dsp_command([0x90], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_highspeed = true;
    this.dsp_16bit = false;
    this.dma_transfer_start();
});

// 8-bit high-speed single-cycle DMA mode digitized sound input.
register_dsp_command([0x91, 0x99], 0, function()
{
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = true;
    this.rec_start(false);
});

// 8-bit high-speed auto-init DMA mode digitized sound input.
register_dsp_command([0x98], 0, function()
{
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = true;
    this.rec_start(true);
});

// Set input mode to mono.
register_dsp_command([0xA0], 0);

// Set input mode to stereo.
register_dsp_command([0xA8], 0);

// Program 16-bit DMA mode digitized sound I/O.
register_dsp_command(any_first_digit(0xB0), 3, function()
{
    if(this.command & (1 << 3))
    {
        // Analogue to digital not implemented.
        this.dsp_default_handler();
        return;
    }
    var mode = this.write_buffer.shift();
    this.dma_irq = SB_IRQ_16BIT;
    this.dma_channel = this.dma_channel_16bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dsp_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dsp_16bit = true;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Program 8-bit DMA mode digitized sound I/O.
register_dsp_command(any_first_digit(0xC0), 3, function()
{
    var mode = this.write_buffer.shift();
    if(this.command & (1 << 3))
    {
        // Analogue to digital (8-bit). Stereo input is written as the mono capture on both
        // channels.
        this.dsp_signed = !!(mode & (1 << 4));
        this.dsp_stereo = !!(mode & (1 << 5));
        this.dsp_16bit = false;
        this.dma_transfer_size_set();
        this.rec_start(!!(this.command & (1 << 2)));
        return;
    }
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dsp_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dsp_16bit = false;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Pause 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD0], 0, function()
{
    this.dma_paused = true;
    this.rec_paused = true;
    this.bus.send("dac-disable");
});

// Turn on speaker.
// Documented to have no effect on SB16.
register_dsp_command([0xD1], 0, function()
{
    this.dummy_speaker_enabled = true;
});

// Turn off speaker.
// Documented to have no effect on SB16.
register_dsp_command([0xD3], 0, function()
{
    this.dummy_speaker_enabled = false;
});

// Continue 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD4], 0, function()
{
    this.dma_paused = false;
    this.rec_paused = false;
    this.bus.send("dac-enable");
});

// Pause 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD5], 0, function()
{
    this.dma_paused = true;
    this.bus.send("dac-disable");
});

// Continue 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD6], 0, function()
{
    this.dma_paused = false;
    this.bus.send("dac-enable");
});

// Get speaker status.
register_dsp_command([0xD8], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.dummy_speaker_enabled * 0xFF);
});

// Exit 16-bit auto-init DMA mode digitized sound I/O.
// Exit 8-bit auto-init mode digitized sound I/O.
register_dsp_command([0xD9, 0xDA], 0, function()
{
    this.dma_autoinit = false;
    this.rec_autoinit = false;
});

// DSP identification
register_dsp_command([0xE0], 1, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(~this.write_buffer.shift());
});

// Get DSP version number.
register_dsp_command([0xE1], 0, function()
{
    this.read_buffer.clear();
    // responsive-wfw311: the DSP version can be presented as an older card (bus "sb16-dsp-version"
    // [major, minor]); Windows 3.x's own Sound Blaster drivers refuse a 4.x DSP.
    this.read_buffer.push(this.dsp_version_major === undefined ? 4 : this.dsp_version_major);
    this.read_buffer.push(this.dsp_version_minor === undefined ? 5 : this.dsp_version_minor);
});

// DMA identification.
register_dsp_command([0xE2], 1);

// Get DSP copyright.
register_dsp_command([0xE3], 0, function()
{
    this.read_buffer.clear();
    for(var i = 0; i < DSP_COPYRIGHT.length; i++)
    {
        this.read_buffer.push(DSP_COPYRIGHT.charCodeAt(i));
    }
    // Null terminator.
    this.read_buffer.push(0);
});

// Write test register.
register_dsp_command([0xE4], 1, function()
{
    this.test_register = this.write_buffer.shift();
});

// Read test register.
register_dsp_command([0xE8], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.test_register);
});

// Trigger IRQ - 8-bit
register_dsp_command([0xF2], 0, function()
{
    this.raise_irq(SB_IRQ_8BIT);
});

// Trigger IRQ - 16-bit
register_dsp_command([0xF3], 0, function()
{
    this.raise_irq(SB_IRQ_16BIT);
});

// ASP - unknown function
var SB_F9 = new Uint8Array(256);
SB_F9[0x0E] = 0xFF;
SB_F9[0x0F] = 0x07;
SB_F9[0x37] = 0x38;
register_dsp_command([0xF9], 1, function()
{
    var input = this.write_buffer.shift();
    dbg_log("dsp 0xf9: unknown function. input: " + input, LOG_SB16);

    this.read_buffer.clear();
    this.read_buffer.push(SB_F9[input]);
});

//
// Mixer Handlers (CT1745)
//

SB16.prototype.mixer_read = function(address)
{
    var handler = MIXER_READ_HANDLERS[address];
    var data;
    if(handler)
    {
        data = handler.call(this);
    }
    else
    {
        data = this.mixer_registers[address];
        dbg_log("unhandled mixer register read. addr:" + h(address) + " data:" + h(data), LOG_SB16);
    }
    return data;
};

SB16.prototype.mixer_write = function(address, data)
{
    var handler = MIXER_WRITE_HANDLERS[address];
    if(handler)
    {
        handler.call(this, data);
    }
    else
    {
        dbg_log("unhandled mixer register write. addr:" + h(address) + " data:" + h(data), LOG_SB16);
    }
};

SB16.prototype.mixer_default_read = function()
{
    dbg_log("mixer register read. addr:" + h(this.mixer_current_address), LOG_SB16);
    return this.mixer_registers[this.mixer_current_address];
};

SB16.prototype.mixer_default_write = function(data)
{
    dbg_log("mixer register write. addr:" + h(this.mixer_current_address) + " data:" + h(data), LOG_SB16);
    this.mixer_registers[this.mixer_current_address] = data;
};

SB16.prototype.mixer_reset = function()
{
    // Values intentionally in decimal.
    // Default values available at
    // https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf
    this.mixer_registers[0x04] = 12 << 4 | 12;
    this.mixer_registers[0x22] = 12 << 4 | 12;
    this.mixer_registers[0x26] = 12 << 4 | 12;
    this.mixer_registers[0x28] = 0;
    this.mixer_registers[0x2E] = 0;
    this.mixer_registers[0x0A] = 0;
    this.mixer_registers[0x30] = 24 << 3;
    this.mixer_registers[0x31] = 24 << 3;
    this.mixer_registers[0x32] = 24 << 3;
    this.mixer_registers[0x33] = 24 << 3;
    this.mixer_registers[0x34] = 24 << 3;
    this.mixer_registers[0x35] = 24 << 3;
    this.mixer_registers[0x36] = 0;
    this.mixer_registers[0x37] = 0;
    this.mixer_registers[0x38] = 0;
    this.mixer_registers[0x39] = 0;
    this.mixer_registers[0x3B] = 0;
    this.mixer_registers[0x3C] = 0x1F;
    this.mixer_registers[0x3D] = 0x15;
    this.mixer_registers[0x3E] = 0x0B;
    this.mixer_registers[0x3F] = 0;
    this.mixer_registers[0x40] = 0;
    this.mixer_registers[0x41] = 0;
    this.mixer_registers[0x42] = 0;
    this.mixer_registers[0x43] = 0;
    this.mixer_registers[0x44] = 8 << 4;
    this.mixer_registers[0x45] = 8 << 4;
    this.mixer_registers[0x46] = 8 << 4;
    this.mixer_registers[0x47] = 8 << 4;

    this.mixer_full_update();
};

SB16.prototype.mixer_full_update = function()
{
    // Start at 1. Don't re-reset.
    for(var i = 1; i < this.mixer_registers.length; i++)
    {
        if(MIXER_REGISTER_IS_LEGACY[i])
        {
            // Legacy registers are actually mapped to other register locations. Update
            // using the new registers rather than the legacy registers.
            continue;
        }
        this.mixer_write(i, this.mixer_registers[i]);
    }
};

/**
 * @param{number} address
 * @param{function():number=} handler
 */
function register_mixer_read(address, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.mixer_default_read;
    }
    MIXER_READ_HANDLERS[address] = handler;
}

/**
 * @param{number} address
 * @param{function(number)=} handler
 */
function register_mixer_write(address, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.mixer_default_write;
    }
    MIXER_WRITE_HANDLERS[address] = handler;
}

// Legacy registers map each nibble to the last 4 bits of the new registers
function register_mixer_legacy(address_old, address_new_left, address_new_right)
{
    MIXER_REGISTER_IS_LEGACY[address_old] = 1;

    /** @this {SB16} */
    MIXER_READ_HANDLERS[address_old] = function()
    {
        var left = this.mixer_registers[address_new_left] & 0xF0;
        var right = this.mixer_registers[address_new_right] >>> 4;
        return left | right;
    };

    /** @this {SB16} */
    MIXER_WRITE_HANDLERS[address_old] = function(data)
    {
        this.mixer_registers[address_old] = data;
        var prev_left = this.mixer_registers[address_new_left];
        var prev_right = this.mixer_registers[address_new_right];
        var left = (data & 0xF0) | (prev_left & 0x0F);
        var right = (data << 4 & 0xF0) | (prev_right & 0x0F);

        this.mixer_write(address_new_left, left);
        this.mixer_write(address_new_right, right);
    };
}

/**
 * @param {number} address
 * @param {number} mixer_source
 * @param {number} channel
 */
function register_mixer_volume(address, mixer_source, channel)
{
    MIXER_READ_HANDLERS[address] = SB16.prototype.mixer_default_read;

    /** @this {SB16} */
    MIXER_WRITE_HANDLERS[address] = function(data)
    {
        this.mixer_registers[address] = data;
        this.bus.send("mixer-volume",
        [
            mixer_source,
            channel,
            (data >>> 2) - 62
        ]);
    };
}

// Reset.
register_mixer_read(0x00, function()
{
    this.mixer_reset();
    return 0;
});
register_mixer_write(0x00);

// Legacy Voice Volume Left/Right.
register_mixer_legacy(0x04, 0x32, 0x33);

// Legacy Mic Volume. TODO.
//register_mixer_read(0x0A);
//register_mixer_write(0x0A, function(data)
//{
//    this.mixer_registers[0x0A] = data;
//    var prev = this.mixer_registers[0x3A];
//    this.mixer_write(0x3A, data << 5 | (prev & 0x0F));
//});

// Legacy Master Volume Left/Right.
register_mixer_legacy(0x22, 0x30, 0x31);
// Legacy Midi Volume Left/Right.
register_mixer_legacy(0x26, 0x34, 0x35);
// Legacy CD Volume Left/Right.
register_mixer_legacy(0x28, 0x36, 0x37);
// Legacy Line Volume Left/Right.
register_mixer_legacy(0x2E, 0x38, 0x39);

// Master Volume Left.
register_mixer_volume(0x30, MIXER_SRC_MASTER, MIXER_CHANNEL_LEFT);
// Master Volume Right.
register_mixer_volume(0x31, MIXER_SRC_MASTER, MIXER_CHANNEL_RIGHT);
// Voice Volume Left.
register_mixer_volume(0x32, MIXER_SRC_DAC, MIXER_CHANNEL_LEFT);
// Voice Volume Right.
register_mixer_volume(0x33, MIXER_SRC_DAC, MIXER_CHANNEL_RIGHT);
// MIDI Volume Left. TODO.
//register_mixer_volume(0x34, MIXER_SRC_SYNTH, MIXER_CHANNEL_LEFT);
// MIDI Volume Right. TODO.
//register_mixer_volume(0x35, MIXER_SRC_SYNTH, MIXER_CHANNEL_RIGHT);
// CD Volume Left. TODO.
//register_mixer_volume(0x36, MIXER_SRC_CD, MIXER_CHANNEL_LEFT);
// CD Volume Right. TODO.
//register_mixer_volume(0x37, MIXER_SRC_CD, MIXER_CHANNEL_RIGHT);
// Line Volume Left. TODO.
//register_mixer_volume(0x38, MIXER_SRC_LINE, MIXER_CHANNEL_LEFT);
// Line Volume Right. TODO.
//register_mixer_volume(0x39, MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT);
// Mic Volume. TODO.
//register_mixer_volume(0x3A, MIXER_SRC_MIC, MIXER_CHANNEL_BOTH);

// PC Speaker Volume.
register_mixer_read(0x3B);
register_mixer_write(0x3B, function(data)
{
    this.mixer_registers[0x3B] = data;
    this.bus.send("mixer-volume", [MIXER_SRC_PCSPEAKER, MIXER_CHANNEL_BOTH, (data >>> 6) * 6 - 18]);
});

// Output Mixer Switches. TODO.
//register_mixer_read(0x3C);
//register_mixer_write(0x3C, function(data)
//{
//    this.mixer_registers[0x3C] = data;
//
//    if(data & 0x01) this.bus.send("mixer-connect", [MIXER_SRC_MIC, MIXER_CHANNEL_BOTH]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_MIC, MIXER_CHANNEL_BOTH]);
//
//    if(data & 0x02) this.bus.send("mixer-connect", [MIXER_SRC_CD, MIXER_CHANNEL_RIGHT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_CD, MIXER_CHANNEL_RIGHT]);
//
//    if(data & 0x04) this.bus.send("mixer-connect", [MIXER_SRC_CD, MIXER_CHANNEL_LEFT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_CD, MIXER_CHANNEL_LEFT]);
//
//    if(data & 0x08) this.bus.send("mixer-connect", [MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT]);
//
//    if(data & 0x10) this.bus.send("mixer-connect", [MIXER_SRC_LINE, MIXER_CHANNEL_LEFT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_LINE, MIXER_CHANNEL_LEFT]);
//});

// Input Mixer Left Switches. TODO.
//register_mixer_read(0x3D);
//register_mixer_write(0x3D);

// Input Mixer Right Switches. TODO.
//register_mixer_read(0x3E);
//register_mixer_write(0x3E);

// Input Gain Left. TODO.
//register_mixer_read(0x3F);
//register_mixer_write(0x3F);

// Input Gain Right. TODO.
//register_mixer_read(0x40);
//register_mixer_write(0x40);

// Output Gain Left.
register_mixer_read(0x41);
register_mixer_write(0x41, function(data)
{
    this.mixer_registers[0x41] = data;
    this.bus.send("mixer-gain-left", (data >>> 6) * 6);
});

// Output Gain Right.
register_mixer_read(0x42);
register_mixer_write(0x42, function(data)
{
    this.mixer_registers[0x42] = data;
    this.bus.send("mixer-gain-right", (data >>> 6) * 6);
});

// Mic AGC. TODO.
//register_mixer_read(0x43);
//register_mixer_write(0x43);

// Treble Left.
register_mixer_read(0x44);
register_mixer_write(0x44, function(data)
{
    this.mixer_registers[0x44] = data;
    data >>>= 3;
    this.bus.send("mixer-treble-left", data - (data < 16 ? 14 : 16));
});

// Treble Right.
register_mixer_read(0x45);
register_mixer_write(0x45, function(data)
{
    this.mixer_registers[0x45] = data;
    data >>>= 3;
    this.bus.send("mixer-treble-right", data - (data < 16 ? 14 : 16));
});

// Bass Left.
register_mixer_read(0x46);
register_mixer_write(0x46, function(data)
{
    this.mixer_registers[0x46] = data;
    data >>>= 3;
    this.bus.send("mixer-bass-right", data - (data < 16 ? 14 : 16));
});

// Bass Right.
register_mixer_read(0x47);
register_mixer_write(0x47, function(data)
{
    this.mixer_registers[0x47] = data;
    data >>>= 3;
    this.bus.send("mixer-bass-right", data - (data < 16 ? 14 : 16));
});

// IRQ Select.
register_mixer_read(0x80, function()
{
    switch(this.irq)
    {
        case SB_IRQ2: return 0x1;
        case SB_IRQ5: return 0x2;
        case SB_IRQ7: return 0x4;
        case SB_IRQ10: return 0x8;
        default: return 0x0;
    }
});
register_mixer_write(0x80, function(bits)
{
    if(bits & 0x1) this.irq = SB_IRQ2;
    if(bits & 0x2) this.irq = SB_IRQ5;
    if(bits & 0x4) this.irq = SB_IRQ7;
    if(bits & 0x8) this.irq = SB_IRQ10;
});

// DMA Select.
register_mixer_read(0x81, function()
{
    var ret = 0;
    switch(this.dma_channel_8bit)
    {
        case SB_DMA0: ret |= 0x1; break;
        case SB_DMA1: ret |= 0x2; break;
        // Channel 2 is hardwired to floppy disk.
        case SB_DMA3: ret |= 0x8; break;
    }
    switch(this.dma_channel_16bit)
    {
        // Channel 4 cannot be used.
        case SB_DMA5: ret |= 0x20; break;
        case SB_DMA6: ret |= 0x40; break;
        case SB_DMA7: ret |= 0x80; break;
    }
    return ret;
});
register_mixer_write(0x81, function(bits)
{
    if(bits & 0x1) this.dma_channel_8bit = SB_DMA0;
    if(bits & 0x2) this.dma_channel_8bit = SB_DMA1;
    if(bits & 0x8) this.dma_channel_8bit = SB_DMA3;
    if(bits & 0x20) this.dma_channel_16bit = SB_DMA5;
    if(bits & 0x40) this.dma_channel_16bit = SB_DMA6;
    if(bits & 0x80) this.dma_channel_16bit = SB_DMA7;
});

// IRQ Status.
register_mixer_read(0x82, function()
{
    var ret = 0x20;
    for(var i = 0; i < 16; i++)
    {
        ret |= i * this.irq_triggered[i];
    }
    return ret;
});

//
// General behaviours
//

SB16.prototype.sampling_rate_change = function(rate)
{
    this.sampling_rate = rate;
    this.bus.send("dac-tell-sampling-rate", rate);
};

SB16.prototype.get_channel_count = function()
{
    return this.dsp_stereo ? 2 : 1;
};

SB16.prototype.dma_transfer_size_set = function()
{
    this.dma_sample_count = 1 + (this.write_buffer.shift() << 0) + (this.write_buffer.shift() << 8);
};

SB16.prototype.dma_transfer_start = function()
{
    dbg_log("begin dma transfer", LOG_SB16);

    // (1) Setup appropriate settings.

    this.bytes_per_sample = 1;
    if(this.dsp_16bit) this.bytes_per_sample *= 2;

    // Don't count stereo interleaved bits apparently.
    // Disabling this line is needed for sounds to work correctly,
    // especially double buffering autoinit mode.
    // Learnt the hard way.
    // if(this.dsp_stereo) this.bytes_per_sample *= 2;

    this.dma_bytes_count = this.dma_sample_count * this.bytes_per_sample;
    this.dma_bytes_block = SB_DMA_BLOCK_SAMPLES * this.bytes_per_sample;
    if(this.trace) console.log("[sb16] dma start: ch " + this.dma_channel + " samples " + this.dma_sample_count +
        " rate " + this.sampling_rate + " autoinit " + this.dma_autoinit + " 16bit " + this.dsp_16bit +
        " stereo " + this.dsp_stereo + " masked " + this.dma.channel_mask[this.dma_channel]);

    // Ensure block size is small enough but not too small, and is divisible by 4
    var max_bytes_block = Math.max(this.dma_bytes_count >> 2 & ~0x3, 32);
    this.dma_bytes_block = Math.min(max_bytes_block, this.dma_bytes_block);

    // (2) Wait until channel is unmasked (if not already)
    this.dma_waiting_transfer = true;
    if(!this.dma.channel_mask[this.dma_channel])
    {
        this.dma_on_unmask(this.dma_channel);
    }
};

SB16.prototype.dma_on_unmask = function(channel)
{
    if(channel !== this.dma_channel || !this.dma_waiting_transfer)
    {
        return;
    }

    // (3) Configure amount of bytes left to transfer and tell speaker adapter
    // to start requesting transfers
    this.dma_waiting_transfer = false;
    this.dma_bytes_left = this.dma_bytes_count;
    this.dma_paused = false;
    this.bus.send("dac-enable");
};

SB16.prototype.dma_transfer_next = function()
{
    dbg_log("dma transfering next block", LOG_SB16);

    var size = Math.min(this.dma_bytes_left, this.dma_bytes_block);
    var samples = Math.floor(size / this.bytes_per_sample);

    this.dma.do_write(this.dma_syncbuffer, 0, size, this.dma_channel, (error) =>
    {
        dbg_log("dma block transfer " + (error ? "unsuccessful" : "successful"), LOG_SB16);
        if(error) return;

        this.dma_to_dac(samples);
        this.dma_bytes_left -= size;

        if(!this.dma_bytes_left)
        {
            // Completed requested transfer of given size.
            this.raise_irq(this.dma_irq);

            if(this.dma_autoinit)
            {
                // Restart the transfer.
                this.dma_bytes_left = this.dma_bytes_count;
            }
        }
    });
};

SB16.prototype.dma_to_dac = function(sample_count)
{
    var amplitude = this.dsp_16bit ? 32767.5 : 127.5;
    var offset = this.dsp_signed ? 0 : -1;
    var repeats = this.dsp_stereo ? 1 : 2;

    var buffer;
    if(this.dsp_16bit)
    {
        buffer = this.dsp_signed ? this.dma_buffer_int16 : this.dma_buffer_uint16;
    }
    else
    {
        buffer = this.dsp_signed ? this.dma_buffer_int8 : this.dma_buffer_uint8;
    }

    var channel = 0;
    for(var i = 0; i < sample_count; i++)
    {
        var sample = audio_normalize(buffer[i], amplitude, offset);
        for(var j = 0; j < repeats; j++)
        {
            this.dac_buffers[channel].push(sample);
            channel ^= 1;
        }
    }

    this.dac_send();
};

//
// Recording (ADC -> DMA) behaviours
//

// Host capture arrives here: mono float samples at the host's rate.
SB16.prototype.rec_push = function(samples, rate)
{
    if(!samples || !samples.length) return;
    if(rate > 0) this.rec_host_rate = rate;
    this.rec_host_seen = true;

    var ring = this.rec_ring, size = SB_REC_RING_SIZE;
    for(var i = 0; i < samples.length; i++)
    {
        ring[(this.rec_ring_w + i) % size] = samples[i];
    }
    this.rec_ring_w += samples.length;

    // Bound the latency: if the DSP has fallen far behind (it was not recording, or the tab was
    // throttled), skip ahead so what it reads next is recent.
    var lag = this.rec_ring_w - this.rec_ring_r;
    if(lag > SB_REC_MAX_LAG)
    {
        this.rec_ring_r = this.rec_ring_w - SB_REC_MAX_LAG / 2;
    }
};

// One 8-bit sample for the DSP, resampled from the host ring; 0x80 (or 0 signed) when there is
// nothing to read.
SB16.prototype.rec_pull_byte = function(signed)
{
    var v = 0;
    var r = this.rec_ring_r;
    if(r + 1 < this.rec_ring_w)
    {
        var i0 = Math.floor(r), f = r - i0;
        var size = SB_REC_RING_SIZE;
        var a = this.rec_ring[i0 % size], b = this.rec_ring[(i0 + 1) % size];
        v = a + (b - a) * f;
        this.rec_ring_r = r + this.rec_host_rate / this.sampling_rate;
    }
    v = audio_clip(v, -1, 1);
    var byte = Math.round(v * 127) + (signed ? 0 : 128);
    return byte & 0xFF;
};

SB16.prototype.rec_start = function(autoinit)
{
    this.rec_channel = this.dma_channel_8bit;
    this.rec_autoinit = autoinit;
    // Block size in bytes; stereo input writes two bytes per sample pair.
    this.rec_bytes_count = this.dma_sample_count * (this.dsp_stereo ? 2 : 1);
    this.rec_bytes_left = this.rec_bytes_count;
    this.rec_owed = 0;
    this.rec_paused = false;
    this.rec_last_time = v86.microtick();
    this.rec_active = true;
    // Start reading recent host samples, not whatever was buffered while idle.
    this.rec_ring_r = this.rec_ring_w;
    if(this.trace) console.log("[sb16] rec start: ch " + this.rec_channel + " block " + this.rec_bytes_count +
        " rate " + this.sampling_rate + " autoinit " + autoinit + " stereo " + this.dsp_stereo +
        " signed " + this.dsp_signed + " masked " + this.dma.channel_mask[this.rec_channel]);
    this.bus.send("sb16-record-start", this.sampling_rate);
};

SB16.prototype.rec_stop = function()
{
    if(!this.rec_active) return;
    this.rec_active = false;
    this.rec_paused = false;
    this.rec_bytes_left = 0;
    if(this.trace) console.log("[sb16] rec stop");
    this.bus.send("sb16-record-stop");
};

// Called from the CPU's hardware timer loop with the wall clock in milliseconds. Both the OPL
// renderer and the recording path are paced by real time rather than by emulated time, so audio
// keeps its rate whatever the guest is doing. Returns the milliseconds until the next one is due.
SB16.prototype.timer = function(now)
{
    var opl_next = this.opl_timer(now);
    var rec_next = this.rec_timer(now);
    return opl_next < rec_next ? opl_next : rec_next;
};

// Render the OPL samples that have become due and send them to the page. Nothing is generated
// while every envelope is off, so an idle Windows costs one array scan per tick.
SB16.prototype.opl_timer = function(now)
{
    this.opl.timers_advance(now);
    if(!this.opl.any_active())
    {
        this.opl_last_time = now;
        this.opl_owed = 0;
        if(this.opl_playing)
        {
            this.opl_playing = false;
            this.bus.send("opl-idle");
            if(this.trace) console.log("[sb16] opl idle after " + this.opl_blocks + " blocks, " +
                                       this.opl_samples + " samples, " + this.opl.writes + " register writes");
        }
        return 100;
    }

    if(!this.opl_playing)
    {
        this.opl_playing = true;
        this.opl_last_time = now;
        this.opl_owed = 0;
        this.opl_blocks = 0;
        this.opl_samples = 0;
        if(this.trace) console.log("[sb16] opl start (" + this.opl.writes + " register writes so far)");
    }

    var elapsed = now - this.opl_last_time;
    this.opl_last_time = now;
    if(elapsed > 0) this.opl_owed += elapsed * OPL_RATE / 1000;
    // After a stall (a throttled tab) do not dump a second of catch-up into the page: drop it.
    if(this.opl_owed > OPL_MAX_OWED) this.opl_owed = OPL_MAX_OWED;

    var count = this.opl_owed | 0;
    if(count >= OPL_MIN_BLOCK)
    {
        if(count > OPL_MAX_BLOCK) count = OPL_MAX_BLOCK;
        this.opl_owed -= count;
        var left = new Float32Array(count), right = new Float32Array(count);
        this.opl.generate(left, right, count);
        this.opl_blocks++;
        this.opl_samples += count;
        this.bus.send("opl-send-data", [left, right], [left.buffer, right.buffer]);
    }
    return 4;
};

SB16.prototype.rec_timer = function(now)
{
    if(!this.rec_active)
    {
        return 100;
    }

    if(this.rec_paused)
    {
        // A paused recording that the driver then masks the DMA channel of is over: that is
        // how SNDBLST2.DRV stops (0xD0, then mask). Otherwise wait for 0xD4.
        if(this.dma.channel_mask[this.rec_channel])
        {
            this.rec_stop();
        }
        this.rec_last_time = now;
        return 100;
    }

    var rate = this.sampling_rate * (this.dsp_stereo ? 2 : 1);   // bytes per second
    var elapsed = now - this.rec_last_time;
    this.rec_last_time = now;
    if(elapsed > 0)
    {
        this.rec_owed += elapsed * rate / 1000;
    }
    // After a stall (throttled tab) do not flood the guest with interrupts: at most two blocks
    // are made up, the rest of the lost time is dropped.
    var cap = Math.max(2 * this.rec_bytes_count, 1024);
    if(this.rec_owed > cap) this.rec_owed = cap;

    var n = Math.floor(this.rec_owed);
    while(n > 0 && this.rec_active)
    {
        var chunk = Math.min(n, this.rec_bytes_left, this.rec_buffer.length);
        var signed = this.dsp_signed;
        if(this.dsp_stereo)
        {
            for(var i = 0; i < chunk; i += 2)
            {
                var s = this.rec_pull_byte(signed);
                this.rec_buffer[i] = s;
                this.rec_buffer[i + 1] = s;
            }
        }
        else
        {
            for(var j = 0; j < chunk; j++)
            {
                this.rec_buffer[j] = this.rec_pull_byte(signed);
            }
        }

        var written = this.dma.do_read_sync(this.rec_buffer, chunk, this.rec_channel);
        // Time passes whether or not the DMA channel accepted the bytes (masked channel or
        // single-mode terminal count): the samples are consumed either way.
        this.rec_owed -= chunk;
        n -= chunk;
        this.rec_bytes_left -= chunk;

        if(written < chunk && this.trace)
        {
            console.log("[sb16] rec: dma accepted " + written + " of " + chunk + " bytes");
        }

        if(this.rec_bytes_left === 0)
        {
            this.raise_irq(SB_IRQ_8BIT);
            if(this.rec_autoinit)
            {
                this.rec_bytes_left = this.rec_bytes_count;
            }
            else
            {
                this.rec_stop();
            }
        }
    }

    if(!this.rec_active) return 100;
    var next = (this.rec_bytes_left - this.rec_owed) * 1000 / rate;
    return Math.max(1, Math.min(next, 20));
};

SB16.prototype.dac_handle_request = function()
{
    if(!this.dma_bytes_left || this.dma_paused)
    {
        // No more data to transfer or is paused. Send whatever is in the buffers.
        this.dac_send();
    }
    else
    {
        this.dma_transfer_next();
    }
};

SB16.prototype.dac_send = function()
{
    if(!this.dac_buffers[0].length)
    {
        return;
    }

    var out0 = this.dac_buffers[0].shift_block(this.dac_buffers[0].length);
    var out1 = this.dac_buffers[1].shift_block(this.dac_buffers[1].length);
    this.bus.send("dac-send-data", [out0, out1], [out0.buffer, out1.buffer]);
};

SB16.prototype.raise_irq = function(type)
{
    dbg_log("raise irq", LOG_SB16);
    if(this.trace) console.log("[sb16] raise irq " + this.irq + " type " + type);
    this.irq_triggered[type] = 1;
    this.cpu.device_raise_irq(this.irq);
};

SB16.prototype.lower_irq = function(type)
{
    dbg_log("lower irq", LOG_SB16);
    if(this.trace && this.irq_triggered[type]) console.log("[sb16] lower irq " + this.irq + " type " + type);
    this.irq_triggered[type] = 0;
    this.cpu.device_lower_irq(this.irq);
};

//
// Helpers
//

function audio_normalize(value, amplitude, offset)
{
    return audio_clip(value / amplitude + offset, -1, 1);
}

function audio_clip(value, low, high)
{
    return (value < low) * low + (value > high) * high + (low <= value && value <= high) * value;
}
