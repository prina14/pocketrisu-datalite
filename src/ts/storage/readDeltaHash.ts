import { Sha256 } from '@aws-crypto/sha256-js'

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export function readHash(bytes: Uint8Array): string {
    const hash = new Sha256()
    hash.update(bytes)
    return hex(hash.digestSync())
}

export async function readHashAsync(bytes: Uint8Array): Promise<string> {
    try {
        if (globalThis.crypto?.subtle) {
            return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
        }
    } catch { /* HTTP origins and restricted browsers keep the verified JS path. */ }
    return readHash(bytes)
}
