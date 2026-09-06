import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const MAX_PAYLOAD = 64 * 1024 * 1024;

/**
 * Loopback-only bridge: serves the noVNC adapter page and pipes its
 * WebSocket to the PVE console endpoint, so PVE credentials, the VNC
 * ticket and TLS verification stay inside the daemon process.
 */
export class ConsoleBridge {
  constructor({ upstreamUrl, headers = {}, tlsOptions = {}, webRoot, onUpstreamClosed }) {
    this.upstreamUrl = upstreamUrl;
    this.headers = headers;
    this.tlsOptions = tlsOptions;
    this.webRoot = webRoot;
    this.onUpstreamClosed = onUpstreamClosed;
    this.token = crypto.randomBytes(24).toString('base64url');
    this.upstream = null;
    this.server = null;
    this.wss = null;
  }

  async start() {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
    });
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.pageUrl = `${this.origin}/`;
    this.rfbUrl = `ws://127.0.0.1:${this.server.address().port}/rfb?token=${this.token}`;
    return this;
  }

  serve(req, res) {
    const path = (req.url || '/').split('?')[0];
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const files = { '/': ['console.html', 'text/html; charset=utf-8'], '/console.bundle.js': ['dist/console.bundle.js', 'text/javascript; charset=utf-8'] };
    const entry = files[path];
    if (!entry) { res.writeHead(404).end('not found'); return; }
    fs.readFile(`${this.webRoot}/${entry[0]}`, (error, body) => {
      if (error) { res.writeHead(500).end('console bundle missing; run npm run build'); return; }
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }).end(body);
    });
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, this.origin);
    if (url.pathname !== '/rfb' || url.searchParams.get('token') !== this.token) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, client => this.attach(client));
  }

  attach(client) {
    if (this.upstream) { try { this.upstream.close(); } catch {} }
    const upstream = this.upstream = new WebSocket(this.upstreamUrl, ['binary'], {
      headers: this.headers, ...this.tlsOptions, perMessageDeflate: false, maxPayload: MAX_PAYLOAD,
    });
    const queued = [];
    const closed = reason => {
      if (this.upstream === upstream) this.upstream = null;
      try { client.close(); } catch {}
      this.onUpstreamClosed?.(reason);
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, isBinary]);
      else closed('client sent data before the PVE console was ready');
    });
    client.on('close', () => { if (this.upstream === upstream) { try { upstream.close(); } catch {} } });
    client.on('error', () => closed('local console socket error'));

    upstream.on('open', () => { for (const [data, isBinary] of queued.splice(0)) upstream.send(data, { binary: isBinary }); });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('error', error => closed(`PVE console socket error: ${error.message}`));
    upstream.on('close', (code, reason) => closed(`PVE console socket closed (${code}${reason ? ` ${reason}` : ''})`));
  }

  async close() {
    if (this.upstream) { try { this.upstream.terminate(); } catch {} this.upstream = null; }
    if (this.wss) { for (const client of this.wss.clients) { try { client.terminate(); } catch {} } }
    await new Promise(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); });
    this.server = null;
  }
}
