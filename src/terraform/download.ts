import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as core from '@actions/core'
import * as toolCache from '@actions/tool-cache'
import { Version } from '../version/version.js'
import { executableName, releaseArch, releasePlatform } from './platform.js'
import { assertDigest, digestFor } from './verify.js'

const TERRAFORM_RELEASES = 'https://releases.hashicorp.com/terraform'
const OPENTOFU_RELEASES = 'https://github.com/opentofu/opentofu/releases/download'
const REQUEST_TIMEOUT_MS = 120_000

export class DownloadError extends Error {}


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
 * Downloads a Terraform release and returns the executable's directory.
 *
 * The chain is: fetch the published checksums, fetch the archive, verify its
 * digest against those checksums, and only then extract. A version already in
 * the tool cache short-circuits all of it.
 */
export async function acquireTerraform(version: Version): Promise<string> {
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

  const sumsText = await fetchText(`${base}/terraform_${text}_SHA256SUMS`)
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
 * OpenTofu publishes checksums as a GitHub release asset, so this mirrors the
 * Terraform path exactly.
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
export async function acquire(version: Version): Promise<string> {
  return version.product === 'OpenTofu' ? acquireOpenTofu(version) : acquireTerraform(version)
}
