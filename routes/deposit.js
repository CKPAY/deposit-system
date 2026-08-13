const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Shared JWT secret key — keep this private, share only with Jember Bet!
const JWT_SECRET = process.env.JWT_SECRET || '4fec6686d2b93ceca92531ed08dbdc48cf0b937965ebbf51b144d8f055f5d004fd85c8518ef72a1d61634949884c4346';

const { saveTx, getTxById, getTxByCleanTxId, getActivePendingTx, expireOldPendingTxs } = require('../db');

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
  if (str.length === 9 && str.startsWith('9')) str = '0' + str;
  return str;
}

function getActivePhoneNumbers() {
  const numbersData = readJSON('numbers.json') || {};
  const list = numbersData.numbers || [];
  return list.filter(n => n.active !== false).map(n => normalizePhone(n.phone));
}

function matchesMaskedPhone(creditedStr, activePhones) {
  if (!creditedStr) return true;
  const str = String(creditedStr).trim();
  if (!str) return true;

  if (!str.includes('*')) {
    const norm = normalizePhone(str);
    return norm.length < 9 || activePhones.includes(norm);
  }

  const last4 = str.slice(-4);
  if (/^\d{4}$/.test(last4)) {
    return activePhones.some(ph => ph.endsWith(last4));
  }

  return true;
}

function extractTransactionId(text) {
  if (!text) return null;
  const str = String(text).trim();
  if (!str) return null;

  const matchTxNum = str.match(/transaction\s+number\s+is\s+([A-Za-z0-9]{8,20})/i);
  if (matchTxNum && matchTxNum[1]) return matchTxNum[1].trim();

  const matchReceipt = str.match(/receipt\/([A-Za-z0-9]{8,20})/i);
  if (matchReceipt && matchReceipt[1]) return matchReceipt[1].trim();

  const matchTxId = str.match(/(?:transaction\s*id|txid|txn|ref)\s*[:=]?\s*([A-Za-z0-9]{8,20})/i);
  if (matchTxId && matchTxId[1]) return matchTxId[1].trim();

  if (!/\s/.test(str)) {
    const isAlphanumericCode = /^[A-Za-z0-9]{8,20}$/.test(str);
    if (isAlphanumericCode) return str;
  }

  return str.split(/\s+/)[0];
}

function getActiveAssignments(assignmentsData) {
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(assignmentsData).filter(([_, a]) => now - a.assignedAt < limit)
  );
}

