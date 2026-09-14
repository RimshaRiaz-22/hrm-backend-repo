'use strict';

const IBAN = require('iban');

/** Default account number length bounds (digits only). */
const ACCOUNT_NUMBER_MIN_LENGTH = 8;
const ACCOUNT_NUMBER_MAX_LENGTH = 20;

/** When true, only Pakistan IBANs (starting with PK) are accepted. */
const BANK_IBAN_PAKISTAN_ONLY = false;

const BANK_VALIDATION_MESSAGES = Object.freeze({
  accountNumberRequired: 'Account number is required.',
  accountNumberDigitsOnly: 'Account number must contain digits only.',
  accountNumberTooShort: (min) => `Account number must be at least ${min} digits.`,
  accountNumberTooLong: (max) => `Account number must be at most ${max} digits.`,
  ibanInvalid: 'Please enter a valid IBAN.',
  ibanPakistanOnly: 'Only Pakistan IBANs (starting with PK) are accepted.',
});

function normalizeAccountNumberInput(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function normalizeIbanInput(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * @param {unknown} accountNumber
 * @param {{
 *   required?: boolean,
 *   minLength?: number,
 *   maxLength?: number,
 * }} [options]
 * @returns {{ valid: boolean, value: string | null, error: string | null }}
 */
function validateAccountNumber(accountNumber, options = {}) {
  const required = options.required !== false;
  const minLength = Number.isInteger(options.minLength)
    ? options.minLength
    : ACCOUNT_NUMBER_MIN_LENGTH;
  const maxLength = Number.isInteger(options.maxLength)
    ? options.maxLength
    : ACCOUNT_NUMBER_MAX_LENGTH;

  const raw = normalizeAccountNumberInput(accountNumber);
  if (!raw) {
    if (required) {
      return { valid: false, value: null, error: BANK_VALIDATION_MESSAGES.accountNumberRequired };
    }
    return { valid: true, value: null, error: null };
  }

  if (!/^\d+$/.test(raw)) {
    return {
      valid: false,
      value: null,
      error: BANK_VALIDATION_MESSAGES.accountNumberDigitsOnly,
    };
  }

  if (raw.length < minLength) {
    return {
      valid: false,
      value: null,
      error: BANK_VALIDATION_MESSAGES.accountNumberTooShort(minLength),
    };
  }

  if (raw.length > maxLength) {
    return {
      valid: false,
      value: null,
      error: BANK_VALIDATION_MESSAGES.accountNumberTooLong(maxLength),
    };
  }

  return { valid: true, value: raw, error: null };
}

/**
 * @param {unknown} iban
 * @param {{ required?: boolean, pakistanOnly?: boolean }} [options]
 * @returns {{ valid: boolean, value: string | null, error: string | null }}
 */
function validateIban(iban, options = {}) {
  const required = Boolean(options.required);
  const pakistanOnly =
    options.pakistanOnly === undefined ? BANK_IBAN_PAKISTAN_ONLY : Boolean(options.pakistanOnly);

  const raw = normalizeIbanInput(iban);
  if (!raw) {
    if (required) {
      return { valid: false, value: null, error: BANK_VALIDATION_MESSAGES.ibanInvalid };
    }
    return { valid: true, value: null, error: null };
  }

  const electronic = IBAN.electronicFormat(raw);

  // IBAN format validation disabled — any value is accepted.
  // if (pakistanOnly && !electronic.startsWith('PK')) {
  //   return {
  //     valid: false,
  //     value: null,
  //     error: BANK_VALIDATION_MESSAGES.ibanPakistanOnly,
  //   };
  // }

  // if (!IBAN.isValid(electronic)) {
  //   return {
  //     valid: false,
  //     value: null,
  //     error: BANK_VALIDATION_MESSAGES.ibanInvalid,
  //   };
  // }

  return { valid: true, value: electronic, error: null };
}

module.exports = {
  ACCOUNT_NUMBER_MIN_LENGTH,
  ACCOUNT_NUMBER_MAX_LENGTH,
  BANK_IBAN_PAKISTAN_ONLY,
  BANK_VALIDATION_MESSAGES,
  normalizeAccountNumberInput,
  normalizeIbanInput,
  validateAccountNumber,
  validateIban,
};
