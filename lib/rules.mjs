// Rule catalog + body filter for dsh-win-env-kit.
//
// The skill ships all nine rules in one SKILL.md (a single source of truth on
// disk). The plugin's `Config` decides which of them the model sees: a
// disabled rule's section is dropped from the body before it is returned, so a
// workspace that, say, never touches binaries can turn rules 3-4 off without
// forking the skill text.
//
// This module is deliberately dependency-free so it can be unit-tested with
// plain node, without the host's schemastery peer dependency.
//
// @module dsh-win-env-kit/rules

/**
 * The nine rules, in document order. `number` is the heading number in
 * SKILL.md (`## <number>. <title>`); `title` must match that heading so the
 * settings UI and the document agree.
 */
export const RULES = [
  { number: 1, title: 'Text is UTF-8 without BOM; set it explicitly' },
  { number: 2, title: 'Line endings follow the file type' },
  { number: 3, title: 'Build output carries no machine identity' },
  { number: 4, title: 'SmartScreen is a reputation problem, not a policy problem' },
  { number: 5, title: 'Transient artefacts live only in `_scratch/`' },
  { number: 6, title: 'Reading an image is an upload; gate it first' },
  { number: 7, title: 'Dev hygiene: log what you start, tear it down, and never loop on "gone"' },
  { number: 8, title: 'Multiple agents editing the same doc: claim a lock first' },
  { number: 9, title: 'A file that starts demanding a security confirmation: local trust marks, not SmartScreen' }
]

/** Every rule number, ascending. */
export const ALL_RULE_NUMBERS = RULES.map((rule) => rule.number)

/**
 * Which rules a config enables.
 *
 * `enabledRules` (a list of numbers) wins when present and non-empty — it is
 * the direct "turn on exactly these" form. Otherwise each rule's own boolean
 * decides, and an absent boolean means enabled, so a config may name only the
 * rules it turns off. Unknown keys are ignored, and a value that is not a
 * recognised "off" token counts as on, which keeps a malformed config from
 * silently muting the skill.
 *
 * @param config - the plugin config row, or undefined.
 * @returns a Set of enabled rule numbers.
 */
export function enabledRuleSet(config) {
  const raw = config ?? {}
  const only = Array.isArray(raw.enabledRules)
    ? raw.enabledRules.map(Number).filter((n) => Number.isInteger(n))
    : []
  const enabled = new Set()
  for (const rule of RULES) {
    if (only.length > 0) {
      if (only.includes(rule.number)) enabled.add(rule.number)
      continue
    }
    const value = raw[`rule${rule.number}`]
    const off = value === false || value === 'false' || value === 0
    if (!off) enabled.add(rule.number)
  }
  return enabled
}

/**
 * Describe the non-default selection, or return '' when every rule is on.
 * @param config - the plugin config row.
 * @returns a markdown blockquote line, or the empty string.
 */
export function activeRulesNotice(config) {
  const enabled = enabledRuleSet(config)
  if (enabled.size === RULES.length) return ''
  const on = [...enabled].sort((a, b) => a - b)
  const off = ALL_RULE_NUMBERS.filter((n) => !enabled.has(n))
  return (
    `> **Configured subset:** ${on.length} of ${RULES.length} rules are enabled ` +
    `(${on.join(', ') || 'none'}). Rules ${off.join(', ')} are off for this install, so their ` +
    `sections are omitted below; treat those areas as unconstrained here.\n`
  )
}

/**
 * Split a body into chunks keyed by the rule they belong to.
 * A chunk is either `{ rule: <number> }` or `{ rule: null }` for the preamble
 * and the unnumbered trailing sections. `###` subsections stay with their
 * parent `##` rule.
 * @param lines - body lines.
 * @returns ordered chunks.
 */
function chunkByRule(lines) {
  const chunks = []
  let current = { rule: null, lines: [] }
  chunks.push(current)
  for (const line of lines) {
    const numbered = /^##\s+(\d+)\.\s+/.exec(line)
    const unnumbered = !numbered && /^##\s+/.test(line)
    if (numbered || unnumbered) {
      current = { rule: numbered ? Number(numbered[1]) : null, lines: [] }
      chunks.push(current)
    }
    current.lines.push(line)
  }
  return chunks
}

/**
 * Read the `# rules 3-4 + 9` style annotation of a line into rule numbers.
 * Ranges (`1-2`) expand, bare numbers (`9`) stand alone, and anything that is
 * not a number (`SCRATCH`, `MOTW`, prose) is ignored. Numbers before the first
 * `#` never count, so a version string or a path cannot masquerade as a tag.
 * @param line - one line of markdown.
 * @returns rule numbers named by the annotation; empty when there is none.
 */
function ruleTagsOf(line) {
  const hash = line.indexOf('#')
  if (hash === -1) return []
  const numbers = []
  const pattern = /(\d+)(?:\s*[-–]\s*(\d+))?/g
  let match
  while ((match = pattern.exec(line.slice(hash))) !== null) {
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || from > 9 || to < from || to > 9) continue
    for (let n = from; n <= to; n += 1) numbers.push(n)
  }
  return numbers
}

/**
 * Drop command lines whose trailing rule annotation names only disabled
 * rules. A line with no annotation, or naming at least one enabled rule,
 * stays.
 * @param lines - lines to filter.
 * @param enabled - enabled rule numbers.
 * @returns filtered lines.
 */
function filterTaggedLines(lines, enabled) {
  const out = []
  for (const line of lines) {
    const tags = ruleTagsOf(line)
    if (tags.length > 0 && !tags.some((n) => enabled.has(n))) continue
    out.push(line)
  }
  return out
}

/** Exposed for tests: the rule numbers a verification line is tagged with. */
export { ruleTagsOf }

/**
 * Remove a fenced block that lost every content line to tag filtering, so a
 * disabled rule never leaves an empty code fence behind.
 * @param lines - lines to compact.
 * @returns compacted lines.
 */
function dropEmptyFences(lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const close = lines.findIndex((l, j) => j > i && /^```/.test(l))
      if (close !== -1 && lines.slice(i + 1, close).every((l) => l.trim() === '')) {
        i = close
        continue
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Build the body the model receives: the enabled rule sections only, with
 * verification commands filtered by their rule tags, plus a notice when the
 * selection is not "all nine".
 * @param body - the SKILL.md body (frontmatter already stripped).
 * @param config - the plugin config row.
 * @returns the filtered body.
 */
export function buildSkillContent(body, config) {
  const enabled = enabledRuleSet(config)
  const chunks = chunkByRule(body.split('\n'))
  const kept = []
  for (const chunk of chunks) {
    if (chunk.rule !== null && !enabled.has(chunk.rule)) continue
    kept.push(...chunk.lines)
  }
  const lines = dropEmptyFences(filterTaggedLines(kept, enabled))
  const notice = activeRulesNotice(config)
  const text = lines.join('\n')
  return notice === '' ? text : `${notice}\n${text}`
}
