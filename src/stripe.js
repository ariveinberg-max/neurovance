import Stripe from 'stripe';

// Real payment collection — reads keys from env, same "quietly not configured
// yet" pattern as mailer.js's Gmail credentials, so the rest of the app
// stays testable before Ari has actually created the Stripe account.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.neurovance.dev';

let stripeClient = null;
function getClient() {
  if (stripeClient) return stripeClient;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

export function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

// Sends the user to Stripe's own hosted checkout page — this app never
// touches a card number itself. client_reference_id carries our userId
// through so the webhook, when it comes back, knows whose plan to flip.
// Reuses an existing Stripe customer if this user has checked out before,
// so a second subscription isn't created as an unrelated customer.
export async function createCheckoutSession(user) {
  const stripe = getClient();
  if (!stripe) throw new Error('Payments are not configured yet.');

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: user.id,
    customer: user.stripeCustomerId || undefined,
    customer_email: user.stripeCustomerId ? undefined : user.email,
    // Also on the subscription itself (not just the session) so a later
    // subscription.deleted event — which only carries the subscription
    // object, not the session — can still be mapped back to our userId.
    subscription_data: { metadata: { userId: user.id } },
    success_url: `${APP_BASE_URL}/?upgraded=1`,
    cancel_url: `${APP_BASE_URL}/?upgrade_canceled=1`,
  });
  return session.url;
}

// The Customer Portal is Stripe's own hosted "manage/cancel my
// subscription" page — again, never touches billing details ourselves.
export async function createBillingPortalSession(user) {
  const stripe = getClient();
  if (!stripe) throw new Error('Payments are not configured yet.');
  if (!user.stripeCustomerId) throw new Error('No billing account found for this user.');

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${APP_BASE_URL}/`,
  });
  return session.url;
}

// Verifies the request actually came from Stripe (not just anyone posting
// {"event": "give me paid access"} to the endpoint) before trusting it.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const stripe = getClient();
  if (!stripe) throw new Error('Payments are not configured yet.');
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
}

export async function getSubscription(subscriptionId) {
  const stripe = getClient();
  if (!stripe) throw new Error('Payments are not configured yet.');
  return stripe.subscriptions.retrieve(subscriptionId);
}
