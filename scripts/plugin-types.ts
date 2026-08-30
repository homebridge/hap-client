/**
 * Custom services and characteristics defined by individual Homebridge plugins.
 *
 * hap-client can only surface what it can name: any service or characteristic
 * whose UUID is missing from the generated maps in `src/hap-types.ts` is
 * filtered out of the parsed service list entirely (see the `Services[s.type]`
 * and `Characteristics[c.type]` filters in `src/index.ts`), which hides it
 * from every downstream consumer - the Homebridge UI's accessories page, the
 * Node-RED integration, and so on.
 *
 * The generator picks up Apple's types from hap-nodejs and the community Eve
 * types from homebridge-lib automatically. Types a plugin invents for itself
 * have no package the generator can import, so they are registered here by
 * hand.
 *
 * To add one:
 *  1. Append an entry below, copying the UUID exactly from the plugin's source.
 *  2. Run `npm run gen` and commit the regenerated `src/hap-types.ts` with it.
 *
 * Rules:
 *  - The UUID is the type's identity. Copy it from the defining plugin, never
 *    invent or "correct" one.
 *  - Entries here never override an Apple or homebridge-lib type. If a name or
 *    UUID is already taken - including a plugin type that has since become
 *    official - generation fails and says which entry to remove.
 */

export interface PluginType {
  /** The name to surface the type under, e.g. 'OpticalSignal' */
  name: string
  /** The UUID exactly as the defining plugin declares it */
  uuid: string
  /** The plugin that defines this type, so the entry can be traced */
  definedBy: string
}

export const PluginServices: PluginType[] = []

export const PluginCharacteristics: PluginType[] = [
  {
    name: 'OpticalSignal',
    uuid: 'A11C14A7-BB9B-4085-8597-68CF63964BF8',
    definedBy: 'homebridge-homematicip',
  },
]
