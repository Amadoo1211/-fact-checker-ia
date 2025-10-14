const express = require('express');
const pool = require('../services/db');
const { stripeClient, webhookSecret } = require('../services/stripe');

const router = express.Router();

router.post('/stripe/webhook', async (req, res) => {
  if (!stripeClient || !webhookSecret) {
    return res.status(400).send('Stripe not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerEmail = session.customer_email || session.customer_details?.email;
      if (!customerEmail) {
        return res.json({ received: true });
      }

      const amountPaid = session.amount_total / 100;
      let planType = 'starter';
      if (amountPaid >= 119) planType = 'business';
      else if (amountPaid >= 39) planType = 'pro';

      const client = await pool.connect();
      const userResult = await client.query('SELECT id FROM users WHERE email = $1', [customerEmail.toLowerCase()]);
      if (userResult.rows.length === 0) {
        client.release();
        return res.json({ received: true });
      }

      await client.query(
        `UPDATE users
         SET plan = $1,
             stripe_customer_id = $2,
             stripe_subscription_id = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [planType, session.customer, session.subscription, userResult.rows[0].id],
      );
      client.release();
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const client = await pool.connect();
      await client.query(
        `UPDATE users SET plan = 'free', stripe_subscription_id = NULL WHERE stripe_subscription_id = $1`,
        [subscription.id],
      );
      client.release();
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
