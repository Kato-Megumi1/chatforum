# Deterministic format conversion only. The source image/layout is unchanged and retained.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectDir = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectDir 'frontend/public/auth-bg.png'
$targetPath = Join-Path $projectDir 'frontend/public/auth-bg-optimized.jpg'
$img = [System.Drawing.Image]::FromFile($sourcePath)
try {
  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
  $settings = New-Object System.Drawing.Imaging.EncoderParameters(1)
  try {
    $settings.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]88)
    $img.Save($targetPath, $encoder, $settings)
  } finally { $settings.Dispose() }
} finally { $img.Dispose() }
Get-Item -LiteralPath $sourcePath, $targetPath | Select-Object Name, Length
