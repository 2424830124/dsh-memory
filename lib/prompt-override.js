/**
 * Prompt-section overrides: put plugin-owned text into the slots the host or a
 * preset already filled, instead of registering competing sections.
 *
 * Registration cannot do this job. Sections are layered per scope, and an agent
 * preset registers `deployment:persona-prefix` inside the very agent scope this
 * plugin would use; a second registration of the same name in the same layer
 * throws `already registered`. Rewriting the assembled result is the only
 * collision-free point, so the rules live here as pure functions over it.
 *
 * Two slots are rewritten, each only when the plugin has text for it:
 *
 * - `deployment:persona-prefix` (order 0) carries the frozen memory block.
 * - `harness:identity` (order -1000) carries the selected preset text.
 *
 * Everything else in the assembly — order, contexts, tools, variables — is left
 * exactly as the other listeners produced it.
 *
 * @module dsh-memory/prompt-override
 */

/** The host's persona prefix section (`SystemPrompt`'s `PERSONA_PREFIX_SECTION`). */
export const PERSONA_SECTION = 'deployment:persona-prefix'

/** The host's fixed opener; absent when `includeHarnessIdentity` is off. */
export const HARNESS_IDENTITY_SECTION = 'harness:identity'

/**
 * Replace one section's text, or add it at the front when the host omitted it.
 *
 * `insertMissing` is what separates the two slots: a preset still needs a
 * section when the host dropped `harness:identity`, while memory must leave the
 * persona alone rather than invent one. Both texts are literal prose, so the
 * rewritten entry disables interpolation: a stray `{{…}}` is text, not a
 * variable reference (or an unknown-name error).
 *
 * @param {{sections?: {name: string, text: string}[]}} assembly - the host assembly result.
 * @param {string} name - the section to rewrite.
 * @param {string} text - the text to put in it.
 * @param {boolean} insertMissing - whether to add the section when it is absent.
 * @returns {object} the same assembly, or a rewritten copy.
 */
function replaceSection(assembly, name, text, insertMissing) {
  const sections = assembly?.sections
  if (!Array.isArray(sections)) return assembly
  const index = sections.findIndex((section) => section?.name === name)
  if (index === -1) {
    return insertMissing ? { ...assembly, sections: [{ name, text, interpolate: false }, ...sections] } : assembly
  }
  const rewritten = sections.slice()
  rewritten[index] = { ...rewritten[index], text, interpolate: false }
  return { ...assembly, sections: rewritten }
}

/**
 * Replace the persona prefix section's text with the memory block.
 *
 * An empty text, a missing section, or an unexpected shape returns the input
 * unchanged: without something to inject, the persona must survive.
 *
 * @param {{sections?: {name: string, text: string}[]}} assembly - the host assembly result.
 * @param {string} text - the frozen memory block.
 * @returns {object} the same assembly, or a rewritten copy.
 */
export function overridePersona(assembly, text) {
  if (text === '') return assembly
  return replaceSection(assembly, PERSONA_SECTION, text, false)
}

/**
 * Replace the harness identity section's text with the selected preset.
 *
 * The host drops that section entirely when `includeHarnessIdentity` is off, but
 * a preset still needs a slot; identity sorts before every other section, so a
 * missing one is inserted at the front. An empty text returns the input
 * unchanged — no preset means the native identity survives, exactly like an
 * empty memory block leaves the native persona alone.
 *
 * @param {{sections?: {name: string, text: string}[]}} assembly - the host assembly result.
 * @param {string} text - the preset text, or `''` for none.
 * @returns {object} the same assembly, or a rewritten copy.
 */
export function overrideHarnessIdentity(assembly, text) {
  if (text === '') return assembly
  return replaceSection(assembly, HARNESS_IDENTITY_SECTION, text, true)
}
