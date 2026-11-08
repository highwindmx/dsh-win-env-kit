// Machine-checkable self test for the dsh-win-env-kit skills provider.
// Run from the package root with `npm run verify` (or `node scripts/verify-provider.mjs`).
// A non-zero exit means the package must not be shipped.
//
// It stubs ctx.skills.registerProvider, drives apply() from lib/index.js, and
// asserts the contract the skill loader depends on: exactly one skill named
// win-env-kit, whose get() exposes a directory resourceBase containing the
// bundled tools, and whose body is clean of host-specific identity.
//
// It also drives the rule selection: every rule on by default, a disabled
// rule's section gone from the body, `enabledRules` overriding the per-rule
// switches, and the published Config schema carrying one switch per rule.
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
// On Windows, import() of an absolute path fails (ERR_UNSUPPORTED_ESM_URL_SCHEME);
// convert to a file:// URL first.
const mod = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
const rules = await import(pathToFileURL(join(pkgRoot, 'lib', 'rules.mjs')).href)
const configModule = await import(pathToFileURL(join(pkgRoot, 'lib', 'config.mjs')).href)
const hostSchema = await import(pathToFileURL(join(pkgRoot, 'lib', 'host-schema.mjs')).href)

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

check(typeof mod.apply === 'function', 'apply() is not exported as a function')
check(mod.name === 'dsh-win-env-kit', `plugin name is ${JSON.stringify(mod.name)}, expected 'dsh-win-env-kit'`)
check(Array.isArray(mod.inject) && mod.inject.includes('skills'), "inject must include 'skills'")

/** Run apply() with a stub ctx and return the captured provider. */
function startProvider(config) {
  let provider
  const ctx = {
    skills: {
      registerProvider(factory) {
        provider = factory({})
        return () => {}
      }
    }
  }
  mod.apply(ctx, config)
  return provider
}

const provider = startProvider(undefined)
check(typeof provider === 'object' && provider !== null, 'apply() did not register a provider')
check(provider && provider.name === 'dsh-win-env-kit', 'registered provider name mismatch')

if (provider) {
  const list = await provider.list({})
  check(Array.isArray(list), 'list() did not return an array')
  check(list.length === 1, `list() returned ${list.length} candidates, expected 1`)
  const candidate = list[0]
  check(candidate && candidate.name === 'win-env-kit', `candidate name is ${candidate && candidate.name}, expected 'win-env-kit'`)
  check(candidate && typeof candidate.description === 'string' && candidate.description.length > 0, 'candidate has no description')
  check(candidate && candidate.description.length <= 500, 'description exceeds the 500-char host catalog truncation limit')

  if (candidate) {
    const got = await provider.get(candidate, {})
    check(got !== undefined, 'get() returned undefined')
    if (got) {
      check(got.resourceBase && got.resourceBase.kind === 'directory', 'resourceBase.kind is not directory')
      const base = got.resourceBase && got.resourceBase.path
      check(typeof base === 'string' && base.length > 0, 'resourceBase.path missing')
      if (typeof base === 'string') {
        check(existsSync(join(base, 'tools', 'dsh-env-lint.mjs')), 'tools/dsh-env-lint.mjs not found under resourceBase')
        check(existsSync(join(base, 'tools', 'dsh-screenshot.ps1')), 'tools/dsh-screenshot.ps1 not found under resourceBase')
        check(existsSync(join(base, 'HOST-PROFILE.md')), 'HOST-PROFILE.md not found under resourceBase')
      }
      check(typeof got.content === 'string' && got.content.includes('Verification commands'), 'skill body missing Verification commands section')
      // A concrete restricting SID (digits after S-1-4-) must never appear in the
      // skill body; rule text only uses the S-1-4-* wildcard / S-1-4-… ellipsis.
      check(!/S-1-4-\d/.test(got.content), 'a concrete S-1-4-* SID leaked into SKILL.md body')

      // Default config: every rule present, and no "configured subset" notice.
      for (const rule of rules.RULES) {
        check(
          got.content.includes(`\n## ${rule.number}. `),
          `default config dropped rule ${rule.number} from the body`
        )
      }
      check(!got.content.includes('**Configured subset:**'), 'default config emitted a subset notice')
      check(!got.description.includes('This install enables rules'), 'default config annotated the description')
      check(rules.describeSelectionLine(undefined) === '', 'default selection line is not empty')
    }
  }

  // One rule off: its section disappears, the others survive, and the notice names it.
  const offProvider = startProvider({ rule5: false, rule6: false })
  const offGot = await offProvider.get(candidate, {})
  if (offGot) {
    check(!offGot.content.includes('\n## 5. '), 'rule 5 section survived rule5: false')
    check(!offGot.content.includes('\n## 6. '), 'rule 6 section survived rule6: false')
    check(offGot.content.includes('\n## 1. '), 'disabling rules 5-6 also dropped rule 1')
    check(offGot.content.includes('**Configured subset:**'), 'a partial selection emitted no subset notice')
    check(
      offGot.content.includes('rules 5, 6 are off'),
      'the subset notice does not name the disabled rules'
    )
    // C: the catalog description and the loaded body must state the SAME
    // canonical selection sentence, so the trigger text and the skill never
    // disagree about which rules are live.
    const selLine = rules.describeSelectionLine({ rule5: false, rule6: false })
    check(selLine.length > 0, 'describeSelectionLine returned empty for a subset selection')
    check(offGot.content.includes(selLine), 'the body does not carry the canonical selection sentence')
    check(offGot.description.includes(selLine), 'the description does not carry the canonical selection sentence')
    check(
      offGot.description.includes('This install enables rules') &&
        offGot.description.includes('rules 5, 6 are off'),
      'the description does not advertise the selection'
    )
    // Verification lines tagged only with disabled rules go with them; a line
    // tagged with an enabled rule stays.
    // The gate also appears in the tool-resolution examples and in rule 6's own
    // body, so assert on the tagged verification line itself (its tag comment).
    check(
      !offGot.content.includes('# rule 6'),
      'a verification command tagged only with a disabled rule survived'
    )
    check(
      offGot.content.includes('build-audit.mjs" out\\app.exe --strict'),
      'a verification command tagged with enabled rules was dropped'
    )
  }

  // `enabledRules` wins over the per-rule switches.
  const onlyProvider = startProvider({ enabledRules: [1, 2], rule3: true })
  const onlyGot = await onlyProvider.get(candidate, {})
  if (onlyGot) {
    check(onlyGot.content.includes('\n## 1. '), 'enabledRules [1,2] dropped rule 1')
    check(onlyGot.content.includes('\n## 2. '), 'enabledRules [1,2] dropped rule 2')
    check(!onlyGot.content.includes('\n## 3. '), 'enabledRules [1,2] kept rule 3 (switches must not win)')
    check(!onlyGot.content.includes('\n## 9. '), 'enabledRules [1,2] kept rule 9')
  }

  // A non-boolean, unrecognised value leaves a rule on rather than muting it.
  check(
    rules.enabledRuleSet({ rule7: 'yes' }).has(7),
    'a non-boolean rule value muted the rule instead of treating it as on'
  )
  check(
    rules.enabledRuleSet(undefined).size === 9,
    'an absent config did not enable all nine rules'
  )
  check(
    [...rules.enabledRuleSet({ rule4: false })].sort((a, b) => a - b).join(',') === '1,2,3,5,6,7,8,9',
    'rule4: false did not disable exactly rule 4'
  )

  // Verification-line tagging: ranges expand, non-numeric tokens are ignored.
  check(
    rules.ruleTagsOf('node x.mjs .   # rules 1-2 + SCRATCH (rule 5)').join(',') === '1,2,5',
    'rule tag range parsing is wrong'
  )
  check(rules.ruleTagsOf('node x.mjs out\\app.exe').length === 0, 'an untagged line reported rule tags')
  check(
    rules.ruleTagsOf('node x.mjs v1.2.3 # rule 9').join(',') === '9',
    'a number before # was mistaken for a rule tag'
  )
}

