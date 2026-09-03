#!/usr/bin/env node
'use strict';
/**
 * build.js — assemble importable n8n workflow JSON.
 *
 * Why a build step at all: every Code node needs the shared libraries inlined
 * (n8n Code nodes cannot `require` project files). Copy-pasting them into 16
 * nodes by hand guarantees they drift, and drift in `businessDaysSince` or
 * `classifyInbound` is exactly the kind of bug that quietly emails someone who
 * asked to be left alone. So the libraries are written once, unit-tested once,
 * and mechanically inlined here.
 *
 *   src/lib/*.js      tested source of truth
 *   src/nodes/*.js    per-node bodies, declaring `// @requires: a,b`
 *   workflows/templates/*.json   node graph with "@@code:<node-name>@@" markers
 *   -> workflows/*.json          committed, import-ready output
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'src', 'lib');
const NODE_DIR = path.join(ROOT, 'src', 'nodes');
const TEMPLATE_DIR = path.join(ROOT, 'workflows', 'templates');
const OUT_DIR = path.join(ROOT, 'workflows');

const EXPORT_MARKER = '// ---8<--- exports';
const SHIM_START = '// ---8<--- node-only shim';
const SHIM_END = '// ---8<--- end node-only shim';
// A node can mark a region to be placed ABOVE the inlined libraries. The config
// nodes use it so the block a human edits is the first thing on screen, not
// buried under 200 lines of date maths.
const HOIST_START = '// ---8<--- hoist';
const HOIST_END = '// ---8<--- end hoist';

/** Strip the CommonJS export block and any Node-only test shim. */
function stripForInline(source) {
  let out = source;

  const exportAt = out.indexOf(EXPORT_MARKER);
  if (exportAt !== -1) out = out.slice(0, exportAt);

  for (;;) {
    const start = out.indexOf(SHIM_START);
    if (start === -1) break;
    const end = out.indexOf(SHIM_END, start);
    if (end === -1) throw new Error('Unterminated node-only shim block');
    out = out.slice(0, start) + out.slice(end + SHIM_END.length);
  }

  // The assembled bundle gets one 'use strict' at the top instead.
  out = out.replace(/^\s*'use strict';\s*\n/, '');
  return out.replace(/\s+$/, '') + '\n';
}

/** Read a node body and the libs it declares. */
function readNode(name) {
  const file = path.join(NODE_DIR, `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`No node source for "${name}" (expected ${file})`);
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^\/\/[^\S\n]*@requires:[^\S\n]*(.*)$/m.exec(raw);
  const requires = match
    ? match[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  let rest = raw.replace(/^\/\/[^\S\n]*@requires:.*$/m, '');
  let hoist = '';
  const hStart = rest.indexOf(HOIST_START);
  if (hStart !== -1) {
    const hEnd = rest.indexOf(HOIST_END, hStart);
    if (hEnd === -1) throw new Error(`Unterminated hoist block in ${name}`);
    hoist = rest.slice(hStart + HOIST_START.length, hEnd).replace(/^\n/, '');
    rest = rest.slice(0, hStart) + rest.slice(hEnd + HOIST_END.length);
  }
  return { requires, hoist, body: stripForInline(rest) };
}

/** Resolve lib dependencies (queue depends on dates) and keep a stable order. */
const LIB_DEPS = { queue: ['dates'], templates: [], classify: [], schema: [], verify: [], dates: [] };

function resolveLibs(names) {
  const seen = new Set();
  const ordered = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    (LIB_DEPS[name] || []).forEach(visit);
    ordered.push(name);
  };
  names.forEach(visit);
  return ordered;
}

const libCache = new Map();
function readLib(name) {
  if (libCache.has(name)) return libCache.get(name);
  const file = path.join(LIB_DIR, `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`Unknown lib "${name}" (expected ${file})`);
  const code = stripForInline(fs.readFileSync(file, 'utf8'));
  libCache.set(name, code);
  return code;
}

function assemble(name) {
  const node = readNode(name);
  const libs = resolveLibs(node.requires);
  const banner =
    `/* =========================================================================\n` +
    ` * GENERATED — do not edit in the n8n UI.\n` +
    ` * Source: src/nodes/${name}.js` +
    (libs.length ? ` + src/lib/{${libs.join(',')}}.js` : '') + `\n` +
    ` * Edit the source and run \`npm run build\`; the tests cover this code.\n` +
    ` * ========================================================================= */\n`;

  const parts = ["'use strict';", banner];
  if (node.hoist) parts.push(node.hoist);
  for (const lib of libs) {
    parts.push(`// ----- inlined: src/lib/${lib}.js -----`);
    parts.push(readLib(lib));
  }
  parts.push(`// ----- node body: src/nodes/${name}.js -----`);
  parts.push(node.body);
  return parts.join('\n');
}

