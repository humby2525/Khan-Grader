param(
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repoRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version

if (-not $version) {
  throw "manifest.json does not contain a version."
}

$requiredFiles = @(
  "manifest.json",
  "icons\icon-16.png",
  "icons\icon-32.png",
  "icons\icon-48.png",
  "icons\icon-128.png",
  "src\background.js",
  "src\content\khanCapture.js",
  "src\dashboard\dashboard.html",
  "src\dashboard\dashboard.css",
  "src\dashboard\dashboard.js"
)

foreach ($relativePath in $requiredFiles) {
  $sourcePath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required extension file is missing: $relativePath"
  }
}

$outputPath = Join-Path $repoRoot $OutputDirectory
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$outputPath = (Resolve-Path -LiteralPath $outputPath).Path

if (-not $outputPath.StartsWith($repoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Output directory must stay inside the repository."
}

$stagingPath = Join-Path $outputPath "package-staging"
if (Test-Path -LiteralPath $stagingPath) {
  $resolvedStagingPath = (Resolve-Path -LiteralPath $stagingPath).Path
  if (-not $resolvedStagingPath.StartsWith($outputPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a staging directory outside the output directory."
  }
  Remove-Item -LiteralPath $resolvedStagingPath -Recurse -Force
}

New-Item -ItemType Directory -Path $stagingPath | Out-Null

try {
  foreach ($relativePath in $requiredFiles) {
    $destinationPath = Join-Path $stagingPath $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot $relativePath) -Destination $destinationPath
  }

  $zipPath = Join-Path $outputPath "Khan-Grader-$version.zip"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  Compress-Archive -Path (Join-Path $stagingPath "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Output "Created $zipPath"
} finally {
  if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
  }
}
