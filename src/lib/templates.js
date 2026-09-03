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

/** The brief gives no company fallback for follow-ups, so use "Hey there". */
function greeting(lead) {
  var first = firstNameOf(lead);
  return first ? 'Hey ' + first + ',' : 'Hey there,';
}

function bodyFollowUp1(lead) {
  return greeting(lead) + ' reason I asked is most kitchen & bath guys I talk to say their biggest headache is estimating a project on Tuesday, getting pulled onto a job site on Wednesday, and completely forgetting to check back in by Friday. By the time they call, the homeowner already signed with someone else who checked in first.\n\nDo you guys have something running that texts/emails them automatically after 48 hours, or is it mostly manual right now?';
}

function bodyFollowUp2(lead) {
  return greeting(lead) + ' I’m guessing either your pipeline is completely packed for the next 6 months, or you’ve already got a system handling quote follow-ups?\n\nIf not, let me know—happy to send over a 60-second video showing how two other remodelers automated it. Otherwise, I’ll stop bugging you!';
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
