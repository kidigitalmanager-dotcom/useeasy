/**
 * UseEasy Spreadsheet Engine — Provider-Agnostic Abstraction Layer
 *
 * Unified interface for Google Sheets, Microsoft Graph (OneDrive/SharePoint),
 * and local Excel files. The classification pipeline interacts with spreadsheets
 * through this layer — it never knows which provider is backing the data.
 *
 * Design:
 * - Factory pattern creates the right provider from tenant config
 * - Base class defines the contract; providers implement specifics
 * - Auto-provisioning: first upload auto-detects headers + maps columns
 * - Diff preview: proposed changes shown to user before applying
 *
 * @version 4.4.1
 * @author Leon Musawu
 */

'use strict';

// ---------------------------------------------------------------------------
// Base Provider (interface contract)
// ---------------------------------------------------------------------------

class BaseSpreadsheetProvider {
  constructor(providerType) {
    this.providerType = providerType;
  }

  /**
   * Validates connection to the spreadsheet.
   * @param {object} config - Provider-specific config (sheet ID, credentials, etc.)
   * @returns {Promise<{ connected: boolean, sheetName: string }>}
   */
  async connect(config) {
    throw new Error('Not implemented: connect()');
  }

  /**
   * Retrieves column headers from the first row.
   * Used during auto-provisioning to suggest column mappings.
   * @param {object} config
   * @returns {Promise<string[]>} Array of header names
   */
  async getHeaders(config) {
    throw new Error('Not implemented: getHeaders()');
  }

  /**
   * Searches for rows matching the given criteria.
   * Uses semantic column mappings to find the right columns.
   *
   * @param {object} config - Sheet config
   * @param {object} criteria - { tenantName?, apartment?, dateRange? }
   * @param {object} mappings - Semantic field → column mappings
   * @returns {Promise<MatchResult[]>} Matched rows with scores
   */
  async findRows(config, criteria, mappings) {
    throw new Error('Not implemented: findRows()');
  }

  /**
   * Updates a single cell value.
   * @param {object} config
   * @param {number} rowIndex - 0-based row index
   * @param {string} columnRef - Column reference (A, B, C... or header name)
   * @param {*} newValue
   * @returns {Promise<{ success: boolean, previousValue: * }>}
   */
  async updateCell(config, rowIndex, columnRef, newValue) {
    throw new Error('Not implemented: updateCell()');
  }

  /**
   * Appends a new row at the end of the sheet.
   * @param {object} config
   * @param {object} rowData - { columnRef: value } pairs
   * @returns {Promise<{ success: boolean, rowIndex: number }>}
   */
  async addRow(config, rowData) {
    throw new Error('Not implemented: addRow()');
  }

  /**
   * Generates a diff preview for proposed changes.
   * Returns before/after pairs for user confirmation.
   *
   * @param {object} config
   * @param {Array<ProposedChange>} changes - [{ rowIndex, column, newValue }]
   * @returns {Promise<DiffPreview[]>} [{ row, column, before, after }]
   */
  async getDiffPreview(config, changes) {
    throw new Error('Not implemented: getDiffPreview()');
  }

  /**
   * Returns a preview of the first N rows (for UI display).
   * @param {object} config
   * @param {number} [limit=10]
   * @returns {Promise<object[]>} Array of row objects
   */
  async getPreview(config, limit = 10) {
    throw new Error('Not implemented: getPreview()');
  }
}

// ---------------------------------------------------------------------------
// Google Sheets Provider
// ---------------------------------------------------------------------------

class GoogleSheetsProvider extends BaseSpreadsheetProvider {
  constructor() {
    super('google_sheets');
  }

  /**
   * Uses Google Sheets API v4 directly (no SDK).
   * Saves ~106 MB of googleapis dependency.
   */
  async connect(config) {
    const { spreadsheetId, accessToken } = config;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

    const response = await this._fetch(url, accessToken);
    return {
      connected: true,
      sheetName: response.properties?.title || 'Unknown',
      sheetCount: response.sheets?.length || 0,
    };
  }

