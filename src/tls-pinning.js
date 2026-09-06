import https from 'node:https';
import tls from 'node:tls';

export function normalizeFingerprint(value) {
  return String(value || '').replace(/[:\s]/g, '').toLowerCase();
}

export function isFingerprint(value) {
  return /^[0-9a-f]{64}$/.test(normalizeFingerprint(value));
}

/**
 * Certificate pinning for PVE's private cluster CA.
 *
 * Node skips `checkServerIdentity` whenever `rejectUnauthorized` is false, so a
 * pin configured that way would silently accept any certificate. This agent
 * therefore completes the handshake permissively, verifies the leaf digest and
 * the requested address itself, and gates every write until verification
 * passed: on mismatch the socket is destroyed before a single request byte is
 * encrypted, so credentials cannot leak to an impostor.
 */
export function createPinnedAgent({ fingerprint, host, ca }) {
  const pinned = normalizeFingerprint(fingerprint);
  if (!isFingerprint(pinned)) throw new Error('tlsFingerprint must be a SHA-256 hex digest');

  const agent = new https.Agent({
    rejectUnauthorized: false, ca, keepAlive: false, maxSockets: 8,
    // Abbreviated handshakes do not re-send the certificate, which would leave
    // nothing to pin against. Always perform a full handshake instead.
    maxCachedSessions: 0,
  });
  const nativeConnect = agent.createConnection.bind(agent);

  agent.createConnection = (options, callback) => {
    const socket = nativeConnect({ ...options, rejectUnauthorized: false }, callback);
    let verified = false;
    const queued = [];
    const nativeWrite = socket.write.bind(socket);
    socket.write = (chunk, encoding, onFlushed) => {
      if (verified) return nativeWrite(chunk, encoding, onFlushed);
      queued.push([chunk, encoding, onFlushed]);
      return false;
    };

    socket.once('secureConnect', () => {
      try {
        verifyPeer(socket, pinned, host);
      } catch (error) {
        socket.destroy(error);
        return;
      }
      verified = true;
      socket.write = nativeWrite;
      for (const [chunk, encoding, onFlushed] of queued.splice(0)) nativeWrite(chunk, encoding, onFlushed);
      if (!socket.writableNeedDrain) socket.emit('drain');
    });

    return socket;
  };

  return agent;
}

export function verifyPeer(socket, pinned, host) {
  const certificate = socket.getPeerCertificate();
  const digest = normalizeFingerprint(certificate?.fingerprint256);
  if (!digest) {
    throw new Error(`No peer certificate to verify (pinned ${pinned}); refusing to send credentials`);
  }
  if (digest !== pinned) {
    throw new Error(`PVE certificate fingerprint mismatch (got ${digest}, pinned ${pinned}); refusing to send credentials`);
  }
  const addressError = host ? tls.checkServerIdentity(host, certificate) : null;
  if (addressError) {
    throw new Error(`PVE certificate does not match ${host} (${addressError.message}); SANs: ${certificate.subjectaltname || 'none'}`);
  }
  return { fingerprint: digest, subjectCN: certificate.subject?.CN ?? null, sans: certificate.subjectaltname || null };
}
