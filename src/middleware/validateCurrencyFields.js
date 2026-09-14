'use strict';

const { sendError } = require('../utils/apiResponse');
const { validateCurrency } = require('../utils/currencyValidation');
const { getPathValue, setPathValue } = require('./validatePhoneFields');

function firstPresentPath(body, paths) {
  for (const path of paths) {
    const value = getPathValue(body, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { path, value };
    }
  }
  return { path: paths[0], value: undefined };
}

function hasPathKey(body, path) {
  const parts = String(path).split('.');
  let current = body;
  for (let i = 0; i < parts.length; i += 1) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(current, parts[i])) {
      return false;
    }
    current = current[parts[i]];
  }
  return true;
}

/**
 * Express middleware factory that validates and normalizes currency fields.
 *
 * @param {Array<{
 *   paths: string[],
 *   required?: boolean,
 *   writePaths?: string[],
 * }>} fields
 *
 * @example
 *   validateCurrencyFields([
 *     { paths: ['salary.currency', 'currency'], required: false, writePaths: ['salary.currency', 'currency'] },
 *   ])
 */
function validateCurrencyFields(fields = []) {
  const configs = Array.isArray(fields) ? fields : [];

  return function validateCurrencyMiddleware(req, res, next) {
    if (!req.body || typeof req.body !== 'object') {
      req.body = {};
    }

    for (const field of configs) {
      const paths = Array.isArray(field.paths) ? field.paths.filter(Boolean) : [];
      if (paths.length === 0) continue;

      const required = Boolean(field.required);
      const { path: matchedPath, value } = firstPresentPath(req.body, paths);
      const hasAnyKey = paths.some((path) => hasPathKey(req.body, path));

      // Optional fields that were not sent at all should be skipped (PATCH semantics).
      if (!required && !hasAnyKey) {
        continue;
      }

      const result = validateCurrency(value, { required });

      if (!result.valid) {
        return sendError(
          res,
          400,
          result.error || 'Unsupported currency. Please select a valid currency.',
          { field: matchedPath }
        );
      }

      const writePaths =
        Array.isArray(field.writePaths) && field.writePaths.length
          ? field.writePaths
          : [matchedPath];

      if (result.value) {
        for (const writePath of writePaths) {
          setPathValue(req.body, writePath, result.value);
        }
      } else if (!required && hasAnyKey) {
        for (const writePath of writePaths) {
          setPathValue(req.body, writePath, null);
        }
      }
    }

    return next();
  };
}

module.exports = {
  validateCurrencyFields,
  validateCurrencyMiddleware: validateCurrencyFields,
};
