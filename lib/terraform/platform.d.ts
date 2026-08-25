/**
 * Mapping the running machine onto the names releases are published under.
 *
 * Kept free of any dependency so that anything needing to know the target
 * platform — including version selection, which applies architecture-specific
 * constraints — can ask without pulling in the downloader.
 */
export declare class UnsupportedPlatform extends Error {
}
/** Release-channel name for the running operating system. */
export declare function releasePlatform(): string;
/** Release-channel name for the running architecture. */
export declare function releaseArch(): string;
/** Name of the executable inside a release archive. */
export declare function executableName(): string;
//# sourceMappingURL=platform.d.ts.map