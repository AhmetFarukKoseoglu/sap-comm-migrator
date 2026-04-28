const express = require('express');
const fetch   = require('node-fetch');
const https   = require('https');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── URL HELPERS ── */
function buildApiBase(rawUrl) {
  const hostname = (rawUrl || '').replace(/\/$/, '').replace(/^https?:\/\//i, '');
  const apiHost  = hostname.includes('-api.')
    ? hostname
    : hostname.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
  return 'https://' + apiHost;
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sapHeaders(auth, extra = {}) {
  return {
    Authorization:    auth,
    Accept:           'application/json;odata.metadata=minimal',
    'Content-Type':   'application/json',
    'odata-version':  '4.0',
    'cache-control':  'no-cache',
    ...extra,
  };
}

function log(method, url, status) {
  console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${method} ${url} → ${status}`);
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/* ── EDMX'ten gelen kesin path ve entity sabitleri ── */
const BASE_CU = '/sap/opu/odata4/sap/aps_com_cu_a4c_odata/srvd_a2x/sap/aps_com_cu_a4c_odata/0001';
const BASE_CS = '/sap/opu/odata4/sap/aps_com_cs_a4c_odata/srvd_a2x/sap/aps_com_cs_a4c_odata/0001';
const BASE_CA = '/sap/opu/odata4/sap/aps_com_ca_a4c_odata/srvd_a2x/sap/aps_com_ca_a4c_odata/0001';

/* EntitySet isimleri EDMX'ten — kesin */
const ENTITY_CU = 'CommunicationUsers';        // CommunicationUsersType  — key: ID
const ENTITY_CS = 'CommunicationSystems';      // CommunicationSystemsType — key: UUID
const ENTITY_CA = 'CommunicationArrangements'; // CommunicationArrangementsType — key: UUID

/* ── CSRF + POST — Node.js built-in https ───────────────
   node-fetch cookie store tutmadığından raw https ile
   GET (token+cookie) → POST (aynı cookie+token) yapılır.
──────────────────────────────────────────────────────── */
function httpsRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function csrfPatch(apiBase, auth, servicePath, entityPath, bodyObj) {
  const parsedBase = new URL(apiBase);
  const host       = parsedBase.hostname;

  const topEntity  = entityPath.split('(')[0];
  const getPath    = `${servicePath}/${topEntity}?$top=1`;
  console.log(`[CSRF-GET for PATCH] https://${host}${getPath}`);

  const getRes = await httpsRequest({
    host,
    port:   443,
    path:   getPath,
    method: 'GET',
    headers: {
      Authorization:   auth,
      Accept:          'application/json;odata.metadata=minimal',
      'odata-version': '4.0',
      'x-csrf-token':  'Fetch',
      'cache-control': 'no-cache',
    },
  });

  const token      = getRes.headers['x-csrf-token'] || '';
  const rawCookies = getRes.headers['set-cookie'] || [];
  const cookieStr  = Array.isArray(rawCookies)
    ? rawCookies.map(c => c.split(';')[0]).join('; ')
    : rawCookies.split(';')[0];

  const patchPath = `${servicePath}/${entityPath}`;
  const bodyStr   = JSON.stringify(bodyObj);
  const patchHeaders = {
    Authorization:  auth,
    Accept:         'application/json;odata.metadata=minimal',
    'Content-Type': 'application/json',
    'odata-version':'4.0',
    'x-csrf-token': token,
    'Content-Length': Buffer.byteLength(bodyStr),
  };
  if (cookieStr) patchHeaders['Cookie'] = cookieStr;

  console.log(`[CSRF-PATCH] https://${host}${patchPath}`);
  const patchRes = await httpsRequest({ host, port: 443, path: patchPath, method: 'PATCH', headers: patchHeaders }, bodyStr);
  log('PATCH', `https://${host}${patchPath}`, patchRes.status);
  return { status: patchRes.status, ok: patchRes.status >= 200 && patchRes.status < 300, text: patchRes.body };
}

async function csrfPost(apiBase, auth, servicePath, entitySet, bodyObj) {
  const parsedBase = new URL(apiBase);
  const host       = parsedBase.hostname;

  /* 1 — GET entity set ile token + cookie al (metadata değil) */
  const getPath = `${servicePath}/${entitySet}?$top=1`;
  console.log(`[CSRF-GET] https://${host}${getPath}`);

  const getRes = await httpsRequest({
    host,
    port:   443,
    path:   getPath,
    method: 'GET',
    headers: {
      Authorization:   auth,
      Accept:          'application/json;odata.metadata=minimal',
      'odata-version': '4.0',
      'x-csrf-token':  'Fetch',
      'cache-control': 'no-cache',
    },
  });

  const token   = getRes.headers['x-csrf-token'] || '';
  const rawCookies = getRes.headers['set-cookie'] || [];
  const cookieStr  = Array.isArray(rawCookies)
    ? rawCookies.map(c => c.split(';')[0]).join('; ')
    : rawCookies.split(';')[0];

  console.log(`[CSRF] status=${getRes.status} | token="${token}" | cookies=${rawCookies.length || (cookieStr ? 1 : 0)}`);

  /* 2 — POST */
  const postPath = `${servicePath}/${entitySet}`;
  const bodyStr  = JSON.stringify(bodyObj);
  const postHeaders = {
    Authorization:  auth,
    Accept:         'application/json;odata.metadata=minimal',
    'Content-Type': 'application/json',
    'odata-version':'4.0',
    'x-csrf-token': token,
    'Content-Length': Buffer.byteLength(bodyStr),
  };
  if (cookieStr) postHeaders['Cookie'] = cookieStr;

  console.log(`[CSRF-POST] https://${host}${postPath}`);
  const postRes = await httpsRequest({ host, port: 443, path: postPath, method: 'POST', headers: postHeaders }, bodyStr);
  log('POST', `https://${host}${postPath}`, postRes.status);
  return { status: postRes.status, ok: postRes.status === 200 || postRes.status === 201, text: postRes.body };
}

/* ════════════════════════════════════════════════════
   CONFIG
   ════════════════════════════════════════════════════ */
app.get('/api/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    res.json(cfg);
  } catch (e) {
    console.error('[CONFIG] config.json okunamadı:', e.message);
    res.json({ source: { url: '', user: '', pass: '' }, target: { url: '', user: '', pass: '' } });
  }
});

