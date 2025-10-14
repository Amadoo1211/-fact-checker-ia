const stripeSecret = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripeClient = stripeSecret ? require('stripe')(stripeSecret) : null;

module.exports = {
  stripeClient,
  webhookSecret,
};
