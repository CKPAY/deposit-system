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

function normalizeAgent(agent) {
  return String(agent || '').trim().toLowerCase();
}

/**
 * Get the shared limit for an agent from agentLimits or connected slots.
 */
function getAgentLimit(agentUsername, fullData = null) {
  if (!agentUsername) return null;
  const data = fullData || readJSON('bank_accounts.json') || {};
  const agentKey = normalizeAgent(agentUsername);
  if (!agentKey) return null;

  if (data.agentLimits && data.agentLimits[agentKey]) {
    const lim = data.agentLimits[agentKey];
    return {
      initialLimit: Number(lim.initialLimit) || 0,
      remainingLimit: (lim.remainingLimit !== undefined && lim.remainingLimit !== null)
        ? Number(lim.remainingLimit)
        : Number(lim.initialLimit) || 0
    };
  }

  // Fallback: check existing slots connected to this agent
  for (const [plat, bankMap] of Object.entries(data)) {
    if (!bankMap || typeof bankMap !== 'object' || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      const found = accs.find(a => normalizeAgent(a.connectedAgent) === agentKey);
      if (found && (found.initialLimit !== undefined && found.initialLimit !== null)) {
        return {
          initialLimit: Number(found.initialLimit) || 0,
          remainingLimit: (found.remainingLimit !== undefined && found.remainingLimit !== null)
            ? Number(found.remainingLimit)
            : Number(found.initialLimit) || 0
        };
      }
    }
  }

  return null;
}

/**
 * Set and sync shared limit for an agent across all connected accounts.
 */
function setAgentLimit(agentUsername, initialLimit, remainingLimit) {
  const agentKey = normalizeAgent(agentUsername);
  if (!agentKey) return null;

  const data = readJSON('bank_accounts.json') || {};
  if (!data.agentLimits) data.agentLimits = {};

  const numInit = Math.max(0, Number(initialLimit) || 0);
  const numRem = (remainingLimit !== undefined && remainingLimit !== null && !isNaN(Number(remainingLimit)))
    ? Math.max(0, Number(remainingLimit))
    : numInit;

  data.agentLimits[agentKey] = {
    initialLimit: numInit,
    remainingLimit: numRem
  };

  // Sync to all slots connected to this agent across all platforms and banks
  for (const [plat, bankMap] of Object.entries(data)) {
    if (!bankMap || typeof bankMap !== 'object' || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(a => {
        if (a && normalizeAgent(a.connectedAgent) === agentKey) {
          a.initialLimit = numInit;
          a.remainingLimit = numRem;
        }
      });
    }
  }

  writeJSON('bank_accounts.json', data);
  return data.agentLimits[agentKey];
}

/**
 * Sync all slots for an agent with their agentLimits record.
 */
function syncAgentSlots(data, agentUsername) {
  const agentKey = normalizeAgent(agentUsername);
  if (!agentKey || !data.agentLimits || !data.agentLimits[agentKey]) return;
  const lim = data.agentLimits[agentKey];

  for (const [plat, bankMap] of Object.entries(data)) {
    if (!bankMap || typeof bankMap !== 'object' || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(a => {
        if (a && normalizeAgent(a.connectedAgent) === agentKey) {
          a.initialLimit = Number(lim.initialLimit) || 0;
          a.remainingLimit = Number(lim.remainingLimit) || 0;
        }
      });
    }
  }
}

