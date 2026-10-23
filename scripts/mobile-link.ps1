param([switch]$Restart)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ============================================================================
#  رابط الجوال — يشغّل الخادم (إن لم يكن يعمل) ثم نفق Cloudflare HTTPS.
#  الاستخدام:  MOBILE-LINK.cmd            (يعيد استخدام نفق شغّال)
#              MOBILE-LINK.cmd -Restart   (رابط جديد)
# ============================================================================

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root "server"
$tools = Join-Path $env:LOCALAPPDATA "NexusTools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

$log = Join-Path $tools "family-tunnel.log"
$pidFile = Join-Path $tools "family-tunnel.pid"
$local = "http://127.0.0.1:8787"

function Test-FamilyHealth {
    try {
        $r = Invoke-RestMethod -Uri "$local/api/health" -TimeoutSec 3
        return ($r.ok -eq $true)
    } catch { return $false }
}

# ---------------------------------------------------------------- local server
if (-not (Test-FamilyHealth)) {
    Write-Host ">> تشغيل خادم مقاضي العائلة..." -ForegroundColor Yellow
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "Node.js غير مثبت أو غير موجود في PATH." }

    Start-Process -FilePath $node -ArgumentList "src/index.js" -WorkingDirectory $serverDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $tools "family-server.out.log") `
        -RedirectStandardError  (Join-Path $tools "family-server.err.log") | Out-Null

    $up = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-FamilyHealth) { $up = $true; break }
    }
    if (-not $up) {
        $errFile = Join-Path $tools "family-server.err.log"
        if (Test-Path $errFile) { Get-Content $errFile -Tail 20 | Write-Host }
        throw "تعذّر تشغيل الخادم على المنفذ 8787. راجع $errFile"
    }
    Write-Host ">> الخادم يعمل." -ForegroundColor Green
}

# ------------------------------------------------------------------- cloudflared
$cloudflared = Join-Path $tools "cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { $cloudflared = $cmd.Source }
    else { throw "cloudflared غير موجود. ثبّته أو ضع cloudflared.exe في $tools" }
}

$url = $null
$runningPid = $null

if (Test-Path $pidFile) {
    $stored = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($stored) {
        $proc = Get-Process -Id ([int]$stored) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -like "*cloudflared*") { $runningPid = $proc.Id }
    }
}

if ($Restart -and $runningPid) {
    Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $runningPid = $null
}

if ($runningPid) {
    if (Test-Path $log) {
        $m = [regex]::Matches((Get-Content $log -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com') | Select-Object -Last 1
        if ($m) { $url = $m.Value }
    }
    if (-not $url) {
        Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
        $runningPid = $null
    }
}

if (-not $url) {
    Write-Host ">> إنشاء رابط HTTPS عام..." -ForegroundColor Yellow
    if (Test-Path $log) { Remove-Item $log -Force }
    $proc = Start-Process -FilePath $cloudflared `
        -ArgumentList @("tunnel", "--url", $local, "--no-autoupdate", "--logfile", $log) `
        -PassThru -WindowStyle Hidden
    $proc.Id | Set-Content $pidFile

    for ($i = 0; $i -lt 80; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $log) {
            $m = [regex]::Matches((Get-Content $log -Raw -ErrorAction SilentlyContinue), 'https://[a-z0-9-]+\.trycloudflare\.com') | Select-Object -Last 1
            if ($m) { $url = $m.Value; break }
        }
    }
    if (-not $url) { throw "تعذّر الحصول على رابط من Cloudflare. راجع $log" }
}

$url | Set-Content (Join-Path $root "family-link.txt") -Encoding ascii
try { Set-Clipboard $url } catch { }

Write-Host ""
Write-Host "======================================================================" -ForegroundColor DarkGray
Write-Host "  رابط مقاضي العائلة للجوال والكمبيوتر (نُسخ للحافظة):" -ForegroundColor Green
Write-Host ""
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1) افتح الرابط في متصفح الجوال." -ForegroundColor Gray
Write-Host "  2) سجّل الدخول بحساب العائلة." -ForegroundColor Gray
Write-Host "  3) أندرويد: قائمة كروم ← إضافة إلى الشاشة الرئيسية." -ForegroundColor Gray
Write-Host "     آيفون: سفاري ← مشاركة ← إضافة إلى الشاشة الرئيسية." -ForegroundColor Gray
Write-Host "  4) من التطبيق اضغط «تفعيل الإشعارات» ثم «إرسال تجربة»." -ForegroundColor Gray
Write-Host ""
Write-Host "  الرابط مؤقت: يبقى ما دام هذا الجهاز يعمل. لإيقافه أغلق نافذة cloudflared." -ForegroundColor DarkYellow
Write-Host "======================================================================" -ForegroundColor DarkGray
