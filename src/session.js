import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ConsoleBridge } from './bridge.js';
import { PveApi } from './pve-api.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const firstLine = text => String(text || '').split('\n')[0].slice(0, 240);

/**
 * Owns one console session: PVE ticket -> loopback bridge -> headless
 * Chromium running the noVNC adapter page. The browser never sees PVE
 * credentials or the API ticket; it only gets the bridge URL and the
 * short lived 8 character RFB password.
 */
export class ConsoleSession {
  constructor(config, { ticketProvider } = {}) {
    this.config = config;
    this.api = new PveApi(config);
    // Injectable for offline tests: defaults to real PVE authentication + vncproxy.
    this.ticketProvider = ticketProvider || (async () => {
      this.auth = await this.api.authenticate();
      return await this.api.openConsole();
    });
    this.browser = null;
    this.context = null;
    this.page = null;
    this.bridge = null;
    this.auth = null;
    this.vmName = null;
    this.sandboxDisabled = false;
    this.notes = [];
    this.pageErrors = [];
    this.upstreamClosed = null;
    this.framebuffer = { width: 0, height: 0 };
  }

  async start() {
    if (!fs.existsSync(path.join(webRoot, 'dist/console.bundle.js'))) {
      throw new Error('web/dist/console.bundle.js is missing; run `npm run build` in the pve-computer-use directory');
    }
    await this.launchBrowser();
    await this.openConsole();
    return this.state();
  }

  async launchBrowser() {
    if (this.browser) return;
    if (!fs.existsSync(this.config.executablePath)) {
      throw new Error(`Chrome executable not found at ${this.config.executablePath}; set executablePath in the config`);
    }
    const args = ['--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--no-first-run', '--disable-background-networking'];
    try {
      this.browser = await chromium.launch({ headless: true, executablePath: this.config.executablePath, args });
    } catch (error) {
      this.sandboxDisabled = true;
      this.notes.push(`chromium sandbox disabled after: ${firstLine(error.message)}`);
      this.browser = await chromium.launch({
        headless: true, executablePath: this.config.executablePath,
        args: [...args, '--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    this.page = await this.context.newPage();
    this.page.on('pageerror', error => this.pageErrors.push(firstLine(error.message)));
    this.page.on('console', message => { if (message.type() === 'error') this.pageErrors.push(firstLine(message.text())); });
  }

  /** Requests a fresh ticket and (re)connects the page to it. */
  async openConsole() {
    const ticket = await this.ticketProvider();
    if (!ticket?.upstreamUrl) throw new Error('Console ticket provider returned no upstream URL');
    if (!ticket.password) throw new Error('Console ticket provider returned no RFB password');
    this.vmName = ticket.vmName;
    this.upstreamClosed = null;
    this.bridge?.close().catch(() => {});
    this.bridge = await new ConsoleBridge({
      upstreamUrl: ticket.upstreamUrl, headers: ticket.headers, tlsOptions: ticket.tlsOptions, webRoot,
      onUpstreamClosed: reason => { this.upstreamClosed = reason; },
    }).start();

    if (this.pageErrors.length > 40) this.pageErrors = this.pageErrors.slice(-20);
    await this.page.goto(this.bridge.pageUrl, { waitUntil: 'load', timeout: 20_000 });
    await this.page.evaluate(
      ({ url, password }) => window.pveConsole.startConsole({ url, password }),
      { url: this.bridge.rfbUrl, password: ticket.password }
    );
    const report = await this.page.evaluate(timeout => window.pveConsole.waitConnected(timeout), this.config.connectTimeoutMs);
    await this.fitViewport(report);
    return report;
  }

  async ensureAlive() {
    if (!this.page) throw new Error('Console session is not started');
    if (this.upstreamClosed) {
      const reason = this.upstreamClosed;
      await this.openConsole().catch(error => { throw new Error(`Console dropped (${reason}) and reconnect failed: ${firstLine(error.message)}`); });
    }
    const report = await this.evaluate('consoleState');
    if (!report.connected) {
      const reason = report.failure || this.upstreamClosed || 'console disconnected';
      await this.openConsole().catch(error => { throw new Error(`Console dropped (${reason}) and reconnect failed: ${firstLine(error.message)}`); });
    }
  }

  async evaluate(fn, arg) {
    return await this.page.evaluate(({ fn, arg }) => window.pveConsole[fn](arg), { fn, arg });
  }

  /** Keeps the headless viewport equal to the guest framebuffer (canvas px == fb px). */
  async fitViewport(report) {
    const width = Number(report?.width) || 0;
    const height = Number(report?.height) || 0;
    if (width < 1 || height < 1) return;                     // size unknown: keep the current viewport
    const size = { width: Math.min(width, this.config.maxViewport), height: Math.min(height, this.config.maxViewport) };
    if (size.width === this.framebuffer.width && size.height === this.framebuffer.height) return;
    this.framebuffer = size;
    await this.page.setViewportSize(size).catch(() => {});
  }

  async state() {
    const report = this.page ? await this.evaluate('consoleState') : { connected: false, width: 0, height: 0 };
    return {
      target: this.config.target, endpoint: this.config.endpoint, node: this.config.node, vmid: this.config.vmid,
      vmName: this.vmName, authMethod: this.auth?.method || null, connected: report.connected,
      failure: report.failure || this.upstreamClosed || null, framebufferUpdates: report.framebufferUpdates ?? 0,
      lastUpdateAt: report.lastUpdateAt || null, width: report.width, height: report.height,
      desktopName: report.desktopName || null, heldKeys: report.heldKeys ?? 0, mouseMask: report.mouseMask ?? 0,
      bridge: this.bridge ? this.bridge.origin : null, sandboxDisabled: this.sandboxDisabled,
      tlsMode: this.config.tlsMode || (this.config.insecureTls ? 'insecure' : 'system-trust'),
      insecureTls: this.config.insecureTls, imageFormat: this.config.imageFormat, notes: this.notes, pageErrors: this.pageErrors.slice(-5),
    };
  }

  async capture() {
    const frame = await this.evaluate('captureFrame', { format: this.config.imageFormat, jpegQuality: this.config.jpegQuality });
    await this.fitViewport(frame);
    return frame;
  }

  async close() {
    for (const task of [
      () => this.page?.evaluate(() => window.pveConsole.releaseAll({})),
      () => this.bridge?.close(),
      () => this.context?.close(),
      () => this.browser?.close(),
    ]) { try { await task(); } catch {} }
    this.page = null; this.context = null; this.browser = null; this.bridge = null;
  }
}
