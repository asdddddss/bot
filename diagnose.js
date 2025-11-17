/**
 * Diagnóstico: Investigar por que wppconnect não mostra QR
 * 
 * Hipóteses:
 * 1. logQR: true não está funcionando - não há callback implementado
 * 2. Sessão está sendo reutilizada do cache Chromium
 * 3. catchQR callback nunca é disparado
 */

const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
const fs = require('fs');

console.log('\n🔍 DIAGNÓSTICO: Investigando wppconnect QR...\n');

// Force clean slate
const tokensPath = path.join(__dirname, 'tokens', 'diag-test');
if (fs.existsSync(tokensPath)) {
  console.log(`Deletando sessão anterior: ${tokensPath}`);
  require('child_process').execSync(`rmdir /s /q "${tokensPath}"`, { windowsHide: true }).toString();
}

console.log('Iniciando wppconnect com todos os callbacks...\n');

wppconnect.create({
  session: 'diag-test',
  headless: false,
  autoClose: 0,
  waitForLogin: false,
  logQR: true,  // Padrão: true
  protocolTimeout: 300000,
  
  // Todos os callbacks possíveis
  catchQR: (qrCode, asciiQR) => {
    console.log('\n✅ CALLBACK catchQR DISPARADO!');
    console.log('QR Code (primeiros 100 chars):', qrCode ? qrCode.substring(0, 100) : 'null');
    console.log('ASCII QR:', asciiQR ? 'presente' : 'null');
  },
  
  onQrCode: (qrCode, asciiQR) => {
    console.log('\n✅ CALLBACK onQrCode DISPARADO!');
    console.log('QR Code:', qrCode ? 'presente' : 'null');
  },
  
  statusFind: (status) => {
    const statusStr = String(status).toLowerCase();
    if (statusStr.includes('qr') || statusStr.includes('scan')) {
      console.log('\n✅ STATUS QR DETECTADO:', status);
    }
  },
  
  onLoadingScreen: (isLoading) => {
    console.log('Loading screen:', isLoading);
  }
}).then((client) => {
  console.log('\n✅✅✅ CLIENT CRIADO! Verificando propriedades...\n');
  console.log('Client properties:', Object.keys(client).slice(0, 15).join(', '));
  console.log('Has page?', !!client.page);
  console.log('Has browser?', !!client.browser);
  console.log('\n⏳ Aguardando 15 segundos para ver se QR aparece...');
  
  setTimeout(() => {
    console.log('\n❌ Nenhum QR apareceu em 15 segundos!');
    process.exit(0);
  }, 15000);
  
}).catch((err) => {
  console.log('\n❌ Erro ao criar client:');
  console.log(err.message || err);
  process.exit(1);
});
