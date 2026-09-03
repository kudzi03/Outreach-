'use strict';
/**
 * classify.js — inbound reply triage for Workflow 2.
 *
 * Four verdicts, in the order they are tested:
 *   'bounce'   hard delivery failure  -> Status = Invalid
 *   'auto'     out-of-office / vacation autoresponder -> NO status change
 *   'optout'   opt-out language       -> Status = Do Not Contact  (terminal)
 *   'replied'  a real human answered  -> Status = Replied + notify
 *
 * Two precision problems drive the design:
 *
 *  1. Quoted history. Our own email is quoted underneath every reply, and our
 *     own signature contains the word "stop". Matching on the raw body would
 *     opt out every single person who answers. So we strip quotes FIRST and
 *     classify only the freshly typed text.
 *
 *  2. The bare word "stop". "Stop by the showroom Thursday" is a warm reply,
 *     not an opt-out, and Do Not Contact is irreversible. So single ambiguous
 *     words only count when the whole reply is short enough to be a command;
 *     unambiguous multi-word phrases count anywhere.
 */

var CLS_QUOTE_SEPARATORS = [
  /^\s*on\s+.{0,120}\s+wrote\s*:\s*$/im,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/im,
  /^\s*_{5,}\s*$/m,
  /^\s*-{5,}\s*$/m,
  /^\s*from\s*:\s*.+$/im,
  /^\s*sent from my \w+/im,
  /^\s*get outlook for \w+/im,
  /^\s*>{1,}\s?/m
];

/** Phrases that mean "never contact me again". Safe to match anywhere. */
var CLS_OPTOUT_PHRASES = [
  'unsubscribe', 'unsubscribe me', 'opt out', 'opt-out', 'optout',
  'not interested', 'no longer interested', 'no thank you', 'no thanks',
  'remove me', 'remove us', 'please remove', 'take me off', 'take us off',
  'take me off your list', 'off your list', 'do not contact',
  "don't contact", 'do not email', "don't email", 'stop emailing',
  'stop contacting', 'stop sending', 'stop reaching out', 'stop messaging',
  'wrong person', 'wrong contact', 'not the right person', 'no soliciting',
  'no solicitation', 'leave me alone', 'lose my email', 'delete my email',
  'delete our details', 'cease and desist', 'unsolicited', 'this is spam',
  'reported as spam', 'we are not interested', 'not looking', 'no need',
  'no longer with', 'has left the company', 'is no longer with'
];

/**
 * Words that mean opt-out only when the reply is essentially just that word.
 * Guard: reply must be <= CLS_SHORT_REPLY_WORDS words.
 */
var CLS_AMBIGUOUS_OPTOUT_WORDS = ['stop', 'remove', 'unsub', 'no', 'nope', 'pass', 'delete'];
var CLS_SHORT_REPLY_WORDS = 4;

/** Positive-intent markers. Used for notification priority, not for routing. */
var CLS_POSITIVE_PHRASES = [
  'interested', 'send it', 'send that', 'send over', 'send me', 'sounds good',
  'sounds interesting', 'tell me more', 'more info', 'more information',
  'how much', 'pricing', 'what does it cost', 'price', 'lets talk',
  "let's talk", 'happy to chat', 'happy to talk', 'call me', 'give me a call',
  'book a', 'schedule a', 'set up a', 'set something up', 'calendar',
  'yes please', 'sure', 'go ahead', 'would love', "i'd love", 'i would love',
  'the video', '60-second video', 'demo', 'worth a look', 'good timing'
];

/** Subjects that signal an autoresponder rather than a human. */
var CLS_AUTOREPLY_SUBJECT = /(out\s+of\s+(the\s+)?office|automatic(ally)?\s+repl|auto[-\s]?reply|autoresponse|away\s+from\s+(my\s+)?(desk|email|office)|on\s+(vacation|holiday|leave|pto)|annual\s+leave|maternity|paternity|i\s+am\s+away|currently\s+away)/i;

