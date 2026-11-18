export declare class TfVarsError extends Error {
}
export interface TfVarsInputs {
    /** Newline- or comma-separated paths, relative to the workspace. */
    varFile?: string;
    /** Literal tfvars content. */
    variables?: string;
}
export interface WrittenTfVars {
    /** Files created inside the module directory. */
    created: string[];
}
/**
 * Name for the nth generated file.
 *
 * A `.json` var file keeps JSON syntax, so it has to become
 * `.auto.tfvars.json`; anything else becomes `.auto.tfvars`. Getting this wrong
 * makes Terraform try to parse JSON as HCL.
 */
export declare function autoTfVarsName(counter: number, sourceName?: string): string;
/**
 * Copies var files and the variables input into the module directory.
 *
 * A missing var file is fatal: continuing would apply a plan built without
 * values the caller clearly intended to supply.
 */
export declare function writeAutoTfVars(inputs: TfVarsInputs, modulePath: string, workspaceRoot?: string): WrittenTfVars;
//# sourceMappingURL=tfvars.d.ts.map