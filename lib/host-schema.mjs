// Locate the host's schemastery copy.
//
// A published plugin resolves its peer dependencies out of the installing
// profile's `node_modules`, so a plain `import('@deepseek-ai/schemastery')`
// just works. A *linked* install does not: pnpm points
// `<profile>/node_modules/dsh-win-env-kit` at the checkout, and Node resolves
// the bare specifier from the checkout's real path — which has no
// `node_modules` at all. The import then fails, `Config` degrades to
// undefined, and every rule silently stays on.
//
// So try the bare specifier first, and fall back to resolving the package from
// a known DSH profile directory. Cross-copy use is safe: schemastery tags its
// schemas with `Symbol.for('schemastery')`, a global-registry symbol, so a
// schema built by one copy is recognised by another.
//
// @module dsh-win-env-kit/host-schema
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readdirSync } from 'node:fs'

const SPEC = '@deepseek-ai/schemastery'

/**
 * Directories that may hold the host's node_modules, most specific first.
 * The DSH environment variables name the running profile; when they are absent
 * (an Electron main process that never exported them) fall back to the
 * conventional `~/.dsh/profiles/*` layout so a linked install still validates.
 * @returns a list of directory paths to anchor resolution on.
 */
function anchors() {
  const list = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) list.push(profileDir)
  const home = process.env.DSH_HOME
  if (home) {
    const profile = process.env.DSH_PROFILE
    list.push(profile ? join(home, 'profiles', profile) : home)
  }
  const conventional = join(homedir(), '.dsh')
  if (!home || !conventional.startsWith(home)) {
    const named = process.env.DSH_PROFILE
    if (named) list.push(join(conventional, 'profiles', named))
    try {
      for (const entry of readdirSync(join(conventional, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) list.push(join(conventional, 'profiles', entry.name))
      }
    } catch {
      // No profiles directory: nothing to add.
    }
  }
  return [...new Set(list)]
}

/**
 * Resolve one package entry point relative to an anchor directory.
 * @param anchor - directory to treat as the resolution root.
 * @returns the default export of the package, or undefined when unresolvable.
 */
async function loadFromAnchor(anchor) {
  const require = createRequire(join(anchor, 'package.json'))
  const manifestPath = require.resolve(`${SPEC}/package.json`)
  const manifest = require(manifestPath)
  const entry = manifest?.exports?.['.']
  const importTarget =
    typeof entry === 'string'
      ? entry
      : typeof entry?.import === 'string'
        ? entry.import
        : typeof manifest?.module === 'string'
          ? manifest.module
          : undefined
  const target = importTarget ? join(dirname(manifestPath), importTarget) : manifestPath
  const mod = await import(pathToFileURL(target).href)
  return mod.default ?? mod
}

/**
 * Load the host's schemastery, falling back to profile-anchored resolution.
 * @returns the schema builder, or undefined when no copy is reachable.
 */
export async function loadHostSchemastery() {
  try {
    const mod = await import(SPEC)
    const z = mod.default ?? mod
    if (typeof z?.object === 'function') return z
  } catch {
    // Fall through to the profile anchors.
  }
  for (const anchor of anchors()) {
    try {
      const z = await loadFromAnchor(anchor)
      if (typeof z?.object === 'function') return z
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}
