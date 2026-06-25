# UseEasy COS

> Communication Operating System for inbound and outbound business communication. UseEasy reads, classifies, drafts and (under gated autonomy) acts on email and voice, connected to the back office systems where the work actually lives. Built for compliance first environments where auto-send is not an option.

[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange)](https://aws.amazon.com/lambda/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)](https://www.postgresql.org/)
[![EU hosted](https://img.shields.io/badge/Hosting-eu--central--1-blueviolet)](#)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#license)

---

## What UseEasy COS does

UseEasy is not a chatbot bolted onto an inbox. It is one layer that understands every message, decides what should happen, and can act on it under autonomy you can trust. It works across three surfaces:

**1. Email.** Every inbound message runs through an 11 gate classification pipeline that combines deterministic rule matching with bounded LLM validation. Each email is classified, labeled (Gmail and Outlook), optionally matched against connected spreadsheets, and turned into a draft, without ever auto-sending a response.

**2. Voice.** Jana, an integrated voice agent running on the same decision logic: multi-step calls, multi-agent routing, recording consent and human hand-off.

**3. Action.** Connectivity into the back office systems where the work lives (CRM, ERP, spreadsheets), with structured write-back into Excel and SharePoint, diff preview and a full audit trail.

**Key metrics:**

- **99.6% accuracy** in the core vertical and 90%+ across the others, validated on **27,000+ production emails**
- **190+ active classification rules** across 13 industry verticals
- **15 explicit decision paths** with deterministic routing
- **Sub-200ms p95 latency** for deterministic classification

---

## Graduated, gated autonomy (the hard part)

The differentiator is not the drafting, it is making autonomy safe. Every workflow moves through three stages and has to earn each one:

- **Shadow:** the engine observes and proposes, and sends nothing.
- **Assisted:** the engine prepares drafts for human approval.
- **Autonomous:** scoped, repetitive cases only, after clearing hard statistical gates (>= 400 samples, < 5% shadow mismatch, < 10% edit rate).

Sensitive categories (invoices, contracts, complaints) are hard-locked from ever auto-sending. Every message is pseudonymized and PII minimized before it reaches an LLM, with inference kept in Frankfurt (eu-central-1) and full audit logging. In a market full of reckless "AI agents", provable safety is what wins regulated buyers.

```
// Promotion gate: a workflow only reaches a higher autonomy tier when it earns it
function canPromote(stats) {
  return stats.sampleCount      >= 400    // enough evidence
      && stats.shadowMismatch    < 0.05   // engine agreed with humans
      && stats.editRate          < 0.10   // humans barely edited the drafts
      && !HARD_LOCKED.has(stats.category); // never invoices, contracts, complaints
}
```

---

## Architecture

```
        Chrome Extension        Outlook Add-In        Console (React)
               |                      |                     |
               +----------------------+---------------------+
                                      |
                        API Gateway (api.useeasy.ai)
                        JWT auth, rate limiting, 46+ routes
                                      |
        +-----------------------------+-----------------------------+
        |                |                 |                        |
   Core Lambda      Outlook Service    Voice (jana-bridge)     Bedrock Proxy
   Node.js 20       Microsoft Graph    VAPI + Twilio           Claude, eu-central-1
        |                |                 |                        |
        +----------------+--------+--------+------------------------+
                                  |
                       PostgreSQL 16 (RDS)
                  public.tenants  |  governance.pack_rules
                  credentials     |  governance.audit_log
                  (PII minimized prompts only)
```

### Classification pipeline (11 gates)

```
Gate 1   Opt-Out Check         Skip if sender opted out
Gate 2   PII Masking           Pseudonymize before the LLM
Gate 3   Risk Escalation       Flag high risk patterns
Gate 4   Pack Engine           Deterministic rule matching (190+ rules)
Gate 5   Confidence Gate       Route to the LLM only if confidence < 0.75
Gate 6   LLM Judge             Bounded choice, not open ended generation
Gate 7   Dual-Label Assignment Max 2 labels, priority based resolution
Gate 8   Provider Apply        Gmail Labels / Outlook Categories
Gate 8.5 Spreadsheet Matching  Multi sheet lookup and diff preview
Gate 9   Draft Generation      Template based with placeholder resolution
Gate 10  Need-Reply Detection  Decide whether a response is needed
Gate 11  Audit and Improvement Full decision trace logged
```

### Multi-tenant domain architecture

Labels are stored as immutable core keys internally. Display names are resolved at the final API call, which enables multi-domain SaaS without code duplication.

```
Same core key, different display per domain:
  billing_payment  ->  "Rechnung & Zahlung"     (e-commerce)
  billing_payment  ->  "Abrechnung & Zahlung"   (real estate)
  support_issue    ->  "Support & Störung"      (e-commerce)
  support_issue    ->  "Mängelmeldung & Reparatur" (real estate)
```

---

## Technical highlights

### 1. Deterministic plus LLM hybrid classification

The Pack Engine evaluates rules deterministically first. The LLM is only invoked when confidence is below threshold, which reduces cost and latency by roughly 80% compared to LLM only approaches.

```
// Recursive AND / OR / NOT condition tree
function evaluateConditions(context, condition) {
  if (condition.not) return !evaluateConditions(context, condition.not);
  if (condition.all) return condition.all.every(c => evaluateConditions(context, c));
  if (condition.any) return condition.any.some(c => evaluateConditions(context, c));
  return evaluateClause(context, condition);
}
```

### 2. Domain-aware label polymorphism

Internal pipeline always uses core keys. The display rewrite happens only at the Gmail / Outlook API boundary.

```
function rewriteLabelsForDomain(labels, tenantDomain) {
  if (!tenantDomain) return labels;            // backwards compatible
  const domainMap = DOMAIN_LABEL_DISPLAY[tenantDomain];
  if (!domainMap) return labels;
  return labels.map(label => domainMap[label] || label);
}
```

### 3. Provider-agnostic spreadsheet engine

A unified abstraction layer supports Google Sheets, Microsoft Graph (OneDrive / SharePoint) and local Excel files through a single interface.

```
class SpreadsheetProvider {
  static create(providerType) {
    switch (providerType) {
      case 'google_sheets':    return new GoogleSheetsProvider();
      case 'microsoft_graph':  return new MicrosoftGraphProvider();
      case 'local':            return new LocalExcelProvider();
    }
  }
  async findRows(config, criteria, columnMappings) { /* ... */ }
  async updateCell(config, rowIndex, columnRef, newValue) { /* ... */ }
  async getDiffPreview(config, proposedChanges) { /* ... */ }
}
```

### 4. Production JWT verification

Dual algorithm JWT verification with JWKS caching, timing safe comparison and automatic key rotation.

```
async function verifyJWT(token) {
  const header = decodeHeader(token);
  if (header.alg === 'ES256') {                 // ECDSA P-256 against cached JWKS
    const jwks = await getCachedJWKS();         // 10 minute TTL
    const key = crypto.createPublicKey({ key: jwks[header.kid], format: 'jwk' });
    return crypto.createVerify('SHA256').update(signedContent)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  if (header.alg === 'HS256') {                 // HMAC fallback, timing safe
    const expected = crypto.createHmac('sha256', secret).update(signedContent).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'base64url'));
  }
}
```

### 5. Outlook integration (Microsoft Graph)

Native HTTPS calls to the Graph API, no SDK dependency. A read then merge pattern accumulates categories instead of overwriting them.

```
async function setCategories(accessToken, messageId, newCategories) {
  const existing = await getMessage(accessToken, messageId, ['categories']);
  const merged = [...new Set([...existing.categories, ...newCategories])];
  return patchMessage(accessToken, messageId, { categories: merged });
}
```

---

## Tech stack

| Layer | Technology | Why |
| --- | --- | --- |
| Runtime | Node.js 20 on AWS Lambda | cold start < 300ms, native crypto |
| Database | PostgreSQL 16 (RDS) | JSONB rule conditions, tenant isolation |
| LLM | AWS Bedrock (Claude), eu-central-1 | GDPR compliant, PII stays in Frankfurt |
| Auth | Supabase JWT + Google / Azure OAuth | ES256 and HS256 dual verification |
| Email | Gmail API + Microsoft Graph | dual provider parity |
| Voice | VAPI + Twilio + jana-bridge | multi-agent call routing and hand-off |
| CRM / ERP | HubSpot OAuth + Microsoft Graph | back office write-back |
| Orchestration | Native AWS (EventBridge + Lambda) | event driven, no external workflow engine |
| Browser | Chrome Extension MV3 | service worker plus content script |
| Frontend | React (Lovable) | admin console and settings |
| Payments | Stripe | checkout sessions and webhooks |

The core Lambda has only three runtime dependencies: `pg`, `@aws-sdk/client-bedrock-runtime` and a spreadsheet parser. No Express, no frameworks, a pure Lambda handler.

---

## Domain coverage (13 industry verticals)

UseEasy ships with pack rules for 12 industry verticals plus a global cross-domain pack. Each vertical has its own classification rules, label names and draft templates. New verticals are added through configuration, no code changes required.

| Vertical | Pack key | Focus areas |
| --- | --- | --- |
| E-Commerce | `ecom_core_v1` | invoices, returns, order confirmations, delivery, support |
| Real Estate | `real_estate_core_v1` | utility billing, rent, maintenance, lease, tenant inquiries |
| Logistics | `logistics_core_v1` | shipping, tracking, warehouse, scheduling |
| B2B Sales | `b2b_sales_core_v1` | quotes, proposals, negotiation, pipeline |
| Coaching | `coaching_core_v1` | bookings, session management, client communication |
| Hotel | `hotel_core_v1` | reservations, guest requests, check-in / out, billing |
| Telecom | `telecom_core_v1` | service orders, outages, billing disputes, contracts |
| Education | `education_core_v1` | enrollment, course admin, student inquiries |
| Manufacturing | `manufacturing_core_v1` | purchase orders, quality, supply chain |
| Marketing | `marketing_core_v1` | campaigns, client reporting, briefs |
| Finance | `finanzen_core_v1` | transactions, compliance, account management |
| Energy | `energie_core_v1` | meter readings, tariff changes, grid inquiries |
| Global | `global_core_v1` | cross-domain patterns, included in all verticals |

---

## Testing

- **Gmail E2E:** 20 test emails, 26 expected actions, 100% pass rate
- **Outlook E2E:** 20 test emails, 77 actions, 8 master categories, 100% pass rate
- **Real estate E2E:** 20 domain specific emails, full classification validation
- **Bulk test:** 27,000+ production emails, 99.6% accuracy in the core vertical, 90%+ across the others

---

## About

Built by **Leon Musawu** as a solo founder and operator, from system design to production deployment on AWS.

This repository contains sanitized code samples and architecture documentation. The full production system includes additional business logic, pack rules, voice flows and integrations that are not shown here.

## Also building

UseEasy COS is one of two products I am building solo. The other is the **[Bauwesen-Engine](https://github.com/kidigitalmanager-dotcom/bauwesen-engine)**, a deterministic structural pre-dimensioning engine for construction (Eurocode timber and steel, German National Annex).

## License

Proprietary. Code samples are provided for portfolio and demonstration purposes only. Not licensed for commercial use or redistribution.
