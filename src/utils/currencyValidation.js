'use strict';

/**
 * Keep in sync with frontend currencyUtils: all ISO 4217 codes from Intl.
 */

function listIsoCurrencyCodes() {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('currency');
    }
  } catch {
    // fall through
  }
  return [
    'PKR',
    'USD',
    'EUR',
    'GBP',
    'AED',
    'SAR',
    'INR',
    'BDT',
    'CNY',
    'JPY',
    'AUD',
    'CAD',
    'NZD',
    'SGD',
    'MYR',
    'TRY',
    'QAR',
    'OMR',
    'KWD',
    'BHD',
    'CHF',
    'MXN',
    'HKD',
    'KRW',
    'THB',
    'IDR',
    'PHP',
    'VND',
    'ZAR',
    'NOK',
    'SEK',
    'DKK',
    'PLN',
    'BRL',
  ];
}

const SUPPORTED_CURRENCY_CODES = Object.freeze(listIsoCurrencyCodes());
const SUPPORTED_CURRENCY_CODE_SET = new Set(SUPPORTED_CURRENCY_CODES);

const CURRENCY_VALIDATION_MESSAGES = Object.freeze({
  required: 'Currency is required.',
  invalidFormat: 'Currency must be a valid 3-letter ISO currency code.',
  unsupported: 'Unsupported currency. Please select a valid currency.',
});

function normalizeCurrencyCode(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

function isSupportedCurrencyCode(value) {
  return SUPPORTED_CURRENCY_CODE_SET.has(normalizeCurrencyCode(value));
}

/**
 * Validate and normalize a currency code against ISO 4217 allowlist.
 *
 * @param {unknown} currency
 * @param {{ required?: boolean }} [options]
 * @returns {{ valid: boolean, value: string | null, error: string | null }}
 */
function validateCurrency(currency, options = {}) {
  const required = options.required !== false;

  if (currency === undefined || currency === null || String(currency).trim() === '') {
    if (required) {
      return {
        valid: false,
        value: null,
        error: CURRENCY_VALIDATION_MESSAGES.required,
      };
    }
    return { valid: true, value: null, error: null };
  }

  const value = normalizeCurrencyCode(currency);

  if (!/^[A-Z]{3}$/.test(value)) {
    return {
      valid: false,
      value: null,
      error: CURRENCY_VALIDATION_MESSAGES.invalidFormat,
    };
  }

  if (!isSupportedCurrencyCode(value)) {
    return {
      valid: false,
      value: null,
      error: CURRENCY_VALIDATION_MESSAGES.unsupported,
    };
  }

  return { valid: true, value, error: null };
}

module.exports = {
  SUPPORTED_CURRENCY_CODES,
  CURRENCY_VALIDATION_MESSAGES,
  normalizeCurrencyCode,
  isSupportedCurrencyCode,
  validateCurrency,
};
