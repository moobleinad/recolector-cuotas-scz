const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SALT = 'SANTA_CRUZ_CUOTAS_SECURE_SALT_2026';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure images directory exists
const imagesDir = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Database setup
const dbPath = process.env.DB_PATH || path.join(__dirname, 'cuotas.db');
const db = new DatabaseSync(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'DIRECTIVO', -- Rol principal para compatibilidad
    roles TEXT DEFAULT '["DIRECTIVO"]',     -- JSON array de roles: '["SUPER_ADMIN", "DIRECTIVO", "PADRE"]'
    phone TEXT,
    status TEXT DEFAULT 'ACTIVO',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    city TEXT DEFAULT 'Santa Cruz de la Sierra',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    user_id INTEGER, -- Directivo asignado
    grade_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    tutor_phone TEXT,
    parent_user_id INTEGER,
    FOREIGN KEY(course_id) REFERENCES courses(id),
    FOREIGN KEY(parent_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    type TEXT DEFAULT 'PUNTUAL',
    require_roster INTEGER DEFAULT 1,
    amount_bob REAL NOT NULL,
    installments_count INTEGER DEFAULT 1,
    installment_amount REAL DEFAULT 0,
    description TEXT,
    bank_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_holder TEXT NOT NULL,
    qr_image_url TEXT,
    deadline_date TEXT NOT NULL,
    activity_month TEXT NOT NULL,
    activity_year TEXT NOT NULL,
    status TEXT DEFAULT 'ACTIVA',
    created_at TEXT NOT NULL,
    FOREIGN KEY(course_id) REFERENCES courses(id),
    FOREIGN KEY(creator_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    student_id INTEGER,
    payer_name TEXT,
    amount_bob REAL NOT NULL,
    installments_covered INTEGER DEFAULT 1,
    payment_method TEXT NOT NULL,
    ref_number TEXT,
    receipt_notes TEXT,
    paid_month TEXT NOT NULL,
    paid_year TEXT NOT NULL,
    paid_at TEXT NOT NULL,
    FOREIGN KEY(activity_id) REFERENCES activities(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    sender_phone TEXT PRIMARY KEY,
    course_id INTEGER NOT NULL,
    activity_id INTEGER NOT NULL,
    last_receipt_info TEXT,
    state TEXT DEFAULT 'WAITING_NAME',
    updated_at TEXT NOT NULL
  );
`);

// Migrations
try { db.exec('ALTER TABLE users ADD COLUMN roles TEXT DEFAULT \'["DIRECTIVO"]\''); } catch(e){}
try { db.exec("ALTER TABLE students ADD COLUMN parent_user_id INTEGER"); } catch(e){}
try { db.exec("ALTER TABLE activities ADD COLUMN type TEXT DEFAULT 'PUNTUAL'"); } catch(e){}
try { db.exec("ALTER TABLE activities ADD COLUMN require_roster INTEGER DEFAULT 1"); } catch(e){}
try { db.exec("ALTER TABLE activities ADD COLUMN installments_count INTEGER DEFAULT 1"); } catch(e){}
try { db.exec("ALTER TABLE activities ADD COLUMN installment_amount REAL DEFAULT 0"); } catch(e){}
try { db.exec("ALTER TABLE payments ADD COLUMN installments_covered INTEGER DEFAULT 1"); } catch(e){}
try { db.exec("ALTER TABLE payments ADD COLUMN payer_name TEXT"); } catch(e){}

// Password helper
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + AUTH_SALT).digest('hex');
}

// Ensure default users have correct roles array and seed padre account
try {
  db.prepare('UPDATE users SET roles = ? WHERE email = ?').run(JSON.stringify(["SUPER_ADMIN", "DIRECTIVO", "PADRE"]), 'admin@cuotas.bo');
  db.prepare('UPDATE users SET roles = ? WHERE email = ?').run(JSON.stringify(["DIRECTIVO", "PADRE"]), 'carmen@colegiosantacruz.bo');

  const padreExists = db.prepare('SELECT id FROM users WHERE email = ?').get('padre@cuotas.bo');
  if (!padreExists) {
    const now = new Date().toISOString();
    const padreRes = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, roles, phone, status, created_at)
      VALUES (?, ?, ?, 'PADRE', '["PADRE"]', ?, 'ACTIVO', ?)
    `).run('Roberto Banegas (Padre de Familia)', 'padre@cuotas.bo', hashPassword('padre123'), '70011223', now);
    const padreId = Number(padreRes.lastInsertRowid);
    const firstStudent = db.prepare('SELECT id FROM students ORDER BY id ASC LIMIT 1').get();
    if (firstStudent) {
      db.prepare('UPDATE students SET parent_user_id = ? WHERE id = ?').run(padreId, firstStudent.id);
    }
  } else {
    db.prepare('UPDATE users SET roles = ? WHERE email = ?').run(JSON.stringify(["PADRE"]), 'padre@cuotas.bo');
  }
} catch(e){}

