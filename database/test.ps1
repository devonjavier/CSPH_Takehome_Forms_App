param(
    [ValidateSet('Compose', 'Psql')]
    [string]$ConnectionMode = 'Compose'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot
try {
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $testSql = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'tests/constraints.sql')
    if ($ConnectionMode -eq 'Psql') {
        $testSql | psql -X --no-password --set=ON_ERROR_STOP=1
    } else {
        $testSql | docker compose exec -T db sh -c 'exec psql -X --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Database constraint checks failed; test fixtures were not committed.' }
} finally {
    Pop-Location
}
