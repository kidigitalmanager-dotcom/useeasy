/**
 * UseEasy Chrome Extension — Service Worker (API Proxy)
 *
 * Handles cross-origin API requests on behalf of the content script.
 * Content scripts in MV3 can't make cross-origin requests directly —
 * the service worker has host_permissions and acts as a proxy.
 *
 * Also manages:
 * - Auth token storage (chrome.storage.local)
 * - Badge updates (unread classification count)
 * - Alarm-based periodic sync
 *
 * @version 0.6.0
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.useeasy.ai';
const AUTH_STORAGE_KEY = 'useeasy_auth_token';
const SYNC_ALARM_NAME = 'useeasy_sync';
const SYNC_INTERVAL_MINUTES = 15;

// ---------------------------------------------------------------------------
// Message Listener (API Proxy)
// ---------------------------------------------------------------------------

/**
 * Listens for messages from the content script and proxies API calls.
 *
 * Message format:
 *   { type: 'USEEASY_API_FETCH', url: '/v1/classify/status', options: { method, body, headers } }
 *
 * Response format:
 *   { ok: boolean, status: number, data: object }
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'USEEASY_API_FETCH') return false;

  // Async handler — must return true to keep the message channel open
  handleApiRequest(message.url, message.options)
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ ok: false, status: 0, data: { error: err.message } }));

  return true; // Keep channel open for async response
});

/**
 * Proxies an API request with auth token injection.
 *
 * @param {string} endpoint - API path (e.g., '/v1/classify/status')
 * @param {object} options - Fetch options { method, body, headers }
 * @returns {Promise<{ ok: boolean, status: number, data: object }>}
 */
async function handleApiRequest(endpoint, options = {}) {
  const token = await getAuthToken();

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const fetchOptions = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  };

  // Inject auth token if available
  if (token) {
    fetchOptions.headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body) {
    fetchOptions.body = options.body;
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

// ---------------------------------------------------------------------------
// Auth Token Management
// ---------------------------------------------------------------------------

/**
 * Retrieves the stored auth token.
 * @returns {Promise<string|null>}
 */
async function getAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
      resolve(result[AUTH_STORAGE_KEY] || null);
    });
  });
}

/**
 * Stores the auth token.
 * Called from the content script after user logs in via Console.
 * @param {string} token
 */
async function setAuthToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AUTH_STORAGE_KEY]: token }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Badge Updates
// ---------------------------------------------------------------------------

/**
 * Updates the extension badge with the count of unread classifications.
 * @param {number} count
 */
function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ---------------------------------------------------------------------------
// Periodic Sync (Alarms API)
// ---------------------------------------------------------------------------

/**
 * Sets up periodic classification sync.
 * Checks for new emails that need classification every 15 minutes.
 */
chrome.alarms.create(SYNC_ALARM_NAME, {
  periodInMinutes: SYNC_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM_NAME) return;

  try {
    const result = await handleApiRequest('/v1/classify/pending');
    if (result.ok && result.data?.pendingCount > 0) {
      updateBadge(result.data.pendingCount);
    }
  } catch (err) {
    console.warn('[UseEasy] Sync failed:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Installation Handler
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open onboarding page on first install
    chrome.tabs.create({ url: 'https://app.useeasy.ai/onboarding?source=extension' });
  }
});

console.log('[UseEasy] Service worker initialized');
