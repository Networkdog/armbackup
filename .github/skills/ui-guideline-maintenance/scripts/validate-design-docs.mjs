#!/usr/bin/env node
// Structural validator for the frontend design guide, the ui-* Agent Skills and the instruction file.
// Offline by default. Use --links to also probe every https URL (403/429 are reported as "blocked", not errors).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' }, json: { type: 'boolean', default: false }, links: { type: 'boolean', default: false }, 'update-ledger': { type: 'boolean', default: false }, 'allow-bulk': { type: 'boolean', default: false }, reason: { type: 'string' }, index: { type: 'boolean', default: false } } });
const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const guidePath = join(root, 'frontend', 'DESIGN_GUIDELINES.md');
const historyPath = join(root, 'frontend', 'DESIGN_GUIDELINES_HISTORY.md');
const skillsDir = join(root, '.github', 'skills');
const instructionPath = join(root, '.github', 'instructions', 'frontend-design.instructions.md');

const LIMITS = { skillLinesError: 200, skillLinesWarn: 150, descriptionMax: 1024, nameMax: 64, instructionLines: 45, fileBytesWarn: 7900, fileBytesError: 8000, reviewDays: 90, stopMean: 4.5, stopMin: 4 };
const REQUIRED_GUIDE_HEADINGS = [/한 장 요약/, /Copilot/, /컨셉/, /심미/, /상호작용/, /간결/, /검수/, /사례/, /미신|오해/, /출처/];
const ALLOWED_CONTRAST = new Set([3, 4.5, 7, 4.499]);
const ALLOWED_SQUARE_TARGETS = new Set([24, 32, 44]);
// An evidence label promises a kind of source. A claim labelled [표준] must not link a vendor design system.
const LABEL_HOSTS = {
  표준: [/(^|\.)(w3\.org|iso\.org|ietf\.org|whatwg\.org|ecma-international\.org|unicode\.org)$/, 'standards body'],
  규제: [/(^|\.)(go\.kr|gov|gov\.uk|europa\.eu)$/, 'regulator or government site'],
  연구: [/(^|\.)(doi\.org|arxiv\.org|acm\.org|cambridge\.org|nih\.gov|microsoft\.com|design\.google|chrisharrison\.net|semanticscholar\.org)$/, 'publication, preprint or researcher page'],
};
const COUNT_WORDS = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12, 열세: 13, 열네: 14, 열다섯: 15 };

