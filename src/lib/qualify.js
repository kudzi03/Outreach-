'use strict';
/**
 * qualify.js — the lead qualification pass (Workflow 3).
 *
 * What this does and, more importantly, what it does NOT do.
 *
 * It reads a company's website and decides whether they belong on the list at
 * all. It does not write, suggest, or influence a single word of the email.
 * That separation is deliberate:
 *
 *  - Generated openers ("I came across your portfolio of transitional kitchen
 *    remodels...") are the most recognizable pattern in cold email. They read
 *    as more of a pitch, not less.
 *  - Anything a model writes into a live email is untestable. The rest of this
 *    system is deterministic and covered by tests; a hallucinated detail in a
 *    cold email is not recoverable.
 *  - Targeting is where the leverage actually is at 30 sends/day. Not sending
 *    to a roofer beats any amount of clever phrasing.
 *
 * So the model answers narrow factual questions, the answer lands in a column,
 * and Workflow 1 skips the clear mismatches. Fixed copy, better list.
 *
 * FAIL-OPEN, everywhere. A dead site, a timeout, an API outage, a blocked
 * scraper — all resolve to "Unsure", which is still contacted. Only an
 * explicit "No" is skipped. Never running Workflow 3 at all leaves Workflow 1
 * behaving exactly as it did before.
 */

// This module deliberately depends on NOTHING else. Reaching for templates.js
// (which has an identical whitespace helper) would inline the entire email copy
// into Workflow 3's nodes, and the one property this workflow must have is that
// the model cannot reach a single word that goes to a prospect.

/** Mailbox providers whose domain tells us nothing about the business. */
var QL_FREEMAIL = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'protonmail.com',
  'proton.me', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com'
];

var QL_VERDICTS = ['Yes', 'Unsure', 'No'];

var QL_CATEGORIES = [
  'kitchen_bath_remodeler', 'general_contractor', 'handyman',
  'supplier_showroom', 'designer_only', 'other_trade', 'not_a_business',
  'unknown'
];

var QL_SIZES = ['solo', 'small_team', 'established', 'unknown'];

