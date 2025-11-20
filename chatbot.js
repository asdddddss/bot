// (agendamento do reprocessamento é criado dentro do escopo do client)
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
const http = require('http');
const url = require('url');
// Timezone configuration: default to Sao Paulo
const TARGET_TIMEZONE = process.env.BOT_TIMEZONE || 'America/Sao_Paulo';

// ===== SERVIDOR HTTP PARA EXIBIR QR CODE =====
const QR_SERVER_PORT = process.env.QR_SERVER_PORT ? Number(process.env.QR_SERVER_PORT) : 3000;
let qrImageData = null; // Base64 PNG do QR code

const qrServer = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Rota: /qr.png - Serve a imagem do QR code em base64
  if (pathname === '/qr.png') {
    if (!qrImageData) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('QR Code not yet captured');
      return;
    }
    try {
      const buffer = Buffer.from(qrImageData, 'base64');
      res.writeHead(200, { 
        'Content-Type': 'image/png',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-cache'
      });
      res.end(buffer);
    } catch (err) {
      console.error('❌ Erro ao servir QR.png:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error serving QR code image');
    }
    return;
  }

  // Rota raiz: exibir página HTML com QR code
  if (pathname === '/' || pathname === '/qrcode') {
    const qrImageTag = qrImageData ? `<img src="/qr.png" alt="QR Code" style="max-width: 300px; width: 100%; border-radius: 10px; image-rendering: pixelated;">` : `<div style="padding: 40px; background: #f0f0f0; border-radius: 10px; color: #999;">⏳ Capturando QR Code...</div>`;
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QR Code - WhatsApp Bot</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
          }
          .container { 
            background: white; 
            padding: 40px; 
            border-radius: 20px; 
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); 
            text-align: center;
            max-width: 500px;
            width: 100%;
          }
          h1 { 
            color: #333; 
            margin-bottom: 10px; 
            font-size: 28px;
          }
          .status-badge { 
            display: inline-block; 
            background: #4CAF50; 
            color: white; 
            padding: 8px 16px; 
            border-radius: 20px; 
            font-size: 13px; 
            margin-bottom: 20px;
          }
          p { 
            color: #666; 
            margin: 15px 0; 
            line-height: 1.6;
          }
          .qr-container { 
            background: #f9f9f9; 
            padding: 30px 20px; 
            border-radius: 15px; 
            border: 3px solid #667eea; 
            margin: 30px 0;
          }
          img { 
            max-width: 100%; 
            height: auto; 
            border-radius: 5px;
            image-rendering: pixelated;
          }
          .instructions { 
            text-align: left; 
            background: #f0f8ff; 
            padding: 20px; 
            border-radius: 10px; 
            border-left: 4px solid #667eea; 
            margin: 20px 0;
          }
          .instructions h3 { 
            margin: 0 0 15px 0; 
            color: #333; 
            font-size: 16px;
          }
          .instructions ol { 
            margin-left: 20px;
            color: #555;
          }
          .instructions li { 
            margin: 8px 0;
          }
          .auto-refresh {
            font-size: 12px;
            color: #999;
            margin-top: 30px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 WhatsApp Bot</h1>
          <p class="status-badge">✅ Bot Ativo</p>
          
          <h2 style="font-size: 18px; color: #555; margin-bottom: 20px;">Escaneie o QR Code</h2>
          
          <div class="qr-container">
            ${qrImageTag}
          </div>
          
          <div class="instructions">
            <h3>📋 Como Conectar:</h3>
            <ol>
              <li>Abra o WhatsApp no seu celular</li>
              <li>Vá para <strong>Configurações → Aparelhos conectados</strong></li>
              <li>Toque em <strong>Conectar um aparelho</strong></li>
              <li>Aponte a câmera para o QR Code acima</li>
            </ol>
          </div>
          
          <p style="font-size: 12px; color: #999; margin-top: 20px;">
            Status: ${qrImageData ? '✅ QR Code capturado' : '⏳ Aguardando captura'}
          </p>
          
          ${!qrImageData ? '<script>setInterval(() => location.reload(), 3000);</script>' : ''}
        </div>
      </body>
      </html>
    `);
    return;
  }

  // Rota JSON para debugging
  else if (pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      qr_ready: !!qrImageData,
      timestamp: new Date().toISOString()
    }, null, 2));
  }
  // 404
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Iniciar servidor HTTP
qrServer.listen(QR_SERVER_PORT, '0.0.0.0', () => {
  console.log(`\n🌐 SERVIDOR QR CODE INICIADO!`);
  console.log(`📱 Acesse o QR code em: http://localhost:${QR_SERVER_PORT}`);
  console.log(`🔗 URL local: http://127.0.0.1:${QR_SERVER_PORT}`);
  console.log(`💻 URL da rede: http://<seu-ip-vps>:${QR_SERVER_PORT}\n`);
});

