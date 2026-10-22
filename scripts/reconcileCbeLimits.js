#!/usr/bin/env node
/**
 * reconcileCbeLimits.js
 * 
 * Inspects all verified deposits & completed withdrawals processed today in SQLite,
 * matches them against connected agent accounts across all banks and Telebirr,
 * and accurately adjusts the agent float pools so agents cannot keep unaccounted float.
 * 
 * Usage:
 *   node scripts/reconcileCbeLimits.js [--dry-run]
 *   node scripts/reconcileCbeLimits.js --apply
 *   node scripts/reconcileCbeLimits.js --bank cbe [--apply]
 */

const fs = require('fs');
const path = require('path');

const baseDir = (() => {
  if (fs.existsSync(path.join(__dirname, '../routes/admin.js'))) return path.join(__dirname, '..');
  if (fs.existsSync(path.join(__dirname, '../backend/routes/admin.js'))) return path.join(__dirname, '../backend');
  if (fs.existsSync(path.join(process.cwd(), 'routes/admin.js'))) return process.cwd();
  if (fs.existsSync(path.join(process.cwd(), 'backend/routes/admin.js'))) return path.join(process.cwd(), 'backend');
  return path.join(__dirname, '..');
})();

const { getEthiopianTimeMidnightTimestamps } = require(path.join(baseDir, 'routes/admin'));
const { readJSON, writeJSON, normalizeAgent, normalizePlatform } = require(path.join(baseDir, 'bankLimits'));
const { db } = require(path.join(baseDir, 'db'));

const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const bankFilterIdx = args.indexOf('--bank');
const bankFilter = bankFilterIdx !== -1 && args[bankFilterIdx + 1] ? args[bankFilterIdx + 1].toLowerCase().trim() : null;

console.log('='.repeat(70));
console.log(`AGENT FLOAT POOL RECONCILIATION & RECOVERY (${isApply ? 'APPLY MODE' : 'DRY-RUN / AUDIT MODE'})`);
if (bankFilter) console.log(`Filtering to bank: ${bankFilter.toUpperCase()}`);
console.log('='.repeat(70));

const bankData = readJSON('bank_accounts.json') || {};
const numData = readJSON('numbers.json') || {};
const timestamps = getEthiopianTimeMidnightTimestamps();
const todayStart = Number(timestamps.todayStart) || 0;

console.log('Audit window (Ethiopian Today Start):', new Date(todayStart).toISOString());

function normalizePhone(p) {
  if (!p) return '';
  let str = String(p).replace(/\D/g, '');
  if (str.startsWith('251')) str = '0' + str.slice(3);
  if (str.length === 9 && (str.startsWith('9') || str.startsWith('7'))) str = '0' + str;
  return str;
}

function matchAccount(creditedStr, slotAcc) {
  if (!creditedStr || !slotAcc) return false;
  const sRaw = String(slotAcc).trim().toLowerCase();
  const tRaw = String(creditedStr).trim().toLowerCase();
  if (sRaw === tRaw) return true;

  const sNormPhone = normalizePhone(sRaw);
  const tNormPhone = normalizePhone(tRaw);
  if (sNormPhone && tNormPhone && sNormPhone === tNormPhone) return true;

  const sClean = sRaw.replace(/\D/g, '');
  const tClean = tRaw.replace(/\D/g, '');
  if (!sClean || !tClean) return false;

  if (tRaw.includes('*')) {
    const parts = tRaw.split(/\*+/);
    let prefix = parts[0] ? parts[0].replace(/\D/g, '') : '';
    let suffix = parts[parts.length - 1] ? parts[parts.length - 1].replace(/\D/g, '') : '';

    if (prefix.startsWith('2519') || prefix === '9' || prefix === '09') prefix = '09';
    else if (prefix.startsWith('2517') || prefix === '7' || prefix === '07') prefix = '07';

    const checkStr = sNormPhone || sClean;
    if (prefix && !checkStr.startsWith(prefix)) return false;
    if (suffix && !checkStr.endsWith(suffix)) return false;
    return true;
  }

  if (sClean === tClean) return true;
  if (sClean.length >= 6 && tClean.length >= 6) {
    return sClean.endsWith(tClean) || tClean.endsWith(sClean);
  }
  return false;
}

// 1. Collect all connected agent accounts (all banks and Telebirr)
const connectedAgentAccounts = [];

