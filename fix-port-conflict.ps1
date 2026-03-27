# Fix Port 8080 Conflict Script
Write-Host "Checking for processes using port 8080..." -ForegroundColor Yellow

$connections = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue

if ($connections) {
    Write-Host "`nFound processes using port 8080:" -ForegroundColor Red
    foreach ($conn in $connections) {
        $process = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($process) {
            Write-Host "  PID: $($process.Id) | Name: $($process.ProcessName) | Path: $($process.Path)" -ForegroundColor Red
        }
    }
    
    $kill = Read-Host "`nKill these processes? (y/n)"
    if ($kill -eq 'y' -or $kill -eq 'Y') {
        foreach ($conn in $connections) {
            try {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
                Write-Host "  Killed process $($conn.OwningProcess)" -ForegroundColor Green
            } catch {
                Write-Host "  Could not kill process $($conn.OwningProcess): $_" -ForegroundColor Yellow
            }
        }
        Write-Host "`nPort 8080 should now be free. Try running 'npm run dev' again." -ForegroundColor Green
    } else {
        Write-Host "`nTo use a different port, set PORT in .env file (e.g., PORT=8081)" -ForegroundColor Yellow
    }
} else {
    Write-Host "No processes found using port 8080. Port should be available." -ForegroundColor Green
}

