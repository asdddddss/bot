// (agendamento do reprocessamento Ã© criado dentro do escopo do client)
const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
// Always load contatos from the same folder as this script to avoid mixing copies
const contatosData = require(path.join(__dirname, 'contatos_filtrados.json'));
// Support both shapes: array or { contatos: [...] }
const contatos = Array.isArray(contatosData) ? contatosData : (contatosData && Array.isArray(contatosData.contatos) ? contatosData.contatos : []);
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const qrDisplay = require('./qr_display');
// Timezone configuration: default to Sao Paulo
const TARGET_TIMEZONE = process.env.BOT_TIMEZONE || 'America/Sao_Paulo';

// Return the hour (0-23) in the given IANA time zone using Intl.
function getHourInTimeZone(timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' });
    const parts = dtf.formatToParts(new Date());
    const hourPart = parts.find(p => p.type === 'hour');
    if (hourPart && hourPart.value) return Number(hourPart.value);
  } catch (e) {
    if (process.env.WPP_DEBUG_MATCH) console.log('âš ï¸ getHourInTimeZone failed:', e && e.message ? e.message : e);
  }
  // fallback to local hour
  return new Date().getHours();
}

// Helper: delay for async/await
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wait until the send window opens in the TARGET_TIMEZONE by polling every minute.
async function waitUntilSendWindow() {
  while (!isWithinSendWindow()) {
    const hr = getHourInTimeZone(TARGET_TIMEZONE);
    console.log(`â³ Fora do horÃ¡rio de envio no fuso ${TARGET_TIMEZONE} (hora local lÃ¡: ${hr}) â€” verificando novamente em 60s.`);
    await delay(60000); // check again in 60 seconds
  }
}

// Janela de horÃ¡rio para envio da primeira mensagem (horÃ¡rio local do servidor)
function isWithinSendWindow() {
  // Use the configured target timezone to determine the current hour
  const hour = getHourInTimeZone(TARGET_TIMEZONE);
  // Start sending only from 13:00 until before 18:00 in the target timezone
  return hour >= 13 && hour < 18; // entre 13:00 (inclusive) e 18:00 (exclusive)
}

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

// FunÃ§Ã£o para buscar contato por nome usando a barra de pesquisa
async function searchContactByName(client, displayName, contatoMap) {
  try {
    const page = client.pupPage;
    const searchSelector = 'div[title="Procurar ou comeÃ§ar uma nova conversa"]';
    await page.waitForSelector(searchSelector, { timeout: 3000 });
    const searchEl = await page.$(searchSelector);
    if (!searchEl) return null;
    // simulate human typing
    await searchEl.click();
    await delay(200 + Math.floor(Math.random() * 300));
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
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
        // exact normalized match
        if (normTitle === normTarget) matched = true;
        // includes (title contains search or vice-versa)
        if (!matched && (normTitle.includes(normTarget) || normTarget.includes(normTitle))) matched = true;
        // fuzzy fallback
        if (!matched && typeof fuzzyMatch === 'function' && fuzzyMatch(title, displayName)) matched = true;
        if (matched) {
          await r.click();
          await delay(300 + Math.floor(Math.random() * 400));
          // try to read opened header
          let opened = null;
          try { opened = await page.$eval('header span[title]', el => el.getAttribute('title')); } catch (hdrErr) {}
          const logEvt = { searchedName: displayName, foundTitle: title, openedHeader: opened || null, ts: new Date().toISOString() };
          // if mapped in contatoMap, include mapping and return mapped contact
          try {
            const key = removerAcentos(String((opened || title)).toLowerCase().replace(/ +/g, ' ').trim());
            if (contatoMap && contatoMap.has(key)) {
              const mapped = contatoMap.get(key);
              logEvt.mapped = true;
              logEvt.mappedName = mapped.name || mapped.formattedName || null;
              logEvt.mappedId = mapped.id || null;
              saveFound(logEvt);
              return mapped;
            }
          } catch (e) { /* ignore mapping errors */ }
          // save attempt even if not mapped
          logEvt.mapped = false;
          saveFound(logEvt);
          return null;
        }
      } catch (e) { /* ignore per-result errors */ }
    }
    // cleanup UI
    try { await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); } catch (e) {}
    return null;
  } catch (e) {
    return null;
  }
}

let enviados = 0;
let falhas = 0;
// FunÃ§Ã£o para capturar QR diretamente da pÃ¡gina via Puppeteer (fallback garantido)
async function captureQRFromPage(page, maxAttempts = 120) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      // Tenta encontrar a imagem do QR na pÃ¡gina
      const qrImageData = await page.evaluate(() => {
        // Procura por canvas com QR (pode estar visÃ­vel ou hidden)
        const canvases = document.querySelectorAll('canvas');
        for (const canvas of canvases) {
          try {
            // Qualquer canvas de tamanho razoÃ¡vel pode ser QR
            if (canvas.width > 50 && canvas.height > 50) {
              const data = canvas.toDataURL('image/png');
              // Verifica se tem conteÃºdo (nÃ£o Ã© branco)
              if (data && data.length > 500) {
                return data;
              }
            }
          } catch (e) {
            // ignore canvas access errors (CORS, etc)
          }
        }
        // Procura por divs que contenham QR (div.qr-code, etc)
        const qrDivs = document.querySelectorAll('[class*="qr"], [id*="qr"], svg[data-qr]');
        for (const div of qrDivs) {
          if (div && div.offsetHeight > 50 && div.offsetWidth > 50) {
            // Tenta extrair como imagem
            try {
              if (div.tagName === 'IMG') return div.src;
              if (div.tagName === 'CANVAS') return div.toDataURL('image/png');
            } catch (e) {}
          }
        }
        return null;
      });

      if (qrImageData && qrImageData.length > 500) {
        console.log('\nðŸ“¸ QR Code capturado via Puppeteer!\n');
        const cleanData = qrImageData.replace(/^data:image\/png;base64,/, '');
        await new Promise((resolve) => {
          QRCode.toString(cleanData, { type: 'terminal' }, (err, result) => {
            if (!err && result) {
              console.log('ðŸ“± QR Code (ASCII Art):\n');
              console.log(result);
            } else {
              console.log('ðŸ“¸ QR detectado (pode estar visÃ­vel na janela Chrome)\n');
            }
            resolve();
          });
        });
        console.log('\nâ³ Aguardando vocÃª escanear o QR code...\n');
        return true;
      }
    } catch (err) {
      // ignore errors, continue trying
    }
    
    attempts++;
    if (attempts % 20 === 0) {
      console.log(`â³ Aguardando QR na pÃ¡gina... (${attempts}s)`);
    }
    await delay(1000);
  }
  return false;
}