for (const [platform, bMap] of Object.entries(bankData)) {
  if (!bMap || typeof bMap !== 'object' || platform === 'agentLimits') continue;
  for (const [b, accs] of Object.entries(bMap)) {
    if (b === 'telebirr') continue;
    if (bankFilter && !b.includes(bankFilter)) continue;
    if (!Array.isArray(accs)) continue;
    accs.forEach(slot => {
      if (slot && slot.connectedAgent && slot.account && slot.account.trim()) {
        connectedAgentAccounts.push({
          agent: normalizeAgent(slot.connectedAgent),
          rawAgent: slot.connectedAgent,
          platform,
          bank: b,
          id: slot.id,
          account: slot.account.trim()
        });
      }
    });
  }
}

// Collect Telebirr connected numbers
if (!bankFilter || bankFilter === 'telebirr') {
  for (const [platform, pData] of Object.entries(numData)) {
    if (!pData || !Array.isArray(pData.numbers)) continue;
    pData.numbers.forEach(slot => {
      if (slot && slot.connectedAgent && slot.phone && slot.phone.trim()) {
        connectedAgentAccounts.push({
          agent: normalizeAgent(slot.connectedAgent),
          rawAgent: slot.connectedAgent,
          platform,
          bank: 'telebirr',
          id: slot.id,
          account: slot.phone.trim()
        });
      }
    });
  }
}

console.log(`\nFound ${connectedAgentAccounts.length} connected account slots:`);
connectedAgentAccounts.forEach(a => {
  console.log(`  - Agent [${a.rawAgent}] | ${a.platform.toUpperCase()} | ${a.bank.toUpperCase()} slot #${a.id}: ${a.account}`);
});

// 2. Query all verified deposits today from SQLite
let depositSql = `
  SELECT id, platform, bank, amount, verifiedAmount, phoneNumber, accountNumber, assignedAgent, status, createdAt, receipt
  FROM transactions
  WHERE status = 'verified'
    AND createdAt >= ?
`;
const depositParams = [todayStart];

if (bankFilter) {
  if (bankFilter === 'cbe') {
    depositSql += ` AND (bank = 'cbe' OR bank = 'cbeagent' OR bank = 'cbe_agent')`;
  } else {
    depositSql += ` AND bank = ?`;
    depositParams.push(bankFilter);
  }
}
depositSql += ` ORDER BY createdAt ASC`;

const verifiedToday = db.prepare(depositSql).all(...depositParams);
console.log(`\nFound ${verifiedToday.length} verified deposit transactions today.`);

// 3. Match deposit transactions to agents
const agentDepositTotals = {};

verifiedToday.forEach(tx => {
  const amt = Number(tx.verifiedAmount || tx.amount || 0);
  let receiptObj = null;
  try {
    receiptObj = tx.receipt ? (typeof tx.receipt === 'string' ? JSON.parse(tx.receipt) : tx.receipt) : null;
  } catch {}

  const hasDigitsOrMask = (str) => str && (/\d/.test(String(str)) || String(str).includes('*'));
  const credited = hasDigitsOrMask(receiptObj?.creditedAccount) ? receiptObj.creditedAccount : null;
  const targetAcc = credited || tx.accountNumber || tx.phoneNumber;

  let matchedAgent = null;
  for (const slot of connectedAgentAccounts) {
    if (matchAccount(targetAcc, slot.account)) {
      matchedAgent = slot.agent;
      break;
    }
  }

  // Fallback to assignedAgent if specified
  if (!matchedAgent && tx.assignedAgent) {
    matchedAgent = normalizeAgent(tx.assignedAgent);
  }

  if (matchedAgent) {
    if (!agentDepositTotals[matchedAgent]) {
      agentDepositTotals[matchedAgent] = { totalETB: 0, count: 0, byBank: {}, txs: [] };
    }
    agentDepositTotals[matchedAgent].totalETB += amt;
    agentDepositTotals[matchedAgent].count += 1;
    const bk = tx.bank || 'telebirr';
    agentDepositTotals[matchedAgent].byBank[bk] = (agentDepositTotals[matchedAgent].byBank[bk] || 0) + amt;
    agentDepositTotals[matchedAgent].txs.push({
      id: tx.id,
      amount: amt,
      account: targetAcc,
      platform: tx.platform,
      bank: tx.bank,
      time: new Date(tx.createdAt).toLocaleTimeString()
    });
  } else {
    console.log(`[Unlinked] Tx #${tx.id} for ${amt} ETB (${tx.bank} Account: ${targetAcc}) did not match any connected agent.`);
  }
});

