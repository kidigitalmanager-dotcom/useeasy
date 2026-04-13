# UseEasy — AI-Powered Email Classification Platform

> Automated email classification, inbox organization and draft generation for B2B SaaS — built for compliance-first environments where auto-send is not an option.

[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange)](https://aws.amazon.com/lambda/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#license)

---

## What UseEasy Does

UseEasy processes inbound emails through an **11-gate classification pipeline** that combines deterministic rule matching with LLM-based validation. Every email gets classified, labeled (Gmail / Outlook), and optionally matched against connected spreadsheets — all without ever auto-sending a response.

**Core flow:**
```
Inbound Email → PII Masking → Risk Escalation → Pack Engine (deterministic) 
    → LLM Judge (bounded choice) → Dual-Label Assignment → Provider Apply 
    → Spreadsheet Matching → Draft Generation → Audit Log
```

**Key metrics:**
- **99.6% accuracy** across 2,730 production emails (bulk test)
- **131 active pack rules** across 13 industry verticals
- **15 decision paths** with explicit routing logic
- **Sub-200ms p95 latency** for deterministic classification

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                              │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│  │  Chrome   │  │  Outlook      │  │  Console Dashboard   │  │
│  │  Ext v0.6 │  │  Add-In v1.1  │  │  (Lovable/React)     │  │
│  └─────┬─────┘  └──────┬────────┘  └──────────┬───────────┘  │
└────────┼───────────────┼──────────────────────┼──────────────┘
         │               │                      │
         ▼               ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│              API Gateway (api.useeasy.ai)                   │
│              46+ Routes · JWT Auth · Rate Limiting           │
└─────────────────────┬───────────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│ Core Lambda  │ │ Outlook  │ │ Bedrock      │
│ v4.4.1       │ │ Service  │ │ Proxy        │
│ Node.js 20   │ │ v1.3.0   │ │ (Claude)     │
│ 7,859 lines  │ │ Graph API│ │ eu-central-1 │
└──────┬───────┘ └────┬─────┘ └──────┬───────┘
       │              │              │
       ▼              ▼              │
┌─────────────────────────────┐     │
│  PostgreSQL 16 (RDS)        │     │
│  ┌─────────┐ ┌────────────┐ │     │
│  │ public   │ │ governance │ │◄────┘
│  │ tenants  │ │ pack_rules │ │  PII-minimized
│  │ creds    │ │ audit_log  │ │  prompts only
│  └─────────┘ └────────────┘ │
└─────────────────────────────┘
```

### Classification Pipeline (11 Gates)

```
Gate 1:  Opt-Out Check          → Skip if sender opted out
Gate 2:  PII Masking            → Pseudonymize before LLM
Gate 3:  Risk Escalation        → Flag high-risk patterns
Gate 4:  Pack Engine             → Deterministic rule matching (131 rules)
Gate 5:  Confidence Gate         → Route to LLM if confidence < 0.75
Gate 6:  LLM Judge               → Bounded choice (not open-ended generation)
Gate 7:  Dual-Label Assignment   → Max 2 labels, priority-based resolution
Gate 8:  Provider Apply          → Gmail Labels / Outlook Categories
Gate 8.5: Spreadsheet Matching   → Multi-sheet lookup + diff preview
Gate 9:  Draft Generation        → Template-based with placeholder resolution
Gate 10: Need-Reply Detection    → Determines if response is needed
Gate 11: Audit + Improvement     → Full decision trace logged
```

### Multi-Tenant Domain Architecture

```
┌──────────────────────────────────────────────┐
│           Tenant Resolution                   │
│                                               │
│  tenant_id ──► governance.tenants             │
│                  ├── domain (13 verticals)     │
│                  └── active_pack_keys []       │
│                                               │
│  domain ──► Pack Rules loaded                 │
│         ──► Label display names               │
│         ──► Draft templates available          │
│         ──► Spreadsheet column semantics       │
└──────────────────────────────────────────────┘

Example: Same core key, different display:
  billing_payment → "Rechnung & Zahlung"     (e-commerce)
  billing_payment → "Abrechnung & Zahlung"   (real estate)
```

---

## Technical Highlights

### 1. Deterministic + LLM Hybrid Classification

The Pack Engine evaluates rules deterministically first. The LLM is only invoked when confidence is below threshold — reducing cost and latency by ~80% compared to LLM-only approaches.

```javascript
// Simplified pack engine clause evaluation
function evaluateClause(context, clause) {
  const fieldValue = getField(context, clause.field);
  switch (clause.operator) {
    case 'exists':      return fieldValue != null;
    case 'eq':          return normalize(fieldValue) === normalize(clause.value);
    case 'contains_any': return clause.values.some(v => text.includes(v));
    case 'regex_any':    return clause.patterns.some(p => new RegExp(p, 'i').test(fieldValue));
  }
}

// Recursive AND/OR/NOT condition tree
function evaluateConditions(context, condition) {
  if (condition.not) return !evaluateConditions(context, condition.not);
  if (condition.all) return condition.all.every(c => evaluateConditions(context, c));
  if (condition.any) return condition.any.some(c => evaluateConditions(context, c));
  return evaluateClause(context, condition);
}
```

### 2. Domain-Aware Label Polymorphism

Labels are stored as immutable core keys internally. Display names are resolved at the final API call — enabling multi-domain SaaS without code duplication.

```javascript
// Internal pipeline always uses core keys
const CORE_KEYS = [
  'billing_payment', 'request_order', 'contract_legal',
  'support_issue', 'status_fulfillment', 'returns_refund', 'manual_review'
];

// Display rewrite happens ONLY at the Gmail/Outlook API boundary
function rewriteLabelsForDomain(labels, tenantDomain) {
  if (!tenantDomain) return labels; // Backwards compatible
  const domainMap = DOMAIN_LABEL_DISPLAY[tenantDomain];
  if (!domainMap) return labels;
  return labels.map(label => domainMap[label] || label);
}
```

### 3. Provider-Agnostic Spreadsheet Engine

A unified abstraction layer supports Google Sheets, Microsoft Graph (OneDrive/SharePoint), and local Excel files through a single interface.

```javascript
class SpreadsheetProvider {
  // Factory method — caller doesn't know which provider is used
  static create(providerType) {
    switch (providerType) {
      case 'google_sheets':    return new GoogleSheetsProvider();
      case 'microsoft_graph':  return new MicrosoftGraphProvider();
      case 'local':            return new LocalExcelProvider();
    }
  }

  // Unified interface for all providers
  async findRows(config, criteria, columnMappings) { /* ... */ }
  async updateCell(config, rowIndex, columnRef, newValue) { /* ... */ }
  async addRow(config, rowData) { /* ... */ }
  async getHeaders(config) { /* ... */ }
  async getDiffPreview(config, proposedChanges) { /* ... */ }
}
```

### 4. Production JWT Verification

Dual-algorithm JWT verification with JWKS caching, timing-safe comparison, and automatic key rotation.

```javascript
async function verifyJWT(token) {
  const header = decodeHeader(token);

  if (header.alg === 'ES256') {
    // ECDSA P-256 — verify against cached JWKS public keys
    const jwks = await getCachedJWKS(); // 10-minute TTL
    const key = crypto.createPublicKey({ key: jwks[header.kid], format: 'jwk' });
    return crypto.createVerify('SHA256')
      .update(signedContent)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
  }

  if (header.alg === 'HS256') {
    // HMAC fallback — timing-safe comparison
    const expected = crypto.createHmac('sha256', secret).update(signedContent).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'base64url'));
  }
}
```

### 5. Chrome Extension (Manifest V3)

Two-process architecture: content script reads Gmail DOM, service worker proxies API calls.

```javascript
// Content Script — reads Gmail context, no network access
function detectEmailContext() {
  const subject = document.querySelector('h2[data-thread-perm-id]')?.textContent;
  const sender = document.querySelector('[email]')?.getAttribute('email');
  return { subject, sender, threadId: extractThreadId() };
}

