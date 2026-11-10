#!/usr/bin/env node
// Element-by-element inventory of a rendered page with objective flags (name/role, contrast, target size,
// duplicates, focus, copy smells). Judgement calls (position, meaning, copy, colour role) stay with the auditor.
// Playwright is resolved from frontend/node_modules. Run with --help for options.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const HELP = `Usage: node element-inventory.mjs --url <http(s) url | file path> [options]
  --viewport 1440x900     --theme light|dark (prefers-color-scheme only)   --reduced-motion   --forced-colors (emulates Windows high contrast: colors are forced, shadows and gradients dropped)
  --wait <ms|selector>    --scope <css selector>   --steps "click:<sel>;fill:<sel>=<text>;press:<key>;hover:<sel>;wait:<ms>" (UI actions, 5 s each)
  --init-script <js file> (runs before the page's scripts: theme switch, stubbed fetch)   --storage-state <json> (saved cookies and localStorage)
  --keyboard [--max-tab 200]   tab forward and backward (Shift+Tab): order, focus indicator, obscured focus, traps
  --rows interactive|all  --limit 150   --summary-only   --detail-limit 10 (lines per rule in Details; 0 = all)
  --out <json file>  --md <markdown file>  --screenshot <png> [--annotate] [--full-page]
  --browser msedge|chrome|chromium   --strict (exit 1 on error flags)   --selftest`;

const { values } = parseArgs({ options: {
  url: { type: 'string' }, viewport: { type: 'string', default: '1440x900' }, theme: { type: 'string', default: 'light' },
  'init-script': { type: 'string' }, 'storage-state': { type: 'string' },
  'reduced-motion': { type: 'boolean', default: false }, 'forced-colors': { type: 'boolean', default: false }, wait: { type: 'string' }, scope: { type: 'string' }, steps: { type: 'string' },
  keyboard: { type: 'boolean', default: false }, 'max-tab': { type: 'string', default: '200' }, rows: { type: 'string', default: 'interactive' },
  limit: { type: 'string', default: '150' }, 'detail-limit': { type: 'string', default: '10' }, 'summary-only': { type: 'boolean', default: false }, out: { type: 'string' }, md: { type: 'string' },
  screenshot: { type: 'string' }, annotate: { type: 'boolean', default: false }, 'full-page': { type: 'boolean', default: false },
  browser: { type: 'string' }, strict: { type: 'boolean', default: false }, selftest: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) { console.log(HELP); process.exit(0); }
// The style properties compared before and after a keyboard focus to decide whether focus is drawn. Under forced colors every color is
// replaced by a system color and focus recolors outline and border even when nothing is painted, so only what is drawn is compared.
const focusProps = forced => forced
  ? ['outlineStyle', 'outlineWidth', 'outlineOffset', 'borderTopWidth', 'textDecorationLine']
  : ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine'];
if (values.selftest) {
  values.url = join(here, '..', 'assets', 'audit-fixture.html');
  values.keyboard = true;
}
if (!values.url) { console.error(HELP); process.exit(2); }

const require = createRequire(join(root, 'frontend', 'package.json'));
let chromium;
try { ({ chromium } = require('@playwright/test')); } catch { console.error('Cannot resolve @playwright/test. Run "npm install --prefix frontend" first.'); process.exit(2); }

// ---------- in-page collection (serialised by Playwright; must stay self-contained) ----------
function collect(options) {
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=option],[role=slider],[role=spinbutton],[role=textbox],[role=searchbox],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable="true"]';
  const SEMANTIC = 'h1,h2,h3,h4,h5,h6,[role=heading],label,legend,caption,th,img,[role=img],svg[aria-label],[role=status],[role=alert],[aria-live=polite],[aria-live=assertive],dialog,[role=dialog],[role=alertdialog]';
  const LANDMARK = 'header,nav,main,aside,footer,form,dialog,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo],[role=search],[role=region],[role=dialog],[role=alertdialog],[role=toolbar],[role=tablist],[role=menu],[role=menubar],[role=listbox],[role=tree],[role=grid],[role=table],table,section[aria-label],section[aria-labelledby]';
  const FOCUS_PROPS = options.focusProps ?? ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine'];
  const scope = options.scope ? document.querySelector(options.scope) : document.body;
  if (!scope) throw new Error('Scope selector matched nothing: ' + options.scope);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => { ctx2d.clearRect(0, 0, 1, 1); ctx2d.fillStyle = '#000'; ctx2d.fillStyle = value; ctx2d.fillRect(0, 0, 1, 1); const d = ctx2d.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const probe = document.createElement('div');
  probe.style.cssText = 'background:Canvas;position:absolute;width:0;height:0';
  document.body.appendChild(probe);
  const canvasColor = rgba(getComputedStyle(probe).backgroundColor);
  probe.remove();

  const normalise = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const isHidden = n => { const cs = getComputedStyle(n); return cs.display === 'none' || cs.visibility === 'hidden' || n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true'; };
  // `referenced` marks text reached through aria-labelledby or <label for>: such targets count even when hidden
  // (design-system icon buttons point aria-labelledby at a display:none tooltip).
  const labelText = (el, referenced = false) => {
    let out = '';
    const walk = n => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1 || (isHidden(n) && !(referenced && n === el))) return;
      const tag = n.tagName.toLowerCase();
      if (['input', 'select', 'textarea', 'script', 'style'].includes(tag)) return;
      if (n !== el && n.getAttribute('aria-label')) { out += ' ' + n.getAttribute('aria-label') + ' '; return; }
      if (tag === 'img') { out += ' ' + (n.getAttribute('alt') ?? '') + ' '; return; }
      if (tag === 'svg') { const t = n.querySelector(':scope > title'); out += t ? ' ' + t.textContent + ' ' : ''; return; }
      n.childNodes.forEach(walk);
    };
    walk(el);
    return normalise(out);
  };
  const nameOf = el => {
    const tag = el.tagName.toLowerCase();
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = normalise(by.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => labelText(n, true)).join(' ')); if (t) return { name: t, source: 'aria-labelledby' }; }
    const aria = normalise(el.getAttribute('aria-label')); if (aria) return { name: aria, source: 'aria-label' };
    if (el.labels?.length) { const t = normalise([...el.labels].map(l => labelText(l, true)).join(' ')); if (t) return { name: t, source: 'label' }; }
    if (tag === 'img') return { name: normalise(el.getAttribute('alt')), source: 'alt' };
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return { name: normalise(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), source: 'value' };
      if (type === 'image') return { name: normalise(el.alt), source: 'alt' };
    }
    if (tag === 'svg') { const t = el.querySelector(':scope > title'); if (t) return { name: normalise(t.textContent), source: 'svg-title' }; }
    const content = labelText(el); if (content) return { name: content, source: 'content' };
    const title = normalise(el.getAttribute('title')); if (title) return { name: title, source: 'title' };
    const placeholder = normalise(el.getAttribute('placeholder')); if (placeholder) return { name: placeholder, source: 'placeholder' };
    return { name: '', source: 'none' };
  };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'file-input' };
  const IMPLICIT = { button: 'button', summary: 'button', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo', header: 'banner', table: 'table', th: 'columnheader', dialog: 'dialog', form: 'form', label: 'label', legend: 'legend', caption: 'caption', svg: 'img' };
  const roleOf = el => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic-a';
    if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] ?? 'textbox';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    return IMPLICIT[tag] ?? tag;
  };
  const regionOf = el => {
    const parts = [];
    for (let p = el.parentElement; p && parts.length < 3; p = p.parentElement) {
      if (!p.matches(LANDMARK)) continue;
      const label = normalise(p.getAttribute('aria-label')).slice(0, 18);
      parts.unshift((p.getAttribute('role') || p.tagName.toLowerCase()) + (label ? `"${label}"` : ''));
    }
    return parts.join(' > ') || 'page';
  };
  const selectorOf = el => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const testid = n.getAttribute('data-testid');
      if (n.id && !/\d{4,}/.test(n.id)) { parts.unshift(`${s}#${CSS.escape(n.id)}`); break; }
      if (testid) { parts.unshift(`${s}[data-testid="${testid}"]`); break; }
      const classes = [...n.classList].filter(c => !/\d{3,}/.test(c)).slice(0, 2);
      if (classes.length) s += '.' + classes.map(c => CSS.escape(c)).join('.');
      else if (n.parentElement) { const same = [...n.parentElement.children].filter(x => x.tagName === n.tagName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`; }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const backdrop = el => {
    const layers = []; let image = false; let opacity = 1;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= parseFloat(cs.opacity);
      const bg = rgba(cs.backgroundColor);
      if (cs.backgroundImage !== 'none') image = true;
      if (bg[3] > 0) { layers.push(bg); if (bg[3] === 1) break; }
    }
    let base = layers.length && layers.at(-1)[3] === 1 ? layers.pop() : canvasColor;
    while (layers.length) base = over(layers.pop(), base);
    return { bg: base, image, opacity };
  };

  // Images, video and canvas that come earlier in the document and cover the centre of the text (hero photos behind a
  // headline) make the real backdrop unknowable, so contrast is reported as unverifiable instead of measured.
  const mediaList = [...scope.querySelectorAll('img,video,canvas,picture')].map(m => ({ m, r: m.getBoundingClientRect() })).filter(x => x.r.width > 8 && x.r.height > 8);
  const overMedia = (el, r) => {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return mediaList.some(({ m, r: mr }) => !m.contains(el) && !el.contains(m) && (m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom);
  };
  const seen = new Set();
  // A link whose ::before or ::after is absolutely positioned at inset 0 is clickable over its whole containing card.
  const stretchedBox = el => {
    if (!(el.tagName === 'A' || el.tagName === 'BUTTON' || ['link', 'button'].includes(el.getAttribute('role')))) return undefined;
    for (const pseudo of ['::after', '::before']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.content === 'normal' || !['absolute', 'fixed'].includes(ps.position)) continue;
      if (!['top', 'right', 'bottom', 'left'].every(k => parseFloat(ps[k]) === 0)) continue;
      let holder = el;
      while (holder && getComputedStyle(holder).position === 'static') holder = holder.parentElement;
      if (!holder || holder === el || holder === document.body || holder === document.documentElement) continue;
      const hr = holder.getBoundingClientRect();
      return { x: Math.round(hr.x + scrollX), y: Math.round(hr.y + scrollY), w: Math.round(hr.width), h: Math.round(hr.height) };
    }
    return undefined;
  };
  // Text that is read by assistive technology but cannot be seen must not count as a visible label: a visually hidden
  // child span (the common "sr-only" pattern inside icon buttons), image replacement with a large negative text-indent,
  // text positioned off the page, or text clipped away by the element's own overflow.
  const styleCache = new WeakMap();
  const styleOf = n => { if (!styleCache.has(n)) styleCache.set(n, getComputedStyle(n)); return styleCache.get(n); };
  const hiddenBox = (cs, r) => (r.width <= 2 && r.height <= 2 && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) || /^inset\(50%/.test(cs.clipPath);
  const shownText = (el, cs, r) => {
    const clipsSelf = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const page = document.documentElement;
    const parts = []; let total = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const value = normalise(n.nodeValue);
      if (!value) continue;
      total++;
      let hiddenAncestor = false;
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (hiddenBox(styleOf(p), p.getBoundingClientRect())) { hiddenAncestor = true; break; }
      if (hiddenAncestor) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const seenGlyphs = [...range.getClientRects()].some(q => {
        if (q.width < 1 || q.height < 1) return false;
        const reachable = q.right + scrollX > 1 && q.bottom + scrollY > 1 && q.left + scrollX < page.scrollWidth && q.top + scrollY < page.scrollHeight;
        const inside = !clipsSelf || (Math.min(q.right, r.right) - Math.max(q.left, r.left) > 1 && Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 1);
        return reachable && inside;
      });
      if (seenGlyphs) parts.push(value);
    }
    return { total, shown: parts.length, text: parts.join(' ') };
  };
  const uids = new WeakMap();
  let uidCounter = 0;
  const uid = n => { if (!uids.has(n)) uids.set(n, ++uidCounter); return uids.get(n); };
  const records = [];
  const add = (el, kind) => {
    if (seen.has(el)) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
    seen.add(el);
    records.push({ el, kind, r, cs });
  };
  scope.querySelectorAll(INTERACTIVE).forEach(el => add(el, 'interactive'));
  scope.querySelectorAll(SEMANTIC).forEach(el => add(el, 'semantic'));
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !normalise(node.nodeValue) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'].includes(parent.tagName)) continue;
    if (parent.closest(INTERACTIVE) || parent.closest(SEMANTIC)) continue;
    add(parent, 'text');
  }

  const sx = scrollX, sy = scrollY;
  const elements = records.map(({ el, kind, r, cs }, index) => {
    const id = `E${String(index + 1).padStart(3, '0')}`;
    el.setAttribute('data-audit-id', id);
    const { name, source } = nameOf(el);
    // Counters and quoted text in ::before or ::after can name a control; icon-font glyphs (private-use characters) do not.
    const nameFromCss = !name && ['::before', '::after'].some(p => { const c = getComputedStyle(el, p).content; return /^(counters?|attr)\(/.test(c) || (/^["']/.test(c) && /[\p{L}\p{N}]/u.test(c)); });
    const { bg, image, opacity } = backdrop(el);
    const fgRaw = rgba(cs.color);
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const fullText = normalise(el.innerText ?? el.textContent);
    let text = fullText;
    if (fullText && !hiddenBox(cs, r) && !['SELECT', 'INPUT', 'TEXTAREA'].includes(el.tagName) && (kind === 'interactive' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || parseFloat(cs.textIndent) < 0)) {
      const seenText = shownText(el, cs, r);
      if (seenText.shown < seenText.total) text = seenText.text;
    }
    const parentBox = el.parentElement ? backdrop(el.parentElement).bg : canvasColor;
    const border = rgba(cs.borderTopColor);
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && border[3] > 0;
    // The inline exception of WCAG 2.5.8 covers a target inside a sentence. Links between "|" or "·" separators form a list, not a sentence.
    const wordsAround = n => !!n && n.nodeType === 3 && /[\p{L}\p{N}]/u.test(n.nodeValue);
    const inlineInText = cs.display === 'inline' && (wordsAround(el.previousSibling) || wordsAround(el.nextSibling));
    const rowAncestor = el.closest('tr,li,[role=row],[role=listitem],article');
    const container = rowAncestor?.closest('table,ul,ol,[role=grid],[role=treegrid],[role=table],[role=list],[role=listbox]');
    const tagName = el.tagName.toLowerCase();
    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
    const labelled = ['select', 'textarea'].includes(tagName) || (tagName === 'input' && !['button', 'submit', 'reset', 'image'].includes(inputType));
    return {
      id, kind, tag: el.tagName.toLowerCase(), role: roleOf(el), name, nameSource: source, nameFromCss: nameFromCss || undefined, text: text.slice(0, 160), hiddenText: text !== fullText ? fullText.slice(0, 80) : undefined,
      region: regionOf(el), selector: selectorOf(el), domIndex: index,
      box: { x: Math.round(r.x + sx), y: Math.round(r.y + sy), w: Math.round(r.width), h: Math.round(r.height) },
      hit: kind === 'interactive' ? stretchedBox(el) : undefined,
      type: el.getAttribute('type') || undefined, href: el.tagName === 'A' ? el.href : undefined,
      placeholder: el.getAttribute('placeholder') || undefined, title: el.getAttribute('title') || undefined,
      hasLabel: !!(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      describedBy: !!el.getAttribute('aria-describedby'), tabindex: el.getAttribute('tabindex') ?? undefined,
      radioGroup: el instanceof HTMLInputElement && el.type === 'radio' && el.name ? `${[...document.forms].indexOf(el.form)}|${el.name}` : undefined,
      inert: !!el.closest('[inert]'), ariaHidden: !!el.closest('[aria-hidden=true]'),
      state: ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-current'].map(a => el.hasAttribute(a) ? `${a.slice(5)}=${el.getAttribute(a)}` : '').filter(Boolean).join(' ') || undefined,
      hasIcon: !!el.querySelector('svg,img,i,[class*=icon]'), iconOnly: !!el.querySelector('svg,img') && !text,
      emoji: /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u.test(text), heading: /^h[1-6]$/.test(el.tagName.toLowerCase()) ? Number(el.tagName[1]) : el.getAttribute('role') === 'heading' && el.getAttribute('aria-level') ? Number(el.getAttribute('aria-level')) : undefined,
      style: { size, weight, family: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), lineHeight: cs.lineHeight, fg: hex(fg), bg: hex(bg), radius: cs.borderTopLeftRadius, shadow: cs.boxShadow === 'none' ? undefined : cs.boxShadow, cursor: cs.cursor, pointerEvents: cs.pointerEvents, display: cs.display, transform: cs.textTransform !== 'none' ? cs.textTransform : undefined },
      contrast: text || kind !== 'text' ? Math.round(ratio(fg, bg) * 100) / 100 : undefined, large, bgUncertain: image || overMedia(el, r),
      controlContrast: hasBorder ? Math.round(ratio(border, parentBox) * 100) / 100 : undefined,
      truncated: cs.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1 && !!text && !((r.width <= 2 && r.height <= 2) || /^inset\(50%/.test(cs.clipPath)), inlineInText,
      visuallyHidden: (r.width <= 2 && r.height <= 2 && cs.overflow !== 'visible') || /^inset\(50%/.test(cs.clipPath),
      transitionAll: cs.transitionProperty === 'all' && cs.transitionDuration.split(',').some(d => parseFloat(d) > 0),
      collectionKey: container ? uid(container) : undefined, collectionRow: rowAncestor ? uid(rowAncestor) : undefined,
      visibleLabel: labelled ? normalise([...(el.labels ?? [])].map(l => labelText(l)).join(' ')) : undefined,
      focusBefore: kind === 'interactive' ? FOCUS_PROPS.map(p => cs[p]).join('|') : undefined,
      nested: kind === 'interactive' && !!el.parentElement?.closest('a[href],button,[role=button],[role=link]'),
    };
  });

  const headings = elements.filter(e => e.heading).map(e => ({ id: e.id, level: e.heading, text: e.text }));
  const census = {};
  const count = (key, value) => { if (value === undefined || value === 'rgba(0, 0, 0, 0)') return; (census[key] ??= {})[value] = (census[key][value] ?? 0) + 1; };
  elements.filter(e => e.text && !e.visuallyHidden).forEach(e => { count('fontSize', `${Math.round(e.style.size * 100) / 100}px`); count('fontWeight', String(e.style.weight)); count('fontFamily', e.style.family); count('textColor', e.style.fg); });
  elements.forEach(e => { if (e.style.bg) count('backgroundColor', e.style.bg); if (e.kind === 'interactive') { count('radius', e.style.radius); count('shadow', e.style.shadow); } });
  // Budgets for radius and shadow concern every visible surface, not only controls.
  document.querySelectorAll('body *').forEach(n => {
    const cs = getComputedStyle(n), r = n.getBoundingClientRect();
    if (!r.width || !r.height || cs.visibility === 'hidden') return;
    if (cs.borderTopLeftRadius !== '0px') count('surfaceRadius', cs.borderTopLeftRadius);
    if (cs.boxShadow !== 'none') count('surfaceShadow', cs.boxShadow);
  });
  return { title: document.title, lang: document.documentElement.lang, elements, headings, census, canvas: hex(canvasColor), pageBackground: hex(backdrop(document.body).bg), docTitle: normalise(document.title), scoped: !!options.scope };
}

// ---------- analysis ----------
const GENERIC = /^(여기|여기를 클릭|클릭|더보기|더 보기|자세히|자세히 보기|바로가기|링크|click here|here|more|read more|learn more|link|details)$/i;
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'listbox', 'option', 'file-input']);
const norm = s => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const squash = s => norm(s).replace(/[\s·•,.:;|/()[\]\-–—]+/g, '');
// Roles whose visible label is their own text. A combobox or spin button shows its current value, which is not a label.
const NAMED_BY_CONTENT = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option']);
// Links that differ only by a trailing slash lead to the same page.
const canon = href => { try { const u = new URL(href); const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname; return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`; } catch { return href ?? ''; } };
// A dark run whose page background is still light means the page ignored prefers-color-scheme.
function themeIgnored(theme, hexColour) {
  if (theme !== 'dark' || !/^#[0-9a-f]{6}$/i.test(hexColour ?? '')) return false;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hexColour.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

function analyse(data, viewport, { theme } = {}) {
  const flags = [];
  const flag = (e, rule, severity, gate, message) => { const f = { id: e?.id, rule, severity, gate, message }; flags.push(f); if (e) (e.flags ??= []).push(rule); };
  // One flag per group of elements, so a repeated link text does not produce hundreds of identical lines.
  const flagGroup = (list, rule, severity, gate, message) => { flags.push({ id: list[0].id, ids: list.map(e => e.id), rule, severity, gate, message }); list.forEach(e => (e.flags ??= []).push(rule)); };
  const els = data.elements;
  // aria-hidden content is invisible to assistive technology, so name and size checks do not apply to it.
  const targets = els.filter(e => e.kind === 'interactive' && INTERACTIVE_ROLES.has(e.role) && e.style.pointerEvents !== 'none' && !e.inert && !e.ariaHidden);
  for (const e of els.filter(x => x.kind === 'interactive' && INTERACTIVE_ROLES.has(x.role) && x.ariaHidden && !x.inert && !x.disabled && x.tabindex !== '-1' && !x.visuallyHidden && x.box.w > 2 && x.box.h > 2)) flag(e, 'A11Y-ARIA-HIDDEN-FOCUSABLE', 'warn', 'G8', 'focusable control inside aria-hidden="true": keyboard users reach it, assistive technology cannot see it (WCAG 4.1.2); add inert or tabindex="-1", or remove aria-hidden');

  for (const e of targets) {
    if (!e.name && e.nameFromCss) flag(e, 'A11Y-NAME-FROM-CSS-CONTENT', 'info', 'G3', `${e.role} takes its name from CSS generated content (::before or ::after); confirm the spoken name with a screen reader`);
    else if (!e.name) flag(e, 'A11Y-NO-NAME', 'error', 'G3', `${e.role} has no accessible name (${e.iconOnly ? 'icon-only' : 'no text or label'})`);
    else if (e.iconOnly) flag(e, 'ICON-ONLY', 'info', 'G3', `icon-only control named "${e.name}"; confirm the icon is universally understood or add visible text`);
    const visible = norm(e.visibleLabel ?? (NAMED_BY_CONTENT.has(e.role) ? e.text : ''));
    if (e.name && visible && ['aria-label', 'aria-labelledby'].includes(e.nameSource) && !squash(e.name).includes(squash(visible))) flag(e, 'A11Y-LABEL-IN-NAME', 'error', 'G3', `visible text "${e.visibleLabel ?? e.text}" is not contained in accessible name "${e.name}" (WCAG 2.5.3)`);
    if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(e.role) && e.placeholder && !e.hasLabel) flag(e, 'A11Y-PLACEHOLDER-LABEL', 'warn', 'G3', 'placeholder is the only label; it disappears on input');
    if (e.tag === 'a' && e.role === 'link' && /#$|^javascript:/i.test(e.href ?? '')) flag(e, 'A11Y-NONNATIVE-CONTROL', 'warn', 'G3', 'link with href="#" or javascript:; fine only if a click scrolls to the top or an in-page target, otherwise use <button> for actions');
    if (e.tabindex !== undefined && Number(e.tabindex) > 0) flag(e, 'A11Y-TABINDEX-POSITIVE', 'warn', 'G8', `tabindex=${e.tabindex} overrides the natural tab order`);
    if (e.nested) flag(e, 'A11Y-NESTED-INTERACTIVE', 'error', 'G3', 'interactive element nested inside another interactive element');
    if (['div', 'span', 'li', 'td'].includes(e.tag) && ['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch'].includes(e.role)) flag(e, 'A11Y-NONNATIVE-CONTROL', 'warn', 'G3', `<${e.tag} role=${e.role}> must replicate native keyboard and focus behaviour; prefer <button>/<a>`);
    if (e.tag === 'a' && e.role === 'button') flag(e, 'A11Y-NONNATIVE-CONTROL', 'warn', 'G3', '<a role=button>: use <button> for actions, <a href> for navigation');
    if (e.role === 'link' || e.role === 'button') {
      if (GENERIC.test(e.name)) flag(e, 'COPY-GENERIC-LINK', 'warn', 'G5', `generic label "${e.name}" is ambiguous out of context`);
      if ([...e.name].length > 40) flag(e, 'COPY-LONG-LABEL', 'info', 'G5', `label is ${[...e.name].length} characters`);
    }
    if (e.emoji && e.text) flag(e, 'COPY-EMOJI-ICON', 'info', 'G5', 'emoji used as an icon; use one icon set so meaning and rendering stay consistent');
    if (e.disabled && !e.describedBy && !e.title && !/current=(?!false)/.test(e.state ?? '')) flag(e, 'DISABLED-NO-REASON', 'info', 'G8', 'disabled control without a nearby reason');
    if (e.placeholder && e.hasLabel && norm(e.placeholder) === norm(e.name)) flag(e, 'COPY-PLACEHOLDER-REPEATS-LABEL', 'info', 'G5', 'placeholder repeats the label');
    if (e.title && norm(e.title) === norm(e.text)) flag(e, 'COPY-TITLE-REDUNDANT', 'info', 'G5', 'title attribute repeats visible text');
  }

  for (const e of els) {
    if (e.visuallyHidden) continue; // screen-reader-only text is not seen, so contrast and size do not apply
    if (e.text && e.contrast !== undefined && !e.disabled) {
      const need = e.large ? 3 : 4.5;
      if (e.bgUncertain) flag(e, 'COLOR-CONTRAST-UNVERIFIABLE', 'info', 'G6', 'text over image or gradient; measure manually');
      else if (e.contrast < need) flag(e, 'COLOR-TEXT-CONTRAST', e.ariaHidden ? 'info' : 'error', 'G6', `contrast ${e.contrast}:1 (${e.style.fg} on ${e.style.bg}) is below ${need}:1${e.ariaHidden ? ' (inside aria-hidden content: decoration and text that is part of a picture are exempt, but sighted users may still read it)' : ''}`);
    }
    if (e.text && e.style.size < 11) flag(e, 'TEXT-TOO-SMALL', e.ariaHidden ? 'info' : 'warn', 'G7', `${e.style.size}px text`);
    else if (e.text && e.style.size < 12) flag(e, 'TEXT-TOO-SMALL', 'info', 'G7', `${e.style.size}px text`);
    if (e.truncated && !e.title) flag(e, 'COPY-TRUNCATED-NO-FALLBACK', 'warn', 'G5', 'text is clipped and has no title; verify the full value is reachable by keyboard and touch');
    if (e.transitionAll) flag(e, 'MOTION-TRANSITION-ALL', 'info', 'G8', '"transition: all" animates every property; list the properties explicitly');
    if (['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(e.role) && e.controlContrast !== undefined && e.controlContrast < 3) flag(e, 'COLOR-CONTROL-BOUNDARY', 'warn', 'G6', `control border contrast ${e.controlContrast}:1 against its surroundings (WCAG 1.4.11 needs 3:1 when the border is the only cue)`);
  }

  // WCAG 2.5.8: undersized targets pass only if their 24px circles hit no other target.
  // A stretched link (a ::before or ::after that covers its card) is judged by the card it makes clickable.
  const boxOf = e => e.hit ?? e.box;
  const centre = e => { const b = boxOf(e); return [b.x + b.w / 2, b.y + b.h / 2]; };
  const contains = (a, b) => { const p = boxOf(a), q = boxOf(b); return p.x <= q.x && p.y <= q.y && p.x + p.w >= q.x + q.w && p.y + p.h >= q.y + q.h; };
  const sized = targets.filter(e => !e.inlineInText && !e.disabled && !e.visuallyHidden && !(['checkbox', 'radio'].includes(e.role) && e.hasLabel));
  for (const e of sized.filter(t => boxOf(t).w < 24 || boxOf(t).h < 24)) {
    const [cx, cy] = centre(e);
    const hit = sized.find(o => {
      if (o === e || contains(o, e) || contains(e, o)) return false;
      const ob = boxOf(o);
      if (ob.w < 24 || ob.h < 24) { const [ox, oy] = centre(o); return Math.hypot(cx - ox, cy - oy) < 24; }
      const nx = Math.max(ob.x, Math.min(cx, ob.x + ob.w)), ny = Math.max(ob.y, Math.min(cy, ob.y + ob.h));
      return Math.hypot(cx - nx, cy - ny) < 12;
    });
    const b = boxOf(e);
    if (hit) flag(e, 'SIZE-TARGET-24', 'error', 'G7', `${b.w}×${b.h}px target is too close to ${hit.id} (WCAG 2.5.8 spacing exception fails)`);
    else flag(e, 'SIZE-TARGET-24', 'info', 'G7', `${b.w}×${b.h}px target passes only through the spacing exception`);
  }
  if (viewport.width <= 480) for (const e of targets.filter(t => !t.inlineInText && !t.visuallyHidden && (boxOf(t).w < 44 || boxOf(t).h < 44) && boxOf(t).w >= 24 && boxOf(t).h >= 24)) flag(e, 'SIZE-TARGET-44', 'info', 'G7', `${boxOf(e).w}×${boxOf(e).h}px touch target is below the 44px design goal`);

  // headings
  const hs = data.headings;
  if (themeIgnored(theme, data.pageBackground)) flag(null, 'THEME-NO-CHANGE', 'info', 'G6', `dark run, but the page background is still light (${data.pageBackground}): the page ignored prefers-color-scheme. If it has its own theme switch, set it with --init-script and run again; otherwise its dark theme is missing`);
  if (!data.scoped && !hs.some(h => h.level === 1)) flag(null, 'A11Y-NO-H1', 'info', 'G3', 'no h1 on the page');
  if (!data.scoped && hs.filter(h => h.level === 1).length > 1) flag(null, 'A11Y-MULTI-H1', 'info', 'G3', 'more than one h1');
  hs.forEach((h, i) => { if (i > 0 && h.level - hs[i - 1].level > 1) flag(els.find(e => e.id === h.id), 'A11Y-HEADING-SKIP', 'warn', 'G3', `heading jumps from h${hs[i - 1].level} to h${h.level}`); });

  // duplicates
  const duplicates = [];
  const group = (list, keyOf) => { const m = new Map(); list.forEach(e => { const k = keyOf(e); if (k) (m.get(k) ?? m.set(k, []).get(k)).push(e); }); return [...m.entries()].filter(([, v]) => v.length > 1); };
  for (const [key, list] of group(targets.filter(e => e.name), e => `${e.role}|${norm(e.name)}`)) {
    const rows = new Set(list.map(e => `${e.collectionKey}#${e.collectionRow}`));
    const inCollection = list.every(e => e.collectionKey) && new Set(list.map(e => e.collectionKey)).size === 1 && rows.size === list.length;
    const same = e => canon(e.href);
    const targetsDiffer = list[0].role === 'link' && new Set(list.map(same)).size > 1;
    duplicates.push({ kind: inCollection ? 'collection-repeat' : 'same-name-role', key: key.replace('|', ' "') + '"', count: list.length, ids: list.map(e => e.id), regions: [...new Set(list.map(e => e.region))] });
    if (!inCollection) flagGroup(list, targetsDiffer ? 'DUP-SAME-NAME-DIFF-TARGET' : 'DUP-SAME-NAME-ROLE', targetsDiffer ? 'warn' : 'info', 'G4', targetsDiffer ? `${list.length}× link text "${list[0].name}" leads to ${new Set(list.map(same)).size} different destinations (WCAG 2.4.4 / 3.2.4)` : `${list.length}× "${list[0].name}" (${list[0].role}); confirm distinct moment, audience or outcome`);
  }
  for (const [href, list] of group(targets.filter(e => e.role === 'link' && e.href), e => (/#$|^javascript:/i.test(e.href) ? null : canon(e.href)))) {
    const names = new Set(list.map(e => norm(e.name)));
    // "card" and "cards" are inflections of one name, not two names for one destination.
    const stem = e => norm(e.name).split(' ').map(w => (w.length > 3 ? w.replace(/s$/, '') : w)).join(' ');
    if (new Set(list.map(stem)).size > 1) { duplicates.push({ kind: 'same-target-different-name', key: href, count: list.length, ids: list.map(e => e.id), names: [...names] }); flagGroup(list, 'DUP-SAME-TARGET-DIFF-NAME', 'info', 'G4', `same destination is labelled ${[...names].map(n => `"${n}"`).join(' / ')}; one concept should have one name (WCAG 3.2.4)`); }
  }
  const echoes = group(els.filter(e => (e.heading || ['tab', 'link', 'menuitem'].includes(e.role) && /current|selected/.test(e.state ?? '')) && e.text), e => norm(e.text));
  for (const [text, list] of echoes) if (list.length + (norm(data.docTitle).includes(text) ? 1 : 0) >= 3) duplicates.push({ kind: 'structural-echo', key: text, count: list.length, ids: list.map(e => e.id) });
  for (const [text, list] of group(els.filter(e => e.heading), e => norm(e.text))) if (list.length > 1) duplicates.push({ kind: 'repeated-heading', key: text, count: list.length, ids: list.map(e => e.id) });
  return { flags, duplicates };
}

// ---------- keyboard traversal ----------
// Smooth scrolling would make the covered-focus check run while the page is still moving, so it is switched off
// for the traversal and the position is awaited until it is stable. A constructable stylesheet is used instead of
// addStyleTag because strict Content-Security-Policy headers (for example on gov.uk) block injected <style> elements.
async function traverse(page, byId, max, reverse = false, scopeSelector, forced = values['forced-colors']) {
  await page.evaluate(() => {
    const css = '*,*::before,*::after{scroll-behavior:auto !important}';
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.__auditSheet = sheet;
    } catch {
      window.__auditScrollBehavior = document.documentElement.style.getPropertyValue('scroll-behavior');
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
    }
  });
  await page.evaluate(backwards => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0, backwards ? document.documentElement.scrollHeight : 0); }, reverse);
  const order = []; const visited = new Set(); let previous; let stuck = 0; let note; let presses = 0;
  for (let i = 0; i < max; i++) {
    presses++;
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
    await page.evaluate(async () => {
      let last = `${scrollX}|${scrollY}`;
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const now = `${scrollX}|${scrollY}`;
        if (now === last) break;
        last = now;
      }
    });
    const info = await page.evaluate(({ props, scopeSel }) => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { wrapped: true };
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const top = document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1));
      // Focusable controls the inventory skipped (opacity 0, zero size: custom radios and checkboxes) still count as tab stops.
      let key = el.getAttribute('data-audit-id');
      const untagged = !key;
      if (untagged) { key = el.getAttribute('data-audit-untagged'); if (!key) { window.__auditUntagged = (window.__auditUntagged ?? 0) + 1; key = `U${window.__auditUntagged}`; el.setAttribute('data-audit-untagged', key); } }
      const name = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      // A control that cannot scroll into view (closed drawer, off-canvas menu) is outside the viewport, not covered.
      const offscreen = r.width > 0 && r.height > 0 && (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight);
      return { id: key, untagged, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') ?? undefined, name, hidden: untagged && (cs.opacity === '0' || r.width <= 2 || r.height <= 2),       after: props.map(p => cs[p]).join('|'), offscreen, covered: !offscreen && !!top && top !== el && !el.contains(top) && !top.contains(el), outside: !!scopeSel && !document.querySelector(scopeSel)?.contains(el) };
          }, { props: focusProps(forced), scopeSel: scopeSelector });
    if (info.wrapped) { if (i > 0) { note = 'focus left the page content (wrapped to browser UI or body)'; break; } continue; }
    // Composite controls (date and time inputs, media controls) keep focus on one element for several Tab presses.
    if (info.id === previous) {
      stuck++;
      if (order.length) order[order.length - 1].stops = stuck + 1;
      if (stuck >= 8) { note = `keyboard trap suspected at ${info.id}`; order.push({ id: info.id, trap: true, untagged: info.untagged }); break; }
      continue;
    }
    stuck = 0;
    if (visited.has(info.id)) { note = 'cycle completed'; break; }
    previous = info.id; visited.add(info.id);
    order.push({ id: info.id, tag: info.tag, type: info.type, name: info.name, untagged: info.untagged, outside: info.outside, hiddenControl: info.hidden, indicator: info.untagged ? undefined : byId.get(info.id)?.focusBefore !== info.after, covered: info.covered, offscreen: info.offscreen });
  }
  if (!note && presses >= max) note = `tab walk stopped at --max-tab ${max}; controls after that are not checked for reachability`;
  await page.evaluate(() => {
    if (window.__auditSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== window.__auditSheet);
    else document.documentElement.style.setProperty('scroll-behavior', window.__auditScrollBehavior ?? '');
  });
  return { order, note };
}

// A click or key step leaves the browser's sequential focus starting point on the control it used, so the first Tab would start
// mid-page and the controls before it would look unreachable. Tabbing until focus leaves the page restores the start of a fresh
// page, positive tabindex first. (Moving focus to the body or collapsing a selection does not: they skip positive tabindex or do nothing.)
async function resetFocusStart(page, limit) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => !document.activeElement || document.activeElement === document.body)) return;
  }
}

