const bcrypt = require('bcrypt');
const pool = require('./db');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'nory.benali89@gmail.com';

async function initDb() {
  try {
    const client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        plan VARCHAR(50) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        daily_checks_used INT DEFAULT 0,
        daily_otto_analysis INT DEFAULT 0,
        weekly_otto_analysis INT DEFAULT 0,
        last_check_date DATE,
        weekly_reset_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        original_text TEXT,
        score_given REAL,
        is_useful BOOLEAN,
        comment TEXT,
        sources_found JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS emails (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(100),
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const adminExists = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [ADMIN_EMAIL]);
    if (adminExists.rows.length === 0) {
      const adminPassword = process.env.ADMIN_DEFAULT_PWD || 'Nory#Biz2025!Xy';
      const hashed = await bcrypt.hash(adminPassword, 10);
      await client.query(
        `INSERT INTO users (email, password_hash, role, plan, created_at)
         VALUES ($1, $2, 'admin', 'business', NOW())`,
        [ADMIN_EMAIL, hashed],
      );

      if (process.env.NODE_ENV !== 'production') {
        console.log(`Admin créé: ${ADMIN_EMAIL}`);
      } else {
        console.info('Compte administrateur initialisé.');
      }
    }

    client.release();
  } catch (error) {
    console.error('Database init error:', error.message);
  }
}

module.exports = initDb;
