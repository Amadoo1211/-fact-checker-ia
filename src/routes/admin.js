const express = require('express');
const pool = require('../services/db');
const { resetAllCounters } = require('../services/quotaService');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'nory.benali89@gmail.com';

const router = express.Router();

router.get('/admin/users', async (req, res) => {
  try {
    const { adminEmail } = req.query;
    if (adminEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT id, email, plan, role, daily_checks_used, daily_otto_analysis, weekly_otto_analysis, created_at
       FROM users ORDER BY created_at DESC`,
    );
    client.release();

    const stats = {
      total: result.rows.length,
      free: result.rows.filter((u) => u.plan === 'free').length,
      starter: result.rows.filter((u) => u.plan === 'starter').length,
      pro: result.rows.filter((u) => u.plan === 'pro').length,
      business: result.rows.filter((u) => u.plan === 'business').length,
    };

    return res.json({ success: true, users: result.rows, stats });
  } catch (error) {
    console.error('Erreur admin/users:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/admin/upgrade-user', async (req, res) => {
  try {
    const { adminEmail, userEmail, plan } = req.body;
    if (adminEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const client = await pool.connect();
    await client.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE email = $2', [plan, userEmail.toLowerCase()]);
    client.release();

    return res.json({ success: true, message: `${userEmail} upgradé vers ${plan}` });
  } catch (error) {
    console.error('Erreur upgrade:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/admin/delete-user', async (req, res) => {
  try {
    const { adminEmail, userEmail } = req.body;
    if (adminEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const client = await pool.connect();
    await client.query('DELETE FROM users WHERE email = $1', [userEmail.toLowerCase()]);
    client.release();

    return res.json({ success: true, message: `${userEmail} supprimé` });
  } catch (error) {
    console.error('Erreur suppression:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/admin/reset-counters', async (req, res) => {
  const { adminEmail } = req.body;
  if (adminEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    await resetAllCounters();
    return res.json({ success: true, message: 'Tous les compteurs ont été remis à zéro !' });
  } catch (error) {
    console.error('Erreur reset counters:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