const findings = [];
const add = (level, file, rule, message, line) => findings.push({ level, file: relative(root, file).split(sep).join('/'), line, rule, message });
const read = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function parseFrontmatter(text, file) {
  const lines = text.split('\n');
  if (lines[0] !== '---') { add('error', file, 'frontmatter', 'File must start with a --- frontmatter block'); return null; }
  const end = lines.indexOf('---', 1);
  if (end < 0) { add('error', file, 'frontmatter', 'Frontmatter block is not closed'); return null; }
  const data = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (/\t/.test(raw)) add('error', file, 'frontmatter', 'Tab character in frontmatter', i + 1);
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const match = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) { add('error', file, 'frontmatter', `Unparseable frontmatter line: ${raw}`, i + 1); continue; }
    let value = match[2].trim();
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
    if (quote) {
      if (value.length < 2 || value.at(-1) !== quote) add('error', file, 'frontmatter', `Unterminated quoted value for ${match[1]}`, i + 1);
      const inner = value.slice(1, -1);
      if (quote === '"' && /(^|[^\\])"/.test(inner)) add('error', file, 'frontmatter', `Unescaped double quote inside ${match[1]}`, i + 1);
      if (quote === "'" && /(^|[^'])'([^']|$)/.test(inner)) add('error', file, 'frontmatter', `Unescaped single quote inside ${match[1]}`, i + 1);
      value = inner;
    } else if (/:\s/.test(value) || /\s#/.test(value)) {
      add('error', file, 'frontmatter', `Unquoted value for ${match[1]} contains ": " or " #" (silent YAML failure); quote it`, i + 1);
    }
    data[match[1]] = value;
  }
  return { data, bodyStart: end + 1 };
}

function checkLocalLinks(text, file, { confineTo } = {}) {
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    if (target.includes('\\')) add('error', file, 'link', `Use "/" separators in link ${target}`, lineOf(text, match.index));
    const resolved = resolve(dirname(file), target.split('#')[0]);
    if (!existsSync(resolved)) add('error', file, 'link', `Broken local link ${target}`, lineOf(text, match.index));
    else if (confineTo && relative(confineTo, resolved).startsWith('..')) add('error', file, 'link', `Link ${target} leaves the skill directory`, lineOf(text, match.index));
  }
  for (const match of text.matchAll(/`((?:frontend|\.github|backend|infra)\/[^`\s*<>{}|]+\.[A-Za-z0-9]+)`/g)) {
    if (!existsSync(join(root, match[1]))) add('error', file, 'path', `Referenced repo path does not exist: ${match[1]}`, lineOf(text, match.index));
  }
}

// One vocabulary: verdicts, duplicate types and style budgets must read the same in the guide, the skills and the templates.
const CANON = {
  verdicts: ['Keep', 'Fix', 'Reword', 'Recolor', 'Move', 'Align', 'Merge', 'Remove', 'Defer', 'Split', 'Decide'],
  budgets: { en: { 'font sizes': 5, 'font weights': 3, 'font families': 2, radii: 3, shadows: 2 }, ko: { '글자 크기 단계': 5, '글자 굵기': 3, '글꼴 계열': 2, '모서리 반경': 3, '그림자': 2 } },
};

// Names the gates carry in every document (Korean in the guide, English in the skills), the order of the reduction ladder, and the
// WCAG 2.2 level of each success criterion the documents cite beside a level.
const GATES = { G1: ['필요성', 'Need'], G2: ['위치', 'Place'], G3: ['의미', 'Meaning'], G4: ['중복', 'Duplicate'], G5: ['문구', 'Copy'], G6: ['색상', 'Colour'], G7: ['형태', 'Form'], G8: ['상태·접근성', 'State and access'] };
const LADDER = [['제거', 'Remove'], ['병합', 'Merge'], ['기본값', 'Default'], ['지연', 'Defer'], ['묶기', 'Group'], ['약화', 'Soften']];
const SC_LEVEL = {
  '1.3.1': 'A', '1.3.2': 'A', '1.4.1': 'A', '1.4.3': 'AA', '1.4.4': 'AA', '1.4.5': 'AA', '1.4.10': 'AA', '1.4.11': 'AA', '1.4.12': 'AA', '1.4.13': 'AA',
  '2.1.1': 'A', '2.1.2': 'A', '2.1.4': 'A', '2.2.1': 'A', '2.2.2': 'A', '2.2.5': 'AAA', '2.3.1': 'A', '2.4.1': 'A', '2.4.2': 'A', '2.4.3': 'A', '2.4.4': 'A', '2.4.6': 'AA', '2.4.7': 'AA',
  '2.4.11': 'AA', '2.4.12': 'AAA', '2.4.13': 'AAA', '2.5.2': 'A', '2.5.3': 'A', '2.5.5': 'AAA', '2.5.7': 'AA', '2.5.8': 'AA',
  '3.2.3': 'AA', '3.2.4': 'AA', '3.2.6': 'A', '3.3.1': 'A', '3.3.2': 'A', '3.3.3': 'AA', '3.3.4': 'AA', '3.3.7': 'A', '3.3.8': 'AA', '4.1.2': 'A', '4.1.3': 'AA',
};

// Facts that more than one file states. Every place must keep matching its pattern, so changing a value in one file fails here
// until the others follow. A place is [path, pattern, minimum matches]. When a value changes on purpose, change the files and the pattern together.
const GUIDE = 'frontend/DESIGN_GUIDELINES.md';
const SKILLS = '.github/skills/';
const FACTS = [
  { id: 'toast-timing', places: [
    [GUIDE, /표시 시간은 8초에서 시작한다/],
    [GUIDE, /오류·위험 알림도 자동으로 닫지 않는다/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /A toast starts at 8 s, stays open while hovered or focused, and never auto-closes if it holds an action or reports an error or risk/],
  ] },
  { id: 'breakpoints', places: [
    [GUIDE, /760px\(\d+곳\)과 1100px\(\d+곳\)/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /repo breakpoints 760 and 1100 px/],
  ] },
  { id: 'target-sizes', places: [
    [GUIDE, /포인터 대상은 24×24 CSS px 이상이다[\s\S]*?44×44를 설계 목표로 한다/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /targets 24 by 24 CSS px[\s\S]*?44 by 44 for primary, frequent and touch controls/],
    ['.github/instructions/frontend-design.instructions.md', /pointer targets at least 24 by 24 px[\s\S]*?44 by 44 for primary and touch controls/],
  ] },
  { id: 'minimum-text', places: [
    [GUIDE, /필수 정보와 행동 라벨은 12px 미만으로 줄이지 않는다/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /Required information and action labels stay at 12px or more/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /required text 12px or more/],
  ] },
  { id: 'register', places: [
    [GUIDE, /서술은 합니다체, 사용자에게 시키는 말은 `-하세요`·`-해 주세요`, 라벨은 명사형/],
    ['.github/instructions/frontend-design.instructions.md', /Statements in 합니다체, instructions to the user as -하세요 or -해 주세요, labels as nouns/],
  ] },
  { id: 'severity', places: [
    [GUIDE, /\*\*P0\*\* \| 사용자를 오도하거나 안전을 해친다/],
    [GUIDE, /\*\*P1\*\* \| 과업을 막거나, 첫 화면·주 과업에서 AA 기준에 실패하거나, 보조기술을 막거나, 의미가 충돌한다/],
    [GUIDE, /\*\*P2\*\* \| 일관성 위반, 불필요한 중복, 모호한 문구, 그 밖의 곳에 있는 AA 미달/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /\*\*P0\*\* misleads or endangers/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /\*\*P1\*\* blocks a task, fails AA on the first screen or main task or blocks assistive technology, or conflicts in meaning/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /\*\*P2\*\* inconsistency, needless duplication, vague copy, AA misses elsewhere/],
    [`${SKILLS}ui-element-audit/assets/audit-sheet-template.md`, /P1 blocks a task or assistive technology, fails AA on the first screen or in the main task, or conflicts in meaning/],
  ] },
  { id: 'reduction-ladder', places: [
    [GUIDE, /제거 → 병합 → 기본값 → 지연 → 묶기 → 약화 순서로 줄인다/],
    [`${SKILLS}ui-simplify/SKILL.md`, /\(remove, merge, default, defer, group, soften\)/],
  ] },
  { id: 'korean-type', places: [
    [GUIDE, /한글 본문 1\.5~1\.7, 제목 1\.25~1\.4, 조밀한 표 1\.4~1\.5/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /body 1\.5 to 1\.7, headings 1\.25 to 1\.4, dense tables 1\.4 to 1\.5/],
    [GUIDE, /42rem 안팎에서 시작/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /start near 42rem/],
    [`${SKILLS}ui-visual-craft/references/snippets.md`, /max-inline-size: 42rem/],
  ] },
  { id: 'headline-scale', places: [
    [GUIDE, /2\.5~3\.5rem, 소제목의 1\.5배 이상/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /2\.5 to 3\.5rem, at least 1\.5 times the next heading/],
  ] },
  { id: 'working-memory', places: [
    [GUIDE, /Cowan은 [^\n]{0,40}약 3~5개 덩어리/, 2],
    [`${SKILLS}ui-simplify/SKILL.md`, /nor "about 3 to 5" caps menu size/],
  ] },
  { id: 'protected-items', places: [
    [GUIDE, /\*\*숨겨도 되는 것은 찾는 방법이 있는 것뿐이다\.\*\*/],
    [`${SKILLS}ui-simplify/SKILL.md`, /## Protected items: hide only if a way to find them remains/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /Protected items \(errors, scope, units, undo, access, audit, legal\) are never removed/],
  ] },
  { id: 'safe-feedback', places: [
    [GUIDE, /포커스를 가져오지 않는다/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /never steals focus/],
    [GUIDE, /서버의 예외 메시지 원문은 화면에 보이지 않는다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /Never show raw server exception text/],
  ] },
  { id: 'colour-and-motion', places: [
    [GUIDE, /빨강은 불가능·차단·오류를 뜻하는 메시지에만 쓰고/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /Red only for impossible, blocked or error/],
    [GUIDE, /`transition: all`을 쓰지 않고/],
    ['.github/instructions/frontend-design.instructions.md', /never `transition: all`/],
  ] },
  { id: 'reaudit-passes', places: [
    [GUIDE, /최대 3회/, 3],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /At most 3 passes/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /\(3 passes at most\)/],
    [`${SKILLS}ui-design-review/SKILL.md`, /at most 3 passes/],
    [`${SKILLS}ui-simplify/SKILL.md`, /\(3 passes at most\)/],
  ] },
  { id: 'ship-rule', places: [
    [GUIDE, /P0·P1이 열려 있거나, R4·R5가 4 미만이거나, 다른 항목이 3 미만이면 출시하지 않는다/],
    [`${SKILLS}ui-design-review/SKILL.md`, /Ship only when no P0 or P1 is open, R4 and R5 are 4 or more, and no other dimension is below 3/],
    [`${SKILLS}ui-design-review/references/screen-rubric.md`, /Ship rule: no open P0 or P1; R4 and R5 at 4 or more; no other dimension below 3/],
  ] },
  { id: 'menu-keys', places: [
    [GUIDE, /명령 메뉴\(`role="menu"`\)에서는 위·아래 화살표가 항목 사이로 포커스를 옮긴다\. Tab과 Shift\+Tab은 항목 사이를 옮기지 않고 메뉴를 닫으며/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /Command menu \(`role=menu`\): Up and Down move between items, Tab closes it, disabled items stay focusable/],
    [`${SKILLS}ui-element-audit/references/element-criteria-layers.md`, /Up and Down move between items and Tab closes it/],
    ['.github/instructions/frontend-design.instructions.md', /arrows move, Tab closes the menu/],
  ] },
  { id: 'character-key-shortcuts', places: [
    [GUIDE, /문자·숫자·기호 키만으로 된 단축키는 사용자가 끌 수 있거나, 수정 키를 넣어 다시 지정할 수 있거나, 해당 컴포넌트에 포커스가 있을 때만 켜져야 한다/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /switchable off, remappable or focus-only \(WCAG 2\.1\.4\)/],
    ['.github/instructions/frontend-design.instructions.md', /turned off, remapped or is focus-only \(WCAG 2\.1\.4\)/],
  ] },
  { id: 'confirmation-tiers', places: [
    [GUIDE, /확인의 수준은 위험에 맞춰 셋으로 나눈다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /Match the confirmation to the risk \(Cloudscape\)/],
  ] },
  { id: 'selection-scope', places: [
    [GUIDE, /체크박스 선택은 화면에 보이는 행에만 적용된다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /covers only the rows visible on the current page/],
  ] },
  { id: 'ai-review-strength', places: [
    [GUIDE, /검토의 강도는 위험에 맞춘다/],
    [`${SKILLS}ui-interaction-design/references/ai-features.md`, /Match review strength to risk/],
  ] },
  { id: 'toolbar-minimum', places: [
    [GUIDE, /툴바는 컨트롤이 셋 이상일 때만 쓰고/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /Toolbar: 3 or more controls/],
  ] },
  { id: 'inline-edit', places: [
    [GUIDE, /Enter는 저장, Esc는 취소로 한다/],
    [GUIDE, /긴 글은 포커스를 잃어도 편집 상태를 유지해/],
    [GUIDE, /영향이 큰 값에는 포커스를 잃어도 저장하지 않고 저장·취소 버튼으로 확정하게 한다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /Enter saves and Esc cancels/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /Long text stays in edit mode on blur/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /For high-impact values use Save and Cancel instead/],
  ] },
  { id: 'confirmation-tier-rules', places: [
    [GUIDE, /다시 만들기 쉬운 것은 확인 없이 바로 실행하되/],
    [GUIDE, /다시 만들기 어려운 단일·일괄 삭제는 확인 모달을 쓴다/],
    [GUIDE, /문구가 맞을 때까지 확인 버튼을 비활성으로 둘 수 있다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /act at once, undo first/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /unlikely to break running systems: confirm in a modal/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /the one disabled-submit exception/],
  ] },
  { id: 'banner-rule', places: [
    [GUIDE, /Atlassian은 배너를 한 번에 하나만 띄우고 닫을 수 없게 두라고 한다/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /banner for lasting limits or outages \(one at a time, stays until resolved\)/],
  ] },
  { id: 'ai-item-by-item', places: [
    [GUIDE, /건별로 확인받는다/],
    [`${SKILLS}ui-interaction-design/references/ai-features.md`, /one item at a time/],
  ] },
  { id: 'team-notified', places: [
    [GUIDE, /자동 보고 체계가 없으면 "팀에 알렸다"고 쓰지 않는다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /unless automatic reporting exists/],
    [`${SKILLS}ui-element-audit/references/element-criteria-layers.md`, /"team notified" without automatic reporting/],
  ] },
  { id: 'apple-hig', places: [
    [GUIDE, /"OK"는 순수 정보 경고에만 쓴다/],
    [GUIDE, /값을 입력하는 즉시 확인하고 문제를 발견하는 즉시 알린다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /OK only in purely informational alerts/],
  ] },
  { id: 'motion-ceiling', places: [
    [GUIDE, /450ms 이상은 운영 화면에서 쓰지 않는다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /never 450 ms or more in operations screens/],
  ] },
  { id: 'inp-threshold', places: [
    [GUIDE, /75번째 백분위수에서 200ms 이하/],
    [`${SKILLS}ui-design-review/SKILL.md`, /INP 200 ms/],
  ] },
  { id: 'label-length', places: [
    [GUIDE, /한국어 12자 안팎에서 시작/, 2],
    [`${SKILLS}ui-simplify/SKILL.md`, /about 12 Korean characters/],
  ] },
  { id: 'wcag-2-5-2', places: [
    ['.github/instructions/frontend-design.instructions.md', /not on `pointerdown` \(WCAG 2\.5\.2\)/],
    [GUIDE, /\*\*2\.5\.2 A:\*\*/],
  ] },
  { id: 'c07-c39-rows', places: [
    [GUIDE, /건너뛰기 링크가 첫 Tab 정지\(이 문서의 선택\. 2\.4\.1은 랜드마크·제목으로도 충족한다\)/],
    [`${SKILLS}ui-element-audit/references/element-criteria-structure.md`, /skip link is the first Tab stop \(design choice; WCAG 2\.4\.1 also accepts landmarks or headings\)/],
    [`${SKILLS}ui-element-audit/references/element-criteria-structure.md`, /can be turned off, remapped or is focus-only \(§5\.6\)/],
  ] },
  { id: 'disabled-vs-hidden', places: [
    [GUIDE, /사용자가 활성화할 방법도 없는 비활성 항목은 숨겨도 된다고 한다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Hide a disabled item only when it is unnecessary on the screen and nobody can enable it/],
  ] },
  { id: 'error-boundary', places: [
    [GUIDE, /오류 경계를 화면 단위와 영역 단위/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /error boundaries at page level and section level/],
  ] },
  { id: 'refresh-rule', places: [
    [GUIDE, /불러오는 동안 기존 데이터를 계속 보여 주고 조작할 수 있게 두며/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /keep the old data visible and usable meanwhile/],
  ] },
  { id: 'empty-value-mark', places: [
    [GUIDE, /새 표 칸에는 `-`를 쓰고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /use `-` in new table cells/],
  ] },
  { id: 'severity-contrast', places: [
    [`${SKILLS}ui-element-audit/SKILL.md`, /contrast under 4\.5:1, nameless control/],
  ] },
  { id: 'stop-rule', places: [
    [`${SKILLS}ui-guideline-maintenance/SKILL.md`, /Rubric mean ≥ 4\.5 and no dimension below 4/],
    [`${SKILLS}ui-guideline-maintenance/references/rubric.md`, /Target: mean ≥ 4\.5, no dimension < 4\./],
    [GUIDE, /목표는 평균 4\.5 이상, 모든 항목 4 이상이다/],
  ] },
  { id: 'size-budget', places: [
    [`${SKILLS}ui-guideline-maintenance/SKILL.md`, /`SKILL\.md` ≤ 150 lines; every `SKILL\.md` and reference file ≤ 8,000 bytes as stored on disk/],
  ] },
  { id: 'ariel-stays', places: [
    ['.github/instructions/frontend-design.instructions.md', /\(`Ariel` stays\)/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /Change `Ariel` in the font stack to `Arial`/],
  ] },
  { id: 'grid-model', places: [
    [GUIDE, /탭 정지는 하나이고, 화살표는 셀 사이로/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /Editable table cells: grid pattern/],
  ] },
  { id: 'theme-flag', places: [
    [`${SKILLS}ui-design-workflow/references/verify-rendered.md`, /`--theme` only emulates `prefers-color-scheme`\./],
    [`${SKILLS}ui-element-audit/SKILL.md`, /prefers-color-scheme only/],
  ] },
  { id: 'g2-default-button', places: [
    [GUIDE, /가로로 놓일 때는 끝쪽에, 세로로 쌓일 때는 맨 위에 두고, 취소 버튼은 보통 가로로는 앞쪽에, 세로로는 맨 아래에 둔다/],
  ] },
  { id: 'selection-scope-label', places: [
    [GUIDE, /5번의 범위 표시를 함께 쓴다\. \*\*\[설계 선택\]\*\*/],
  ] },
  { id: 'empty-list-value', places: [
    [GUIDE, /상세 값·목록에 `없음`/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /`없음` \(details and lists\)/],
  ] },
  { id: 'review-pointer', places: [
    [GUIDE, /확인 단계\(§5\.4\)를 높이는/],
  ] },
  { id: 'status-indicators', places: [
    [GUIDE, /상태 표시기는 색·모양·기호 가운데 둘 이상에 기댄다/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /relies on at least two of colour, shape and symbol/],
    [`${SKILLS}ui-element-audit/references/element-criteria-data.md`, /two or more of colour, shape, symbol/],
  ] },
  { id: 'tabs-model', places: [
    [GUIDE, /Tab 키는 탭 목록을 벗어나 탭 패널로 가며/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Tab leaves the tab list for the panel/],
    ['.github/instructions/frontend-design.instructions.md', /`aria-controls` on each tab/],
  ] },
  { id: 'treegrid-model', places: [
    [GUIDE, /포커스가 행에 있으면 오른쪽 화살표는 접힌 행을 펼치고 왼쪽 화살표는 펼친 행을 접는다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /with focus on a row, Right expands a collapsed row and Left collapses an expanded one/],
  ] },
  { id: 'refresh-live-region', places: [
    [GUIDE, /갱신 시각이 바뀌면 `role="status"`\(또는 `aria-live`\) 영역으로 알리고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Announce a changed refresh time in a `role="status"` region/],
  ] },
  { id: 'tabpanel-tabindex', places: [
    [GUIDE, /첫 내용이 포커스를 받을 수 없으면 패널에 `tabindex="0"`을 둔다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /no focusable content, or whose first content is not focusable, gets `tabindex="0"`/],
  ] },
  { id: 'bulk-selection-summary', places: [
    [GUIDE, /일괄 선택에는 요약과 결과 표시가 따른다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /header checkbox is `mixed`/],
  ] },
  { id: 'datevalue-opt-in', places: [
    [GUIDE, /`DateValue`에 시간대를 보이는 선택 속성을 더해 쓰고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /add optional props whose defaults keep today's output/],
    ['.github/instructions/frontend-design.instructions.md', /add optional props whose defaults keep today's output/],
  ] },
  { id: 'small-text-in-cells', places: [
    [GUIDE, /표의 `data-label` 칸 안에서도 `\.small-text`는 12px이다/],
    ['.github/instructions/frontend-design.instructions.md', /`\.small-text` is 12px inside a table `data-label` cell too/],
  ] },
  { id: 'tab-wrap', places: [
    [GUIDE, /처음과 끝에서는 반대쪽으로 순환한다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /arrows move focus and wrap/],
  ] },
  { id: 'grid-keys', places: [
    [GUIDE, /Ctrl\+Home·Ctrl\+End는 첫 셀·마지막 셀로/],
  ] },
  { id: 'selection-cleared', places: [
    [GUIDE, /정렬, 페이지 이동, 표시 설정 변경은 선택을 지우고/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /sorting, paging, display settings and rows leaving the view clear it/],
  ] },
  { id: 'initial-focus', places: [
    [GUIDE, /포커스는 가장 덜 파괴적인 선택에서 시작한다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /Start focus on the least destructive choice/],
  ] },
  { id: 'absolute-times', places: [
    [GUIDE, /승인·감사·만료·복구 시각에 절대 시각을 쓴다/],
    [GUIDE, /절대 시각에는 UTC 오프셋을 항상 붙이고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Approval, audit, expiry and recovery times are absolute with a UTC offset/],
  ] },
  { id: 'tab-aria-pair', places: [
    [GUIDE, /탭에 `aria-controls`, 패널에 `aria-labelledby`/],
    [GUIDE, /각 탭에는 `aria-controls`로 패널을, 패널에는 `aria-labelledby`로 탭을 잇고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Each tab has `aria-controls`, each panel `role="tabpanel"` with `aria-labelledby`/],
  ] },
  { id: 'status-label-default', places: [
    [GUIDE, /상태 배지에 글자 라벨을 기본으로 둔다/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /plus a text label by default/],
  ] },
  { id: 'carbon-status-source', places: [
    [GUIDE, /네 요소 중 세 가지 이상을 갖추라고도 한다 \[관행\]\[carbon-status\]/],
  ] },
  { id: 'large-text', places: [
    [GUIDE, /큰 글자\(18pt 이상, 굵은 14pt 이상\)는 3:1 이상/],
  ] },
  { id: 'login-generic', places: [
    [GUIDE, /무엇이 틀렸는지 밝히지 않고 같은 문장 하나로 알린다/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /get one generic sentence; a session that can expire warns first/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /one generic sentence whatever the cause/],
  ] },
  { id: 'save-always-enabled', places: [
    [GUIDE, /폼이 잘못됐거나 바뀌지 않았다는 이유로 비활성화하거나 숨기지 않는다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /never disable or hide it because the form is invalid or unchanged/],
  ] },
  { id: 'pass-condition', places: [
    [GUIDE, /합격은 P0·P1이 없을 때다/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /Pass means no P0 or P1/],
  ] },
  { id: 'unmarked-numbers', places: [
    [GUIDE, /예산\)는 모두 \*\*\[설계 선택\]\*\*이다/],
  ] },
  { id: 'disabled-source-key', places: [
    [GUIDE, /일반 텍스트로 보여 준다 \[관행\]\[cloudscape-disabled\]/],
  ] },
  { id: 'human-ai-sign', places: [
    [GUIDE, /사람·AI 중 더 나은 쪽보다 낮았다\(g=-0\.23\)/],
  ] },
  { id: 'text-too-small-gate', places: [
    [GUIDE, /`TEXT-TOO-SMALL` \| G7 \|/],
  ] },
  { id: 'no-database', places: [
    [GUIDE, /데이터베이스 서비스는 제안하지 않는다/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /introduce a database service for UI state \(persist only to Azure Storage/],
    ['.github/instructions/frontend-design.instructions.md', /No database services/],
  ] },
  { id: 'no-positive-tabindex', places: [
    [GUIDE, /양수 `tabindex`로 순서를 맞추지 않는다/, 2],
    ['.github/instructions/frontend-design.instructions.md', /no positive `tabindex`/],
  ] },
  { id: 'instruction-deviations', places: [
    ['.github/instructions/frontend-design.instructions.md', /`RequestActionMenu\.tsx` skips disabled items in its arrow loop and lets Tab walk the items/],
    ['.github/instructions/frontend-design.instructions.md', /takes `id` and `panelId` \(it sets `aria-controls`/],
  ] },
  { id: 'apply-after-diff', places: [
    [`${SKILLS}ui-interaction-design/references/ai-features.md`, /Apply stays disabled, with its reason, until the diff was opened/],
  ] },
  { id: 'apply-to-scope', places: [
    ['.github/instructions/frontend-design.instructions.md', /applyTo: "frontend\/src\/\*\*\/\*\.tsx,frontend\/src\/\*\*\/\*\.ts,frontend\/src\/\*\*\/\*\.css"/],
  ] },
  { id: 'status-two-signals', places: [
    [GUIDE, /색·모양·기호 중 둘 이상\(§4\.4\)/],
    [`${SKILLS}ui-element-audit/references/element-criteria-data.md`, /two or more of colour, shape, symbol \(§4\.4\)/],
  ] },
  { id: 'forced-colors', places: [
    [GUIDE, /`forced-color-adjust: none`은 사용자의 색·대비 요구를 더 잘 지원하는 조정에만 쓰고/],
    [GUIDE, /경계는 `border`, 포커스는 `outline`, 상태는 글자나 기호로 전한다/],
    ['.github/instructions/frontend-design.instructions.md', /draw boundaries with `border`, focus with `outline`, status with text or a symbol/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /boundaries use `border`, focus `outline`, status text or a symbol/],
    [`${SKILLS}ui-element-audit/SKILL.md`, /`--forced-colors` \(Windows high contrast\)/],
  ] },
  { id: 'timestamps', places: [
    [GUIDE, /UTC도 `UTC\+0:00`처럼 쓴다/],
    [GUIDE, /`datetime`을 기계가 읽는 형식/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /UTC as `UTC\+0:00`/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /`datetime` is never prose/],
    [`${SKILLS}ui-visual-craft/SKILL.md`, /absolute times carry a UTC offset/],
    ['.github/instructions/frontend-design.instructions.md', /`datetime` holds an ISO value, never prose/],
  ] },
  { id: 'tabbar-claim', places: [
    [GUIDE, /`panelId`를 받아 탭에 `aria-controls`를 달고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /accepts `id` and `panelId` and sets `aria-controls`/],
  ] },
  { id: 'datevalue-claim', places: [
    [GUIDE, /브라우저의 현지 시각을 시간대 표시 없이 보여 주고/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /`DateValue` shows local time without a zone/],
    ['.github/instructions/frontend-design.instructions.md', /`DateValue` shows local time without a zone/],
  ] },
  { id: 'no-match-state', places: [
    [GUIDE, /검색·필터 결과 없음은 원인과, 조건을 지우거나 고치는 방법을 함께 보인다/],
    [GUIDE, /공백만 입력했거나 목록 자체가 비어 있으면 검색이 원인이 아니므로/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /No-match state \(search or filter\)/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /A blank-only term or an empty catalog is not a search miss/],
  ] },
  { id: 'focus-after-clear', places: [
    [GUIDE, /지우면 그 버튼이 사라지므로 포커스를 검색 입력으로 보낸다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /move focus to the search input with a ref/],
  ] },
  { id: 'space-token-fact', places: [
    [GUIDE, /\(`var\(--space-` 0건\)/],
    ['.github/instructions/frontend-design.instructions.md', /Existing CSS never uses `--space-\*`/],
  ] },
  { id: 'empty-state-text-size', places: [
    [GUIDE, /`\.empty-state p`는 12px이다/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /`EmptyState` text is 12px \(`\.empty-state p`\)/],
    ['.github/instructions/frontend-design.instructions.md', /Text inside `EmptyState` is 12px/],
  ] },
  { id: 'no-br-layout', places: [
    [`${SKILLS}ui-visual-craft/SKILL.md`, /never `<br>` or empty spacers/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /never `<br>`/],
    ['.github/instructions/frontend-design.instructions.md', /No `<br>` for layout/],
  ] },
  { id: 'new-state-test', places: [
    [`${SKILLS}ui-design-workflow/references/verify-rendered.md`, /A new state or behaviour gets a case in that spec/],
  ] },
  // Status words and order-sensitive values. A swap keeps the numbers ledger quiet, so these sentences are pinned as written.
  { id: 'standard-status', places: [
    [GUIDE, /WCAG 3\.0은 2026-09-10 기준 W3C 작업 초안이고/],
    [GUIDE, /WCAG 3\.0은 2026-09-10 W3C 작업 초안이다/],
    [GUIDE, /2025\.10 명세는 안정 상태이며 W3C 표준은 아니다/],
    [GUIDE, /기본 적합성 목표는 \*\*WCAG 2\.2 AA\*\*다/],
    [GUIDE, /\*\*\[연구\]\*\* Design Theater\(AAAI\/AIES\)/],
    [GUIDE, /4\.499:1은 4\.5:1을 충족하지 못한다/],
  ] },
  { id: 'ordered-values', places: [
    [GUIDE, /50ms 노출에서도 500ms 평가와 가깝게 나왔다/],
    [GUIDE, /역할 토큰 · 4\.5:1 \/ 3:1 · 아이콘·글자 병행/],
    ['.github/instructions/frontend-design.instructions.md', /Contrast 4\.5:1 for text and 3:1 for large text and UI parts/],
    [GUIDE, /컨트롤 높이 \| 편안함 44px, 촘촘함 32px/],
    [GUIDE, /컨트롤 6px, 표면 8px, 대화상자 12px/],
    [GUIDE, /개별 대상 9\.2mm, 연속 입력 9\.6mm면 충분하다고 결론/],
    [GUIDE, /재현율 92\.1%, 정밀도 87\.3%/],
    [GUIDE, /한 손 49%, 두 손으로 받치고 한 손으로만 조작 36%, 두 손으로 받치고 두 엄지로 입력 15%/],
    [`${SKILLS}ui-visual-craft/references/ergonomics.md`, /one hand 49%, cradled 36%, two hands 15%/],
    [GUIDE, /표준 곡선은 `cubic-bezier\(0\.2, 0, 0, 1\)`\(`easing-standard`\), 가속 곡선은 `cubic-bezier\(0\.3, 0, 1, 1\)`\(`easing-standard-accelerate`\)/],
    [`${SKILLS}ui-interaction-design/references/states-and-feedback.md`, /Easing `cubic-bezier\(0\.2, 0, 0, 1\)`, exits `cubic-bezier\(0\.3, 0, 1, 1\)`/],
    [GUIDE, /높이는 뷰포트의 6분의 1 이하에서 시작한다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /\(a sixth of the viewport height at most\)/],
    [`${SKILLS}ui-guideline-maintenance/references/trial-protocol.md`, /Judge twice with positions swapped to reduce position bias\./],
    [GUIDE, /3순위가 4순위를 이기는 것은 시각 패턴이고 1순위의 접근성 규칙은 아니다/],
    [GUIDE, /`100vh`는 `lvh`, 곧 브라우저 UI가 접힌 큰 뷰포트와 같다/],
    [`${SKILLS}ui-visual-craft/references/ergonomics.md`, /`100vh` equals `lvh` \(browser UI retracted\)/],
  ] },
  // Safety rules that the guide and a Skill both state. A flip in one place must fail until the other follows.
  { id: 'focus-after-delete', places: [
    [GUIDE, /다음 행, 없으면 이전 행, 없으면 표 제목으로 옮기고/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /focus the next row's first control, else the previous row's, else the table heading/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /the next row's first control, else the previous row's, else the table heading/],
  ] },
  { id: 'bulk-retry-failed', places: [
    [GUIDE, /실패한 건만 다시 시도하게 한다/],
    [`${SKILLS}ui-interaction-design/references/destructive-and-async.md`, /retry only the failed ones/],
  ] },
  { id: 'validate-on-submit', places: [
    [GUIDE, /기본은 \*\*제출 시 전체 검증\*\*이다/],
    [`${SKILLS}ui-interaction-design/references/forms-and-validation.md`, /Default: validate on submit, all at once\./],
  ] },
  { id: 'label-on-top', places: [
    [GUIDE, /기본은 필드 위\(top\)다/],
  ] },
  { id: 'ask-only-irreversible', places: [
    [GUIDE, /\*\*묻는다:\*\* 되돌릴 수 없는 결정\(권한·삭제·결제·개인정보\)/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /irreversible decisions \(permissions, deletion, payment, personal data\)/],
    [`${SKILLS}ui-design-workflow/assets/brief-template.md`, /the answer changes an irreversible decision/],
  ] },
  { id: 'server-contract-wins', places: [
    [`${SKILLS}ui-design-workflow/SKILL.md`, /A server contract \(a required reason, `expected_revision`\) outranks wording such as "edit directly"/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /take the least risky assumption \(reversible, narrowest permission, Draft only\)/],
  ] },
  { id: 'e2e-build-first', places: [
    [GUIDE, /e2e는 `dist`를 복사해 쓰므로 먼저 빌드한다/],
    ['.github/instructions/frontend-design.instructions.md', /Run e2e after a build with `--workers=1`/],
    [`${SKILLS}ui-design-workflow/references/verify-rendered.md`, /then the e2e spec for the area with `--workers=1` \(build first;/],
  ] },
  { id: 'action-button-scope', places: [
    [GUIDE, /`ActionButton`\(`disabledReason`\)은 이미 그것을 쓰는 화면에만 남긴다/],
    [GUIDE, /`ActionButton`\(`disabledReason`\. 기존 화면에 한하고 새 컨트롤은 §5\.1\)/],
    ['.github/instructions/frontend-design.instructions.md', /`ActionButton` only on screens that already use it/],
    ['.github/instructions/frontend-design.instructions.md', /`ActionButton\(disabledReason\)` stays only where a screen already uses it/],
    [`${SKILLS}ui-interaction-design/SKILL.md`, /The `ActionButton` wrapper is a `tabIndex=0` span with no role or name, so do not copy it/],
  ] },
  { id: 'viewport-list', places: [
    [GUIDE, /기본 점검은 320 \/ 390 \/ 1024 \/ 1440px이고, 768px과 낮은 화면은 검수·시험 작업에서 더한다/],
    [`${SKILLS}ui-design-workflow/SKILL.md`, /look at 320, 390, 1024 and 1440 px/],
    [`${SKILLS}ui-design-workflow/references/verify-rendered.md`, /screenshots at 320, 390, 1024 and 1440 px/],
    [`${SKILLS}ui-design-review/SKILL.md`, /Open the screen at 320, 390, 1024 and 1440 px \(add 768 px and the low heights of guide §11\.1 for a full review\)/],
  ] },
  { id: 'planted-wrong-suggestion', places: [
    [GUIDE, /시험용 목업과 고정 데이터에 틀린 제안을 하나 일부러 넣고/],
    [GUIDE, /중요한 제안은 적용 전에 비교 화면을 반드시 거치게 한다/],
  ] },
];

function checkFacts() {
  for (const fact of FACTS) {
    const files = [...new Set(fact.places.map(place => place[0]))];
    for (const [path, pattern, minimum = 1] of fact.places) {
      const file = join(root, path);
      if (!existsSync(file)) { add('error', file, 'fact', `Fact "${fact.id}": file not found`); continue; }
      const count = (read(file).match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
      if (count < minimum) add('error', file, 'fact', `Fact "${fact.id}" no longer matches ${pattern} (${count} of ${minimum}). Also stated in: ${files.join(', ')}`);
    }
  }
}

function checkGateNames(text, file) {
  const wrong = (index, gate, language, found) => add('error', file, 'canon', `${gate} is named "${GATES[gate][language]}", found "${found}"`, lineOf(text, index));
  for (const match of text.matchAll(/^#{3,4} (G[1-8]) (.+?)\s*$/gm)) if (match[2] !== GATES[match[1]][0]) wrong(match.index, match[1], 0, match[2]);
  for (const match of text.matchAll(/\*\*(G[1-8]) ([^*]+)\*\*/g)) if (match[2] !== GATES[match[1]][0]) wrong(match.index, match[1], 0, match[2]);
  for (const match of text.matchAll(/^\| (G[1-8]) ([A-Za-z][A-Za-z ]*?) \|/gm)) if (match[2] !== GATES[match[1]][1]) wrong(match.index, match[1], 1, match[2]);
}

function checkLadder(text, file) {
  for (const match of text.matchAll(/^\| ([1-6]) (제거|병합|기본값|지연|묶기|약화|Remove|Merge|Default|Defer|Group|Soften) \|/gm)) {
    const step = LADDER[Number(match[1]) - 1];
    if (!step.includes(match[2])) add('error', file, 'canon', `Reduction ladder step ${match[1]} is ${step.join(' / ')}, found ${match[2]}`, lineOf(text, match.index));
  }
}

function checkWcagLevels(text, file) {
  // "2.4.11 AA", "2.4.11 (AA)", "2.2.5 is AAA", "2.2.5는 AAA"
  for (const match of text.matchAll(/\b([1-4]\.\d{1,2}\.\d{1,2})(?:\s*\((AAA|AA|A)\)|\s+(AAA|AA)\b|\s+(A)(?=[\]),.;:*])|\s*(?:은|는|이|가|is|=|:)\s*(?:level\s+)?(AAA|AA|A)(?![\p{L}\d]))/gu)) {
    const level = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (SC_LEVEL[match[1]] && level !== SC_LEVEL[match[1]]) add('error', file, 'wcag', `WCAG ${match[1]} is level ${SC_LEVEL[match[1]]}, found ${level}`, lineOf(text, match.index));
  }
  // "AAA(2.2.5)": the level comes first.
  for (const match of text.matchAll(/(?<![\p{L}\d])(AAA|AA|A)\s*\(([1-4]\.\d{1,2}\.\d{1,2})\)/gu)) {
    if (SC_LEVEL[match[2]] && match[1] !== SC_LEVEL[match[2]]) add('error', file, 'wcag', `WCAG ${match[2]} is level ${SC_LEVEL[match[2]]}, found ${match[1]}`, lineOf(text, match.index));
  }
}

function checkCanon(text, file) {
  checkGateNames(text, file);
  checkLadder(text, file);
  if (/\bDUP1\s*(?:to|–|-|~)\s*DUP9\b/.test(text)) add('error', file, 'canon', 'Duplicate types run DUP1 to DUP10');
  // Gates run G1 to G8. The human-AI guidelines are written HAX1 to HAX18 so the two label sets cannot be confused.
  text.split('\n').forEach((line, index) => { if (/\bG(?:9|1[0-8])\b/.test(line) && !/HAX/.test(line)) add('error', file, 'canon', 'Gate label above G8; gates run G1 to G8 (HAX items are HAX1 to HAX18)', index + 1); });
  for (const match of text.matchAll(/^Verdicts?: (.+)$/gm)) {
    const missing = CANON.verdicts.filter(verdict => !match[1].includes(verdict));
    if (missing.length) add('error', file, 'canon', `Verdict list lacks ${missing.join(', ')}`, lineOf(text, match.index));
  }
  for (const [name, limit] of Object.entries(CANON.budgets.en)) {
    for (const match of text.matchAll(new RegExp(`\\|\\s*${name}\\s*\\|\\s*(\\d+) or fewer`, 'gi'))) {
      if (Number(match[1]) !== limit) add('error', file, 'canon', `Budget for ${name} is ${limit}, found ${match[1]}`, lineOf(text, match.index));
    }
  }
  for (const [name, limit] of Object.entries(CANON.budgets.ko)) {
    for (const match of text.matchAll(new RegExp(`\\|\\s*${name}\\s*\\|\\s*(\\d+) 이하`, 'g'))) {
      if (Number(match[1]) !== limit) add('error', file, 'canon', `Budget for ${name} is ${limit}, found ${match[1]}`, lineOf(text, match.index));
    }
  }
  for (const match of text.matchAll(/shadows?[^.\n]{0,80}at most (\d+)/gi)) {
    if (Number(match[1]) !== CANON.budgets.en.shadows) add('error', file, 'canon', `Shadow budget is ${CANON.budgets.en.shadows}, found ${match[1]}`, lineOf(text, match.index));
  }
}

function checkConstants(text, file) {
  checkCanon(text, file);
  for (const match of text.matchAll(/(\d+(?:\.\d+)?):1\b/g)) {
    const ratio = Number(match[1]);
    // Ratios below 3 are failing examples; 4.499 is the documented rounding example.
    if (ratio >= 3 && !ALLOWED_CONTRAST.has(ratio)) add('warn', file, 'constant', `Unexpected contrast ratio ${match[0]} (allowed 3, 4.5, 7)`, lineOf(text, match.index));
  }
  for (const match of text.matchAll(/(\d+)\s*(?:[×x]|by)\s*(\d+)\s*(?:CSS\s*)?px/g)) {
    if (match[1] === match[2] && !ALLOWED_SQUARE_TARGETS.has(Number(match[1])) && !/audit-fixture/.test(file)) add('warn', file, 'constant', `Unexpected square target size ${match[0]} (allowed 24, 32, 44)`, lineOf(text, match.index));
  }
  text.split('\n').forEach((line, index) => {
    if (/WCAG\s*2\.1(?!\.?\d)/.test(line) && !/UAIS|연구|KWCAG/.test(line)) add('warn', file, 'constant', 'Mentions WCAG 2.1; the target is WCAG 2.2', index + 1);
  });
  if (/\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum/i.test(text)) add('error', file, 'placeholder', 'Placeholder text found');
  checkWcagLevels(text, file);
}

function checkFileBytes(text, file) {
  const bytes = statSync(file).size;
  if (bytes > LIMITS.fileBytesError) add('error', file, 'size', `${bytes} bytes as stored (budget ${LIMITS.fileBytesError}); some agents cannot read a larger file in one call, so move detail into smaller references`);
  else if (bytes > LIMITS.fileBytesWarn) add('warn', file, 'size', `${bytes} bytes as stored; within ${LIMITS.fileBytesError - LIMITS.fileBytesWarn} bytes of the ${LIMITS.fileBytesError}-byte budget`);
}

function checkTables(text, file) {
  let width = null;
  text.split('\n').forEach((line, index) => {
    if (!line.startsWith('|')) { width = null; return; }
    const cells = line.replace(/\\\|/g, '').replace(/`[^`]*`/g, m => m.replace(/\|/g, '')).split('|').length;
    if (width === null) width = cells;
    else if (cells !== width) add('error', file, 'table', `Inconsistent table column count (${cells} vs ${width})`, index + 1);
  });
  if ((text.match(/^```/gm) ?? []).length % 2) add('error', file, 'fence', 'Unbalanced code fence');
}

function slug(heading) {
  return heading.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
}

let guideSections = new Set();
function checkSectionRefs(text, file) {
  if (!guideSections.size) return;
  for (const match of text.matchAll(/§(\d+(?:\.\d+)?)/g)) {
    if (!guideSections.has(match[1])) add('error', file, 'xref', `Reference §${match[1]} does not match any guide heading`, lineOf(text, match.index));
  }
}

// A heading such as "열두 가지 원칙" or "여덟 관문" must match the number of items the section lists.
function checkCountHeadings(text, file) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((line, index) => { const match = line.match(/^(#{2,4}) (.+)$/); if (match) heads.push({ level: match[1].length, title: match[2], line: index }); });
  heads.forEach((head, i) => {
    const word = head.title.match(/(열다섯|열네|열세|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한) ?(?:가지|관문)/);
    if (!word) return;
    const own = lines.slice(head.line + 1, heads[i + 1] ? heads[i + 1].line : lines.length);
    const stop = heads.findIndex((other, j) => j > i && other.level <= head.level);
    const subs = heads.slice(i + 1, stop < 0 ? heads.length : stop).filter(other => other.level === head.level + 1).length;
    const rows = own.filter(line => line.startsWith('|')).length - 2;
    const actual = own.filter(line => /^\d+\. /.test(line)).length || (rows > 0 ? rows : subs);
    if (actual && actual !== COUNT_WORDS[word[1]]) add('error', file, 'count', `Heading "${head.title}" says ${COUNT_WORDS[word[1]]} but the section lists ${actual}`, head.line + 1);
  });
}

function validateGuide() {
  if (!existsSync(guidePath)) { add('error', guidePath, 'missing', 'Design guide not found'); return; }
  const text = read(guidePath);
  const review = text.match(/기준일 \*\*(\d{4}-\d{2}-\d{2})\*\* · 다음 점검 예정일 \*\*(\d{4}-\d{2}-\d{2})\*\*/);
  if (!review) add('error', guidePath, 'schedule', 'Header needs "기준일 **YYYY-MM-DD** · 다음 점검 예정일 **YYYY-MM-DD**"');
  else {
    const days = Math.round((Date.parse(review[2]) - Date.parse(review[1])) / 864e5);
    if (days > LIMITS.reviewDays) add('error', guidePath, 'schedule', `Next review is ${days} days after the base date (limit ${LIMITS.reviewDays})`);
  }
  const headings = [...text.matchAll(/^(#{1,4}) (.+)$/gm)].map(m => ({ level: m[1].length, title: m[2], line: lineOf(text, m.index) }));
  guideSections = new Set(headings.filter(h => h.level === 2 || h.level === 3).map(h => h.title.match(/^(\d+(?:\.\d+)?)\.?\s/)?.[1]).filter(Boolean));
  for (const required of REQUIRED_GUIDE_HEADINGS) if (!headings.some(h => h.level <= 3 && required.test(h.title))) add('error', guidePath, 'coverage', `No heading matches ${required}`);
  const numbered = headings.filter(h => h.level === 2 && /^\d+\./.test(h.title)).map(h => Number(h.title.match(/^(\d+)\./)[1]));
  numbered.forEach((n, i) => { if (n !== numbered[0] + i) add('error', guidePath, 'numbering', `Section numbering gap near ${n}`); });
  checkCountHeadings(text, guidePath);
  if (/<!--\s*NEXT\s*-->/.test(text)) add('error', guidePath, 'marker', 'Leftover <!-- NEXT --> authoring marker');
  const linked = new Set([...text.matchAll(/\]\(#([^)\s]+)\)/g)].map(m => decodeURIComponent(m[1])));
  for (const h of headings.filter(x => x.level === 2 && x.title !== '목차')) if (!linked.has(slug(h.title))) add('warn', guidePath, 'toc', `Heading "${h.title}" is missing from the table of contents`, h.line);
  const slugs = new Set(headings.map(h => slug(h.title)));
  for (const match of text.matchAll(/\]\(#([^)\s]+)\)/g)) if (!slugs.has(decodeURIComponent(match[1]))) add('error', guidePath, 'anchor', `Broken anchor #${match[1]}`, lineOf(text, match.index));
  const definitions = new Map([...text.matchAll(/^\[([^\]\n]+)\]:\s+(\S+)\s*$/gm)].map(m => [m[1].toLowerCase(), m[2]]));
  const used = new Set([...text.matchAll(/\[[^\]\n]+\]\[([^\]\n]+)\]/g)].map(m => m[1].toLowerCase()));
  for (const key of used) if (!definitions.has(key)) add('error', guidePath, 'source', `Undefined source reference [${key}]`);
  for (const key of definitions.keys()) if (!used.has(key)) add('warn', guidePath, 'source', `Unused source definition [${key}]`);
  for (const [key, url] of definitions) if (!/^https:\/\//.test(url)) add('error', guidePath, 'source', `Source [${key}] must use https`);
  for (const match of text.matchAll(/\[(표준|규제|연구)[^\]\n]*\]\[([^\]\n]+)\]/g)) {
    const url = definitions.get(match[2].toLowerCase());
    if (!url) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (!LABEL_HOSTS[match[1]][0].test(host)) add('error', guidePath, 'label', `[${match[1]}] cites ${host} through [${match[2]}]; link a ${LABEL_HOSTS[match[1]][1]} or change the label`, lineOf(text, match.index));
  }
  // A design-system key names a topic ("cloudscape-delete"); its URL must be about that topic.
  for (const [key, url] of definitions) {
    const vendor = key.match(/^(cloudscape|atlassian|apple|apg|primer|carbon)-(.+)$/);
    if (!vendor) continue;
    let path = '';
    try { path = new URL(url).pathname.toLowerCase().replace(/[_%]/g, '-'); } catch { continue; }
    const topics = vendor[2].split('-').filter(word => word.length >= 4);
    if (topics.length && !topics.some(word => path.includes(word.slice(0, 5)))) add('error', guidePath, 'source', `Source [${key}] names a topic that its URL path does not contain: ${url}`);
  }
  const rows = (text.match(/^\| C\d{2} \|/gm) ?? []).length;
  for (const match of text.matchAll(/(\d+)개 구성 요소/g)) if (Number(match[1]) !== rows) add('error', guidePath, 'count', `Text says ${match[1]} components but the table has ${rows}`, lineOf(text, match.index));
  checkLocalLinks(text, guidePath);
  checkSectionRefs(text, guidePath);
  checkConstants(text, guidePath);
  checkTables(text, guidePath);
  return { urls: [...definitions.values()], lines: text.split('\n').length, sources: definitions.size };
}

function validateSkills() {
  if (!existsSync(skillsDir)) { add('error', skillsDir, 'missing', 'No .github/skills directory'); return { skills: 0, urls: [] }; }
  const urls = [];
  let count = 0;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) { add('error', dir, 'skill', 'Directory has no SKILL.md'); continue; }
    count++;
    const text = read(file);
    checkFileBytes(text, file);
    const parsed = parseFrontmatter(text, file);
    if (parsed) {
      const { name, description } = parsed.data;
      if (!name) add('error', file, 'skill', 'Missing name');
      else {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) add('error', file, 'skill', `Invalid name "${name}" (lowercase letters, numbers, hyphens)`);
        if (name.length > LIMITS.nameMax) add('error', file, 'skill', `name exceeds ${LIMITS.nameMax} characters`);
        if (name !== entry.name) add('error', file, 'skill', `name "${name}" must match directory "${entry.name}"`);
      }
      if (!description) add('error', file, 'skill', 'Missing description');
      else {
        if (description.length > LIMITS.descriptionMax) add('error', file, 'skill', `description is ${description.length} characters (max ${LIMITS.descriptionMax})`);
        if (!/use when|use for|when:/i.test(description)) add('error', file, 'skill', 'description must say when to use the skill ("Use when ...")');
        if (description.length < 120) add('warn', file, 'skill', 'description is short; add trigger keywords');
      }
      const lines = text.split('\n').length;
      if (lines > LIMITS.skillLinesError) add('error', file, 'size', `SKILL.md has ${lines} lines (budget ${LIMITS.skillLinesError})`);
      else if (lines > LIMITS.skillLinesWarn) add('warn', file, 'size', `SKILL.md has ${lines} lines (target <= ${LIMITS.skillLinesWarn})`);
    }
    checkLocalLinks(text, file, { confineTo: dir });
    checkSectionRefs(text, file);
    checkConstants(text, file);
    checkTables(text, file);
    urls.push(...[...text.matchAll(/https:\/\/[^\s)>\]]+/g)].map(m => m[0]));
    for (const sub of ['references', 'assets', 'scripts']) {
      const subDir = join(dir, sub);
      if (!existsSync(subDir)) continue;
      for (const item of readdirSync(subDir)) {
        const path = join(subDir, item);
        if (!statSync(path).isFile()) { add('warn', path, 'layout', 'Nested directory; keep references one level deep'); continue; }
        if (!text.includes(`./${sub}/${item}`)) add('warn', path, 'layout', 'File is not linked from SKILL.md');
        if (item.endsWith('.md')) { const extra = read(path); checkFileBytes(extra, path); checkLocalLinks(extra, path, { confineTo: dir }); checkSectionRefs(extra, path); checkConstants(extra, path); checkTables(extra, path); }
      }
    }
  }
  return { skills: count, urls };
}

