import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
// Pinned noVNC constants (the package exports map only exposes ./core/rfb.js,
// so the test helper reaches into node_modules by path).
import { encodings } from '../node_modules/@novnc/novnc/core/encodings.js';

// 32bpp / 24bit true colour, little endian. Like QEMU, the byte order on the wire
// is R,G,B,X (red-shift 0); noVNC's raw decoder copies the bytes straight into the
// canvas, so a big-endian shift declaration would swap red and blue.
const PIXEL_FORMAT = Buffer.from([
  32, 24, 0, 1,
  0x00, 0xff, 0x00, 0xff, 0x00, 0xff,
  0, 8, 16,
  0, 0, 0,
]);

const QEMU_EXT_KEY_EVENT = encodings.pseudoEncodingQEMUExtendedKeyEvent;
const RAW_ENCODING = encodings.encodingRaw;

/**
 * Minimal RFB 3.008 server used by the offline end-to-end test.
 * Like PVE's vncwebsocket endpoint it carries the RFB byte stream inside a
 * WebSocket. It performs VNC authentication (type 2), serves one solid-colour
 * raw framebuffer and records every key/pointer message it receives.
 */
export class FakeVncServer {
  constructor({
    width = 64, height = 48, name = 'fake-pve-console',
    color = { r: 201, g: 32, b: 43 }, pattern = null, advertiseQemuExtKey = false, maxUpdates = 6, rejectAuth = false,
    partialFirstUpdate = false,
  } = {}) {
    this.partialFirstUpdate = partialFirstUpdate;
    this.sentPartialFirstUpdate = false;
    this.pattern = pattern;
    this.rejectAuth = rejectAuth;
    this.width = width;
    this.height = height;
    this.name = name;
    this.color = color;
    this.advertiseQemuExtKey = advertiseQemuExtKey;
    this.maxUpdates = maxUpdates;
    this.events = {
      clientVersion: null, chosenSecurityType: null, authResponse: null, sharedFlag: null,
      pixelFormat: null, encodings: null, keyEvents: [], qemuKeyEvents: [], pointerEvents: [], cutText: [],
    };
    this.errors = [];
    this.updateCount = 0;
    this.qemuAdvertised = false;
    this.clientWantsQemuExtKey = false;
    this.server = null;
  }

  async listen() {
    this.server = new WebSocketServer({
      host: '127.0.0.1', port: 0,
      handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
    });
    this.server.on('connection', socket => this.handle(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.once('listening', resolve);
    });
    this.port = this.server.address().port;
    return this.url = `ws://127.0.0.1:${this.port}/console`;
  }

  close() {
    return new Promise(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }

  handle(socket) {
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    const waiters = [];
    socket.on('message', chunk => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      while (waiters.length && buffered.length >= waiters[0].bytes) {
        const waiter = waiters.shift();
        waiter.resolve(Buffer.from(buffered.subarray(0, waiter.bytes)));
        buffered = buffered.subarray(waiter.bytes);
      }
    });
    socket.on('close', () => { for (const waiter of waiters.splice(0)) waiter.reject(new Error('socket closed')); });
    const read = bytes => new Promise((resolve, reject) => {
      if (buffered.length >= bytes) {
        resolve(Buffer.from(buffered.subarray(0, bytes)));
        buffered = buffered.subarray(bytes);
        return;
      }
      waiters.push({ bytes, resolve, reject });
    });
    const write = data => new Promise((resolve, reject) => socket.send(data, { binary: true }, error => (error ? reject(error) : resolve())));
    this.run(socket, read, write).catch(error => { this.errors.push(String(error.message)); try { socket.terminate(); } catch {} });
  }