/** Verify the assembled code at least parses before we ship it. */
function assertParses(name, code) {
  try {
    // n8n wraps Code-node source in an async function body; mirror that so a
    // top-level `return` is legal here too.
    new Function(`return (async () => {\n${code}\n});`);
  } catch (err) {
    throw new Error(`Assembled code for "${name}" does not parse: ${err.message}`);
  }
}

const CODE_MARKER = /^@@code:([a-z0-9-]+)@@$/i;

/** Walk the template, swapping every "@@code:name@@" string for real source. */
function injectCode(value, used) {
  if (typeof value === 'string') {
    const m = CODE_MARKER.exec(value);
    if (!m) return value;
    const name = m[1];
    const code = assemble(name);
    assertParses(name, code);
    used.add(name);
    return code;
  }
  if (Array.isArray(value)) return value.map((v) => injectCode(v, used));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = injectCode(value[key], used);
    return out;
  }
  return value;
}

/** Structural checks that catch the mistakes a JSON schema would not. */
function validateWorkflow(fileName, wf) {
  const problems = [];
  const names = new Set();

  for (const node of wf.nodes || []) {
    if (names.has(node.name)) problems.push(`duplicate node name "${node.name}"`);
    names.add(node.name);
    if (!node.type) problems.push(`node "${node.name}" has no type`);
    if (!Array.isArray(node.position)) problems.push(`node "${node.name}" has no position`);
    if (node.type === 'n8n-nodes-base.code') {
      const js = node.parameters && node.parameters.jsCode;
      if (!js || /@@code:/.test(js)) problems.push(`code node "${node.name}" has no injected source`);
    }
  }

  for (const from of Object.keys(wf.connections || {})) {
    if (!names.has(from)) problems.push(`connection from unknown node "${from}"`);
    for (const outputs of Object.values(wf.connections[from])) {
      for (const branch of outputs || []) {
        for (const link of branch || []) {
          if (!names.has(link.node)) {
            problems.push(`connection "${from}" -> unknown node "${link.node}"`);
          }
        }
      }
    }
  }

  // Every node except triggers and disabled ones should be reachable.
  const reachable = new Set();
  const EXTRA_TRIGGERS = new Set(['n8n-nodes-base.emailReadImap']);
  const isTrigger = (n) => /trigger|webhook/i.test(n.type) || EXTRA_TRIGGERS.has(n.type);
  const triggerish = (wf.nodes || []).filter(isTrigger);
  const stack = triggerish.map((n) => n.name);
  while (stack.length) {
    const cur = stack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const conns = (wf.connections || {})[cur] || {};
    for (const outputs of Object.values(conns)) {
      for (const branch of outputs || []) {
        for (const link of branch || []) stack.push(link.node);
      }
    }
  }
  for (const node of wf.nodes || []) {
    if (!reachable.has(node.name) && !isTrigger(node) && !/stickyNote/i.test(node.type)) {
      problems.push(`node "${node.name}" is unreachable from any trigger`);
    }
  }

  if (problems.length) {
    throw new Error(`${fileName} failed validation:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * `--check` builds everything in memory and compares against the committed
 * output instead of writing. That is what stops someone tweaking a Code node
 * in the n8n UI, pasting the JSON back, and silently un-testing the logic.
 */
function main(argv) {
  const checkOnly = (argv || []).includes('--check');
  const templates = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!templates.length) throw new Error(`No templates found in ${TEMPLATE_DIR}`);

  const allUsed = new Set();
  const stale = [];
  for (const file of templates) {
    const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
    const used = new Set();
    const built = injectCode(template, used);
    validateWorkflow(file, built);

    const outPath = path.join(OUT_DIR, file);
    const rendered = JSON.stringify(built, null, 2) + '\n';

    if (checkOnly) {
      const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
      if (current !== rendered) stale.push(path.relative(ROOT, outPath));
    } else {
      fs.writeFileSync(outPath, rendered, 'utf8');
    }
    used.forEach((u) => allUsed.add(u));

    const codeNodes = (built.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code').length;
    console.log(
      `${checkOnly ? 'checked' : 'built'} ${path.relative(ROOT, outPath)}  ` +
      `(${(built.nodes || []).length} nodes, ${codeNodes} code nodes, ${used.size} sources inlined)`
    );
  }

  if (stale.length) {
    throw new Error(
      `Out of date with src/: ${stale.join(', ')}\nRun \`npm run build\` and commit the result.`
    );
  }

  // Fail loudly on a node source nobody references — that means a rename went
  // half-finished and some node is running stale inline code.
  const orphans = fs.readdirSync(NODE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .filter((n) => !allUsed.has(n));
  if (orphans.length) {
    throw new Error(`Unused node sources (not referenced by any template): ${orphans.join(', ')}`);
  }

  console.log(checkOnly ? 'check ok — workflows match src/' : 'build ok');
}

main(process.argv.slice(2));
