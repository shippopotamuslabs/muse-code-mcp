/** Methods whose params can carry credentials. Refused before any frame is written. */
export function credentialMethod(method: string): boolean {
  const name = method.toLowerCase();
  return (
    name.startsWith("account/") ||
    name.startsWith("mcpserver/oauth") ||
    name.includes("login") ||
    name.includes("logout")
  );
}
