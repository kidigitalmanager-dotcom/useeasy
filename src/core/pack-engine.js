/**
 * UseEasy Pack Engine — Deterministic Rule Evaluator
 *
 * Evaluates classification rules stored in PostgreSQL against email context.
 * Rules are organized in "packs" per domain (13 industry verticals) and
 * loaded per-tenant based on their active pack keys.
 *
 * Architecture:
 * - Rules are JSON condition trees with AND/OR/NOT logic
 * - Each rule has a priority (P0-P9) for conflict resolution
 * - Evaluation is pure/deterministic — no LLM involved
 * - LLM is only invoked downstream if pack confidence < threshold
 *
 * @version 4.4.1
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Rule Loading (from governance.pack_rules via PostgreSQL)
// ---------------------------------------------------------------------------

/**
 * Loads active pack rules for a tenant from the governance schema.
 * Uses the tenant's active_pack_keys to filter rules, always includes global_core.
 *
 * @param {object} dbPool - PostgreSQL connection pool
 * @param {string} tenantId - Tenant identifier
 * @returns {Array<PackRule>} Sorted by priority (P0 = highest)
 */
async function loadPackRules(dbPool, tenantId) {
  if (!dbPool) throw new Error('loadPackRules: dbPool is required');
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('loadPackRules: tenantId must be a non-empty string');
  }

  // Query governance.v_tenant_active_packs view
  // This view auto-appends 'global_core' to every tenant's pack list
  const { rows: tenantPacks } = await dbPool.query(
    `SELECT pack_key FROM governance.v_tenant_active_packs WHERE tenant_id = $1`,
    [tenantId]
  );

  if (!tenantPacks || tenantPacks.length === 0) {
    return []; // Tenant has no packs configured
  }

  const packKeys = tenantPacks.map(r => r.pack_key);

  // Load all active rules for these packs, sorted by priority
  const { rows: rules } = await dbPool.query(
    `SELECT rule_key, pack_key, priority, conditions_json, action_json
     FROM governance.pack_rules
     WHERE pack_key = ANY($1) AND is_active = true
     ORDER BY priority ASC`,
    [packKeys]
  );

  return rules.map(r => ({
    key: r.rule_key,
    pack: r.pack_key,
    priority: r.priority,
    conditions: r.conditions_json,
    action: r.action_json,
  }));
}

// ---------------------------------------------------------------------------
// Field Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a field value from the email context object.
 * Supports dot-notation for nested fields (e.g., 'headers.from').
 *
 * @param {object} ctx - Email context { subject, body, from, headers, ... }
 * @param {string} fieldPath - Dot-separated field path
 * @returns {*} Field value or undefined
 */
function getField(ctx, fieldPath) {
  return fieldPath.split('.').reduce((obj, key) => obj?.[key], ctx);
}

/**
 * Normalizes text for comparison: lowercase, trim, collapse whitespace.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Clause Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates a single clause against the email context.
 *
 * Supported operators:
 * - exists:       field is not null/undefined
 * - eq:           normalized equality
 * - neq:          normalized inequality
 * - contains:     substring match (case-insensitive)
 * - contains_any: any of the values is a substring
 * - regex_any:    any regex pattern matches
 * - gt / lt:      numeric comparison
 *
 * @param {object} ctx - Email context
 * @param {object} clause - { field, op, value?, values?, patterns? }
 * @returns {boolean}
 */
