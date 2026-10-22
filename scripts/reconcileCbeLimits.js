#!/usr/bin/env node
/**
 * reconcileCbeLimits.js
 * 
 * Inspects all verified CBE / CBE Agent deposits processed today in SQLite,
 * matches them against connected agent accounts in bank_accounts.json,
 * and accurately adjusts the agent float pools so agents cannot keep unaccounted float.
 * 
 * Usage:
 *   node backend/scripts/reconcileCbeLimits.js [--dry-run]
 *   node backend/scripts/reconcileCbeLimits.js --apply
 */

const fs = require('fs');
const path = require('path');
const { getEthiopianTimeMidnightTimestamps } = require('../routes/admin');
const { readJSON, writeJSON, normalizeAgent, normalizePlatform } = require('../bankLimits');
const { db } = require('../db');

const args = process.argv.slice(2);
const isApply = args.includes('--apply');

console.log('='.repeat(70));
console.log(`CBE FLOAT POOL RECONCILIATION & RECOVERY (${isApply ? 'APPLY MODE' : 'DRY-RUN / AUDIT MODE'})`);
console.log('='.repeat(70));

const bankData = readJSON('bank_accounts.json') || {};
const numData = readJSON('numbers.json') || {};
const timestamps = getEthiopianTimeMidnightTimestamps();
const todayStart = Number(timestamps.todayStart) || 0;

console.log('Audit window (Ethiopian Today Start):', new Date(todayStart).toISOString());

// 1. Collect all connected agent CBE accounts
const agentCbeAccounts = []; // { agent, platform, bank, account, cleanAcc }
for (const [platform, bMap] of Object.entries(bankData)) {
  if (!bMap || typeof bMap !== 'object' || platform === 'agentLimits') continue;
  for (const b of ['cbe', 'cbeagent', 'cbe_agent']) {
    const accs = bMap[b];
    if (!Array.isArray(accs)) continue;
    accs.forEach(slot => {
      if (slot && slot.connectedAgent && slot.account && slot.account.trim()) {
        const cleanAcc = slot.account.trim().replace(/\D/g, '');
        agentCbeAccounts.push({
          agent: normalizeAgent(slot.connectedAgent),
          rawAgent: slot.connectedAgent,
          platform,
          bank: b,
          id: slot.id,
          account: slot.account.trim(),
          cleanAcc
        });
      }
    });
  }
}

console.log(`\nFound ${agentCbeAccounts.length} connected CBE / CBE Agent account slots:`);
agentCbeAccounts.forEach(a => {
  console.log(`  - Agent [${a.rawAgent}] | ${a.platform.toUpperCase()} | ${a.bank.toUpperCase()} slot #${a.id}: ${a.account}`);
});

// 2. Query all verified deposits today from SQLite for cbe and cbeagent
const verifiedToday = db.prepare(`
  SELECT id, platform, bank, amount, verifiedAmount, phoneNumber, accountNumber, assignedAgent, status, createdAt, receipt
  FROM transactions
  WHERE (bank = 'cbe' OR bank = 'cbeagent' OR bank = 'cbe_agent')
    AND status = 'verified'
    AND createdAt >= ?
  ORDER BY createdAt ASC
`).all(todayStart);

console.log(`\nFound ${verifiedToday.length} verified CBE / CBE Agent deposit transactions today.`);

// 3. Match transactions to agents
const agentDepositTotals = {}; // agentKey -> { totalETB: number, count: number, txs: [] }

function matchAccount(creditedStr, cleanSlotAcc) {
  if (!creditedStr || !cleanSlotAcc) return false;
  const raw = String(creditedStr).trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return false;

  if (raw.includes('*')) {
    const parts = raw.split(/\*+/);
    const prefix = parts[0] ? parts[0].replace(/\D/g, '') : '';
    const suffix = parts[parts.length - 1] ? parts[parts.length - 1].replace(/\D/g, '') : '';
    if (prefix && !cleanSlotAcc.startsWith(prefix)) return false;
    if (suffix && !cleanSlotAcc.endsWith(suffix)) return false;
    return true;
  }
  if (digits === cleanSlotAcc) return true;
  if (digits.length >= 6 && cleanSlotAcc.length >= 6) {
    return cleanSlotAcc.endsWith(digits) || digits.endsWith(cleanSlotAcc);
  }
  return false;
}

