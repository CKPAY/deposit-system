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
    callbackUrl TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_userId ON transactions(userId);
  CREATE INDEX IF NOT EXISTS idx_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactionId ON transactions(transactionId);
`);

// Helper functions for Database Access
const stmtInsertTx = db.prepare(`
  INSERT OR REPLACE INTO transactions (
    id, orderId, userId, requestedAmount, amount, verifiedAmount,
    phoneNumber, status, transactionId, failReason, receipt,
    createdAt, expiresAt, submittedAt, returnUrl, callbackUrl
  ) VALUES (
    @id, @orderId, @userId, @requestedAmount, @amount, @verifiedAmount,
    @phoneNumber, @status, @transactionId, @failReason, @receipt,
    @createdAt, @expiresAt, @submittedAt, @returnUrl, @callbackUrl
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
    receipt: tx.receipt ? JSON.stringify(tx.receipt) : null,
    createdAt: Number(tx.createdAt || Date.now()),
    expiresAt: Number(tx.expiresAt || Date.now() + 20 * 60 * 1000),
    submittedAt: tx.submittedAt ? Number(tx.submittedAt) : null,
    returnUrl: tx.returnUrl || null,
    callbackUrl: tx.callbackUrl || null,
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

function getActivePendingTx(userId) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT * FROM transactions
    WHERE userId = ? AND status = 'pending' AND expiresAt > ?
    ORDER BY createdAt DESC LIMIT 1
  `).get(String(userId), now);
  if (!row) return null;
  return {
    ...row,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}

function expireOldPendingTxs(userId) {
  db.prepare(`UPDATE transactions SET status = 'expired' WHERE userId = ? AND status = 'pending'`).run(String(userId));
}

function getAllTxs(filters = {}) {
  let sql = `SELECT * FROM transactions`;
  const conditions = [];
  const params = [];

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

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM transactions`).get().cnt;
  const verified = db.prepare(`SELECT COUNT(*) as cnt, SUM(verifiedAmount) as totalAmount FROM transactions WHERE status = 'verified'`).get();
  const pending = db.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE status = 'pending'`).get().cnt;
  const failed = db.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE status = 'failed'`).get().cnt;

  return {
    totalTransactions: total,
    verifiedCount: verified.cnt,
    verifiedVolume: verified.totalAmount || 0,
    pendingCount: pending,
    failedCount: failed,
  };
}

// Automatically migrate transactions.json to SQLite if file exists
const jsonPath = path.join(dataDir, 'transactions.json');
if (fs.existsSync(jsonPath)) {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const jsonTxs = JSON.parse(raw);
    if (Array.isArray(jsonTxs) && jsonTxs.length > 0) {
      const migrateMany = db.transaction((txs) => {
        for (const t of txs) {
          saveTx(t);
        }
      });
      migrateMany(jsonTxs);
    }
  } catch (e) {
    console.error('Migration notice:', e.message);
  }
}

module.exports = {
  db,
  saveTx,
  getTxById,
  getTxByCleanTxId,
  getActivePendingTx,
  expireOldPendingTxs,
  getAllTxs,
  getStats,
};
