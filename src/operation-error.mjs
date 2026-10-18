/** Public diagnostics use fixed vocabulary, never raw errors, URLs or server bodies. */
export const STAGES = ['collect', 'encrypt', 'mkdir', 'upload', 'download', 'verify', 'list', 'cleanup']
export const REASONS = ['failed', 'http', 'network', 'tls', 'timeout', 'cancelled', 'size', 'invalid-data']
export class OperationError extends Error {
  constructor(message, { stage, reason = 'failed', status, remoteMayExist } = {}) {
    super(message)
    this.stage = stage; this.reason = reason; this.status = status; this.remoteMayExist = remoteMayExist
  }
}
export function diagnostic(error) {
  if (!(error instanceof OperationError) || !STAGES.includes(error.stage) || !REASONS.includes(error.reason)) return undefined
  return { stage: error.stage, reason: error.reason,
    ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
    ...(typeof error.remoteMayExist === 'boolean' ? { remoteMayExist: error.remoteMayExist } : {}) }
}
export function atStage(error, stage, remoteMayExist) {
  const result = error instanceof OperationError ? error : new OperationError(`Snapshot ${stage} failed`, { stage })
  result.remoteMayExist = remoteMayExist
  return result
}
