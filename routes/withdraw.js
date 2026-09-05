const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  saveWithdrawal,
  getWithdrawalById,
  updateWithdrawalStatus,
  getAllWithdrawals,
  getWithdrawalStats
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

// Platform Secret Keys for JWT decoding and Webhook HMAC-SHA256 signing
function getPlatformSecret(platform = 'jember') {
  const p = String(platform || 'jember').toLowerCase();
  const raw = readJSON('settings.json') || {};
  if (raw.platforms && raw.platforms[p] && raw.platforms[p].jwtSecret) {
    return raw.platforms[p].jwtSecret;
  }
  if (p === 'bravobirr') return '6c4cc37b91b419beba46e4d950199a02b8f99c1e4e0ace11ff01999a4dd7c6fe';
  if (p === 'abay') return '7f97e97c37042d344dd3be0371b3f490e3e7e2b5c7f226bbde726271dd9fa366';
  return process.env.JWT_SECRET || '4fec6686d2b93ceca92531ed08dbdc48cf0b937965ebbf51b144d8f055f5d004fd85c8518ef72a1d61634949884c4346';
}

function normalizePhone(str) {
  if (!str) return '';
  let s = String(str).replace(/\D/g, '');
  if (s.startsWith('251') && s.length === 12) s = '0' + s.slice(3);
  if (s.startsWith('9') && s.length === 9) s = '0' + s;
  if (s.startsWith('7') && s.length === 9) s = '0' + s;
  return s;
}

