import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as core from '@actions/core'
import { exec } from '@actions/exec'
import * as toolCache from '@actions/tool-cache'
import { Version } from '../version/version'
import {
  HASHICORP_KEY_SUFFIX,
  HASHICORP_SIGNING_KEY,
  VerificationError,
  assertDigest,
  digestFor,
} from './verify'

const TERRAFORM_RELEASES = 'https://releases.hashicorp.com/terraform'
const OPENTOFU_RELEASES = 'https://github.com/opentofu/opentofu/releases/download'
const REQUEST_TIMEOUT_MS = 120_000

export class DownloadError extends Error {}

/** Release-channel name for the running operating system. */
export function releasePlatform(): string {
  const platforms: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' }
  const platform = platforms[process.platform]
  if (!platform) throw new DownloadError(`No release is published for '${process.platform}'`)
  return platform
}

/** Release-channel name for the running architecture. */
export function releaseArch(): string {
  const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }
  const arch = architectures[process.arch]
  if (!arch) throw new DownloadError(`No release is published for '${process.arch}'`)
  return arch
}

function executableName(): string {
  return process.platform === 'win32' ? 'terraform.exe' : 'terraform'
}

async function fetchTo(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) {
    throw new DownloadError(
      response.status === 404
        ? `${url} does not exist — is that version published for this platform?`
        : `GET ${url} returned ${response.status}`
    )
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) {
    throw new DownloadError(`GET ${url} returned ${response.status}`)
  }
  return response.text()
}

/**
 * Confirms the checksums file was signed by HashiCorp.
 *
 * Without this the checksum comparison proves only that the archive matches a
 * file fetched from the same place — anyone able to serve a bad archive could
 * serve sums to match it. The signature is what ties the download back to
 * HashiCorp.
 *
 * gpg is present on GitHub-hosted runners. When it is missing the run stops
 * rather than silently downgrading to an unsigned check.
 */
async function verifySumsSignature(sumsPath: string, signaturePath: string): Promise<void> {
  const exitCode = await exec(
    'gpg',
    ['--assert-signer', HASHICORP_SIGNING_KEY, '--verify', signaturePath, sumsPath],
    { ignoreReturnCode: true, silent: true }
  )

  if (exitCode !== 0) {
    throw new VerificationError(
      'Could not verify the signature on the checksums file. The download was not used.'
    )
  }
}

export interface AcquireOptions {
  /** Skips signature verification. Only for platforms where gpg is unavailable. */
  skipSignatureCheck?: boolean
}

/**
 * Downloads a Terraform release and returns the executable's directory.
 *
 * The chain is: fetch the signature and checksums, verify the signature, fetch
 * the archive, verify its digest against the now-trusted checksums, and only
 * then extract. A version already in the tool cache short-circuits all of it.
 */
export async function acquireTerraform(
  version: Version,
  options: AcquireOptions = {}
): Promise<string> {
  const platform = releasePlatform()
  const arch = releaseArch()
  const text = version.toString()

  const cached = toolCache.find('terraform', text, arch)
  if (cached) {
    core.info(`Using cached Terraform ${text}`)
    return join(cached, executableName())
  }

  const archiveName = `terraform_${text}_${platform}_${arch}.zip`
  const base = `${TERRAFORM_RELEASES}/${text}`

  const workDir = join(process.env.RUNNER_TEMP || '/tmp', `terraform-${text}-${process.pid}`)
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })

  const sumsPath = join(workDir, `terraform_${text}_SHA256SUMS`)
  const sumsText = await fetchText(`${base}/terraform_${text}_SHA256SUMS`)
  writeFileSync(sumsPath, sumsText)

  if (options.skipSignatureCheck) {
    core.warning('Skipping signature verification of the Terraform checksums file')
  } else {
    const signaturePath = `${sumsPath}.${HASHICORP_KEY_SUFFIX}.sig`
    await fetchTo(`${base}/terraform_${text}_SHA256SUMS.${HASHICORP_KEY_SUFFIX}.sig`, signaturePath)
    await verifySumsSignature(sumsPath, signaturePath)
    core.info('Verified the checksums file signature')
  }

  const expected = digestFor(sumsText, archiveName)

  core.info(`Downloading Terraform ${text} (${platform}/${arch})`)
  const archivePath = join(workDir, archiveName)
  await fetchTo(`${base}/${archiveName}`, archivePath)

  // Verified before extraction: unpacking is what would place untrusted code on
  // the runner.
  assertDigest(archivePath, archiveName, expected)
  core.info(`Verified ${archiveName} against the published checksum`)

  const extracted = await toolCache.extractZip(archivePath, join(workDir, 'extracted'))
  const installed = await toolCache.cacheDir(extracted, 'terraform', text, arch)
  return join(installed, executableName())
}

/**
 * Downloads an OpenTofu release and returns the executable.
 *
 * OpenTofu publishes checksums as a GitHub release asset. There is no
 * HashiCorp-equivalent signing key here, so verification is the digest alone.
 */
export async function acquireOpenTofu(version: Version): Promise<string> {
  const platform = releasePlatform()
  const arch = releaseArch()
  const text = version.toString()

  const cached = toolCache.find('opentofu', text, arch)
  if (cached) {
    core.info(`Using cached OpenTofu ${text}`)
    return join(cached, executableName())
  }

  const archiveName = `tofu_${text}_${platform}_${arch}.zip`
  const base = `${OPENTOFU_RELEASES}/v${text}`

  const workDir = join(process.env.RUNNER_TEMP || '/tmp', `opentofu-${text}-${process.pid}`)
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })

  const sumsText = await fetchText(`${base}/tofu_${text}_SHA256SUMS`)
  const expected = digestFor(sumsText, archiveName)

  core.info(`Downloading OpenTofu ${text} (${platform}/${arch})`)
  const archivePath = join(workDir, archiveName)
  await fetchTo(`${base}/${archiveName}`, archivePath)

  assertDigest(archivePath, archiveName, expected)
  core.info(`Verified ${archiveName} against the published checksum`)

  const extracted = await toolCache.extractZip(archivePath, join(workDir, 'extracted'))
  const installed = await toolCache.cacheDir(extracted, 'opentofu', text, arch)
  return join(installed, executableName())
}

/** Downloads whichever product the version belongs to. */
export async function acquire(version: Version, options: AcquireOptions = {}): Promise<string> {
  return version.product === 'OpenTofu'
    ? acquireOpenTofu(version)
    : acquireTerraform(version, options)
}