  async getHeaders(config) {
    const { spreadsheetId, sheetName, accessToken } = config;
    const range = `${sheetName || 'Sheet1'}!1:1`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

    const response = await this._fetch(url, accessToken);
    return response.values?.[0] || [];
  }

  async findRows(config, criteria, mappings) {
    // Fetches all rows and filters in-memory
    // For large sheets, this could be optimized with Google Sheets filter views
    const allRows = await this._getAllRows(config);
    return this._matchRows(allRows, criteria, mappings);
  }

  async updateCell(config, rowIndex, columnRef, newValue) {
    const { spreadsheetId, sheetName, accessToken } = config;
    const range = `${sheetName || 'Sheet1'}!${columnRef}${rowIndex + 2}`; // +2: header + 0-index

    // Read current value first (for audit trail)
    const currentUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const current = await this._fetch(currentUrl, accessToken);
    const previousValue = current.values?.[0]?.[0] || null;

    // Write new value
    const writeUrl = `${currentUrl}?valueInputOption=USER_ENTERED`;
    await this._fetch(writeUrl, accessToken, 'PUT', {
      range,
      values: [[newValue]],
    });

    return { success: true, previousValue };
  }

  async addRow(config, rowData) {
    const { spreadsheetId, sheetName, accessToken } = config;
    const headers = await this.getHeaders(config);

    // Map rowData keys to column positions
    const row = headers.map(header => rowData[header] || '');
    const range = `${sheetName || 'Sheet1'}!A:${String.fromCharCode(64 + headers.length)}`;

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
    const response = await this._fetch(url, accessToken, 'POST', {
      values: [row],
    });

    return {
      success: true,
      rowIndex: parseInt(response.updates?.updatedRange?.match(/\d+$/)?.[0] || '0') - 1,
    };
  }

  async getDiffPreview(config, changes) {
    const diffs = [];
    for (const change of changes) {
      const { spreadsheetId, sheetName, accessToken } = config;
      const range = `${sheetName || 'Sheet1'}!${change.column}${change.rowIndex + 2}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
      const current = await this._fetch(url, accessToken);

      diffs.push({
        row: change.rowIndex,
        column: change.column,
        before: current.values?.[0]?.[0] || '(empty)',
        after: change.newValue,
      });
    }
    return diffs;
  }

  // --- Internal helpers (HTTP, matching) omitted for brevity ---

  async _fetch(url, accessToken, method = 'GET', body = null) {
    // Native HTTPS fetch with Bearer auth
    // Implementation uses Node.js https module — no axios/node-fetch
    return {}; // Placeholder
  }

  async _getAllRows(config) { return []; }
  _matchRows(rows, criteria, mappings) { return []; }
}

// ---------------------------------------------------------------------------
// Microsoft Graph Provider (OneDrive / SharePoint)
// ---------------------------------------------------------------------------

class MicrosoftGraphProvider extends BaseSpreadsheetProvider {
  constructor() {
    super('microsoft_graph');
  }

  /**
   * Connects via Microsoft Graph API to OneDrive/SharePoint Excel files.
   * Uses the workbook session API for efficient batch operations.
   */
  async connect(config) {
    const { itemId, accessToken } = config;
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/workbook`;

    const response = await this._graphFetch(url, accessToken);
    return {
      connected: true,
      sheetName: 'Workbook',
    };
  }

  async getHeaders(config) {
    const { itemId, sheetName, accessToken } = config;
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/workbook/worksheets('${sheetName || 'Sheet1'}')/range(address='1:1')`;

    const response = await this._graphFetch(url, accessToken);
    return response.values?.[0]?.filter(Boolean) || [];
  }

  async findRows(config, criteria, mappings) {
    // Graph API: fetch used range, then filter in-memory
    const allRows = await this._getUsedRange(config);
    return this._matchRows(allRows, criteria, mappings);
  }

  async updateCell(config, rowIndex, columnRef, newValue) {
    const { itemId, sheetName, accessToken } = config;
    const cellAddress = `${columnRef}${rowIndex + 2}`;
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/workbook/worksheets('${sheetName || 'Sheet1'}')/range(address='${cellAddress}')`;

    await this._graphFetch(url, accessToken, 'PATCH', {
      values: [[newValue]],
    });

    return { success: true };
  }

  // --- Internal helpers omitted ---

  async _graphFetch(url, accessToken, method = 'GET', body = null) { return {}; }
  async _getUsedRange(config) { return []; }
  _matchRows(rows, criteria, mappings) { return []; }
}

// ---------------------------------------------------------------------------
// Local Excel Provider (xlsx library)
// ---------------------------------------------------------------------------

class LocalExcelProvider extends BaseSpreadsheetProvider {
  constructor() {
    super('local');
    this.xlsx = require('xlsx');
  }