// The guide's element table (section 8.4) and the element-criteria references repeat the same rows. Ids and the numbers a row
// states (sizes, limits, counts) must agree, so a change made in one place cannot silently skip the other.
function checkRowParity() {
  const dir = join(skillsDir, 'ui-element-audit', 'references');
  if (!existsSync(guidePath) || !existsSync(dir)) return;
  const rowsOf = text => new Map([...text.matchAll(/^\| (C\d{2}) \|(.*)$/gm)].map(m => [m[1], m[2]]));
  const numbersOf = row => new Set(row.replace(/§[\d.]+|\[[^\]]*\]|\b[GC]\d+\b|\d+\.\d+(?:\.\d+)?/g, ' ').match(/\d+/g) ?? []);
  const guideRows = rowsOf(read(guidePath));
  const referenceRows = new Map();
  for (const item of readdirSync(dir).filter(name => /^element-criteria-.*\.md$/.test(name))) {
    for (const [id, row] of rowsOf(read(join(dir, item)))) referenceRows.set(id, { row, file: join(dir, item) });
  }
  for (const [id, row] of guideRows) {
    const other = referenceRows.get(id);
    if (!other) { add('error', guidePath, 'parity', `${id} is in the guide but in no element-criteria file`); continue; }
    const a = numbersOf(row), b = numbersOf(other.row);
    const diff = [...new Set([...[...a].filter(n => !b.has(n)), ...[...b].filter(n => !a.has(n))])];
    if (diff.length) add('error', other.file, 'parity', `${id}: numbers differ between the guide and this file (${diff.join(', ')})`);
    const pointers = row => new Set(row.match(/§\d+(?:\.\d+)?/g) ?? []);
    const pa = pointers(row), pb = pointers(other.row);
    const pointerDiff = [...pa].filter(p => !pb.has(p)).concat([...pb].filter(p => !pa.has(p)));
    if (pointerDiff.length) add('error', other.file, 'parity', `${id}: section pointers differ between the guide and this file (${pointerDiff.join(', ')})`);
    // Code terms (`aria-controls`, `th scope`) do not change with the language, so the two rows must name the same ones.
    const termsOf = text => new Set([...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]));
    const ta = termsOf(row), tb = termsOf(other.row);
    const termDiff = [...ta].filter(term => !tb.has(term)).concat([...tb].filter(term => !ta.has(term)));
    if (termDiff.length) add('error', other.file, 'parity', `${id}: code terms differ between the guide and this file (${termDiff.join(', ')})`);
  }
  for (const [id, { file }] of referenceRows) if (!guideRows.has(id)) add('error', file, 'parity', `${id} is not in the guide's element table`);
  // The title of each file lists the rows it holds, for example "(C25 to C38, C40)".
  for (const item of readdirSync(dir).filter(name => /^element-criteria-.*\.md$/.test(name))) {
    const content = read(join(dir, item));
    const label = content.match(/^# .*\(([^)]*C\d{2}[^)]*)\)/m);
    if (!label) continue;
    const expected = new Set();
    for (const part of label[1].split(',')) {
      const range = part.match(/C(\d+) to C(\d+)/);
      if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) expected.add(`C${String(n).padStart(2, '0')}`);
      else { const one = part.match(/C(\d+)/); if (one) expected.add(`C${one[1].padStart(2, '0')}`); }
    }
    const actual = new Set(rowsOf(content).keys());
    const gap = [...actual].filter(id => !expected.has(id)).concat([...expected].filter(id => !actual.has(id)));
    if (gap.length) add('error', join(dir, item), 'parity', `Title range "${label[1]}" does not match the rows (${gap.join(', ')})`);
  }
}