/* ════════════════════════════════════════════════════
   TEST
   ════════════════════════════════════════════════════ */
app.post('/api/test', async (req, res) => {
  const { url, user, pass } = req.body;
  if (!url || !user || !pass) return res.status(400).json({ error: 'url, user, pass zorunlu.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const testUrl  = `${apiBase}${BASE_CU}/${ENTITY_CU}?$top=1`;

  try {
    const resp = await fetch(testUrl, {
      headers: sapHeaders(auth),
      signal:  AbortSignal.timeout(10000),
    });
    log('TEST', testUrl, resp.status);
    if (resp.ok) return res.json({ ok: true, apiBase });
    const text = await resp.text();
    res.json({ ok: false, status: resp.status, detail: text.slice(0, 400), apiBase });
  } catch (e) {
    log('TEST', testUrl, 'ERR: ' + e.message);
    res.status(502).json({ ok: false, error: e.message, apiBase });
  }
});

/* ════════════════════════════════════════════════════
   GET — Communication Users
   EntityType: CommunicationUsersType
   Fields: ID, Name, Type, Description, IsLocked, LockStatus,
           PasswordStatus, ChangedAt, ChangedBy
   ════════════════════════════════════════════════════ */
app.get('/api/comm-users', async (req, res) => {
  const { url, user, pass } = req.query;
  if (!url || !user || !pass) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const odataUrl = `${apiBase}${BASE_CU}/${ENTITY_CU}`;

  try {
    const resp = await fetch(odataUrl, { headers: sapHeaders(auth), signal: AbortSignal.timeout(15000) });
    log('GET', odataUrl, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `SAP HTTP ${resp.status}`, detail: text.slice(0, 400) });
    }
    const json = await resp.json();
    res.json({ value: json.value || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});



/* ════════════════════════════════════════════════════
   GET — Communication Arrangements
   EntityType: CommunicationArrangementsType
   Fields: UUID, CommunicationScenarioID, CommunicationSystemID,
           Name, Description, CreatedAt, ChangedAt ...
   ════════════════════════════════════════════════════ */
app.get('/api/comm-arrangements', async (req, res) => {
  const { url, user, pass } = req.query;
  if (!url || !user || !pass) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const odataUrl = `${apiBase}${BASE_CA}/${ENTITY_CA}?$expand=InboundServices,InboundUser,OutboundServices,OutboundUser,Properties`;

  try {
    const resp = await fetch(odataUrl, { headers: sapHeaders(auth), signal: AbortSignal.timeout(15000) });
    log('GET', odataUrl, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `SAP HTTP ${resp.status}`, detail: text.slice(0, 400) });
    }
      const json = await resp.json();
    res.json({ value: json.value || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   GET — Communication Systems
   EntityType: CommunicationSystemsType
   ════════════════════════════════════════════════════ */
app.get('/api/comm-systems', async (req, res) => {
  const { url, user, pass } = req.query;
  if (!url || !user || !pass) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const odataUrl = `${apiBase}${BASE_CS}/${ENTITY_CS}?$expand=BusinessPartners,EventChannel,InboundUsers,OpenIDConnect,OutboundUsers`;

  try {
    const resp = await fetch(odataUrl, { headers: sapHeaders(auth), signal: AbortSignal.timeout(15000) });
    log('GET', odataUrl, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `SAP HTTP ${resp.status}`, detail: text.slice(0, 400) });
    }
    const json  = await resp.json();
    const systems = json.value || [];
    systems.forEach(s => {
      const iu = (s.InboundUsers  || []).map(u => `${u.CommunicationUserID}(${u.AuthenticationMethod})`).join(', ');
      const ou = (s.OutboundUsers || []).map(u => `${u.Name}(${u.AuthenticationMethod})`).join(', ');
      console.log(`[CS] ID=${s.ID} | InboundUsers=[${iu}] | OutboundUsers=[${ou}]`);
    });
    res.json({ value: systems });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   GET — Communication User (tek kayıt, ID ile)
   ════════════════════════════════════════════════════ */
app.get('/api/comm-users/single', async (req, res) => {
  const { url, user, pass, id } = req.query;
  if (!url || !user || !pass || !id) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const odataUrl = `${apiBase}${BASE_CU}/${ENTITY_CU}('${encodeURIComponent(id)}')`;

  try {
    const resp = await fetch(odataUrl, { headers: sapHeaders(auth), signal: AbortSignal.timeout(10000) });
    log('GET', odataUrl, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `SAP HTTP ${resp.status}`, detail: text.slice(0, 400) });
    }
    const json = await resp.json();
    res.json({ value: json });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   POST — CS için InboundUser çözümle
   1. Kaynak sistemden ID ile user çek → Name al
   2. Hedef sistemde Name eşleşeni bul
   3. Bulunamazsa hedefte oluştur → tekrar Name ile çek
   ════════════════════════════════════════════════════ */
app.post('/api/comm-users/resolve-for-cs', async (req, res) => {
  const { srcUrl, srcUser, srcPass, tgtUrl, tgtUser, tgtPass, communicationUserID } = req.body;
  if (!srcUrl || !srcUser || !srcPass || !tgtUrl || !tgtUser || !tgtPass || !communicationUserID) {
    return res.status(400).json({ error: 'Parametre eksik.' });
  }

  const srcBase = buildApiBase(srcUrl);
  const tgtBase = buildApiBase(tgtUrl);
  const srcAuth = basicAuth(srcUser, srcPass);
  const tgtAuth = basicAuth(tgtUser, tgtPass);

  try {
    /* 1 — Kaynak sistemden user'ı ID ile çek → Name al */
    const srcOdataUrl = `${srcBase}${BASE_CU}/${ENTITY_CU}('${encodeURIComponent(communicationUserID)}')`;
    const srcResp = await fetch(srcOdataUrl, { headers: sapHeaders(srcAuth), signal: AbortSignal.timeout(10000) });
    log('GET(src-user)', srcOdataUrl, srcResp.status);
    if (!srcResp.ok) {
      const txt = await srcResp.text();
      return res.status(404).json({ error: `Kaynak sistemde user bulunamadı (${srcResp.status})`, detail: txt.slice(0, 300) });
    }
    const srcUserData = await srcResp.json();
    const srcName = srcUserData.Name;
    console.log(`[RESOLVE] Kaynak user: ID=${srcUserData.ID} Name=${srcName}`);
    if (!srcName) return res.status(400).json({ error: `Kaynak user Name alanı boş: ${communicationUserID}` });

    /* 2 — Hedef sistemdeki tüm user'ları çek → Name ile eşleştir */
    const tgtListUrl  = `${tgtBase}${BASE_CU}/${ENTITY_CU}`;
    const tgtListResp = await fetch(tgtListUrl, { headers: sapHeaders(tgtAuth), signal: AbortSignal.timeout(15000) });
    log('GET(tgt-users)', tgtListUrl, tgtListResp.status);
    if (!tgtListResp.ok) {
      const txt = await tgtListResp.text();
      return res.status(tgtListResp.status).json({ error: `Hedef sistemden user listesi alınamadı (${tgtListResp.status})`, detail: txt.slice(0, 300) });
    }
    const tgtListJson = await tgtListResp.json();
    const tgtUsers    = tgtListJson.value || [];

    const matched = tgtUsers.find(u => u.Name === srcName);
    if (matched) {
      console.log(`[RESOLVE] Hedef eşleşme: Name=${matched.Name} → ID=${matched.ID}`);
      return res.json({ ok: true, created: false, user: matched });
    }

    /* 3 — Eşleşme yok → hedefte oluştur */
    console.log(`[RESOLVE] Hedef sistemde Name="${srcName}" bulunamadı — oluşturuluyor...`);
    const createBody = { ID: srcUserData.ID, Name: srcUserData.Name || srcUserData.ID, Type: srcUserData.Type || 'B', Description: srcUserData.Description || '', Password: 'SapCommunication12345!' };
    const { status: cStatus, ok: cOk, text: cText } = await csrfPost(tgtBase, tgtAuth, BASE_CU, ENTITY_CU, createBody);
    const cMsg = tryParse(cText)?.error?.message || cText;
    if (!cOk && !(cStatus === 400 && cMsg.toLowerCase().includes('already used'))) {
      return res.status(cStatus).json({ error: `Hedef sistemde user oluşturulamadı (${cStatus})`, detail: cText.slice(0, 400) });
    }
    console.log(`[RESOLVE] Oluşturuldu: ${srcUserData.ID}`);

    /* 4 — Tekrar çek → Name ile doğrula */
    const tgtListResp2 = await fetch(tgtListUrl, { headers: sapHeaders(tgtAuth), signal: AbortSignal.timeout(15000) });
    const tgtListJson2 = await tgtListResp2.json();
    const matched2     = (tgtListJson2.value || []).find(u => u.Name === srcName);
    if (!matched2) return res.status(404).json({ error: `Oluşturma sonrası Name="${srcName}" bulunamadı` });
    console.log(`[RESOLVE] Oluşturma sonrası eşleşme: Name=${matched2.Name} → ID=${matched2.ID}`);
    res.json({ ok: true, created: true, user: matched2 });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CREATE — Communication User
   Zorunlu alanlar (EDMX): ID (key), Name, Type
   Password opsiyonel — hedefte yeniden set edilmeli
   ════════════════════════════════════════════════════ */
app.post('/api/comm-users/create', async (req, res) => {
  const { url, user, pass, payload } = req.body;
  if (!url || !user || !pass || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase = buildApiBase(url);
  const auth    = basicAuth(user, pass);
  const body    = {
    ID:          payload.ID,
    Name:        payload.Name        || payload.ID,
    Type:        payload.Type        || 'B',
    Description: payload.Description || '',
    Password:    'SapCommunication12345!',
  };

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CU, ENTITY_CU, body);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    const parsed = tryParse(text);
    const msg = parsed?.error?.message || text;
    if (status === 400 && msg.toLowerCase().includes('already used')) {
      return res.json({ ok: true, skipped: true, reason: 'Zaten mevcut' });
    }
    console.error(`[CU POST ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CREATE — Communication System
   Zorunlu alanlar (EDMX): ID, Name
   UUID server tarafında üretilir (Computed)
   ════════════════════════════════════════════════════ */
app.post('/api/comm-systems/create', async (req, res) => {
  const { url, user, pass, payload } = req.body;
  if (!url || !user || !pass || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase = buildApiBase(url);
  const auth    = basicAuth(user, pass);
  const body    = {
    ID:                                           payload.ID,
    Name:                                         payload.Name                                        || payload.ID,
    Type:                                         payload.Type                                        || 'customer_managed',
    Description:                                  payload.Description                                 || '',
    TCPPort:                                      payload.TCPPort                                     ?? 443,
    LogicalSystemID:                              payload.LogicalSystemID                             || '',
    BusinessSystemID:                             payload.BusinessSystemID                            || '',
    SAPClient:                                    payload.SAPClient                                   || '',
    HostName:                                     payload.HostName                                    || '',
    HostNameUI:                                   payload.HostNameUI                                  || '',
    OwnerContactPersonName:                       payload.OwnerContactPersonName                      || '',
    OwnerContactPersonPhone:                      payload.OwnerContactPersonPhone                     || '',
    OwnerContactPersonEMail:                      payload.OwnerContactPersonEMail                     || '',
    IsOwnSystem:                                  payload.IsOwnSystem                                 ?? false,
    CipherSuites:                                 payload.CipherSuites                                || '',
    IsCipherSuiteDefault:                         payload.IsCipherSuiteDefault                        ?? true,
    IsOAuth2IdentityProviderActive:               payload.IsOAuth2IdentityProviderActive              ?? false,
    OAuth2IdentityProviderName:                   payload.OAuth2IdentityProviderName                  || '',
    OAuth2IdentityProviderUserLogonType:          payload.OAuth2IdentityProviderUserLogonType         || '',
    OAuth2IdentityProviderCertificateSubject:     payload.OAuth2IdentityProviderCertificateSubject    || '',
    OAuth2IdentityProviderCertificateIssuer:      payload.OAuth2IdentityProviderCertificateIssuer     || '',
    OAuth2IdentityProviderCertificatePublicKeyBase64: payload.OAuth2IdentityProviderCertificatePublicKeyBase64 || '',
    OAuth2AuthorizationEndpoint:                  payload.OAuth2AuthorizationEndpoint                 || '',
    OAuth2TokenEndpoint:                          payload.OAuth2TokenEndpoint                         || '',
    OAuth2MTLSEndpoint:                           payload.OAuth2MTLSEndpoint                          || '',
    OAuth2Audience:                               payload.OAuth2Audience                              || '',
    OAuth2RedirectURI:                            payload.OAuth2RedirectURI                           || '',
    IsRemoteSQLAccessActive:                      payload.IsRemoteSQLAccessActive                     ?? false,
    RemoteSQLAdapterName:                         payload.RemoteSQLAdapterName                        || '',
    RemoteSQLAdapterConfiguration:                payload.RemoteSQLAdapterConfiguration               || '',
    IsSAPCloudConnectorActive:                    payload.IsSAPCloudConnectorActive                   ?? false,
    SAPCloudConnectorLocationID:                  payload.SAPCloudConnectorLocationID                 || '',
    IsRFCLoadBalancingActive:                     payload.IsRFCLoadBalancingActive                    ?? false,
    RFCSAPSystemID:                               payload.RFCSAPSystemID                              || '',
    RFCSAPSystemNumber:                           payload.RFCSAPSystemNumber                          || '',
    RFCLogonGroup:                                payload.RFCLogonGroup                               || '',
    RFCMessageServerTargetHost:                   payload.RFCMessageServerTargetHost                  || '',
    IsRFCFastSerializationActive:                 payload.IsRFCFastSerializationActive                ?? false,
    DestinationServiceUUID:                       payload.DestinationServiceUUID                      || '00000000-0000-0000-0000-000000000000',
    DestinationServiceName:                       payload.DestinationServiceName                      || '',
    IsDefaultDestinationServiceActive:            payload.IsDefaultDestinationServiceActive           ?? false,
    IsHubSystem:                                  payload.IsHubSystem                                 ?? false,
    IsInboundOnly:                                payload.IsInboundOnly                               ?? false,
    IsSAMLBearerAssertionProviderActive:          payload.IsSAMLBearerAssertionProviderActive         ?? false,
    SAMLBearerAssertionProviderName:              payload.SAMLBearerAssertionProviderName             || '',
    SAMLBearerAssertionProviderCertificateSubject:  payload.SAMLBearerAssertionProviderCertificateSubject  || '',
    SAMLBearerAssertionProviderCertificateIssuer:   payload.SAMLBearerAssertionProviderCertificateIssuer   || '',
    SAMLBearerAssertionProviderCertificatePublicKeyBase64: payload.SAMLBearerAssertionProviderCertificatePublicKeyBase64 || '',
    SAMLBearerAssertionProviderUserLogonType:     payload.SAMLBearerAssertionProviderUserLogonType    || '',
  };

  console.log(`[CS BODY] ${JSON.stringify(body)}`);

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CS, ENTITY_CS, body);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    const parsed = tryParse(text);
    const msg = parsed?.error?.message || text;
    if (status === 400 && (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists'))) {
      return res.json({ ok: true, skipped: true, reason: 'Zaten mevcut' });
    }
    if (status === 400 && msg.toLowerCase().includes('authorizations')) {
      console.error(`[CS POST ERR] ${status}:`, text.slice(0, 800));
      return res.status(status).json({ ok: false, error: 'Yetki hatası: Hedef sistemde Communication System oluşturma yetkisi eksik. SAP_COM_0A48 arrangement\'ında CS yazma yetkisi kontrol edilmeli.', detail: text.slice(0, 800) });
    }
    console.error(`[CS POST ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   POST — CA için CommunicationSystemID çözümle
   Kaynak sistemden CS ID ile CS çek → Name al
   Hedef sistemde Name eşleşen CS'i bul → ID döndür
   ════════════════════════════════════════════════════ */
app.post('/api/comm-systems/resolve-id', async (req, res) => {
  const { srcUrl, srcUser, srcPass, tgtUrl, tgtUser, tgtPass, communicationSystemID } = req.body;
  if (!srcUrl || !srcUser || !srcPass || !tgtUrl || !tgtUser || !tgtPass || !communicationSystemID) {
    return res.status(400).json({ error: 'Parametre eksik.' });
  }

  const srcBase = buildApiBase(srcUrl);
  const tgtBase = buildApiBase(tgtUrl);
  const srcAuth = basicAuth(srcUser, srcPass);
  const tgtAuth = basicAuth(tgtUser, tgtPass);

  try {
    /* 1 — Kaynak sistemden CS'i ID ile çek → Name al */
    const srcOdataUrl = `${srcBase}${BASE_CS}/${ENTITY_CS}?$filter=ID eq '${encodeURIComponent(communicationSystemID)}'&$top=1`;
    const srcResp = await fetch(srcOdataUrl, { headers: sapHeaders(srcAuth), signal: AbortSignal.timeout(10000) });
    log('GET(src-cs)', srcOdataUrl, srcResp.status);

    if (!srcResp.ok) {
      const txt = await srcResp.text();
      return res.status(srcResp.status).json({ error: `Kaynak sistemde CS bulunamadı (${srcResp.status})`, detail: txt.slice(0, 300) });
    }
    const srcJson = await srcResp.json();
    const srcCS   = (srcJson.value || [])[0];
    if (!srcCS) {
      return res.status(404).json({ error: `Kaynak sistemde ID="${communicationSystemID}" olan CS bulunamadı` });
    }
    const srcName = srcCS.Name || srcCS.ID;
    console.log(`[CS-RESOLVE] Kaynak CS: ID=${srcCS.ID} Name=${srcName}`);

    /* 2 — Hedef sistemde önce ID ile direkt ara */
    const tgtByIdUrl  = `${tgtBase}${BASE_CS}/${ENTITY_CS}?$filter=ID eq '${encodeURIComponent(communicationSystemID)}'&$top=1`;
    const tgtByIdResp = await fetch(tgtByIdUrl, { headers: sapHeaders(tgtAuth), signal: AbortSignal.timeout(10000) });
    log('GET(tgt-cs-byid)', tgtByIdUrl, tgtByIdResp.status);

    if (tgtByIdResp.ok) {
      const tgtByIdJson = await tgtByIdResp.json();
      const byId = (tgtByIdJson.value || [])[0];
      if (byId) {
        console.log(`[CS-RESOLVE] Hedef ID eşleşmesi: ID=${byId.ID}`);
        return res.json({ ok: true, systemID: byId.ID, system: byId });
      }
    }

    /* 3 — ID ile bulunamazsa Name ile ara */
    const tgtByNameUrl  = `${tgtBase}${BASE_CS}/${ENTITY_CS}?$filter=Name eq '${encodeURIComponent(srcName)}'&$top=1`;
    const tgtByNameResp = await fetch(tgtByNameUrl, { headers: sapHeaders(tgtAuth), signal: AbortSignal.timeout(10000) });
    log('GET(tgt-cs-byname)', tgtByNameUrl, tgtByNameResp.status);

    if (tgtByNameResp.ok) {
      const tgtByNameJson = await tgtByNameResp.json();
      const byName = (tgtByNameJson.value || [])[0];
      if (byName) {
        console.log(`[CS-RESOLVE] Hedef Name eşleşmesi: Name=${byName.Name} → ID=${byName.ID}`);
        return res.json({ ok: true, systemID: byName.ID, system: byName });
      }
    }

    return res.status(404).json({ error: `Hedef sistemde ID="${communicationSystemID}" veya Name="${srcName}" olan CS bulunamadı` });
  
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   GET — CS içindeki InboundUsers + OutboundUsers
   ID'ye göre tek CS çeker (expand ile)
   ════════════════════════════════════════════════════ */
app.get('/api/comm-systems/users', async (req, res) => {
  const { url, user, pass, id } = req.query;
  if (!url || !user || !pass || !id) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase  = buildApiBase(url);
  const auth     = basicAuth(user, pass);
  const odataUrl = `${apiBase}${BASE_CS}/${ENTITY_CS}?$filter=ID eq '${encodeURIComponent(id)}'&$expand=InboundUsers,OutboundUsers&$top=1`;

  try {
    const resp = await fetch(odataUrl, { headers: sapHeaders(auth), signal: AbortSignal.timeout(10000) });
    log('GET(cs-users)', odataUrl, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `SAP HTTP ${resp.status}`, detail: text.slice(0, 400) });
    }
    const json = await resp.json();
    const cs   = (json.value || [])[0];
    if (!cs) return res.status(404).json({ error: `CS bulunamadı: ${id}` });
    console.log(`[CS-USERS] ID=${id} inbound=${cs.InboundUsers?.length || 0} outbound=${cs.OutboundUsers?.length || 0}`);
    res.json({ ok: true, inboundUsers: cs.InboundUsers || [], outboundUsers: cs.OutboundUsers || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CREATE — Communication Arrangement
   Body: ScenarioID + SystemID + Name + InboundUserUUID + OutboundUserUUID
   ════════════════════════════════════════════════════ */
app.post('/api/comm-arrangements/create', async (req, res) => {
  const { url, user, pass, payload } = req.body;
  if (!url || !user || !pass || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase = buildApiBase(url);
  const auth    = basicAuth(user, pass);

  const createBody = {
    CommunicationScenarioID: payload.CommunicationScenarioID || '',
    Name:                    payload.Name                    || '',
    Description:             payload.Description             || '',
  };
  if (payload.CommunicationSystemID) createBody.CommunicationSystemID = payload.CommunicationSystemID;

  /* Deep insert — InboundUser (GET'ten gelen yapı, sadece UUID güncellenerek) */
  if (payload.InboundUser) {
    createBody.InboundUser = { ...payload.InboundUser };
  }

  /* Deep insert — OutboundUser (GET'ten gelen yapı aynen) */
  if (payload.OutboundUser) {
    createBody.OutboundUser = { ...payload.OutboundUser };
  }

  /* Deep insert — InboundServices (GET'ten gelen yapı aynen) */
  if (Array.isArray(payload.InboundServices) && payload.InboundServices.length > 0) {
    createBody.InboundServices = payload.InboundServices;
  }

  /* Deep insert — OutboundServices (GET'ten gelen yapı aynen) */
  if (Array.isArray(payload.OutboundServices) && payload.OutboundServices.length > 0) {
    createBody.OutboundServices = payload.OutboundServices;
  }

  /* Properties */
  if (Array.isArray(payload.Properties) && payload.Properties.length > 0) {
    createBody.Properties = payload.Properties;
  }

  console.log(`[CA CREATE BODY] ${JSON.stringify(createBody)}`);

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CA, ENTITY_CA, createBody);
    console.log(`[CA CREATE RESPONSE] status=${status} body=${text.slice(0, 1000)}`);

    if (!ok) {
      const parsed = tryParse(text);
      const msg    = parsed?.error?.message || text;
      if (status === 400 && (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists'))) {
        return res.json({ ok: true, skipped: true, reason: 'Zaten mevcut' });
      }
      console.error(`[CA POST ERR] ${status}:`, text.slice(0, 800));
      return res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
    }

    const created = tryParse(text);
    return res.json({ ok: true, data: created });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CS — InboundUser ekle
   POST .../CommunicationSystems(UUID)/InboundUsers
   ════════════════════════════════════════════════════ */
app.post('/api/comm-systems/inbound-user', async (req, res) => {
  const { url, user, pass, systemUUID, payload } = req.body;
  if (!url || !user || !pass || !systemUUID || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase    = buildApiBase(url);
  const auth       = basicAuth(user, pass);
  const entityPath = `${ENTITY_CS}(${systemUUID})/InboundUsers`;
  const body       = {
    CommunicationUserID:          payload.CommunicationUserID,
    AuthenticationMethod:         payload.AuthenticationMethod         || 'basic',
    OAuth2GrantType:              payload.OAuth2GrantType              || '',
    IsOAuth2RefreshTokenAllowed:  payload.IsOAuth2RefreshTokenAllowed  ?? false,
    OAuth2RefreshTokenExpiryValue: payload.OAuth2RefreshTokenExpiryValue ?? 0,
    OAuth2RefreshTokenExpiryUnit: payload.OAuth2RefreshTokenExpiryUnit || '',
    OAuth2ClientID:               payload.OAuth2ClientID               || '',
  };

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CS, entityPath, body);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    const parsed = tryParse(text);
    const msg = parsed?.error?.message || text;
    if (status === 400 && (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists'))) {
      return res.json({ ok: true, skipped: true, reason: 'Zaten mevcut' });
    }
    console.error(`[CS INBOUND ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CS — OutboundUser ekle
   POST .../CommunicationSystems(UUID)/OutboundUsers
   OutboundUsers'da CommunicationUserID yoktur — Name kullanılır
   ════════════════════════════════════════════════════ */
app.post('/api/comm-systems/outbound-user', async (req, res) => {
  const { url, user, pass, systemUUID, payload } = req.body;
  if (!url || !user || !pass || !systemUUID || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase    = buildApiBase(url);
  const auth       = basicAuth(user, pass);
  const entityPath = `${ENTITY_CS}(${systemUUID})/OutboundUsers`;
  const body       = {
    Name:                           payload.Name                           || '',
    AuthenticationMethod:           payload.AuthenticationMethod           || 'basic',
    OAuth2ClientID:                 payload.OAuth2ClientID                 || '',
    OAuth2ClientAuthenticationMethod: payload.OAuth2ClientAuthenticationMethod || '',
    Password:                       'SapCommunication12345!',
  };

  console.log(`[CS OUTBOUND BODY] systemUUID=${systemUUID} body=${JSON.stringify(body)}`);

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CS, entityPath, body);
    console.log(`[CS OUTBOUND RESPONSE] status=${status} body=${text.slice(0, 500)}`);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    const parsed = tryParse(text);
    const msg = parsed?.error?.message || text;
    if (status === 400 && (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists'))) {
      return res.json({ ok: true, skipped: true, reason: 'Zaten mevcut' });
    }
    console.error(`[CS OUTBOUND ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CA — InboundUser set et
   POST .../CommunicationArrangements(UUID)/InboundUser
   ════════════════════════════════════════════════════ */
app.post('/api/comm-arrangements/inbound-user', async (req, res) => {
  const { url, user, pass, arrangementUUID, payload } = req.body;
  if (!url || !user || !pass || !arrangementUUID || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase    = buildApiBase(url);
  const auth       = basicAuth(user, pass);
  const entityPath = `${ENTITY_CA}(${arrangementUUID})/InboundUser`;
  const body       = {
    CommunicationSystemInboundUserUUID: payload.CommunicationSystemInboundUserUUID,
  };

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CA, entityPath, body);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    console.error(`[CA INBOUND ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   CA — OutboundUser set et
   POST .../CommunicationArrangements(UUID)/OutboundUser
   ════════════════════════════════════════════════════ */
app.post('/api/comm-arrangements/outbound-user', async (req, res) => {
  const { url, user, pass, arrangementUUID, payload } = req.body;
  if (!url || !user || !pass || !arrangementUUID || !payload) return res.status(400).json({ error: 'Parametre eksik.' });

  const apiBase    = buildApiBase(url);
  const auth       = basicAuth(user, pass);
  const entityPath = `${ENTITY_CA}(${arrangementUUID})/OutboundUser`;
  const body       = {
    CommunicationSystemOutboundUserUUID: payload.CommunicationSystemOutboundUserUUID,
  };

  try {
    const { status, ok, text } = await csrfPost(apiBase, auth, BASE_CA, entityPath, body);
    if (ok) return res.json({ ok: true, data: tryParse(text) });
    console.error(`[CA OUTBOUND ERR] ${status}:`, text.slice(0, 800));
    res.status(status).json({ ok: false, error: `SAP HTTP ${status}`, detail: text.slice(0, 800) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});


/* ════════════════════════════════════════════════════
   START
   ════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log(' SAP Communication Objects Migrator');
  console.log('========================================');
  console.log(` Adres : http://localhost:${PORT}`);
  console.log('========================================\n');
});
