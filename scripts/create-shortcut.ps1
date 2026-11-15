<#
  在桌面创建 PaperLens 的快捷方式。

  为什么要脚本而不是直接给个 exe：这是个 Electron 项目，直接跑需要
  `electron <项目目录>`，而且在这台机器上必须带 --no-sandbox 和自定义
  user-data-dir（否则 Electron 在 ready 前段错误）。双击快捷方式就省掉了
  开终端敲命令这一步。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'resources\icon.ico'
$userData = Join-Path $root '.userdata'

if (-not (Test-Path $electron)) {
    Write-Error "找不到 Electron 运行时：$electron`n先执行：node node_modules\electron\install.js"
}

if (-not (Test-Path $icon)) {
    Write-Warning "图标不存在，快捷方式将使用默认图标：$icon"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'PaperLens.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)

$shortcut.TargetPath = $electron
$shortcut.Arguments = '"{0}" --no-sandbox --user-data-dir="{1}"' -f $root, $userData
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'PaperLens — 划词翻译论文阅读器'
if (Test-Path $icon) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "已创建快捷方式：$linkPath"
Write-Host "  目标：$electron"
Write-Host "  参数：$($shortcut.Arguments)"
