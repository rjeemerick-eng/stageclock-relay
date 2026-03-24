/**
 * StageClock Multisite Relay Hub
 * ─────────────────────────────────────────────────────────
 * Lightweight WebSocket relay. Routes messages between
 * StageClock instances in the same org. No clock logic —
 * just authenticated routing.
 *
 * Deploy: Railway, fly.io, Render (free tier works fine)
 * Node.js 18+
 *
 * ENV:
 *   PORT          WebSocket port (default 8080)
 *   RELAY_SECRET  Shared secret for basic auth (optional)
 *   LICENSE_API   URL to validate license keys (optional)
 */

const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const RELAY_SECRET = process.env.RELAY_SECRET || null;
const LICENSE_API  = process.env.LICENSE_API  || null;

const wss = new WebSocketServer({ port: PORT });

// orgs[orgId] = Map<siteName, { ws, siteName, isPrimary, licenseKey, joinedAt }>
const orgs = new Map();

console.log(`StageClock relay hub listening on :${PORT}`);

// ── Helpers ────────────────────────────────────────────────

function getOrg(orgId) {
  if (!orgs.has(orgId)) orgs.set(orgId, new Map());
  return orgs.get(orgId);
}

function rosterFor(orgId, excludeSiteName = null) {
  const org = getOrg(orgId);
  return [...org.values()]
    .filter(s => s.siteName !== excludeSiteName)
    .map(s => ({
      siteName:  s.siteName,
      isPrimary: s.isPrimary,
      joinedAt:  s.joinedAt,
    }));
}

function broadcast(orgId, msg, excludeSiteName = null) {
  const org = getOrg(orgId);
  const payload = JSON.stringify(msg);
  for (const site of org.values()) {
    if (site.siteName === excludeSiteName) continue;
    if (site.ws.readyState === WebSocket.OPEN) {
      site.ws.send(payload);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── License validation (optional) ─────────────────────────
// If LICENSE_API is set, validate on connect. Otherwise allow all.

async function validateLicense(licenseKey, orgId) {
  if (!LICENSE_API || !licenseKey) return true; // open relay
  try {
    const res = await fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, orgId }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return data.valid === true && (data.tier === 'multisite' || data.tier === 'pro');
  } catch {
    // If license API is unreachable, allow connection (fail open)
    console.warn('License API unreachable — allowing connection');
    return true;
  }
}

// ── Connection handler ─────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let site = null; // { orgId, siteName, isPrimary, licenseKey }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── HELLO — join an org ──────────────────────────────
    if (msg.type === 'HELLO') {
      const { orgId, siteName, isPrimary, licenseKey } = msg;

      if (!orgId || !siteName) {
        send(ws, { type: 'ERROR', code: 'MISSING_FIELDS', message: 'orgId and siteName required' });
        ws.close();
        return;
      }

      // Validate license
      const valid = await validateLicense(licenseKey, orgId);
      if (!valid) {
        send(ws, { type: 'ERROR', code: 'INVALID_LICENSE', message: 'License key invalid or not Multisite tier' });
        ws.close();
        return;
      }

      const org = getOrg(orgId);

      // Kick existing connection with same siteName (reconnect case)
      if (org.has(siteName)) {
        const existing = org.get(siteName);
        if (existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
          send(existing.ws, { type: 'ERROR', code: 'REPLACED', message: 'Another connection opened for this site' });
          existing.ws.close();
        }
        org.delete(siteName);
      }

      site = { orgId, siteName, isPrimary: !!isPrimary, licenseKey, ws, joinedAt: Date.now() };
      org.set(siteName, site);

      console.log(`[${orgId}] ${siteName} joined (${ip}) primary=${isPrimary}`);

      // Send welcome with current roster
      send(ws, {
        type:    'WELCOME',
        siteName,
        orgId,
        roster:  rosterFor(orgId, siteName),
      });

      // Notify others
      broadcast(orgId, {
        type:      'SITE_JOINED',
        siteName,
        isPrimary: !!isPrimary,
        roster:    rosterFor(orgId),
      }, siteName);

      return;
    }

    // All other messages require a valid HELLO first
    if (!site) {
      send(ws, { type: 'ERROR', code: 'NOT_JOINED', message: 'Send HELLO first' });
      return;
    }

    // ── SITE_STATE — clock state from primary ────────────
    if (msg.type === 'SITE_STATE') {
      broadcast(site.orgId, {
        type:      'SITE_STATE',
        siteName:  site.siteName,
        isPrimary: site.isPrimary,
        state:     msg.state,
        ts:        Date.now(),
      }, site.siteName);
      return;
    }

    // ── BROADCAST_CUE — fire cue to all sites ───────────
    if (msg.type === 'BROADCAST_CUE') {
      broadcast(site.orgId, {
        type:      'BROADCAST_CUE',
        fromSite:  site.siteName,
        cue:       msg.cue,
        ts:        Date.now(),
      }, site.siteName);
      console.log(`[${site.orgId}] CUE from ${site.siteName}: ${msg.cue?.text}`);
      return;
    }

    // ── OP_MSG — operator text message ──────────────────
    if (msg.type === 'OP_MSG') {
      broadcast(site.orgId, {
        type:     'OP_MSG',
        fromSite: site.siteName,
        text:     msg.text,
        ts:       Date.now(),
      }, site.siteName);
      return;
    }

    // ── PING — keepalive ────────────────────────────────
    if (msg.type === 'PING') {
      send(ws, { type: 'PONG', ts: Date.now() });
      return;
    }
  });

  ws.on('close', () => {
    if (!site) return;
    const org = getOrg(site.orgId);

    // Only remove if this ws is still the registered one
    if (org.get(site.siteName)?.ws === ws) {
      org.delete(site.siteName);
      console.log(`[${site.orgId}] ${site.siteName} left`);

      broadcast(site.orgId, {
        type:     'SITE_LEFT',
        siteName: site.siteName,
        roster:   rosterFor(site.orgId),
      });

      // Clean up empty orgs
      if (org.size === 0) orgs.delete(site.orgId);
    }
  });

  ws.on('error', (err) => {
    console.error(`WS error [${site?.siteName || ip}]:`, err.message);
  });
});

// ── Health check (Railway/fly.io need HTTP) ────────────────
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') {
    const orgCount  = orgs.size;
    const siteCount = [...orgs.values()].reduce((n, org) => n + org.size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', orgs: orgCount, sites: siteCount, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(process.env.HTTP_PORT || 8081);

console.log(`Health endpoint on :${process.env.HTTP_PORT || 8081}/health`);
