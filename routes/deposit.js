const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { deductBankDepositLimit, findVerifiedSlot, matchSlotAccount } = require('../bankLimits');

// Secret Keys per betting platform
function getPlatformSecret(platform = 'jember') {
  const p = String(platform || 'jember').toLowerCase();
  const raw = readJSON('settings.json') || {};
  if (raw.platforms && raw.platforms[p] && raw.platforms[p].jwtSecret) {
    return raw.platforms[p].jwtSecret;
  }
  if (p === 'walta') return 'd0ee8f6ffc6f56f367d9a943a076bc5996e23eea9ae7496110761a3a508fb41d';
  if (p === 'bravobirr') return '6c4cc37b91b419beba46e4d950199a02b8f99c1e4e0ace11ff01999a4dd7c6fe';
  if (p === 'abay') return '7f97e97c37042d344dd3be0371b3f490e3e7e2b5c7f226bbde726271dd9fa366';
  return process.env.JWT_SECRET || '4fec6686d2b93ceca92531ed08dbdc48cf0b937965ebbf51b144d8f055f5d004fd85c8518ef72a1d61634949884c4346';
}

// Standardized Webhook Payload Generator for ALL 3 statuses (verified, failed, expired)
function createWebhookPayload(tx, status, verifiedAmt = 0, receiptData = {}, errorMessage = null) {
  const timestamp = Date.now();
  const orderId = tx.orderId || tx.order_id || null;
  const verifiedAmount = Number(verifiedAmt) || 0;
  const platform = tx.platform || 'jember';
  const secret = getPlatformSecret(platform);
  
  const rawSigString = `${tx.id}:${orderId || ''}:${verifiedAmount}:${status}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(rawSigString).digest('hex');

  const partnerBank = (tx.originalBank && tx.originalBank.toLowerCase().includes('siinqee'))
    ? 'siinqee'
    : (tx.bank === 'ebirr' && tx.originalBank ? 'siinqee' : (tx.bank || 'telebirr'));

  return {
    status,
    sessionId: tx.id,
    userId: tx.userId,
    orderId: orderId,
    requestedAmount: tx.requestedAmount || tx.amount || 0,
    verifiedAmount: verifiedAmount,
    amount: verifiedAmount,
    bank: partnerBank,
    transactionId: tx.transactionId || null,
    phoneNumber: tx.phoneNumber || null,
    accountNumber: tx.accountNumber || tx.phoneNumber || null,
    payer: receiptData.payer || null,
    receiver: receiptData.receiver || null,
    error: errorMessage || tx.failReason || null,
    timestamp: timestamp,
    signature: signature
  };
}

// Webhook Dispatcher with Automatic 3x Retry Mechanism (5-second delay between attempts)
async function sendWebhookWithRetry(callbackUrl, payload, maxRetries = 3) {
  if (!callbackUrl) return;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CKPAY-Signature': payload.signature
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6000),
      });

      if (response.ok) {
        console.log(`Webhook delivered successfully to ${callbackUrl} (Attempt ${attempt})`);
        return true;
      } else {
        console.warn(`Webhook attempt ${attempt} failed with HTTP status ${response.status}`);
      }
    } catch (err) {
      console.error(`Webhook attempt ${attempt} error:`, err.message);
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  return false;
}

const {
  saveTx,
  getTxById,
  getTxByOrderId,
  getTxByCleanTxId,
  getActivePendingTx,
  updateTxStatus,
  expireOldPendingTxs,
  expireAllOldPendingTxs
} = require('../db');

const dataDir = path.join(__dirname, '../data');

function readJSON(file) {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
}

function normalizePhone(p) {
  if (!p) return '';
  let str = String(p).replace(/\D/g, '');
  if (str.startsWith('251')) str = '0' + str.slice(3);
  if (str.length === 9 && (str.startsWith('9') || str.startsWith('7'))) str = '0' + str;
  return str;
}

function normalizePlatform(platform) {
  if (!platform) return 'jember';
  const p = String(platform).toLowerCase().trim();
  if (p.includes('walta')) return 'walta';
  if (p.includes('bravo')) return 'bravobirr';
  if (p.includes('abay')) return 'abay';
  if (p.includes('jember')) return 'jember';
  return 'jember';
}

function detectPlatform(req, tokenPayload = {}) {
  const explicit = req.body?.platform || req.query?.platform || tokenPayload?.platform;
  if (explicit) {
    return normalizePlatform(explicit);
  }
  const returnUrl = req.body?.returnUrl || req.body?.return_url || tokenPayload?.returnUrl || tokenPayload?.return_url || '';
  const callbackUrl = req.body?.callbackUrl || req.body?.callback_url || tokenPayload?.callbackUrl || tokenPayload?.callback_url || '';
  const referer = req.headers?.['referer'] || req.headers?.['origin'] || '';
  const combined = `${returnUrl} ${callbackUrl} ${referer}`.toLowerCase();

  return normalizePlatform(combined);
}

function getPlatformSettings(platform = 'jember') {
  const p = normalizePlatform(platform);
  const raw = readJSON('settings.json') || {};
  if (raw.platforms && raw.platforms[p]) {
    return {
      ...raw.platforms[p],
      bankVerificationMethod: raw.platforms[p].bankVerificationMethod || 'copy_paste',
      bankVerificationMethods: raw.platforms[p].bankVerificationMethods || {},
      adminUsers: raw.adminUsers || [],
      whitelistedIPs: raw.whitelistedIPs || []
    };
  }
  return {
    siteName: p === 'walta' ? 'Walta Bet' : p === 'bravobirr' ? 'BravoBirr Bet' : p === 'abay' ? 'Abay Bet' : 'Jember Bet',
    minDeposit: raw.minDeposit || 100,
    maxDeposit: raw.maxDeposit || 50000,
    sessionExpiry: raw.sessionExpiry || 20,
    depositEnabled: raw.depositEnabled !== false,
    currency: raw.currency || 'ETB',
    verifyApiKey: raw.verifyApiKey || '',
    apiKeys: raw.apiKeys || ['', '', '', '', ''],
    bankVerificationMethod: 'copy_paste',
    bankVerificationMethods: {},
    adminUsers: raw.adminUsers || [],
    whitelistedIPs: raw.whitelistedIPs || []
  };
}

function getVerificationMode(platform = 'jember', bank = 'cbe') {
  const settings = getPlatformSettings(platform);
  let b = String(bank || '').toLowerCase().trim();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  if (b === 'cbe_agent') b = 'cbeagent';

  const raw = (settings.bankVerificationMethods && settings.bankVerificationMethods[b])
    || (b !== 'telebirr' ? settings.bankVerificationMethod : null)
    || 'auto';

  return raw === 'manual' ? 'manual' : 'auto';
}

function getBankVerificationMethod(platform = 'jember', bank = 'cbe') {
  const mode = getVerificationMode(platform, bank);
  let b = String(bank || '').toLowerCase().trim();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  if (b === 'cbe_agent') b = 'cbeagent';

  // Telebirr auto: strictly copy_paste; Telebirr manual: strictly screenshot
  if (b === 'telebirr') {
    return mode === 'manual' ? 'screenshot' : 'copy_paste';
  }

  // Banks: manual is strictly screenshot; auto supports both screenshot and copy_paste
  if (mode === 'manual') return 'screenshot';
  return 'both';
}

function getPlatformNumbers(platform = 'jember') {
  const p = normalizePlatform(platform);
  const raw = readJSON('numbers.json') || {};
  let list = [];
  if (raw[p] && Array.isArray(raw[p].numbers)) {
    list = raw[p].numbers;
  } else if (Array.isArray(raw.numbers) && p === 'jember') {
    list = raw.numbers;
  } else {
    list = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      phone: '',
      label: `Account ${i + 1}`,
      activeUsers: 0
    }));
  }

  // Ensure slots connected to agents reflect live shared agent limit
  const bankData = readJSON('bank_accounts.json') || {};
  if (bankData.agentLimits) {
    list.forEach(slot => {
      if (slot && slot.connectedAgent) {
        const agKey = String(slot.connectedAgent).trim().toLowerCase();
        if (bankData.agentLimits[agKey]) {
          const lim = bankData.agentLimits[agKey];
          slot.initialLimit = Number(lim.initialLimit) || 0;
          slot.remainingLimit = (lim.remainingLimit !== undefined && lim.remainingLimit !== null)
            ? Number(lim.remainingLimit)
            : Number(lim.initialLimit) || 0;
        }
      }
    });
  }

  return list;
}

function getActivePhoneNumbers(platform = 'jember') {
  const list = getPlatformNumbers(platform);
  return list.filter(n => n.active !== false && n.phone && n.phone.trim()).map(n => normalizePhone(n.phone));
}

function matchesMaskedPhone(creditedStr, activePhones) {
  if (!creditedStr || !Array.isArray(activePhones) || activePhones.length === 0) return false;
  const str = String(creditedStr).trim();
  if (!str) return false;

  // If contains letters only or no digits at all (e.g. merchant name, bank name without account), reject
  const digitsOnly = str.replace(/\D/g, '');
  if (digitsOnly.length === 0) return false;

  // Case 1: Masked phone number (e.g. '2519****7604', '0912****04', '09****2277', '2517****1234')
  if (str.includes('*')) {
    const parts = str.split(/\*+/);
    const prefixRaw = parts[0] ? parts[0].replace(/\D/g, '') : '';
    const suffix = parts[parts.length - 1] ? parts[parts.length - 1].replace(/\D/g, '') : '';

    // Telebirr masked phone must have at least 2 suffix digits (usually 4 digits, e.g. 7604)
    if (suffix.length < 2) return false;

    let prefix = '';
    if (prefixRaw.startsWith('2519') || prefixRaw === '9' || prefixRaw === '09') prefix = '09';
    else if (prefixRaw.startsWith('2517') || prefixRaw === '7' || prefixRaw === '07') prefix = '07';

    return activePhones.some(ph => {
      const normPh = normalizePhone(ph);
      if (!normPh.endsWith(suffix)) return false;
      if (prefix && !normPh.startsWith(prefix)) return false;
      return true;
    });
  }

  // Case 2: Full unmasked receiver phone (e.g. '0922319389', '251922319389', '0940072277')
  const norm = normalizePhone(str);
  // Must be a valid 10-digit Ethiopian mobile number (09xxxxxxxx or 07xxxxxxxx)
  if (!/^0[97]\d{8}$/.test(norm)) {
    // If it's a shortcode like 6464, 8989, or Siinqee bank account, REJECT!
    return false;
  }

  return activePhones.some(ph => normalizePhone(ph) === norm);
}

function getPlatformBankAccounts(platform = 'jember', bank = 'cbe') {
  const p = normalizePlatform(platform);
  let b = String(bank || 'cbe').toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  const raw = readJSON('bank_accounts.json') || {};
  const platData = raw[p] || {};

  if (b === 'ebirr') {
    const listEbirr = Array.isArray(platData.ebirr) ? platData.ebirr : [];
    const listSiinqee = Array.isArray(platData.siinqee) ? platData.siinqee : [];
    const activeE = listEbirr.filter(a => a.active !== false && a.account && a.account.trim());
    const activeS = listSiinqee.filter(a => a.active !== false && a.account && a.account.trim());
    if (activeE.length > 0 && activeS.length === 0) return listEbirr;
    if (activeS.length > 0 && activeE.length === 0) return listSiinqee;
    if (activeE.length > 0 && activeS.length > 0) return [...listEbirr, ...listSiinqee];
    return listEbirr.length > 0 ? listEbirr : listSiinqee;
  }

  if (platData[b] && Array.isArray(platData[b])) {
    return platData[b];
  }
  return [];
}

function getActiveBankAccounts(platform = 'jember', bank = 'cbe') {
  const p = normalizePlatform(platform);
  let b = String(bank || 'cbe').toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';

  const raw = readJSON('bank_accounts.json') || {};
  const platData = raw[p] || {};

  if (b === 'ebirr') {
    const listEbirr = Array.isArray(platData.ebirr) ? platData.ebirr : [];
    const listSiinqee = Array.isArray(platData.siinqee) ? platData.siinqee : [];
    const combined = [...listEbirr, ...listSiinqee];
    return Array.from(new Set(
      combined
        .filter(a => a.active !== false && a.account && a.account.trim())
        .map(a => a.account.trim())
    ));
  }

  let list = getPlatformBankAccounts(platform, bank);
  let active = list.filter(a => a.active !== false && a.account && a.account.trim()).map(a => a.account.trim());
  if ((bank === 'cbeagent' || bank === 'cbe_agent') && active.length === 0) {
    list = getPlatformBankAccounts(platform, 'cbe');
    active = list.filter(a => a.active !== false && a.account && a.account.trim()).map(a => a.account.trim());
  }
  return active;
}

function isBankEnabled(platform = 'jember', bank = 'cbe') {
  const p = normalizePlatform(platform);
  let b = String(bank || 'cbe').toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  const raw = readJSON('bank_accounts.json') || {};
  const platData = raw[p] || {};
  const status = platData.bankStatus || {};
  const bankStatusVal = (b === 'ebirr')
    ? (status.ebirr !== undefined ? status.ebirr : status.siinqee)
    : status[b];

  if (bankStatusVal === false) {
    return false;
  }
  if ((b === 'cbeagent' || b === 'cbe_agent') && status[b] === undefined) {
    if (status['cbeagent'] !== undefined) return status['cbeagent'] !== false;
    if (status['mpesa'] !== undefined) return status['mpesa'] !== false;
    if (status['cbe'] !== undefined) return status['cbe'] !== false;
  }
  const SUPPORTED_7_BANKS = ['cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
  const hasAnyExplicitTrue = SUPPORTED_7_BANKS.some(bk => {
    if (bk === 'ebirr') return status.ebirr === true || status.siinqee === true;
    return status[bk] === true;
  });
  if (hasAnyExplicitTrue) {
    if (bankStatusVal === true) return true;
    if ((b === 'cbeagent' || b === 'cbe_agent') && (status['mpesa'] === true || status['cbe'] === true)) return true;
    return false;
  }
  return true;
}

function matchesMaskedAccount(creditedStr, activeAccounts) {
  if (!creditedStr || !Array.isArray(activeAccounts) || activeAccounts.length === 0) return false;
  const str = String(creditedStr).trim();
  if (!str) return false;
  const digitsOnly = str.replace(/\D/g, '');
  if (digitsOnly.length === 0) return false;

  if (str.includes('*')) {
    const parts = str.split(/\*+/);
    const prefix = parts[0] ? parts[0].replace(/\D/g, '') : '';
    const suffix = parts[parts.length - 1] ? parts[parts.length - 1].replace(/\D/g, '') : '';

    // Bank masked receipts ALWAYS have at least 3 suffix digits (e.g. 1********9504, 1****9504).
    // If suffix is missing or fewer than 3 digits, it cannot be safely verified -> reject.
    if (suffix.length < 3) return false;

    return activeAccounts.some(acc => {
      const cleanAcc = String(acc).replace(/\D/g, '');
      if (prefix && !cleanAcc.startsWith(prefix)) return false;
      if (!cleanAcc.endsWith(suffix)) return false;
      return true;
    });
  }

  // Exact unmasked account or normalized phone match
  return activeAccounts.some(acc => {
    const cleanAcc = String(acc).replace(/\D/g, '');
    if (cleanAcc === digitsOnly) return true;
    const p1 = normalizePhone(acc);
    const p2 = normalizePhone(str);
    if (p1 && p2 && p1 === p2) return true;
    return false;
  });
}

function extractTransactionId(text) {
  if (!text) return null;
  const str = String(text).trim();
  if (!str) return null;

  // 1. Direct single token (if user pasted only the code or only the URL)
  if (!/\s/.test(str)) {
    // If it is a CBE Birr / Bank URL with query param ?TID=...
    const directQueryMatch = str.match(/[?&](?:TID|tid|id|txn|ref)=([A-Za-z0-9_-]{8,50})/i);
    if (directQueryMatch && directQueryMatch[1]) return directQueryMatch[1].trim().toUpperCase();

    // If it is a CBE / Bank receipt URL pasted directly (ignore words like aureceipt, receipt, invoice)
    const directUrlMatch = str.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:cbe\.com\.et|telebirr\.et|boa\.et|awashbank\.com|dashenbank\.com|ebirr\.com)[^\s]*\/(?!aureceipt|receipt|invoice|feedback)([A-Za-z0-9_-]{8,50})/i);
    if (directUrlMatch && directUrlMatch[1]) return directUrlMatch[1].trim();

    const directEbirrMatch = str.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*ebirr\.com\/[^\s]*\/([A-Za-z0-9_-]{8,50})/i);
    if (directEbirrMatch && directEbirrMatch[1]) return directEbirrMatch[1].trim();

    // Direct v2- or receipt hash code (e.g. v2-hfHCxFSmqtLtX7liH8Qm)
    if (/^v2-[A-Za-z0-9_-]{8,40}$/i.test(str)) return str;

    // Direct alphanumeric code (Telebirr, CBE FT, BoA, eBirr token, etc.)
    if (/^[A-Za-z0-9_-]{8,35}$/.test(str)) {
      if (str.startsWith('v2-')) return str;
      if (str.length >= 16 && /[a-z]/.test(str) && /[A-Z]/.test(str)) return str;
      return str.toUpperCase();
    }
  }

  // 1b. Direct eBirr Receipt Link in full text (e.g. receipt.ebirr.com/kaafimf/AmCD20Etm1dNXaDB3_LG4A)
  const matchEbirrUrl = str.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*ebirr\.com\/[^\s]*\/([A-Za-z0-9_-]{8,50})/i);
  if (matchEbirrUrl && matchEbirrUrl[1]) {
    return matchEbirrUrl[1].trim();
  }

  // 2. Multilingual keywords for Ethiopian Languages & English (Txn ID, Transaction ID, Ref, etc.)
  const matchKeyword = str.match(
    /(?:transaction\s+(?:number\s+is|id|number|no|code)|txn\s*id|txn|txid|\bId\b|ref(?:erence)?(?:\s*no\.?|\s*number|\s*id)?|receipt(?:\s*no\.?|\s*number|\s*id)?|reciept(?:\s*no\.?|\s*number|\s*id)?|የግብይት\s*(?:ቁጥር(?:ዎ)?|መለያ)?|መለያ\s*ቁጥር|የደረሰኝ\s*ቁጥር|lakk(?:oofsa)?\.?\s*(?:daldala(?:a| keessanii)?|dabarsaa|nagahee|ajajaa)?|ቁጽሪ\s*(?:ንግዲ(?:ኹም)?|ትራንዛክሽን|ደረሰኝ)?|lambarka\s*(?:macaamilka|rasiidka|tixraaca)?)\s*[:፡=]?\s*([A-Za-z0-9_-]{8,40})/iu
  );
  if (matchKeyword && matchKeyword[1]) {
    const val = matchKeyword[1].trim();
    if (val.startsWith('v2-')) return val;
    if (val.length >= 16 && /[a-z]/.test(val) && /[A-Z]/.test(val)) return val;
    return val.toUpperCase();
  }

  // 3. CBE Birr / Bank URL with query param ?TID=... (e.g. cbepay1.cbe.com.et/aureceipt?TID=DJI21S46O36&PH=...)
  const matchQueryTid = str.match(/[?&](?:TID|tid|id|txn|ref)=([A-Za-z0-9_-]{8,40})/i);
  if (matchQueryTid && matchQueryTid[1]) {
    return matchQueryTid[1].trim().toUpperCase();
  }

  // 4. CBE Receipt Link path token (e.g. cbe.com.et/v2-...) - ignoring known path words like aureceipt, receipt, invoice
  const matchCbeUrl = str.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*cbe\.com\.et\/(?!aureceipt|receipt|invoice|feedback)([A-Za-z0-9_-]{8,50})/i) ||
                      str.match(/https?:\/\/[^\s]*mbrec[ie]{2}pt[^\s]*\/([A-Za-z0-9_-]{8,50})/i);
  if (matchCbeUrl && matchCbeUrl[1]) {
    return matchCbeUrl[1].trim(); // Must preserve exact case for CBE receipt URL tokens!
  }

  // 5. Generic receipt URL format: receipt/DHH3VDJ5SH or reciept/DHH3VDJ5SH
  const matchReceipt = str.match(/rec[ie]{2}pt[/?=]([A-Za-z0-9_-]{8,40})/i);
  if (matchReceipt && matchReceipt[1]) {
    const val = matchReceipt[1].trim();
    return val.startsWith('v2-') ? val : val.toUpperCase();
  }

  // 6. CBE Reference Number pattern (starts with FT followed by alphanumeric)
  const matchCbeCode = str.match(/\b(FT[A-Za-z0-9]{8,18})\b/i);
  if (matchCbeCode && matchCbeCode[1]) return matchCbeCode[1].trim().toUpperCase();

  // 7. Telebirr / CBE Birr code (starts with D followed by 9-13 alphanumeric characters)
  const matchDCode = str.match(/\b(D[A-Za-z0-9]{9,13})\b/i);
  if (matchDCode && matchDCode[1]) return matchDCode[1].trim().toUpperCase();

  // 8. Standalone v2- receipt code anywhere in text
  const matchV2Code = str.match(/\b(v2-[A-Za-z0-9_-]{8,40})\b/i);
  if (matchV2Code && matchV2Code[1]) return matchV2Code[1].trim();

  // 9. Bank prefixes: BOA, AW, AT, DA, DB
  const matchBankPrefix = str.match(/\b((?:BOA|AW|AT|DA|DB)[A-Za-z0-9]{6,18})\b/i);
  if (matchBankPrefix && matchBankPrefix[1]) return matchBankPrefix[1].trim().toUpperCase();

  // 9. Blacklist check before generic word fallbacks (prevent common words like RECOVERY5, SERVICE, VAT, etc.)
  const BLACKLIST = new Set([
    'DISASTER', 'RECOVERY', 'RECOVERY5', 'SERVICE', 'CHARGE', 'BALANCE',
    'ACCOUNT', 'COMMISSION', 'TOTAL', 'SUCCESSFULLY', 'TRANSFERRED',
    'BANKING', 'FEEDBACK', 'CURRENT', 'DEPOSIT', 'PAYMENT', 'BANK',
    'THANKS', 'COMMERCIAL', 'ETHIOPIA', 'ETB', 'USD', 'EURO', 'GOOGLE', 'FORMS'
  ]);

  // Delimiters include parentheses and punctuation so "Recovery(5%)" doesn't become "Recovery5"
  const words = str.split(/[\s,;:፡.\r\n\t()[\]{}'"\\%]+/);
  for (const w of words) {
    if (/https?|forms\.gle|cbe\.com/i.test(w)) continue;
    const clean = w.replace(/[^A-Za-z0-9_-]/g, '');
    if (BLACKLIST.has(clean.toUpperCase())) continue;
    if (clean.length >= 8 && clean.length <= 25 && /[A-Za-z]/.test(clean) && /[0-9]/.test(clean)) {
      if (clean.startsWith('v2-')) return clean;
      if (clean.length >= 16 && /[a-z]/.test(clean) && /[A-Z]/.test(clean)) return clean;
      return clean.toUpperCase();
    }
  }

  return null;
}

function getActiveAssignments(assignmentsData) {
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(assignmentsData).filter(([_, a]) => now - a.assignedAt < limit)
  );
}

function pickPhoneNumber(numbers, activeAssignments, userHistory = []) {
  const available = numbers.filter(n => n.active !== false && n.phone && n.phone.trim());
  if (available.length === 0) return numbers[0]?.phone || '';

  // Filter out any numbers already assigned to this user in the current 10-day cycle
  let candidates = available.filter(n => !userHistory.includes(n.phone));

  // If all numbers in pool have been used in cycle, start fresh cycle excluding only the last used number
  if (candidates.length === 0) {
    const lastPhone = userHistory[userHistory.length - 1];
    candidates = available.filter(n => n.phone !== lastPhone);
    if (candidates.length === 0) {
      candidates = available;
    }
  }

  // Count active load per candidate across all active users
  const counts = {};
  candidates.forEach(n => (counts[n.phone] = 0));
  Object.values(activeAssignments).forEach(a => {
    if (counts[a.phone] !== undefined) counts[a.phone]++;
  });

  const minCount = Math.min(...Object.values(counts));
  const minCandidates = candidates.filter(n => counts[n.phone] === minCount);

  const randomIndex = Math.floor(Math.random() * minCandidates.length);
  return minCandidates[randomIndex].phone;
}

router.post('/test-callback', (req, res) => {
  const orderId = (req.body.orderId || req.body.order_id || req.body.sessionId || req.body.id || '56031b32-a1c8-4fce-93bd-92213c6e14d5').toString().trim();
  const status = (req.body.status || 'verified').toLowerCase();
  
  // Case-insensitive lookup by orderId or sessionId
  const foundTx = orderId ? (getTxByOrderId(orderId) || getTxById(orderId)) : null;
  
  // Real requested amount: prioritize the existing transaction from SQLite
  const requestedAmt = Number(
    (foundTx && (foundTx.requestedAmount || foundTx.amount)) ||
    req.body.requestedAmount ||
    req.body.requested_amount ||
    req.body.amount ||
    100
  );

  // If verified, verifiedAmount is paid amount; for rejected/failed/expired, it is 0
  const verifiedAmt = status === 'verified'
    ? Number(req.body.verifiedAmount || req.body.amount || foundTx?.verifiedAmount || requestedAmt)
    : 0;

  const callbackUrl = req.body.callbackUrl || req.body.callback_url || foundTx?.callbackUrl || 'https://cbtestpayment.testenvh.com/CKPay/process';
  const userId = req.body.userId || req.body.user_id || foundTx?.userId || 'TEST_USER_9921';
  const sessionId = foundTx?.id || (req.body.sessionId ? String(req.body.sessionId).trim() : orderId) || uuidv4();
  const phoneNumber = foundTx?.phoneNumber || req.body.phoneNumber || '0911223344';
  const bank = foundTx?.bank || req.body.bank || 'telebirr';
  const platform = foundTx?.platform || req.body.platform || 'jember';
  const accountNumber = foundTx?.accountNumber || req.body.accountNumber || (bank !== 'telebirr' ? phoneNumber : null);

  // If transaction exists in DB, update its status
  if (foundTx) {
    updateTxStatus(foundTx.id, status, {
      transactionId: status === 'verified' ? (foundTx.transactionId || 'DES' + Math.floor(Math.random() * 900000 + 100000)) : foundTx.transactionId,
      failReason: status === 'verified' ? null : (req.body.reason || req.body.error || 'Transaction rejected'),
    });
  }

  const txObj = {
    id: sessionId,
    userId: userId,
    orderId: foundTx?.orderId || orderId,
    requestedAmount: requestedAmt,
    amount: requestedAmt,
    platform: platform,
    bank: bank,
    phoneNumber: phoneNumber,
    accountNumber: accountNumber,
    transactionId: status === 'verified' ? (foundTx?.transactionId || 'DES' + Math.floor(Math.random() * 900000 + 100000)) : null,
    failReason: status === 'verified' ? null : (req.body.reason || req.body.error || null)
  };

  const payload = createWebhookPayload(txObj, status, verifiedAmt, {}, req.body.reason || req.body.error || null);
  sendWebhookWithRetry(callbackUrl, payload);

  res.json({
    success: true,
    message: `Test callback sent to ${callbackUrl}`,
    payload
  });
});

// Explicit rejection endpoint preserving true requestedAmount
router.post('/reject', (req, res) => {
  const orderId = (req.body.orderId || req.body.order_id || req.body.sessionId || req.body.id || '').toString().trim();
  const reason = req.body.reason || req.body.error || 'Transaction rejected';

  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId or sessionId' });
  }

  const foundTx = getTxByOrderId(orderId) || getTxById(orderId);
  if (!foundTx) {
    return res.status(404).json({ error: `Transaction ${orderId} not found` });
  }

  const updatedTx = updateTxStatus(foundTx.id, 'rejected', {
    failReason: reason
  });

  const callbackUrl = req.body.callbackUrl || req.body.callback_url || updatedTx.callbackUrl || 'https://cbtestpayment.testenvh.com/CKPay/process';
  const payload = createWebhookPayload(updatedTx, 'rejected', 0, {}, reason);
  sendWebhookWithRetry(callbackUrl, payload);

  res.json({
    success: true,
    message: `Transaction ${orderId} marked rejected and webhook dispatched`,
    payload
  });
});

router.get('/active-banks', (req, res) => {
  const platform = req.query.platform || detectPlatform(req) || 'jember';
  const p = normalizePlatform(platform);
  const raw = readJSON('bank_accounts.json') || {};
  const platData = raw[p] || {};
  const status = platData.bankStatus || {};

  const SUPPORTED_7_BANKS = ['cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];

  const hasAnyExplicitTrue = SUPPORTED_7_BANKS.some(b => {
    if (b === 'ebirr') return status.ebirr === true || status.siinqee === true;
    return status[b] === true || (b === 'cbeagent' && (status['mpesa'] === true || status['cbe'] === true));
  });
  const hasAnyConfiguredAccounts = SUPPORTED_7_BANKS.some(b => {
    let accs = Array.isArray(platData[b]) ? platData[b] : [];
    if (b === 'cbeagent' && !accs.some(a => a && a.active !== false && String(a.account || '').trim() !== '')) {
      accs = Array.isArray(platData['cbe']) ? platData['cbe'] : [];
    }
    return accs.some(a => a && a.active !== false && String(a.account || '').trim() !== '');
  });

  const activeBanks = SUPPORTED_7_BANKS.filter(b => {
    // If explicitly disabled in admin bankStatus, exclude
    const bStatus = (b === 'ebirr') ? (status.ebirr !== undefined ? status.ebirr : status.siinqee) : status[b];
    if (bStatus === false) return false;
    if (b === 'cbeagent' && status['cbeagent'] === undefined) {
      if (status['mpesa'] === false || status['cbe'] === false) return false;
    }

    // If admin explicitly set some bank(s) to true, ONLY include banks where status[b] === true
    if (hasAnyExplicitTrue) {
      if (b === 'ebirr') {
        if (status.ebirr !== true && status.siinqee !== true) return false;
      } else if (status[b] !== true && !(b === 'cbeagent' && (status['mpesa'] === true || status['cbe'] === true))) {
        return false;
      }
    }

    // Strict check: only include banks that have at least one active configured account
    const configuredActive = getActiveBankAccounts(p, b);
    if (configuredActive.length === 0) return false;

    // Check account limit quotas:
    // - Accounts with NO limit set: always available.
    // - Accounts WITH a limit (connected or not): available only while remaining > 0.
    let accs = Array.isArray(platData[b]) ? platData[b] : [];
    if (b === 'cbeagent' && !accs.some(a => a && a.active !== false && String(a.account || '').trim() !== '')) {
      accs = Array.isArray(platData['cbe']) ? platData['cbe'] : [];
    } else if (b === 'ebirr') {
      const eAccs = Array.isArray(platData['ebirr']) ? platData['ebirr'] : [];
      const sAccs = Array.isArray(platData['siinqee']) ? platData['siinqee'] : [];
      accs = [...eAccs, ...sAccs];
    }

    const hasAvailable = accs.some(a => {
      if (!a || a.active === false || String(a.account || '').trim() === '') return false;
      const hasLimit = (a.remainingLimit !== undefined && a.remainingLimit !== null) ||
                       (a.initialLimit !== undefined && a.initialLimit !== null);
      if (!hasLimit) return true; // No limit set -> always available
      const rem = Number(a.remainingLimit !== undefined && a.remainingLimit !== null ? a.remainingLimit : (a.initialLimit || 0));
      return rem > 0; // Has a limit -> only available while remaining > 0
    });
    return hasAvailable;
  });

  const settings = getPlatformSettings(p);

  const enrichedStatus = { ...status };
  if (enrichedStatus.ebirr === undefined && enrichedStatus.siinqee !== undefined) {
    enrichedStatus.ebirr = enrichedStatus.siinqee;
  }
  if (enrichedStatus.siinqee === undefined && enrichedStatus.ebirr !== undefined) {
    enrichedStatus.siinqee = enrichedStatus.ebirr;
  }
  if (enrichedStatus.cbeagent === undefined) {
    enrichedStatus.cbeagent = enrichedStatus.mpesa !== undefined ? enrichedStatus.mpesa : (enrichedStatus.cbe !== undefined ? enrichedStatus.cbe : true);
  }

  const verificationModes = {};
  SUPPORTED_7_BANKS.concat(['telebirr']).forEach(b => {
    verificationModes[b] = getVerificationMode(p, b);
  });

  res.json({
    platform: p,
    activeBanks,
    status: enrichedStatus,
    bankVerificationMethod: settings.bankVerificationMethod || 'copy_paste',
    bankVerificationMethods: settings.bankVerificationMethods || {},
    verificationModes
  });
});

router.post('/init', (req, res) => {
  let tokenPayload = {};
  let detectedPlatformFromToken = null;
  const rawToken = req.body.token || req.headers['x-ckpay-token'] || null;

  if (rawToken) {
    // Check against each platform secret (jember, bravobirr, abay, walta)
    for (const plat of ['jember', 'bravobirr', 'abay', 'walta']) {
      try {
        const sec = getPlatformSecret(plat);
        tokenPayload = jwt.verify(rawToken, sec);
        detectedPlatformFromToken = plat;
        break;
      } catch {}
    }

    if (!detectedPlatformFromToken) {
      try { tokenPayload = jwt.decode(rawToken) || {}; } catch {}
      return res.status(401).json({ error: 'Invalid or expired payment token. Please start a new deposit session.' });
    }
  }

  const platform = detectedPlatformFromToken || detectPlatform(req, tokenPayload);
  const settings = getPlatformSettings(platform);

  // Support both CK-PAY and standard parameter names across body, token, and query
  const userId = req.body.userId || req.body.account_id || req.body.client_id || tokenPayload.userId || tokenPayload.account_id || tokenPayload.id || req.query.userId || req.query.account_id || req.query.client_id;
  const amount = req.body.amount || tokenPayload.amount || req.query.amount;
  const orderId = req.body.orderId || req.body.order_id || req.body.merchant_order_id || req.body.merchantOrderId || tokenPayload.order_id || tokenPayload.orderId || tokenPayload.merchant_order_id || req.query.orderId || req.query.order_id || null;
  const returnUrl = req.body.returnUrl || req.body.return_url || req.body.success_url || tokenPayload.returnUrl || tokenPayload.return_url || req.query.returnUrl || req.query.return_url || null;
  const callbackUrl = req.body.callbackUrl || req.body.callback_url || req.body.postback_url || tokenPayload.callbackUrl || tokenPayload.callback_url || req.query.callbackUrl || req.query.callback_url || null;
  const forceNew = req.body.forceNew || req.query.forceNew;

  if (!userId || !amount) {
    return res.status(400).json({ error: 'Missing userId (or account_id) or amount' });
  }

  if (!settings.depositEnabled) {
    return res.status(403).json({ error: `Deposits are currently disabled for ${settings.siteName}` });
  }

  const amt = Number(amount);
  if (amt < settings.minDeposit || amt > settings.maxDeposit) {
    return res.status(400).json({ error: `Amount must be between ${settings.minDeposit} and ${settings.maxDeposit} ETB` });
  }

  const referer = String(req.headers.referer || req.headers.referrer || '').toLowerCase();
  const isRefererTelebirr = (referer.includes('/pay/am') || referer.includes('/deposit')) && !referer.includes('/pay/banks') && !referer.includes('/deposit/banks') && !referer.includes('mode=banks');
  const tokenOrQueryBank = tokenPayload.bank || req.query.bank;

  let explicitBank = req.body.bank || tokenOrQueryBank || 'telebirr';
  // If the user opened the Telebirr checkout route (/pay/am or /deposit) and neither the token nor query specified a bank,
  // do not allow a stale localStorage 'cbe' from req.body to override it
  if (isRefererTelebirr && !tokenOrQueryBank && explicitBank !== 'telebirr') {
    explicitBank = 'telebirr';
  }

  // Safety fallback: if a bank is disabled for this platform, but neither the token nor query requested that bank
  // (e.g. came from an old mobile browser cache), gracefully fallback to 'telebirr' instead of failing with an error.
  if (explicitBank !== 'telebirr' && !tokenOrQueryBank && !isBankEnabled(platform, explicitBank)) {
    explicitBank = 'telebirr';
  }

  const rawBankCandidate = String(explicitBank).toLowerCase();
  const isSiinqeePartner = ['siinqee', 'sinqee'].some(function(x) { return rawBankCandidate.includes(x); });
  const bank = isSiinqeePartner ? 'ebirr' : rawBankCandidate;

  let assignedPhone = '';
  let assignedAccount = '';
  let assignedAgent = null;

  if (bank === 'telebirr') {
    const numbers = getPlatformNumbers(platform);
    const activeNumberList = numbers.filter(n => n.phone && n.phone.trim() && n.active !== false);
    if (activeNumberList.length === 0) {
      return res.status(500).json({ error: `No active phone numbers configured for ${settings.siteName}` });
    }

    // Candidate Accounts: filter by available limit quota
    const candidateNumberList = activeNumberList.filter(n => {
      const hasLimit = (n.remainingLimit !== undefined && n.remainingLimit !== null) ||
                       (n.initialLimit !== undefined && n.initialLimit !== null);
      if (!hasLimit) {
        return true; // No limit set -> always available
      }
      const remaining = Number(n.remainingLimit !== undefined && n.remainingLimit !== null ? n.remainingLimit : (n.initialLimit || 0));
      return remaining >= amt; // Has a limit -> stop when it runs out
    });

    if (candidateNumberList.length === 0) {
      return res.status(400).json({
        error: `Deposit limit reached for Telebirr accounts (Requested ${amt} ETB exceeds available limit). Please try a smaller amount or choose another bank.`
      });
    }

    let assignmentsData = readJSON('assignments.json') || {};
    const activeAssignments = getActiveAssignments(assignmentsData);
    const now = Date.now();
    const userKey = `${platform}:${userId}`;

    // Assign a rotated phone number from this platform's dedicated pool
    const userRecord = assignmentsData[userKey] || {};
    let history = Array.isArray(userRecord.history) ? [...userRecord.history] : [];
    if (userRecord.phone && !history.includes(userRecord.phone)) {
      history.push(userRecord.phone);
    }

    if (history.length >= candidateNumberList.length) {
      const lastPhone = history[history.length - 1];
      history = lastPhone ? [lastPhone] : [];
    }

    assignedPhone = pickPhoneNumber(candidateNumberList, activeAssignments, history);
    history.push(assignedPhone);

    const chosenSlot = candidateNumberList.find(n => normalizePhone(n.phone) === normalizePhone(assignedPhone)) || candidateNumberList[0];
    assignedAgent = chosenSlot ? (chosenSlot.connectedAgent || null) : null;

    assignmentsData[userKey] = {
      phone: assignedPhone,
      platform: platform,
      assignedAt: now,
      history: history
    };

    const pruneLimit = 48 * 60 * 60 * 1000;
    const prunedAssignments = {};
    for (const [k, v] of Object.entries(assignmentsData)) {
      if (now - (v.assignedAt || 0) < pruneLimit) {
        prunedAssignments[k] = v;
      }
    }
    writeJSON('assignments.json', prunedAssignments);
  } else {
    // Non-telebirr bank: check if enabled
    if (!isBankEnabled(platform, bank)) {
      return res.status(400).json({ error: `${bank.toUpperCase()} is currently disabled for ${settings.siteName}. Please choose another bank.` });
    }
    let bankAccounts = getPlatformBankAccounts(platform, bank);
    let activeBankList = bankAccounts.filter(a => a.account && a.account.trim() && a.active !== false);
    if ((bank === 'cbeagent' || bank === 'cbe_agent') && activeBankList.length === 0) {
      bankAccounts = getPlatformBankAccounts(platform, 'cbe');
      activeBankList = bankAccounts.filter(a => a.account && a.account.trim() && a.active !== false);
    }
    if (activeBankList.length === 0) {
      return res.status(500).json({ error: `No active ${bank.toUpperCase()} accounts configured for ${settings.siteName}` });
    }

    // Candidate Accounts:
    // 1. Non-connected accounts with NO limit set (remainingLimit null, initialLimit null) -> Available always.
    // 2. Any account (connected OR non-connected) WITH a set limit follows strict quota:
    //    - Works only while remaining >= requested amount.
    //    - STOPS being available once the limit is finished (remaining < amt).
    const candidateAccounts = activeBankList.filter(a => {
      const hasLimit = (a.remainingLimit !== undefined && a.remainingLimit !== null) ||
                       (a.initialLimit !== undefined && a.initialLimit !== null);
      if (!hasLimit) {
        return true; // No limit set -> always available
      }
      const remaining = Number(a.remainingLimit !== undefined && a.remainingLimit !== null ? a.remainingLimit : (a.initialLimit || 0));
      return remaining >= amt; // Has a limit -> stop when it runs out
    });

    if (candidateAccounts.length === 0) {
      return res.status(400).json({
        error: `Deposit limit reached for ${bank.toUpperCase()} accounts (Requested ${amt} ETB exceeds available limit). Please try a smaller amount or choose another bank.`
      });
    }

    const randomIdx = Math.floor(Math.random() * candidateAccounts.length);
    const chosenSlot = candidateAccounts[randomIdx];
    assignedAccount = chosenSlot.account.trim();
    assignedAgent = chosenSlot.connectedAgent || null;
  }

  // Re-use active pending session ONLY for browser reloads (no token, same amount & orderId)
  if (!forceNew && rawToken) {
    expireOldPendingTxs(userId, platform);
  } else if (!forceNew && !rawToken) {
    const activeSession = getActivePendingTx(userId, platform, amt);
    if (activeSession) {
      return res.json({
        sessionId: activeSession.id,
        platform: platform,
        bank: activeSession.bank || bank || 'telebirr',
        phoneNumber: activeSession.phoneNumber,
        accountNumber: activeSession.accountNumber || activeSession.phoneNumber,
        amount: activeSession.amount,
        requestedAmount: activeSession.requestedAmount || activeSession.amount,
        bankVerificationMethod: getBankVerificationMethod(platform, activeSession.bank || bank),
        verificationMode: getVerificationMode(platform, activeSession.bank || bank),
        expiresAt: activeSession.expiresAt,
        sessionExpiry: settings.sessionExpiry,
        currency: settings.currency,
        minDeposit: settings.minDeposit,
        maxDeposit: settings.maxDeposit,
        returnUrl: activeSession.returnUrl || null,
        callbackUrl: activeSession.callbackUrl || null,
      });
    }
  }

  // Mark any old pending sessions as expired for this platform:user in SQLite
  expireOldPendingTxs(userId, platform);

  const sessionId = uuidv4();
  const now = Date.now();
  const expiresAt = now + settings.sessionExpiry * 60 * 1000;

  const newTxObj = {
    id: sessionId,
    orderId: orderId || null,
    userId: String(userId),
    platform: platform,
    bank: bank,
    originalBank: isSiinqeePartner ? 'siinqee' : bank,
    requestedAmount: amt,
    amount: amt,
    phoneNumber: bank === 'telebirr' ? assignedPhone : assignedAccount,
    accountNumber: bank === 'telebirr' ? null : assignedAccount,
    assignedAgent: assignedAgent || null,
    status: 'pending',
    createdAt: now,
    expiresAt,
    transactionId: null,
    submittedAt: null,
    returnUrl: returnUrl || null,
    callbackUrl: callbackUrl || null,
  };
  saveTx(newTxObj);

  res.json({
    sessionId,
    platform,
    bank: isSiinqeePartner ? 'siinqee' : bank,
    orderId: orderId || null,
    phoneNumber: newTxObj.phoneNumber,
    accountNumber: newTxObj.accountNumber || newTxObj.phoneNumber,
    amount: amt,
    requestedAmount: amt,
    bankVerificationMethod: getBankVerificationMethod(platform, bank),
    verificationMode: getVerificationMode(platform, bank),
    expiresAt,
    sessionExpiry: settings.sessionExpiry,
    currency: settings.currency,
    minDeposit: settings.minDeposit,
    maxDeposit: settings.maxDeposit,
    returnUrl: returnUrl || null,
    callbackUrl: callbackUrl || null,
  });
});

function getApiKeyForPhone(phoneNumber, settings, platform = 'jember') {
  const numbers = getPlatformNumbers(platform);
  const normTarget = normalizePhone(phoneNumber);
  let phoneIndex = numbers.findIndex(n => normalizePhone(n.phone) === normTarget);
  if (phoneIndex === -1) phoneIndex = 0;

  // 20 phone numbers mapped to 5 API keys (4 numbers per key)
  const keyIndex = Math.floor(phoneIndex / 4);
  const keys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];
  let selectedKey = keys[keyIndex];
  // Fallback if specific slot key is blank
  if (!selectedKey) {
    selectedKey = keys.find(k => k && k.trim()) || settings.verifyApiKey || '';
  }

  return selectedKey;
}

async function pollVerifyEtStatus(apiKey, requestId) {
  const statusUrl = `https://verify.et/api/verify/${requestId}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      const res = await fetch(statusUrl, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.json();
      const rawItem = body.data || {};
      const resObj = rawItem.result || rawItem;
      const status = rawItem.processingStatus || rawItem.status || resObj.status;
      const isVerified = rawItem.verified === true || resObj.verified === true || status === 'completed' || status === 'success';

      if (isVerified && (resObj.amount || resObj.receiverAccount || rawItem.result)) {
        const receiverAcc = resObj.receiverAccount || resObj.bankSpecific?.receiverAccount || resObj.creditedPartyAccountNo || rawItem.receiverAccount || '';
        const amt = resObj.amount !== undefined ? resObj.amount : (resObj.amountValue !== undefined ? resObj.amountValue : (rawItem.amount || '0'));
        const sender = resObj.senderName || resObj.payerName || rawItem.senderName || 'Telebirr Customer';
        const receiver = resObj.receiverName || resObj.creditedPartyName || rawItem.receiverName || 'Merchant';
        const txNum = resObj.transactionNumber || resObj.referenceNumber || resObj.receiptNumber || rawItem.transactionNumber || requestId;

        return {
          success: true,
          message: 'Transaction verified successfully.',
          receipt: {
            transactionId: txNum,
            status: 'VERIFIED',
            payer: sender,
            receiver: receiver,
            amount: String(amt),
            date: resObj.timestamp || rawItem.completedAt || new Date().toISOString(),
            creditedAccount: receiverAcc,
          }
        };
      }
      if (status === 'failed' || resObj.status === 'failed') {
        return {
          success: false,
          message: resObj.message || body.message || 'Transaction verification failed on verify.et.'
        };
      }
    } catch {}
  }
  return {
    success: false,
    message: 'Verification request timed out. Please try again.'
  };
}

