// Hard, server-side blocklist that the model cannot talk or prompt its way
// around and that no client-side human-confirm depends on.
//
// run_shell_command / the code-agent's terminal give real process reach (and a
// bypass permission mode means no confirmation is asked), so a prompt-injected
// page or a glitchy tool chain could otherwise steer the shell at an
// ad-account/card/billing endpoint and spend real money. These categories
// NEVER execute regardless of who asked or what permission mode is set. Kept
// deliberately conservative so the brain stays fully capable for ordinary,
// free work.
//
// Returns an explanation string when it blocks, otherwise null (safe to run).
export function assertSpendSafeShell(command, extraHits = []) {
  const cmd = String(command || '').toLowerCase();
  const hits = [
    [/adsapi\.snapchat\.com|snapchat.*(ads?|business)|business\.snapchat/, 'Snapchat Ads'],
    [/graph\.facebook\.com.*(act_|adaccount|campaign|adset|ads)/, 'Meta/Facebook Ads'],
    [/googleads\.googleapis\.com/, 'Google Ads'],
    [/business-api\.tiktok\.com/, 'TikTok Ads'],
    [/ads-api\.twitter\.com|api\.twitter\.com.*ads/, 'Twitter/X Ads'],
    [/stripe\.com|stripe\b/, 'Stripe/payment processing'],
    [/flyctl (scale|machine update|machine create|machine clone|ips allocate|volumes create|volumes extend|certs add|apps create|billing)|fly (scale|billing)/, 'paid Fly.io provisioning'],
    [/aws |az |gcloud .*billing|gsutil|gcloud compute/, 'paid cloud provisioning'],
    [/npm (publish|yarn publish)|pnpm publish/, 'package publish'],
    ...extraHits,
  ];
  for (const [pattern, label] of hits) {
    if (pattern.test(cmd)) return label;
  }
  return null;
}