// Return the hour (0-23) in the given IANA time zone using Intl.
function getHourInTimeZone(timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' });
    const parts = dtf.formatToParts(new Date());
    const hourPart = parts.find(p => p.type === 'hour');
    if (hourPart && hourPart.value) return Number(hourPart.value);
  } catch (e) {
    if (process.env.WPP_DEBUG_MATCH) console.log('⚠️ getHourInTimeZone failed:', e && e.message ? e.message : e);
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
    console.log(`⏳ Fora do horário de envio no fuso ${TARGET_TIMEZONE} (hora local lá: ${hr}) — verificando novamente em 60s.`);
    await delay(60000); // check again in 60 seconds
  }
}

// Janela de horário para envio da primeira mensagem (horário local do servidor)
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

// Função para buscar contato por nome usando a barra de pesquisa
async function searchContactByName(client, displayName, contatoMap) {
  try {
    const page = client.pupPage;
    const searchSelector = 'div[title="Procurar ou começar uma nova conversa"]';
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
// Função para capturar QR diretamente da página via Puppeteer (fallback garantido)
async function captureQRFromPage(page, maxAttempts = 120) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      // Tenta encontrar a imagem do QR na página
      const qrImageData = await page.evaluate(() => {
        // Procura por canvas com QR (pode estar visível ou hidden)
        const canvases = document.querySelectorAll('canvas');
        for (const canvas of canvases) {
          try {
            // Qualquer canvas de tamanho razoável pode ser QR
            if (canvas.width > 50 && canvas.height > 50) {
              const data = canvas.toDataURL('image/png');
              // Verifica se tem conteúdo (não é branco)
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
        console.log('\n📸 QR Code capturado via Puppeteer!\n');
        const cleanData = qrImageData.replace(/^data:image\/png;base64,/, '');
        await new Promise((resolve) => {
          QRCode.toString(cleanData, { type: 'terminal' }, (err, result) => {
            if (!err && result) {
              console.log('📱 QR Code (ASCII Art):\n');
              console.log(result);
            } else {
              console.log('📸 QR detectado (pode estar visível na janela Chrome)\n');
            }
            resolve();
          });
        });
        console.log('\n⏳ Aguardando você escanear o QR code...\n');
        return true;
      }
    } catch (err) {
      // ignore errors, continue trying
    }
    
    attempts++;
    if (attempts % 20 === 0) {
      console.log(`⏳ Aguardando QR na página... (${attempts}s)`);
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

// Se não houver tokens salvos, force uma sessão nova com timestamp para garantir QR fresco
const tokenPath = path.join(__dirname, 'tokens', sessionName);
if (!fs.existsSync(tokenPath)) {
  console.log('⚠️ Nenhuma sessão autenticada encontrada. Forçando autenticação nova...');
  // Usar timestamp para garantir sessão única = novo QR
  sessionName = `${sessionName}-auth-${Date.now()}`;
}

console.log('ℹ️ Using session:', sessionName);
console.log('ℹ️ Script __dirname:', __dirname);
console.log('✅ Iniciando wppconnect.create() — aguardando QR code...\n');

// Variável para rastrear se o QR já foi exibido
let qrShown = false;

// Função para decodificar QR de screenshot via jsQR
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

// Função para capturar screenshot do QR code do WhatsApp Web
async function captureQRScreenshot(page) {
  try {
    if (!page) return null;
    
    // Tenta encontrar o elemento QR code no DOM
    const qrElement = await page.$('canvas[data-testid*="qr"], [data-testid*="qr"], canvas, div[class*="qr"]');
    
    if (qrElement) {
      // Se encontrou, tira screenshot só do elemento
      const screenshot = await qrElement.screenshot({ encoding: 'base64' });
      if (screenshot && screenshot.length > 500) {
        console.log('📸 Screenshot do QR code capturado via elemento!');
        return screenshot;
      }
    }

    // Se não encontrou o elemento, tira screenshot de uma região da página
    // Tenta screenshots de diferentes regiões onde o QR pode estar
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
          // Verifica se a imagem não é toda branca (tem conteúdo)
          const buffer = Buffer.from(screenshot, 'base64');
          if (buffer.length > 1000) {
            console.log('📸 Screenshot do QR code capturado com sucesso!');
            return screenshot;
          }
        }
      } catch (e) {
        // Continua para próxima região
      }
    }

    return null;
  } catch (e) {
    console.log('⚠️ Erro ao capturar screenshot do QR:', e && e.message ? e.message : e);
    return null;
  }
}

// Função para capturar e exibir QR continuamente
async function captureAndDisplayQR(client) {
  const maxAttempts = 600; // 10 minutos (600 * 1s)
  let lastError = '';
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const waPage = client.waPage;
      if (!waPage) {
        if (attempt === 0) console.log('⏳ Aguardando página Puppeteer...');
        await delay(1000);
        continue;
      }

      // MÉTODO 1: Tenta extrair QR do DOM (canvas/img)
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

      // MÉTODO 2: Se método 1 falhar, tira screenshot e decodifica
      let qrText = null;
      if (!qrData && !qrShown) {
        try {
          const screenshot = await waPage.screenshot({ encoding: 'base64' });
          qrText = await decodeQRFromScreenshot(screenshot);
        } catch (e) {
          // Screenshot falhou, continua
        }
      }

      // Se encontrou QR por qualquer método, exibe
      if ((qrData || qrText) && !qrShown) {
        console.log('\n' + '='.repeat(80));
        console.log('📱 QR CODE ENCONTRADO! Capturando screenshot...');
        console.log('='.repeat(80) + '\n');
        
        // Tentar capturar screenshot do QR code
        const screenshot = await captureQRScreenshot(waPage);
        if (screenshot) {
          qrScreenshot = screenshot;
          console.log('✅ Screenshot do WhatsApp Web capturado!\n');
        }
        
        if (qrData) {
          const cleanData = qrData.data.replace(/^data:image\/png;base64,/, '');
          qrImageData = cleanData; // Também salvar PNG alternativo
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
          console.log('✅ QR Decodificado via screenshot!');
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
        console.log('🌐 ACESSE VIA HTTP:');
        console.log(`   👉 http://localhost:${QR_SERVER_PORT}`);
        console.log(`   👉 http://127.0.0.1:${QR_SERVER_PORT}`);
        console.log('='.repeat(80) + '\n');
        
        qrShown = true;
      }
      
      // Se QR já foi mostrado, verificar se autenticou
      if (qrShown) {
        try {
          const profileName = await client.getProfileName();
          if (profileName && String(profileName).trim().length > 0) {
            console.log('🎉 Autenticação CONCLUÍDA! Bem-vindo:', profileName);
            return true;
          }
        } catch (e) {
          // Ainda não autenticado
        }
      }

      if (attempt === 0) console.log('⏳ Monitorando página para QR...');
      if (attempt % 10 === 0 && attempt > 0) {
        console.log(`⏳ Aguardando... ${attempt}s`);
      }
      await delay(1000);
      
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      if (errMsg !== lastError) {
        console.log('ℹ️ Monitoramento:', errMsg);
        lastError = errMsg;
      }
      await delay(1000);
    }
  }
  return false;
}

wppconnect.create({
  session: sessionName,
  headless: process.env.HEADLESS !== 'false' ? true : false,  // ← DEFAULT TRUE (production/VPS); set HEADLESS=false to see browser
  autoClose: 0,  // ← NUNCA FECHAR AUTOMATICAMENTE (0 = desabilitar)
  waitForLogin: false,  // ← NÃO BLOQUEAR, deixar rodar
  logQR: true,  // ← DEIXAR wppconnect LOGAR QR AUTOMATICAMENTE (default)
  disableWelcome: false,
  protocolTimeout: process.env.PROTOCOL_TIMEOUT ? Number(process.env.PROTOCOL_TIMEOUT) : 300000,
  catchQR: (qrCode, asciiQR) => {
    console.log('🔔 catchQR callback acionado! qrCode recebido:', !!qrCode);
    if (!qrShown && qrCode) {
      console.log('\n' + '='.repeat(80));
      console.log('✅ QR CODE CAPTURADO COM SUCESSO!');
      console.log('='.repeat(80));
      try {
        const cleanData = qrCode.replace(/^data:image\/png;base64,/, '');
        qrImageData = cleanData;
        console.log('✅ QR Image Data armazenado com', cleanData.length, 'bytes');
        
        console.log('\n🌟 OPÇÕES PARA ESCANEAR:\n');
        console.log('1️⃣  ACESO NO NAVEGADOR (RECOMENDADO):');
        console.log(`   👉 http://localhost:${QR_SERVER_PORT}`);
        console.log(`   👉 http://<SEU-IP-VPS>:${QR_SERVER_PORT}\n`);
        
        console.log('2️⃣  PRÓXIMOS PASSOS:');
        console.log('   • Copie a URL acima');
        console.log('   • Abra no navegador do seu celular');
        console.log('   • O QR code aparecerá automaticamente');
        console.log('   • Escaneie com outro celular (WhatsApp → Configurações → Aparelhos conectados)\n');
        console.log('='.repeat(80) + '\n');
        
        qrShown = true;
      } catch (e) {
        console.log('⚠️ Erro ao processar QR code:', e && e.message ? e.message : e);
        qrShown = true;
      }
    }
  },
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
  console.log('\n✅ ✅ ✅ BOT CONECTADO ✅ ✅ ✅\n');
  
  // Inicia captura de QR em background
  const qrCapturePromise = captureAndDisplayQR(client);
  
  // Aguarda um pouco para a página carregar
  await delay(3000);
  let isReallyLogged = false;
  try {
    // Tenta obter o nome do perfil - só funciona se autenticado
    const profileName = await client.getProfileName();
    console.log('✅ Perfil obtido:', profileName);
    isReallyLogged = profileName && String(profileName).trim().length > 0;
  } catch (e) {
    console.log('ℹ️ Erro ao obter perfil:', e && e.message ? e.message : 'desconhecido');
    isReallyLogged = false;
  }
  
  if (!isReallyLogged) {
    console.log('\n🔍 DETECÇÃO: Sessão NÃO está autenticada!');
    console.log('⏳ Verificando página para QR code...\n');
  } else {
    console.log('🎉 Sessão conectada ao WhatsApp!\n');
  }

  // ---------- START: funções para consultas/envio manuais sem parar o bot ----------
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
        console.log(`ℹ️ Loaded ${contatosIniciados.size} started contacts from ${STARTED_FILE}`);
      } else {
        console.log(`ℹ️ No ${STARTED_FILE} found — starting fresh.`);
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

  // Carrega estado persistido (se houver)
  loadStartedFromDisk();

  // Retorna array de objetos { chatIdNorm, chatIdOriginal, info } para os "abertos"
  function getOpenConversations() {
    const out = [];
    for (const [chatIdNorm, info] of contatosIniciados.entries()) {
      // critério: já iniciamos (startedAt) e o contato respondeu (lastRespondedAt) mas audioSent != true
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

  // Interactive stdin handler removed — no terminal commands exposed
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (raw) => {
    // intentionally ignore stdin commands in production mode
  });
  // ---------- END: funções para consultas/envio manuais ----------

  // Listener: só responde quando um contato que o bot iniciou responder
  client.onMessage(async (msg) => {
    try {
      // Filtragens iniciais
      if (msg.fromMe) return; // ignorar mensagens do próprio bot
      if (msg.isGroupMsg) return; // ignorar grupos
      if (msg.type === 'status') return; // ignorar atualizações de status
      if (msg.isNotification || msg.isBot) return; // ignorar notificações/bots

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
          console.log(`⚠️ Mensagem duplicada de ${incomingNorm} (mesmo id) — ignorando.`);
          return;
        }
        // time-based debounce: ignore if last response was very recent
        const lastResp = startedInfo.lastRespondedAt || 0;
        if (now - lastResp < 5000) { // 5s window
          console.log(`⚠️ Resposta recente de ${incomingNorm} detectada (${Math.round(now - lastResp)}ms) — ignorando para evitar duplicatas.`);
          return;
        }
      }

      // Verifica se esse contato foi iniciado por este bot (usando id normalizado)
      if (!contatosIniciados.has(incomingNorm)) {
        // Não iniciamos essa conversa, então não respondemos
        console.log(`⚠️ Mensagem recebida de ${incomingNorm} mas não iniciada por este bot — ignorando.`);
        return;
      }

      // If the message arrives very soon after we started the conversation, treat it as automatic
      // (some autoresponders and systems reply immediately). Ignore messages within 5s of startedAt.
      try {
        const startedEntry = contatosIniciados.get(incomingNorm) || {};
        const startedAt = startedEntry.startedAt || 0;
        if (startedAt && (now - startedAt) < 5000) {
          if (process.env.WPP_DEBUG_MATCH) console.log(`🔎 Ignoring message from ${incomingNorm} because it arrived ${now - startedAt}ms after start (treated as automatic)`);
          console.log(`⚠️ Mensagem de ${incomingNorm} chegou logo após início (${Math.round(now - startedAt)}ms) — provável automática — ignorando.`);
          return;
        }
      } catch (e) { /* ignore errors retrieving startedAt */ }

      // Se já enviamos o áudio para essa conversa, não enviamos novamente
      let startedInfoCheck = contatosIniciados.get(incomingNorm);
      if (startedInfoCheck && startedInfoCheck.audioSent) {
        console.log(`ℹ️ Áudio já enviado anteriormente para ${incomingNorm} — ignorando envio duplicado.`);
        return;
      }

      // Apenas responder se a mensagem parecer vinda de um humano (filtra auto-replies/sistemas)
      if (!isLikelyHumanMessage(msg)) {
        console.log(`⚠️ Mensagem de ${incomingNorm} parece automática/sistema — ignorando.`);
        return;
      }

      // Optional: evitar respostas a mensagens automáticas - exemplo ampliado
      const body = (msg.body || '').toString().toLowerCase();
      // expanded patterns to catch common auto-replies / OOF messages
      const autoPatterns = [
        'mensagem automática', 'resposta automática', 'auto-reply', 'auto reply', 'auto resposta',
        'resposta automática', 'estou fora', 'estou ausente', 'fora do horário', 'horário de atendimento',
        'mensagem de ausência', 'mensagem de ausencia', 'serviço', 'autoresponder', 'autoreply',
        'mensagem automática', 'não estou disponível', 'não estou disponível', 'indisponível', 'indisponivel'
      ];
      const autoRegex = /\b(auto|autom[aá]tico|ausente|fora|indispon[ií]vel|aus[eé]ncia|ausencia|autoresponder|auto-?reply)\b/i;
      if (!body || autoPatterns.some(p => body.includes(p)) || autoRegex.test(body)) {
        console.log(`⚠️ Mensagem parece automática/sistema de ${chatId} — ignorando.`);
        return;
      }

  // enviar áudio de resposta (simulando gravação na hora)
  const audioPath = path.join(__dirname, 'audio_resposta.ogg');
      if (!fs.existsSync(audioPath)) {
        console.log(`⚠️ Arquivo de áudio não encontrado em ${audioPath}.`);
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
          await client.sendText(targetId, 'Não foi possível enviar o áudio automaticamente.');
        } else {
          throw new Error('Nenhum método de envio de áudio suportado pelo client');
        }
        console.log(`🎤 Áudio enviado para ${incomingNorm}`);
        // mark last responded id/time to avoid duplicates
        if (startedInfo2) {
          if (incomingMsgId) startedInfo2.lastMsgId = incomingMsgId;
          startedInfo2.lastRespondedAt = now;
          // audioSent já foi marcado antes do envio
          contatosIniciados.set(incomingNorm, startedInfo2);
        }
      } catch (e) {
        console.log(`❌ Erro ao enviar áudio para ${incomingNorm}: ${e && e.message ? e.message : e}`);
      }
    } catch (err) {
      console.log('❌ Erro no onMessage:', err.message);
    }
  });

  // Aguarda 2 minutos antes de buscar contatos para garantir carregamento
  console.log('⏳ Aguardando 2 minutos para carregar contatos...');
  await delay(120000);

  // Configuráveis
  // Limite máximo de envios (padrão) - usa MAX_OPA já definido no topo

  // Variáveis de escopo para índices que podem ser rebuildados
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

  // Rebuilda todos os índices a partir de todosContatos
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
      console.log('⚠️ Erro ao atualizar log_contatos_wpp.txt:', e && e.message ? e.message : e);
    }
  }

  // Busca inicial e build dos índices
    // Persistent cache on disk for contacts (agenda_cache.json)
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
          console.log('⚠️ saveAgendaCache: lista vazia — não sobrescrevendo o cache.');
          return false;
        }
        fs.writeFileSync(AGENDA_CACHE_FILE, JSON.stringify(list, null, 2), 'utf8');
        console.log(`✅ Agenda salva em cache (${AGENDA_CACHE_FILE}) — ${list.length} contatos`);
        return true;
      } catch (e) {
        console.log('⚠️ Erro ao salvar cache de agenda:', e && e.message ? e.message : e);
        return false;
      }
    }

    // 1) tenta carregar do cache no disco primeiro
    const cached = loadAgendaCache();
    if (cached) {
      todosContatos = cached;
      try { rebuildIndices(); } catch (e) { console.log('⚠️ Erro rebuildIndices após carregar cache:', e && e.message ? e.message : e); }
    }

    // 2) em seguida, tenta buscar do WhatsApp — se obtiver uma lista válida (não vazia), sobrescreve cache
    try {
      const fresh = await (client.listContacts ? client.listContacts() : (client.getAllContacts ? client.getAllContacts() : []));
      if (Array.isArray(fresh) && fresh.length > 0) {
        // se não havia cache ou a lista nova tem conteúdo, atualiza em memória e grava em disco
        todosContatos = fresh;
        rebuildIndices();
        saveAgendaCache(fresh);
        console.log(`ℹ️ Contatos carregados do WhatsApp: ${todosContatos.length}`);
      } else {
        if (!cached) console.log('⚠️ Não foi possível obter contatos do WhatsApp e não existe cache local. Agenda ficará vazia.');
        else console.log('⚠️ Lista do WhatsApp vazia — mantendo cache local.');
      }
    } catch (e) {
      console.log('❌ Erro ao obter contatos iniciais do WhatsApp:', e && e.message ? e.message : e);
      if (!cached) console.log('⚠️ Nenhum cache local disponível — a lista de contatos ficará vazia até que seja possível obter do WhatsApp.');
    }

  // Limite máximo de envios (padrão) - usa MAX_OPA já definido no topo

  // Mantém a função de envio inicial (envia "Opa" para cada contato filtrado)
  // Constrói um set com os números autorizados (da lista `contatos`) para garantir que
  // nunca enviemos para contatos que não estão explicitamente na sua lista filtrada.
  const allowedNumbers = new Set(contatos.map(c => normalizePhone(c.numero)).filter(Boolean));
  console.log(`ℹ️ Números autorizados carregados: ${allowedNumbers.size}`);
  // If the process started before 13:00 in TARGET_TIMEZONE, wait until the send window opens there
  await waitUntilSendWindow();
  console.log('▶️ Janela de envio aberta no fuso', TARGET_TIMEZONE, '— iniciando envios.');

  for (const [i, contato] of contatos.entries()) {
    if (enviados >= MAX_OPA) {
      console.log(`🚦 Limite de ${MAX_OPA} mensagens 'opa' atingido. Parando envios.`);
      break;
    }
    // Debug: show current hour in TARGET_TIMEZONE before deciding to send
    if (process.env.WPP_DEBUG_MATCH) {
      const hr = getHourInTimeZone(TARGET_TIMEZONE);
      console.log(`🔎 Hora atual em ${TARGET_TIMEZONE}: ${hr}h — isWithinSendWindow()=${isWithinSendWindow()}`);
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
      // Implementação do fluxo baseado em índices
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
            console.log(`🔎 Encontrado via UI por nome exato: ${contatoAgenda.name}`);
          } else {
            // uiFound === null means either not found or found but unmapped; continue heuristics
            if (process.env.WPP_DEBUG_MATCH) console.log('🔎 UI search did not return a mapped contact. Falling back to index search.');
          }
        } catch (uiErr) { if (process.env.WPP_DEBUG_MATCH) console.log('⚠️ UI search error:', uiErr && uiErr.message ? uiErr.message : uiErr); }
      }
      uiConfirmed = !!uiFound;

      // 1) busca por número exato
      if (tentativaNumero && phoneMap.has(tentativaNumero)) {
        contatoAgenda = phoneMap.get(tentativaNumero);
        console.log(`🔎 Encontrado por número exato: ${normalizeChatId(contatoAgenda.id)}`);
      }

      // 2) busca por últimos dígitos
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
        if (contatoAgenda) console.log(`🔎 Encontrado por últimos dígitos: ${normalizeChatId(contatoAgenda.id)}`);
      }

      // 3) busca por nome exato no mapa
      if (!contatoAgenda && contatoMap.has(nomeBusca)) {
        contatoAgenda = contatoMap.get(nomeBusca);
        console.log(`🔎 Encontrado no nameMap: ${contatoAgenda.name}`);
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
        if (contatoAgenda) console.log(`🔎 Encontrado por tokenIndex: ${contatoAgenda.name}`);
      }

      // 5) fuzzy global (último recurso antes da UI)
      if (!contatoAgenda) {
        let best = null, bestScore = 0;
        for (const c of todosContatos) {
          if (!c.name) continue;
          if (!c.isMyContact) continue;
          const n = c.name;
          if (fuzzyMatch(n, normalizarNomeContato(contato))) { best = c; bestScore = 1; break; }
          // leve heurística: token overlap
        }
        if (best) { contatoAgenda = best; console.log(`🔎 Encontrado por fuzzy global: ${contatoAgenda.name}`); }
      }

      // (UI confirmation removed — using unified uiFindContactByExactName earlier)

      // 7) envio final seguindo confirmações
      // Proteção extra: se o candidato encontrado (contatoAgenda) não estiver na lista filtrada
      // (pelo número), pule para evitar enviar para contatos do catálogo que coincidem por nome.
      if (contatoAgenda) {
        try {
          const candidatePhone = extractDigitsFromId(contatoAgenda) || (contatoAgenda.numero ? normalizePhone(contatoAgenda.numero) : null);
          const requestedPhone = tentativaNumero || null;
          // if candidatePhone exists and is not in allowedNumbers and doesn't match the requestedPhone, skip
          if (candidatePhone && !allowedNumbers.has(candidatePhone) && requestedPhone && candidatePhone !== requestedPhone) {
            console.log(`⚠️ Candidato encontrado (${contatoAgenda.name} / ${candidatePhone}) NÃO está na lista filtrada — pulando para evitar envio fora da lista.`);
            skipDelay = true;
            continue;
          }
        } catch (chkErr) { /* ignore check failures and proceed */ }
      }
      if (uiConfirmed && contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) — pulando envio via UI.`);
          if (process.env.WPP_DEBUG_MATCH) console.log(`🔎 skip reason: chatExists true for candidate ${chatId}`);
          skipDelay = true;
        } else {
          try {
            await client.sendText(chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`✅ Mensagem enviada via UI para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend) {
            console.log('❌ Erro envio via UI:', errSend.message);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (contatoAgenda && contatoAgenda.id) {
        const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
        if (await chatExists(client, chatId)) {
          console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) — pulando envio por correspondência.`);
          if (process.env.WPP_DEBUG_MATCH) console.log(`🔎 skip reason: chatExists true for candidate ${chatId}`);
          skipDelay = true;
        } else {
          try {
            await client.sendText(chatId, mensagem);
            contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
            console.log(`✅ Mensagem enviada por correspondência para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
            enviados++;
          } catch (errSend2) {
            console.log('❌ Falha ao enviar por correspondência:', errSend2.message);
            falhas++;
            skipDelay = true;
          }
        }
      } else if (tentativaNumero) {
        // último recurso: antes de enviar diretamente por número, tentar localizar o contato na agenda
        let foundAgendaContact = null;
        try {
          for (const c of todosContatos) {
            try {
              const cand = extractDigitsFromId(c) || (c.number || c.phone || c.numero || '');
              const candNorm = normalizePhone(cand);
              if (candNorm && tentativaNumero && candNorm === tentativaNumero) { foundAgendaContact = c; break; }
              // última heurística: comparar últimos 8 dígitos
              if (candNorm && tentativaNumero && candNorm.slice(-8) === tentativaNumero.slice(-8)) { foundAgendaContact = c; break; }
            } catch (inner) { /* ignore per-contact parse errors */ }
          }
        } catch (e) { /* ignore failures during scan */ }

        // se não encontrado por número, tentar mapear por nome exato
        if (!foundAgendaContact && contatoMap && contatoMap.has(nomeBusca)) {
          foundAgendaContact = contatoMap.get(nomeBusca);
        }

        if (foundAgendaContact && foundAgendaContact.id) {
          contatoAgenda = foundAgendaContact;
          const chatId = contatoAgenda.id; const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) — pulando envio por correspondência de agenda.`);
            if (process.env.WPP_DEBUG_MATCH) console.log(`🔎 skip reason: chatExists true for candidate ${chatId}`);
            skipDelay = true;
          } else {
            try {
              await client.sendText(chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`✅ Mensagem enviada por correspondência (agenda) para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('❌ Falha ao enviar por correspondência (agenda):', errFallback.message);
              falhas++;
              skipDelay = true;
            }
          }
        } else {
          // fallback numérico puro
          const chatId = `${tentativaNumero}@c.us`; const chatIdNorm = normalizeChatId(chatId);
          if (await chatExists(client, chatId)) {
            console.log(`⚠️ Já existe chat aberto com ${normalizarNomeContato(contato)} (${chatIdNorm}) — pulando envio por fallback numérico.`);
            if (process.env.WPP_DEBUG_MATCH) console.log(`🔎 skip reason: chatExists true for candidate ${chatId}`);
            skipDelay = true;
          } else {
            try {
              await client.sendText(chatId, mensagem);
              contatosIniciados.set(chatIdNorm, { startedAt: Date.now(), chatIdOriginal: chatId });
              console.log(`⚠️ Mensagem enviada por fallback NUMÉRICO para ${normalizarNomeContato(contato)} (${chatIdNorm})`);
              enviados++;
            } catch (errFallback) {
              console.log('❌ Falha no fallback por número:', errFallback.message);
              const logPesquisaPath = path.join(__dirname, 'log_pesquisa.txt');
              fs.appendFileSync(logPesquisaPath, `Contato não encontrado: ${normalizarNomeContato(contato)} | Busca: ${nomeBusca}\n`);
              fs.appendFileSync(logPesquisaPath, `-----------------------------\n`);
              falhas++;
              skipDelay = true;
            }
          }
        }
      } else {
        const logPesquisaPath = path.join(__dirname, 'log_pesquisa.txt');
        fs.appendFileSync(logPesquisaPath, `Contato não encontrado: ${normalizarNomeContato(contato)} | Busca: ${nomeBusca}\n`);
        fs.appendFileSync(logPesquisaPath, `-----------------------------\n`);
        console.log(`⚠️ [${i + 1}/${contatos.length}] Contato não encontrado na agenda: ${normalizarNomeContato(contato)} - pulando.`);
        falhas++;
        skipDelay = true;
      }
    } catch (e) {
      console.log(`❌ [${i + 1}/${contatos.length}] Erro ao processar ${normalizarNomeContato(contato)}: ${e.message}`);
      falhas++;
    }

    const restantes = contatos.length - (i + 1);

    // (refresh periódico removido — usamos cache persistente em disco e atualização manual)
    console.log(`📊 Progresso: ${enviados} enviados, ${falhas} falhas, ${restantes} restantes.`);

    if (skipDelay) {
      console.log('⏩ Pulando espera devido a falha / chat existente — seguindo para o próximo contato.');
    } else {
  const espera = randomDelay(45000, 75000); // 45s a 1m15s
      console.log(`⏳ Aguardando ${Math.round(espera / 1000)} segundos antes do próximo envio...`);
      await delay(espera);
    }
  }

  // escreve resumo final usando as variáveis de topo (enviados/falhas)
  try {
    fs.writeFileSync(path.join(__dirname, 'log.txt'), `Enviados: ${enviados}\\nFalhas: ${falhas}`);
  } catch (e) {}
  console.log(`📊 Envio finalizado: ${enviados} enviados, ${falhas} falhas`);

  // Keep the process alive so the bot can respond with audio to incoming replies.
  console.log('🤖 Bot permanecerá ativo para receber respostas e enviar áudio. Pressione CTRL+C para encerrar.');

  // Heartbeat log to keep process/connection active and make status visible
  setInterval(() => {
    console.log(`🫡 Bot ativo. Enviados: ${enviados}, Falhas: ${falhas}. ${new Date().toISOString()}`);
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
      console.log(`⏳ Bot ficará ativo até ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} (${TARGET_TIMEZONE}).`);
      const checkInterval = setInterval(async () => {
        try {
          const hr = getHourInTimeZone(TARGET_TIMEZONE);
          const minute = getMinuteInTimeZone(TARGET_TIMEZONE);
          if (hr > SHUTDOWN_HOUR || (hr === SHUTDOWN_HOUR && minute >= SHUTDOWN_MINUTE)) {
            clearInterval(checkInterval);
            console.log(`⏰ ${TARGET_TIMEZONE} alcançou ${String(SHUTDOWN_HOUR).padStart(2,'0')}:${String(SHUTDOWN_MINUTE).padStart(2,'0')} — encerrando bot.`);
            try {
              if (client && client.close) await client.close();
            } catch (e) { console.log('⚠️ Erro ao fechar client durante shutdown:', e && e.message ? e.message : e); }
            process.exit(0);
          }
          // optional: log remaining time every 10 minutes
        } catch (e) {
          /* ignore transient errors in watcher */
        }
      }, 30 * 1000); // check every 30s
    } catch (e) {
      console.log('⚠️ Não foi possível iniciar shutdown watcher:', e && e.message ? e.message : e);
    }
  })();

  // Graceful shutdown on CTRL+C
  process.on('SIGINT', async () => {
    console.log('\n⏹️ Recebido SIGINT — encerrando sessão...');
    try {
      if (client && client.close) await client.close();
    } catch (e) {
      console.log('Erro ao fechar client:', e && e.message ? e.message : e);
    }
    process.exit(0);
  });
}).catch((err) => {
  console.log('❌ Erro ao iniciar o bot:', err && err.message ? err.message : String(err));
  console.log('\n📌 DICAS:');
  console.log('   1. Verifique se a pasta tokens/disparador foi deletada');
  console.log('   2. Verifique se o navegador Chrome está disponível');
  console.log('   3. Tente novamente ou use um novo WPP_SESSION\n');
  process.exit(1);
});
