const { Pool } = require('pg');
const bcrypt = require('bcrypt');

(async () => {
    try {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            console.error('❌ DATABASE_URL manquant.');
            process.exit(1);
        }

        const pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        });

        const updates = [
  { email: 'boud3285@gmail.com', password: 'Boud#2025!Xy' },
  { email: 'Ziadtakedine@gmail.com', password: 'Ziad#2025!Xy' },
  { email: 'Nory.benali89@gmail.com', password: 'Nory#2025!Xy' } // ✅ ajouté
];


        const client = await pool.connect();

        try {
            for (const { email, password } of updates) {
                const hashed = await bcrypt.hash(password, 10);
                const { rowCount } = await client.query(
                    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2`,
                    [hashed, email.toLowerCase()]
                );

                if (rowCount === 0) {
                    throw new Error(`Compte introuvable pour ${email}`);
                }

                console.log(`✅ ${email} → ${password}`);
            }

            console.log('🔐 Réinitialisation terminée.');
        } finally {
            client.release();
            await pool.end();
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Erreur durant la réinitialisation:', error.message || error);
        process.exit(1);
    }
})();
