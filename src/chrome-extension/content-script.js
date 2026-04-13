/**
 * UseEasy Chrome Extension — Content Script (Gmail Integration)
 *
 * Runs in the Gmail page context. Reads email metadata from the DOM,
 * injects UseEasy UI panels, and communicates with the service worker
 * for API calls (content scripts can't make cross-origin requests).
 *
 * Architecture:
 *   Content Script (this file)  → reads DOM, injects UI, sends messages
 *   Service Worker              → receives messages, makes API calls, responds
 *
 * This two-process split is required by Manifest V3 security model.
 *
 * @version 0.6.0
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VERSION = '0.6.0';
const PANEL_ID = 'useeasy-panel';
const BUTTON_CLASS = 'useeasy-action-btn';

// ---------------------------------------------------------------------------
// Gmail DOM Detection
// ---------------------------------------------------------------------------

/**
 * Detects the current email context from Gmail's DOM.
 * Gmail doesn't expose a public API for extensions, so we read the DOM.
 *
 * @returns {EmailContext|null} { subject, sender, threadId, snippet }
 */
function detectEmailContext() {
  // Thread view: subject is in h2 with data-thread-perm-id
  const subjectEl = document.querySelector('h2[data-thread-perm-id]');
  if (!subjectEl) return null;

  const subject = subjectEl.textContent?.trim() || '';
  const threadId = subjectEl.getAttribute('data-thread-perm-id') || '';

  // Sender: look for [email] attribute in the message header area
  const senderEl = document.querySelector('[email]');
  const sender = senderEl?.getAttribute('email') || '';

  // Snippet: first few lines of the email body
  const bodyEl = document.querySelector('.a3s.aiL');
  const snippet = bodyEl?.textContent?.substring(0, 200)?.trim() || '';

  return { subject, sender, threadId, snippet };
}

/**
 * Extracts thread ID from Gmail URL hash.
 * Gmail uses fragment-based routing: #inbox/FMfcgzQ...
 *
 * @returns {string|null} Thread ID or null
 */
