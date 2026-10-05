'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePhoneNumber,
  normalizeToE164,
  requireE164,
} = require('../src/utils/phoneValidation');
const { validatePhoneFields } = require('../src/middleware/validatePhoneFields');

describe('validatePhoneNumber', () => {
  it('requires a value when required=true', () => {
    const result = validatePhoneNumber('', { required: true, fieldName: 'phone number' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'empty');
    assert.match(result.error, /required/i);
  });

  it('allows empty optional phones', () => {
    const result = validatePhoneNumber('', { required: false });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'empty');
    assert.equal(result.e164, null);
  });

  it('rejects incomplete numbers for the selected country', () => {
    const result = validatePhoneNumber('+92420', { required: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'incomplete');
    assert.match(result.error, /too short/i);
  });

  it('accepts a valid Pakistan mobile and returns E.164', () => {
    const result = validatePhoneNumber('+92 300 1234567', { required: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'valid');
    assert.equal(result.e164, '+923001234567');
    assert.equal(result.country, 'PK');
  });

  it('accepts a valid US number and returns E.164', () => {
    const result = validatePhoneNumber('+1 415 555 2671', { required: true });
    assert.equal(result.ok, true);
    assert.equal(result.e164, '+14155552671');
    assert.equal(result.country, 'US');
  });

  it('accepts a valid GB number and returns E.164', () => {
    const result = validatePhoneNumber('+44 7911 123456', { required: true });
    assert.equal(result.ok, true);
    assert.equal(result.e164, '+447911123456');
  });

  it('rejects invalid numbers even when length looks plausible', () => {
    const result = validatePhoneNumber('+1200', { required: true });
    assert.equal(result.ok, false);
  });
});

describe('normalizeToE164 / requireE164', () => {
  it('normalizes valid input to E.164 and returns null for empty optional', () => {
    assert.equal(normalizeToE164('+923001234567'), '+923001234567');
    assert.equal(normalizeToE164(''), null);
  });

  it('requireE164 returns descriptive errors', () => {
    const missing = requireE164('');
    assert.match(missing.error, /required/i);
    const ok = requireE164('+14155552671');
    assert.equal(ok.error, null);
    assert.equal(ok.e164, '+14155552671');
  });
});

describe('validatePhoneFields middleware', () => {
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
          resolve({ req, res, nextCalled: false });
          return this;
        },
      };
      middleware(req, res, () => resolve({ req, res, nextCalled: true }));
    });
  }

  it('normalizes nested personal.phone_no to E.164 and continues', async () => {
    const middleware = validatePhoneFields([
      {
        paths: ['phone_number', 'personal.phone_no'],
        required: true,
        fieldName: 'phone number',
        writePaths: ['phone_number', 'personal.phone_no', 'home_phone'],
      },
    ]);

    const { req, nextCalled, res } = await runMiddleware(middleware, {
      personal: { phone_no: '+92 300 1234567' },
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(req.body.personal.phone_no, '+923001234567');
    assert.equal(req.body.phone_number, '+923001234567');
    assert.equal(req.body.home_phone, '+923001234567');
  });

  it('rejects invalid phones with HTTP 400 and descriptive message', async () => {
    const middleware = validatePhoneFields([
      {
        paths: ['phone_number'],
        required: true,
        fieldName: 'phone number',
      },
    ]);

    const { nextCalled, res } = await runMiddleware(middleware, {
      phone_number: '+92 420',
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, true);
    assert.match(res.payload.message, /too short|valid/i);
  });

  it('skips optional fields that were not provided', async () => {
    const middleware = validatePhoneFields([
      {
        paths: ['business_phone_no'],
        required: false,
        fieldName: 'business phone',
      },
    ]);

    const { nextCalled, req } = await runMiddleware(middleware, { name: 'Acme' });
    assert.equal(nextCalled, true);
    assert.equal(req.body.business_phone_no, undefined);
  });
});
