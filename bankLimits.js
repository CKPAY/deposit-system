const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

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

function normalizePlatform(platform) {
  if (!platform) return 'jember';
  const p = String(platform).toLowerCase().trim();
  if (p.includes('walta')) return 'walta';
  if (p.includes('bravo')) return 'bravobirr';
  if (p.includes('abay')) return 'abay';
  if (p.includes('jember')) return 'jember';
  return 'jember';
}

/**
 * Deduct deposit amount from connected bank account limit.
 * Remaining limit decreases when a deposit is verified.
 */
function deductBankDepositLimit(platform, bank, accountNumber, amount) {
  const p = normalizePlatform(platform);
  const b = String(bank || '').toLowerCase().trim();
  const accNum = String(accountNumber || '').trim();
  const amt = Number(amount) || 0;
  if (!accNum || amt <= 0 || b === 'telebirr') return null;

  const fullData = readJSON('bank_accounts.json') || {};
  if (!fullData[p] || !Array.isArray(fullData[p][b])) return null;

  const slot = fullData[p][b].find(a => 
    String(a.account || '').trim().toLowerCase() === accNum.toLowerCase()
  );

  if (slot && slot.remainingLimit !== undefined && slot.remainingLimit !== null) {
    const prev = Number(slot.remainingLimit);
    slot.remainingLimit = Math.max(0, Math.round((prev - amt) * 100) / 100);
    writeJSON('bank_accounts.json', fullData);
    const label = slot.connectedAgent ? `Agent: ${slot.connectedAgent}` : 'Non-connected Account';
    console.log(`[Bank Limit] Deposit ${amt} ETB deducted from ${p}/${b} account ${accNum} (${label}). Prev: ${prev}, New Remaining: ${slot.remainingLimit}`);
    return slot;
  }
  return null;
}

/**
 * Increase bank account limit when a withdrawal is completed by an agent.
 * Remaining limit increases when an agent pays out a withdrawal.
 */
function increaseBankWithdrawLimit(platform, bank, agentUsername, amount, specificAccount = null) {
  const p = normalizePlatform(platform);
  const b = String(bank || '').toLowerCase().trim();
  const amt = Number(amount) || 0;
  if (amt <= 0) return null;

  const fullData = readJSON('bank_accounts.json') || {};
  let slot = null;
  let targetPlat = p;
  let targetBank = b;

  // 1. Try finding in the specified platform and bank
  if (fullData[p] && Array.isArray(fullData[p][b])) {
    if (specificAccount) {
      const accNum = String(specificAccount).trim().toLowerCase();
      slot = fullData[p][b].find(a => String(a.account || '').trim().toLowerCase() === accNum);
    }
    if (!slot && agentUsername) {
      const uName = String(agentUsername).trim().toLowerCase();
      slot = fullData[p][b].find(a => String(a.connectedAgent || '').trim().toLowerCase() === uName);
    }
  }

  // 2. If not found, search other banks on this platform for the agent
  if (!slot && agentUsername && fullData[p]) {
    const uName = String(agentUsername).trim().toLowerCase();
    for (const [bk, accs] of Object.entries(fullData[p])) {
      if (Array.isArray(accs)) {
        const found = accs.find(a => String(a.connectedAgent || '').trim().toLowerCase() === uName);
        if (found) {
          slot = found;
          targetBank = bk;
          break;
        }
      }
    }
  }

  // 3. Fallback: search across all platforms for this agent
  if (!slot && agentUsername) {
    const uName = String(agentUsername).trim().toLowerCase();
    for (const [pl, bMap] of Object.entries(fullData)) {
      if (bMap && typeof bMap === 'object') {
        for (const [bk, accs] of Object.entries(bMap)) {
          if (Array.isArray(accs)) {
            const found = accs.find(a => String(a.connectedAgent || '').trim().toLowerCase() === uName);
            if (found) {
              slot = found;
              targetPlat = pl;
              targetBank = bk;
              break;
            }
          }
        }
      }
      if (slot) break;
    }
  }

  if (slot && slot.connectedAgent && slot.remainingLimit !== undefined && slot.remainingLimit !== null) {
    const prev = Number(slot.remainingLimit);
    const newRemaining = Math.round((prev + amt) * 100) / 100;
    // Cap at initialLimit so remaining can never exceed the set limit
    const cap = (slot.initialLimit !== undefined && slot.initialLimit !== null) ? Number(slot.initialLimit) : newRemaining;
    slot.remainingLimit = Math.min(newRemaining, cap);
    writeJSON('bank_accounts.json', fullData);
    console.log(`[Bank Limit] Withdrawal ${amt} ETB added to ${targetPlat}/${targetBank} account ${slot.account} (Agent: ${slot.connectedAgent}). Prev: ${prev}, New Remaining: ${slot.remainingLimit} (cap: ${cap})`);
    return slot;
  }
  return null;
}

/**
 * Get all bank accounts connected to a specific agent across all platforms and banks.
 */
function getAgentConnectedAccounts(agentUsername) {
  if (!agentUsername) return [];
  const uName = String(agentUsername).trim().toLowerCase();
  const fullData = readJSON('bank_accounts.json') || {};
  const connected = [];

  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap) continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(acc => {
        if (acc && acc.connectedAgent && String(acc.connectedAgent).trim().toLowerCase() === uName) {
          connected.push({
            platform: plat,
            bank: bank,
            id: acc.id,
            account: acc.account,
            label: acc.label,
            active: acc.active !== false,
            connectedAgent: acc.connectedAgent,
            initialLimit: Number(acc.initialLimit) || 0,
            remainingLimit: (acc.remainingLimit !== undefined && acc.remainingLimit !== null) ? Number(acc.remainingLimit) : Number(acc.initialLimit) || 0
          });
        }
      });
    }
  }
  return connected;
}

module.exports = {
  deductBankDepositLimit,
  increaseBankWithdrawLimit,
  getAgentConnectedAccounts,
  readJSON,
  writeJSON,
  normalizePlatform
};
