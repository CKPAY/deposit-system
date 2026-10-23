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

  // Sync to numbers.json for telebirr numbers connected to this agent
  const numData = readJSON('numbers.json');
  if (numData) {
    let numChanged = false;
    for (const [plat, pData] of Object.entries(numData)) {
      if (!pData || !Array.isArray(pData.numbers)) continue;
      pData.numbers.forEach(n => {
        if (n && normalizeAgent(n.connectedAgent) === agentKey) {
          n.initialLimit = numInit;
          n.remainingLimit = numRem;
          numChanged = true;
        }
      });
    }
    if (numChanged) {
      writeJSON('numbers.json', numData);
    }
  }

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

  const numData = readJSON('numbers.json');
  if (numData) {
    let numChanged = false;
    for (const [plat, pData] of Object.entries(numData)) {
      if (!pData || !Array.isArray(pData.numbers)) continue;
      pData.numbers.forEach(n => {
        if (n && normalizeAgent(n.connectedAgent) === agentKey) {
          n.initialLimit = Number(lim.initialLimit) || 0;
          n.remainingLimit = Number(lim.remainingLimit) || 0;
          numChanged = true;
        }
      });
    }
    if (numChanged) {
      writeJSON('numbers.json', numData);
    }
  }
}

function normalizePhone(p) {
  if (!p) return '';
  let str = String(p).replace(/\D/g, '');
  if (str.startsWith('251')) str = '0' + str.slice(3);
  if (str.length === 9 && (str.startsWith('9') || str.startsWith('7'))) str = '0' + str;
  return str;
}

/**
 * Account matcher that handles exact matching, masked accounts (e.g. 1000****789, 1****9707, ****9707),
 * clean digit suffix matching (>= 4 digits), and normalized phone matching (09... vs 2519...).
 */
function matchSlotAccount(slotAcc, targetAcc) {
  if (!slotAcc || !targetAcc) return false;
  const sRaw = String(slotAcc).trim().toLowerCase();
  const tRaw = String(targetAcc).trim().toLowerCase();
  if (sRaw === tRaw) return true;

  // Check phone normalization first
  const sNormPhone = normalizePhone(sRaw);
  const tNormPhone = normalizePhone(tRaw);
  if (sNormPhone && tNormPhone && sNormPhone === tNormPhone) return true;

  const sClean = sRaw.replace(/\D/g, '');
  const tClean = tRaw.replace(/\D/g, '');
  if (!sClean || !tClean) return false;

  // Handle masked patterns (e.g. "1000****789", "2519****2277", "09****2277", "1****9707", "****9707")
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

  if (sRaw.includes('*')) {
    const parts = sRaw.split(/\*+/);
    let prefix = parts[0] ? parts[0].replace(/\D/g, '') : '';
    let suffix = parts[parts.length - 1] ? parts[parts.length - 1].replace(/\D/g, '') : '';

    if (prefix.startsWith('2519') || prefix === '9' || prefix === '09') prefix = '09';
    else if (prefix.startsWith('2517') || prefix === '7' || prefix === '07') prefix = '07';

    const checkStr = tNormPhone || tClean;
    if (prefix && !checkStr.startsWith(prefix)) return false;
    if (suffix && !checkStr.endsWith(suffix)) return false;
    return true;
  }

  if (sClean === tClean) return true;
  if (sClean.length >= 4 && tClean.length >= 4) {
    return sClean.endsWith(tClean) || tClean.endsWith(sClean);
  }
  return false;
}

/**
 * Find the exact configured slot and connected agent that received a verified deposit.
 * Priority: exact match > phone match > masked/suffix match.
 * Scans preferred bank, bank family (CBE/CBEAgent, eBirr/Siinqee), all other banks, and telebirr.
 */
