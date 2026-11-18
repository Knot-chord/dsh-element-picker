<#
  compat.ps1 — 在隔离沙盒里验证本插件能被指定版本的 DSH 接受并挂载。

  用法：
    pwsh -File scripts/compat.ps1                      # 默认跑 0.2.1-rc.5 .. 0.2.2-rc.3
    pwsh -File scripts/compat.ps1 -Versions 0.2.0-rc.2 # 探更低的版本
    pwsh -File scripts/compat.ps1 -Fresh               # 重建每个版本的沙盒

  隔离：DSH_HOME 与 npm 缓存都在本仓库 .compat\ 下，不碰桌面应用与全局环境。
  说明：客户端（引用卡/输入框）在 headless 下无法运行，它的兼容性由 client.js 的
  能力探测链保证；这里验证的是「宿主能装、能挂、配置能生成」。
#>
[CmdletBinding()]
param(
  # 沙箱只有一处：D:\Deepseek Hardness\dsh-workspace\compat（复用现成的 DSH_HOME 与 npm-cache），
  # 每个 minor 线只验证"代表版本"：该线最后一个 rc（功能分界点），
  # 0.2.0-rc.2 = 0.2.x 起点；0.2.1-rc.5 = 引用卡出现前的最后版本（0.2.2-rc.1 才有 insertQuote）。
  # 当前桌面端（0.2.2-rc.3）用真机验证，不再占沙箱。
  [string[]]$Versions = @("0.2.0-rc.2", "0.2.1-rc.5"),
  [string]$PluginDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Profile = "compat",
  [switch]$Fresh
)

$ErrorActionPreference = "Stop"
# 沙盒放在 DSH 安装目录下的统一沙盒区（可用 DSH_REF_COMPAT 覆盖），不放仓库里。
$root = if ($env:DSH_REF_COMPAT) { $env:DSH_REF_COMPAT } else { "D:\Deepseek Hardness\dsh-workspace\compat" }
$sandboxHome = Join-Path $root "dsh-home"
$cache = Join-Path $root "npm-cache"
New-Item -ItemType Directory -Force -Path $sandboxHome, $cache | Out-Null

$Versions = @($Versions | ForEach-Object { $_ -split "`",`"" } | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() })
$rows = [System.Collections.Generic.List[object]]::new()

function Resolve-DshBin([string]$Version) {
  # The npx cache keeps the fully installed package even when its own manifest is gone;
  # running lib/bin.js directly is instant and needs no network.
  foreach ($entry in (Get-ChildItem (Join-Path $cache "_npx") -Directory -ErrorAction SilentlyContinue)) {
    $pkg = Join-Path $entry.FullName "node_modules\@deepseek-ai\dsh\package.json"
    if (-not (Test-Path $pkg)) { continue }
    try { $json = Get-Content $pkg -Raw | ConvertFrom-Json } catch { continue }
    if ($json.version -ne $Version) { continue }
    $script = Join-Path $entry.FullName "node_modules\@deepseek-ai\dsh\lib\bin.js"
    if (Test-Path $script) { return $script }
  }
  return $null
}

function Dsh {
  param([string]$Version, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $local = Resolve-DshBin $Version
  if ($local) {
    & node $local @Arguments 2>&1
    return
  }
  & npx --yes "@deepseek-ai/dsh@$Version" @Arguments 2>&1
}

foreach ($version in $Versions) {
  # 共享沙箱：同一个 DSH_HOME 依次验证每个版本，不再按版本建目录。
  $env:DSH_HOME = $sandboxHome
  $env:npm_config_cache = $cache
  New-Item -ItemType Directory -Force -Path $sandboxHome | Out-Null

  $result = [pscustomobject]@{
    Version = $version
    Cli = "?"
    Install = "?"
    Mounted = "?"
    Config = "?"
    Detail = ""
  }

  try {
    $printed = (Dsh $version --version) | Where-Object { "$_".Trim() -match '^\d+\.\d+\.\d+(-[0-9A-Za-z\.]+)?$' } | Select-Object -Last 1
    $trimmed = "$printed".Trim()
    $result.Cli = if ($trimmed -eq $version) { "PASS" } elseif ($trimmed -eq "") { "SKIP(no --version)" } else { "FAIL($trimmed)" }
  } catch {
    $result.Cli = "FAIL"
    $result.Detail = "$($_.Exception.Message)"
  }

  if ($result.Cli -notlike "FAIL*") {
    try {
      $patch = Join-Path $sandboxHome "profiles\$Profile\cordis.patch.yml"
      if (-not (Test-Path $patch)) { $null = Dsh $version $Profile --from-default-profile headless --dump-config }
      # 用 link: 安装：pnpm 只建一个链接，不复制十万个小文件（file: 会整份复制，
      # 既慢又是之前误删事故的诱因——副本里带着 .compat 缓存）。
      $spec = "link:" + ($PluginDir -replace "\\", "/")
      $out = Dsh $version plugin --profile $Profile add $spec
      if ($LASTEXITCODE -ne 0) { throw ($out | Select-Object -Last 1) }
      $result.Install = "PASS"
    } catch {
      $result.Install = "FAIL"
      $result.Detail = "$($_.Exception.Message)"
    }
  }

  if ($result.Install -eq "PASS") {
    try {
      $dump = Dsh $version --profile $Profile --dump-config
      $joined = ($dump -join "`n")
      $result.Mounted = if ($joined -match 'element-ref') { "PASS" } else { "FAIL(no row)" }
      $result.Config = if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }
      if ($result.Mounted -eq "PASS" -and $LASTEXITCODE -ne 0) { $result.Detail = ($dump | Select-Object -Last 2) -join ' ' }
    } catch {
      $result.Mounted = "FAIL"
      $result.Detail = "$($_.Exception.Message)"
    }
  }

  $rows.Add($result)
  Write-Host ("{0,-12} cli={1,-10} install={2,-10} mounted={3,-12} config={4,-6} {5}" -f $result.Version, $result.Cli, $result.Install, $result.Mounted, $result.Config, $result.Detail)
}

$outFile = Join-Path $root "compat-result.json"
$rows | ConvertTo-Json -Depth 4 | Set-Content $outFile -Encoding utf8
Write-Host ""
Write-Host "写入 $outFile"









