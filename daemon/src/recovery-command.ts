const recoveryPage = (pageName: string) =>
  pageName.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120).replace(/'/g, "''");

export function observeRecoveryCommand(pageName: string): string {
  return `dev-browser observe --page '${recoveryPage(pageName)}' --delta`;
}