/** Subjects that signal a bounce / delivery-status notification. */
var CLS_BOUNCE_SUBJECT = /(undeliverable|undelivered|delivery\s+(status\s+notification|failure|has\s+failed)|returned\s+mail|mail\s+delivery\s+(failed|subsystem)|failure\s+notice|message\s+not\s+delivered|address\s+not\s+found|recipient\s+rejected)/i;

var CLS_BOUNCE_SENDER = /(mailer-daemon|postmaster|mail\.delivery|delivery-status|no-?reply@.*(mail|smtp|mx))/i;

/** Lower-case a header map so lookups do not depend on the mail client. */
function normalizeHeaders(headers) {
  var out = {};
  if (!headers || typeof headers !== 'object') return out;
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    var v = headers[keys[i]];
    out[keys[i].toLowerCase()] = Array.isArray(v) ? v.join(' ') : String(v === undefined || v === null ? '' : v);
  }
  return out;
}

/** Pull the bare address out of `"Dana Ruiz" <dana@example.com>`. */
function extractEmail(value) {
  if (!value) return null;
  var s = String(value);
  var angled = /<([^>]+)>/.exec(s);
  if (angled) s = angled[1];
  var m = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.exec(s);
  return m ? m[0].trim().toLowerCase() : null;
}

/**
 * Normalize an address for MATCHING ONLY (never for sending):
 * lowercase, strip +tag. Gmail dot-folding is deliberately NOT applied —
 * it is wrong for every other provider and could match the wrong record.
 */
function matchKey(email) {
  var addr = extractEmail(email);
  if (!addr) return null;
  var parts = addr.split('@');
  var local = parts[0].split('+')[0];
  return local + '@' + parts[1];
}

/**
 * Strip quoted history and signatures, leaving only what the person typed.
 * Conservative: if stripping would leave nothing, keep the original text.
 */
