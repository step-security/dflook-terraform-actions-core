import { Version } from './version.js';
import { TerraformModule } from '../terraform/module.js';
/**
 * `required_version` in the module.
 *
 * The constraint may legitimately match nothing — a configuration pinning a
 * version that no longer exists, say. That is not an error here: it means this
 * source cannot answer, and the next one gets a turn.
 */
export declare function fromRequiredVersion(module: TerraformModule, versions: Version[]): Version | undefined;
/**
 * A tfenv `.terraform-version` file (or `.opentofu-version`).
 *
 * tfenv supports more than a bare version: `latest` takes the newest release,
 * and `latest:REGEX` the newest whose version string matches. A concrete
 * version that is not in the available list is still honoured — the file is an
 * instruction, not a suggestion, and the download will report it if it does not
 * exist.
 */
export declare function parseTfenv(contents: string, versions: Version[]): Version | undefined;
export declare function fromTfenv(modulePath: string, filename: string, versions: Version[]): Version | undefined;
/** A tfswitch `.tfswitchrc` file, which holds a bare version and nothing else. */
export declare function fromTfswitch(modulePath: string): Version | undefined;
/** Reads the terraform entry out of an asdf `.tool-versions` file. */
export declare function parseToolVersions(contents: string, versions: Version[]): Version | undefined;
/**
 * An asdf `.tool-versions` file.
 *
 * asdf resolves these by walking up the directory tree, so a single file at the
 * repository root applies to every module beneath it. The walk stops at the
 * workspace root to avoid picking up a file from outside the checkout.
 */
export declare function fromAsdf(modulePath: string, workspaceRoot: string, versions: Version[]): Version | undefined;
/**
 * The `TERRAFORM_VERSION` or `OPENTOFU_VERSION` environment variable.
 *
 * These hold a *constraint*, not necessarily an exact version, so
 * `TERRAFORM_VERSION: ~> 1.5` is valid. Unlike the other constraint-based
 * sources this takes the newest match including pre-releases, which is what
 * makes `OPENTOFU_VERSION: 1.6.0-alpha3` selectable.
 */
export declare function fromEnvironment(env: Record<string, string | undefined>, versions: Version[]): {
    version?: Version;
    variable?: string;
    unmatchedConstraint?: string;
};
/**
 * The version recorded in a local `terraform.tfstate`.
 *
 * Only consulted when the state has actually been written to — `serial` is 0 for
 * a freshly initialised file, which tells us nothing about which version a real
 * apply used.
 */
export declare function fromLocalState(modulePath: string, openTofu?: boolean): Version | undefined;
/** True when a path exists, used to decide whether a source is worth reading. */
export declare function sourceExists(modulePath: string, filename: string): boolean;
//# sourceMappingURL=sources.d.ts.map