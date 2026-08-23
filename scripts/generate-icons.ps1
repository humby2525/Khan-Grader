param(
  [switch]$PromoOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$iconDirectory = Join-Path $repoRoot "icons"
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Rectangle,
    [float]$Radius
  )

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

if (-not $PromoOnly) {
foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 128.0
  $tile = [System.Drawing.RectangleF]::new(16 * $scale, 16 * $scale, 96 * $scale, 96 * $scale)
  $tilePath = New-RoundedRectanglePath -Rectangle $tile -Radius (16 * $scale)
  $tileBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(20, 43, 54))
  $graphics.FillPath($tileBrush, $tilePath)

  $paper = [System.Drawing.RectangleF]::new(37 * $scale, 29 * $scale, 54 * $scale, 70 * $scale)
  $paperPath = New-RoundedRectanglePath -Rectangle $paper -Radius (5 * $scale)
  $paperBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(247, 250, 252))
  $graphics.FillPath($paperBrush, $paperPath)

  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(51, 137, 137), [Math]::Max(1, 6 * $scale))
  $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($linePen, 49 * $scale, 48 * $scale, 78 * $scale, 48 * $scale)
  $graphics.DrawLine($linePen, 49 * $scale, 63 * $scale, 72 * $scale, 63 * $scale)

  $checkPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(236, 178, 46), [Math]::Max(1, 7 * $scale))
  $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLines($checkPen, [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(49 * $scale, 79 * $scale),
    [System.Drawing.PointF]::new(60 * $scale, 89 * $scale),
    [System.Drawing.PointF]::new(80 * $scale, 72 * $scale)
  ))

  $outputPath = Join-Path $iconDirectory "icon-$size.png"
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $checkPen.Dispose()
  $linePen.Dispose()
  $paperBrush.Dispose()
  $paperPath.Dispose()
  $tileBrush.Dispose()
  $tilePath.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "Generated Chrome extension icons in $iconDirectory"
}

$assetDirectory = Join-Path $repoRoot "store-assets"
New-Item -ItemType Directory -Path $assetDirectory -Force | Out-Null

$promo = [System.Drawing.Bitmap]::new(440, 280, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$promoGraphics = [System.Drawing.Graphics]::FromImage($promo)
$promoGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$promoGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$promoGraphics.Clear([System.Drawing.Color]::FromArgb(245, 247, 248))

$accentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(51, 137, 137))
$promoGraphics.FillRectangle($accentBrush, 0, 0, 12, 280)

$icon = [System.Drawing.Image]::FromFile((Join-Path $iconDirectory "icon-128.png"))
$promoGraphics.DrawImage($icon, 42, 76, 128, 128)

$titleFont = [System.Drawing.Font]::new("Arial", 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [System.Drawing.Font]::new("Arial", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(20, 43, 54))
$subtitleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(72, 91, 101))

$promoGraphics.DrawString("Khan Grader", $titleFont, $titleBrush, 194, 94)
$subtitleBounds = [System.Drawing.RectangleF]::new(196, 137, 205, 72)
$promoGraphics.DrawString("Weekly minutes to`nteacher-reviewed grades", $subtitleFont, $subtitleBrush, $subtitleBounds)

$promoPath = Join-Path $assetDirectory "small-promo-440x280-rgb.png"
$promo.Save($promoPath, [System.Drawing.Imaging.ImageFormat]::Png)

$subtitleBrush.Dispose()
$titleBrush.Dispose()
$subtitleFont.Dispose()
$titleFont.Dispose()
$icon.Dispose()
$accentBrush.Dispose()
$promoGraphics.Dispose()
$promo.Dispose()

Write-Output "Generated Chrome Web Store promo image at $promoPath"
