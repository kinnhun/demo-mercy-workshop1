const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const DB_DIR = path.join(__dirname, 'workshop-data');
const DB_FILE = path.join(DB_DIR, 'registrations.json');

// Sequential queue to prevent parallel local Git commits/file writes from conflicting
let writeQueue = Promise.resolve();

// Check if Git is initialized in DB_DIR, initialize if not (Only for local mode)
async function initDatabase() {
  // If we are in GitHub API mode, we do not need local git initialization
  if (process.env.GITHUB_TOKEN) {
    console.log('[Database] Running in GitHub API Remote mode.');
    return;
  }

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
      console.log('[Database] Local Git repository initialized successfully.');
    } catch (error) {
      console.error('[Database] Failed to initialize local Git repository:', error);
    }
  } else {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  }
}

// -------------------------------------------------------------------
// GITHUB API MODE HELPERS
// -------------------------------------------------------------------

function getGitHubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_REPO_OWNER,
    repo: process.env.GITHUB_REPO_NAME,
    filePath: 'workshop-data/registrations.json', // Path inside the repo
    branch: process.env.GITHUB_BRANCH || 'main'
  };
}

// Fetch file from GitHub API
async function fetchFromGitHub() {
  const config = getGitHubConfig();
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Vercel-Express-App'
    }
  });

  if (response.status === 404) {
    return { list: [], sha: null };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API read failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
  let list = [];
  try {
    list = JSON.parse(contentStr || '[]');
  } catch (e) {
    console.error('[Database] Error parsing GitHub JSON content, defaulting to empty array:', e);
    list = [];
  }

  return { list, sha: data.sha };
}

// Commit file to GitHub API
async function commitToGitHub(list, sha, commitMessage) {
  const config = getGitHubConfig();
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}`;
  
  const contentBase64 = Buffer.from(JSON.stringify(list, null, 2), 'utf8').toString('base64');
  
  const payload = {
    message: commitMessage,
    content: contentBase64,
    branch: config.branch
  };

  if (sha) {
    payload.sha = sha;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Vercel-Express-App',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API write failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.content.sha;
}

// -------------------------------------------------------------------
// PUBLIC DATABASE APIs
// -------------------------------------------------------------------

// Read registrations (Unified interface, now async)
async function getRegistrations() {
  // Mode 1: GitHub API Mode
  if (process.env.GITHUB_TOKEN) {
    try {
      const { list } = await fetchFromGitHub();
      return list;
    } catch (error) {
      console.error('[Database] GitHub API fetch registrations error:', error);
      return [];
    }
  }

  // Mode 2: Local File Mode
  try {
    if (!fs.existsSync(DB_FILE)) {
      return [];
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (error) {
    console.error('[Database] Local file read error:', error);
    return [];
  }
}

// Add a registration (Unified interface, handles queue locally or API requests)
function addRegistration(regData) {
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        // Mode 1: GitHub API Mode
        if (process.env.GITHUB_TOKEN) {
          console.log('[Database] Saving registration via GitHub API...');
          
          // 1. Fetch current list & file SHA
          const { list, sha } = await fetchFromGitHub();
          
          // 2. Generate next ID
          let nextId = 125;
          if (list.length > 0) {
            const maxId = Math.max(...list.map(r => Number(r.id) || 0));
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

          list.push(newReg);

          // 3. Commit back to GitHub
          const msg = `Add registration ID ${newReg.id} - ${newReg.full_name}`;
          await commitToGitHub(list, sha, msg);
          
          console.log(`[Database] Saved and committed ID ${newReg.id} directly to GitHub.`);
          resolve(newReg);
          return;
        }

        // Mode 2: Local File Mode
        const regs = await getRegistrations();
        
        let nextId = 125;
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
        
        fs.writeFileSync(DB_FILE, JSON.stringify(regs, null, 2), 'utf8');
        console.log(`[Database] Added registration ID ${newReg.id} locally.`);

        // Auto commit to local git
        try {
          await execPromise('git add registrations.json', { cwd: DB_DIR });
          await execPromise(`git commit -m "Add registration ID ${newReg.id} - ${newReg.full_name}"`, { cwd: DB_DIR });
          console.log(`[Database] Committed ID ${newReg.id} to local Git repository.`);
        } catch (gitError) {
          console.error('[Database] Local Git commit error:', gitError.message);
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
