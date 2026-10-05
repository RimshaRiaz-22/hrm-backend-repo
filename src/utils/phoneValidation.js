'use strict';

const {
  parsePhoneNumberFromString,
  isValidPhoneNumber,
  isPossiblePhoneNumber,
  validatePhoneNumberLength,
} = require('libphonenumber-js');

/**
 * Normalize free-text / partial input into a parseable international candidate.
 * Relies on libphonenumber-js for country rules — no hardcoded lengths or codes.
 */
function toParseCandidate(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  // Digits-only values from phone widgets are treated as international when prefixed with +.
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}

function resolveCountryLabel(country) {
  return country ? String(country).toUpperCase() : 'the selected country';

}

/**
 * Validate a phone number with libphonenumber-js (E.164).
 *
 * @param {unknown} input
 * @param {{ defaultCountry?: string, required?: boolean, fieldName?: string }} [options]
 * @returns {{
 *   ok: boolean,
 *   status: 'empty'|'incomplete'|'invalid'|'valid',
 *   e164: string|null,
 *   country: string|null,
 *   nationalNumber: string|null,
 *   error: string|null,
 *   lengthError: string|null,
 * }}
 */
function validatePhoneNumber(input, options = {}) {
  const required = options.required !== false;
  const fieldName = options.fieldName || 'phone number';
  const defaultCountry = options.defaultCountry
    ? String(options.defaultCountry).trim().toUpperCase()
    : undefined;

  const candidate = toParseCandidate(input);
  if (!candidate) {
    if (required) {
      return {
        ok: false,
        status: 'empty',
        e164: null,
        country: null,
        nationalNumber: null,
        error: `${fieldName} is required.`,
        lengthError: null,
      };
    }
    return {
      ok: true,
      status: 'empty',
      e164: null,
      country: null,
      nationalNumber: null,
      error: null,
      lengthError: null,
    };
  }

  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  const country = parsed?.country || defaultCountry || null;
  const countryLabel = resolveCountryLabel(country);
  const lengthError = validatePhoneNumberLength(candidate, defaultCountry) || null;

  if (lengthError === 'TOO_SHORT') {
    return {
      ok: false,
      status: 'incomplete',
      e164: parsed?.number || null,
      country,
      nationalNumber: parsed?.nationalNumber || null,
      error: `${fieldName} is too short for ${countryLabel}.`,
      lengthError,
    };
  }
  if (lengthError === 'TOO_LONG') {
    return {
      ok: false,
      status: 'invalid',
      e164: parsed?.number || null,
      country,
      nationalNumber: parsed?.nationalNumber || null,
      error: `${fieldName} is too long for ${countryLabel}.`,
      lengthError,
    };
  }
  if (lengthError === 'INVALID_LENGTH') {
    return {
      ok: false,
      status: 'invalid',
      e164: parsed?.number || null,
      country,
      nationalNumber: parsed?.nationalNumber || null,
      error: `${fieldName} length is invalid for ${countryLabel}.`,
      lengthError,
    };
  }
  if (lengthError === 'NOT_A_NUMBER') {
    return {
      ok: false,
      status: 'invalid',
      e164: null,
      country,
      nationalNumber: null,
      error: `Please enter a valid ${fieldName}.`,
      lengthError,
    };
  }

  const possible = defaultCountry
    ? isPossiblePhoneNumber(candidate, defaultCountry)
    : isPossiblePhoneNumber(candidate);
  const valid = defaultCountry
    ? isValidPhoneNumber(candidate, defaultCountry)
    : isValidPhoneNumber(candidate);

  if (!possible || !valid || !parsed?.number) {
    return {
      ok: false,
      status: 'invalid',
      e164: parsed?.number || null,
      country,
      nationalNumber: parsed?.nationalNumber || null,
      error: `Please enter a valid ${fieldName} for ${countryLabel}.`,
      lengthError: null,
    };
  }

  return {
    ok: true,
    status: 'valid',
    e164: parsed.number,
    country: parsed.country || country,
    nationalNumber: parsed.nationalNumber || null,
    error: null,
    lengthError: null,
  };
}

/**
 * Convert input to E.164 when valid; otherwise return null.
 */
function normalizeToE164(input, options = {}) {
  const result = validatePhoneNumber(input, { ...options, required: false });
  if (!result.ok || result.status === 'empty') return null;
  return result.e164;
}

/**
 * Require a valid E.164 phone and return it, or an error message.
 */
function requireE164(input, options = {}) {
  const result = validatePhoneNumber(input, { ...options, required: true });
  if (!result.ok) {
    return { error: result.error, e164: null, country: result.country };
  }
  return { error: null, e164: result.e164, country: result.country };
}

module.exports = {
  validatePhoneNumber,
  normalizeToE164,
  requireE164,
  toParseCandidate,
};
