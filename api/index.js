require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');

const { initDatabase, getRegistrations, addRegistration } = require('../database');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Block direct access to sensitive backend files
app.get(/^\/(server\.js|database\.js|package\.json|package-lock\.json|\.env.*)/, (req, res) => {
  res.status(403).send('Access Forbidden');
});

// Admin authentication check middleware
function checkAdminAuth(req, res, next) {
  if (req.cookies.admin_session === 'authenticated') {
    next();
  } else {
    // For API requests, return 401. For page requests, we can let the client-side script handle the login modal.
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      next(); // Let the frontend load and check auth via API
    }
  }
}

// -------------------------------------------------------------------
// PUBLIC APIs
// -------------------------------------------------------------------

// 1. Submit registration
app.post('/api/register', async (req, res) => {
  try {
    const { full_name, phone, email, workshop_date, workshop_type, note, referral_code } = req.body;

    if (!full_name || !phone || !email || !workshop_date || !workshop_type) {
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ các thông tin bắt buộc.' });
    }

    // Phone format check (10 digits numeric)
    const phoneClean = phone.replace(/[\s\-\(\)]/g, '');
    if (!/^\d{10}$/.test(phoneClean)) {
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ. Vui lòng nhập đúng 10 chữ số.' });
    }

    const regData = {
      full_name: full_name.trim(),
      phone: phoneClean,
      email: email.trim().toLowerCase(),
      workshop_date: workshop_date.trim(),
      workshop_type: workshop_type.trim(),
      note: note ? note.trim() : '',
      referral_code: referral_code ? referral_code.trim().toUpperCase() : ''
    };

    const newReg = await addRegistration(regData);
    res.status(201).json({ success: true, registration: newReg });
  } catch (error) {
    console.error('[Server] Registration error:', error);
    res.status(500).json({ error: 'Đã xảy ra lỗi hệ thống khi lưu đăng ký.' });
  }
});

// 2. Fetch specific referral portal data (limited & masked data)
app.get('/api/referral/:code', async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ error: 'Mã giới thiệu không hợp lệ.' });
    }

    const allRegs = await getRegistrations();
    const referrals = allRegs.filter(r => (r.referral_code || '').toUpperCase() === code);

    // Mask sensitive info (phone, email) for privacy
    const maskedReferrals = referrals.map(r => {
      // Phone mask (e.g. 0912***789)
      let maskedPhone = r.phone;
      if (r.phone && r.phone.length === 10) {
        maskedPhone = `${r.phone.substring(0, 4)}***${r.phone.substring(7)}`;
      }
      
      // Email mask (e.g. te***@domain.com)
      let maskedEmail = r.email;
      if (r.email && r.email.includes('@')) {
        const parts = r.email.split('@');
        const mailbox = parts[0];
        const domain = parts[1];
        const maskedMailbox = mailbox.length > 2 
          ? `${mailbox.substring(0, 2)}***` 
          : `${mailbox.substring(0, 1)}***`;
        maskedEmail = `${maskedMailbox}@${domain}`;
      }

      return {
        id: r.id,
        created_at: r.created_at,
        full_name: r.full_name,
        phone: maskedPhone,
        email: maskedEmail,
        workshop_date: r.workshop_date,
        workshop_type: r.workshop_type
      };
    });

    res.json({
      referral_code: code,
      total: referrals.length,
      list: maskedReferrals
    });
  } catch (error) {
    console.error('[Server] Referral error:', error);
    res.status(500).json({ error: 'Lỗi tải thống kê giới thiệu.' });
  }
});