// Webhook Payload Generator for Withdrawals
function createWithdrawWebhookPayload(w, status, secret) {
  const timestamp = Date.now();
  const orderId = w.orderId || null;
  const amount = Number(w.amount) || 0;
  
  const rawSigString = `${w.id}:${orderId || ''}:${amount}:${status}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(rawSigString).digest('hex');

  return {
    status, // 'completed' | 'rejected'
    sessionId: w.id,
    withdrawId: w.id,
    userId: w.userId,
    orderId: orderId,
    amount: amount,
    phoneNumber: w.phoneNumber,
    transactionId: w.transactionId || null,
    rejectReason: w.rejectReason || null,
    processedBy: w.processedBy || null,
    platform: w.platform,
    timestamp: timestamp,
    signature: signature
  };
}

// Webhook Dispatcher with 3x retry
async function sendWebhookWithRetry(callbackUrl, payload, maxRetries = 3) {
  if (!callbackUrl) return false;

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
        console.log(`Withdrawal Webhook delivered to ${callbackUrl} (Attempt ${attempt})`);
        return true;
      }
    } catch (err) {
      console.error(`Withdrawal Webhook attempt ${attempt} error:`, err.message);
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  return false;
}

// Helper: Ethiopian Time Calculation for Midnights
function getEthiopianTimeMidnightTimestamps() {
  const now = Date.now();
  const ETHIOPIA_OFFSET_MS = 3 * 60 * 60 * 1000;
  const eatDate = new Date(now + ETHIOPIA_OFFSET_MS);

  const year = eatDate.getUTCFullYear();
  const month = eatDate.getUTCMonth();
  const day = eatDate.getUTCDate();

  const todayStartUTC = Date.UTC(year, month, day) - ETHIOPIA_OFFSET_MS;
  const dayOfWeek = eatDate.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStartUTC = todayStartUTC - (daysFromMonday * 24 * 60 * 60 * 1000);
  const monthStartUTC = Date.UTC(year, month, 1) - ETHIOPIA_OFFSET_MS;

  return { todayStart: todayStartUTC, weekStart: weekStartUTC, monthStart: monthStartUTC };
}

// ─── PUBLIC / SERVER-TO-SERVER WITHDRAWAL ROUTES ─────────────────────────────

router.post(['/init', '/request'], (req, res) => {
  let tokenPayload = {};
  let detectedPlatform = null;
  const rawToken = req.body.token || req.headers['x-ckpay-token'] || null;

  if (rawToken) {
    const raw = readJSON('settings.json') || {};
    const configuredPlatforms = Object.keys(raw.platforms || {});
    const allPlatforms = Array.from(new Set(['jember', 'bravobirr', 'abay', ...configuredPlatforms]));

    for (const plat of allPlatforms) {
      try {
        const sec = getPlatformSecret(plat);
        tokenPayload = jwt.verify(rawToken, sec);
        detectedPlatform = plat;
        break;
      } catch {}
    }

    if (!detectedPlatform) {
      try { tokenPayload = jwt.decode(rawToken) || {}; } catch {}
      return res.status(401).json({ error: 'Invalid or expired withdrawal token.' });
    }
  }

  const explicitPlat = req.body.platform || tokenPayload.platform;
  const returnUrl = req.body.returnUrl || req.body.return_url || tokenPayload.returnUrl || tokenPayload.return_url || '';
  const callbackUrl = req.body.callbackUrl || req.body.callback_url || tokenPayload.callbackUrl || tokenPayload.callback_url || '';

  const platform = detectedPlatform || (
    explicitPlat && ['jember', 'bravobirr', 'abay'].includes(String(explicitPlat).toLowerCase())
      ? String(explicitPlat).toLowerCase()
      : (returnUrl + ' ' + callbackUrl).includes('bravobirr') ? 'bravobirr'
      : (returnUrl + ' ' + callbackUrl).includes('abay') ? 'abay'
      : 'jember'
  );

  const userId = req.body.userId || req.body.account_id || tokenPayload.userId || tokenPayload.id || tokenPayload.account_id;
  const amount = Number(req.body.amount || tokenPayload.amount);
  const rawPhone = req.body.phoneNumber || req.body.phone || tokenPayload.phoneNumber || tokenPayload.phone;
  const orderId = req.body.orderId || req.body.order_id || tokenPayload.orderId || tokenPayload.order_id || null;

  if (!userId || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal parameters (missing userId or amount)' });
  }

  const phone = normalizePhone(rawPhone);
  if (!phone || !/^0[97]\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Please provide a valid 10-digit Ethiopian mobile number (09... or 07...)' });
  }

  const defaultReturnUrl = platform === 'bravobirr'
    ? 'https://www.bravobirr.bet/account/finance'
    : platform === 'abay'
    ? 'https://www.abaybet.bet/account/finance'
    : 'https://www.jember.bet/account/finance';

  const finalReturnUrl = returnUrl || defaultReturnUrl;

  const sessionId = uuidv4();
  const newWithdrawal = {
    id: sessionId,
    orderId: orderId,
    userId: String(userId),
    amount: amount,
    phoneNumber: phone,
    status: 'pending',
    transactionId: null,
    rejectReason: null,
    processedBy: null,
    platform: platform,
    createdAt: Date.now(),
    processedAt: null,
    returnUrl: finalReturnUrl,
    callbackUrl: callbackUrl || null,
  };

  saveWithdrawal(newWithdrawal);

  res.json({
    sessionId: newWithdrawal.id,
    orderId: newWithdrawal.orderId,
    userId: newWithdrawal.userId,
    amount: newWithdrawal.amount,
    phoneNumber: newWithdrawal.phoneNumber,
    status: newWithdrawal.status,
    platform: newWithdrawal.platform,
    createdAt: newWithdrawal.createdAt,
    returnUrl: newWithdrawal.returnUrl,
    callbackUrl: newWithdrawal.callbackUrl,
  });
});

router.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const w = getWithdrawalById(sessionId);
  if (!w) {
    return res.status(404).json({ error: 'Withdrawal session not found' });
  }
  res.json(w);
});

router.post('/cancel', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const w = getWithdrawalById(sessionId);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') {
    return res.status(400).json({ error: `Cannot cancel a withdrawal that is already ${w.status}` });
  }

  const updated = updateWithdrawalStatus(sessionId, 'rejected', {
    rejectReason: 'Cancelled by user',
    processedBy: 'user'
  });

  if (updated.callbackUrl) {
    const secret = getPlatformSecret(updated.platform);
    const payload = createWithdrawWebhookPayload(updated, 'rejected', secret);
    sendWebhookWithRetry(updated.callbackUrl, payload);
  }

  res.json({ success: true, withdrawal: updated });
});

// ─── AGENT & ADMIN AUTHENTICATED ROUTES ─────────────────────────────────────
const adminModule = require('./admin');

function requireStaffAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const session = adminModule.activeSessions ? adminModule.activeSessions.get(token) : null;
  if (!session || Date.now() > session.expiresAt) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.adminSession = session;
  next();
}

router.get('/list', requireStaffAuth, (req, res) => {
  const { platform, status, search } = req.query;
  const rows = getAllWithdrawals({ platform, status, search });
  res.json(rows);
});

router.get('/stats', requireStaffAuth, (req, res) => {
  const platform = req.query.platform || 'all';
  const timestamps = getEthiopianTimeMidnightTimestamps();
  const stats = getWithdrawalStats(platform, timestamps);
  res.json(stats);
});

router.post('/approve', requireStaffAuth, (req, res) => {
  const { sessionId, transactionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const w = getWithdrawalById(sessionId);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status === 'completed') {
    return res.status(400).json({ error: 'Withdrawal is already completed' });
  }

  const agentUsername = req.adminSession.username || 'agent';
  const updated = updateWithdrawalStatus(sessionId, 'completed', {
    transactionId: transactionId ? String(transactionId).trim().toUpperCase() : `TB_MANUAL_${Date.now()}`,
    processedBy: agentUsername
  });

  if (updated.callbackUrl) {
    const secret = getPlatformSecret(updated.platform);
    const payload = createWithdrawWebhookPayload(updated, 'completed', secret);
    sendWebhookWithRetry(updated.callbackUrl, payload);
  }

  res.json({
    success: true,
    message: `Withdrawal approved by ${agentUsername}`,
    withdrawal: updated
  });
});

router.post('/reject', requireStaffAuth, (req, res) => {
  const { sessionId, rejectReason } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const w = getWithdrawalById(sessionId);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status === 'completed') {
    return res.status(400).json({ error: 'Cannot reject an already completed withdrawal' });
  }

  const agentUsername = req.adminSession.username || 'agent';
  const reason = rejectReason ? String(rejectReason).trim() : 'Rejected by payout agent';

  const updated = updateWithdrawalStatus(sessionId, 'rejected', {
    rejectReason: reason,
    processedBy: agentUsername
  });

  if (updated.callbackUrl) {
    const secret = getPlatformSecret(updated.platform);
    const payload = createWithdrawWebhookPayload(updated, 'rejected', secret);
    sendWebhookWithRetry(updated.callbackUrl, payload);
  }

  res.json({
    success: true,
    message: `Withdrawal rejected by ${agentUsername}`,
    withdrawal: updated
  });
});

module.exports = router;
