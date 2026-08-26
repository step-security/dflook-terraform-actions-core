/**
 * Public surface of the shared core.
 *
 * The actions build on this rather than reaching into individual modules, so the
 * internal layout can change without touching three repositories.
 */

// Version selection
export {
  Version,
  InvalidVersion,
  compareVersions,
  earliestFinalVersion,
  earliestVersion,
  latestFinalVersion,
  latestVersion,
  sortVersions,
  tryParseVersion,
} from './version/version.js'
export type { Product } from './version/version.js'

export {
  Constraint,
  InvalidConstraint,
  applyConstraints,
  parseConstraints,
  sortConstraints,
} from './version/constraint.js'
export type { ConstraintOperator } from './version/constraint.js'

export {
  fromAsdf,
  fromEnvironment,
  fromLocalState,
  fromRequiredVersion,
  fromTfenv,
  fromTfswitch,
  parseTfenv,
  parseToolVersions,
} from './version/sources.js'

export { candidateVersions, resolveVersion } from './version/resolve.js'
export type { ResolveContext, ResolveInputs, Resolution } from './version/resolve.js'

// Releases and downloading
export { ReleaseLookupError, getOpenTofuVersions, getTerraformVersions } from './terraform/releases.js'
export { DownloadError, acquire, acquireOpenTofu, acquireTerraform } from './terraform/download.js'
export {
  VerificationError,
  assertDigest,
  digestFor,
  sha256OfFile,
} from './terraform/verify.js'
export {
  UnsupportedPlatform,
  executableName,
  releaseArch,
  releasePlatform,
} from './terraform/platform.js'

// Reading the module
export {
  filesInModule,
  getBackendType,
  getRequiredVersionExpression,
  getSensitiveVariables,
  getVersionConstraints,
  loadModule,
  stripComments,
} from './terraform/module.js'
export type { TerraformModule } from './terraform/module.js'

// Running the tool
export { runTool, splitList } from './terraform/exec.js'
export type { RunOptions, RunResult } from './terraform/exec.js'
export {
  InitError,
  backendConfigArgs,
  initBackendWorkspace,
  selectWorkspace,
} from './terraform/init.js'
export type { BackendConfigInputs, InitOptions, InitResult } from './terraform/init.js'
export {
  PLAN_CHANGES,
  PLAN_ERROR,
  PLAN_NO_CHANGES,
  PlanArgsError,
  cannotSavePlan,
  planArgs,
  runPlan,
} from './terraform/plan.js'
export type { PlanArgsInputs, PlanOptions, PlanResult } from './terraform/plan.js'

export {
  compactPlan,
  runApply,
  savedPlanHasNoChanges,
} from './terraform/apply.js'
export type { ApplyFailure, ApplyOptions, ApplyResult } from './terraform/apply.js'
export { getLockInfo, isStateLocked } from './terraform/lock.js'
export type { LockInfo } from './terraform/lock.js'
export {
  OutputParseError,
  flattenOutputs,
  outputCommands,
  parseOutputs,
  publishOutputs,
} from './terraform/outputs.js'
export type { OutputCommand, TerraformOutput, TerraformOutputs } from './terraform/outputs.js'

// Redacting sensitive values from output
export {
  DEFAULT_RESOURCES_PATTERN,
  DEFAULT_VALUES_PATTERN,
  Masker,
  maskOptionsFromEnv,
  maskOutput,
} from './terraform/mask.js'
export type { MaskOptions } from './terraform/mask.js'

// Preparing the environment
export {
  formatCloudTokens,
  formatHttpCredentials,
  renderNetrc,
  renderTerraformrc,
  writeCredentials,
} from './setup/credentials.js'
export type {
  CredentialInputs,
  CredentialTarget,
  WrittenCredentials,
} from './setup/credentials.js'

export {
  TfVarsError,
  autoTfVarsName,
  deleteAutoTfVars,
  writeAutoTfVars,
} from './setup/tfvars.js'
export type { TfVarsInputs, WrittenTfVars } from './setup/tfvars.js'

export { PreRunError, runPreRunCommands } from './setup/pre-run.js'
export type { PreRunOptions } from './setup/pre-run.js'

// Talking to the runner
export {
  commandsStopped,
  debug,
  endGroup,
  error,
  info,
  resumeWorkflowCommands,
  startGroup,
  stopWorkflowCommands,
  warning,
  withWorkflowCommandsStopped,
} from './actions/workflow.js'
// Deciding whether a plan was approved
export {
  commentHash,
  normalisePlan,
  planHash,
  planOutHash,
  planTextMatches,
  removeUnchangedAttributes,
  removeWarnings,
} from './comment/hash.js'
export {
  collapseThreshold,
  formatHeaders,
  matchingHeaders,
  parseComment,
  parseHeaders,
  renderComment,
} from './comment/comment.js'
export type { CommentHeaders, ParsedComment, RenderOptions } from './comment/comment.js'
export {
  completeBackendConfig,
  readBackendConfigFiles,
  readBackendConfigInput,
  readModuleBackendConfig,
} from './comment/backend-config.js'
export type { BackendConfig, CompleteConfigInputs } from './comment/backend-config.js'
export { backendFingerprint, canonicalJson } from './comment/backend-fingerprint.js'
export type { FingerprintOptions } from './comment/backend-fingerprint.js'
export {
  GitHubClient,
  GitHubError,
  WorkflowError,
  findPullRequest,
  nextLink,
} from './comment/github.js'
export type {
  EventContext,
  GitHubClientOptions,
  GitHubComment,
  PullRequest,
} from './comment/github.js'
export {
  findPlanComment,
  isApproved,
  isBinaryPlanApproved,
  planCommentHeaders,
  planModifierHash,
  writePlanComment,
} from './comment/plan-comment.js'
export type {
  FoundComment,
  PlanIdentity,
  PlanModifier,
  UpdateOptions,
} from './comment/plan-comment.js'
