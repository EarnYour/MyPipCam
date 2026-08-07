import {
  extensionInstallChannel,
  type ExtensionInstallChannel,
} from './driveConfig'

const GITHUB_NEW_ISSUE =
  'https://github.com/EarnYour/MyPipCam/issues/new'
const SUPPORT_EMAIL = 'steven@earnyour.com'

export type BugReportDiagnostics = {
  version: string
  extensionId: string
  channel: ExtensionInstallChannel
  channelLabel: string
  userAgent: string
}

function channelLabel(channel: ExtensionInstallChannel): string {
  switch (channel) {
    case 'store':
      return 'Chrome Web Store'
    case 'unpacked-stable':
      return 'Local (stable unpacked ID)'
    default:
      return 'Local (dev / other)'
  }
}

function shortUserAgent(ua: string): string {
  const trimmed = ua.trim()
  if (trimmed.length <= 160) return trimmed
  return `${trimmed.slice(0, 157)}…`
}

/** Safe diagnostics only — never include API keys or OAuth/Drive tokens. */
export function collectBugReportDiagnostics(): BugReportDiagnostics {
  let version = 'unknown'
  let extensionId = 'unknown'
  try {
    version = chrome.runtime.getManifest().version || version
  } catch {
    /* ignore */
  }
  try {
    extensionId = chrome.runtime.id || extensionId
  } catch {
    /* ignore */
  }
  const channel = extensionInstallChannel(extensionId)
  const ua =
    typeof navigator !== 'undefined' && navigator.userAgent
      ? navigator.userAgent
      : 'unknown'

  return {
    version,
    extensionId,
    channel,
    channelLabel: channelLabel(channel),
    userAgent: shortUserAgent(ua),
  }
}

function diagnosticsBlock(d: BugReportDiagnostics): string {
  return [
    '### Environment',
    `- Extension version: ${d.version}`,
    `- Extension ID: ${d.extensionId}`,
    `- Install channel: ${d.channelLabel} (\`${d.channel}\`)`,
    `- User agent: ${d.userAgent}`,
    '',
    '### What happened?',
    '',
    '<!-- Describe the bug. Steps to reproduce help a lot. -->',
    '',
    '### Expected',
    '',
    '',
  ].join('\n')
}

/** Prefills a public GitHub issue (preferred for store users). */
export function bugReportGitHubUrl(d = collectBugReportDiagnostics()): string {
  const title = `[Bug] MyPipCam ${d.version} (${d.channelLabel})`
  const body = [
    'Found a bug in MyPipCam.',
    '',
    diagnosticsBlock(d),
  ].join('\n')
  const params = new URLSearchParams({ title, body })
  return `${GITHUB_NEW_ISSUE}?${params.toString()}`
}

/** Optional private email path with the same diagnostics. */
export function bugReportMailtoUrl(d = collectBugReportDiagnostics()): string {
  const subject = `MyPipCam bug report — v${d.version}`
  const body = [
    'Found a bug in MyPipCam.',
    '',
    diagnosticsBlock(d).replace(/^### /gm, ''),
  ].join('\n')
  return `mailto:${SUPPORT_EMAIL}?${new URLSearchParams({
    subject,
    body,
  }).toString()}`
}