// ---------- run ----------
const [width, height] = values.viewport.split('x').map(Number);
const viewport = { width, height };
const target = /^https?:|^file:/.test(values.url) ? values.url : pathToFileURL(resolve(values.url)).href;
for (const key of ['init-script', 'storage-state']) if (values[key] && !existsSync(resolve(values[key]))) { console.error(`--${key}: file not found: ${values[key]}`); process.exit(2); }

let browser;
for (const channel of values.browser ? [values.browser] : ['msedge', 'chrome', undefined]) {
  try { browser = await chromium.launch(channel && channel !== 'chromium' ? { channel, headless: true } : { headless: true }); break; } catch { /* try next */ }
}
if (!browser) { console.error('No Chromium-based browser could be launched.'); process.exit(2); }

const context = await browser.newContext({ viewport, colorScheme: values.theme, reducedMotion: values['reduced-motion'] ? 'reduce' : 'no-preference', ...(values['forced-colors'] ? { forcedColors: 'active' } : {}), ...(values['storage-state'] ? { storageState: resolve(values['storage-state']) } : {}) });
if (values['init-script']) await context.addInitScript({ path: resolve(values['init-script']) });
const page = await context.newPage();
await page.goto(target, { waitUntil: 'load' });
if (values.wait && /^\d+$/.test(values.wait)) await page.waitForTimeout(Number(values.wait));
else if (values.wait) await page.waitForSelector(values.wait);
else { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(300); }
async function runStep(raw) {
  const [kind, ...rest] = raw.split(':'); const arg = rest.join(':');
  if (kind === 'click') await page.locator(arg).first().click({ timeout: 5000 });
  else if (kind === 'hover') await page.locator(arg).first().hover({ timeout: 5000 });
  else if (kind === 'fill') { const at = arg.lastIndexOf('='); await page.locator(arg.slice(0, at)).first().fill(arg.slice(at + 1), { timeout: 5000 }); }
  else if (kind === 'press') await page.keyboard.press(arg);
  else if (kind === 'wait') await page.waitForTimeout(Number(arg));
  else throw new Error(`unknown step kind "${kind}" (use click, fill, press, hover or wait)`);
}