/**
 * Deduct deposit amount from connected bank account or agent pool.
 * If account is connected to an agent, deducts from the agent's shared pool.
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

  if (!slot) return null;

  // Case 1: Account is connected to an agent -> Shared Agent Pool
  if (slot.connectedAgent) {
    const agentKey = normalizeAgent(slot.connectedAgent);
    if (!fullData.agentLimits) fullData.agentLimits = {};

    let currentInit = Number(slot.initialLimit) || 0;
    let currentRem = (slot.remainingLimit !== undefined && slot.remainingLimit !== null)
      ? Number(slot.remainingLimit)
      : currentInit;

    if (fullData.agentLimits[agentKey]) {
      currentInit = Number(fullData.agentLimits[agentKey].initialLimit) || currentInit;
      currentRem = Number(fullData.agentLimits[agentKey].remainingLimit);
      if (isNaN(currentRem)) currentRem = currentInit;
    }

    const newRemaining = Math.max(0, Math.round((currentRem - amt) * 100) / 100);

    fullData.agentLimits[agentKey] = {
      initialLimit: currentInit,
      remainingLimit: newRemaining
    };

    // Update ALL slots connected to this agent across all platforms and banks
    for (const [pl, bMap] of Object.entries(fullData)) {
      if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
      for (const [bk, accs] of Object.entries(bMap)) {
        if (!Array.isArray(accs)) continue;
        accs.forEach(a => {
          if (a && normalizeAgent(a.connectedAgent) === agentKey) {
            a.initialLimit = currentInit;
            a.remainingLimit = newRemaining;
          }
        });
      }
    }

    writeJSON('bank_accounts.json', fullData);
    console.log(`[Bank Limit] Deposit ${amt} ETB deducted from shared agent pool '${agentKey}' (via ${p}/${b} ${accNum}). Prev: ${currentRem}, New Remaining: ${newRemaining}`);
    return { ...slot, remainingLimit: newRemaining, initialLimit: currentInit };
  }

  // Case 2: Standalone account with its own limit (no agent)
  if (slot.remainingLimit !== undefined && slot.remainingLimit !== null) {
    const prev = Number(slot.remainingLimit);
    slot.remainingLimit = Math.max(0, Math.round((prev - amt) * 100) / 100);
    writeJSON('bank_accounts.json', fullData);
    console.log(`[Bank Limit] Deposit ${amt} ETB deducted from standalone ${p}/${b} account ${accNum}. Prev: ${prev}, New Remaining: ${slot.remainingLimit}`);
    return slot;
  }

  return null;
}

/**
 * Increase bank account limit when a withdrawal is completed by an agent.
 * Replenishes the agent's shared pool (capped at initialLimit).
 */
function increaseBankWithdrawLimit(platform, bank, agentUsername, amount, specificAccount = null) {
  const p = normalizePlatform(platform);
  const b = String(bank || '').toLowerCase().trim();
  const amt = Number(amount) || 0;
  if (amt <= 0) return null;

  const fullData = readJSON('bank_accounts.json') || {};
  const agentKey = normalizeAgent(agentUsername);

  if (agentKey) {
    if (!fullData.agentLimits) fullData.agentLimits = {};

    let currentInit = 0;
    let currentRem = 0;

    if (fullData.agentLimits[agentKey]) {
      currentInit = Number(fullData.agentLimits[agentKey].initialLimit) || 0;
      currentRem = Number(fullData.agentLimits[agentKey].remainingLimit) || 0;
    } else {
      // Find from any connected slot
      for (const [pl, bMap] of Object.entries(fullData)) {
        if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
        for (const [bk, accs] of Object.entries(bMap)) {
          if (!Array.isArray(accs)) continue;
          const found = accs.find(a => normalizeAgent(a.connectedAgent) === agentKey);
          if (found) {
            currentInit = Number(found.initialLimit) || 0;
            currentRem = Number(found.remainingLimit !== undefined && found.remainingLimit !== null ? found.remainingLimit : found.initialLimit) || 0;
            break;
          }
        }
        if (currentInit > 0) break;
      }
    }

    if (currentInit > 0 || currentRem > 0) {
      const cap = currentInit > 0 ? currentInit : (currentRem + amt);
      const newRemaining = Math.min(cap, Math.round((currentRem + amt) * 100) / 100);

      fullData.agentLimits[agentKey] = {
        initialLimit: cap,
        remainingLimit: newRemaining
      };

      // Sync to ALL slots connected to this agent
      for (const [pl, bMap] of Object.entries(fullData)) {
        if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
        for (const [bk, accs] of Object.entries(bMap)) {
          if (!Array.isArray(accs)) continue;
          accs.forEach(a => {
            if (a && normalizeAgent(a.connectedAgent) === agentKey) {
              a.initialLimit = cap;
              a.remainingLimit = newRemaining;
            }
          });
        }
      }

      writeJSON('bank_accounts.json', fullData);
      console.log(`[Bank Limit] Withdrawal ${amt} ETB replenished shared agent pool '${agentKey}'. Prev: ${currentRem}, New Remaining: ${newRemaining} (cap: ${cap})`);
      return { agent: agentKey, initialLimit: cap, remainingLimit: newRemaining };
    }
  }

  // Fallback for specific account without agent
  if (specificAccount && fullData[p] && Array.isArray(fullData[p][b])) {
    const accNum = String(specificAccount).trim().toLowerCase();
    const slot = fullData[p][b].find(a => String(a.account || '').trim().toLowerCase() === accNum);
    if (slot && slot.remainingLimit !== undefined && slot.remainingLimit !== null) {
      const prev = Number(slot.remainingLimit);
      const cap = (slot.initialLimit !== undefined && slot.initialLimit !== null) ? Number(slot.initialLimit) : (prev + amt);
      slot.remainingLimit = Math.min(cap, Math.round((prev + amt) * 100) / 100);
      writeJSON('bank_accounts.json', fullData);
      return slot;
    }
  }

  return null;
}

