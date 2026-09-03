// @requires: qualify
// n8n Code node — "Read Page" (Run Once for All Items)
//
// Input: the raw website response (the HTTP node continues on error, so a
// timeout, a 404 or a blocked scraper arrives here as data).
// Output: either a Claude request to send, or a finished "Unsure" verdict.

var cfg = $('W3 Config').first().json.cfg;
// Read the IF node's true output (branch 0), never the splitInBatches node —
// $('node').first() defaults to branch 0, which on a loop node is "done".
var lead = $('Readable?').first().json;
var res = $input.first().json || {};

function unreadable(reason) {
  return [{
    json: Object.assign({}, lead, {
      route: 'unreadable',
      verdict: {
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
      }
    })
  }];
}

if (res.error) {
  var detail = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
  return unreadable('Could not load ' + lead.qualifyUrl + ': ' + detail.slice(0, 120));
}

var html = res.data !== undefined ? res.data : (res.body !== undefined ? res.body : '');
if (typeof html !== 'string') html = JSON.stringify(html);

var page = htmlToText(html, cfg.pageCharLimit);

if (!isUsablePage(page)) {
  return unreadable('Site has too little readable text to judge (' + page.originalLength + ' chars).');
}

console.log('[' + lead.runId + '] read ' + lead.qualifyUrl + ' -> ' + page.text.length +
  ' chars' + (page.truncated ? ' (truncated)' : ''));

return [{
  json: Object.assign({}, lead, {
    route: 'classify',
    pageTitle: page.title,
    pageChars: page.text.length,
    claudeRequest: buildClaudeRequest(page, lead, {
      model: cfg.claudeModel,
      effort: cfg.claudeEffort,
      maxTokens: cfg.claudeMaxTokens
    })
  })
}];
