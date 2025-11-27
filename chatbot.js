// WhatsApp Bot - Fixed Version
const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
const contatosData = require(path.join(__dirname, 'contatos_filtrados.json'));
const contatos = Array.isArray(contatosData) ? contatosData : (contatosData && Array.isArray(contatosData.contatos) ? contatosData.contatos : []);
const fs = require('fs');
const os = require('os');
const qrDisplay = require('./qr_display');

// Configuration
const TARGET_TIMEZONE = process.env.BOT_TIMEZONE || 'America/Sao_Paulo';
const MAX_OPA = process.env.MAX_OPA ? Number(process.env.MAX_OPA) : 50;
const LAST_N = process.env.LAST_N ? Number(process.env.LAST_N) : 8;

// ============ HELPER FUNCTIONS ============

function getHourInTimeZone(timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' });
    const parts = dtf.formatToParts(new Date());
    const hourPart = parts.find(p => p.type === 'hour');
    if (hourPart && hourPart.value) return Number(hourPart.value);
  } catch (e) {
    if (process.env.WPP_DEBUG_MATCH) console.log('⚠️ getHourInTimeZone failed:', e && e.message ? e.message : e);
  }
  return new Date().getHours();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// DISABLED: Função de espera de horário de envio – comentada para permitir envios a qualquer hora
// async function waitUntilSendWindow() {
//   while (!isWithinSendWindow()) {
//     const hr = getHourInTimeZone(TARGET_TIMEZONE);
//     console.log(`⏳ Fora do horário de envio no fuso ${TARGET_TIMEZONE} (hora local lá: ${hr}) – verificando novamente em 60s.`);
//     await delay(60000);
//   }
// }

// function isWithinSendWindow() {
//   const hour = getHourInTimeZone(TARGET_TIMEZONE);
//   return hour >= 13 && hour < 18;
// }

