'use strict';

function httpError(status, code, details) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  if (details !== undefined) e.details = details;
  return e;
}

const isoNow = () => new Date().toISOString();

module.exports = { httpError, isoNow };