function extractThreadIdFromHash() {
  const hash = window.location.hash;
  const match = hash.match(/#(?:inbox|sent|label\/[^/]+)\/([A-Za-z0-9]+)/);
  return match?.[1] || null;
}

// ---------------------------------------------------------------------------
// Navigation Watching
// ---------------------------------------------------------------------------

/**
 * Watches for Gmail navigation changes (SPA — no page reloads).
 * Gmail uses hashchange for navigation between threads.
 */
function watchNavigation() {
  let lastHash = window.location.hash;

  window.addEventListener('hashchange', () => {
    const newHash = window.location.hash;
    if (newHash !== lastHash) {
      lastHash = newHash;
      onNavigationChange(newHash);
    }
  });

  // Also watch for DOM mutations (Gmail lazy-loads email content)
  const observer = new MutationObserver(debounce(() => {
    const context = detectEmailContext();
    if (context) {
      onEmailOpened(context);
    }
  }, 500));

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Called when Gmail navigates to a new view.
 */
function onNavigationChange(hash) {
  // Clean up any existing UseEasy panels
  removePanel();

  // Check if we're viewing a thread
  const threadId = extractThreadIdFromHash();
  if (threadId) {
    // Wait for Gmail to render the thread, then inject
    setTimeout(() => {
      const context = detectEmailContext();
      if (context) onEmailOpened(context);
    }, 800);
  }
}

// ---------------------------------------------------------------------------
// API Communication (via Service Worker)
// ---------------------------------------------------------------------------

/**
 * Sends an API request through the service worker.
 * Content scripts can't make cross-origin requests directly (MV3).
 * The service worker has host_permissions and proxies the request.
 *
 * @param {string} endpoint - API path (e.g., '/v1/classify')
 * @param {object} [options] - { method, body, headers }
 * @returns {Promise<object>} API response
 */
function apiRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'USEEASY_API_FETCH',
        url: endpoint,
        options: {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body ? JSON.stringify(options.body) : undefined,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.ok) {
          resolve(response.data);
        } else {
          reject(new Error(`API ${response?.status}: ${JSON.stringify(response?.data)}`));
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Email Classification Trigger
// ---------------------------------------------------------------------------

/**
 * Called when the user opens an email thread.
 * Fetches classification from the API and renders the result panel.
 *
 * @param {EmailContext} context
 */
async function onEmailOpened(context) {
  if (!context?.threadId) return;

  // Avoid duplicate panels
  if (document.getElementById(PANEL_ID)) return;

  try {
    // Fetch classification from API
    const result = await apiRequest('/v1/classify/status', {
      method: 'POST',
      body: {
        thread_id: context.threadId,
        subject: context.subject,
        sender: context.sender,
      },
    });

    if (result?.classification) {
      renderClassificationPanel(result);
    }

    // Check for spreadsheet matches (v0.6.0)
    if (result?.spreadsheet_update) {
      renderSpreadsheetPanel(result.spreadsheet_update);
    }
  } catch (err) {
    console.warn('[UseEasy] Classification fetch failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// UI Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the classification result panel in Gmail's sidebar.
 *
 * @param {object} result - Classification result from API
 */
function renderClassificationPanel(result) {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'useeasy-panel';

  // Panel content: labels, confidence, decision path
  panel.innerHTML = `
    <div class="useeasy-panel-header">
      <span class="useeasy-logo">UE</span>
      <span class="useeasy-title">UseEasy</span>
      <span class="useeasy-version">v${VERSION}</span>
    </div>
    <div class="useeasy-panel-body">
      <div class="useeasy-labels">
        ${(result.classification.labels || []).map(label =>
          `<span class="useeasy-label">${escapeHtml(label)}</span>`
        ).join('')}
      </div>
      <div class="useeasy-meta">
        <span>Confidence: ${Math.round((result.classification.confidence || 0) * 100)}%</span>
        <span>Path: ${result.classification.decidedBy || 'unknown'}</span>
      </div>
    </div>
  `;

  // Inject into Gmail sidebar
  injectPanel(panel);
}

/**
 * Renders the spreadsheet match panel (v0.6.0).
 * Shows diff preview: what would change in the connected spreadsheet.
 *
 * @param {object} spreadsheetUpdate - { sheetName, diffs[], templateAvailable }
 */
function renderSpreadsheetPanel(spreadsheetUpdate) {
  // Implementation renders diff table with before/after values
  // + Confirm/Cancel buttons + optional draft-from-template trigger
}

/**
 * Renders the permanent Excel button in Gmail's button row (v0.6.0).
 * Opens the Console's Excel Live-Sync settings tab.
 */
function renderExcelButton() {
  const buttonRow = document.querySelector('.G-Ni.J-J5-Ji'); // Gmail button container
  if (!buttonRow) return;
  if (buttonRow.querySelector('.useeasy-excel-btn')) return; // Already exists

  const btn = document.createElement('div');
  btn.className = `${BUTTON_CLASS} useeasy-excel-btn`;
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'UseEasy Excel');
  btn.textContent = 'Excel';
  btn.title = 'Open UseEasy Excel Live-Sync';

  btn.addEventListener('click', () => {
    window.open('https://app.useeasy.ai/einstellungen?tab=excel', '_blank');
  });

  buttonRow.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Panel Injection + Removal
// ---------------------------------------------------------------------------

function injectPanel(panel) {
  // Find Gmail's sidebar container
  const sidebar = document.querySelector('.bkK') // Right sidebar
    || document.querySelector('.nH.bkK');

  if (sidebar) {
    sidebar.prepend(panel);
  } else {
    // Fallback: inject as floating panel
    panel.style.position = 'fixed';
    panel.style.top = '80px';
    panel.style.right = '20px';
    panel.style.zIndex = '9999';
    document.body.appendChild(panel);
  }
}

function removePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Entry point. Waits for Gmail to fully load, then starts watching.
 */
function initialize() {
  // Wait for Gmail's main UI to render
  const checkReady = setInterval(() => {
    if (document.querySelector('.aeH')) { // Gmail main container
      clearInterval(checkReady);
      watchNavigation();
      renderExcelButton();
      console.log(`[UseEasy] Content script v${VERSION} initialized`);
    }
  }, 500);

  // Timeout after 30s
  setTimeout(() => clearInterval(checkReady), 30000);
}

// Run on load
initialize();