function validateInstructions() {
  if (!existsSync(instructionPath)) { add('warn', instructionPath, 'instructions', 'Instruction file not found'); return; }
  const text = read(instructionPath);
  const parsed = parseFrontmatter(text, instructionPath);
  if (parsed) {
    if (!parsed.data.description) add('error', instructionPath, 'instructions', 'Missing description');
    if (!parsed.data.applyTo) add('error', instructionPath, 'instructions', 'Missing applyTo');
    else if (/^["']?\*\*["']?$/.test(parsed.data.applyTo)) add('error', instructionPath, 'instructions', 'applyTo "**" loads the file for every request');
  }
  const lines = text.split('\n').length;
  if (lines > LIMITS.instructionLines) add('error', instructionPath, 'size', `Instruction file has ${lines} lines (budget ${LIMITS.instructionLines})`);
  checkLocalLinks(text, instructionPath);
  checkConstants(text, instructionPath);
}

// Claims about this repository (not about the world) go stale when the code changes, so re-check them against the tree.
function checkRepoClaims() {
  const src = join(root, 'frontend', 'src');
  if (!existsSync(src)) return;
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (/\.[jt]sx?$/.test(entry.name)) files.push(path); } };
  walk(src);
  const guideText = existsSync(guidePath) ? read(guidePath) : '';
  const claim = guideText.match(/`frontend\/src`에는 `ErrorBoundary`[^\n]*?가 (없다|있다)/);
  if (!claim) add('error', guidePath, 'repo-claim', 'The guide no longer states whether frontend/src has an error boundary; section 5.1 relies on it');
  else {
    const hit = files.find(file => /ErrorBoundary|componentDidCatch|getDerivedStateFromError/.test(read(file)));
    if ((claim[1] === '없다') === Boolean(hit)) add('error', guidePath, 'repo-claim', `The guide says frontend/src ${claim[1]} an error boundary, but ${hit ? `${relative(root, hit)} mentions one` : 'none was found'}; update section 5.1 and states-and-feedback.md`);
  }
  const menu = files.find(file => file.endsWith('RequestActionMenu.tsx'));
  const cssText = readdirSync(src).filter(name => name.endsWith('.css')).map(name => read(join(src, name))).join('\n');
  const spaceUses = (cssText.match(/var\(--space-/g) ?? []).length;
  if (!/\(`var\(--space-` 0건\)/.test(guideText)) add('error', guidePath, 'repo-claim', 'The guide no longer states how many times the CSS uses var(--space-*); section 14.2 and the instruction file rely on it');
  else if (spaceUses > 0) add('error', guidePath, 'repo-claim', `The guide says the CSS never uses var(--space-*), but ${spaceUses} uses exist; update section 14.2 and the instruction file`);
  const emptyRule = cssText.match(/\.empty-state p\{[^}]*?font-size:(\d+)px/);
  if (!/`\.empty-state p`는 12px이다/.test(guideText)) add('error', guidePath, 'repo-claim', 'The guide no longer states the size of .empty-state p; section 14.4 item 10 relies on it');
  else if (!emptyRule || emptyRule[1] !== '12') add('error', guidePath, 'repo-claim', `The guide says .empty-state p is 12px, but the CSS says ${emptyRule ? `${emptyRule[1]}px` : 'nothing'}; update section 14.4 item 10, the interaction skill and the instruction file`);
  const ui = files.find(file => file.endsWith(`${sep}ui.tsx`));
  if (ui) {
    const uiText = read(ui);
    const tabBar = uiText.match(/export function TabBar[\s\S]*?(?=\nexport |$)/)?.[0] ?? '';
    const tabClaim = /공용 `TabBar`는[^\n]*?`panelId`를 받아 탭에 `aria-controls`를 달고/.test(guideText);
    if (!tabClaim) add('error', guidePath, 'repo-claim', 'The guide no longer states whether TabBar sets aria-controls; section 14.4 and the interaction skill rely on it');
    else if (!/aria-controls/.test(tabBar) || !/panelId/.test(tabBar)) add('error', guidePath, 'repo-claim', 'The guide says TabBar takes panelId and sets aria-controls, but ui.tsx no longer does; update section 14.4 and the interaction skill');
    const zoneClaim = /`formatDate`·`DateValue`는 브라우저의 현지 시각을 시간대 표시 없이/.test(guideText);
    if (!zoneClaim) add('error', guidePath, 'repo-claim', 'The guide no longer states whether DateValue shows a time zone; section 14.4 and the interaction skill rely on it');
    else if (/timeZoneName/.test(uiText)) add('error', guidePath, 'repo-claim', 'The guide says DateValue shows no time zone, but ui.tsx sets timeZoneName; update section 14.4 and the interaction skill');
  }
  const instruction = existsSync(instructionPath) ? read(instructionPath) : '';
  if (menu && /RequestActionMenu\.tsx/.test(instruction) && !/:not\(:disabled\)/.test(read(menu))) add('error', instructionPath, 'repo-claim', 'The instruction file lists RequestActionMenu.tsx as skipping disabled items, but the code no longer does; update it');
}

// Generic guards. Literal-phrase FACTS only protect sentences somebody listed, so these cover whole classes of edits: every number in
// the prose, every file name and npm script the documents cite, every H.n and A.n pointer, the facts about the code that the guide
// states with a count, and the limits the validator enforces against the sentences that quote them. None of them can tell a right
// statement from a wrong one; they make an unreviewed change visible.
function docFiles() {
  const found = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.md')) found.push(path); } };
  if (existsSync(skillsDir)) walk(skillsDir);
  for (const path of [instructionPath, guidePath, historyPath]) if (existsSync(path)) found.push(path);
  return found.map(path => relative(root, path).split(sep).join('/')).sort();
}

// Ledger v2: two snapshots per file, both kept per line and in order, so a swap inside a sentence changes the snapshot (a per-file
// multiset of numbers could not see one):
//  - numbers: every number, id, pointer, citation key, rule id and count word of a line;
//  - markers: the words that carry polarity, bounds, order and strength ("않는다", "never", "이상", "next", "[연구]") and every code span.
// A line enters the ledger as a 6-hex digest of its ordered tokens. Changing any of them fails until --update-ledger lists the lines
// and records a reason. Section pointers, ids (C05, G5, H.3) and URLs are not numbers here.
const ledgerPath = join(skillsDir, 'ui-guideline-maintenance', 'scripts', 'numbers-ledger.json');
const KO_COUNT = { 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12, 열세: 13, 열네: 14, 열다섯: 15, 둘: 2, 셋: 3, 넷: 4, 첫: 1 };
const EN_COUNT = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const KO_UNITS = '(?:가지|개|단계|번|곳|줄|명|건|배|회|종|색|층|쪽|관문)';
const KO_COUNT_WITH_UNIT = new RegExp(`(열다섯|열네|열세|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두) ?${KO_UNITS}`, 'g');
// Pointers and ids ("§5.4", "section 8", "G5", "C05", "H.3", "2.5.8") are kept apart from numbers.
const ID_PATTERN = /§\s?\d+(?:\.\d+)*|\b[Ss]ections? \d+(?:\.\d+)*|\b(?:[CGSRD]\d{1,2}|HAX\d+|DUP\d+|P[0-3])\b|\bH\.\d\b|\bA\.\d\b|\b\d+\.\d+\.\d+\b/g;
const NUMBER_PATTERN = /\d{4}-\d{2}-\d{2}|(?<![\w.])\d+(?:[.,]\d+)*(?:[~–-]\d+(?:[.,]\d+)*)?(?:\s?(?:ms|px|rem|em|pt)\b|\s?s\b|%|:1\b)?/g;
const MARKER_PATTERNS = [
  /않|말고|말라|금지|없|아니|못한|못하|불가/g,
  /반드시|필수|허용|권고|권장|요구|제외|예외|대신/g,
  /이상|이하|미만|초과|최대|최소|이내/g,
  /먼저|나중|이전|다음|처음|마지막|시작|끝|첫|앞쪽|뒤쪽|위쪽|아래쪽|왼쪽|오른쪽/g,
  /항상|절대|때만|에만|뿐|모두|전부|하나도/g,
  /켜(?:고|지|진|서|는)|끄(?:고|지|는)|끌 수/g,
  /\[(?:표준|규제|연구|관행|동향|사례|설계 선택)[^\]\n]*\]/g,
  /"예"|"아니오"/g,
  /\b(?:never|not|no|nor|without|cannot|can't|don't|doesn't|isn't|must|should|may|only|always|unless|except|instead|neither|none)\b/gi,
  /\b(?:at most|at least|more than|fewer than|less than|up to|or more|or fewer)\b/gi,
  /\b(?:before|after|first|last|next|previous|left|right|above|below|start|end|top|bottom|forward|backward)\b/gi,
  /\b(?:allow(?:s|ed)?|forbid(?:s|den)?|require(?:s|d)?|optional|enable(?:d|s)?|disable(?:d|s)?|hide|hidden|show(?:s|n)?|keeps?|remove(?:s|d)?|lighter|darker|larger|smaller|earlier|later|default)\b/gi,
  /\b(?:yes|true|false)\b/gi,
  /`[^`\n]+`/g,
];
const blank = (chars, index, length) => { for (let k = index; k < index + length; k++) chars[k] = ' '; };
function lineNumbers(line) {
  const chars = line.replace(/https?:\/\/\S+/g, match => ' '.repeat(match.length)).split('');
  const prose = chars.join('');
  const found = [];
  for (const match of prose.matchAll(ID_PATTERN)) { found.push([match.index, `@${match[0].replace(/\s+/g, '').replace(/^[Ss]ections?/, '§')}`]); blank(chars, match.index, match[0].length); }
  // A citation key is counted per use, so swapping one key for another changes two signatures. So is a rule id in a code span.
  for (const match of prose.matchAll(/\]\[([a-z][a-z0-9-]*)\]/g)) found.push([match.index, `$${match[1]}`]);
  for (const match of prose.matchAll(/`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/g)) found.push([match.index, `%${match[1]}`]);
  const rest = chars.join('');
  for (const match of rest.matchAll(NUMBER_PATTERN)) found.push([match.index, match[0].replace(/\s+/g, '')]);
  for (const match of rest.matchAll(KO_COUNT_WITH_UNIT)) { found.push([match.index, `#${KO_COUNT[match[1]]}`]); blank(chars, match.index, match[0].length); }
  // Count words with no unit after them: "세 경로", "둘 이상", "넷은", "셋째", "첫째".
  const bare = chars.join('');
  for (const match of bare.matchAll(/(?<![가-힣])(다섯|여섯|일곱|여덟|아홉|열한|열두|열세|열네|열다섯|네|세|두) (?=[가-힣])/g)) found.push([match.index, `#${KO_COUNT[match[1]]}`]);
  for (const match of bare.matchAll(/(?<![가-힣])(둘|셋|넷)(?=째|[ .,;:)·]|$|[이은는을를의에로와과만도])/gm)) found.push([match.index, `#${KO_COUNT[match[1]]}`]);
  for (const match of bare.matchAll(/(?<![가-힣])(첫)째/g)) found.push([match.index, `#${KO_COUNT[match[1]]}`]);
  for (const match of rest.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi)) found.push([match.index, `#${EN_COUNT[match[1].toLowerCase()]}`]);
  return found.sort((a, b) => a[0] - b[0]).map(item => item[1]);
}
function lineMarkers(line) {
  const found = [];
  for (const pattern of MARKER_PATTERNS) for (const match of line.matchAll(pattern)) found.push([match.index, match[0].toLowerCase()]);
  return found.sort((a, b) => a[0] - b[0]).map(item => item[1]);
}
// Logs that only grow (trial records, routing results, the round log) hold history, not rules, so wording is not tracked there.
const MARKER_EXEMPT = /(?:^frontend\/DESIGN_GUIDELINES_HISTORY\.md$|ui-guideline-maintenance\/references\/(?:trial-(?:log|judgements|s4|s5|requests)|trigger-(?:results|queries|queries-heldout))\.md$)/;
const markerScope = file => !MARKER_EXEMPT.test(file);
const lineDigest = tokens => createHash('sha1').update(tokens.join('\u0001')).digest('hex').slice(0, 6);
function fileSignatures(file, text) {
  const numbers = [], markers = [];
  text.split('\n').forEach((line, index) => {
    if (/^\[[^\]\n]+\]:\s+\S+\s*$/.test(line)) return;
    const counted = lineNumbers(line);
    if (counted.length) numbers.push({ sig: lineDigest(counted), line: index + 1, text: line });
    if (markerScope(file)) { const marked = lineMarkers(line); if (marked.length) markers.push({ sig: lineDigest(marked), line: index + 1, text: line }); }
  });
  return { numbers, markers };
}
// Longest common subsequence of the saved digests and the current lines: what is left over is what changed.
function changedLines(saved, current) {
  const n = saved.length, m = current.length;
  if (n === m && saved.every((sig, i) => sig === current[i].sig)) return { added: [], removed: 0 };
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = saved[i] === current[j].sig ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const matched = new Set();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (saved[i] === current[j].sig) { matched.add(j); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return { added: current.filter((_, index) => !matched.has(index)), removed: n - matched.size };
}
// The routing text of a Skill is its description. A change cannot be validated offline, so it has to be re-stamped.
function descriptionDigests() {
  const out = {};
  if (!existsSync(skillsDir)) return out;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const match = read(file).split('\n---')[0].match(/^description:\s*(.+)$/m);
    if (match) out[entry.name] = createHash('sha1').update(match[1].trim()).digest('hex').slice(0, 12);
  }
  return out;
}
const BULK_LINES = 60;
function checkNumbersLedger() {
  const files = docFiles();
  const current = Object.fromEntries(files.map(file => [file, fileSignatures(file, read(join(root, file)))]));
  const digests = descriptionDigests();
  const saved = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null;
  const upgraded = !!saved && saved.version !== 2;
  const descriptionChanges = Object.keys({ ...saved?._descriptions, ...digests }).filter(name => saved?._descriptions?.[name] !== digests[name]);
  const changes = [];
  for (const file of files) {
    const hadNumbers = !upgraded && saved?.numbers?.[file];
    const hadMarkers = !upgraded && saved?.markers?.[file];
    const numbers = hadNumbers ? changedLines(saved.numbers[file], current[file].numbers) : { added: current[file].numbers, removed: 0, isNew: true };
    const markers = !markerScope(file) ? { added: [], removed: 0 } : hadMarkers ? changedLines(saved.markers[file], current[file].markers) : { added: current[file].markers, removed: 0, isNew: true };
    if (numbers.added.length || numbers.removed || markers.added.length || markers.removed) changes.push({ file, numbers, markers });
  }
  const gone = saved && !upgraded ? Object.keys(saved.numbers ?? {}).filter(file => !files.includes(file)) : [];
  const show = (entries, limit) => entries.slice(0, limit).map(entry => `L${entry.line}: ${entry.text.trim().slice(0, 90)}`);
  const changedOf = change => new Map([...change.numbers.added, ...change.markers.added].map(entry => [entry.line, entry]));
  if (values['update-ledger']) {
    const touched = changes.reduce((sum, change) => sum + new Set([...change.numbers.added, ...change.markers.added].map(entry => entry.line)).size + change.numbers.removed + change.markers.removed, 0);
    for (const name of descriptionChanges) console.log(`description changed: ${name}`);
    for (const change of changes) {
      console.log(`ledger changed: ${change.file}: numbers +${change.numbers.added.length}/-${change.numbers.removed}, wording +${change.markers.added.length}/-${change.markers.removed}`);
      for (const line of show([...changedOf(change).values()].sort((a, b) => a.line - b.line), 25)) console.log(`    ${line}`);
    }
    for (const file of gone) console.log(`ledger drops: ${file}`);
    const reason = (values.reason ?? '').trim();
    const total = touched + descriptionChanges.length + gone.length;
    const bulk = !upgraded && total > BULK_LINES;
    if (total && reason.length < 12) { add('error', ledgerPath, 'ledger', `${total} ledger entries would change (listed above). Read them, then repeat with --reason "<why these changes are intended>" (12 characters or more); the reason is kept in the ledger`); return; }
    if (bulk && (!values['allow-bulk'] || reason.length < 40)) { add('error', ledgerPath, 'ledger', `${total} entries would change at once (more than ${BULK_LINES}): a bulk stamp hides what was read. Stamp in smaller steps, or repeat with --allow-bulk and a --reason of 40 characters or more that names the sections you read`); return; }
    const reasons = [...(saved?._reasons ?? [])];
    if (total) reasons.push({ date: new Date().toISOString().slice(0, 10), entries: total, reason });
    const rows = (kind, list) => list.map(file => `    ${JSON.stringify(file)}: ${JSON.stringify(current[file][kind].map(entry => entry.sig))}`).join(',\n');
    writeFileSync(ledgerPath, `{\n  "version": 2,\n  "numbers": {\n${rows('numbers', files)}\n  },\n  "markers": {\n${rows('markers', files.filter(markerScope))}\n  },\n  "_descriptions": ${JSON.stringify(digests)},\n  "_reasons": ${JSON.stringify(reasons.slice(-12))}\n}\n`);
    if (upgraded) console.log('ledger format upgraded to version 2');
    return;
  }
  if (!saved) { add('warn', ledgerPath, 'ledger', 'No ledger; review the documents, then run --update-ledger --reason "<why>"'); return; }
  if (upgraded) { add('error', ledgerPath, 'ledger', 'The ledger has an old format (version 1); review the documents, then run --update-ledger --reason "<why>"'); return; }
  for (const change of changes) {
    const parts = [];
    if (change.numbers.isNew || change.markers.isNew) parts.push('the file is not in the ledger');
    else {
      if (change.numbers.added.length || change.numbers.removed) parts.push(`numbers, ids, pointers or citation keys changed on ${change.numbers.added.length} line(s) (${change.numbers.removed} removed)`);
      if (change.markers.added.length || change.markers.removed) parts.push(`words that carry meaning (negation, bounds, order, strength, evidence label, code span) changed on ${change.markers.added.length} line(s) (${change.markers.removed} removed)`);
    }
    const sample = show([...changedOf(change).values()].sort((a, b) => a.line - b.line), 3);
    add('error', join(root, change.file), 'ledger', `${parts.join('; ')}${sample.length ? `: ${sample.join(' | ')}` : ''}. If intended, read the lines, then run --update-ledger --reason "<why>"`);
  }
  for (const file of gone) add('error', ledgerPath, 'ledger', `The ledger lists ${file}, which is gone or out of scope`);
  for (const name of descriptionChanges) add('error', join(skillsDir, name, 'SKILL.md'), 'ledger', `The description of ${name} changed (or the Skill is new or gone). Routing cannot be checked offline: rerun the queries in references/trigger-queries.md, record the result in references/trigger-results.md, then run --update-ledger --reason "<why>"`);
}

