const express = require('express');
const {
  buildQuotaPayload,
  ensureDailyReset,
} = require('../services/quotaService');
const { getUserByEmail } = require('../services/userService');

const router = express.Router();

router.post('/quota', async (req, res) => {
  try {
    const { userEmail } = req.body || {};

    if (!userEmail) {
      return res.json({ anonymous: true, quota: null });
    }

    let user = await getUserByEmail(userEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }

    user = await ensureDailyReset(user);
    const quota = buildQuotaPayload(user);
    return res.json({ success: true, quota });
  } catch (error) {
    console.error('quota error', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

router.post('/reset-quota', async (req, res) => {
  try {
    const { userEmail } = req.body || {};

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'missing_email' });
    }

    let user = await getUserByEmail(userEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }

    user = await ensureDailyReset(user);
    const quota = buildQuotaPayload(user);
    return res.json({ success: true, quota });
  } catch (error) {
    console.error('reset-quota error', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

module.exports = router;
