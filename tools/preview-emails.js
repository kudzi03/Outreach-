#!/usr/bin/env node
'use strict';
/**
 * preview-emails.js — print all three touches exactly as they will be sent.
 *
 *   npm run preview
 *   npm run preview -- --first-name="" --company="Bath Pros Inc."
 *
 * Read them out loud before you enable the campaign. This is the cheapest
 * quality check in the whole system.
 */
const templates = require('../src/lib/templates.js');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const lead = {
  'First Name': arg('first-name', 'Dana'),
  'Company Name': arg('company', 'Maple Ridge Kitchens, LLC'),
  threadSubject: 'quick question / Maple Ridge Kitchens',
  messageId: '<b7f3e1c2-0000-4000-8000-abcdef012345@mtasv.net>'
};

const cfg = {
  senderName: process.env.SENDER_NAME || 'Nat Marlowe',
  senderCompany: process.env.SENDER_COMPANY || 'Marlowe Automations',
  senderPostalAddress: process.env.SENDER_POSTAL_ADDRESS || '1200 W 6th St, Suite 200, Austin, TX 78703'
};

const LABELS = {
  email1: 'TOUCH 1  ·  Day 1',
  followup1: 'TOUCH 2  ·  Day 4  (3 business days later, threaded reply)',
  followup2: 'TOUCH 3  ·  Day 8  (4 business days later, threaded reply)'
};

const resolved = templates.firstNameOf(lead);
console.log('='.repeat(74));
console.log(`Lead: First Name=${JSON.stringify(lead['First Name'])}  Company=${JSON.stringify(lead['Company Name'])}`);
console.log(`Personalization: ${resolved ? `first name resolved to "${resolved}"` : 'NO usable first name — fallback copy'}`);
console.log('='.repeat(74));

for (const touch of ['email1', 'followup1', 'followup2']) {
  const msg = templates.buildMessage(touch, lead, cfg);
  console.log(`\n\x1b[1m${LABELS[touch]}\x1b[0m`);
  console.log('-'.repeat(74));
  console.log(`Subject: ${msg.subject}`);
  for (const h of msg.headers) console.log(`${h.Name}: ${h.Value}`);
  console.log('-'.repeat(74));
  console.log(msg.textBody);
  console.log(`[${msg.textBody.length} characters, plain text, no links, no tracking]`);
}
