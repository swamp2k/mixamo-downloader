param(
    [Parameter(Mandatory = $false)]
    [string]$InputDir = ".\mixamo-test\characters",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = ".\mixamo-test\characters-glb",

    [Parameter(Mandatory = $false)]
    [string]$BlenderPath,

    [switch]$Overwrite
)

$ErrorActionPreference = "Stop"

function Resolve-Blender {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop
        return $resolved.Path
    }

    $command = Get-Command blender -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $roots = @(
        "$env:ProgramFiles\Blender Foundation",
        "${env:ProgramFiles(x86)}\Blender Foundation"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    $candidates = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $exe = Join-Path $_.FullName "blender.exe"
                if (Test-Path -LiteralPath $exe) {
                    Get-Item -LiteralPath $exe
                }
            }
    }

    $candidate = $candidates |
        Sort-Object { [version]($_.Directory.Name -replace "[^0-9.]", "") } -Descending |
        Select-Object -First 1

    if ($candidate) {
        return $candidate.FullName
    }

    throw "Could not find Blender. Install Blender, add it to PATH, or pass -BlenderPath C:\path\to\blender.exe"
}

$blender = Resolve-Blender -ExplicitPath $BlenderPath
$script = Join-Path $PSScriptRoot "convert_mixamo_fbx_to_glb.py"

Write-Host "Blender: $blender"
Write-Host "Input:   $InputDir"
Write-Host "Output:  $OutputDir"

$arguments = @(
    "--background",
    "--factory-startup",
    "--python", $script,
    "--",
    "--input", $InputDir,
    "--output", $OutputDir
)

if ($Overwrite) {
    $arguments += "--overwrite"
}

& $blender @arguments
exit $LASTEXITCODE