// Names that documents may cite although no file of that name exists (outputs a tool writes, placeholders).
const NAME_ALLOW = new Set([]);
// A component or function named in a code span must exist in the product code. ErrorBoundary is the guide's claim that there is none
// (checkRepoFacts re-searches for it).
const PRODUCT_CODE = /^(?:frontend\/(?:src|e2e|scripts)|backend\/src)\/.+\.(?:tsx?|css|py|mjs)$/;
const IDENTIFIER_ALLOW = new Set(['ErrorBoundary']);
// Options of tools this repository only calls (Playwright, npm), which no script of ours defines.
const EXTERNAL_FLAGS = new Set(['--workers', '--prefix', '--help']);
const RULE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

// Every `--option` a script or a stylesheet of this repository defines or mentions.
function definedFlags() {
  const known = new Set(EXTERNAL_FLAGS);
  const visit = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') visit(path); continue; }
      if (!/\.(mjs|ps1|css)$/.test(entry.name) || (dir.includes(`${sep}skills${sep}`) && !dir.endsWith(`${sep}scripts`))) continue;
      const text = read(path);
      for (const match of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*[a-z0-9])/g)) known.add(match[1]);
      for (const match of text.matchAll(/['"]?([a-z][a-z-]*)['"]?\s*:\s*\{\s*type:\s*'(?:string|boolean)'/g)) known.add(`--${match[1]}`);
    }
  };
  visit(join(root, 'frontend', 'scripts'));
  visit(join(root, 'frontend', 'src'));
  visit(skillsDir);
  return known;
}

