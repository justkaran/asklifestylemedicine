function enabledOnlyWhenExplicitlyTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * Stanford mode is opt-in and deliberately fail-closed. Only an explicit true
 * value may select the bounded Stanford database startup path.
 */
export function isStanfordEdition(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return enabledOnlyWhenExplicitlyTrue(env.STANFORD_EDITION);
}

/**
 * Billing is opt-in: every billing route and Stripe boot task remains disabled
 * unless the deployment explicitly sets BILLING_ENABLED=true.
 *
 * This avoids enabling billing accidentally in deployments that do not supply
 * Stripe configuration.
 */
export function isBillingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Stanford's bounded database intentionally has no Stripe mirror or billing
  // tables. A stray BILLING_ENABLED=true must never reactivate that code path.
  return (
    !isStanfordEdition(env) &&
    enabledOnlyWhenExplicitlyTrue(env.BILLING_ENABLED)
  );
}