function evaluateClause(ctx, clause) {
  if (!clause || !clause.field || !clause.op) {
    throw new Error(`evaluateClause: invalid clause — field and op are required`);
  }

  const fieldValue = getField(ctx, clause.field);

  switch (clause.op) {
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;

    case 'eq':
      return normalizeText(fieldValue) === normalizeText(clause.value);

    case 'neq':
      return normalizeText(fieldValue) !== normalizeText(clause.value);

    case 'contains':
      return normalizeText(fieldValue).includes(normalizeText(clause.value));

    case 'contains_any': {
      const text = normalizeText(fieldValue);
      return (clause.values || []).some(v => text.includes(normalizeText(v)));
    }

    case 'regex_any': {
      if (typeof fieldValue !== 'string') return false;
      return (clause.patterns || []).some(pattern => {
        try {
          return new RegExp(pattern, 'i').test(fieldValue);
        } catch {
          return false; // Invalid regex in rule — skip, don't crash
        }
      });
    }

    case 'gt':
      return Number(fieldValue) > Number(clause.value);

    case 'lt':
      return Number(fieldValue) < Number(clause.value);

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Condition Tree Evaluation (recursive AND/OR/NOT)
// ---------------------------------------------------------------------------

/**
 * Evaluates a condition tree recursively.
 *
 * Condition format:
 *   { all: [conditions] }     → AND (every child must match)
 *   { any: [conditions] }     → OR  (at least one must match)
 *   { not: condition }        → NOT (child must not match)
 *   { field, op, value, ... } → Leaf clause
 *
 * @param {object} ctx - Email context
 * @param {object} condition - Condition tree node
 * @returns {boolean}
 */
function evaluateConditions(ctx, condition) {
  if (condition.not) {
    return !evaluateConditions(ctx, condition.not);
  }
  if (condition.all) {
    return condition.all.every(child => evaluateConditions(ctx, child));
  }
  if (condition.any) {
    return condition.any.some(child => evaluateConditions(ctx, child));
  }
  // Leaf node — evaluate as clause
  return evaluateClause(ctx, condition);
}

// ---------------------------------------------------------------------------
// Pack Engine Main Entry
// ---------------------------------------------------------------------------

/**
 * Runs all active pack rules against an email context.
 * Returns matched rules sorted by priority, with the highest-priority
 * match used as the primary classification candidate.
 *
 * @param {Array<PackRule>} rules - Pre-loaded pack rules
 * @param {object} emailContext - { subject, body, from, to, headers, ... }
 * @returns {PackEngineResult} { matches, primaryCandidate, confidence }
 */
function evaluatePackRules(rules, emailContext) {
  const matches = [];

  for (const rule of rules) {
    const isMatch = evaluateConditions(emailContext, rule.conditions);
    if (isMatch) {
      matches.push({
        ruleKey: rule.key,
        packKey: rule.pack,
        priority: rule.priority,
        action: rule.action,
      });
    }
  }

  // Sort by priority (lower number = higher priority)
  matches.sort((a, b) => a.priority - b.priority);

  const primary = matches[0] || null;

  return {
    matches,
    primaryCandidate: primary?.action?.coreKey || null,
    confidence: primary ? calculateConfidence(matches) : 0,
    matchCount: matches.length,
    decidedBy: matches.length > 0 ? 'pack_engine' : null,
  };
}

/**
 * Calculates confidence score based on match quality.
 * Used to decide whether the Pack Engine result is sufficient
 * or should be escalated to the LLM Judge for validation.
 *
 * Scoring logic:
 *   - Single match:           0.95 (high confidence, skip LLM)
 *   - Multiple, same key:     0.90 (rules agree, skip LLM)
 *   - Multiple, conflicting:  0.70–0.85 (priority gap determines score)
 *
 * If score < CONFIDENCE_GATE (0.75), the LLM Judge is invoked downstream.
 *
 * @param {Array<object>} matches - Priority-sorted rule matches
 * @returns {number} Confidence score between 0.0 and 0.95
 */
function calculateConfidence(matches) {
  if (matches.length === 0) return 0;
  if (matches.length === 1) return 0.95;

  // Multiple matches — check if they agree on core key
  const coreKeys = new Set(matches.map(m => m.action?.coreKey));
  if (coreKeys.size === 1) return 0.90; // All agree → high confidence

  // Conflicting matches — confidence scales with priority gap between
  // the top two candidates. Larger gap = primary is more dominant.
  const primaryPriority = matches[0].priority;
  const secondaryPriority = matches[1].priority;
  const gap = secondaryPriority - primaryPriority;

  // Base 0.70 + up to 0.15 bonus for priority gap, capped at 0.85
  return 0.70 + Math.min(gap * 0.05, 0.15);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadPackRules,
  evaluatePackRules,
  evaluateConditions,
  evaluateClause,
  getField,
  normalizeText,
};
