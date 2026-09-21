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
    platform TEXT NOT NULL DEFAULT 'jember',
    bank TEXT NOT NULL DEFAULT 'telebirr',
    accountNumber TEXT
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
    callbackUrl TEXT,
    assignedAgent TEXT,
    receiptImage TEXT,
    bank TEXT NOT NULL DEFAULT 'telebirr',
    accountNumber TEXT,
    accountHolderName TEXT
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

  const hasBank = tableInfo.some(col => col.name === 'bank');
  if (!hasBank) {
    db.exec(`ALTER TABLE transactions ADD COLUMN bank TEXT NOT NULL DEFAULT 'telebirr'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_bank ON transactions(bank)`);

  const hasAccountNumber = tableInfo.some(col => col.name === 'accountNumber');
  if (!hasAccountNumber) {
    db.exec(`ALTER TABLE transactions ADD COLUMN accountNumber TEXT`);
  }

  const wTableInfo = db.prepare(`PRAGMA table_info(withdrawals)`).all();
  const hasAssignedAgent = wTableInfo.some(col => col.name === 'assignedAgent');
  if (!hasAssignedAgent) {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN assignedAgent TEXT`);
  }
  const hasReceiptImage = wTableInfo.some(col => col.name === 'receiptImage');
  if (!hasReceiptImage) {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN receiptImage TEXT`);
  }
  const hasWBank = wTableInfo.some(col => col.name === 'bank');
  if (!hasWBank) {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN bank TEXT NOT NULL DEFAULT 'telebirr'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_w_bank ON withdrawals(bank)`);

  const hasWAccountNumber = wTableInfo.some(col => col.name === 'accountNumber');
  if (!hasWAccountNumber) {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN accountNumber TEXT`);
  }
  const hasWAccountHolder = wTableInfo.some(col => col.name === 'accountHolderName');
  if (!hasWAccountHolder) {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN accountHolderName TEXT`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_w_assignedAgent ON withdrawals(assignedAgent)`);
} catch (e) {
  console.error('Migration index notice:', e.message);
}

