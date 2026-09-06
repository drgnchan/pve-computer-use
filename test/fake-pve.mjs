import crypto from 'node:crypto';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { FakeVncServer } from './fake-vnc-server.mjs';

export const FAKE_TOKEN_ID = 'pve-cu@pve!console';
export const FAKE_TOKEN_SECRET = 'tok-secret-value';
export const FAKE_USERNAME = 'pve-cu@pve';
export const FAKE_PASSWORD = 'pw-secret-value';

function formBody(raw) {
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Stand-in for a Proxmox VE host: the REST endpoints pve-cu uses plus the
 * vncwebsocket upgrade that carries the RFB byte stream. Mirrors the behaviour
 * verified in pve-qemu-server/src/PVE/API2/Qemu.pm and pve-manager HTTPServer.pm:
 *   - /access/ticket issues an API ticket + CSRF token (no auth required)
 *   - protected endpoints accept either an API token or the PVEAuthCookie
 *   - vncproxy returns "<vnc password>:PVEVNC:..." plus an explicit password
 *   - vncwebsocket requires API auth *and* a matching vncticket/port
 */
export class FakePve {
  constructor({ cert, key, node = 'lab', vmid = 105, vmName = 'fake-vm', running = true, width = 160, height = 100, advertiseQemuExtKey = true, pattern = null, color, rejectAuth = false, omitVncPasswordField = false }) {
    this.omitVncPasswordField = omitVncPasswordField;
    this.node = node;
    this.vmid = vmid;
    this.vmName = vmName;
    this.running = running;
    this.cert = cert;
    this.key = key;
    this.records = { loginBodies: [], statusRequests: 0, vncproxyRequests: [], wsUpgrades: [], unauthenticated: 0 };
    this.ticket = null;
    this.csrf = null;
    this.vncTicket = null;
    this.vncPort = 5900;
    this.vncPassword = null;
    this.vnc = new FakeVncServer({ width, height, advertiseQemuExtKey, name: vmName, pattern, color, rejectAuth });
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
    });
  }

  async listen() {
    this.server = https.createServer({ cert: this.cert, key: this.key }, (req, res) => this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.endpoint = `https://127.0.0.1:${this.port}`;
  }

  async close() {
    await this.vnc.close();
    for (const client of this.wss.clients) { try { client.terminate(); } catch {} }
    this.wss.close();
    await new Promise(resolve => (this.server ? this.server.close(resolve) : resolve()));
  }

  authenticate(req) {
    if (req.headers.authorization === `PVEAPIToken=${FAKE_TOKEN_ID}=${FAKE_TOKEN_SECRET}`) return 'api-token';
    const match = /PVEAuthCookie=([^;]+)/.exec(req.headers.cookie || '');
    if (match && this.ticket && decodeURIComponent(match[1]) === this.ticket) return 'ticket';
    return null;
  }

  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  }

  deny(res) {
    this.records.unauthenticated++;
    this.json(res, 401, null);
  }

  async handle(req, res) {
    const url = new URL(req.url, this.endpoint);
    const path = url.pathname;
    let raw = '';
    for await (const chunk of req) raw += chunk;

    if (req.method === 'POST' && path === '/api2/json/access/ticket') {
      const body = formBody(raw);
      const passwordOk = body.username === FAKE_USERNAME && body.password === FAKE_PASSWORD;
      this.records.loginBodies.push({ username: body.username, passwordOk });
      if (!passwordOk) return this.deny(res);
      this.ticket = `PVE:${FAKE_USERNAME}:${crypto.randomBytes(16).toString('hex').toUpperCase()}::`;
      this.csrf = crypto.randomBytes(16).toString('hex').toUpperCase();
      return this.json(res, 200, { ticket: this.ticket, CSRFPreventionToken: this.csrf, username: FAKE_USERNAME });
    }

    if (req.method === 'GET' && path === '/api2/json/access/domains') {
      return this.json(res, 200, [{ realm: 'pve', type: 'pve' }, { realm: 'pam', type: 'pam' }]);
    }

    const auth = this.authenticate(req);
    if (!auth) return this.deny(res);

    if (req.method === 'GET' && path === `/api2/json/nodes/${this.node}/qemu/${this.vmid}/status/current`) {
      this.records.statusRequests++;
      return this.json(res, 200, {
        vmid: this.vmid, name: this.vmName, status: this.running ? 'running' : 'stopped',
        qemu: this.running ? 'running' : 'stopped', uptime: 1234,
      });
    }

    if (req.method === 'POST' && path === `/api2/json/nodes/${this.node}/qemu/${this.vmid}/vncproxy`) {
      const body = formBody(raw);
      this.records.vncproxyRequests.push({ auth, body, csrf: req.headers.csrfpreventiontoken || null });
      if (!this.running) return this.json(res, 500, null);
      // Ticket auth needs the CSRF header; API tokens are exempt (as in PVE).
      if (auth === 'ticket' && req.headers.csrfpreventiontoken !== this.csrf) return this.deny(res);
      if (body.websocket !== '1') return this.json(res, 400, null);
      // PVE::Ticket::generate_vnc_password uses 8 bytes in '!' (33) .. '`' (96).
      this.vncPassword = Array.from(crypto.randomBytes(8), byte => String.fromCharCode(33 + (byte % 64))).join('');
      this.vncTicket = `${this.vncPassword}:PVEVNC:${FAKE_USERNAME}:/vms/${this.vmid}:${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      const result = {
        user: FAKE_USERNAME, ticket: this.vncTicket,
        cert: '', port: this.vncPort, upid: `UPID:${this.node}:0000:00000000:00000000:vncproxy:${this.vmid}:${FAKE_USERNAME}:`,
      };
      // Older PVE versions omit the field; the password then only exists as the
      // ticket prefix, exactly like the real server behaves.
      if (!this.omitVncPasswordField) result.password = this.vncPassword;
      return this.json(res, 200, result);
    }

    return this.json(res, 501, null);
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, this.endpoint);
    const auth = this.authenticate(req);
    const vncticket = url.searchParams.get('vncticket');
    const port = Number(url.searchParams.get('port'));
    this.records.wsUpgrades.push({
      auth, port, vncticket,
      authorization: req.headers.authorization || null,
      cookie: req.headers.cookie || null,
      protocol: req.headers['sec-websocket-protocol'] || null,
    });
    if (!auth || vncticket !== this.vncTicket || port !== this.vncPort) {
      this.records.unauthenticated++;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, client => this.vnc.handle(client));
  }
}
