#!/usr/bin/env node

/**
 * Script para verificar o estado REAL de autenticação da sessão
 * Este script mostra se a sessão está genuinamente conectada ou se é uma "fake session"
 */

const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
const fs = require('fs');

const sessionName = process.env.WPP_SESSION || 'disparador';
const tokenPath = path.join(__dirname, 'tokens', sessionName);

console.log('🔍 Verificador de Autenticação\n');
console.log('Session:', sessionName);
console.log('Token Path:', tokenPath);
console.log('Tokens existem?', fs.existsSync(tokenPath));
console.log('');

// Se não houver tokens, força sessão nova
let finalSessionName = sessionName;
if (!fs.existsSync(tokenPath)) {
  finalSessionName = `${sessionName}-auth-${Date.now()}`;
  console.log('⚠️ Nenhuma sessão encontrada. Criando nova com timestamp...');
  console.log('Final Session Name:', finalSessionName);
  console.log('');
}

wppconnect.create({
  session: finalSessionName,
  headless: false,
  autoClose: 0,
  waitForLogin: false,
  logQR: true,
  disableWelcome: false,
  catchQR: (qrCode, asciiQR) => {
    console.log('\n' + '='.repeat(80));
    console.log('📱 QR CODE CALLBACK DISPARADO!');
    console.log('='.repeat(80));
    if (qrCode) {
      console.log('Base64 size:', qrCode.length, 'bytes');
      const cleanData = qrCode.replace(/^data:image\/png;base64,/, '');
      const QRCode = require('qrcode');
      QRCode.toString(cleanData, { type: 'terminal', width: 15 }, (err, result) => {
        if (!err && result) {
          console.log('\n' + result);
        }
      });
    }
    console.log('='.repeat(80) + '\n');
  }
}).then(async (client) => {
  console.log('\n✅ CLIENT CRIADO\n');

  // Testar múltiplas formas de verificar autenticação
  console.log('TESTANDO AUTENTICAÇÃO...\n');

  // Test 1: getProfileName()
  console.log('1️⃣ Testando client.getProfileName()...');
  try {
    const profileName = await client.getProfileName();
    console.log('   ✅ getProfileName() funcionou! Nome:', profileName);
  } catch (e) {
    console.log('   ❌ getProfileName() falhou:', e && e.message ? e.message : e);
  }

  // Test 2: listChats()
  console.log('\n2️⃣ Testando client.listChats()...');
  try {
    const chats = await client.listChats();
    console.log('   ✅ listChats() funcionou! Total de chats:', Array.isArray(chats) ? chats.length : 'desconhecido');
  } catch (e) {
    console.log('   ❌ listChats() falhou:', e && e.message ? e.message : e);
  }

  // Test 3: getAllContacts()
  console.log('\n3️⃣ Testando client.getAllContacts()...');
  try {
    const contacts = await client.getAllContacts();
    console.log('   ✅ getAllContacts() funcionou! Total de contatos:', Array.isArray(contacts) ? contacts.length : 'desconhecido');
  } catch (e) {
    console.log('   ❌ getAllContacts() falhou:', e && e.message ? e.message : e);
  }

  // Test 4: Verificar waPage
  console.log('\n4️⃣ Verificando client.waPage...');
  if (client.waPage) {
    console.log('   ✅ client.waPage existe');
    try {
      const url = client.waPage.url();
      console.log('   Página atual:', url);
    } catch (e) {
      console.log('   Erro ao obter URL:', e && e.message ? e.message : e);
    }
  } else {
    console.log('   ❌ client.waPage não existe');
  }

  console.log('\n' + '='.repeat(80));
  console.log('RESUMO');
  console.log('='.repeat(80));
  console.log('Se apenas getStatus() falhou mas getChatList() funcionou:');
  console.log('  → Existe um bug/quirk no wppconnect v1.37.5');
  console.log('');
  console.log('Se TUDO falhou:');
  console.log('  → Session é FAKE, precisa escanear QR code');
  console.log('');
  console.log('Se TUDO funcionou:');
  console.log('  → Session está GENUINAMENTE autenticada');
  console.log('='.repeat(80) + '\n');

  // Aguarda 5 segundos e encerra
  console.log('Encerrando em 5 segundos...');
  setTimeout(() => {
    process.exit(0);
  }, 5000);

}).catch(err => {
  console.error('❌ Erro ao criar client:', err && err.message ? err.message : err);
  process.exit(1);
});