// Rule ids the inventory tool can print; a document that backticks an id must use one of them, and the guide must list every one.
function inventoryRules() {
  const file = join(skillsDir, 'ui-element-audit', 'scripts', 'element-inventory.mjs');
  if (!existsSync(file)) return null;
  const source = read(file);
  const ids = new Set([...source.matchAll(/'([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)'/g)].map(match => match[1]));
  for (const id of [...ids]) if ([...ids].some(other => other !== id && other.startsWith(`${id}-`))) ids.delete(id);
  const severity = new Map([...source.matchAll(/\bflag\((?:[A-Za-z_.]+|null),\s*'([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)',\s*'(info|warn|error)'/g)].map(match => [match[1], match[2]]));
  return { ids, severity, prefixes: new Set([...ids].map(id => id.split('-')[0])) };
}

function checkNamedFiles(files) {
  const names = new Set();
  const skip = new Set(['node_modules', '.git', '.venv', 'dist', 'test-results', 'artifacts', '__pycache__', '.pytest_cache', '.data', '.playwright-mcp', '.azure', 'playwright-report', 'coverage']);
  const sources = [];
  const productSources = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(join(dir, entry.name)); continue; }
      names.add(entry.name);
      const path = join(dir, entry.name);
      if (/\.(?:mjs|js|ts|tsx|py|css|ya?ml|ps1)$/.test(entry.name) && !/mutants|ledger/.test(entry.name) && !dir.includes(`${sep}ui-guideline-maintenance${sep}scripts`) && statSync(path).size < 300000) sources.push(read(path));
      if (PRODUCT_CODE.test(relative(root, path).split(sep).join('/')) && statSync(path).size < 300000) productSources.push(read(path));
    }
  };
  walk(root);
  const sourceText = sources.join('\n');
  const productText = productSources.join('\n');
  const known = new Map();
  const inProduct = name => { if (!known.has(name)) known.set(name, new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(productText)); return known.get(name); };
  const stems = new Set([...names].map(name => name.replace(/\.[^.]+$/, '')));
  const scripts = new Set();
  for (const pkg of ['package.json', 'frontend/package.json']) {
    const path = join(root, pkg);
    if (!existsSync(path)) continue;
    try { for (const name of Object.keys(JSON.parse(readFileSync(path, 'utf8')).scripts ?? {})) scripts.add(name); } catch { /* an unreadable package.json is not this check's finding */ }
  }
  const flags = definedFlags();
  const rules = inventoryRules();
  for (const file of files) {
    const text = read(join(root, file));
    const where = index => lineOf(text, index);
    for (const match of text.matchAll(/`([\w./-]+\.(?:md|mjs|cjs|js|json|tsx?|css|html?|ps1|ya?ml|py|txt))`/g)) {
      const base = match[1].split('/').pop();
      if (!names.has(base) && !NAME_ALLOW.has(base)) add('error', join(root, file), 'filename', `\`${match[1]}\` is not a file in the repository`, where(match.index));
    }
    if (scripts.size) for (const match of text.matchAll(/npm(?:\.cmd)? run ([\w:-]+)/g)) if (!scripts.has(match[1])) add('error', join(root, file), 'command', `npm script "${match[1]}" is not in package.json`, where(match.index));
    // A code span such as `design:review` that shares its prefix with real scripts must be one of them.
    const prefixes = new Set([...scripts].filter(name => name.includes(':')).map(name => name.split(':')[0]));
    for (const match of text.matchAll(/`([a-z][\w-]*:[\w-]+)`/g)) if (prefixes.has(match[1].split(':')[0]) && !scripts.has(match[1])) add('error', join(root, file), 'command', `\`${match[1]}\` looks like an npm script but is not in package.json`, where(match.index));
    for (const span of text.matchAll(/`([^`\n]+)`/g)) {
      const inner = span[1];
      if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(inner) && !IDENTIFIER_ALLOW.has(inner) && !inProduct(inner)) add('error', join(root, file), 'identifier', `\`${inner}\` is not a name in the product code (frontend/src, frontend/e2e, frontend/scripts, backend/src); fix the name, or add it to IDENTIFIER_ALLOW if it is an external or deliberately absent name`, where(span.index));
      for (const flag of inner.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*[a-z0-9])/g)) {
        if (/^--space-\d+$/.test(flag[1])) continue;
        if (!flags.has(flag[1]) && ![...flags].some(known => known.startsWith(`${flag[1]}-`))) add('error', join(root, file), 'flag', `\`${flag[1]}\` is not an option of any script or stylesheet in the repository`, where(span.index));
      }
      // A path or file inside a longer command, such as `node .github/skills/.../element-inventory.mjs --url x`.
      if (/\s/.test(inner)) {
        for (const token of inner.split(/[\s,()=]+/)) {
          const cleaned = token.replace(/^["'`]+|["'`.,;:]+$/g, '').replace(/^\.\//, '');
          if (/^[\w./-]*\/[\w./-]+\.(?:md|mjs|cjs|js|json|tsx?|css|html?|ps1|ya?ml|py|txt)$/.test(cleaned) && !names.has(cleaned.split('/').pop())) add('error', join(root, file), 'filename', `\`${cleaned}\` is not a file in the repository`, where(span.index));
          if (/^(?:frontend|\.github|backend|infra)\/[\w./-]+\.[\w]+$/.test(cleaned) && !existsSync(join(root, cleaned))) add('error', join(root, file), 'path', `Referenced repo path does not exist: ${cleaned}`, where(span.index));
        }
      }
      // An environment variable named in a document must appear in the code or the configuration.
      for (const env of inner.matchAll(/(?<![\w.-])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w-])/g)) {
        if (!stems.has(env[1]) && !sourceText.includes(env[1])) add('error', join(root, file), 'env', `\`${env[1]}\` appears in no script, source or configuration file`, where(span.index));
      }
      if (rules && RULE_ID.test(inner) && rules.prefixes.has(inner.split('-')[0]) && !rules.ids.has(inner)) add('error', join(root, file), 'rule-id', `\`${inner}\` is not a rule id of element-inventory.mjs`, where(span.index));
    }
    for (const match of text.matchAll(/`((?:frontend|backend|infra)\/node_modules)`/g)) if (!existsSync(join(root, match[1].split('/')[0], 'package.json'))) add('error', join(root, file), 'path', `${match[1]} cannot hold packages: ${match[1].split('/')[0]}/package.json does not exist`, where(match.index));
    if (rules) for (const match of text.matchAll(/`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`\((정보|오류|경고)\)/g)) {
      const expected = { 정보: 'info', 오류: 'error', 경고: 'warn' }[match[2]];
      if (rules.severity.has(match[1]) && rules.severity.get(match[1]) !== expected) add('error', join(root, file), 'rule-id', `${match[1]} is printed as ${rules.severity.get(match[1])}, the document says ${match[2]}`, where(match.index));
    }
  }
  if (rules && existsSync(guidePath)) {
    const guideText = read(guidePath);
    for (const id of rules.ids) if (!guideText.includes(`\`${id}\``)) add('error', guidePath, 'rule-id', `The inventory tool prints ${id}; the guide's indicator table (section 8.8) does not list it`);
  }
}

