'use strict';

const GAME_URL = 'https://pokecatch-online.app/';
const GAME_HOSTS = Object.freeze([
  new URL(GAME_URL).hostname,
  'pokecatch-online.netlify.app',
  'pokecatch-online.pages.dev',
]);

const AUTH_PROVIDER_HOSTS = Object.freeze([
  'accounts.google.com', 'accounts.youtube.com', 'accounts.google.cn',
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'discord.com', 'discordapp.com',
  'appleid.apple.com',
]);

const POPUP_ALLOW_HOSTS = Object.freeze([
  ...GAME_HOSTS,
  ...AUTH_PROVIDER_HOSTS,
  'supabase.co', 'supabase.in',
  'firebaseapp.com', 'web.app',
]);

const NAV_ALLOW_HOSTS = Object.freeze([
  ...GAME_HOSTS,
  ...AUTH_PROVIDER_HOSTS,
  'supabase.co', 'supabase.in',
  'firebaseapp.com', 'web.app',
]);

const AUTH_FLOW_TTL = 5 * 60 * 1000;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function hostAllowed(url, list) {
  // Firebase 常先开 about:blank 再改 location，空窗口必须放行，否则弹窗直接没了
  if (!url || url === 'about:blank') return true;
  const h = hostOf(url);
  if (!h) return false;
  return list.some((a) => h === a || h.endsWith('.' + a));
}

function isGameHost(h) {
  const host = String(h || '').toLowerCase();
  if (!host) return false;
  return GAME_HOSTS.some((a) => host === a || host.endsWith('.' + a));
}

function isGameUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && GAME_HOSTS.includes(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function isOAuthEndpoint(url) {
  try {
    const u = new URL(url);
    return /\/(auth\/v1\/authorize|oauth2?\/authorize|oauth\/authorize)/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function isSupabaseAuthorizeUrl(url) {
  if (!hostAllowed(url, ['supabase.co', 'supabase.in'])) return false;
  try {
    return /^\/auth\/v1\/authorize\b/i.test(new URL(url).pathname);
  } catch (_) {
    return false;
  }
}

function createNavigationPolicy() {
  let authFlowUntil = 0;

  return {
    shouldAllowNavigation(url, now = Date.now()) {
      const h = hostOf(url);
      if (h && isGameHost(h)) {
        authFlowUntil = 0;
        return true;
      }
      if (hostAllowed(url, NAV_ALLOW_HOSTS)) {
        if (isOAuthEndpoint(url) || h.endsWith('.supabase.co') || h.endsWith('.supabase.in')) {
          authFlowUntil = now + AUTH_FLOW_TTL;
        }
        return true;
      }
      if (authFlowUntil > now && h && AUTH_PROVIDER_HOSTS.some((a) => h === a || h.endsWith('.' + a))) {
        return true;
      }
      return false;
    },
    resetAuthFlow() {
      authFlowUntil = 0;
    },
  };
}

module.exports = {
  GAME_URL,
  GAME_HOSTS,
  AUTH_PROVIDER_HOSTS,
  POPUP_ALLOW_HOSTS,
  NAV_ALLOW_HOSTS,
  AUTH_FLOW_TTL,
  isHttpUrl,
  hostOf,
  hostAllowed,
  isGameHost,
  isGameUrl,
  isOAuthEndpoint,
  isSupabaseAuthorizeUrl,
  createNavigationPolicy,
};
