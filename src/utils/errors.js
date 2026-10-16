'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message); this.name = 'HttpError'; this.status = status; this.code = code;
  }
}

class ProviderError extends Error {
  constructor(code, { retryable = false, ambiguous = false } = {}) {
    super(code); this.name = 'ProviderError'; this.code = code;
    this.retryable = retryable; this.ambiguous = ambiguous;
  }
}

module.exports = { HttpError, ProviderError };