// Helper functions for Database Access
const stmtInsertTx = db.prepare(`
  INSERT OR REPLACE INTO transactions (
    id, orderId, userId, requestedAmount, amount, verifiedAmount,
    phoneNumber, status, transactionId, failReason, receipt,
    createdAt, expiresAt, submittedAt, returnUrl, callbackUrl, platform, bank, accountNumber
  ) VALUES (
    @id, @orderId, @userId, @requestedAmount, @amount, @verifiedAmount,
    @phoneNumber, @status, @transactionId, @failReason, @receipt,
    @createdAt, @expiresAt, @submittedAt, @returnUrl, @callbackUrl, @platform, @bank, @accountNumber
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
    phoneNumber: String(tx.phoneNumber || ''),
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
    bank: String(tx.bank || 'telebirr').toLowerCase(),
    accountNumber: tx.accountNumber ? String(tx.accountNumber).trim() : null,
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
  // Block if already verified OR currently being processed to eliminate race conditions/double credits
  const row = db.prepare(`SELECT * FROM transactions WHERE UPPER(transactionId) = ? AND status IN ('verified', 'processing')`).get(clean);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function getTxByOrderId(orderId) {
  if (!orderId) return null;
  const row = db.prepare(`SELECT * FROM transactions WHERE orderId = ? ORDER BY createdAt DESC LIMIT 1`).get(String(orderId));
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function getActivePendingTx(userId, platform = 'jember', amount = null) {
  const now = Date.now();
  // Include both pending AND processing transactions so browser refresh preserves the session
  let sql = `SELECT * FROM transactions WHERE userId = ? AND platform = ? AND status IN ('pending', 'processing') AND expiresAt > ?`;
  const params = [String(userId), String(platform).toLowerCase(), now];
  if (amount) {
    sql += ` AND amount = ?`;
    params.push(Number(amount));
  }
  sql += ` ORDER BY createdAt DESC LIMIT 1`;
  const row = db.prepare(sql).get(...params);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function updateTxStatus(id, status, updates = {}) {
  const fields = ['status = ?'];
  const params = [status];

  if (updates.transactionId !== undefined) {
    fields.push('transactionId = ?');
    params.push(updates.transactionId ? String(updates.transactionId).trim().toUpperCase() : null);
  }
  if (updates.failReason !== undefined) {
    fields.push('failReason = ?');
    params.push(updates.failReason || null);
  }
  if (updates.submittedAt !== undefined) {
    fields.push('submittedAt = ?');
    params.push(updates.submittedAt ? Number(updates.submittedAt) : null);
  }
  if (updates.verifiedAmount !== undefined) {
    fields.push('verifiedAmount = ?');
    params.push(updates.verifiedAmount !== null ? Number(updates.verifiedAmount) : null);
  }
  if (updates.amount !== undefined) {
    fields.push('amount = ?');
    params.push(Number(updates.amount));
  }
  if (updates.receipt !== undefined) {
    fields.push('receipt = ?');
    params.push(updates.receipt ? (typeof updates.receipt === 'string' ? updates.receipt : JSON.stringify(updates.receipt)) : null);
  }
  if (updates.phoneNumber !== undefined) {
    fields.push('phoneNumber = ?');
    params.push(String(updates.phoneNumber));
  }

  params.push(String(id));
  const sql = `UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...params);
  return getTxById(id);
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

  if (filters.bank && filters.bank !== 'all') {
    conditions.push(`bank = ?`);
    params.push(String(filters.bank).toLowerCase());
  }

  if (filters.search) {
    conditions.push(`(userId LIKE ? OR transactionId LIKE ? OR phoneNumber LIKE ? OR id LIKE ? OR accountNumber LIKE ?)`);
    const term = `%${filters.search}%`;
    params.push(term, term, term, term, term);
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
  const lastWeekStart = Number(timestamps.lastWeekStart) || 0;
  const lastWeekEnd = Number(timestamps.lastWeekEnd) || 0;
  const monthStart = Number(timestamps.monthStart) || 0;

  const sql = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'verified' THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as totalETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${todayStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as todayETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${weekStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as weekETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${lastWeekStart} AND createdAt <= ${lastWeekEnd} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as lastWeekETB,
      SUM(CASE WHEN status = 'verified' AND createdAt >= ${monthStart} THEN COALESCE(verifiedAmount, amount, 0) ELSE 0 END) as monthETB,
      COUNT(CASE WHEN status = 'verified' THEN 1 END) as verified,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${todayStart} THEN 1 END) as todayCount,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${weekStart} THEN 1 END) as weekCount,
      COUNT(CASE WHEN status = 'verified' AND createdAt >= ${lastWeekStart} AND createdAt <= ${lastWeekEnd} THEN 1 END) as lastWeekCount,
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
    lastWeekCount: row.lastWeekCount || 0,
    monthCount: row.monthCount || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    verified: row.verified || 0,
    failed: row.failed || 0,
    expired: row.expired || 0,
    totalETB: row.totalETB || 0,
    todayETB: row.todayETB || 0,
    weekETB: row.weekETB || 0,
    lastWeekETB: row.lastWeekETB || 0,
    monthETB: row.monthETB || 0,
  };
}

// ─── WITHDRAWAL HELPER FUNCTIONS ─────────────────────────────────────────────
const stmtInsertWithdrawal = db.prepare(`
  INSERT OR REPLACE INTO withdrawals (
    id, orderId, userId, amount, phoneNumber, status,
    transactionId, rejectReason, processedBy, platform,
    createdAt, processedAt, returnUrl, callbackUrl, assignedAgent, receiptImage,
    bank, accountNumber, accountHolderName
  ) VALUES (
    @id, @orderId, @userId, @amount, @phoneNumber, @status,
    @transactionId, @rejectReason, @processedBy, @platform,
    @createdAt, @processedAt, @returnUrl, @callbackUrl, @assignedAgent, @receiptImage,
    @bank, @accountNumber, @accountHolderName
  )
`);

