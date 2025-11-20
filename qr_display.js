// Exibição de QR code com imagem e ASCII art usando wppconnect callbacks
// Similar ao outro bot: mostra data URI e opcionalmente salva em arquivo temporário

const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
  // Configuração para catchQR
  setupQRDisplay: () => {
    return (qrCode, asciiQR) => {
      if (qrCode && !global.qrDisplayed) {
        global.qrDisplayed = true;
        
        try {
          console.log('\n\n');
          console.log('╔' + '═'.repeat(78) + '╗');
          console.log('║' + ' '.repeat(78) + '║');
          console.log('║' + 'QR CODE CAPTURADO - ESCANEIE COM SEU CELULAR'.padStart(62).padEnd(78) + '║');
          console.log('║' + ' '.repeat(78) + '║');
          console.log('╚' + '═'.repeat(78) + '╝');
          console.log('\n');
          
          // Exibir QR code em ASCII art
          if (asciiQR && String(asciiQR).trim()) {
            console.log(asciiQR);
          }
          
          console.log('\n');
          
          // Processar base64 QR code como data URI para visualização
          if (qrCode && String(qrCode).trim()) {
            const raw = String(qrCode).trim();
            const maybeDataUri = raw.startsWith('data:image') ? raw : `data:image/png;base64,${raw}`;
            console.log('═'.repeat(80));
            console.log('IMAGEM QR CODE (Data URI) — Copie e cole em navegador para visualizar:');
            console.log('═'.repeat(80));
            console.log(maybeDataUri);
            console.log('═'.repeat(80));
            
            // Tentar salvar em arquivo temporário para referência
            try {
              const tmpDir = os.tmpdir() || '/tmp';
              const sessionName = process.env.WPP_SESSION || 'disparador';
              const tmpPath = path.join(tmpDir, `wpp_qr_${sessionName}.png`);
              const base64Only = maybeDataUri.split(',')[1] || maybeDataUri;
              const buf = Buffer.from(base64Only, 'base64');
              fs.writeFileSync(tmpPath, buf);
              console.log(`\nQR salvo em: ${tmpPath}`);
            } catch (saveErr) {
              // Silenciosamente ignorar erros de salvamento
            }
          }
          
          console.log('\n');
          console.log('╔' + '═'.repeat(78) + '╗');
          console.log('║' + 'INSTRUÇÕES:'.padStart(45).padEnd(78) + '║');
          console.log('║' + ' '.repeat(78) + '║');
          console.log('║' + '1. Abra WhatsApp no seu celular'.padStart(52).padEnd(78) + '║');
          console.log('║' + '2. Vá em: Configurações → Aparelhos conectados'.padStart(66).padEnd(78) + '║');
          console.log('║' + '3. Clique em "Conectar um aparelho"'.padStart(56).padEnd(78) + '║');
          console.log('║' + '4. Aponte a câmera para o QR code acima'.padStart(62).padEnd(78) + '║');
          console.log('║' + ' '.repeat(78) + '║');
          console.log('╚' + '═'.repeat(78) + '╝');
          console.log('\n');
          
        } catch (e) {
          console.log('Erro ao exibir QR:', e && e.message ? e.message : e);
        }
      }
    };
  }
};
