const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'database.sqlite');
const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for high concurrent write performance
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    orderId TEXT,
    userId TEXT NOT NULL,
    requestedAmount REAL NOT NULL,
    amount REAL NOT NULL,
    verifiedAmount REAL,
    phoneNumber TEXT NOT NULL,
    status TEXT NOT NULL,
    transactionId TEXT,
    failReason TEXT,
    receipt TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    submittedAt INTEGER,
    returnUrl TEXT,
    callbackUrl TEXT,
    platform TEXT NOT NULL DEFAULT 'jember'
  );

  CREATE INDEX IF NOT EXISTS idx_userId ON transactions(userId);
  CREATE INDEX IF NOT EXISTS idx_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactionId ON transactions(transactionId);

  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    orderId TEXT,
    userId TEXT NOT NULL,
    amount REAL NOT NULL,
    phoneNumber TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    transactionId TEXT,
    rejectReason TEXT,
    processedBy TEXT,
    platform TEXT NOT NULL DEFAULT 'jember',
    createdAt INTEGER NOT NULL,
    processedAt INTEGER,
    returnUrl TEXT,
    callbackUrl TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_w_status ON withdrawals(status);
  CREATE INDEX IF NOT EXISTS idx_w_platform ON withdrawals(platform);
  CREATE INDEX IF NOT EXISTS idx_w_userId ON withdrawals(userId);
  CREATE INDEX IF NOT EXISTS idx_w_createdAt ON withdrawals(createdAt);
