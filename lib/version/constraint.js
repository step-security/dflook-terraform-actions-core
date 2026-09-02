import { compareVersions } from './version.js';
const OPERATOR_AND_REST = /^([=!<>~]*)(.*)$/;
const PARTIAL_VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.*))?$/;
/** Ordering used when constraints are sorted, mirroring upstream. */
const OPERATOR_ORDER = ['<', '<=', '=', '~>', '>=', '>'];
export class InvalidConstraint extends Error {
}
export class Constraint {
    operator;
    major;
    /** Undefined when the constraint omitted it, e.g. `~> 1`. */
    minor;
    patch;
    preRelease;
    constructor(constraint) {
        // Whitespace is insignificant, so '>= 1.5' and '>=1.5' are the same.
        const compact = constraint.replace(/\s/g, '');
        const split = OPERATOR_AND_REST.exec(compact);
        if (!split)
            throw new InvalidConstraint(`Invalid version constraint: ${constraint}`);
        this.operator = (split[1] || '=');
        if (!OPERATOR_ORDER.includes(this.operator) && this.operator !== '!=') {
            throw new InvalidConstraint(`Invalid constraint operator: ${split[1]}`);
        }
        const parts = PARTIAL_VERSION.exec(split[2]);
        if (!parts)
            throw new InvalidConstraint(`Invalid version constraint: ${constraint}`);
        this.major = Number(parts[1]);
        this.minor = parts[2] === undefined ? undefined : Number(parts[2]);
        this.patch = parts[3] === undefined ? undefined : Number(parts[3]);
        this.preRelease = parts[4] ?? '';
    }
    toString() {
        let text = `${this.operator}${this.major}`;
        if (this.minor !== undefined)
            text += `.${this.minor}`;
        if (this.patch !== undefined)
            text += `.${this.patch}`;
        if (this.preRelease)
            text += `-${this.preRelease}`;
        return text;
    }
    /** Compares a version against this constraint's version, omissions as zero. */
    compare(version) {
        if (version.major !== this.major)
            return version.major - this.major;
        if (version.minor !== (this.minor ?? 0))
            return version.minor - (this.minor ?? 0);
        if (version.patch !== (this.patch ?? 0))
            return version.patch - (this.patch ?? 0);
        if (version.preRelease < this.preRelease)
            return -1;
        if (version.preRelease > this.preRelease)
            return 1;
        return 0;
    }
    isAllowed(version) {
        const order = this.compare(version);
        // Only an exact match may resolve to a pre-release.
        if (this.operator === '=')
            return order === 0;
        if (version.preRelease)
            return false;
        switch (this.operator) {
            case '!=':
                return order !== 0;
            case '>':
                return order > 0;
            case '>=':
                return order >= 0;
            case '<':
                return order < 0;
            case '<=':
                return order <= 0;
            case '~>':
                if (this.minor === undefined)
                    return version.major >= this.major;
                if (this.patch === undefined) {
                    return version.major === this.major && version.minor >= this.minor;
                }
                return (version.major === this.major &&
                    version.minor === this.minor &&
                    version.patch >= this.patch);
            default:
                return false;
        }
    }
}
/** Keeps only the versions permitted by every constraint. */
export function applyConstraints(versions, constraints) {
    const all = [...constraints];
    return [...versions].filter((version) => all.every((constraint) => constraint.isAllowed(version)));
}
/**
 * Parses a comma-separated constraint expression.
 *
 * Unparseable clauses are dropped rather than thrown, matching how Terraform
 * tolerates expressions it cannot act on.
 */
export function parseConstraints(expression) {
    const constraints = [];
    for (const clause of expression.split(',')) {
        if (!clause.trim())
            continue;
        try {
            constraints.push(new Constraint(clause));
        }
        catch {
            // Ignored deliberately; see the note above.
        }
    }
    return constraints;
}
export function sortConstraints(constraints) {
    return [...constraints].sort((a, b) => {
        if (a.major !== b.major)
            return a.major - b.major;
        if ((a.minor ?? 0) !== (b.minor ?? 0))
            return (a.minor ?? 0) - (b.minor ?? 0);
        if ((a.patch ?? 0) !== (b.patch ?? 0))
            return (a.patch ?? 0) - (b.patch ?? 0);
        if (a.preRelease !== b.preRelease) {
            if (a.preRelease === '')
                return 1;
            if (b.preRelease === '')
                return -1;
            return a.preRelease < b.preRelease ? -1 : 1;
        }
        return OPERATOR_ORDER.indexOf(a.operator) - OPERATOR_ORDER.indexOf(b.operator);
    });
}
export { compareVersions };
//# sourceMappingURL=constraint.js.map