// Seed Initial Data if empty
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
if (userCount === 0) {
  const now = new Date().toISOString();
  
  // 1. Super Admin Daniel Simons (has ALL 3 ROLES)
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, roles, phone, status, created_at)
    VALUES (?, ?, ?, 'SUPER_ADMIN', '["SUPER_ADMIN", "DIRECTIVO", "PADRE"]', ?, 'ACTIVO', ?)
  `).run('Daniel Simons', 'admin@cuotas.bo', hashPassword('admin123'), '77123456', now);

  // 2. Directivo Sra. Carmen Hurtado (has DIRECTIVO & PADRE)
  const carmenRes = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, roles, phone, status, created_at)
    VALUES (?, ?, ?, 'DIRECTIVO', '["DIRECTIVO", "PADRE"]', ?, 'ACTIVO', ?)
  `).run('Sra. Carmen Hurtado', 'carmen@colegiosantacruz.bo', hashPassword('carmen123'), '76012345', now);
  const carmenId = Number(carmenRes.lastInsertRowid);

  // 3. Padre de Familia Ejemplo: Roberto Banegas (has PADRE role)
  const padreRes = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, roles, phone, status, created_at)
    VALUES (?, ?, ?, 'PADRE', '["PADRE"]', ?, 'ACTIVO', ?)
  `).run('Roberto Banegas (Padre de Familia)', 'padre@cuotas.bo', hashPassword('padre123'), '70011223', now);
  const padreId = Number(padreRes.lastInsertRowid);

  // 4. School
  const schoolRes = db.prepare(`
    INSERT INTO schools (name, city, created_at)
    VALUES (?, ?, ?)
  `).run('Colegio Santa Cruz de la Sierra', 'Santa Cruz de la Sierra', now);
  const schoolId = Number(schoolRes.lastInsertRowid);

  // 5. Course
  const courseRes = db.prepare(`
    INSERT INTO courses (school_id, user_id, grade_name, slug, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(schoolId, carmenId, '3ro B de Primaria', 'colegiosantacruz-3rob', now);
  const courseId = Number(courseRes.lastInsertRowid);

  // 6. Activities (Puntual & Recurrente)
  const actMonth = now.slice(0, 7);
  const actYear = now.slice(0, 4);
  const actRes = db.prepare(`
    INSERT INTO activities (course_id, creator_user_id, title, type, require_roster, amount_bob, installments_count, installment_amount, description, bank_name, account_number, account_holder, qr_image_url, deadline_date, activity_month, activity_year, status, created_at)
    VALUES (?, ?, ?, 'PUNTUAL', 1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVA', ?)
  `).run(
    courseId, carmenId, 'Cuota Plato Kermesse y Día de la Tradición', 20.0, 20.0,
    'Cuota obligatoria para el festival estudiantil.',
    'Banco Ganadero', 'CA 1310325959', 'SIMONS SIMONS DANIEL BATHAL',
    '/images/qr_cuenta.png', '05 de Octubre, 2026', actMonth, actYear, now
  );
  const actId = Number(actRes.lastInsertRowid);

  const recActRes = db.prepare(`
    INSERT INTO activities (course_id, creator_user_id, title, type, require_roster, amount_bob, installments_count, installment_amount, description, bank_name, account_number, account_holder, qr_image_url, deadline_date, activity_month, activity_year, status, created_at)
    VALUES (?, ?, ?, 'RECURRENTE', 1, 200.0, 10, 20.0, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVA', ?)
  `).run(
    courseId, carmenId, 'Caja Chica Mensual del Curso (Gestión 2026)',
    'Aporte de 20 Bs. mensual por 10 meses (Total 200 Bs.) para material de limpieza, botiquín y fotocopias.',
    'Banco Ganadero', 'CA 1310325959', 'SIMONS SIMONS DANIEL BATHAL',
    '/images/qr_cuenta.png', '30 de Noviembre, 2026', actMonth, actYear, now
  );
  const recActId = Number(recActRes.lastInsertRowid);

  // 7. Students (Valentina linked to Roberto)
  const sampleStudents = [
    'Mateo Zeballos Suárez', 'Sofía Hurtado Roca', 'Lucas Simons Paz',
    'Valentina Aguilera Banegas', 'Santiago Morales Justiniano', 'Isabella Antelo Melgar',
    'Nicolás Vaca Diez', 'Camila Saucedo Chávez', 'Sebastián Arteaga Rivero',
    'Luciana Ribera Méndez', 'Joaquín Dorado Cuéllar', 'Mariana Peredo Añez',
    'Diego Montero Castedo', 'Valeria Landívar Franco', 'Gabriel Soliz Céspedes',
    'Martina Ortiz Cronenbold', 'Alejandro Chávez Toledo', 'Victoria Parada Serrate',
    'Emiliano Gutiérrez Vaca', 'Adriana Justiniano Bravo'
  ];

  const studentInsert = db.prepare('INSERT INTO students (course_id, full_name, parent_user_id) VALUES (?, ?, ?)');
  sampleStudents.forEach((name, idx) => {
    studentInsert.run(courseId, name, idx === 3 ? padreId : null);
  });

  // Mock payments
  const students = db.prepare('SELECT id FROM students WHERE course_id = ? LIMIT 5').all(courseId);
  const payInsert = db.prepare(`
    INSERT INTO payments (activity_id, student_id, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
    VALUES (?, ?, 20.0, 1, 'QR SIMPLE GANADERO', ?, 'Comprobante verificado por IA', ?, ?, ?)
  `);

  students.forEach((s, idx) => {
    payInsert.run(actId, s.id, `REF-88910${idx}`, actMonth, actYear, new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' }));
  });

  db.prepare(`
    INSERT INTO payments (activity_id, student_id, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
    VALUES (?, ?, 60.0, 3, 'TRANSFERENCIA', 'REF-REC-001', 'Abonó 3 meses juntos', ?, ?, ?)
  `).run(recActId, students[0].id, actMonth, actYear, new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' }));

  console.log('Seeded database with School, Course, Students, Multi-Role Users, and Activities.');
}

// Authentication Middleware
function authenticateUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Por favor inicia sesión.' });
  }

  const token = authHeader.split(' ')[1];
  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.name, u.email, u.role, u.roles, u.phone, u.status
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(token);

  if (!session) return res.status(401).json({ error: 'Sesión expirada o inválida.' });
  if (session.status !== 'ACTIVO') return res.status(403).json({ error: 'Cuenta suspendida.' });

  try {
    session.rolesList = session.roles ? JSON.parse(session.roles) : [session.role];
  } catch (e) {
    session.rolesList = [session.role];
  }

  req.user = session;
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || (!req.user.rolesList.includes('SUPER_ADMIN') && req.user.role !== 'SUPER_ADMIN')) {
    return res.status(403).json({ error: 'Requiere privilegios de Super Administrador.' });
  }
  next();
}

function requireDirectivo(req, res, next) {
  if (!req.user || (!req.user.rolesList.includes('DIRECTIVO') && !req.user.rolesList.includes('SUPER_ADMIN'))) {
    return res.status(403).json({ error: 'Acceso restringido a Directivos.' });
  }
  next();
}

function requirePadre(req, res, next) {
  if (!req.user || (!req.user.rolesList.includes('PADRE') && !req.user.rolesList.includes('SUPER_ADMIN'))) {
    return res.status(403).json({ error: 'Acceso restringido a Padres de Familia.' });
  }
  next();
}

// ==========================================
// 1. AUTHENTICATION & LOGIN UNIFICADO
// ==========================================

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Ingresa correo y contraseña.' });

    const hash = hashPassword(password);
    const user = db.prepare(`
      SELECT id, name, email, role, roles, phone, status 
      FROM users 
      WHERE email = ? AND password_hash = ?
    `).get(email.trim().toLowerCase(), hash);

    if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    if (user.status !== 'ACTIVO') return res.status(403).json({ error: 'Esta cuenta está pausada o suspendida.' });

    let rolesList = [];
    try {
      rolesList = user.roles ? JSON.parse(user.roles) : [user.role];
    } catch(e) {
      rolesList = [user.role];
    }

    const token = 'TOK_' + crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, new Date().toISOString());

    // If directivo, attach course id
    let course_id = null;
    let course_name = null;
    let school_name = null;
    let course_slug = null;

    const c = db.prepare(`
      SELECT c.id, c.grade_name, c.slug, s.name as school_name 
      FROM courses c 
      JOIN schools s ON c.school_id = s.id 
      WHERE c.user_id = ?
    `).get(user.id);
    if (c) {
      course_id = c.id;
      course_name = c.grade_name;
      school_name = c.school_name;
      course_slug = c.slug;
    }

    // Default redirect destination based on primary roles
    let defaultPanel = '/padre.html';
    if (rolesList.includes('SUPER_ADMIN')) defaultPanel = '/admin-maestro.html';
    else if (rolesList.includes('DIRECTIVO')) defaultPanel = '/directivo.html';

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        roles: rolesList,
        phone: user.phone,
        course_id,
        course_name,
        school_name,
        course_slug,
        can_admin: rolesList.includes('SUPER_ADMIN'),
        can_directivo: rolesList.includes('DIRECTIVO'),
        can_padre: rolesList.includes('PADRE'),
        defaultPanel
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateUser, (req, res) => {
  let course = null;
  if (req.user.rolesList.includes('DIRECTIVO')) {
    course = db.prepare(`
      SELECT c.*, s.name as school_name 
      FROM courses c 
      JOIN schools s ON c.school_id = s.id 
      WHERE c.user_id = ?
    `).get(req.user.user_id);
  }

  res.json({
    user: {
      id: req.user.user_id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      roles: req.user.rolesList,
      phone: req.user.phone,
      course_id: course ? course.id : null,
      course_name: course ? course.grade_name : null,
      school_name: course ? course.school_name : null,
      course_slug: course ? course.slug : null,
      can_admin: req.user.rolesList.includes('SUPER_ADMIN'),
      can_directivo: req.user.rolesList.includes('DIRECTIVO'),
      can_padre: req.user.rolesList.includes('PADRE')
    }
  });
});

app.post('/api/auth/logout', authenticateUser, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader.split(' ')[1];
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ success: true });
});

