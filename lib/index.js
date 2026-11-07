// dsh-win-env-kit: portable Windows environment rules for the DeepSeek Harness.
//
// A Cordis plugin that registers one skill provider into the HOST layer of the
// `ctx.skills` registry, so every agent preset's scope chain merges this
// skill. The skill body and its bundled tools live in
// `../skills/<name>/` inside this package; the provider locates them from
// `import.meta.url` (an assembly fact of this package, never user config)
// and loads bodies on demand.
//
// The provider protocol mirrors @deepseek-ai/dsh-skill-filesystem:
//   - list()  discovers directory-bundle candidates (name/description from
//     YAML frontmatter, body left unread until requested)
//   - get()   parses the winning candidate's SKILL.md and returns the full
//     definition with a directory resource base for relative references
//
// The directory `resourceBase` is the important part: it is what makes the
// `tools/...` paths inside SKILL.md resolve against the installed package,
// not against the workspace CWD.
//
// The `Config` export selects which of the nine rules the model sees; the
// document stays single-sourced on disk and is filtered per install in
// `get()` (see ./rules.mjs). Config itself needs the host's schemastery peer
// dependency, so it is imported opportunistically: with the dependency absent
// (e.g. a bare `node scripts/verify-provider.mjs` in the package folder) the
// provider still loads and every rule stays on.
//
// @module dsh-win-env-kit
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RULES, buildSkillContent, enabledRuleSet } from './rules.mjs'

const name = 'dsh-win-env-kit'
const inject = ['skills']

/**
 * Rule selection schema; undefined when the host's schemastery cannot be
 * resolved (a bare checkout running the self test). Declaring no Config is
 * harmless: with none, the loader accepts any row config and every rule stays
 * on, which is the default anyway.
 */
let Config
try {
  const [{ default: z }, { defineConfig }] = await Promise.all([
    import('@deepseek-ai/schemastery'),
    import('./config.mjs')
  ])
  Config = defineConfig(z)
} catch {
  Config = undefined
}

/** Registry precedence for packaged skill providers: ranks below the local bundled root. */
const PACKAGED_SKILL_RANK = 550

/** The source bucket these skills advertise under (prompt-visible metadata). */
const SOURCE = 'custom'

/**
 * Parse the YAML frontmatter block of a SKILL.md into metadata plus body.
 * Handles the scalar fields DSH skill discovery consumes (name, description,
 * whenToUse) plus the invocation flag, and supports folded scalar blocks
 * (`description: >` followed by indented lines) — folded lines are joined
 * with single spaces, matching YAML semantics. Richer metadata passes
 * through verbatim.
 * @param text - the raw skill file contents.
 * @returns parsed metadata object and the markdown body after the block, or
 *   null when the file has no frontmatter block at all.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  let currentKey = null
  let folded = false
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (/^[ \t]/.test(line) && currentKey !== null) {
      // Indented continuation of a folded scalar.
      const value = line.trim()
      if (value) {
        metadata[currentKey] = folded
          ? `${metadata[currentKey]} ${value}`
          : `${metadata[currentKey]}\n${value}`
      }
      continue
    }
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!match) {
      currentKey = null
      folded = false
      continue
    }
    let value = match[2].trim()
    folded = value === '>' || value === '>-' || value === '>+'
    if (folded) {
      value = ''
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
    currentKey = folded ? match[1] : null
  }
  return { metadata, body }
}

/**
 * Read and parse one skill directory's SKILL.md.
 * @param skillFile - absolute path to the SKILL.md file.
 * @param signal - optional cancellation; aborts the read.
 * @returns the parsed skill record, or undefined when the file vanished.
 */
async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === null) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body
  }
}

/**
 * `disable-model-invocation: true` marks a user-invoked skill (reachable only
 * by the human). Map it onto DSH's invocation flags; anything else stays
 * model- and user-invocable. This skill needs model self-invocation, so its
 * SKILL.md does not set the flag.
 * @param metadata - parsed frontmatter metadata.
 * @returns the DSH invocation record.
 */
function invocationFrom(metadata) {
  if (metadata['disable-model-invocation'] === 'true') {
    return { modelInvocable: false, userInvocable: true }
  }
  return { modelInvocable: true, userInvocable: true }
}

/**
 * Discover packaged skill candidates by scanning the package's `skills/`
 * directory: one subdirectory per skill, each carrying a SKILL.md.
 * @param skillsRoot - absolute path to this package's skills directory.
 * @param signal - optional cancellation.
 * @returns the candidate list.
 */
async function discoverCandidates(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: invocationFrom(parsed.metadata),
      source: SOURCE,
      provider: name,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {})
    })
  }
  return candidates
}

/**
 * Append the selection to the frontmatter description so the model sees which
 * rules are live before it decides to load the skill. Without this, turning a
 * rule off would leave it advertised in the trigger text but absent from the
 * body — the worst of both.
 * @param description - the frontmatter description.
 * @param config - the plugin config row.
 * @returns the description, annotated when the selection is not "all nine".
 */
function describeSelection(description, config) {
  const enabled = enabledRuleSet(config)
  if (enabled.size === RULES.length) return description
  const off = RULES.filter((rule) => !enabled.has(rule.number)).map((rule) => rule.number)
  const on = [...enabled].sort((a, b) => a - b)
  return `${description} This install enables rules ${on.join(', ') || 'none'}; rules ${off.join(', ')} are off.`
}

/**
 * Register the packaged win-env-kit provider on `ctx.skills`.
 * @param ctx - the plugin context; `ctx.skills` receives the provider.
 * @param config - the validated row config (rule selection).
 */
function apply(ctx, config) {
  const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  ctx.skills.registerProvider((control) => ({
    name,
    async list(options) {
      const candidates = await discoverCandidates(skillsRoot, options?.signal)
      return candidates.map((candidate) => ({
        ...candidate,
        description: describeSelection(candidate.description, config)
      }))
    },
    async get(candidate, options) {
      const parsed = await parseSkillFile(candidate.path, options?.signal)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: describeSelection(parsed.description, config),
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: invocationFrom(parsed.metadata),
        source: SOURCE,
        provider: name,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: buildSkillContent(parsed.content, config)
      }
    }
  }))
}

export { Config, apply, name, inject }
export default { Config, apply, name, inject }
