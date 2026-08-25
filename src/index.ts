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

export { TfVarsError, autoTfVarsName, writeAutoTfVars } from './setup/tfvars.js'
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