param(
    [ValidateSet('Compose', 'Psql')]
    [string]$ConnectionMode = 'Compose'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Expected child-process failures are asserted below rather than treated as
# terminating PowerShell errors when a caller enables native error handling.
$PSNativeCommandUseErrorActionPreference = $false

# Run after a successful migration. Exercise the real runner against its existing
# ledger, using an isolated directory instead of moving/deleting repository files.
$migrationRunner = Join-Path $PSScriptRoot 'migrate.ps1'
$powerShellExecutable = (Get-Process -Id $PID).Path
$fixtureDirectory = Join-Path ([IO.Path]::GetTempPath()) ('forms-migration-history-' + [guid]::NewGuid().ToString('N'))
$pendingMigrationPath = Join-Path $fixtureDirectory '999_missing_history_probe.sql'
[void][IO.Directory]::CreateDirectory($fixtureDirectory)

function Assert-MissingHistoryRejected {
    $runnerOutput = & $powerShellExecutable -NoProfile -File $migrationRunner `
        -ConnectionMode $ConnectionMode -MigrationDirectory $fixtureDirectory 2>&1
    $runnerExitCode = $LASTEXITCODE
    $runnerText = $runnerOutput | Out-String
    if ($runnerExitCode -eq 0) {
        throw 'Runner accepted a directory missing its applied migration history.'
    }
    if ($runnerText -notmatch 'Applied migration files missing from repository:' -or
        $runnerText -notmatch '001_initial_schema.sql') {
        throw "Runner failed for an unexpected reason: $runnerText"
    }
}

try {
    Assert-MissingHistoryRejected
    Write-Output 'PASS: empty migration directory rejects missing applied files.'

    # If history checking happens too late this division-by-zero will run instead.
    [IO.File]::WriteAllText($pendingMigrationPath, "SELECT 1 / 0;`n")
    Assert-MissingHistoryRejected
    Write-Output 'PASS: missing history is rejected before a pending migration executes.'
} finally {
    # Only remove the exact test-created file and its now-empty directory.
    if (Test-Path -LiteralPath $pendingMigrationPath) {
        Remove-Item -LiteralPath $pendingMigrationPath
    }
    Remove-Item -LiteralPath $fixtureDirectory
}

# GitHub's pwsh wrapper propagates LASTEXITCODE; do not leak an expected failure.
exit 0
