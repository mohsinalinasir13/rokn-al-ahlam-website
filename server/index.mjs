// Minimal HTTP wrapper around the enquiry relay. Run: node server/index.mjs
import http from 'node:http';
import { createRelay, clientIp, MAX_BODY_BYTES } from './enquiry-relay.mjs';

const relay = createRelay();
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES + 1024) { aborted = true; res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"ok":false,"code":"payload_too_large"}'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    try {
      const ip = clientIp(req.headers, req.socket.remoteAddress, relay.cfg.trustProxy);
      const out = await relay.handle({ method: req.method, path: (req.url || '').split('?')[0], headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), ip });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch (e) {
      console.error(JSON.stringify({ evt: 'relay_error', name: e && e.name }));
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false,"code":"internal_error","message":"We could not send your enquiry right now."}');
    }
  });
});

// Slow-request protection and clean container stops.
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.info(JSON.stringify({ evt: 'relay_stopping', signal: sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(port, host, () => console.info(JSON.stringify({ evt: 'relay_listening', host, port, configured: !!(relay.cfg.url && relay.cfg.secret), origins: relay.cfg.origins.length, trustProxy: relay.cfg.trustProxy })));
