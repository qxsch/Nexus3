<#
.SYNOPSIS
  Renders the NEXUS-3 app icon (the N3 brand mark) to build/icon.png and build/icon.ico.
.DESCRIPTION
  Windows only, uses System.Drawing. The generated files are committed, so this only
  needs to be re-run when the brand mark changes.
#>
[CmdletBinding()]
param(
    [int]$Size = 1024,
    [string]$OutDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
    param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $R * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap {
    param([int]$Edge)

    $bmp = [System.Drawing.Bitmap]::new($Edge, $Edge, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Brand mark geometry: 38px box, 11px radius, 14px type (src/css/style.css .brand-mark).
    $pad = [single]($Edge * 0.055)
    $box = [single]($Edge - 2 * $pad)
    $radius = [single]($box * (11.0 / 38.0))
    $path = New-RoundedPath -X $pad -Y $pad -W $box -H $box -R $radius

    # CSS linear-gradient(145deg, ...) -> GDI+ angle is measured from the x-axis.
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.RectangleF]::new($pad, $pad, $box, $box),
        [System.Drawing.Color]::FromArgb(0x22, 0xD3, 0xEE),
        [System.Drawing.Color]::FromArgb(0xFB, 0xBF, 0x24),
        55.0)
    $blend = [System.Drawing.Drawing2D.ColorBlend]::new(3)
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(0x22, 0xD3, 0xEE),
        [System.Drawing.Color]::FromArgb(0xF4, 0x72, 0xB6),
        [System.Drawing.Color]::FromArgb(0xFB, 0xBF, 0x24))
    $blend.Positions = @(0.0, 0.55, 1.0)
    $brush.InterpolationColors = $blend
    $g.FillPath($brush, $path)

    $fontName = @('Cascadia Mono', 'Consolas', 'Courier New') |
        Where-Object { [System.Drawing.FontFamily]::Families.Name -contains $_ } |
        Select-Object -First 1
    $font = [System.Drawing.Font]::new($fontName, [single]($box * (14.0 / 38.0)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(0x04, 0x12, 0x1A))
    $g.DrawString('N3', $font, $ink, [System.Drawing.RectangleF]::new($pad, $pad, $box, $box), $format)

    $ink.Dispose(); $format.Dispose(); $font.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

$pngPath = Join-Path $OutDir 'icon.png'
$icoPath = Join-Path $OutDir 'icon.ico'

$master = New-IconBitmap -Edge $Size
$master.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$master.Dispose()

# Multi-resolution ICO with PNG-compressed entries.
$sizes = 16, 24, 32, 48, 64, 128, 256
$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap -Edge $s
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $images.Add($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
}

$stream = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$dim)
    $writer.Write([byte]$dim)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($bytes in $images) { $writer.Write($bytes, 0, $bytes.Length) }
$writer.Dispose()
$stream.Dispose()

Write-Host "icon written: $pngPath"
Write-Host "icon written: $icoPath"
