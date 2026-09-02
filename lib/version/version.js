/**
 * The version model used throughout release selection.
 *
 * Terraform and OpenTofu both publish `major.minor.patch` with an optional
 * pre-release suffix. Ordering has one non-obvious rule: a release with no
 * pre-release suffix sorts *above* any pre-release of the same number, so
 * 1.6.0 is newer than 1.6.0-rc1. Suffixes themselves compare as plain strings,
 * which is what the upstream release channels rely on.
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([\d\w-]+))?/;
export class InvalidVersion extends Error {
}
export class Version {
    major;
    minor;
    patch;
    /** Empty string when this is a final release. */
    preRelease;
    product;
    constructor(version, product = 'Terraform') {
        const match = VERSION.exec(version);
        if (!match)
            throw new InvalidVersion(`Not a valid version: ${version}`);
        this.major = Number(match[1]);
        this.minor = Number(match[2]);
        this.patch = Number(match[3]);
        this.preRelease = match[4] ?? '';
        this.product = product;
    }
    toString() {
        const core = `${this.major}.${this.minor}.${this.patch}`;
        return this.preRelease ? `${core}-${this.preRelease}` : core;
    }
    equals(other) {
        return compareVersions(this, other) === 0;
    }
}
/** Negative when a sorts before b, positive when after, zero when equal. */
export function compareVersions(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    if (a.minor !== b.minor)
        return a.minor - b.minor;
    if (a.patch !== b.patch)
        return a.patch - b.patch;
    if (a.preRelease === b.preRelease)
        return 0;
    // A final release outranks any pre-release of the same number.
    if (a.preRelease === '')
        return 1;
    if (b.preRelease === '')
        return -1;
    return a.preRelease < b.preRelease ? -1 : 1;
}
/** Ascending order. */
export function sortVersions(versions) {
    return [...versions].sort(compareVersions);
}
/** Highest version, ignoring pre-releases. Undefined when there are none. */
export function latestFinalVersion(versions) {
    const ordered = sortVersions(versions).reverse();
    return ordered.find((version) => !version.preRelease);
}
/** Highest version, pre-releases included. */
export function latestVersion(versions) {
    return sortVersions(versions).pop();
}
/** Lowest version, ignoring pre-releases. */
export function earliestFinalVersion(versions) {
    return sortVersions(versions).find((version) => !version.preRelease);
}
/** Lowest version, pre-releases included. */
export function earliestVersion(versions) {
    return sortVersions(versions)[0];
}
/** Parses a version, returning undefined instead of throwing. */
export function tryParseVersion(value, product = 'Terraform') {
    try {
        return new Version(value.trim(), product);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=version.js.map