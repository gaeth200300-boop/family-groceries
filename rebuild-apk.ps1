# Rebuild the Android APK after changing www/ (run from PowerShell).
$root = $PSScriptRoot
Set-Location $root
node .\node_modules\@capacitor\cli\bin\capacitor sync android
robocopy "$root\android" "C:\fgbuild\android" /E /NFL /NDL /NJH /NJS /XD build .gradle | Out-Null
robocopy "$root\node_modules\@capacitor\android" "C:\fgbuild\node_modules\@capacitor\android" /E /NFL /NDL /NJH /NJS | Out-Null
cmd /c "C:\fgbuild\build-apk.bat"
Copy-Item "C:\fgbuild\android\app\build\outputs\apk\debug\app-debug.apk" "$root\family-groceries.apk" -Force
Write-Host "Done: $root\family-groceries.apk"