function qlTrim(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Collapse whitespace and strip control characters. Local by design. */
function qlTidy(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Domain half of an email address, lowercased. */
function domainOf(email) {
  var at = qlTrim(email).toLowerCase().split('@');
  return at.length === 2 && at[1] ? at[1] : null;
}

function isFreemail(email) {
  var d = domainOf(email);
  return d ? QL_FREEMAIL.indexOf(d) !== -1 : false;
}

/**
 * Where to look for this company's site.
 *
 * A `Website` column wins if the user has one. Otherwise the email domain is a
 * good guess for a small contractor — dana@mapleridgekitchens.com is almost
 * certainly mapleridgekitchens.com. A free mailbox tells us nothing, so those
 * leads are left unchecked rather than guessed at.
 */
function resolveUrl(lead) {
  var explicit = qlTrim(lead && (lead.website || lead['Website'] || lead['Site'] || lead['URL']));
  if (explicit) {
    var url = explicit;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    if (/^https?:\/\/[^\s/.]+\.[^\s/]{2,}/i.test(url)) {
      return { url: url.split('#')[0], source: 'website-column' };
    }
    return { url: null, source: 'website-column', reason: 'Website column is not a usable URL.' };
  }

  var email = qlTrim(lead && (lead.email || lead['Email']));
  if (!email) return { url: null, source: 'none', reason: 'No website and no email address.' };
  if (isFreemail(email)) {
    return { url: null, source: 'freemail', reason: 'Free mailbox (' + domainOf(email) + ') — no company site to read.' };
  }
  var d = domainOf(email);
  if (!d || d.indexOf('.') === -1) {
    return { url: null, source: 'email-domain', reason: 'Email domain is unusable.' };
  }
  return { url: 'https://' + d, source: 'email-domain' };
}

/**
 * HTML -> readable text.
 *
 * Scripts, styles, nav chrome and SVG are dropped first: they are most of the
 * bytes and none of the signal, and every token we send costs money.
 */
function htmlToText(html, maxChars) {
  var limit = maxChars || 6000;
  var text = String(html || '');

  var title = '';
  var titleMatch = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(text);
  if (titleMatch) title = titleMatch[1];

  var description = '';
  var descMatch = /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]{0,400}?)["']/i.exec(text);
  if (descMatch) description = descMatch[1];

  var body = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  var head = [];
  if (title) head.push('PAGE TITLE: ' + qlTidy(title));
  if (description) head.push('META DESCRIPTION: ' + qlTidy(description));
  var joined = (head.length ? head.join('\n') + '\n\n' : '') + body;

  return {
    title: qlTidy(title),
    description: qlTidy(description),
    text: joined.slice(0, limit),
    truncated: joined.length > limit,
    originalLength: joined.length
  };
}

/**
 * Is there enough on the page to judge anything?
 * A parked domain, a JS-only shell or a 404 gives us nothing, and asking the
 * model to guess from 40 words produces confident nonsense.
 */
function isUsablePage(page, minChars) {
  var min = minChars || 200;
  if (!page || !page.text) return false;
  var words = page.text.replace(/\s+/g, ' ').trim();
  if (words.length < min) return false;
  if (/domain (is )?(for sale|parked)|buy this domain|coming soon|under construction|website is being/i.test(words.slice(0, 600))) {
    return false;
  }
  return true;
}

var QL_SYSTEM_PROMPT = [
  'You qualify leads for a B2B outreach list. You are shown text scraped from',
  'one company website and you decide whether that company belongs on the list.',
  '',
  'The list targets KITCHEN AND BATH REMODELING CONTRACTORS in the US who:',
  '  - sell and install full kitchen and/or bathroom remodels for homeowners, and',
  '  - are large enough to run a quoting/estimating process (not a lone handyman).',
  '',
  'Answer "No" when the company is any of:',
  '  - a supplier, showroom or fabricator that does not install',
  '  - a handyman or odd-jobs service',
  '  - an interior designer or architect who does not do the build',
  '  - an unrelated trade (roofing, HVAC, landscaping, plumbing-only, electrical,',
  '    flooring-only, painting, pools, restoration, cleaning)',
  '  - a franchise portal, directory, marketplace or lead-gen site',
  '  - a parked, dead or non-business page',
  '',
  'Answer "Unsure" when the page is too thin or too ambiguous to tell.',
  '',
  'Be strict. A wrong "Yes" wastes a send and risks a spam complaint; a wrong',
  '"No" only costs one lead. Judge ONLY from the text shown - never guess from',
  'the company name, and never invent details that are not on the page.',
  '',
  'Reply with a single JSON object and nothing else. No prose, no code fence:',
  '{',
  '  "fit": "Yes" | "Unsure" | "No",',
  '  "category": "kitchen_bath_remodeler" | "general_contractor" | "handyman" |',
  '              "supplier_showroom" | "designer_only" | "other_trade" |',
  '              "not_a_business" | "unknown",',
  '  "size": "solo" | "small_team" | "established" | "unknown",',
  '  "does_kitchens": true | false,',
  '  "does_baths": true | false,',
  '  "has_existing_crm": true | false,',
  '  "reason": "<= 20 words, quoting evidence from the page"',
  '}',
  '',
  'has_existing_crm means the page advertises online booking, instant quoting or',
  'automated follow-up.'
].join('\n');

/**
 * Build the Anthropic Messages API request body.
 *
 * Low effort: this is a short classification, not a reasoning problem, and
 * effort is the first thing that should come down on a per-lead cost.
 */
function buildClaudeRequest(page, lead, opts) {
  var o = opts || {};
  var company = qlTrim(lead && (lead.companyName || lead['Company Name'])) || '(unknown)';
  var city = qlTrim(lead && (lead.city || lead['City']));

  var userText = [
    'Company name on the list: ' + company,
    city ? 'City on the list: ' + city : null,
    'Website: ' + (lead.qualifyUrl || '(unknown)'),
    '',
    '--- BEGIN PAGE TEXT ---',
    page.text,
    '--- END PAGE TEXT ---'
  ].filter(Boolean).join('\n');

  return {
    model: o.model || 'claude-sonnet-5',
    max_tokens: o.maxTokens || 2000,
    system: QL_SYSTEM_PROMPT,
    output_config: { effort: o.effort || 'low' },
    messages: [{ role: 'user', content: userText }]
  };
}

/** Pull the assistant's text out of a Messages API response. */
function textFromResponse(response) {
  var blocks = (response && response.content) || [];
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    // Skip thinking blocks; take the visible answer only.
    if (blocks[i] && blocks[i].type === 'text' && blocks[i].text) out.push(blocks[i].text);
  }
  return out.join('\n').trim();
}