// "이력 H.3" and "부록 A.1" are pointers like "§5.4"; they must land on a heading.
function checkRefPointers(files) {
  const history = existsSync(historyPath) ? read(historyPath) : '';
  const guideText = existsSync(guidePath) ? read(guidePath) : '';
  const parts = new Set([...history.matchAll(/^## H\.(\d+) /gm)].map(match => match[1]));
  const appendix = new Set([...guideText.matchAll(/^### A\.(\d+) /gm)].map(match => match[1]));
  for (const file of files) {
    const text = read(join(root, file));
    for (const match of text.matchAll(/(?<![\w.])H\.(\d+)(?!\d)/g)) if (!parts.has(match[1])) add('error', join(root, file), 'xref', `Reference H.${match[1]} does not match a heading of the history file`, lineOf(text, match.index));
    for (const match of text.matchAll(/(?<![\w.])A\.(\d+)(?!\d)/g)) if (!appendix.has(match[1])) add('error', join(root, file), 'xref', `Reference A.${match[1]} does not match a heading of the guide's appendix`, lineOf(text, match.index));
  }
}

// Facts about the code that the guide states with a count or a value, re-measured against the tree.
function checkRepoFacts() {
  const src = join(root, 'frontend', 'src');
  if (!existsSync(src) || !existsSync(guidePath)) return;
  const css = readdirSync(src).filter(name => name.endsWith('.css')).map(name => read(join(src, name))).join('\n');
  const guideText = read(guidePath);
  const instruction = existsSync(instructionPath) ? read(instructionPath) : '';
  const bad = (file, message) => add('error', file, 'repo-fact', message);
  const media = width => (css.match(new RegExp(`\\((?:max|min)-width:\\s*${width}px\\)`, 'g')) ?? []).length;
  const breakpoints = guideText.match(/(\d+)px\((\d+)곳\)과 (\d+)px\((\d+)곳\)이다/);
  if (!breakpoints) bad(guidePath, 'The guide no longer states how many media queries use each breakpoint (section 9.3)');
  else for (const [width, count] of [[breakpoints[1], breakpoints[2]], [breakpoints[3], breakpoints[4]]]) if (media(width) !== Number(count)) bad(guidePath, `The guide says ${width}px is used in ${count} media queries; the CSS has ${media(width)}`);
  const spaces = new Map([...css.matchAll(/--space-(\d+):\s*(\d+)px/g)].map(match => [match[1], match[2]]));
  const scale = guideText.match(/`--space-(\d+)`\((\d+)px\)~`--space-(\d+)`\((\d+)px\)/);
  if (!scale) bad(guidePath, 'The guide no longer states the --space scale (section 14.3)');
  else if (spaces.get(scale[1]) !== scale[2] || spaces.get(scale[3]) !== scale[4]) bad(guidePath, `The guide says --space-${scale[1]} is ${scale[2]}px and --space-${scale[3]} is ${scale[4]}px; the CSS has ${spaces.get(scale[1])}px and ${spaces.get(scale[3])}px`);
  const absent = guideText.match(/`--space-(\d+)`·`--space-(\d+)`은 없다/);
  if (absent && [absent[1], absent[2]].some(n => spaces.has(n))) bad(guidePath, `The guide says --space-${absent[1]} and --space-${absent[2]} do not exist; the CSS defines one of them`);
  const radius = guideText.match(/`--radius`\((\d+)px\)/);
  const radiusCss = css.match(/--radius:\s*(\d+)px/);
  if (radius && radiusCss && radius[1] !== radiusCss[1]) bad(guidePath, `The guide says --radius is ${radius[1]}px; the CSS has ${radiusCss[1]}px`);
  const font = guideText.match(/`--font-ui`는 `([^`]+)`다/);
  const fontCss = css.match(/--font-ui:\s*([^;}]+)/);
  if (font && fontCss && font[1].replace(/\s+/g, '') !== fontCss[1].replace(/\s+/g, '')) bad(guidePath, `The font stack in the guide differs from --font-ui in the CSS (${fontCss[1].trim()})`);
  const declarations = (css.match(/(?:^|[;{}\s])(?:padding|margin|gap)(?:-[a-z]+)*:[^;}]*\d+px/g) ?? []).length;
  // The heading scale in section 4.2 is the smallest and largest px font-size the CSS gives to an h2 or h3 selector.
  const headingRange = tag => {
    const sizes = [];
    let nonPx = 0;
    const pattern = new RegExp(`(^|[\\s>+~])${tag}(?![\\w-])(\\[[^\\]]*\\]|:[\\w-]+(\\([^)]*\\))?|\\.[\\w-]+)*$`);
    const walk = text => {
      let at = 0;
      while (at < text.length) {
        const open = text.indexOf('{', at);
        if (open < 0) break;
        const prelude = text.slice(at, open).trim();
        let depth = 1, end = open + 1;
        while (end < text.length && depth) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; }
        const body = text.slice(open + 1, end - 1);
        if (/^@(?:media|supports)/.test(prelude)) walk(body);
        else if (!prelude.startsWith('@') && prelude.split(',').some(selector => pattern.test(selector.trim()))) {
          const size = body.match(/(?:^|;)\s*font-size\s*:\s*([^;}]+)/);
          if (size) { const px = size[1].trim().match(/^(\d+(?:\.\d+)?)px$/); if (px) sizes.push(Number(px[1])); else nonPx++; }
        }
        at = end;
      }
    };
    walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    return { min: Math.min(...sizes), max: Math.max(...sizes), nonPx, count: sizes.length };
  };
  const headingClaim = guideText.match(/h2 (\d+)~(\d+)px, h3 (\d+)~(\d+)px/);
  if (!headingClaim) bad(guidePath, 'The guide no longer states the heading scale of the CSS as "h2 a~bpx, h3 c~dpx" (section 4.2)');
  else for (const [tag, low, high] of [['h2', headingClaim[1], headingClaim[2]], ['h3', headingClaim[3], headingClaim[4]]]) {
    const measured = headingRange(tag);
    if (!measured.count || measured.nonPx || measured.min !== Number(low) || measured.max !== Number(high)) bad(guidePath, `The guide says ${tag} is ${low}~${high}px in the CSS; the CSS has ${measured.count ? `${measured.min}~${measured.max}px` : 'no px size'}${measured.nonPx ? ` and ${measured.nonPx} size(s) that are not in px` : ''}`);
  }
  for (const [file, text, pattern] of [[guidePath, guideText, /\(([\d,]+)여 건/], [instructionPath, instruction, /about ([\d,]+) px spacing declarations/]]) {
    const stated = text.match(pattern);
    if (!stated) continue;
    const low = Number(stated[1].replace(/,/g, ''));
    if (declarations < low || declarations >= low + 100) bad(file, `States about ${stated[1]} px spacing declarations; the CSS has ${declarations}`);
  }
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (/\.tsx?$/.test(entry.name)) files.push(path); } };
  walk(src);
  const users = files.filter(file => !file.endsWith(`${sep}ui.tsx`) && /\bTabBar\b/.test(read(file))).map(file => file.split(sep).pop());
  const tabClaim = guideText.match(/`TabBar`를 쓰는 곳은 `([^`]+)` 하나/);
  if (tabClaim && (users.length !== 1 || users[0] !== tabClaim[1])) bad(guidePath, `The guide says only ${tabClaim[1]} uses TabBar; the code has ${users.join(', ') || 'no user'}`);
  if (!tabClaim && /`TabBar`를 쓰는 곳은/.test(guideText)) bad(guidePath, 'The sentence naming the one file that uses TabBar changed shape; restore it or update checkRepoFacts');
  // Claims that something is absent are re-searched in the tree.
  const boundaryTerms = files.reduce((sum, file) => sum + (read(file).match(/ErrorBoundary|componentDidCatch|getDerivedStateFromError/g) ?? []).length, 0);
  const boundaryAbsent = /`ErrorBoundary`·`componentDidCatch`·`getDerivedStateFromError`가 없다/.test(guideText);
  if (boundaryAbsent !== (boundaryTerms === 0)) bad(guidePath, `The guide ${boundaryAbsent ? 'says' : 'no longer says'} that frontend/src has no error boundary; the code mentions one ${boundaryTerms} times`);
  const fontStack = css.match(/--font-ui:\s*([^;}]+)/);
  if (fontStack && /Ariel/.test(fontStack[1]) !== /`Ariel`을 `Arial`로 고치지 않는다/.test(guideText)) bad(guidePath, `The font stack ${/Ariel/.test(fontStack[1]) ? 'contains' : 'no longer contains'} "Ariel"; the guide's sentence about leaving it alone does not match`);
  const findInRepo = name => {
    const hits = [];
    const visit = dir => { for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) { const path = join(dir, entry.name); if (entry.isDirectory()) { if (!['node_modules', '__pycache__', '.venv'].includes(entry.name)) visit(path); } else if (entry.name === name) hits.push(path); } };
    visit(src); visit(join(root, 'backend', 'src'));
    return hits[0];
  };
  const statesDoc = join(skillsDir, 'ui-interaction-design', 'references', 'states-and-feedback.md');
  if (existsSync(statesDoc)) {
    const doc = read(statesDoc);
    const none = doc.match(/`frontend\/src` has (none|one)/);
    if (!none || (none[1] === 'none') !== (boundaryTerms === 0)) bad(statesDoc, `The reference says frontend/src has ${none?.[1] ?? 'an unstated number of'} error boundaries; the code mentions one ${boundaryTerms} times`);
    const treeGrid = files.find(file => file.endsWith(`${sep}TreeGrid.tsx`));
    if (/The repo's `TreeGrid` is a `table`/.test(doc) && treeGrid && (!/<table/.test(read(treeGrid)) || /role=["']treegrid["']/.test(read(treeGrid)))) bad(statesDoc, 'The reference says TreeGrid is a table, not role=treegrid; TreeGrid.tsx differs');
    const operations = files.find(file => file.endsWith(`${sep}ChangeOperationsPage.tsx`));
    if (/passes `panelId` and renders a `tabpanel`/.test(doc) && operations && (!/tabpanel/.test(read(operations)) || !/panelId/.test(read(operations)) || !files.some(file => file !== operations && /tabpanel/.test(read(file))))) bad(statesDoc, 'The reference says ChangeOperationsPage passes panelId and renders a tabpanel like the other screens; the code differs');
  }
  const aiDoc = join(skillsDir, 'ui-interaction-design', 'references', 'ai-features.md');
  if (existsSync(aiDoc)) {
    const claim = read(aiDoc).match(/`ai_review` \(`([\w.]+)`, `([\w.]+)`\)/);
    if (!claim) bad(aiDoc, 'The reference no longer names the two files that define ai_review');
    else for (const name of [claim[1], claim[2]]) { const located = findInRepo(name); if (!located || !read(located).includes('ai_review')) bad(aiDoc, `The reference says ${name} defines ai_review; it does not`); }
  }
  const themeDoc = join(skillsDir, 'ui-design-workflow', 'references', 'verify-rendered.md');
  const themeFile = files.find(file => file.endsWith(`${sep}ThemeControl.tsx`));
  if (existsSync(themeDoc) && themeFile) {
    const stored = read(themeDoc).match(/`localStorage\['azfw-theme'\]` holds `(\w+)` or `(\w+)`/);
    const code = read(themeFile);
    if (!stored) bad(themeDoc, 'verify-rendered.md no longer states which values the theme storage key takes');
    else if (![stored[1], stored[2]].every(value => new RegExp(`value === '${value}'`).test(code)) || /localStorage[\s\S]{0,40}value === 'system'/.test(code)) bad(themeDoc, `verify-rendered.md says the theme key holds ${stored[1]} or ${stored[2]}; ThemeControl.tsx accepts something else`);
  }
  if (/`api\.updateOperations`는 `frontend\/src`에서 정의 한 곳뿐이고 호출하는 곳이 없다/.test(guideText)) {
    const mentions = files.reduce((sum, file) => sum + (read(file).match(/\bupdateOperations\b/g) ?? []).length, 0);
    if (mentions !== 1) bad(guidePath, `The guide says api.updateOperations has one definition and no caller; frontend/src mentions it ${mentions} times`);
  }
  const cell = css.match(/\[data-label\]\s+\.small-text\s*\{[^}]*?font-size:\s*(\d+)px/);
  if (/`forced-colors`·`prefers-contrast`·`forced-color-adjust` 규칙이 한 건도 없고/.test(guideText)) {
    const mentions = (css.match(/forced-colors|prefers-contrast|forced-color-adjust/g) ?? []).length;
    if (mentions) bad(guidePath, `The guide says the CSS has no forced-colors, prefers-contrast or forced-color-adjust rule; the CSS mentions them ${mentions} times`);
  }
  const shadowOnlyFocus = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)].filter(match => /box-shadow/.test(match[2]) && !/outline/.test(match[2])).length;
  if (/`:focus-visible` 규칙 가운데 `box-shadow`만 쓰는 것도 없다/.test(guideText) && shadowOnlyFocus) bad(guidePath, `The guide says no :focus-visible rule relies on box-shadow alone; the CSS has ${shadowOnlyFocus}`);
  const apiTs = existsSync(join(src, 'api.ts')) ? read(join(src, 'api.ts')) : '';
  // API routes the interaction skill quotes in code spans must exist in the client.
  const interactionDir = join(skillsDir, 'ui-interaction-design');
  if (apiTs && existsSync(interactionDir)) {
    const docs = [join(interactionDir, 'SKILL.md'), ...(existsSync(join(interactionDir, 'references')) ? readdirSync(join(interactionDir, 'references')).filter(name => name.endsWith('.md')).map(name => join(interactionDir, 'references', name)) : [])];
    for (const doc of docs.filter(existsSync)) {
      const text = read(doc);
      for (const match of text.matchAll(/`(\/[a-z][a-z-]*)`/g)) if (!apiTs.includes(`'${match[1]}'`) && !apiTs.includes(`'${match[1]}/`) && !apiTs.includes(`\`${match[1]}/`)) add('error', doc, 'repo-fact', `Route ${match[1]} is not in frontend/src/api.ts`, lineOf(text, match.index));
    }
  }
  if (/`\[data-label\] \.small-text`/.test(guideText) && (!cell || cell[1] !== '12')) bad(guidePath, `The guide says .small-text is 12px inside [data-label] cells; the CSS has ${cell ? `${cell[1]}px` : 'no such rule'}`);
  const ui = files.find(file => file.endsWith(`${sep}ui.tsx`));
  const focusClaim = guideText.match(/`ConfirmDialog`는 기본 포커스가 (취소|확인)에 있고/);
  if (ui && focusClaim) {
    const uiText = read(ui);
    const holder = /onClick=\{onCancel\}[^>]*\bautoFocus\b/.test(uiText) ? '취소' : /onClick=\{onConfirm\}[^>]*\bautoFocus\b/.test(uiText) ? '확인' : '';
    if (holder !== focusClaim[1]) bad(guidePath, `The guide says ConfirmDialog focuses ${focusClaim[1]} first; the code gives autoFocus to ${holder || 'neither button'}`);
  }
}

// The limits the validator enforces must read the same in the sentences that quote them.
function checkLimitSentences() {
  const maintenance = join(skillsDir, 'ui-guideline-maintenance', 'SKILL.md');
  if (existsSync(maintenance)) {
    const text = read(maintenance);
    const budget = text.match(/`SKILL\.md` ≤ (\d+) lines; every `SKILL\.md` and reference file ≤ ([\d,]+) bytes[^;]*; instruction file ≤ (\d+) lines/);
    if (!budget) add('error', maintenance, 'limits', 'The size-budget sentence changed shape; restore it or update checkLimitSentences');
    else {
      if (Number(budget[1]) !== LIMITS.skillLinesWarn) add('error', maintenance, 'limits', `Says SKILL.md is capped at ${budget[1]} lines; the validator warns above ${LIMITS.skillLinesWarn}`);
      if (Number(budget[2].replace(/,/g, '')) !== LIMITS.fileBytesError) add('error', maintenance, 'limits', `Says files are capped at ${budget[2]} bytes; the validator fails above ${LIMITS.fileBytesError}`);
      if (Number(budget[3]) !== LIMITS.instructionLines) add('error', maintenance, 'limits', `Says the instruction file is capped at ${budget[3]} lines; the validator fails above ${LIMITS.instructionLines}`);
    }
    const days = text.match(/about (\d+) days out/);
    if (!days || Number(days[1]) !== LIMITS.reviewDays) add('error', maintenance, 'limits', `The review schedule sentence does not say ${LIMITS.reviewDays} days`);
    const stop = text.match(/Rubric mean ≥ ([\d.]+) and no dimension below (\d+)/);
    if (!stop || Number(stop[1]) !== LIMITS.stopMean || Number(stop[2]) !== LIMITS.stopMin) add('error', maintenance, 'limits', `The stop rule does not say a mean of ${LIMITS.stopMean} and no dimension below ${LIMITS.stopMin}, which is what the H.1 verdict check enforces`);
  }
  const header = (existsSync(guidePath) ? read(guidePath) : '').match(/기준일의 (\d+)일 뒤/);
  if (header && Number(header[1]) !== LIMITS.reviewDays) add('error', guidePath, 'limits', `The header says the next review is ${header[1]} days out; the validator allows ${LIMITS.reviewDays}`);
}

// The round log, tool tests and trial results live outside the guide; the guide and the skills cite them as H.1 to H.3.
function validateHistory() {
  if (!existsSync(historyPath)) { add('error', historyPath, 'history', 'History file not found; the guide and the maintenance skill point to it'); return; }
  const text = read(historyPath);
  for (const part of ['H.1', 'H.2', 'H.3']) if (!new RegExp(`^## ${part.replace('.', '\\.')} `, 'm').test(text)) add('error', historyPath, 'history', `Heading ${part} is missing; the guide cites it`);
  // The guide's baseline date must be the date of the last round in the log, so a guide edited after its last logged round says so.
  const baseline = (existsSync(guidePath) ? read(guidePath) : '').match(/기준일 \*\*(\d{4}-\d{2}-\d{2})\*\*/);
  const rounds = [...text.matchAll(/^\| (\d+) [^|]+\| (\d{4}-\d{2}-\d{2}) \|/gm)];
  if (baseline && rounds.length && rounds.at(-1)[2] !== baseline[1]) add('error', historyPath, 'history', `The last round in H.1 (${rounds.at(-1)[1]}) is dated ${rounds.at(-1)[2]}; the guide's baseline date is ${baseline[1]}. Log the round, or fix the header`);
  // A verdict of 중단 (stop) is only allowed when the rubric cell meets the stop rule; every other verdict must be 계속.
  for (const row of text.matchAll(/^\| (\d+) [^\n]*$/gm)) {
    const cells = row[0].split(' | ');
    const verdict = cells.at(-1).replace(/\s*\|\s*$/, '').trim();
    const rubric = cells.at(-2).trim();
    const score = rubric.match(/^(\d(?:\.\d+)?)·(\d(?:\.\d+)?)$/);
    if (!['계속', '중단'].includes(verdict)) add('error', historyPath, 'history', `Round ${row[1]} has the verdict "${verdict}"; use 계속 or 중단`, lineOf(text, row.index));
    else if (verdict === '중단' && !(score && Number(score[1]) >= LIMITS.stopMean && Number(score[2]) >= LIMITS.stopMin)) add('error', historyPath, 'history', `Round ${row[1]} says 중단, but its rubric cell is "${rubric}"; the stop rule needs a mean of ${LIMITS.stopMean} or more and no dimension below ${LIMITS.stopMin}`, lineOf(text, row.index));
  }
  checkLocalLinks(text, historyPath);
  checkSectionRefs(text, historyPath);
  checkConstants(text, historyPath);
  checkTables(text, historyPath);
}

async function probe(urls) {
  const unique = [...new Set(urls)];
  const results = [];
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const url = unique[next++];
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'design-docs-validator/1.0' } });
        results.push({ url, status: response.status });
      } catch (error) { results.push({ url, status: 0, error: String(error.cause?.code ?? error.message) }); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return results;
}

