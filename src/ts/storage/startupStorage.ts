import { NodeStorage } from './nodeStorage'

// One tab, one authenticated storage instance. This entry must stay free of
// App/Svelte stores, database decoding, plugin execution and login UI imports.
let storage: NodeStorage | undefined
export function getStartupStorage(): NodeStorage {
    return storage ??= new NodeStorage()
}
export function startStartupStoragePrefetch(): Promise<void> {
    return getStartupStorage().prefetchStartupDatabase()
}