function removerAcentos(str) {
  if (!str) return '';
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarNomeContato(contato) {
  const name = contato && (contato.nome || contato.name || contato.formattedName || '');
  if (!name) return '';
  return String(name).trim();
}

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

function normalizeChatId(chatId) {
  if (!chatId) return '';
  const idStr = String(chatId);
  if (idStr.includes('@')) {
    const parts = idStr.split('@');
    return normalizePhone(parts[0]);
  }
  return normalizePhone(idStr);
}

function levenshtein(s1, s2) {
  const a = String(s1 || '').toLowerCase();
  const b = String(s2 || '').toLowerCase();
  const arr = [];
  for (let i = 0; i <= b.length; i++) {
    arr[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    arr[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const marker = a[j - 1] === b[i - 1] ? 0 : 1;
      arr[i][j] = Math.min(
        arr[i][j - 1] + 1,
        arr[i - 1][j] + 1,
        arr[i - 1][j - 1] + marker
      );
    }
  }
  return arr[b.length][a.length];
}

function fuzzyMatch(s1, s2, threshold = 0.8) {
  const a = String(s1 || '').toLowerCase();
  const b = String(s2 || '').toLowerCase();
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const similarity = 1 - (dist / maxLen);
  return similarity >= threshold;
}

function isLikelyHumanMessage(msg) {
  if (!msg || !msg.body) return false;
  const body = String(msg.body).toLowerCase();
  if (body.length < 2) return false;
  const autoIndicators = [
    'mensagem automática', 'resposta automática', 'auto-reply',
    'estou fora', 'estou ausente', 'fora do horário',
    'message rate', 'typing', 'media omitted'
  ];
  for (const indicator of autoIndicators) {
    if (body.includes(indicator)) return false;
  }
  return true;
}

async function chatExists(client, chatId) {
  if (!client || !client.getChatById) return false;
  try {
    const chat = await client.getChatById(chatId);
    return chat && chat.id ? true : false;
  } catch (e) {
    return false;
  }
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const today = new Date().toISOString().slice(0, 10);
const foundViaUiPath = path.join(__dirname, `found_via_ui_${today}.json`);

function saveFound(evt) {
  try {
    let arr = [];
    if (fs.existsSync(foundViaUiPath)) {
      const raw = fs.readFileSync(foundViaUiPath, 'utf8');
      if (raw && raw.trim()) {
        try { arr = JSON.parse(raw); } catch (e) { arr = []; }
      }
    }
    arr.push(evt);
    fs.writeFileSync(foundViaUiPath, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { /* ignore logging failures */ }
}

async function uiFindContactByExactName(client, displayName) {
  if (!client || !client.pupPage || !displayName) return null;
  const today = new Date().toISOString().slice(0, 10);
  const foundViaUiPath = path.join(__dirname, `found_via_ui_${today}.json`);
  
  try {
    const page = client.pupPage;
    const searchSelector = 'div[title="Procurar ou começar uma nova conversa"]';
    await page.waitForSelector(searchSelector, { timeout: 3000 });
    const searchEl = await page.$(searchSelector);
    if (!searchEl) return null;
    
    await searchEl.click();
    await delay(200 + Math.floor(Math.random() * 300));
    await page.keyboard.down('Control'); 
    await page.keyboard.press('A'); 
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await delay(120);
    await page.type(searchSelector, displayName, { delay: 80 });
    await delay(900 + Math.floor(Math.random() * 600));
    
    const results = await page.$$('span[title]');
    const normTarget = removerAcentos(String(displayName).toLowerCase().replace(/ +/g, ' ').trim());
    
    for (const r of results) {
      try {
        const title = await page.evaluate(el => el.getAttribute('title'), r);
        if (!title) continue;
        const normTitle = removerAcentos(String(title).toLowerCase().replace(/ +/g, ' ').trim());
        let matched = false;
        if (normTitle === normTarget) matched = true;
        if (!matched && (normTitle.includes(normTarget) || normTarget.includes(normTitle))) matched = true;
        if (!matched && typeof fuzzyMatch === 'function' && fuzzyMatch(title, displayName)) matched = true;
        
        if (matched) {
          await r.click();
          await delay(300 + Math.floor(Math.random() * 400));
          let opened = null;
          try { opened = await page.$eval('header span[title]', el => el.getAttribute('title')); } catch (hdrErr) {}
          const logEvt = { searchedName: displayName, foundTitle: title, openedHeader: opened || null, ts: new Date().toISOString() };
          saveFound(logEvt);
          return null;
        }
      } catch (e) { /* ignore per-result errors */ }
    }
    
    try { 
      await page.keyboard.down('Control'); 
      await page.keyboard.press('A'); 
      await page.keyboard.up('Control'); 
      await page.keyboard.press('Backspace'); 
    } catch (e) {}
    return null;
  } catch (e) {
    return null;
  }
}

// State variables
let enviados = 0;
let falhas = 0;
const contatosIniciados = new Map();

// Session management
let sessionName = process.env.WPP_SESSION || 'disparador';
const tokensRoot = path.join(__dirname, 'tokens');

try {
  if (!fs.existsSync(tokensRoot)) fs.mkdirSync(tokensRoot, { recursive: true });
  const entries = fs.readdirSync(tokensRoot).filter(n => n && n.indexOf('.') !== 0);
  let candidate = entries.find(n => n === sessionName);
  if (!candidate) {
    const matches = entries.filter(n => n.startsWith(sessionName));
    if (matches.length > 0) {
      matches.sort((a, b) => {
        const sa = fs.statSync(path.join(tokensRoot, a)).mtimeMs;
        const sb = fs.statSync(path.join(tokensRoot, b)).mtimeMs;
        return sb - sa;
      });
      candidate = matches[0];
    }
  }
  if (candidate) {
    sessionName = candidate;
    console.log('ℹ️ Reutilizando sessão existente:', sessionName);
  } else {
    sessionName = `${sessionName}-auth-${Date.now()}`;
    console.log('ℹ️ Nenhuma sessão encontrada – criando nova sessão:', sessionName);
  }
} catch (e) {
  console.log('⚠️ Erro ao inspecionar a pasta de tokens:', e && e.message ? e.message : e);
  sessionName = `${sessionName}-auth-${Date.now()}`;
}

console.log('ℹ️ Using session:', sessionName);
console.log('ℹ️ Script __dirname:', __dirname);
console.log('✅ Iniciando wppconnect.create() – aguardando QR code...\n');

// ============ MAIN BOT ============

wppconnect.create({
  session: sessionName,
  headless: process.env.HEADLESS !== 'false' ? true : false,
  autoClose: 0,
  waitForLogin: false,
  logQR: true,
  disableWelcome: false,
  // Increase protocolTimeout to avoid Runtime.callFunctionOn timed out errors during heavy CDP calls
  // Default: 3000000ms (50 minutes) to handle slow contact fetches
  protocolTimeout: process.env.PROTOCOL_TIMEOUT ? Number(process.env.PROTOCOL_TIMEOUT) : 3000000,
  catchQR: qrDisplay.setupQRDisplay(),
  puppeteerOptions: {
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  // Keep launch timeout unlimited by default; can be overridden via env
  timeout: process.env.PUPPETEER_LAUNCH_TIMEOUT ? Number(process.env.PUPPETEER_LAUNCH_TIMEOUT) : 0,
    dumpio: process.env.PUPPETEER_DUMPIO ? (process.env.PUPPETEER_DUMPIO === '1' || process.env.PUPPETEER_DUMPIO === 'true') : false,
    defaultViewport: null
  }
}).then(async (client) => {
  console.log('\n✅ ✅ ✅ BOT CONECTADO ✅ ✅ ✅\n');
  
  await delay(3000);
  let isReallyLogged = false;
  try {
    const profileName = await client.getProfileName();
    console.log('✅ Perfil obtido:', profileName);
    isReallyLogged = profileName && String(profileName).trim().length > 0;
  } catch (e) {
    console.log('ℹ️ Erro ao obter perfil:', e && e.message ? e.message : 'desconhecido');
    isReallyLogged = false;
  }
  
  if (!isReallyLogged) {
    console.log('\n🔐 DETECÇÃO: Sessão NÃO está autenticada!');
    console.log('⏳ Verificando página para QR code...\n');
  } else {
    console.log('🎉 Sessão conectada ao WhatsApp!\n');
  }

  // Load started contacts from disk
  const STARTED_FILE = path.join(__dirname, 'contatos_iniciados.json');
  
  function loadStartedFromDisk() {
    try {
      if (fs.existsSync(STARTED_FILE)) {
        const raw = fs.readFileSync(STARTED_FILE, 'utf8');
        const obj = JSON.parse(raw || '{}');
        contatosIniciados.clear();
        if (Array.isArray(obj)) {
          obj.forEach(item => {
            if (item && item.chatId) contatosIniciados.set(String(item.chatId), item);
          });
        } else {
          Object.entries(obj).forEach(([k, v]) => contatosIniciados.set(String(k), v));
        }
        console.log(`ℹ️ Loaded ${contatosIniciados.size} started contacts from ${STARTED_FILE}`);
      }
    } catch (e) {
      console.log('⚠️ Erro ao carregar contatos iniciados:', e && e.message ? e.message : e);
    }
  }

  function saveStartedToDisk() {
    try {
      const obj = Object.fromEntries(Array.from(contatosIniciados.entries()));
      fs.writeFileSync(STARTED_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.log('⚠️ Erro ao salvar contatos iniciados:', e && e.message ? e.message : e);
    }
  }

  loadStartedFromDisk();

  // Message listener
  client.onMessage(async (msg) => {
    try {
      if (msg.fromMe) return;
      if (msg.isGroupMsg) return;
      if (msg.type === 'status') return;
      if (msg.isNotification || msg.isBot) return;

      const chatId = msg.from;
      const incomingNorm = normalizeChatId(chatId);

      function getMessageUniqueId(m) {
        if (!m) return null;
        if (m.id) return typeof m.id === 'string' ? m.id : (m.id.id || m.id._serialized || JSON.stringify(m.id));
        if (m._serialized) return m._serialized;
        if (m.key && m.key.id) return m.key.id;
        if (m.id && m.id._serialized) return m.id._serialized;
        try { return JSON.stringify(m); } catch (e) { return null; }
      }

      const incomingMsgId = getMessageUniqueId(msg);
      const now = Date.now();

      const startedInfo = contatosIniciados.get(incomingNorm);
      if (startedInfo) {
        if (incomingMsgId && startedInfo.lastMsgId && incomingMsgId === startedInfo.lastMsgId) {
          console.log(`⚠️ Mensagem duplicada de ${incomingNorm} (mesmo id) – ignorando.`);
          return;
        }
        const lastResp = startedInfo.lastRespondedAt || 0;
        if (now - lastResp < 5000) {
          console.log(`⚠️ Resposta recente de ${incomingNorm} detectada (${Math.round(now - lastResp)}ms) – ignorando para evitar duplicatas.`);
          return;
        }
      }

      if (!contatosIniciados.has(incomingNorm)) {
        console.log(`⚠️ Mensagem recebida de ${incomingNorm} mas não iniciada por este bot – ignorando.`);
        return;
      }

      try {
        const startedEntry = contatosIniciados.get(incomingNorm) || {};
        const startedAt = startedEntry.startedAt || 0;
        if (startedAt && (now - startedAt) < 5000) {
          if (process.env.WPP_DEBUG_MATCH) console.log(`🔍 Ignoring message from ${incomingNorm} because it arrived ${now - startedAt}ms after start`);
          console.log(`⚠️ Mensagem de ${incomingNorm} chegou logo após início (${Math.round(now - startedAt)}ms) – provável automática – ignorando.`);
          return;
        }
      } catch (e) { /* ignore errors */ }

      let startedInfoCheck = contatosIniciados.get(incomingNorm);
      if (startedInfoCheck && startedInfoCheck.audioSent) {
        console.log(`ℹ️ Áudio já enviado anteriormente para ${incomingNorm} – ignorando envio duplicado.`);
        return;
      }

      if (!isLikelyHumanMessage(msg)) {
        console.log(`⚠️ Mensagem de ${incomingNorm} parece automática/sistema – ignorando.`);
        return;
      }

      const body = (msg.body || '').toString().toLowerCase();
      const autoPatterns = [
        'mensagem automática', 'resposta automática', 'auto-reply', 'auto reply',
        'estou fora', 'estou ausente', 'fora do horário',
        'mensagem de ausência', 'serviço'
      ];
      const autoRegex = /\b(auto|automático|ausente|fora|indisponível|ausência)\b/i;
      if (!body || autoPatterns.some(p => body.includes(p)) || autoRegex.test(body)) {
        console.log(`⚠️ Mensagem parece automática/sistema de ${chatId} – ignorando.`);
        return;
      }

      const audioPath = path.join(__dirname, 'audio_resposta.ogg');
      if (!fs.existsSync(audioPath)) {
        console.log(`⚠️ Arquivo de áudio não encontrado em ${audioPath}.`);
        return;
      }

      try {
        const startedInfo2 = contatosIniciados.get(incomingNorm);
        const targetId = startedInfo2 && startedInfo2.chatIdOriginal ? startedInfo2.chatIdOriginal : chatId;
        
        if (startedInfo2) {
          startedInfo2.audioSent = true;
          contatosIniciados.set(incomingNorm, startedInfo2);
          try { saveStartedToDisk(); } catch (e) { /* ignore */ }
        }
        
        if (client.sendPtt && typeof client.sendPtt === 'function') {
          await client.sendPtt(targetId, audioPath);
        } else if (client.sendFile && typeof client.sendFile === 'function') {
          await client.sendFile(targetId, audioPath, 'audio.ogg', '', { sendAudioAsVoice: true });
        } else if (client.sendText && typeof client.sendText === 'function') {
          await sendTextWithRetries(client, targetId, 'Não foi possível enviar o áudio automaticamente.');
        } else {
          throw new Error('Nenhum método de envio de áudio suportado pelo client');
        }
        
        console.log(`🎤 Áudio enviado para ${incomingNorm}`);
        
        if (startedInfo2) {
          if (incomingMsgId) startedInfo2.lastMsgId = incomingMsgId;
          startedInfo2.lastRespondedAt = now;
          contatosIniciados.set(incomingNorm, startedInfo2);
        }
      } catch (e) {
        console.log(`❌ Erro ao enviar áudio para ${incomingNorm}: ${e && e.message ? e.message : e}`);
      }
    } catch (err) {
      console.log('❌ Erro no onMessage:', err.message);
    }
  });

  console.log('⏳ Aguardando 2 minutos para carregar contatos...');
  await delay(120000);

  // Build contact indices
  let todosContatos = [];
  let contatoMap = new Map();
  let phoneMap = new Map();
  let lastNMap = new Map();
  let tokenIndex = new Map();
  let formattedNameMap = new Map();

  function extractDigitsFromId(c) {
    try {
      const idStr = c && (c.id && (typeof c.id === 'string' ? c.id : (c.id._serialized || '')) || c._serialized || '');
      if (idStr) {
        const digits = (idStr.match(/\d+/g) || []).join('');
        return normalizePhone(digits);
      }
      if (c && c.number) return normalizePhone(String(c.number));
      return '';
    } catch (e) { return ''; }
  }

  function rebuildIndices() {
    contatoMap = new Map(
      todosContatos
        .filter(c => c.name)
        .map(c => [removerAcentos(c.name.toLowerCase().replace(/ +/g, ' ').trim()), c])
    );
    phoneMap = new Map();
    lastNMap = new Map();
    tokenIndex = new Map();
    formattedNameMap = new Map();

    todosContatos.forEach(c => {
      const p = extractDigitsFromId(c);
      if (p) {
        if (!phoneMap.has(p)) phoneMap.set(p, c);
        const last = p.slice(-LAST_N);
        if (!lastNMap.has(last)) lastNMap.set(last, []);
        lastNMap.get(last).push(c);
      }
      if (c.name) {
        const n = removerAcentos(c.name.toLowerCase().replace(/ +/g, ' ').trim());
        const tokens = n.split(' ').filter(t => t.length > 2);
        tokens.forEach(t => {
          if (!tokenIndex.has(t)) tokenIndex.set(t, new Set());
          tokenIndex.get(t).add(c);
        });
      }
      if (c.formattedName) formattedNameMap.set(removerAcentos(String(c.formattedName).toLowerCase()), c);
    });

    try {
      const logContatosPath = path.join(__dirname, 'log_contatos_wpp.txt');
      fs.writeFileSync(logContatosPath, 'id | name | isMyContact | normalizado\n');
      todosContatos.forEach(c => {
        if (c.name) {
          fs.appendFileSync(logContatosPath, `${c.id} | ${c.name} | ${c.isMyContact} | ${removerAcentos(c.name.toLowerCase().replace(/ +/g, ' '))}\n`);
        }
      });
    } catch (e) {
      console.log('⚠️ Erro ao atualizar log_contatos_wpp.txt:', e && e.message ? e.message : e);
    }
  }

  const AGENDA_CACHE_FILE = path.join(__dirname, 'agenda_cache.json');

  function loadAgendaCache() {
    try {
      if (fs.existsSync(AGENDA_CACHE_FILE)) {
        const raw = fs.readFileSync(AGENDA_CACHE_FILE, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`ℹ️ Carregando ${parsed.length} contatos do cache em ${AGENDA_CACHE_FILE}`);
            return parsed;
          }
        }
      }
    } catch (e) {
      console.log('⚠️ Erro ao carregar cache de agenda:', e && e.message ? e.message : e);
    }
    return null;
  }

  function saveAgendaCache(list) {
    try {
      if (!Array.isArray(list) || list.length === 0) {
        console.log('⚠️ saveAgendaCache: lista vazia – não sobrescrevendo o cache.');
        return false;
      }
      fs.writeFileSync(AGENDA_CACHE_FILE, JSON.stringify(list, null, 2), 'utf8');
      console.log(`✅ Agenda salva em cache (${AGENDA_CACHE_FILE}) – ${list.length} contatos`);
      return true;
    } catch (e) {
      console.log('⚠️ Erro ao salvar cache de agenda:', e && e.message ? e.message : e);
      return false;
    }
  }

  const cached = loadAgendaCache();
  if (cached) {
    todosContatos = cached;
    try { rebuildIndices(); } catch (e) { console.log('⚠️ Erro rebuildIndices após carregar cache:', e && e.message ? e.message : e); }
  }

  // Helper: fetch contacts with retries to avoid transient protocol timeouts
  async function fetchContactsWithRetries(client, attempts = 5, waitMs = 15000) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const contacts = await (client.listContacts ? client.listContacts() : (client.getAllContacts ? client.getAllContacts() : []));
        return contacts || [];
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? err.message : String(err);
        console.log(`⚠️ fetchContactsWithRetries: tentativa ${i+1}/${attempts} falhou: ${msg}`);
        // If last attempt, break and rethrow below
        if (i < attempts - 1) {
          const backoffMs = waitMs * (i + 1);
          console.log(`   ↻ Aguardando ${Math.round(backoffMs / 1000)}s antes de tentar novamente...`);
          await delay(backoffMs);
        }
      }
    }
    throw lastErr;
  }

  // Helper: send text with retries to mitigate transient protocol/CDP timeouts
  async function sendTextWithRetries(client, chatId, text, attempts = process.env.SEND_RETRIES ? Number(process.env.SEND_RETRIES) : 3, waitMs = process.env.SEND_RETRY_WAIT_MS ? Number(process.env.SEND_RETRY_WAIT_MS) : 7000) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        if (!client) throw new Error('client not available');
        // Prefer native sendText when available
        if (client.sendText && typeof client.sendText === 'function') {
          return await client.sendText(chatId, text);
        }
        // Fallback to generic sendMessage if present
        if (client.sendMessage && typeof client.sendMessage === 'function') {
          return await client.sendMessage(chatId, { text });
        }
        throw new Error('no send method available on client');
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? err.message : String(err);
        console.log(`⚠️ sendTextWithRetries: tentativa ${i+1} para ${chatId} falhou: ${msg}`);
        // If not last attempt, wait with simple backoff
        if (i < attempts - 1) {
          const backoff = waitMs * (i + 1);
          console.log(`   ↻ Aguardando ${Math.round(backoff / 1000)}s antes de nova tentativa...`);
          await delay(backoff);
        }
      }
    }
    // After attempts exhausted, rethrow the last error
    throw lastErr;
  }

  try {
    const fresh = await fetchContactsWithRetries(client, process.env.CONTACTS_FETCH_RETRIES ? Number(process.env.CONTACTS_FETCH_RETRIES) : 5, process.env.CONTACTS_FETCH_WAIT_MS ? Number(process.env.CONTACTS_FETCH_WAIT_MS) : 15000);
    if (Array.isArray(fresh) && fresh.length > 0) {
      todosContatos = fresh;
      rebuildIndices();
      saveAgendaCache(fresh);
      console.log(`ℹ️ Contatos carregados do WhatsApp: ${todosContatos.length}`);
    } else {
      if (!cached) console.log('⚠️ Não foi possível obter contatos do WhatsApp e não existe cache local.');
      else console.log('⚠️ Lista do WhatsApp vazia – mantendo cache local.');
    }
  } catch (e) {
    console.log('❌ Erro ao obter contatos iniciais do WhatsApp (após tentativas):', e && e.message ? e.message : e);
  }

  const allowedNumbers = new Set(contatos.map(c => normalizePhone(c.numero)).filter(Boolean));
  console.log(`ℹ️ Números autorizados carregados: ${allowedNumbers.size}`);
  
  // DISABLED: Verificação de horário – comentada para permitir envios a qualquer hora
  // await waitUntilSendWindow();
  // console.log('▶️ Janela de envio aberta no fuso', TARGET_TIMEZONE, '– iniciando envios.');
  
  console.log('▶️ Iniciando envios (sem restrição de horário).');

  for (const [i, contato] of contatos.entries()) {
    if (enviados >= MAX_OPA) {
      console.log(`🚦 Limite de ${MAX_OPA} mensagens 'opa' atingido. Parando envios.`);
      break;
    }
    
    // DISABLED: Verificação de horário de envio – comentada para permitir envios a qualquer hora
    // if (process.env.WPP_DEBUG_MATCH) {
    //   const hr = getHourInTimeZone(TARGET_TIMEZONE);
    //   console.log(`🔍 Hora atual em ${TARGET_TIMEZONE}: ${hr}h – isWithinSendWindow()=${isWithinSendWindow()}`);
    // }
    // 
    // if (!isWithinSendWindow()) {
    //   await waitUntilSendWindow();
    // }
    
    let skipDelay = false;
    const nomeBusca = removerAcentos(normalizarNomeContato(contato).toLowerCase().replace(/ +/g, ' ').trim());
    const mensagem = `Boa tarde`;

    try {
      let contatoAgenda = null;
      const tentativaNumero = contato.numero ? normalizePhone(contato.numero) : null;

      let uiFound = null;
      let uiConfirmed = false;
      if (client && client.pupPage) {
        try {
          uiFound = await uiFindContactByExactName(client, normalizarNomeContato(contato));
          if (uiFound) {
            contatoAgenda = uiFound;
            console.log(`🔍 Encontrado via UI por nome exato: ${contatoAgenda.name}`);
          }
        } catch (uiErr) { 
          if (process.env.WPP_DEBUG_MATCH) console.log('⚠️ UI search error:', uiErr && uiErr.message ? uiErr.message : uiErr); 
        }
      }
      uiConfirmed = !!uiFound;

      if (tentativaNumero && phoneMap.has(tentativaNumero)) {
        contatoAgenda = phoneMap.get(tentativaNumero);
        console.log(`🔍 Encontrado por número exato: ${normalizeChatId(contatoAgenda.id)}`);
      }

      if (!contatoAgenda && tentativaNumero) {
        const last = tentativaNumero.slice(-LAST_N);
        const list = lastNMap.get(last) || [];
        if (list.length === 1) contatoAgenda = list[0];
        else if (list.length > 1) {
          const nomeInt = normalizarNomeContato(contato);
          let best = null, bestScore = -1;
          list.forEach(c => {
            const score = fuzzyMatch(c.name || c.formattedName || '', nomeInt) ? 1 : 0;
            if (score > bestScore) { best = c; bestScore = score; }
          });
          if (best) contatoAgenda = best;
        }
        if (contatoAgenda) console.log(`🔍 Encontrado por últimos dígitos: ${normalizeChatId(contatoAgenda.id)}`);
      }

      if (!contatoAgenda && contatoMap.has(nomeBusca)) {
        contatoAgenda = contatoMap.get(nomeBusca);
        console.log(`🔍 Encontrado no nameMap: ${contatoAgenda.name}`);
      }

      if (!contatoAgenda) {
        const tokens = nomeBusca.split(' ').filter(t => t.length > 2);
        const counter = new Map();
        tokens.forEach(t => {
          const s = tokenIndex.get(t);
          if (s) for (const c of s) counter.set(c, (counter.get(c) || 0) + 1);
        });
        const candidates = Array.from(counter.entries()).sort((a,b) => b[1]-a[1]).map(x=>x[0]);
        if (candidates.length > 0) contatoAgenda = candidates[0];
        if (contatoAgenda) console.log(`🔍 Encontrado por tokenIndex: ${contatoAgenda.name}`);
      }

      if (!contatoAgenda) {
        let best = null, bestScore = 0;
        for (const c of todosContatos) {
          if (!c.name) continue;
          if (!c.isMyContact) continue;
          const n = c.name;
          if (fuzzyMatch(n, normalizarNomeContato(contato))) { best = c; bestScore = 1; break; }
        }
        if (best) { contatoAgenda = best; console.log(`🔍 Encontrado por fuzzy global: ${contatoAgenda.name}`); }
      }

      if (contatoAgenda) {
        try {
          const candidatePhone = extractDigitsFromId(contatoAgenda) || (contatoAgenda.numero ? normalizePhone(contatoAgenda.numero) : null);
          const requestedPhone = tentativaNumero || null;
          if (candidatePhone && !allowedNumbers.has(candidatePhone) && requestedPhone && candidatePhone !== requestedPhone) {
            console.log(`⚠️ Candidato encontrado (${contatoAgenda.name} / ${candidatePhone}) NÃO está na lista filtrada – pulando para evitar envio fora da lista.`);
            skipDelay = true;
            continue;
          }
        } catch (chkErr) { /* ignore check failures and proceed */ }
      }

      if (uiConfirmed && contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id;
        const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) – pulando envio via UI.`);
          if (process.env.WPP_DEBUG_MATCH) console.log(`🔍 skip reason: chatExists true for candidate ${chatId}`);
          skipDelay = true;
        } else {
            try {
            await sendTextWithRetries(client, chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`✅ Mensagem enviada via UI para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend) {
            console.log('❌ Erro envio via UI:', errSend && errSend.message ? errSend.message : errSend);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id;
        const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) – pulando envio por correspondência.`);
          skipDelay = true;
        } else {
          try {
            await sendTextWithRetries(client, chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`✅ Mensagem enviada por correspondência para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend2) {
            console.log('❌ Falha ao enviar por correspondência:', errSend2 && errSend2.message ? errSend2.message : errSend2);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (tentativaNumero) {
        let foundAgendaContact = null;
        try {
          for (const c of todosContatos) {
            try {
              const cand = extractDigitsFromId(c) || (c.number || c.phone || c.numero || '');
              const candNorm = normalizePhone(cand);
              if (candNorm && tentativaNumero && candNorm === tentativaNumero) { foundAgendaContact = c; break; }
              if (candNorm && tentativaNumero && candNorm.slice(-8) === tentativaNumero.slice(-8)) { foundAgendaContact = c; break; }
            } catch (inner) { /* ignore per-contact parse errors */ }
          }
        } catch (e) { /* ignore failures during scan */ }

        if (!foundAgendaContact && contatoMap && contatoMap.has(nomeBusca)) {
          foundAgendaContact = contatoMap.get(nomeBusca);
        }

        if (foundAgendaContact && foundAgendaContact.id) {
          contatoAgenda = foundAgendaContact;
          const chatId = contatoAgenda.id;
          const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) – pulando envio por correspondência de agenda.`);
            skipDelay = true;
          } else {
            try {
              await sendTextWithRetries(client, chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`✅ Mensagem enviada por correspondência (agenda) para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('❌ Falha ao enviar por correspondência (agenda):', errFallback && errFallback.message ? errFallback.message : errFallback);
              falhas++;
              skipDelay = true;
            }
          }
        } else {
          const chatId = `${tentativaNumero}@c.us`;
          const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) – pulando envio por fallback numérico.`);
            skipDelay = true;
          } else {
            try {
              await sendTextWithRetries(client, chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`⚠️ Mensagem enviada por fallback NUMÉRICO para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('❌ Falha no fallback por número:', errFallback && errFallback.message ? errFallback.message : errFallback);
              falhas++;
              skipDelay = true;
            }
          }
        }
      } else {
        console.log(`⚠️ [${i + 1}/${contatos.length}] Contato não encontrado na agenda: ${normalizarNomeContato(contato)} - pulando.`);
        falhas++;
        skipDelay = true;
      }
    } catch (e) {
      console.log(`❌ [${i + 1}/${contatos.length}] Erro ao processar ${normalizarNomeContato(contato)}: ${e.message}`);
      falhas++;
    }

    const restantes = contatos.length - (i + 1);
    console.log(`📊 Progresso: ${enviados} enviados, ${falhas} falhas, ${restantes} restantes.`);

    if (skipDelay) {
      console.log('⏭ Pulando espera devido a falha / chat existente – seguindo para o próximo contato.');
    } else {
      const espera = randomDelay(45000, 75000);
      console.log(`⏳ Aguardando ${Math.round(espera / 1000)} segundos antes do próximo envio...`);
      await delay(espera);
    }
  }

  try {
    fs.writeFileSync(path.join(__dirname, 'log.txt'), `Enviados: ${enviados}\nFalhas: ${falhas}`);
  } catch (e) {}
  console.log(`📊 Envio finalizado: ${enviados} enviados, ${falhas} falhas`);

  console.log('🤖 Bot permanecerá ativo para receber respostas e enviar áudio. Pressione CTRL+C para encerrar.');

  setInterval(() => {
    console.log(`🫡 Bot ativo. Enviados: ${enviados}, Falhas: ${falhas}. ${new Date().toISOString()}`);
  }, 5 * 60 * 1000);

  const SHUTDOWN_HOUR = process.env.SHUTDOWN_HOUR ? Number(process.env.SHUTDOWN_HOUR) : 19;
  const SHUTDOWN_MINUTE = process.env.SHUTDOWN_MINUTE ? Number(process.env.SHUTDOWN_MINUTE) : 30;

  function getMinuteInTimeZone(timeZone) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, minute: '2-digit', hour: '2-digit', second: '2-digit' });
      const parts = dtf.formatToParts(new Date());
      const minutePart = parts.find(p => p.type === 'minute');
      return minutePart ? Number(minutePart.value) : new Date().getMinutes();
    } catch (e) {
      return new Date().getMinutes();
    }
  }

  (function startShutdownWatcher() {
    try {
      console.log(`⏳ Bot ficará ativo até ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} (${TARGET_TIMEZONE}).`);
      const checkInterval = setInterval(async () => {
        try {
          const hr = getHourInTimeZone(TARGET_TIMEZONE);
          const minute = getMinuteInTimeZone(TARGET_TIMEZONE);
          if (hr > SHUTDOWN_HOUR || (hr === SHUTDOWN_HOUR && minute >= SHUTDOWN_MINUTE)) {
            clearInterval(checkInterval);
            console.log(`⏰ ${TARGET_TIMEZONE} alcançou ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} – encerrando bot.`);
            try {
              if (client && client.close) await client.close();
            } catch (e) { console.log('⚠️ Erro ao fechar client durante shutdown:', e && e.message ? e.message : e); }
            process.exit(0);
          }
        } catch (e) { /* ignore transient errors */ }
      }, 30 * 1000);
    } catch (e) {
      console.log('⚠️ Não foi possível iniciar shutdown watcher:', e && e.message ? e.message : e);
    }
  })();

  process.on('SIGINT', async () => {
    console.log('\nℹ️ Recebido SIGINT – encerrando sessão...');
    try {
      if (client && client.close) await client.close();
    } catch (e) {
      console.log('Erro ao fechar client:', e && e.message ? e.message : e);
    }
    process.exit(0);
  });
}).catch((err) => {
  console.log('❌ Erro ao iniciar o bot:', err && err.message ? err.message : String(err));
  console.log('\n🔌 DICAS:');
  console.log('   1. Verifique se a pasta tokens/disparador foi deletada');
  console.log('   2. Verifique se o navegador Chrome está disponível');
  console.log('   3. Tente novamente ou use um novo WPP_SESSION\n');
  process.exit(1);
});
