#!/usr/bin/env node
/**
 * reconcileCbeLimits.js
 * 
 * Database-Driven Float Pool Audit & Reconciliation.
 * Reads directly from SQLite database (transactions & withdrawals tables)
 * to calculate and correct the exact float pool for any agent or all agents.
 * 
 * Usage:
 *   node scripts/reconcileCbeLimits.js                          # Audit all agents for today
 *   node scripts/reconcileCbeLimits.js --apply                  # Apply today's reconciliation
 *   node scripts/reconcileCbeLimits.js --agent agent11          # Detailed transaction audit for agent11 (today)
 *   node scripts/reconcileCbeLimits.js --agent agent11 --all-time         # Audit all-time database deposits for agent11
 *   node scripts/reconcileCbeLimits.js --agent agent11 --all-time --apply # Apply all-time reconciliation for agent11
 *   node scripts/reconcileCbeLimits.js --agent agent11 --hours 24         # Audit last 24 hours
 *   node scripts/reconcileCbeLimits.js --agent agent11 --hours 24 --apply # Apply last 24 hours
 *   node scripts/reconcileCbeLimits.js --set agent11 150000     # Manually force set agent11 remaining float
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
const isAllTime = args.includes('--all-time') || args.includes('--all');

const agentIdx = args.indexOf('--agent');
const targetAgent = agentIdx !== -1 && args[agentIdx + 1] ? normalizeAgent(args[agentIdx + 1]) : null;

const hoursIdx = args.indexOf('--hours');
const customHours = hoursIdx !== -1 && args[hoursIdx + 1] ? Number(args[hoursIdx + 1]) : null;

const setIdx = args.indexOf('--set');
const setTargetAgent = setIdx !== -1 && args[setIdx + 1] ? normalizeAgent(args[setIdx + 1]) : null;
const setAmount = setIdx !== -1 && args[setIdx + 2] ? Number(args[setIdx + 2]) : null;

const bankData = readJSON('bank_accounts.json') || {};
const numData = readJSON('numbers.json') || {};

console.log('='.repeat(75));
console.log('DATABASE-DRIVEN FLOAT RECONCILIATION & AUDIT TOOL');
console.log('='.repeat(75));

// --- SPECIAL COMMAND: DIRECT FORCE SET ---
if (setTargetAgent && setAmount !== null && !isNaN(setAmount)) {
  console.log(`[MANUAL OVERRIDE] Setting remaining float for agent '${setTargetAgent}' to ${setAmount.toLocaleString()} ETB...`);
  
  if (!bankData.agentLimits) bankData.agentLimits = {};
  const currentInit = bankData.agentLimits[setTargetAgent]?.initialLimit || setAmount;
  bankData.agentLimits[setTargetAgent] = {
    initialLimit: currentInit,
    remainingLimit: Math.max(0, setAmount)
  };

  // Sync to all bank accounts
  for (const [pl, bMap] of Object.entries(bankData)) {
    if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
    for (const [bk, accs] of Object.entries(bMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(a => {
        if (a && normalizeAgent(a.connectedAgent) === setTargetAgent) {
          a.remainingLimit = Math.max(0, setAmount);
        }
      });
    }
  }

  // Sync to all numbers
  if (numData) {
    for (const [pl, pData] of Object.entries(numData)) {
      if (!pData || !Array.isArray(pData.numbers)) continue;
      pData.numbers.forEach(n => {
        if (n && normalizeAgent(n.connectedAgent) === setTargetAgent) {
          n.remainingLimit = Math.max(0, setAmount);
        }
      });
    }
  }

  writeJSON('bank_accounts.json', bankData);
  writeJSON('numbers.json', numData);
  console.log(`[SUCCESS] Agent '${setTargetAgent}' remaining float updated to ${setAmount.toLocaleString()} ETB across all linked slots.`);
  process.exit(0);
}

// Determine Time Window
let startTime = 0;
let timeDesc = 'All-Time (Entire Database History)';

if (!isAllTime) {
  if (customHours) {
    startTime = Date.now() - (customHours * 60 * 60 * 1000);
    timeDesc = `Last ${customHours} Hours (Since ${new Date(startTime).toLocaleString()})`;
  } else {
    const timestamps = getEthiopianTimeMidnightTimestamps();
    startTime = Number(timestamps.todayStart) || 0;
    timeDesc = `Today since Ethiopian Midnight (${new Date(startTime).toLocaleString()})`;
  }
}

console.log(`Mode:         ${isApply ? 'APPLY CORRECTION' : 'DRY-RUN / AUDIT'}`);
console.log(`Time Window:  ${timeDesc}`);
if (targetAgent) console.log(`Target Agent: ${targetAgent}`);
console.log('-'.repeat(75));

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

// 1. Collect all connected agent accounts
const connectedAgentAccounts = [];
const agentKnownAccounts = {}; // agentKey -> Set of account strings

for (const [platform, bMap] of Object.entries(bankData)) {
  if (!bMap || typeof bMap !== 'object' || platform === 'agentLimits') continue;
  for (const [b, accs] of Object.entries(bMap)) {
    if (b === 'telebirr') continue;
    if (!Array.isArray(accs)) continue;
    accs.forEach(slot => {
      if (slot && slot.connectedAgent && slot.account && slot.account.trim()) {
        const agKey = normalizeAgent(slot.connectedAgent);
        connectedAgentAccounts.push({
          agent: agKey,
          rawAgent: slot.connectedAgent,
          platform,
          bank: b,
          id: slot.id,
          account: slot.account.trim()
        });
        if (!agentKnownAccounts[agKey]) agentKnownAccounts[agKey] = new Set();
        agentKnownAccounts[agKey].add(slot.account.trim().toLowerCase());
        const clean = slot.account.trim().replace(/\D/g, '');
        if (clean) agentKnownAccounts[agKey].add(clean);
      }
    });
  }
}

for (const [platform, pData] of Object.entries(numData)) {
  if (!pData || !Array.isArray(pData.numbers)) continue;
  pData.numbers.forEach(slot => {
    if (slot && slot.connectedAgent && slot.phone && slot.phone.trim()) {
      const agKey = normalizeAgent(slot.connectedAgent);
      connectedAgentAccounts.push({
        agent: agKey,
        rawAgent: slot.connectedAgent,
        platform,
        bank: 'telebirr',
        id: slot.id,
        account: slot.phone.trim()
      });
      if (!agentKnownAccounts[agKey]) agentKnownAccounts[agKey] = new Set();
      agentKnownAccounts[agKey].add(slot.phone.trim().toLowerCase());
      const norm = normalizePhone(slot.phone.trim());
      if (norm) agentKnownAccounts[agKey].add(norm);
    }
  });
}

console.log(`Found ${connectedAgentAccounts.length} connected account slots configured in system.`);

// 2. Query verified transactions from SQLite
let sql = `
  SELECT id, platform, bank, amount, verifiedAmount, phoneNumber, accountNumber, assignedAgent, status, createdAt, receipt
  FROM transactions
  WHERE status = 'verified'
`;
const params = [];

if (startTime > 0) {
  sql += ` AND createdAt >= ?`;
  params.push(startTime);
}
sql += ` ORDER BY createdAt ASC`;

const verifiedTxs = db.prepare(sql).all(...params);
console.log(`Found ${verifiedTxs.length} total verified transactions in database for this window.`);

// 3. Match transactions
const agentStats = {}; // agentKey -> { totalETB, count, byBank, txs }

verifiedTxs.forEach(tx => {
  const amt = Number(tx.verifiedAmount || tx.amount || 0);
  let receiptObj = null;
  try {
    receiptObj = tx.receipt ? (typeof tx.receipt === 'string' ? JSON.parse(tx.receipt) : tx.receipt) : null;
  } catch {}

  const hasDigitsOrMask = (str) => str && (/\d/.test(String(str)) || String(str).includes('*'));
  const credited = hasDigitsOrMask(receiptObj?.creditedAccount) ? receiptObj.creditedAccount : null;
  const targetAcc = credited || tx.accountNumber || tx.phoneNumber;

  let matchedAgent = null;
  let matchReason = '';

  // Direct assignedAgent check
  if (tx.assignedAgent) {
    matchedAgent = normalizeAgent(tx.assignedAgent);
    matchReason = `assignedAgent (${tx.assignedAgent})`;
  }

  // Account slot match
  if (!matchedAgent) {
    for (const slot of connectedAgentAccounts) {
      if (matchAccount(targetAcc, slot.account)) {
        matchedAgent = slot.agent;
        matchReason = `account match (${slot.platform}/${slot.bank} ${slot.account})`;
        break;
      }
    }
  }

  // Fallback: check against known agent accounts set
  if (!matchedAgent && targetAcc) {
    const rawClean = String(targetAcc).trim().toLowerCase();
    const cleanDigits = rawClean.replace(/\D/g, '');
    const normPh = normalizePhone(rawClean);

    for (const [ag, set] of Object.entries(agentKnownAccounts)) {
      if (set.has(rawClean) || (cleanDigits && set.has(cleanDigits)) || (normPh && set.has(normPh))) {
        matchedAgent = ag;
        matchReason = `known account set match (${targetAcc})`;
        break;
      }
    }
  }

  if (matchedAgent) {
    if (targetAgent && matchedAgent !== targetAgent) return;

    if (!agentStats[matchedAgent]) {
      agentStats[matchedAgent] = { totalETB: 0, count: 0, byBank: {}, txs: [] };
    }
    agentStats[matchedAgent].totalETB += amt;
    agentStats[matchedAgent].count += 1;
    const bk = String(tx.bank || 'telebirr').toLowerCase();
    agentStats[matchedAgent].byBank[bk] = (agentStats[matchedAgent].byBank[bk] || 0) + amt;
    agentStats[matchedAgent].txs.push({
      id: tx.id,
      amount: amt,
      bank: bk,
      platform: tx.platform,
      account: targetAcc,
      payer: receiptObj?.payer || '',
      date: new Date(tx.createdAt).toLocaleString(),
      matchReason
    });
  }
});

// 4. Query completed withdrawals
let wSql = `
  SELECT id, platform, bank, amount, processedBy, assignedAgent, createdAt
  FROM withdrawals
  WHERE status = 'completed'
`;
const wParams = [];
if (startTime > 0) {
  wSql += ` AND createdAt >= ?`;
  wParams.push(startTime);
}
const completedWds = db.prepare(wSql).all(...wParams);
const agentWdStats = {}; // agentKey -> number

completedWds.forEach(w => {
  const ag = normalizeAgent(w.assignedAgent || w.processedBy);
  if (ag && ag !== 'admin') {
    if (targetAgent && ag !== targetAgent) return;
    const amt = Number(w.amount) || 0;
    agentWdStats[ag] = (agentWdStats[ag] || 0) + amt;
  }
});

// 5. Output Detailed Report
const displayAgents = targetAgent ? [targetAgent] : Array.from(new Set([...Object.keys(agentStats), ...Object.keys(agentWdStats)]));

console.log('\n' + '-'.repeat(75));
console.log('RECONCILIATION SUMMARY REPORT:');
console.log('-'.repeat(75));

if (displayAgents.length === 0) {
  console.log('No matching transactions found.');
}

for (const ag of displayAgents) {
  const stat = agentStats[ag] || { totalETB: 0, count: 0, byBank: {}, txs: [] };
  const withdrawTotal = agentWdStats[ag] || 0;

  const pool = bankData.agentLimits && bankData.agentLimits[ag];
  const initialLimit = pool ? Number(pool.initialLimit || 0) : 0;
  const currentRemaining = pool ? Number(pool.remainingLimit || 0) : 0;

  const netDeduction = stat.totalETB - withdrawTotal;
  const recalculatedRemaining = Math.min(initialLimit, Math.max(0, initialLimit - netDeduction));
  const diff = currentRemaining - recalculatedRemaining;

  console.log(`\n================== AGENT: ${ag.toUpperCase()} ==================`);
  console.log(`Configured Initial Float:          ${initialLimit.toLocaleString()} ETB`);
  console.log(`Current Recorded Remaining Float:  ${currentRemaining.toLocaleString()} ETB`);
  console.log(`Total Verified Deposits in DB:     ${stat.totalETB.toLocaleString()} ETB (${stat.count} txs)`);
  
  for (const [bName, bAmt] of Object.entries(stat.byBank)) {
    console.log(`   - ${bName.toUpperCase().padEnd(10)}: ${bAmt.toLocaleString().padStart(10)} ETB`);
  }

  console.log(`Total Completed Withdrawals in DB: ${withdrawTotal.toLocaleString()} ETB`);
  console.log(`Target Calculated Remaining Float: ${recalculatedRemaining.toLocaleString()} ETB`);

  if (diff > 0) {
    console.log(`--> OVER-FLOAT DISCREPANCY:       +${diff.toLocaleString()} ETB (unaccounted float)`);
  } else if (diff < 0) {
    console.log(`--> CURRENT FLOAT IS LOWER:       ${diff.toLocaleString()} ETB`);
  } else {
    console.log(`--> FLOAT STATUS:                  PERFECTLY IN SYNC (0 ETB diff)`);
  }

  // Print individual transactions if targeted agent
  if (targetAgent && stat.txs.length > 0) {
    console.log('\n--- VERIFIED TRANSACTIONS LIST IN DATABASE ---');
    stat.txs.forEach((t, i) => {
      console.log(`${String(i + 1).padStart(3)}. ${t.date} | ${t.platform.toUpperCase().padEnd(8)} | ${t.bank.toUpperCase().padEnd(8)} | ${t.amount.toLocaleString().padStart(7)} ETB | Acc: ${t.account || 'N/A'} | Reason: ${t.matchReason}`);
    });
  }

  // Apply corrections if requested
  if (isApply && diff > 0) {
    console.log(`\n--> [APPLYING] Setting ${ag} remaining float to ${recalculatedRemaining.toLocaleString()} ETB...`);
    if (!bankData.agentLimits) bankData.agentLimits = {};
    bankData.agentLimits[ag] = {
      initialLimit: initialLimit,
      remainingLimit: recalculatedRemaining
    };

    // Sync bank accounts
    for (const [pl, bMap] of Object.entries(bankData)) {
      if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
      for (const [bk, accs] of Object.entries(bMap)) {
        if (!Array.isArray(accs)) continue;
        accs.forEach(a => {
          if (a && normalizeAgent(a.connectedAgent) === ag) {
            a.remainingLimit = recalculatedRemaining;
          }
        });
      }
    }

    // Sync phone numbers
    if (numData) {
      for (const [pl, pData] of Object.entries(numData)) {
        if (!pData || !Array.isArray(pData.numbers)) continue;
        pData.numbers.forEach(n => {
          if (n && normalizeAgent(n.connectedAgent) === ag) {
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
  console.log('\n[SUCCESS] Updated bank_accounts.json and numbers.json.');
} else {
  console.log('\n[DRY RUN FINISHED]');
  console.log('To apply these calculated float values, add the --apply flag.');
}
console.log('='.repeat(75));
