const { Pool } = require('pg');
const bcrypt = require('bcrypt');

(async () => {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL manquant');

    const pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    // LISTE A REMPLACER AVEC LES COMPTES À RÉINITIALISER
    const updates = [
      { email: 'nory.benali89@gmail.com', password: 'Nory#Biz2025!Xy' },
      { email: 'boud3285@gmail.com', password: 'Boud#2025!Xy' },
      { email: 'ziadtakedine@gmail.com', password: 'Ziad#2025!Xy' },
    ];

    const client = await pool.connect();
    try {
      for (const { email, password } of updates) {
        const hashed = await bcrypt.hash(password, 10);
        const result = await client.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)`,
          [hashed, email],
        );
        if (result.rowCount === 0) {
          console.warn(`Compte introuvable pour ${email}`);
        } else {
          console.log(`✅ ${email} -> ${password}`);
        }
      }
    } finally {
      client.release();
      await pool.end();
    }

    process.exit(0);
  } catch (err) {
    console.error('❌', err.message || err);
    process.exit(1);
  }
})();
