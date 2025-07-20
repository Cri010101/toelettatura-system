const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS per permettere connessioni dall'app Android
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-development';

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token di accesso richiesto' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token non valido' });
    }
    req.user = user;
    next();
  });
};

// Database initialization
async function initDatabase() {
  try {
    console.log('🔄 Checking database...');
    
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    const tablesCheck = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'users'
    `);

    if (tablesCheck.rows.length === 0) {
      console.log('🔄 Creating database tables...');
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'admin',
          fcm_token VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS services (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          duration INTEGER NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          description TEXT,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS appointments (
          id SERIAL PRIMARY KEY,
          client_name VARCHAR(255) NOT NULL,
          client_phone VARCHAR(20),
          client_email VARCHAR(255),
          pet_name VARCHAR(255) NOT NULL,
          pet_breed VARCHAR(255),
          service_id INTEGER REFERENCES services(id),
          appointment_date DATE NOT NULL,
          appointment_time TIME NOT NULL,
          notes TEXT,
          status VARCHAR(50) DEFAULT 'pending',
          rejection_reason TEXT,
          proposed_changes JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          type VARCHAR(50) DEFAULT 'info',
          read BOOLEAN DEFAULT false,
          appointment_id INTEGER REFERENCES appointments(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        INSERT INTO services (name, duration, price, description) VALUES
        ('Bagno e Spazzolatura', 60, 25.00, 'Bagno completo con shampoo specifico e spazzolatura'),
        ('Taglio Completo', 90, 40.00, 'Taglio completo del pelo con styling'),
        ('Taglio Unghie', 30, 15.00, 'Taglio professionale delle unghie'),
        ('Pulizia Orecchie', 20, 10.00, 'Pulizia accurata delle orecchie'),
        ('Pacchetto Completo', 120, 60.00, 'Tutti i servizi inclusi')
        ON CONFLICT DO NOTHING
      `);

      const hashedPassword = await bcrypt.hash('admin123', 10);
      await pool.query(
        'INSERT INTO users (email, password, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        ['admin@toelettatura.com', hashedPassword, 'admin']
      );

      console.log('✅ Database initialized successfully!');
      console.log('👤 Admin user: admin@toelettatura.com / admin123');
    } else {
      console.log('✅ Database tables already exist');
    }
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: '🎉 Connessione al server OK!', 
    server_time: new Date().toISOString()
  });
});

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password richiesti' });
    }
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      message: 'Login effettuato con successo',
      token,
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Errore durante il login' });
  }
});

// Services Routes
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services WHERE active = true ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Services error:', err);
    res.status(500).json({ error: 'Errore recupero servizi' });
  }
});

// Appointments Routes
app.get('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, s.name as service_name, s.duration, s.price 
      FROM appointments a 
      LEFT JOIN services s ON a.service_id = s.id 
      ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Appointments error:', err);
    res.status(500).json({ error: 'Errore recupero appuntamenti' });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const {
      clientName,
      clientPhone,
      clientEmail,
      petName,
      petBreed,
      serviceId,
      appointmentDate,
      appointmentTime,
      notes
    } = req.body;
    
    if (!clientName || !petName || !serviceId || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    }
    
    const result = await pool.query(`
      INSERT INTO appointments 
      (client_name, client_phone, client_email, pet_name, pet_breed, service_id, appointment_date, appointment_time, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *
    `, [clientName, clientPhone, clientEmail, petName, petBreed, serviceId, appointmentDate, appointmentTime, notes]);
    
    res.json({
      message: 'Appuntamento creato con successo',
      appointment: result.rows[0]
    });
  } catch (err) {
    console.error('Create appointment error:', err);
    res.status(500).json({ error: 'Errore creazione appuntamento' });
  }
});

app.put('/api/appointments/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, proposedChanges } = req.body;
    
    const result = await pool.query(`
      UPDATE appointments 
      SET status = $1, rejection_reason = $2, proposed_changes = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 
      RETURNING *
    `, [status, rejectionReason, JSON.stringify(proposedChanges), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Appuntamento non trovato' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update appointment error:', err);
    res.status(500).json({ error: 'Errore aggiornamento appuntamento' });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Errore interno del server' });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato' });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  await initDatabase();
});

module.exports = app;