async function verifyEbirrReceiptFromUrl(receiptUrlOrToken, platform = 'jember') {
  try {
    let fullUrl = String(receiptUrlOrToken || '').trim();
    if (!fullUrl.startsWith('http')) {
      fullUrl = `https://receipt.ebirr.com/kaafimf/${fullUrl}`;
    }
    const res = await fetch(fullUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const receiptNo = (html.match(/RECEIPT\s*NO:<\/td>\s*<td[^>]*>\s*([A-Za-z0-9_-]+)/i) || html.match(/Receipt\s*No\.?[^0-9]*([0-9]{8,20})/i) || [])[1];
    const amtMatch = (html.match(/AMOUNT:<\/td>[\s\S]*?<strong>\s*([0-9.]+)\s*<\/strong>/i) || html.match(/Settled\s*Amount[^0-9]*([0-9.]+)/i) || [])[1];
    const receiverPhone = (html.match(/Receiver Account\/Mobile[\s\S]*?<td[^>]*>\s*([0-9]+)/i) || html.match(/Receiver\s*(?:Account\/Mobile)?[^0-9]*([0-9]{9,13})/i) || [])[1];
    const receiverName = (html.match(/Receiver name[\s\S]*?<td[^>]*>\s*([^<]+)/i) || [])[1]?.trim();
    const senderName = (html.match(/Sender Name[\s\S]*?<td[^>]*>\s*([^<]+)/i) || [])[1]?.trim();
    const dateMatch = (html.match(/DATE:<\/td>\s*<td[^>]*>\s*([^<]+)/i) || [])[1]?.trim();

    if (receiptNo && amtMatch) {
      const parsedAmt = parseFloat(amtMatch);
      const activeAccounts = getActiveBankAccounts(platform, 'ebirr');
      if (!activeAccounts || activeAccounts.length === 0) {
        return {
          success: false,
          message: 'No active eBirr/Siinqee accounts configured for this platform. Please contact support.',
          code: 'NO_ACTIVE_ACCOUNTS'
        };
      }

      const cleanReceiver = (receiverPhone || '').replace(/\D/g, '');
      if (!cleanReceiver || cleanReceiver.length < 8) {
        return {
          success: false,
          message: 'Could not extract valid recipient account from eBirr receipt.',
          code: 'RECEIVER_NOT_FOUND'
        };
      }

      const matchedAccount = activeAccounts.find(acc => {
        const cleanAcc = acc.replace(/\D/g, '');
        const normAcc = normalizePhone(acc);
        const normRec = normalizePhone(cleanReceiver);
        if (normAcc && normRec && normAcc === normRec) return true;
        if (cleanAcc === cleanReceiver) return true;
        if (cleanReceiver.length >= 9 && cleanAcc.endsWith(cleanReceiver.slice(-9))) return true;
        if (cleanAcc.length >= 9 && cleanReceiver.endsWith(cleanAcc.slice(-9))) return true;
        return false;
      });

      if (!matchedAccount) {
        return {
          success: false,
          message: 'Receipt was not sent to an active eBirr account for this platform.',
          code: 'ACCOUNT_MISMATCH'
        };
      }

      return {
        success: true,
        settlementMatch: true,
        matchedAccount: matchedAccount,
        receipt: {
          transactionId: receiptNo,
          receiptNumber: receiptNo,
          amount: parsedAmt,
          creditedAccount: matchedAccount,
          payer: senderName || '',
          senderName: senderName || '',
          receiver: receiverName || receiverPhone || matchedAccount,
          date: dateMatch || new Date().toISOString()
        }
      };
    }
  } catch (err) {
    console.warn('[eBirr Receipt Scraper] Error fetching:', err.message);
  }
  return null;
}

async function verifyWithVerifyEt(apiKey, transactionId, bank = 'telebirr', receivingAccount = '') {
  try {
    const b = String(bank || 'telebirr').toLowerCase();
    const cleanTx = String(transactionId).trim();

    let requestBody = {};
    if (b === 'cbe' || b === 'cbeagent' || b === 'cbe_agent') {
      const suffix = (receivingAccount || '').replace(/\D/g, '').slice(-8);
      requestBody = {
        bank: 'cbe',
        referenceNumber: cleanTx,
        accountSuffix: suffix,
        settlementAccount: receivingAccount || undefined,
      };
    } else if (b === 'boa') {
      const suffix = (receivingAccount || '').replace(/\D/g, '').slice(-5);
      requestBody = {
        bank: 'boa',
        referenceNumber: cleanTx,
        accountSuffix: suffix,
        settlementAccount: receivingAccount || undefined,
      };
    } else if (b === 'cbebirr') {
      requestBody = {
        bank: 'cbebirr',
        receiptNumber: cleanTx,
        phone: receivingAccount || undefined,
        settlementAccount: receivingAccount || undefined,
      };
    } else if (b === 'mpesa') {
      requestBody = {
        bank: 'mpesa',
        transactionNumber: cleanTx,
        settlementAccount: receivingAccount || undefined,
      };
    } else if (b === 'awash' || b === 'dashen') {
      requestBody = {
        bank: b,
        referenceNumber: cleanTx,
        settlementAccount: receivingAccount || undefined,
      };
    } else if (b === 'ebirr' || b === 'siinqee') {
      requestBody = {
        bank: 'siinqee',
        referenceNumber: cleanTx,
        settlementAccount: receivingAccount || undefined,
      };
    } else {
      // Telebirr default (100% untouched)
      requestBody = {
        bank: 'telebirr',
        transactionNumber: cleanTx,
      };
    }

    const res = await fetch('https://verify.et/api/verify?waitMs=5000', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();

    if (res.status === 202 && data.requestId) {
      return await pollVerifyEtStatus(apiKey, data.requestId);
    }

    if (!res.ok && !data.success) {
      return {
        success: false,
        message: data.message || 'Verification failed on verify.et',
        code: data.code || 'VERIFICATION_FAILED',
      };
    }

    const rawData = (Array.isArray(data.data) && data.data.length > 0) ? data.data[0] : (data.data || {});
    const resObj = rawData.result || rawData;
    const isVerified = rawData.verified === true || resObj.verified === true || rawData.status === 'success' || resObj.status === 'success' || data.verification?.verified === true;

    if (!isVerified) {
      return {
        success: false,
        message: data.message || rawData.message || resObj.message || 'Transaction not found or verification failed.',
      };
    }

    const receiverAcc = resObj.receiverAccount || resObj.bankSpecific?.receiverAccount || resObj.creditedPartyAccountNo || rawData.receiverAccount || '';
    const amt = resObj.amount !== undefined ? resObj.amount : (resObj.amountValue !== undefined ? resObj.amountValue : (rawData.amount || '0'));
    const sender = resObj.senderName || resObj.payerName || rawData.senderName || 'Customer';
    const receiver = resObj.receiverName || resObj.creditedPartyName || rawData.receiverName || 'Merchant';
    const txNum = resObj.transactionNumber || resObj.referenceNumber || resObj.receiptNumber || rawData.transactionNumber || transactionId;
    const settlementMatch = Boolean(
      resObj.settlementAccountMatch?.matched === true ||
      rawData.settlementAccountMatch?.matched === true ||
      data.settlementAccountMatch?.matched === true
    );

    return {
      success: true,
      message: 'Transaction verified successfully.',
      settlementMatch,
      receipt: {
        transactionId: txNum,
        status: 'VERIFIED',
        payer: sender,
        receiver: receiver,
        amount: String(amt),
        date: resObj.timestamp || rawData.date || new Date().toISOString(),
        creditedAccount: receiverAcc,
      },
    };
  } catch (err) {
    return {
      success: false,
      message: 'The verify.et service is temporarily unavailable. Please try again.',
      code: 'NETWORK_FAILED',
    };
  }
}

async function verifyWithVerifyEtMultiKey(settings, transactionId, targetPhoneNumber, activePhones, platform = 'jember', bank = 'telebirr', receivingAccount = '') {
  const b = String(bank || 'telebirr').toLowerCase();
  const apiKeys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];
  const primaryKey = getApiKeyForPhone(targetPhoneNumber, settings, platform);

  // Build unique list of all configured API keys, trying primary phone key first
  const keysToTry = [];
  if (primaryKey && primaryKey.trim() && !primaryKey.includes('_placeholder')) {
    keysToTry.push(primaryKey.trim());
  }
  apiKeys.forEach(k => {
    if (k && k.trim() && !k.includes('_placeholder') && !keysToTry.includes(k.trim())) {
      keysToTry.push(k.trim());
    }
  });
  if (settings.verifyApiKey && settings.verifyApiKey.trim() && !keysToTry.includes(settings.verifyApiKey.trim())) {
    keysToTry.push(settings.verifyApiKey.trim());
  }

  const isCbeFamily = (b === 'cbe' || b === 'cbeagent' || b === 'cbe_agent');
  const isEbirrFamily = (b === 'ebirr' || b === 'siinqee');
  let candidateAccounts = [];
  if (isCbeFamily) {
    const activeCbe = getActiveBankAccounts(platform, 'cbe');
    const activeAgent = getActiveBankAccounts(platform, 'cbeagent');
    candidateAccounts = Array.from(new Set([...activeAgent, ...activeCbe].filter(Boolean)));
  } else if (isEbirrFamily) {
    const activeEbirr = getActiveBankAccounts(platform, 'ebirr');
    const activeSiinqee = getActiveBankAccounts(platform, 'siinqee');
    candidateAccounts = Array.from(new Set([...activeEbirr, ...activeSiinqee].filter(Boolean)));
  } else if (b !== 'telebirr') {
    candidateAccounts = getActiveBankAccounts(platform, b);
  }

  // Strictly require active configured accounts for banks
  if (b !== 'telebirr' && candidateAccounts.length === 0) {
    return {
      success: false,
      message: `No active ${b.toUpperCase()} accounts configured for this platform. Please contact support.`,
      code: 'NO_ACTIVE_ACCOUNTS'
    };
  }

  // If receivingAccount was assigned from active accounts, prioritize testing it first
  if (receivingAccount && candidateAccounts.includes(receivingAccount)) {
    candidateAccounts = [receivingAccount, ...candidateAccounts.filter(a => a !== receivingAccount)];
  }

  let lastResult = null;

  for (const key of keysToTry) {
    if (!key || key.includes('_placeholder')) continue;

    const accountsToTest = (b !== 'telebirr') ? candidateAccounts : [''];

    for (const testAcc of accountsToTest) {
      console.log(`[Verify] Trying key on Verify.ET for tx (${b}), acc (${testAcc}):`, transactionId);
      const result = await verifyWithVerifyEt(key, transactionId, b, testAcc);
      console.log('[Verify] Result from verifyWithVerifyEt:', result.success, result.message, result.receipt?.creditedAccount);

      if (result.success && result.receipt) {
        if (b === 'telebirr') {
          const credited = result.receipt.creditedAccount || result.receipt.receiver;
          const isMatch = matchesMaskedPhone(credited, activePhones);
          console.log('[Verify] Masked phone match:', credited, 'against activePhones:', isMatch);
          if (isMatch) {
            return result;
          }
        } else {
          if (result.settlementMatch === true) {
            result.matchedAccount = testAcc;
            result.receipt.creditedAccount = testAcc;
            return result;
          }
          const credited = result.receipt.creditedAccount || result.receipt.receiver;
          if (credited && matchesMaskedAccount(credited, candidateAccounts)) {
            const matched = candidateAccounts.find(acc => matchesMaskedAccount(credited, [acc]));
            result.matchedAccount = matched || testAcc;
            if (!result.receipt.creditedAccount) {
              result.receipt.creditedAccount = result.matchedAccount;
            }
            console.log(`[Verify] Bank (${b}) account match:`, credited, '->', result.matchedAccount);
            return result;
          }
        }
      }
      lastResult = result;
    }
  }

  if (lastResult && lastResult.message && /credit|balance|insufficient/i.test(lastResult.message)) {
    return {
      success: false,
      message: lastResult.message,
      code: 'INSUFFICIENT_CREDITS'
    };
  }

  return {
    success: false,
    message: b === 'telebirr'
      ? 'Transaction not found or could not be verified on any active phone number. Please check and try again.'
      : `Transaction not found or could not be verified for ${b.toUpperCase()}. Please check and try again.`,
  };
}

async function verifyWithVerifyEtScreenshot(apiKey, imageBuffer, mimeType, bank, receivingAccount, sessionId) {
  try {
    const form = new FormData();
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    form.append('image', new Blob([imageBuffer], { type: mimeType }), `receipt_${sessionId}.${ext}`);
    let verifyBank = (bank === 'cbeagent' || bank === 'cbe_agent') ? 'cbe' : bank;
    if (verifyBank === 'ebirr') verifyBank = 'siinqee';
    if (verifyBank && verifyBank !== 'telebirr') {
      form.append('bank', String(verifyBank).toLowerCase());
    }
    if (receivingAccount) {
      form.append('settlementAccount', String(receivingAccount).trim());
    }

    const idempotencyKey = `dep_img_${sessionId}_${Date.now()}`.slice(0, 100);

    const res = await fetch('https://verify.et/api/verify', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Idempotency-Key': idempotencyKey,
      },
      body: form,
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();

    if (res.status === 202 && data.requestId) {
      return await pollVerifyEtStatus(apiKey, data.requestId);
    }

    if (!res.ok && !data.success) {
      let msg = data.message || 'Image verification failed on verify.et';
      if (data.code === 'INSUFFICIENT_IMAGE_CREDITS') {
        msg = 'Insufficient Verify.ET image credits. Please top up image credits on Verify.ET dashboard.';
      } else if (data.code === 'IMAGE_PROCESSING_DISABLED') {
        msg = 'Image processing is disabled on Verify.ET dashboard. Please enable it in API keys settings.';
      } else if (data.code === 'IMAGE_FIELD_CONFLICT') {
        msg = 'The receipt screenshot does not match the chosen bank or account.';
      }
      return {
        success: false,
        message: msg,
        code: data.code || 'VERIFICATION_FAILED',
      };
    }

    const rawData = (Array.isArray(data.data) && data.data.length > 0) ? data.data[0] : (data.data || {});
    const resObj = rawData.result || rawData;
    const isVerified = rawData.verified === true || resObj.verified === true || rawData.status === 'success' || resObj.status === 'success' || data.verification?.verified === true;

    if (!isVerified) {
      return {
        success: false,
        message: data.message || rawData.message || resObj.message || 'Transaction could not be verified from the screenshot.',
      };
    }

    const receiverAcc = resObj.receiverAccount || resObj.bankSpecific?.receiverAccount || resObj.creditedPartyAccountNo || rawData.receiverAccount || '';
    const amt = resObj.amount !== undefined ? resObj.amount : (resObj.amountValue !== undefined ? resObj.amountValue : (rawData.amount || '0'));
    const sender = resObj.senderName || resObj.payerName || rawData.senderName || 'Bank Customer';
    const receiver = resObj.receiverName || resObj.creditedPartyName || rawData.receiverName || 'Merchant';
    const txNum = resObj.transactionNumber || resObj.referenceNumber || resObj.receiptNumber || rawData.transactionNumber || rawData.reference || `IMG-${Date.now().toString().slice(-8)}`;
    const methodUsed = data.imageProcessing?.method || rawData.imageProcessing?.method || 'screenshot';

    return {
      success: true,
      message: `Transaction verified successfully via ${methodUsed.toUpperCase()}.`,
      method: methodUsed,
      receipt: {
        transactionId: txNum,
        status: 'VERIFIED',
        payer: sender,
        receiver: receiver,
        amount: String(amt),
        date: resObj.timestamp || rawData.date || new Date().toISOString(),
        creditedAccount: receiverAcc,
      },
    };
  } catch (err) {
    console.error('[Verify Screenshot] Network/Fetch error:', err.message);
    return {
      success: false,
      message: 'The verify.et service is temporarily unavailable or timed out. Please try again.',
      code: 'NETWORK_FAILED',
    };
  }
}

async function verifyWithVerifyEtScreenshotMultiKey(settings, imageBuffer, mimeType, platform = 'jember', bank = 'cbe', receivingAccount = '', sessionId = '') {
  const b = String(bank || 'cbe').toLowerCase();
  const apiKeys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];

  const keysToTry = [];
  apiKeys.forEach(k => {
    if (k && k.trim() && !k.includes('_placeholder') && !keysToTry.includes(k.trim())) {
      keysToTry.push(k.trim());
    }
  });
  if (settings.verifyApiKey && settings.verifyApiKey.trim() && !keysToTry.includes(settings.verifyApiKey.trim())) {
    keysToTry.push(settings.verifyApiKey.trim());
  }

  if (keysToTry.length === 0) {
    return {
      success: false,
      message: 'Verification service is not configured for this platform. Please contact support.',
      code: 'NO_API_KEY'
    };
  }

  let lastResult = null;
  const isCbeFamily = (b === 'cbe' || b === 'cbeagent' || b === 'cbe_agent');
  const isEbirrFamily = (b === 'ebirr' || b === 'siinqee');
  const allActiveAccounts = isCbeFamily
    ? Array.from(new Set([...getActiveBankAccounts(platform, 'cbeagent'), ...getActiveBankAccounts(platform, 'cbe')].filter(Boolean)))
    : isEbirrFamily
    ? Array.from(new Set([...getActiveBankAccounts(platform, 'ebirr'), ...getActiveBankAccounts(platform, 'siinqee')].filter(Boolean)))
    : (b !== 'telebirr')
    ? getActiveBankAccounts(platform, b)
    : [];

  if (allActiveAccounts.length === 0) {
    return {
      success: false,
      message: `No active ${b.toUpperCase()} accounts configured for this platform. Please contact support.`,
      code: 'NO_ACTIVE_ACCOUNTS'
    };
  }

  for (const key of keysToTry) {
    console.log(`[Verify Screenshot] Trying key on Verify.ET for bank (${b}), session:`, sessionId);
    const result = await verifyWithVerifyEtScreenshot(key, imageBuffer, mimeType, b, '', sessionId);
    console.log('[Verify Screenshot] Result:', result.success, result.message, result.receipt?.creditedAccount);

    if (result.success && result.receipt) {
      const credited = result.receipt.creditedAccount || result.receipt.receiver;
      if (credited && matchesMaskedAccount(credited, allActiveAccounts)) {
        const matched = allActiveAccounts.find(acc => matchesMaskedAccount(credited, [acc]));
        result.matchedAccount = matched || credited;
        return result;
      }
      console.warn(`[Verify Screenshot] Rejecting: credited '${credited}' does not match active accounts:`, allActiveAccounts);
      lastResult = {
        success: false,
        message: 'The receipt was not sent to an active bank account for this platform.',
        code: 'ACCOUNT_MISMATCH'
      };
      continue;
    }
    lastResult = result;
  }

  return lastResult || {
    success: false,
    message: 'Could not verify the receipt screenshot on Verify.ET. Please try again or upload a clearer screenshot.',
    code: 'VERIFICATION_FAILED'
  };
}