function findVerifiedSlot(platform, preferredBank, creditedIdentifier) {
  if (!creditedIdentifier) return null;
  const p = normalizePlatform(platform);
  let b = String(preferredBank || '').toLowerCase().trim();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  if (b === 'cbe_agent') b = 'cbeagent';

  const fullData = readJSON('bank_accounts.json') || {};
  const platBankData = fullData[p] || {};
  const numData = readJSON('numbers.json') || {};
  const platNumData = (numData[p] && Array.isArray(numData[p].numbers)) ? numData[p].numbers : [];

  const targetStr = String(creditedIdentifier).trim();

  const testSlots = (slots, bankName) => {
    if (!Array.isArray(slots) || slots.length === 0) return null;

    // Pass 1: exact match
    for (const slot of slots) {
      if (!slot) continue;
      const acc = slot.account || slot.phone;
      if (!acc) continue;
      const sClean = String(acc).replace(/\D/g, '');
      const tClean = targetStr.replace(/\D/g, '');
      if (sClean && tClean && sClean === tClean) {
        return { slot, bank: bankName, account: acc, connectedAgent: slot.connectedAgent || null, matchType: 'exact' };
      }
      const sPhone = normalizePhone(acc);
      const tPhone = normalizePhone(targetStr);
      if (sPhone && tPhone && sPhone === tPhone) {
        return { slot, bank: bankName, account: acc, connectedAgent: slot.connectedAgent || null, matchType: 'exact_phone' };
      }
    }

    // Pass 2: masked or suffix pattern match
    for (const slot of slots) {
      if (!slot) continue;
      const acc = slot.account || slot.phone;
      if (!acc) continue;
      if (matchSlotAccount(acc, targetStr)) {
        return { slot, bank: bankName, account: acc, connectedAgent: slot.connectedAgent || null, matchType: 'pattern' };
      }
    }

    return null;
  };

  const banksToCheck = [];
  if (b === 'cbe') {
    banksToCheck.push('cbe', 'cbeagent');
  } else if (b === 'cbeagent') {
    banksToCheck.push('cbeagent', 'cbe');
  } else if (b === 'ebirr' || b === 'siinqee') {
    banksToCheck.push('ebirr', 'siinqee');
  } else if (b && b !== 'telebirr') {
    banksToCheck.push(b);
  }

  // Telebirr priority check
  if (b === 'telebirr') {
    const teleMatch = testSlots(platNumData, 'telebirr');
    if (teleMatch) return teleMatch;
  }

  // Preferred bank and family check
  for (const bk of banksToCheck) {
    const match = testSlots(platBankData[bk], bk);
    if (match) return match;
  }

  // All other configured banks
  for (const [bk, slots] of Object.entries(platBankData)) {
    if (bk === 'bankStatus' || banksToCheck.includes(bk)) continue;
    const match = testSlots(slots, bk);
    if (match) return match;
  }

  // Fallback telebirr numbers check
  if (b !== 'telebirr') {
    const teleMatch = testSlots(platNumData, 'telebirr');
    if (teleMatch) return teleMatch;
  }

  return null;
}

/**
 * Deduct deposit amount from connected bank account or agent pool.
 * If account is connected to an agent, deducts from the agent's shared pool.
 */
