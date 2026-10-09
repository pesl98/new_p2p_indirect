/** Default mail provider. Nothing is sent. The buyer copies the link. */
export async function sendWithNone() {
  return { status: 'skipped', provider: 'none' };
}