function stripQuoted(rawText) {
  if (!rawText) return '';
  var text = String(rawText).replace(/\r\n/g, '\n');

  var cutAt = text.length;
  for (var i = 0; i < CLS_QUOTE_SEPARATORS.length; i++) {
    var m = CLS_QUOTE_SEPARATORS[i].exec(text);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  var head = text.slice(0, cutAt);

  // Drop a trailing "-- \nsignature" block.
  head = head.replace(/\n--\s*\n[\s\S]*$/, '\n');

  head = head.replace(/[​-‍﻿]/g, '').trim();
  return head || text.trim();
}

/** Reduce to comparable prose: lowercase, punctuation to spaces. */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(normalized) {
  return normalized ? normalized.split(' ').filter(Boolean).length : 0;
}

/** Detect out-of-office / autoresponders from headers and subject. */
function isAutoReply(headers, subject) {
  var h = normalizeHeaders(headers);
  var autoSubmitted = (h['auto-submitted'] || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress']) return true;
  if (/auto[_-]?(reply|generated|responder)/i.test(h['precedence'] || '')) return true;
  if (/vacation|out-of-office/i.test(h['x-mailer'] || '')) return true;
  if ((h['x-ms-exchange-inbox-rules-loop'] || '') !== '') return true;
  return CLS_AUTOREPLY_SUBJECT.test(String(subject || ''));
}

/** Detect hard bounces / delivery-status notifications. */
function isBounce(headers, subject, fromEmail) {
  var h = normalizeHeaders(headers);
  var ct = (h['content-type'] || '').toLowerCase();
  if (ct.indexOf('report-type=delivery-status') !== -1) return true;
  if (ct.indexOf('multipart/report') !== -1) return true;
  if (h['x-failed-recipients']) return true;
  if (CLS_BOUNCE_SENDER.test(String(fromEmail || ''))) return true;
  return CLS_BOUNCE_SUBJECT.test(String(subject || ''));
}

/** Phrase hit with word boundaries, so "no" never matches inside "nothing". */
function containsPhrase(normalized, phrase) {
  var esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|\\s)' + esc + '($|\\s)').test(normalized);
}

function matchedOptOutPhrases(normalized) {
  var hits = [];
  for (var i = 0; i < CLS_OPTOUT_PHRASES.length; i++) {
    if (containsPhrase(normalized, normalizeText(CLS_OPTOUT_PHRASES[i]))) {
      hits.push(CLS_OPTOUT_PHRASES[i]);
    }
  }
  if (wordCount(normalized) <= CLS_SHORT_REPLY_WORDS) {
    for (var j = 0; j < CLS_AMBIGUOUS_OPTOUT_WORDS.length; j++) {
      if (containsPhrase(normalized, CLS_AMBIGUOUS_OPTOUT_WORDS[j])) {
        hits.push(CLS_AMBIGUOUS_OPTOUT_WORDS[j]);
      }
    }
  }
  return hits;
}

function matchedPositivePhrases(normalized) {
  var hits = [];
  for (var i = 0; i < CLS_POSITIVE_PHRASES.length; i++) {
    if (containsPhrase(normalized, normalizeText(CLS_POSITIVE_PHRASES[i]))) {
      hits.push(CLS_POSITIVE_PHRASES[i]);
    }
  }
  return hits;
}

/**
 * Classify one inbound message.
 *
 * @param {object} msg {fromEmail, subject, text, headers}
 * @returns {{
 *   verdict:'bounce'|'auto'|'optout'|'replied',
 *   sentiment:'positive'|'neutral'|'negative'|'none',
 *   nextStatus:string|null,        null = leave the record alone
 *   notify:boolean,
 *   cleanText:string,
 *   matchedOptOut:string[],
 *   matchedPositive:string[],
 *   reason:string
 * }}
 */
function classifyInbound(msg) {
  var m = msg || {};
  var subject = m.subject || '';
  var fromEmail = extractEmail(m.fromEmail || m.from) || '';
  var clean = stripQuoted(m.text || m.textPlain || m.body || '');
  var normalized = normalizeText(clean);

  var base = {
    verdict: 'replied',
    sentiment: 'neutral',
    nextStatus: 'Replied',
    notify: true,
    cleanText: clean,
    matchedOptOut: [],
    matchedPositive: [],
    reason: ''
  };

  // Bounces first: a DSN quoting our original would otherwise look like a
  // reply containing our own copy.
  if (isBounce(m.headers, subject, fromEmail)) {
    base.verdict = 'bounce';
    base.sentiment = 'none';
    base.nextStatus = 'Invalid';
    base.notify = false;
    base.reason = 'Delivery-status notification / bounce detected.';
    return base;
  }

  // Auto-replies are NOT replies. Marking them "Replied" silently kills a
  // live sequence every time someone takes a week off.
  if (isAutoReply(m.headers, subject)) {
    base.verdict = 'auto';
    base.sentiment = 'none';
    base.nextStatus = null;
    base.notify = false;
    base.reason = 'Autoresponder / out-of-office. Sequence left untouched.';
    return base;
  }

  var optOut = matchedOptOutPhrases(normalized);
  if (optOut.length) {
    base.verdict = 'optout';
    base.sentiment = 'negative';
    base.nextStatus = 'Do Not Contact';
    base.notify = false;
    base.matchedOptOut = optOut;
    base.reason = 'Opt-out language matched: ' + optOut.join(', ');
    return base;
  }

  var positive = matchedPositivePhrases(normalized);
  base.matchedPositive = positive;
  base.sentiment = positive.length ? 'positive' : 'neutral';
  base.reason = positive.length
    ? 'Positive reply. Matched: ' + positive.join(', ')
    : 'Human reply, neutral intent.';
  return base;
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLS_OPTOUT_PHRASES: CLS_OPTOUT_PHRASES,
    CLS_AMBIGUOUS_OPTOUT_WORDS: CLS_AMBIGUOUS_OPTOUT_WORDS,
    CLS_POSITIVE_PHRASES: CLS_POSITIVE_PHRASES,
    normalizeHeaders: normalizeHeaders,
    extractEmail: extractEmail,
    matchKey: matchKey,
    stripQuoted: stripQuoted,
    normalizeText: normalizeText,
    wordCount: wordCount,
    isAutoReply: isAutoReply,
    isBounce: isBounce,
    containsPhrase: containsPhrase,
    matchedOptOutPhrases: matchedOptOutPhrases,
    matchedPositivePhrases: matchedPositivePhrases,
    classifyInbound: classifyInbound
  };
}