function saveWithdrawal(w) {
  const row = {
    id: w.id,
    orderId: w.orderId || null,
    userId: String(w.userId),
    amount: Number(w.amount),
    phoneNumber: String(w.phoneNumber || ''),
    status: String(w.status || 'pending'),
    transactionId: w.transactionId ? String(w.transactionId).trim().toUpperCase() : null,
    rejectReason: w.rejectReason || null,
    processedBy: w.processedBy || null,
    platform: String(w.platform || 'jember').toLowerCase(),
    createdAt: Number(w.createdAt || Date.now()),
    processedAt: w.processedAt ? Number(w.processedAt) : null,
    returnUrl: w.returnUrl || null,
    callbackUrl: w.callbackUrl || null,
    assignedAgent: w.assignedAgent ? String(w.assignedAgent).trim() : null,
    receiptImage: w.receiptImage || null,
    bank: String(w.bank || 'telebirr').toLowerCase(),
    accountNumber: w.accountNumber ? String(w.accountNumber).trim() : null,
    accountHolderName: w.accountHolderName ? String(w.accountHolderName).trim() : null,
  };
  stmtInsertWithdrawal.run(row);
  return row;
}

function getWithdrawalById(id) {
  return db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(id) || null;
}

function getWithdrawalByOrderId(orderId, platform = null) {
  if (!orderId) return null;
  if (platform) {
    return db.prepare(`SELECT * FROM withdrawals WHERE orderId = ? AND platform = ?`).get(String(orderId), String(platform).toLowerCase()) || null;
  }
  return db.prepare(`SELECT * FROM withdrawals WHERE orderId = ?`).get(String(orderId)) || null;
}

function updateWithdrawalStatus(id, status, { transactionId = null, rejectReason = null, processedBy = null, assignedAgent = null, receiptImage = null } = {}) {
  const now = Date.now();
  const cleanTxId = transactionId ? String(transactionId).trim().toUpperCase() : null;
  db.prepare(`
    UPDATE withdrawals
    SET status = ?,
        transactionId = COALESCE(?, transactionId),
        rejectReason = COALESCE(?, rejectReason),
        processedBy = COALESCE(?, processedBy),
        assignedAgent = COALESCE(?, assignedAgent),
        receiptImage = COALESCE(?, receiptImage),
        processedAt = ?
    WHERE id = ?
  `).run(status, cleanTxId, rejectReason, processedBy, assignedAgent, receiptImage, now, id);
  return getWithdrawalById(id);
}

