# 🔧 DIAGNÓSTICO: Por que o QR Code não aparecia

## Problema Identificado

**O bot mostrava "AUTENTICAÇÃO CONCLUÍDA" mas na verdade NÃO estava autenticado.**

### Causas Raiz:

1. **wppconnect reutiliza tokens Chromium**
   - A biblioteca salva dados de autenticação em `tokens/disparador/` no Chromium IndexedDB
   - Mesmo deletando a pasta de tokens, o cache do Chromium mantinha os dados
   - Resultado: wppconnect assumia sessão "autenticada" mas sem acesso real

2. **logQR: true não dispara quando não há QR**
   - wppconnect assume que se há uma pasta de tokens, a sessão já existe
   - Se a sessão "existe", não gera novo QR
   - Callbacks (`catchQR`, `onQrCode`, `logQR`) nunca são disparados

3. **Sessão fake vs. real**
   - Bot reportava "✅ AUTENTICAÇÃO CONCLUÍDA"
   - Mas operações WhatsApp falhavam com `Cannot read properties of undefined (reading 'm')`
   - Indicava que a sessão PARECIA autenticada mas estava quebrada

## Solução Implementada

### 1. **Forçar Nova Sessão a Cada Execução (se não autenticada)**
```javascript
const tokenPath = path.join(__dirname, 'tokens', sessionName);
if (!fs.existsSync(tokenPath)) {
  // Usar timestamp para garantir sessão única = novo QR obrigatoriamente
  sessionName = `${sessionName}-auth-${Date.now()}`;
}
```
→ **Resultado**: Cada execução sem tokens valida cria nome único → wppconnect é forçado a gerar novo QR

### 2. **Adicionar catchQR Callback Como Fallback**
```javascript
catchQR: (qrCode, asciiQR) => {
  // Se logQR falhar, capturamos aqui
  QRCode.toString(cleanData, { type: 'terminal' }, (err, result) => {
    if (!err && result) console.log(result);
  });
}
```
→ **Resultado**: Se `logQR: true` não render QR, capturamos no callback

### 3. **Detectar Sessão Fake e Mostrar Instruções**
```javascript
const isReallyLogged = await client.getStatus()
  .then(() => true)
  .catch(() => false);
  
if (!isReallyLogged) {
  console.log('Sessão NÃO está autenticada. Verifique o QR Code...');
}
```
→ **Resultado**: Avisa usuário se sessão falsa, com instruções claras

## Como Usar Agora

### Primeira Execução (sem tokens):

1. **Execute o bot**:
   ```
   node chatbot
   ```

2. **Uma JANELA CHROME abrirá automaticamente**

3. **Procure o QR Code** no lado esquerdo da tela do navegador

4. **Escaneie com WhatsApp**:
   - Celular → WhatsApp → Configurações → Aparelhos conectados → Seu navegador

5. **Bot autentica e começa**

### Execuções Posteriores:

- Bot reutiliza tokens autenticados (mais rápido)
- Se precisar reconectar: `Remove-Item -Recurse -Force .\tokens` (Windows) ou `rm -rf ./tokens` (Linux/Mac)

## Documentação Consultada

- **@wppconnect-team/wppconnect v1.37.5**
  - `CreateConfig.logQR`: Logs QR automatically in terminal (default: true)
  - `CreateConfig.waitForLogin`: Wait for login before returning client (default: false)
  - `CreateConfig.autoClose`: Auto-close timeout in ms (default: 60000)

- **Limitação Descoberta**: 
  - wppconnect assume que se há tokens, sessão está OK
  - Não há forma confiável de "forçar novo QR" sem deletar tudo
  - Por isso usamos timestamp para garantir sessão nova

## Tecnologias Envolvidas

| Tech | Versão | Uso |
|------|--------|-----|
| @wppconnect-team/wppconnect | 1.37.5 | Conexão WhatsApp Web |
| puppeteer | (embedded) | Navegador Chrome automatizado |
| qrcode | ^1.5.0+ | Renderizar QR em ASCII (terminal) |
| chromium | (puppeteer) | Navegador  Chrome + IndexedDB cache |

## Próximas Melhorias

- [ ] Atualizar para wppconnect 1.37.6 (tem fixes de session)
- [ ] Implementar melhor detecção de session válida
- [ ] Cache de QR em arquivo para reutilizar em crashes
- [ ] Webhook para notificar quando autenticado

---

**Data**: 2025-11-17  
**Status**: ✅ Resolvido - Bot agora força nova autenticação quando necessário