function deductBankDepositLimit(platform, bank, accountNumber, amount, fallbackAccount = null, assignedAgent = null) {
  const p = normalizePlatform(platform);
  let b = String(bank || '').toLowerCase().trim();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  if (b === 'cbe_agent') b = 'cbeagent';
  const amt = Number(amount) || 0;
  if (amt <= 0) return null;

  const fullData = readJSON('bank_accounts.json') || {};
  if (!fullData[p]) return null;

  const isCbeFamily = (b === 'cbe' || b === 'cbeagent');
  const isEbirrFamily = (b === 'ebirr' || b === 'siinqee');
  const isTelebirr = (b === 'telebirr');

  let slot = null;
  let slotBank = b;

  // Search by verified account / phone using slot resolution
  if (accountNumber && (/\d/.test(String(accountNumber)) || String(accountNumber).includes('*'))) {
    const found = findVerifiedSlot(p, b, accountNumber);
    if (found) {
      slot = found.slot;
      slotBank = found.bank;
    }
  }

  if (!slot && fallbackAccount && (/\d/.test(String(fallbackAccount)) || String(fallbackAccount).includes('*'))) {
    const foundFb = findVerifiedSlot(p, b, fallbackAccount);
    if (foundFb) {
      slot = foundFb.slot;
      slotBank = foundFb.bank;
    }
  }

  // Fallback: match by assignedAgent if not found by account string
  if (!slot && assignedAgent) {
    const agKey = normalizeAgent(assignedAgent);
    if (isTelebirr) {
      const numData = readJSON('numbers.json') || {};
      const numSlots = (numData[p] && Array.isArray(numData[p].numbers)) ? numData[p].numbers : [];
      slot = numSlots.find(n => normalizeAgent(n.connectedAgent) === agKey);
    } else {
      let slots = Array.isArray(fullData[p][b]) ? fullData[p][b] : [];
      slot = slots.find(a => normalizeAgent(a.connectedAgent) === agKey);
      if (!slot && isCbeFamily) {
        const altBank = (b === 'cbe') ? 'cbeagent' : 'cbe';
        const altSlots = Array.isArray(fullData[p][altBank]) ? fullData[p][altBank] : [];
        slot = altSlots.find(a => normalizeAgent(a.connectedAgent) === agKey);
        if (slot) slotBank = altBank;
      }
      if (!slot && isEbirrFamily) {
        const altBank = (b === 'ebirr') ? 'siinqee' : 'ebirr';
        const altSlots = Array.isArray(fullData[p][altBank]) ? fullData[p][altBank] : [];
        slot = altSlots.find(a => normalizeAgent(a.connectedAgent) === agKey);
        if (slot) slotBank = altBank;
      }
    }
  }

  // Fallback: direct deduction from shared agent limit if assignedAgent exists in agentLimits
  if (!slot && assignedAgent) {
    const agKey = normalizeAgent(assignedAgent);
    if (fullData.agentLimits && fullData.agentLimits[agKey]) {
      const currentInit = Number(fullData.agentLimits[agKey].initialLimit) || 0;
      const currentRem = (fullData.agentLimits[agKey].remainingLimit !== undefined && fullData.agentLimits[agKey].remainingLimit !== null)
        ? Number(fullData.agentLimits[agKey].remainingLimit)
        : currentInit;
      const newRemaining = Math.max(0, Math.round((currentRem - amt) * 100) / 100);

      fullData.agentLimits[agKey] = {
        initialLimit: currentInit,
        remainingLimit: newRemaining
      };

      for (const [pl, bMap] of Object.entries(fullData)) {
        if (!bMap || typeof bMap !== 'object' || pl === 'agentLimits') continue;
        for (const [bk, accs] of Object.entries(bMap)) {
          if (!Array.isArray(accs)) continue;
          accs.forEach(a => {
            if (a && normalizeAgent(a.connectedAgent) === agKey) {
              a.initialLimit = currentInit;
              a.remainingLimit = newRemaining;
            }
          });
        }
      }
      writeJSON('bank_accounts.json', fullData);

      const numData = readJSON('numbers.json');
      if (numData) {
        let numChanged = false;
        for (const [pl, pData] of Object.entries(numData)) {
          if (!pData || !Array.isArray(pData.numbers)) continue;
          pData.numbers.forEach(n => {
            if (n && normalizeAgent(n.connectedAgent) === agKey) {
              n.initialLimit = currentInit;
              n.remainingLimit = newRemaining;
              numChanged = true;
            }
          });
        }
        if (numChanged) writeJSON('numbers.json', numData);
      }

      console.log(`[Bank Limit] Deposit ${amt} ETB deducted directly from shared agent pool '${agKey}'. Prev: ${currentRem}, New Remaining: ${newRemaining}`);
      return { agent: agKey, initialLimit: currentInit, remainingLimit: newRemaining };
    }
  }

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

    const numData = readJSON('numbers.json');
    if (numData) {
      let numChanged = false;
      for (const [pl, pData] of Object.entries(numData)) {
        if (!pData || !Array.isArray(pData.numbers)) continue;
        pData.numbers.forEach(n => {
          if (n && normalizeAgent(n.connectedAgent) === agentKey) {
            n.initialLimit = currentInit;
            n.remainingLimit = newRemaining;
            numChanged = true;
          }
        });
      }
      if (numChanged) {
        writeJSON('numbers.json', numData);
      }
    }

    console.log(`[Bank Limit] Deposit ${amt} ETB deducted from shared agent pool '${agentKey}' (via ${p}/${slotBank} ${slot.account || slot.phone}). Prev: ${currentRem}, New Remaining: ${newRemaining}`);
    return { ...slot, remainingLimit: newRemaining, initialLimit: currentInit };
  }

  // Case 2: Standalone account with its own limit (no agent)
  const hasLimit = (slot.remainingLimit !== undefined && slot.remainingLimit !== null) ||
                   (slot.initialLimit !== undefined && slot.initialLimit !== null);
  if (hasLimit) {
    const prev = Number(slot.remainingLimit !== undefined && slot.remainingLimit !== null ? slot.remainingLimit : slot.initialLimit);
    const init = (slot.initialLimit !== undefined && slot.initialLimit !== null) ? Number(slot.initialLimit) : prev;
    const newRem = Math.max(0, Math.round((prev - amt) * 100) / 100);
    slot.initialLimit = init;
    slot.remainingLimit = newRem;

    if (isTelebirr) {
      const numData = readJSON('numbers.json') || {};
      if (numData[p] && Array.isArray(numData[p].numbers)) {
        const found = numData[p].numbers.find(n => n.id === slot.id || n.phone === slot.phone);
        if (found) {
          found.initialLimit = init;
          found.remainingLimit = newRem;
          writeJSON('numbers.json', numData);
        }
      }
    } else {
      writeJSON('bank_accounts.json', fullData);
    }

    console.log(`[Bank Limit] Deposit ${amt} ETB deducted from standalone ${p}/${slotBank} account ${slot.account || slot.phone}. Prev: ${prev}, New Remaining: ${newRem}`);
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
  let b = String(bank || '').toLowerCase().trim();
  if (b === 'siinqee' || b === 'sinqee') b = 'ebirr';
  if (b === 'cbe_agent') b = 'cbeagent';
  const amt = Number(amount) || 0;
  if (amt <= 0) return null;

  const fullData = readJSON('bank_accounts.json') || {};
  const agentKey = normalizeAgent(agentUsername);

  if (agentKey && agentKey !== 'admin') {
    if (!fullData.agentLimits) fullData.agentLimits = {};

    let currentInit = 0;
    let currentRem = 0;

    if (fullData.agentLimits[agentKey]) {
      currentInit = Number(fullData.agentLimits[agentKey].initialLimit) || 0;
      currentRem = Number(fullData.agentLimits[agentKey].remainingLimit) || 0;
    } else {
      // Find from any connected slot in bank_accounts.json
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

      // Also search numbers.json if not found in bank_accounts.json
      if (currentInit === 0 && currentRem === 0) {
        const numData = readJSON('numbers.json') || {};
        for (const [pl, pData] of Object.entries(numData)) {
          if (!pData || !Array.isArray(pData.numbers)) continue;
          const found = pData.numbers.find(n => normalizeAgent(n.connectedAgent) === agentKey);
          if (found) {
            currentInit = Number(found.initialLimit) || 0;
            currentRem = Number(found.remainingLimit !== undefined && found.remainingLimit !== null ? found.remainingLimit : found.initialLimit) || 0;
            break;
          }
        }
      }
    }

    if (currentInit > 0 || currentRem > 0) {
      const cap = currentInit > 0 ? currentInit : (currentRem + amt);
      const newRemaining = Math.min(cap, Math.round((currentRem + amt) * 100) / 100);

      fullData.agentLimits[agentKey] = {
        initialLimit: cap,
        remainingLimit: newRemaining
      };

      // Sync to ALL slots connected to this agent in bank_accounts.json
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

      // Also sync to numbers.json for telebirr slots connected to this agent
      const numData = readJSON('numbers.json');
      if (numData) {
        let numChanged = false;
        for (const [pl, pData] of Object.entries(numData)) {
          if (!pData || !Array.isArray(pData.numbers)) continue;
          pData.numbers.forEach(n => {
            if (n && normalizeAgent(n.connectedAgent) === agentKey) {
              n.initialLimit = cap;
              n.remainingLimit = newRemaining;
              numChanged = true;
            }
          });
        }
        if (numChanged) {
          writeJSON('numbers.json', numData);
        }
      }

      console.log(`[Bank Limit] Withdrawal ${amt} ETB replenished shared agent pool '${agentKey}'. Prev: ${currentRem}, New Remaining: ${newRemaining} (cap: ${cap})`);
      return { agent: agentKey, initialLimit: cap, remainingLimit: newRemaining };
    }
  }

  // Fallback for specific account without agent
  if (specificAccount && b === 'telebirr') {
    const numData = readJSON('numbers.json') || {};
    if (numData[p] && Array.isArray(numData[p].numbers)) {
      const sAcc = normalizePhone(specificAccount);
      const slot = numData[p].numbers.find(n => normalizePhone(n.phone) === sAcc);
      if (slot && (slot.remainingLimit !== undefined && slot.remainingLimit !== null)) {
        const prev = Number(slot.remainingLimit);
        const cap = (slot.initialLimit !== undefined && slot.initialLimit !== null) ? Number(slot.initialLimit) : (prev + amt);
        slot.remainingLimit = Math.min(cap, Math.round((prev + amt) * 100) / 100);
        writeJSON('numbers.json', numData);
        return slot;
      }
    }
  } else if (specificAccount && fullData[p]) {
    const sClean = String(specificAccount).replace(/\D/g, '');
    let slots = Array.isArray(fullData[p][b]) ? fullData[p][b] : [];
    let slot = slots.find(a => String(a.account || '').replace(/\D/g, '') === sClean);
    if (!slot && (b === 'cbe' || b === 'cbeagent')) {
      const altBank = (b === 'cbe') ? 'cbeagent' : 'cbe';
      const altSlots = Array.isArray(fullData[p][altBank]) ? fullData[p][altBank] : [];
      slot = altSlots.find(a => String(a.account || '').replace(/\D/g, '') === sClean);
    }
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
function getAgentConnectedAccounts(agentUsername, platformFilter) {
  if (!agentUsername) return [];
  const uName = normalizeAgent(agentUsername);
  const pFilter = platformFilter && platformFilter !== 'all' ? normalizePlatform(platformFilter) : null;
  const fullData = readJSON('bank_accounts.json') || {};
  const connected = [];

  const agentLim = (fullData.agentLimits && fullData.agentLimits[uName]) ? fullData.agentLimits[uName] : null;

  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    if (pFilter && plat !== pFilter) continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (bank === 'telebirr') continue;
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

  // Also check numbers.json for telebirr
  const numData = readJSON('numbers.json') || {};
  for (const [plat, pObj] of Object.entries(numData)) {
    if (typeof pObj !== 'object' || !pObj || !Array.isArray(pObj.numbers)) continue;
    if (pFilter && plat !== pFilter) continue;
    pObj.numbers.forEach(n => {
      if (n && n.connectedAgent && normalizeAgent(n.connectedAgent) === uName) {
        const agentLim = (fullData.agentLimits && fullData.agentLimits[uName]) ? fullData.agentLimits[uName] : null;
        const already = connected.some(c => c.bank === 'telebirr' && (c.account === n.phone || (c.platform === plat && c.id === n.id)));
        if (!already) {
          const init = agentLim ? Number(agentLim.initialLimit) : Number(n.initialLimit) || 0;
          const rem = agentLim ? Number(agentLim.remainingLimit) : (n.remainingLimit !== undefined && n.remainingLimit !== null ? Number(n.remainingLimit) : init);
          connected.push({
            platform: plat,
            bank: 'telebirr',
            id: n.id,
            account: n.phone,
            label: n.label || `Telebirr ${n.phone}`,
            active: n.active !== false,
            connectedAgent: n.connectedAgent,
            initialLimit: init,
            remainingLimit: rem
          });
        }
      }
    });
  }

  return connected;
}

/**
 * Get all connected bank accounts across all agents, platforms, and banks.
 */
function getAllConnectedAccounts(platformFilter) {
  const pFilter = platformFilter && platformFilter !== 'all' ? normalizePlatform(platformFilter) : null;
  const fullData = readJSON('bank_accounts.json') || {};
  const connected = [];

  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    if (pFilter && plat !== pFilter) continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (bank === 'telebirr') continue;
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

  // Also check numbers.json for telebirr
  const numData = readJSON('numbers.json') || {};
  for (const [plat, pObj] of Object.entries(numData)) {
    if (typeof pObj !== 'object' || !pObj || !Array.isArray(pObj.numbers)) continue;
    if (pFilter && plat !== pFilter) continue;
    pObj.numbers.forEach(n => {
      if (n && n.connectedAgent) {
        const ag = normalizeAgent(n.connectedAgent);
        const agentLim = (fullData.agentLimits && fullData.agentLimits[ag]) ? fullData.agentLimits[ag] : null;
        const already = connected.some(c => c.bank === 'telebirr' && (c.account === n.phone || (c.platform === plat && c.id === n.id)));
        if (!already) {
          const init = agentLim ? Number(agentLim.initialLimit) : Number(n.initialLimit) || 0;
          const rem = agentLim ? Number(agentLim.remainingLimit) : (n.remainingLimit !== undefined && n.remainingLimit !== null ? Number(n.remainingLimit) : init);
          connected.push({
            platform: plat,
            bank: 'telebirr',
            id: n.id,
            account: n.phone,
            label: n.label || `Telebirr ${n.phone}`,
            active: n.active !== false,
            connectedAgent: n.connectedAgent,
            initialLimit: init,
            remainingLimit: rem
          });
        }
      }
    });
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

  // Next collect accounts from bank_accounts.json
  for (const [plat, bankMap] of Object.entries(fullData)) {
    if (typeof bankMap !== 'object' || !bankMap || plat === 'agentLimits') continue;
    for (const [bank, accs] of Object.entries(bankMap)) {
      if (bank === 'telebirr') continue;
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

  // Also collect Telebirr numbers from numbers.json
  const numData = readJSON('numbers.json') || {};
  for (const [plat, pObj] of Object.entries(numData)) {
    if (typeof pObj !== 'object' || !pObj || !Array.isArray(pObj.numbers)) continue;
    pObj.numbers.forEach(n => {
      if (n && n.connectedAgent) {
        const ag = normalizeAgent(n.connectedAgent);
        if (!pools[ag]) {
          pools[ag] = {
            agent: ag,
            initialLimit: Number(n.initialLimit) || 0,
            remainingLimit: (n.remainingLimit !== undefined && n.remainingLimit !== null) ? Number(n.remainingLimit) : Number(n.initialLimit) || 0,
            accounts: []
          };
        }
        const already = pools[ag].accounts.some(a => a.bank === 'telebirr' && (a.account === n.phone || (a.platform === plat && a.id === n.id)));
        if (!already) {
          pools[ag].accounts.push({
            platform: plat,
            bank: 'telebirr',
            id: n.id,
            account: n.phone,
            label: n.label || `Account ${n.id}`,
            active: n.active !== false
          });
        }
      }
    });
  }

  return Object.values(pools);
}

module.exports = {
  deductBankDepositLimit,
  findVerifiedSlot,
  matchSlotAccount,
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
