'use strict';
/**
 * verify.js — MillionVerifier verdict mapping.
 *
 * API: GET https://api.millionverifier.com/api/v3/?api=KEY&email=X&timeout=20
 * Returns { email, result, resultcode, subresult, free, role, credits, ... }
 *
 * result values: ok | catch_all | unknown | disposable | invalid | error
 *
 * Mapping to the brief's three-value `Verification Status`:
 *   ok                        -> Valid
 *   catch_all | unknown       -> Risky
 *   invalid | disposable      -> Invalid
 *
 * The brief says Invalid AND Risky both halt. That is the right default for a
 * 30/day reputation-first campaign, so ALLOW_RISKY defaults to false. Flipping
 * it to true sends to catch-all domains, which is a real trade: many legitimate
 * remodeling companies run catch-all Exchange/Google Workspace domains.
 *
 * Errors are NEVER treated as verdicts. If the API is down or out of credits we
 * return `pending`, and the dispatcher defers the lead to tomorrow with its
 * status untouched — an outage must not burn a lead as "Invalid".
 */

var VERIFY_ENDPOINT = 'https://api.millionverifier.com/api/v3/';

function verifyUrl(apiKey, email, timeoutSeconds) {
  return VERIFY_ENDPOINT +
    '?api=' + encodeURIComponent(apiKey) +
    '&email=' + encodeURIComponent(email) +
    '&timeout=' + encodeURIComponent(String(timeoutSeconds || 20));
}

/** RFC-ish syntax gate. Cheap, runs before we spend a verification credit. */
function looksLikeEmail(value) {
  if (!value) return false;
  var s = String(value).trim();
  if (s.length > 254 || /\s/.test(s)) return false;
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

/**
 * Map an API payload (or a transport failure) to a decision.
 *
 * @param {object} response  parsed MillionVerifier JSON, or null on failure
 * @param {object} opts      { allowRisky:boolean, httpError:any }
 * @returns {{
 *   verificationStatus:'Valid'|'Risky'|'Invalid'|null,
 *   decision:'send'|'halt'|'pending',
 *   raw:string,
 *   reason:string
 * }}
 */
function mapVerification(response, opts) {
  var o = opts || {};
  var allowRisky = o.allowRisky === true;

  if (o.httpError || !response || typeof response !== 'object') {
    return {
      verificationStatus: null,
      decision: 'pending',
      raw: '',
      reason: 'Verifier unreachable or returned no payload. Lead deferred, status untouched.'
    };
  }

  var result = String(response.result || '').toLowerCase();

  // MillionVerifier reports quota/auth problems in `error`, sometimes with
  // result === 'error'. Never let that mark a real address Invalid.
  if (response.error || result === 'error' || result === '') {
    return {
      verificationStatus: null,
      decision: 'pending',
      raw: result,
      reason: 'Verifier error: ' + (response.error || 'empty result') + '. Lead deferred.'
    };
  }

  if (result === 'ok') {
    return {
      verificationStatus: 'Valid',
      decision: 'send',
      raw: result,
      reason: 'Deliverable.'
    };
  }

  if (result === 'catch_all' || result === 'unknown') {
    return {
      verificationStatus: 'Risky',
      decision: allowRisky ? 'send' : 'halt',
      raw: result,
      reason: 'Risky (' + result + '). ' + (allowRisky ? 'ALLOW_RISKY=true, sending.' : 'Halted by policy.')
    };
  }

  // invalid, disposable, and anything unrecognized: fail closed.
  return {
    verificationStatus: 'Invalid',
    decision: 'halt',
    raw: result,
    reason: 'Undeliverable (' + result + ').'
  };
}

/**
 * Should we spend a credit on this lead at all?
 * A lead already verified Valid stays valid — re-verifying on every follow-up
 * triples the bill for no benefit.
 */
function needsVerification(lead, opts) {
  var o = opts || {};
  var current = String((lead && lead.verificationStatus) || '').trim().toLowerCase();
  if (o.forceReverify) return true;
  if (current === 'valid') return false;
  if (current === 'risky' && o.allowRisky) return false;
  return true;
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VERIFY_ENDPOINT: VERIFY_ENDPOINT,
    verifyUrl: verifyUrl,
    looksLikeEmail: looksLikeEmail,
    mapVerification: mapVerification,
    needsVerification: needsVerification
  };
}