// A bad selector must not hang for 30 s and end in a stack trace: each step gets 5 s and a one-line error.
for (const [index, raw] of (values.steps ?? '').split(';').map(s => s.trim()).filter(Boolean).entries()) {
  try { await runStep(raw); }
  catch (error) { console.error(`Step ${index + 1} '${raw}' failed: ${String(error.message).split('\n')[0]}`); await browser.close(); process.exit(2); }
}

// Entrance animations and transitions make colours and opacity differ between runs, so wait (up to 3 s) for finite ones to end.
await page.evaluate(async limit => {
  const deadline = performance.now() + limit;
  while (performance.now() < deadline) {
    const running = document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
    if (!running.length) return;
    await Promise.race([Promise.allSettled(running.map(a => a.finished)), new Promise(resolve => setTimeout(resolve, 250))]);
  }
}, 3000);

const data = await page.evaluate(collect, { scope: values.scope, focusProps: focusProps(values['forced-colors']) });
const result = analyse(data, viewport, { theme: values.theme });
// Self-test: the fixture has no dark styles, so a dark run must report that the page ignored the preference.
let darkRunFlagged = false;
if (values.selftest) {
  const darkContext = await browser.newContext({ viewport, colorScheme: 'dark' });
  const darkPage = await darkContext.newPage();
  await darkPage.goto(target, { waitUntil: 'load' });
  darkRunFlagged = analyse(await darkPage.evaluate(collect, { scope: values.scope }), viewport, { theme: 'dark' }).flags.some(f => f.rule === 'THEME-NO-CHANGE');
  await darkContext.close();
}
const byId = new Map(data.elements.map(e => [e.id, e]));
let keyboard;
if (values.keyboard) {
  if (values.steps) await resetFocusStart(page, Number(values['max-tab']) + 5);
  keyboard = await traverse(page, byId, Number(values['max-tab']), false, values.scope);
  const backward = await traverse(page, byId, Number(values['max-tab']), true, values.scope);
  keyboard.reverseStops = backward.order.length;
  const reached = new Set(keyboard.order.map(o => o.id));
  for (const o of keyboard.order) {
    if (o.untagged) {
      if (!o.outside) result.flags.push({ id: null, rule: 'A11Y-HIDDEN-FOCUS-TARGET', severity: 'info', gate: 'G8', message: `Tab stop on <${o.tag}${o.type ? ` type=${o.type}` : ''}> "${o.name}" is not in the inventory${o.hiddenControl ? ' (visually hidden control)' : ''}; confirm its label or proxy shows a visible focus indicator (WCAG 2.4.7)` });
      continue;
    }
    const e = byId.get(o.id); if (!e) continue;
    if (o.indicator === false) { result.flags.push({ id: e.id, rule: 'A11Y-FOCUS-NO-INDICATOR', severity: 'warn', gate: 'G8', message: 'no computed style change on keyboard focus; confirm a visible indicator exists (WCAG 2.4.7)' }); (e.flags ??= []).push('A11Y-FOCUS-NO-INDICATOR'); }
    if (o.covered) { result.flags.push({ id: e.id, rule: 'A11Y-FOCUS-OBSCURED', severity: 'warn', gate: 'G8', message: 'another element covers the centre of the focused control; check whether it is entirely hidden (fails WCAG 2.4.11 AA) or only partly covered (2.4.12 AAA)' }); (e.flags ??= []).push('A11Y-FOCUS-OBSCURED'); }
    if (o.trap) result.flags.push({ id: e.id, rule: 'A11Y-KEYBOARD-TRAP', severity: 'error', gate: 'G8', message: 'focus did not advance on Tab (WCAG 2.1.2)' });
  }
  // One closed drawer can hold dozens of links; report the root cause once instead of one "covered" flag per link.
  const offscreenStops = keyboard.order.filter(o => o.offscreen && !o.untagged && byId.has(o.id));
  if (offscreenStops.length) {
    const ids = offscreenStops.map(o => o.id);
    result.flags.push({ id: ids[0], rule: 'A11Y-FOCUS-OFFSCREEN', severity: 'warn', gate: 'G8', message: `${ids.length} tab stop${ids.length > 1 ? 's' : ''} (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', ...' : ''}) take focus while entirely outside the viewport, usually a closed drawer or off-canvas menu that is still in the tab order; hide it from keyboard and assistive technology until it opens (WCAG 2.4.3, 2.4.7)` });
    for (const id of ids) (byId.get(id).flags ??= []).push('A11Y-FOCUS-OFFSCREEN');
  }
  // Moving backwards puts the focused control at the top edge, where a sticky header without scroll-padding-top covers it.
  const alreadyCovered = new Set(result.flags.filter(f => f.rule === 'A11Y-FOCUS-OBSCURED').map(f => f.id));
  for (const o of backward.order) {
    const e = !o.untagged && byId.get(o.id);
    if (!e || !o.covered || alreadyCovered.has(e.id)) continue;
    alreadyCovered.add(e.id);
    result.flags.push({ id: e.id, rule: 'A11Y-FOCUS-OBSCURED', severity: 'warn', gate: 'G8', message: 'another element covers the centre of the control when it takes focus moving backwards (Shift+Tab); check whether it is entirely hidden (fails WCAG 2.4.11 AA) or only partly covered (2.4.12 AAA), usually a sticky header without scroll-padding-top' });
    (e.flags ??= []).push('A11Y-FOCUS-OBSCURED');
  }
  const reachedGroups = new Set(keyboard.order.map(o => byId.get(o.id)?.radioGroup).filter(Boolean));
  for (const e of data.elements.filter(x => x.kind === 'interactive' && INTERACTIVE_ROLES.has(x.role) && !x.inert && !x.disabled && x.tabindex !== '-1')) {
    // A native radio group has one tab stop; arrow keys move inside it.
    if (e.radioGroup && reachedGroups.has(e.radioGroup)) continue;
    if (!reached.has(e.id) && keyboard.order.length < Number(values['max-tab']) && !keyboard.note?.startsWith('keyboard trap')) result.flags.push({ id: e.id, rule: 'A11Y-UNREACHABLE-BY-TAB', severity: 'warn', gate: 'G8', message: 'not reached by Tab; confirm it has a keyboard alternative' });
  }
}

