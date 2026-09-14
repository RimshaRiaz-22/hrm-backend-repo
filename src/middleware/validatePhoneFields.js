'use strict';

const { sendError } = require('../utils/apiResponse');
const { validatePhoneNumber } = require('../utils/phoneValidation');

function getPathValue(source, path) {
  if (!source || typeof source !== 'object') return undefined;
  const parts = String(path).split('.');
  let current = source;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setPathValue(source, path, value) {
  const parts = String(path).split('.');
  let current = source;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

function firstPresentPath(body, paths) {
  for (const path of paths) {
    const value = getPathValue(body, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { path, value };
    }
  }
  return { path: paths[0], value: undefined };
}

/**
 * Express middleware factory that validates and normalizes phone fields to E.164.
 *
 * @param {Array<{
 *   paths: string[],
 *   required?: boolean,
 *   fieldName?: string,
 *   defaultCountry?: string,
 *   writePaths?: string[],
 * }>} fields
 *
 * Example:
 *   validatePhoneFields([
 *     {
 *       paths: ['phone_number', 'home_phone', 'personal.phone_no'],
 *       required: true,
 *       fieldName: 'phone number',
 *       writePaths: ['phone_number', 'home_phone', 'personal.phone_no'],
 *     },
 *   ])
 */
function validatePhoneFields(fields = []) {
  const configs = Array.isArray(fields) ? fields : [];

  return function validatePhoneFieldsMiddleware(req, res, next) {
    if (!req.body || typeof req.body !== 'object') {
      req.body = {};
    }

    for (const field of configs) {
      const paths = Array.isArray(field.paths) ? field.paths.filter(Boolean) : [];
      if (paths.length === 0) continue;

      const required = Boolean(field.required);
      const { path: matchedPath, value } = firstPresentPath(req.body, paths);
      const hasAnyKey = paths.some((path) => {
        const parts = String(path).split('.');
        let current = req.body;
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
      });

      // Optional fields that were not sent at all should be skipped (PATCH semantics).
      if (!required && !hasAnyKey) {
        continue;
      }

      const result = validatePhoneNumber(value, {
        required,
        fieldName: field.fieldName || 'phone number',
        defaultCountry: field.defaultCountry,
      });

      if (!result.ok) {
        return sendError(res, 400, result.error || 'Invalid phone number.', {
          field: matchedPath,
          phone: {
            status: result.status,
            country: result.country,
            lengthError: result.lengthError,
          },
        });
      }

      if (result.e164) {
        const writePaths = Array.isArray(field.writePaths) && field.writePaths.length
          ? field.writePaths
          : [matchedPath];
        for (const writePath of writePaths) {
          setPathValue(req.body, writePath, result.e164);
        }
      } else if (!required && hasAnyKey) {
        // Explicit empty optional phone → clear mapped paths.
        const writePaths = Array.isArray(field.writePaths) && field.writePaths.length
          ? field.writePaths
          : paths;
        for (const writePath of writePaths) {
          setPathValue(req.body, writePath, null);
        }
      }
    }

    return next();
  };
}

module.exports = {
  validatePhoneFields,
  getPathValue,
  setPathValue,
};
