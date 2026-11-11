const DIRECT_AUTH_URL = 'https://ep-summer-breeze-bdgam8p2.neonauth.c-8.us-east-2.aws.neon.tech/neondb/auth';
export const DATA_URL = 'https://ep-summer-breeze-bdgam8p2.apirest.c-8.us-east-2.aws.neon.tech/neondb/rest/v1';
// Browser only: the page directory, without query or hash. Empty outside a browser (Node tests).
export const APP_URL = typeof location === 'undefined'
  ? ''
  : new URL('./', location.href).href.split('?')[0].split('#')[0];
// Test hook: on localhost, a localStorage override may point auth at a local server.
function localAuthOverride() {
  if (typeof location === 'undefined' || !['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  try {
    const value = localStorage['tabletop-scorecard:auth-url'];
    if (typeof value === 'string' && (value.startsWith('http://localhost') || value.startsWith('http://127.0.0.1'))) return value;
  } catch {
    // Storage unavailable; fall through to the default.
  }
  return null;
}
// On the production host, auth goes through a same-origin Worker proxy (first-party cookies).
export const AUTH_URL = localAuthOverride() || (typeof location !== 'undefined' && location.hostname === 'www.eight1fivedesign.com'
  ? new URL('auth', APP_URL).href.replace(/\/$/, '')
  : DIRECT_AUTH_URL);
