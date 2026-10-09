$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
$checker = Join-Path $PSScriptRoot 'check-migration-files.ps1'
$powerShellExecutable = (Get-Process -Id $PID).Path
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRepository = Join-Path $temporaryRoot ('forms-migration-policy-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory((Join-Path $fixtureRepository 'database/migrations'))

function Invoke-FixtureGit {
    & git -C $fixtureRepository @args
    if ($LASTEXITCODE -ne 0) { throw "Fixture git failed: $args" }
}

function Save-FixtureCommit {
    Invoke-FixtureGit add --all
    Invoke-FixtureGit -c user.name=MigrationTests -c user.email=tests@example.test `
        -c commit.gpgsign=false commit --quiet -m fixture
    Invoke-FixtureGit rev-parse HEAD
}

function Assert-PolicyResult([string]$baseline, [bool]$shouldPass, [string]$scenario) {
    $output = & $powerShellExecutable -NoProfile -File $checker -RepositoryPath $fixtureRepository `
        -BaseRevision $baseline 2>&1
    $exitCode = $LASTEXITCODE
    if (($exitCode -eq 0) -ne $shouldPass) { throw "Unexpected result for ${scenario}: $output" }
    if (-not $shouldPass -and ($output | Out-String) -notmatch 'Existing migrations are immutable') {
        throw "Unexpected failure for ${scenario}: $output"
    }
    Write-Output "PASS: $scenario"
}

try {
    Invoke-FixtureGit init --quiet
    $oldMigration = Join-Path $fixtureRepository 'database/migrations/001_initial.sql'
    [IO.File]::WriteAllText($oldMigration, "SELECT 1;`n")
    $baseline = Save-FixtureCommit
    Assert-PolicyResult $baseline $true 'unchanged migrations accepted'

    [IO.File]::WriteAllText((Join-Path $fixtureRepository 'database/migrations/002_new.sql'), "SELECT 2;`n")
    $addition = Save-FixtureCommit
    Assert-PolicyResult $baseline $true 'new migration accepted'

    [IO.File]::WriteAllText($oldMigration, "SELECT 3;`n")
    $edited = Save-FixtureCommit
    Assert-PolicyResult $addition $false 'old migration edit rejected'

    Invoke-FixtureGit mv database/migrations/001_initial.sql database/migrations/003_renamed.sql
    $renamed = Save-FixtureCommit
    Assert-PolicyResult $edited $false 'old migration rename rejected'

    Remove-Item -LiteralPath (Join-Path $fixtureRepository 'database/migrations/003_renamed.sql')
    $deleted = Save-FixtureCommit
    Assert-PolicyResult $renamed $false 'old migration deletion rejected'
} finally {
    # Recursive cleanup is confined to the exact test-created repository under temp.
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRepository)
    if ([IO.Path]::GetDirectoryName($resolvedFixture) -ne $temporaryRoot.TrimEnd('\', '/') -or
        [IO.Path]::GetFileName($resolvedFixture) -notlike 'forms-migration-policy-*') {
        throw 'Refusing cleanup outside the test fixture directory.'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
exit 0