  async run(socket, read, write) {
    this.socket = socket;
    this.write = write;
    await write(Buffer.from('RFB 003.008\n'));
    this.events.clientVersion = (await read(12)).toString().trim();
    await write(Buffer.from([1, 2]));                       // one security type: VNC auth
    this.events.chosenSecurityType = (await read(1))[0];
    if (this.events.chosenSecurityType !== 2) throw new Error(`client chose security type ${this.events.chosenSecurityType}`);
    await write(crypto.randomBytes(16));                     // challenge
    this.events.authResponse = await read(16);               // DES response (accepted as-is)
    if (this.rejectAuth) {                                   // SecurityResult: failed + reason (RFB 3.8)
      const reason = Buffer.from('authentication failure', 'utf8');
      const failure = Buffer.alloc(8 + reason.length);
      failure.writeUInt32BE(1, 0);                 // SecurityResult: failed
      failure.writeUInt32BE(reason.length, 4);     // RFB 3.8 reason length
      reason.copy(failure, 8);
      await write(failure);
      socket.terminate();
      return;
    }
    await write(Buffer.from([0, 0, 0, 0]));                  // SecurityResult: OK
    this.events.sharedFlag = (await read(1))[0];             // ClientInit

    const nameBytes = Buffer.from(this.name, 'utf8');
    const serverInit = Buffer.alloc(24 + nameBytes.length);
    serverInit.writeUInt16BE(this.width, 0);
    serverInit.writeUInt16BE(this.height, 2);
    PIXEL_FORMAT.copy(serverInit, 4);
    serverInit.writeUInt32BE(nameBytes.length, 20);
    nameBytes.copy(serverInit, 24);
    await write(serverInit);

    while (socket.readyState === 1) {
      const type = (await read(1))[0];
      if (type === 0) {                                     // SetPixelFormat
        this.events.pixelFormat = await read(19);
      } else if (type === 2) {                              // SetEncodings
        await read(1);
        const count = (await read(2)).readUInt16BE(0);
        const raw = await read(count * 4);
        this.events.encodings = Array.from({ length: count }, (_, index) => raw.readInt32BE(index * 4));
        this.clientWantsQemuExtKey = this.events.encodings.includes(QEMU_EXT_KEY_EVENT);
      } else if (type === 3) {                              // FramebufferUpdateRequest
        const request = await read(9);
        this.pendingRequest = true;
        await this.sendUpdate(write, request[0] === 1);
      } else if (type === 4) {                              // KeyEvent
        const body = await read(7);
        this.events.keyEvents.push({ down: body[0] === 1, keysym: body.readUInt32BE(3) });
      } else if (type === 5) {                              // PointerEvent
        const body = await read(5);
        this.events.pointerEvents.push({ mask: body[0], x: body.readUInt16BE(1), y: body.readUInt16BE(3) });
      } else if (type === 6) {                              // ClientCutText
        await read(3);
        const length = (await read(4)).readUInt32BE(0);
        this.events.cutText.push((await read(length)).toString('utf8'));
      } else if (type === 255) {                            // QEMUExtendedKeyEvent
        const body = await read(11);
        this.events.qemuKeyEvents.push({ down: body.readUInt16BE(1) === 1, keysym: body.readUInt32BE(3), keycode: body.readUInt32BE(7) });
      } else {
        throw new Error(`unsupported client message type ${type}`);
      }
    }
  }

  /** Pushes a framebuffer update on demand, bypassing the update cap. */
  async pushUpdate(color) {
    if (!this.write || this.socket?.readyState !== 1) return false;
    if (color) this.color = color;
    await this.sendUpdate(this.write, false, true);
    return true;
  }

  /** Solid colour, or four known quadrants so pixel order can be checked visually. */
  pixelAt(x, y) {
    if (this.pattern !== 'quadrants') return this.color;
    const right = x >= this.width / 2;
    const bottom = y >= this.height / 2;
    if (!bottom && !right) return { r: 255, g: 0, b: 0 };     // top-left red
    if (!bottom && right) return { r: 0, g: 255, b: 0 };      // top-right green
    if (bottom && !right) return { r: 0, g: 0, b: 255 };      // bottom-left blue
    return { r: 255, g: 255, b: 255 };                        // bottom-right white
  }

  async sendUpdate(write, incremental, force = false) {
    if (!force && this.updateCount >= this.maxUpdates) return;
    if (!force && incremental && this.updateCount >= 2) return;
    this.updateCount++;

    const rects = [];
    if (this.advertiseQemuExtKey && this.clientWantsQemuExtKey && !this.qemuAdvertised) {
      this.qemuAdvertised = true;
      const pseudo = Buffer.alloc(12);
      pseudo.writeInt32BE(QEMU_EXT_KEY_EVENT, 8);            // zero sized pseudo encoding rect
      rects.push(pseudo);
    }
    // Emulate a server whose first update only carries damaged regions, so the
    // client must request a full frame before the backbuffer is trustworthy.
    const partial = this.partialFirstUpdate && !this.sentPartialFirstUpdate;
    this.sentPartialFirstUpdate = true;
    const rectHeight = partial ? Math.max(1, Math.floor(this.height / 2)) : this.height;
    const raw = Buffer.alloc(this.width * rectHeight * 4);
    for (let y = 0; y < rectHeight; y++) {
      for (let x = 0; x < this.width; x++) {
        const offset = (y * this.width + x) * 4;
        const pixel = this.pixelAt(x, y);
        raw[offset] = pixel.r;        // wire order is R,G,B,X (red-shift 0)
        raw[offset + 1] = pixel.g;
        raw[offset + 2] = pixel.b;
      }
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(this.width, 4);
    header.writeUInt16BE(rectHeight, 6);
    header.writeInt32BE(RAW_ENCODING, 8);
    rects.push(Buffer.concat([header, raw]));

    const message = Buffer.alloc(4);
    message.writeUInt16BE(rects.length, 2);
    await write(Buffer.concat([message, ...rects]));
  }
}
