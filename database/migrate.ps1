param(
    [ValidateSet('Compose', 'Psql')]
    [string]$ConnectionMode = 'Compose',
    [string]$MigrationDirectory = (Join-Path $PSScriptRoot 'migrations')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Compose uses container credentials; Psql uses standard PG* environment variables.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$migrationFiles = @(Get-ChildItem -LiteralPath $MigrationDirectory -File -Filter '*.sql' | Sort-Object Name)
# Validate before placing filenames into SQL, including the complete-history check.
foreach ($migrationFile in $migrationFiles) {
    if ($migrationFile.Name -notmatch '^\d{3}_[a-z0-9_]+\.sql$') {
        throw "Invalid migration filename: $($migrationFile.Name)"
    }
}
$filenameLiterals = ($migrationFiles | ForEach-Object { "'$($_.Name)'" }) -join ', '
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

# Run under the migration lock BEFORE any pending SQL. An empty directory must
# also fail against a populated ledger, rather than silently skipping every file.
[void]$sql.AppendLine(@"
DO `$history`$
DECLARE missing_filenames text;
BEGIN
    SELECT string_agg(filename, ', ' ORDER BY filename) INTO missing_filenames
    FROM schema_migrations
    WHERE NOT (filename = ANY (ARRAY[$filenameLiterals]::text[]));
    IF missing_filenames IS NOT NULL THEN
        RAISE EXCEPTION 'Applied migration files missing from repository: %', missing_filenames;
    END IF;
END;
`$history`$;
"@)

foreach ($migrationFile in $migrationFiles) {
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
    if ($ConnectionMode -eq 'Psql') {
        $sql.ToString() | psql -X --no-password --set=ON_ERROR_STOP=1
    } else {
        $sql.ToString() | docker compose exec -T db sh -c 'exec psql -X --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Migration failed; the transaction was not committed.' }
} finally {
    Pop-Location
}