// Service Worker — handles cross-origin API calls
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'API_FETCH') {
    fetch(msg.url, msg.options)
      .then(res => res.json())
      .then(data => sendResponse({ ok: true, data }));
    return true; // Keep channel open for async response
  }
});
```

### 6. Outlook Integration (Microsoft Graph)

Native HTTPS calls to Graph API — no SDK dependency. Read-then-merge pattern for category accumulation.

```javascript
// Category accumulation: never overwrites, always merges
async function setCategories(accessToken, messageId, newCategories) {
  // Step 1: Read existing categories
  const existing = await getMessage(accessToken, messageId, ['categories']);

  // Step 2: Merge (deduplicate)
  const merged = [...new Set([...existing.categories, ...newCategories])];

  // Step 3: PATCH with full set
  return patchMessage(accessToken, messageId, { categories: merged });
}
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Runtime** | Node.js 20 on AWS Lambda | Cold start < 300ms, native crypto |
| **Database** | PostgreSQL 16 (RDS) | JSONB for rule conditions, row-level security |
| **LLM** | AWS Bedrock (Claude) in eu-central-1 | GDPR-compliant, PII stays in Frankfurt |
| **Auth** | Supabase JWT + Google/Azure OAuth | ES256 + HS256 dual verification |
| **Email** | Gmail API + Microsoft Graph | Dual-provider parity |
| **Orchestration** | n8n (migrating to native AWS) | Visual workflow debugging |
| **Browser** | Chrome Extension MV3 | Service worker + content script |
| **Frontend** | React (Lovable) | Admin console + settings |
| **Payments** | Stripe | Checkout sessions + webhooks |

