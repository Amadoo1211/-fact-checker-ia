// update-quotas.js
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PLAN_LIMITS = {
  free: { dailyVerifications: 3, dailyOtto: 1 },
  starter: { dailyVerifications: 10, dailyOtto: 5 },
  pro: { dailyVerifications: 30, dailyOtto: Infinity },
  business: { dailyVerifications: Infinity, dailyOtto: Infinity },
};

(async () => {
  const client = await pool.connect();
  try {
    console.log("🔧 Vérification / mise à jour de la table users...");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS daily_otto_analysis INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_otto_reset_date DATE DEFAULT CURRENT_DATE,
      ADD COLUMN IF NOT EXISTS last_check_date DATE DEFAULT CURRENT_DATE;
    `);

    console.log("✅ Colonnes vérifiées / ajoutées avec succès.\n");

    const res = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users';
    `);

    console.log("📋 Structure actuelle de la table users :\n");
    res.rows.forEach(r => console.log(`• ${r.column_name} (${r.data_type})`));

    console.log("\n🧮 Limites de plan configurées :");
    Object.entries(PLAN_LIMITS).forEach(([plan, v]) => {
      console.log(`- ${plan}: ${v.dailyVerifications} vérif/jour, ${v.dailyOtto === Infinity ? "illimité" : v.dailyOtto + " Otto/jour"}`);
    });

    console.log("\n✅ Mise à jour terminée avec succès !");
  } catch (err) {
    console.error("❌ Erreur pendant la mise à jour :", err);
  } finally {
    client.release();
    process.exit(0);
  }
})();