// The published schema: one switch per rule plus enabledRules, all defaulting
// to on. Uses schemastery when resolvable, otherwise the stub below.
// Chainable by mutation so `.default(x).description(y)` keeps both the default
// and the text; a spread-based stub drops the default set by the earlier call.
function stubField() {
  const field = {}
  field.default = (v) => {
    field.fallback = v
    return field
  }
  field.description = (d) => {
    field.text = d
    return field
  }
  field.required = () => field
  field.min = () => field
  field.max = () => field
  return field
}
const stubZ = {
  boolean: () => stubField(),
  number: () => stubField(),
  string: () => stubField(),
  array: () => stubField(),
  object: (shape) => ({ shape })
}

let z = stubZ
let realSchema = false
// Resolve the peer the same way the plugin does: bare specifier first, then a
// profile-anchored fallback. A linked install has no local node_modules, so a
// bare import here would report UNDEFINED on exactly the setup we ship into.
const resolvedZ = await hostSchema.loadHostSchemastery()
if (resolvedZ) {
  z = resolvedZ
  realSchema = true
}
const built = configModule.defineConfig(z)
const shape = realSchema ? null : built.shape
const keys = realSchema ? configModule.CONFIG_KEYS : Object.keys(shape)
check(
  keys.join(',') === `enabledRules,${rules.RULES.map((r) => `rule${r.number}`).join(',')}`,
  `Config keys are ${keys.join(',')}`
)
if (!realSchema) {
  for (const rule of rules.RULES) {
    const field = shape[`rule${rule.number}`]
    check(field && field.fallback === true, `Config rule${rule.number} does not default to true`)
    check(
      field && typeof field.text === 'string' && field.text.includes(rule.title),
      `Config rule${rule.number} does not describe its rule`
    )
  }
  check(shape.enabledRules && Array.isArray(shape.enabledRules.fallback), 'Config enabledRules is not a list')
} else {
  // A schemastery Schema is callable, so accept both function and object.
  const builtOk = built !== null && (typeof built === 'object' || typeof built === 'function')
  check(builtOk, 'defineConfig returned nothing for real schemastery')
  const resolved = z.resolve
    ? z.resolve({}, built)
    : built({})
  const row = Array.isArray(resolved) ? resolved[0] : resolved
  check(row && row.rule1 === true && row.rule9 === true, 'Config defaults are not all-on')
}

// A missing schema is not fatal (the loader then accepts any row config and
// every rule stays on) but it is silent: the per-rule switches stop working.
// Demand the schema whenever a host copy is reachable, so a broken peer
// resolution fails here instead of shipping a plugin whose config is ignored.
check(
  !realSchema || typeof mod.Config === 'object' || typeof mod.Config === 'function',
  'Config was not exported while @deepseek-ai/schemastery resolves (host would accept any row config)'
)
if (!realSchema) {
  console.log('note: no schemastery reachable from this checkout; schema assertions used the stub')
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  console.error(`\nverify-provider: ${failures.length} assertion(s) failed`)
  process.exit(1)
}
console.log(
  'verify-provider: OK (1 skill, directory resourceBase, bundled tools present, clean body, ' +
    'rule selection + Config schema verified)'
)
