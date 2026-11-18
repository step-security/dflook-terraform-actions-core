/**
 * Running the caller's own setup commands before Terraform.
 *
 * `TERRAFORM_PRE_RUN` exists for things that have to happen inside the job but
 * outside Terraform — installing a provider plugin from a private registry,
 * fetching a certificate, configuring a proxy.
 *
 * The script runs with `-x` so each command appears in the log, and with `-e`
 * and `-o pipefail` so a failure stops the run rather than proceeding into
 * Terraform with a half-finished environment.
 */
export declare class PreRunError extends Error {
}
export interface PreRunOptions {
    /** Directory to write the script into. Defaults to a fresh temp directory. */
    scriptDir?: string;
    /** Interpreter. Defaults to bash. */
    shell?: string;
}
/**
 * Executes `TERRAFORM_PRE_RUN`, if set.
 *
 * Workflow commands are suspended for the duration. The script's output is
 * entirely under the caller's control, and without suspending them a line of
 * output could masquerade as an instruction to the runner — setting an output,
 * adding a mask, or exporting an environment variable. Suspending makes it plain
 * text.
 */
export declare function runPreRunCommands(script: string | undefined, options?: PreRunOptions): Promise<boolean>;
//# sourceMappingURL=pre-run.d.ts.map