// Self-test: a walk after a click step must start at the top of the page like a fresh page, not after the clicked control.
let clickWalkOk = true;
if (values.selftest) {
  const clickContext = await browser.newContext({ viewport });
  const clickPage = await clickContext.newPage();
  await clickPage.goto(target, { waitUntil: 'load' });
  const clickData = await clickPage.evaluate(collect, { scope: values.scope });
  await clickPage.locator('button[role=combobox]').click({ timeout: 5000 });
  await resetFocusStart(clickPage, Number(values['max-tab']) + 5);
  const walked = await traverse(clickPage, new Map(clickData.elements.map(e => [e.id, e])), Number(values['max-tab']), false, values.scope);
  clickWalkOk = walked.order[0]?.id === keyboard.order[0]?.id && walked.order.length === keyboard.order.length;
  await clickContext.close();
}

// Self-test: forced-colors emulation must really force colors, and a focus ring drawn only by box-shadow must then count as no indicator
// even though focus recolors outline and border. Without this, --forced-colors would report nothing.
let forcedColorsOk = true;
if (values.selftest) {
  const forcedContext = await browser.newContext({ viewport, forcedColors: 'active' });
  const forcedPage = await forcedContext.newPage();
  await forcedPage.setContent('<style>.f{background:#f00;box-shadow:0 0 4px #000}.s:focus-visible{outline:none;box-shadow:0 0 0 3px #00f}.o:focus-visible{outline:3px solid #00f}</style><div class="f">x</div><button class="s">shadow</button><button class="o">outline</button>');
  const forced = await forcedPage.evaluate(() => { const s = getComputedStyle(document.querySelector('.f')); return { shadow: s.boxShadow, background: s.backgroundColor }; });
  const forcedData = await forcedPage.evaluate(collect, { scope: undefined, focusProps: focusProps(true) });
  const forcedWalk = await traverse(forcedPage, new Map(forcedData.elements.map(e => [e.id, e])), 10, false, undefined, true);
  const stop = name => forcedWalk.order.find(o => o.name === name);
  forcedColorsOk = forced.shadow === 'none' && forced.background !== 'rgb(255, 0, 0)' && stop('shadow')?.indicator === false && stop('outline')?.indicator === true;
  await forcedContext.close();
}

