# UseEasy Architecture

## Overview

UseEasy is a multi-tenant email classification platform built on AWS serverless infrastructure. It processes inbound emails through a deterministic-first pipeline, using LLM validation only when the deterministic engine's confidence falls below threshold. This hybrid approach achieves 99.6% accuracy while keeping LLM costs minimal.

## Design Principles

**1. Deterministic First, LLM Second**
The Pack Engine (rule-based) handles ~80% of classifications without touching the LLM. Only ambiguous emails go to the LLM Judge, which operates in bounded-choice mode (picks from 7 labels) rather than open-ended generation.

**2. Compliance by Architecture**
UseEasy never auto-sends emails. All responses are created as drafts. PII is masked before any LLM invocation. The Bedrock proxy runs in eu-central-1 (Frankfurt) for GDPR compliance.

**3. Provider Parity**
Gmail and Outlook receive identical classification results. The label system uses internal core keys throughout the pipeline, with provider-specific rendering only at the API boundary.

**4. Domain Polymorphism**
A single codebase serves multiple business domains (e-commerce, real estate, etc.) through configuration. Domain-specific behavior is controlled by tenant metadata in PostgreSQL, not code branches.

## Infrastructure

### AWS Resources

| Resource | Service | Config |
|----------|---------|--------|
| Core API | Lambda (Node.js 20) | 512 MB, no VPC |
| Outlook Service | Lambda (Node.js 20) | 256 MB, VPC |
| Bedrock Proxy | Lambda (Node.js 20) | 512 MB, no VPC |
| API Gateway | HTTP API v2 | 46+ routes, JWT authorizer |
| Database | RDS PostgreSQL 16 | Multi-AZ, encrypted |
| Static Assets | S3 + CloudFront | Outlook Add-In icons/HTML |

### Database Schema

```
public schema:
  tenants              — Tenant registration, feature flags
  provider_credentials — OAuth tokens (Gmail, Outlook)

governance schema:
  tenants              — Domain + pack key assignments
  pack_rules           — Classification rules (JSONB conditions)
  audit_log            — Full decision traces
  tenant_spreadsheets  — Spreadsheet connections
  spreadsheet_actions_log — Spreadsheet change audit trail
  draft_templates      — Email draft templates

governance views:
  v_tenant_active_packs — Auto-appends global_core to pack lists
```

### API Routes (46+)

```
Classification:
  POST /v1/classify          — Main classification endpoint
  POST /v1/classify/status   — Check classification for a thread
  GET  /v1/classify/pending  — Pending classifications

Email Operations:
  POST /v1/gmail/label       — Apply Gmail labels
  POST /v1/gmail/draft       — Create Gmail draft
  POST /v1/outlook/label     — Set Outlook categories
  POST /v1/outlook/draft     — Create Outlook draft

Spreadsheet:
  POST /v1/spreadsheet/upload     — Upload + auto-map
  GET  /v1/dashboard/spreadsheets — List connections
  GET  /v1/spreadsheet/audit      — Audit trail
  POST /v1/spreadsheet/draft-from-template — Generate draft
  POST /v1/spreadsheet/revert     — Bulk revert

Auth:
  POST /v1/auth/start        — OAuth initiation
  GET  /v1/auth/callback      — OAuth callback
  POST /v1/auth/console-login — Console auth

Admin:
  GET  /v1/admin/tenants      — Tenant management
  POST /v1/admin/rules        — Pack rule CRUD
```

## Classification Pipeline Detail

### Gate 1: Opt-Out Check
Checks if the sender has opted out of classification. Opt-out is stored per-tenant in PostgreSQL and respected immediately.

### Gate 2: PII Masking
Before any LLM invocation, PII is pseudonymized:
- Email addresses → `[EMAIL_1]`, `[EMAIL_2]`
- Phone numbers → `[PHONE_1]`
- Names → Replaced with role identifiers
- Addresses → `[ADDRESS]`

The mapping is stored temporarily and reversed in the draft generation step.

### Gate 3: Risk Escalation
Certain patterns trigger immediate escalation to `manual_review`:
- Legal threats, lawsuit language
- High-value amounts above threshold
- Known fraud patterns
- Compliance-sensitive content

Risk escalation adds `manual_review` as a label AND resolves the category from risk flags using a priority-based mapping.

### Gate 4: Pack Engine
The deterministic rule engine evaluates conditions against the email context. Rules are stored as JSONB in PostgreSQL, supporting AND/OR/NOT logic trees with operators like `contains_any`, `regex_any`, `eq`, `exists`.

131 active rules across 3 packs:
- `ecom_core_v1` (13 rules) — E-commerce patterns
- `hv_real_estate_v1` (24 rules) — Property management
- `global_core` (1 rule) — Cross-domain patterns

### Gate 5: Confidence Gate
If the Pack Engine confidence is ≥ 0.75, the LLM is skipped entirely. This saves ~80% of LLM invocations.

### Gate 6: LLM Judge
When invoked, the LLM receives a bounded-choice prompt: "Classify this email into one of these 7 categories." It returns a structured JSON response with the chosen category and reasoning.

The LLM runs on AWS Bedrock (Claude) in eu-central-1, receiving only PII-masked content.

### Gate 7: Dual-Label Assignment
Each email gets 1-2 labels. The primary label comes from the Pack Engine or LLM Judge. A secondary label may be added from risk escalation.

Priority-based resolution ensures the most specific label wins when multiple flags are present.

### Gate 8: Provider Apply
Labels are applied via the Gmail API (as labels) or Microsoft Graph API (as categories). Domain-specific display names are resolved at this boundary via `rewriteLabelsForDomain()`.

### Gate 8.5: Spreadsheet Matching (v4.4.1)
After classification, the engine checks if the tenant has connected spreadsheets. If so, it performs multi-sheet matching using semantic column mappings, generates a diff preview, and returns UI hints for the Chrome Extension or Outlook Add-In.

### Gate 9: Draft Generation
If a matching template exists, a draft email is generated with placeholder resolution from spreadsheet data and email context. Unresolved placeholders are flagged for manual review.

### Gate 10: Need-Reply Detection
Analyzes the email to determine if a response is expected. Factors: question marks, request language, urgency indicators.

### Gate 11: Audit + Improvement
The full decision trace is logged to `governance.audit_log`. This includes: which rules matched, confidence scores, LLM reasoning (if invoked), labels applied, and timestamps.
