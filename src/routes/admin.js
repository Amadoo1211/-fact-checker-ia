const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../services/db');
const { resetAllCounters } = require('../services/quotaService');

const ADMIN_RESET_SECRET = process.env.ADMIN_RESET_SECRET;

const router = express.Router();

function isAuthorized(secret) {
  return ADMIN_RESET_SECRET && secret === ADMIN_RESET_SECRET;
}

router.get('/admin/users', async (req, res) => {
  try {
    const { adminSecret } = req.query;
    if (!isAuthorized(adminSecret)) {
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
    const { adminSecret, userEmail, plan } = req.body;
    if (!isAuthorized(adminSecret)) {
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
    const { adminSecret, userEmail } = req.body;
    if (!isAuthorized(adminSecret)) {
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
  const { adminSecret } = req.body;
  if (!isAuthorized(adminSecret)) {
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

router.post('/admin/reset-password', async (req, res) => {
  const { adminSecret, targetEmail, newPassword } = req.body || {};

  if (!isAuthorized(adminSecret)) {
    return res.status(403).json({ success: false, error: 'access_denied' });
  }

  if (!targetEmail || !newPassword) {
    return res.status(400).json({ success: false, error: 'missing_parameters' });
  }

  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
      [hashed, targetEmail],
    );

    if (process.env.NODE_ENV !== 'production') {
      console.log(`Mot de passe réinitialisé pour ${targetEmail}`);
    }

    return res.json({ success: true, message: 'Password reset' });
  } catch (err) {
    console.error('Erreur reset password admin:', err.message || err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

module.exports = router;