  async connect(config) {
    const { filePath } = config;
    const workbook = this.xlsx.readFile(filePath);
    return {
      connected: true,
      sheetName: workbook.SheetNames[0],
      sheetCount: workbook.SheetNames.length,
    };
  }

  async getHeaders(config) {
    const { filePath, sheetName } = config;
    const workbook = this.xlsx.readFile(filePath);
    const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    const data = this.xlsx.utils.sheet_to_json(sheet, { header: 1 });
    return data[0] || [];
  }

  async findRows(config, criteria, mappings) {
    const { filePath, sheetName } = config;
    const workbook = this.xlsx.readFile(filePath);
    const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    const rows = this.xlsx.utils.sheet_to_json(sheet);
    return this._matchRows(rows, criteria, mappings);
  }

  _matchRows(rows, criteria, mappings) { return []; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate spreadsheet provider based on type.
 * Callers interact with the base interface — no provider-specific code needed.
 *
 * @param {string} providerType - 'google_sheets' | 'microsoft_graph' | 'local'
 * @returns {BaseSpreadsheetProvider}
 */
function createProvider(providerType) {
  switch (providerType) {
    case 'google_sheets':    return new GoogleSheetsProvider();
    case 'microsoft_graph':  return new MicrosoftGraphProvider();
    case 'local':            return new LocalExcelProvider();
    default:
      throw new Error(`Unknown spreadsheet provider: ${providerType}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-Provisioning (column mapping suggestion)
// ---------------------------------------------------------------------------

/**
 * Analyzes spreadsheet headers and suggests semantic column mappings.
 * Used during initial setup — user uploads a file, we detect what each column means.
 *
 * Semantic fields: tenant_name, apartment, date, time, status,
 *                  contractor, phone, notes, priority, cost
 *
 * @param {string[]} headers - Column header names
 * @returns {object} { [semanticField]: columnIndex }
 */
function suggestColumnMappings(headers) {
  const suggestions = {};
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim());

  const FIELD_PATTERNS = {
    tenant_name: ['mieter', 'tenant', 'name', 'bewohner', 'kunde'],
    apartment:   ['wohnung', 'apartment', 'einheit', 'unit', 'objekt'],
    date:        ['datum', 'date', 'termin', 'fällig'],
    time:        ['uhrzeit', 'time', 'zeit'],
    status:      ['status', 'zustand', 'erledigt', 'done'],
    contractor:  ['handwerker', 'firma', 'contractor', 'dienstleister'],
    phone:       ['telefon', 'phone', 'mobil', 'tel'],
    notes:       ['notiz', 'notes', 'bemerkung', 'kommentar'],
    priority:    ['priorität', 'priority', 'dringend', 'urgent'],
    cost:        ['kosten', 'cost', 'betrag', 'amount', 'preis'],
  };

  for (const [field, keywords] of Object.entries(FIELD_PATTERNS)) {
    const matchIndex = normalizedHeaders.findIndex(h =>
      keywords.some(kw => h.includes(kw))
    );
    if (matchIndex !== -1) {
      suggestions[field] = {
        columnIndex: matchIndex,
        headerName: headers[matchIndex],
        confidence: 'high',
      };
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  BaseSpreadsheetProvider,
  GoogleSheetsProvider,
  MicrosoftGraphProvider,
  LocalExcelProvider,
  createProvider,
  suggestColumnMappings,
};
