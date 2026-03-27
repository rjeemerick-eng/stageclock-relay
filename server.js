const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const LICENSE_API = process.env.LICENSE_API || null;
const orgs = new Map();

const server = http.createServer((req, res) => {
  const orgCount  = orgs.size;
  const siteCount = [...orgs.values()].reduce((n, org) => n + org.size, 0);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', orgs: orgCount, sites: siteCount, uptime: process.uptime() }));
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log('StageClock relay hub on :' + PORT);
});

function getOrg(id) { if (!orgs.has(id)) orgs.set(id, new Map()); return orgs.get(id); }
function rosterFor(orgId, ex) { return [...getOrg(orgId).values()].filter(s=>s.siteName!==ex).map(s=>({siteName:s.siteName,isPrimary:s.isPrimary,joinedAt:s.joinedAt})); }
function broadcast(orgId, msg, ex) { const p=JSON.stringify(msg); for(const s of getOrg(orgId).values()){if(s.siteName===ex)continue;if(s.ws.readyState===WebSocket.OPEN)s.ws.send(p);} }
function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}

async function validateLicense(key, orgId) {
  if (!LICENSE_API || !key) return true;
  try { const r=await fetch(LICENSE_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({licenseKey:key,orgId}),signal:AbortSignal.timeout(3000)}); const d=await r.json(); return d.valid===true; } catch { return true; }
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let site = null;

  ws.on('message', async (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if (msg.type === 'HELLO') {
      const { orgId, siteName, isPrimary, licenseKey } = msg;
      if (!orgId || !siteName) { send(ws,{type:'ERROR',code:'MISSING_FIELDS'}); ws.close(); return; }
      if (!await validateLicense(licenseKey, orgId)) { send(ws,{type:'ERROR',code:'INVALID_LICENSE'}); ws.close(); return; }
      const org = getOrg(orgId);

      // Block duplicate primary
      if (isPrimary) {
        const existingPrimary = [...org.values()].find(s => s.isPrimary && s.siteName !== siteName);
        if (existingPrimary) {
          send(ws, { type:'PRIMARY_CONFLICT', existingSite: existingPrimary.siteName });
          // Allow them to join but as non-primary
          // (client will handle unchecking the box)
        }
      }

      if (org.has(siteName)) { const ex=org.get(siteName); if(ex.ws!==ws&&ex.ws.readyState===WebSocket.OPEN){send(ex.ws,{type:'ERROR',code:'REPLACED'});ex.ws.close();} org.delete(siteName); }
      // Force isPrimary=false if conflict detected
      const existingPrimary2 = isPrimary ? [...org.values()].find(s => s.isPrimary && s.siteName !== siteName) : null;
      const resolvedPrimary = isPrimary && !existingPrimary2;
      site = { orgId, siteName, isPrimary: resolvedPrimary, licenseKey, ws, joinedAt:Date.now() };
      org.set(siteName, site);
      console.log('['+orgId+'] '+siteName+' joined ('+ip+') primary='+resolvedPrimary);
      send(ws, { type:'WELCOME', siteName, orgId, roster:rosterFor(orgId,siteName) });
      broadcast(orgId, { type:'SITE_JOINED', siteName, isPrimary:resolvedPrimary, roster:rosterFor(orgId) }, siteName);
      return;
    }

    if (!site) { send(ws,{type:'ERROR',code:'NOT_JOINED'}); return; }

    if (msg.type==='SITE_STATE') { broadcast(site.orgId,{type:'SITE_STATE',siteName:site.siteName,isPrimary:site.isPrimary,state:msg.state,ts:Date.now()},site.siteName); return; }
    if (msg.type==='BROADCAST_CUE') { broadcast(site.orgId,{type:'BROADCAST_CUE',fromSite:site.siteName,cue:msg.cue,ts:Date.now()},site.siteName); return; }
    if (msg.type==='ADD_TIME') { broadcast(site.orgId,{type:'ADD_TIME',fromSite:site.siteName,seconds:msg.seconds,ts:Date.now()},site.siteName); return; }
    if (msg.type==='OP_MSG') { broadcast(site.orgId,{type:'OP_MSG',fromSite:site.siteName,text:msg.text,ts:Date.now()},site.siteName); return; }
    if (msg.type==='OP_ALERT') { broadcast(site.orgId,{type:'OP_ALERT',fromSite:site.siteName,text:msg.text,ts:Date.now()}); return; } // alert goes to ALL including sender
    if (msg.type==='PING') { send(ws,{type:'PONG',ts:Date.now()}); return; }
  });

  ws.on('close', () => {
    if (!site) return;
    const org = getOrg(site.orgId);
    if (org.get(site.siteName)?.ws===ws) {
      org.delete(site.siteName);
      console.log('['+site.orgId+'] '+site.siteName+' left');
      broadcast(site.orgId,{type:'SITE_LEFT',siteName:site.siteName,roster:rosterFor(site.orgId)});
      if (org.size===0) orgs.delete(site.orgId);
    }
  });

  ws.on('error', err => console.error('WS error ['+( site?.siteName||ip)+']: '+err.message));
});
