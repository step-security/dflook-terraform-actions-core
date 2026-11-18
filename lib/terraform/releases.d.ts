import { Version } from '../version/version.js';
export declare class ReleaseLookupError extends Error {
}
/**
 * Every published Terraform version.
 *
 * Read from the release index rather than a JSON API because HashiCorp does not
 * publish one; the index is the authoritative list of what exists.
 */
export declare function getTerraformVersions(): Promise<Version[]>;
/**
 * Every published OpenTofu version.
 *
 * The releases endpoint is paged, and a token is used when one is available
 * purely to avoid the unauthenticated rate limit — the data itself is public.
 */
export declare function getOpenTofuVersions(token?: string): Promise<Version[]>;
//# sourceMappingURL=releases.d.ts.map