router.post('/verify', (req, res) => {
  const { sessionId, transactionId } = req.body;

  if (!sessionId || !transactionId) {
    return res.status(400).json({ error: 'Missing sessionId or transactionId' });
  }

  const cleanTxId = extractTransactionId(transactionId);
  if (!cleanTxId) {
    return res.status(400).json({ error: 'Invalid transaction ID format' });
  }

  // Anti-fraud duplicate check: instant indexed SQLite check
  const alreadyUsed = getTxByCleanTxId(cleanTxId);
  if (alreadyUsed && alreadyUsed.id !== sessionId) {
    return res.status(400).json({ error: 'This transaction ID has already been verified and credited.' });
  }

  const tx = getTxById(sessionId);
  if (!tx) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const platform = tx.platform || 'jember';
  const mode = getVerificationMode(platform, tx.bank);
  if (mode === 'manual') {
    return res.status(400).json({ error: 'Manual verification requires uploading a receipt screenshot.' });
  }

  if (Date.now() > tx.expiresAt) {
    updateTxStatus(sessionId, 'expired');

    if (tx.callbackUrl) {
      const payload = createWebhookPayload(tx, 'expired', 0, {}, 'Session has expired');
      sendWebhookWithRetry(tx.callbackUrl, payload);
    }

    return res.status(400).json({ error: 'Session has expired' });
  }

  if (tx.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction already submitted' });
  }

  updateTxStatus(sessionId, 'processing', {
    transactionId: cleanTxId,
    submittedAt: Date.now()
  });

  const settings = getPlatformSettings(platform);
  const activePhones = getActivePhoneNumbers(platform);
  const apiKey = getApiKeyForPhone(tx.phoneNumber, settings, platform);

  // Process verification asynchronously in background
  (async () => {
    const bank = tx.bank || 'telebirr';
    const targetAccount = tx.accountNumber || tx.phoneNumber;
    let result = null;

    // Direct eBirr Receipt Link / Token extraction (instant verification without verify.et queue)
    // NOTE: eBirr tokens are case-sensitive (e.g. DTG1wTiGTSr-e52e51tRfA). cleanTxId preserves case for mixed-case tokens.
    const rawInput = String(transactionId || '');
    const ebirrUrlMatch = rawInput.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*ebirr\.com\/[^\s]+/i);
    const isEbirrToken = (bank === 'ebirr' || bank === 'siinqee') && (
      ebirrUrlMatch ||
      /^[A-Za-z0-9_-]{16,40}$/.test(cleanTxId) ||
      /^[A-Za-z0-9_-]{16,40}$/.test(rawInput.trim())
    );
    if (isEbirrToken) {
      // Prefer: raw URL > original rawInput token (case-preserved) > cleanTxId
      const targetTokenOrUrl = ebirrUrlMatch
        ? ebirrUrlMatch[0]
        : (/^[A-Za-z0-9_-]{8,50}$/.test(rawInput.trim()) ? rawInput.trim() : cleanTxId);
      console.log('[Verify Route] Attempting direct eBirr receipt verification for:', targetTokenOrUrl);
      result = await verifyEbirrReceiptFromUrl(targetTokenOrUrl, platform);
      console.log('[Verify Route] Direct eBirr outcome:', result?.success, result?.receipt?.transactionId);
    }

    if (!result || !result.success) {
      if (apiKey && apiKey.trim() && !apiKey.includes('_placeholder')) {
        result = await verifyWithVerifyEtMultiKey(settings, cleanTxId, tx.phoneNumber, activePhones, platform, bank, targetAccount);
      }
    }

    if (result) {
      console.log('[Verify Route] Outcome:', result.success, result.message, result.receipt);
      const currentTx = getTxById(sessionId);

      if (currentTx) {
        if (result.success && result.receipt) {
          if (bank === 'telebirr') {
            const creditedAccountStr = result.receipt.creditedAccount || result.receipt.receiver;
            if (!matchesMaskedPhone(creditedAccountStr, activePhones)) {
              console.log('[Verify Route] Reject: not matching activePhones:', creditedAccountStr);
              updateTxStatus(sessionId, 'pending', {
                transactionId: null,
                submittedAt: null,
                failReason: 'Transaction was not sent to an active deposit phone number. Please try again.'
              });
              return;
            }
          } else {
            const isCbeFam = (bank === 'cbe' || bank === 'cbeagent' || bank === 'cbe_agent');
            const isEbirrFam = (bank === 'ebirr' || bank === 'siinqee');
            const activeBankAccounts = isCbeFam
              ? Array.from(new Set([...getActiveBankAccounts(platform, 'cbeagent'), ...getActiveBankAccounts(platform, 'cbe')]))
              : isEbirrFam
              ? Array.from(new Set([...getActiveBankAccounts(platform, 'ebirr'), ...getActiveBankAccounts(platform, 'siinqee')]))
              : getActiveBankAccounts(platform, bank);

            const creditedAccountStr = result.matchedAccount || result.receipt.creditedAccount || result.receipt.receiver;
            if (!creditedAccountStr || !matchesMaskedAccount(creditedAccountStr, activeBankAccounts)) {
              console.warn(`[Verify Route] Reject: credited '${creditedAccountStr}' does not match active bank accounts:`, activeBankAccounts);
              updateTxStatus(sessionId, 'pending', {
                transactionId: null,
                submittedAt: null,
                failReason: 'Transaction was not sent to an active deposit account for this platform. Please transfer to the displayed account and try again.'
              });
              return;
            }
          }

          const rawAmt = result.receipt.amount || '0';
          const parsedAmt = parseFloat(String(rawAmt).replace(/[^0-9.]/g, '')) || currentTx.amount;

          const minDeposit = settings.minDeposit || 100;
          const maxDeposit = settings.maxDeposit || 50000;

          if (parsedAmt < minDeposit) {
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: `Amount (${parsedAmt.toFixed(2)} ETB) is below the minimum deposit of ${minDeposit} ETB. Please try again.`
            });
            return;
          }

          if (parsedAmt > maxDeposit) {
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: `Amount (${parsedAmt.toFixed(2)} ETB) exceeds the maximum deposit of ${maxDeposit} ETB.`
            });
            return;
          }

          const verifiedTxId = cleanTxId || (result.receipt && (result.receipt.transactionId || result.receipt.receiptNumber)) || null;

          // Identify actual receiving slot and agent from verified receipt
          const hasDigitsOrMask = (str) => str && (/\d/.test(String(str)) || String(str).includes('*'));
          const verifiedIdentifier = (result.matchedAccount && hasDigitsOrMask(result.matchedAccount) ? result.matchedAccount : null)
            || (hasDigitsOrMask(result.receipt?.creditedAccount) ? result.receipt.creditedAccount : null)
            || (hasDigitsOrMask(result.receipt?.receiver) ? result.receipt.receiver : null);

          const actualSlot = findVerifiedSlot(currentTx.platform, currentTx.bank, verifiedIdentifier);
          if (!actualSlot) {
            console.warn(`[Verify Route Security] REJECTED: Credited account '${verifiedIdentifier}' does not match any active slot for platform '${currentTx.platform}', bank '${currentTx.bank}'.`);
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: 'Transaction was not sent to an active deposit account for this platform. Please transfer to the displayed account and try again.'
            });
            return;
          }
          const actualAgent = actualSlot.connectedAgent || currentTx.assignedAgent;
          const actualAccount = actualSlot.account || actualSlot.phone || verifiedIdentifier;
          const actualBank = actualSlot.bank || currentTx.bank;

          console.log(`[Verify Route] True recipient resolved: Agent '${actualAgent}', Bank '${actualBank}', Account '${actualAccount}' (Display was Agent '${currentTx.assignedAgent}', Bank '${currentTx.bank}', Account '${currentTx.accountNumber || currentTx.phoneNumber}')`);

          const updatedTx = updateTxStatus(sessionId, 'verified', {
            transactionId: verifiedTxId,
            amount: parsedAmt,
            verifiedAmount: parsedAmt,
            failReason: null,
            receipt: result.receipt,
            assignedAgent: actualAgent,
            accountNumber: actualAccount,
            bank: actualBank,
            ...(actualBank === 'telebirr' && actualAccount ? { phoneNumber: actualAccount } : {})
          });

          // Deduct from connected bank/telebirr account float limit of the ACTUAL recipient agent
          if (updatedTx) {
            deductBankDepositLimit(
              updatedTx.platform,
              actualBank,
              actualAccount,
              parsedAmt,
              null,
              actualAgent
            );
          }

          // Webhook Callback with HMAC-SHA256 Signature Verification & Retries
          if (updatedTx && updatedTx.callbackUrl) {
            const payload = createWebhookPayload(updatedTx, 'verified', parsedAmt, result.receipt);
            sendWebhookWithRetry(updatedTx.callbackUrl, payload);
          }
        } else {
          updateTxStatus(sessionId, 'pending', {
            transactionId: null,
            submittedAt: null,
            failReason: result.message || 'Invalid transaction ID or receipt not found. Please try again.'
          });
        }
      }
    } else {
      updateTxStatus(sessionId, 'pending', {
        transactionId: null,
        submittedAt: null,
        failReason: 'Verification service is not configured for this platform. Please contact support.'
      });
    }
  })();

  res.json({
    success: true,
    status: 'processing',
    sessionId,
  });
});

