/**
 * Credentials Terraform needs to reach private module sources and Terraform
 * Cloud.
 *
 * Three inputs, each written where Terraform or git already looks for it:
 *
 * - `TERRAFORM_CLOUD_TOKENS` becomes `credentials` blocks in `.terraformrc`
 * - `TERRAFORM_HTTP_CREDENTIALS` becomes `.netrc` entries, which is how git
 *   authenticates HTTPS module sources
 * - `TERRAFORM_SSH_KEY` becomes an SSH private key, for git+ssh sources
 *
 * Existing files are appended to rather than replaced. A workflow may well have
 * set up its own credentials before this runs, and clobbering them would break
 * module sources that were previously working.
 */
export interface CredentialInputs {
    /** Newline- or comma-separated `hostname=token` pairs. */
    cloudTokens?: string;
    /** Newline-separated `hostname=username:password` entries. */
    httpCredentials?: string;
    /** A private key, written with owner-only permissions. */
    sshKey?: string;
}
export interface CredentialTarget {
    /** Where `.terraformrc` and `.netrc` live. Defaults to the home directory. */
    home?: string;
}
export interface WrittenCredentials {
    /** Hostnames a Terraform Cloud token was written for. */
    cloudHosts: string[];
    /** Hostnames a netrc entry was written for. */
    netrcHosts: string[];
    sshKeyWritten: boolean;
}
/**
 * Renders `credentials` blocks for a Terraform CLI config.
 *
 * Each entry is `hostname=token`. The token may itself contain `=` — base64
 * padding, for instance — so only the first separator is significant.
 */
export declare function formatCloudTokens(value: string): {
    host: string;
    token: string;
}[];
/**
 * Parses HTTP credentials.
 *
 * Each entry is `hostname=username:password`, where the hostname may include a
 * path prefix so different repositories on one host can use different
 * credentials. The password may contain colons, so only the first is a
 * separator.
 */
export declare function formatHttpCredentials(value: string): {
    host: string;
    username: string;
    password: string;
}[];
/** Renders a `.terraformrc` credentials block. */
export declare function renderTerraformrc(credentials: {
    host: string;
    token: string;
}[]): string;
/**
 * Renders `.netrc` machine entries.
 *
 * A host given with a path prefix is reduced to its hostname, since netrc keys
 * on host alone.
 */
export declare function renderNetrc(credentials: {
    host: string;
    username: string;
    password: string;
}[]): string;
/**
 * Writes every supplied credential to disk.
 *
 * Files are created with restrictive permissions before anything is written to
 * them, so a secret is never briefly world-readable.
 */
export declare function writeCredentials(inputs: CredentialInputs, target?: CredentialTarget): WrittenCredentials;
/** Reads a file's contents, for tests and diagnostics. */
export declare function readIfPresent(path: string): string | undefined;
//# sourceMappingURL=credentials.d.ts.map