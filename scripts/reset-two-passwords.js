const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const updates = [
  { email: 'boud3285@gmail.com', password: 'Boud#2025!Xy' },
  { email: 'Ziadtakedine@gmail.com', password: 'Ziad#2025!Xy' },
  { email: 'Nory.benali89@gmail.com', password: 'Nory#2025!Xy' }, // ✅ ajouté
];

async function resetTwoPasswords(logger = console) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const error = new Error('DATABASE_URL manquant.');
    logger.error(`❌ ${error.message}`);
    throw error;
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const results = [];
  const client = await pool.connect();

  try {
    for (const { email, password } of updates) {
      try {
        const hashed = await bcrypt.hash(password, 10);
        const { rowCount } = await client.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2`,
          [hashed, email.toLowerCase()],
        );

        if (rowCount === 0) {
          const message = `Compte introuvable pour ${email}`;
          results.push({ email, success: false, error: message });
          logger.error(`❌ ${message}`);
        } else {
          results.push({ email, success: true });
          logger.log(`✅ ${email} → ${password}`);
        }
      } catch (err) {
        const message = err.message || String(err);
        results.push({ email, success: false, error: message });
        logger.error(`❌ Erreur pour ${email}: ${message}`);
      }
    }

    const summary = {
      status: 'done',
      results,
      updated: results.filter((item) => item.success).map((item) => item.email),
      failed: results.filter((item) => !item.success).map((item) => ({ email: item.email, error: item.error })),
    };

    if (summary.failed.length === 0) {
      logger.log('🔐 Réinitialisation terminée.');
    }

    return summary;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { resetTwoPasswords };

if (require.main === module) {
  resetTwoPasswords()
    .then((summary) => {
      if (summary.failed.length > 0) {
        process.exit(1);
      }

      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Erreur durant la réinitialisation:', error.message || error);
      process.exit(1);
    });
}
