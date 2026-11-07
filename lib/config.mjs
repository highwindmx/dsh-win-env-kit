// The plugin's Config schema.
//
// Cordis validates a plugin row's `config` against the `Config` export at
// activation, and `Config.listConfigs` reports this schema so the settings UI
// can render one toggle per rule. The schema is built from RULES, so a rule
// can never exist in the document without a matching switch.
//
// The schema library is a host-provided peer dependency (`@deepseek-ai/
// schemastery`), so `defineConfig` takes it as an argument instead of
// importing it: the provider resolves the real library when the host has it,
// and the self test can pass a probe object without one. That keeps
// `lib/index.js` loadable in a bare checkout.
//
// @module dsh-win-env-kit/config
import { RULES } from './rules.mjs'

/**
 * Build the Config schema with the caller's schemastery-compatible `z`.
 * @param z - the schema library (default export of `@deepseek-ai/schemastery`).
 * @returns the Config object schema.
 */
export function defineConfig(z) {
  const shape = {
    /**
     * Direct form: enable exactly these rule numbers. Takes precedence over
     * the per-rule switches when non-empty. Handy for a short patch row,
     * since a cordis `config` is replaced wholesale rather than deep-merged.
     */
    enabledRules: z
      .array(z.number())
      .default([])
      .description(
        'Enable exactly these rule numbers (1-9). When empty, the per-rule switches below decide.'
      )
  }

  for (const rule of RULES) {
    shape[`rule${rule.number}`] = z
      .boolean()
      .default(true)
      .description(`${rule.number}. ${rule.title}`)
  }

  return z.object(shape)
}

/** Config keys in schema order, for tests and docs. */
export const CONFIG_KEYS = ['enabledRules', ...RULES.map((rule) => `rule${rule.number}`)]

export default defineConfig
