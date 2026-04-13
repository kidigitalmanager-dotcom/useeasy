/**
 * UseEasy Label Policy — Domain-Aware Label Resolution
 *
 * This module manages the mapping between internal core keys and
 * user-facing label names across different business domains (13 verticals).
 *
 * Design principle:
 *   Internal code ALWAYS uses immutable core keys (e.g., 'billing_payment').
 *   Display names are resolved ONLY at the final API boundary (Gmail/Outlook).
 *   This enables multi-domain SaaS without code duplication.
 *
 * @version 4.4.1
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Core Label Keys (immutable, used throughout the pipeline)
// ---------------------------------------------------------------------------

const CORE_LABEL_KEYS = [
  'billing_payment',
  'request_order',
  'contract_legal',
  'support_issue',
  'status_fulfillment',
  'returns_refund',
  'manual_review',
];

/**
 * Core label definitions with metadata.
 * This is the single source of truth for label properties.
 */
const CORE_LABEL_BY_KEY = Object.freeze({
  billing_payment:    { key: 'billing_payment',    priority: 1, color: 'red' },
  request_order:      { key: 'request_order',      priority: 2, color: 'orange' },
  contract_legal:     { key: 'contract_legal',     priority: 3, color: 'brown' },
  support_issue:      { key: 'support_issue',      priority: 4, color: 'yellow' },
  status_fulfillment: { key: 'status_fulfillment', priority: 5, color: 'green' },
  returns_refund:     { key: 'returns_refund',     priority: 6, color: 'teal' },
  manual_review:      { key: 'manual_review',      priority: 7, color: 'olive' },
});

// ---------------------------------------------------------------------------
// Domain Label Display Map
// ---------------------------------------------------------------------------

/**
 * Maps core keys to domain-specific display names.
 * Each domain can override any or all label names.
 * Unknown domains fall back to 'default'.
 *
 * Production deployment covers 13 industry verticals — two shown here
 * as examples. Additional domains (logistics, coaching, hotel, telecom,
 * education, manufacturing, marketing, finance, energy, b2b_sales)
 * follow the same pattern and are loaded from the database at runtime.
 */
const DOMAIN_LABEL_DISPLAY = Object.freeze({
  default: {
    billing_payment:    'Billing & Payment',
    request_order:      'Request & Order',
    contract_legal:     'Contract & Legal',
    support_issue:      'Support & Issue',
    status_fulfillment: 'Status & Fulfillment',
    returns_refund:     'Returns & Refund',
    manual_review:      'Manual Review',
  },

  // Example: Real estate domain uses property management terminology
  real_estate: {
    billing_payment:    'Utility Billing & Payment',
    request_order:      'Tenant Inquiry & Request',
    contract_legal:     'Lease & Legal',
    support_issue:      'Maintenance & Repair',
    status_fulfillment: 'Process & Fulfillment',
    returns_refund:     'Termination & Settlement',
    manual_review:      'Manual Review',
  },

  // 11 additional domains configured in production (not shown).
  // New domains can be added without code changes —
  // just insert a new key here and the pipeline handles the rest.
});

// ---------------------------------------------------------------------------
// Reverse Lookup (built once at module load for O(1) display→core resolution)
// ---------------------------------------------------------------------------

const DISPLAY_TO_CORE_KEY = Object.freeze(
  Object.entries(DOMAIN_LABEL_DISPLAY.default).reduce(
    (acc, [coreKey, displayName]) => ({ ...acc, [displayName]: coreKey }),
    {}
  )
);

// ---------------------------------------------------------------------------
// Label Resolution Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the display name for a core key in a given domain.
 *
 * Resolution order:
 *   1. Domain-specific mapping (if domain is known)
 *   2. Default domain mapping
 *   3. Core key as-is (failsafe — should never happen with valid keys)
 *
 * @param {string} coreKey - Internal core key (e.g., 'billing_payment')
 * @param {string} [domain] - Tenant domain (e.g., 'real_estate'). Defaults to 'default'.
 * @returns {string} Human-readable label name
 */
function getLabelDisplayName(coreKey, domain) {
  const domainMap = DOMAIN_LABEL_DISPLAY[domain] || DOMAIN_LABEL_DISPLAY.default;
  return domainMap[coreKey] || DOMAIN_LABEL_DISPLAY.default[coreKey] || coreKey;
}

/**
 * Rewrites a single label for a specific domain.
 * Accepts both core keys and display names as input.
 *
 * @param {string} label - Label to rewrite (core key or display name)
 * @param {string} domain - Target domain
 * @returns {string} Domain-specific display name
 */
function rewriteLabelForDomain(label, domain) {
  // Direct core key lookup (most common path)
  if (CORE_LABEL_BY_KEY[label]) {
    return getLabelDisplayName(label, domain);
  }

  // Reverse lookup: display name → core key → domain display name
  const coreKey = DISPLAY_TO_CORE_KEY[label];
  if (coreKey) {
    return getLabelDisplayName(coreKey, domain);
  }

  // Unknown label — return as-is (e.g., custom tenant labels)
  return label;
}

