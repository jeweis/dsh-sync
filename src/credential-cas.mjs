/** Optional extension seam; the ordinary Harness reference API remains unmodified. */
export const REFERENCE_CAS = Symbol.for('dsh-config-vault.reference-cas.v1')
export function referenceCAS(credentials, ref) {
  const capability = credentials?.[REFERENCE_CAS]
  return capability?.version === 1 && typeof capability.manages === 'function' && capability.manages(ref) && typeof capability.snapshot === 'function' && typeof capability.compareAndSet === 'function' ? capability : null
}
