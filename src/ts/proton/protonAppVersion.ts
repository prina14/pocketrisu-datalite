/** Proton accepts its own release labels, not our DataLite prerelease suffix.
 * Keep the external client identity and use the package's numeric base version.
 */
export function protonAppVersion(version: string): string {
    const base = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(version)?.[1] ?? '0.0.0'
    return `external-drive-pocketrisu@${base}-stable`
}