if (values.screenshot) {
  mkdirSync(dirname(resolve(values.screenshot)), { recursive: true });
  // The keyboard walk leaves the page scrolled and a control focused; shoot the first screen.
  await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0, 0); });
  if (values.annotate) await page.evaluate(els => {
    const layer = document.createElement('div'); layer.id = '__audit_overlay'; layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483647';
    for (const e of els) { const b = document.createElement('div'); b.style.cssText = `position:absolute;left:${e.box.x}px;top:${e.box.y}px;width:${e.box.w}px;height:${e.box.h}px;outline:1px dashed #d1005d;`; const t = document.createElement('span'); t.textContent = e.id.slice(1); t.style.cssText = 'position:absolute;left:0;top:-9px;font:9px/9px monospace;background:#d1005d;color:#fff;padding:0 1px'; b.appendChild(t); layer.appendChild(b); }
    document.body.appendChild(layer);
  }, data.elements.filter(e => e.kind === 'interactive' || e.heading));
  await page.screenshot({ path: resolve(values.screenshot), fullPage: values['full-page'] });
}
await page.evaluate(() => { document.querySelectorAll('[data-audit-id],[data-audit-untagged]').forEach(n => { n.removeAttribute('data-audit-id'); n.removeAttribute('data-audit-untagged'); }); document.getElementById('__audit_overlay')?.remove(); });
await browser.close();