verifiedToday.forEach(tx => {
  const amt = Number(tx.verifiedAmount || tx.amount || 0);
  let receiptObj = null;
  try {
    receiptObj = tx.receipt ? (typeof tx.receipt === 'string' ? JSON.parse(tx.receipt) : tx.receipt) : null;
  } catch {}

  const credited = receiptObj ? (receiptObj.creditedAccount || receiptObj.receiver) : null;
  const targetAcc = credited || tx.accountNumber || tx.phoneNumber;

  // Find matching agent
  let matchedAgent = null;
  let matchedSlot = null;

  for (const slot of agentCbeAccounts) {
    if (matchAccount(targetAcc, slot.cleanAcc)) {
      matchedAgent = slot.agent;
      matchedSlot = slot;
      break;
    }
  }

  // Fallback to assignedAgent if specified
  if (!matchedAgent && tx.assignedAgent) {
    matchedAgent = normalizeAgent(tx.assignedAgent);
  }

  if (matchedAgent) {
    if (!agentDepositTotals[matchedAgent]) {
      agentDepositTotals[matchedAgent] = { totalETB: 0, count: 0, txs: [] };
    }
    agentDepositTotals[matchedAgent].totalETB += amt;
    agentDepositTotals[matchedAgent].count += 1;
    agentDepositTotals[matchedAgent].txs.push({
      id: tx.id,
      amount: amt,
      account: targetAcc,
      platform: tx.platform,
      bank: tx.bank,
      time: new Date(tx.createdAt).toLocaleTimeString()
    });
  } else {
    console.log(`[Unlinked] Tx #${tx.id} for ${amt} ETB (Account: ${targetAcc}) did not match any connected CBE agent.`);
  }
});

// 4. Report & Adjust Float Pools
console.log('\n' + '-'.repeat(70));
console.log('RECONCILIATION SUMMARY PER AGENT:');
console.log('-'.repeat(70));

if (Object.keys(agentDepositTotals).length === 0) {
  console.log('No agent-linked CBE deposits found for today.');
}

for (const [agentKey, stat] of Object.entries(agentDepositTotals)) {
  const pool = bankData.agentLimits && bankData.agentLimits[agentKey];
  const initialLimit = pool ? Number(pool.initialLimit || 0) : 0;
  const currentRemaining = pool ? Number(pool.remainingLimit || 0) : 0;
  const recalculatedRemaining = Math.max(0, initialLimit - stat.totalETB);

  console.log(`\nAgent: ${agentKey}`);
  console.log(`  - Total Verified CBE Deposits Today: ${stat.totalETB.toLocaleString()} ETB across ${stat.count} transaction(s)`);
  console.log(`  - Initial Configured Float:          ${initialLimit.toLocaleString()} ETB`);
  console.log(`  - Current Recorded Remaining Float:  ${currentRemaining.toLocaleString()} ETB`);
  console.log(`  - Target Calculated Remaining Float: ${recalculatedRemaining.toLocaleString()} ETB`);

  const difference = currentRemaining - recalculatedRemaining;
  if (difference > 0) {
    console.log(`  [OVER-FLOAT WARNING] Agent has ${difference.toLocaleString()} ETB more float than they should have!`);
  } else if (difference < 0) {
    console.log(`  [INFO] Float is currently lower (additional withdrawals/deductions processed).`);
  } else {
    console.log(`  [IN SYNC] Recorded float matches today's CBE deposits exactly.`);
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
  console.log('  node backend/scripts/reconcileCbeLimits.js --apply');
}
console.log('='.repeat(70));
