/**
 * UseEasy Category Manager — Outlook Category Mapping
 *
 * Maps internal classification results to Outlook Master Categories.
 * Handles the translation between UseEasy core keys, UE/Case/* categories,
 * and the final UE/* Master Categories with colors.
 *
 * Architecture:
 *   Internal core keys → UE/Case/* (detailed) → UE/* (master, colored)
 *
 * @version 1.3.0
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Master Category Colors (Microsoft Graph preset names)
// ---------------------------------------------------------------------------

const CATEGORY_COLORS = Object.freeze({
  'UE/Billing & Payment':      'preset0',  // Red
  'UE/Request & Order':        'preset1',  // Orange
  'UE/Contract & Legal':       'preset3',  // Brown
  'UE/Support & Issue':        'preset4',  // Yellow
  'UE/Status & Fulfillment':   'preset5',  // Green
  'UE/Returns & Refund':       'preset7',  // Teal
  'UE/Manual Review':          'preset8',  // Olive
  'UE/Opt-out':                'preset9',  // Blue
});

// ---------------------------------------------------------------------------
// Category Expansion
// ---------------------------------------------------------------------------

/**
 * Expands classification labels into the full set of Outlook categories.
 *
 * Each email gets:
 *   1. One or more UE/Case/* categories (detailed classification)
 *   2. The corresponding UE/* master category (colored, visible in UI)
 *
 * Example input:  ['billing_payment', 'manual_review']
 * Example output: ['UE/Case/Billing & Payment', 'UE/Billing & Payment',
 *                  'UE/Case/Manual Review', 'UE/Manual Review']
 *
 * @param {string[]} labels - Core keys or UE/Case/* labels
 * @param {object} labelMap - Maps core keys → display names
 * @returns {string[]} Expanded category list (deduplicated)
 */
function expandCategories(labels, labelMap) {
  const categories = new Set();

  for (const label of labels) {
    // Resolve to display name
    const displayName = labelMap[label] || label;

    // Add detailed category: UE/Case/Display Name
    if (!label.startsWith('UE/')) {
      categories.add(`UE/Case/${displayName}`);
    }

    // Add master category: UE/Display Name (this one has color)
    const masterName = label.startsWith('UE/Case/')
      ? label.replace('UE/Case/', 'UE/')
      : `UE/${displayName}`;

    if (CATEGORY_COLORS[masterName]) {
      categories.add(masterName);
    }
  }

  return [...categories];
}

/**
 * Builds the list of master categories that need to be provisioned
 * in the user's mailbox. Called during initial setup.
 *
 * @returns {Array<{displayName: string, color: string}>}
 */
function getMasterCategoryDefinitions() {
  return Object.entries(CATEGORY_COLORS).map(([name, color]) => ({
    displayName: name,
    color,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CATEGORY_COLORS,
  expandCategories,
  getMasterCategoryDefinitions,
};
