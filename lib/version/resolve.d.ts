import { Constraint } from './constraint.js';
import { Version } from './version.js';
import { TerraformModule } from '../terraform/module.js';
/**
 * Choosing which version to run.
 *
 * Order matters more than any individual source. It runs from the most
 * authoritative statement of intent to the least:
 *
 *  1. the remote workspace, when the backend can tell us what it expects
 *  2. `required_version` in the configuration
 *  3. `.tfswitchrc`
 *  4. `.opentofu-version`, when OpenTofu is selected
 *  5. `.terraform-version`
 *  6. `.tool-versions`
 *  7. `TERRAFORM_VERSION` / `OPENTOFU_VERSION`
 *  8. the version that wrote the existing state
 *  9. the newest release
 *
 * The environment variable sitting seventh is deliberate and worth knowing: a
 * `required_version` in the configuration wins over it, because the
 * configuration states what the code needs while the variable states only what
 * the workflow would prefer.
 */
export interface ResolveInputs {
    /** Directory of the module being operated on. */
    modulePath: string;
    /** Repository root, used to bound the `.tool-versions` search. */
    workspaceRoot: string;
    /** Non-empty when the caller passed backend config key/values. */
    backendConfig?: string;
    /** True when OpenTofu is being used. */
    openTofu?: boolean;
}
export interface ResolveContext {
    module: TerraformModule;
    /** Every version available across the selected products. */
    versions: Version[];
    env: Record<string, string | undefined>;
    /**
     * Asks the remote workspace which version it expects. Supplied by the caller
     * so that resolution needs no network of its own.
     */
    remoteWorkspaceVersion?: () => Version | undefined;
    /**
     * Reads the version that wrote existing remote state, when the backend
     * supports being inspected that way.
     */
    remoteStateVersion?: () => Version | undefined;
    /** Constraints imposed by the backend in use. */
    backendConstraints?: () => Constraint[];
}
export interface Resolution {
    version: Version;
    /** Human-readable account of why this version was chosen. */
    reason: string;
}
export declare function resolveVersion(inputs: ResolveInputs, context: ResolveContext): Resolution | undefined;
/**
 * The candidate set for a run.
 *
 * With OpenTofu selected, Terraform is capped below 1.6.0 — the point at which
 * the projects diverged — and OpenTofu's own releases are added. Without it,
 * only Terraform is considered.
 */
export declare function candidateVersions(terraform: Version[], openTofu: Version[] | undefined): Version[];
//# sourceMappingURL=resolve.d.ts.map