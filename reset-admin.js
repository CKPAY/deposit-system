const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, 'data', 'settings.json');

const newUsername = process.argv[2] || 'admin';
const newPassword = process.argv[3] || 'ckpay2024!';

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    settings = {};
  }
}

// Ensure adminUsers array exists
if (!Array.isArray(settings.adminUsers) || settings.adminUsers.length === 0) {
  settings.adminUsers = [
    { username: 'admin', password: settings.adminPassword || 'ckpay2024!' }
  ];
}

const existingIdx = settings.adminUsers.findIndex(u => u.username.toLowerCase() === newUsername.toLowerCase());
if (existingIdx !== -1) {
  settings.adminUsers[existingIdx].password = newPassword;
} else {
  settings.adminUsers.push({ username: newUsername, password: newPassword });
}

// Keep legacy fields synced for compatibility
settings.adminUsername = newUsername;
settings.adminPassword = newPassword;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log('====================================================');
console.log('✅ ADMIN CREDENTIALS RESET SUCCESSFULLY!');
console.log('----------------------------------------------------');
console.log(`Username : ${newUsername}`);
console.log(`Password : ${newPassword}`);
console.log('====================================================');
