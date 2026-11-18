import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { applyConstraints, parseConstraints } from './constraint.js';
import { Version, latestFinalVersion, latestVersion } from './version.js';
import { getVersionConstraints } from '../terraform/module.js';
/**
 * The individual places a Terraform version can be declared.
 *
 * Each reader answers "does this source name a version, and if so which one",
 * returning undefined when it has nothing to say. A source that is present but
 * unusable also returns undefined rather than failing, so an unreadable
 * `.tool-versions` never stops a run that could have resolved a version
 * elsewhere.
 *
 * The order these are consulted in lives in `resolve.ts`, not here.
 */
/** Reads a file, returning undefined rather than throwing. */
function tryRead(path) {
    try {
        if (!statSync(path).isFile())
            return undefined;
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
/**
 * `required_version` in the module.
 *
 * The constraint may legitimately match nothing — a configuration pinning a
 * version that no longer exists, say. That is not an error here: it means this
 * source cannot answer, and the next one gets a turn.
 */
export function fromRequiredVersion(module, versions) {
    const constraints = getVersionConstraints(module);
    if (!constraints)
        return undefined;
    return latestFinalVersion(applyConstraints(versions, constraints));
}
/**
 * A tfenv `.terraform-version` file (or `.opentofu-version`).
 *
 * tfenv supports more than a bare version: `latest` takes the newest release,
 * and `latest:REGEX` the newest whose version string matches. A concrete
 * version that is not in the available list is still honoured — the file is an
 * instruction, not a suggestion, and the download will report it if it does not
 * exist.
 */
export function parseTfenv(contents, versions) {
    const requested = contents.trim();
    if (!requested)
        return undefined;
    if (requested === 'latest') {
        return latestFinalVersion(versions);
    }
    if (requested.startsWith('latest:')) {
        const pattern = requested.slice('latest:'.length);
        let expression;
        try {
            expression = new RegExp(pattern);
        }
        catch {
            return undefined;
        }
        const matched = versions.filter((version) => expression.test(version.toString()));
        return matched.length ? latestVersion(matched) : undefined;
    }
    const known = versions.find((version) => version.toString() === requested);
    if (known)
        return known;
    try {
        return new Version(requested);
    }
    catch {
        return undefined;
    }
}
export function fromTfenv(modulePath, filename, versions) {
    const contents = tryRead(join(modulePath, filename));
    return contents === undefined ? undefined : parseTfenv(contents, versions);
}
/** A tfswitch `.tfswitchrc` file, which holds a bare version and nothing else. */
export function fromTfswitch(modulePath) {
    const contents = tryRead(join(modulePath, '.tfswitchrc'));
    if (contents === undefined)
        return undefined;
    try {
        return new Version(contents.trim());
    }
    catch {
        return undefined;
    }
}
/** Reads the terraform entry out of an asdf `.tool-versions` file. */
export function parseToolVersions(contents, versions) {
    for (const line of contents.split('\n')) {
        const match = /^\s*terraform\s+([^\s#]+)/.exec(line.trim());
        if (!match)
            continue;
        if (match[1] === 'latest')
            return latestFinalVersion(versions);
        try {
            return new Version(match[1]);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/**
 * An asdf `.tool-versions` file.
 *
 * asdf resolves these by walking up the directory tree, so a single file at the
 * repository root applies to every module beneath it. The walk stops at the
 * workspace root to avoid picking up a file from outside the checkout.
 */
export function fromAsdf(modulePath, workspaceRoot, versions) {
    let directory = resolve(modulePath);
    const stopAt = resolve(workspaceRoot);
    for (;;) {
        const contents = tryRead(join(directory, '.tool-versions'));
        if (contents !== undefined) {
            const version = parseToolVersions(contents, versions);
            if (version)
                return version;
        }
        if (directory === stopAt)
            break;
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    return undefined;
}
/**
 * The `TERRAFORM_VERSION` or `OPENTOFU_VERSION` environment variable.
 *
 * These hold a *constraint*, not necessarily an exact version, so
 * `TERRAFORM_VERSION: ~> 1.5` is valid. Unlike the other constraint-based
 * sources this takes the newest match including pre-releases, which is what
 * makes `OPENTOFU_VERSION: 1.6.0-alpha3` selectable.
 */
export function fromEnvironment(env, versions) {
    const variable = env.TERRAFORM_VERSION !== undefined
        ? 'TERRAFORM_VERSION'
        : env.OPENTOFU_VERSION !== undefined
            ? 'OPENTOFU_VERSION'
            : undefined;
    if (!variable)
        return {};
    const expression = env[variable] ?? '';
    let constraints;
    try {
        constraints = parseConstraints(expression);
    }
    catch {
        return { variable };
    }
    if (!constraints.length)
        return { variable };
    const allowed = applyConstraints(versions, constraints);
    if (!allowed.length)
        return { variable, unmatchedConstraint: expression };
    return { version: latestVersion(allowed), variable };
}
/**
 * The version recorded in a local `terraform.tfstate`.
 *
 * Only consulted when the state has actually been written to — `serial` is 0 for
 * a freshly initialised file, which tells us nothing about which version a real
 * apply used.
 */
export function fromLocalState(modulePath, openTofu = false) {
    const contents = tryRead(join(modulePath, 'terraform.tfstate'));
    if (contents === undefined)
        return undefined;
    try {
        const state = JSON.parse(contents);
        if (!state.serial || state.serial <= 0)
            return undefined;
        if (!state.terraform_version)
            return undefined;
        // OpenTofu writes Terraform-compatible state, so the product comes from
        // what we were asked to run rather than from the file.
        return new Version(state.terraform_version, openTofu ? 'OpenTofu' : 'Terraform');
    }
    catch {
        return undefined;
    }
}
/** True when a path exists, used to decide whether a source is worth reading. */
export function sourceExists(modulePath, filename) {
    return existsSync(join(modulePath, filename));
}
//# sourceMappingURL=sources.js.map