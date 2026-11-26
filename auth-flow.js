/** Account decisions happen only after the OAuth provider verifies the user's identity. */
export function accountFlowDecision({ exists, mode }) {
  if (exists) return 'sign-in';
  return mode === 'signup' ? 'create' : 'signup-required';
}
