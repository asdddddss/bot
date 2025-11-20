#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import re

with open('chatbot.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Padrão para encontrar e substituir o bloco de console.log para QR
pattern = r"console\.log\('📸 QR CODE SALVO COM SUCESSO!.*?console\.log\('='.repeat\(80\) \+ '\\\n'\);"

replacement = """// Gerar QR code em Unicode - muito mais legível
        console.log('📱 QR CODE ESCANEÁVEL (copie se precisar):\\n');
        QRCode.toString(cleanData, { type: 'terminal', width: 25, small: false }, (err, result) => {
          if (!err && result) console.log(result);
        });
        console.log('\\n🌐 OU ACESSE VIA NAVEGADOR:\\n');
        console.log(`   👉 http://localhost:${QR_SERVER_PORT}`);
        console.log(`   👉 http://127.0.0.1:${QR_SERVER_PORT}`);
        console.log('\\n💡 Na VPS, substitua "localhost" pelo IP da máquina');
        console.log('📱 Aponte a câmera do celular para qualquer uma das opções acima!\\n');
        console.log('='.repeat(80) + '\\n');"""

content = re.sub(pattern, replacement, content, flags=re.DOTALL)

with open('chatbot.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('✅ Arquivo atualizado com sucesso!')
