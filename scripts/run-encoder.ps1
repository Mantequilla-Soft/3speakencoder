# Runs the encoder and restarts it when it exits with code 75, which it does
# after applying an update from the dashboard. Any other exit ends this script
# with the same code.
#
#   powershell -ExecutionPolicy Bypass -File scripts\run-encoder.ps1

Set-Location (Join-Path $PSScriptRoot '..')

# Tells the encoder a supervisor will restart it (otherwise it asks for a manual restart)
$env:ENCODER_SUPERVISED = '1'

while ($true) {
    & npm start
    $code = $LASTEXITCODE
    if ($code -eq 75) {
        Write-Host "Encoder updated itself - restarting..." -ForegroundColor Green
        Start-Sleep -Seconds 2
        continue
    }
    exit $code
}
