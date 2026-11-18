/**
 * Mapping the running machine onto the names releases are published under.
 *
 * Kept free of any dependency so that anything needing to know the target
 * platform — including version selection, which applies architecture-specific
 * constraints — can ask without pulling in the downloader.
 */
export class UnsupportedPlatform extends Error {
}
const ARCHITECTURES = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };
const PLATFORMS = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
/** Release-channel name for the running operating system. */
export function releasePlatform() {
    const platform = PLATFORMS[process.platform];
    if (!platform)
        throw new UnsupportedPlatform(`No release is published for '${process.platform}'`);
    return platform;
}
/** Release-channel name for the running architecture. */
export function releaseArch() {
    const arch = ARCHITECTURES[process.arch];
    if (!arch)
        throw new UnsupportedPlatform(`No release is published for '${process.arch}'`);
    return arch;
}
/** Name of the executable inside a release archive. */
export function executableName() {
    return process.platform === 'win32' ? 'terraform.exe' : 'terraform';
}
//# sourceMappingURL=platform.js.map