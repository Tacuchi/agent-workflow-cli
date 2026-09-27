/** The plan's operative handoff, including legacy `## Handoff` spellings. */
export function isPlanHandoffHeading(title: string): boolean {
  return /^(?:handoff\b.*|operational handoff)$/i.test(title.trim());
}
