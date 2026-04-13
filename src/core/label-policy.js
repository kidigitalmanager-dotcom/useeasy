/**
 * UseEasy Label Policy — Domain-Aware Label Resolution
 *
 * This module manages the mapping between internal core keys and
 * user-facing label names across different business domains.
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
 * NOTE: Actual production values redacted.
 * The pattern shown here demonstrates the architecture.
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

  // Example: Real estate domain uses different terminology
  real_estate: {
    billing_payment:    'Utility Billing & Payment',
    request_order:      'Tenant Inquiry & Request',
    contract_legal:     'Lease & Legal',
    support_issue:      'Maintenance & Repair',
    status_fulfillment: 'Process & Fulfillment',
    returns_refund:     'Termination & Settlement',
    manual_review:      'Manual Review',
  },

  // Additional domains can be added without code changes
  // Just insert a new key here — the pipeline handles the rest
});

// ---------------------------------------------------------------------------
// Label Resolution Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the display name for a core key in a given domain.
 *
 * @param {string} coreKey - Internal core key (e.g., 'billing_payment')
 * @param {string} [domain] - Tenant domain (e.g., 'real_estate')
 * @returns {string} Human-readable label name
 */
function getLabelDisplayName(coreKey, domain) {
  const domainMap = DOMAIN_LABEL_DISPLAY[domain] || DOMAIN_LABEL_DISPLAY.default;
  return domainMap[coreKey] || DOMAIN_LABEL_DISPLAY.default[coreKey] || coreKey;
}

/**
 * Rewrites a single label for a specific domain.
 * Used internally by rewriteLabelsForDomain.
 *
 * @param {string} label - Label to rewrite (can be core key or display name)
 * @param {string} domain - Target domain
 * @returns {string} Domain-specific display name
 */
function rewriteLabelForDomain(label, domain) {
  // Check if label is already a core key
  if (CORE_LABEL_BY_KEY[label]) {
    return getLabelDisplayName(label, domain);
  }

  // Check if label is a default display name → resolve to core key first
  const defaultMap = DOMAIN_LABEL_DISPLAY.default;
  const coreKey = Object.keys(defaultMap).find(k => defaultMap[k] === label);
  if (coreKey) {
    return getLabelDisplayName(coreKey, domain);
  }

  // Unknown label — return as-is
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
 * @param {string[]} decision.riskFlags - Risk escalation flags
 * @param {boolean} decision.candidatesOnly - Skip human review rules
 * @returns {string[]} Final core keys (max 2)
 */
function resolveDualLabels(decision) {
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

/**
 * Resolves a category core key from risk escalation flags.
 * Uses TRIGGER_TO_CORE_KEY mapping with specificity ranking —
 * more specific categories win over generic ones.
 *
 * Example: If both 'contract' and 'support' flags are present,
 * 'contract_legal' wins because it's more specific (higher specificity score).
 */
function resolveCategoryFromFlags(flags) {
  // Implementation uses TRIGGER_TO_CORE_KEY + CORE_KEY_SPECIFICITY
  // maps — details omitted (business logic).
  // Pattern: flags.map(f => TRIGGER_TO_CORE_KEY[f]).sort(bySpecificity)[0]
  return null; // Placeholder
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
  toOutlookCategory,
};
