import { Version, compareVersions } from './version.js';
/**
 * Terraform version constraints.
 *
 * A constraint is an operator plus a partial version: `>= 1.5`, `~> 1.5.0`,
 * `!= 1.4.2`, or a bare `1.5.7` meaning equality. Omitted components read as
 * zero when comparing.
 *
 * Two rules here are easy to get wrong and both are load-bearing:
 *
 * - **Every operator except `=` refuses pre-releases.** `>= 1.0` will not select
 *   1.6.0-rc1. A pre-release can only ever be chosen by asking for it exactly.
 * - **`~>` widens by one component from the right.** `~> 1.5.0` permits 1.5.x,
 *   `~> 1.5` permits 1.x from 1.5 up, and `~> 1` permits any major at or above 1
 *   — which is looser than the pessimistic operator implies elsewhere.
 */
export type ConstraintOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~>';
export declare class InvalidConstraint extends Error {
}
export declare class Constraint {
    readonly operator: ConstraintOperator;
    readonly major: number;
    /** Undefined when the constraint omitted it, e.g. `~> 1`. */
    readonly minor: number | undefined;
    readonly patch: number | undefined;
    readonly preRelease: string;
    constructor(constraint: string);
    toString(): string;
    /** Compares a version against this constraint's version, omissions as zero. */
    private compare;
    isAllowed(version: Version): boolean;
}
/** Keeps only the versions permitted by every constraint. */
export declare function applyConstraints(versions: Iterable<Version>, constraints: Iterable<Constraint>): Version[];
/**
 * Parses a comma-separated constraint expression.
 *
 * Unparseable clauses are dropped rather than thrown, matching how Terraform
 * tolerates expressions it cannot act on.
 */
export declare function parseConstraints(expression: string): Constraint[];
export declare function sortConstraints(constraints: Iterable<Constraint>): Constraint[];
export { compareVersions };
//# sourceMappingURL=constraint.d.ts.map