// 4. Query completed withdrawals today for agents to factor in legitimate replenishments
const completedWithdrawals = db.prepare(`
  SELECT id, platform, bank, amount, processedBy, assignedAgent, createdAt
  FROM withdrawals
  WHERE status = 'completed'
    AND createdAt >= ?
`).all(todayStart);

const agentWithdrawalTotals = {};
completedWithdrawals.forEach(w => {
  const ag = normalizeAgent(w.assignedAgent || w.processedBy);
  if (ag && ag !== 'admin') {
    const amt = Number(w.amount) || 0;
    agentWithdrawalTotals[ag] = (agentWithdrawalTotals[ag] || 0) + amt;
  }
});

// 5. Report & Adjust Float Pools
console.log('\n' + '-'.repeat(70));
console.log('RECONCILIATION SUMMARY PER AGENT:');
console.log('-'.repeat(70));

const allTargetAgents = new Set([...Object.keys(agentDepositTotals), ...Object.keys(agentWithdrawalTotals)]);

if (allTargetAgents.size === 0) {
  console.log('No agent-linked transactions found for today.');
}

for (const agentKey of allTargetAgents) {
  const stat = agentDepositTotals[agentKey] || { totalETB: 0, count: 0, byBank: {} };
  const withdrawTotal = agentWithdrawalTotals[agentKey] || 0;

  const pool = bankData.agentLimits && bankData.agentLimits[agentKey];
  const initialLimit = pool ? Number(pool.initialLimit || 0) : 0;
  const currentRemaining = pool ? Number(pool.remainingLimit || 0) : 0;

  const netDeduction = stat.totalETB - withdrawTotal;
  const recalculatedRemaining = Math.min(initialLimit, Math.max(0, initialLimit - netDeduction));

  console.log(`\nAgent: ${agentKey}`);
  console.log(`  - Total Verified Deposits Today:    ${stat.totalETB.toLocaleString()} ETB across ${stat.count} transaction(s)`);
  for (const [bName, bAmt] of Object.entries(stat.byBank)) {
    console.log(`      * ${bName.toUpperCase()}: ${bAmt.toLocaleString()} ETB`);
  }
  console.log(`  - Total Completed Withdrawals Today: ${withdrawTotal.toLocaleString()} ETB`);
  console.log(`  - Initial Configured Float:          ${initialLimit.toLocaleString()} ETB`);
  console.log(`  - Current Recorded Remaining Float:  ${currentRemaining.toLocaleString()} ETB`);
  console.log(`  - Target Calculated Remaining Float: ${recalculatedRemaining.toLocaleString()} ETB`);

  const difference = currentRemaining - recalculatedRemaining;
  if (difference > 0) {
    console.log(`  [OVER-FLOAT WARNING] Agent has ${difference.toLocaleString()} ETB more float than they should have!`);
  } else if (difference < 0) {
    console.log(`  [INFO] Float is currently lower than net calculated.`);
  } else {
    console.log(`  [IN SYNC] Recorded float matches today's activity exactly.`);
  }

  if (isApply && difference > 0) {
    console.log(`  --> Applying correction: setting remaining limit to ${recalculatedRemaining.toLocaleString()} ETB...`);
    if (!bankData.agentLimits) bankData.agentLimits = {};
    bankData.agentLimits[agentKey] = {
      initialLimit: initialLimit,
      remainingLimit: recalculatedRemaining
    };

    // Sync to all slots in bank_accounts.json
    for (const [pl, bMap] of Object.entries(bankData)) {
      if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
      for (const [bk, accs] of Object.entries(bMap)) {
        if (!Array.isArray(accs)) continue;
        accs.forEach(a => {
          if (a && normalizeAgent(a.connectedAgent) === agentKey) {
            a.remainingLimit = recalculatedRemaining;
          }
        });
      }
    }

    // Sync to all slots in numbers.json
    if (numData) {
      for (const [pl, pData] of Object.entries(numData)) {
        if (!pData || !Array.isArray(pData.numbers)) continue;
        pData.numbers.forEach(n => {
          if (n && normalizeAgent(n.connectedAgent) === agentKey) {
            n.remainingLimit = recalculatedRemaining;
          }
        });
      }
    }
  }
}

if (isApply) {
  writeJSON('bank_accounts.json', bankData);
  writeJSON('numbers.json', numData);
  console.log('\n[SUCCESS] Updated bank_accounts.json and numbers.json with reconciled float pools.');
} else {
  console.log('\n[DRY RUN COMPLETE] To apply these deductions to Hostinger float pools, run:');
  console.log('  node scripts/reconcileCbeLimits.js --apply');
}
console.log('='.repeat(70));