### Minimal Dependencies (Core Lambda)

The core Lambda has only 3 runtime dependencies:
- `pg` — PostgreSQL client
- `@aws-sdk/client-bedrock-runtime` — LLM invocation
- `xlsx` — Spreadsheet parsing

No Express. No frameworks. Pure Lambda handler.

---

## Domain Coverage (13 Industry Verticals)

UseEasy ships with pack rules for 12 industry verticals plus a global cross-domain pack. Each vertical has domain-specific classification rules, label names, and draft templates. New verticals can be added through configuration — no code changes required.

### Configured Verticals

| Vertical | Pack Key | Focus Areas |
|----------|----------|-------------|
| **E-Commerce** | `ecom_core_v1` | Invoices, returns, order confirmations, delivery, support tickets |
| **Real Estate** | `real_estate_core_v1` | Utility billing, rent, maintenance, lease management, tenant inquiries |
| **Logistics** | `logistics_core_v1` | Shipping, tracking, warehouse, delivery scheduling |
| **B2B Sales** | `b2b_sales_core_v1` | Quotes, proposals, contract negotiation, pipeline |
| **Coaching** | `coaching_core_v1` | Bookings, session management, client communication |
| **Hotel** | `hotel_core_v1` | Reservations, guest requests, check-in/out, billing |
| **Telecom** | `telecom_core_v1` | Service orders, outages, billing disputes, contracts |
| **Education** | `education_core_v1` | Enrollment, course admin, student inquiries, certificates |
| **Manufacturing** | `manufacturing_core_v1` | Purchase orders, quality, supply chain, maintenance |
| **Marketing** | `marketing_core_v1` | Campaign management, client reporting, brief handling |
| **Finance** | `finanzen_core_v1` | Transactions, compliance, account management, audits |
| **Energy** | `energie_core_v1` | Meter readings, tariff changes, grid inquiries, billing |
| **Global** | `global_core_v1` | Cross-domain patterns (included in all verticals) |

---

## Testing

- **Gmail E2E:** 20 test emails → 26 expected actions → 100% pass rate
- **Outlook E2E:** 20 test emails → 77 actions → 8 master categories → 100% pass rate
- **HV (Real Estate) E2E:** 20 domain-specific emails → full classification validation
- **Bulk Test:** 2,730 production emails → 99.6% accuracy

---

## Repository Structure

```
useeasy/
├── README.md                          # This file
├── docs/
│   ├── ARCHITECTURE.md                # Deep-dive system design
│   ├── CLASSIFICATION_PIPELINE.md     # 11-gate pipeline documentation
│   ├── MULTI_TENANT_DESIGN.md         # Domain-aware architecture
│   └── SPREADSHEET_ENGINE.md          # Provider-agnostic design
├── src/
│   ├── core/                          # Core classification engine (sanitized)
│   │   ├── pack-engine.js             # Deterministic rule evaluator
│   │   ├── label-policy.js            # Domain-aware label resolution
│   │   └── jwt-verify.js             # Dual-algorithm JWT verification
│   ├── outlook-service/               # Microsoft Graph integration
│   │   ├── graph-client.js            # Native HTTPS Graph API client
│   │   └── category-manager.js        # Read-then-merge categories
│   ├── spreadsheet-engine/            # Provider-agnostic spreadsheet layer
│   │   ├── provider-factory.js        # Factory pattern + base interface
│   │   └── template-engine.js         # Draft generation with placeholders
│   └── chrome-extension/              # Gmail integration (MV3)
│       ├── content-script.js          # DOM reader + UI injection
│       └── service-worker.js          # API proxy bridge
└── diagrams/
    ├── system-overview.mermaid        # High-level architecture
    ├── classification-flow.mermaid    # Pipeline flow
    └── domain-architecture.mermaid    # Multi-tenant design
```

---

## About

Built by **Leon Musawu** as a solo founder/operator — from system design to production deployment.

This repository contains sanitized code samples and architecture documentation. The full production system includes additional business logic, pack rules, and integrations not shown here.

---

## License

This project is proprietary. Code samples are provided for portfolio/demonstration purposes only. Not licensed for commercial use or redistribution.