// ==========================================
// 2. SUPER ADMIN: GESTIÓN TOTAL DE USUARIOS Y ROLES
// ==========================================

// List all users with full roles, phone, WhatsApp and course
app.get('/api/admin/users', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const rawUsers = db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.roles, u.phone, u.status, u.created_at,
             c.id as course_id, c.grade_name, s.name as school_name
      FROM users u
      LEFT JOIN courses c ON c.user_id = u.id
      LEFT JOIN schools s ON c.school_id = s.id
      ORDER BY u.id DESC
    `).all();

    const users = rawUsers.map(u => {
      let parsedRoles = [];
      try {
        parsedRoles = u.roles ? JSON.parse(u.roles) : [u.role];
      } catch(e) {
        parsedRoles = [u.role];
      }
      return {
        ...u,
        roles: parsedRoles
      };
    });

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create User with Multiple Roles
app.post('/api/admin/users', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const rawName = req.body.name || req.body.full_name;
    const { email, password, phone, roles = ['PADRE'], course_id } = req.body;
    const name = rawName ? rawName.trim() : '';

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nombre, correo y contraseña son obligatorios.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) return res.status(400).json({ error: 'Ese correo electrónico ya está registrado.' });

    const rolesList = Array.isArray(roles) && roles.length > 0 ? roles : ['PADRE'];
    const primaryRole = rolesList[0];
    const rolesJson = JSON.stringify(rolesList);
    const hash = hashPassword(password);
    const nowStr = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, roles, phone, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
    `).run(name, cleanEmail, hash, primaryRole, rolesJson, phone ? phone.trim() : null, nowStr);

    const newUserId = Number(result.lastInsertRowid);

    // If assigned to a course as directivo
    if (course_id && rolesList.includes('DIRECTIVO')) {
      db.prepare('UPDATE courses SET user_id = ? WHERE id = ?').run(newUserId, course_id);
    }

    res.json({ success: true, userId: newUserId, roles: rolesList, message: 'Usuario creado exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit User (Name, Email, WhatsApp, Password, Roles, Course)
app.put('/api/admin/users/:id', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const userId = req.params.id;
    const rawName = req.body.name || req.body.full_name;
    const { email, password, phone, roles, course_id, status } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const name = rawName ? rawName.trim() : user.name;
    const cleanEmail = email ? email.trim().toLowerCase() : user.email;
    const rolesList = Array.isArray(roles) && roles.length > 0 ? roles : (user.roles ? JSON.parse(user.roles) : [user.role]);
    const primaryRole = rolesList[0];
    const rolesJson = JSON.stringify(rolesList);

    if (password && password.trim()) {
      const hash = hashPassword(password.trim());
      db.prepare(`
        UPDATE users 
        SET name = ?, email = ?, password_hash = ?, role = ?, roles = ?, phone = ?, status = ?
        WHERE id = ?
      `).run(name, cleanEmail, hash, primaryRole, rolesJson, phone ? phone.trim() : null, status || user.status, userId);
    } else {
      db.prepare(`
        UPDATE users 
        SET name = ?, email = ?, role = ?, roles = ?, phone = ?, status = ?
        WHERE id = ?
      `).run(name, cleanEmail, primaryRole, rolesJson, phone ? phone.trim() : null, status || user.status, userId);
    }

    // Reassign course if directivo
    if (course_id !== undefined) {
      db.prepare('UPDATE courses SET user_id = NULL WHERE user_id = ?').run(userId);
      if (course_id && rolesList.includes('DIRECTIVO')) {
        db.prepare('UPDATE courses SET user_id = ? WHERE id = ?').run(userId, course_id);
      }
    }

    res.json({ success: true, roles: rolesList, message: 'Usuario actualizado exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete User
app.delete('/api/admin/users/:id', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const userId = req.params.id;
    if (parseInt(userId) === req.user.user_id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta de Super Administrador.' });
    }

    db.prepare('UPDATE courses SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    res.json({ success: true, message: 'Usuario eliminado del sistema.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Overview with Stats, Activities, Courses, Schools
app.get('/api/admin/overview', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    const totalSchools = db.prepare('SELECT COUNT(*) as count FROM schools').get().count;
    const totalCourses = db.prepare('SELECT COUNT(*) as count FROM courses').get().count;
    const totalActivities = db.prepare('SELECT COUNT(*) as count FROM activities').get().count;
    const activeActivities = db.prepare("SELECT COUNT(*) as count FROM activities WHERE status = 'ACTIVA'").get().count;
    const finishedActivities = db.prepare("SELECT COUNT(*) as count FROM activities WHERE status = 'FINALIZADA'").get().count;
    const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students').get().count;
    const totalRevenue = db.prepare('SELECT COALESCE(SUM(amount_bob), 0) as sum FROM payments').get().sum;

    const rawUsers = db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.status, u.role, u.roles, u.created_at,
             c.id as course_id, c.grade_name, c.slug, s.name as school_name,
             (SELECT COUNT(*) FROM activities WHERE course_id = c.id) as activities_count,
             (SELECT COALESCE(SUM(p.amount_bob), 0) FROM activities a LEFT JOIN payments p ON p.activity_id = a.id WHERE a.course_id = c.id) as total_collected
      FROM users u
      LEFT JOIN courses c ON c.user_id = u.id
      LEFT JOIN schools s ON c.school_id = s.id
      ORDER BY u.id DESC
    `).all();

    const users = rawUsers.map(u => ({
      ...u,
      roles: u.roles ? JSON.parse(u.roles) : [u.role]
    }));

    const directivos = users.filter(u => u.roles.includes('DIRECTIVO'));

    const schools = db.prepare(`
      SELECT s.*, 
             (SELECT COUNT(*) FROM courses WHERE school_id = s.id) as course_count
      FROM schools s
      ORDER BY s.name ASC
    `).all();

    const courses = db.prepare(`
      SELECT c.*, s.name as school_name, u.name as president_name, u.email as president_email,
             (SELECT COUNT(*) FROM students WHERE course_id = c.id) as student_count,
             (SELECT COUNT(*) FROM activities WHERE course_id = c.id) as activity_count
      FROM courses c
      JOIN schools s ON c.school_id = s.id
      LEFT JOIN users u ON c.user_id = u.id
      ORDER BY s.name, c.grade_name
    `).all();

    const allActivities = db.prepare(`
      SELECT a.*, s.name as school_name, c.grade_name, u.name as directivo_name,
             (SELECT COUNT(*) FROM payments WHERE activity_id = a.id) as payments_count,
             (SELECT COALESCE(SUM(amount_bob), 0) FROM payments WHERE activity_id = a.id) as total_collected,
             (SELECT COUNT(*) FROM students WHERE course_id = a.course_id) as total_students
      FROM activities a
      JOIN courses c ON a.course_id = c.id
      JOIN schools s ON c.school_id = s.id
      JOIN users u ON a.creator_user_id = u.id
      ORDER BY a.id DESC
    `).all();

    res.json({
      stats: { totalUsers, totalSchools, totalCourses, totalActivities, activeActivities, finishedActivities, totalStudents, totalRevenue },
      directivos,
      users,
      schools,
      courses,
      allActivities
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schools CRUD
app.get('/api/admin/schools', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const schools = db.prepare('SELECT * FROM schools ORDER BY name ASC').all();
    res.json(schools);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/schools', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const { name, city } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del colegio es obligatorio.' });

    const nowStr = new Date().toISOString();
    const result = db.prepare('INSERT INTO schools (name, city, created_at) VALUES (?, ?, ?)')
      .run(name.trim(), city ? city.trim() : 'Santa Cruz de la Sierra', nowStr);

    res.json({ success: true, schoolId: Number(result.lastInsertRowid), message: 'Colegio creado con éxito.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Courses CRUD
app.get('/api/admin/courses', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const courses = db.prepare(`
      SELECT c.*, s.name as school_name, u.name as president_name, u.email as president_email
      FROM courses c
      JOIN schools s ON c.school_id = s.id
      LEFT JOIN users u ON c.user_id = u.id
      ORDER BY s.name, c.grade_name
    `).all();
    res.json(courses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/courses', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const { school_id, grade_name } = req.body;
    if (!school_id || !grade_name) return res.status(400).json({ error: 'Selecciona un colegio e ingresa el curso.' });

    const school = db.prepare('SELECT name FROM schools WHERE id = ?').get(school_id);
    if (!school) return res.status(404).json({ error: 'Colegio no encontrado.' });

    const cleanSchool = school.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanGrade = grade_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const slug = `${cleanSchool}-${cleanGrade}-${Math.floor(100 + Math.random() * 900)}`;
    const nowStr = new Date().toISOString();

    const result = db.prepare('INSERT INTO courses (school_id, user_id, grade_name, slug, created_at) VALUES (?, NULL, ?, ?, ?)')
      .run(school_id, grade_name.trim(), slug, nowStr);

    res.json({ success: true, courseId: Number(result.lastInsertRowid), slug, message: 'Curso creado con éxito.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Student Roster CRUD for Super Admin
app.get('/api/admin/courses/:id/students', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const courseId = req.params.id;
    const course = db.prepare('SELECT c.*, s.name as school_name FROM courses c JOIN schools s ON c.school_id = s.id WHERE c.id = ?').get(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado.' });

    const students = db.prepare('SELECT * FROM students WHERE course_id = ? ORDER BY full_name ASC').all(courseId);
    res.json({ course, students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/courses/:id/students', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const courseId = req.params.id;
    const { full_name, tutor_phone } = req.body;
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Nombre de alumno obligatorio.' });

    const r = db.prepare('INSERT INTO students (course_id, full_name, tutor_phone) VALUES (?, ?, ?)')
      .run(courseId, full_name.trim(), tutor_phone ? tutor_phone.trim() : null);

    res.json({ success: true, studentId: Number(r.lastInsertRowid), message: 'Alumno agregado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/courses/:id/students/bulk', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const courseId = req.params.id;
    const { raw_text } = req.body;
    if (!raw_text || !raw_text.trim()) return res.status(400).json({ error: 'Pega la lista de alumnos.' });

    const lines = raw_text.split(/\r?\n|\\n/).map(l => l.replace(/^[0-9]+[\.\-\)]\s*/, '').trim()).filter(l => l.length >= 3);
    if (lines.length === 0) return res.status(400).json({ error: 'No se detectaron nombres válidos en el texto.' });

    const insert = db.prepare('INSERT INTO students (course_id, full_name) VALUES (?, ?)');
    let count = 0;
    lines.forEach(name => {
      insert.run(courseId, name);
      count++;
    });

    res.json({ success: true, count, message: `Se importaron ${count} alumnos exitosamente.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/students/:id', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const studentId = req.params.id;
    const { full_name, tutor_phone } = req.body;
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Nombre obligatorio.' });

    db.prepare('UPDATE students SET full_name = ?, tutor_phone = ? WHERE id = ?')
      .run(full_name.trim(), tutor_phone ? tutor_phone.trim() : null, studentId);

    res.json({ success: true, message: 'Alumno actualizado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/students/:id', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const studentId = req.params.id;
    db.prepare('DELETE FROM payments WHERE student_id = ?').run(studentId);
    db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
    res.json({ success: true, message: 'Alumno eliminado de la lista.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global Financial Summary (Monthly / Annual / All)
app.get('/api/admin/financial-summary', authenticateUser, requireSuperAdmin, (req, res) => {
  try {
    const { period, value, year, month } = req.query; 

    let filterYear = year;
    let filterMonth = month;
    if (period === 'year' && value) filterYear = value;
    if (period === 'month' && value) {
      const parts = value.split('-');
      if (parts.length === 2) {
        filterYear = parts[0];
        filterMonth = parts[1];
      }
    }

    let wherePayments = [];
    let params = [];

    if (filterYear) {
      wherePayments.push('p.paid_year = ?');
      params.push(filterYear);
    }
    if (filterMonth) {
      const mStr = filterMonth.padStart(2, '0');
      wherePayments.push("strftime('%m', p.paid_at) = ? OR p.paid_month LIKE ?");
      params.push(mStr, `%-${mStr}`);
    }

    const whereClause = wherePayments.length > 0 ? `WHERE ${wherePayments.join(' AND ')}` : '';

    const sql = `
      SELECT a.id as activity_id, a.title, a.type, a.require_roster, a.amount_bob, a.installments_count, a.installment_amount,
             a.activity_month, a.activity_year, a.status,
             s.name as school_name, c.grade_name, u.name as directivo_name,
             COUNT(p.id) as total_payments,
             COALESCE(SUM(p.amount_bob), 0) as total_collected,
             (SELECT COUNT(*) FROM students WHERE course_id = c.id) as total_students
      FROM activities a
      JOIN courses c ON a.course_id = c.id
      JOIN schools s ON c.school_id = s.id
      JOIN users u ON a.creator_user_id = u.id
      LEFT JOIN payments p ON p.activity_id = a.id
      ${whereClause}
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `;

    const summary = db.prepare(sql).all(...params);
    const totalCollected = summary.reduce((acc, row) => acc + row.total_collected, 0);
    const totalTarget = summary.reduce((acc, row) => {
      if (row.require_roster === 1) {
        return acc + (row.amount_bob * (row.total_students || 0));
      } else {
        return acc + (row.amount_bob * Math.max(1, row.total_payments));
      }
    }, 0);
    const totalPending = Math.max(0, totalTarget - totalCollected);
    const compliancePercent = totalTarget > 0 ? Math.round((totalCollected / totalTarget) * 100) : 0;

    const schoolsMap = {};
    summary.forEach(row => {
      if (!schoolsMap[row.school_name]) {
        schoolsMap[row.school_name] = { school_name: row.school_name, total_collected: 0, activities_count: 0, courses: new Set() };
      }
      schoolsMap[row.school_name].total_collected += row.total_collected;
      schoolsMap[row.school_name].activities_count += 1;
      schoolsMap[row.school_name].courses.add(row.grade_name);
    });

    const bySchool = Object.values(schoolsMap).map(s => ({
      school_name: s.school_name,
      total_collected: s.total_collected,
      activities_count: s.activities_count,
      courses_count: s.courses.size
    }));

    res.json({
      totalCollected,
      totalPending,
      totalTarget,
      compliancePercent,
      bySchool,
      byActivity: summary,
      filter: { year: filterYear || 'todos', month: filterMonth || 'todos' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. DIRECTIVO: ACTIVIDADES, ROSTER Y PDF
// ==========================================

app.get('/api/directivo/dashboard', authenticateUser, requireDirectivo, (req, res) => {
  try {
    let course = null;
    if (req.user.rolesList.includes('SUPER_ADMIN')) {
      const courseId = req.query.course_id ? parseInt(req.query.course_id) : null;
      if (courseId) {
        course = db.prepare(`SELECT c.*, s.name as school_name FROM courses c JOIN schools s ON c.school_id = s.id WHERE c.id = ?`).get(courseId);
      } else {
        course = db.prepare(`SELECT c.*, s.name as school_name FROM courses c JOIN schools s ON c.school_id = s.id ORDER BY c.id ASC LIMIT 1`).get();
      }
    } else {
      course = db.prepare(`SELECT c.*, s.name as school_name FROM courses c JOIN schools s ON c.school_id = s.id WHERE c.user_id = ?`).get(req.user.user_id);
    }

    if (!course) {
      return res.status(404).json({ error: 'No tienes un curso asignado actualmente.' });
    }

    const activities = db.prepare(`
      SELECT * FROM activities 
      WHERE course_id = ? 
      ORDER BY id DESC
    `).all(course.id);

    const students = db.prepare(`
      SELECT * FROM students 
      WHERE course_id = ? 
      ORDER BY full_name ASC
    `).all(course.id);

    const activitiesWithStats = activities.map(act => {
      const payments = db.prepare(`
        SELECT p.*, s.full_name as student_name
        FROM payments p
        LEFT JOIN students s ON p.student_id = s.id
        WHERE p.activity_id = ?
      `).all(act.id);

      const paidCount = payments.length;
      const totalCollected = payments.reduce((acc, p) => acc + p.amount_bob, 0);
      const targetAmount = act.require_roster === 1 ? (act.amount_bob * students.length) : totalCollected;
      const percent = targetAmount > 0 ? Math.round((totalCollected / targetAmount) * 100) : 0;

      return {
        ...act,
        paidCount,
        pendingCount: Math.max(0, students.length - paidCount),
        totalCollected,
        targetAmount,
        percent,
        payments
      };
    });

    res.json({
      course,
      directivo: { id: req.user.user_id, name: req.user.name, email: req.user.email, roles: req.user.rolesList },
      activities: activitiesWithStats,
      students
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Activity
app.post('/api/directivo/activities', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const {
      title,
      type = 'PUNTUAL',
      require_roster = 1,
      amount_bob,
      installments_count = 1,
      installment_amount = 0,
      description,
      bank_name,
      account_number,
      account_holder,
      deadline_date,
      qr_image_url
    } = req.body;

    if (!title || !amount_bob || !bank_name || !account_number || !account_holder || !deadline_date) {
      return res.status(400).json({ error: 'Faltan campos obligatorios para la actividad.' });
    }

    let course = null;
    if (req.user.rolesList.includes('SUPER_ADMIN') && req.body.course_id) {
      course = db.prepare('SELECT id FROM courses WHERE id = ?').get(req.body.course_id);
    } else {
      course = db.prepare('SELECT id FROM courses WHERE user_id = ?').get(req.user.user_id);
    }

    if (!course) return res.status(403).json({ error: 'No tienes un curso asignado para crear actividades.' });

    const now = new Date();
    const actMonth = now.toISOString().slice(0, 7);
    const actYear = now.getFullYear().toString();
    const nowStr = now.toISOString();

    const insert = db.prepare(`
      INSERT INTO activities (
        course_id, creator_user_id, title, type, require_roster, amount_bob,
        installments_count, installment_amount, description, bank_name,
        account_number, account_holder, qr_image_url, deadline_date,
        activity_month, activity_year, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVA', ?)
    `);

    const result = insert.run(
      course.id,
      req.user.user_id,
      title.trim(),
      type,
      parseInt(require_roster),
      parseFloat(amount_bob),
      parseInt(installments_count || 1),
      parseFloat(installment_amount || amount_bob),
      description ? description.trim() : '',
      bank_name.trim(),
      account_number.trim(),
      account_holder.trim(),
      qr_image_url || '/images/qr_cuenta.png',
      deadline_date.trim(),
      actMonth,
      actYear,
      nowStr
    );

    res.json({ success: true, activityId: Number(result.lastInsertRowid), message: 'Actividad creada con éxito.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit Activity
app.put('/api/directivo/activities/:id', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const actId = req.params.id;
    const act = db.prepare(`
      SELECT a.*, c.user_id as course_owner_id 
      FROM activities a 
      JOIN courses c ON a.course_id = c.id 
      WHERE a.id = ?
    `).get(actId);

    if (!act) return res.status(404).json({ error: 'Actividad no encontrada.' });

    if (!req.user.rolesList.includes('SUPER_ADMIN') && act.course_owner_id !== req.user.user_id) {
      return res.status(403).json({ error: 'No tienes permiso para modificar una actividad creada por otro curso.' });
    }

    const {
      title,
      type,
      require_roster,
      amount_bob,
      installments_count,
      installment_amount,
      description,
      bank_name,
      account_number,
      account_holder,
      deadline_date,
      status,
      qr_image_url
    } = req.body;

    db.prepare(`
      UPDATE activities
      SET title = ?, type = ?, require_roster = ?, amount_bob = ?, installments_count = ?, installment_amount = ?,
          description = ?, bank_name = ?, account_number = ?, account_holder = ?, deadline_date = ?, status = ?, qr_image_url = ?
      WHERE id = ?
    `).run(
      title ? title.trim() : act.title,
      type || act.type,
      require_roster !== undefined ? parseInt(require_roster) : act.require_roster,
      amount_bob !== undefined ? parseFloat(amount_bob) : act.amount_bob,
      installments_count !== undefined ? parseInt(installments_count) : act.installments_count,
      installment_amount !== undefined ? parseFloat(installment_amount) : act.installment_amount,
      description !== undefined ? description.trim() : act.description,
      bank_name ? bank_name.trim() : act.bank_name,
      account_number ? account_number.trim() : act.account_number,
      account_holder ? account_holder.trim() : act.account_holder,
      deadline_date ? deadline_date.trim() : act.deadline_date,
      status || act.status,
      qr_image_url || act.qr_image_url,
      actId
    );

    res.json({ success: true, message: 'Actividad actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update QR Image
app.post('/api/directivo/activities/:id/qr', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const actId = req.params.id;
    const { image_base64 } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'Falta la imagen del QR.' });

    const act = db.prepare(`
      SELECT a.*, c.user_id as course_owner_id 
      FROM activities a 
      JOIN courses c ON a.course_id = c.id 
      WHERE a.id = ?
    `).get(actId);

    if (!act) return res.status(404).json({ error: 'Actividad no encontrada.' });
    if (!req.user.rolesList.includes('SUPER_ADMIN') && act.course_owner_id !== req.user.user_id) {
      return res.status(403).json({ error: 'No autorizado para cambiar el QR de este curso.' });
    }

    let publicUrl = '';
    if (image_base64.startsWith('data:image')) {
      const matches = image_base64.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const dataBuffer = Buffer.from(matches[2], 'base64');
        const filename = `qr_act_${actId}_${Date.now()}.${ext}`;
        const filePath = path.join(imagesDir, filename);
        fs.writeFileSync(filePath, dataBuffer);
        publicUrl = `/images/${filename}`;
      } else {
        publicUrl = image_base64;
      }
    } else {
      publicUrl = image_base64;
    }

    db.prepare('UPDATE activities SET qr_image_url = ? WHERE id = ?').run(publicUrl, actId);

    res.json({ success: true, qr_image_url: publicUrl, message: '¡Código QR actualizado exitosamente!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Manual Payment
app.post('/api/directivo/payments/toggle', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const { activity_id, student_id, method, payer_name } = req.body;
    const act = db.prepare(`
      SELECT a.*, c.user_id as course_owner_id 
      FROM activities a 
      JOIN courses c ON a.course_id = c.id 
      WHERE a.id = ?
    `).get(activity_id);

    if (!act) return res.status(404).json({ error: 'Actividad no encontrada.' });
    if (!req.user.rolesList.includes('SUPER_ADMIN') && act.course_owner_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Acceso no autorizado a este curso.' });
    }

    if (act.require_roster === 1 && student_id) {
      const existing = db.prepare('SELECT id FROM payments WHERE activity_id = ? AND student_id = ?').get(activity_id, student_id);
      if (existing) {
        db.prepare('DELETE FROM payments WHERE id = ?').run(existing.id);
        return res.json({ success: true, newStatus: 'PENDIENTE' });
      } else {
        const now = new Date();
        const pMonth = now.toISOString().slice(0, 7);
        const pYear = now.getFullYear().toString();
        const nowStr = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });

        db.prepare(`
          INSERT INTO payments (activity_id, student_id, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
          VALUES (?, ?, ?, ?, 'PAGO-EN-MANO', 'Registrado por directivo', ?, ?, ?)
        `).run(activity_id, student_id, act.amount_bob, act.installments_count || 1, pMonth, pYear, nowStr);

        return res.json({ success: true, newStatus: 'PAGADO' });
      }
    } else {
      const now = new Date();
      const pMonth = now.toISOString().slice(0, 7);
      const pYear = now.getFullYear().toString();
      const nowStr = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });

      db.prepare(`
        INSERT INTO payments (activity_id, student_id, payer_name, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
        VALUES (?, NULL, ?, ?, 1, ?, 'COBRO-LIBRE', 'Registrado en mano', ?, ?, ?)
      `).run(activity_id, payer_name || 'Aportante Libre', act.amount_bob, method || 'EFECTIVO', pMonth, pYear, nowStr);

      return res.json({ success: true, message: 'Pago registrado.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recurring Fee Installment Payment
app.post('/api/directivo/payments/recurring', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const { activity_id, student_id, amount_bob, method, ref_number } = req.body;
    if (!activity_id || !student_id || !amount_bob) {
      return res.status(400).json({ error: 'Faltan datos para el pago recurrente.' });
    }

    const act = db.prepare(`
      SELECT a.*, c.user_id as course_owner_id 
      FROM activities a 
      JOIN courses c ON a.course_id = c.id 
      WHERE a.id = ?
    `).get(activity_id);

    if (!act) return res.status(404).json({ error: 'Actividad no encontrada.' });
    if (!req.user.rolesList.includes('SUPER_ADMIN') && act.course_owner_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Acceso no autorizado.' });
    }

    const payAmount = parseFloat(amount_bob);
    const existing = db.prepare('SELECT * FROM payments WHERE activity_id = ? AND student_id = ?').get(activity_id, student_id);

    const now = new Date();
    const pMonth = now.toISOString().slice(0, 7);
    const pYear = now.getFullYear().toString();
    const nowStr = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });

    if (existing) {
      const newTotal = existing.amount_bob + payAmount;
      const installmentsCovered = act.installment_amount > 0 ? Math.min(act.installments_count, Math.floor(newTotal / act.installment_amount)) : 1;

      db.prepare(`
        UPDATE payments 
        SET amount_bob = ?, installments_covered = ?, payment_method = ?, paid_at = ?, ref_number = ?
        WHERE id = ?
      `).run(newTotal, installmentsCovered, method || 'EFECTIVO', nowStr, ref_number || existing.ref_number, existing.id);

      res.json({ success: true, totalPaid: newTotal, installmentsCovered });
    } else {
      const installmentsCovered = act.installment_amount > 0 ? Math.min(act.installments_count, Math.floor(payAmount / act.installment_amount)) : 1;

      db.prepare(`
        INSERT INTO payments (activity_id, student_id, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Pago de cuota recurrente', ?, ?, ?)
      `).run(activity_id, student_id, payAmount, installmentsCovered, method || 'EFECTIVO', ref_number || 'CUOTA-RECURRENTE', pMonth, pYear, nowStr);

      res.json({ success: true, totalPaid: payAmount, installmentsCovered });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Financial summary for directivo
app.get('/api/directivo/financial-summary', authenticateUser, requireDirectivo, (req, res) => {
  try {
    let course = null;
    if (req.user.rolesList.includes('SUPER_ADMIN') && req.query.course_id) {
      course = db.prepare('SELECT id, grade_name FROM courses WHERE id = ?').get(req.query.course_id);
    } else {
      course = db.prepare('SELECT id, grade_name FROM courses WHERE user_id = ?').get(req.user.user_id);
    }

    if (!course) return res.status(404).json({ error: 'Curso no encontrado.' });

    const { period, value, year, month } = req.query;

    let filterYear = year;
    let filterMonth = month;
    if (period === 'year' && value) filterYear = value;
    if (period === 'month' && value) {
      const parts = value.split('-');
      if (parts.length === 2) {
        filterYear = parts[0];
        filterMonth = parts[1];
      }
    }

    let whereSql = 'WHERE a.course_id = ?';
    const params = [course.id];

    if (filterYear) {
      whereSql += ' AND a.activity_year = ?';
      params.push(filterYear);
    }
    if (filterMonth) {
      const mStr = filterMonth.padStart(2, '0');
      whereSql += ' AND a.activity_month LIKE ?';
      params.push(`%-${mStr}`);
    }

    const sql = `
      SELECT a.id, a.title, a.type, a.require_roster, a.amount_bob, a.installments_count, a.installment_amount,
             a.activity_month, a.activity_year, a.deadline_date, a.status,
             (SELECT COUNT(*) FROM payments WHERE activity_id = a.id) as paid_count,
             (SELECT COUNT(*) FROM students WHERE course_id = a.course_id) as total_students,
             (SELECT COALESCE(SUM(amount_bob), 0) FROM payments WHERE activity_id = a.id) as total_collected
      FROM activities a
      ${whereSql}
      ORDER BY a.created_at DESC
    `;

    const summary = db.prepare(sql).all(...params);
    const totalCollected = summary.reduce((acc, r) => acc + r.total_collected, 0);
    const totalTarget = summary.reduce((acc, r) => {
      if (r.require_roster === 1) {
        return acc + (r.amount_bob * (r.total_students || 0));
      } else {
        return acc + (r.amount_bob * Math.max(1, r.paid_count));
      }
    }, 0);
    const totalPending = Math.max(0, totalTarget - totalCollected);
    const percent = totalTarget > 0 ? Math.round((totalCollected / totalTarget) * 100) : 0;

    res.json({
      course,
      summary: {
        totalCollected,
        totalPending,
        totalTarget,
        percent,
        byActivity: summary
      },
      filter: { year: filterYear || 'todos', month: filterMonth || 'todos' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add student
app.post('/api/directivo/students', authenticateUser, requireDirectivo, (req, res) => {
  try {
    const { full_name } = req.body;
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Nombre del alumno obligatorio.' });

    let course = null;
    if (req.user.rolesList.includes('SUPER_ADMIN') && req.body.course_id) {
      course = db.prepare('SELECT id FROM courses WHERE id = ?').get(req.body.course_id);
    } else {
      course = db.prepare('SELECT id FROM courses WHERE user_id = ?').get(req.user.user_id);
    }

    if (!course) return res.status(403).json({ error: 'No tienes un curso asignado.' });

    db.prepare('INSERT INTO students (course_id, full_name) VALUES (?, ?)').run(course.id, full_name.trim());
    res.json({ success: true, message: 'Alumno añadido.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. PANEL DE PADRES DE FAMILIA (NUEVO ROL PADRE)
// ==========================================

app.get('/api/padre/dashboard', authenticateUser, requirePadre, (req, res) => {
  try {
    // Find courses and children associated with this parent
    let myStudents = db.prepare(`
      SELECT s.*, c.grade_name, c.slug as course_slug, sc.name as school_name, u.name as president_name, u.phone as president_phone
      FROM students s
      JOIN courses c ON s.course_id = c.id
      JOIN schools sc ON c.school_id = sc.id
      LEFT JOIN users u ON c.user_id = u.id
      WHERE s.parent_user_id = ?
    `).all(req.user.user_id);

    // If parent has no student explicitly linked, give them the first course for easy demonstration
    if (myStudents.length === 0) {
      const defaultCourse = db.prepare(`
        SELECT c.*, sc.name as school_name, u.name as president_name, u.phone as president_phone
        FROM courses c
        JOIN schools sc ON c.school_id = sc.id
        LEFT JOIN users u ON c.user_id = u.id
        ORDER BY c.id ASC LIMIT 1
      `).get();

      if (defaultCourse) {
        myStudents = [{
          id: 0,
          full_name: `${req.user.name} (Estudiante Representado)`,
          course_id: defaultCourse.id,
          grade_name: defaultCourse.grade_name,
          course_slug: defaultCourse.slug,
          school_name: defaultCourse.school_name,
          president_name: defaultCourse.president_name,
          president_phone: defaultCourse.president_phone
        }];
      }
    }

    // Get activities for all relevant courses
    const courseIds = Array.from(new Set(myStudents.map(s => s.course_id)));
    let activities = [];
    if (courseIds.length > 0) {
      const placeholders = courseIds.map(() => '?').join(',');
      activities = db.prepare(`
        SELECT a.*, c.grade_name, sc.name as school_name
        FROM activities a
        JOIN courses c ON a.course_id = c.id
        JOIN schools sc ON c.school_id = sc.id
        WHERE a.course_id IN (${placeholders}) AND a.status = 'ACTIVA'
        ORDER BY a.id DESC
      `).all(...courseIds);
    }

    // Attach payment status per activity for each student
    const activitiesWithStatus = activities.map(act => {
      const payments = db.prepare('SELECT * FROM payments WHERE activity_id = ?').all(act.id);
      const studentStatuses = myStudents.filter(s => s.course_id === act.course_id).map(s => {
        const p = payments.find(pay => pay.student_id === s.id);
        const isPaid = !!p;
        const isRec = act.type === 'RECURRENTE';
        const isFullyPaid = isPaid && (!isRec || p.amount_bob >= act.amount_bob);

        return {
          student_id: s.id,
          student_name: s.full_name,
          status: isFullyPaid ? 'PAGADO' : (isPaid ? 'PARCIAL' : 'PENDIENTE'),
          amount_paid: p ? p.amount_bob : 0,
          installments_covered: p ? p.installments_covered : 0,
          paid_at: p ? p.paid_at : null,
          ref_number: p ? p.ref_number : null
        };
      });

      return {
        ...act,
        studentStatuses
      };
    });

    res.json({
      parent: {
        id: req.user.user_id,
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
        roles: req.user.rolesList
      },
      students: myStudents,
      activities: activitiesWithStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. PUBLIC PORTAL ENDPOINTS
// ==========================================

function getPublicCourseData(slug, activityIdQuery) {
  let course = null;
  if (slug) {
    course = db.prepare(`
      SELECT c.*, s.name as school_name, u.name as president_name, u.phone as president_phone 
      FROM courses c 
      JOIN schools s ON c.school_id = s.id 
      LEFT JOIN users u ON c.user_id = u.id 
      WHERE c.slug = ?
    `).get(slug);
  } else {
    course = db.prepare(`
      SELECT c.*, s.name as school_name, u.name as president_name, u.phone as president_phone 
      FROM courses c 
      JOIN schools s ON c.school_id = s.id 
      LEFT JOIN users u ON c.user_id = u.id 
      ORDER BY c.id ASC LIMIT 1
    `).get();
  }

  if (!course) return null;

  const activities = db.prepare(`
    SELECT * FROM activities 
    WHERE course_id = ? AND status = 'ACTIVA' 
    ORDER BY id DESC
  `).all(course.id);

  let currentActivity = null;
  if (activityIdQuery) {
    currentActivity = activities.find(a => a.id === parseInt(activityIdQuery));
  }
  if (!currentActivity && activities.length > 0) {
    currentActivity = activities[0];
  }

  const rawStudents = db.prepare(`
    SELECT id, full_name 
    FROM students 
    WHERE course_id = ? 
    ORDER BY full_name ASC
  `).all(course.id);

  let students = [];
  let freePayments = [];
  let paidCount = 0;
  let totalCollected = 0;

  if (currentActivity) {
    const payments = db.prepare(`
      SELECT student_id, payer_name, paid_at, payment_method, ref_number, amount_bob, installments_covered 
      FROM payments 
      WHERE activity_id = ?
    `).all(currentActivity.id);

    const paidMap = new Map();
    payments.forEach(p => {
      if (p.student_id) paidMap.set(p.student_id, p);
      else freePayments.push(p);
    });

    paidCount = payments.length;
    totalCollected = payments.reduce((acc, p) => acc + p.amount_bob, 0);

    if (currentActivity.require_roster === 1) {
      students = rawStudents.map(s => {
        const p = paidMap.get(s.id);
        const isPaid = !!p;
        const isRecurring = currentActivity.type === 'RECURRENTE';
        const isFullyPaid = isPaid && (!isRecurring || p.amount_bob >= currentActivity.amount_bob);

        return {
          id: s.id,
          full_name: s.full_name,
          status: isFullyPaid ? 'PAGADO' : (isPaid ? 'PARCIAL' : 'PENDIENTE'),
          paid_at: p ? p.paid_at : null,
          payment_method: p ? p.payment_method : null,
          ref_number: p ? p.ref_number : null,
          amount_paid: p ? p.amount_bob : 0,
          installments_covered: p ? p.installments_covered : 0
        };
      });
    } else {
      students = payments.map((p, idx) => ({
        id: idx + 1,
        full_name: p.payer_name || 'Aportante Anónimo',
        status: 'PAGADO',
        paid_at: p.paid_at,
        payment_method: p.payment_method,
        ref_number: p.ref_number,
        amount_paid: p.amount_bob,
        installments_covered: p.installments_covered
      }));
    }
  }

  const totalStudents = currentActivity && currentActivity.require_roster === 1 ? rawStudents.length : paidCount;
  const pendingCount = currentActivity && currentActivity.require_roster === 1 ? Math.max(0, totalStudents - paidCount) : 0;
  const targetAmount = currentActivity && currentActivity.require_roster === 1 ? (currentActivity.amount_bob * totalStudents) : totalCollected;
  const percent = targetAmount > 0 ? Math.round((totalCollected / targetAmount) * 100) : 0;

  return {
    course: {
      id: course.id,
      grade_name: course.grade_name,
      school_name: course.school_name,
      slug: course.slug
    },
    directivo: {
      name: course.president_name || 'Mesa Directiva',
      phone: course.president_phone || ''
    },
    activities,
    currentActivity,
    metrics: {
      totalCollected,
      paidCount,
      pendingCount,
      totalStudents,
      percent,
      targetAmount
    },
    students
  };
}

app.get('/api/public/course', (req, res) => {
  try {
    const data = getPublicCourseData(req.query.slug, req.query.activity_id);
    if (!data) return res.status(404).json({ error: 'Curso no encontrado.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/course/:slug', (req, res) => {
  try {
    const data = getPublicCourseData(req.params.slug, req.query.activity_id);
    if (!data) return res.status(404).json({ error: 'Curso no encontrado.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. WHATSAPP AI ASSISTANT SIMULATION
// ==========================================

const STOP_WORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'pague', 'pago', 'cuota', 'transferi', 'comprobante', 'recibo', 'para', 'por', 'mi', 'hijo', 'hija', 'alumno']);

function normalizeText(text) {
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
}

function matchStudentInText(queryText, studentsList) {
  const normQuery = normalizeText(queryText);
  const rawWords = normQuery.split(/\s+/);
  const meaningfulWords = rawWords.filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  let bestMatch = null;
  let maxScore = 0;

  for (const student of studentsList) {
    const normStudent = normalizeText(student.full_name);
    const studentParts = normStudent.split(/\s+/);

    if (normQuery.includes(normStudent)) {
      return student;
    }

    let matches = 0;
    for (const part of studentParts) {
      if (part.length < 3) continue;
      if (meaningfulWords.some(w => w === part || (w.length >= 4 && part.includes(w)))) {
        matches++;
      }
    }

    if (matches >= 2 && matches > maxScore) {
      maxScore = matches;
      bestMatch = student;
    } else if (matches === 1 && studentParts.length <= 2 && matches > maxScore) {
      maxScore = matches;
      bestMatch = student;
    }
  }

  return bestMatch;
}

app.post('/api/bot/chat', (req, res) => {
  try {
    const { phone = '70012345', text = '', has_image = false, course_slug } = req.body;

    let course = null;
    if (course_slug) {
      course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(course_slug);
    }
    if (!course) {
      course = db.prepare('SELECT * FROM courses ORDER BY id ASC LIMIT 1').get();
    }
    if (!course) {
      return res.json({ reply: 'Hola, aún no hay cursos configurados en la plataforma.' });
    }

    const activity = db.prepare("SELECT * FROM activities WHERE course_id = ? AND status = 'ACTIVA' ORDER BY id DESC LIMIT 1").get(course.id);
    if (!activity) {
      return res.json({ reply: '¡Hola! En este momento no hay ninguna actividad o cuota abierta para cobro en el curso.' });
    }

    const students = db.prepare('SELECT * FROM students WHERE course_id = ?').all(course.id);

    let session = db.prepare('SELECT * FROM chat_sessions WHERE sender_phone = ?').get(phone);
    if (!session) {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO chat_sessions (sender_phone, course_id, activity_id, state, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(phone, course.id, activity.id, 'WAITING_NAME', now);
      session = { sender_phone: phone, course_id: course.id, activity_id: activity.id, state: 'WAITING_NAME' };
    }

    if (has_image) {
      const matched = matchStudentInText(text, students);
      if (matched) {
        return registerBotPayment(res, activity, matched, session);
      } else {
        db.prepare("UPDATE chat_sessions SET state = 'WAITING_NAME', updated_at = ? WHERE sender_phone = ?")
          .run(new Date().toISOString(), phone);

        const feeText = activity.type === 'RECURRENTE' ? `${activity.installment_amount} Bs. (cuota mensual)` : `${activity.amount_bob} Bs.`;
        return res.json({
          reply: `¡Muchas gracias! 📸 He recibido tu comprobante de pago de *${feeText}* para *"${activity.title}"* del curso *${course.grade_name}*.

Por favor, ¿me indicas el *Nombre Completo del alumno/a* para asentar su pago en la planilla oficial? 😊`
        });
      }
    }

    if (session.state === 'WAITING_NAME') {
      const matched = matchStudentInText(text, students);
      if (matched) {
        return registerBotPayment(res, activity, matched, session);
      } else {
        return res.json({
          reply: `Hola estimado padre/madre de familia. No pude identificar al alumno/a con el nombre "*${text}*".

Por favor indícame los *dos nombres y apellidos* tal como figuran en la lista del curso *${course.grade_name}*. 📝`
        });
      }
    }

    const matched = matchStudentInText(text, students);
    if (matched) {
      return registerBotPayment(res, activity, matched, session);
    }

    const feeAmount = activity.type === 'RECURRENTE' ? activity.installment_amount : activity.amount_bob;
    return res.json({
      reply: `¡Hola! Soy el Asistente Inteligente de Cuotas de *${course.grade_name}*.

Para registrar tu cuota de *${feeAmount} Bs.* para *"${activity.title}"*, envíame una foto del comprobante de transferencia y el nombre de tu hijo/a.`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function registerBotPayment(res, activity, student, session) {
  try {
    const existing = db.prepare('SELECT id, amount_bob FROM payments WHERE activity_id = ? AND student_id = ?').get(activity.id, student.id);
    const now = new Date();
    const pMonth = now.toISOString().slice(0, 7);
    const pYear = now.getFullYear().toString();
    const nowStr = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });
    const ref = 'WHATSAPP-AI-' + Math.floor(100000 + Math.random() * 900000);

    const feePayAmount = activity.type === 'RECURRENTE' ? activity.installment_amount : activity.amount_bob;

    if (existing) {
      if (activity.type === 'RECURRENTE') {
        const newTotal = existing.amount_bob + feePayAmount;
        const covered = Math.min(activity.installments_count, Math.floor(newTotal / activity.installment_amount));
        db.prepare('UPDATE payments SET amount_bob = ?, installments_covered = ?, paid_at = ?, ref_number = ? WHERE id = ?')
          .run(newTotal, covered, nowStr, ref, existing.id);

        return res.json({
          reply: `🎉 *¡ABONO REGISTRADO CON ÉXITO!*

` +
                 `👤 *Alumno:* ${student.full_name}
` +
                 `🎯 *Actividad:* ${activity.title}
` +
                 `💰 *Nuevo Total Abonado:* ${newTotal} Bs. (${covered}/${activity.installments_count} cuotas cubiertas)
` +
                 `🧾 *Ref:* ${ref}
` +
                 `📅 *Fecha:* ${nowStr}

` +
                 `El estado se actualizó en la planilla en vivo del curso.`
        });
      } else {
        return res.json({
          reply: `✅ El alumno *${student.full_name}* ya figuraba con la cuota *PAGADA* en el sistema para *"${activity.title}"*.

¡Todo está al día! Si tienes alguna duda, puedes consultar a la mesa directiva.`
        });
      }
    }

    db.prepare(`
      INSERT INTO payments (activity_id, student_id, amount_bob, installments_covered, payment_method, ref_number, receipt_notes, paid_month, paid_year, paid_at)
      VALUES (?, ?, ?, 1, 'QR SIMPLE GANADERO', ?, 'Validado automáticamente por Asistente IA WhatsApp', ?, ?, ?)
    `).run(activity.id, student.id, feePayAmount, ref, pMonth, pYear, nowStr);

    db.prepare("UPDATE chat_sessions SET state = 'COMPLETED', updated_at = ? WHERE sender_phone = ?")
      .run(new Date().toISOString(), session.sender_phone);

    return res.json({
      reply: `🎉 *¡PAGO REGISTRADO EXITOSAMENTE!*

` +
             `👤 *Alumno:* ${student.full_name}
` +
             `🎯 *Actividad:* ${activity.title}
` +
             `💰 *Monto:* ${feePayAmount} Bs.
` +
             `🧾 *Ref:* ${ref}
` +
             `📅 *Fecha:* ${nowStr}

` +
             `El estado del alumno cambió a 🟢 *PAGADO* en la planilla en vivo de la directiva y en el portal público.`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

app.listen(PORT, () => {
  console.log(`CUOTAS_UNIFIED_SERVER_ON_PORT_${PORT}`);
});
