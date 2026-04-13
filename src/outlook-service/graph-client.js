/**
 * UseEasy Outlook Service — Microsoft Graph API Client
 *
 * Native HTTPS client for Microsoft Graph API — no SDK dependency.
 * Handles email operations, category management, and draft creation
 * for Outlook/Microsoft 365 integration.
 *
 * Key pattern: Read-then-merge for categories (never overwrites).
 *
 * @version 1.3.0
 * @author Leon Musawu
 */

'use strict';

const https = require('https');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ---------------------------------------------------------------------------
// Core Graph API Fetch (no dependencies)
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated request to Microsoft Graph API.
 * Uses native Node.js https — no axios, node-fetch, or SDK.
 *
 * @param {string} path - API path (e.g., '/me/messages/{id}')
 * @param {string} accessToken - OAuth2 Bearer token
 * @param {string} [method='GET']
 * @param {object} [body=null]
 * @returns {Promise<object>} Parsed JSON response
 */
function graphFetch(path, accessToken, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GRAPH_BASE}${path}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Graph API ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error(`Graph response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Graph API timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Message Operations
// ---------------------------------------------------------------------------

/**
 * Retrieves a message by ID with optional field selection.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {string[]} [select] - Fields to select (reduces payload)
 * @returns {Promise<object>} Message object
 */
async function getMessage(accessToken, messageId, select = []) {
  let path = `/me/messages/${messageId}`;
  if (select.length > 0) {
    path += `?$select=${select.join(',')}`;
  }
  return graphFetch(path, accessToken);
}

/**
 * Lists messages in a folder with optional filtering.
 *
 * @param {string} accessToken
 * @param {string} [folderId='inbox']
 * @param {object} [options] - { top, filter, select, orderBy }
 * @returns {Promise<object[]>} Array of message objects
 */
async function listMessages(accessToken, folderId = 'inbox', options = {}) {
  const params = new URLSearchParams();
  if (options.top) params.set('$top', options.top);
  if (options.select) params.set('$select', options.select.join(','));
  if (options.orderBy) params.set('$orderby', options.orderBy);
  // Note: $filter with special chars is unreliable in Graph API
  // We filter in-memory after fetching (learned the hard way)

  const query = params.toString();
  const path = `/me/mailFolders/${folderId}/messages${query ? '?' + query : ''}`;

  const response = await graphFetch(path, accessToken);
  return response.value || [];
}

// ---------------------------------------------------------------------------
// Category Management (Read-then-Merge Pattern)
// ---------------------------------------------------------------------------

/**
 * Sets categories on a message using read-then-merge.
 *
 * IMPORTANT: Graph API PATCH replaces the entire categories array.
 * If you just PATCH with new categories, you lose existing ones.
 * We MUST read first, merge, then PATCH.
 *
 * This was Bug #5 in Outlook E2E testing — took us from 4/20 to 20/20
 * colored category coverage.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {string[]} newCategories - Categories to add
 * @returns {Promise<string[]>} Final merged category list
 */
async function setCategories(accessToken, messageId, newCategories) {
  // Step 1: Read existing categories
  const message = await getMessage(accessToken, messageId, ['categories']);
  const existing = message.categories || [];

  // Step 2: Merge with deduplication
  const merged = [...new Set([...existing, ...newCategories])];

  // Step 3: PATCH with the full merged set
  await graphFetch(`/me/messages/${messageId}`, accessToken, 'PATCH', {
    categories: merged,
  });

  return merged;
}

/**
 * Ensures Master Categories exist in the mailbox with correct colors.
 * Must be called before assigning categories (otherwise they appear without color).
 *
 * Requires: MailboxSettings.ReadWrite scope
 *
 * @param {string} accessToken
 * @param {Array<{displayName: string, color: string}>} categories
 */
async function ensureMasterCategories(accessToken, categories) {
  // Get existing master categories
  const existing = await graphFetch('/me/outlook/masterCategories', accessToken);
  const existingNames = new Set((existing.value || []).map(c => c.displayName));

  // Create missing ones
  for (const cat of categories) {
    if (!existingNames.has(cat.displayName)) {
      try {
        await graphFetch('/me/outlook/masterCategories', accessToken, 'POST', {
          displayName: cat.displayName,
          color: cat.color,
        });
      } catch (err) {
        // Category might already exist (race condition) — safe to ignore
        if (!err.message.includes('409')) throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Draft Operations (Compliance: never auto-send)
// ---------------------------------------------------------------------------

/**
 * Creates a new draft message.
 * UseEasy NEVER auto-sends — compliance requirement.
 * User must review and send manually.
 *
 * @param {string} accessToken
 * @param {object} draft - { to, subject, bodyContent, bodyType? }
 * @returns {Promise<{ draftId: string, webLink: string }>}
 */
async function createDraft(accessToken, draft) {
  const message = {
    subject: draft.subject,
    body: {
      contentType: draft.bodyType || 'Text',
      content: draft.bodyContent,
    },
    toRecipients: (Array.isArray(draft.to) ? draft.to : [draft.to]).map(email => ({
      emailAddress: { address: email },
    })),
  };

  const result = await graphFetch('/me/messages', accessToken, 'POST', message);

  return {
    draftId: result.id,
    webLink: result.webLink,
  };
}

/**
 * Creates a reply draft to an existing message.
 *
 * @param {string} accessToken
 * @param {string} messageId - Original message to reply to
 * @param {string} bodyContent - Reply body text
 * @returns {Promise<{ draftId: string, webLink: string }>}
 */
async function createReplyDraft(accessToken, messageId, bodyContent) {
  const result = await graphFetch(
    `/me/messages/${messageId}/createReply`,
    accessToken,
    'POST',
    {}
  );

  // Update the reply draft with our content
  await graphFetch(`/me/messages/${result.id}`, accessToken, 'PATCH', {
    body: {
      contentType: 'Text',
      content: bodyContent,
    },
  });

  return {
    draftId: result.id,
    webLink: result.webLink,
  };
}

// ---------------------------------------------------------------------------
// Mark as Read
// ---------------------------------------------------------------------------

/**
 * Marks a message as read.
 * Called after successful classification to avoid re-processing.
 */
async function markAsRead(accessToken, messageId) {
  return graphFetch(`/me/messages/${messageId}`, accessToken, 'PATCH', {
    isRead: true,
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  graphFetch,
  getMessage,
  listMessages,
  setCategories,
  ensureMasterCategories,
  createDraft,
  createReplyDraft,
  markAsRead,
};