// --index: the sections of the guide with their line ranges and sizes, so a reader whose tool returns only part of a file can
// jump to a section. It is computed on demand, so it cannot go stale.
function printIndex() {
  if (!existsSync(guidePath)) { console.error('Guide not found'); process.exit(2); }
  const raw = readFileSync(guidePath, 'utf8');
  const eol = raw.includes('\r\n') ? 2 : 1;
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const heads = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) { fenced = !fenced; return; }
    const match = !fenced && line.match(/^(#{2,3}) (.+)$/);
    if (match) heads.push({ level: match[1].length, title: match[2], start: i + 1 });
  });
  const bytes = lines.map(line => Buffer.byteLength(line, 'utf8') + eol);
  console.log(`${relative(root, guidePath).split(sep).join('/')}: ${lines.length} lines, ${(bytes.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KB`);
  console.log(' lines          KB  section');
  heads.forEach((head, index) => {
    const next = heads.slice(index + 1).find(other => other.level <= head.level);
    const end = next ? next.start - 1 : lines.length;
    const kb = bytes.slice(head.start - 1, end).reduce((a, b) => a + b, 0) / 1024;
    console.log(`${String(head.start).padStart(5)}-${String(end).padEnd(5)} ${kb.toFixed(1).padStart(6)}  ${'  '.repeat(head.level - 2)}${head.title}`);
  });
}
if (values.index) { printIndex(); process.exit(0); }

const guide = validateGuide();
const skills = validateSkills();
checkRowParity();
checkFacts();
validateInstructions();
validateHistory();
checkRepoClaims();
checkNumbersLedger();
const docs = docFiles();
checkNamedFiles(docs);
checkRefPointers(docs);
checkRepoFacts();
checkLimitSentences();

let linkResults = [];
if (values.links) {
  linkResults = await probe([...(guide?.urls ?? []), ...skills.urls]);
  for (const result of linkResults) {
    if (result.status === 0) add('warn', guidePath, 'url', `Unreachable ${result.url} (${result.error})`);
    else if ([403, 429, 999].includes(result.status)) add('warn', guidePath, 'url', `Blocked (${result.status}) ${result.url}; check manually`);
    else if (result.status >= 500) add('warn', guidePath, 'url', `Server error (${result.status}) ${result.url}; transient, check again later`);
    else if (result.status >= 400) add('error', guidePath, 'url', `HTTP ${result.status} ${result.url}`);
  }
}

const errors = findings.filter(f => f.level === 'error');
const warnings = findings.filter(f => f.level === 'warn');
const summary = { result: errors.length ? 'FAIL' : 'PASS', errors: errors.length, warnings: warnings.length, skills: skills.skills, guideLines: guide?.lines ?? 0, sources: guide?.sources ?? 0, urlsProbed: linkResults.length };
if (values.json) console.log(JSON.stringify({ summary, findings }, null, 2));
else {
  for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(5)} ${f.file}${f.line ? ':' + f.line : ''} [${f.rule}] ${f.message}`);
  console.log(JSON.stringify(summary));
}
process.exit(errors.length ? 1 : 0);