// Mapa para armazenar quais contatos foram iniciados por este bot
// chave: chatId (ex: '5511999999999@c.us'), valor: { startedAt: timestamp }
const contatosIniciados = new Map();

// session name can be overridden with env WPP_SESSION to allow multiple copies
let sessionName = process.env.WPP_SESSION || 'disparador';

// Se nÃ£o houver tokens salvos, force uma sessÃ£o nova com timestamp para garantir QR fresco
const tokenPath = path.join(__dirname, 'tokens', sessionName);
if (!fs.existsSync(tokenPath)) {
  console.log('âš ï¸ Nenhuma sessÃ£o autenticada encontrada. ForÃ§ando autenticaÃ§Ã£o nova...');
  // Usar timestamp para garantir sessÃ£o Ãºnica = novo QR
  sessionName = `${sessionName}-auth-${Date.now()}`;
}

console.log('â„¹ï¸ Using session:', sessionName);
console.log('â„¹ï¸ Script __dirname:', __dirname);
console.log('âœ… Iniciando wppconnect.create() â€” aguardando QR code...\n');

// VariÃ¡vel para rastrear se o QR jÃ¡ foi exibido
let qrShown = false;

// FunÃ§Ã£o para decodificar QR de screenshot via jsQR
async function decodeQRFromScreenshot(screenshotBase64) {
  try {
    // Converter base64 para buffer
    const buffer = Buffer.from(screenshotBase64, 'base64');
    
    // Usar Jimp para carregar a imagem
    const image = await Jimp.read(buffer);
    
    // Extrair dados de pixel (RGBA)
    const imageData = {
      data: new Uint8ClampedArray(image.bitmap.data),
      width: image.bitmap.width,
      height: image.bitmap.height
    };
    
    // Decodificar QR code usando jsQR
    const qrCode = jsQR(imageData.data, imageData.width, imageData.height);
    
    if (qrCode && qrCode.data) {
      return qrCode.data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// FunÃ§Ã£o para capturar screenshot do QR code do WhatsApp Web
async function captureQRScreenshot(page) {
  try {
    if (!page) return null;
    
    // Tenta encontrar o elemento QR code no DOM
    const qrElement = await page.$('canvas[data-testid*="qr"], [data-testid*="qr"], canvas, div[class*="qr"]');
    
    if (qrElement) {
      // Se encontrou, tira screenshot sÃ³ do elemento
      const screenshot = await qrElement.screenshot({ encoding: 'base64' });
      if (screenshot && screenshot.length > 500) {
        console.log('ðŸ“¸ Screenshot do QR code capturado via elemento!');
        return screenshot;
      }
    }

    // Se nÃ£o encontrou o elemento, tira screenshot de uma regiÃ£o da pÃ¡gina
    // Tenta screenshots de diferentes regiÃµes onde o QR pode estar
    const regions = [
      { x: 0, y: 0, width: 600, height: 600 },        // Canto superior esquerdo
      { x: 100, y: 100, width: 500, height: 500 },    // Centro
    ];

    for (const region of regions) {
      try {
        const screenshot = await page.screenshot({ 
          encoding: 'base64',
          clip: region
        });
        
        if (screenshot && screenshot.length > 500) {
          // Verifica se a imagem nÃ£o Ã© toda branca (tem conteÃºdo)
          const buffer = Buffer.from(screenshot, 'base64');
          if (buffer.length > 1000) {
            console.log('ðŸ“¸ Screenshot do QR code capturado com sucesso!');
            return screenshot;
          }
        }
      } catch (e) {
        // Continua para prÃ³xima regiÃ£o
      }
    }

    return null;
  } catch (e) {
    console.log('âš ï¸ Erro ao capturar screenshot do QR:', e && e.message ? e.message : e);
    return null;
  }
}

// FunÃ§Ã£o para capturar e exibir QR continuamente
async function captureAndDisplayQR(client) {
  const maxAttempts = 600; // 10 minutos (600 * 1s)
  let lastError = '';
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const waPage = client.waPage;
      if (!waPage) {
        if (attempt === 0) console.log('â³ Aguardando pÃ¡gina Puppeteer...');
        await delay(1000);
        continue;
      }

      // MÃ‰TODO 1: Tenta extrair QR do DOM (canvas/img)
      const qrData = await waPage.evaluate(() => {
        try {
          // Procura canvas (QR renderizado como canvas)
          const canvas = document.querySelector('canvas');
          if (canvas && canvas.offsetHeight > 100 && canvas.offsetWidth > 100) {
            return { type: 'canvas', data: canvas.toDataURL('image/png') };
          }
          
          // Procura img com base64 (QR como imagem)
          const img = document.querySelector('img[src^="data:image"]');
          if (img && img.naturalWidth > 100) {
            return { type: 'img', data: img.src };
          }

          return null;
        } catch (e) {
          return null;
        }
      });

      // MÃ‰TODO 2: Se mÃ©todo 1 falhar, tira screenshot e decodifica
      let qrText = null;
      if (!qrData && !qrShown) {
        try {
          const screenshot = await waPage.screenshot({ encoding: 'base64' });
          qrText = await decodeQRFromScreenshot(screenshot);
        } catch (e) {
          // Screenshot falhou, continua
        }
      }

      // Se encontrou QR por qualquer mÃ©todo, exibe
      if ((qrData || qrText) && !qrShown) {
        console.log('\n' + '='.repeat(80));
        console.log('ðŸ“± QR CODE ENCONTRADO! Capturando screenshot...');
        console.log('='.repeat(80) + '\n');
        
        // Tentar capturar screenshot do QR code
        const screenshot = await captureQRScreenshot(waPage);
        if (screenshot) {
          qrScreenshot = screenshot;
          console.log('âœ… Screenshot do WhatsApp Web capturado!\n');
        }
        
        if (qrData) {
          const cleanData = qrData.data.replace(/^data:image\/png;base64,/, '');
          qrImageData = cleanData; // TambÃ©m salvar PNG alternativo
          try {
            const asciiQR = await new Promise((resolve) => {
              QRCode.toString(cleanData, { type: 'terminal', width: 15 }, (err, result) => {
                resolve(err ? null : result);
              });
            });
            if (asciiQR) {
              console.log(asciiQR);
            }
          } catch (e) {
            // Render falhou
          }
        } else if (qrText) {
          console.log('âœ… QR Decodificado via screenshot!');
          console.log('Dados encontrados: ' + qrText.substring(0, 100) + '...\n');
          try {
            const asciiQR = await new Promise((resolve) => {
              QRCode.toString(qrText, { type: 'terminal', width: 15 }, (err, result) => {
                resolve(err ? null : result);
              });
            });
            if (asciiQR) {
              console.log(asciiQR);
            }
          } catch (e) {
            // Render falhou
          }
        }

        console.log('\n' + '='.repeat(80));
        console.log('ðŸŒ ACESSE VIA HTTP:');
        console.log(`   ðŸ‘‰ http://localhost:${QR_SERVER_PORT}`);
        console.log(`   ðŸ‘‰ http://127.0.0.1:${QR_SERVER_PORT}`);
        console.log('='.repeat(80) + '\n');
        
        qrShown = true;
      }
      
      // Se QR jÃ¡ foi mostrado, verificar se autenticou
      if (qrShown) {
        try {
          const profileName = await client.getProfileName();
          if (profileName && String(profileName).trim().length > 0) {
            console.log('ðŸŽ‰ AutenticaÃ§Ã£o CONCLUÃDA! Bem-vindo:', profileName);
            return true;
          }
        } catch (e) {
          // Ainda nÃ£o autenticado
        }
      }

      if (attempt === 0) console.log('â³ Monitorando pÃ¡gina para QR...');
      if (attempt % 10 === 0 && attempt > 0) {
        console.log(`â³ Aguardando... ${attempt}s`);
      }
      await delay(1000);
      
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      if (errMsg !== lastError) {
        console.log('â„¹ï¸ Monitoramento:', errMsg);
        lastError = errMsg;
      }
      await delay(1000);
    }
  }
  return false;
}

wppconnect.create({
  session: sessionName,
  headless: process.env.HEADLESS !== 'false' ? true : false,  // â† DEFAULT TRUE (production/VPS); set HEADLESS=false to see browser
  autoClose: 0,  // â† NUNCA FECHAR AUTOMATICAMENTE (0 = desabilitar)
  waitForLogin: false,  // â† NÃƒO BLOQUEAR, deixar rodar
  logQR: true,  // â† DEIXAR wppconnect LOGAR QR AUTOMATICAMENTE (default)
  disableWelcome: false,
  protocolTimeout: process.env.PROTOCOL_TIMEOUT ? Number(process.env.PROTOCOL_TIMEOUT) : 300000,
  catchQR: qrDisplay.setupQRDisplay(),
  puppeteerOptions: {
    // improve stability on small VPS / container environments
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    // disable Puppeteer launch timeout (0 = no timeout) or set via env PUPPETEER_LAUNCH_TIMEOUT
    timeout: process.env.PUPPETEER_LAUNCH_TIMEOUT ? Number(process.env.PUPPETEER_LAUNCH_TIMEOUT) : 0,
    // show browser stdout/stderr in logs for debugging (useful in CI / Railway)
    dumpio: process.env.PUPPETEER_DUMPIO ? (process.env.PUPPETEER_DUMPIO === '1' || process.env.PUPPETEER_DUMPIO === 'true') : false,
    defaultViewport: null
  }
}).then(async (client) => {
  console.log('\nâœ… âœ… âœ… BOT CONECTADO âœ… âœ… âœ…\n');
  
  // Inicia captura de QR em background
  const qrCapturePromise = captureAndDisplayQR(client);
  
  // Aguarda um pouco para a pÃ¡gina carregar
  await delay(3000);
  let isReallyLogged = false;
  try {
    // Tenta obter o nome do perfil - sÃ³ funciona se autenticado
    const profileName = await client.getProfileName();
    console.log('âœ… Perfil obtido:', profileName);
    isReallyLogged = profileName && String(profileName).trim().length > 0;
  } catch (e) {
    console.log('â„¹ï¸ Erro ao obter perfil:', e && e.message ? e.message : 'desconhecido');
    isReallyLogged = false;
  }
  
  if (!isReallyLogged) {
    console.log('\nðŸ” DETECÃ‡ÃƒO: SessÃ£o NÃƒO estÃ¡ autenticada!');
    console.log('â³ Verificando pÃ¡gina para QR code...\n');
  } else {
    console.log('ðŸŽ‰ SessÃ£o conectada ao WhatsApp!\n');
  }

  // ---------- START: funÃ§Ãµes para consultas/envio manuais sem parar o bot ----------
  const STARTED_FILE = path.join(__dirname, 'contatos_iniciados.json');

  function loadStartedFromDisk() {
    try {
      if (fs.existsSync(STARTED_FILE)) {
        const raw = fs.readFileSync(STARTED_FILE, 'utf8');
        const obj = JSON.parse(raw || '{}');
        contatosIniciados.clear();
        // objeto pode ser array ou map-like
        if (Array.isArray(obj)) {
          obj.forEach(item => {
            if (item && item.chatId) contatosIniciados.set(String(item.chatId), item);
          });
        } else {
          Object.entries(obj).forEach(([k, v]) => contatosIniciados.set(String(k), v));
        }
        console.log(`â„¹ï¸ Loaded ${contatosIniciados.size} started contacts from ${STARTED_FILE}`);
      } else {
        console.log(`â„¹ï¸ No ${STARTED_FILE} found â€” starting fresh.`);
      }
    } catch (e) {
      console.log('âš ï¸ Erro ao carregar contatos iniciados:', e && e.message ? e.message : e);
    }
  }

  function saveStartedToDisk() {
    try {
      const obj = Object.fromEntries(Array.from(contatosIniciados.entries()));
      fs.writeFileSync(STARTED_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.log('âš ï¸ Erro ao salvar contatos iniciados:', e && e.message ? e.message : e);
    }
  }

  // Carrega estado persistido (se houver)
  loadStartedFromDisk();

  // Retorna array de objetos { chatIdNorm, chatIdOriginal, info } para os "abertos"
  function getOpenConversations() {
    const out = [];
    for (const [chatIdNorm, info] of contatosIniciados.entries()) {
      // critÃ©rio: jÃ¡ iniciamos (startedAt) e o contato respondeu (lastRespondedAt) mas audioSent != true
      const startedAt = info && info.startedAt ? info.startedAt : 0;
      const lastResp = info && info.lastRespondedAt ? info.lastRespondedAt : 0;
      const audioSent = !!(info && info.audioSent);
      if (startedAt && lastResp && lastResp > startedAt && !audioSent) {
        out.push({
          chatIdNorm,
          chatIdOriginal: info.chatIdOriginal || `${chatIdNorm}`,
          startedAt,
          lastRespondedAt: lastResp,
          lastMsgId: info.lastMsgId || null
        });
      }
    }
    return out;
  }

  // Interactive stdin handler removed â€” no terminal commands exposed
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (raw) => {
    // intentionally ignore stdin commands in production mode
  });
  // ---------- END: funÃ§Ãµes para consultas/envio manuais ----------

  // Listener: sÃ³ responde quando um contato que o bot iniciou responder
  client.onMessage(async (msg) => {
    try {
      // Filtragens iniciais
      if (msg.fromMe) return; // ignorar mensagens do prÃ³prio bot
      if (msg.isGroupMsg) return; // ignorar grupos
      if (msg.type === 'status') return; // ignorar atualizaÃ§Ãµes de status
      if (msg.isNotification || msg.isBot) return; // ignorar notificaÃ§Ãµes/bots

      const chatId = msg.from; // id do chat (ex: '5511999999999@c.us')
      const incomingNorm = normalizeChatId(chatId);

      // Try to extract a stable message id for deduplication (various wppconnect shapes)
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

      // Debounce/dedupe: ignore if we already responded to the same message id
      const startedInfo = contatosIniciados.get(incomingNorm);
      if (startedInfo) {
        if (incomingMsgId && startedInfo.lastMsgId && incomingMsgId === startedInfo.lastMsgId) {
          console.log(`âš ï¸ Mensagem duplicada de ${incomingNorm} (mesmo id) â€” ignorando.`);
          return;
        }
        // time-based debounce: ignore if last response was very recent
        const lastResp = startedInfo.lastRespondedAt || 0;
        if (now - lastResp < 5000) { // 5s window
          console.log(`âš ï¸ Resposta recente de ${incomingNorm} detectada (${Math.round(now - lastResp)}ms) â€” ignorando para evitar duplicatas.`);
          return;
        }
      }

      // Verifica se esse contato foi iniciado por este bot (usando id normalizado)
      if (!contatosIniciados.has(incomingNorm)) {
        // NÃ£o iniciamos essa conversa, entÃ£o nÃ£o respondemos
        console.log(`âš ï¸ Mensagem recebida de ${incomingNorm} mas nÃ£o iniciada por este bot â€” ignorando.`);
        return;
      }

      // If the message arrives very soon after we started the conversation, treat it as automatic
      // (some autoresponders and systems reply immediately). Ignore messages within 5s of startedAt.
      try {
        const startedEntry = contatosIniciados.get(incomingNorm) || {};
        const startedAt = startedEntry.startedAt || 0;
        if (startedAt && (now - startedAt) < 5000) {
          if (process.env.WPP_DEBUG_MATCH) console.log(`ðŸ”Ž Ignoring message from ${incomingNorm} because it arrived ${now - startedAt}ms after start (treated as automatic)`);
          console.log(`âš ï¸ Mensagem de ${incomingNorm} chegou logo apÃ³s inÃ­cio (${Math.round(now - startedAt)}ms) â€” provÃ¡vel automÃ¡tica â€” ignorando.`);
          return;
        }
      } catch (e) { /* ignore errors retrieving startedAt */ }

      // Se jÃ¡ enviamos o Ã¡udio para essa conversa, nÃ£o enviamos novamente
      let startedInfoCheck = contatosIniciados.get(incomingNorm);
      if (startedInfoCheck && startedInfoCheck.audioSent) {
        console.log(`â„¹ï¸ Ãudio jÃ¡ enviado anteriormente para ${incomingNorm} â€” ignorando envio duplicado.`);
        return;
      }

      // Apenas responder se a mensagem parecer vinda de um humano (filtra auto-replies/sistemas)
      if (!isLikelyHumanMessage(msg)) {
        console.log(`âš ï¸ Mensagem de ${incomingNorm} parece automÃ¡tica/sistema â€” ignorando.`);
        return;
      }

      // Optional: evitar respostas a mensagens automÃ¡ticas - exemplo ampliado
      const body = (msg.body || '').toString().toLowerCase();
      // expanded patterns to catch common auto-replies / OOF messages
      const autoPatterns = [
        'mensagem automÃ¡tica', 'resposta automÃ¡tica', 'auto-reply', 'auto reply', 'auto resposta',
        'resposta automÃ¡tica', 'estou fora', 'estou ausente', 'fora do horÃ¡rio', 'horÃ¡rio de atendimento',
        'mensagem de ausÃªncia', 'mensagem de ausencia', 'serviÃ§o', 'autoresponder', 'autoreply',
        'mensagem automÃ¡tica', 'nÃ£o estou disponÃ­vel', 'naÌƒo estou disponÃ­vel', 'indisponÃ­vel', 'indisponivel'
      ];
      const autoRegex = /\b(auto|autom[aÃ¡]tico|ausente|fora|indispon[iÃ­]vel|aus[eÃ©]ncia|ausencia|autoresponder|auto-?reply)\b/i;
      if (!body || autoPatterns.some(p => body.includes(p)) || autoRegex.test(body)) {
        console.log(`âš ï¸ Mensagem parece automÃ¡tica/sistema de ${chatId} â€” ignorando.`);
        return;
      }

  // enviar Ã¡udio de resposta (simulando gravaÃ§Ã£o na hora)
  const audioPath = path.join(__dirname, 'audio_resposta.ogg');
      if (!fs.existsSync(audioPath)) {
        console.log(`âš ï¸ Arquivo de Ã¡udio nÃ£o encontrado em ${audioPath}.`);
        return;
      }

      try {
        const startedInfo2 = contatosIniciados.get(incomingNorm);
        const targetId = startedInfo2 && startedInfo2.chatIdOriginal ? startedInfo2.chatIdOriginal : chatId;
        // Marcar imediatamente antes do envio real para evitar race condition
        if (startedInfo2) {
          startedInfo2.audioSent = true;
          contatosIniciados.set(incomingNorm, startedInfo2);
          // persist state to disk to survive restarts/crashes
          try { saveStartedToDisk(); } catch (e) { /* ignore */ }
        }
        // Many wppconnect versions don't expose sendVoice; prefer sendPtt or sendFile with voice option.
        if (client.sendPtt && typeof client.sendPtt === 'function') {
          await client.sendPtt(targetId, audioPath);
        } else if (client.sendFile && typeof client.sendFile === 'function') {
          // sendFile(chatId, filePath, filename, caption, options)
          // try to send as voice note
          await client.sendFile(targetId, audioPath, 'audio.ogg', '', { sendAudioAsVoice: true });
        } else if (client.sendText && typeof client.sendText === 'function') {
          // fallback: inform user we couldn't send audio
          await client.sendText(targetId, 'NÃ£o foi possÃ­vel enviar o Ã¡udio automaticamente.');
        } else {
          throw new Error('Nenhum mÃ©todo de envio de Ã¡udio suportado pelo client');
        }
        console.log(`ðŸŽ¤ Ãudio enviado para ${incomingNorm}`);
        // mark last responded id/time to avoid duplicates
        if (startedInfo2) {
          if (incomingMsgId) startedInfo2.lastMsgId = incomingMsgId;
          startedInfo2.lastRespondedAt = now;
          // audioSent jÃ¡ foi marcado antes do envio
          contatosIniciados.set(incomingNorm, startedInfo2);
        }
      } catch (e) {
        console.log(`âŒ Erro ao enviar Ã¡udio para ${incomingNorm}: ${e && e.message ? e.message : e}`);
      }
    } catch (err) {
      console.log('âŒ Erro no onMessage:', err.message);
    }
  });

  // Aguarda 2 minutos antes de buscar contatos para garantir carregamento
  console.log('â³ Aguardando 2 minutos para carregar contatos...');
  await delay(120000);

  // ConfigurÃ¡veis
  // Limite mÃ¡ximo de envios (padrÃ£o) - usa MAX_OPA jÃ¡ definido no topo

  // VariÃ¡veis de escopo para Ã­ndices que podem ser rebuildados
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

  // Rebuilda todos os Ã­ndices a partir de todosContatos
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

    // Log da agenda atualizado
    try {
      const logContatosPath = path.join(__dirname, 'log_contatos_wpp.txt');
      fs.writeFileSync(logContatosPath, 'id | name | isMyContact | normalizado\n');
      todosContatos.forEach(c => {
        if (c.name) {
          fs.appendFileSync(logContatosPath, `${c.id} | ${c.name} | ${c.isMyContact} | ${removerAcentos(c.name.toLowerCase().replace(/ +/g, ' '))}\n`);
        }
      });
    } catch (e) {
      console.log('âš ï¸ Erro ao atualizar log_contatos_wpp.txt:', e && e.message ? e.message : e);
    }
  }

  // Busca inicial e build dos Ã­ndices
    // Persistent cache on disk for contacts (agenda_cache.json)
    const AGENDA_CACHE_FILE = path.join(__dirname, 'agenda_cache.json');

    function loadAgendaCache() {
      try {
        if (fs.existsSync(AGENDA_CACHE_FILE)) {
          const raw = fs.readFileSync(AGENDA_CACHE_FILE, 'utf8');
          if (raw && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              console.log(`â„¹ï¸ Carregando ${parsed.length} contatos do cache em ${AGENDA_CACHE_FILE}`);
              return parsed;
            }
          }
        }
      } catch (e) {
        console.log('âš ï¸ Erro ao carregar cache de agenda:', e && e.message ? e.message : e);
      }
      return null;
    }

    function saveAgendaCache(list) {
      try {
        if (!Array.isArray(list) || list.length === 0) {
          console.log('âš ï¸ saveAgendaCache: lista vazia â€” nÃ£o sobrescrevendo o cache.');
          return false;
        }
        fs.writeFileSync(AGENDA_CACHE_FILE, JSON.stringify(list, null, 2), 'utf8');
        console.log(`âœ… Agenda salva em cache (${AGENDA_CACHE_FILE}) â€” ${list.length} contatos`);
        return true;
      } catch (e) {
        console.log('âš ï¸ Erro ao salvar cache de agenda:', e && e.message ? e.message : e);
        return false;
      }
    }

    // 1) tenta carregar do cache no disco primeiro
    const cached = loadAgendaCache();
    if (cached) {
      todosContatos = cached;
      try { rebuildIndices(); } catch (e) { console.log('âš ï¸ Erro rebuildIndices apÃ³s carregar cache:', e && e.message ? e.message : e); }
    }

    // 2) em seguida, tenta buscar do WhatsApp â€” se obtiver uma lista vÃ¡lida (nÃ£o vazia), sobrescreve cache
    try {
      const fresh = await (client.listContacts ? client.listContacts() : (client.getAllContacts ? client.getAllContacts() : []));
      if (Array.isArray(fresh) && fresh.length > 0) {
        // se nÃ£o havia cache ou a lista nova tem conteÃºdo, atualiza em memÃ³ria e grava em disco
        todosContatos = fresh;
        rebuildIndices();
        saveAgendaCache(fresh);
        console.log(`â„¹ï¸ Contatos carregados do WhatsApp: ${todosContatos.length}`);
      } else {
        if (!cached) console.log('âš ï¸ NÃ£o foi possÃ­vel obter contatos do WhatsApp e nÃ£o existe cache local. Agenda ficarÃ¡ vazia.');
        else console.log('âš ï¸ Lista do WhatsApp vazia â€” mantendo cache local.');
      }
    } catch (e) {
      console.log('âŒ Erro ao obter contatos iniciais do WhatsApp:', e && e.message ? e.message : e);
      if (!cached) console.log('âš ï¸ Nenhum cache local disponÃ­vel â€” a lista de contatos ficarÃ¡ vazia atÃ© que seja possÃ­vel obter do WhatsApp.');
    }

  // Limite mÃ¡ximo de envios (padrÃ£o) - usa MAX_OPA jÃ¡ definido no topo

  // MantÃ©m a funÃ§Ã£o de envio inicial (envia "Opa" para cada contato filtrado)
  // ConstrÃ³i um set com os nÃºmeros autorizados (da lista `contatos`) para garantir que
  // nunca enviemos para contatos que nÃ£o estÃ£o explicitamente na sua lista filtrada.
  const allowedNumbers = new Set(contatos.map(c => normalizePhone(c.numero)).filter(Boolean));
  console.log(`â„¹ï¸ NÃºmeros autorizados carregados: ${allowedNumbers.size}`);
  // If the process started before 13:00 in TARGET_TIMEZONE, wait until the send window opens there
  await waitUntilSendWindow();
  console.log('â–¶ï¸ Janela de envio aberta no fuso', TARGET_TIMEZONE, 'â€” iniciando envios.');

  for (const [i, contato] of contatos.entries()) {
    if (enviados >= MAX_OPA) {
      console.log(`ðŸš¦ Limite de ${MAX_OPA} mensagens 'opa' atingido. Parando envios.`);
      break;
    }
    // Debug: show current hour in TARGET_TIMEZONE before deciding to send
    if (process.env.WPP_DEBUG_MATCH) {
      const hr = getHourInTimeZone(TARGET_TIMEZONE);
      console.log(`ðŸ”Ž Hora atual em ${TARGET_TIMEZONE}: ${hr}h â€” isWithinSendWindow()=${isWithinSendWindow()}`);
    }
    if (!isWithinSendWindow()) {
      // If we're outside the sending window (e.g., day turned), wait until the next opening in TARGET_TIMEZONE
      await waitUntilSendWindow();
      // after waiting, re-evaluate the same contact
    }
    let skipDelay = false;
    const nomeBusca = removerAcentos(normalizarNomeContato(contato).toLowerCase().replace(/ +/g, ' ').trim());
  const mensagem = `Boa tarde`;

    try {
      // ImplementaÃ§Ã£o do fluxo baseado em Ã­ndices
      let contatoAgenda = null;
      const tentativaNumero = contato.numero ? normalizePhone(contato.numero) : null;

      // First: try UI exact-name search (simulate human searching by the exact display name)
      let uiFound = null;
      let uiConfirmed = false;
      if (client && client.pupPage) {
        try {
          uiFound = await uiFindContactByExactName(client, normalizarNomeContato(contato));
          if (uiFound) {
            contatoAgenda = uiFound;
            console.log(`ðŸ”Ž Encontrado via UI por nome exato: ${contatoAgenda.name}`);
          } else {
            // uiFound === null means either not found or found but unmapped; continue heuristics
            if (process.env.WPP_DEBUG_MATCH) console.log('ðŸ”Ž UI search did not return a mapped contact. Falling back to index search.');
          }
        } catch (uiErr) { if (process.env.WPP_DEBUG_MATCH) console.log('âš ï¸ UI search error:', uiErr && uiErr.message ? uiErr.message : uiErr); }
      }
      uiConfirmed = !!uiFound;

      // 1) busca por nÃºmero exato
      if (tentativaNumero && phoneMap.has(tentativaNumero)) {
        contatoAgenda = phoneMap.get(tentativaNumero);
        console.log(`ðŸ”Ž Encontrado por nÃºmero exato: ${normalizeChatId(contatoAgenda.id)}`);
      }

      // 2) busca por Ãºltimos dÃ­gitos
      if (!contatoAgenda && tentativaNumero) {
        const last = tentativaNumero.slice(-LAST_N);
        const list = lastNMap.get(last) || [];
        if (list.length === 1) contatoAgenda = list[0];
        else if (list.length > 1) {
          // escolher melhor candidato por fuzzy match com o nome
          const nomeInt = normalizarNomeContato(contato);
          let best = null, bestScore = -1;
          list.forEach(c => {
            const score = fuzzyMatch(c.name || c.formattedName || '', nomeInt) ? 1 : 0;
            if (score > bestScore) { best = c; bestScore = score; }
          });
          if (best) contatoAgenda = best;
        }
        if (contatoAgenda) console.log(`ðŸ”Ž Encontrado por Ãºltimos dÃ­gitos: ${normalizeChatId(contatoAgenda.id)}`);
      }

      // 3) busca por nome exato no mapa
      if (!contatoAgenda && contatoMap.has(nomeBusca)) {
        contatoAgenda = contatoMap.get(nomeBusca);
        console.log(`ðŸ”Ž Encontrado no nameMap: ${contatoAgenda.name}`);
      }

      // 4) token index intersection
      if (!contatoAgenda) {
        const tokens = nomeBusca.split(' ').filter(t => t.length > 2);
        const counter = new Map();
        tokens.forEach(t => {
          const s = tokenIndex.get(t);
          if (s) for (const c of s) counter.set(c, (counter.get(c) || 0) + 1);
        });
        // pega os com maior contagem
        const candidates = Array.from(counter.entries()).sort((a,b) => b[1]-a[1]).map(x=>x[0]);
        if (candidates.length > 0) contatoAgenda = candidates[0];
        if (contatoAgenda) console.log(`ðŸ”Ž Encontrado por tokenIndex: ${contatoAgenda.name}`);
      }

      // 5) fuzzy global (Ãºltimo recurso antes da UI)
      if (!contatoAgenda) {
        let best = null, bestScore = 0;
        for (const c of todosContatos) {
          if (!c.name) continue;
          if (!c.isMyContact) continue;
          const n = c.name;
          if (fuzzyMatch(n, normalizarNomeContato(contato))) { best = c; bestScore = 1; break; }
          // leve heurÃ­stica: token overlap
        }
        if (best) { contatoAgenda = best; console.log(`ðŸ”Ž Encontrado por fuzzy global: ${contatoAgenda.name}`); }
      }

      // (UI confirmation removed â€” using unified uiFindContactByExactName earlier)

      // 7) envio final seguindo confirmaÃ§Ãµes
      // ProteÃ§Ã£o extra: se o candidato encontrado (contatoAgenda) nÃ£o estiver na lista filtrada
      // (pelo nÃºmero), pule para evitar enviar para contatos do catÃ¡logo que coincidem por nome.
      if (contatoAgenda) {
        try {
          const candidatePhone = extractDigitsFromId(contatoAgenda) || (contatoAgenda.numero ? normalizePhone(contatoAgenda.numero) : null);
          const requestedPhone = tentativaNumero || null;
          // if candidatePhone exists and is not in allowedNumbers and doesn't match the requestedPhone, skip
          if (candidatePhone && !allowedNumbers.has(candidatePhone) && requestedPhone && candidatePhone !== requestedPhone) {
            console.log(`âš ï¸ Candidato encontrado (${contatoAgenda.name} / ${candidatePhone}) NÃƒO estÃ¡ na lista filtrada â€” pulando para evitar envio fora da lista.`);
            skipDelay = true;
            continue;
          }
        } catch (chkErr) { /* ignore check failures and proceed */ }
      }
      if (uiConfirmed && contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`âš ï¸ JÃ¡ existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) â€” pulando envio via UI.`);
          if (process.env.WPP_DEBUG_MATCH) console.log(`ðŸ”Ž skip reason: chatExists true for candidate ${chatId}`);
          skipDelay = true;
        } else {
          try {
            await client.sendText(chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`âœ… Mensagem enviada via UI para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend) {
            console.log('âŒ Erro envio via UI:', errSend.message);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`âš ï¸ JÃ¡ existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) â€” pulando envio por correspondÃªncia.`);
          if (process.env.WPP_DEBUG_MATCH) console.log(`ðŸ”Ž skip reason: chatExists true for candidate ${chatId}`);
          skipDelay = true;
        } else {
          try {
            await client.sendText(chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`âœ… Mensagem enviada por correspondÃªncia para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend2) {
            console.log('âŒ Falha ao enviar por correspondÃªncia:', errSend2.message);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (tentativaNumero) {
        // Ãºltimo recurso: antes de enviar diretamente por nÃºmero, tentar localizar o contato na agenda
        let foundAgendaContact = null;
        try {
          for (const c of todosContatos) {
            try {
              const cand = extractDigitsFromId(c) || (c.number || c.phone || c.numero || '');
              const candNorm = normalizePhone(cand);
              if (candNorm && tentativaNumero && candNorm === tentativaNumero) { foundAgendaContact = c; break; }
              // Ãºltima heurÃ­stica: comparar Ãºltimos 8 dÃ­gitos
              if (candNorm && tentativaNumero && candNorm.slice(-8) === tentativaNumero.slice(-8)) { foundAgendaContact = c; break; }
            } catch (inner) { /* ignore per-contact parse errors */ }
          }
        } catch (e) { /* ignore failures during scan */ }

        // se nÃ£o encontrado por nÃºmero, tentar mapear por nome exato
        if (!foundAgendaContact && contatoMap && contatoMap.has(nomeBusca)) {
          foundAgendaContact = contatoMap.get(nomeBusca);
        }

        if (foundAgendaContact && foundAgendaContact.id) {
          contatoAgenda = foundAgendaContact;
          const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`âš ï¸ JÃ¡ existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) â€” pulando envio por correspondÃªncia de agenda.`);
            if (process.env.WPP_DEBUG_MATCH) console.log(`ðŸ”Ž skip reason: chatExists true for candidate ${chatId}`);
            skipDelay = true;
          } else {
            try {
              await client.sendText(chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`âœ… Mensagem enviada por correspondÃªncia (agenda) para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('âŒ Falha ao enviar por correspondÃªncia (agenda):', errFallback.message);
              falhas++;
              skipDelay = true;
            }
          }
        } else {
          // fallback numÃ©rico puro
          const chatId = `${tentativaNumero}@c.us`; const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`âš ï¸ JÃ¡ existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) â€” pulando envio por fallback numÃ©rico.`);
            if (process.env.WPP_DEBUG_MATCH) console.log(`ðŸ”Ž skip reason: chatExists true for candidate ${chatId}`);
            skipDelay = true;
          } else {
            try {
              await client.sendText(chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`âš ï¸ Mensagem enviada por fallback NUMÃ‰RICO para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('âŒ Falha no fallback por nÃºmero:', errFallback.message);
              const logPesquisaPath = path.join(__dirname, 'log_pesquisa.txt');
              fs.appendFileSync(logPesquisaPath, `Contato nÃ£o encontrado: ${normalizarNomeContato(contato)} | Busca: ${nomeBusca}\n`);
              fs.appendFileSync(logPesquisaPath, `-----------------------------\n`);
              falhas++;
              skipDelay = true;
            }
          }
        }
      } else {
        const logPesquisaPath = path.join(__dirname, 'log_pesquisa.txt');
        fs.appendFileSync(logPesquisaPath, `Contato nÃ£o encontrado: ${normalizarNomeContato(contato)} | Busca: ${nomeBusca}\n`);
        fs.appendFileSync(logPesquisaPath, `-----------------------------\n`);
        console.log(`âš ï¸ [${i + 1}/${contatos.length}] Contato nÃ£o encontrado na agenda: ${normalizarNomeContato(contato)} - pulando.`);
        falhas++;
        skipDelay = true;
      }
    } catch (e) {
      console.log(`âŒ [${i + 1}/${contatos.length}] Erro ao processar ${normalizarNomeContato(contato)}: ${e.message}`);
      falhas++;
    }

    const restantes = contatos.length - (i + 1);

    // (refresh periÃ³dico removido â€” usamos cache persistente em disco e atualizaÃ§Ã£o manual)
    console.log(`ðŸ“Š Progresso: ${enviados} enviados, ${falhas} falhas, ${restantes} restantes.`);

    if (skipDelay) {
      console.log('â© Pulando espera devido a falha / chat existente â€” seguindo para o prÃ³ximo contato.');
    } else {
  const espera = randomDelay(45000, 75000); // 45s a 1m15s
      console.log(`â³ Aguardando ${Math.round(espera / 1000)} segundos antes do prÃ³ximo envio...`);
      await delay(espera);
    }
  }

  // escreve resumo final usando as variÃ¡veis de topo (enviados/falhas)
  try {
    fs.writeFileSync(path.join(__dirname, 'log.txt'), `Enviados: ${enviados}\\nFalhas: ${falhas}`);
  } catch (e) {}
  console.log(`ðŸ“Š Envio finalizado: ${enviados} enviados, ${falhas} falhas`);

  // Keep the process alive so the bot can respond with audio to incoming replies.
  console.log('ðŸ¤– Bot permanecerÃ¡ ativo para receber respostas e enviar Ã¡udio. Pressione CTRL+C para encerrar.');

  // Heartbeat log to keep process/connection active and make status visible
  setInterval(() => {
    console.log(`ðŸ«¡ Bot ativo. Enviados: ${enviados}, Falhas: ${falhas}. ${new Date().toISOString()}`);
  }, 5 * 60 * 1000); // every 5 minutes

  // --- New: shutdown watcher ---
  // The bot will remain active until the configured shutdown time in TARGET_TIMEZONE
  const SHUTDOWN_HOUR = process.env.SHUTDOWN_HOUR ? Number(process.env.SHUTDOWN_HOUR) : 19; // default 19
  const SHUTDOWN_MINUTE = process.env.SHUTDOWN_MINUTE ? Number(process.env.SHUTDOWN_MINUTE) : 30; // default :30

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

  // Start watcher that will gracefully close the client when TARGET_TIMEZONE reaches SHUTDOWN_HOUR:SHUTDOWN_MINUTE.
  (function startShutdownWatcher() {
    try {
      console.log(`â³ Bot ficarÃ¡ ativo atÃ© ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} (${TARGET_TIMEZONE}).`);
      const checkInterval = setInterval(async () => {
        try {
          const hr = getHourInTimeZone(TARGET_TIMEZONE);
          const minute = getMinuteInTimeZone(TARGET_TIMEZONE);
          if (hr > SHUTDOWN_HOUR || (hr === SHUTDOWN_HOUR && minute >= SHUTDOWN_MINUTE)) {
            clearInterval(checkInterval);
            console.log(`â° ${TARGET_TIMEZONE} alcanÃ§ou ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} â€” encerrando bot.`);
            try {
              if (client && client.close) await client.close();
            } catch (e) { console.log('âš ï¸ Erro ao fechar client durante shutdown:', e && e.message ? e.message : e); }
            process.exit(0);
          }
          // optional: log remaining time every 10 minutes
        } catch (e) {
          /* ignore transient errors in watcher */
        }
      }, 30 * 1000); // check every 30s
    } catch (e) {
      console.log('âš ï¸ NÃ£o foi possÃ­vel iniciar shutdown watcher:', e && e.message ? e.message : e);
    }
  })();

  // Graceful shutdown on CTRL+C
  process.on('SIGINT', async () => {
    console.log('\nâ¹ï¸ Recebido SIGINT â€” encerrando sessÃ£o...');
    try {
      if (client && client.close) await client.close();
    } catch (e) {
      console.log('Erro ao fechar client:', e && e.message ? e.message : e);
    }
    process.exit(0);
  });
}).catch((err) => {
  console.log('âŒ Erro ao iniciar o bot:', err && err.message ? err.message : String(err));
  console.log('\nðŸ“Œ DICAS:');
  console.log('   1. Verifique se a pasta tokens/disparador foi deletada');
  console.log('   2. Verifique se o navegador Chrome estÃ¡ disponÃ­vel');
  console.log('   3. Tente novamente ou use um novo WPP_SESSION\n');
  process.exit(1);
});


