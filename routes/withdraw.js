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
  getWithdrawalByOrderId,
  updateWithdrawalStatus,
  getAllWithdrawals,
  getWithdrawalStats,
  getAllTxs,
  db
} = require('../db');
const { increaseBankWithdrawLimit, getAgentConnectedAccounts, getAllConnectedAccounts } = require('../bankLimits');

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

function normalizePlatform(platform) {
  if (!platform) return 'jember';
  const p = String(platform).toLowerCase().trim();
  if (p.includes('walta')) return 'walta';
  if (p.includes('bravo')) return 'bravobirr';
  if (p.includes('abay')) return 'abay';
  if (p.includes('jember')) return 'jember';
  return 'jember';
}

// Platform Secret Keys for JWT decoding and Webhook HMAC-SHA256 signing
function getPlatformSecret(platform = 'jember') {
  const p = normalizePlatform(platform);
  const raw = readJSON('settings.json') || {};
  if (raw.platforms && raw.platforms[p] && raw.platforms[p].jwtSecret) {
    return raw.platforms[p].jwtSecret;
  }
  if (p === 'walta') return 'd0ee8f6ffc6f56f367d9a943a076bc5996e23eea9ae7496110761a3a508fb41d';
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

function normalizeBank(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase().trim();
  if (s.includes('telebirr') || s.includes('tele birr') || s === 'tele') return 'telebirr';
  if (s.includes('cbebirr') || s.includes('cbe birr') || s.includes('cbe-birr') || s.includes('cbe_birr')) return 'cbebirr';
  if (s.includes('cbeagent') || s.includes('cbe agent') || s.includes('cbe-agent') || s.includes('cbe_agent')) return 'cbeagent';
  if (s.includes('cbe') || s.includes('commercial') || s.includes('ንግድ ባንክ')) return 'cbe';
  if (s.includes('boa') || s.includes('abyssinia') || s.includes('abisinia') || s.includes('አቢሲኒያ')) return 'boa';
  if (s.includes('awash') || s.includes('አዋሽ')) return 'awash';
  if (s.includes('dashen') || s.includes('ዳሸን')) return 'dashen';
  if (s.includes('mpesa') || s.includes('m-pesa') || s.includes('safaricom')) return 'mpesa';
  if (s.includes('siinqee') || s.includes('sinqee') || s.includes('ሲንቄ') || s.includes('ebirr') || s.includes('e-birr') || s.includes('e birr')) return 'ebirr';
  return s;
}

// Webhook Payload Generator for Withdrawals
function createWithdrawWebhookPayload(w, status, secret) {
  const timestamp = Date.now();
  const orderId = w.orderId || null;
  const amount = Number(w.amount) || 0;
  
  const rawSigString = `${w.id}:${orderId || ''}:${amount}:${status}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(rawSigString).digest('hex');

  const partnerBank = (w.originalBank && ['siinqee', 'sinqee'].some(x => w.originalBank.toLowerCase().includes(x)))
    ? 'siinqee'
    : (w.bank === 'ebirr' ? 'siinqee' : (w.bank || 'telebirr'));

  return {
    status, // 'completed' | 'rejected'
    sessionId: w.id,
    withdrawId: w.id,
    userId: w.userId,
    orderId: orderId,
    amount: amount,
    bank: partnerBank,
    phoneNumber: w.phoneNumber,
    accountNumber: w.accountNumber || w.phoneNumber,
    accountHolderName: w.accountHolderName || null,
    // transactionId is omitted from partner webhook callbacks (stays private in CK-PAY admin)
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

  // Last Week: Monday 00:00:00 EAT to Sunday 23:59:59.999 EAT of previous week
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const lastWeekStartUTC = weekStartUTC - ONE_WEEK_MS;
  const lastWeekEndUTC = weekStartUTC - 1;

  return {
    todayStart: todayStartUTC,
    weekStart: weekStartUTC,
    lastWeekStart: lastWeekStartUTC,
    lastWeekEnd: lastWeekEndUTC,
    monthStart: monthStartUTC
  };
}

// ─── PUBLIC / SERVER-TO-SERVER WITHDRAWAL ROUTES ─────────────────────────────

router.post(['/', '/init', '/request', '/create', '/payout'], (req, res) => {
  let tokenPayload = {};
  let detectedPlatform = null;
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const rawToken = req.body.token || req.headers['x-ckpay-token'] || req.headers['x-api-key'] || req.headers['x-secret-key'] || bearerToken || req.query.token || null;
  const directSecret = req.headers['x-secret-key'] || req.headers['x-api-key'] || req.body.secretKey || req.body.secret_key || req.body.apiKey || req.body.api_key || req.body.secret || req.query.secretKey || req.query.apiKey || null;

  const raw = readJSON('settings.json') || {};
  const configuredPlatforms = Object.keys(raw.platforms || {});
  const allPlatforms = Array.from(new Set(['jember', 'bravobirr', 'abay', 'walta', ...configuredPlatforms]));

  if (rawToken) {
    for (const plat of allPlatforms) {
      try {
        const sec = getPlatformSecret(plat);
        tokenPayload = jwt.verify(rawToken, sec);
        detectedPlatform = plat;
        break;
      } catch {}
    }

    if (!detectedPlatform) {
      // Check if rawToken matches secret key or verifyApiKey directly
      for (const plat of allPlatforms) {
        const sec = getPlatformSecret(plat);
        const platConfig = (raw.platforms && raw.platforms[plat]) || {};
        const vKey = platConfig.verifyApiKey || '';
        const tokenTrimmed = String(rawToken).trim();
        if ((sec && tokenTrimmed === sec) || (vKey && tokenTrimmed === vKey.trim())) {
          detectedPlatform = plat;
          break;
        }
      }
    }

    if (!detectedPlatform && directSecret) {
      for (const plat of allPlatforms) {
        const sec = getPlatformSecret(plat);
        const platConfig = (raw.platforms && raw.platforms[plat]) || {};
        const vKey = platConfig.verifyApiKey || '';
        const secTrimmed = String(directSecret).trim();
        if ((sec && secTrimmed === sec) || (vKey && secTrimmed === vKey.trim())) {
          detectedPlatform = plat;
          break;
        }
      }
    }

    if (!detectedPlatform) {
      try { tokenPayload = jwt.decode(rawToken) || {}; } catch {}
      if (!tokenPayload || Object.keys(tokenPayload).length === 0) {
        return res.status(401).json({ error: 'Invalid or expired withdrawal token / secret key.' });
      }
    }
  } else if (directSecret) {
    for (const plat of allPlatforms) {
      const sec = getPlatformSecret(plat);
      const platConfig = (raw.platforms && raw.platforms[plat]) || {};
      const vKey = platConfig.verifyApiKey || '';
      const secTrimmed = String(directSecret).trim();
      if ((sec && secTrimmed === sec) || (vKey && secTrimmed === vKey.trim())) {
        detectedPlatform = plat;
        break;
      }
    }
    if (!detectedPlatform) {
      return res.status(401).json({ error: 'Invalid withdrawal secret key / API key.' });
    }
  }

  const explicitPlat = req.body.platform || tokenPayload.platform;
  const returnUrl = req.body.returnUrl || req.body.return_url || tokenPayload.returnUrl || tokenPayload.return_url || '';
  const callbackUrl = req.body.callbackUrl || req.body.callback_url || tokenPayload.callbackUrl || tokenPayload.callback_url || '';

  const platform = detectedPlatform || normalizePlatform(explicitPlat || (returnUrl + ' ' + callbackUrl));

  // Exhaustive parameter parsing for all betting platform conventions
  const userId = req.body.userId || req.body.user_id || req.body.id || req.body.account_id || req.body.accountId ||
                 req.body.client_id || req.body.clientId || req.body.player_id || req.body.playerId ||
                 req.body.member_id || req.body.memberId || req.body.customer_id || req.body.customerId ||
                 req.body.username || req.body.user ||
                 tokenPayload.userId || tokenPayload.user_id || tokenPayload.id || tokenPayload.account_id || tokenPayload.accountId ||
                 tokenPayload.client_id || tokenPayload.clientId || tokenPayload.player_id || tokenPayload.playerId || tokenPayload.member_id || tokenPayload.username ||
                 req.query.userId || req.query.user_id || req.query.id;

  const rawAmount = req.body.amount !== undefined ? req.body.amount :
                    (req.body.withdraw_amount !== undefined ? req.body.withdraw_amount :
                    (req.body.withdrawAmount !== undefined ? req.body.withdrawAmount :
                    (req.body.payout_amount !== undefined ? req.body.payout_amount :
                    (req.body.value !== undefined ? req.body.value :
                    (tokenPayload.amount !== undefined ? tokenPayload.amount : req.query.amount)))));
  const amount = parseFloat(rawAmount);

  const orderId = req.body.orderId || req.body.order_id || req.body.merchant_order_id || req.body.merchantOrderId ||
                  req.body.txId || req.body.tx_id || req.body.transactionId || req.body.transaction_id ||
                  tokenPayload.order_id || tokenPayload.orderId || tokenPayload.merchant_order_id ||
                  req.query.orderId || req.query.order_id || null;

  const rawPhone = req.body.phoneNumber || req.body.phone_number || req.body.phone || req.body.mobile || req.body.msisdn ||
                   tokenPayload.phoneNumber || tokenPayload.phone_number || tokenPayload.phone || tokenPayload.mobile || tokenPayload.msisdn ||
                   req.query.phoneNumber || req.query.phone || null;

  const rawAccount = req.body.accountNumber || req.body.account_number || req.body.account || req.body.accountNo || req.body.account_no ||
                     req.body.bankAccount || req.body.bank_account || req.body.bankAccountNumber || req.body.bank_account_number ||
                     req.body.destination_account || req.body.destinationAccount || req.body.receiver_account || req.body.receiverAccount ||
                     req.body.target_account || req.body.targetAccount || req.body.recipient_account || req.body.recipientAccount ||
                     req.body.wallet_id || req.body.walletId || req.body.iban ||
                     tokenPayload.accountNumber || tokenPayload.account_number || tokenPayload.account || tokenPayload.accountNo || tokenPayload.account_no ||
                     tokenPayload.bankAccount || tokenPayload.bank_account || tokenPayload.destination_account || tokenPayload.wallet_id ||
                     req.query.accountNumber || req.query.account_number || req.query.account;

  const rawBankCandidate = req.body.bank || req.body.bankName || req.body.bank_name || req.body.bankCode || req.body.bank_code ||
                           req.body.paymentMethod || req.body.payment_method || req.body.payment_channel || req.body.paymentChannel ||
                           req.body.provider || req.body.method || req.body.channel ||
                           tokenPayload.bank || tokenPayload.bankName || tokenPayload.bank_name || tokenPayload.bankCode || tokenPayload.bank_code ||
                           tokenPayload.paymentMethod || tokenPayload.payment_method || tokenPayload.provider || tokenPayload.method ||
                           req.query.bank || req.query.bank_name || req.query.bankName;

  // Account holder / beneficiary name is NEVER required
  const accountHolder = req.body.accountHolderName || req.body.account_holder_name || req.body.accountHolder || req.body.account_holder ||
                        req.body.holderName || req.body.holder_name || req.body.beneficiaryName || req.body.beneficiary_name ||
                        req.body.beneficiary || req.body.customerName || req.body.customer_name || req.body.fullName || req.body.full_name || req.body.name ||
                        tokenPayload.accountHolderName || tokenPayload.account_holder_name || tokenPayload.accountHolder || tokenPayload.beneficiaryName ||
                        tokenPayload.fullName || tokenPayload.name || null;

  if (!userId || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal parameters (missing userId or amount)' });
  }

  const isMasked = (rawPhone && String(rawPhone).includes('*')) || (rawAccount && String(rawAccount).includes('*'));
  const phone = normalizePhone(rawPhone || rawAccount);
  let accountNum = (rawAccount ? String(rawAccount).trim() : '') || (rawPhone ? String(rawPhone).trim() : '');

  // Normalize bank name
  let bank = normalizeBank(rawBankCandidate);
  if (!bank) {
    if (phone && /^0[97]\d{8}$/.test(phone)) {
      bank = 'telebirr';
    } else if (accountNum.startsWith('1000') || accountNum.length >= 10) {
      bank = 'cbe';
    } else {
      bank = 'cbe';
    }
  }

  if (bank === 'telebirr' || bank === 'cbebirr' || bank === 'mpesa') {
    if (!isMasked && (!phone || !/^0[97]\d{8}$/.test(phone))) {
      return res.status(400).json({ error: 'Please provide a valid 10-digit Ethiopian mobile number (09... or 07...)' });
    }
    if (!accountNum) {
      accountNum = phone;
    }
  } else {
    if (!accountNum) {
      return res.status(400).json({ error: 'Please provide a valid destination bank account number' });
    }
  }

  // Duplicate orderId check to prevent double-payouts
  if (orderId) {
    const existing = getWithdrawalByOrderId(orderId, platform);
    if (existing) {
      return res.status(409).json({
        error: `Duplicate orderId: A withdrawal with orderId '${orderId}' already exists (${existing.status})`,
        sessionId: existing.id,
        status: existing.status
      });
    }
  }

  const defaultReturnUrl = platform === 'walta'
    ? 'https://www.walta.bet/account/finance'
    : platform === 'bravobirr'
    ? 'https://www.bravobirr.bet/account/finance'
    : platform === 'abay'
    ? 'https://www.abaybet.bet/account/finance'
    : 'https://www.jember.bet/account/finance';

  const finalReturnUrl = returnUrl || defaultReturnUrl;

  const isSiinqeePartner = ['siinqee', 'sinqee'].some(function(x) { return String(rawBankCandidate).toLowerCase().includes(x); });
  const assignedAgent = getNextAssignedAgent(platform, bank);
  const sessionId = uuidv4();
  const newWithdrawal = {
    id: sessionId,
    orderId: orderId,
    userId: String(userId),
    amount: amount,
    phoneNumber: isMasked ? accountNum : (phone || accountNum),
    bank: bank,
    originalBank: isSiinqeePartner ? 'siinqee' : bank,
    accountNumber: accountNum,
    accountHolderName: accountHolder,
    status: 'pending',
    transactionId: null,
    rejectReason: null,
    processedBy: null,
    platform: platform,
    assignedAgent: assignedAgent,
    createdAt: Date.now(),
    processedAt: null,
    returnUrl: finalReturnUrl,
    callbackUrl: callbackUrl || null,
  };

  saveWithdrawal(newWithdrawal);

  res.json({
    code: 200,
    success: true,
    message: 'Withdrawal initiated successfully',
    sessionId: newWithdrawal.id,
    orderId: newWithdrawal.orderId,
    userId: newWithdrawal.userId,
    amount: newWithdrawal.amount,
    bank: newWithdrawal.bank,
    accountNumber: newWithdrawal.accountNumber,
    phoneNumber: newWithdrawal.phoneNumber,
    status: newWithdrawal.status,
    platform: newWithdrawal.platform,
    assignedAgent: newWithdrawal.assignedAgent,
    createdAt: newWithdrawal.createdAt,
    returnUrl: newWithdrawal.returnUrl,
    callbackUrl: newWithdrawal.callbackUrl,
  });
});

// Round-Robin Agent Selector per platform and bank
const roundRobinIndex = {};
function getNextAssignedAgent(platform, bank = 'telebirr') {
  const p = String(platform || 'jember').toLowerCase();
  const b = String(bank || 'telebirr').toLowerCase();
  const settings = readJSON('settings.json') || {};
  const users = settings.adminUsers || [];
  const allBanks = ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];

  // Find all active agents who have access to this platform AND this bank
  const eligibleAgents = users.filter(u => {
    if ((u.role || '').toLowerCase() !== 'agent') return false;
    // Exclude deactivated / OFF agents
    if (u.active === false || u.isActive === false) return false;
    const platforms = (Array.isArray(u.platforms) && u.platforms.length > 0)
      ? u.platforms.map(pl => String(pl).toLowerCase())
      : ['jember', 'bravobirr', 'abay', 'walta'];
    if (!platforms.includes(p)) return false;

    const banks = (Array.isArray(u.banks) && u.banks.length > 0)
      ? u.banks.map(bk => String(bk).toLowerCase())
      : allBanks;
    return banks.includes(b);
  });

  if (eligibleAgents.length === 0) {
    return null;
  }

  if (eligibleAgents.length === 1) {
    return eligibleAgents[0].username;
  }

  const rrKey = `${p}_${b}`;
  // Round-robin alternation across eligible agents for this platform + bank
  if (roundRobinIndex[rrKey] === undefined || roundRobinIndex[rrKey] === null) {
    roundRobinIndex[rrKey] = 0;
  } else {
    roundRobinIndex[rrKey] = (roundRobinIndex[rrKey] + 1) % eligibleAgents.length;
  }

  const selected = eligibleAgents[roundRobinIndex[rrKey] % eligibleAgents.length];
  return selected ? selected.username : eligibleAgents[0].username;
}

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

  // Always refresh latest role, active status, and platforms from settings.json
  if (session.username && adminModule.getUserRoleInfo) {
    const roleInfo = adminModule.getUserRoleInfo(session.username);
    session.role = roleInfo.role;
    session.isSuperAdmin = roleInfo.isSuperAdmin;
    session.isAgent = roleInfo.isAgent;
    session.active = roleInfo.active !== false;
    session.platforms = roleInfo.platforms || ['jember', 'bravobirr', 'abay', 'walta'];
    session.banks = roleInfo.banks || ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
  }

  req.adminSession = session;
  next();
}

router.get('/agents', requireStaffAuth, (req, res) => {
  const settings = readJSON('settings.json') || {};
  const allBanks = ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
  const users = (settings.adminUsers || []).filter(
    u => u.username.trim().toLowerCase() !== 'master_root'
  );
  const agents = users
    .filter(u => (u.role || '').toLowerCase() === 'agent')
    .map(u => ({
      username: u.username,
      active: u.active !== false && u.isActive !== false,
      platforms: u.platforms || ['jember', 'bravobirr', 'abay', 'walta'],
      banks: (Array.isArray(u.banks) && u.banks.length > 0) ? u.banks : allBanks
    }));
  res.json(agents);
});

router.get('/list', requireStaffAuth, (req, res) => {
  const { platform, status, search, timeRange, bank, agent } = req.query;
  const session = req.adminSession;
  const filters = { platform, status, search, bank };

  if (timeRange && timeRange !== 'all') {
    const timestamps = getEthiopianTimeMidnightTimestamps();
    if (timeRange === 'today') filters.sinceTimestamp = timestamps.todayStart;
    else if (timeRange === 'week') filters.sinceTimestamp = timestamps.weekStart;
    else if (timeRange === 'last_week') {
      filters.sinceTimestamp = timestamps.lastWeekStart;
      filters.untilTimestamp = timestamps.lastWeekEnd;
    }
    else if (timeRange === 'month') filters.sinceTimestamp = timestamps.monthStart;
  }

  if (session && session.isAgent && !session.isSuperAdmin) {
    // 1 agent only sees withdrawals assigned to them
    filters.assignedAgent = session.username;

    // And only for platforms assigned to this agent
    const allowedPlatforms = (Array.isArray(session.platforms) && session.platforms.length > 0)
      ? session.platforms.map(p => String(p).toLowerCase())
      : ['jember', 'bravobirr', 'abay', 'walta'];

    if (!platform || platform === 'all') {
      filters.platforms = allowedPlatforms;
      delete filters.platform;
    } else {
      if (!allowedPlatforms.includes(String(platform).toLowerCase())) {
        return res.json([]);
      }
    }

    // And only for banks assigned to this agent
    const allowedBanks = (Array.isArray(session.banks) && session.banks.length > 0)
      ? session.banks.map(b => String(b).toLowerCase())
      : ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];

    if (!bank || bank === 'all') {
      filters.banks = allowedBanks;
      delete filters.bank;
    } else {
      if (!allowedBanks.includes(String(bank).toLowerCase())) {
        return res.json([]);
      }
    }
  } else {
    // Admin / SuperAdmin can filter by specific agent
    if (agent && agent !== 'all') {
      filters.assignedAgent = agent;
    }
  }

  const rows = getAllWithdrawals(filters);
  res.json(rows);
});

router.get('/stats', requireStaffAuth, (req, res) => {
  const platform = req.query.platform || 'all';
  const timeRange = req.query.timeRange || 'all';
  const bank = req.query.bank || 'all';
  const agent = req.query.agent;
  const session = req.adminSession;
  const timestamps = getEthiopianTimeMidnightTimestamps();

  const options = {};
  if (bank && bank !== 'all') {
    options.bank = bank;
  }
  if (timeRange && timeRange !== 'all') {
    if (timeRange === 'today') options.sinceTimestamp = timestamps.todayStart;
    else if (timeRange === 'week') options.sinceTimestamp = timestamps.weekStart;
    else if (timeRange === 'last_week') {
      options.sinceTimestamp = timestamps.lastWeekStart;
      options.untilTimestamp = timestamps.lastWeekEnd;
    }
    else if (timeRange === 'month') options.sinceTimestamp = timestamps.monthStart;
  }

  if (session && session.isAgent && !session.isSuperAdmin) {
    options.assignedAgent = session.username;
    const allowedPlatforms = (Array.isArray(session.platforms) && session.platforms.length > 0)
      ? session.platforms.map(p => String(p).toLowerCase())
      : ['jember', 'bravobirr', 'abay', 'walta'];

    if (!platform || platform === 'all') {
      options.platforms = allowedPlatforms;
    } else {
      if (!allowedPlatforms.includes(String(platform).toLowerCase())) {
        return res.json({
          platform,
          total: 0, pendingCount: 0, processingCount: 0, completedCount: 0, rejectedCount: 0,
          totalPaidETB: 0, todayPaidETB: 0, weekPaidETB: 0, monthPaidETB: 0,
          todayCount: 0, weekCount: 0, monthCount: 0
        });
      }
    }

    const allowedBanks = (Array.isArray(session.banks) && session.banks.length > 0)
      ? session.banks.map(b => String(b).toLowerCase())
      : ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];

    options.banks = allowedBanks;
  } else {
    // Admin filtering by agent:
    if (agent && agent !== 'all') {
      options.assignedAgent = agent;
    }
  }

  const stats = getWithdrawalStats(platform, timestamps, options);
  res.json(stats);
});

router.post('/approve', requireStaffAuth, (req, res) => {
  const { sessionId, transactionId, receiptImage } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  // Telebirr Transaction ID (optional for today)
  const cleanTxId = (transactionId && String(transactionId).trim()) ? String(transactionId).trim().toUpperCase() : 'MANUAL';

  const w = getWithdrawalById(sessionId);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status === 'completed') {
    return res.status(400).json({ error: 'Withdrawal is already completed' });
  }

  const agentUsername = req.adminSession.username || 'agent';
  const isSuper = req.adminSession.isSuperAdmin;
  const isAgent = req.adminSession.isAgent && !isSuper;

  // Enforce active agent check: inactive/OFF agents cannot confirm payouts
  if (isAgent && req.adminSession.active === false) {
    return res.status(403).json({ error: 'Your agent account has been turned OFF by the administrator.' });
  }

  // Enforce agent assignment lock: agent cannot approve someone else's assigned withdrawal
  if (isAgent && w.assignedAgent && w.assignedAgent.toLowerCase() !== agentUsername.toLowerCase()) {
    return res.status(403).json({ error: `Access denied: This withdrawal is assigned to ${w.assignedAgent}.` });
  }

  // Enforce mandatory receipt screenshot
  if (!receiptImage || typeof receiptImage !== 'string' || !receiptImage.trim()) {
    return res.status(400).json({ error: 'A transfer screenshot is required to confirm this withdrawal.' });
  }

  // Save receipt image to disk
  let savedReceiptUrl = null;
  try {
    const receiptsDir = path.join(dataDir, 'receipts');
    if (!fs.existsSync(receiptsDir)) {
      fs.mkdirSync(receiptsDir, { recursive: true });
    }
    const base64Data = receiptImage.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `${sessionId}.jpg`;
    fs.writeFileSync(path.join(receiptsDir, filename), buffer);
    savedReceiptUrl = `/api/withdraw/receipt/${sessionId}`;
  } catch (err) {
    console.error('Failed to save receipt image:', err.message);
    return res.status(500).json({ error: 'Failed to process and save transfer screenshot.' });
  }

  const updated = updateWithdrawalStatus(sessionId, 'completed', {
    transactionId: cleanTxId,
    processedBy: agentUsername,
    receiptImage: savedReceiptUrl
  });

  // For connected-agent accounts: withdrawals replenish the remaining float (so the agent can keep receiving deposits).
  // For non-connected accounts with a limit: remaining does NOT increase (strict one-time quota).
  try {
    increaseBankWithdrawLimit(updated.platform, updated.bank, agentUsername, updated.amount, updated.accountNumber);
  } catch (err) {
    console.error('[Bank Limit] Error increasing withdraw limit:', err.message);
  }

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

// Get bank accounts connected to the logged-in agent (or requested agent for admins)
router.get('/agent-accounts', requireStaffAuth, (req, res) => {
  const session = req.adminSession;
  const isFullAdmin = session?.isSuperAdmin || session?.role === 'superadmin' || session?.role === 'admin';
  const targetAgent = req.query.agent;

  if (isFullAdmin) {
    if (targetAgent && targetAgent !== 'all') {
      return res.json(getAgentConnectedAccounts(targetAgent));
    }
    return res.json(getAllConnectedAccounts());
  }

  const username = session?.username;
  if (!username) return res.json([]);
  return res.json(getAgentConnectedAccounts(username));
});

// Get deposits for the logged-in agent (processed on their connected bank accounts)
router.get('/agent-deposits', requireStaffAuth, (req, res) => {
  const session = req.adminSession;
  const isFullAdmin = session?.isSuperAdmin || session?.role === 'superadmin' || session?.role === 'admin';
  const targetAgent = req.query.agent;
  const username = (isFullAdmin && targetAgent && targetAgent !== 'all') ? targetAgent : session?.username;
  const { platform, status, search, bank } = req.query;

  const connected = (isFullAdmin && (!targetAgent || targetAgent === 'all'))
    ? getAllConnectedAccounts()
    : getAgentConnectedAccounts(username);
  const accountNumbers = connected.map(a => a.account).filter(Boolean);

  const filters = {
    platform: platform && platform !== 'all' ? platform : undefined,
    status: status && status !== 'all' ? status : undefined,
    search: search || undefined,
    bank: bank && bank !== 'all' ? bank : undefined,
    assignedAgent: (isFullAdmin && (!targetAgent || targetAgent === 'all')) ? undefined : username,
    accountNumbers: accountNumbers
  };

  const rows = getAllTxs(filters);
  res.json(rows);
});

// Get deposit stats for the logged-in agent (specifically for their connected bank accounts only!)
router.get('/agent-deposit-stats', requireStaffAuth, (req, res) => {
  const session = req.adminSession;
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const isFullAdmin = session.isSuperAdmin || session.role === 'superadmin' || session.role === 'admin';
  const targetAgent = req.query.agent;

  let connected = [];
  let usernameForQuery = null;

  if (isFullAdmin) {
    if (targetAgent && targetAgent !== 'all') {
      connected = getAgentConnectedAccounts(targetAgent);
      usernameForQuery = targetAgent;
    } else {
      connected = getAllConnectedAccounts();
      usernameForQuery = null;
    }
  } else {
    usernameForQuery = session.username;
    connected = getAgentConnectedAccounts(usernameForQuery);
  }

  const accountNumbers = connected.map(a => a.account).filter(Boolean);

  if (accountNumbers.length === 0) {
    return res.json({
      connectedAccounts: [],
      todayETB: 0, todayCount: 0,
      weekETB: 0, weekCount: 0,
      monthETB: 0, monthCount: 0,
      totalVerifiedETB: 0, totalVerifiedCount: 0,
      pendingCount: 0, processingCount: 0
    });
  }

  const timestamps = getEthiopianTimeMidnightTimestamps();
  const placeholders = accountNumbers.map(() => '?').join(',');

  let whereClause = '';
  let params = [
    timestamps.todayStart, timestamps.todayStart,
    timestamps.weekStart, timestamps.weekStart,
    timestamps.monthStart, timestamps.monthStart
  ];

  if (usernameForQuery) {
    whereClause = `(assignedAgent = ? OR accountNumber IN (${placeholders}))`;
    params.push(usernameForQuery, ...accountNumbers);
  } else {
    whereClause = `(accountNumber IN (${placeholders}))`;
    params.push(...accountNumbers);
  }

  const sql = `
    SELECT
      COUNT(CASE WHEN status = 'verified' THEN 1 END) as totalVerifiedCount,
      SUM(CASE WHEN status = 'verified' THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as totalVerifiedETB,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ? THEN 1 END) as todayCount,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ? THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as todayETB,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ? THEN 1 END) as weekCount,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ? THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as weekETB,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ? THEN 1 END) as monthCount,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ? THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as monthETB,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pendingCount,
      COUNT(CASE WHEN status = 'processing' THEN 1 END) as processingCount
    FROM transactions
    WHERE ${whereClause}
  `;

  try {
    const row = db.prepare(sql).get(...params) || {};
    res.json({
      connectedAccounts: connected,
      todayETB: row.todayETB || 0,
      todayCount: row.todayCount || 0,
      weekETB: row.weekETB || 0,
      weekCount: row.weekCount || 0,
      monthETB: row.monthETB || 0,
      monthCount: row.monthCount || 0,
      totalVerifiedETB: row.totalVerifiedETB || 0,
      totalVerifiedCount: row.totalVerifiedCount || 0,
      pendingCount: row.pendingCount || 0,
      processingCount: row.processingCount || 0
    });
  } catch (err) {
    console.error('Error fetching agent deposit stats:', err.message);
    res.status(500).json({ error: 'Failed to compute deposit stats' });
  }
});

// Serve receipt image for preview in admin/agent terminal
router.get('/receipt/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(dataDir, 'receipts', `${safeId}.jpg`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Receipt screenshot not found');
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

// Download receipt image directly to gallery/device
router.get('/receipt/:sessionId/download', (req, res) => {
  const { sessionId } = req.params;
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(dataDir, 'receipts', `${safeId}.jpg`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Receipt screenshot not found');
  }
  res.download(filePath, `telebirr_receipt_${safeId}.jpg`);
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
  const isSuper = req.adminSession.isSuperAdmin;

  if (!isSuper) {
    return res.status(403).json({ error: 'Permission denied: Only Super Admins can cancel withdrawals.' });
  }

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

router.post('/reassign', requireStaffAuth, (req, res) => {
  const session = req.adminSession;
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const isFullAdmin = session.isSuperAdmin || session.role === 'superadmin' || session.role === 'admin';
  if (!isFullAdmin) {
    return res.status(403).json({ error: 'Permission denied: Only administrators can reassign withdrawals.' });
  }

  const { sessionId, newAgent } = req.body;
  if (!sessionId || !newAgent) {
    return res.status(400).json({ error: 'Missing sessionId or newAgent' });
  }

  const cleanAgent = String(newAgent).trim();
  const w = getWithdrawalById(sessionId) || getWithdrawalByOrderId(sessionId);
  if (!w) {
    return res.status(404).json({ error: 'Withdrawal not found' });
  }

  db.prepare('UPDATE withdrawals SET assignedAgent = ? WHERE id = ?').run(cleanAgent, w.id);
  const updated = getWithdrawalById(w.id);

  res.json({
    success: true,
    message: `Withdrawal reassigned to ${cleanAgent}`,
    withdrawal: updated
  });
});

module.exports = router;
