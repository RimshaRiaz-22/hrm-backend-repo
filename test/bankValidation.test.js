'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAccountNumber,
  validateIban,
  BANK_VALIDATION_MESSAGES,
} = require('../src/utils/bankValidation');

describe('validateAccountNumber', () => {
  it('requires a value when required=true', () => {
    const result = validateAccountNumber('', { required: true });
    assert.equal(result.valid, false);
    assert.equal(result.error, BANK_VALIDATION_MESSAGES.accountNumberRequired);
  });

  it('accepts digits within default 8–20 length', () => {
    const result = validateAccountNumber('12345678');
    assert.equal(result.valid, true);
    assert.equal(result.value, '12345678');
  });

  it('strips spaces and rejects non-digits', () => {
    assert.equal(validateAccountNumber('12 345 678').valid, true);
    assert.equal(validateAccountNumber('12 345 678').value, '12345678');
    assert.equal(
      validateAccountNumber('12345ABC').error,
      BANK_VALIDATION_MESSAGES.accountNumberDigitsOnly
    );
    assert.equal(
      validateAccountNumber('1234-5678').error,
      BANK_VALIDATION_MESSAGES.accountNumberDigitsOnly
    );
  });

  it('rejects too short and too long account numbers', () => {
    assert.match(validateAccountNumber('1234567').error, /at least 8/i);
    assert.match(validateAccountNumber('1'.repeat(21)).error, /at most 20/i);
  });

  it('supports configurable length bounds', () => {
    const shortOk = validateAccountNumber('12345', { minLength: 5, maxLength: 10 });
    assert.equal(shortOk.valid, true);
    const tooLong = validateAccountNumber('12345678901', { minLength: 5, maxLength: 10 });
    assert.match(tooLong.error, /at most 10/i);
  });
});

describe('validateIban', () => {
  it('allows empty optional IBAN', () => {
    const result = validateIban('', { required: false });
    assert.equal(result.valid, true);
    assert.equal(result.value, null);
  });

  it('normalizes spaces/case and accepts a valid Pakistan IBAN', () => {
    const result = validateIban('pk36 scbl 0000001123456702');
    assert.equal(result.valid, true);
    assert.equal(result.value, 'PK36SCBL0000001123456702');
  });

  it('rejects invalid checksum / format', () => {
    const result = validateIban('PK00SCBL0000001123456702');
    assert.equal(result.valid, false);
    assert.equal(result.error, BANK_VALIDATION_MESSAGES.ibanInvalid);
  });

  it('accepts valid non-Pakistan IBANs by default', () => {
    const result = validateIban('DE89370400440532013000');
    assert.equal(result.valid, true);
    assert.equal(result.value, 'DE89370400440532013000');
  });

  it('can still restrict to Pakistan when pakistanOnly is enabled', () => {
    const result = validateIban('DE89370400440532013000', { pakistanOnly: true });
    assert.equal(result.valid, false);
    assert.equal(result.error, BANK_VALIDATION_MESSAGES.ibanPakistanOnly);
  });
});
