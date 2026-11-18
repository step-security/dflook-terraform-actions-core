import { Constraint } from '../version/constraint.js';
/**
 * Reading the few facts we need out of a Terraform module.
 *
 * Only four things are ever needed: the `required_version` constraint, the
 * backend type, the remote/cloud backend configuration, and which variables are
 * marked sensitive. A full HCL parser is not required for that, so this reads
 * the specific constructs instead.
 *
 * Comments are stripped before anything is matched. That matters more than it
 * sounds: a commented-out backend block is extremely common while migrating
 * state, and a naive match would pick it up and choose the wrong backend.
 */
export interface TerraformModule {
    /** Concatenated source of every file in the module, comments removed. */
    readonly body: string;
    /** Files that were read, in the order they were merged. */
    readonly files: readonly string[];
}
/**
 * Removes comments while preserving string literals.
 *
 * A `#` inside a quoted string is not a comment, so the scan tracks whether it
 * is inside quotes rather than matching line-wise.
 */
export declare function stripComments(source: string): string;
/**
 * Files that make up the module.
 *
 * With OpenTofu selected, a `.tofu` file replaces the `.tf` file of the same
 * name — that is how a configuration provides tofu-specific overrides.
 */
export declare function filesInModule(path: string, openTofu?: boolean): string[];
/** Reads and merges every file in the module. Unreadable files are skipped. */
export declare function loadModule(path: string, openTofu?: boolean): TerraformModule;
/** The `required_version` constraint expression, if the module declares one. */
export declare function getRequiredVersionExpression(module: TerraformModule): string | undefined;
/** The `required_version` constraint, parsed. Undefined when absent. */
export declare function getVersionConstraints(module: TerraformModule): Constraint[] | undefined;
/**
 * The backend the module uses.
 *
 * A `cloud` block counts as the `cloud` backend. With neither a backend block
 * nor a cloud block, Terraform defaults to local state.
 */
export declare function getBackendType(module: TerraformModule): string;
/**
 * Names of variables declared `sensitive = true`.
 *
 * Both `variable "name" {` and the unquoted `variable name {` are recognised —
 * Terraform accepts the latter and real configurations use it.
 */
export declare function getSensitiveVariables(module: TerraformModule): string[];
//# sourceMappingURL=module.d.ts.map