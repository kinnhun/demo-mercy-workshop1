const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const DB_DIR = path.join(__dirname, 'workshop-data');
const DB_FILE = path.join(DB_DIR, 'registrations.json');

// Sequential queue to prevent parallel Git commits from conflicting
let writeQueue = Promise.resolve();

// Check if Git is initialized in DB_DIR, initialize if not
async function initDatabase() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const gitDir = path.join(DB_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      console.log('[Database] Initializing new Git repository in workshop-data...');
      await execPromise('git init', { cwd: DB_DIR });
      
      // Create empty registrations file
      if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
      }
      
      // Initial commit
      await execPromise('git add registrations.json', { cwd: DB_DIR });
      await execPromise('git commit -m "Initialize workshop database"', { cwd: DB_DIR });
      console.log('[Database] Git repository initialized successfully.');
    } catch (error) {
      console.error('[Database] Failed to initialize Git repository:', error);
    }
  } else {
    // If folder exists but registrations.json doesn't
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  }

  // Setup Git Remote if provided in environment
  const remoteUrl = process.env.GIT_REMOTE_URL;
  if (remoteUrl) {
    try {
      // Check if remote already exists
      const { stdout } = await execPromise('git remote', { cwd: DB_DIR });
      if (!stdout.includes('origin')) {
        console.log(`[Database] Adding Git remote origin: ${remoteUrl}`);
        await execPromise(`git remote add origin ${remoteUrl}`, { cwd: DB_DIR });
      } else {
        // Update remote URL in case it changed
        await execPromise(`git remote set-url origin ${remoteUrl}`, { cwd: DB_DIR });
      }
    } catch (error) {
      console.error('[Database] Error setting git remote URL:', error);
    }
  }
}

// Read registrations
function getRegistrations() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return [];
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (error) {
    console.error('[Database] Error reading database file:', error);
    return [];
  }
}

// Add a registration (runs inside the sequential queue)
function addRegistration(regData) {
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const regs = getRegistrations();
        
        // Find next ID
        let nextId = 125; // User example starts from 125
        if (regs.length > 0) {
          const maxId = Math.max(...regs.map(r => Number(r.id) || 0));
          if (maxId >= 125) {
            nextId = maxId + 1;
          }
        }

        const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const newReg = {
          id: nextId,
          created_at: timestamp,
          full_name: regData.full_name,
          phone: regData.phone,
          email: regData.email,
          workshop_date: regData.workshop_date,
          workshop_type: regData.workshop_type,
          note: regData.note || '',
          referral_code: regData.referral_code ? regData.referral_code.trim().toUpperCase() : ''
        };

        regs.push(newReg);
        
        // Write file
        fs.writeFileSync(DB_FILE, JSON.stringify(regs, null, 2), 'utf8');
        console.log(`[Database] Added registration ID ${newReg.id} successfully.`);

        // Auto commit to git
        try {
          await execPromise('git add registrations.json', { cwd: DB_DIR });
          await execPromise(`git commit -m "Add registration ID ${newReg.id} - ${newReg.full_name}"`, { cwd: DB_DIR });
          console.log(`[Database] Committed registration ID ${newReg.id} to local Git repository.`);
          
          // Try to push to remote if configured
          if (process.env.GIT_REMOTE_URL) {
            console.log('[Database] Attempting to push to remote repository...');
            // git push -u origin master/main depending on active branch
            const { stdout: branchName } = await execPromise('git rev-parse --abbrev-ref HEAD', { cwd: DB_DIR });
            const branch = branchName.trim();
            await execPromise(`git push -u origin ${branch}`, { cwd: DB_DIR });
            console.log('[Database] Pushed to remote successfully.');
          }
        } catch (gitError) {
          // Log git error, but don't fail the registration registration itself
          console.error('[Database] Git commit/push error (saved locally, check configuration):', gitError.message);
        }

        resolve(newReg);
      } catch (error) {
        console.error('[Database] Failed to save registration:', error);
        reject(error);
      }
    });
  });
}

module.exports = {
  initDatabase,
  getRegistrations,
  addRegistration
};
