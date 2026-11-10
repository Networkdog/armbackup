#!/usr/bin/env node
// Mutation test for validate-design-docs.mjs. It copies the design files to a temporary folder, changes one fact at a time
// and checks that the validator reports something new. A mutant nobody notices shows a rule the validator lacks.
// A mutant whose text no longer exists is reported as stale: update the list together with the documents.
// Usage: node mutation-test.mjs [--min-rate 0.9] [--keep] [--mutants <json file>]
// --mutants replaces the built-in list with your own, so a reviewer can try mutations the author did not anticipate:
// a JSON array of ["what it breaks", [["relative/path", "text to find", "replacement"], ...]].
// Exit 1 when the catch rate is below the target or a mutant is stale.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'min-rate': { type: 'string', default: '0.9' }, keep: { type: 'boolean', default: false }, mutants: { type: 'string' } } });
const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, '..', '..', '..', '..');
const validator = join(scripts, 'validate-design-docs.mjs');

const G = 'frontend/DESIGN_GUIDELINES.md';
const S = '.github/skills/';
const INSTRUCTIONS = '.github/instructions/frontend-design.instructions.md';

// Each mutant: what it breaks, and [file, text to find, replacement] edits (the first occurrence is replaced).
const BUILT_IN = [
  ['ladder rows swapped in ui-simplify', [[`${S}ui-simplify/SKILL.md`, '| 3 Default | Same choice every time?', '| 3 Defer | Same choice every time?'], [`${S}ui-simplify/SKILL.md`, '| 4 Defer | Needed rarely?', '| 4 Default | Needed rarely?']]],
  ['ladder order in the guide summary', [[G, '제거 → 병합 → 기본값 → 지연 → 묶기 → 약화 순서로', '제거 → 병합 → 지연 → 기본값 → 묶기 → 약화 순서로']]],
  ['toast 8 s to 3 s in the interaction skill', [[`${S}ui-interaction-design/SKILL.md`, 'A toast starts at 8 s', 'A toast starts at 3 s']]],
  ['toast 8 s to 3 s in the guide', [[G, '표시 시간은 8초에서 시작한다', '표시 시간은 3초에서 시작한다']]],
  ['target size 24 to 20 in the instruction file', [[INSTRUCTIONS, 'pointer targets at least 24 by 24 px', 'pointer targets at least 20 by 20 px']]],
  ['P1 definition changed in the audit skill', [[`${S}ui-element-audit/SKILL.md`, 'fails AA on the first screen or main task', 'fails AAA on the first screen or main task']]],
  ['P1 definition changed in the guide', [[G, '첫 화면·주 과업에서 AA 기준에 실패하거나', '첫 화면·주 과업에서 AAA 기준에 실패하거나']]],
  ['register changed to 해요체', [[INSTRUCTIONS, 'Statements in 합니다체', 'Statements in 해요체']]],
  ['breakpoint 760 to 768 in the workflow skill', [[`${S}ui-design-workflow/SKILL.md`, 'repo breakpoints 760 and 1100 px', 'repo breakpoints 768 and 1100 px']]],
  ['WCAG 2.4.11 written as AAA', [[`${S}ui-element-audit/references/tool-limits.md`, '2.4.11 (AA)', '2.4.11 (AAA)']]],
  ['WCAG 3.3.3 written as AAA in the guide', [[G, '[표준 3.3.3 AA]', '[표준 3.3.3 AAA]']]],
  ['font size budget 5 to 6', [[`${S}ui-simplify/SKILL.md`, '| Font sizes | 5 or fewer |', '| Font sizes | 6 or fewer |']]],
  ['gate G9 appears', [[`${S}ui-element-audit/SKILL.md`, 'through G1 to G8', 'through G1 to G9']]],
  ['gate G8 renamed in the guide', [[G, '#### G8 상태·접근성', '#### G8 상태·동작·접근성']]],
  ['gate G6 renamed in the audit skill', [[`${S}ui-element-audit/SKILL.md`, '| G6 Colour |', '| G6 Color |']]],
  ['broken local link in the interaction skill', [[`${S}ui-interaction-design/SKILL.md`, './references/forms-and-validation.md', './references/forms-and-validations.md']]],
  ['undefined source key in the guide', [[G, '[관행][hoober17]', '[관행][hoober18]']]],
  ['duplicate types DUP1 to DUP9', [[`${S}ui-element-audit/SKILL.md`, 'see DUP1 to DUP10 in the reference', 'see DUP1 to DUP9 in the reference']]],
  ['reference to a missing guide section', [[`${S}ui-interaction-design/SKILL.md`, '(guide §5.8)', '(guide §5.88)']]],
  ['guide heading renumbered', [[G, '### 5.12 로그인과 세션', '### 5.13 로그인과 세션']]],
  ['criteria number differs from the guide (C09)', [[`${S}ui-element-audit/references/element-criteria-actions.md`, 'only 1 `action.primary`', 'only 2 `action.primary`']]],
  ['verdict list lacks Decide', [[`${S}ui-element-audit/assets/audit-sheet-template.md`, 'Split, Decide.', 'Split.']]],
  ['placeholder text left in a skill', [[`${S}ui-interaction-design/SKILL.md`, '# UI interaction design', '# UI interaction design TODO']]],
  ['table row loses a column', [[`${S}ui-simplify/SKILL.md`, '| Font weights | 3 or fewer |', '| Font weights 3 or fewer |']]],
  ['Cowan range changed to 4', [[G, '약 3~5개 덩어리로 추정했다', '약 4개 덩어리로 추정했다']]],
  ['skill name no longer matches its folder', [[`${S}ui-element-audit/SKILL.md`, 'name: ui-element-audit', 'name: ui-element-audits']]],
  ['description loses its trigger phrase', [[`${S}ui-interaction-design/SKILL.md`, 'description: "Use when designing', 'description: "Designing']]],
  ['headline scale changed in a skill', [[`${S}ui-visual-craft/SKILL.md`, '2.5 to 3.5rem', '2.5 to 4rem']]],
  ['Korean line height changed in a skill', [[`${S}ui-visual-craft/SKILL.md`, 'body 1.5 to 1.7', 'body 1.4 to 1.7']]],
  ['minimum text size changed in the audit skill', [[`${S}ui-element-audit/SKILL.md`, 'required text 12px or more', 'required text 11px or more']]],
  ['instruction file applies to every file', [[INSTRUCTIONS, 'applyTo: "frontend/src/**/*.tsx,frontend/src/**/*.ts,frontend/src/**/*.css"', 'applyTo: "**"']]],
  ['re-audit passes 3 to 5 in the review skill', [[`${S}ui-design-review/SKILL.md`, 'at most 3 passes', 'at most 5 passes']]],
  ['ship rule R4 and R5 threshold lowered', [[`${S}ui-design-review/references/screen-rubric.md`, 'R4 and R5 at 4 or more', 'R4 and R5 at 3 or more']]],
  ['toast may steal focus', [[`${S}ui-interaction-design/SKILL.md`, 'never steals focus', 'may steal focus']]],
  ['protected items become removable', [[`${S}ui-element-audit/SKILL.md`, 'are never removed', 'are sometimes removed']]],
  ['raw exception text allowed', [[`${S}ui-interaction-design/references/forms-and-validation.md`, 'Never show raw server exception text', 'Show raw server exception text when useful']]],
  ['red meaning widened', [[`${S}ui-visual-craft/SKILL.md`, 'Red only for impossible, blocked or error.', 'Red for any emphasis.']]],
  ['transition all allowed in the instruction file', [[INSTRUCTIONS, 'never `transition: all`', 'prefer `transition: all`']]],
  ['working-memory range changed in ui-simplify', [[`${S}ui-simplify/SKILL.md`, '"about 3 to 5"', '"about 4"']]],
  ['menu Tab behaviour flipped in the interaction skill', [[`${S}ui-interaction-design/SKILL.md`, 'Up and Down move between items, Tab closes it', 'Up and Down move between items, Tab moves between items']]],
  ['menu Tab behaviour flipped in the criteria row', [[`${S}ui-element-audit/references/element-criteria-layers.md`, 'Up and Down move between items and Tab closes it', 'Up and Down move between items and Tab moves on']]],
  ['WCAG 2.1.4 level changed in the guide', [[G, '[표준 2.1.4 A]', '[표준 2.1.4 AA]']]],
  ['WCAG 2.5.2 level changed in the guide', [[G, '**2.5.2 A:**', '**2.5.2 AAA:**']]],
  ['WCAG 2.4.2 level changed in the guide', [[G, '[표준 2.4.2 A]', '[표준 2.4.2 AA]']]],
  ['confirmation tiers reduced to two in the guide', [[G, '확인의 수준은 위험에 맞춰 셋으로 나눈다', '확인의 수준은 위험에 맞춰 둘로 나눈다']]],
  ['selection scope widened in the skill', [[`${S}ui-interaction-design/references/destructive-and-async.md`, 'covers only the rows visible on the current page', 'covers all rows of the table']]],
  ['AI review strength rule changed', [[`${S}ui-interaction-design/references/ai-features.md`, 'Match review strength to risk', 'Match review strength to speed']]],
  ['character-key shortcut rule dropped from the instruction file', [[INSTRUCTIONS, 'turned off, remapped or is focus-only (WCAG 2.1.4)', 'turned off (WCAG 2.1.4)']]],
  ['tab key stays inside the tab list (guide)', [[G, 'Tab 키는 탭 목록을 벗어나 탭 패널로 가며', 'Tab 키는 탭 사이를 옮기며']]],
  ['tree grid arrow keys swapped (skill)', [[`${S}ui-interaction-design/references/states-and-feedback.md`, 'with focus on a row, Right expands a collapsed row and Left collapses an expanded one', 'with focus on a row, Left expands a collapsed row and Right collapses an expanded one']]],
  ['absolute times lose the UTC offset (guide)', [[G, 'UTC도 `UTC+0:00`처럼 쓴다', 'UTC는 생략한다']]],
  ['datetime attribute may hold prose (skill)', [[`${S}ui-interaction-design/references/states-and-feedback.md`, '`datetime` is never prose', '`datetime` may be prose']]],
  ['status indicator may rely on colour alone (skill)', [[`${S}ui-visual-craft/SKILL.md`, 'relies on at least two of colour, shape and symbol', 'may rely on colour alone']]],
  ['repo claim reversed: TabBar sets aria-controls', [[G, '`panelId`를 받아 탭에 `aria-controls`를 달고', '`panelId`를 받아도 탭에 `aria-controls`를 달지 않고']]],
  ['repo claim reversed: DateValue shows a time zone', [[G, '브라우저의 현지 시각을 시간대 표시 없이', '브라우저의 현지 시각을 시간대와 함께']]],
  ['focus after clear sent to the results (guide)', [[G, '포커스를 검색 입력으로 보낸다', '포커스를 결과 영역으로 보낸다']]],
  ['blank term counts as a search miss (skill)', [[`${S}ui-interaction-design/references/states-and-feedback.md`, 'A blank-only term or an empty catalog is not a search miss', 'A blank-only term is a search miss']]],
  ['repo claim reversed: empty-state paragraph size (guide)', [[G, '`.empty-state p`는 12px이다', '`.empty-state p`는 11px이다']]],
  ['repo claim reversed: space tokens are used (guide)', [[G, '(`var(--space-` 0건)', '(`var(--space-` 40건)']]],
  ['layout with line breaks allowed (skill)', [[`${S}ui-visual-craft/SKILL.md`, 'never `<br>` or empty spacers', 'use `<br>` for spacing']]],
  ['space token fact reversed (instruction file)', [[INSTRUCTIONS, 'Existing CSS never uses `--space-*`', 'Existing CSS always uses `--space-*`']]],
  ['stop verdict without a passing rubric (history)', [['frontend/DESIGN_GUIDELINES_HISTORY.md', '| 4.15·3.5 | 계속 |', '| 4.15·3.5 | 중단 |']]],
  ['heading scale of the CSS misstated (guide)', [[G, 'h2 12~24px, h3 12~17px', 'h2 12~26px, h3 12~17px']]],
  ['component name that is not in the code (guide)', [[G, '`IconButton`(`label` 필수), `DownloadButton`', '`IconButton`(`label` 필수), `DownloadBtn`']]],
];

