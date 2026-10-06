/**
 * Per-customer integration settings.
 *
 * One deployment, one database. Webhook target and signing secret are
 * environment variables on that deployment. They are not stored in the
 * database and no API returns them. API keys are separate: an admin mints
 * them, and only the SHA-256 hash is stored.
 */

export function loadIntegrationConfig(env = process.env) {
  const webhookTargetUrl = String(env.WEBHOOK_TARGET_URL || '').trim();
  const webhookSigningSecret = String(env.WEBHOOK_SIGNING_SECRET || '').trim();
  return {
    webhookTargetUrl,
    webhookSigningSecret,
    ready: Boolean(webhookTargetUrl && webhookSigningSecret)
  };
}

export function webhookTargetHost(url) {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Customer targets must be https. Loopback http is allowed so a local
 * receiver (and tests) can run without a certificate.
 */
export function assertDeliverableWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error('WEBHOOK_TARGET_URL is not a valid URL');
    error.code = 'webhook_url_invalid';
    throw error;
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) {
    return parsed;
  }
  const error = new Error('WEBHOOK_TARGET_URL must be https');
  error.code = 'webhook_url_invalid';
  throw error;
}

export function publicIntegrationConfig(config) {
  const source = config || loadIntegrationConfig();
  return {
    webhook_target_configured: Boolean(source.webhookTargetUrl),
    webhook_signing_secret_configured: Boolean(source.webhookSigningSecret),
    webhook_target_host: webhookTargetHost(source.webhookTargetUrl)
  };
}
