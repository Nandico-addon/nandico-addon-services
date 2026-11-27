# Run on Windows from PowerShell; no activation or global Python packages needed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    foreach ($required in @('main.py', 'config.txt', 'requirements.txt', 'test_worklist.py', 'fixtures\fuji-worklist-query.json', 'fixtures\siemens-worklist-query.json', 'manage-startup.ps1', 'WINDOWS.md', 'Enable PC Startup.cmd', 'Enable Startup.cmd', 'Stop Worklist.cmd', 'Start Worklist.cmd', 'Check Status.cmd', 'Disable Startup.cmd')) {
        if (-not (Test-Path $required -PathType Leaf)) {
            throw "Incomplete source folder: missing $required. Extract the complete build kit before building."
        }
    }
    if (-not (Test-Path '.venv\Scripts\python.exe')) {
        & py -3 -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
    }
    $python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    & $python -m pip install -r requirements.txt pyinstaller==6.22.3
    if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed.' }
    # Exercise real local DICOM/HTTP fixtures for every modality before packaging.
    # These tests never contact live HIMS or a real scanner.
    & $python -m unittest discover -s . -p test_worklist.py -v
    if ($LASTEXITCODE -ne 0) { throw 'Worklist regression checks failed; no new executable was built.' }
    # Build a portable folder like the supplied MediMind app. Stage separately
    # so rebuilding does not remove an installation's configuration or logs.
    & $python -m PyInstaller --noconfirm --clean --onedir --noconsole --name KRJWorklist --distpath build/windows-package main.py
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable build failed. Stop the app before rebuilding.' }
    $package = Join-Path $PSScriptRoot 'build\windows-package\KRJWorklist'
    $installed = Join-Path $PSScriptRoot 'dist\KRJWorklist'
    $configuration = Join-Path $PSScriptRoot 'config.txt'
    if (Test-Path "$installed\config.txt") {
        $configuration = "$installed\config.txt"
    } elseif (Test-Path 'dist\config.txt') {
        $configuration = Join-Path $PSScriptRoot 'dist\config.txt'
    }
    Copy-Item $configuration "$package\config.txt"
    Copy-Item manage-startup.ps1, WINDOWS.md, 'Enable PC Startup.cmd', 'Enable Startup.cmd', 'Start Worklist.cmd', 'Stop Worklist.cmd', 'Check Status.cmd', 'Disable Startup.cmd' $package
    New-Item -ItemType Directory -Force -Path $installed | Out-Null
    Copy-Item "$package\*" $installed -Recurse -Force
    # Zip only staged release files, never logs from an existing installation.
    Compress-Archive -Path $package -DestinationPath 'dist\KRJWorklist-Windows-x64.zip' -Force
    Write-Host "Ready: $installed\KRJWorklist.exe"
    Write-Host "Portable ZIP: $PSScriptRoot\dist\KRJWorklist-Windows-x64.zip"
} finally {
    Pop-Location
}
