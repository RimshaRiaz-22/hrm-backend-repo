'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCurrency,
  CURRENCY_VALIDATION_MESSAGES,
  SUPPORTED_CURRENCY_CODES,
} = require('../src/utils/currencyValidation');
const {
  validateCurrencyFields,
  validateCurrencyMiddleware,
} = require('../src/middleware/validateCurrencyFields');

describe('validateCurrency', () => {
  it('accepts PKR, NZD and other ISO codes (normalized)', () => {
    assert.equal(validateCurrency('pkr').valid, true);
    assert.equal(validateCurrency('pkr').value, 'PKR');
    assert.ok(SUPPORTED_CURRENCY_CODES.includes('PKR'));
    assert.ok(SUPPORTED_CURRENCY_CODES.includes('NZD'));
    assert.equal(validateCurrency('NZD').valid, true);
    assert.equal(validateCurrency('USD').valid, true);
    assert.equal(validateCurrency('EUR').valid, true);
  });

  it('rejects unsupported and malformed values', () => {
    const cases = [
      ['PNS', CURRENCY_VALIDATION_MESSAGES.unsupported],
      ['ABC', CURRENCY_VALIDATION_MESSAGES.unsupported],
      ['PK', CURRENCY_VALIDATION_MESSAGES.invalidFormat],
      ['PKRR', CURRENCY_VALIDATION_MESSAGES.invalidFormat],
      ['123', CURRENCY_VALIDATION_MESSAGES.invalidFormat],
      ['', CURRENCY_VALIDATION_MESSAGES.required],
      [null, CURRENCY_VALIDATION_MESSAGES.required],
      [undefined, CURRENCY_VALIDATION_MESSAGES.required],
    ];

    for (const [input, expected] of cases) {
      const result = validateCurrency(input, { required: true });
      assert.equal(result.valid, false, String(input));
      assert.equal(result.value, null, String(input));
      assert.equal(result.error, expected, String(input));
    }
  });

  it('allows empty when required=false', () => {
    const result = validateCurrency('', { required: false });
    assert.equal(result.valid, true);
    assert.equal(result.value, null);
    assert.equal(result.error, null);
  });
});

describe('validateCurrencyMiddleware', () => {
  function runMiddleware(middleware, body) {
    return new Promise((resolve) => {
      const req = { body };
      const res = {
        statusCode: 200,
        payload: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          resolve({ req, res });
          return this;
        },
      };
      middleware(req, res, () => resolve({ req, res, next: true }));
    });
  }

  it('is exported as validateCurrencyMiddleware alias', () => {
    assert.equal(validateCurrencyMiddleware, validateCurrencyFields);
  });

  it('normalizes currency on employee salary payload', async () => {
    const middleware = validateCurrencyFields([
      {
        paths: ['salary.currency', 'currency'],
        required: false,
        writePaths: ['salary.currency', 'currency'],
      },
    ]);
    const { req, next } = await runMiddleware(middleware, {
      salary: { currency: ' pkr ' },
    });
    assert.equal(next, true);
    assert.equal(req.body.salary.currency, 'PKR');
    assert.equal(req.body.currency, 'PKR');
  });

  it('returns HTTP 400 for unsupported currency', async () => {
    const middleware = validateCurrencyFields([
      { paths: ['currency'], required: true, writePaths: ['currency'] },
    ]);
    const { res, next } = await runMiddleware(middleware, { currency: 'PNS' });
    assert.equal(next, undefined);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload?.error, true);
    assert.equal(
      res.payload?.message,
      'Unsupported currency. Please select a valid currency.'
    );
  });
});
