/**
 * Validates extra CLI arguments against a provider's allowlist.
 *
 * Each element in `args` must start with one of the `allowed` prefixes
 * (e.g. "--verbose" allows "--verbose" as-is and "--verbose=3").
 */
export function validateExtraArgs(
  args: string[],
  allowed: string[],
  options?: { skipValidation?: boolean },
): { valid: boolean; invalid: string[] } {
  if (options?.skipValidation) {
    return { valid: true, invalid: [] };
  }
  const invalid: string[] = [];

  for (const arg of args) {
    const isAllowed = allowed.some(
      (prefix) => arg === prefix || arg.startsWith(`${prefix}=`),
    );
    if (!isAllowed) {
      invalid.push(arg);
    }
  }

  return { valid: invalid.length === 0, invalid };
}
