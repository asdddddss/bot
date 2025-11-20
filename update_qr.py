#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# Ler o arquivo
with open('chatbot.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Encontrar e substituir as linhas
new_lines = []
i = 0
while i < len(lines):
    # Procura pela linha que contém "QR CODE SALVO"
    if "console.log('📸 QR CODE SALVO" in lines[i] or "console.log('� QR CODE SALVO" in lines[i]:
        # Substituir este bloco e os próximos
        # Pula até encontrar o console.log('='.repeat(80))
        new_lines.append("        // Gerar QR code em Unicode - muito mais legível\n")
        new_lines.append("        console.log('📱 QR CODE ESCANEÁVEL (copie se precisar):\\n');\n")
        new_lines.append("        QRCode.toString(cleanData, { type: 'terminal', width: 25, small: false }, (err, result) => {\n")
        new_lines.append("          if (!err && result) console.log(result);\n")
        new_lines.append("        });\n")
        new_lines.append("        console.log('\\n🌐 OU ACESSE VIA NAVEGADOR:\\n');\n")
        
        # Pula as linhas antigas até "console.log('='.repeat"
        while i < len(lines):
            if "console.log('='.repeat" in lines[i]:
                break
            i += 1
        # Voltar uma linha para adicionar antes do =.repeat
        i -= 1
        new_lines.append("        console.log('\\n💡 Na VPS, substitua \"localhost\" pelo IP da máquina');\n")
        new_lines.append("        console.log('📱 Aponte a câmera do celular para qualquer uma das opções acima!\\n');\n")
    
    new_lines.append(lines[i])
    i += 1

# Escrever de volta
with open('chatbot.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print('✅ Arquivo atualizado!')