`);

// Safe column migration for existing databases
try {
  const tableInfo = db.prepare(`PRAGMA table_info(transactions)`).all();
  const hasPlatform = tableInfo.some(col => col.name === 'platform');
  if (!hasPlatform) {
    db.exec(`ALTER TABLE transactions ADD COLUMN platform TEXT NOT NULL DEFAULT 'jember'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_platform ON transactions(platform)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_platform_status ON transactions(platform, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_user_plat_status ON transactions(userId, platform, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_status_expires ON transactions(status, expiresAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_status_submitted ON transactions(status, submittedAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_plat_stat_created ON transactions(platform, status, createdAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_plat_stat_phone ON transactions(platform, status, phoneNumber, createdAt)`);
} catch (e) {
  console.error('Migration index notice:', e.message);
}

// Helper functions for Database Access
const stmtInsertTx = db.prepare(`
  INSERT OR REPLACE INTO transactions (
    id, orderId, userId, requestedAmount, amount, verifiedAmount,
    phoneNumber, status, transactionId, failReason, receipt,
    createdAt, expiresAt, submittedAt, returnUrl, callbackUrl, platform
  ) VALUES (
    @id, @orderId, @userId, @requestedAmount, @amount, @verifiedAmount,
    @phoneNumber, @status, @transactionId, @failReason, @receipt,
    @createdAt, @expiresAt, @submittedAt, @returnUrl, @callbackUrl, @platform
  )
`);

function saveTx(tx) {
  const row = {
    id: tx.id,
    orderId: tx.orderId || null,
    userId: String(tx.userId),
    requestedAmount: Number(tx.requestedAmount || tx.amount),
    amount: Number(tx.amount),
    verifiedAmount: tx.verifiedAmount !== undefined ? Number(tx.verifiedAmount) : null,
    phoneNumber: String(tx.phoneNumber),
    status: String(tx.status),
    transactionId: tx.transactionId ? String(tx.transactionId).trim().toUpperCase() : null,
    failReason: tx.failReason || null,
    receipt: tx.receipt ? (typeof tx.receipt === 'string' ? tx.receipt : JSON.stringify(tx.receipt)) : null,
    createdAt: Number(tx.createdAt || Date.now()),
    expiresAt: Number(tx.expiresAt || Date.now() + 20 * 60 * 1000),
    submittedAt: tx.submittedAt ? Number(tx.submittedAt) : null,
    returnUrl: tx.returnUrl || null,
    callbackUrl: tx.callbackUrl || null,
    platform: String(tx.platform || 'jember').toLowerCase(),
  };
  stmtInsertTx.run(row);
}

function getTxById(id) {
  const row = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function getTxByCleanTxId(txId) {
  if (!txId) return null;
  const clean = String(txId).trim().toUpperCase();
  const row = db.prepare(`SELECT * FROM transactions WHERE UPPER(transactionId) = ? AND status = 'verified'`).get(clean);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function getActivePendingTx(userId, platform = 'jember') {
  const now = Date.now();
  const row = db.prepare(`
    SELECT * FROM transactions
    WHERE userId = ? AND platform = ? AND status = 'pending' AND expiresAt > ?
    ORDER BY createdAt DESC LIMIT 1
  `).get(String(userId), String(platform).toLowerCase(), now);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function expireOldPendingTxs(userId, platform = 'jember') {
  db.prepare(`UPDATE transactions SET status = 'expired' WHERE userId = ? AND platform = ? AND status = 'pending'`)
    .run(String(userId), String(platform).toLowerCase());
}

function expireAllOldPendingTxs() {
  const now = Date.now();
  db.prepare(`UPDATE transactions SET status = 'expired' WHERE status = 'pending' AND expiresAt < ?`).run(now);
  db.prepare(`UPDATE transactions SET status = 'failed', failReason = 'Verification timeout' WHERE status = 'processing' AND submittedAt < ?`).run(now - 30000);
}

function updateTx(id, fields = {}) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getTxById(id);

  const setClauses = [];
  const params = [];

  for (const k of keys) {
    if (k === 'receipt' && typeof fields[k] === 'object' && fields[k] !== null) {
      setClauses.push(`receipt = ?`);
      params.push(JSON.stringify(fields[k]));
    } else if (k === 'transactionId' && fields[k]) {
      setClauses.push(`transactionId = ?`);
      params.push(String(fields[k]).trim().toUpperCase());
    } else {
      setClauses.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }

  params.push(id);
  db.prepare(`UPDATE transactions SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  return getTxById(id);
}

function updatePendingTxPhone(platform, oldPhone, newPhone) {
  if (!oldPhone || !newPhone) return;
  db.prepare(`
    UPDATE transactions SET phoneNumber = ?
    WHERE platform = ? AND status = 'pending' AND phoneNumber = ?
  `).run(newPhone, String(platform).toLowerCase(), oldPhone);
}

function getAllTxs(filters = {}) {
  // Always clean up expired sessions first so only truly active sessions show as pending
  expireAllOldPendingTxs();

  let sql = `SELECT * FROM transactions`;
  const conditions = [];
  const params = [];

  if (filters.platform && filters.platform !== 'all') {
    conditions.push(`platform = ?`);
    params.push(String(filters.platform).toLowerCase());
  }

  if (filters.status && filters.status !== 'all') {
    conditions.push(`status = ?`);
    params.push(filters.status);
  }

  if (filters.search) {
    conditions.push(`(userId LIKE ? OR transactionId LIKE ? OR phoneNumber LIKE ? OR id LIKE ?)`);
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY createdAt DESC LIMIT 1000`;

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    ...r,
    receipt: r.receipt ? JSON.parse(r.receipt) : null,
  }));
}

function getStats(platform = 'all', timestamps = {}) {
  let whereClause = '';
  const params = [];

  if (platform && platform !== 'all') {
    whereClause = ' WHERE platform = ?';
    params.push(String(platform).toLowerCase());
  }

  const todayStart = Number(timestamps.todayStart) || 0;
  const weekStart = Number(timestamps.weekStart) || 0;
  const monthStart = Number(timestamps.monthStart) || 0;

  const sql = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'verified' THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as totalETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${todayStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as todayETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${weekStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as weekETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${monthStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as monthETB,
      COUNT(CASE WHEN status = 'verified' THEN 1 END) as verified,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${todayStart} THEN 1 END) as todayCount,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${weekStart} THEN 1 END) as weekCount,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${monthStart} THEN 1 END) as monthCount,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired
    FROM transactions${whereClause}
  `;

  const row = db.prepare(sql).get(...params) || {};

  return {
    platform,
    total: row.total || 0,
    todayCount: row.todayCount || 0,
    weekCount: row.weekCount || 0,
    monthCount: row.monthCount || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    verified: row.verified || 0,
    failed: row.failed || 0,
    expired: row.expired || 0,
    totalETB: row.totalETB || 0,
    todayETB: row.todayETB || 0,
    weekETB: row.weekETB || 0,
    monthETB: row.monthETB || 0,
  };
}

// ─── WITHDRAWAL HELPER FUNCTIONS ─────────────────────────────────────────────
const stmtInsertWithdrawal = db.prepare(`
  INSERT OR REPLACE INTO withdrawals (
    id, orderId, userId, amount, phoneNumber, status,
    transactionId, rejectReason, processedBy, platform,
    createdAt, processedAt, returnUrl, callbackUrl
  ) VALUES (
    @id, @orderId, @userId, @amount, @phoneNumber, @status,
    @transactionId, @rejectReason, @processedBy, @platform,
    @createdAt, @processedAt, @returnUrl, @callbackUrl
  )
`);

function saveWithdrawal(w) {
  const row = {
    id: w.id,
    orderId: w.orderId || null,
    userId: String(w.userId),
    amount: Number(w.amount),
    phoneNumber: String(w.phoneNumber),
    status: String(w.status || 'pending'),
    transactionId: w.transactionId ? String(w.transactionId).trim().toUpperCase() : null,
    rejectReason: w.rejectReason || null,
    processedBy: w.processedBy || null,
    platform: String(w.platform || 'jember').toLowerCase(),
    createdAt: Number(w.createdAt || Date.now()),
    processedAt: w.processedAt ? Number(w.processedAt) : null,
    returnUrl: w.returnUrl || null,
    callbackUrl: w.callbackUrl || null,
  };
  stmtInsertWithdrawal.run(row);
  return row;
}

function getWithdrawalById(id) {
  return db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(id) || null;
}

function updateWithdrawalStatus(id, status, { transactionId = null, rejectReason = null, processedBy = null } = {}) {
  const now = Date.now();
  db.prepare(`
    UPDATE withdrawals
    SET status = ?,
        transactionId = COALESCE(?, transactionId),
        rejectReason = COALESCE(?, rejectReason),
        processedBy = COALESCE(?, processedBy),
        processedAt = ?
    WHERE id = ?
  `).run(status, transactionId, rejectReason, processedBy, now, id);
  return getWithdrawalById(id);
}

function getAllWithdrawals(filters = {}) {
  let sql = `SELECT * FROM withdrawals`;
  const conditions = [];
  const params = [];

  if (filters.platform && filters.platform !== 'all') {
    conditions.push(`platform = ?`);
    params.push(String(filters.platform).toLowerCase());
  }

  if (filters.status && filters.status !== 'all') {
    conditions.push(`status = ?`);
    params.push(filters.status);
  }

  if (filters.search) {
    conditions.push(`(userId LIKE ? OR phoneNumber LIKE ? OR transactionId LIKE ? OR orderId LIKE ? OR id LIKE ?)`);
    const term = `%${filters.search}%`;
    params.push(term, term, term, term, term);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY createdAt DESC LIMIT 1000`;
  return db.prepare(sql).all(...params);
}

function getWithdrawalStats(platform = 'all', timestamps = {}) {
  let whereClause = '';
  const params = [];

  if (platform && platform !== 'all') {
    whereClause = ' WHERE platform = ?';
    params.push(String(platform).toLowerCase());
  }

  const todayStart = Number(timestamps.todayStart) || 0;
  const weekStart = Number(timestamps.weekStart) || 0;
  const monthStart = Number(timestamps.monthStart) || 0;

  const sql = `
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pendingCount,
      COUNT(CASE WHEN status = 'processing' THEN 1 END) as processingCount,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completedCount,
      COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejectedCount,
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as totalPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${todayStart} THEN amount ELSE 0 END) as todayPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${weekStart} THEN amount ELSE 0 END) as weekPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${monthStart} THEN amount ELSE 0 END) as monthPaidETB,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${todayStart} THEN 1 END) as todayCount,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${weekStart} THEN 1 END) as weekCount,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${monthStart} THEN 1 END) as monthCount
    FROM withdrawals${whereClause}
  `;

  const row = db.prepare(sql).get(...params) || {};
  return {
    platform,
    total: row.total || 0,
    pendingCount: row.pendingCount || 0,
    processingCount: row.processingCount || 0,
    completedCount: row.completedCount || 0,
    rejectedCount: row.rejectedCount || 0,
    totalPaidETB: row.totalPaidETB || 0,
    todayPaidETB: row.todayPaidETB || 0,
    weekPaidETB: row.weekPaidETB || 0,
    monthPaidETB: row.monthPaidETB || 0,
    todayCount: row.todayCount || 0,
    weekCount: row.weekCount || 0,
    monthCount: row.monthCount || 0,
  };
}

module.exports = {
  db,
  saveTx,
  updateTx,
  updatePendingTxPhone,
  getTxById,
  getTxByCleanTxId,
  getActivePendingTx,
  expireOldPendingTxs,
  expireAllOldPendingTxs,
  getAllTxs,
  getStats,
  saveWithdrawal,
  getWithdrawalById,
  updateWithdrawalStatus,
  getAllWithdrawals,
  getWithdrawalStats,
};
