# Builds bin/ of the mediagrab skill from the pinned, hash-checked sources in setup.lock.json.
# Usage: setup.ps1          download what is missing or wrong, idempotent
#        setup.ps1 -Check   status only, no network, exit 1 if anything is not ok

param([switch]$Check)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SkillDir = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $SkillDir 'bin'
$TmpDir = Join-Path $SkillDir 'tmp'
$Lock = Get-Content (Join-Path $PSScriptRoot 'setup.lock.json') -Raw | ConvertFrom-Json

function Get-Sha256($path) {
	return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
}

function Get-ItemState($item) {
	$files = $item.files.PSObject.Properties
	if(@($files).Count -eq 0) {
		return 'not pinned'
	}
	foreach($file in $files) {
		$path = Join-Path $BinDir $file.Name
		if(-not (Test-Path -LiteralPath $path)) {
			return 'missing'
		}
		if((Get-Sha256 $path) -ne $file.Value) {
			return 'hash mismatch'
		}
	}
	return 'ok'
}

function Install-Item($name, $item) {
	New-Item -ItemType Directory -Force -Path $BinDir, $TmpDir | Out-Null
	$download = Join-Path $TmpDir ([IO.Path]::GetFileName($item.url))
	Write-Host "Downloading $name $($item.version)"
	Invoke-WebRequest -Uri $item.url -OutFile $download -UseBasicParsing
	try {
		if((Get-Sha256 $download) -ne $item.sha256) {
			throw "$name download hash mismatch - refusing to install"
		}
		if($item.extract) {
			Add-Type -AssemblyName System.IO.Compression.FileSystem
			$zip = [IO.Compression.ZipFile]::OpenRead($download)
			try {
				foreach($entry in $item.extract.PSObject.Properties) {
					$zipEntry = $zip.GetEntry($entry.Value)
					if($null -eq $zipEntry) {
						throw "$name archive lacks $($entry.Value)"
					}
					[IO.Compression.ZipFileExtensions]::ExtractToFile($zipEntry, (Join-Path $BinDir $entry.Name), $true)
				}
			}
			finally {
				$zip.Dispose()
			}
		}
		else {
			Copy-Item -LiteralPath $download -Destination (Join-Path $BinDir ([IO.Path]::GetFileName($item.url))) -Force
		}
	}
	finally {
		Remove-Item -LiteralPath $download -Force
	}
}

$failed = $false
foreach($entry in $Lock.bin.PSObject.Properties) {
	$state = Get-ItemState $entry.Value
	if(-not $Check -and $state -ne 'ok') {
		Install-Item $entry.Name $entry.Value
		$state = Get-ItemState $entry.Value
	}
	if($state -eq 'not pinned') {
		# First install of a new lock entry: print the extracted hashes for setup.lock.json
		foreach($file in $entry.Value.extract.PSObject.Properties) {
			$path = Join-Path $BinDir $file.Name
			if(Test-Path -LiteralPath $path) {
				Write-Host ('  pin {0} {1}' -f $file.Name, (Get-Sha256 $path))
			}
		}
	}
	Write-Host ('{0,-14} {1} {2}' -f $state, $entry.Name, $entry.Value.version)
	if($state -ne 'ok') {
		$failed = $true
	}
}

if($failed) {
	exit 1
}
exit 0
