/**
 * UseEasy Template Engine — Draft Generation with Placeholder Resolution
 *
 * Generates email drafts from templates stored in PostgreSQL.
 * Each template has placeholders (e.g., {tenant_name}, {apartment})
 * that are resolved from spreadsheet data and email context.
 *
 * Key feature: tracks resolved vs. unresolved placeholders.
 * Unresolved placeholders signal the user to review before sending.
 *
 * @version 4.4.1
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Placeholder Regex
// ---------------------------------------------------------------------------

const PLACEHOLDER_REGEX = /\{(\w+)\}/g;

// ---------------------------------------------------------------------------
// Template Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves all placeholders in a template string.
 *
 * @param {string} template - Template with {placeholder} syntax
 * @param {object} context - Key-value pairs for resolution
 * @returns {ResolvedTemplate} { text, resolved[], unresolved[] }
 */
function resolveTemplate(template, context) {
  const resolved = [];
  const unresolved = [];

  const text = template.replace(PLACEHOLDER_REGEX, (match, key) => {
    if (context[key] !== undefined && context[key] !== null && context[key] !== '') {
      resolved.push(key);
      return String(context[key]);
    }
    unresolved.push(key);
    return match; // Leave placeholder in place for manual fill
  });

  return { text, resolved, unresolved };
}

/**
 * Resolves a full draft template (subject + body).
 *
 * Context is built from multiple sources:
 *   1. Spreadsheet row data (matched via findRows)
 *   2. Email metadata (sender, subject, date)
 *   3. Tenant metadata (company name, contact info)
 *
 * @param {object} template - { subject: string, body: string }
 * @param {object} entities - Extracted entities from spreadsheet match
 * @param {object} tenantMeta - Tenant-level metadata
 * @returns {DraftResult}
 */
function resolveDraftTemplate(template, entities, tenantMeta) {
  // Build context from all available sources
  const context = {
    // Spreadsheet entities
    tenant_name:  entities?.tenant_name || '',
    apartment:    entities?.apartment || '',
    date:         entities?.date || '',
    time:         entities?.time || '',
    status:       entities?.status || '',
    contractor:   entities?.contractor || '',
    phone:        entities?.phone || '',
    notes:        entities?.notes || '',
    priority:     entities?.priority || '',
    cost:         entities?.cost || '',

    // Tenant metadata
    company_name: tenantMeta?.company_name || '',
    admin_name:   tenantMeta?.admin_name || '',
    admin_email:  tenantMeta?.admin_email || '',

    // Dynamic values
    today:        new Date().toISOString().split('T')[0],
  };

  const subjectResult = resolveTemplate(template.subject || '', context);
  const bodyResult = resolveTemplate(template.body || '', context);

  // Merge resolved/unresolved lists
  const allResolved = [...new Set([...subjectResult.resolved, ...bodyResult.resolved])];
  const allUnresolved = [...new Set([...subjectResult.unresolved, ...bodyResult.unresolved])];

  return {
    subject: subjectResult.text,
    body: bodyResult.text,
    resolved_placeholders: allResolved,
    unresolved_placeholders: allUnresolved,
    has_unresolved: allUnresolved.length > 0,
    completeness: allResolved.length / (allResolved.length + allUnresolved.length) || 0,
  };
}

// ---------------------------------------------------------------------------
// Template Loading (from PostgreSQL)
// ---------------------------------------------------------------------------

/**
 * Loads draft templates for a tenant from the database.
 * Falls back to default templates if tenant has none.
 *
 * @param {object} dbPool - PostgreSQL connection pool
 * @param {string} tenantId - Tenant identifier
 * @returns {Promise<DraftTemplate[]>}
 */
async function loadDraftTemplates(dbPool, tenantId) {
  // Try tenant-specific templates first
  const { rows } = await dbPool.query(
    `SELECT id, template_key, subject, body, description, placeholders
     FROM governance.draft_templates
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY template_key`,
    [tenantId]
  );

  if (rows.length > 0) return rows;

  // Fall back to default templates
  const { rows: defaults } = await dbPool.query(
    `SELECT id, template_key, subject, body, description, placeholders
     FROM governance.draft_templates
     WHERE tenant_id = '__default__' AND is_active = true
     ORDER BY template_key`,
    []
  );

  return defaults;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveTemplate,
  resolveDraftTemplate,
  loadDraftTemplates,
  PLACEHOLDER_REGEX,
};