function pickPhoneNumber(numbers, activeAssignments, userHistory = []) {
  const available = numbers.filter(n => n.active !== false);
  if (available.length === 0) return numbers[0].phone;

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

router.post('/init', (req, res) => {
  // Verify JWT token signature if token is provided
  const rawToken = req.body.token || req.headers['x-ckpay-token'] || null;
  if (rawToken) {
    try {
      jwt.verify(rawToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired payment token. Please start a new deposit session.' });
    }
  }

  // Support both CK-PAY and A-Pay standard parameter names
  const userId = req.body.userId || req.body.account_id || req.body.client_id;
  const amount = req.body.amount;
  const orderId = req.body.orderId || req.body.order_id || req.body.merchant_order_id || null;
  const returnUrl = req.body.returnUrl || req.body.return_url || req.body.success_url || null;
  const callbackUrl = req.body.callbackUrl || req.body.callback_url || req.body.postback_url || null;
  const forceNew = req.body.forceNew;

  if (!userId || !amount) {
    return res.status(400).json({ error: 'Missing userId (or account_id) or amount' });
  }

  const settings = readJSON('settings.json');
  if (!settings.depositEnabled) {
    return res.status(403).json({ error: 'Deposits are currently disabled' });
  }

  const amt = Number(amount);
  if (amt < settings.minDeposit || amt > settings.maxDeposit) {
    return res.status(400).json({ error: `Amount must be between ${settings.minDeposit} and ${settings.maxDeposit} ETB` });
  }

  const numbersData = readJSON('numbers.json');
  const numbers = numbersData.numbers || [];
  if (numbers.length === 0) {
    return res.status(500).json({ error: 'No phone numbers configured' });
  }

  let assignmentsData = readJSON('assignments.json') || {};
  const activeAssignments = getActiveAssignments(assignmentsData);
  const transactions = readJSON('transactions.json') || [];
  const now = Date.now();

  // Re-use active pending session on refresh ONLY if forceNew is not requested and amount matches
  if (!forceNew) {
    const activeSession = transactions.find(
      t => t.userId === String(userId) && t.status === 'pending' && t.expiresAt > now && Number(t.amount) === amt
    );
    if (activeSession) {
      return res.json({
        sessionId: activeSession.id,
        phoneNumber: activeSession.phoneNumber,
        amount: activeSession.amount,
        requestedAmount: activeSession.requestedAmount || activeSession.amount,
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

  // If forceNew is requested OR previous session expired, assign a NEW rotated phone number from the remaining 9 numbers
  const userRecord = assignmentsData[userId] || {};
  let history = Array.isArray(userRecord.history) ? [...userRecord.history] : [];
  if (userRecord.phone && !history.includes(userRecord.phone)) {
    history.push(userRecord.phone);
  }

  const available = numbers.filter(n => n.active !== false);
  if (history.length >= available.length) {
    const lastPhone = history[history.length - 1];
    history = lastPhone ? [lastPhone] : [];
  }

  assignedPhone = pickPhoneNumber(numbers, activeAssignments, history);
  history.push(assignedPhone);

  assignmentsData[userId] = {
    phone: assignedPhone,
    assignedAt: now,
    history: history
  };
  writeJSON('assignments.json', assignmentsData);

  // Mark any old pending sessions as expired
  transactions.forEach(t => {
    if (t.userId === String(userId) && t.status === 'pending') {
      t.status = 'expired';
    }
  });

  const sessionId = uuidv4();
  const expiresAt = now + settings.sessionExpiry * 60 * 1000;

  const newTxObj = {
    id: sessionId,
    orderId: orderId || null,
    userId: String(userId),
    requestedAmount: amt,
    amount: amt,
    phoneNumber: assignedPhone,
    status: 'pending',
    createdAt: now,
    expiresAt,
    transactionId: null,
    submittedAt: null,
    returnUrl: returnUrl || null,
    callbackUrl: callbackUrl || null,
  };
  transactions.push(newTxObj);
  writeJSON('transactions.json', transactions);
  try { saveTx(newTxObj); } catch {}

  res.json({
    sessionId,
    orderId: orderId || null,
    phoneNumber: assignedPhone,
    amount: amt,
    requestedAmount: amt,
    expiresAt,
    sessionExpiry: settings.sessionExpiry,
    currency: settings.currency,
    minDeposit: settings.minDeposit,
    maxDeposit: settings.maxDeposit,
  });
});

function getApiKeyForPhone(phoneNumber, settings) {
  const numbersData = readJSON('numbers.json') || {};
  const numbers = numbersData.numbers || [];

  const normTarget = normalizePhone(phoneNumber);
  let phoneIndex = numbers.findIndex(n => normalizePhone(n.phone) === normTarget);
  if (phoneIndex === -1) phoneIndex = 0;

  // 10 phone numbers mapped to 5 API keys (2 numbers per key)
  const keyIndex = Math.floor(phoneIndex / 2);
  const keys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];
  let selectedKey = keys[keyIndex] ? keys[keyIndex].trim() : '';

  // Fallback if specific slot key is blank
  if (!selectedKey) {
    selectedKey = keys.find(k => k && k.trim()) || settings.verifyApiKey || '';
  }

  return selectedKey;
}

async function pollVerifyEtStatus(apiKey, requestId) {
  const statusUrl = `https://verify.et/api/verify/${requestId}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      const res = await fetch(statusUrl, {
        headers: { 'x-api-key': apiKey }
      });
      const body = await res.json();
      const item = body.data || {};
      const status = item.processingStatus || item.status;
      if (status === 'completed' || status === 'success' || item.verified === true) {
        return {
          success: true,
          message: 'Transaction verified successfully.',
          receipt: {
            transactionId: item.referenceNumber || item.transactionNumber || requestId,
            status: 'VERIFIED',
            payer: item.senderName || item.payer || 'Telebirr Customer',
            receiver: item.receiverName || item.receiver || 'Merchant',
            amount: String(item.amount || '0'),
            date: item.completedAt || new Date().toISOString(),
            creditedAccount: item.receiverAccount || '',
          }
        };
      }
      if (status === 'failed' || item.verified === false) {
        return {
          success: false,
          message: body.message || 'Transaction verification failed on verify.et.'
        };
      }
    } catch {}
  }
  return {
    success: false,
    message: 'Verification request timed out. Please try again.'
  };
}

async function verifyWithVerifyEt(apiKey, transactionId, phoneNumber) {
  try {
    const res = await fetch('https://verify.et/api/verify?waitMs=5000', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        bank: 'telebirr',
        transactionNumber: transactionId,
        settlementAccount: phoneNumber || undefined,
      }),
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

    const item = (Array.isArray(data.data) && data.data.length > 0) ? data.data[0] : (data.data || {});
    const isVerified = item.verified === true || item.status === 'success' || data.verification?.verified === true;

    if (!isVerified) {
      return {
        success: false,
        message: data.message || item.message || 'Transaction not found or verification failed.',
      };
    }

    if (item.settlementAccountMatch && item.settlementAccountMatch.matched === false) {
      return {
        success: false,
        message: 'Transaction was not sent to the assigned deposit phone number.',
        code: 'SETTLEMENT_MISMATCH',
      };
    }

    return {
      success: true,
      message: 'Transaction verified successfully.',
      receipt: {
        transactionId: item.referenceNumber || item.transactionNumber || transactionId,
        status: 'VERIFIED',
        payer: item.senderName || item.payer || 'Telebirr Customer',
        receiver: item.receiverName || item.receiver || 'Merchant',
        amount: String(item.amount || '0'),
        date: item.timestamp || item.date || new Date().toISOString(),
        creditedAccount: item.receiverAccount || item.creditedAccount || phoneNumber,
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

async function verifyWithVerifyEtMultiKey(settings, transactionId, targetPhoneNumber, activePhones) {
  const apiKeys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];
  const primaryKey = getApiKeyForPhone(targetPhoneNumber, settings);

  const keysToTry = [primaryKey];
  apiKeys.forEach(k => {
    if (k && k.trim() && !k.includes('_placeholder') && !keysToTry.includes(k.trim())) {
      keysToTry.push(k.trim());
    }
  });
  if (settings.verifyApiKey && settings.verifyApiKey.trim() && !keysToTry.includes(settings.verifyApiKey.trim())) {
    keysToTry.push(settings.verifyApiKey.trim());
  }

  let lastResult = null;

  for (const key of keysToTry) {
    if (!key || key.includes('_placeholder')) continue;

    // 1. Try with targetPhoneNumber first
    let result = await verifyWithVerifyEt(key, transactionId, targetPhoneNumber);
    if (result.success && result.receipt) {
      return result;
    }

    lastResult = result;

    // 2. If mismatch/not found on target phone, try without settlementAccount
    // to check if money was received on ANY of our 10 active phone numbers!
    const resNoAccount = await verifyWithVerifyEt(key, transactionId, null);
    if (resNoAccount.success && resNoAccount.receipt) {
      const credited = resNoAccount.receipt.creditedAccount || resNoAccount.receipt.receiver;
      if (matchesMaskedPhone(credited, activePhones)) {
        return resNoAccount;
      } else {
        return {
          success: false,
          message: 'Transaction was not sent to any of our active deposit phone numbers.',
          code: 'SETTLEMENT_MISMATCH',
        };
      }
    }
  }

  return lastResult || {
    success: false,
    message: 'Transaction not found or could not be verified.',
  };
}

router.post('/verify', (req, res) => {
  const { sessionId, transactionId, customVerifiedAmount } = req.body;

  if (!sessionId || !transactionId) {
    return res.status(400).json({ error: 'Missing sessionId or transactionId' });
  }

  const cleanTxId = extractTransactionId(transactionId);
  if (!cleanTxId) {
    return res.status(400).json({ error: 'Invalid transaction ID format' });
  }

  const transactions = readJSON('transactions.json') || [];

  // Anti-fraud duplicate check: 0.0001ms instant SQLite check!
  const alreadyUsed = getTxByCleanTxId(cleanTxId);
  if (alreadyUsed) {
    return res.status(400).json({ error: 'This transaction ID has already been verified and credited.' });
  }

  const idx = transactions.findIndex(t => t.id === sessionId);

  if (idx === -1) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const tx = transactions[idx];

  if (Date.now() > tx.expiresAt) {
    transactions[idx].status = 'expired';
    writeJSON('transactions.json', transactions);
    return res.status(400).json({ error: 'Session has expired' });
  }

  if (tx.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction already submitted' });
  }

  transactions[idx].transactionId = cleanTxId;
  transactions[idx].status = 'processing';
  transactions[idx].submittedAt = Date.now();
  writeJSON('transactions.json', transactions);

  const settings = readJSON('settings.json') || {};
  const activePhones = getActivePhoneNumbers();
  const apiKey = getApiKeyForPhone(tx.phoneNumber, settings);

  // Process verification
  (async () => {
    if (apiKey && apiKey.trim() && !apiKey.includes('_placeholder')) {
      // Call MultiKey Verify.ET algorithm
      const result = await verifyWithVerifyEtMultiKey(settings, cleanTxId, tx.phoneNumber, activePhones);

      const currentTxs = readJSON('transactions.json') || [];
      const tIdx = currentTxs.findIndex(t => t.id === sessionId);

      if (tIdx !== -1) {
        // Enforce active phone validation: Check if session's assigned phone is still active in numbers.json
        const activePhones = getActivePhoneNumbers();
        const assignedPhoneNorm = normalizePhone(currentTxs[tIdx].phoneNumber);

        if (!activePhones.includes(assignedPhoneNorm)) {
          currentTxs[tIdx].status = 'failed';
          currentTxs[tIdx].failReason = 'This deposit phone number is no longer active. Please start a new deposit session.';
          writeJSON('transactions.json', currentTxs);
          return;
        }

        if (result.success && result.receipt) {
          const creditedAccountStr = result.receipt.creditedAccount || result.receipt.receiver;
          if (!matchesMaskedPhone(creditedAccountStr, activePhones)) {
            currentTxs[tIdx].status = 'failed';
            currentTxs[tIdx].failReason = 'Transaction was not sent to an active deposit phone number.';
            writeJSON('transactions.json', currentTxs);
            return;
          }

          const rawAmt = result.receipt.amount || '0';
          const parsedAmt = parseFloat(String(rawAmt).replace(/[^0-9.]/g, '')) || currentTxs[tIdx].amount;

          const minDeposit = settings.minDeposit || 100;
          const maxDeposit = settings.maxDeposit || 50000;

          if (parsedAmt < minDeposit) {
            currentTxs[tIdx].status = 'failed';
            currentTxs[tIdx].failReason = `Verified amount (${parsedAmt.toFixed(2)} ETB) is below minimum deposit limit of ${minDeposit} ETB.`;
            writeJSON('transactions.json', currentTxs);
            return;
          }

          if (parsedAmt > maxDeposit) {
            currentTxs[tIdx].status = 'failed';
            currentTxs[tIdx].failReason = `Verified amount (${parsedAmt.toFixed(2)} ETB) exceeds maximum deposit limit of ${maxDeposit} ETB.`;
            writeJSON('transactions.json', currentTxs);
            return;
          }

          currentTxs[tIdx].amount = parsedAmt;
          currentTxs[tIdx].verifiedAmount = parsedAmt;
          currentTxs[tIdx].status = 'verified';
          currentTxs[tIdx].receipt = result.receipt;
          writeJSON('transactions.json', currentTxs);
          try { saveTx(currentTxs[tIdx]); } catch {}

          // Webhook Callback with HMAC-SHA256 Signature Verification
          if (currentTxs[tIdx].callbackUrl) {
            try {
              const timestamp = Date.now();
              const orderId = currentTxs[tIdx].orderId || currentTxs[tIdx].order_id || null;
              const rawSigString = `${currentTxs[tIdx].id}:${orderId || ''}:${parsedAmt}:verified:${timestamp}`;
              const signature = crypto.createHmac('sha256', JWT_SECRET).update(rawSigString).digest('hex');

              const payload = {
                status: 'verified',
                sessionId: currentTxs[tIdx].id,
                userId: currentTxs[tIdx].userId,
                orderId: orderId,
                requestedAmount: currentTxs[tIdx].requestedAmount || currentTxs[tIdx].amount,
                verifiedAmount: parsedAmt,
                amount: parsedAmt,
                transactionId: currentTxs[tIdx].transactionId,
                phoneNumber: currentTxs[tIdx].phoneNumber,
                payer: result.receipt.payer || null,
                receiver: result.receipt.receiver || null,
                timestamp: timestamp,
                signature: signature
              };

              fetch(currentTxs[tIdx].callbackUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CKPAY-Signature': signature
                },
                body: JSON.stringify(payload)
              }).catch(err => console.error('Webhook error:', err));
            } catch (e) {}
          }
        } else {
          // Verification failed on verify.et
          currentTxs[tIdx].status = 'failed';
          currentTxs[tIdx].failReason = result.message || 'Invalid transaction ID or receipt not found';
        }
      }
    } else {
      // Fallback simulation mode if no API key is provided
      setTimeout(() => {
        const currentTxs = readJSON('transactions.json') || [];
        const tIdx = currentTxs.findIndex(t => t.id === sessionId);
        if (tIdx !== -1 && currentTxs[tIdx].status === 'processing') {
          const verifiedAmt = customVerifiedAmount ? Number(customVerifiedAmount) : currentTxs[tIdx].amount;
          const minDeposit = settings.minDeposit || 100;
          const maxDeposit = settings.maxDeposit || 50000;

          if (verifiedAmt < minDeposit) {
            currentTxs[tIdx].status = 'failed';
            currentTxs[tIdx].failReason = `Verified amount (${verifiedAmt.toFixed(2)} ETB) is below minimum deposit limit of ${minDeposit} ETB.`;
            writeJSON('transactions.json', currentTxs);
            return;
          }

          if (verifiedAmt > maxDeposit) {
            currentTxs[tIdx].status = 'failed';
            currentTxs[tIdx].failReason = `Verified amount (${verifiedAmt.toFixed(2)} ETB) exceeds maximum deposit limit of ${maxDeposit} ETB.`;
            writeJSON('transactions.json', currentTxs);
            return;
          }
          currentTxs[tIdx].amount = verifiedAmt;
          currentTxs[tIdx].verifiedAmount = verifiedAmt;
          currentTxs[tIdx].status = 'verified';
          writeJSON('transactions.json', currentTxs);

          if (currentTxs[tIdx].callbackUrl) {
            try {
              const timestamp = Date.now();
              const orderId = currentTxs[tIdx].orderId || currentTxs[tIdx].order_id || null;
              const rawSigString = `${currentTxs[tIdx].id}:${orderId || ''}:${verifiedAmt}:verified:${timestamp}`;
              const signature = crypto.createHmac('sha256', JWT_SECRET).update(rawSigString).digest('hex');

              const payload = {
                status: 'verified',
                sessionId: currentTxs[tIdx].id,
                userId: currentTxs[tIdx].userId,
                orderId: orderId,
                requestedAmount: currentTxs[tIdx].requestedAmount || currentTxs[tIdx].amount,
                verifiedAmount: verifiedAmt,
                amount: verifiedAmt,
                transactionId: currentTxs[tIdx].transactionId,
                phoneNumber: currentTxs[tIdx].phoneNumber,
                timestamp: timestamp,
                signature: signature
              };

              fetch(currentTxs[tIdx].callbackUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CKPAY-Signature': signature
                },
                body: JSON.stringify(payload)
              }).catch(err => console.error('Webhook error:', err));
            } catch (e) {}
          }
        }
      }, 2000);
    }
  })();

  res.json({
    success: true,
    status: 'processing',
    sessionId,
  });
});

router.post('/fail', (req, res) => {
  const { sessionId, transactionId, reason } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const transactions = readJSON('transactions.json') || [];
  const idx = transactions.findIndex(t => t.id === sessionId);

  if (idx !== -1) {
    transactions[idx].status = 'failed';
    if (transactionId) transactions[idx].transactionId = transactionId.trim();
    transactions[idx].failReason = reason || 'Verification failed';
    transactions[idx].submittedAt = Date.now();
    writeJSON('transactions.json', transactions);
  }

  res.json({ success: true, status: 'failed' });
});

router.get('/status/:sessionId', (req, res) => {
  const transactions = readJSON('transactions.json') || [];
  const tx = transactions.find(t => t.id === req.params.sessionId);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: tx.status,
    amount: tx.amount,
    phoneNumber: tx.phoneNumber || null,
    verifiedAmount: tx.verifiedAmount || tx.amount,
    requestedAmount: tx.requestedAmount || tx.amount,
    transactionId: tx.transactionId,
    failReason: tx.failReason || null,
    returnUrl: tx.returnUrl || null,
    receipt: tx.receipt || null
  });
});

// Reset a failed/processing transaction back to pending so user can try again
// without losing the remaining session time
router.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const transactions = readJSON('transactions.json') || [];
  const idx = transactions.findIndex(t => t.id === sessionId);

  if (idx === -1) return res.status(404).json({ error: 'Session not found' });

  const tx = transactions[idx];

  if (Date.now() > tx.expiresAt) {
    transactions[idx].status = 'expired';
    writeJSON('transactions.json', transactions);
    return res.status(400).json({ error: 'Session has expired' });
  }

  // Only allow reset from failed or processing states
  if (!['failed', 'processing'].includes(tx.status)) {
    return res.status(400).json({ error: `Cannot reset a transaction with status: ${tx.status}` });
  }

  transactions[idx].status = 'pending';
  transactions[idx].transactionId = null;
  transactions[idx].failReason = null;
  transactions[idx].submittedAt = null;
  writeJSON('transactions.json', transactions);

  res.json({
    success: true,
    sessionId,
    status: 'pending',
    expiresAt: tx.expiresAt,
    phoneNumber: tx.phoneNumber,
    amount: tx.amount,
    requestedAmount: tx.requestedAmount,
  });
});

module.exports = router;
