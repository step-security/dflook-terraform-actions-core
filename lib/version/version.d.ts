/**
 * The version model used throughout release selection.
 *
 * Terraform and OpenTofu both publish `major.minor.patch` with an optional
 * pre-release suffix. Ordering has one non-obvious rule: a release with no
 * pre-release suffix sorts *above* any pre-release of the same number, so
 * 1.6.0 is newer than 1.6.0-rc1. Suffixes themselves compare as plain strings,
 * which is what the upstream release channels rely on.
 */
export type Product = 'Terraform' | 'OpenTofu';
export declare class InvalidVersion extends Error {
}
export declare class Version {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** Empty string when this is a final release. */
    readonly preRelease: string;
    readonly product: Product;
    constructor(version: string, product?: Product);
    toString(): string;
    equals(other: Version): boolean;
}
/** Negative when a sorts before b, positive when after, zero when equal. */
export declare function compareVersions(a: Version, b: Version): number;
/** Ascending order. */
export declare function sortVersions(versions: Iterable<Version>): Version[];
/** Highest version, ignoring pre-releases. Undefined when there are none. */
export declare function latestFinalVersion(versions: Iterable<Version>): Version | undefined;
/** Highest version, pre-releases included. */
export declare function latestVersion(versions: Iterable<Version>): Version | undefined;
/** Lowest version, ignoring pre-releases. */
export declare function earliestFinalVersion(versions: Iterable<Version>): Version | undefined;
/** Lowest version, pre-releases included. */
export declare function earliestVersion(versions: Iterable<Version>): Version | undefined;
/** Parses a version, returning undefined instead of throwing. */
export declare function tryParseVersion(value: string, product?: Product): Version | undefined;
//# sourceMappingURL=version.d.ts.map