const MUTANTS = values.mutants ? JSON.parse(readFileSync(resolve(values.mutants), 'utf8')) : BUILT_IN;
const temp = mkdtempSync(join(tmpdir(), 'design-docs-mutants-'));
for (const [from, to] of [[G, G], ['frontend/DESIGN_GUIDELINES_HISTORY.md', 'frontend/DESIGN_GUIDELINES_HISTORY.md'], [INSTRUCTIONS, INSTRUCTIONS], ['.github/skills', '.github/skills'], ['frontend/src', 'frontend/src'], ['frontend/scripts', 'frontend/scripts'], ['frontend/playwright.config.ts', 'frontend/playwright.config.ts'], ['frontend/package.json', 'frontend/package.json'], ['backend/src', 'backend/src']]) {
  const target = join(temp, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repo, from), target, { recursive: true });
}

const run = () => {
  const result = spawnSync(process.execPath, [validator, '--root', temp, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error(`The validator printed no JSON: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.slice(start)).findings;
};
const key = finding => `${finding.level}|${finding.rule}|${finding.file}|${finding.message}`;

const baseline = new Map();
for (const finding of run()) baseline.set(key(finding), (baseline.get(key(finding)) ?? 0) + 1);

const rows = [];
for (const [what, edits] of MUTANTS) {
  const originals = new Map();
  let stale = false;
  for (const [path, find, replacement] of edits) {
    const file = join(temp, path);
    const text = readFileSync(file, 'utf8');
    if (!originals.has(file)) originals.set(file, text);
    if (!text.includes(find)) { stale = true; break; }
    writeFileSync(file, text.replace(find, () => replacement));
  }
  let outcome = { what, status: 'stale', detail: 'text to change not found' };
  if (!stale) {
    const counts = new Map(baseline);
    const added = run().filter(finding => {
      const left = counts.get(key(finding)) ?? 0;
      if (left > 0) { counts.set(key(finding), left - 1); return false; }
      return true;
    });
    const firstError = added.find(finding => finding.level === 'error');
    const first = firstError ?? added[0];
    outcome = { what, status: !added.length ? 'missed' : firstError ? 'caught' : 'caught (warning only)', detail: first ? `[${first.rule}] ${first.message}`.slice(0, 110) : '' };
  }
  for (const [file, original] of originals) writeFileSync(file, original);
  rows.push(outcome);
}

if (!values.keep) rmSync(temp, { recursive: true, force: true });
for (const row of rows) console.log(`${row.status.padEnd(22)} ${row.what}${row.detail ? `  ->  ${row.detail}` : ''}`);
const caught = rows.filter(row => row.status.startsWith('caught')).length;
const stale = rows.filter(row => row.status === 'stale').length;
const rate = caught / rows.length;
console.log(JSON.stringify({ mutants: rows.length, caught, warningOnly: rows.filter(row => row.status === 'caught (warning only)').length, missed: rows.filter(row => row.status === 'missed').length, stale, rate: Number(rate.toFixed(3)), target: Number(values['min-rate']) }));
process.exit(stale || rate < Number(values['min-rate']) ? 1 : 0);
