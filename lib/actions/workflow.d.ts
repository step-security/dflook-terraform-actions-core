export declare function info(message: string): void;
export declare function debug(message: string): void;
export declare function warning(message: string): void;
export declare function error(message: string, file?: string): void;
export declare function startGroup(title: string): void;
export declare function endGroup(): void;
/**
 * Stops the runner interpreting workflow commands until resumed.
 *
 * Needed whenever output we do not control is echoed to stdout. Without it, a
 * Terraform resource name or a user-supplied script could print
 * `::set-output::` or `::add-mask::` and have the runner act on it — output
 * becoming instruction. Everything between the two calls is treated as plain
 * text.
 */
export declare function stopWorkflowCommands(): void;
export declare function resumeWorkflowCommands(): void;
/** Runs a function with workflow command interpretation suspended. */
export declare function withWorkflowCommandsStopped<T>(action: () => Promise<T>): Promise<T>;
/** True when commands are currently suspended. Exposed for tests. */
export declare function commandsStopped(): boolean;
//# sourceMappingURL=workflow.d.ts.map