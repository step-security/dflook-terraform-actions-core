import { Version } from '../version/version.js';
export declare class DownloadError extends Error {
}
export interface AcquireOptions {
    /** Skips signature verification. Only for platforms where gpg is unavailable. */
    skipSignatureCheck?: boolean;
}
/**
 * Downloads a Terraform release and returns the executable's directory.
 *
 * The chain is: fetch the signature and checksums, verify the signature, fetch
 * the archive, verify its digest against the now-trusted checksums, and only
 * then extract. A version already in the tool cache short-circuits all of it.
 */
export declare function acquireTerraform(version: Version, options?: AcquireOptions): Promise<string>;
/**
 * Downloads an OpenTofu release and returns the executable.
 *
 * OpenTofu publishes checksums as a GitHub release asset. There is no
 * HashiCorp-equivalent signing key here, so verification is the digest alone.
 */
export declare function acquireOpenTofu(version: Version): Promise<string>;
/** Downloads whichever product the version belongs to. */
export declare function acquire(version: Version, options?: AcquireOptions): Promise<string>;
//# sourceMappingURL=download.d.ts.map