import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { parseConstraints } from '../version/constraint.js';
/**
 * Removes comments while preserving string literals.
 *
 * A `#` inside a quoted string is not a comment, so the scan tracks whether it
 * is inside quotes rather than matching line-wise.
 */
export function stripComments(source) {
    let output = '';
    let index = 0;
    let inString;
    let inHeredoc;
    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];
        if (inHeredoc) {
            // Heredoc bodies are copied verbatim until the terminator on its own line.
            const lineEnd = source.indexOf('\n', index);
            const line = source.slice(index, lineEnd === -1 ? undefined : lineEnd);
            if (line.trim() === inHeredoc)
                inHeredoc = undefined;
            output += line + (lineEnd === -1 ? '' : '\n');
            index = lineEnd === -1 ? source.length : lineEnd + 1;
            continue;
        }
        if (inString) {
            output += char;
            if (char === '\\') {
                output += next ?? '';
                index += 2;
                continue;
            }
            if (char === inString)
                inString = undefined;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = char;
            output += char;
            index += 1;
            continue;
        }
        const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(index));
        if (heredoc) {
            inHeredoc = heredoc[1];
            output += heredoc[0];
            index += heredoc[0].length;
            continue;
        }
        if (char === '#' || (char === '/' && next === '/')) {
            const lineEnd = source.indexOf('\n', index);
            if (lineEnd === -1)
                break;
            output += '\n';
            index = lineEnd + 1;
            continue;
        }
        if (char === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 2;
            output += ' ';
            continue;
        }
        output += char;
        index += 1;
    }
    return output;
}
/**
 * Files that make up the module.
 *
 * With OpenTofu selected, a `.tofu` file replaces the `.tf` file of the same
 * name — that is how a configuration provides tofu-specific overrides.
 */
export function filesInModule(path, openTofu = false) {
    let entries;
    try {
        entries = readdirSync(path).sort();
    }
    catch {
        return [];
    }
    if (!openTofu) {
        return entries.filter((name) => extname(name) === '.tf').map((name) => join(path, name));
    }
    const chosen = new Map();
    for (const name of entries) {
        const extension = extname(name);
        const stem = name.slice(0, name.length - extension.length);
        if (extension === '.tf' && !chosen.has(stem))
            chosen.set(stem, join(path, name));
        else if (extension === '.tofu')
            chosen.set(stem, join(path, name));
    }
    return [...chosen.values()];
}
/** Reads and merges every file in the module. Unreadable files are skipped. */
export function loadModule(path, openTofu = false) {
    const files = [];
    const bodies = [];
    for (const file of filesInModule(path, openTofu)) {
        try {
            if (!statSync(file).isFile())
                continue;
            bodies.push(stripComments(readFileSync(file, 'utf8')));
            files.push(file);
        }
        catch {
            // A file that cannot be read cannot contribute; Terraform will complain
            // about it in its own time.
        }
    }
    return { body: bodies.join('\n'), files };
}
/** The `required_version` constraint expression, if the module declares one. */
export function getRequiredVersionExpression(module) {
    const match = /required_version\s*=\s*"([^"]+)"/.exec(module.body);
    return match?.[1];
}
/** The `required_version` constraint, parsed. Undefined when absent. */
export function getVersionConstraints(module) {
    const expression = getRequiredVersionExpression(module);
    if (!expression)
        return undefined;
    const constraints = parseConstraints(expression);
    return constraints.length ? constraints : undefined;
}
/**
 * The backend the module uses.
 *
 * A `cloud` block counts as the `cloud` backend. With neither a backend block
 * nor a cloud block, Terraform defaults to local state.
 */
export function getBackendType(module) {
    const quoted = /backend\s*"([^"]+)"/.exec(module.body);
    if (quoted)
        return quoted[1];
    const bare = /backend\s+([A-Za-z0-9_-]+)\s*\{/.exec(module.body);
    if (bare)
        return bare[1].trim();
    if (/\bcloud\s*\{/.test(module.body))
        return 'cloud';
    return 'local';
}
/**
 * Names of variables declared `sensitive = true`.
 *
 * Both `variable "name" {` and the unquoted `variable name {` are recognised —
 * Terraform accepts the latter and real configurations use it.
 */
export function getSensitiveVariables(module) {
    const names = [];
    const blocks = module.body.matchAll(/variable\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*\{/g);
    for (const block of blocks) {
        const name = block[1] ?? block[2];
        const start = (block.index ?? 0) + block[0].length;
        // Scan to the matching brace so a nested block cannot leak into the next
        // variable's body.
        let depth = 1;
        let index = start;
        while (index < module.body.length && depth > 0) {
            if (module.body[index] === '{')
                depth += 1;
            else if (module.body[index] === '}')
                depth -= 1;
            index += 1;
        }
        const body = module.body.slice(start, index);
        if (/sensitive\s*=\s*"?true"?/i.test(body))
            names.push(name);
    }
    return names;
}
//# sourceMappingURL=module.js.map