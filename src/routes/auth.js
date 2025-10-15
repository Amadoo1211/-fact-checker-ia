const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../services/db');
const { getUserByEmail } = require('../services/userService');

const router = express.Router();

router.post('/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Email invalide' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Mot de passe trop court (min 6)' });
    }

    const normalizedEmail = email.toLowerCase();

    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Email déjà utilisé' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    const result = await client.query(
      `INSERT INTO users (email, password_hash, role, plan, daily_checks_used, daily_otto_analysis, weekly_otto_analysis, last_check_date, weekly_reset_date)
       VALUES ($1, $2, 'user', 'free', 0, 0, 0, CURRENT_DATE, CURRENT_DATE)
       RETURNING id, email, role, plan`,
      [normalizedEmail, hashedPassword],
    );
    client.release();

    const createdUser = result.rows[0];
    console.log(`✅ User signed up: ${createdUser.email}`);

    return res.json({
      success: true,
      userEmail: createdUser.email,
      plan: createdUser.plan || 'free',
      token: null,
    });
  } catch (error) {
    console.error('Erreur signup:', error);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
    }

    const normalizedEmail = email.toLowerCase();
    const user = await getUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    console.log(`✅ User logged in: ${user.email}`);

    return res.json({
      success: true,
      userEmail: user.email,
      plan: user.plan || 'free',
      token: null,
    });
  } catch (error) {
    console.error('Erreur login:', error);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

console.log('✅ Auth routes ready (login/signup operational)');

module.exports = router;
