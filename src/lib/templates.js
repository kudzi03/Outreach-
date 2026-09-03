'use strict';
/**
 * templates.js — the 3-touch copy, plus the personalization guards that keep
 * a bad CRM row from producing an embarrassing email.
 *
 * Deliberate choices:
 *  - Plain text only. No HTML, no tracking pixel, no links in touch 1 & 2.
 *    Cold outreach at 30/day lives or dies on sender reputation; image
 *    beacons and link-wrapping are the two fastest ways into Promotions/Spam.
 *  - Follow-ups are threaded replies (Re: + In-Reply-To/References), so the
 *    prospect sees one conversation rather than three cold emails.
 */

var TPL_GENERIC_LOCALPARTS = [
  'info', 'sales', 'admin', 'team', 'office', 'contact', 'hello', 'help',
  'support', 'service', 'enquiries', 'inquiries', 'estimating', 'estimates',
  'accounts', 'billing', 'mail', 'email', 'noreply', 'no-reply', 'webmaster'
];

var TPL_COMPANY_TOKENS = /\b(llc|inc|incorporated|ltd|limited|co|corp|corporation|compan(y|ies)|construction|remodels?|remodell?ing|kitchens?|baths?|bathrooms?|designs?|builders?|building|contracting|contractors?|group|services?|solutions?|renovations?|cabinet(s|ry)?|interiors?|millwork|plumbing|studios?|enterprises?|associates|partners|holdings)\b/i;

/** Collapse whitespace and strip control characters. */
function tidy(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "JOHN" -> "John", "mcdonald" -> "Mcdonald" (conservative, no fancy casing). */
function titleCase(value) {
  return tidy(value).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, function (_, sep, ch) {
    return sep + ch.toUpperCase();
  });
}

/**
 * Decide whether a First Name value is safe to put in an email.
 * Rejects blanks, role addresses, company names, numbers and scraped junk.
 * A rejection is not an error — it simply routes us to the fallback copy.
 */
