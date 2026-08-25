import { Constraint, applyConstraints } from './constraint.js';
import { fromAsdf, fromEnvironment, fromLocalState, fromRequiredVersion, fromTfenv, fromTfswitch, } from './sources.js';
import { latestFinalVersion } from './version.js';
import { getBackendType } from '../terraform/module.js';
import { releaseArch } from '../terraform/platform.js';
/** Versions whose architecture support rules out earlier releases. */
const ARM64_SUPPORTED_FROM = '0.13.5';
/** Backend config as `key=value` pairs first became available here. */
const BACKEND_KEY_VALUE_FROM = '0.9.1';
export function resolveVersion(inputs, context) {
    const { modulePath, workspaceRoot, openTofu = false } = inputs;
    const { module, env } = context;
    let versions = context.versions;
    const remote = context.remoteWorkspaceVersion?.();
    if (remote) {
        return { version: remote, reason: `the remote workspace is set to ${remote}` };
    }
    const required = fromRequiredVersion(module, versions);
    if (required) {
        return {
            version: required,
            reason: `it is the newest ${required.product} matching the required_version constraints`,
        };
    }
    const tfswitch = fromTfswitch(modulePath);
    if (tfswitch) {
        return { version: tfswitch, reason: 'it is specified in .tfswitchrc' };
    }
    if (openTofu) {
        const tofuFile = fromTfenv(modulePath, '.opentofu-version', versions);
        if (tofuFile) {
            return { version: tofuFile, reason: 'it is specified in .opentofu-version' };
        }
    }
    const tfenv = fromTfenv(modulePath, '.terraform-version', versions);
    if (tfenv) {
        return { version: tfenv, reason: 'it is specified in .terraform-version' };
    }
    const asdf = fromAsdf(modulePath, workspaceRoot, versions);
    if (asdf) {
        return { version: asdf, reason: 'it is specified in .tool-versions' };
    }
    const environment = fromEnvironment(env, versions);
    if (environment.version) {
        return {
            version: environment.version,
            reason: `it is the newest ${environment.version.product} matching ${environment.variable}`,
        };
    }
    // Passing backend config as key/value pairs requires a version that supports
    // the flag, so asking for it rules out anything older.
    if (inputs.backendConfig?.trim()) {
        versions = applyConstraints(versions, [new Constraint(`>=${BACKEND_KEY_VALUE_FROM}`)]);
    }
    const backendConstraints = context.backendConstraints?.() ?? [];
    if (backendConstraints.length) {
        versions = applyConstraints(versions, backendConstraints);
    }
    const backend = getBackendType(module);
    if (backend === 'local') {
        const local = fromLocalState(modulePath, openTofu);
        if (local) {
            return { version: local, reason: 'it wrote the existing local terraform.tfstate' };
        }
    }
    if (releaseArch() === 'arm64') {
        versions = applyConstraints(versions, [new Constraint(`>=${ARM64_SUPPORTED_FROM}`)]);
    }
    // remote and cloud backends are asked directly, above; local state has already
    // been read. Anything else may have inspectable state.
    if (!['remote', 'cloud', 'local'].includes(backend)) {
        const remoteState = context.remoteStateVersion?.();
        if (remoteState) {
            return { version: remoteState, reason: 'it wrote the existing remote state' };
        }
    }
    const latest = latestFinalVersion(versions);
    if (!latest)
        return undefined;
    return { version: latest, reason: 'no version was specified, so the newest release was used' };
}
/**
 * The candidate set for a run.
 *
 * With OpenTofu selected, Terraform is capped below 1.6.0 — the point at which
 * the projects diverged — and OpenTofu's own releases are added. Without it,
 * only Terraform is considered.
 */
export function candidateVersions(terraform, openTofu) {
    if (!openTofu)
        return terraform;
    const capped = applyConstraints(terraform, [new Constraint('<1.6.0')]);
    return [...capped, ...openTofu];
}
//# sourceMappingURL=resolve.js.map