// 3. Export Excel for Referral Portal (masked for security, clean Excel file)
app.get('/api/referral/:code/export', async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    if (!code) {
      return res.status(400).send('Mã giới thiệu không hợp lệ.');
    }

    const allRegs = await getRegistrations();
    const referrals = allRegs.filter(r => (r.referral_code || '').toUpperCase() === code);

    if (referrals.length === 0) {
      return res.status(404).send('Không có dữ liệu đăng ký nào cho mã giới thiệu này.');
    }

    // Masked format for safety
    const exportData = referrals.map((r, index) => {
      let maskedPhone = r.phone;
      if (r.phone && r.phone.length === 10) {
        maskedPhone = `${r.phone.substring(0, 4)}***${r.phone.substring(7)}`;
      }
      let maskedEmail = r.email;
      if (r.email && r.email.includes('@')) {
        const parts = r.email.split('@');
        const mailbox = parts[0];
        const domain = parts[1];
        const maskedMailbox = mailbox.length > 2 ? `${mailbox.substring(0, 2)}***` : `${mailbox.substring(0, 1)}***`;
        maskedEmail = `${maskedMailbox}@${domain}`;
      }

      return {
        'STT': index + 1,
        'ID Đăng ký': r.id,
        'Thời gian đăng ký': r.created_at,
        'Họ và tên': r.full_name,
        'Số điện thoại': maskedPhone,
        'Email': maskedEmail,
        'Ngày Workshop': r.workshop_date,
        'Loại Workshop': r.workshop_type
      };
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(exportData);
    
    // Set column widths
    const max_widths = [
      { wch: 6 },  // STT
      { wch: 12 }, // ID
      { wch: 22 }, // Date time
      { wch: 25 }, // Name
      { wch: 15 }, // Phone
      { wch: 25 }, // Email
      { wch: 18 }, // Workshop Date
      { wch: 25 }  // Workshop Type
    ];
    ws['!cols'] = max_widths;

    xlsx.utils.book_append_sheet(wb, ws, `Referral - ${code}`);
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=referral_${code}_registrations.xlsx`);
    res.send(buffer);
  } catch (error) {
    console.error('[Server] Export error:', error);
    res.status(500).send('Lỗi xuất file excel.');
  }
});

// -------------------------------------------------------------------
// ADMIN APIs (Auth Protected)
// -------------------------------------------------------------------

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const systemUser = process.env.ADMIN_USER || 'admin';
  const systemPass = process.env.ADMIN_PASS || 'MercyTech2026!';

  if (username === systemUser && password === systemPass) {
    // Set authenticated cookie (1 day)
    res.cookie('admin_session', 'authenticated', {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'strict'
    });
    return res.json({ success: true });
  }

  res.status(401).json({ error: 'Tài khoản hoặc mật khẩu không chính xác.' });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.json({ success: true });
});

// Check status session
app.get('/api/admin/check-session', (req, res) => {
  if (req.cookies.admin_session === 'authenticated') {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

// Fetch registrations list
app.get('/api/admin/registrations', checkAdminAuth, async (req, res) => {
  try {
    const regs = await getRegistrations();
    
    let { page, limit, search, sort_by, sort_order, referral_code } = req.query;
    
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 10;
    sort_by = sort_by || 'created_at';
    sort_order = sort_order || 'desc';
    
    let filtered = [...regs];

    // Search filter
    if (search) {
      const query = search.toLowerCase();
      filtered = filtered.filter(r => 
        r.full_name.toLowerCase().includes(query) ||
        r.phone.includes(query) ||
        r.email.toLowerCase().includes(query) ||
        (r.referral_code || '').toLowerCase().includes(query)
      );
    }

    // Referral filter
    if (referral_code) {
      const refQuery = referral_code.trim().toUpperCase();
      filtered = filtered.filter(r => (r.referral_code || '').toUpperCase() === refQuery);
    }

    // Sort logic
    filtered.sort((a, b) => {
      let valA = a[sort_by];
      let valB = b[sort_by];

      // Handle ID sorting
      if (sort_by === 'id') {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      }

      if (valA < valB) return sort_order === 'asc' ? -1 : 1;
      if (valA > valB) return sort_order === 'asc' ? 1 : -1;
      return 0;
    });

    // Pagination
    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginated = filtered.slice(startIndex, endIndex);

    res.json({
      registrations: paginated,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('[Server] Fetch error:', error);
    res.status(500).json({ error: 'Lỗi tải danh sách đăng ký.' });
  }
});

// Admin stats dashboard
app.get('/api/admin/stats', checkAdminAuth, async (req, res) => {
  try {
    const regs = await getRegistrations();
    
    const totalRegistrations = regs.length;

    // Track unique referral codes
    const referralsMap = {};
    let totalReferralsCount = 0;

    // Date variables (using local time logic)
    const now = new Date();
    
    // Format dates to compare with registration strings
    const todayStr = now.toLocaleDateString('vi-VN');
    
    // Start of this week
    const startOfWeek = new Date();
    startOfWeek.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); // Mon
    startOfWeek.setHours(0,0,0,0);

    // Start of this month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    startOfMonth.setHours(0,0,0,0);

    let countToday = 0;
    let countThisWeek = 0;
    let countThisMonth = 0;

    regs.forEach(r => {
      // Stat by Referral
      if (r.referral_code) {
        const code = r.referral_code.toUpperCase();
        referralsMap[code] = (referralsMap[code] || 0) + 1;
      }

      // Parse created_at string
      // Format is like "24/06/2026, 16:15:30" or "24/06/2026 16:15:30"
      if (r.created_at) {
        const datePart = r.created_at.split(',')[0].split(' ')[0]; // extracts "24/06/2026"
        
        // Match today
        if (datePart === todayStr) {
          countToday++;
        }

        // Convert date string dd/mm/yyyy to Date object
        const dateParts = datePart.split('/');
        if (dateParts.length === 3) {
          const regDate = new Date(dateParts[2], dateParts[1] - 1, dateParts[0]);
          
          if (regDate >= startOfWeek) {
            countThisWeek++;
          }
          if (regDate >= startOfMonth) {
            countThisMonth++;
          }
        }
      }
    });

    const uniqueReferrals = Object.keys(referralsMap);
    totalReferralsCount = uniqueReferrals.length;

    // Top referrals
    const topReferrals = uniqueReferrals
      .map(code => ({ code, count: referralsMap[code] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5); // top 5

    res.json({
      totalRegistrations,
      totalReferrals: totalReferralsCount,
      topReferrals,
      countToday,
      countThisWeek,
      countThisMonth
    });
  } catch (error) {
    console.error('[Server] Stats error:', error);
    res.status(500).json({ error: 'Lỗi tải thống kê tổng hợp.' });
  }
});

// Admin export full Excel
app.get('/api/admin/export', checkAdminAuth, async (req, res) => {
  try {
    const regs = await getRegistrations();
    let filtered = [...regs];
    const { referral_code } = req.query;

    if (referral_code) {
      const code = referral_code.trim().toUpperCase();
      filtered = filtered.filter(r => (r.referral_code || '').toUpperCase() === code);
    }

    if (filtered.length === 0) {
      return res.status(404).send('Không có dữ liệu để xuất file.');
    }

    const exportData = filtered.map((r, index) => ({
      'STT': index + 1,
      'ID Đăng ký': r.id,
      'Thời gian đăng ký': r.created_at,
      'Họ và tên': r.full_name,
      'Số điện thoại': r.phone,
      'Email': r.email,
      'Ngày Workshop': r.workshop_date,
      'Loại Workshop': r.workshop_type,
      'Mã giới thiệu': r.referral_code || 'Không có',
      'Ghi chú': r.note || ''
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(exportData);

    // Set column widths
    const max_widths = [
      { wch: 6 },   // STT
      { wch: 12 },  // ID
      { wch: 22 },  // Created at
      { wch: 25 },  // Name
      { wch: 15 },  // Phone
      { wch: 25 },  // Email
      { wch: 18 },  // Date
      { wch: 25 },  // Type
      { wch: 15 },  // Ref
      { wch: 35 }   // Note
    ];
    ws['!cols'] = max_widths;

    const sheetName = referral_code ? `Referral - ${referral_code}` : "All Registrations";
    xlsx.utils.book_append_sheet(wb, ws, sheetName);
    
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = referral_code ? `registrations_referral_${referral_code}.xlsx` : 'all_registrations.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buffer);
  } catch (error) {
    console.error('[Server] Admin export error:', error);
    res.status(500).send('Lỗi xuất báo cáo excel.');
  }
});

// -------------------------------------------------------------------
// PAGE ROUTING & STATIC FILE FALLBACK
// -------------------------------------------------------------------

// Serve Admin UI
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

// Serve Referral portal UI (matching path like /referral/ABC123)
app.get('/referral/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'referral.html'));
});

// Serve all other static content
app.use(express.static(path.join(__dirname, '..'), { dotfiles: 'ignore' }));

// Start Server Wrapper
const startServer = async () => {
  try {
    // Initialize local database (if running locally)
    await initDatabase();
    
    // Only listen to port if NOT running on Vercel Serverless environment
    if (!process.env.VERCEL) {
      app.listen(PORT, () => {
        console.log(`[Server] Starting server on http://localhost:${PORT}`);
      });
    } else {
      console.log('[Server] Running as a Serverless function on Vercel.');
    }
  } catch (err) {
    console.error('[Server] Failed to initialize server:', err);
  }
};

startServer();

module.exports = app;