/**
 * Rewrites an array of labels for a specific domain.
 * Called at the final API boundary (Gmail label apply / Outlook category set).
 *
 * This is the key architectural choice:
 *   - Internal pipeline uses core keys everywhere
 *   - Domain-specific display happens ONLY here, at the edge
 *   - Without a domain, labels pass through unchanged (backwards compatible)
 *
 * @param {string[]} labels - Array of labels/core keys
 * @param {string} [tenantDomain] - Tenant's domain
 * @returns {string[]} Domain-specific display labels
 */
function rewriteLabelsForDomain(labels, tenantDomain) {
  if (!tenantDomain) return labels; // No domain = no rewrite
  if (!DOMAIN_LABEL_DISPLAY[tenantDomain]) return labels; // Unknown domain

  return labels.map(label => rewriteLabelForDomain(label, tenantDomain));
}

// ---------------------------------------------------------------------------
// Dual-Label Logic
// ---------------------------------------------------------------------------

/**
 * Resolves the final label set for an email.
 * Maximum 2 labels per email, selected by priority.
 *
 * Priority resolution:
 *   1. Primary label from Pack Engine / LLM Judge
 *   2. Secondary label from risk escalation flags (if different)
 *   3. 'manual_review' is always added if risk flags present
 *
 * @param {object} decision - Classification decision
 * @param {string} decision.primaryKey - Primary core key
 * @param {string[]} [decision.riskFlags] - Risk escalation flags
 * @param {boolean} [decision.candidatesOnly] - Skip human review rules
 * @returns {string[]} Final core keys (max 2)
 */
function resolveDualLabels(decision) {
  if (!decision || typeof decision !== 'object') {
    return [];
  }

  const labels = new Set();

  // Always add primary
  if (decision.primaryKey) {
    labels.add(decision.primaryKey);
  }

  // Risk escalation adds manual_review + category
  if (decision.riskFlags?.length > 0) {
    labels.add('manual_review');

    // Resolve category from risk flags using priority-based mapping
    const categoryKey = resolveCategoryFromFlags(decision.riskFlags);
    if (categoryKey && categoryKey !== decision.primaryKey) {
      labels.add(categoryKey);
    }
  }

  // Cap at 2 labels, ordered by priority
  const sorted = [...labels].sort((a, b) => {
    const pa = CORE_LABEL_BY_KEY[a]?.priority ?? 99;
    const pb = CORE_LABEL_BY_KEY[b]?.priority ?? 99;
    return pa - pb;
  });

  return sorted.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Risk Flag → Category Resolution
// ---------------------------------------------------------------------------

/**
 * Priority-based mapping from risk escalation triggers to core keys.
 * More specific triggers map to more specific categories.
 * When multiple flags are present, the most specific one wins.
 */
const TRIGGER_TO_CORE_KEY = Object.freeze({
  legal_threat:       'contract_legal',
  contract_dispute:   'contract_legal',
  gdpr_request:       'contract_legal',
  billing_dispute:    'billing_payment',
  payment_fraud:      'billing_payment',
  refund_escalation:  'returns_refund',
  chargeback:         'returns_refund',
  service_outage:     'support_issue',
  complaint:          'support_issue',
  delivery_failure:   'status_fulfillment',
});

/**
 * Specificity scores for conflict resolution.
 * Higher score = more specific category = wins over generic ones.
 */
const CORE_KEY_SPECIFICITY = Object.freeze({
  contract_legal:     90,
  billing_payment:    80,
  returns_refund:     70,
  support_issue:      60,
  status_fulfillment: 50,
  request_order:      40,
  manual_review:      10,
});

/**
 * Resolves a category core key from risk escalation flags.
 * Uses TRIGGER_TO_CORE_KEY mapping with specificity ranking —
 * more specific categories win over generic ones.
 *
 * Example: If both 'legal_threat' and 'complaint' flags are present,
 * 'contract_legal' wins (specificity 90) over 'support_issue' (specificity 60).
 *
 * @param {string[]} flags - Risk escalation trigger flags
 * @returns {string|null} Most specific category core key, or null
 */
function resolveCategoryFromFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    return null;
  }

  // Map flags to core keys, filter unknown flags
  const candidates = flags
    .map(flag => TRIGGER_TO_CORE_KEY[flag])
    .filter(Boolean);

  if (candidates.length === 0) return null;

  // Sort by specificity (descending) — most specific wins
  candidates.sort((a, b) =>
    (CORE_KEY_SPECIFICITY[b] || 0) - (CORE_KEY_SPECIFICITY[a] || 0)
  );

  return candidates[0];
}

// ---------------------------------------------------------------------------
// Outlook Category Mapping
// ---------------------------------------------------------------------------

/**
 * Maps core keys to Outlook Master Category names.
 * Outlook uses "UE/" prefix for all UseEasy categories.
 *
 * @param {string} coreKey - Internal core key
 * @param {string} [domain] - Tenant domain for display name
 * @returns {string} Outlook category name (e.g., "UE/Billing & Payment")
 */
function toOutlookCategory(coreKey, domain) {
  const displayName = getLabelDisplayName(coreKey, domain);
  return `UE/${displayName}`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CORE_LABEL_KEYS,
  CORE_LABEL_BY_KEY,
  DOMAIN_LABEL_DISPLAY,
  getLabelDisplayName,
  rewriteLabelForDomain,
  rewriteLabelsForDomain,
  resolveDualLabels,
  resolveCategoryFromFlags,
  toOutlookCategory,
};