// ---------- output ----------
const report = { meta: { url: values.url, viewport: values.viewport, theme: values.theme, reducedMotion: values['reduced-motion'], forcedColors: values['forced-colors'], title: data.title, lang: data.lang, elements: data.elements.length, generated: new Date().toISOString() }, flags: result.flags, duplicates: result.duplicates, census: data.census, headings: data.headings, tabOrder: keyboard, elements: data.elements.map(({ focusBefore, collectionKey, collectionRow, ...rest }) => rest) };
if (values.out) { mkdirSync(dirname(resolve(values.out)), { recursive: true }); writeFileSync(resolve(values.out), JSON.stringify(report, null, 2)); }

const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (s, n) => ([...String(s ?? '')].length > n ? [...String(s)].slice(0, n - 1).join('') + '…' : String(s ?? ''));
const bySeverity = { error: 0, warn: 1, info: 2 };
const lines = [`# Element inventory: ${esc(data.title)}`, '', `${values.url} · ${values.viewport} · ${values.theme}${values['reduced-motion'] ? ' · reduced motion' : ''}${values['forced-colors'] ? ' · forced colors' : ''} · ${data.elements.length} elements · lang=${data.lang || '(none)'}`, ''];
const summary = new Map();
for (const f of result.flags) { const k = `${f.severity}|${f.rule}|${f.gate}`; (summary.get(k) ?? summary.set(k, []).get(k)).push(f.id ?? 'page'); }
lines.push('## Flags', '', '| Severity | Rule | Gate | Count | First screen | Elements |', '| --- | --- | --- | --- | --- | --- |');
for (const [k, ids] of [...summary.entries()].sort((a, b) => bySeverity[a[0].split('|')[0]] - bySeverity[b[0].split('|')[0]] || a[0].localeCompare(b[0]))) { const [sev, rule, gate] = k.split('|'); const firstScreen = ids.filter(id => (byId.get(id)?.box.y ?? Infinity) < viewport.height).length; lines.push(`| ${sev} | ${rule} | ${gate} | ${ids.length} | ${firstScreen} | ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''} |`); }
if (!summary.size) lines.push('| – | none | – | 0 | 0 | – |');
lines.push('', '## Details (errors and warnings)', '');
const detailLimit = Number(values['detail-limit']);
const shownPerRule = new Map(); const totalPerRule = new Map();
for (const f of result.flags.filter(x => x.severity !== 'info')) totalPerRule.set(f.rule, (totalPerRule.get(f.rule) ?? 0) + 1);
for (const f of result.flags.filter(x => x.severity !== 'info').sort((a, b) => bySeverity[a.severity] - bySeverity[b.severity] || a.rule.localeCompare(b.rule))) {
  const count = shownPerRule.get(f.rule) ?? 0; shownPerRule.set(f.rule, count + 1);
  if (detailLimit && count >= detailLimit) continue;
  const e = byId.get(f.id);
  lines.push(`- **${f.severity.toUpperCase()}** \`${f.rule}\` ${f.id ?? 'page'}${e ? ` \`${esc(e.selector)}\` "${esc(clip(e.name || e.text, 40))}"` : ''}: ${esc(f.message)}`);
}
for (const [rule, total] of totalPerRule) {
  if (!detailLimit || total <= detailLimit) continue;
  let more = `- … ${total - detailLimit} more \`${rule}\` flags; all are in the --out JSON`;
  if (rule === 'COLOR-TEXT-CONTRAST') {
    const pairs = new Map();
    for (const f of result.flags.filter(x => x.rule === rule && x.severity !== 'info')) { const e = byId.get(f.id); if (e) { const k = `${e.style.fg} on ${e.style.bg}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); } }
    more += `; most common colour pairs: ${[...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`).join(', ')} (one decorative style or one token can explain many)`;
  }
  lines.push(more);
}
lines.push('', '## Duplicate candidates', '');
if (!result.duplicates.length) lines.push('None.');
for (const d of result.duplicates) lines.push(`- ${d.kind}: ${esc(d.key)} ×${d.count} (${d.ids.join(', ')})${d.regions ? ` in ${d.regions.map(esc).join(' | ')}` : ''}${d.names ? ` names: ${d.names.map(esc).join(' / ')}` : ''}`);
lines.push('', '## Style census (value × count)', '');
for (const [key, counts] of Object.entries(data.census)) lines.push(`- ${key} (${Object.keys(counts).length} distinct): ${Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${esc(clip(v, 40))}×${n}`).join(', ')}`);
if (keyboard) { lines.push('', '## Tab order', '', keyboard.order.map((o, i) => `${i + 1}. ${o.untagged ? `(not in inventory: ${o.tag}${o.type ? ' ' + o.type : ''} "${esc(clip(o.name ?? '', 30))}")` : o.id ?? '(unknown)'}${o.trap ? ' TRAP' : ''}${o.stops > 1 ? ` (×${o.stops} Tab presses)` : ''}`).join('  ·  ') + (keyboard.note ? `\n\nNote: ${keyboard.note}` : '') + `\n\nReverse pass (Shift+Tab): ${keyboard.reverseStops} stops`); }
if (!values['summary-only']) {
  const shown = data.elements.filter(e => values.rows === 'all' || e.kind !== 'text').sort((a, b) => Math.round(a.box.y / 12) - Math.round(b.box.y / 12) || a.box.x - b.box.x).slice(0, Number(values.limit));
  lines.push('', `## Elements (reading order, ${values.rows}, first ${shown.length})`, '', '| ID | Region | Role | Name / text | Box x,y w×h | Type | Contrast | Flags |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of shown) lines.push(`| ${e.id} | ${esc(e.region)} | ${e.role}${e.state ? ' ' + esc(e.state) : ''} | ${esc(clip(e.name || e.text, 36))} | ${e.box.x},${e.box.y} ${e.box.w}×${e.box.h} | ${e.style.size}px/${e.style.weight} ${e.style.fg} on ${e.style.bg} | ${e.contrast ?? ''} | ${(e.flags ?? []).join(' ')} |`);
}
const markdown = lines.join('\n');
if (values.md) { mkdirSync(dirname(resolve(values.md)), { recursive: true }); writeFileSync(resolve(values.md), markdown); }

if (values.selftest) {
  const expected = ['A11Y-NO-NAME', 'A11Y-LABEL-IN-NAME', 'A11Y-PLACEHOLDER-LABEL', 'A11Y-NONNATIVE-CONTROL', 'A11Y-NESTED-INTERACTIVE', 'A11Y-TABINDEX-POSITIVE', 'A11Y-HEADING-SKIP', 'SIZE-TARGET-24', 'COLOR-TEXT-CONTRAST', 'COPY-GENERIC-LINK', 'COPY-EMOJI-ICON', 'COPY-TRUNCATED-NO-FALLBACK', 'COPY-PLACEHOLDER-REPEATS-LABEL', 'DISABLED-NO-REASON', 'MOTION-TRANSITION-ALL', 'DUP-SAME-NAME-DIFF-TARGET', 'DUP-SAME-TARGET-DIFF-NAME', 'DUP-SAME-NAME-ROLE', 'A11Y-FOCUS-OBSCURED', 'A11Y-FOCUS-OFFSCREEN', 'A11Y-HIDDEN-FOCUS-TARGET', 'A11Y-ARIA-HIDDEN-FOCUSABLE', 'A11Y-NAME-FROM-CSS-CONTENT', 'COLOR-CONTRAST-UNVERIFIABLE'];
  const found = new Set(result.flags.map(f => f.rule));
  const missing = expected.filter(r => !found.has(r));
  const falsePositive = result.duplicates.some(d => d.kind === 'same-name-role' && /삭제/.test(d.key)) ? ['collection repeat reported as duplicate'] : [];
  // Guards for tool defects found in a trial: a native radio group has one tab stop, and smooth scrolling must not
  // make a focused control look covered by a sticky header.
  const radioFlagged = result.flags.some(f => f.rule === 'A11Y-UNREACHABLE-BY-TAB' && byId.get(f.id)?.role === 'radio');
  const midButton = data.elements.find(e => e.name === '중간 단추');
  // A visually hidden control that takes focus must not cut the traversal short (a trial page lost 90 elements this way).
  const reachedMid = !!midButton && keyboard.order.some(o => o.id === midButton.id);
  const hiddenText = data.elements.find(e => e.text === '화면 낭독기 전용 안내문입니다');
  const trapFlagged = result.flags.some(f => f.rule === 'A11Y-KEYBOARD-TRAP');
  const guards = [];
  if (radioFlagged) guards.push('radio group reported as unreachable by Tab');
  if (trapFlagged) guards.push('composite date input reported as a keyboard trap');
  if (!midButton) guards.push('middle button missing from inventory');
  else {
    if ((midButton.flags ?? []).includes('A11Y-FOCUS-OBSCURED')) guards.push('focused control reported as covered during smooth scrolling');
    if (!reachedMid) guards.push('traversal stopped before the middle button (hidden or composite control cut it short)');
  }
  if (!hiddenText) guards.push('screen-reader-only text missing from inventory');
  else if ((hiddenText.flags ?? []).includes('COPY-TRUNCATED-NO-FALLBACK')) guards.push('screen-reader-only text reported as truncated');
  // Found on gov.uk: text a sighted user cannot see is not a visible label, and a copyright sign is not an emoji icon.
  const srChild = data.elements.find(e => e.name === '검색 열기');
  const indented = data.elements.find(e => e.name === '찾기');
  const copyright = data.elements.find(e => /저작권 안내/.test(e.name));
  if (!srChild) guards.push('icon button with a visually hidden child missing from inventory');
  else if ((srChild.flags ?? []).includes('A11Y-LABEL-IN-NAME') || srChild.text) guards.push('visually hidden child text treated as the visible label');
  if (!indented) guards.push('text-indent icon button missing from inventory');
  else if ((indented.flags ?? []).some(f => ['COLOR-TEXT-CONTRAST', 'COPY-TRUNCATED-NO-FALLBACK', 'A11Y-LABEL-IN-NAME'].includes(f)) || indented.text) guards.push('text moved off the button by text-indent treated as visible text');
  if (!copyright) guards.push('copyright link missing from inventory');
  else if ((copyright.flags ?? []).includes('COPY-EMOJI-ICON')) guards.push('copyright sign reported as an emoji icon');
  // Found on primer.style, linear.app and wikipedia.org.
  const darkTip = data.elements.find(e => e.name === '어두운 화면으로 전환');
  if (!darkTip || darkTip.nameSource !== 'aria-labelledby') guards.push('aria-labelledby pointing at a hidden element lost its name');
  const combo = data.elements.find(e => e.role === 'combobox' && e.name === '테마');
  if (!combo) guards.push('value-showing combobox missing from inventory');
  else if ((combo.flags ?? []).includes('A11Y-LABEL-IN-NAME')) guards.push('displayed value of a combobox treated as its visible label');
  const skip = data.elements.find(e => /본문으로 건너뛰기/.test(e.name));
  if (!skip) guards.push('visually hidden skip link missing from inventory');
  else if ((skip.flags ?? []).some(f => f.startsWith('SIZE-TARGET'))) guards.push('visually hidden skip link reported as an undersized target');
  const cite = data.elements.find(e => e.nameFromCss);
  if (!cite) guards.push('control named by CSS generated content not detected');
  else if ((cite.flags ?? []).includes('A11Y-NO-NAME')) guards.push('name from CSS generated content reported as missing');
  const guideLinks = data.elements.filter(e => e.role === 'link' && e.name === '가이드');
  if (guideLinks.length < 2) guards.push('trailing-slash link pair missing from inventory');
  else if (guideLinks.some(e => (e.flags ?? []).includes('DUP-SAME-NAME-DIFF-TARGET'))) guards.push('links differing only by a trailing slash reported as different destinations');
  const hiddenInput = data.elements.find(e => e.ariaHidden && e.tag === 'input');
  if (!hiddenInput) guards.push('aria-hidden input missing from inventory');
  else if ((hiddenInput.flags ?? []).includes('A11Y-NO-NAME')) guards.push('aria-hidden input reported as unnamed');
  // Found on Firewall Desk: a tree item carries aria-level but is not a heading, so it must not add an h1 or a level jump.
  if (data.headings.some(h => h.level === 1 && /트리 항목/.test(h.text))) guards.push('aria-level on a tree item counted as a heading');
  const overImage = data.elements.find(e => e.text === '이미지 위의 흰 글자');
  if (!overImage) guards.push('text over an image missing from inventory');
  else if ((overImage.flags ?? []).includes('COLOR-TEXT-CONTRAST')) guards.push('text over an image measured against the page background');
  // Found by the audit trials on gov.uk and wikipedia.org.
  const stretch = data.elements.find(e => e.name === '카드 전체 링크');
  if (!stretch) guards.push('stretched link missing from inventory');
  else if (!stretch.hit) guards.push('stretched link hit area not detected');
  else if ((stretch.flags ?? []).some(f => f.startsWith('SIZE-TARGET'))) guards.push('stretched link judged by its text box instead of its hit area');
  const hashLinks = data.elements.filter(e => e.role === 'link' && ['맨 위로', '목차로'].includes(e.name));
  if (hashLinks.length < 2) guards.push('href="#" link pair missing from inventory');
  else if (hashLinks.some(e => (e.flags ?? []).includes('DUP-SAME-TARGET-DIFF-NAME'))) guards.push('href="#" links treated as one shared destination');
  // Found on cloudscape.design at 390 px: 42 off-screen drawer links were reported as "covered", the current-page crumb as
  // a disabled control without a reason, and "card" / "cards" as two names for one destination.
  const drawerLink = data.elements.find(e => e.name === '서랍 항목');
  if (!drawerLink) guards.push('off-canvas drawer link missing from inventory');
  else {
    if ((drawerLink.flags ?? []).includes('A11Y-FOCUS-OBSCURED')) guards.push('control focused outside the viewport reported as covered by another element');
    if (!(drawerLink.flags ?? []).includes('A11Y-FOCUS-OFFSCREEN')) guards.push('control focused outside the viewport not reported');
  }
  const currentCrumb = data.elements.find(e => e.name === '현재 위치');
  if (!currentCrumb) guards.push('current-page control missing from inventory');
  else if ((currentCrumb.flags ?? []).includes('DISABLED-NO-REASON')) guards.push('current-page control reported as disabled without a reason');
  const pluralLinks = data.elements.filter(e => e.role === 'link' && ['card', 'cards'].includes(e.name));
  if (pluralLinks.length < 2) guards.push('singular and plural link pair missing from inventory');
  else if (pluralLinks.some(e => (e.flags ?? []).includes('DUP-SAME-TARGET-DIFF-NAME'))) guards.push('singular and plural names treated as two names for one destination');
  if (!(keyboard.reverseStops >= 5)) guards.push('backward (Shift+Tab) keyboard pass did not run');
  // A link is inside a sentence only when words sit beside it; links between "|" separators are a list and are measured.
  const sentenceLink = data.elements.find(e => e.role === 'link' && e.name === '이용 약관');
  const listLink = data.elements.find(e => e.role === 'link' && e.name === '다음 글');
  if (!sentenceLink || !listLink) guards.push('inline-link pair missing from inventory');
  else {
    if ((sentenceLink.flags ?? []).some(f => f.startsWith('SIZE-TARGET'))) guards.push('link inside a sentence judged against the 24px target size');
    if (!(listLink.flags ?? []).some(f => f.startsWith('SIZE-TARGET'))) guards.push('link between "|" separators exempted as inline in a sentence');
  }
  if (!clickWalkOk) guards.push('keyboard walk after a click step did not start at the top of the page (false A11Y-UNREACHABLE-BY-TAB flags)');
  if (!forcedColorsOk) guards.push('forced-colors emulation did not force colors, so --forced-colors would report nothing');
  // A dark run of a page without dark styles must say so; a dark page and a light run must not trigger it.
  if (!darkRunFlagged) guards.push('dark run of a page without dark styles not flagged THEME-NO-CHANGE');
  if (themeIgnored('dark', '#0d1117') || themeIgnored('light', '#ffffff') || !themeIgnored('dark', '#ffffff')) guards.push('THEME-NO-CHANGE decision wrong for a dark page, a light run or a light page in a dark run');
  const problems = [...missing.map(r => `missing ${r}`), ...falsePositive, ...guards];
  console.log(problems.length ? `SELFTEST FAIL: ${problems.join('; ')}` : `SELFTEST PASS: ${expected.length} expected rules found, collection repeat ignored, radio group, smooth-scroll, hidden-control, hidden-text, copyright-sign, hidden-reference, aria-hidden, css-name, trailing-slash, image-backdrop, stretched-link, hash-link, backward-pass, click-step-walk, theme-ignored, off-canvas-drawer, current-page-control, singular-plural-name, forced-colors-emulation and inline-link guards hold (21 guard groups), ${data.elements.length} elements`);
  process.exit(problems.length ? 1 : 0);
}
console.log(markdown);
process.exit(values.strict && result.flags.some(f => f.severity === 'error') ? 1 : 0);
