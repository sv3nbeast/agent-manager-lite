export function privateContentIssues(content, { checkDocumentReferences = false } = {}) {
  const issues = []
  // Synthetic names used by the source fixtures are allowed.
  if (/\/Users\/(?!example\/|alice\/|bob\/|Alice Smith\/)[^/\r\n]+\//.test(content)) {
    issues.push('personal machine path')
  }
  if (checkDocumentReferences && /docs\/(?:evidence\/|[A-Z][A-Z_]+\.md)/.test(content)) {
    issues.push('private document reference')
  }
  return issues
}
