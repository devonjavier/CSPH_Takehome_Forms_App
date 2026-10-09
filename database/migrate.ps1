$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Use the existing container's environment without printing or parsing .env secrets.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$migrationFiles = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'migrations') -Filter '*.sql' | Sort-Object Name)
$sql = [System.Text.StringBuilder]::new()
[void]$sql.AppendLine(@'
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = public;
-- Serialize migration runners and record a checksum so applied files cannot drift.
SELECT pg_advisory_xact_lock(72481001);
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
'@)

foreach ($migrationFile in $migrationFiles) {
    if ($migrationFile.Name -notmatch '^\d{3}_[a-z0-9_]+\.sql$') {
        throw "Invalid migration filename: $($migrationFile.Name)"
    }
    $filename = $migrationFile.Name
    # Normalize line endings so Git's Windows checkout conversion does not cause drift.
    $migrationSql = [System.IO.File]::ReadAllText($migrationFile.FullName).Replace("`r`n", "`n")
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $checksum = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($migrationSql))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    [void]$sql.AppendLine("DO `$check`$ BEGIN IF EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '$filename' AND checksum <> '$checksum') THEN RAISE EXCEPTION 'Applied migration changed: $filename'; END IF; END; `$check`$;")
    [void]$sql.AppendLine("SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '$filename') AS already_applied \gset")
    [void]$sql.AppendLine('\if :already_applied')
    [void]$sql.AppendLine("\echo Already applied: $filename")
    [void]$sql.AppendLine('\else')
    [void]$sql.AppendLine("\echo Applying: $filename")
    [void]$sql.AppendLine($migrationSql)
    [void]$sql.AppendLine("INSERT INTO schema_migrations (filename, checksum) VALUES ('$filename', '$checksum');")
    [void]$sql.AppendLine('\endif')
}
[void]$sql.AppendLine('COMMIT;')

Push-Location $repositoryRoot
try {
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $sql.ToString() | docker compose exec -T db sh -c 'exec psql -X --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    if ($LASTEXITCODE -ne 0) { throw 'Migration failed; the transaction was not committed.' }
} finally {
    Pop-Location
}
