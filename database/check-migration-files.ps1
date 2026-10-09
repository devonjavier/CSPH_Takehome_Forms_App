param(
    [Parameter(Mandatory)]
    [string]$BaseRevision,
    [string]$HeadRevision = 'HEAD',
    [string]$RepositoryPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Compare committed trees, not checkout line endings. Resolve refs before diffing
# and fail closed if a shallow/missing revision cannot be read.
$baseTree = git -C $RepositoryPath rev-parse --verify --end-of-options "${BaseRevision}^{tree}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the migration baseline.' }
$headTree = git -C $RepositoryPath rev-parse --verify --end-of-options "${HeadRevision}^{tree}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the migration candidate.' }

# Disable rename detection: moving a migration is a deletion plus an addition,
# and the deletion must fail just like a content change to an old migration.
$forbiddenChanges = @(git -C $RepositoryPath diff --no-renames --name-status `
    --diff-filter=DMRTUXB $baseTree $headTree -- database/migrations/)
if ($LASTEXITCODE -ne 0) { throw 'Could not compare migration history.' }
if ($forbiddenChanges.Count -gt 0) {
    throw "Existing migrations are immutable. Add a new migration instead.`n$($forbiddenChanges -join "`n")"
}
Write-Output 'PASS: existing migration files are unchanged; additions are allowed.'
exit 0