/** Find the first balanced {...} in a string, tolerating a stray code fence. */
function extractJson(text) {
  if (!text) return null;
  var cleaned = String(text).replace(/```(?:json)?/gi, '');
  var start = cleaned.indexOf('{');
  if (start === -1) return null;
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = start; i < cleaned.length; i++) {
    var ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

function oneOf(value, allowed, fallback) {
  var v = qlTrim(value).toLowerCase();
  for (var i = 0; i < allowed.length; i++) {
    if (String(allowed[i]).toLowerCase() === v) return allowed[i];
  }
  return fallback;
}

/**
 * Turn a raw API response (or a failure) into a verdict we are willing to
 * write to Airtable.
 *
 * Every unhappy path lands on "Unsure", never "No". A model that returns
 * garbage, an API that 500s, a page we could not read — none of those are
 * evidence that the company is a bad fit, and treating them as such would
 * silently delete leads.
 */
function parseVerdict(response, opts) {
  var o = opts || {};

  if (o.httpError || !response) {
    return unsure('Qualification API unreachable: ' + String(o.httpError || 'no response').slice(0, 120));
  }
  if (response.type === 'error' || response.error) {
    var msg = (response.error && (response.error.message || response.error.type)) || 'API error';
    return unsure('Qualification API error: ' + String(msg).slice(0, 120));
  }
  if (response.stop_reason === 'refusal') {
    return unsure('Model declined to classify this page.');
  }

  var parsed = extractJson(textFromResponse(response));
  if (!parsed || typeof parsed !== 'object') {
    return unsure('Model did not return usable JSON.');
  }

  var fit = oneOf(parsed.fit, QL_VERDICTS, null);
  if (!fit) return unsure('Model returned an unrecognized verdict.');

  var usage = response.usage || {};
  return {
    fit: fit,
    category: oneOf(parsed.category, QL_CATEGORIES, 'unknown'),
    size: oneOf(parsed.size, QL_SIZES, 'unknown'),
    doesKitchens: parsed.does_kitchens === true,
    doesBaths: parsed.does_baths === true,
    hasExistingCrm: parsed.has_existing_crm === true,
    reason: qlTrim(parsed.reason).slice(0, 300) || 'No reason given.',
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    ok: true
  };

  function unsure(reason) {
    return {
      fit: 'Unsure',
      category: 'unknown',
      size: 'unknown',
      doesKitchens: false,
      doesBaths: false,
      hasExistingCrm: false,
      reason: reason,
      inputTokens: 0,
      outputTokens: 0,
      ok: false
    };
  }
}

/** Rough USD cost of one classification, for the run summary. */
function estimateCost(inputTokens, outputTokens, pricing) {
  var p = pricing || { inputPerMillion: 2.0, outputPerMillion: 10.0 }; // claude-sonnet-5
  return (inputTokens / 1e6) * p.inputPerMillion + (outputTokens / 1e6) * p.outputPerMillion;
}

/**
 * Airtable formula for leads that still need checking.
 *
 * Only leads that have not been contacted yet: re-qualifying someone already
 * mid-sequence changes nothing, because Workflow 1 will not stop a sequence on
 * a fit verdict — only on a reply or an opt-out.
 */
function qualifyFetchFormula() {
  return [
    'AND(',
    '  {Email} != "",',
    '  OR({Fit} = "", {Fit} = "Unchecked"),',
    '  OR({Status} = "", {Status} = "New", {Status} = "Queued")',
    ')'
  ].join('').replace(/\s+/g, ' ');
}

/** Normalize one Airtable record for the qualification pass. */
function normalizeForQualify(record) {
  var f = (record && record.fields) || {};
  return {
    recordId: record && record.id,
    companyName: qlTrim(f['Company Name']),
    email: qlTrim(f['Email']).toLowerCase(),
    city: qlTrim(f['City']),
    website: qlTrim(f['Website']),
    fit: qlTrim(f['Fit']),
    status: qlTrim(f['Status'])
  };
}

/**
 * Build a run's worth of work.
 *
 * Two leads at the same domain (two contacts at one company) only need one
 * page fetch and one API call; the second inherits the first's verdict, which
 * is both cheaper and more consistent.
 */
function buildQualifyQueue(records, ctx) {
  var c = ctx || {};
  var cap = Number(c.perRunCap) > 0 ? Math.floor(Number(c.perRunCap)) : 50;

  var list = [];
  var incoming = records || [];
  for (var i = 0; i < incoming.length; i++) {
    if (incoming[i] && incoming[i].id) list.push(normalizeForQualify(incoming[i]));
  }

  var queue = [];
  var skipped = [];
  var seenDomain = {};

  for (var n = 0; n < list.length; n++) {
    var lead = list[n];
    var resolved = resolveUrl(lead);

    if (!resolved.url) {
      // Not a rejection — we simply cannot look. Mark it and move on.
      skipped.push({
        recordId: lead.recordId,
        email: lead.email,
        fit: 'Unsure',
        reason: resolved.reason || 'No website could be resolved.',
        unresolvable: true
      });
      continue;
    }

    var host = resolved.url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (seenDomain[host]) {
      skipped.push({
        recordId: lead.recordId,
        email: lead.email,
        reason: 'Same domain as record ' + seenDomain[host] + ' in this run.',
        duplicateOf: seenDomain[host],
        unresolvable: false
      });
      continue;
    }
    seenDomain[host] = lead.recordId;

    lead.qualifyUrl = resolved.url;
    lead.urlSource = resolved.source;
    lead.host = host;
    queue.push(lead);
  }

  var overflow = queue.slice(cap);
  for (var o = 0; o < overflow.length; o++) {
    skipped.push({
      recordId: overflow[o].recordId,
      email: overflow[o].email,
      reason: 'Over the ' + cap + '-per-run cap; picked up next run.',
      unresolvable: false
    });
  }

  var final = queue.slice(0, cap);
  for (var q = 0; q < final.length; q++) {
    final[q].position = q + 1;
    final[q].queueSize = final.length;
  }

  return {
    queue: final,
    skipped: skipped,
    stats: {
      fetched: list.length,
      resolvable: queue.length,
      queued: final.length,
      skipped: skipped.length,
      cap: cap
    }
  };
}

// ---8<--- exports (stripped by build/build.js when inlining into n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QL_FREEMAIL: QL_FREEMAIL,
    QL_VERDICTS: QL_VERDICTS,
    QL_CATEGORIES: QL_CATEGORIES,
    QL_SYSTEM_PROMPT: QL_SYSTEM_PROMPT,
    qlTidy: qlTidy,
    domainOf: domainOf,
    isFreemail: isFreemail,
    resolveUrl: resolveUrl,
    htmlToText: htmlToText,
    isUsablePage: isUsablePage,
    buildClaudeRequest: buildClaudeRequest,
    textFromResponse: textFromResponse,
    extractJson: extractJson,
    parseVerdict: parseVerdict,
    estimateCost: estimateCost,
    qualifyFetchFormula: qualifyFetchFormula,
    normalizeForQualify: normalizeForQualify,
    buildQualifyQueue: buildQualifyQueue
  };
}