// Verify Bank Deposit via Receipt Screenshot / QR Upload (STRICTLY for Banks, NOT Telebirr)
router.post('/verify-screenshot', async (req, res) => {
  const { sessionId, image } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  if (!image || typeof image !== 'string' || !image.trim()) {
    return res.status(400).json({ error: 'Please upload a receipt screenshot' });
  }

  const tx = getTxById(sessionId);
  if (!tx) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const platform = tx.platform || 'jember';
  const mode = getVerificationMode(platform, tx.bank);

  // In auto mode, Telebirr uses 10-char transaction ID. In manual mode, Telebirr allows screenshot.
  if (tx.bank === 'telebirr' && mode !== 'manual') {
    return res.status(400).json({
      error: 'Screenshot verification is only available when manual mode is enabled. For automatic Telebirr, please enter your transaction number.'
    });
  }

  if (Date.now() > tx.expiresAt) {
    updateTxStatus(sessionId, 'expired');
    if (tx.callbackUrl) {
      const payload = createWebhookPayload(tx, 'expired', 0, {}, 'Session has expired');
      sendWebhookWithRetry(tx.callbackUrl, payload);
    }
    return res.status(400).json({ error: 'Session has expired' });
  }

  if (tx.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction already submitted or processing' });
  }

  // Parse base64 data
  let mimeType = 'image/jpeg';
  let base64Data = image;
  const match = image.match(/^data:([A-Za-z0-9\/+.-]+);base64,(.+)$/);
  if (match) {
    mimeType = match[1];
    base64Data = match[2];
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > 8.5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Screenshot image must be under 8MB' });
  }

  // Save screenshot locally to uploads/screenshots directory
  let savedImageUrl = null;
  try {
    const screenshotsDir = path.join(dataDir, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filename = `dep_${sessionId}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(screenshotsDir, filename), buffer);
    savedImageUrl = `/screenshots/${filename}`;
  } catch (err) {
    console.warn('[Screenshot] Could not save screenshot locally:', err.message);
  }

  updateTxStatus(sessionId, 'processing', {
    submittedAt: Date.now(),
    receiptImage: savedImageUrl
  });

  if (mode === 'manual') {
    // In manual mode, stay in 'processing' state waiting for staff confirmation in Transactions
    return res.json({
      success: true,
      status: 'processing',
      sessionId,
      manual: true
    });
  }

  const settings = getPlatformSettings(platform);
  const targetAccount = tx.accountNumber || tx.phoneNumber;

  // Process verification asynchronously in background
  (async () => {
    try {
      const result = await verifyWithVerifyEtScreenshotMultiKey(
        settings,
        buffer,
        mimeType,
        platform,
        tx.bank,
        targetAccount,
        sessionId
      );

      console.log('[Verify Screenshot] Outcome:', result.success, result.message, result.receipt);
      const currentTx = getTxById(sessionId);

      if (currentTx) {
        if (result.success && result.receipt) {
          const rawAmt = result.receipt.amount || '0';
          let parsedAmt = parseFloat(String(rawAmt).replace(/[^0-9.]/g, '')) || currentTx.amount;

          const minDeposit = settings.minDeposit || 100;
          const maxDeposit = settings.maxDeposit || 50000;

          if (parsedAmt < minDeposit) {
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: `Amount (${parsedAmt.toFixed(2)} ETB) is below the minimum deposit of ${minDeposit} ETB. Please try again.`
            });
            return;
          }

          if (parsedAmt > maxDeposit) {
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: `Amount (${parsedAmt.toFixed(2)} ETB) exceeds the maximum deposit of ${maxDeposit} ETB.`
            });
            return;
          }

          const verifiedTxId = (result.receipt && (result.receipt.transactionId || result.receipt.receiptNumber)) || `IMG-${Date.now().toString().slice(-8)}`;

          // Anti-fraud duplicate check on extracted transaction ID
          if (verifiedTxId) {
            const alreadyUsed = getTxByCleanTxId(verifiedTxId);
            if (alreadyUsed && alreadyUsed.id !== sessionId) {
              updateTxStatus(sessionId, 'pending', {
                transactionId: null,
                submittedAt: null,
                failReason: 'This transaction receipt has already been verified and credited.'
              });
              return;
            }
          }

          // Identify actual receiving slot and agent from verified receipt
          const hasDigitsOrMask = (str) => str && (/\d/.test(String(str)) || String(str).includes('*'));
          const verifiedIdentifier = (result.matchedAccount && hasDigitsOrMask(result.matchedAccount) ? result.matchedAccount : null)
            || (hasDigitsOrMask(result.receipt?.creditedAccount) ? result.receipt.creditedAccount : null)
            || (hasDigitsOrMask(result.receipt?.receiver) ? result.receipt.receiver : null);

          const actualSlot = findVerifiedSlot(currentTx.platform, currentTx.bank, verifiedIdentifier);
          if (!actualSlot) {
            console.warn(`[Verify Route Security] REJECTED: Credited account '${verifiedIdentifier}' does not match any active slot for platform '${currentTx.platform}', bank '${currentTx.bank}'.`);
            updateTxStatus(sessionId, 'pending', {
              transactionId: null,
              submittedAt: null,
              failReason: 'Transaction was not sent to an active deposit account for this platform. Please transfer to the displayed account and try again.'
            });
            return;
          }
          const actualAgent = actualSlot.connectedAgent || currentTx.assignedAgent;
          const actualAccount = actualSlot.account || actualSlot.phone || verifiedIdentifier;
          const actualBank = actualSlot.bank || currentTx.bank;

          console.log(`[Verify Screenshot] True recipient resolved: Agent '${actualAgent}', Bank '${actualBank}', Account '${actualAccount}' (Display was Agent '${currentTx.assignedAgent}', Bank '${currentTx.bank}', Account '${currentTx.accountNumber || currentTx.phoneNumber}')`);

          // Extra 8-digit backend ledger validation for CBE and other banks:
          // Queries the bank's live core ledger using the extracted transaction code and our real account's suffix.
          // This eliminates middle-digit spoofing (e.g. 1000 9999 9504 vs 1000 4297 39504) with 100% certainty.
          if (verifiedTxId && !verifiedTxId.startsWith('IMG-') && actualAccount) {
            const apiKeys = Array.isArray(settings.apiKeys) ? settings.apiKeys.filter(Boolean) : [];
            const primaryKey = settings.verifyApiKey || apiKeys[0];
            if (primaryKey && !primaryKey.includes('_placeholder')) {
              try {
                let targetBank = (actualBank === 'cbeagent' || actualBank === 'cbe_agent') ? 'cbe' : actualBank;
                if (targetBank === 'ebirr') targetBank = 'siinqee';
                console.log(`[Verify Screenshot] Running live backend ledger cross-check for ${verifiedTxId} (${targetBank}) against account ${actualAccount}...`);
                const crossCheck = await verifyWithVerifyEt(primaryKey, verifiedTxId, targetBank, actualAccount);
                if (crossCheck && crossCheck.success) {
                  if (crossCheck.settlementMatch === false) {
                    console.warn(`[Verify Screenshot Security] 8-digit backend check REJECTED: ${verifiedTxId} was NOT sent to ${actualAccount}`);
                    updateTxStatus(sessionId, 'pending', {
                      transactionId: null,
                      submittedAt: null,
                      failReason: 'Transaction was not sent to an active deposit account for this platform. Please transfer to the displayed account and try again.'
                    });
                    return;
                  }
                  if (crossCheck.receipt?.amount) {
                    const bankAmt = parseFloat(String(crossCheck.receipt.amount).replace(/[^0-9.]/g, ''));
                    if (bankAmt && !isNaN(bankAmt) && bankAmt > 0) {
                      parsedAmt = bankAmt;
                    }
                  }
                } else if (crossCheck && !crossCheck.success) {
                  if (crossCheck.code === 'VERIFICATION_FAILED' || /not found|invalid|mismatch/i.test(crossCheck.message || '')) {
                    console.warn(`[Verify Screenshot Security] Live bank API rejected reference ${verifiedTxId}:`, crossCheck.message);
                    updateTxStatus(sessionId, 'pending', {
                      transactionId: null,
                      submittedAt: null,
                      failReason: 'Transaction was not sent to an active deposit account for this platform. Please transfer to the displayed account and try again.'
                    });
                    return;
                  }
                }
              } catch (chkErr) {
                console.warn('[Verify Screenshot] Backend cross-check non-fatal error:', chkErr.message);
              }
            }
          }

          const updatedTx = updateTxStatus(sessionId, 'verified', {
            transactionId: verifiedTxId,
            amount: parsedAmt,
            verifiedAmount: parsedAmt,
            failReason: null,
            receipt: result.receipt,
            receiptImage: savedImageUrl,
            assignedAgent: actualAgent,
            accountNumber: actualAccount,
            bank: actualBank,
            ...(actualBank === 'telebirr' && actualAccount ? { phoneNumber: actualAccount } : {})
          });

          // Deduct from connected bank/telebirr account float limit of the ACTUAL recipient agent
          if (updatedTx) {
            deductBankDepositLimit(
              updatedTx.platform,
              actualBank,
              actualAccount,
              parsedAmt,
              null,
              actualAgent
            );
          }

          // Webhook Callback with HMAC-SHA256 Signature Verification & Retries
          if (updatedTx && updatedTx.callbackUrl) {
            const payload = createWebhookPayload(updatedTx, 'verified', parsedAmt, result.receipt);
            sendWebhookWithRetry(updatedTx.callbackUrl, payload);
          }
        } else {
          updateTxStatus(sessionId, 'pending', {
            transactionId: null,
            submittedAt: null,
            failReason: result.message || 'Receipt screenshot verification failed. Please try again with a clearer image.'
          });
        }
      }
    } catch (err) {
      console.error('[Verify Screenshot] Error:', err.message);
      updateTxStatus(sessionId, 'pending', {
        transactionId: null,
        submittedAt: null,
        failReason: 'Verification error occurred. Please try again.'
      });
    }
  })();

  res.json({
    success: true,
    status: 'processing',
    sessionId
  });
});

router.post('/fail', (req, res) => {
  const { sessionId, reason } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  updateTxStatus(sessionId, 'pending', {
    transactionId: null,
    submittedAt: null,
    failReason: reason || 'Verification timed out. Please try again.'
  });

  res.json({ success: true, status: 'pending' });
});

router.get('/session/:sessionId', (req, res) => {
  const tx = getTxById(req.params.sessionId);
  if (!tx) return res.status(404).json({ error: 'Session not found' });
  const platform = tx.platform || 'jember';
  const settings = getPlatformSettings(platform);

  res.json({
    sessionId: tx.id,
    platform: platform,
    bank: tx.bank || 'telebirr',
    status: tx.status,
    phoneNumber: tx.phoneNumber || null,
    accountNumber: tx.accountNumber || tx.phoneNumber || null,
    amount: tx.amount,
    requestedAmount: tx.requestedAmount || tx.amount,
    bankVerificationMethod: getBankVerificationMethod(platform, tx.bank),
    expiresAt: tx.expiresAt,
    sessionExpiry: settings.sessionExpiry || 20,
    currency: settings.currency || 'ETB',
    minDeposit: settings.minDeposit || 100,
    maxDeposit: settings.maxDeposit || 50000,
    returnUrl: tx.returnUrl || null,
    callbackUrl: tx.callbackUrl || null,
    transactionId: tx.transactionId || null,
    failReason: tx.failReason || null,
    receiptImage: tx.receiptImage || null,
  });
});

router.get('/status/:sessionId', (req, res) => {
  const tx = getTxById(req.params.sessionId);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  const platform = tx.platform || 'jember';
  const settings = getPlatformSettings(platform);
  res.json({
    status: tx.status,
    platform: platform,
    bank: tx.bank || 'telebirr',
    amount: tx.amount,
    phoneNumber: tx.phoneNumber || null,
    accountNumber: tx.accountNumber || tx.phoneNumber || null,
    verifiedAmount: tx.verifiedAmount || tx.amount,
    requestedAmount: tx.requestedAmount || tx.amount,
    bankVerificationMethod: getBankVerificationMethod(platform, tx.bank),
    transactionId: tx.transactionId,
    failReason: tx.failReason || null,
    returnUrl: tx.returnUrl || null,
    receipt: tx.receipt || null,
    receiptImage: tx.receiptImage || null
  });
});

// Reset a failed/processing transaction back to pending so user can try again
// without losing the remaining session time
router.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const tx = getTxById(sessionId);
  if (!tx) return res.status(404).json({ error: 'Session not found' });

  if (Date.now() > tx.expiresAt) {
    updateTxStatus(sessionId, 'expired');
    return res.status(400).json({ error: 'Session has expired' });
  }

  if (!['pending', 'failed', 'processing'].includes(tx.status)) {
    return res.status(400).json({ error: `Cannot reset a transaction with status: ${tx.status}` });
  }

  const updated = updateTxStatus(sessionId, 'pending', {
    transactionId: null,
    failReason: null,
    submittedAt: null
  });

  res.json({
    success: true,
    sessionId,
    platform: updated.platform || 'jember',
    status: 'pending',
    expiresAt: updated.expiresAt,
    phoneNumber: updated.phoneNumber,
    amount: updated.amount,
    requestedAmount: updated.requestedAmount,
  });
});

router.createWebhookPayload = createWebhookPayload;
router.sendWebhookWithRetry = sendWebhookWithRetry;
router.getVerificationMode = getVerificationMode;

module.exports = router;