function getAllWithdrawals(filters = {}) {
  let sql = `SELECT * FROM withdrawals`;
  const conditions = [];
  const params = [];

  if (filters.assignedAgent) {
    conditions.push(`(LOWER(assignedAgent) = LOWER(?) OR LOWER(processedBy) = LOWER(?))`);
    params.push(String(filters.assignedAgent).trim(), String(filters.assignedAgent).trim());
  }

  if (filters.sinceTimestamp) {
    if (filters.untilTimestamp) {
      conditions.push(`((createdAt >= ? AND createdAt <= ?) OR (processedAt IS NOT NULL AND processedAt >= ? AND processedAt <= ?))`);
      params.push(
        Number(filters.sinceTimestamp), Number(filters.untilTimestamp),
        Number(filters.sinceTimestamp), Number(filters.untilTimestamp)
      );
    } else {
      conditions.push(`(createdAt >= ? OR (processedAt IS NOT NULL AND processedAt >= ?))`);
      params.push(Number(filters.sinceTimestamp), Number(filters.sinceTimestamp));
    }
  }

  if (Array.isArray(filters.platforms) && filters.platforms.length > 0) {
    const placeholders = filters.platforms.map(() => '?').join(', ');
    conditions.push(`platform IN (${placeholders})`);
    params.push(...filters.platforms.map(p => String(p).toLowerCase()));
  } else if (filters.platform && filters.platform !== 'all') {
    conditions.push(`platform = ?`);
    params.push(String(filters.platform).toLowerCase());
  }

  if (filters.bank && filters.bank !== 'all') {
    conditions.push(`bank = ?`);
    params.push(String(filters.bank).toLowerCase());
  }

  if (filters.status && filters.status !== 'all') {
    conditions.push(`status = ?`);
    params.push(filters.status);
  }

  if (filters.search) {
    conditions.push(`(userId LIKE ? OR phoneNumber LIKE ? OR transactionId LIKE ? OR orderId LIKE ? OR id LIKE ? OR assignedAgent LIKE ? OR accountNumber LIKE ? OR accountHolderName LIKE ?)`);
    const term = `%${filters.search}%`;
    params.push(term, term, term, term, term, term, term, term);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY createdAt DESC LIMIT 1000`;
  return db.prepare(sql).all(...params);
}

function getWithdrawalStats(platform = 'all', timestamps = {}, { assignedAgent = null, platforms = null, sinceTimestamp = null, untilTimestamp = null } = {}) {
  const conditions = [];
  const params = [];

  if (assignedAgent) {
    conditions.push(`(LOWER(assignedAgent) = LOWER(?) OR LOWER(processedBy) = LOWER(?))`);
    params.push(String(assignedAgent).trim(), String(assignedAgent).trim());
  }

  if (Array.isArray(platforms) && platforms.length > 0) {
    const placeholders = platforms.map(() => '?').join(', ');
    conditions.push(`platform IN (${placeholders})`);
    params.push(...platforms.map(p => String(p).toLowerCase()));
  } else if (platform && platform !== 'all') {
    conditions.push('platform = ?');
    params.push(String(platform).toLowerCase());
  }

  const whereClause = conditions.length > 0 ? (' WHERE ' + conditions.join(' AND ')) : '';

  const todayStart = Number(timestamps.todayStart) || 0;
  const weekStart = Number(timestamps.weekStart) || 0;
  const lastWeekStart = Number(timestamps.lastWeekStart) || 0;
  const lastWeekEnd = Number(timestamps.lastWeekEnd) || 0;
  const monthStart = Number(timestamps.monthStart) || 0;

  const timeFilterClause = (sinceTimestamp && untilTimestamp)
    ? `AND ((createdAt >= ${Number(sinceTimestamp)} AND createdAt <= ${Number(untilTimestamp)}) OR (processedAt IS NOT NULL AND processedAt >= ${Number(sinceTimestamp)} AND processedAt <= ${Number(untilTimestamp)}))`
    : sinceTimestamp
    ? `AND (createdAt >= ${Number(sinceTimestamp)} OR (processedAt IS NOT NULL AND processedAt >= ${Number(sinceTimestamp)}))`
    : '';

  const sql = `
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'pending' ${timeFilterClause} THEN 1 END) as pendingCount,
      COUNT(CASE WHEN status = 'processing' ${timeFilterClause} THEN 1 END) as processingCount,
      COUNT(CASE WHEN status = 'completed' ${timeFilterClause} THEN 1 END) as completedCount,
      COUNT(CASE WHEN status = 'rejected' ${timeFilterClause} THEN 1 END) as rejectedCount,
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as totalPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${todayStart} THEN amount ELSE 0 END) as todayPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${weekStart} THEN amount ELSE 0 END) as weekPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${lastWeekStart} AND processedAt <= ${lastWeekEnd} THEN amount ELSE 0 END) as lastWeekPaidETB,
      SUM(CASE WHEN status = 'completed' AND processedAt >= ${monthStart} THEN amount ELSE 0 END) as monthPaidETB,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${todayStart} THEN 1 END) as todayCount,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${weekStart} THEN 1 END) as weekCount,
      COUNT(CASE WHEN status = 'completed' AND processedAt >= ${lastWeekStart} AND processedAt <= ${lastWeekEnd} THEN 1 END) as lastWeekCount,
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
    lastWeekPaidETB: row.lastWeekPaidETB || 0,
    monthPaidETB: row.monthPaidETB || 0,
    todayCount: row.todayCount || 0,
    weekCount: row.weekCount || 0,
    lastWeekCount: row.lastWeekCount || 0,
    monthCount: row.monthCount || 0,
  };
}

module.exports = {
  db,
  saveTx,
  getTxById,
  getTxByOrderId,
  getTxByCleanTxId,
  getActivePendingTx,
  updateTxStatus,
  expireOldPendingTxs,
  expireAllOldPendingTxs,
  getAllTxs,
  getStats,
  saveWithdrawal,
  getWithdrawalById,
  getWithdrawalByOrderId,
  updateWithdrawalStatus,
  getAllWithdrawals,
  getWithdrawalStats,
};