function firstNameOf(lead) {
  var raw = tidy(lead && (lead.firstName || lead['First Name']));
  if (!raw) return null;
  // A company name scraped into the First Name column ("Maple Ridge Kitchens")
  // must be rejected on the WHOLE value: its first token alone ("Maple") looks
  // like a perfectly good first name.
  if (TPL_COMPANY_TOKENS.test(raw)) return null;
  // Take only the first token: "John Smith" -> "John".
  var first = raw.split(' ')[0];
  if (first.length < 2 || first.length > 20) return null;
  if (/[0-9@_/\\|<>{}\[\]()]/.test(first)) return null;
  if (!/^\p{L}[\p{L}'\-.]*$/u.test(first)) return null;
  if (TPL_GENERIC_LOCALPARTS.indexOf(first.toLowerCase()) !== -1) return null;
  if (TPL_COMPANY_TOKENS.test(first)) return null;
  var company = tidy(lead && (lead.companyName || lead['Company Name'])).toLowerCase();
  if (company && first.toLowerCase() === company) return null;
  return titleCase(first);
}

/**
 * Company name for the subject line. Strips trailing legal suffixes so the
 * subject reads "quick question / Maple Ridge Kitchens" rather than
 * "quick question / Maple Ridge Kitchens, LLC.".
 */
function companyOf(lead) {
  var raw = tidy(lead && (lead.companyName || lead['Company Name']));
  if (!raw) return null;
  var trimmed = raw
    .replace(/[,\s]+(llc|l\.l\.c\.?|inc\.?|incorporated|ltd\.?|limited|co\.?|corp\.?|corporation)\.?$/i, '')
    .replace(/[\s,.\-]+$/, '')
    .trim();
  return trimmed || raw;
}

/** Plain-text footer. CAN-SPAM: identify the sender, give a way out. */
function signature(cfg) {
  var conf = cfg || {};
  var lines = ['--'];
  if (conf.senderName) lines.push(conf.senderName);
  if (conf.senderCompany) lines.push(conf.senderCompany);
  if (conf.senderPostalAddress) lines.push(conf.senderPostalAddress);
  lines.push('');
  // Doubles as the opt-out mechanism Workflow 2 listens for.
  lines.push('Not the right person? Just reply "stop" and I will close the loop.');
  return lines.join('\n');
}

function withSignature(body, cfg) {
  return body.trim() + '\n\n' + signature(cfg) + '\n';
}

/** Subject for touch 1. Falls back to a company-free subject if needed. */
function subjectForEmail1(lead) {
  var company = companyOf(lead);
  return company ? 'quick question / ' + company : 'quick question';
}

/** "Re: " prefix that never stacks into "Re: Re: ...". */
function replySubject(threadSubject, lead) {
  var base = tidy(threadSubject) || subjectForEmail1(lead);
  return /^re:/i.test(base) ? base : 'Re: ' + base;
}

function bodyEmail1(lead) {
  var first = firstNameOf(lead);
  if (first) {
    return 'Hey ' + first + ', quick question: when you guys drop off a quote for a $20k+ kitchen or bath job, who usually handles chasing them down a few days later?';
  }
  var company = companyOf(lead);
  var who = company ? 'the team at ' + company : 'your team';
  return 'Quick question for ' + who + '—when you guys send out a quote for a bigger remodel, who handles following up?';
}

/**
 * Follow-ups are replies inside a thread the prospect can see. A fresh
 * "Hey there," greeting on a bump reads like a mail merge, so with no usable
 * first name we simply open on the sentence.
 */
function greeting(lead) {
  var first = firstNameOf(lead);
  return first ? 'Hey ' + first + ' — ' : '';
}

/**
 * Touch 2. Deliberately SHORTER than the opener, not longer.
 *
 * The prospect can see touch 1 directly beneath this one, so re-explaining the
 * premise wastes the only three seconds of attention a bump gets. What survives
 * from the original draft is the Tuesday/Wednesday/Friday detail — that is the
 * line a remodeler recognizes as their own week — and everything that merely
 * narrated it back to them is gone.
 *
 * It closes on a binary a busy person can answer in four words, including an
 * easy "no". Giving someone a graceful out is what makes them reply at all.
 */
function bodyFollowUp1(lead) {
  var open = greeting(lead);
  return open + (open ? 'r' : 'R') +
    'eason I ask: most guys tell me the quote goes out Tuesday, they get pulled onto a job site Wednesday, and nobody\'s called the homeowner by Friday.' +
    '\n\nIs that you, or have you got it handled?';
}

/**
 * Touch 3. The break-up.
 *
 * Avoids the two most-recognized closers in cold email — the false either/or
 * ("I'm guessing your pipeline is packed, or...") and "I'll stop bugging you!".
 * Both are template tells that a remodeler who gets ten of these a week will
 * clock instantly. This just closes the loop and leaves the door open.
 */
function bodyFollowUp2(lead) {
  var open = greeting(lead);
  return open + (open ? 'l' : 'L') + 'ast one from me.' +
    '\n\nIf it\'s handled, ignore this. If it\'s not, just reply and I\'ll send a 60-second video of what two other remodelers set up.';
}

/**
 * Build the outbound message for a given touch.
 *
 * @param {string} touch 'email1' | 'followup1' | 'followup2'
 * @param {object} lead  normalized lead (+ threadSubject / messageId / threadReferences)
 * @param {object} cfg   sender identity
 * @returns {{subject:string,textBody:string,headers:Array,touch:string,isReply:boolean}}
 */
function buildMessage(touch, lead, cfg) {
  var conf = cfg || {};
  var row = lead || {};
  var msg;
  if (touch === 'email1') {
    msg = { subject: subjectForEmail1(row), textBody: bodyEmail1(row), isReply: false };
  } else if (touch === 'followup1') {
    msg = { subject: replySubject(row.threadSubject, row), textBody: bodyFollowUp1(row), isReply: true };
  } else if (touch === 'followup2') {
    msg = { subject: replySubject(row.threadSubject, row), textBody: bodyFollowUp2(row), isReply: true };
  } else {
    throw new Error('Unknown touch: ' + touch);
  }

  msg.touch = touch;
  msg.textBody = withSignature(msg.textBody, conf);
  msg.headers = [];

  // RFC 5322 threading. With no stored Message-ID we still send; the reply
  // then threads on subject alone. Never block a send on a missing header.
  var parentId = tidy(row.messageId);
  if (msg.isReply && parentId) {
    var refs = tidy(row.threadReferences);
    msg.headers.push({ Name: 'In-Reply-To', Value: parentId });
    msg.headers.push({ Name: 'References', Value: (refs ? refs + ' ' : '') + parentId });
  }
  return msg;
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tidy: tidy,
    titleCase: titleCase,
    firstNameOf: firstNameOf,
    companyOf: companyOf,
    signature: signature,
    subjectForEmail1: subjectForEmail1,
    replySubject: replySubject,
    greeting: greeting,
    bodyEmail1: bodyEmail1,
    bodyFollowUp1: bodyFollowUp1,
    bodyFollowUp2: bodyFollowUp2,
    buildMessage: buildMessage
  };
}
