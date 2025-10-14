const express = require('express');
const pool = require('../services/db');
const { stripeClient } = require('../services/stripe');

const router = express.Router();

router.post('/subscribe', async (req, res) => {
  try {
    const { email, name, source } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'Email invalide' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Format email invalide' });
    }

    const sanitizedEmail = email.toLowerCase().trim().substring(0, 255);
    const sanitizedName = name ? name.trim().substring(0, 100) : null;
    const sanitizedSource = source ? source.substring(0, 50) : 'unknown';

    const client = await pool.connect();

    try {
      const existingUser = await client.query('SELECT 1 FROM emails WHERE email = $1', [sanitizedEmail]);
      if (existingUser.rows.length > 0) {
        return res.json({ success: true, message: 'Email already subscribed', alreadySubscribed: true });
      }

      await client.query(
        'INSERT INTO emails (email, name, source, created_at) VALUES ($1, $2, $3, NOW())',
        [sanitizedEmail, sanitizedName, sanitizedSource],
      );

      return res.json({ success: true, message: 'Successfully subscribed', alreadySubscribed: false });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erreur subscription:', error);
    return res.status(500).json({ success: false, error: "Erreur serveur lors de l'inscription" });
  }
});

router.get('/check-email', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.json({ subscribed: false });
    }

    const client = await pool.connect();
    const result = await client.query('SELECT email, created_at FROM emails WHERE email = $1', [email.toLowerCase().trim()]);
    client.release();

    if (result.rows.length > 0) {
      return res.json({ subscribed: true, subscribedAt: result.rows[0].created_at });
    }

    return res.json({ subscribed: false });
  } catch (error) {
    console.error('Erreur check email:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    googleConfigured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    stripeConfigured: !!stripeClient,
  });
});

module.exports = router;
