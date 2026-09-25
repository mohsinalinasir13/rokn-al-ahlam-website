// Rokn Al Ahlam enquiry relay.
//
// Browser -> POST /api/enquiry (this relay) -> HMAC-signed POST to the Company OS
// website-lead intake (/api/v1/leads/website) -> central Prospect record.
//
// The browser can never hold the Company OS webhook secret, so a small
// server-side signer is required. This file has no dependencies (Node built-ins
// only). It never logs enquiry contents: only event type, status and timing.
//
// Environment (see server/.env.example):
//   COMPANY_OS_INTAKE_URL      e.g. https://os.bestwaysolutions.ae/api/v1/leads/website
//   COMPANY_OS_WEBHOOK_SECRET  shared HMAC secret (server-side only)
//   ALLOWED_ORIGINS            comma list, default https://roknalahlam.com,https://www.roknalahlam.com
//   RATE_LIMIT_PER_MIN         default 10 per client IP
//   UPSTREAM_TIMEOUT_MS        default 8000
//   TRUST_PROXY=1              use the first X-Forwarded-For entry as the client IP
import crypto from 'node:crypto';
import { validateEnquiry, etypeLabel, COMMON_HEAD, EXTRAS, NOTES_F } from '../src/enquirySchema.js';

export const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

// Same algorithm Company OS verifies: HMAC-SHA256(secret, "<unix seconds>." + rawBody), hex.
export function signWebhook(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

// Client IP for rate limiting. Behind a trusted reverse proxy (Caddy) the proxy overwrites
// X-Forwarded-For with the real peer, so the LAST entry is the one the proxy vouches for;
// earlier entries are client-controlled and must never be trusted.
export function clientIp(headers, remoteAddress, trustProxy) {
  if (trustProxy && headers && headers['x-forwarded-for']) {
    const parts = String(headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return remoteAddress || 'unknown';
}

export function referenceFromProspectId(id) {
  return 'RA-' + String(id).replace(/-/g, '').slice(0, 8).toUpperCase();
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max) : '');

export function buildLead({ id, type, clean, body, receivedAt }) {
  const label = etypeLabel(type);
  const lines = ['Enquiry type: ' + label];
  for (const f of [...COMMON_HEAD, ...EXTRAS[type], NOTES_F]) if (clean[f.n]) lines.push(f.l + ': ' + clean[f.n]);
  const utm = {};
  if (body.utm && typeof body.utm === 'object') for (const k of UTM_KEYS) { const v = str(body.utm[k], 200); if (v) utm[k] = v; }
  return {
    id,
    company_name: (clean.company || clean.name).slice(0, 200),
    contact_name: clean.name.slice(0, 200),
    email: clean.email || null,
    phone: clean.phone.slice(0, 40),
    message: lines.join('\n').slice(0, 5000),
    source: 'roknalahlam.com',
    metadata: {
      site: 'roknalahlam.com', brand: 'Rokn Al Ahlam', enquiryType: type, enquiryTypeLabel: label,
      fields: clean, consent: true, consentText: 'I agree to be contacted about my enquiry.',
      page: str(body.page, 200), referrer: str(body.referrer, 500), utm,
      submittedAt: str(body.submittedAt, 40), relayReceivedAt: receivedAt,
    },
  };
}

export function createRelay({ env = process.env, fetchImpl = globalThis.fetch, logger = console, now = () => Date.now() } = {}) {
  const cfg = {
    url: env.COMPANY_OS_INTAKE_URL || '',
    secret: env.COMPANY_OS_WEBHOOK_SECRET || '',
    origins: (env.ALLOWED_ORIGINS || 'https://roknalahlam.com,https://www.roknalahlam.com').split(',').map(s => s.trim()).filter(Boolean),
    limit: Number(env.RATE_LIMIT_PER_MIN) || 10,
    timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 8000,
    trustProxy: env.TRUST_PROXY === '1',
  };
  const hits = new Map();
  const log = (o) => { try { logger.info(JSON.stringify(o)); } catch (e) { /* logging must never break a request */ } };

  const cors = (origin) => origin && cfg.origins.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }
    : { vary: 'Origin' };
  const reply = (status, obj, origin, extra = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin), ...extra }, body: JSON.stringify(obj) });
  const fail = (status, code, message, origin, extra) => reply(status, { ok: false, code, message }, origin, extra);
  const GENERIC = 'We could not send your enquiry right now.';

  function limited(ip) {
    const t = now();
    const arr = (hits.get(ip) || []).filter(x => t - x < 60000);
    if (arr.length >= cfg.limit) { hits.set(ip, arr); return true; }
    arr.push(t); hits.set(ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < 60000)) hits.delete(k);
    return false;
  }

  async function handle({ method, path, headers = {}, body = '', ip = 'unknown' }) {
    const origin = headers.origin;
    if (path === '/api/health' && method === 'GET') return reply(200, { ok: true, configured: !!(cfg.url && cfg.secret) }, origin);
    if (path !== '/api/enquiry') return fail(404, 'not_found', 'Not found.', origin);
    if (origin && !cfg.origins.includes(origin)) return fail(403, 'origin_not_allowed', 'Origin not allowed.', undefined);
    if (method === 'OPTIONS') return { status: 204, headers: { ...cors(origin), 'cache-control': 'no-store' }, body: '' };
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed.', origin, { allow: 'POST, OPTIONS' });
    if (limited(ip)) return fail(429, 'rate_limited', 'Too many attempts. Please wait a minute and try again.', origin, { 'retry-after': '60' });
    if (!cfg.url || !cfg.secret) { log({ evt: 'enquiry_failed', code: 'not_configured' }); return fail(503, 'not_configured', GENERIC, origin); }
    if (!/application\/json/i.test(headers['content-type'] || '')) return fail(415, 'unsupported_media_type', 'Send JSON.', origin);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return fail(413, 'payload_too_large', 'Request too large.', origin);
    let payload;
    try { payload = JSON.parse(body); } catch (e) { return fail(400, 'invalid_json', 'Invalid request.', origin); }
    if (!payload || typeof payload !== 'object') return fail(400, 'invalid_json', 'Invalid request.', origin);
    if (typeof payload.hp === 'string' && payload.hp.trim() !== '') { log({ evt: 'enquiry_rejected', code: 'honeypot' }); return fail(400, 'rejected', GENERIC, origin); }
    const v = validateEnquiry(payload);
    if (!v.ok) return reply(400, { ok: false, code: 'validation', errors: v.errors }, origin);

    const id = typeof payload.id === 'string' && UUID_RE.test(payload.id) ? payload.id.toLowerCase() : crypto.randomUUID();
    const lead = buildLead({ id, type: v.type, clean: v.clean, body: payload, receivedAt: new Date(now()).toISOString() });
    const raw = JSON.stringify(lead);
    const ts = String(Math.floor(now() / 1000));
    const started = now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    let res;
    try {
      res = await fetchImpl(cfg.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': signWebhook(cfg.secret, ts, raw) }, body: raw });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && e.name === 'AbortError';
      log({ evt: 'enquiry_failed', type: v.type, code: timedOut ? 'upstream_timeout' : 'upstream_unreachable', ms: now() - started });
      return fail(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unreachable', GENERIC, origin);
    }
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON upstream body */ }
    const ms = now() - started;
    if (res.ok && data && typeof data.id === 'string' && data.id) {
      const reference = referenceFromProspectId(data.id);
      log({ evt: 'enquiry_ok', type: v.type, ref: reference, ms });
      return reply(200, { ok: true, reference }, origin);
    }
    const code = res.status === 429 ? 'upstream_busy' : (res.status === 401 || res.status === 403 || res.status === 503) ? 'upstream_rejected' : res.ok ? 'upstream_bad_response' : 'upstream_error';
    log({ evt: 'enquiry_failed', type: v.type, code, upstreamStatus: res.status, ms });
    return fail(code === 'upstream_busy' ? 503 : 502, code, GENERIC, origin);
  }

  return { handle, cfg };
}