/**
 * Get all bank accounts connected to a specific agent across all platforms and banks.
 */
function getAgentConnectedAccounts(agentUsername) {
  if (!agentUsername) return [];
  const uName = normalizeAgent(agentUsername);
  const fullData = readJSON('bank_accounts.json') || {};
  const connected = [];

  const agentLim = (fullData.agentLimits && fullData.agentLimits[uName]) ? fullData.agentLimits[uName] : null;

  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(acc => {
        if (acc && normalizeAgent(acc.connectedAgent) === uName) {
          const init = agentLim ? Number(agentLim.initialLimit) : Number(acc.initialLimit) || 0;
          const rem = agentLim ? Number(agentLim.remainingLimit) : (acc.remainingLimit !== undefined && acc.remainingLimit !== null ? Number(acc.remainingLimit) : init);
          connected.push({
            platform: plat,
            bank: bank,
            id: acc.id,
            account: acc.account,
            label: acc.label,
            active: acc.active !== false,
            connectedAgent: acc.connectedAgent,
            initialLimit: init,
            remainingLimit: rem
          });
        }
      });
    }
  }
  return connected;
}

/**
 * Get all connected bank accounts across all agents, platforms, and banks.
 */
function getAllConnectedAccounts() {
  const fullData = readJSON('bank_accounts.json') || {};
  const connected = [];

  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(acc => {
        if (acc && acc.connectedAgent) {
          const uName = normalizeAgent(acc.connectedAgent);
          const agentLim = (fullData.agentLimits && fullData.agentLimits[uName]) ? fullData.agentLimits[uName] : null;
          const init = agentLim ? Number(agentLim.initialLimit) : Number(acc.initialLimit) || 0;
          const rem = agentLim ? Number(agentLim.remainingLimit) : (acc.remainingLimit !== undefined && acc.remainingLimit !== null ? Number(acc.remainingLimit) : init);

          connected.push({
            platform: plat,
            bank: bank,
            id: acc.id,
            account: acc.account,
            label: acc.label,
            active: acc.active !== false,
            connectedAgent: acc.connectedAgent,
            initialLimit: init,
            remainingLimit: rem
          });
        }
      });
    }
  }
  return connected;
}

/**
 * Get all agents with their shared limit pool and all connected accounts.
 */
function getAllAgentPools() {
  const fullData = readJSON('bank_accounts.json') || {};
  const pools = {};

  // First collect from agentLimits
  if (fullData.agentLimits) {
    for (const [ag, lim] of Object.entries(fullData.agentLimits)) {
      pools[ag] = {
        agent: ag,
        initialLimit: Number(lim.initialLimit) || 0,
        remainingLimit: Number(lim.remainingLimit) || 0,
        accounts: []
      };
    }
  }

  // Next collect accounts
  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (!Array.isArray(accs)) continue;
      accs.forEach(acc => {
        if (acc && acc.connectedAgent) {
          const ag = normalizeAgent(acc.connectedAgent);
          if (!pools[ag]) {
            pools[ag] = {
              agent: ag,
              initialLimit: Number(acc.initialLimit) || 0,
              remainingLimit: (acc.remainingLimit !== undefined && acc.remainingLimit !== null) ? Number(acc.remainingLimit) : Number(acc.initialLimit) || 0,
              accounts: []
            };
          }
          pools[ag].accounts.push({
            platform: plat,
            bank: bank,
            id: acc.id,
            account: acc.account,
            label: acc.label,
            active: acc.active !== false
          });
        }
      });
    }
  }

  return Object.values(pools);
}

module.exports = {
  deductBankDepositLimit,
  increaseBankWithdrawLimit,
  getAgentConnectedAccounts,
  getAllConnectedAccounts,
  getAgentLimit,
  setAgentLimit,
  getAllAgentPools,
  syncAgentSlots,
  readJSON,
  writeJSON,
  normalizePlatform,
  normalizeAgent
};
